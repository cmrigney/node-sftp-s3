import { PublicKey } from "ssh2";
import { ParsedKey } from "ssh2-streams";
import { S3 } from "aws-sdk";
import { PassThrough } from "stream";

export interface FileHandle {
  flags: number;
  filename: string;
  fullname: string;
  size?: number;
  fnum?: number;
  reqid?: number;
  read?: boolean;
  stream?: PassThrough
}

export interface DirectoryHandle {
  fullname: string;
  listings: Array<S3.Object>;
  read?: boolean;
}

export interface UserData {
  username: string;
  key: ParsedKey;
  s3: AWS.S3;
  bucket: string;
  path: string; // prefix
}

export interface AuthResult {
  success: boolean;
  userData?: UserData;
}

export interface AuthHandler {
  publicKeyAuthSupported(): boolean;
  passwordAuthSupported(): boolean;
  authorizePublicKey(
    username: string,
    publicKey: PublicKey
  ): Promise<AuthResult>;
  authorizePassword(username: string, password: string): Promise<AuthResult>;
}
