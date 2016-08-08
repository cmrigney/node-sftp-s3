# node-sftp-s3
Node JS module for creating an SFTP server with user isolation that uses S3 for file storage.

## Install

`npm install node-sftp-s3`

## Usage

```
var SFTPS3Server = require('node-sftp-s3').SFTPS3Server;

var AWS = require('aws-sdk');
var path = require('path');
var fs = require('fs');

//aws.json contains credentials for S3 access
AWS.config.loadFromPath(path.join(__dirname, 'aws.json'));

var s3 = new AWS.S3({ params: { Bucket: 'testing' } });

var server = new SFTPS3Server(s3);

//You can generate a key with ssh-keygen
server.addHostKey(fs.readFileSync(path.join(__dirname, 'server_key_rsa')));

//Add users' public keys.  These can also be added after the server has already started
server.addPublicKey(fs.readFileSync(path.join(__dirname, 'client_key_rsa.pub')), 'baruser');

server.listen(2222, '127.0.0.1', function(port) {
  console.log('Listening on ' + port);
  //server.stop() will stop the server
});


```

## Events

SFTPServer emits several events.  Each event passes a dictionary object with the listed parameters.

The path parameter includes the user's subfolder name.

 * **client-error** - `{ client: <Object>, error: <Error> }`
 * **login** - `{ username: <string> }`
 * **file-uploaded** - `{ path: <string>, username: <string> }`
 * **file-downloaded** - `{ path: <string>, username: <string> }`
 * **file-deleted** - `{ path: <string>, username: <string> }`
 * **directory-deleted** - `{ path: <string>, username: <string> }`
 * **directory-created** - `{ path: <string>, username: <string> }`
 * **file-renamed** - `{ path: <string>, oldPath: <string>, username: <string> }`

## Notes

Password authentication is NOT currently supported.  Only public/private key auth. It should be simple to add this feature.  A PR is welcome. :)
