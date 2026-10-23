/**
 * Publisher 进程入口。
 * 启动意图：选择配置 → 独占归档与本地交付目录 → 组合归档/发布/采集 → 恢复任务 → 监听控制请求。
 * 本地交付仓需要额外进程锁；S3 通过服务端条件写入协调发布头。
 */
import { readFile } from 'node:fs/promises';
import { lock } from '@webhaven/core';
import { delivery, LocalStore } from '../../../packages/core/src/store.js';
import { roleSetting, roleDataDirectory } from '../../../packages/core/src/settings.js';
import { VersionArchive } from './archive.js';
import { ReleasePublisher } from './publish.js';
import { CaptureQueue } from './captures.js';
import { createPublisherServer } from './http.js';

const dataDirectory = roleDataDirectory('PUBLISHER');
const releaseProcessLock = await lock(dataDirectory);
const authenticationFile = roleSetting('PUBLISHER', 'AUTH_FILE');
const tokens = JSON.parse(
  authenticationFile
    ? await readFile(authenticationFile, 'utf8')
    : roleSetting('PUBLISHER', 'TOKENS', '[]'),
);
const archive = new VersionArchive(dataDirectory, {
  fileBytes: Number(process.env.MAX_FILE_BYTES || 20971520),
  totalBytes: Number(process.env.MAX_VERSION_BYTES || 262144000),
});
const deliveryStore = delivery();
const releaseDeliveryLock =
  deliveryStore instanceof LocalStore ? await lock(deliveryStore.root) : async () => {};
const releasePublisher = new ReleasePublisher(archive, deliveryStore);
const captureQueue = new CaptureQueue(archive, releasePublisher);
await captureQueue.recoverInterruptedCaptures();
const server = createPublisherServer(archive, releasePublisher, captureQueue, tokens);
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(
  Number(roleSetting('PUBLISHER', 'PORT', 8081)),
  roleSetting('PUBLISHER', 'HOST', '127.0.0.1'),
);

/** 停止接收请求并在连接结束后释放目录锁；超时退出由下次启动恢复检查处理。 */
async function stopPublisher() {
  server.close(async () => {
    await releaseDeliveryLock();
    await releaseProcessLock();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', stopPublisher);
process.on('SIGINT', stopPublisher);
console.log('WebHaven publisher started');
