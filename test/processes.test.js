/**
 * 独立进程验收：通过真实 HTTP/CLI 提交和访问，覆盖重启、断源以及旧配置名称。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { digest } from '@webhaven/core';
const root = new URL('../', import.meta.url).pathname;
const token = 'test-only-webhaven-submit-token';
async function port() {
  const s = createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function poll(fn) {
  let last;
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fn();
      if (r) return r;
    } catch (e) {
      last = e;
    }
    await pause(50);
  }
  throw last || new Error('Timed out');
}
async function kill(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

test('Publisher and Mirror: independent processes and offline access', (t) =>
  verifyProcessLifecycle(t));
test('Legacy environment names retain independent process behavior', (t) =>
  verifyProcessLifecycle(t, true));

async function verifyProcessLifecycle(t, useLegacyConfiguration = false) {
  const data = await mkdtemp(join(tmpdir(), 'webhaven-process-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const p = await port(),
    c = await port();
  const children = [];
  const errors = [];
  t.after(async () => {
    for (const ch of children) await kill(ch);
  });
  const env = {
    ...process.env,
    DELIVERY_DRIVER: 'local',
    DELIVERY_DIR: join(data, 'delivery'),
    PUBLISHER_DATA_DIR: join(data, 'publisher'),
    MIRROR_DATA_DIR: join(data, 'mirror'),
    PUBLISHER_PORT: String(p),
    MIRROR_PORT: String(c),
    COLLECTIONS: 'docs',
    SYNC_INTERVAL_MS: '100',
    MIN_FREE_BYTES: '0',
    ALLOW_PRIVATE_NETWORK: 'true',
    PUBLISHER_TOKENS: JSON.stringify([
      { token, collections: ['docs'], permissions: ['submit', 'publish'] },
    ]),
  };
  if (useLegacyConfiguration) {
    for (const [current, previous] of [
      ['PUBLISHER', 'PRODUCER'],
      ['MIRROR', 'CONSUMER'],
    ]) {
      for (const key of Object.keys(env)) {
        if (!key.startsWith(current + '_')) continue;
        env[key.replace(current, previous)] = env[key];
        delete env[key];
      }
    }
  }
  const start = (entry) => {
    const ch = spawn(process.execPath, [entry], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ch.stderr.on('data', (x) => errors.push(x.toString()));
    children.push(ch);
    return ch;
  };
  const publisher = start('apps/publisher/src/main.js');
  let mirrorProcess = start('apps/mirror/src/main.js');
  const base = `http://127.0.0.1:${p}`,
    mirror = `http://127.0.0.1:${c}`;
  await poll(async () => {
    const r = await fetch(base + '/healthz');
    return r.ok;
  });
  await poll(async () => {
    const r = await fetch(mirror + '/healthz');
    return r.ok;
  });
  const call = (path, method = 'GET', value, auth = token) =>
    fetch(base + '/v1/collections/docs/' + path, {
      method,
      headers: {
        authorization: `Bearer ${auth}`,
        'content-type': Buffer.isBuffer(value) ? 'application/octet-stream' : 'application/json',
      },
      body:
        value === undefined ? undefined : Buffer.isBuffer(value) ? value : JSON.stringify(value),
    });
  assert.equal((await call('head', 'GET', undefined, 'bad')).status, 401);
  const bytes = Buffer.from('<h1>passive uploaded content</h1>');
  const candidate = await (
    await call('candidates', 'POST', {
      files: [
        { path: 'index.html', sha256: digest(bytes), bytes: bytes.length, type: 'text/html' },
      ],
      complete: true,
      expectedRevision: 0,
    })
  ).json();
  const id = candidate.manifest.version;
  assert.equal((await call(`candidates/${id}/objects/${digest(bytes)}`, 'PUT', bytes)).status, 200);
  const finalized = await (await call(`candidates/${id}/finalize`, 'POST', {})).json();
  assert.equal(finalized.release.revision, 1);
  await poll(async () => {
    const r = await fetch(mirror + '/sites/docs/');
    return r.ok && (await r.text()).includes('passive uploaded');
  });
  const programDir = join(data, 'program-output');
  await mkdir(programDir);
  await writeFile(join(programDir, 'index.html'), '<h1>Program generated content</h1>');
  const cli = spawn(
    process.execPath,
    [
      'apps/publisher/src/cli.js',
      'submit',
      '--collection',
      'docs',
      '--directory',
      programDir,
      '--no-publish',
    ],
    {
      cwd: root,
      env: {
        ...env,
        [useLegacyConfiguration ? 'PRODUCER_URL' : 'PUBLISHER_URL']: base,
        WEBHAVEN_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  cli.stdout.on('data', (b) => (output += b));
  let cliError = '';
  cli.stderr.on('data', (b) => (cliError += b));
  const [code] = await once(cli, 'exit');
  assert.equal(code, 0, cliError);
  assert.equal(JSON.parse(output).state, 'ready');
  assert.equal((await (await call('head')).json()).revision, 1);
  const source = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end(
        '<!doctype html><h1>active captured website</h1><img src="/image.svg"><link rel="stylesheet" href="/main.css"><script type="module" src="/app.js"></script>',
      );
    } else if (req.url === '/image.svg') {
      res.setHeader('content-type', 'image/svg+xml');
      res.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
    } else if (req.url === '/main.css') {
      res.setHeader('content-type', 'text/css');
      res.end('@import "nested.css";body{color:green}');
    } else if (req.url === '/nested.css') {
      res.setHeader('content-type', 'text/css');
      res.end('h1{color:blue}');
    } else if (req.url === '/app.js') {
      res.setHeader('content-type', 'application/javascript');
      res.end('import "./module.js";');
    } else if (req.url === '/module.js') {
      res.setHeader('content-type', 'application/javascript');
      res.end('globalThis.webhavenLoaded=true;');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  t.after(() => source.close());
  const capture = await (
    await call('captures', 'POST', {
      kind: 'web',
      url: `http://127.0.0.1:${source.address().port}/`,
      expectedRevision: 1,
    })
  ).json();
  const job = await poll(async () => {
    const j = await (await call(`captures/${capture.id}`)).json();
    return j.finishedAt ? j : null;
  });
  assert.equal(job.state, 'complete', JSON.stringify(job));
  assert.equal(job.release.revision, 2);
  const page = await poll(async () => {
    const r = await fetch(mirror + '/sites/docs/');
    const text = await r.text();
    return text.includes('active captured') ? { url: r.url, text } : null;
  });
  const direct = await (
    await call('captures', 'POST', {
      kind: 'web',
      url: `http://127.0.0.1:${source.address().port}/image.svg`,
      expectedRevision: 2,
      autoPublish: false,
    })
  ).json();
  const fileJob = await poll(async () => {
    const j = await (await call(`captures/${direct.id}`)).json();
    return j.finishedAt ? j : null;
  });
  assert.equal(fileJob.state, 'complete', JSON.stringify(fileJob));
  const artifact = await (await call(`candidates/${fileJob.version}`)).json();
  assert.equal(artifact.manifest.files.length, 1);
  assert.equal(artifact.manifest.files[0].type, 'image/svg+xml');
  await new Promise((r) => source.close(r));
  await kill(publisher);
  const refs = [...page.text.matchAll(/(?:src|href)="([^\"]+)"/g)].map(
    (m) => new URL(m[1], page.url).href,
  );
  assert.equal(refs.length, 3);
  for (const url of refs) assert.equal((await fetch(url)).status, 200, url);
  await kill(mirrorProcess);
  await rm(join(data, 'delivery'), { recursive: true, force: true });
  mirrorProcess = start('apps/mirror/src/main.js');
  await poll(async () => {
    const r = await fetch(mirror + '/sites/docs/');
    return r.ok && (await r.text()).includes('active captured');
  });
  assert.notEqual(publisher.pid, mirrorProcess.pid);
}
