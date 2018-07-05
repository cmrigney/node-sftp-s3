var sftps3 = require('../index.js');

var AWS = require('aws-sdk');
var path = require('path');
var fs = require('fs');

var defaultRegion = process.env.AWS_DEFAULT_REGION
var s3Bucket = process.env.AWS_S3_BUCKET
var s3Prefix = process.env.AWS_S3_PREFIX
var sftpPort = process.env.SFTP_PORT
var loggingEnabled = process.env.LOGGING_ENABLED

AWS.config.s3 = {
  region: defaultRegion
};

var s3 = new AWS.S3({ params: { Bucket: s3Bucket } });

var server = new sftps3.SFTPS3Server(s3);
if(loggingEnabled)
  server.enableLogging();

//When using this module, make sure you generate your own key with openssl!
server.addHostKey(fs.readFileSync(path.join(__dirname, 'keys/server_key_rsa')));

//Add users' keys
server.addPublicKey(fs.readFileSync(path.join(__dirname, 'keys/id_rsa.pub')), 'someuser', 'uploads');

server.listen(sftpPort, '127.0.0.1', function(port) {
  console.log('Listening on ' + port);
});

