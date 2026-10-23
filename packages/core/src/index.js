import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, readFile, stat, lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export class Fault extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const requireThat = (condition, message, status = 400) => {
  if (!condition) throw new Fault(status, message);
};
export const digest = (body) => createHash('sha256').update(body).digest('hex');
export function identifier(value) {
  requireThat(
    typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value),
    'Invalid identifier',
  );
  return value;
}
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
export function hex(value) {
  requireThat(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Invalid SHA-256');
  return value;
}
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
export async function jsonFile(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}
export const writeJson = (path, value) => atomic(path, JSON.stringify(value));
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
export function serial() {
  let tail = Promise.resolve();
  return (action) => {
    const result = tail.then(action);
    tail = result.catch(() => {});
    return result;
  };
}
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
export function respond(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}
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
