import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { directoryFiles, digest, mediaType, requireThat } from '@webhaven/core';

const { values, positionals } = parseArgs({
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
const base =
  (process.env.PRODUCER_URL || 'http://127.0.0.1:8081') +
  '/v1/collections/' +
  encodeURIComponent(values.collection || '');
async function call(path, method = 'GET', value) {
  const r = await fetch(base + '/' + path, {
    method,
    headers: {
      authorization: `Bearer ${process.env.WEBHAVEN_TOKEN || ''}`,
      ...(Buffer.isBuffer(value)
        ? { 'content-type': 'application/octet-stream' }
        : { 'content-type': 'application/json' }),
    },
    body: value === undefined ? undefined : Buffer.isBuffer(value) ? value : JSON.stringify(value),
    signal: AbortSignal.timeout(120000),
  });
  const result = await r.json();
  requireThat(r.ok, result.error || `HTTP ${r.status}`, r.status);
  return result;
}
try {
  requireThat(values.collection, '--collection is required');
  const action = positionals[0];
  if (action === 'head') console.log(JSON.stringify(await call('head'), null, 2));
  else if (action === 'submit') {
    requireThat(values.directory, '--directory is required');
    const expectedRevision =
      values['expected-revision'] === undefined
        ? (await call('head')).revision
        : Number(values['expected-revision']);
    const entries = await directoryFiles(values.directory);
    const files = [];
    for (const f of entries) {
      const data = await readFile(f.absolute);
      files.push({
        path: f.path,
        sha256: digest(data),
        bytes: data.length,
        type: mediaType(f.path),
      });
    }
    const c = await call('candidates', 'POST', {
      files,
      expectedRevision,
      complete: !values.partial,
      issues: values.partial ? ['Submitter declared partial content'] : [],
      source: { kind: 'program' },
    });
    for (let i = 0; i < files.length; i++)
      await call(
        `candidates/${c.manifest.version}/objects/${files[i].sha256}`,
        'PUT',
        await readFile(entries[i].absolute),
      );
    console.log(
      JSON.stringify(
        await call(`candidates/${c.manifest.version}/finalize`, 'POST', {
          autoPublish: !values['no-publish'],
        }),
        null,
        2,
      ),
    );
  } else if (action === 'capture') {
    const expectedRevision =
      values['expected-revision'] === undefined
        ? (await call('head')).revision
        : Number(values['expected-revision']);
    requireThat(values.url || values.s3, '--url or --s3 is required');
    console.log(
      JSON.stringify(
        await call('captures', 'POST', {
          kind: values.s3 ? 's3' : 'web',
          url: values.url,
          browser: !!values.browser,
          expectedRevision,
          autoPublish: !values['no-publish'],
        }),
        null,
        2,
      ),
    );
  } else if (action === 'publish') {
    requireThat(
      values['expected-revision'] !== undefined,
      '--expected-revision is required for publish/rollback',
    );
    console.log(
      JSON.stringify(
        await call('publish', 'POST', {
          version: values.version,
          expectedRevision: Number(values['expected-revision']),
          operationId: values['operation-id'] || randomUUID(),
          approval: values.approval,
        }),
        null,
        2,
      ),
    );
  } else throw new Error('Usage: cli submit|capture|publish|head --collection NAME [options]');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
