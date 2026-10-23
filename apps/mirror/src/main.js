/**
 * Mirror 进程入口。
 * 启动意图：选择配置并锁定独立目录 → 恢复已验证本地版本 → 开始提供内容 → 后台轮询更新。
 * 服务无需等待交付仓恢复即可启动；首次没有本地版本时内容仍会返回未发布。
 */
import { lock, identifier, requireThat } from '@webhaven/core';
import { delivery } from '../../../packages/core/src/store.js';
import { roleSetting, roleDataDirectory } from '../../../packages/core/src/settings.js';
import { LocalMirror } from './mirror.js';
import { createMirrorServer } from './http.js';

const dataDirectory = roleDataDirectory('MIRROR');
const releaseProcessLock = await lock(dataDirectory);
const collections = (process.env.COLLECTIONS || '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
collections.forEach(identifier);
requireThat(collections.length > 0, 'COLLECTIONS is required');
const syncIntervalMs = Number(process.env.SYNC_INTERVAL_MS || 30000);
requireThat(Number.isFinite(syncIntervalMs) && syncIntervalMs >= 100, 'Invalid sync interval');
const mirror = new LocalMirror(dataDirectory, delivery(process.env, true), {
  retain: Number(process.env.RETAIN_VERSIONS || 3),
  minFreeBytes: Number(process.env.MIN_FREE_BYTES || 67108864),
  limits: {
    fileBytes: Number(process.env.MAX_FILE_BYTES || 20971520),
    totalBytes: Number(process.env.MAX_VERSION_BYTES || 262144000),
  },
});
await mirror.restoreVerifiedVersions();
const server = createMirrorServer(mirror);
server.listen(
  Number(roleSetting('MIRROR', 'PORT', 8080)),
  roleSetting('MIRROR', 'HOST', '127.0.0.1'),
);
let stopped = false;
let nextSync;

/** 逐集合记录同步失败，避免一个集合阻塞其他集合；一轮结束后再计时，避免定时任务重叠。 */
async function syncConfiguredCollections() {
  for (const collection of collections) {
    try {
      await mirror.syncCollection(collection);
    } catch (error) {
      console.error(JSON.stringify({ collection, error: error.message }));
    }
  }
  if (!stopped) nextSync = setTimeout(syncConfiguredCollections, syncIntervalMs);
}
void syncConfiguredCollections();
/** 停止后续轮询并释放本地锁；未完成暂存会在下次启动时清理。 */
async function stopMirror() {
  stopped = true;
  clearTimeout(nextSync);
  server.close();
  await releaseProcessLock();
  process.exit(0);
}
process.on('SIGTERM', stopMirror);
process.on('SIGINT', stopMirror);
console.log('WebHaven mirror started');
