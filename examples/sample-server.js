var sftps3 = require('../index.js');

var AWS = require('aws-sdk');
var path = require('path');
var fs = require('fs');

//You will need your own aws.json placed at the root folder
AWS.config.loadFromPath(path.join(__dirname, '../aws.json'));

var s3 = new AWS.S3({ params: { Bucket: 'sensource-testing' } });

var server = new sftps3.SFTPS3Server(s3);

//When using this module, make sure you generate your own key with openssl!
server.addHostKey(fs.readFileSync(path.join(__dirname, 'keys/server_key_rsa')));

//Add users' keys
server.addPublicKey(fs.readFileSync(path.join(__dirname, 'keys/id_rsa.pub')), 'someuser', 'uploads');

server.listen(2222, '127.0.0.1', function(port) {
  console.log('Listening on ' + port);
});

