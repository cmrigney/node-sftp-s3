'use strict';

var chai = require('chai');
var sinon = require('sinon');
var SFTPServer = require('../index.js').SFTPS3Server;
var S3Stub = require('./s3stub.js');
var fs = require('fs');
var path = require('path');

chai.use(require('sinon-chai'));

var Client = require('ssh2').Client;

var expect = chai.expect;

describe("SFTP", function() {

  var s3Instance = new S3Stub({ Bucket: 'test' });
  var server;

  beforeEach(() => {
    server = new SFTPServer(s3Instance);
  });

  afterEach((done) => {
    server.stop(() => done());
  });

  it("Should Authenticate User", function(done) {
    var loginSpy = getEventSpy(server, 'login');
    server.addHostKey(fs.readFileSync(path.join(__dirname, 'keys/server_key_rsa')));
    server.addPublicKey(fs.readFileSync(path.join(__dirname, 'keys/id_rsa.pub')), 'foo');
    server.listen(2222, '127.0.0.1', () => {
      var conn = new Client();
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          conn.end();
          if(err)
            return done(err);
          expect(loginSpy).to.have.been.called;
          done();
        });
      })
      .on('error', (err) => {
        done(err);
      })
      .connect({
        host: '127.0.0.1',
        port: 2222,
        username: 'foo',
        privateKey: fs.readFileSync(path.join(__dirname, 'keys/id_rsa'))
      });

    });
  });

  it("Should Failed to Authenticate User", function(done) {
    server.addHostKey(fs.readFileSync(path.join(__dirname, 'keys/server_key_rsa')));
    server.addPublicKey(fs.readFileSync(path.join(__dirname, 'keys/id_rsa.pub')), 'foo');
    server.listen(2222, '127.0.0.1', () => {
      var conn = new Client();
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          conn.end();
          done(new Error('Incorrectly logged user in'));
        });
      })
      .on('error', () => {
        done();
      })
      .connect({
        host: '127.0.0.1',
        port: 2222,
        username: 'bar',
        privateKey: fs.readFileSync(path.join(__dirname, 'keys/id_rsa'))
      });
    });
  });

  it("Should Write and Read and Delete Correctly", function(done) {
    var uploadedSpy = getEventSpy(server, 'file-uploaded');
    var downloadedSpy = getEventSpy(server, 'file-downloaded');
    var deletedSpy = getEventSpy(server, 'file-deleted');
    server.addHostKey(fs.readFileSync(path.join(__dirname, 'keys/server_key_rsa')));
    server.addPublicKey(fs.readFileSync(path.join(__dirname, 'keys/id_rsa.pub')), 'foo');
    server.addPublicKey(fs.readFileSync(path.join(__dirname, 'keys/id_rsa2.pub')), 'bar');

    server.listen(2222, '127.0.0.1', () => {
      writeTest();

      function writeTest() {
        execClientSFTP('foo', 'keys/id_rsa', server, done, (conn, sftp) => {
          var stream = sftp.createWriteStream('/test.txt');
          stream.on('error', (err) => {
            conn.end();
            done(err);
          });
          stream.end('abc', 'utf8', () => {
            conn.end();
            setTimeout(() => {
              expect(uploadedSpy).to.have.been.calledOnce;
              readTest();
            }, 50);
          });

        });
      }

      function readTest() {
        execClientSFTP('foo', 'keys/id_rsa', server, done, (conn, sftp) => {
          var stream = sftp.createReadStream('/test.txt', { start: 1, end: 2, encoding: 'utf8' });
          stream.on('error', (err) => {
            conn.end();
            done(err);
          });
          var result = '';
          stream.on('data', (d) => result += d);
          stream.on('end', (d) => {
            if(d)
              result += d;

            conn.end();
            expect(result).to.equal('bc');
            setTimeout(() => {
              expect(downloadedSpy).to.have.been.calledOnce;
              readFromAnotherUser();
            }, 100);
          });
        });
      }

      function readFromAnotherUser() {
        execClientSFTP('bar', 'keys/id_rsa2', server, done, (conn, sftp) => {
          var stream = sftp.createReadStream('/test.txt', { start: 1, end: 2, encoding: 'utf8' });
          stream.on('error', (err) => {
            conn.end();
            listFromAnotherUser();
          });
          stream.on('data', (d) => {
            conn.end();
            done(new Error('Should not have been able to read data'));
          });
        });
      }

      function listFromAnotherUser() {
        execClientSFTP('bar', 'keys/id_rsa2', server, done, (conn, sftp) => {
          sftp.readdir('/', (err, lst) => {
            conn.end();
            if(err)
              return done(err);
            
            expect(lst.length).to.equal(0);
            deleteFile();
          });
        });
      }

      function deleteFile() {
        execClientSFTP('foo', 'keys/id_rsa', server, done, (conn, sftp) => {
          sftp.unlink('/test.txt', (err) => {
            conn.end();
            if(err)
              return done(err);
            setTimeout(() => {
              expect(deletedSpy).to.have.been.calledOnce;
              done();
            }, 50);
          });
        });
      }

    });
  });

  it("Create and Remove Directory", function(done) {
    var createDirSpy = getEventSpy(server, 'directory-created');
    var deleteDirSpy = getEventSpy(server, 'directory-deleted');
    server.addHostKey(fs.readFileSync(path.join(__dirname, 'keys/server_key_rsa')));
    server.addPublicKey(fs.readFileSync(path.join(__dirname, 'keys/id_rsa.pub')), 'foo');
    server.addPublicKey(fs.readFileSync(path.join(__dirname, 'keys/id_rsa2.pub')), 'bar');

    server.listen(2222, '127.0.0.1', () => {
      createDir();

      function createDir() {
        execClientSFTP('foo', 'keys/id_rsa', server, done, (conn, sftp) => {
          sftp.mkdir('/somedir', (err) => {
            conn.end();
            if(err)
              return done(err);
            setTimeout(() => {
              expect(createDirSpy).to.have.been.calledOnce;
              removeDir();
            }, 50);
          });
        });
      }

      function removeDir() {
        execClientSFTP('foo', 'keys/id_rsa', server, done, (conn, sftp) => {
          sftp.rmdir('/somedir', (err) => {
            conn.end();
            if(err)
              return done(err);
            setTimeout(() => {
              expect(deleteDirSpy).to.have.been.calledOnce;
              done();
            }, 50);
          });
        });
      }
    });
  });

  it("Rename File", function(done) {
    var renameSpy = getEventSpy(server, 'file-renamed');
    server.addHostKey(fs.readFileSync(path.join(__dirname, 'keys/server_key_rsa')));
    server.addPublicKey(fs.readFileSync(path.join(__dirname, 'keys/id_rsa.pub')), 'foo');
    server.addPublicKey(fs.readFileSync(path.join(__dirname, 'keys/id_rsa2.pub')), 'bar');

    server.listen(2222, '127.0.0.1', () => {
      write();

      function write() {
        execClientSFTP('foo', 'keys/id_rsa', server, done, (conn, sftp) => {
          var stream = sftp.createWriteStream('/test.txt');
          stream.on('error', (err) => {
            conn.end();
            done(err);
          });
          stream.end('abc', 'utf8', () => {
            conn.end();
            rename();
          });
        });
      }

      function rename() {
        execClientSFTP('foo', 'keys/id_rsa', server, done, (conn, sftp) => {
          sftp.rename('/test.txt', '/abc.txt', (err) => {
            conn.end();
            if(err)
              return done(err);
            setTimeout(() => {
              expect(renameSpy).to.have.been.calledOnce;
              ensureRenamed();
            }, 50);
          });
        });
      }

      function ensureRenamed() {
        execClientSFTP('foo', 'keys/id_rsa', server, done, (conn, sftp) => {
          sftp.readdir('/', (err, lst) => {
            conn.end();
            if(err)
              return done(err);
            
            expect(lst.length).to.equal(1);
            expect(lst[0].filename).to.equal('abc.txt');
            done();
          });
        });
      }
    });
  });

  function execClientSFTP(username, key, server, done, fn) {
    var conn = new Client();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        fn(conn, sftp);
      });
    })
    .on('error', (err) => {
      done(err);
    })
    .connect({
      host: '127.0.0.1',
      port: 2222,
      username: username,
      privateKey: fs.readFileSync(path.join(__dirname, key))
    });
  }

  function getEventSpy(obj, event) {
    var x = {};
    x[event] = function noop() {
      //console.log(event + ' called');
    };
    var spy = sinon.spy(x, event);
    obj.on(event, x[event].bind(x));
    return spy;
  }
});