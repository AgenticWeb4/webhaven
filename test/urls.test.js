import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivate, normalizeUrl, sameSite, siteId } from '../apps/publisher/src/urls.js';

test('canonical URLs retain query identity, drop fragments and reject credentials/schemes', () => {
  assert.equal(
    normalizeUrl('/img?a=1#x', 'https://EXAMPLE.com:443/path'),
    'https://example.com/img?a=1',
  );
  assert.notEqual(siteId('https://example.com/?a=1'), siteId('https://example.com/?a=2'));
  for (const value of [
    'file:///etc/passwd',
    'http://user:secret@example.com',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => normalizeUrl(value));
  }
});
test('private networks include IPv4-mapped IPv6 and alternate IP spellings', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '172.16.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:7f00:1',
    '::ffff:192.168.1.1',
  ]) {
    assert.equal(isPrivate(address), true, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
    assert.equal(isPrivate(address), false);
  assert.equal(isPrivate(new URL('http://2130706433').hostname), true);
});
test('page traversal stays in the same site', () => {
  assert.equal(sameSite('https://support.example.com/', 'https://www.example.com/'), true);
  assert.equal(sameSite('https://evil-example.com/', 'https://www.example.com/'), false);
});
