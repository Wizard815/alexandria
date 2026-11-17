// Audit: live events. A stream stays open for a long time: who may read it is checked again for every event.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { EventTap } from './security-kit.ts';
import { boot, type Kit } from './audit-kit.ts';

let k: Kit;
before(async () => { k = await boot(); });
after(() => k?.close());
const settle = () => new Promise((r) => setTimeout(r, 150));
const EVENTS = () => k.w('/events');

test('Audit_Events: a player removed from the world stops receiving its live events', async () => {
  const tap = new EventTap(k.base + EVENTS(), k.T.tom);
  await settle();
  await k.ok('PUT', k.w('/live/presence'), k.T.dm, { location: 'before removal' });
  await settle();
  assert.ok(tap.text.includes('before removal'), 'the stream works while tom is a member');
  await k.ok('DELETE', `/api/admin/worlds/${k.W}/members/${k.ID.tom}`, k.T.admin);
  await k.ok('PUT', k.w('/live/presence'), k.T.dm, { location: 'after removal ZQXAFTER' });
  await k.ok('POST', k.w('/stage/cards'), k.T.dm, { kind: 'text', text: 'ZQXAFTERCARD' });
  await settle();
  await tap.close();
  assert.ok(!tap.text.includes('ZQXAFTER'), `a removed player still got events: ${tap.text.slice(-300)}`);
});

test('Audit_Events: a DM who is demoted stops receiving DM-only events', async () => {
  const dm2 = k.T.dm2;
  const tap = new EventTap(k.base + k.w2('/events'), dm2);
  await settle();
  await k.ok('PUT', `/api/admin/worlds/${k.W2}/members/${k.ID.dm2}`, k.T.admin, { role: 'player' });
  const dmId = k.ID.dm2;
  void dmId;
  // wendy is a player of world 2; make the world's DM someone else so DM-only events exist.
  await k.ok('PUT', `/api/admin/worlds/${k.W2}/members/${k.ID.dm}`, k.T.admin, { role: 'dm' });
  await k.ok('POST', k.w2('/clock/events'), k.T.dm, { title: 'ZQXDMONLYEVENT', start: 10, visibility: 'dm' });
  await settle();
  await tap.close();
  assert.ok(!tap.text.includes('ZQXDMONLYEVENT'), `a demoted DM still got a DM-only event: ${tap.text.slice(-300)}`);
});

test('Audit_Events: a signed-out session and a revoked key stop receiving events', async () => {
  const login = await k.ok('POST', '/api/auth/login', null, { username: 'jess', password: 'player pass 123' });
  const tap = new EventTap(k.base + EVENTS(), login.token);
  const key = await k.ok('POST', '/api/keys', k.T.jess, { scope: 'scribe', worldId: k.W, label: 'ev', access: 'read' });
  const tap2 = new EventTap(k.base + EVENTS(), key.key);
  await settle();
  await k.ok('POST', '/api/auth/logout', login.token);
  await k.ok('DELETE', `/api/keys/${key.id}`, k.T.jess);
  await k.ok('PUT', k.w('/live/presence'), k.T.dm, { location: 'ZQXAFTERLOGOUT' });
  await settle();
  await tap.close();
  await tap2.close();
  assert.ok(!tap.text.includes('ZQXAFTERLOGOUT'), 'a signed-out session still gets events');
  assert.ok(!tap2.text.includes('ZQXAFTERLOGOUT'), 'a revoked key still gets events');
});
