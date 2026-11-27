// ?view=players: the GM's table screen is seen by the players, so a GM who asks for the players' copy gets exactly that.
// Combat (no hidden foes, AC, temp HP, concentration, exact monster HP), map marks (no GM, "only me" or hidden marks) and
// the map pictures on offer (no GM-level files).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';

let base = '';
let server: any;
let tmp = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';

async function call(method: string, url: string, token?: string, body?: unknown, raw?: Buffer) {
  const r = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : raw ? { 'Content-Type': 'application/octet-stream' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const t = await r.text();
  let json: any = null;
  try { json = JSON.parse(t); } catch { json = null; }
  return { status: r.status, body: json };
}
const ok = async (method: string, url: string, token?: string, body?: unknown, raw?: Buffer) => {
  const r = await call(method, url, token, body, raw);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const PNG = (x: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`pad ${x} pad`)]);
const api = (p: string) => `/api/worlds/${W}${p}`;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-screens-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Screenland', dmAccountId: ID.dm })).id;
  const inv = await ok('POST', api('/invites'), T.dm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' });
  T.jess = j.token;
  ID.jess = j.account.id;
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('TestScreens_PlayersViewOfCombatDropsDMOnlyFields', async () => {
  await ok('POST', api('/live/combatants'), T.dm, { name: 'Jess the Bold', accountId: ID.jess, initiative: 15, hp: 20, maxHp: 20 });
  const gob = await ok('POST', api('/live/combatants'), T.dm, { name: 'Goblin', initiative: 12, hp: 4, maxHp: 10, ac: 15, tempHp: 3, concentration: 'Bless' });
  await ok('POST', api('/live/combatants'), T.dm, { name: 'Ambusher in the Dark', initiative: 18, hp: 30, maxHp: 30, hidden: true, ac: 17 });
  await ok('PUT', api('/live/combat'), T.dm, { active: true, round: 1, turn: 0 });

  // Control: the GM's own view has the secrets, so the test would notice if the fixture stopped having any.
  const full = JSON.stringify(await ok('GET', api('/live/combat'), T.dm));
  assert.ok(full.includes('Ambusher in the Dark') && full.includes('"ac":17') && full.includes('Bless'), 'the GM view has the GM-only facts');

  const table = await ok('GET', api('/live/combat?view=players'), T.dm);
  const s = JSON.stringify(table);
  for (const secret of ['Ambusher', '"ac"', 'temp_hp', 'concentration', 'Bless', '"hp"', 'max_hp', 'death_saves', 'statblock', 'account_id']) assert.ok(!s.includes(secret), `table view leaked ${secret}: ${s}`);
  assert.deepEqual(table.combatants.map((c: any) => c.name), ['Jess the Bold', 'Goblin']);
  assert.equal(table.combatants.find((c: any) => c.id === gob.id).health, 'Bloodied', 'monster health follows the world setting (words)');
  assert.ok(table.combatants.every((c: any) => c.mine === false), 'the GM is nobody\'s character on this screen');

  // It is the same as what a player is served (apart from whose turn it is "for me"), and a player cannot ask for more.
  const jess = await ok('GET', api('/live/combat'), T.jess);
  assert.deepEqual(table.combatants.map((c: any) => ({ ...c, mine: false })), jess.combatants.map((c: any) => ({ ...c, mine: false })));
  assert.deepEqual(await ok('GET', api('/live/combat?view=dm'), T.jess), jess);
  assert.equal(JSON.stringify(await ok('GET', api('/live/combat?view=players'), T.jess)), JSON.stringify(jess));

  // A world that shows nothing of monster health shows nothing on the table either.
  await ok('PATCH', api('/settings'), T.dm, { monsterHealth: 'none' });
  const none = JSON.stringify(await ok('GET', api('/live/combat?view=players'), T.dm));
  assert.ok(!none.includes('Bloodied') && !none.includes('health":"'), none);
  await ok('PATCH', api('/settings'), T.dm, { initiativeVisible: false });
  const hidden = await ok('GET', api('/live/combat?view=players'), T.dm);
  assert.equal(hidden.combatants, undefined, 'a world that hides the order hides it on the table too');
});

test('TestScreens_PlayersViewOfMapMarksDropsDMOnlyMarks', async () => {
  const add = (b: Record<string, unknown>, tok = T.dm) => ok('POST', api('/map/table/marks'), tok, { kind: 'pin', x: 10, y: 10, ...b });
  const shown = await add({ label: 'Party pin', visibility: 'party' });
  await add({ label: 'GM secret door', visibility: 'dm' });
  await add({ label: 'GM private note', visibility: 'me' });
  const gone = await add({ label: 'Hidden later', visibility: 'party' });
  await ok('PATCH', api(`/map/table/marks/${gone.id}`), T.dm, { hidden: true });
  await add({ label: 'Jess private', visibility: 'me' }, T.jess);

  const labels = (x: any[]) => x.map((m) => m.data.label).sort();
  assert.deepEqual(labels(await ok('GET', api('/map/table/marks'), T.dm)), ['GM private note', 'GM secret door', 'Hidden later', 'Party pin'], 'control: the GM sees GM marks and hidden marks (not a player\'s only-me)');
  const table = await ok('GET', api('/map/table/marks?view=players'), T.dm);
  assert.deepEqual(labels(table), ['Party pin']);
  assert.equal(table[0].id, shown.id);
  assert.ok(!JSON.stringify(table).includes('GM '), 'no GM text anywhere');
  assert.deepEqual(labels(await ok('GET', api('/map/table/marks?view=players'), T.jess)), ['Jess private', 'Party pin'], 'a player still sees their own marks, and cannot widen with the option');
});

test('TestScreens_PlayersViewOfMapPicturesDropsDMFiles', async () => {
  await ok('POST', api('/files?folder=Maps&title=Open%20Map&name=open.png&kind=map&level=party'), T.dm, undefined, PNG('open'));
  await ok('POST', api('/files?folder=Maps&title=Secret%20Map&name=secret.png&kind=map&level=dm'), T.dm, undefined, PNG('secret'));
  const names = (x: any[]) => x.map((f) => f.name).sort();
  assert.deepEqual(names(await ok('GET', api('/files/maps'), T.dm)), ['open.png', 'secret.png'], 'control: the GM is offered both');
  const table = await ok('GET', api('/files/maps?view=players'), T.dm);
  assert.deepEqual(names(table), ['open.png']);
  assert.ok(table.every((f: any) => f.level === undefined), 'no GM-only detail (level, remote) on the player copy');
  assert.deepEqual(names(await ok('GET', api('/files/maps?view=players'), T.jess)), ['open.png']);
  // The picture address it hands out loads for the GM's login (it is a ticket for a listed file).
  const img = await fetch(base + table[0].url);
  assert.equal(img.status, 200);
});
