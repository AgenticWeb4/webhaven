/**
 * 发布选择：把已就绪版本交付出去，并以条件更新发布头作为唯一生效点。
 * 选择旧版本也是一次新发布，修订继续递增。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { identifier, digest, requireThat, serial } from '@webhaven/core';

/** 串行编排本进程的发布请求；交付仓条件写入负责最终冲突判断。 */
export class ReleasePublisher {
  /** 注入归档与交付适配器；发布逻辑无需知道交付仓采用目录还是 S3。 */
  constructor(archive, deliveryStore) {
    this.archive = archive;
    this.deliveryStore = deliveryStore;
    this.serializePublication = serial();
  }

  /** 返回当前发布记录和条件写令牌；未发布时二者为 null。 */
  async readPublishedRelease(collection) {
    const pointer = await this.deliveryStore.get(`heads/${identifier(collection)}.json`);
    return pointer
      ? { record: JSON.parse(pointer.data), etag: pointer.etag }
      : { record: null, etag: null };
  }

  /**
   * 意图：可重试地选择一个就绪版本，同时保留冲突时的旧选择。
   * 步骤：验证请求 → 查找已提交重放 → 比较修订 → 检查资格 → 交付内容 → 条件提交。
   * request 需要 expectedRevision、operationId；部分版本还需非空 approval 原因。
   * 返回已提交记录；提交后丢失响应时，用相同输入重试可找回该记录。
   */
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

  /** 操作标识和预计修订共同描述重试身份；非法输入在任何写入前拒绝。 */
  #validatePublicationRequest({ operationId, expectedRevision }) {
    identifier(operationId);
    requireThat(
      Number.isSafeInteger(expectedRevision) && expectedRevision >= 0,
      'expectedRevision is required',
    );
  }

  /** 沿历史查找已提交操作；相同操作标识绑定不同版本或修订时返回 409。 */
  async #findCommittedOperation(release, version, { operationId, expectedRevision }) {
    // 后面已有新发布或回滚时，仍要沿历史找回旧操作的提交结果。
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

  /** 防止较早开始的采集覆盖较新的发布；未发布集合的逻辑修订为 0。 */
  #requireExpectedRevision(current, expectedRevision) {
    requireThat(
      (current.record?.revision || 0) === expectedRevision,
      'Publication revision conflict',
      409,
    );
  }

  /** 自动资格或人工批准都要求候选已完成；批准原因不能替代字节校验。 */
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

  /** 发布头切换前准备对象及清单；复用已存在对象，新增内容须与归档摘要匹配。 */
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

  /** 新记录连接前一发布记录，既支持回滚审计，也支持后续幂等重放查找。 */
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

  /** 先写历史记录，最后比较并替换发布头；此前失败只留下未引用交付数据。 */
  async #commitRelease(release, expectedEtag) {
    const releaseBytes = Buffer.from(JSON.stringify(release));
    await this.deliveryStore.put(release.key, releaseBytes);
    // 这是发布生效点；它引用的对象、清单和历史记录都已先准备好。
    await this.deliveryStore.put(`heads/${release.collection}.json`, releaseBytes, {
      expected: expectedEtag,
    });
  }
}
