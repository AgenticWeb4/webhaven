/**
 * 共享基础约束：输入校验、持久写入、进程互斥和清单验证。
 * 业务流程由 Publisher 与 Mirror 编排；这里不持有发布状态。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, readFile, stat, lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** 可映射到 HTTP 状态码的预期拒绝；未分类异常仍由入口隐藏内部细节。 */
export class Fault extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
/** 断言业务前置条件；失败抛出 Fault，默认视为输入错误（400）。 */
export const requireThat = (condition, message, status = 400) => {
  if (!condition) throw new Fault(status, message);
};
/** 对原始字节计算 SHA-256；用于内容身份与完整性校验。 */
export const digest = (body) => createHash('sha256').update(body).digest('hex');
/** 校验集合、版本和操作标识；仅接受至多 64 位的受限 ASCII 名称。 */
export function identifier(value) {
  requireThat(
    typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value),
    'Invalid identifier',
  );
  return value;
}
/** 校验相对文件键；拒绝路径穿越、隐藏段和可产生 URL 歧义的字符。 */
export function filePath(value) {
  requireThat(
    typeof value === 'string' && value.length <= 512 && !/[\\\x00-\x1f\x7f:#?%]/.test(value),
    'Invalid file path',
  );
  requireThat(
    value.split('/').every((p) => p && p !== '.' && p !== '..' && !p.startsWith('.')),
    'Unsafe file path',
  );
  return value;
}
/** 验证小写 SHA-256 摘要，避免将任意路径用作对象键。 */
export function hex(value) {
  requireThat(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Invalid SHA-256');
  return value;
}
/**
 * 意图：使读者看到完整旧文件或完整新文件。
 * 步骤：同目录独占创建临时文件 → 写入并刷盘 → 重命名替换 → 刷新目录。
 * 约束：依赖同文件系统的重命名语义；异常向上传播，临时文件最终清理。
 */
export async function atomic(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const f = await open(temp, 'wx', 0o600);
    try {
      await f.writeFile(body);
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(temp, path);
    const dir = await open(dirname(path), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
}
/** 读取持久 JSON；仅文件不存在时返回 fallback，损坏 JSON 必须暴露错误。 */
export async function jsonFile(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}
/** 使用与二进制文件相同的原子写入路径保存 JSON。 */
export const writeJson = (path, value) => atomic(path, JSON.stringify(value));
/**
 * 意图：一个数据目录只交给一个本机进程使用。
 * 步骤：独占创建 PID 锁 → 冲突时探测持有者 → 确认进程不存在才移除旧锁。
 * 返回释放函数；这不是跨主机锁，无法判断的锁需要人工检查。
 */
export async function lock(root) {
  await mkdir(root, { recursive: true });
  const path = join(root, '.process-lock');
  try {
    const h = await open(path, 'wx');
    await h.writeFile(String(process.pid));
    await h.close();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(await readFile(path, 'utf8'));
    requireThat(Number.isInteger(pid) && pid > 0, 'Invalid process lock; inspect manually', 503);
    try {
      process.kill(pid, 0);
      throw new Fault(503, 'Data directory already has a running process');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    await rm(path);
    return lock(root);
  }
  return async () => {
    if ((await readFile(path, 'utf8').catch(() => '')) === String(process.pid)) await rm(path);
  };
}
/** 返回进程内串行执行器；当前调用接收自己的失败，后续任务仍可继续执行。 */
export function serial() {
  let tail = Promise.resolve();
  return (action) => {
    const result = tail.then(action);
    // 队尾只负责保持队列可用；原始 result 保留拒绝结果供调用者处理。
    tail = result.catch(() => {});
    return result;
  };
}
/** 有界读取请求体；逐块累计，超过 limit 字节即拒绝（413）。 */
export async function body(request, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    requireThat(size <= limit, 'Request too large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
/** 输出不缓存的 JSON 控制响应；内容文件响应由 Mirror 自己处理。 */
export function respond(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}
/** 递归列出目录中的普通文件及相对路径；拒绝符号链接和特殊文件。 */
export async function directoryFiles(root) {
  root = resolve(root);
  const files = [];
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      filePath(relative);
      requireThat(!entry.isSymbolicLink(), 'Symlinks are not accepted');
      if (entry.isDirectory()) await walk(join(dir, entry.name), relative + '/');
      else {
        requireThat(entry.isFile(), 'Only regular files are accepted');
        files.push({ path: relative, absolute: join(dir, entry.name) });
      }
    }
  }
  await walk(root);
  return files;
}
/**
 * 意图：在创建归档或接收版本前，验证同一套清单约束。
 * 步骤：身份和数量 → 路径、摘要、大小、类型 → 文件/目录冲突 → 总量与覆盖声明。
 * 返回声明的总字节数；这里不读取对象，实际内容校验由归档或镜像执行。
 */
export function manifestValid(m, limits = {}) {
  requireThat(m?.schema === 1, 'Unsupported manifest schema');
  identifier(m.collection);
  identifier(m.version);
  requireThat(
    Array.isArray(m.files) && m.files.length > 0 && m.files.length <= (limits.files || 2000),
    'Invalid file count',
  );
  const paths = new Set();
  let total = 0;
  for (const f of m.files) {
    filePath(f.path);
    hex(f.sha256);
    requireThat(!paths.has(f.path), 'Duplicate file path');
    paths.add(f.path);
    requireThat(
      Number.isSafeInteger(f.bytes) &&
        f.bytes >= 0 &&
        f.bytes <= (limits.fileBytes || 20 * 1024 * 1024),
      'Invalid file size',
    );
    requireThat(
      typeof f.type === 'string' && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(f.type),
      'Invalid MIME type',
    );
    total += f.bytes;
  }
  // a 与 a/b 不能同时是文件；否则在落盘时会出现文件/目录身份冲突。
  for (const path of paths) {
    let prefix = '';
    for (const p of path.split('/').slice(0, -1)) {
      prefix += p;
      requireThat(!paths.has(prefix), 'File/directory collision');
      prefix += '/';
    }
  }
  requireThat(
    total <= (limits.totalBytes || 250 * 1024 * 1024),
    'Version size limit exceeded',
    413,
  );
  requireThat(m.complete === true || m.complete === false, 'Complete scope must be declared');
  requireThat(Array.isArray(m.issues), 'Issues must be an array');
  return total;
}
/** 为没有明确类型的文件按扩展名提供默认 MIME 类型；不做内容嗅探。 */
export const mediaType = (path) =>
  ({
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    mjs: 'application/javascript',
    json: 'application/json',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    woff: 'font/woff',
    woff2: 'font/woff2',
    txt: 'text/plain',
  })[path.split('.').pop().toLowerCase()] || 'application/octet-stream';
