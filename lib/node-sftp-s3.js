'use strict';

var crypto = require('crypto');
var _path = require('path');
var constants = require('constants');
var Readable = require('stream').Readable;

var _ = require('lodash');
var buffersEqual = require('buffer-equal-constant-time');
var ssh2 = require('ssh2');
var utils = ssh2.utils;
var OPEN_MODE = ssh2.SFTP_OPEN_MODE;
var STATUS_CODE = ssh2.SFTP_STATUS_CODE;

class SFTPS3Server {
  constructor(s3Instance) {
    this.s3 = s3Instance;
    this.publicKeys = [];
  }

  /**
   * Adds a public key for authentication
   * 
   * @param {string} key
   * @param {string} path - root directory for specified key
   */
  addPublicKey(key, path) {
    var pubKey = utils.genPublicKey(utils.parseKey(key));
    this.publicKeys.push({ key: pubKey, path: _path.normalize(path) });
  }

  _findKey(key) {
    for (var idx = 0; idx < this.publicKeys.length; idx++) {
      var pubKey = this.publicKeys[idx];
      if(key.algo === pubKey.key.fulltype &&
         buffersEqual(key.data, pubKey.key.public)) {
        return pubKey;
      }
    }
  }

  _mapKey(path, filename) {
    return path + '/' + _path.normalize(filename);
  }

  /**
   * Starts the SFTP server listening
   * 
   * @param {number} port
   * @param {string} bindAddress
   * @param {Function} [callback]
   */
  listen(port, bindAddress, callback) {
    this.ssh = new ssh2.Server({
      hostKeys: this.hostKeys
    }, (client) => {
      var pubKey;
      client.on('authentication', (ctx) => {
        if(ctx.method !== 'publickey') {
          return ctx.reject();
        }

        pubKey = this._findKey(ctx.key);
        if(!pubKey) {
          return ctx.reject();
        }

        if(ctx.signature) {
          var verifier = crypto.createVerify(ctx.sigAlgo);
          verifier.update(ctx.blob);
          if(verifier.verify(pubKey.key.publicOrig, ctx.signature))
            return ctx.accept();
          else
            return ctx.reject();
        }
        else {
          return ctx.reject();
        }
      })
      .on('ready', () => {
        client.on('session', (accept, reject) => {
          var session = accept();
          session.on('sftp', (accept, reject) => {
            var openFiles = {};
            var openDirs = {};
            var handleCount = 0;

            var sftpStream = accept();
            sftpStream.on('OPEN', (reqid, filename, flags, attrs) => {
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
                var handle = new Buffer(4);
                var stream = new Readable;

                openFiles[handleCount] = { flags: flags, filename: filename, fullname: fullname, stream: stream };
                var state = openFiles[handleCount];
                handle.writeUInt32BE(handleCount++, 0, true);
                sftpStream.handle(reqid, handle);

                this.s3.putObject({
                  Key: fullname,
                  Body: stream
                }, (err, data) => {
                  if(err)
                    state.errored = true;
                });
              }
              else {
                return sftpStream.status(reqid, STATUS_CODE.OP_UNSUPPORTED);
              }
            }).on('READ', (reqid, handle, offset, length) => {
              if(handle.length !== 4 || !openFiles[handle.readUInt32BE(0, true)])
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);
              
              var state = openFiles[handle.readUInt32BE(0, true)];
              if(!(state.flags & OPEN_MODE.READ))
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);
               
              if(state.read)
                return sftpStream.status(reqid, STATUS_CODE.EOF);
              
              if(offset + length > state.size)
                length = state.size - offset;

              if(offset >= state.size || length === 0)
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);

              if(offset + length >= state.size) {
                state.read = true;
              }

              this.s3.getObject({
                 Key: state.fullname,
                 Range: `bytes ${offset}-${offset+length-1}/${state.size}`
              }, function(err, data) {
                if(err)
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);

                sftpStream.data(reqid, data.Body);
              });

            }).on('WRITE', (reqid, handle, offset, data) => {
              if (handle.length !== 4 || !openFiles[handle.readUInt32BE(0, true)])
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);
              
              var state = openFiles[handle.readUInt32BE(0, true)];
              if(!(state.flags & OPEN_MODE.WRITE))
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);

              if(state.errored)
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);
              
              state.stream.push(data);
              return sftpStream.status(reqid, STATUS_CODE.OK);
            }).on('OPENDIR', (reqid, path) => {
              var fullname = this._mapKey(pubKey.path, path);

              this.s3.listObjects({
                Prefix: fullname
              }, (err, data) => {
                if(err)
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                
                if(data.Contents.length === 0)
                  return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                
                var handle = new Buffer(4);

                openDirs[handleCount] = { fullname: fullname, listings: data.Contents };
                handle.writeUInt32BE(handleCount++, 0, true);
                sftpStream.handle(reqid, handle);
              });
            }).on('READDIR', (reqid, handle) => {
              if (handle.length !== 4 || !openDirs[(handle.readUInt32BE(0, true))])
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);

              var state = openDirs[(handle.readUInt32BE(0, true))];

              if(state.read)
                return sftpStream.status(reqid, STATUS_CODE.EOF);
              
              state.read = true;

              sftpStream.name(reqid, state.listings.map((l) => {
                var filename = l.Key.substring(l.Key.length - state.fullname.length).split('/')[0];
                
                var mode = constants.S_IFREG;
                mode |= constants.S_IRWXU; // read, write, execute for user
                mode |= constants.S_IRWXG; // read, write, execute for group
                mode |= constants.S_IRWXO; // read, write, execute for other

                var attrs = {
                  mode: mode,
                  uid: 0,
                  gid: 0,
                  size: l.Size,
                  atime: l.LastModified,
                  mtime: l.LastModified
                };

                return {
                  filename: filename,
                  longname: filename,
                  attrs: attrs
                };
              }));

            }).on('CLOSE', (reqid, handle) => {
              var fnum = handle.readUInt32BE(0, true);

              if (handle.length !== 4 || (!openFiles[fnum] && !openDirs[fnum]))
                return sftpStream.status(reqid, STATUS_CODE.FAILURE);
              
              if(openFiles[fnum]) {
                if(openFiles[fnum].errored)
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);

                if (openFiles[fnum].flags & OPEN_MODE.WRITE)
                  openFiles[fnum].stream.push(null);

                delete openFiles[fnum];
              }
              else {
                delete openDirs[fnum];
              }

              sftpStream.status(reqid, STATUS_CODE.OK);
            }).on('REMOVE', (reqid, path) => {
              var fullname = this._mapKey(pubKey.path, path);

              this.s3.deleteObject({
                Key: fullname
              }, function(err, data) {
                if(err)
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                
                return sftpStream.status(reqid, STATUS_CODE.OK);
              });
            }).on('RMDIR', (reqid, path) => {
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
                  
                  return sftpStream.status(reqid, STATUS_CODE.OK);
                });
              });
            }).on('MKDIR', (reqid, path, attrs) => {
              var fullname = this._mapKey(pubKey.path, _path.join(path, '.dir'));

              this.s3.putObject({
                Key: fullname,
                Body: ''
              }, (err, data) => {
                if(err)
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                
                return sftpStream.status(reqid, STATUS_CODE.OK);
              });
            }).on('RENAME', (reqid, oldPath, newPath) => {
              var fullnameOld = this._mapKey(pubKey.path, oldPath);
              var fullnameNew = this._mapKey(pubKey.path, newPath);

              this.s3.copyObject({
                Key: fullnameNew,
                CopySource: fullnameOld
              }, (err, data) => {
                if(err)
                  return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                
                this.s3.deleteObject({
                  Key: fullnameOld
                }, (err, data) => {
                  if(err)
                    return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                
                  return sftpStream.status(reqid, STATUS_CODE.OK);
                });
              });
            }).on('STAT', onStat)
              .on('LSTAT', onStat);
            function onStat(reqid, path) {
              var fullname = this._mapKey(pubKey.path, path);

              this.s3.listObjects({
                Prefix: fullname
              }, (err, data) => {
                if(err)
                  return sftpStream.status(reqid, STATUS_CODE.FAILURE);
                
                var f = _.find(data.Contents, { Key: fullname }); //exact filename match
                if(!f)
                  return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                
                var mode = constants.S_IFREG;
                mode |= constants.S_IRWXU; // read, write, execute for user
                mode |= constants.S_IRWXG; // read, write, execute for group
                mode |= constants.S_IRWXO; // read, write, execute for other

                sftpStream.attrs(reqid, {
                  mode: mode,
                  uid: 0,
                  gid: 0,
                  size: f.Size,
                  atime: f.LastModified,
                  mtime: f.LastModified
                });
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
}

