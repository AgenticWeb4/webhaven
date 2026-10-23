import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Archive } from '../apps/producer/src/archive.js';
import { Publisher } from '../apps/producer/src/publish.js';
import { Replica } from '../apps/consumer/src/replica.js';
import { LocalStore } from '../packages/core/src/store.js';
process.env.ALLOW_PRIVATE_NETWORK = 'true';
const { fromWeb } = await import('../apps/producer/src/capture.js');
const data = await mkdtemp(join(tmpdir(), 'webhaven-capture-bench-'));
const store = new LocalStore(join(data, 'delivery'));
const a = new Archive(join(data, 'producer'));
const p = new Publisher(a, store);
const r = new Replica(join(data, 'consumer'), store, { minFreeBytes: 0 });
await r.load();
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
        const c = await fromWeb(a, 'bench', { url, expectedRevision: revision, concurrency });
        const captured = performance.now();
        if (!c.qualified) throw Error(JSON.stringify(c.manifest.issues));
        await p.publish('bench', c.manifest.version, {
          expectedRevision: revision,
          operationId: `capture-${++revision}`,
        });
        const published = performance.now();
        await r.sync('bench');
        const end = performance.now();
        const row = {
          size,
          concurrency,
          repeat,
          httpRequests: requests,
          captureArchiveMs: captured - start,
          publishMs: published - captured,
          consumerSyncMs: end - published,
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
