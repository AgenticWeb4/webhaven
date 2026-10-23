/**
 * 交付仓统一接口：get 读取、put 条件写入、list 列举。
 * 发布者写入共享键空间；镜像仅拉取，两个进程不导入彼此的业务代码。
 */
import { readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { atomic, digest, Fault, requireThat, filePath, serial } from './index.js';

// 本地条件检查与替换在本进程内串行；跨进程互斥由 Publisher 的目录锁承担。
const queue = serial();
/** 本地目录适配器；根目录由可信运维方管理，Mirror 以只读模式使用。 */
export class LocalStore {
  /** root 是本地交付根目录；readOnly 在每次写入入口拒绝写操作。 */
  constructor(root, { readOnly = false } = {}) {
    this.root = resolve(root);
    this.readOnly = readOnly;
  }
  /** 把已校验的相对对象键映射到根目录，不接受任意磁盘路径。 */
  path(key) {
    filePath(key);
    return join(this.root, key);
  }
  /** 返回有界字节与内容摘要令牌；缺失返回 null，其他读取错误继续抛出。 */
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
  /**
   * 意图：在调用者观察的对象仍未变化时完成替换。
   * expected：undefined 无条件写；null 仅创建；字符串仅替换相同令牌的对象。
   * 步骤：拒绝只读写入 → 串行比较旧摘要 → 原子写入；冲突返回 409。
   */
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
  /** 递归列出指定前缀下的普通文件键；忽略隐藏项，目录不存在时返回空集。 */
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
/** S3 适配器；条件写入由对象存储服务端执行，ETag 仅作为不透明版本令牌。 */
export class S3Store {
  /** 绑定桶、键前缀及连接配置；client 可注入，凭证由 SDK 或显式配置提供。 */
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
  /** 校验逻辑键后附加配置前缀，使来源桶与交付桶可独立命名。 */
  key(key) {
    filePath(key);
    return this.prefix + key;
  }
  /**
   * 有界读取对象，返回 data、服务端 etag 和 MIME 类型；404 返回 null。
   * 逐块检查实际接收大小，并在成功或失败后释放响应流。
   */
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
  /**
   * 意图：把本地与 S3 的条件写入契约保持一致。
   * 步骤：将 expected 映射为创建/匹配条件 → 服务端写入 → 将 409/412 统一为冲突。
   * 返回服务端 ETag；不把 ETag 当作 SHA-256，也不在冲突后盲目覆盖。
   */
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
  /**
   * 遍历全部分页并返回去掉配置前缀的对象键，忽略目录标记。
   * 截断结果缺少后续令牌时拒绝，避免把不完整清单误认为完整来源。
   */
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
/** 按配置创建交付适配器；readOnly 是进程角色的写入约束，不替代 S3 权限策略。 */
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
