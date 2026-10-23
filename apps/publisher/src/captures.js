/**
 * 采集任务编排：持久排队、执行采集、归档，并按资格决定是否自动发布。
 * 任务完成与发布成功分别记录，避免把获取内容成功误报为公开版本已切换。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { identifier, requireThat, writeJson, jsonFile, serial } from '@webhaven/core';
import { captureWebsite, captureS3Prefix } from './capture.js';

/** 检查预计修订并附加当前版本文件；部分提交据此保留未覆盖的基础文件。 */
export async function prepareVersionInput(archive, releasePublisher, collection, input) {
  const current = (await releasePublisher.readPublishedRelease(collection)).record;
  requireThat(
    (current?.revision || 0) === input.expectedRevision,
    'Publication revision conflict',
    409,
  );
  const baseFiles = current
    ? (await archive.readCandidate(collection, current.version)).manifest.files
    : [];
  return { ...input, baseFiles };
}

/** 合格且允许自动发布时才尝试选择；返回原候选并附 release 或 publishError。 */
export async function publishIfQualified(releasePublisher, collection, candidate, options = {}) {
  if (!candidate.qualified || options.autoPublish === false) return candidate;
  try {
    candidate.release = await releasePublisher.publishVersion(
      collection,
      candidate.manifest.version,
      {
        expectedRevision: candidate.expectedRevision,
        operationId: options.operationId || candidate.manifest.version,
      },
    );
  } catch (error) {
    candidate.publishError = error.message;
  }
  return candidate;
}

/** 单进程串行任务队列；持久文件支持重启恢复，不提供跨进程任务调度。 */
export class CaptureQueue {
  /** 注入归档、发布编排和来源配置；来源凭证仅供执行时连接，不写入版本来源描述。 */
  constructor(archive, releasePublisher, env = process.env) {
    this.archive = archive;
    this.releasePublisher = releasePublisher;
    this.env = env;
    this.serializeCapture = serial();
  }

  /** 任务文件按集合隔离；路径只使用经过校验的标识。 */
  #jobPath(collection, captureId) {
    return join(this.archive.root, 'jobs', identifier(collection), `${identifier(captureId)}.json`);
  }

  /** 返回唯一持久任务及结果；任务不存在时返回 404。 */
  async readCapture(collection, captureId) {
    const job = await jsonFile(this.#jobPath(collection, captureId));
    requireThat(job, 'Capture not found', 404);
    return job;
  }

  /**
   * 意图：向提交者返回可查询、已持久保存的采集任务。
   * 步骤：检查来源种类与预计修订 → 固定基础文件 → 保存 queued → 加入执行队列。
   * 返回任务不表示采集完成；调用方须继续查询任务状态和缺口。
   */
  async startCapture(collection, input) {
    requireThat(['web', 's3'].includes(input.kind), 'Capture kind must be web or s3');
    requireThat(
      Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
      'expectedRevision is required',
    );
    const preparedInput = await prepareVersionInput(
      this.archive,
      this.releasePublisher,
      collection,
      input,
    );
    const job = {
      id: randomUUID(),
      collection,
      state: 'queued',
      input: preparedInput,
      createdAt: new Date().toISOString(),
    };
    await this.#saveCapture(job);
    this.#enqueueCapture(job);
    return job;
  }

  /** 将任务状态原子写回自己的集合目录，使查询与恢复读取同一记录。 */
  #saveCapture(job) {
    return writeJson(this.#jobPath(job.collection, job.id), job);
  }

  /** 串行执行任务；持久化本身失败需记录日志，不能只依赖尚未保存的任务状态。 */
  #enqueueCapture(job) {
    return this.serializeCapture(() => this.#executeCapture(job)).catch((error) =>
      console.error('Capture persistence failure:', error.message),
    );
  }

  /**
   * 意图：把获取结果与发布结果分开持久记录。
   * 步骤：保存 running → 采集归档 → 保存 complete/partial → 尝试发布 → 保存结束信息。
   * 采集异常标记 failed；发布异常保留候选并单独记录 publishError。
   */
  async #executeCapture(job) {
    job.state = 'running';
    await this.#saveCapture(job);
    try {
      const candidate = await this.#captureSource(job);
      job.version = candidate.manifest.version;
      job.state = candidate.qualified ? 'complete' : 'partial';
      await this.#saveCapture(job);
      await publishIfQualified(this.releasePublisher, job.collection, candidate, {
        autoPublish: job.input.autoPublish,
        operationId: job.id,
      });
      if (candidate.release) job.release = candidate.release;
      if (candidate.publishError) job.publishError = candidate.publishError;
    } catch (error) {
      job.state = 'failed';
      job.error = error.message;
    } finally {
      job.finishedAt = new Date().toISOString();
      await this.#saveCapture(job);
    }
  }

  /** S3 连接目标取自运维配置，任务输入不能注入另一套桶凭证或连接地址。 */
  #captureSource(job) {
    if (job.input.kind === 'web') return captureWebsite(this.archive, job.collection, job.input);
    return captureS3Prefix(this.archive, job.collection, {
      ...job.input,
      bucket: this.env.SOURCE_S3_BUCKET,
      prefix: this.env.SOURCE_S3_PREFIX,
      endpoint: this.env.SOURCE_S3_ENDPOINT,
      region: this.env.SOURCE_S3_REGION,
      credentials: this.env.SOURCE_S3_ACCESS_KEY_ID
        ? {
            accessKeyId: this.env.SOURCE_S3_ACCESS_KEY_ID,
            secretAccessKey: this.env.SOURCE_S3_SECRET_ACCESS_KEY,
          }
        : undefined,
    });
  }

  /**
   * 意图：重启后恢复可继续的排队任务，并明确标记执行中断。
   * queued 可重新入队；running 标记 interrupted，要求重新提交，避免猜测外部执行进度。
   */
  async recoverInterruptedCaptures() {
    const directory = join(this.archive.root, 'jobs');
    const collections = await readdir(directory).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const collection of collections) {
      for (const filename of await readdir(join(directory, collection))) {
        const job = await jsonFile(join(directory, collection, filename));
        if (job?.state === 'queued') this.#enqueueCapture(job);
        else if (job?.state === 'running') {
          job.state = 'interrupted';
          job.error = 'Publisher stopped during capture; submit a new capture';
          await writeJson(join(directory, collection, filename), job);
        }
      }
    }
  }
}
