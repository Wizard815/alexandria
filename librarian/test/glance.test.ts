// At a glance (features/glance): the widget and phone-home read. A player sees
// their own HP, conditions, mana, session and quick events meant for them;
// the DM sees the turn and the queues. A widget key opens only this read.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { resolveToken } from '../src/core/auth.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
let W2 = '';

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const G = (w = W) => `/api/worlds/${w}/glance`;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-glance-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Glanceland', dmAccountId: ID.dm })).id;
  W2 = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Otherland', dmAccountId: ID.dm })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' });
  T.jess = j.token;
  ID.jess = j.account.id;
  const inv2 = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  const k = await ok('POST', '/api/join', undefined, { code: inv2.code, username: 'kip', password: 'player pass 456', characterName: 'Kip' });
  T.kip = k.token;
  ID.kip = k.account.id;
});
after(async () => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('Glance_quiet: no fight, no session, the date and the character name', async () => {
  const g = await ok('GET', G(), T.jess);
  assert.equal(g.role, 'player');
  assert.equal(g.name, 'Jess');
  assert.equal(g.world.name, 'Glanceland');
  assert.ok(typeof g.date === 'string' && g.date.length > 0);
  assert.equal(g.combat.active, false);
  assert.equal(g.combat.me, null);
  assert.equal(g.mana, null, 'mana is off by default');
  assert.equal(g.session.live, false);
  assert.deepEqual(g.quick, []);
  assert.ok('offers' in g.waiting && !('approvals' in g.waiting));
});

test('Glance_fight: a player sees their own HP and conditions, not anyone else', async () => {
  await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Jess', accountId: ID.jess, initiative: 15, hp: 23, maxHp: 40, tempHp: 5 });
  const kip = await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Kip', accountId: ID.kip, initiative: 12, hp: 9, maxHp: 30 });
  await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Lurker', initiative: 20, hp: 50, maxHp: 50, hidden: true });
  await ok('PATCH', `/api/worlds/${W}/live/combatants/${kip.id ?? kip.combatant?.id ?? ''}`, T.dm, { effects: [{ name: 'Poisoned', rounds: 3 }] }).catch(() => {});
  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { active: true, round: 2, turn: 0 });

  const g = await ok('GET', G(), T.jess);
  assert.equal(g.combat.active, true);
  assert.equal(g.combat.round, 2);
  assert.deepEqual({ hp: g.combat.me.hp, maxHp: g.combat.me.maxHp, tempHp: g.combat.me.tempHp }, { hp: 23, maxHp: 40, tempHp: 5 });
  assert.equal(g.combat.myTurn, false, 'the hidden foe goes first');
  assert.equal(g.combat.turnName, null, 'a hidden foe is never named to players');
  assert.ok(!JSON.stringify(g).includes('Lurker'));
  assert.ok(!JSON.stringify(g).includes('"hp":9'), "another player's HP is not in a player's glance");

  const d = await ok('GET', G(), T.dm);
  assert.equal(d.role, 'dm');
  assert.equal(d.combat.turnName, 'Lurker');
  assert.ok('approvals' in d.waiting && 'requests' in d.waiting);

  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { turn: 1 });
  const g2 = await ok('GET', G(), T.jess);
  assert.equal(g2.combat.myTurn, true);
  assert.equal(g2.combat.turnName, 'Jess');
  assert.equal(g2.session.live, true, 'a running fight counts as a live session');
  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { active: false });
});

test('Glance_mana: shown when the world uses mana', async () => {
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellMana: true });
  await ok('PUT', `/api/worlds/${W}/spells/characters/${ID.jess}`, T.jess, { level: 3, castingAbility: 'int', abilities: { int: 16 } });
  const g = await ok('GET', G(), T.jess);
  assert.ok(g.mana, 'mana is on');
  assert.equal(g.mana.max, 3 * 4 + 3, 'the default formula: level * 4 + mod');
  assert.equal(g.mana.now, g.mana.max, 'a full pool before any casting');
  const d = await ok('GET', G(), T.dm);
  assert.equal(d.mana, null, 'the DM has no pool of their own');
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellMana: false });
});

test('Glance_quick: open quick events reach only their audience', async () => {
  const ev = await ok('POST', `/api/worlds/${W}/quick-events`, T.dm, { kind: 'notice', title: 'Something moves', prompt: 'Roll Perception', audience: [ID.jess], timerS: 60 });
  const g = await ok('GET', G(), T.jess);
  assert.equal(g.quick.length, 1);
  assert.equal(g.quick[0].title, 'Something moves');
  assert.equal(g.quick[0].answered, false);
  assert.ok(!('dc' in g.quick[0]));
  const k = await ok('GET', G(), T.kip);
  assert.equal(k.quick.length, 0, 'Kip was not asked');
  const d = await ok('GET', G(), T.dm);
  assert.deepEqual({ answers: d.quick[0].answers, of: d.quick[0].of }, { answers: 0, of: 1 });
  await ok('POST', `/api/worlds/${W}/quick-events/${ev.id}/cancel`, T.dm).catch(() => {});
});

test('Glance_session: the next game night and my answer', async () => {
  const soon = new Date(Date.now() + 2 * 864e5).toISOString();
  const end = new Date(Date.now() + 2 * 864e5 + 4 * 36e5).toISOString();
  deps.db.prepare(`INSERT INTO cal_sessions (id, world_id, title, starts_at, ends_at, location, status, updated_at) VALUES ('cs_glance', ?, 'Into the Crypt', ?, ?, 'Kitchen', 'scheduled', ?)`).run(W, soon, end, soon);
  deps.db.prepare(`INSERT INTO cal_rsvps (session_id, account_id, answer, at) VALUES ('cs_glance', ?, 'yes', ?)`).run(ID.jess, soon);
  const g = await ok('GET', G(), T.jess);
  assert.equal(g.next.title, 'Into the Crypt');
  assert.equal(g.next.rsvp, 'yes');
  assert.equal(g.next.going, 1);
  assert.equal(g.next.happening, false);
  const k = await ok('GET', G(), T.kip);
  assert.equal(k.next.rsvp, null);
});

test('Glance_widgetKey: opens only GET glance for its own world', async () => {
  const made = await call('POST', `${G()}/link`, T.jess);
  assert.equal(made.status, 201);
  const key: string = made.body.key;
  assert.ok(key.startsWith('alx_wdg_'));
  assert.equal(made.body.world, (await ok('GET', `/api/worlds/${W}`, T.jess)).slug);

  const g = await call('GET', G(), key);
  assert.equal(g.status, 200);
  assert.equal(g.body.name, 'Jess');
  assert.equal((await call('GET', `${G()}?x=1`, key)).status, 200);

  // Nothing else: other routes, other methods, other worlds, the MCP server.
  for (const p of ['/live', '/library', '/members', '/settings', '/glance/link', '/spells/characters/' + ID.jess]) {
    assert.equal((await call('GET', `/api/worlds/${W}${p}`, key)).status, 401, p);
  }
  assert.equal((await call('POST', `${G()}/link`, key)).status, 401);
  assert.equal((await call('GET', '/api/worlds', key)).status, 401);
  assert.equal((await call('GET', '/api/me', key)).status, 401);
  assert.equal((await call('GET', G(W2), key)).status, 403);
  assert.equal(resolveToken(deps.db, key), null, 'other consumers (MCP, /v1) never accept it');
  assert.equal((await call('POST', '/mcp', key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status >= 400, true);
});

test('Glance_widgetLink: only from a signed-in session, and old widget keys retire', async () => {
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'guest' });
  const guest = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'gwen', password: 'guest pass 789' });
  assert.equal((await call('POST', `${G()}/link`, guest.token)).status, 403, 'a guest makes no widget key');
  assert.equal((await call('GET', G(), guest.token)).status, 200, 'but may read the glance in the app');
  const scribe = await ok('POST', '/api/keys', T.jess, { scope: 'scribe', label: 'mcp', worldId: W });
  assert.equal((await call('POST', `${G()}/link`, scribe.key)).status, 403);
  const keys: string[] = [];
  for (let i = 0; i < 6; i++) keys.push((await ok('POST', `${G()}/link`, T.kip)).key);
  const live = await Promise.all(keys.map(async (k) => (await call('GET', G(), k)).status));
  assert.deepEqual(live, [401, 401, 200, 200, 200, 200], 'the newest four keep working');
  const listed = (await ok('GET', '/api/keys', T.kip)).filter((k: any) => !k.revoked && k.prefix.startsWith('alx_wdg_'));
  assert.equal(listed.length, 4);
  assert.ok(listed.every((k: any) => k.label === 'Home-screen widget' && k.access === 'read'), 'listed, so it can be revoked like any key');
});

test('Glance_alerts: each person gets their own alerts, with stable ids', async () => {
  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { active: true, round: 4, turn: 1 });
  const ev = await ok('POST', `/api/worlds/${W}/quick-events`, T.dm, { kind: 'notice', title: 'A noise upstairs', prompt: 'Roll Perception', audience: [ID.kip], timerS: 60 });
  const soon = new Date(Date.now() + 30 * 60000).toISOString();
  deps.db.prepare(`INSERT INTO cal_sessions (id, world_id, title, starts_at, ends_at, location, status, updated_at) VALUES ('cs_alert', ?, 'Session 9', ?, ?, 'Kitchen', 'scheduled', ?)`).run(W, soon, new Date(Date.now() + 5 * 36e5).toISOString(), soon);
  const ids = (g: any) => g.alerts.map((a: any) => a.kind);

  const j = await ok('GET', G(), T.jess);
  assert.ok(ids(j).includes('turn'), 'Jess: her turn');
  assert.ok(!ids(j).includes('quick'), 'Jess was not asked');
  assert.ok(ids(j).includes('night'), 'game night within the hour');
  const turn = j.alerts.find((a: any) => a.kind === 'turn');
  assert.equal(turn.path, `/w/${j.world.slug}/live`);
  assert.equal((await ok('GET', G(), T.jess)).alerts.find((a: any) => a.kind === 'turn').id, turn.id, 'the same id each time');

  const k = await ok('GET', G(), T.kip);
  assert.ok(!ids(k).includes('turn'), 'not Kip\'s turn');
  assert.ok(k.alerts.some((a: any) => a.id === `quick:${ev.id}`), 'Kip: the quick event for him');

  const d = await ok('GET', G(), T.dm);
  assert.ok(!ids(d).includes('quick') && !ids(d).includes('turn'));
  assert.ok(d.alerts.find((a: any) => a.kind === 'night').path.includes('/dm/calendar'));
  // A widget key reads the alerts too (the Android background check uses it).
  const key = (await ok('POST', `${G()}/link`, T.jess)).key;
  assert.ok((await ok('GET', G(), key)).alerts.some((a: any) => a.kind === 'turn'));

  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { active: false });
  await ok('POST', `/api/worlds/${W}/quick-events/${ev.id}/cancel`, T.dm).catch(() => {});
  deps.db.prepare(`DELETE FROM cal_sessions WHERE id = 'cs_alert'`).run();
});

test('Glance_answer: a widget key answers a quick event from a notification, and nothing more', async () => {
  const roll = await ok('POST', `/api/worlds/${W}/quick-events`, T.dm, { kind: 'notice', title: 'Listen', prompt: 'Roll Perception', audience: [ID.jess], timerS: 120 });
  const vote = await ok('POST', `/api/worlds/${W}/quick-events`, T.dm, { kind: 'vote', title: 'Which way?', prompt: 'Pick', options: ['North', 'South'], audience: 'party', timerS: 120 });
  const key = (await ok('POST', `${G()}/link`, T.jess)).key;
  const g = await ok('GET', G(), key);
  const a = g.alerts.find((x: any) => x.id === `quick:${roll.id}`);
  assert.deepEqual(a.actions, [{ id: 'roll', label: 'Roll for me' }]);
  assert.deepEqual(g.alerts.find((x: any) => x.id === `quick:${vote.id}`).actions.map((x: any) => x.label), ['North', 'South']);

  assert.equal((await call('POST', `${G()}/answer/${roll.id}`, key, { action: 'roll' })).status, 200);
  assert.equal((await call('POST', `${G()}/answer/${vote.id}`, key, { action: 'choice:1' })).status, 200);
  const dmView = await ok('GET', `/api/worlds/${W}/quick-events`, T.dm);
  const list = Array.isArray(dmView) ? dmView : dmView.events ?? dmView.items ?? [];
  const r1 = list.find((e: any) => e.id === roll.id).responses.find((x: any) => x.account_id === ID.jess);
  assert.ok(r1.roll >= 1 && r1.roll <= 20, 'rolled a d20');
  assert.equal(list.find((e: any) => e.id === vote.id).responses.find((x: any) => x.account_id === ID.jess).choice, 1);
  assert.ok(!(await ok('GET', G(), key)).alerts.some((x: any) => x.id === `quick:${roll.id}`), 'answered: the alert is gone');

  assert.equal((await call('POST', `${G()}/answer/${vote.id}`, key, { action: 'choice:9' })).status, 400);
  assert.equal((await call('POST', `${G()}/answer/${vote.id}`, key, { action: 'drop tables' })).status, 400);
  assert.equal((await call('POST', `/api/worlds/${W}/quick-events/${vote.id}/respond`, key, { choice: 0 })).status, 401, 'the normal route still refuses a widget key');
  assert.equal((await call('POST', `${G()}/link`, key)).status, 401);
  assert.equal((await call('POST', `/api/worlds/${W2}/glance/answer/${vote.id}`, key, { action: 'choice:0' })).status, 403, 'not in another world');
  const kipVote = await call('POST', `${G()}/answer/${roll.id}`, (await ok('POST', `${G()}/link`, T.kip)).key, { action: 'roll' });
  assert.equal(kipVote.status, 404, 'Kip was not asked');
  for (const e of [roll, vote]) await ok('POST', `/api/worlds/${W}/quick-events/${e.id}/cancel`, T.dm).catch(() => {});
});
