import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import {
  body,
  respond,
  identifier,
  requireThat,
  writeJson,
  jsonFile,
  serial,
} from '@webhaven/core';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { fromWeb, fromS3 } from './capture.js';

async function baseInput(archive, publisher, c, input) {
  const head = (await publisher.head(c)).record;
  requireThat(
    (head?.revision || 0) === input.expectedRevision,
    'Publication revision conflict',
    409,
  );
  const baseFiles = head ? (await archive.get(c, head.version)).manifest.files : [];
  return { ...input, baseFiles };
}
export class Captures {
  constructor(archive, publisher, env = process.env) {
    this.archive = archive;
    this.publisher = publisher;
    this.env = env;
    this.queue = serial();
  }
  path(c, id) {
    return join(this.archive.root, 'jobs', identifier(c), identifier(id) + '.json');
  }
  async start(c, input) {
    requireThat(['web', 's3'].includes(input.kind), 'Capture kind must be web or s3');
    requireThat(
      Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
      'expectedRevision is required',
    );
    input = await baseInput(this.archive, this.publisher, c, input);
    const job = {
      id: randomUUID(),
      collection: c,
      state: 'queued',
      input,
      createdAt: new Date().toISOString(),
    };
    await writeJson(this.path(c, job.id), job);
    this.run(job);
    return job;
  }
  run(job) {
    return this.queue(async () => {
      const save = () => writeJson(this.path(job.collection, job.id), job);
      job.state = 'running';
      await save();
      try {
        const options = { ...job.input };
        if (options.kind === 's3')
          Object.assign(options, {
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
        const c =
          options.kind === 'web'
            ? await fromWeb(this.archive, job.collection, options)
            : await fromS3(this.archive, job.collection, options);
        job.version = c.manifest.version;
        job.state = c.qualified ? 'complete' : 'partial';
        await save();
        if (c.qualified && options.autoPublish !== false) {
          try {
            job.release = await this.publisher.publish(job.collection, job.version, {
              expectedRevision: c.expectedRevision,
              operationId: job.id,
            });
          } catch (e) {
            job.publishError = e.message;
          }
        }
      } catch (e) {
        job.state = 'failed';
        job.error = e.message;
      } finally {
        job.finishedAt = new Date().toISOString();
        await save();
      }
    }).catch((e) => console.error('Capture persistence failure:', e.message));
  }
  async recover() {
    const folder = join(this.archive.root, 'jobs');
    for (const c of await readdir(folder).catch((e) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    }))
      for (const f of await readdir(join(folder, c))) {
        const job = await jsonFile(join(folder, c, f));
        if (job?.state === 'queued') this.run(job);
        else if (job?.state === 'running') {
          job.state = 'interrupted';
          job.error = 'Producer stopped during capture; submit a new capture';
          await writeJson(join(folder, c, f), job);
        }
      }
  }
}
function authorized(req, tokens, collection, permission) {
  const offered = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
  const match = tokens.find((t) => {
    const value = Buffer.from(t.token);
    return value.length === offered.length && timingSafeEqual(value, offered);
  });
  requireThat(match, 'Authentication required', 401);
  requireThat(
    match.collections.includes(collection) && match.permissions.includes(permission),
    'Permission denied',
    403,
  );
  return match;
}
export function producerServer(archive, publisher, captures, tokens) {
  requireThat(
    Array.isArray(tokens) && tokens.length > 0,
    'At least one producer token is required',
  );
  for (const t of tokens) {
    requireThat(
      typeof t.token === 'string' && t.token.length >= 24,
      'Token must have at least 24 characters',
    );
    requireThat(
      Array.isArray(t.collections) && Array.isArray(t.permissions),
      'Invalid token scope',
    );
    t.collections.forEach(identifier);
  }
  return createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz')
        return respond(res, 200, { status: 'ok' });
      const path = decodeURIComponent(req.url.split('?')[0]);
      const m = path.match(/^\/v1\/collections\/([^/]+)\/(.+)$/);
      requireThat(m, 'Not found', 404);
      const c = identifier(m[1]),
        route = m[2];
      authorized(req, tokens, c, route === 'publish' ? 'publish' : 'submit');
      if (req.method === 'GET' && route === 'head')
        return respond(res, 200, (await publisher.head(c)).record || { revision: 0 });
      if (req.method === 'POST' && route === 'candidates')
        return respond(
          res,
          201,
          await archive.create(
            c,
            await baseInput(archive, publisher, c, JSON.parse(await body(req, 1048576))),
          ),
        );
      if (req.method === 'POST' && route === 'captures')
        return respond(res, 202, await captures.start(c, JSON.parse(await body(req, 1048576))));
      const job = route.match(/^captures\/([^/]+)$/);
      if (req.method === 'GET' && job) {
        const j = await jsonFile(captures.path(c, job[1]));
        requireThat(j, 'Capture not found', 404);
        return respond(res, 200, j);
      }
      const candidate = route.match(/^candidates\/([^/]+)(?:\/(.*))?$/);
      if (candidate) {
        const id = identifier(candidate[1]);
        if (req.method === 'GET' && !candidate[2])
          return respond(res, 200, await archive.get(c, id));
        const object = candidate[2]?.match(/^objects\/([a-f0-9]{64})$/);
        if (req.method === 'PUT' && object) {
          await archive.put(
            c,
            id,
            object[1],
            await body(req, archive.limits.fileBytes || 20971520),
          );
          return respond(res, 200, { stored: true });
        }
        if (req.method === 'POST' && candidate[2] === 'finalize') {
          const options = JSON.parse(await body(req, 16384));
          const result = await archive.finish(c, id);
          if (result.qualified && options.autoPublish !== false) {
            try {
              result.release = await publisher.publish(c, id, {
                expectedRevision: result.expectedRevision,
                operationId: options.operationId || id,
              });
            } catch (e) {
              result.publishError = e.message;
            }
          }
          return respond(res, 200, result);
        }
      }
      if (req.method === 'POST' && route === 'publish') {
        const input = JSON.parse(await body(req, 16384));
        return respond(res, 200, await publisher.publish(c, identifier(input.version), input));
      }
      return respond(res, 404, { error: 'Not found' });
    } catch (e) {
      if (!res.headersSent)
        respond(res, e.status || (e instanceof SyntaxError ? 400 : 500), {
          error: e.status || e instanceof SyntaxError ? e.message : 'Internal producer error',
        });
      else res.destroy();
    }
  });
}
