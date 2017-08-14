'use strict';

var crypto = require('crypto');
var _path = require('path');
var constants = require('constants');
var EventEmitter = require('events').EventEmitter;
var PassThrough = require('stream').PassThrough;

var moment = require('moment');
var _ = require('lodash');
var buffersEqual = require('buffer-equal-constant-time');
var ssh2 = require('ssh2');
var utils = ssh2.utils;
var OPEN_MODE = ssh2.SFTP_OPEN_MODE;
var STATUS_CODE = ssh2.SFTP_STATUS_CODE;

const util = require('util');

class SFTPS3Server extends EventEmitter {
  constructor(s3Instance) {
    super();
    this.s3 = s3Instance;
    this.publicKeys = [];
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
   * Adds a public key for authentication for a username
   *
   * @param {string} key
   * @param {string} username - username for specified key
   * @param {string} [ns] - Additional path prefix
   */
  addPublicKey(key, username, ns) {
    var pubKey = utils.genPublicKey(utils.parseKey(key));
    var path = _path.normalize(username);
    if(ns) {
      path = _path.join(_path.normalize(ns), path);
    }

    while (path.indexOf('\\') >= 0)
      path = path.replace('\\', '/');

    this.publicKeys.push({ key: pubKey, username: username, path: path });
    this._log(util.format('Added public key for username %s, path %s', username, path));
  }

  /**
   * Remove the public key for a username
   *
   * @param {string} username
   */
  removePublicKey(username) {
    const self = this;
    _.remove(this.publicKeys, (p) => {
      self._log(util.format('Removed public key for username %s', username));
      return p.username === username;
    });
  }

  /**
   * Remove all public keys
   */
  removeAllPublicKeys() {
    this._log(util.format('Removed all public keys'));
    this.publicKeys = [];
  }

  /**
   * Add a host key. You need at least one host key before you can start the server.
   *
   * @param {string} key
   */
  addHostKey(key) {
    this._log('Added server key');
    this.hostKeys.push(key);
  }

  /**
   * Starts the SFTP server listening
   *
   * @param {number} port
   * @param {string} bindAddress
   * @param {Function} [callback]
   */
  listen(port, bindAddress, callback) {
    if(this.ssh)
      throw new Error('Already running');

    this.ssh = new ssh2.Server({
      hostKeys: this.hostKeys
    }, (client) => {
      var pubKey;
      client.on('error', (err) => {
        this.emit('client-error', { client: client, error: err });
      });
      client.on('authentication', (ctx) => {
        if(ctx.method !== 'publickey') {
          return ctx.reject(['publickey']);
        }

        pubKey = this._findKey(ctx.username, ctx.key);
        if(!pubKey) {
          this._log('public key not found');
          return ctx.reject(['publickey not found']);
        }

        if(ctx.signature) {
          var verifier = crypto.createVerify(ctx.sigAlgo);
          verifier.update(ctx.blob);
          if(verifier.verify(pubKey.key.publicOrig, ctx.signature)) {
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
      .on('ready', () => {
        client.on('session', (accept, reject) => {
          var session = accept();
          this._log(util.format('logging on %s', pubKey.username));
          this.emit('login', { username: pubKey.username });
          session.on('sftp', (accept, reject) => {
            var openFiles = {};
            var openDirs = {};
            var handleCount = 0;

            var sftpStream = accept();
            sftpStream.on('OPEN', (reqid, filename, flags, attrs) => {
              this._log(util.format('SFTP %s', 'OPEN'));
              if(filename.endsWith('\\') || filename.endsWith('/')) {
                filename = filename.substring(0, filename.length - 1 );
              }
              var fullname = this._mapKey(pubKey.path, filename);

              if(flags & OPEN_MODE.READ) {
                this.s3.listObjects({
                  Prefix: fullname
                }, (err, data) => {
                  if(err)
                    return sftpStream.status(reqid, STATUS_CODE.FAILURE);

                  var f = _.find(data.Contents, { Key: fullname }); //exact filename match
                  if(!f)
                    return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);

                  var handle = new Buffer(4);

                  openFiles[handleCount] = { flags: flags, filename: filename, size: f.Size, fullname: fullname };
                  handle.writeUInt32BE(handleCount++, 0, true);
                  sftpStream.handle(reqid, handle);
                });
              }
              else if(flags & OPEN_MODE.WRITE) {
                var stream = new PassThrough();

                var handle = new Buffer(4);
                openFiles[handleCount] = { flags: flags, filename: filename, fullname: fullname, stream: stream };
                var state = openFiles[handleCount];
                handle.writeUInt32BE(handleCount++, 0, true);
                sftpStream.handle(reqid, handle);

                this.s3.upload({
                  Key: fullname,
                  Body: stream
                }, (err, data) => {
                  //Done uploading
                  delete openFiles[state.fnum];

                  if(err)
                    return sftpStream.status(state.reqid, STATUS_CODE.FAILURE);

                  this.emit('file-uploaded', { path: state.fullname, username: pubKey.username });
                  sftpStream.status(state.reqid, STATUS_CODE.OK);
                });
              }
              else {
                return sftpStream.status(reqid, STATUS_CODE.OP_UNSUPPORTED);
              }
            }).on('READ', (reqid, handle, offset, length) => {
              this._log(util.format('SFTP %s', 'READ'));
              if(handle.length !== 4 || !openFiles[handle.readUInt32BE(0, true)])
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);

              var state = openFiles[handle.readUInt32BE(0, true)];
              if(!(state.flags & OPEN_MODE.READ))
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);

              if(state.read) {
                return sftpStream.status(reqid, STATUS_CODE.EOF);
              }

              if(offset + length > state.size)
                length = state.size - offset;

              if(offset >= state.size || length === 0)
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);

              if(offset + length >= state.size) {
                state.read = true;
              }

              this.s3.getObject({
                 Key: state.fullname,
                 Range: `bytes=${offset}-${offset+length-1}`
              }, function(err, data) {
                if(err || data.Body.length === 0)
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);

                sftpStream.data(reqid, data.Body);
              });

            }).on('WRITE', (reqid, handle, offset, data) => {
              this._log(util.format('SFTP %s', 'WRITE'));
              if (handle.length !== 4 || !openFiles[handle.readUInt32BE(0, true)])
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);

              var state = openFiles[handle.readUInt32BE(0, true)];
              if(!(state.flags & OPEN_MODE.WRITE))
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);

              state.stream.write(new Buffer(data), (err, data) => {
                if(err) {
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                }

                sftpStream.status(reqid, STATUS_CODE.OK);
              });
            }).on('OPENDIR', (reqid, path) => {
              this._log(util.format('SFTP %s', 'OPENDIR'));
              var fullname = this._mapKey(pubKey.path, path);
              var isRoot = (path === '/');

              this.s3.listObjects({
                Prefix: fullname
              }, (err, data) => {
                if(err)
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);

                if(data.Contents.length === 0 && !isRoot)
                  return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);

                var handle = new Buffer(4);

                var listings = _.filter(data.Contents, (c) => {
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

                openDirs[handleCount] = { fullname: fullname, listings: listings };
                handle.writeUInt32BE(handleCount++, 0, true);
                sftpStream.handle(reqid, handle);
              });
            }).on('READDIR', (reqid, handle) => {
              this._log(util.format('SFTP %s', 'READDIR'));
              if (handle.length !== 4 || !openDirs[(handle.readUInt32BE(0, true))])
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);

              var state = openDirs[(handle.readUInt32BE(0, true))];

              if(state.read)
                return sftpStream.status(reqid, STATUS_CODE.EOF);

              state.read = true;

              sftpStream.name(reqid, state.listings.map((l) => {
                var filename = l.Key.substring(state.fullname.length);
                if(filename.startsWith('/'))
                  filename = filename.substring(1);
                if(filename.endsWith('/'))
                  filename = filename.substring(0, filename.length - 1);

                var mode = 0;
                mode |= constants.S_IRWXU; // read, write, execute for user
                mode |= constants.S_IRWXG; // read, write, execute for group
                mode |= constants.S_IRWXO; // read, write, execute for other

                if(l.IsDir)
                  mode |= constants.S_IFDIR;
                else
                  mode |= constants.S_IFREG;

                var attrs = {
                  mode: mode,
                  uid: 0,
                  gid: 0,
                  size: (l.IsDir ? 1 : l.Size),
                  atime: l.LastModified,
                  mtime: l.LastModified
                };

                var lastModified = moment(l.LastModified);

                return {
                  filename: filename,
                  longname: `${l.IsDir ? 'd' : '-'}rw-rw-rw-    1 ${pubKey.username}  ${pubKey.username} ${l.Size} ${lastModified.format('MMM D')} ${moment().year() === lastModified.year() ? lastModified.format('HH:mm') : lastModified.format('YYYY')} ${_path.basename(filename)}`,
                  attrs: attrs
                };
              }));

            }).on('REALPATH', (reqid, path) => {
              this._log(util.format('SFTP %s', 'REALPATH'));
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

              var fullname = this._mapKey(pubKey.path, path);

              this._log(util.format('listing objects under %s (%s)', fullname, p));
              this.s3.listObjects({
                Prefix: fullname
              }, (err, data) => {
                if(err) {
                  this._log(util.format('error: %s\n%s', err, err.stack));
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                }

                this._log(util.format('%d objects found', data.Contents.length));

                var realObj = _.find(data.Contents, (c) => c.Key === fullname || c.Key === (fullname + '/.dir'));

                if(realObj && realObj.Key.endsWith('.dir')) {
                  this._log(util.format('$s is a directory', realObj.Key));
                  realObj.IsDir = true;
                }

                if(!realObj && p === '/') {
                  this._log(util.format('listing empty root directory %s', p));
                  realObj = {
                    IsDir: true,
                    LastModified: new Date(),
                    Size: 0
                  };
                }

                if(!realObj) {
                  this._log(util.format('no objects found at %s', fullname));
                  return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                }

                var lastModified = moment(realObj.LastModified);

                var name = [{
                  filename: p,
                  longname: `${realObj.IsDir ? 'd' : '-'}rw-rw-rw-    1 ${pubKey.username}  ${pubKey.username} ${realObj.Size} ${lastModified.format('MMM D')} ${moment().year() === lastModified.year() ? lastModified.format('HH:mm') : lastModified.format('YYYY')} ${_path.basename(p) || p}`
                }];

                sftpStream.name(reqid, name);
              });
            }).on('CLOSE', (reqid, handle) => {
              this._log(util.format('SFTP %s', 'CLOSE'));
              var fnum = handle.readUInt32BE(0, true);

              if (handle.length !== 4 || (!openFiles[fnum] && !openDirs[fnum]))
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);


              if(openFiles[fnum]) {
                var state = openFiles[fnum];

                if (openFiles[fnum].flags & OPEN_MODE.WRITE) {
                  state.reqid = reqid;
                  state.fnum = fnum;
                  state.stream.end();
                  return;
                }
                else {
                  this.emit('file-downloaded', { path: state.fullname, username: pubKey.username });
                  delete openFiles[fnum];
                }
              }
              else {
                delete openDirs[fnum];
              }

              sftpStream.status(reqid, STATUS_CODE.OK);
            }).on('REMOVE', (reqid, path) => {
              this._log(util.format('SFTP %s', 'REMOVE'));
              var fullname = this._mapKey(pubKey.path, path);

              this.s3.deleteObject({
                Key: fullname
              }, (err, data) => {
                if(err)
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);

                this.emit('file-deleted', { path: fullname, username: pubKey.username });
                sftpStream.status(reqid, STATUS_CODE.OK);
              });
            }).on('RMDIR', (reqid, path) => {
              this._log(util.format('SFTP %s', 'RMDIR'));
              var fullname = this._mapKey(pubKey.path, path);

              this.s3.listObjects({
                Prefix: fullname
              }, (err, data) => {
                if(err)
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);

                var keys = data.Contents.map((c) => {
                  return {
                    Key: c.Key
                  };
                });

                if(keys.length === 0)
                  return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);

                this.s3.deleteObjects({
                  Delete: {
                    Objects: keys
                  }
                }, (err, data) => {
                  if(err)
                    return sftpStream.status(reqid, STATUS_CODE.FAILURE);

                  this.emit('directory-deleted', { path: fullname, username: pubKey.username });
                  return sftpStream.status(reqid, STATUS_CODE.OK);
                });
              });
            }).on('MKDIR', (reqid, path, attrs) => {
              this._log(util.format('SFTP %s', 'MKDIR'));
              var procPath = _path.join(path, '.dir');
              if(procPath.endsWith('/'))
                procPath = procPath.slice(0, -1);

              var fullname = this._mapKey(pubKey.path, procPath);

              this.s3.putObject({
                Key: fullname,
                Body: ''
              }, (err, data) => {
                if(err)
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);

                this.emit('directory-created', { path: fullname, username: pubKey.username });
                return sftpStream.status(reqid, STATUS_CODE.OK);
              });
            }).on('RENAME', (reqid, oldPath, newPath) => {
              this._log(util.format('SFTP %s', 'RENAME'));
              var fullnameOld = this._mapKey(pubKey.path, oldPath);
              var fullnameNew = this._mapKey(pubKey.path, newPath);

              this.s3.copyObject({
                Key: fullnameNew,
                CopySource: this.s3.config.params.Bucket + '/' + fullnameOld
              }, (err, data) => {
                if(err)
                  return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);

                this.s3.deleteObject({
                  Key: fullnameOld
                }, (err, data) => {
                  if(err)
                    return sftpStream.status(reqid, STATUS_CODE.FAILURE);

                  this.emit('file-renamed', { path: fullnameNew, oldPath: fullnameOld, username: pubKey.username });
                  return sftpStream.status(reqid, STATUS_CODE.OK);
                });
              });
            }).on('STAT', onStat.bind(this))
              .on('LSTAT', onStat.bind(this));
            function onStat(reqid, path) {
              this._log(util.format('SFTP %s', 'STAT/LSTAT'));
              var fullname = this._mapKey(pubKey.path, path);

              this.s3.listObjects({
                Prefix: fullname
              }, (err, data) => {
                if(err)
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);

                var exactMatch = _.find(data.Contents, { Key: fullname });    //exact filename match
                if(exactMatch) {
                  var mode = constants.S_IFREG;   // regular file
                  mode |= constants.S_IRWXU;      // read, write, execute for user
                  mode |= constants.S_IRWXG;      // read, write, execute for group
                  mode |= constants.S_IRWXO;      // read, write, execute for other

                  sftpStream.attrs(reqid, {
                    mode: mode,
                    uid: 0,
                    gid: 0,
                    size: exactMatch.Size,
                    atime: exactMatch.LastModified,
                    mtime: exactMatch.LastModified
                  });
                  return;
                }
                  
                var directoryMatch = _.find(data.Contents, { Key: fullname + '/.dir' });    //directory match
                if(directoryMatch) {
                  var mode = constants.S_IFDIR;   // directory
                  mode |= constants.S_IRWXU;      // read, write, execute for user
                  mode |= constants.S_IRWXG;      // read, write, execute for group
                  mode |= constants.S_IRWXO;      // read, write, execute for other

                  sftpStream.attrs(reqid, {
                    mode: mode,
                    uid: 0,
                    gid: 0,
                    size: 1,
                    atime: directoryMatch.LastModified,
                    mtime: directoryMatch.LastModified
                  });
                  return;
                }
                  
                //No matches
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
  stop(cb) {
    if(this.ssh) {
      this.ssh.close(cb);
      this.ssh = null;
    }
    else {
      process.nextTick(cb);
    }
  }

  //------------------------- Private Methods -------------------------------------

  _log() {
    if (this.loggingEnabled) {
      console.log.apply(console, arguments);
    }
  }

  _findKey(username, key) {
    for (var idx = 0; idx < this.publicKeys.length; idx++) {
      if (this.publicKeys[idx]['username'] == username) {
        var pubKey = this.publicKeys[idx];
        if(key.algo === pubKey.key.fulltype &&
           buffersEqual(key.data, pubKey.key.public)) {
          return pubKey;
        }
      }
    }
  }

  _mapKey(path, filename) {
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

module.exports = SFTPS3Server;
