/**
 * URL 身份与目标检查：保留查询参数、移除片段，限制协议、端口及网络地址范围。
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { config } from './config.js';

/** 为规范 URL 生成稳定摘要；这里只生成名称，不代表已校验内容。 */
export const hash = (value) => createHash('sha256').update(value).digest('hex');

/** 解析相对 URL，拒绝凭证及非 HTTP(S) 协议；片段不参与网络资源身份。 */
export function normalizeUrl(value, base) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public HTTP(S) URLs without credentials are supported');
  }
  url.hash = '';
  return url.href;
}

/** 非公开单播地址及无法识别的地址都视为受限；统一处理 IPv4 映射 IPv6。 */
export function isPrivate(address) {
  try {
    return ipaddr.process(address.replace(/^\[|\]$/g, '')).range() !== 'unicast';
  } catch {
    return true;
  }
}

/** 解析全部 DNS 答案；默认任一答案受限就拒绝，返回结果供实际连接直接使用。 */
export async function addresses(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const answers = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  const permitted = (address) =>
    !isPrivate(address) || (config.allowFakeIp && !isIP(host) && /^198\.(18|19)\./.test(address));
  if (
    !answers.length ||
    (!config.allowPrivate && answers.some(({ address }) => !permitted(address)))
  ) {
    throw new Error(`Private/reserved network target denied: ${hostname}`);
  }
  return answers;
}

/** 检查规范 URL、允许端口及当前解析结果；下载连接时仍需再次检查地址。 */
export async function validateTarget(value) {
  const url = new URL(normalizeUrl(value));
  if (!config.allowPrivate && url.port && !['80', '443'].includes(url.port))
    throw new Error('Unsupported target port');
  await addresses(url.hostname);
  return url.href;
}

/** 规范 URL 的短标识；不用于内容完整性或认证。 */
export const siteId = (url) => hash(normalizeUrl(url)).slice(0, 16);
/** 按去掉 www 的根主机及其子域判断范围；这是主机比较，不是公共后缀解析。 */
export const sameSite = (url, root) => {
  const domain = new URL(root).hostname.replace(/^www\./, '');
  const host = new URL(url).hostname;
  return host === domain || host.endsWith(`.${domain}`);
};
