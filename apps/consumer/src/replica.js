import { join } from 'node:path';
import { mkdir, readFile, rename, rm, readdir, statfs } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  identifier,
  digest,
  manifestValid,
  requireThat,
  atomic,
  jsonFile,
  writeJson,
  serial,
} from '@webhaven/core';

export class Replica {
  constructor(root, store, { retain = 3, minFreeBytes = 64 * 1024 * 1024, limits = {} } = {}) {
    requireThat(Number.isInteger(retain) && retain >= 1, 'retain must be at least one');
    this.root = root;
    this.store = store;
    this.retain = retain;
    this.minFreeBytes = minFreeBytes;
    this.limits = limits;
    this.heads = new Map();
    this.manifests = new Map();
    this.change = serial();
    this.errors = {};
  }
  collectionPath(c) {
    return join(this.root, 'collections', identifier(c));
  }
  versionPath(c, v) {
    return join(this.collectionPath(c), 'versions', identifier(v));
  }
  async load() {
    await mkdir(join(this.root, 'collections'), { recursive: true });
    for (const c of await readdir(join(this.root, 'collections'))) {
      identifier(c);
      const dir = this.collectionPath(c);
      for (const f of await readdir(dir))
        if (f.startsWith('.staging-')) await rm(join(dir, f), { recursive: true, force: true });
      const r = await jsonFile(join(dir, 'current.json'));
      const versions = await readdir(join(dir, 'versions')).catch((e) => {
        if (e.code === 'ENOENT') return [];
        throw e;
      });
      for (const v of versions) {
        try {
          const raw = await readFile(join(this.versionPath(c, v), 'manifest.json'));
          const m = JSON.parse(raw);
          manifestValid(m, this.limits);
          requireThat(m.collection === c && m.version === v, 'Local identity mismatch', 422);
          if (r?.version === v)
            requireThat(digest(raw) === r.manifestHash, 'Local manifest mismatch', 422);
          for (const f of m.files) {
            const bytes = await readFile(join(this.versionPath(c, v), 'files', f.path));
            requireThat(
              bytes.length === f.bytes && digest(bytes) === f.sha256,
              'Local content corruption',
              422,
            );
          }
          this.manifests.set(`${c}/${v}`, m);
        } catch (e) {
          this.errors[c] = e.message;
        }
      }
      if (r && this.manifests.has(`${c}/${r.version}`)) this.heads.set(c, r);
    }
  }
  async sync(collection) {
    identifier(collection);
    return this.change(async () => {
      let stage;
      try {
        const remote = await this.store.get(`heads/${collection}.json`);
        if (!remote) return { state: 'unpublished' };
        const r = JSON.parse(remote.data);
        identifier(r.version);
        requireThat(
          r.schema === 1 &&
            r.collection === collection &&
            Number.isSafeInteger(r.revision) &&
            r.revision >= 1,
          'Invalid release record',
          422,
        );
        if (this.heads.get(collection)?.revision === r.revision) {
          requireThat(
            this.heads.get(collection).manifestHash === r.manifestHash,
            'Mutated release revision',
            422,
          );
          return { state: 'unchanged', ...r };
        }
        requireThat(
          !this.heads.has(collection) || r.revision > this.heads.get(collection).revision,
          'Release revision went backward',
          409,
        );
        const raw = await this.store.get(`manifests/${r.version}.json`);
        requireThat(raw && digest(raw.data) === r.manifestHash, 'Manifest digest mismatch', 422);
        const m = JSON.parse(raw.data);
        const total = manifestValid(m, this.limits);
        requireThat(
          m.collection === collection && m.version === r.version,
          'Manifest identity mismatch',
          422,
        );
        await mkdir(this.collectionPath(collection), { recursive: true });
        const disk = await statfs(this.root);
        requireThat(
          disk.bavail * disk.bsize >= total + this.minFreeBytes,
          'Insufficient consumer disk space',
          507,
        );
        stage = join(this.collectionPath(collection), `.staging-${randomUUID()}`);
        await mkdir(join(stage, 'files'), { recursive: true });
        // Reuse only bytes verified against the new manifest; directory and S3 stores are untrusted inputs.
        for (const f of m.files) {
          let bytes = await readFile(
            join(this.versionPath(collection, r.version), 'files', f.path),
          ).catch(() => null);
          if (!bytes || digest(bytes) !== f.sha256) {
            const object = await this.store.get(`objects/${f.sha256}`, this.limits.fileBytes);
            requireThat(object, 'Missing delivery object', 422);
            bytes = object.data;
          }
          requireThat(
            bytes.length === f.bytes && digest(bytes) === f.sha256,
            `Object verification failed: ${f.path}`,
            422,
          );
          await atomic(join(stage, 'files', f.path), bytes);
        }
        await atomic(join(stage, 'manifest.json'), raw.data);
        const target = this.versionPath(collection, r.version);
        await mkdir(join(this.collectionPath(collection), 'versions'), { recursive: true });
        try {
          await rename(stage, target);
          stage = null;
        } catch (e) {
          if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e;
          // Existing immutable version must match, including its bytes, before rollback reuse.
          const prior = await readFile(join(target, 'manifest.json'));
          requireThat(digest(prior) === r.manifestHash, 'Existing version differs', 422);
          for (const f of m.files) {
            const b = await readFile(join(target, 'files', f.path));
            requireThat(
              digest(b) === f.sha256 && b.length === f.bytes,
              'Existing version corrupt',
              422,
            );
          }
        }
        await writeJson(join(this.collectionPath(collection), 'current.json'), r);
        this.heads.set(collection, r);
        this.manifests.set(`${collection}/${r.version}`, m);
        delete this.errors[collection];
        await writeJson(join(target, 'activation.json'), { revision: r.revision }).catch((e) => {
          this.errors[collection] = `Activation metadata deferred: ${e.message}`;
        });
        await this.prune(collection).catch((e) => {
          this.errors[collection] = `Published; cleanup deferred: ${e.message}`;
        });
        return { state: 'activated', ...r };
      } catch (e) {
        this.errors[collection] = e.message;
        throw e;
      } finally {
        if (stage) await rm(stage, { recursive: true, force: true });
      }
    });
  }
  async manifest(c, v) {
    identifier(c);
    identifier(v);
    return this.manifests.get(`${c}/${v}`) || null;
  }
  async prune(c) {
    const folder = join(this.collectionPath(c), 'versions');
    const versions = [];
    for (const v of await readdir(folder)) {
      const m = await jsonFile(join(folder, v, 'manifest.json'));
      if (m)
        versions.push({
          ...m,
          activation: (await jsonFile(join(folder, v, 'activation.json')))?.revision || 0,
        });
    }
    versions.sort((a, b) => b.activation - a.activation);
    const keep = new Set([this.heads.get(c).version]);
    for (const v of versions) if (keep.size < this.retain) keep.add(v.version);
    for (const v of versions)
      if (!keep.has(v.version)) {
        await rm(join(folder, v.version), { recursive: true, force: true });
        this.manifests.delete(`${c}/${v.version}`);
      }
  }
}
