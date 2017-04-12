/// <reference path="./typings/aws-sdk/aws-sdk.d.ts" />

declare module 'node-sftp-s3' {

  import * as AWS from 'aws-sdk';
  import { EventEmitter } from 'events';

  export class SFTPS3Server extends EventEmitter {
    constructor(s3: AWS.S3);

    /**
     * Enables logging to standard output
     */
    enableLogging(): void;

    /**
     * Disables logging
     */
    disableLogging(): void;

    /**
     * Adds a public key for authentication for a username
     *
     * @param {string} key
     * @param {string} username - username for specified key
     * @param {string} [ns] - Additional path prefix
     */
    addPublicKey(key: string, username: string, ns?: string): void;

    /**
     * Remove the public key for a username
     *
     * @param {string} username
     */
    removePublicKey(username: string): void;

    /**
     * Remove all public keys 
     */
    removeAllPublicKeys(): void;

    /**
     * Add a host key. You need at least one host key before you can start the server.
     *
     * @param {string} key
     */
    addHostKey(key: string): void;

    /**
     * Starts the SFTP server listening
     *
     * @param {number} port
     * @param {string} bindAddress
     * @param {Function} [callback]
     */
    listen(port: number, bindAddress: string, callback?: (port: number) => void): void;

    /**
     * Stop listener
     *
     * @param {Function} cb - Callback for when stop is complete
     */
    stop(cb: () => void): void;
  }

}
