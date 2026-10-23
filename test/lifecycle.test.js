/**
 * 版本生命周期验收：发布、回滚、故障保留、幂等重试、字节校验与离线恢复。
 * 夹具使用隔离临时目录；断言公共结果与持久状态，不依赖私有步骤的拆分数量。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { VersionArchive } from '../apps/publisher/src/archive.js';
import { ReleasePublisher } from '../apps/publisher/src/publish.js';
import { LocalMirror } from '../apps/mirror/src/mirror.js';
import { createMirrorServer } from '../apps/mirror/src/http.js';
import { LocalStore } from '../packages/core/src/store.js';
import { digest, manifestValid, filePath } from '@webhaven/core';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'webhaven-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = new VersionArchive(join(root, 'publisher'));
  const store = new LocalStore(join(root, 'delivery'));
  const publisher = new ReleasePublisher(archive, store);
  const mirror = new LocalMirror(
    join(root, 'mirror'),
    new LocalStore(join(root, 'delivery'), { readOnly: true }),
    { minFreeBytes: 0, ...options },
  );
  await mirror.restoreVerifiedVersions();
  async function candidate(text, expectedRevision, extra = {}) {
    const data = Buffer.from(text);
    const c = await archive.beginVersion('docs', {
      files: [{ path: 'index.html', sha256: digest(data), bytes: data.length, type: 'text/html' }],
      complete: true,
      expectedRevision,
      ...extra,
    });
    await archive.storeCandidateObject('docs', c.manifest.version, digest(data), data);
    return archive.finalizeVersion('docs', c.manifest.version);
  }
  return { root, archive, store, publisher, mirror, candidate };
}
test('published content survives store/publisher failure, restart, byte range and HEAD', async (t) => {
  const f = await fixture(t);
  const c = await f.candidate('hello offline world', 0);
  await f.publisher.publishVersion('docs', c.manifest.version, {
    expectedRevision: 0,
    operationId: 'first',
  });
  await f.mirror.syncCollection('docs');
  await rm(f.store.root, { recursive: true, force: true });
  assert.equal((await f.mirror.syncCollection('docs')).state, 'unpublished');
  const restarted = new LocalMirror(
    f.mirror.root,
    new LocalStore(f.store.root, { readOnly: true }),
    {
      minFreeBytes: 0,
    },
  );
  await restarted.restoreVerifiedVersions();
  const server = createMirrorServer(restarted);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/sites/docs/');
  assert.equal(await r.text(), 'hello offline world');
  assert.match(r.url, /\/versions\//);
  assert.equal((await fetch(r.url, { headers: { range: 'bytes=0-4' } })).status, 206);
  assert.equal(await (await fetch(r.url, { headers: { range: 'bytes=0-4' } })).text(), 'hello');
  assert.equal((await fetch(r.url, { headers: { range: 'bytes=99-100' } })).status, 416);
  assert.equal((await fetch(r.url, { method: 'HEAD' })).headers.get('content-length'), '19');
  assert.equal(
    (await fetch(r.url, { headers: { 'if-none-match': r.headers.get('etag') } })).status,
    304,
  );
  assert.equal((await fetch(base + '/sites/unknown/')).status, 404);
});
test('partial candidates require approval; old versions and causal replay survive rollback', async (t) => {
  const f = await fixture(t);
  const a = await f.candidate('a', 0);
  await f.publisher.publishVersion('docs', a.manifest.version, {
    expectedRevision: 0,
    operationId: 'a',
  });
  const b = await f.candidate('b', 1, { complete: false, issues: ['missing file'] });
  await assert.rejects(
    f.publisher.publishVersion('docs', b.manifest.version, {
      expectedRevision: 1,
      operationId: 'b',
    }),
    /approval/,
  );
  assert.equal((await f.publisher.readPublishedRelease('docs')).record.version, a.manifest.version);
  await f.publisher.publishVersion('docs', b.manifest.version, {
    expectedRevision: 1,
    operationId: 'b',
    approval: 'accept missing file',
  });
  const back = await f.publisher.publishVersion('docs', a.manifest.version, {
    expectedRevision: 2,
    operationId: 'back',
  });
  assert.equal(back.revision, 3);
  const replay = await f.publisher.publishVersion('docs', a.manifest.version, {
    expectedRevision: 0,
    operationId: 'a',
  });
  assert.equal(replay.revision, 1);
  assert.equal((await f.publisher.readPublishedRelease('docs')).record.revision, 3);
  await assert.rejects(
    f.publisher.publishVersion('docs', b.manifest.version, {
      expectedRevision: 0,
      operationId: 'a',
    }),
    /different inputs/,
  );
});
test('stale capture cannot overwrite newer publication', async (t) => {
  const f = await fixture(t);
  const a = await f.candidate('a', 0),
    b = await f.candidate('b', 0);
  const outcomes = await Promise.allSettled([
    f.publisher.publishVersion('docs', a.manifest.version, {
      expectedRevision: 0,
      operationId: 'a',
    }),
    f.publisher.publishVersion('docs', b.manifest.version, {
      expectedRevision: 0,
      operationId: 'b',
    }),
  ]);
  assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
  assert.match(outcomes.find((x) => x.status === 'rejected').reason.message, /conflict/);
});
test('mirror detects missing/corrupt objects without replacing current or leaking staging', async (t) => {
  const f = await fixture(t);
  const a = await f.candidate('good', 0);
  await f.publisher.publishVersion('docs', a.manifest.version, {
    expectedRevision: 0,
    operationId: 'a',
  });
  await f.mirror.syncCollection('docs');
  const b = await f.candidate('bad candidate', 1);
  await f.publisher.publishVersion('docs', b.manifest.version, {
    expectedRevision: 1,
    operationId: 'b',
  });
  await writeFile(join(f.store.root, 'objects', b.manifest.files[0].sha256), 'corrupt');
  await assert.rejects(f.mirror.syncCollection('docs'), /verification/);
  assert.equal(f.mirror.activeReleases.get('docs').version, a.manifest.version);
  assert.equal(
    (await readdir(f.mirror.collectionPath('docs'))).some((x) => x.startsWith('.staging-')),
    false,
  );
});
test('disk reserve protects old publication', async (t) => {
  const f = await fixture(t);
  const a = await f.candidate('a', 0);
  await f.publisher.publishVersion('docs', a.manifest.version, {
    expectedRevision: 0,
    operationId: 'a',
  });
  await f.mirror.syncCollection('docs');
  const b = await f.candidate('b', 1);
  await f.publisher.publishVersion('docs', b.manifest.version, {
    expectedRevision: 1,
    operationId: 'b',
  });
  f.mirror.minFreeBytes = Number.MAX_SAFE_INTEGER;
  await assert.rejects(f.mirror.syncCollection('docs'), /disk/);
  assert.equal(f.mirror.activeReleases.get('docs').version, a.manifest.version);
});
test('retention keeps current version when rolling back', async (t) => {
  const f = await fixture(t, { retain: 3 });
  const versions = [];
  for (let i = 0; i < 5; i++) {
    const c = await f.candidate(String(i), i);
    versions.push(c);
    await f.publisher.publishVersion('docs', c.manifest.version, {
      expectedRevision: i,
      operationId: `r${i}`,
    });
    await f.mirror.syncCollection('docs');
  }
  assert.equal((await readdir(join(f.mirror.collectionPath('docs'), 'versions'))).length, 3);
  await f.publisher.publishVersion('docs', versions[0].manifest.version, {
    expectedRevision: 5,
    operationId: 'rollback',
  });
  await f.mirror.syncCollection('docs');
  assert.equal(
    await readFile(
      join(f.mirror.versionPath('docs', versions[0].manifest.version), 'files/index.html'),
      'utf8',
    ),
    '0',
  );
  assert.equal((await readdir(join(f.mirror.collectionPath('docs'), 'versions'))).length, 3);
});
test('failed publication pointer write leaves old head; retry commits once', async (t) => {
  const f = await fixture(t);
  const a = await f.candidate('a', 0);
  await f.publisher.publishVersion('docs', a.manifest.version, {
    expectedRevision: 0,
    operationId: 'a',
  });
  const b = await f.candidate('b', 1);
  const put = f.store.put.bind(f.store);
  let fail = true;
  f.store.put = async (key, data, options) => {
    if (fail && key === 'heads/docs.json') throw new Error('injected interruption');
    return put(key, data, options);
  };
  await assert.rejects(
    f.publisher.publishVersion('docs', b.manifest.version, {
      expectedRevision: 1,
      operationId: 'b',
    }),
    /interruption/,
  );
  assert.equal((await f.publisher.readPublishedRelease('docs')).record.revision, 1);
  fail = false;
  await f.publisher.publishVersion('docs', b.manifest.version, {
    expectedRevision: 1,
    operationId: 'b',
  });
  assert.equal((await f.publisher.readPublishedRelease('docs')).record.revision, 2);
});
test('unsafe paths, duplicate files and read-only writes are rejected', async (t) => {
  for (const p of ['../escape', '/absolute', 'a/../../b', 'a\\b', '.secret', 'a/%2e%2e/x', 'a//b'])
    assert.throws(() => filePath(p));
  const f = await fixture(t);
  const c = await f.candidate('a', 0);
  const m = structuredClone(c.manifest);
  m.files.push(m.files[0]);
  assert.throws(() => manifestValid(m), /Duplicate/);
  await assert.rejects(
    new LocalStore(f.store.root, { readOnly: true }).put('a', Buffer.from('x')),
    /Read-only/,
  );
});
test('startup quarantines a corrupt current version instead of serving unverified bytes', async (t) => {
  const f = await fixture(t);
  const a = await f.candidate('a', 0);
  await f.publisher.publishVersion('docs', a.manifest.version, {
    expectedRevision: 0,
    operationId: 'a',
  });
  await f.mirror.syncCollection('docs');
  await writeFile(
    join(f.mirror.versionPath('docs', a.manifest.version), 'files/index.html'),
    'tampered',
  );
  const restarted = new LocalMirror(f.mirror.root, f.store, { minFreeBytes: 0 });
  await restarted.restoreVerifiedVersions();
  assert.equal(restarted.activeReleases.has('docs'), false);
  assert.match(restarted.errors.docs, /corruption/);
});
test('static dependency gaps block automatic qualification and finalized files stay immutable', async (t) => {
  const f = await fixture(t);
  const c = await f.candidate('<h1>artifact</h1><img src="missing.png">', 0);
  assert.equal(c.qualified, false);
  assert.equal(c.manifest.complete, false);
  assert.ok(c.manifest.issues.some((x) => x.error === 'Unresolved static dependency'));
  await assert.rejects(
    f.archive.storeCandidateObject(
      'docs',
      c.manifest.version,
      digest(Buffer.from('x')),
      Buffer.from('x'),
    ),
    /immutable/,
  );
});
test('partial logical versions preserve base files while complete inventories may delete', async (t) => {
  const f = await fixture(t);
  const first = await f.candidate('old', 0);
  const base = first.manifest.files;
  const bytes = Buffer.from('new');
  const file = { path: 'new.txt', sha256: digest(bytes), bytes: bytes.length, type: 'text/plain' };
  const c = await f.archive.beginVersion('docs', {
    files: [file],
    baseFiles: base,
    complete: false,
    issues: ['partial'],
    expectedRevision: 0,
  });
  await f.archive.storeCandidateObject('docs', c.manifest.version, file.sha256, bytes);
  const partial = await f.archive.finalizeVersion('docs', c.manifest.version);
  assert.equal(partial.manifest.files.length, 2);
  assert.equal(partial.qualified, false);
  const full = await f.archive.beginVersion('docs', {
    files: [file],
    baseFiles: base,
    complete: true,
    expectedRevision: 0,
  });
  const finalized = await f.archive.finalizeVersion('docs', full.manifest.version);
  assert.deepEqual(
    finalized.manifest.files.map((f) => f.path),
    ['new.txt'],
  );
});
test('lost response after publication is recovered by idempotent replay', async (t) => {
  const f = await fixture(t);
  const a = await f.candidate('a', 0);
  const put = f.store.put.bind(f.store);
  let fail = true;
  f.store.put = async (key, data, options) => {
    const result = await put(key, data, options);
    if (fail && key === 'heads/docs.json') {
      fail = false;
      throw new Error('response lost after commit');
    }
    return result;
  };
  await assert.rejects(
    f.publisher.publishVersion('docs', a.manifest.version, {
      expectedRevision: 0,
      operationId: 'one',
    }),
    /response lost/,
  );
  assert.equal((await f.publisher.readPublishedRelease('docs')).record.revision, 1);
  assert.equal(
    (
      await f.publisher.publishVersion('docs', a.manifest.version, {
        expectedRevision: 0,
        operationId: 'one',
      })
    ).revision,
    1,
  );
});
