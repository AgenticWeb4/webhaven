import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { config } from './config.js';

export const hash = (value) => createHash('sha256').update(value).digest('hex');

export function normalizeUrl(value, base) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public HTTP(S) URLs without credentials are supported');
  }
  url.hash = '';
  return url.href;
}

export function isPrivate(address) {
  try {
    return ipaddr.process(address.replace(/^\[|\]$/g, '')).range() !== 'unicast';
  } catch {
    return true;
  }
}

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

export async function validateTarget(value) {
  const url = new URL(normalizeUrl(value));
  if (!config.allowPrivate && url.port && !['80', '443'].includes(url.port))
    throw new Error('Unsupported target port');
  await addresses(url.hostname);
  return url.href;
}

export const siteId = (url) => hash(normalizeUrl(url)).slice(0, 16);
export const sameSite = (url, root) => {
  const domain = new URL(root).hostname.replace(/^www\./, '');
  const host = new URL(url).hostname;
  return host === domain || host.endsWith(`.${domain}`);
};
