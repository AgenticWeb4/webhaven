import { readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { atomic, digest, Fault, requireThat, filePath, serial } from './index.js';

const queue = serial();
export class LocalStore {
  constructor(root, { readOnly = false } = {}) {
    this.root = resolve(root);
    this.readOnly = readOnly;
  }
  path(key) {
    filePath(key);
    return join(this.root, key);
  }
  async get(key, max = 32 * 1024 * 1024) {
    try {
      requireThat((await stat(this.path(key))).size <= max, 'Object size exceeded', 413);
      const data = await readFile(this.path(key));
      requireThat(data.length <= max, 'Object size exceeded', 413);
      return { data, etag: digest(data) };
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
  async put(key, data, { expected } = {}) {
    requireThat(!this.readOnly, 'Read-only delivery store', 403);
    return queue(async () => {
      const old = await this.get(key);
      if (expected !== undefined)
        requireThat((old?.etag ?? null) === expected, 'Publication revision conflict', 409);
      await atomic(this.path(key), data);
      return digest(data);
    });
  }
  async list(prefix) {
    filePath(prefix.replace(/\/$/, ''));
    const all = [];
    const walk = async (dir, start) => {
      for (const f of await readdir(dir, { withFileTypes: true }).catch((e) => {
        if (e.code === 'ENOENT') return [];
        throw e;
      })) {
        if (f.name.startsWith('.')) continue;
        const key = `${start}${f.name}`;
        if (f.isDirectory()) await walk(join(dir, f.name), key + '/');
        else if (f.isFile()) all.push(key);
      }
    };
    await walk(join(this.root, prefix), prefix);
    return all;
  }
}
export class S3Store {
  constructor({
    bucket,
    prefix = '',
    endpoint,
    region = 'us-east-1',
    readOnly = false,
    client,
    credentials,
  }) {
    requireThat(bucket, 'S3 bucket is required');
    this.bucket = bucket;
    this.prefix = prefix ? prefix.replace(/\/$/, '') + '/' : '';
    this.readOnly = readOnly;
    if (this.prefix) filePath(this.prefix.slice(0, -1));
    this.client =
      client ||
      new S3Client({
        endpoint,
        region,
        credentials,
        forcePathStyle: true,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
  }
  key(key) {
    filePath(key);
    return this.prefix + key;
  }
  async get(key, max = 32 * 1024 * 1024) {
    try {
      const r = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
        { abortSignal: AbortSignal.timeout(30000) },
      );
      const chunks = [];
      let size = 0;
      try {
        for await (const c of r.Body) {
          size += c.length;
          requireThat(size <= max, 'S3 object size exceeded', 413);
          chunks.push(c);
        }
      } finally {
        r.Body?.destroy?.();
      }
      return {
        data: Buffer.concat(chunks),
        etag: r.ETag,
        type: (r.ContentType || 'application/octet-stream').split(';')[0],
      };
    } catch (e) {
      if (e.$metadata?.httpStatusCode === 404 || e.name === 'NoSuchKey') return null;
      throw e;
    }
  }
  async put(key, data, { expected } = {}) {
    requireThat(!this.readOnly, 'Read-only delivery store', 403);
    const conditional =
      expected === null
        ? { IfNoneMatch: '*' }
        : expected !== undefined
          ? { IfMatch: expected }
          : {};
    try {
      const r = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(key),
          Body: data,
          ...conditional,
        }),
        { abortSignal: AbortSignal.timeout(30000) },
      );
      return r.ETag;
    } catch (e) {
      if ([409, 412].includes(e.$metadata?.httpStatusCode))
        throw new Fault(409, 'Publication revision conflict');
      throw e;
    }
  }
  async list(prefix) {
    const keys = [];
    let token;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix + prefix,
          ContinuationToken: token,
        }),
        { abortSignal: AbortSignal.timeout(30000) },
      );
      for (const o of r.Contents || [])
        if (o.Key && !o.Key.endsWith('/')) keys.push(o.Key.slice(this.prefix.length));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
      requireThat(!r.IsTruncated || token, 'S3 pagination token missing', 502);
    } while (token);
    return keys;
  }
}
export function delivery(env = process.env, readOnly = false) {
  if ((env.DELIVERY_DRIVER || 'local') === 'local')
    return new LocalStore(env.DELIVERY_DIR || 'var/delivery', { readOnly });
  requireThat(env.DELIVERY_DRIVER === 's3', 'DELIVERY_DRIVER must be local or s3');
  return new S3Store({
    bucket: env.S3_BUCKET,
    prefix: env.S3_PREFIX,
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    readOnly,
  });
}
