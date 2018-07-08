import { S3 } from "aws-sdk";
import _ from 'lodash';
const Range = require('http-range').Range;

type StubS3Object = Partial<S3.Object>;
type Params = any;

export default class S3Stub {
  private Bucket?: string;
  private config: { params: Params };
  private objects: { [k :string]: any };
  private uploadId: number;
  private inc: number;
  private multipart?: any;

  constructor(params: Params) {
    this.Bucket = params.Bucket;
    this.config = {
      params: {
        Bucket: this.Bucket
      }
    };
    this.objects = {};
    this.uploadId = 1;
    this.inc = 0;
  }

  listObjects(params: Params, cb: Function) {
    let prefix = '';
    if(params.Prefix) {
      prefix = params.Prefix;
    }

    const results: Array<StubS3Object> = [];

    _.forOwn(this.objects, (v: any, k: string) => {
      if(k.startsWith(prefix)) {
        results.push({
          Key: k,
          Size: v.size,
          LastModified: v.LastModified
        });
      }
    });

    process.nextTick(() => cb(null, { Contents: results }));
  }

  createMultipartUpload(params: Params, cb: Function) {
    if(this.multipart)
      return process.nextTick(() => cb(new Error('Already in process of multipart upload')));
    var key = params.Key;
    this.multipart = {
      key: key,
      parts: [],
      uploadId: this.uploadId++
    };
    process.nextTick(() => cb(null, { UploadId: this.multipart.uploadId }));
  }

  copyObject(params: Params, cb: Function) {
    var key = params.Key || '';
    var src = params.CopySource;
    var obj = _.find(this.objects, (v: any, k: string) => (this.Bucket + '/' + k) === src);
    if(!obj)
      return process.nextTick(() => cb(new Error('Not found')));
    
    this.objects[key] = {
      data: new Buffer(obj.data),
      size: obj.size,
      LastModified: new Date()
    };
    process.nextTick(() => cb(null, {}));
  }

  deleteObjects(params: Params, cb: Function) {
    var keys = params.Delete.Objects;
    for (var index = 0; index < keys.length; index++) {
      var k = keys[index].Key;
      if(!this.objects[k])
        return process.nextTick(() => cb(new Error('Not found')));
      delete this.objects[k];
    }

    process.nextTick(() => cb(null, {}));
  }

  deleteObject(params: Params, cb: Function) {
    if(!this.objects[params.Key || ''])
      return process.nextTick(() => cb(new Error('Not found')));
    delete this.objects[params.Key || ''];
    process.nextTick(() => cb(null, {}));
  }

  getObject(params: Params, cb: Function) {
    var key = params.Key;
    var range = params.Range;

    var obj = _.find(this.objects, (v: any, k: string) => k === key);
    if(!obj)
      return process.nextTick(() => cb(new Error('Not found')));
    
    var data = obj.data;
    if(range) {
      var r = Range.prototype.parse(range)._ranges[0]._range;
      data = data.slice(r[0], r[1] + 1);
    }

    process.nextTick(() => cb(null, { Body: data, Size: data.length, LastModified: obj.LastModified }));
  }

  uploadPart(params: Params, cb: Function) {
    var key = params.Key;
    var partNum = params.PartNumber - 1;
    var uploadId = params.UploadId;
    var body = params.Body;

    if(!this.multipart || this.multipart.key !== key || this.multipart.uploadId !== uploadId)
      return process.nextTick(() => cb(new Error("Invalid upload key")));
    
    var etag = `abc${this.inc++}`;

    this.multipart.parts[partNum] = { body: body, etag: etag };
    process.nextTick(() => cb(null, { ETag: etag }));
  }

  abortMultipartUpload(params: Params, cb: Function) {
    if(!this.multipart)
      return process.nextTick(() => cb(new Error('No ongoing upload')));
    
    this.multipart = null;
    process.nextTick(() => cb(null, {}));
  }

  completeMultipartUpload(params: Params, cb: Function) {
    var key = params.Key;
    var uploadId = params.UploadId;
    var parts = params.MultipartUpload.Parts;

    if(!this.multipart)
      return process.nextTick(() => cb(new Error('No ongoing upload')));
    
    var data = new Buffer(0);
    parts.forEach((v: any) => {
      var p = v.PartNumber;
      data = Buffer.concat([data, this.multipart.parts[p-1].body]);
    });

    this.objects[key] = {
      data: data,
      size: data.length,
      LastModified: new Date()
    };
    this.multipart = null;
    process.nextTick(() => cb(null, {}));
  }

  upload(params: Params, cb: Function) {
    var key = params.Key;
    var stream = params.Body;
    var buffer = new Buffer(0);
    stream.on('data', (d: any) => {
      buffer = Buffer.concat([buffer, d]);
    });
    stream.on('finish', () => {
      this.objects[key] = { data: buffer, size: buffer.length, LastModified: new Date() };
      cb(null, {});
    });
  }

  putObject(params: Params, cb: Function) {
    var key = params.Key;
    var body = params.Body;
    this.objects[key] = { data: new Buffer(body), size: body.length, LastModified: new Date() };
    process.nextTick(() => cb(null, {}));
  }

}
