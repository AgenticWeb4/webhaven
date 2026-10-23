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

async function resolveExpectedRevision() {
  return options['expected-revision'] === undefined
    ? (await requestPublisher('head')).revision
    : Number(options['expected-revision']);
}

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

async function uploadCandidateFiles(version, files, entries) {
  for (let index = 0; index < files.length; index++)
    await requestPublisher(
      `candidates/${version}/objects/${files[index].sha256}`,
      'PUT',
      await readFile(entries[index].absolute),
    );
}

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
