'use strict';

import crypto from 'crypto';
import _path from 'path';
import constants from 'constants';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import moment from 'moment';
import _ from 'lodash';
import ssh2 from 'ssh2';
const OPEN_MODE = ssh2.SFTP_OPEN_MODE;
const STATUS_CODE = ssh2.SFTP_STATUS_CODE;
import { S3 } from 'aws-sdk';

import util from 'util';
import { AuthHandler, UserData, FileHandle, DirectoryHandle } from './types';
import { FileEntry, Attributes } from 'ssh2-streams';
import { ObjectIdentifier } from 'aws-sdk/clients/s3';

export default class SFTPS3Server extends EventEmitter {
  private hostKeys: Array<any>;
  private loggingEnabled: boolean;
  private ssh?: ssh2.Server|null;

  constructor(private authHandler: AuthHandler) {
    super();
    this.hostKeys = [];
    this.loggingEnabled = false;
  }

  /**
   * Enables logging to standard output
   */
  enableLogging() {
    this.loggingEnabled = true;
  }

  /**
   * Disables logging
   */
  disableLogging() {
    this.loggingEnabled = false;
  }

  /**
   * Add a host key. You need at least one host key before you can start the server.
   */
  addHostKey(key: string) {
    this._log('Added server key');
    this.hostKeys.push(key);
  }

  /**
   * Starts the SFTP server listening
   */
  listen(port: number, bindAddress: string, callback: (port: number) => any) {
    if(this.ssh)
      throw new Error('Already running');
    
    const supportedMethods: Array<"publickey"|"password"> = [];
    if(this.authHandler.publicKeyAuthSupported())
      supportedMethods.push('publickey');
    if(this.authHandler.passwordAuthSupported())
      supportedMethods.push('password');

    this.ssh = new ssh2.Server({
      hostKeys: this.hostKeys
    }, (client) => {
      let userData: UserData;
      client.on('error', (err) => {
        this.emit('client-error', { client: client, error: err });
      });
      client.on('authentication', (ctx) => {
        if(ctx.method === 'publickey' && _.includes(supportedMethods, 'publickey')) {
          this.authHandler.authorizePublicKey(ctx.username, ctx.key).then(authResult => {
            if(!authResult.success) {
              this._log(`user login attempt failed for ${ctx.username}`);
              return ctx.reject(supportedMethods);
            }
            
            this._log(`user login attempt success for ${ctx.username}`);

            userData = authResult.userData as UserData;
    
            if(ctx.signature) {
              var verifier = crypto.createVerify(ctx.sigAlgo);
              verifier.update(ctx.blob);
              if(verifier.verify(userData.key.publicOrig, ctx.signature)) {
                this._log('signature verified');
                return ctx.accept();
              }
              else {
                this._log('signature rejected');
                return ctx.reject();
              }
            }
            else {
              this._log('no signature present');
              return ctx.accept();
            }
          })
          .catch((err: Error) => {
            this._log(`error occurred logging in as ${ctx.username} - ${err.message}`);
            ctx.reject();
          });
        }
        else {
          this._log('rejecting unsupported authentication');
          return ctx.reject(supportedMethods);
        }
      })
      .on('ready', () => {
        client.on('session', (accept, reject) => {
          var session = accept();
          this._log(util.format('logging on %s', userData.username));
          this.emit('login', { username: userData.username });
          session.on('sftp', (accept, reject) => {
            var openFiles: { [k: string]: FileHandle } = {};
            var openDirs: { [k: string]: DirectoryHandle } = {};
            var handleCount = 0;

            var sftpStream = accept();
            sftpStream.on('OPEN', (reqid, filename, flags, attrs) => {
              this._log(util.format('SFTP OPEN filename=%s flags=%d handle=%d', filename, flags, handleCount));
              if(filename.endsWith('\\') || filename.endsWith('/')) {
                filename = filename.substring(0, filename.length - 1 );
              }
              var fullname = this._mapKey(userData.path, filename);

              if(flags & OPEN_MODE.READ) {
                userData.s3.listObjects({
                  Prefix: fullname,
                  Bucket: userData.bucket
                }, (err, data) => {
                  if(err) {
                    this._log(util.format('S3 error listing %s: %s', fullname, err));
                    return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                  }

                  var f = _.find(data.Contents, { Key: fullname }) as S3.Object; //exact filename match
                  if(!f) {
                    this._log(util.format('Key %s not found in S3 list', fullname));
                    return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                  }

                  var handle = new Buffer(4);

                  this._log(util.format('Issuing handle %d', handleCount));
                  openFiles[handleCount] = { flags: flags, filename: filename, size: f.Size, fullname: fullname };
                  handle.writeUInt32BE(handleCount++, 0, true);
                  sftpStream.handle(reqid, handle);
                });
              }
              else if(flags & OPEN_MODE.WRITE) {
                var stream = new PassThrough();

                this._log(util.format('Issuing handle %d', handleCount));
                var handle = new Buffer(4);
                openFiles[handleCount] = { flags: flags, filename: filename, fullname: fullname, stream: stream };
                var state = openFiles[handleCount];
                handle.writeUInt32BE(handleCount++, 0, true);
                sftpStream.handle(reqid, handle);

                userData.s3.upload({
                  Key: fullname,
                  Body: stream,
                  Bucket: userData.bucket
                }, (err: Error, data: S3.ManagedUpload.SendData) => {
                  //Done uploading

                  if(_.isUndefined(state.reqid))
                    return;

                  if(_.isUndefined(state.fnum)) {
                    this._log('undefined handles');
                    return sftpStream.status(state.reqid as number, STATUS_CODE.FAILURE);
                  }

                  delete openFiles[state.fnum];

                  if(err) {
                    this._log(util.format('S3 error uploading %s: %s', fullname, err));
                    return sftpStream.status(state.reqid, STATUS_CODE.FAILURE);
                  }

                  this._log(util.format('Successfully uploaded %s', fullname));
                  this.emit('file-uploaded', { path: state.fullname, username: userData.username });
                  sftpStream.status(state.reqid, STATUS_CODE.OK);
                });
              }
              else {
                this._log(util.format('Unsupported operation'));
                return sftpStream.status(reqid, STATUS_CODE.OP_UNSUPPORTED);
              }
            }).on('READ', (reqid, handle, offset, length) => {
              if(handle.length !== 4)
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);
              
              var handleId = handle.readUInt32BE(0, true);
              
              this._log(util.format('SFTP READ handle=%d offset=%d length=%d', handleId, offset, length));
              
              var state = openFiles[handleId];
              if(!state || !(state.flags & OPEN_MODE.READ)) {
                this._log('Invalid flags');
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);
              }

              if(state.read) {
                this._log('EOF');
                return sftpStream.status(reqid, STATUS_CODE.EOF);
              }

              const size = state.size || 0;

              if(offset + length > size)
                length = size - offset;

              if(offset >= size || length === 0) {
                this._log('Invalid offset');
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);
              }

              if(offset + length >= size) {
                state.read = true;
              }

              userData.s3.getObject({
                 Key: state.fullname,
                 Range: `bytes=${offset}-${offset+length-1}`,
                 Bucket: userData.bucket
              }, (err: Error, data: S3.GetObjectOutput) => {
                const body = data && data.Body as string|Buffer;
                if(err || body.length === 0) {
                  this._log(util.format('S3 error getting object %s: %s', state.fullname, err));
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                }

                this._log(util.format('Successfully read %s', state.fullname));
                sftpStream.data(reqid, body);
              });

            }).on('WRITE', (reqid, handle, offset, data) => {
              if (handle.length !== 4)
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);
              
              var handleId = handle.readUInt32BE(0, true);
              
              this._log(util.format('SFTP WRITE handle=%d offset=%d', handleId, offset));

              var state = openFiles[handleId];
              if(!state || !(state.flags & OPEN_MODE.WRITE)) {
                this._log('Invalid flags');
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);
              }

              if(state.stream) {
                state.stream.write(new Buffer(data), (err: Error) => {
                  if(err) {
                    this._log('Error writing to stream');
                    return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                  }

                  this._log('Wrote bytes to stream');
                  sftpStream.status(reqid, STATUS_CODE.OK);
                });
              }
              else {
                this._log('stream undefined');
                sftpStream.status(reqid, STATUS_CODE.FAILURE);
              }
            }).on('OPENDIR', (reqid, path) => {
              this._log(util.format('SFTP OPENDIR %s', path));
              var fullname = this._mapKey(userData.path, path);
              var isRoot = (path === '/');

              userData.s3.listObjects({
                Prefix: fullname,
                Bucket: userData.bucket
              }, (err: Error, data: S3.ListObjectsOutput) => {
                if(err) {
                  this._log(util.format('S3 error listing %s: %s', fullname, err));
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                }

                if(!data.Contents) {
                  this._log('Failure, no data contents');
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                }

                if(data.Contents.length === 0 && !isRoot) {
                  this._log(util.format('Key %s not found'), fullname);
                  return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                }

                var handle = new Buffer(4);

                var listings = _.filter(data.Contents as Array<S3.Object & { IsDir: boolean }>, (c) => {
                  if(!c.Key)
                    return false;

                  var f = c.Key.substring(fullname.length);
                  if(!f.startsWith('/'))
                    f = '/' + f;
                  if(f === '/.dir')
                    return false;
                  var parts = f.split('/');
                  if(parts[0])
                    return false;
                  if(parts.length === 3 && parts[2] === '.dir') {
                    if(!parts[1])
                      return false;
                    c.Key = c.Key.substring(0, c.Key.length - 4);
                    c.IsDir = true;
                    return true;
                  }
                  return parts.length === 2;
                });

                this._log(util.format('Issuing handle %d', handleCount));
                openDirs[handleCount] = { fullname: fullname, listings: listings };
                handle.writeUInt32BE(handleCount++, 0, true);
                sftpStream.handle(reqid, handle);
              });
            }).on('READDIR', (reqid, handle) => {
              if (handle.length !== 4)
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);
              
              var handleId = handle.readUInt32BE(0, true);

              this._log(util.format('SFTP READDIR handle=%d', handleId));
              
              var state = openDirs[handleId];
              if(!state) {
                this._log('Unknown handle');
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);
              }

              if(state.read) {
                this._log('EOF');
                return sftpStream.status(reqid, STATUS_CODE.EOF);
              }

              state.read = true;

              sftpStream.name(reqid, state.listings.map((obj): FileEntry => {
                const l = obj as S3.Object & { IsDir: boolean };

                if(_.isUndefined(l.Key))
                  throw new Error('key undefined');

                let filename = l.Key.substring(state.fullname.length);
                if(filename.startsWith('/'))
                  filename = filename.substring(1);
                if(filename.endsWith('/'))
                  filename = filename.substring(0, filename.length - 1);

                let mode = 0;
                mode |= constants.S_IRWXU; // read, write, execute for user
                mode |= constants.S_IRWXG; // read, write, execute for group
                mode |= constants.S_IRWXO; // read, write, execute for other

                if(l.IsDir)
                  mode |= constants.S_IFDIR;
                else
                  mode |= constants.S_IFREG;

                const lastMod = l.LastModified || new Date();

                const attrs: Attributes = {
                  mode: mode,
                  uid: 0,
                  gid: 0,
                  size: (l.IsDir ? 1 : l.Size) || 0,
                  atime: Math.floor(+lastMod/1000),
                  mtime: Math.floor(+lastMod/1000)
                };

                const lastModified = moment(l.LastModified);

                this._log('Returned directory details');
                return {
                  filename: filename,
                  longname: `${l.IsDir ? 'd' : '-'}rw-rw-rw-    1 ${userData.username}  ${userData.username} ${l.Size} ${lastModified.format('MMM D')} ${moment().year() === lastModified.year() ? lastModified.format('HH:mm') : lastModified.format('YYYY')} ${_path.basename(filename)}`,
                  attrs: attrs
                };
              }));

            }).on('REALPATH', (reqid, path) => {
              this._log(util.format('SFTP REALPATH %s', path));
              if(path === '.')
                path = '/';
              var p = path;
              p = p.replace('\\\\', '/');
              p = p.replace('\\.\\', '/');
              p = p.replace('\\', '/');
              p = _path.normalize(p);
              while(p.indexOf('\\') >= 0)
                p = p.replace('\\', '/');
              if(!p.startsWith('/'))
                p = '/' + p;

              var fullname = this._mapKey(userData.path, path);

              this._log(util.format('listing objects under %s (%s)', fullname, p));
              userData.s3.listObjects({
                Prefix: fullname,
                Bucket: userData.bucket
              }, (err, data) => {
                if(err) {
                  this._log(util.format('S3 error listing %s: %s', fullname, err));
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                }
                if(_.isUndefined(data.Contents)) {
                  this._log('contents undefined');
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                }

                this._log(util.format('%d objects found', data.Contents.length));

                var realObj = _.find(data.Contents, (c) => c.Key === fullname || c.Key === (fullname + '/.dir')) as S3.Object & { IsDir: boolean };

                if(realObj && realObj.Key && realObj.Key.endsWith('.dir')) {
                  this._log(util.format('%s is a directory', realObj.Key));
                  realObj.IsDir = true;
                }

                if(!realObj && (p === '/' || p === '/.')) {
                  this._log(util.format('listing empty root directory %s', p));
                  realObj = {
                    IsDir: true,
                    LastModified: new Date(),
                    Size: 0
                  };
                  p = '/';
                }

                if(!realObj) {
                  this._log(util.format('no objects found at %s', fullname));
                  return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                }

                let mode = 0;
                mode |= constants.S_IRWXU; // read, write, execute for user
                mode |= constants.S_IRWXG; // read, write, execute for group
                mode |= constants.S_IRWXO; // read, write, execute for other

                if(realObj.IsDir)
                  mode |= constants.S_IFDIR;
                else
                  mode |= constants.S_IFREG;

                const lastMod = realObj.LastModified || new Date();

                const attrs: Attributes = {
                  mode: mode,
                  uid: 0,
                  gid: 0,
                  size: (realObj.IsDir ? 1 : realObj.Size) || 0,
                  atime: Math.floor(+lastMod/1000),
                  mtime: Math.floor(+lastMod/1000)
                };

                const lastModified = moment(realObj.LastModified);

                var name: Array<FileEntry> = [{
                  filename: p,
                  longname: `${realObj.IsDir ? 'd' : '-'}rw-rw-rw-    1 ${userData.username}  ${userData.username} ${realObj.Size} ${lastModified.format('MMM D')} ${moment().year() === lastModified.year() ? lastModified.format('HH:mm') : lastModified.format('YYYY')} ${_path.basename(p) || p}`,
                  attrs: attrs
                }];

                this._log('Returning real name');
                sftpStream.name(reqid, name);
              });
            }).on('CLOSE', (reqid, handle) => {
              if (handle.length !== 4)
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);
              
              const handleId = handle.readUInt32BE(0, true);
              
              this._log(util.format('SFTP CLOSE handle=%d', handleId));
              
              if(!openFiles[handleId] && !openDirs[handleId]) {
                this._log('Unknown handle');
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);
              }

              if(openFiles[handleId]) {
                var state = openFiles[handleId];

                if (openFiles[handleId].flags & OPEN_MODE.WRITE) {
                  state.reqid = reqid;
                  state.fnum = handleId;
                  if(!_.isUndefined(state.stream))
                    state.stream.end();
                  this._log('Stream closed');
                  return;
                }
                else {
                  this.emit('file-downloaded', { path: state.fullname, username: userData.username });
                  delete openFiles[handleId];
                }
              }
              else {
                delete openDirs[handleId];
              }

              this._log('Handle closed');
              sftpStream.status(reqid, STATUS_CODE.OK);
            }).on('REMOVE', (reqid, path) => {
              this._log(util.format('SFTP REMOVE %s', path));
              var fullname = this._mapKey(userData.path, path);

              userData.s3.deleteObject({
                Key: fullname,
                Bucket: userData.bucket
              }, (err, data) => {
                if(err) {
                  this._log(util.format('S3 error deleting object %s: %s', fullname, err));
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                }

                this._log('File deleted');
                this.emit('file-deleted', { path: fullname, username: userData.username });
                sftpStream.status(reqid, STATUS_CODE.OK);
              });
            }).on('RMDIR', (reqid, path) => {
              this._log(util.format('SFTP RMDIR %s', path));
              var fullname = this._mapKey(userData.path, path);

              userData.s3.listObjects({
                Prefix: fullname,
                Bucket: userData.bucket
              }, (err, data) => {
                if(err) {
                  this._log(util.format('S3 error listing %s: %s', fullname, err));
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                }
                if(_.isUndefined(data.Contents)) {
                  this._log('undefined contents');
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                }

                const keys = data.Contents.map((c): ObjectIdentifier => {
                  if(_.isUndefined(c.Key))
                    throw new Error('key undefined');
                  return {
                    Key: c.Key
                  };
                });

                if(keys.length === 0) {
                  this._log(util.format('Key %s not found in listing', fullname));
                  return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                }

                userData.s3.deleteObjects({
                  Delete: {
                    Objects: keys
                  },
                  Bucket: userData.bucket
                }, (err, data) => {
                  if(err) {
                    this._log('S3 error deleting objects: %s', err);
                    return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                  }

                  this._log('Directory deleted');
                  this.emit('directory-deleted', { path: fullname, username: userData.username });
                  return sftpStream.status(reqid, STATUS_CODE.OK);
                });
              });
            }).on('MKDIR', (reqid, path, attrs) => {
              this._log(util.format('SFTP MKDIR %s', path));
              var procPath = _path.join(path, '.dir');
              if(procPath.endsWith('/'))
                procPath = procPath.slice(0, -1);

              var fullname = this._mapKey(userData.path, procPath);

              userData.s3.putObject({
                Key: fullname,
                Body: '',
                Bucket: userData.bucket
              }, (err, data) => {
                if(err) {
                  this._log(util.format('S3 error putting object %s: %s', fullname, err));
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                }

                this._log('Directory created');
                this.emit('directory-created', { path: fullname, username: userData.username });
                return sftpStream.status(reqid, STATUS_CODE.OK);
              });
            }).on('RENAME', (reqid, oldPath, newPath) => {
              this._log(util.format('SFTP RENAME %s->%s', oldPath, newPath));
              var fullnameOld = this._mapKey(userData.path, oldPath);
              var fullnameNew = this._mapKey(userData.path, newPath);

              userData.s3.copyObject({
                Key: fullnameNew,
                CopySource: userData.bucket + '/' + fullnameOld,
                Bucket: userData.bucket
              }, (err, data) => {
                if(err) {
                  this._log(util.format('S3 error copying %s to %s: %s', fullnameOld, fullnameNew, err));
                  return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                }

                userData.s3.deleteObject({
                  Key: fullnameOld,
                  Bucket: userData.bucket
                }, (err, data) => {
                  if(err) {
                    this._log(util.format('S3 error deleting object %s: %s', fullnameOld, err));
                    return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                  }

                  this._log('File renamed');
                  this.emit('file-renamed', { path: fullnameNew, oldPath: fullnameOld, username: userData.username });
                  return sftpStream.status(reqid, STATUS_CODE.OK);
                });
              });
            }).on('STAT', (reqid: number, path: string) => onStat(this, reqid, path))
              .on('LSTAT', (reqid: number, path: string) => onStat(this, reqid, path));
            function onStat(self: SFTPS3Server, reqid: number, path: string) {
              self._log(util.format('SFTP STAT/LSTAT %s', path));
              var fullname = self._mapKey(userData.path, path);

              userData.s3.listObjects({
                Prefix: fullname,
                Bucket: userData.bucket
              }, (err, data) => {
                if(err) {
                  self._log(util.format('S3 error listing %s: %s', fullname, err));
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                }

                const exactMatch = _.find(data.Contents, { Key: fullname }) as S3.Object;    //exact filename match
                if(!_.isUndefined(exactMatch)) {
                  let mode = constants.S_IFREG;   // regular file
                  mode |= constants.S_IRWXU;      // read, write, execute for user
                  mode |= constants.S_IRWXG;      // read, write, execute for group
                  mode |= constants.S_IRWXO;      // read, write, execute for other

                  self._log('Retrieved file attrs');
                  const lastMod = exactMatch.LastModified || new Date();
                  sftpStream.attrs(reqid, {
                    mode: mode,
                    uid: 0,
                    gid: 0,
                    size: exactMatch.Size || 0,
                    atime: Math.floor(+lastMod/1000),
                    mtime: Math.floor(+lastMod/1000)
                  });
                  return;
                }
                  
                const directoryMatch = _.find(data.Contents, { Key: fullname + '/.dir' });    //directory match
                if(directoryMatch) {
                  var mode = constants.S_IFDIR;   // directory
                  mode |= constants.S_IRWXU;      // read, write, execute for user
                  mode |= constants.S_IRWXG;      // read, write, execute for group
                  mode |= constants.S_IRWXO;      // read, write, execute for other

                  self._log('Retrieved directory attrs');
                  const lastMod = directoryMatch.LastModified || new Date();
                  sftpStream.attrs(reqid, {
                    mode: mode,
                    uid: 0,
                    gid: 0,
                    size: 1,
                    atime: Math.floor(+lastMod/1000),
                    mtime: Math.floor(+lastMod/1000)
                  });
                  return;
                }
                  
                //No matches
                self._log(util.format('Key %s not in listing', fullname));
                return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              });
            }
          });
        });
      })
      .on('end', () => {

      });
    });

    this.ssh.listen(port, bindAddress, function() {
      if(callback)
        callback(port);
    });
  }

  /**
   * Stop listener
   *
   * @param {Function} cb - Callback for when stop is complete
   */
  stop(cb: (err: Error) => any) {
    if(this.ssh) {
      this.ssh.close(cb);
      this.ssh = null;
    }
    else {
      process.nextTick(cb);
    }
  }

  //------------------------- Private Methods -------------------------------------

  _log(...args: Array<any>) {
    if (this.loggingEnabled) {
      console.log(...args);
    }
  }

  _mapKey(path: string, filename: string) {
    var p = filename;
    p = p.replace('\\\\', '/');
    p = p.replace('\\.\\', '/');
    p = p.replace('\\', '/');
    p = _path.normalize(p);
    while(p.indexOf('\\') >= 0)
      p = p.replace('\\', '/');
    if(!p.startsWith('/'))
      p = '/' + p;
    return path + p;
  }
}

