import { readFile } from 'node:fs/promises';
import { S3Store } from '../../../packages/core/src/store.js';
import { digest, directoryFiles, mediaType, filePath, requireThat } from '@webhaven/core';
import { validateTarget } from './urls.js';
import { filename, transform } from './rewrite.js';
import { download } from './download.js';
import { captureRenderedPage } from './browser.js';

export async function archiveFiles(
  archive,
  collection,
  entries,
  { complete = true, issues = [], expectedRevision, source, baseFiles } = {},
) {
  const files = entries.map((entry) => ({
    path: filePath(entry.path),
    sha256: digest(entry.body),
    bytes: entry.body.length,
    type: entry.type || mediaType(entry.path),
  }));
  const candidate = await archive.beginVersion(collection, {
    files,
    complete,
    issues,
    expectedRevision,
    source,
    baseFiles,
  });
  for (let index = 0; index < files.length; index++)
    await archive.storeCandidateObject(
      collection,
      candidate.manifest.version,
      files[index].sha256,
      entries[index].body,
    );
  return archive.finalizeVersion(collection, candidate.manifest.version);
}

export async function captureDirectory(archive, collection, directory, options) {
  const entries = [];
  for (const file of await directoryFiles(directory))
    entries.push({ path: file.path, body: await readFile(file.absolute) });
  return archiveFiles(archive, collection, entries, { ...options, source: { kind: 'directory' } });
}

export async function captureS3Prefix(archive, collection, options) {
  const source = new S3Store({
    bucket: options.bucket,
    prefix: options.prefix || '',
    endpoint: options.endpoint,
    region: options.region,
    credentials: options.credentials,
    readOnly: true,
  });
  const entries = [];
  let totalBytes = 0;
  for (const key of await source.list('')) {
    requireThat(entries.length < 2000, 'Source file count limit exceeded', 413);
    filePath(key);
    const object = await source.get(key, archive.limits.fileBytes);
    requireThat(object, 'Source changed during capture', 409);
    totalBytes += object.data.length;
    requireThat(
      totalBytes <= (archive.limits.totalBytes || 250 * 1024 * 1024),
      'Source size limit exceeded',
      413,
    );
    entries.push({
      path: key,
      body: object.data,
      type: object.type === 'application/octet-stream' ? mediaType(key) : object.type,
    });
  }
  return archiveFiles(archive, collection, entries, {
    ...options,
    source: { kind: 's3', bucket: options.bucket, prefix: options.prefix || '' },
  });
}

export async function captureWebsite(archive, collection, options) {
  const url = await validateTarget(options.url);
  const capture = new WebsiteCapture(url, archive.limits, options);
  if (options.browser) await capture.captureRenderedEntry();
  await capture.fetchObservedDependencies();
  const entries = capture.prepareLocalFiles();
  return archiveFiles(archive, collection, entries, {
    expectedRevision: options.expectedRevision,
    complete: capture.issues.length === 0,
    issues: capture.issues,
    baseFiles: options.baseFiles,
    source: { kind: 'web', url, scope: 'entry-and-observed-dependencies' },
  });
}

class WebsiteCapture {
  constructor(url, limits, options) {
    this.url = url;
    this.limits = limits;
    this.maxResources = options.maxResources ?? 150;
    this.concurrency = options.concurrency ?? 4;
    requireThat(
      Number.isInteger(this.maxResources) && this.maxResources >= 1 && this.maxResources <= 2000,
      'Invalid maxResources',
    );
    requireThat(
      Number.isInteger(this.concurrency) && this.concurrency >= 1 && this.concurrency <= 32,
      'Invalid concurrency',
    );
    this.resources = new Map();
    this.aliases = new Map();
    this.issues = [];
    this.pendingUrls = [url];
    this.knownUrls = new Set([url]);
    this.totalBytes = 0;
  }

  #recordResource(resource) {
    const previous = this.resources.get(resource.url);
    this.totalBytes += resource.body.length - (previous?.body.length || 0);
    requireThat(
      this.totalBytes <= (this.limits.totalBytes || 250 * 1024 * 1024),
      'Capture byte limit exceeded',
      413,
    );
    this.resources.set(resource.url, resource);
    this.aliases.set(resource.finalUrl, resource.url);
  }

  captureRenderedEntry() {
    return captureRenderedPage({
      url: this.url,
      resources: this.resources,
      maxResources: this.maxResources,
      maxFileBytes: this.limits.fileBytes || 20971520,
      recordResource: (resource) => this.#recordResource(resource),
      reportIssue: (issue) => this.issues.push(issue),
    });
  }

  async fetchObservedDependencies() {
    for (let cursor = 0; cursor < this.pendingUrls.length;) {
      const batch = this.pendingUrls.slice(cursor, cursor + this.concurrency);
      cursor += batch.length;
      await Promise.all(batch.map((url) => this.#downloadResource(url)));
      this.#discoverDependencies();
    }
  }

  async #downloadResource(url) {
    try {
      if (!this.resources.has(url))
        this.#recordResource(await download(url, { maxBytes: this.limits.fileBytes }));
    } catch (error) {
      this.issues.push({ url, error: error.message });
    }
  }

  #discoverDependencies() {
    // Browser-captured CSS and scripts can contain dependencies that the browser did not request.
    for (const resource of this.resources.values()) {
      if (resource.discovered) continue;
      resource.discovered = true;
      transform(resource.body, resource.type, resource.finalUrl, (url, kind) => {
        if (kind === 'page' || this.knownUrls.has(url)) return null;
        this.knownUrls.add(url);
        if (this.knownUrls.size > this.maxResources)
          this.issues.push({ url, error: 'Resource limit reached' });
        else this.pendingUrls.push(url);
        return null;
      });
    }
  }

  prepareLocalFiles() {
    const entry = this.resources.get(this.url);
    requireThat(entry, 'Entry resource not captured', 422);
    const entries = [];
    for (const resource of this.resources.values()) {
      const body = transform(
        resource.body,
        resource.type,
        resource.finalUrl,
        (url, kind) => this.#resolveLocalReference(url, kind),
        { archive: true },
      );
      entries.push({ path: filename(resource.url, resource.type), body, type: resource.type });
      if (resource === entry && /^(text\/html|application\/xhtml\+xml)$/.test(resource.type))
        entries.push({ path: 'index.html', body, type: 'text/html' });
    }
    return entries;
  }

  #resolveLocalReference(url, kind) {
    const target = this.resources.get(url) || this.resources.get(this.aliases.get(url));
    if (target) return './' + filename(target.url, target.type);
    if (kind !== 'page') this.issues.push({ url, error: 'Unresolved dependency' });
    return './unavailable';
  }
}
