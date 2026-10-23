/**
 * 只读内容服务：稳定地址重定向到固定版本，文件响应从已验证清单定位。
 * HTTP 热路径不访问交付仓；本地文件由可信运维方管理，启动/同步时执行内容校验。
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { identifier, filePath, requireThat, respond } from '@webhaven/core';

/** 创建 GET/HEAD 内容服务与健康检查；调用者负责监听端口和关闭进程。 */
export function createMirrorServer(mirror) {
  return createServer(async (request, response) => {
    try {
      if (request.url === '/healthz') return respond(response, 200, describeHealth(mirror));
      requireThat(['GET', 'HEAD'].includes(request.method), 'Method not allowed', 405);
      const target = parseContentRoute(request.url);
      if (target.active) return redirectToActiveVersion(response, mirror, target);
      await serveVerifiedFile(request, response, mirror, target);
    } catch (error) {
      if (!response.headersSent)
        respond(response, error.status || 500, {
          error: error.status ? error.message : 'Content unavailable',
        });
      else response.destroy();
    }
  });
}

/** 同步错误表示降级，不等于旧内容不可读；published 列出当前已有本地选择的集合。 */
function describeHealth(mirror) {
  return {
    status: Object.keys(mirror.errors).length ? 'degraded' : 'ok',
    published: [...mirror.activeReleases.keys()],
    errors: mirror.errors,
  };
}

/** 区分当前选择与固定版本路径，校验每段后才允许后续磁盘定位。 */
function parseContentRoute(requestUrl) {
  // 先解码原始路径再检查，避免 URL 规范化提前消去路径穿越痕迹。
  const path = decodeURIComponent(requestUrl.split('?')[0]);
  const active = path.match(/^\/sites\/([^/]+)(?:\/(.*))?$/);
  if (active)
    return {
      active: true,
      collection: identifier(active[1]),
      path: filePath(active[2] || 'index.html'),
    };
  const pinned = path.match(/^\/versions\/([^/]+)\/([^/]+)\/(.+)$/);
  requireThat(pinned, 'Not found', 404);
  return {
    active: false,
    collection: identifier(pinned[1]),
    version: identifier(pinned[2]),
    path: filePath(pinned[3]),
  };
}

/** 稳定地址不缓存跳转，使新访问看到新选择；固定版本 URL 维持页面内资源一致性。 */
function redirectToActiveVersion(response, mirror, target) {
  const release = mirror.activeReleases.get(target.collection);
  requireThat(release, 'No published version', 404);
  const path = target.path.split('/').map(encodeURIComponent).join('/');
  response.writeHead(307, {
    location: `/versions/${target.collection}/${release.version}/${path}`,
    'cache-control': 'no-store',
  });
  response.end();
}

/**
 * 意图：仅向客户端提供清单中已经验证的本地文件。
 * 步骤：查验证缓存 → 定位声明文件 → 生成条件/范围响应 → 按需流式发送文件。
 * 不在每次读取时重算摘要；传输失败由外层结束连接，流式发送保留背压。
 */
async function serveVerifiedFile(request, response, mirror, target) {
  const manifest = await mirror.readVerifiedManifest(target.collection, target.version);
  const file = manifest?.files.find((file) => file.path === target.path);
  requireThat(file, 'File not found', 404);
  const plan = planFileResponse(request, file);
  response.writeHead(plan.status, plan.headers);
  if (!plan.sendBody) return response.end();
  await pipeline(
    createReadStream(
      join(mirror.versionPath(target.collection, target.version), 'files', target.path),
      { start: plan.start, end: plan.end },
    ),
    response,
  );
}

/** 先处理 ETag，再处理 If-Range 与单段 Range；HEAD 保留对应响应头但不发送文件体。 */
function planFileResponse(request, file) {
  const etag = `"${file.sha256}"`;
  if (request.headers['if-none-match'] === etag)
    return { status: 304, headers: { etag }, sendBody: false };
  const headers = {
    'content-type': file.type,
    'content-length': file.bytes,
    etag,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  const rangeRequested =
    request.headers.range && (!request.headers['if-range'] || request.headers['if-range'] === etag);
  const range = rangeRequested
    ? parseByteRange(request.headers.range, file.bytes)
    : { start: 0, end: file.bytes - 1 };
  if (!range)
    return { status: 416, headers: { 'content-range': `bytes */${file.bytes}` }, sendBody: false };
  if (rangeRequested) {
    headers['content-range'] = `bytes ${range.start}-${range.end}/${file.bytes}`;
    headers['content-length'] = range.end - range.start + 1;
  }
  return {
    status: rangeRequested ? 206 : 200,
    headers,
    ...range,
    sendBody: request.method !== 'HEAD' && file.bytes > 0,
  };
}

/** 将闭区间、开放尾部或后缀范围转为含首尾字节的区间；多段或非法范围返回 null。 */
function parseByteRange(header, size) {
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size)
    return null;
  return { start, end };
}
