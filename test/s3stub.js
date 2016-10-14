'use strict';
var _ = require('lodash');
var parseRange = require('range-parser');

class S3Stub {
  constructor(params) {
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

  listObjects(params, cb) {
    var prefix = '';
    if(params.Prefix) {
      prefix = params.Prefix;
    }

    var results = [];

    _.forOwn(this.objects, (v, k) => {
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

  createMultipartUpload(params, cb) {
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

  copyObject(params, cb) {
    var key = params.Key;
    var src = params.CopySource;
    var obj = _.find(this.objects, (v, k) => (this.Bucket + '/' + k) === src);
    if(!obj)
      return process.nextTick(() => cb(new Error('Not found')));
    
    this.objects[key] = {
      data: new Buffer(obj.data),
      size: obj.size,
      LastModified: new Date()
    };
    process.nextTick(() => cb(null, {}));
  }

  deleteObjects(params, cb) {
    var keys = params.Delete.Objects;
    for (var index = 0; index < keys.length; index++) {
      var k = keys[index].Key;
      if(!this.objects[k])
        return process.nextTick(() => cb(new Error('Not found')));
      delete this.objects[k];
    }

    process.nextTick(() => cb(null, {}));
  }

  deleteObject(params, cb) {
    if(!this.objects[params.Key])
      return process.nextTick(() => cb(new Error('Not found')));
    delete this.objects[params.Key];
    process.nextTick(() => cb(null, {}));
  }

  getObject(params, cb) {
    var key = params.Key;
    var range = params.Range;

    var obj = _.find(this.objects, (v, k) => k === key);
    if(!obj)
      return process.nextTick(() => cb(new Error('Not found')));
    
    var data = obj.data;
    if(range) {
      range = parseRange(data.length, range)[0];
      data = data.slice(range.start, range.end + 1);
    }

    process.nextTick(() => cb(null, { Body: data, Size: data.length, LastModified: obj.LastModified }));
  }

  uploadPart(params, cb) {
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

  abortMultipartUpload(params, cb) {
    if(!this.multipart)
      return process.nextTick(() => cb(new Error('No ongoing upload')));
    
    this.multipart = null;
    process.nextTick(() => cb(null, {}));
  }

  completeMultipartUpload(params, cb) {
    var key = params.Key;
    var uploadId = params.UploadId;
    var parts = params.MultipartUpload.Parts;

    if(!this.multipart)
      return process.nextTick(() => cb(new Error('No ongoing upload')));
    
    var data = new Buffer(0);
    parts.forEach((v) => {
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

  upload(params, cb) {
    var key = params.Key;
    var stream = params.Body;
    var buffer = new Buffer(0);
    stream.on('data', (d) => {
      buffer = Buffer.concat([buffer, d]);
    });
    stream.on('finish', () => {
      this.objects[key] = { data: buffer, size: buffer.length, LastModified: new Date() };
      cb(null, {});
    });
  }

  putObject(params, cb) {
    var key = params.Key;
    var body = params.Body;
    this.objects[key] = { data: new Buffer(body), size: body.length, LastModified: new Date() };
    process.nextTick(() => cb(null, {}));
  }

}

module.exports = S3Stub;