import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { identifier, digest, requireThat, serial } from '@webhaven/core';

export class ReleasePublisher {
  constructor(archive, deliveryStore) {
    this.archive = archive;
    this.deliveryStore = deliveryStore;
    this.serializePublication = serial();
  }

  async readPublishedRelease(collection) {
    const pointer = await this.deliveryStore.get(`heads/${identifier(collection)}.json`);
    return pointer
      ? { record: JSON.parse(pointer.data), etag: pointer.etag }
      : { record: null, etag: null };
  }

  async publishVersion(collection, version, request = {}) {
    return this.serializePublication(async () => {
      this.#validatePublicationRequest(request);
      const current = await this.readPublishedRelease(collection);
      const committed = await this.#findCommittedOperation(current.record, version, request);
      if (committed) return committed;

      this.#requireExpectedRevision(current, request.expectedRevision);
      const candidate = await this.#requirePublishableCandidate(
        collection,
        version,
        request.approval,
      );
      await this.#stageVersionForDelivery(candidate);
      const release = this.#describeRelease(collection, version, candidate, current, request);
      await this.#commitRelease(release, current.etag);
      return release;
    });
  }

  #validatePublicationRequest({ operationId, expectedRevision }) {
    identifier(operationId);
    requireThat(
      Number.isSafeInteger(expectedRevision) && expectedRevision >= 0,
      'expectedRevision is required',
    );
  }

  async #findCommittedOperation(release, version, { operationId, expectedRevision }) {
    // Follow history so replay remains idempotent even after a later release or rollback.
    while (release) {
      if (release.operationId === operationId) {
        requireThat(
          release.version === version && release.revision === expectedRevision + 1,
          'Operation ID already used for different inputs',
          409,
        );
        return release;
      }
      if (release.revision <= expectedRevision) break;
      const previous = release.previous ? await this.deliveryStore.get(release.previous) : null;
      release = previous ? JSON.parse(previous.data) : null;
    }
    return null;
  }

  #requireExpectedRevision(current, expectedRevision) {
    requireThat(
      (current.record?.revision || 0) === expectedRevision,
      'Publication revision conflict',
      409,
    );
  }

  async #requirePublishableCandidate(collection, version, approval) {
    const candidate = await this.archive.readCandidate(collection, version);
    requireThat(candidate.state === 'ready', 'Candidate is not finalized', 409);
    const explicitlyApproved = typeof approval === 'string' && approval.trim().length > 0;
    requireThat(
      candidate.qualified || explicitlyApproved,
      'Partial version requires explicit approval reason',
      422,
    );
    return candidate;
  }

  async #stageVersionForDelivery(candidate) {
    for (const file of candidate.manifest.files) {
      const objectKey = `objects/${file.sha256}`;
      if (await this.deliveryStore.get(objectKey, this.archive.limits.fileBytes)) continue;
      const bytes = await readFile(this.archive.objectPath(file.sha256));
      requireThat(digest(bytes) === file.sha256, 'Archive corruption', 422);
      await this.deliveryStore.put(objectKey, bytes);
    }
    const version = candidate.manifest.version;
    const manifestBytes = await readFile(join(this.archive.root, 'manifests', `${version}.json`));
    requireThat(
      digest(manifestBytes) === candidate.manifestHash,
      'Archive manifest corruption',
      422,
    );
    await this.deliveryStore.put(`manifests/${version}.json`, manifestBytes);
  }

  #describeRelease(collection, version, candidate, current, request) {
    const revision = request.expectedRevision + 1;
    return {
      schema: 1,
      collection,
      version,
      revision,
      manifestHash: candidate.manifestHash,
      operationId: request.operationId,
      approval: request.approval || null,
      previous: current.record?.key || null,
      key: `releases/${collection}/${revision}-${request.operationId}.json`,
      publishedAt: new Date().toISOString(),
    };
  }

  async #commitRelease(release, expectedEtag) {
    const releaseBytes = Buffer.from(JSON.stringify(release));
    await this.deliveryStore.put(release.key, releaseBytes);
    // This conditional pointer write is the publication commit. Everything it references is ready.
    await this.deliveryStore.put(`heads/${release.collection}.json`, releaseBytes, {
      expected: expectedEtag,
    });
  }
}
