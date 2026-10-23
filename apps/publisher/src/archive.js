/**
 * 版本归档：把上传候选变成不可变清单与按摘要保存的内容对象。
 * 本模块负责内容就绪和资格判断；切换公开版本由 ReleasePublisher 负责。
 */
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

/** 管理归档根目录和资源限额；完成操作在实例内串行执行。 */
export class VersionArchive {
  /** root 为受进程锁保护的归档目录；limits 控制文件、版本和剩余空间预算。 */
  constructor(root, limits = {}) {
    this.root = root;
    this.limits = limits;
    this.serializeFinalization = serial();
  }

  /** 候选状态与内容对象分开存放，未完成候选不会成为发布清单。 */
  candidatePath(collection, version) {
    return join(this.root, 'candidates', identifier(collection), `${identifier(version)}.json`);
  }

  /** 相同字节共用 SHA-256 对象键，版本清单通过摘要引用它。 */
  objectPath(sha256) {
    return join(this.root, 'objects', hex(sha256));
  }

  /**
   * 意图：在接收文件前固定候选的逻辑清单与预计发布修订。
   * 步骤：校验修订 → 构建完整逻辑清单 → 检查限额和空间 → 保存 uploading 状态。
   * 返回持久候选；expectedRevision 在真正发布时仍需重新比较。
   */
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

  /** 部分输入继承基础文件，完整输入允许删去旧文件；同路径以本次声明为准。 */
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

  /** 预留版本总量和剩余空间预算；检查不等同于向操作系统预约空间。 */
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

  /** 按集合和版本读取候选，缺失返回 404；损坏文件交由入口报告。 */
  async readCandidate(collection, version) {
    const candidate = await jsonFile(this.candidatePath(collection, version));
    requireThat(candidate, 'Candidate not found', 404);
    return candidate;
  }

  /** 仅 uploading 候选可上传声明过且大小、摘要都匹配的字节；完成后拒绝修改。 */
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

  /**
   * 意图：只有所有声明内容已验证的候选才可进入 ready。
   * 步骤：读取或复用已完成结果 → 校验全部对象 → 收集静态依赖缺口 → 固化清单。
   * 返回 qualified 或有缺口的候选；缺失/损坏对象直接拒绝，不产生 ready 半成品。
   */
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

  /** 实际读取并核对每个对象；返回的字节供后续静态依赖检查复用。 */
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

  /** 把依赖缺口固定为版本说明；有缺口时完整声明自动降为部分内容。 */
  #recordDependencyChecks(manifest, bodies) {
    manifest.issues.push(...dependencyIssues(manifest.files, bodies));
    if (manifest.issues.length) manifest.complete = false;
  }

  /** 先保存清单字节与摘要，再提交 ready 状态；资格要求完整且没有已知缺口。 */
  async #commitArchivedVersion(collection, version, candidate) {
    const manifestBytes = Buffer.from(JSON.stringify(candidate.manifest));
    await atomic(join(this.root, 'manifests', `${version}.json`), manifestBytes);
    candidate.manifestHash = digest(manifestBytes);
    candidate.state = 'ready';
    candidate.qualified = candidate.manifest.complete && candidate.manifest.issues.length === 0;
    await writeJson(this.candidatePath(collection, version), candidate);
  }
}
