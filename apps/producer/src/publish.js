import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { identifier, digest, requireThat, serial } from '@webhaven/core';

export class Publisher {
  constructor(archive, store) {
    this.archive = archive;
    this.store = store;
    this.change = serial();
  }
  async head(collection) {
    const r = await this.store.get(`heads/${identifier(collection)}.json`);
    return r ? { record: JSON.parse(r.data), etag: r.etag } : { record: null, etag: null };
  }
  async publish(collection, version, { expectedRevision, operationId, approval } = {}) {
    return this.change(async () => {
      identifier(operationId);
      requireThat(
        Number.isSafeInteger(expectedRevision) && expectedRevision >= 0,
        'expectedRevision is required',
      );
      const current = await this.head(collection);
      let prior = current.record;
      // Publication records form a causal chain. Replaying an old committed operation stays idempotent.
      while (prior) {
        if (prior.operationId === operationId) {
          requireThat(
            prior.version === version && prior.revision === expectedRevision + 1,
            'Operation ID already used for different inputs',
            409,
          );
          return prior;
        }
        if (prior.revision <= expectedRevision) break;
        const p = prior.previous ? await this.store.get(prior.previous) : null;
        prior = p ? JSON.parse(p.data) : null;
      }
      requireThat(
        (current.record?.revision || 0) === expectedRevision,
        'Publication revision conflict',
        409,
      );
      const c = await this.archive.get(collection, version);
      requireThat(c.state === 'ready', 'Candidate is not finalized', 409);
      requireThat(
        c.qualified || (typeof approval === 'string' && approval.trim().length > 0),
        'Partial version requires explicit approval reason',
        422,
      );
      for (const f of c.manifest.files) {
        const key = `objects/${f.sha256}`;
        if (!(await this.store.get(key, this.archive.limits.fileBytes))) {
          const data = await readFile(this.archive.objectPath(f.sha256));
          requireThat(digest(data) === f.sha256, 'Archive corruption', 422);
          await this.store.put(key, data);
        }
      }
      const raw = await readFile(join(this.archive.root, 'manifests', version + '.json'));
      requireThat(digest(raw) === c.manifestHash, 'Archive manifest corruption', 422);
      await this.store.put(`manifests/${version}.json`, raw);
      const key = `releases/${collection}/${expectedRevision + 1}-${operationId}.json`;
      const record = {
        schema: 1,
        collection,
        version,
        revision: expectedRevision + 1,
        manifestHash: c.manifestHash,
        operationId,
        approval: approval || null,
        previous: current.record?.key || null,
        key,
        publishedAt: new Date().toISOString(),
      };
      await this.store.put(key, Buffer.from(JSON.stringify(record)));
      // Objects and manifest are complete before the single conditional publication commit.
      await this.store.put(`heads/${collection}.json`, Buffer.from(JSON.stringify(record)), {
        expected: current.etag,
      });
      return record;
    });
  }
}
