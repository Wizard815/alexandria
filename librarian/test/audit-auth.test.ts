// Audit: sign-in edges. Passwords, sessions, keys, invites.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, type Kit } from './audit-kit.ts';

let k: Kit;
before(async () => { k = await boot(); });
after(() => k?.close());

test('Audit_Auth: changing a password signs out every other session of that account', async () => {
  const other = (await k.ok('POST', '/api/auth/login', null, { username: 'tom', password: 'player pass 123' })).token as string;
  const mine = (await k.ok('POST', '/api/auth/login', null, { username: 'tom', password: 'player pass 123' })).token as string;
  assert.equal((await k.call('GET', '/api/me', other)).status, 200);
  await k.ok('POST', '/api/me/password', mine, { current: 'player pass 123', password: 'a brand new password' });
  assert.equal((await k.call('GET', '/api/me', mine)).status, 200, 'the session that changed the password stays signed in');
  assert.equal((await k.call('GET', '/api/me', other)).status, 401, 'a session opened with the old password must not survive the change');
  assert.equal((await k.call('GET', '/api/me', k.T.tom)).status, 401, 'the join session is also an older session');
});

test('Audit_Auth: sessions and keys of an account the admin deleted stop working at once', async () => {
  const inv = await k.ok('POST', k.w('/invites'), k.T.gm, { role: 'player' });
  const j = await k.ok('POST', '/api/join', null, { code: inv.code, username: 'gone', password: 'player pass 123', characterName: 'Gone' });
  const key = (await k.ok('POST', '/api/keys', j.token, { scope: 'scribe', worldId: k.W, label: 'k', access: 'read' })).key as string;
  assert.equal((await k.call('GET', k.w('/library/pages'), key)).status, 200);
  await k.ok('DELETE', `/api/admin/accounts/${j.account.id}`, k.T.admin);
  assert.equal((await k.call('GET', '/api/me', j.token)).status, 401);
  assert.equal((await k.call('GET', k.w('/library/pages'), key)).status, 401);
  assert.equal((await k.call('POST', '/mcp', key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
});

test('Audit_Auth: an invite is single use, a guest invite makes a guest, and the code is not enough without the right body', async () => {
  const inv = await k.ok('POST', k.w('/invites'), k.T.gm, { role: 'guest' });
  const bad = await k.call('POST', '/api/join', null, { code: inv.code, username: 'x' });
  assert.equal(bad.status, 400);
  const bad2 = await k.call('POST', '/api/join', null, { code: inv.code, username: 'bad name!', password: 'player pass 123' });
  assert.equal(bad2.status, 400);
  const first = await k.call('POST', '/api/join', null, { code: inv.code, username: 'guest2', password: 'player pass 123' });
  assert.equal(first.status, 201, first.text);
  const again = await k.call('POST', '/api/join', null, { code: inv.code, username: 'guest3', password: 'player pass 123' });
  assert.equal(again.status, 400, 'the code was used');
  const me = await k.ok('GET', '/api/me', first.body.token);
  assert.equal(me.worlds[0].role, 'guest');
  // A guest cannot write anything a player can.
  assert.equal((await k.call('POST', k.w('/inventory'), first.body.token, { name: 'x' })).status, 403);
  assert.equal((await k.call('POST', k.w('/people'), first.body.token, { name: 'x' })).status, 403);
});

test('Audit_Auth: a failed join with a wrong username format does not use up the invite', async () => {
  const inv = await k.ok('POST', k.w('/invites'), k.T.gm, { role: 'player' });
  const bad = await k.call('POST', '/api/join', null, { code: inv.code, username: 'a', password: 'player pass 123' });
  assert.equal(bad.status, 400);
  const good = await k.call('POST', '/api/join', null, { code: inv.code, username: 'laterplayer', password: 'player pass 123' });
  assert.equal(good.status, 201, good.text);
});
