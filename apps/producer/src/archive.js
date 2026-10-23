import { join } from 'node:path';
import { readFile, mkdir, statfs } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  identifier,
  hex,
  digest,
  writeJson,
  jsonFile,
  atomic,
  manifestValid,
  requireThat,
  serial,
} from '@webhaven/core';

import { dependencyIssues } from './verify.js';

export class Archive {
  constructor(root, limits = {}) {
    this.root = root;
    this.limits = limits;
    this.change = serial();
  }
  candidatePath(collection, id) {
    return join(this.root, 'candidates', identifier(collection), identifier(id) + '.json');
  }
  objectPath(hash) {
    return join(this.root, 'objects', hex(hash));
  }
  async create(collection, input) {
    identifier(collection);
    requireThat(
      Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
      'expectedRevision is required',
    );
    const version = randomUUID();
    const combined = new Map((input.complete ? [] : input.baseFiles || []).map((f) => [f.path, f]));
    for (const f of input.files || []) combined.set(f.path, f);
    const manifest = {
      schema: 1,
      collection,
      version,
      files: [...combined.values()],
      complete: input.complete,
      issues: input.issues || [],
      source: input.source || { kind: 'upload' },
      createdAt: new Date().toISOString(),
    };
    const total = manifestValid(manifest, this.limits);
    await mkdir(this.root, { recursive: true });
    const disk = await statfs(this.root);
    requireThat(
      disk.bavail * disk.bsize >= total + (this.limits.minFreeBytes ?? 67108864),
      'Insufficient producer disk space',
      507,
    );
    const candidate = { manifest, expectedRevision: input.expectedRevision, state: 'uploading' };
    await writeJson(this.candidatePath(collection, version), candidate);
    return candidate;
  }
  async get(collection, version) {
    const c = await jsonFile(this.candidatePath(collection, version));
    requireThat(c, 'Candidate not found', 404);
    return c;
  }
  async put(collection, version, hash, bytes) {
    const c = await this.get(collection, version);
    requireThat(c.state === 'uploading', 'Candidate is immutable after finalize', 409);
    const f = c.manifest.files.find((f) => f.sha256 === hash);
    requireThat(
      f && bytes.length === f.bytes && digest(bytes) === hash,
      'Object digest or size mismatch',
      422,
    );
    await atomic(this.objectPath(hash), bytes);
  }
  async finish(collection, version) {
    return this.change(async () => {
      const c = await this.get(collection, version);
      if (c.state === 'ready') return c;
      const bodies = new Map();
      for (const f of c.manifest.files) {
        const bytes = await readFile(this.objectPath(f.sha256)).catch(() => null);
        requireThat(
          bytes && bytes.length === f.bytes && digest(bytes) === f.sha256,
          `Missing or corrupt object: ${f.path}`,
          422,
        );
        bodies.set(f.sha256, bytes);
      }
      // The manifest is immutable; validation metadata lives in the candidate record.
      c.manifest.issues.push(...dependencyIssues(c.manifest.files, bodies));
      if (c.manifest.issues.length) c.manifest.complete = false;
      const data = Buffer.from(JSON.stringify(c.manifest));
      await atomic(join(this.root, 'manifests', version + '.json'), data);
      c.manifestHash = digest(data);
      c.state = 'ready';
      c.qualified = c.manifest.complete && c.manifest.issues.length === 0;
      await writeJson(this.candidatePath(collection, version), c);
      return c;
    });
  }
}
