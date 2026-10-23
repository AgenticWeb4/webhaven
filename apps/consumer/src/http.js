import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { identifier, filePath, requireThat, respond } from '@webhaven/core';

export function consumerServer(replica) {
  return createServer(async (req, res) => {
    try {
      if (req.url === '/healthz')
        return respond(res, 200, {
          status: Object.keys(replica.errors).length ? 'degraded' : 'ok',
          published: [...replica.heads.keys()],
          errors: replica.errors,
        });
      requireThat(['GET', 'HEAD'].includes(req.method), 'Method not allowed', 405);
      // Validate the raw decoded path before URL normalization can hide dot segments.
      const path = decodeURIComponent(req.url.split('?')[0]);
      const stable = path.match(/^\/sites\/([^/]+)(?:\/(.*))?$/);
      if (stable) {
        const c = identifier(stable[1]);
        const f = filePath(stable[2] || 'index.html');
        const r = replica.heads.get(c);
        requireThat(r, 'No published version', 404);
        res.writeHead(307, {
          location: `/versions/${c}/${r.version}/${f.split('/').map(encodeURIComponent).join('/')}`,
          'cache-control': 'no-store',
        });
        return res.end();
      }
      const pinned = path.match(/^\/versions\/([^/]+)\/([^/]+)\/(.+)$/);
      requireThat(pinned, 'Not found', 404);
      const [, c, v, p] = pinned;
      identifier(c);
      identifier(v);
      filePath(p);
      const manifest = await replica.manifest(c, v);
      const f = manifest?.files.find((x) => x.path === p);
      requireThat(f, 'File not found', 404);
      const headers = {
        'content-type': f.type,
        'content-length': f.bytes,
        etag: `"${f.sha256}"`,
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      };
      if (req.headers['if-none-match'] === headers.etag) {
        res.writeHead(304, { etag: headers.etag });
        return res.end();
      }
      let start = 0,
        end = f.bytes - 1,
        status = 200;
      if (
        req.headers.range &&
        (!req.headers['if-range'] || req.headers['if-range'] === headers.etag)
      ) {
        const m = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
        if (!m || (!m[1] && !m[2]) || f.bytes === 0) {
          res.writeHead(416, { 'content-range': `bytes */${f.bytes}` });
          return res.end();
        }
        if (!m[1]) start = Math.max(0, f.bytes - Number(m[2]));
        else {
          start = Number(m[1]);
          if (m[2]) end = Math.min(end, Number(m[2]));
        }
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= f.bytes
        ) {
          res.writeHead(416, { 'content-range': `bytes */${f.bytes}` });
          return res.end();
        }
        status = 206;
        headers['content-range'] = `bytes ${start}-${end}/${f.bytes}`;
        headers['content-length'] = end - start + 1;
      }
      res.writeHead(status, headers);
      if (req.method === 'HEAD' || f.bytes === 0) return res.end();
      await pipeline(
        createReadStream(join(replica.versionPath(c, v), 'files', p), { start, end }),
        res,
      );
    } catch (e) {
      if (!res.headersSent)
        respond(res, e.status || 500, { error: e.status ? e.message : 'Content unavailable' });
      else res.destroy();
    }
  });
}
