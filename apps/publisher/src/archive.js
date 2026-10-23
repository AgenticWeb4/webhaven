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

export class VersionArchive {
  constructor(root, limits = {}) {
    this.root = root;
    this.limits = limits;
    this.serializeFinalization = serial();
  }

  candidatePath(collection, version) {
    return join(this.root, 'candidates', identifier(collection), `${identifier(version)}.json`);
  }

  objectPath(sha256) {
    return join(this.root, 'objects', hex(sha256));
  }

  async beginVersion(collection, input) {
    identifier(collection);
    requireThat(
      Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
      'expectedRevision is required',
    );
    const manifest = this.#describeVersion(collection, input);
    const totalBytes = manifestValid(manifest, this.limits);
    await this.#requireSpaceForVersion(totalBytes);
    const candidate = { manifest, expectedRevision: input.expectedRevision, state: 'uploading' };
    await writeJson(this.candidatePath(collection, manifest.version), candidate);
    return candidate;
  }

  #describeVersion(collection, input) {
    const filesByPath = new Map(
      (input.complete ? [] : input.baseFiles || []).map((file) => [file.path, file]),
    );
    for (const file of input.files || []) filesByPath.set(file.path, file);
    return {
      schema: 1,
      collection,
      version: randomUUID(),
      files: [...filesByPath.values()],
      complete: input.complete,
      issues: input.issues || [],
      source: input.source || { kind: 'upload' },
      createdAt: new Date().toISOString(),
    };
  }

  async #requireSpaceForVersion(totalBytes) {
    await mkdir(this.root, { recursive: true });
    const disk = await statfs(this.root);
    const reserveBytes = this.limits.minFreeBytes ?? 67108864;
    requireThat(
      disk.bavail * disk.bsize >= totalBytes + reserveBytes,
      'Insufficient publisher disk space',
      507,
    );
  }

  async readCandidate(collection, version) {
    const candidate = await jsonFile(this.candidatePath(collection, version));
    requireThat(candidate, 'Candidate not found', 404);
    return candidate;
  }

  async storeCandidateObject(collection, version, sha256, bytes) {
    const candidate = await this.readCandidate(collection, version);
    requireThat(candidate.state === 'uploading', 'Candidate is immutable after finalize', 409);
    const declaredFile = candidate.manifest.files.find((file) => file.sha256 === sha256);
    requireThat(
      declaredFile && bytes.length === declaredFile.bytes && digest(bytes) === sha256,
      'Object digest or size mismatch',
      422,
    );
    await atomic(this.objectPath(sha256), bytes);
  }

  async finalizeVersion(collection, version) {
    return this.serializeFinalization(async () => {
      const candidate = await this.readCandidate(collection, version);
      if (candidate.state === 'ready') return candidate;
      const bodies = await this.#readVerifiedObjects(candidate.manifest.files);
      this.#recordDependencyChecks(candidate.manifest, bodies);
      await this.#commitArchivedVersion(collection, version, candidate);
      return candidate;
    });
  }

  async #readVerifiedObjects(files) {
    const bodies = new Map();
    for (const file of files) {
      const bytes = await readFile(this.objectPath(file.sha256)).catch(() => null);
      requireThat(
        bytes && bytes.length === file.bytes && digest(bytes) === file.sha256,
        `Missing or corrupt object: ${file.path}`,
        422,
      );
      bodies.set(file.sha256, bytes);
    }
    return bodies;
  }

  #recordDependencyChecks(manifest, bodies) {
    manifest.issues.push(...dependencyIssues(manifest.files, bodies));
    if (manifest.issues.length) manifest.complete = false;
  }

  async #commitArchivedVersion(collection, version, candidate) {
    const manifestBytes = Buffer.from(JSON.stringify(candidate.manifest));
    await atomic(join(this.root, 'manifests', `${version}.json`), manifestBytes);
    candidate.manifestHash = digest(manifestBytes);
    candidate.state = 'ready';
    candidate.qualified = candidate.manifest.complete && candidate.manifest.issues.length === 0;
    await writeJson(this.candidatePath(collection, version), candidate);
  }
}
