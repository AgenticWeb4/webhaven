import { readFile } from 'node:fs/promises';
import { S3Store } from '../../../packages/core/src/store.js';
import { digest, directoryFiles, mediaType, filePath, requireThat } from '@webhaven/core';
import { normalizeUrl, validateTarget } from './urls.js';
import { filename, transform } from './rewrite.js';
import { download } from './download.js';

export async function submitFiles(
  archive,
  collection,
  entries,
  { complete = true, issues = [], expectedRevision, source, baseFiles } = {},
) {
  const files = entries.map((f) => ({
    path: filePath(f.path),
    sha256: digest(f.body),
    bytes: f.body.length,
    type: f.type || mediaType(f.path),
  }));
  const c = await archive.create(collection, {
    files,
    complete,
    issues,
    expectedRevision,
    source,
    baseFiles,
  });
  for (let i = 0; i < files.length; i++)
    await archive.put(collection, c.manifest.version, files[i].sha256, entries[i].body);
  return archive.finish(collection, c.manifest.version);
}
export async function fromDirectory(archive, collection, root, options) {
  const entries = [];
  for (const f of await directoryFiles(root))
    entries.push({ path: f.path, body: await readFile(f.absolute) });
  return submitFiles(archive, collection, entries, { ...options, source: { kind: 'directory' } });
}
export async function fromS3(archive, collection, options) {
  const source = new S3Store({
    bucket: options.bucket,
    prefix: options.prefix || '',
    endpoint: options.endpoint,
    region: options.region,
    credentials: options.credentials,
    readOnly: true,
  });
  const entries = [];
  let bytes = 0;
  for (const key of await source.list('')) {
    requireThat(entries.length < 2000, 'Source file count limit exceeded', 413);
    filePath(key);
    const o = await source.get(key, archive.limits.fileBytes);
    requireThat(o, 'Source changed during capture', 409);
    bytes += o.data.length;
    requireThat(
      bytes <= (archive.limits.totalBytes || 250 * 1024 * 1024),
      'Source size limit exceeded',
      413,
    );
    entries.push({
      path: key,
      body: o.data,
      type: o.type === 'application/octet-stream' ? mediaType(key) : o.type,
    });
  }
  return submitFiles(archive, collection, entries, {
    ...options,
    source: { kind: 's3', bucket: options.bucket, prefix: options.prefix || '' },
  });
}
export async function fromWeb(archive, collection, options) {
  const root = await validateTarget(options.url);
  const items = new Map();
  const aliases = new Map();
  const issues = [];
  const pending = [root];
  const known = new Set([root]);
  const max = options.maxResources ?? 150;
  requireThat(Number.isInteger(max) && max >= 1 && max <= 2000, 'Invalid maxResources');
  const parallel = options.concurrency ?? 4;
  requireThat(Number.isInteger(parallel) && parallel >= 1 && parallel <= 32, 'Invalid concurrency');
  let total = 0;
  const save = (item) => {
    const previous = items.get(item.url);
    total += item.body.length - (previous?.body.length || 0);
    requireThat(
      total <= (archive.limits.totalBytes || 250 * 1024 * 1024),
      'Capture byte limit exceeded',
      413,
    );
    items.set(item.url, item);
    aliases.set(item.finalUrl, item.url);
  };
  if (options.browser) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const tasks = new Set();
      await page.route('**/*', async (route) => {
        try {
          if (
            !['GET', 'HEAD'].includes(route.request().method()) ||
            ['xhr', 'fetch', 'media', 'websocket', 'eventsource'].includes(
              route.request().resourceType(),
            )
          )
            return await route.abort();
          await validateTarget(route.request().url());
          await route.continue();
        } catch {
          await route.abort();
        }
      });
      page.on('response', (r) => {
        if (r.status() !== 200) return;
        const url = normalizeUrl(r.url());
        if (items.has(url) || tasks.size + items.size >= max) return;
        const t = (async () => {
          const headers = await r.allHeaders();
          if (/\b(private|no-store)\b/i.test(headers['cache-control'] || '')) return;
          const bytes = await r.body();
          requireThat(
            bytes.length <= (archive.limits.fileBytes || 20971520),
            'Browser asset too large',
            413,
          );
          save({
            url,
            finalUrl: url,
            body: bytes,
            type: (headers['content-type'] || 'application/octet-stream').split(';')[0],
          });
        })().catch((e) => issues.push({ url, error: e.message }));
        tasks.add(t);
        t.finally(() => tasks.delete(t));
      });
      await page.goto(root, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(500);
      await Promise.allSettled([...tasks]);
      requireThat(
        (await page.locator('body').innerText()).trim().length >= 20,
        'No readable final page; possible access challenge',
        422,
      );
      save({
        url: root,
        finalUrl: normalizeUrl(page.url()),
        type: 'text/html',
        body: Buffer.from(await page.content()),
      });
    } finally {
      await browser.close();
    }
  }
  for (let cursor = 0; cursor < pending.length;) {
    const batch = pending.slice(cursor, cursor + parallel);
    cursor += batch.length;
    await Promise.all(
      batch.map(async (url) => {
        try {
          if (!items.has(url)) save(await download(url, { maxBytes: archive.limits.fileBytes }));
        } catch (e) {
          issues.push({ url, error: e.message });
        }
      }),
    );
    // Revisit captured browser resources as well, so nested CSS and modules are discovered.
    for (const item of items.values()) {
      if (item.discovered) continue;
      item.discovered = true;
      transform(item.body, item.type, item.finalUrl, (url, kind) => {
        if (kind === 'page' || known.has(url)) return null;
        known.add(url);
        if (known.size > max) {
          issues.push({ url, error: 'Resource limit reached' });
          return null;
        }
        pending.push(url);
        return null;
      });
    }
  }
  const entry = items.get(root);
  requireThat(entry, 'Entry resource not captured', 422);
  const entries = [];
  for (const item of items.values()) {
    const body = transform(
      item.body,
      item.type,
      item.finalUrl,
      (url, kind) => {
        const target = items.get(url) || items.get(aliases.get(url));
        if (target) return './' + filename(target.url, target.type);
        if (kind !== 'page') issues.push({ url, error: 'Unresolved dependency' });
        return './unavailable';
      },
      { archive: true },
    );
    entries.push({ path: filename(item.url, item.type), body, type: item.type });
    if (item === entry && /^(text\/html|application\/xhtml\+xml)$/.test(item.type))
      entries.push({ path: 'index.html', body, type: 'text/html' });
  }
  return submitFiles(archive, collection, entries, {
    expectedRevision: options.expectedRevision,
    complete: issues.length === 0,
    issues,
    baseFiles: options.baseFiles,
    source: { kind: 'web', url: root, scope: 'entry-and-observed-dependencies' },
  });
}
