// Screen size per person and per device (features/uiprefs): each device keeps its own zoom, another account never
// sees it, values are checked, and old devices drop off past the cap.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, type Kit } from './audit-kit.ts';
import { MAX_DEVICES } from '../src/features/uiprefs/index.ts';

let k: Kit;
before(async () => { k = await boot(); });
after(() => k?.close());

test('TestUiPrefs_EachDeviceKeepsItsOwnZoom', async () => {
  assert.equal((await k.call('GET', '/api/me/ui/phone_abc123', k.T.jess)).body.zoom, 100);
  await k.ok('PUT', '/api/me/ui/phone_abc123', k.T.jess, { zoom: 80, label: 'Android app' });
  await k.ok('PUT', '/api/me/ui/desk_abc123', k.T.jess, { zoom: 125, label: 'Desktop app' });
  const p = (await k.call('GET', '/api/me/ui/phone_abc123', k.T.jess)).body;
  assert.deepEqual([p.zoom, p.label], [80, 'Android app']);
  assert.equal((await k.call('GET', '/api/me/ui/desk_abc123', k.T.jess)).body.zoom, 125);
  // A later save without a label keeps the name.
  await k.ok('PUT', '/api/me/ui/phone_abc123', k.T.jess, { zoom: 90 });
  assert.equal((await k.call('GET', '/api/me/ui/phone_abc123', k.T.jess)).body.label, 'Android app');
});

test('TestUiPrefs_PrivateCheckedAndSignedIn', async () => {
  await k.ok('PUT', '/api/me/ui/shared_dev1', k.T.jess, { zoom: 70 });
  assert.equal((await k.call('GET', '/api/me/ui/shared_dev1', k.T.tom)).body.zoom, 100, 'another account sees its own row only');
  assert.equal((await k.call('GET', '/api/me/ui/shared_dev1', null)).status, 401);
  assert.equal((await k.call('PUT', '/api/me/ui/shared_dev1', k.T.jess, { zoom: 20 })).status, 400);
  assert.equal((await k.call('PUT', '/api/me/ui/shared_dev1', k.T.jess, { zoom: 'big' })).status, 400);
  assert.equal((await k.call('PUT', '/api/me/ui/a%20b', k.T.jess, { zoom: 90 })).status, 400);
});

test('TestUiPrefs_OldDevicesDropOffPastTheCap', async () => {
  for (let i = 0; i < MAX_DEVICES + 3; i++) await k.ok('PUT', `/api/me/ui/many_${String(i).padStart(3, '0')}`, k.T.tom, { zoom: 110 });
  const n = (k.deps.db as any).prepare('SELECT COUNT(*) AS n FROM ui_prefs WHERE account_id = ?').get(k.ID.tom).n;
  assert.equal(n, MAX_DEVICES);
});
