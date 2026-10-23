import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { S3Store } from '../packages/core/src/store.js';
import { Archive } from '../apps/producer/src/archive.js';
import { Publisher } from '../apps/producer/src/publish.js';
import { fromS3 } from '../apps/producer/src/capture.js';
import { Replica } from '../apps/consumer/src/replica.js';

const endpoint = process.env.TEST_S3_ENDPOINT;
test(
  'S3-compatible service: source prefix, conditional commit, read-only replica and signed requests',
  { skip: !endpoint },
  async (t) => {
    const credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
    const client = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials,
    });
    t.after(() => client.destroy());
    const bucket = 'webhaven-test-' + randomUUID();
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    const source = new S3Store({ bucket, endpoint, credentials, prefix: 'source' });
    await source.put('index.html', Buffer.from('S3 source website'));
    await source.put('nested/readme.txt', Buffer.from('nested source object'));
    const local = await mkdtemp(join(tmpdir(), 'webhaven-s3-'));
    t.after(() => rm(local, { recursive: true, force: true }));
    const archive = new Archive(join(local, 'producer'));
    const c = await fromS3(archive, 'docs', {
      bucket,
      prefix: 'source',
      endpoint,
      credentials,
      expectedRevision: 0,
    });
    assert.equal(c.manifest.files.length, 2);
    const delivery = new S3Store({ bucket, endpoint, credentials, prefix: 'delivery' });
    const pub = new Publisher(archive, delivery);
    const release = await pub.publish('docs', c.manifest.version, {
      expectedRevision: 0,
      operationId: 'first',
    });
    assert.equal(release.revision, 1);
    const readOnly = new S3Store({
      bucket,
      endpoint,
      credentials,
      prefix: 'delivery',
      readOnly: true,
    });
    await assert.rejects(readOnly.put('invalid', Buffer.from('x')), /Read-only/);
    const replica = new Replica(join(local, 'consumer'), readOnly, { minFreeBytes: 0 });
    await replica.load();
    await replica.sync('docs');
    assert.equal(replica.heads.get('docs').version, c.manifest.version);
    await assert.rejects(
      delivery.put('heads/docs.json', Buffer.from('{}'), { expected: null }),
      (e) => e.status === 409,
    );
    await assert.rejects(
      delivery.put('heads/docs.json', Buffer.from('{}'), { expected: '"wrong-etag"' }),
      (e) => e.status === 409,
    );
    const writes = await Promise.allSettled([
      delivery.put('race.json', Buffer.from('a'), { expected: null }),
      delivery.put('race.json', Buffer.from('b'), { expected: null }),
    ]);
    assert.equal(writes.filter((x) => x.status === 'fulfilled').length, 1);
    const old = await delivery.get('race.json');
    const update = await Promise.allSettled([
      delivery.put('race.json', Buffer.from('c'), { expected: old.etag }),
      delivery.put('race.json', Buffer.from('d'), { expected: old.etag }),
    ]);
    assert.equal(update.filter((x) => x.status === 'fulfilled').length, 1);
    if (process.env.TEST_S3_READ_ONLY_ACCESS_KEY_ID) {
      const restricted = new S3Store({
        bucket,
        endpoint,
        prefix: 'delivery',
        credentials: {
          accessKeyId: process.env.TEST_S3_READ_ONLY_ACCESS_KEY_ID,
          secretAccessKey: process.env.TEST_S3_READ_ONLY_SECRET_ACCESS_KEY,
        },
      });
      assert.ok((await restricted.get(`manifests/${c.manifest.version}.json`)).data.length > 0);
      await assert.rejects(
        restricted.put('denied', Buffer.from('x')),
        (e) => e.$metadata?.httpStatusCode === 403,
      );
      restricted.client.destroy();
    }
    assert.ok((await readOnly.get(`manifests/${c.manifest.version}.json`)).data.length > 0);
  },
);
