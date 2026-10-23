/**
 * 下载链路基准：受控本地源站提供入口和 32 个资源，分别计时采集归档、发布、镜像激活。
 * 轮询等待不计入端到端时间；重复交付对象可复用，不代表公网下载性能。
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { VersionArchive } from '../apps/publisher/src/archive.js';
import { ReleasePublisher } from '../apps/publisher/src/publish.js';
import { LocalMirror } from '../apps/mirror/src/mirror.js';
import { LocalStore } from '../packages/core/src/store.js';
process.env.ALLOW_PRIVATE_NETWORK = 'true';
const { captureWebsite } = await import('../apps/publisher/src/capture.js');
const data = await mkdtemp(join(tmpdir(), 'webhaven-capture-bench-'));
const store = new LocalStore(join(data, 'delivery'));
const a = new VersionArchive(join(data, 'publisher'));
const p = new ReleasePublisher(a, store);
const r = new LocalMirror(join(data, 'mirror'), store, { minFreeBytes: 0 });
await r.restoreVerifiedVersions();
let size = 1024,
  requests = 0;
const source = createServer((req, res) => {
  requests++;
  const u = new URL(req.url, 'http://fixture');
  if (u.pathname === '/') {
    res.setHeader('content-type', 'text/html');
    res.end(
      '<h1>Controlled download fixture</h1>' +
        Array.from({ length: 32 }, (_, i) => `<img src="/blob?i=${i}">`).join(''),
    );
  } else {
    res.setHeader('content-type', 'application/octet-stream');
    res.end(Buffer.alloc(size, Number(u.searchParams.get('i'))));
  }
});
source.listen(0, '127.0.0.1');
await once(source, 'listening');
const url = `http://127.0.0.1:${source.address().port}/`;
const rows = [];
let revision = 0;
try {
  for (size of [1024, 65536, 1048576])
    for (const concurrency of [1, 8, 32])
      for (let repeat = 0; repeat < 3; repeat++) {
        requests = 0;
        const start = performance.now();
        const c = await captureWebsite(a, 'bench', {
          url,
          expectedRevision: revision,
          concurrency,
        });
        const captured = performance.now();
        if (!c.qualified) throw Error(JSON.stringify(c.manifest.issues));
        await p.publishVersion('bench', c.manifest.version, {
          expectedRevision: revision,
          operationId: `capture-${++revision}`,
        });
        const published = performance.now();
        await r.syncCollection('bench');
        const end = performance.now();
        const row = {
          size,
          concurrency,
          repeat,
          httpRequests: requests,
          captureArchiveMs: captured - start,
          publishMs: published - captured,
          mirrorSyncMs: end - published,
          endToEndMs: end - start,
          capturePayloadMiBs: (32 * size) / 1048576 / ((captured - start) / 1000),
          issues: c.manifest.issues.length,
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
} finally {
  source.close();
  await rm(data, { recursive: true, force: true });
}
await mkdir('results', { recursive: true });
await writeFile(
  'results/capture.json',
  JSON.stringify(
    {
      node: process.version,
      source: 'controlled loopback HTTP fixture; not a public-site benchmark',
      rows,
    },
    null,
    2,
  ) + '\n',
);
