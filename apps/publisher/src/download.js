import { Agent, fetch } from 'undici';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { addresses, normalizeUrl, validateTarget } from './urls.js';

// Validate DNS at connection time too, including every redirected destination.
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

export async function download(input, { maxBytes = config.maxAssetBytes } = {}) {
  let url = normalizeUrl(input);
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
