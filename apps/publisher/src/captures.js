import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { identifier, requireThat, writeJson, jsonFile, serial } from '@webhaven/core';
import { captureWebsite, captureS3Prefix } from './capture.js';

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

export class CaptureQueue {
  constructor(archive, releasePublisher, env = process.env) {
    this.archive = archive;
    this.releasePublisher = releasePublisher;
    this.env = env;
    this.serializeCapture = serial();
  }

  #jobPath(collection, captureId) {
    return join(this.archive.root, 'jobs', identifier(collection), `${identifier(captureId)}.json`);
  }

  async readCapture(collection, captureId) {
    const job = await jsonFile(this.#jobPath(collection, captureId));
    requireThat(job, 'Capture not found', 404);
    return job;
  }

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

  #saveCapture(job) {
    return writeJson(this.#jobPath(job.collection, job.id), job);
  }

  #enqueueCapture(job) {
    return this.serializeCapture(() => this.#executeCapture(job)).catch((error) =>
      console.error('Capture persistence failure:', error.message),
    );
  }

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
