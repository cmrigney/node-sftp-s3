import { SFTPS3Server } from '../index';

import AWS from 'aws-sdk';
import _ from 'lodash';
import path from 'path';
import fs from 'fs';
import InMemoryAuthHandler from '../lib/InMemoryAuthHandler';

var defaultRegion = process.env.AWS_DEFAULT_REGION
var s3Bucket = process.env.AWS_S3_BUCKET
var s3Prefix = process.env.AWS_S3_PREFIX
var sftpPort = parseInt(process.env.SFTP_PORT || '2222');
var loggingEnabled = process.env.LOGGING_ENABLED

if(_.isUndefined(s3Bucket))
  throw new Error('Please define the s3 bucket with the environment variable AWS_S3_BUCKET');

AWS.config.s3 = {
  region: defaultRegion
};

const s3 = new AWS.S3();

const authHandler = new InMemoryAuthHandler(s3, s3Bucket);

//add users public key
authHandler.addPublicKey(fs.readFileSync(path.join(__dirname, 'keys/id_rsa.pub'), { encoding: 'utf8' }), 'someuser', s3Prefix);

const server = new SFTPS3Server(authHandler);
if(loggingEnabled)
  server.enableLogging();

//When using this module, make sure you generate your own key with openssl!
server.addHostKey(fs.readFileSync(path.join(__dirname, 'keys/server_key_rsa'), { encoding: 'utf8' }));

server.listen(sftpPort, '127.0.0.1', function(port: number) {
  console.log('Listening on ' + port);
});

