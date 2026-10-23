import { resolve } from 'node:path';
import { lock, identifier, requireThat } from '@webhaven/core';
import { delivery } from '../../../packages/core/src/store.js';
import { Replica } from './replica.js';
import { consumerServer } from './http.js';

const root = resolve(process.env.CONSUMER_DATA_DIR || 'var/consumer');
const unlock = await lock(root);
const collections = (process.env.COLLECTIONS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
collections.forEach(identifier);
requireThat(collections.length > 0, 'COLLECTIONS is required');
const interval = Number(process.env.SYNC_INTERVAL_MS || 30000);
requireThat(Number.isFinite(interval) && interval >= 100, 'Invalid sync interval');
const replica = new Replica(root, delivery(process.env, true), {
  retain: Number(process.env.RETAIN_VERSIONS || 3),
  minFreeBytes: Number(process.env.MIN_FREE_BYTES || 67108864),
  limits: {
    fileBytes: Number(process.env.MAX_FILE_BYTES || 20971520),
    totalBytes: Number(process.env.MAX_VERSION_BYTES || 262144000),
  },
});
await replica.load();
const server = consumerServer(replica);
server.listen(Number(process.env.CONSUMER_PORT || 8080), process.env.CONSUMER_HOST || '127.0.0.1');
let stopped = false;
let timer;
async function sync() {
  for (const c of collections)
    try {
      await replica.sync(c);
    } catch (e) {
      console.error(JSON.stringify({ collection: c, error: e.message }));
    }
  if (!stopped) timer = setTimeout(sync, interval);
}
void sync();
async function stop() {
  stopped = true;
  clearTimeout(timer);
  server.close();
  await unlock();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
console.log('WebHaven consumer started');
