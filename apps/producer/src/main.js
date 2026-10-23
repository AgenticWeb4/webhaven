import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { lock } from '@webhaven/core';
import { delivery, LocalStore } from '../../../packages/core/src/store.js';
import { Archive } from './archive.js';
import { Publisher } from './publish.js';
import { Captures, producerServer } from './http.js';

const root = resolve(process.env.PRODUCER_DATA_DIR || 'var/producer');
const unlock = await lock(root);
const tokens = JSON.parse(
  process.env.PRODUCER_AUTH_FILE
    ? await readFile(process.env.PRODUCER_AUTH_FILE, 'utf8')
    : process.env.PRODUCER_TOKENS || '[]',
);
const archive = new Archive(root, {
  fileBytes: Number(process.env.MAX_FILE_BYTES || 20971520),
  totalBytes: Number(process.env.MAX_VERSION_BYTES || 262144000),
});
const store = delivery();
const unlockDelivery = store instanceof LocalStore ? await lock(store.root) : async () => {};
const publisher = new Publisher(archive, store);
const captures = new Captures(archive, publisher);
await captures.recover();
const server = producerServer(archive, publisher, captures, tokens);
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(Number(process.env.PRODUCER_PORT || 8081), process.env.PRODUCER_HOST || '127.0.0.1');
async function stop() {
  server.close(async () => {
    await unlockDelivery();
    await unlock();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
console.log('WebHaven producer started');
