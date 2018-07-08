import { AuthHandler, AuthResult, UserData } from "./types";
import { PublicKey, utils } from "ssh2";
import _path from 'path';
import _ from 'lodash';
const buffersEqual = require('buffer-equal-constant-time') as (a: Buffer, b: Buffer) => boolean;


export default class InMemoryAuthHandler implements AuthHandler {
  private loggingEnabled?: boolean;

  constructor(private s3: AWS.S3, private bucket: string, private publicKeys: Array<UserData> = []) {
    this.loggingEnabled = true;
  }

  log(...args: Array<any>) {
    if(this.loggingEnabled)
      console.log(...args);
  }

  disableLogging() {
    this.loggingEnabled = false;
  }

  /**
   * Adds a public key for authentication for a username
   */
  addPublicKey(key: string, username: string, ns?: string) {
    const parsedKey = utils.parseKey(key);
    if(parsedKey instanceof Error) {
      this.log(`Failed to parse key for ${username}. Error: ${parsedKey.message}`);
      return { success: false, error: parsedKey };
    }
    else {
      var pubKey = utils.genPublicKey(parsedKey);
      var path = _path.normalize(username);
      if(ns) {
        path = _path.join(_path.normalize(ns), path);
      }

      while (path.indexOf('\\') >= 0)
        path = path.replace('\\', '/');

      this.publicKeys.push({ key: pubKey, username: username, path: path, s3: this.s3, bucket: this.bucket });
      this.log(`Added public key for username ${username}, path ${path}`);
      
      return { success: true };
    }
  }

  /**
   * Remove the public key for a username
   */
  removePublicKey(username: string) {
    _.remove(this.publicKeys, p => {
      return p.username === username;
    });
  }

  publicKeyAuthSupported(): boolean {
    return true;
  }
  passwordAuthSupported(): boolean {
    return false;
  }

  async authorizePublicKey(username: string, key: PublicKey) : Promise<AuthResult> {
    for (var idx = 0; idx < this.publicKeys.length; idx++) {
      if (this.publicKeys[idx]['username'] == username) {
        var pubKey = this.publicKeys[idx];
        if(key.algo === pubKey.key.fulltype &&
          buffersEqual(key.data, pubKey.key.public)) {
          return { success: true, userData: pubKey };
        }
      }
    }
    return { success: false };
  }

  authorizePassword(username: string, password: string): Promise<AuthResult> {
    throw new Error('Not implemented');
  }
}