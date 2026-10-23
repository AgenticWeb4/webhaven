/**
 * 下载配置在模块加载时从环境读取；修改环境需重启进程。
 * 默认拒绝私网，测试夹具需在启动前显式允许；MAX_FILE_BYTES 以字节为单位。
 */
export const config = {
  allowPrivate: process.env.ALLOW_PRIVATE_NETWORK === 'true',
  allowFakeIp: false,
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 15000),
  maxAssetBytes: Number(process.env.MAX_FILE_BYTES || 20971520),
};
