export const config = {
  allowPrivate: process.env.ALLOW_PRIVATE_NETWORK === 'true',
  allowFakeIp: false,
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 15000),
  maxAssetBytes: Number(process.env.MAX_FILE_BYTES || 20971520),
};
