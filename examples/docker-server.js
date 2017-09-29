var sftps3 = require('./index.js');

var AWS = require('aws-sdk');
var path = require('path');
var fs = require('fs');
var util = require('util');

//Read config from environment variables
var defaultRegion = process.env.AWS_DEFAULT_REGION
var s3Bucket = process.env.AWS_S3_BUCKET
var s3Prefix = process.env.AWS_S3_PREFIX
var sftpPort = process.env.SFTP_PORT
var loggingEnabled = process.env.LOGGING_ENABLED

// Initialize AWS S3 client
var s3 = new AWS.S3({ params: { Bucket: s3Bucket } });

// Configure S3 client
AWS.config.s3 = {
  region: defaultRegion
}


var server = new sftps3.SFTPS3Server(s3);
if(loggingEnabled)
  server.enableLogging();

//When using this module, make sure you generate your own key with openssl!
server.addHostKey(fs.readFileSync(path.join(__dirname, 'keys/server_key_rsa')));

//Add users' key
// server.addPublicKey(fs.readFileSync(path.join(__dirname, 'keys/id_' + sftpUser + '.pub')), sftpUser, s3Prefix);
//Find keys matching user pattern
var userPattern = new RegExp(/^id_(.*)\.pub$/);
console.log('searching for user public keys');
fs.readdir(path.join(__dirname, 'keys'), '', function(err, files) {
  console.log(util.format('found %d potential keys', files.length));
  files.filter(function(file) {
    console.log(util.format('testing %s', file));
    return userPattern.test(file);
  }).map(function(file) {
    return userPattern.exec(file)[1];
  }).forEach(function(username) {
    console.log(util.format('found public key for user %s', username));
    server.addPublicKey(fs.readFileSync(path.join(__dirname, 'keys/id_' + username + '.pub')), username, s3Prefix);
  });
});

server.listen(sftpPort, '0.0.0.0', function(port) {
  console.log('Listening on ' + port);
});

