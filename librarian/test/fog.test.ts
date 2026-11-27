// Fog of war: off by default, GM-only writes, state round-trips (and compacts), and marks under fog never reach a player or
// the table screen's ?view=players. Also the table display (which map picture the table screen shows).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { compact, isFogged, type FogState } from '../src/core/fog.ts';

let base = '';
let server: any;
let tmp = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let json: any = null;
  try { json = JSON.parse(t); } catch { json = null; }
  return { status: r.status, body: json };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const api = (p: string) => `/api/worlds/${W}${p}`;
const PIC = 'lib:lf_cave';

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-fog-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.gm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'gm password 123' })).account.id;
  T.gm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'gm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Fogland', gmAccountId: ID.gm })).id;
  const inv = await ok('POST', api('/invites'), T.gm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' });
  T.jess = j.token;
  ID.jess = j.account.id;
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const fog = (p = '') => api(`/fog/map/world${p}`);

test('TestFog_OffByDefaultAndMarksUnchanged', async () => {
  const s = await ok('GET', `${fog()}?pic=${PIC}`, T.jess);
  assert.equal(s.enabled, false);
  await ok('POST', api('/map/world/marks'), T.gm, { kind: 'pin', x: 10, y: 10, label: 'Plain pin', visibility: 'party' });
  for (const [tok, q] of [[T.jess, ''], [T.gm, '?view=players'], [T.gm, '']] as const) {
    const marks = await ok('GET', api(`/map/world/marks${q}`), tok);
    assert.ok(marks.some((m: any) => m.data.label === 'Plain pin'), `fog off: the pin is there for ${q || 'plain'}`);
  }
});

test('TestFog_WritesAreGMOnly', async () => {
  for (const [m, p, b] of [
    ['PUT', '/enabled', { pic: PIC, enabled: true }],
    ['POST', '/ops', { pic: PIC, op: { k: 'all', v: 1 } }],
    ['POST', '/undo', { pic: PIC }],
    ['PUT', '/state', { pic: PIC, enabled: true, ops: [] }],
  ] as const) {
    const r = await call(m, fog(p), T.jess, b);
    assert.equal(r.status, 403, `${m} ${p} -> ${r.status}`);
  }
  assert.equal((await call('PUT', api('/fog/table'), T.jess, { pic: PIC })).status, 403);
  assert.equal((await ok('GET', `${fog()}?pic=${PIC}`, T.gm)).enabled, false, 'nothing changed');
});

test('TestFog_StateRoundTripsAndStartsFogged', async () => {
  const on = await ok('PUT', fog('/enabled'), T.gm, { pic: PIC, enabled: true });
  assert.deepEqual([on.enabled, on.base, on.ops], [true, null, []], 'starts fully fogged');
  await ok('POST', fog('/ops'), T.gm, { pic: PIC, op: { k: 'c', x: 0.25, y: 0.5, r: 0.1, v: 1 } });
  await ok('POST', fog('/ops'), T.gm, { pic: PIC, op: { k: 'r', x: 0.6, y: 0.6, w: 0.2, h: 0.2, v: 1 } });
  const seen = await ok('GET', `${fog()}?pic=${PIC}`, T.jess);
  assert.equal(seen.ops.length, 2);
  assert.ok(isFogged(seen, 0.9, 0.1) && !isFogged(seen, 0.25, 0.5) && !isFogged(seen, 0.7, 0.7));
  const undone = await ok('POST', fog('/undo'), T.gm, { pic: PIC });
  assert.equal(undone.ops.length, 1);
  assert.ok(isFogged(undone, 0.7, 0.7), 'the rectangle is covered again');
  const bad = await call('POST', fog('/ops'), T.gm, { pic: PIC, op: { k: 'c', x: 4, y: 0, r: 0.1 } });
  assert.equal(bad.status, 400);
  // Another picture of the same map is its own layer, still off.
  assert.equal((await ok('GET', `${fog()}?pic=lib:other`, T.jess)).enabled, false);
  // Restore a saved state exactly.
  const put = await ok('PUT', fog('/state'), T.gm, { pic: 'lib:other', enabled: true, ops: [{ k: 'all', v: 1 }] });
  assert.deepEqual(put.ops, [{ k: 'all', v: 1 }]);
  await ok('PUT', fog('/enabled'), T.gm, { pic: 'lib:other', enabled: false });
  assert.equal((await ok('GET', `${fog()}?pic=lib:other`, T.jess)).ops.length, 1, 'turning it off keeps the strokes');
});

test('TestFog_CompactsLongStrokeLists', () => {
  const ops = Array.from({ length: 300 }, (_, i) => ({ k: 'c' as const, x: (i % 50) / 50 + 0.01, y: 0.5, r: 0.03, v: 1 as const }));
  const s: FogState = { enabled: true, base: null, ops };
  const c = compact(s);
  assert.ok(c.ops.length < 100 && c.base, 'old strokes became a bitmask');
  for (const [x, y] of [[0.01, 0.5], [0.5, 0.5], [0.5, 0.9], [0.99, 0.1], [0.3, 0.5]]) assert.equal(isFogged(c, x, y), isFogged(s, x, y), `same answer at ${x},${y}`);
});

test('TestFog_MarksUnderFogNeverReachPlayers', async () => {
  // Fog on for PIC: only the circle around (25, 50) is open. A party pin at 80,20 is under fog; one at 25,50 is not.
  const open = (await ok('POST', api('/map/world/marks'), T.gm, { kind: 'pin', x: 25, y: 50, label: 'Open pin', visibility: 'party' })).id;
  const hidden = (await ok('POST', api('/map/world/marks'), T.gm, { kind: 'pin', x: 80, y: 20, label: 'Fogged pin', visibility: 'party' })).id;
  const route = (await ok('POST', api('/map/world/marks'), T.gm, { kind: 'route', points: [{ x: 25, y: 50 }, { x: 90, y: 90 }], visibility: 'party' })).id;
  const gmOnly = (await ok('POST', api('/map/world/marks'), T.gm, { kind: 'pin', x: 80, y: 20, label: 'GM secret', visibility: 'gm' })).id;
  const mine = (await ok('POST', api('/map/world/marks'), T.jess, { kind: 'pin', x: 85, y: 25, label: 'Jess in fog', visibility: 'me' })).id;

  const ids = async (tok: string, q = '') => (await ok('GET', api(`/map/world/marks${q}`), tok)).map((m: any) => m.id);
  const gmAll = await ids(T.gm);
  for (const m of [open, hidden, route, gmOnly]) assert.ok(gmAll.includes(m), 'the GM sees every mark it may');
  for (const [who, tok, q] of [['player', T.jess, ''], ['table (view=players)', T.gm, '?view=players']] as const) {
    const got = await ids(tok, q);
    assert.ok(got.includes(open), `${who} sees the pin in the open`);
    for (const [name, m] of [['fogged pin', hidden], ['route into fog', route]] as const) assert.ok(!got.includes(m), `${who} never gets the ${name}`);
  }
  const text = JSON.stringify(await ok('GET', api('/map/world/marks?view=players'), T.gm)) + JSON.stringify(await ok('GET', api('/map/world/marks'), T.jess));
  assert.ok(!text.includes('Fogged pin') && !text.includes('GM secret') && !text.includes('Jess in fog'), 'no label of a fogged mark appears');
  assert.ok(!(await ids(T.jess)).includes(mine), 'even a player\'s own mark under fog is not served back');

  // Uncovering the area brings the mark back; covering again takes it away.
  await ok('POST', fog('/ops'), T.gm, { pic: PIC, op: { k: 'all', v: 1 } });
  assert.ok((await ids(T.jess)).includes(hidden));
  await ok('POST', fog('/ops'), T.gm, { pic: PIC, op: { k: 'all', v: 0 } });
  assert.ok(!(await ids(T.jess)).includes(hidden));
  // Fog off: everything party-visible is back.
  await ok('PUT', fog('/enabled'), T.gm, { pic: PIC, enabled: false });
  assert.ok((await ids(T.jess)).includes(hidden) && (await ids(T.gm, '?view=players')).includes(route));
  await ok('PUT', fog('/enabled'), T.gm, { pic: PIC, enabled: true });
});

test('TestFog_LiveEventsCarryNoMarks', async () => {
  const r = await fetch(base + api('/events'), { headers: { Authorization: `Bearer ${T.jess}` } });
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const wait = async (re: RegExp, ms = 4000) => { const t0 = Date.now(); while (!re.test(buf) && Date.now() - t0 < ms) { const x = await Promise.race([reader.read(), new Promise<null>((s) => setTimeout(() => s(null), 500))]); if (x && x.value) buf += dec.decode(x.value); } return re.test(buf); };
  await wait(/connected/);
  await ok('POST', fog('/ops'), T.gm, { pic: PIC, op: { k: 'c', x: 0.8, y: 0.2, r: 0.05, v: 1 } });
  assert.ok(await wait(/event: fog/), 'a fog change is announced');
  // A mark placed under fog (after covering again) is not announced to the player at all.
  await ok('POST', fog('/undo'), T.gm, { pic: PIC });
  buf = '';
  await ok('POST', api('/map/world/marks'), T.gm, { kind: 'pin', x: 80, y: 20, label: 'Event leak', visibility: 'party' });
  await wait(/event: fog/, 800); // no event is expected for the player
  assert.ok(!buf.includes('Event leak'), `the player stream never carried the fogged mark: ${buf}`);
  await reader.cancel();
});

test('TestFog_TableDisplayFollowsTheGM', async () => {
  assert.deepEqual(await ok('GET', api('/fog/table'), T.jess), { mapId: null, pic: null, version: 0 });
  const set = await ok('PUT', api('/fog/table'), T.gm, { mapId: 'world', pic: PIC });
  assert.equal(set.pic, PIC);
  assert.equal(set.version, 1);
  assert.deepEqual(await ok('GET', api('/fog/table'), T.jess), set);
  const cleared = await ok('PUT', api('/fog/table'), T.gm, { pic: null });
  assert.equal(cleared.pic, null);
  assert.equal(cleared.mapId, 'world', 'only what was sent changes');
});
