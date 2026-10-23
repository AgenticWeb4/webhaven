/**
 * 受限 HTTP 下载：只获取允许的公开资源，并保留原 URL 与最终响应 URL。
 * 每次重定向与实际 DNS 连接均检查目标，读取过程执行解码后字节上限。
 */
import { Agent, fetch } from 'undici';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { addresses, normalizeUrl, validateTarget } from './urls.js';

// 实际连接时再次检查 DNS 结果，覆盖每次重定向后的连接，降低检查与使用之间的偏差。
const agent = new Agent({
  connections: 32,
  connect: {
    lookup(hostname, options, callback) {
      addresses(hostname)
        .then((all) => {
          const choices = options.family ? all.filter((a) => a.family === options.family) : all;
          if (!choices.length) throw new Error('No address for requested family');
          if (options.all) callback(null, choices);
          else callback(null, choices[0].address, choices[0].family);
        })
        .catch(callback);
    },
  },
});

/**
 * 意图：在共同超时预算内下载单个可归档响应。
 * 步骤：验证目标 → 手动处理重定向 → 检查状态及缓存声明 → 有界读取字节。
 * 返回 {url, finalUrl, body, type, etag, lastModified}；拒绝超限、非 200 与私有响应。
 */
export async function download(input, { maxBytes = config.maxAssetBytes } = {}) {
  let url = normalizeUrl(input);
  // 所有跳转共用一个截止时间，避免每跳重新计时导致请求无限延长。
  const signal = AbortSignal.timeout(config.fetchTimeoutMs);
  for (let redirects = 0; redirects <= 5; redirects++) {
    await validateTarget(url);
    const response = await fetch(url, {
      dispatcher: agent,
      redirect: 'manual',
      signal,
      headers: { 'user-agent': 'WebHaven/0.1 (public resource mirror)', accept: '*/*' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Redirect without Location');
      url = normalizeUrl(location, url);
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}: ${url}`);
    }
    if (/\b(?:no-store|private)\b/i.test(response.headers.get('cache-control') || '')) {
      await response.body?.cancel();
      throw new Error(`Response is not public/cacheable: ${url}`);
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new Error(`Asset exceeds ${maxBytes} bytes`);
    }
    // Content-Length 只能提前筛查；实际解码后大小仍须逐块检查。
    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw new Error(`Asset exceeds ${maxBytes} decoded bytes`);
        chunks.push(chunk);
      }
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    return {
      url: input,
      finalUrl: url,
      body: Buffer.concat(chunks),
      type: (response.headers.get('content-type') || 'application/octet-stream')
        .split(';')[0]
        .toLowerCase(),
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    };
  }
  throw new Error('Too many redirects');
}
