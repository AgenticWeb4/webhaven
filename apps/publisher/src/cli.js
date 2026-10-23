/**
 * 命令行提交端：外部程序通过 Publisher HTTP 接口提交内容，不直接写归档或交付目录。
 * 命令返回控制结果；采集命令返回排队任务，后续状态由任务查询接口读取。
 */
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { directoryFiles, digest, mediaType, requireThat } from '@webhaven/core';
import { roleSetting } from '../../../packages/core/src/settings.js';

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    collection: { type: 'string' },
    directory: { type: 'string' },
    url: { type: 'string' },
    s3: { type: 'boolean' },
    browser: { type: 'boolean' },
    version: { type: 'string' },
    'expected-revision': { type: 'string' },
    'operation-id': { type: 'string' },
    approval: { type: 'string' },
    'no-publish': { type: 'boolean' },
    partial: { type: 'boolean' },
  },
});
const collectionUrl =
  roleSetting('PUBLISHER', 'URL', 'http://127.0.0.1:8081') +
  '/v1/collections/' +
  encodeURIComponent(options.collection || '');

/** 带集合令牌发送 JSON 或二进制请求；非成功响应保留服务端状态并转为命令失败。 */
async function requestPublisher(path, method = 'GET', value) {
  const binary = Buffer.isBuffer(value);
  const response = await fetch(`${collectionUrl}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.WEBHAVEN_TOKEN || ''}`,
      'content-type': binary ? 'application/octet-stream' : 'application/json',
    },
    body: value === undefined ? undefined : binary ? value : JSON.stringify(value),
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  requireThat(response.ok, result.error || `HTTP ${response.status}`, response.status);
  return result;
}

/** 用户指定修订时直接使用，否则读取当前值；真正提交仍可能因并发发布产生冲突。 */
async function resolveExpectedRevision() {
  return options['expected-revision'] === undefined
    ? (await requestPublisher('head')).revision
    : Number(options['expected-revision']);
}

/**
 * 意图：把外部程序产出的目录交给标准候选流程。
 * 步骤：固定预计修订 → 生成清单 → 创建候选 → 上传对象 → 完成并按选项尝试发布。
 * 目录若在清单生成后发生变化，服务端会以大小或摘要不匹配拒绝上传。
 */
async function submitDirectory() {
  requireThat(options.directory, '--directory is required');
  const expectedRevision = await resolveExpectedRevision();
  const entries = await directoryFiles(options.directory);
  const files = await describeDirectory(entries);
  const candidate = await requestPublisher('candidates', 'POST', {
    files,
    expectedRevision,
    complete: !options.partial,
    issues: options.partial ? ['Submitter declared partial content'] : [],
    source: { kind: 'program' },
  });
  await uploadCandidateFiles(candidate.manifest.version, files, entries);
  return requestPublisher(`candidates/${candidate.manifest.version}/finalize`, 'POST', {
    autoPublish: !options['no-publish'],
  });
}

/** 为每个文件声明相对路径、摘要、字节数与类型；上传时仍由服务端独立验证。 */
async function describeDirectory(entries) {
  const files = [];
  for (const entry of entries) {
    const bytes = await readFile(entry.absolute);
    files.push({
      path: entry.path,
      sha256: digest(bytes),
      bytes: bytes.length,
      type: mediaType(entry.path),
    });
  }
  return files;
}

/** 将文件上传到候选声明的摘要键，避免 CLI 直接控制持久对象路径。 */
async function uploadCandidateFiles(version, files, entries) {
  for (let index = 0; index < files.length; index++)
    await requestPublisher(
      `candidates/${version}/objects/${files[index].sha256}`,
      'PUT',
      await readFile(entries[index].absolute),
    );
}

/** 提交 URL 或配置好的 S3 来源任务；返回排队结果，不等待采集完成。 */
async function startCapture() {
  const expectedRevision = await resolveExpectedRevision();
  requireThat(options.url || options.s3, '--url or --s3 is required');
  return requestPublisher('captures', 'POST', {
    kind: options.s3 ? 's3' : 'web',
    url: options.url,
    browser: !!options.browser,
    expectedRevision,
    autoPublish: !options['no-publish'],
  });
}

/** 显式发布或回滚必须提供预计修订；重试应复用 operation-id，避免产生新的操作身份。 */
async function publishVersion() {
  requireThat(
    options['expected-revision'] !== undefined,
    '--expected-revision is required for publish/rollback',
  );
  return requestPublisher('publish', 'POST', {
    version: options.version,
    expectedRevision: Number(options['expected-revision']),
    operationId: options['operation-id'] || randomUUID(),
    approval: options.approval,
  });
}

try {
  requireThat(options.collection, '--collection is required');
  const commands = {
    head: () => requestPublisher('head'),
    submit: submitDirectory,
    capture: startCapture,
    publish: publishVersion,
  };
  const command = Object.hasOwn(commands, positionals[0]) ? commands[positionals[0]] : null;
  requireThat(command, 'Usage: cli submit|capture|publish|head --collection NAME [options]');
  console.log(JSON.stringify(await command(), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
