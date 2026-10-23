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

export class LocalMirror {
  constructor(
    root,
    deliveryStore,
    { retain = 3, minFreeBytes = 64 * 1024 * 1024, limits = {} } = {},
  ) {
    requireThat(Number.isInteger(retain) && retain >= 1, 'retain must be at least one');
    Object.assign(this, { root, deliveryStore, retain, minFreeBytes, limits });
    this.activeReleases = new Map();
    this.verifiedManifests = new Map();
    this.serializeSync = serial();
    this.errors = {};
  }

  collectionPath(collection) {
    return join(this.root, 'collections', identifier(collection));
  }
  versionPath(collection, version) {
    return join(this.collectionPath(collection), 'versions', identifier(version));
  }

  async restoreVerifiedVersions() {
    const collectionsDirectory = join(this.root, 'collections');
    await mkdir(collectionsDirectory, { recursive: true });
    for (const collection of await readdir(collectionsDirectory)) {
      identifier(collection);
      await this.#removeInterruptedDownloads(collection);
      await this.#restoreCollection(collection);
    }
  }

  async #removeInterruptedDownloads(collection) {
    const directory = this.collectionPath(collection);
    for (const entry of await readdir(directory)) {
      if (entry.startsWith('.staging-'))
        await rm(join(directory, entry), { recursive: true, force: true });
    }
  }

  async #restoreCollection(collection) {
    const selected = await jsonFile(join(this.collectionPath(collection), 'current.json'));
    const versions = await readdir(join(this.collectionPath(collection), 'versions')).catch(
      (error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    for (const version of versions) {
      try {
        const directory = this.versionPath(collection, version);
        const bytes = await readFile(join(directory, 'manifest.json'));
        const manifest = JSON.parse(bytes);
        this.#requireManifestIdentity(manifest, collection, version);
        if (selected?.version === version)
          requireThat(digest(bytes) === selected.manifestHash, 'Local manifest mismatch', 422);
        await this.#verifyVersionFiles(directory, manifest, 'Local content corruption');
        this.verifiedManifests.set(`${collection}/${version}`, manifest);
      } catch (error) {
        this.errors[collection] = error.message;
      }
    }
    if (selected && this.verifiedManifests.has(`${collection}/${selected.version}`))
      this.activeReleases.set(collection, selected);
  }

  async syncCollection(collection) {
    identifier(collection);
    return this.serializeSync(async () => {
      let stagingDirectory;
      try {
        const release = await this.#readLatestRelease(collection);
        if (!release) return { state: 'unpublished' };
        if (this.#isAlreadyActive(collection, release)) return { state: 'unchanged', ...release };
        const version = await this.#readVerifiedDeliveryManifest(release);
        await this.#requireSpaceForVersion(collection, version.totalBytes);
        stagingDirectory = join(this.collectionPath(collection), `.staging-${randomUUID()}`);
        await this.#prepareVersion(stagingDirectory, release, version);
        const installed = await this.#installPreparedVersion(
          stagingDirectory,
          release,
          version.manifest,
        );
        if (installed) stagingDirectory = null;
        await this.#activateVersion(collection, release, version.manifest);
        await this.#recordActivationAndPrune(collection, release);
        return { state: 'activated', ...release };
      } catch (error) {
        this.errors[collection] = error.message;
        throw error;
      } finally {
        if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
      }
    });
  }

  async #readLatestRelease(collection) {
    const pointer = await this.deliveryStore.get(`heads/${collection}.json`);
    if (!pointer) return null;
    const release = JSON.parse(pointer.data);
    identifier(release.version);
    requireThat(
      release.schema === 1 &&
        release.collection === collection &&
        Number.isSafeInteger(release.revision) &&
        release.revision >= 1,
      'Invalid release record',
      422,
    );
    return release;
  }

  #isAlreadyActive(collection, release) {
    const active = this.activeReleases.get(collection);
    if (active?.revision === release.revision) {
      requireThat(active.manifestHash === release.manifestHash, 'Mutated release revision', 422);
      return true;
    }
    requireThat(
      !active || release.revision > active.revision,
      'Release revision went backward',
      409,
    );
    return false;
  }

  #requireManifestIdentity(manifest, collection, version) {
    const totalBytes = manifestValid(manifest, this.limits);
    requireThat(
      manifest.collection === collection && manifest.version === version,
      'Manifest identity mismatch',
      422,
    );
    return totalBytes;
  }

  async #readVerifiedDeliveryManifest(release) {
    const object = await this.deliveryStore.get(`manifests/${release.version}.json`);
    requireThat(
      object && digest(object.data) === release.manifestHash,
      'Manifest digest mismatch',
      422,
    );
    const manifest = JSON.parse(object.data);
    const totalBytes = this.#requireManifestIdentity(manifest, release.collection, release.version);
    return { manifest, bytes: object.data, totalBytes };
  }

  async #requireSpaceForVersion(collection, totalBytes) {
    await mkdir(this.collectionPath(collection), { recursive: true });
    const disk = await statfs(this.root);
    requireThat(
      disk.bavail * disk.bsize >= totalBytes + this.minFreeBytes,
      'Insufficient mirror disk space',
      507,
    );
  }

  async #prepareVersion(stagingDirectory, release, version) {
    await mkdir(join(stagingDirectory, 'files'), { recursive: true });
    for (const file of version.manifest.files) {
      const bytes = await this.#readVerifiedObject(release, file);
      await atomic(join(stagingDirectory, 'files', file.path), bytes);
    }
    await atomic(join(stagingDirectory, 'manifest.json'), version.bytes);
  }

  async #readVerifiedObject(release, file) {
    let bytes = await readFile(
      join(this.versionPath(release.collection, release.version), 'files', file.path),
    ).catch(() => null);
    if (!bytes || digest(bytes) !== file.sha256) {
      const object = await this.deliveryStore.get(`objects/${file.sha256}`, this.limits.fileBytes);
      requireThat(object, 'Missing delivery object', 422);
      bytes = object.data;
    }
    requireThat(
      bytes.length === file.bytes && digest(bytes) === file.sha256,
      `Object verification failed: ${file.path}`,
      422,
    );
    return bytes;
  }

  async #installPreparedVersion(stagingDirectory, release, manifest) {
    const target = this.versionPath(release.collection, release.version);
    await mkdir(join(this.collectionPath(release.collection), 'versions'), { recursive: true });
    try {
      await rename(stagingDirectory, target);
      return true;
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      // A rollback may reuse an old version, but only after its existing bytes are checked again.
      const prior = await readFile(join(target, 'manifest.json'));
      requireThat(digest(prior) === release.manifestHash, 'Existing version differs', 422);
      await this.#verifyVersionFiles(target, manifest, 'Existing version corrupt');
      return false;
    }
  }

  async #verifyVersionFiles(directory, manifest, message) {
    for (const file of manifest.files) {
      const bytes = await readFile(join(directory, 'files', file.path));
      requireThat(bytes.length === file.bytes && digest(bytes) === file.sha256, message, 422);
    }
  }

  async #activateVersion(collection, release, manifest) {
    // Commit the local selection only after every file in the version has been verified.
    await writeJson(join(this.collectionPath(collection), 'current.json'), release);
    this.activeReleases.set(collection, release);
    this.verifiedManifests.set(`${collection}/${release.version}`, manifest);
    delete this.errors[collection];
  }

  async #recordActivationAndPrune(collection, release) {
    await writeJson(join(this.versionPath(collection, release.version), 'activation.json'), {
      revision: release.revision,
    }).catch((error) => {
      this.errors[collection] = `Activation metadata deferred: ${error.message}`;
    });
    await this.#pruneHistory(collection).catch((error) => {
      this.errors[collection] = `Published; cleanup deferred: ${error.message}`;
    });
  }

  async readVerifiedManifest(collection, version) {
    identifier(collection);
    identifier(version);
    return this.verifiedManifests.get(`${collection}/${version}`) || null;
  }

  async #pruneHistory(collection) {
    const directory = join(this.collectionPath(collection), 'versions');
    const versions = [];
    for (const version of await readdir(directory)) {
      const manifest = await jsonFile(join(directory, version, 'manifest.json'));
      if (manifest)
        versions.push({
          ...manifest,
          activation: (await jsonFile(join(directory, version, 'activation.json')))?.revision || 0,
        });
    }
    versions.sort((left, right) => right.activation - left.activation);
    const keep = new Set([this.activeReleases.get(collection).version]);
    for (const version of versions) if (keep.size < this.retain) keep.add(version.version);
    for (const version of versions) {
      if (keep.has(version.version)) continue;
      await rm(join(directory, version.version), { recursive: true, force: true });
      this.verifiedManifests.delete(`${collection}/${version.version}`);
    }
  }
}
