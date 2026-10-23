import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Archive } from '../apps/producer/src/archive.js';
import { Publisher } from '../apps/producer/src/publish.js';
import { fromWeb } from '../apps/producer/src/capture.js';
import { Replica } from '../apps/consumer/src/replica.js';
import { consumerServer } from '../apps/consumer/src/http.js';
import { LocalStore } from '../packages/core/src/store.js';

test(
  'browser capture and actual offline rendering with origin stopped',
  { skip: process.env.RUN_BROWSER_TESTS !== 'true' },
  async (t) => {
    const data = await mkdtemp(join(tmpdir(), 'webhaven-browser-'));
    t.after(() => rm(data, { recursive: true, force: true }));
    const source = createServer((req, res) => {
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html');
        res.end(
          '<!doctype html><title>WebHaven fixture</title><h1>WebHaven source fixture page</h1><script src="/app.js"></script><link rel="stylesheet" href="/style.css">',
        );
      } else if (req.url === '/app.js') {
        res.setHeader('content-type', 'application/javascript');
        res.end(
          'globalThis.webhavenExecuted = true; document.querySelector("h1").textContent="WebHaven browser fixture rendered offline";',
        );
      } else if (req.url === '/style.css') {
        res.setHeader('content-type', 'text/css');
        res.end('h1{color:rgb(0,128,0)}');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    source.listen(0, '127.0.0.1');
    await once(source, 'listening');
    t.after(() => source.close());
    const a = new Archive(join(data, 'producer'));
    const store = new LocalStore(join(data, 'delivery'));
    const p = new Publisher(a, store);
    const r = new Replica(join(data, 'consumer'), store, { minFreeBytes: 0 });
    await r.load();
    const c = await fromWeb(a, 'docs', {
      url: `http://127.0.0.1:${source.address().port}/`,
      browser: true,
      expectedRevision: 0,
    });
    assert.equal(c.qualified, true, JSON.stringify(c.manifest.issues));
    await p.publish('docs', c.manifest.version, { expectedRevision: 0, operationId: 'browser' });
    await r.sync('docs');
    await new Promise((resolve) => source.close(resolve));
    const server = consumerServer(r);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const external = [];
    await page.route('**/*', (route) => {
      if (
        !route
          .request()
          .url()
          .startsWith(base + '/')
      ) {
        external.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(base + '/sites/docs/', { waitUntil: 'networkidle' });
    assert.equal(await page.title(), 'WebHaven fixture');
    assert.equal(await page.locator('h1').innerText(), 'WebHaven browser fixture rendered offline');
    assert.equal(await page.evaluate(() => globalThis.webhavenExecuted), true);
    assert.equal(
      await page.locator('h1').evaluate((e) => getComputedStyle(e).color),
      'rgb(0, 128, 0)',
    );
    assert.deepEqual(external, []);
  },
);
