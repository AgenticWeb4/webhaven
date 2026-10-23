/**
 * 统一采集入口：目录、来源 S3 和网址最终都转为可校验的文件清单。
 * 网页采集范围是入口与可观察依赖，不是遍历整个网站或复现任意动态业务。
 */
import { readFile } from 'node:fs/promises';
import { S3Store } from '../../../packages/core/src/store.js';
import { digest, directoryFiles, mediaType, filePath, requireThat } from '@webhaven/core';
import { validateTarget } from './urls.js';
import { filename, transform } from './rewrite.js';
import { download } from './download.js';
import { captureRenderedPage } from './browser.js';

/**
 * 意图：让各种来源共享同一套归档规则。
 * 步骤：从 entries[{path, body, type}] 声明摘要清单 → 创建候选 → 写入对象 → 完成校验。
 * options 包含预计修订、完整声明和基础文件；返回候选，不直接切换公开版本。
 */
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

/** 读取可信目录的普通文件后统一归档；目录遍历拒绝符号链接。 */
export async function captureDirectory(archive, collection, directory, options) {
  const entries = [];
  for (const file of await directoryFiles(directory))
    entries.push({ path: file.path, body: await readFile(file.absolute) });
  return archiveFiles(archive, collection, entries, { ...options, source: { kind: 'directory' } });
}

/**
 * 只读列举来源前缀并逐对象读取，执行文件数、单文件和总量限制后归档。
 * 返回候选；来源不是跨对象事务快照，读取时缺失对象会拒绝本次采集。
 */
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

/**
 * 意图：把入口与观察到的资源整理成可独立访问的版本。
 * 步骤：验证目标 → 可选浏览器采集 → 补齐静态依赖 → 改为本地引用 → 归档校验。
 * 任一已知缺口都会阻止自动资格；成功下载入口本身不等于版本完整。
 */
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

/** 一次网页采集的内部工作集；保存资源、重定向别名、去重队列和缺口。 */
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

  /** 替换同 URL 资源时只计算字节差额，最终 DOM 可覆盖首次响应而不重复记账。 */
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

  /** 把浏览器观察结果写入同一工作集，让后续依赖发现与静态抓取复用。 */
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

  /** 按受限并发批次下载；每批发现的新资源进入后续批次，单资源失败转成缺口。 */
  async fetchObservedDependencies() {
    for (let cursor = 0; cursor < this.pendingUrls.length;) {
      const batch = this.pendingUrls.slice(cursor, cursor + this.concurrency);
      cursor += batch.length;
      await Promise.all(batch.map((url) => this.#downloadResource(url)));
      this.#discoverDependencies();
    }
  }

  /** 已有浏览器资源直接复用；下载失败不丢弃其他资源，但必须留下缺口说明。 */
  async #downloadResource(url) {
    try {
      if (!this.resources.has(url))
        this.#recordResource(await download(url, { maxBytes: this.limits.fileBytes }));
    } catch (error) {
      this.issues.push({ url, error: error.message });
    }
  }

  /** 只扩展资源依赖，跳过页面导航；URL 去重并限制规模，防止无界抓取。 */
  #discoverDependencies() {
    // 浏览器已获取的 CSS 和脚本仍可能引用尚未实际请求的依赖，需要再次分析。
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

  /**
   * 意图：使已获取文件之间使用同版本相对引用。
   * 步骤：确认入口 → 重写资源引用 → 输出摘要文件名 → 为 HTML 入口追加 index.html。
   * 缺失依赖指向本地 unavailable 并留下缺口；这里不伪造缺失资源。
   */
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

  /** 重定向前后 URL 可指向同一资源；未获取页面导航也改为本地失效地址。 */
  #resolveLocalReference(url, kind) {
    const target = this.resources.get(url) || this.resources.get(this.aliases.get(url));
    if (target) return './' + filename(target.url, target.type);
    if (kind !== 'page') this.issues.push({ url, error: 'Unresolved dependency' });
    return './unavailable';
  }
}
