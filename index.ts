'use strict';

import SFTPS3Server from './lib/node-sftp-s3';
import InMemoryAuthHandler from './lib/InMemoryAuthHandler';
import { AuthHandler, AuthResult } from './lib/types';
import { PublicKey, utils } from 'ssh2';
const parseKey = utils.parseKey;

export { SFTPS3Server, InMemoryAuthHandler, AuthHandler, AuthResult, PublicKey, parseKey };
 