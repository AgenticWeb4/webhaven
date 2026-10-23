/**
 * 本地镜像：从只读交付仓取得版本，验证完整内容后才切换本地选择。
 * 内容访问只使用验证缓存和本地文件，不依赖 Publisher 或交付仓在线。
 */
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

/** 管理本地已验证版本、当前发布选择及同步错误；同步在实例内串行执行。 */
export class LocalMirror {
  /** root 为独立镜像目录；retain 至少为 1，minFreeBytes 为下载后的剩余空间预算。 */
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

  /** 每个集合拥有独立版本目录与 current.json；集合标识先经过校验。 */
  collectionPath(collection) {
    return join(this.root, 'collections', identifier(collection));
  }
  /** 固定版本的磁盘位置，供同步安装及已验证文件服务共同使用。 */
  versionPath(collection, version) {
    return join(this.collectionPath(collection), 'versions', identifier(version));
  }

  /**
   * 意图：交付仓离线时也能从磁盘恢复可信的本地版本。
   * 步骤：清理中断暂存目录 → 校验本地清单与每个文件 → 恢复有效的当前选择。
   * 损坏版本不进入服务缓存；错误记录到集合状态，不凭 current.json 直接信任字节。
   */
  async restoreVerifiedVersions() {
    const collectionsDirectory = join(this.root, 'collections');
    await mkdir(collectionsDirectory, { recursive: true });
    for (const collection of await readdir(collectionsDirectory)) {
      identifier(collection);
      await this.#removeInterruptedDownloads(collection);
      await this.#restoreCollection(collection);
    }
  }

  /** 暂存目录尚未激活，重启可清理；不会删除已经安装的完整版本目录。 */
  async #removeInterruptedDownloads(collection) {
    const directory = this.collectionPath(collection);
    for (const entry of await readdir(directory)) {
      if (entry.startsWith('.staging-'))
        await rm(join(directory, entry), { recursive: true, force: true });
    }
  }

  /** 逐版本重新核验；当前版本还必须匹配发布记录中的清单摘要。 */
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

  /**
   * 意图：让集合从一个完整本地版本切换到另一个完整本地版本。
   * 步骤：读取新修订 → 校验清单与预算 → 暂存并校验对象 → 安装目录 → 激活 → 清理历史。
   * 返回 unpublished/unchanged/activated；激活前失败保留旧选择并清理暂存。
   * 激活后的附属元数据或清理失败单独记录，不撤销已经生效的完整版本。
   */
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

  /** 校验发布头的集合、版本及正整数修订；未发布返回 null。 */
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

  /** 同修订须保持相同清单摘要；修订倒退拒绝，回滚也必须使用更高修订。 */
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

  /** 同时核验清单结构、限额与发布记录所指的集合/版本，返回声明总量。 */
  #requireManifestIdentity(manifest, collection, version) {
    const totalBytes = manifestValid(manifest, this.limits);
    requireThat(
      manifest.collection === collection && manifest.version === version,
      'Manifest identity mismatch',
      422,
    );
    return totalBytes;
  }

  /** 先验证清单原始字节的摘要，再解析内容，避免信任被替换的清单。 */
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

  /** 下载前检查新版本全量及保留空间，不通过提前删除当前版本腾出预算。 */
  async #requireSpaceForVersion(collection, totalBytes) {
    await mkdir(this.collectionPath(collection), { recursive: true });
    const disk = await statfs(this.root);
    requireThat(
      disk.bavail * disk.bsize >= totalBytes + this.minFreeBytes,
      'Insufficient mirror disk space',
      507,
    );
  }

  /** 在隔离暂存目录写入全部已验证文件，最后保存同一版本清单字节。 */
  async #prepareVersion(stagingDirectory, release, version) {
    await mkdir(join(stagingDirectory, 'files'), { recursive: true });
    for (const file of version.manifest.files) {
      const bytes = await this.#readVerifiedObject(release, file);
      await atomic(join(stagingDirectory, 'files', file.path), bytes);
    }
    await atomic(join(stagingDirectory, 'manifest.json'), version.bytes);
  }

  /** 可复用本地同版本对象，但仍核对摘要与大小；否则从交付仓有界读取。 */
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

  /** 安装新目录；目标已存在时重新验证后复用，返回是否已移动暂存目录。 */
  async #installPreparedVersion(stagingDirectory, release, manifest) {
    const target = this.versionPath(release.collection, release.version);
    await mkdir(join(this.collectionPath(release.collection), 'versions'), { recursive: true });
    try {
      await rename(stagingDirectory, target);
      return true;
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      // 回滚可以复用已有旧版本，但必须重新核对已有目录中的清单与文件。
      const prior = await readFile(join(target, 'manifest.json'));
      requireThat(digest(prior) === release.manifestHash, 'Existing version differs', 422);
      await this.#verifyVersionFiles(target, manifest, 'Existing version corrupt');
      return false;
    }
  }

  /** 清单中的每个文件都须存在且匹配字节数与摘要，任一失败即拒绝该版本。 */
  async #verifyVersionFiles(directory, manifest, message) {
    for (const file of manifest.files) {
      const bytes = await readFile(join(directory, 'files', file.path));
      requireThat(bytes.length === file.bytes && digest(bytes) === file.sha256, message, 422);
    }
  }

  /** 先原子保存磁盘选择，再更新内存索引；崩溃重启以磁盘记录重新验证恢复。 */
  async #activateVersion(collection, release, manifest) {
    // 本地生效点：只有全部文件验证完成，才可提交新的 current.json。
    await writeJson(join(this.collectionPath(collection), 'current.json'), release);
    this.activeReleases.set(collection, release);
    this.verifiedManifests.set(`${collection}/${release.version}`, manifest);
    delete this.errors[collection];
  }

  /** 激活修订用于历史排序；这些后处理失败记为降级，已经激活的内容仍可访问。 */
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

  /** 只查询已验证的内存清单，缺失返回 null；访问请求不会借此回源或同步。 */
  async readVerifiedManifest(collection, version) {
    identifier(collection);
    identifier(version);
    return this.verifiedManifests.get(`${collection}/${version}`) || null;
  }

  /** 按最近激活修订保留历史；先保住当前版本，再补足 retain，回滚也计为最近激活。 */
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
