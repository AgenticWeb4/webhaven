import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roleSetting, roleDataDirectory } from '../packages/core/src/settings.js';

test('new role settings take precedence while old configuration remains usable', () => {
  assert.equal(
    roleSetting('PUBLISHER', 'PORT', 8081, { PUBLISHER_PORT: '9100', PRODUCER_PORT: '9000' }),
    '9100',
  );
  assert.equal(
    roleSetting('PUBLISHER', 'TOKENS', '[]', { PRODUCER_TOKENS: 'legacy-scoped-token' }),
    'legacy-scoped-token',
  );
  assert.equal(roleSetting('MIRROR', 'PORT', 8080, { CONSUMER_PORT: '9200' }), '9200');
});

test('role rename does not hide existing default data; explicit directories still win', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'webhaven-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'var', 'producer'), { recursive: true });
  await mkdir(join(root, 'var', 'consumer'));
  assert.equal(roleDataDirectory('PUBLISHER', {}, root), join(root, 'var', 'producer'));
  assert.equal(roleDataDirectory('MIRROR', {}, root), join(root, 'var', 'consumer'));
  assert.equal(
    roleDataDirectory('PUBLISHER', { PUBLISHER_DATA_DIR: 'explicit' }, root),
    join(root, 'explicit'),
  );
});
