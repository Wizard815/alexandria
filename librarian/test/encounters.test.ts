// NPC encounters: the DM sends a talk to one player, the player answers in
// their app, options give coin, items or a shop, small games run on the
// server, the reward cap, the DM speaking live, wandering, and what other
// players and guests never see.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, run } from '../src/core/db.ts';
import { balance } from '../src/core/coin.ts';
import { STARTERS, parseScript, play } from '../src/features/encounters/index.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const P = () => `/api/worlds/${W}/encounters`;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const set = (patch: Record<string, unknown>) => ok('PATCH', `/api/worlds/${W}/settings`, T.dm, patch);
const setCoin = (owner: string, cp: number) => { run(deps.db, 'DELETE FROM ledger WHERE world_id = ? AND owner = ?', W, owner); if (cp) run(deps.db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, 'Test', ?, ?, 'approved')`, `led_t${Math.random()}`, W, owner, cp, ID.dm, new Date().toISOString()); };
const coin = (owner: string) => balance(deps.db, W, owner);
const invQty = (owner: string, name: string) => all<any>(deps.db, `SELECT qty FROM items WHERE world_id = ? AND owner = ? AND name = ? AND status = 'approved'`, W, owner, name).reduce((n, x) => n + x.qty, 0);
const send = (body: Record<string, unknown>) => ok('POST', P(), T.dm, body);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-enc-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Streetland', dmAccountId: ID.dm })).id;
  for (const [u, c] of [['jess', 'Jess'], ['tom', 'Tom']]) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: u, password: 'player pass 123', characterName: c });
    T[u] = j.token; ID[u] = j.account.id;
  }
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'guest' });
  T.guest = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'visitor', password: 'guest pass 1234', characterName: 'Visitor' })).token;
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('TestEncounters_StartersAreValidScripts', () => {
  assert.ok(STARTERS.length >= 5);
  for (const s of STARTERS) assert.doesNotThrow(() => parseScript(s.script), s.id);
});

test('TestEncounters_ParseScriptRejectsBrokenLinks', () => {
  assert.throws(() => parseScript({ nodes: [{ id: 'a', text: 'Hi', options: [{ label: 'Go', next: 'nowhere' }] }] }), /not a node/);
  assert.throws(() => parseScript({ nodes: [{ id: 'a', text: 'Hi' }, { id: 'a', text: 'Again' }] }), /Two nodes/);
  assert.throws(() => parseScript({ nodes: [{ id: 'a', text: 'Hi', game: { kind: 'coin', win: 'a', lose: 'b' } }] }), /not a node/);
  assert.throws(() => parseScript({ nodes: [{ id: 'a', text: 'Hi', options: [{ label: 'x', effects: [{ kind: 'gold', cp: -5 }] }] }] }), /cp/);
  assert.throws(() => parseScript({ nodes: [] }), /at least one/);
});

test('TestEncounters_GamesFollowTheDice', () => {
  const g = { stakeCp: 0, winCp: 0, dc: null, skill: null, win: 'w', lose: 'l' };
  assert.equal(play({ ...g, kind: 'coin' }, { pick: 0 }, () => 1).won, true);
  assert.equal(play({ ...g, kind: 'coin' }, { pick: 1 }, () => 1).won, false);
  assert.equal(play({ ...g, kind: 'shells' }, { pick: 2 }, () => 3).won, true);
  assert.throws(() => play({ ...g, kind: 'shells' }, {}, () => 1), /Pick a shell/);
  // Dice ties go to the house.
  assert.equal(play({ ...g, kind: 'dice' }, {}, () => 4).won, false);
  const r = play({ ...g, kind: 'check', dc: 13, skill: 'Athletics' }, { roll: 10, modifier: 3 });
  assert.equal(r.won, true);
  assert.equal(r.total, 13);
  assert.equal(play({ ...g, kind: 'check', dc: 13 }, { roll: 9, modifier: 3 }).won, false);
});

test('TestEncounters_QuickTalkReachesOnlyThatPlayer', async () => {
  const [e] = await send({ accountIds: [ID.jess], npcName: 'Old Bess', line: 'Spare a moment, dearie?', answers: ['Of course', 'Sorry, busy'] });
  assert.equal(e.player, 'Jess');
  const mine = await ok('GET', P(), T.jess);
  const v = mine.find((x: any) => x.id === e.id);
  assert.equal(v.text, 'Spare a moment, dearie?');
  assert.deepEqual(v.options, [{ label: 'Of course' }, { label: 'Sorry, busy' }]);
  assert.equal(v.script, undefined, 'players never get the script');
  assert.equal(v.dc, undefined);
  assert.equal((await ok('GET', P(), T.tom)).some((x: any) => x.id === e.id), false);
  assert.equal((await call('GET', `${P()}/${e.id}`, T.tom)).status, 404);
  assert.equal((await call('POST', `${P()}/${e.id}/choose`, T.tom, { option: 0 })).status, 404);
  assert.equal((await call('GET', P(), T.guest)).status, 403);
  assert.equal((await call('POST', P(), T.jess, { accountIds: [ID.tom], line: 'Hi' })).status, 403);

  const done = await ok('POST', `${P()}/${e.id}/choose`, T.jess, { option: 1 });
  assert.equal(done.status, 'done');
  assert.equal(done.log.at(-1).text, 'Sorry, busy');
  assert.equal((await call('POST', `${P()}/${e.id}/choose`, T.jess, { option: 0 })).status, 409);
  const dm = await ok('GET', `${P()}/${e.id}`, T.dm);
  assert.equal(dm.log.at(-1).who, 'you');
});

test('TestEncounters_GiftsPayCoinAndItemsUpToTheCap', async () => {
  setCoin(ID.jess, 0);
  await set({ encounterRewardCapCp: 30 });
  const script = { start: 'hi', nodes: [
    { id: 'hi', text: 'Take this.', options: [{ label: 'Thanks', next: 'again', effects: [{ kind: 'gold', cp: 20 }, { kind: 'item', name: 'Lucky pebble', qty: 2 }] }] },
    { id: 'again', text: 'And more?', options: [{ label: 'More!', next: 'again', effects: [{ kind: 'gold', cp: 20 }] }, { label: 'Bye', next: null }] },
  ] };
  const [e] = await send({ accountIds: [ID.jess], npcName: 'Generous Gil', script });
  let v = await ok('POST', `${P()}/${e.id}/choose`, T.jess, { option: 0 });
  assert.equal(coin(ID.jess), 20);
  assert.equal(invQty(ID.jess, 'Lucky pebble'), 2);
  v = await ok('POST', `${P()}/${e.id}/choose`, T.jess, { option: 0 });
  v = await ok('POST', `${P()}/${e.id}/choose`, T.jess, { option: 0 });
  assert.equal(coin(ID.jess), 30, 'the cap stops a loop farming coin');
  assert.match(v.log.at(-2).text, /nothing more to give/);
  await set({ encounterRewardCapCp: 1000 });
});

test('TestEncounters_StakedSkillCheckWinsAndLoses', async () => {
  const script = { start: 'go', nodes: [
    { id: 'go', text: 'Arm-wrestle?', options: [{ label: 'No', next: null }], game: { kind: 'check', dc: 15, skill: 'Athletics', stakeCp: 10, winCp: 25, win: 'won', lose: 'lost' } },
    { id: 'won', text: 'You win.', options: [{ label: 'Again', next: 'go' }] },
    { id: 'lost', text: 'You lose.', options: [{ label: 'Again', next: 'go' }] },
  ] };
  setCoin(ID.tom, 5);
  const [e] = await send({ accountIds: [ID.tom], npcName: 'Hollis', script });
  const p = await ok('GET', `${P()}/${e.id}`, T.tom);
  assert.deepEqual(p.game, { kind: 'check', label: 'Skill check', stakeCp: 10, winCp: 25, skill: 'Athletics' });
  assert.equal(p.dc, undefined, 'the DC stays with the DM');
  assert.equal((await call('POST', `${P()}/${e.id}/choose`, T.tom, { play: true, roll: 20 })).status, 409, 'cannot cover the stake');
  setCoin(ID.tom, 100);
  let v = await ok('POST', `${P()}/${e.id}/choose`, T.tom, { play: true, roll: 2, modifier: 1 });
  assert.equal(v.text, 'You lose.');
  assert.equal(coin(ID.tom), 90);
  v = await ok('POST', `${P()}/${e.id}/choose`, T.tom, { option: 0 });
  v = await ok('POST', `${P()}/${e.id}/choose`, T.tom, { play: true, roll: 18 });
  assert.equal(v.text, 'You win.');
  assert.equal(coin(ID.tom), 115);
  // The game node's own option walks away.
  v = await ok('POST', `${P()}/${e.id}/choose`, T.tom, { option: 0 });
  v = await ok('POST', `${P()}/${e.id}/choose`, T.tom, { option: 0 });
  assert.equal(v.status, 'done');
});

test('TestEncounters_ShopOptionOpensOnlyAnOpenShop', async () => {
  const at = new Date().toISOString();
  run(deps.db, `INSERT INTO shops (id, world_id, name, status, created_at, updated_at) VALUES ('shp_hidden', ?, 'Secret Stall', 'hidden', ?, ?)`, W, at, at);
  const [a] = await send({ accountIds: [ID.jess], templateId: 'builtin:peddler', shopId: 'shp_hidden' });
  let v = await ok('POST', `${P()}/${a.id}/choose`, T.jess, { option: 0 });
  assert.equal(v.shop, null);
  assert.match(v.log.at(-1).text, /nothing to sell/);

  run(deps.db, `INSERT INTO shops (id, world_id, name, status, created_at, updated_at) VALUES ('shp_open', ?, 'Quill''s Pack', 'open', ?, ?)`, W, at, at);
  const [b] = await send({ accountIds: [ID.jess], templateId: 'builtin:peddler', shopId: 'shp_open' });
  v = await ok('POST', `${P()}/${b.id}/choose`, T.jess, { option: 0 });
  assert.deepEqual(v.shop, { id: 'shp_open', name: "Quill's Pack" });
  assert.equal((await call('POST', P(), T.dm, { accountIds: [ID.jess], templateId: 'builtin:peddler', shopId: 'shp_nope' })).status, 400);
});

test('TestEncounters_DmSpeaksLiveAndANewTalkReplacesTheOld', async () => {
  const [a] = await send({ accountIds: [ID.jess], npcName: 'Guard', line: 'Halt!', answers: ['Why?'] });
  const said = await ok('POST', `${P()}/${a.id}/say`, T.dm, { text: 'Papers, please.', answers: ['Here', 'Run'] });
  assert.equal(said.text, 'Papers, please.');
  const v = await ok('GET', `${P()}/${a.id}`, T.jess);
  assert.deepEqual(v.options.map((o: any) => o.label), ['Here', 'Run']);
  assert.equal(v.log.at(-1).who, 'dm');
  assert.equal((await call('POST', `${P()}/${a.id}/say`, T.jess, { text: 'x' })).status, 403);

  const [b] = await send({ accountIds: [ID.jess], npcName: 'Beggar', line: 'Alms?' });
  assert.equal((await ok('GET', `${P()}/${a.id}`, T.jess)).status, 'cancelled', 'one NPC at a time');
  const bv = await ok('GET', `${P()}/${b.id}`, T.jess);
  assert.deepEqual(bv.options, [{ label: 'Farewell' }]);
  const ended = await ok('POST', `${P()}/${b.id}/end`, T.dm);
  assert.equal(ended.status, 'cancelled');
});

test('TestEncounters_WanderingNeedsTheSettingAndWaits', async () => {
  assert.equal((await call('POST', `${P()}/wander`, T.tom)).status, 403);
  await set({ encounterWander: true, encounterWanderMinutes: 30 });
  const cfg = await ok('GET', `${P()}/config`, T.tom);
  assert.equal(cfg.wander, true);
  assert.equal(cfg.nextWanderAt, null);
  const e = await ok('POST', `${P()}/wander`, T.tom);
  assert.equal(e.source, 'wander');
  assert.ok(STARTERS.some((s) => s.npcName === e.npc.name), 'with no saved wander encounters the starters are the pool');
  assert.equal((await call('POST', `${P()}/wander`, T.tom)).status, 409, 'finish the open talk first');
  await ok('POST', `${P()}/${e.id}/leave`, T.tom);
  assert.equal((await call('POST', `${P()}/wander`, T.tom)).status, 429, 'cooldown');
  assert.ok((await ok('GET', `${P()}/config`, T.tom)).nextWanderAt);

  // A saved wander encounter replaces the starters as the pool.
  await ok('POST', `${P()}/templates/all`, T.dm, { name: 'Fishwife', npcName: 'Nell', wander: true, script: { nodes: [{ id: 's', text: 'Fresh fish!' }] } });
  await set({ encounterWanderMinutes: 0 });
  const f = await ok('POST', `${P()}/wander`, T.jess);
  assert.equal(f.npc.name, 'Nell');
});

test('TestEncounters_TemplatesAreDmOnly', async () => {
  assert.equal((await call('GET', `${P()}/templates/all`, T.jess)).status, 403);
  const t = await ok('POST', `${P()}/templates/all`, T.dm, { name: 'Riddler', npcName: 'Sphinx', script: { nodes: [{ id: 'q', text: 'What walks on four legs…?', options: [{ label: 'A person', next: 'r', effects: [{ kind: 'gold', cp: 5 }] }, { label: 'A dog', next: null }] }, { id: 'r', text: 'Correct.' }] } });
  const list = await ok('GET', `${P()}/templates/all`, T.dm);
  assert.ok(list.templates.some((x: any) => x.id === t.id));
  assert.ok(list.starters.length >= 5);
  await ok('PUT', `${P()}/templates/all/${t.id}`, T.dm, { ...t, name: 'The Riddler' });
  assert.equal((await call('POST', `${P()}/templates/all`, T.dm, { name: 'Bad', npcName: 'x', script: { nodes: [{ id: 'a', text: 'x', options: [{ label: 'y', next: 'zz' }] }] } })).status, 400);
  const [e] = await send({ accountIds: 'party', templateId: t.id });
  assert.equal(e.templateName, 'The Riddler');
  await ok('DELETE', `${P()}/templates/all/${t.id}`, T.dm);
  assert.equal((await call('DELETE', `${P()}/templates/all/${t.id}`, T.dm)).status, 404);
});
