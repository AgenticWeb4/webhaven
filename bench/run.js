import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, platform, arch } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { request, Agent } from 'node:http';
import { VersionArchive } from '../apps/publisher/src/archive.js';
import { ReleasePublisher } from '../apps/publisher/src/publish.js';
import { LocalMirror } from '../apps/mirror/src/mirror.js';
import { createMirrorServer } from '../apps/mirror/src/http.js';
import { LocalStore } from '../packages/core/src/store.js';
import { archiveFiles } from '../apps/publisher/src/capture.js';

if (!isMainThread) {
  const agent = new Agent({ keepAlive: true, maxSockets: workerData.concurrency });
  const latency = [];
  let completed = 0,
    bytes = 0,
    errors = 0;
  const end = performance.now() + workerData.duration * 1000;
  const started = performance.now();
  async function loop() {
    while (performance.now() < end) {
      const at = performance.now();
      await new Promise((resolve) => {
        const r = request(workerData.url, { agent }, (response) => {
          let n = 0;
          response.on('data', (b) => (n += b.length));
          response.on('end', () => {
            if (response.statusCode !== 200 || n !== workerData.size) errors++;
            else {
              completed++;
              bytes += n;
            }
            latency.push(performance.now() - at);
            resolve();
          });
          response.on('error', () => {
            errors++;
            resolve();
          });
        });
        r.on('error', () => {
          errors++;
          resolve();
        });
        r.setTimeout(5000, () => r.destroy());
        r.end();
      });
    }
  }
  await Promise.all(Array.from({ length: workerData.concurrency }, loop));
  agent.destroy();
  latency.sort((a, b) => a - b);
  const percentile = (p) =>
    latency[Math.min(latency.length - 1, Math.floor(latency.length * p))] || 0;
  parentPort.postMessage({
    requests: completed,
    bytes,
    errors,
    elapsedMs: performance.now() - started,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  });
} else {
  const root = await mkdtemp(join(tmpdir(), 'webhaven-bench-'));
  const store = new LocalStore(join(root, 'delivery'));
  const a = new VersionArchive(join(root, 'publisher'));
  const p = new ReleasePublisher(a, store);
  const r = new LocalMirror(join(root, 'mirror'), new LocalStore(store.root, { readOnly: true }), {
    minFreeBytes: 0,
  });
  await r.restoreVerifiedVersions();
  const server = createMirrorServer(r);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = {
    environment: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0].model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      date: new Date().toISOString(),
      transport: 'local directory, Node mirror, loopback HTTP/1.1 keep-alive',
      repeats: Number(process.env.REPEATS || 3),
      durationSeconds: Number(process.env.DURATION || 3),
    },
    download: [],
    access: [],
  };
  let revision = 0;
  try {
    for (const size of [1024, 65536, 1048576]) {
      let candidate;
      for (let repeat = 0; repeat < results.environment.repeats; repeat++) {
        const entries = Array.from({ length: 32 }, (_, i) => ({
          path: `file-${i}.bin`,
          body: Buffer.alloc(size, i + repeat),
          type: 'application/octet-stream',
        }));
        const start = performance.now();
        candidate = await archiveFiles(a, 'bench', entries, { expectedRevision: revision });
        const archived = performance.now();
        await p.publishVersion('bench', candidate.manifest.version, {
          expectedRevision: revision,
          operationId: `r${++revision}`,
        });
        const published = performance.now();
        await r.syncCollection('bench');
        const synced = performance.now();
        results.download.push({
          size,
          files: 32,
          repeat,
          archiveMs: archived - start,
          publishMs: published - archived,
          mirrorSyncMs: synced - published,
          endToEndMs: synced - start,
          deliveryMiBs: (32 * size) / 1048576 / ((synced - archived) / 1000),
        });
      }
      for (const concurrency of [1, 32, 128])
        for (let repeat = 0; repeat < results.environment.repeats; repeat++) {
          const url = base + `/versions/bench/${candidate.manifest.version}/file-0.bin`;
          const cpu = process.cpuUsage();
          const start = performance.now();
          const load = new Worker(new URL(import.meta.url), {
            workerData: { url, size, concurrency, duration: results.environment.durationSeconds },
          });
          const [row] = await once(load, 'message');
          const cpuEnd = process.cpuUsage(cpu);
          const elapsed = performance.now() - start;
          Object.assign(row, {
            size,
            concurrency,
            repeat,
            rps: row.requests / (row.elapsedMs / 1000),
            miBs: row.bytes / 1048576 / (row.elapsedMs / 1000),
            serverProcessRssBytes: process.memoryUsage().rss,
            cpuTimeMs: (cpuEnd.user + cpuEnd.system) / 1000,
            wallMs: elapsed,
          });
          results.access.push(row);
          console.log(JSON.stringify(row));
        }
    }
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
  await mkdir('results', { recursive: true });
  await writeFile('results/performance.json', JSON.stringify(results, null, 2) + '\n');
}
