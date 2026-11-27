// Foundry VTT: the real Alexandria Bridge module (features/foundry/client/
// alexandria.js) runs in a stand-in Foundry (foundry-stub.js) against a real
// librarian, and both sides are checked: actors linked by name, HP and status
// effects both ways, scenes brought in as library maps and maps sent out as
// scenes, tokens on the Alexandria map (hidden and fogged ones kept from
// players), fog drawn in Foundry and uncovered by player tokens, token moves
// from Alexandria, rolls, journal entries, chat lines, keys and roles.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.ts';
import { isFogged } from '../src/core/fog.ts';
import { conditionsFromStatuses, revealAround, statusMap, statusesFor } from '../src/features/foundry/sync.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE = fs.readFileSync(path.join(here, '../src/features/foundry/client/alexandria.js'), 'utf8');
const STUB = fs.readFileSync(path.join(here, 'foundry-stub.js'), 'utf8');

let base = '';
let server: any;
let tmp = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
let KEY = '';

async function call(method: string, url: string, token?: string, body?: unknown, raw?: { type: string; data: Buffer }) {
  const headers: Record<string, string> = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  if (raw) headers['Content-Type'] = raw.type; else if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + url, { method, headers, body: raw ? new Uint8Array(raw.data) : body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
}
const ok = async (method: string, url: string, token?: string, body?: unknown, raw?: { type: string; data: Buffer }) => {
  const r = await call(method, url, token, body, raw);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const api = (p: string) => `/api/worlds/${W}${p}`;

/** A real PNG of w x h (one grey colour). */
function png(w: number, h: number) {
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 0x80); for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- a Foundry world with the module ----
function foundry() {
  const foundryFiles: Record<string, Buffer> = { 'worlds/sunken/keep.png': png(40, 25) };
  const ctx: any = { console, Blob, File, atob, Buffer, ImageData: class {}, document: { getElementById: () => null, createElement: () => ({ dataset: {} }), body: { appendChild() {} } } };
  // Timers do nothing: the test runs each tick itself.
  ctx.setTimeout = () => 0;
  ctx.clearTimeout = () => {};
  ctx.fetch = async (url: string, init?: any) => {
    if (/^https?:/.test(url)) return fetch(url, init);
    const f = foundryFiles[url];
    return f ? new Response(new Uint8Array(f), { headers: { 'Content-Type': 'image/png' } }) : new Response('no', { status: 404 });
  };
  vm.createContext(ctx);
  vm.runInContext(STUB, ctx);
  const fv = ctx.makeFoundry({ imageSize: [40, 25] });
  Object.assign(ctx, fv.api);
  ctx.globalThis = ctx;
  vm.runInContext(`${MODULE.replace(/^export /gm, '')}\n;globalThis.__alx = { fogTest, fogPixels, Bridge };`, ctx);
  const jessU = fv.user('jess', false);
  const tomU = fv.user('Tom', false);
  const jess = fv.addActor('Jessamine', 'character', [jessU], 30, 30);
  const tom = fv.addActor('Tomas', 'character', [tomU], 22, 25);
  const gob = fv.addActor('Goblin', 'npc', [], 7, 7);
  const keep = fv.addScene('Sunken Keep', 'worlds/sunken/keep.png', 4000, 2500, 100);
  const jt = fv.addToken(keep, 'Jessamine', jess, 5, 5);
  const gt = fv.addToken(keep, 'Goblin', gob, 30, 20, { hidden: true });
  fv.ready();
  const mod = () => ctx.game.modules.get('alexandria-bridge').api;
  const connect = async () => {
    ctx.game.settings.set('alexandria-bridge', 'url', base);
    ctx.game.settings.set('alexandria-bridge', 'key', KEY);
    return mod().reconnect();
  };
  const tick = async () => { await mod().bridge.tick(); };
  return { fv, ctx, jess, tom, gob, keep, jt, gt, jessU, tomU, connect, tick, mod, foundryFiles };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-foundry-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.gm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'gm password 123' })).account.id;
  T.gm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'gm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Keephold', gmAccountId: ID.gm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.gm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name === 'jess' ? 'Jessamine' : 'Tomas' });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
});

after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('TestFoundry_StatusMap: conditions to status effects and back, custom ids, the rest left alone', () => {
  const map = statusMap({ Poisoned: 'poison', Prone: '', Hexed: 'curse' });
  assert.equal(map.Poisoned, 'poison');
  assert.equal(map.Prone, undefined);
  assert.deepEqual(statusesFor(['poisoned', 'Inspired', 'Hexed'], map), ['poison', 'curse']);
  assert.deepEqual(conditionsFromStatuses(['Poisoned', 'Inspired'], ['unconscious', 'burning'], map), ['Inspired', 'Unconscious']);
  // A player token uncovers a circle `squares` grid squares wide around it.
  assert.deepEqual(revealAround({ x: 50, y: 25 }, 6, 0.025), { k: 'c', x: 0.5, y: 0.25, r: 0.15, v: 1 });
  assert.equal(revealAround({ x: 50, y: 25 }, 0, 0.025), null);
  assert.equal(revealAround({ x: 50, y: 25 }, 6, null), null);
});

test('TestFoundry_FogParity: the module draws exactly the fog the server enforces', () => {
  const g = foundry();
  const fogTest = g.ctx.__alx.fogTest;
  const base = Buffer.alloc(96 * 96 / 8);
  for (let i = 0; i < base.length; i++) base[i] = (i * 37) & 0xff;
  const state = { enabled: true, base: base.toString('base64'), ops: [{ k: 'c', x: 0.3, y: 0.4, r: 0.12, v: 1 }, { k: 'r', x: 0.5, y: 0.1, w: 0.3, h: 0.2, v: 0 }, { k: 'c', x: 0.7, y: 0.7, r: 0.05, v: 1 }] };
  const t = fogTest({ ...state, aspect: 1.6 });
  for (let k = 0; k < 2000; k++) {
    const x = ((k * 7919) % 1000) / 1000, y = ((k * 104729) % 1000) / 1000;
    assert.equal(t(x, y), isFogged(state as any, x, y), `at ${x},${y}`);
  }
});

test('TestFoundry_Keys: only the GM makes a key; a bad or replaced key is refused; the module installs by URL', async () => {
  assert.equal((await call('POST', api('/foundry/key'), T.jess)).status, 403);
  assert.equal((await call('GET', api('/foundry'), T.jess)).status, 403);
  const first = (await ok('POST', api('/foundry/key'), T.gm)).key;
  assert.match(first, /^alx_fvtt_/);
  KEY = (await ok('POST', api('/foundry/key'), T.gm)).key;
  assert.equal((await call('POST', '/api/foundry/bridge/sync', first, {})).status, 401);
  assert.equal((await call('POST', '/api/foundry/bridge/sync', 'alx_fvtt_nope', {})).status, 401);
  assert.equal((await call('POST', '/api/foundry/bridge/sync', T.gm, {})).status, 401, 'a GM session is not a bridge key');
  // The bridge answers a Foundry page on any address (CORS), preflight included.
  const pre = await fetch(`${base}/api/foundry/bridge/sync`, { method: 'OPTIONS', headers: { Origin: 'http://foundry.local:30000', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Authorization/);
  assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
  // Foundry's "Install Module" reads the manifest, then the zip it names.
  const man = await ok('GET', '/api/foundry/module.json');
  assert.equal(man.id, 'alexandria-bridge');
  assert.equal(man.download, `${base}/api/foundry/module.zip`);
  assert.deepEqual(man.esmodules, ['scripts/alexandria.js']);
  const zip = Buffer.from(await (await fetch(man.download)).arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'a zip');
  for (const n of ['module.json', 'scripts/alexandria.js', 'styles/alexandria.css']) assert.ok(zip.includes(Buffer.from(n)), n);
  assert.ok(zip.includes(Buffer.from('class Bridge')), 'the module code is in it');
  assert.ok(!zip.includes(Buffer.from(KEY)), 'never the key');
});

test('TestFoundry_Sync: HP, statuses, scenes, tokens, fog, moves, rolls and journal entries move both ways', async () => {
  const g = foundry();
  assert.equal(await g.connect(), true);
  let st = await ok('GET', api('/foundry'), T.gm);
  assert.equal(st.online, true);
  assert.equal(st.moduleVersion, '1.0.0');
  assert.equal(st.foundryWorld, 'Sunken Realm');
  assert.equal(st.system, 'dnd5e');
  assert.ok(st.statusIds.includes('poisoned'));
  // The player characters (not the goblin) were linked by character name; Foundry's HP filled in Alexandria's.
  assert.deepEqual(st.actors.map((a: any) => [a.name, a.accountId]), [['Jessamine', ID.jess], ['Tomas', ID.tom]]);
  let sheet = await ok('GET', api(`/sheet/${ID.jess}`), T.gm);
  assert.equal(sheet.hp, 30);
  assert.equal(sheet.maxHp, 30);
  assert.deepEqual(st.scenes.map((s: any) => [s.name, s.mapId]), [['Sunken Keep', null]]);

  // ---- HP and statuses ----
  // Damage in Foundry → Alexandria's sheet (logged as Foundry), not sent back.
  await g.jess.update({ 'system.attributes.hp.value': 21 });
  await g.tick();
  sheet = await ok('GET', api(`/sheet/${ID.jess}`), T.gm);
  assert.equal(sheet.hp, 21);
  const log = (await ok('GET', api(`/sheet/log?account=${ID.jess}`), T.gm)).log;
  assert.equal(log[0].source, 'foundry');
  // Damage and conditions in Alexandria → the actor's HP and status effects.
  await ok('POST', api(`/sheet/${ID.jess}/vitals`), T.gm, { damage: 5, conditions: ['Poisoned', 'Inspired'] });
  await g.tick();
  assert.equal(g.jess.system.attributes.hp.value, 16);
  assert.deepEqual([...g.jess.statuses], ['poisoned']);
  const logLen = (await ok('GET', api(`/sheet/log?account=${ID.jess}`), T.gm)).log.length;
  await g.tick();
  await g.tick();
  assert.equal((await ok('GET', api(`/sheet/log?account=${ID.jess}`), T.gm)).log.length, logLen, 'what the module applied is not reported back as a change');
  // A status toggled in Foundry → conditions (Inspired has no status and stays).
  await g.jess.toggleStatusEffect('prone', { active: true });
  await g.jess.toggleStatusEffect('poisoned', { active: false });
  await g.tick();
  sheet = await ok('GET', api(`/sheet/${ID.jess}`), T.gm);
  assert.deepEqual(sheet.conditions, ['Inspired', 'Prone']);

  // ---- a scene comes into Alexandria as a map ----
  const keepId = g.keep.id;
  assert.equal((await call('POST', api(`/foundry/scenes/${keepId}/import`), T.jess)).status, 403);
  await ok('POST', api(`/foundry/scenes/${keepId}/import`), T.gm);
  await g.tick(); // the module gets the item and uploads the picture
  st = await ok('GET', api('/foundry'), T.gm);
  const sc = st.scenes[0];
  assert.equal(sc.mapId, 'sunken-keep');
  assert.match(sc.pic, /^lib:lf_/);
  assert.equal(sc.picName, 'keep.png');
  const maps = await ok('GET', api('/files/maps'), T.jess);
  assert.ok(maps.some((m: any) => `lib:${m.id}` === sc.pic), 'the picture is a library map the party can open');
  assert.deepEqual(await ok('GET', api('/foundry/maps'), T.jess), [{ mapId: 'sunken-keep', pic: sc.pic, name: 'Sunken Keep' }]);

  // ---- tokens: the linked scene's tokens are on the map ----
  await g.tick(); // config now lists the scene: the module sends its tokens
  let gmMarks = await ok('GET', api('/map/sunken-keep/marks'), T.gm);
  const jm = gmMarks.find((m: any) => m.data.label === 'Jessamine');
  const gm = gmMarks.find((m: any) => m.data.label === 'Goblin');
  assert.ok(jm && gm, 'both tokens');
  // Token centre: (5.5 squares × 100 px) / 4000 px wide.
  assert.equal(jm.data.x, 13.75);
  assert.equal(jm.data.y, 22);
  assert.equal(jm.data.token.account, ID.jess);
  assert.equal(gm.hidden_by_gm, true);
  let jessMarks = await ok('GET', api('/map/sunken-keep/marks'), T.jess);
  assert.deepEqual(jessMarks.map((m: any) => m.data.label), ['Jessamine'], 'a hidden token is the GM\'s alone');

  // ---- fog: on in Alexandria → drawn in Foundry; the goblin under fog is kept from players ----
  await ok('PUT', api('/fog/map/sunken-keep/enabled'), T.gm, { pic: sc.pic, enabled: true });
  await ok('POST', api('/fog/map/sunken-keep/ops'), T.gm, { pic: sc.pic, op: { k: 'c', x: 0.1375, y: 0.22, r: 0.1 } });
  await g.gt.update({ hidden: false });
  await g.tick();
  const flag = g.keep.getFlag('alexandria-bridge', 'fog');
  assert.equal(flag.enabled, true);
  assert.equal(flag.ops.length, 1);
  assert.equal(flag.aspect, 1.6);
  jessMarks = await ok('GET', api('/map/sunken-keep/marks'), T.jess);
  assert.deepEqual(jessMarks.map((m: any) => m.data.label), ['Jessamine'], 'the goblin is under fog');
  // A player token moving in Foundry uncovers fog around it (6 squares × 100/4000 = 0.15 of the width).
  await g.jt.update({ x: g.keep.dimensions.sceneX + 25 * 100, y: g.keep.dimensions.sceneY + 20 * 100 });
  await g.tick();
  let fog = await ok('GET', api(`/fog/map/sunken-keep?pic=${encodeURIComponent(sc.pic)}`), T.gm);
  assert.equal(fog.ops.length, 2);
  assert.deepEqual(fog.ops[1], { k: 'c', x: 0.6375, y: 0.82, r: 0.15, v: 1 });
  jessMarks = await ok('GET', api('/map/sunken-keep/marks'), T.jess);
  assert.deepEqual(jessMarks.map((m: any) => m.data.label).sort(), ['Goblin', 'Jessamine'], 'the goblin stands in the uncovered circle now');
  await g.tick();
  assert.equal(g.keep.getFlag('alexandria-bridge', 'fog').ops.length, 2, 'and Foundry draws the new fog');
  // The goblin moving in Foundry does not uncover anything.
  await g.gt.update({ x: g.gt.x + 100 });
  await g.tick();
  fog = await ok('GET', api(`/fog/map/sunken-keep?pic=${encodeURIComponent(sc.pic)}`), T.gm);
  assert.equal(fog.ops.length, 2);

  // ---- moving a token from Alexandria ----
  assert.equal((await call('PUT', api(`/foundry/tokens/${jm.id}`), T.tom, { x: 50, y: 50 })).status, 403, 'not Tom\'s character');
  assert.equal((await call('PUT', api(`/foundry/tokens/${gm.id}`), T.jess, { x: 50, y: 50 })).status, 403, 'nor the goblin');
  assert.equal((await call('PUT', api(`/foundry/tokens/${jm.id}`), T.jess, { x: 150, y: 50 })).status, 400);
  const mv = await ok('PUT', api(`/foundry/tokens/${jm.id}`), T.jess, { x: 76.25, y: 42 });
  assert.equal(mv.uncovered, true);
  await g.tick();
  // Centre 76.25% of 4000 = 3050 → top left 3000, on the grid.
  assert.equal(g.jt.x, g.keep.dimensions.sceneX + 3000);
  assert.equal(g.jt.y, g.keep.dimensions.sceneY + 1000);
  await g.tick();
  gmMarks = await ok('GET', api('/map/sunken-keep/marks'), T.gm);
  assert.equal(gmMarks.find((m: any) => m.id === jm.id).data.x, 76.25, 'Foundry\'s answer does not move it back');
  // The GM and the assistant move tokens by name too.
  await ok('PUT', api('/foundry/tokens/goblin'), T.gm, { x: 11.25, y: 10 });
  await g.tick();
  assert.equal(g.gt.x, g.keep.dimensions.sceneX + 400);
  // A token deleted in Foundry leaves the map.
  g.keep.tokens.delete(g.gt.id);
  g.fv.api.Hooks.callAll('deleteToken', g.gt, {}, 'x');
  await g.tick();
  gmMarks = await ok('GET', api('/map/sunken-keep/marks'), T.gm);
  assert.deepEqual(gmMarks.map((m: any) => m.data.label), ['Jessamine']);

  // ---- an Alexandria map picture becomes a Foundry scene ----
  const up = await ok('POST', api('/files?kind=map&level=party&name=harbor.png&title=Harbor'), T.gm, undefined, { type: 'image/png', data: png(64, 40) });
  assert.equal((await call('POST', api('/foundry/scenes'), T.gm, { pic: 'lib:lf_nope' })).status, 404);
  await ok('POST', api('/foundry/scenes'), T.gm, { pic: `lib:${up.id}`, name: 'The Harbor' });
  await g.tick();
  const made = g.fv.api.game.scenes.find((s: any) => s.name === 'The Harbor');
  assert.ok(made, 'scene made');
  assert.match(made.background.src, /^alexandria\/the-harbor-\d+\.png$/);
  assert.equal(g.fv.files[made.background.src].length, png(64, 40).length, 'with the picture saved in Foundry');
  assert.equal(made.width, 40);
  await g.tick();
  st = await ok('GET', api('/foundry'), T.gm);
  const harbor = st.scenes.find((s: any) => s.name === 'The Harbor');
  assert.equal(harbor.mapId, 'the-harbor');
  assert.equal(harbor.pic, `lib:${up.id}`);
  // Unlinking takes the scene's tokens off the map.
  await ok('PUT', api(`/foundry/scenes/${keepId}`), T.gm, { mapId: null });
  assert.deepEqual(await ok('GET', api('/map/sunken-keep/marks'), T.gm), []);
  await g.tick();
  assert.equal(g.keep.getFlag('alexandria-bridge', 'fog').enabled, false, 'and its fog from Foundry');
  await ok('PUT', api(`/foundry/scenes/${keepId}`), T.gm, { mapId: 'sunken-keep', pic: sc.pic });
  await g.tick();
  await g.tick();
  assert.equal((await ok('GET', api('/map/sunken-keep/marks'), T.gm)).length, 1, 'linked again: the token is back');

  // ---- rolls, journal entries and chat lines ----
  await ok('POST', api('/sessionchat/sessions/start'), T.gm, { title: 'Foundry night' });
  await g.fv.api.ChatMessage.create({ speaker: { actor: g.jess.id, alias: 'Jessamine' }, author: g.jessU, flavor: 'Stealth check', rolls: [{ formula: '1d20 + 4', total: 19, dice: [{ results: [{ result: 15, active: true }] }] }] });
  await g.fv.api.ChatMessage.create({ speaker: { alias: 'GM' }, author: g.fv.gm, whisper: ['x'], rolls: [{ formula: '1d20', total: 3, dice: [] }] });
  await g.tick();
  const chat = (await ok('GET', api('/sessionchat/chat/table'), T.tom)).messages;
  const roll = chat.find((m: any) => m.kind === 'roll');
  assert.equal(roll.author_id ?? roll.authorId, ID.jess);
  assert.equal(roll.roll.total, 19);
  assert.match(roll.roll.note, /Stealth check · Foundry/);
  assert.equal(chat.filter((m: any) => m.kind === 'roll').length, 1, 'whispers stay in Foundry');

  await ok('PUT', api('/library/pages'), T.gm, { path: 'Handouts/Plot', markdown: '# Plot\nThe twist.' });
  const port = await ok('PUT', api('/library/pages'), T.gm, { path: 'Places/Port', visibility: 'party', markdown: '# Port\nFish and [[Plot]].\n\n> [!secret]\n> Smugglers.\n' });
  assert.equal((await call('POST', api('/foundry/handout'), T.gm, { page: 'Plot', players: true })).status, 409);
  await ok('POST', api('/foundry/handout'), T.gm, { page: port.id, players: true });
  await ok('POST', api('/foundry/say'), T.gm, { text: 'The bell <tolls> twice.', as: 'Bellringer' });
  await g.tick();
  const j = g.fv.journals.find((x: any) => x.name === 'Port');
  assert.ok(j, 'journal entry made');
  assert.equal(j.ownership.default, 2, 'players can read it');
  assert.doesNotMatch(j.pages[0].text.content, /Smugglers/, 'players get the player copy');
  assert.match(j.pages[1].text.content, /Smugglers/, 'the GM notes page has the GM copy');
  assert.equal(j.pages[1].ownership.default, 0);
  const said = g.fv.chat.find((m: any) => m.speaker?.alias === 'Bellringer');
  assert.equal(said.content, '<p>The bell &lt;tolls&gt; twice.</p>');
  await g.tick();
  assert.equal((await ok('GET', api('/sessionchat/chat/table'), T.tom)).messages.filter((m: any) => m.kind === 'roll').length, 1, 'Alexandria\'s own lines are not read back as rolls');

  // Table chat rolls → Foundry when that is on.
  await ok('PATCH', api('/settings'), T.gm, { foundryRollsOut: true });
  await g.tick();
  await ok('POST', api('/sessionchat/chat/table'), T.tom, { body: '/roll 1d20+2 perception' });
  await g.tick();
  assert.ok(g.fv.chat.some((m: any) => /Tom/.test(m.content) && /1d20\+2/.test(m.content)), 'Tom\'s roll is in the Foundry chat');

  st = await ok('GET', api('/foundry'), T.gm);
  assert.ok(st.activity.some((a: any) => a.dir === 'in' && /Jessamine: HP 30 → 21/.test(a.text)), JSON.stringify(st.activity.slice(0, 5)));
  assert.ok(st.activity.some((a: any) => a.dir === 'out' && /Journal entry "Port"/.test(a.text)));
});

test('TestFoundry_Settings: tokens and fog follow the GM\'s switches; players may be kept from moving tokens', async () => {
  const marks = await ok('GET', api('/map/sunken-keep/marks'), T.gm);
  const jm = marks.find((m: any) => m.data.label === 'Jessamine');
  await ok('PATCH', api('/settings'), T.gm, { foundryPlayersMove: false });
  assert.equal((await call('PUT', api(`/foundry/tokens/${jm.id}`), T.jess, { x: 20, y: 20 })).status, 403);
  await ok('PATCH', api('/settings'), T.gm, { foundryPlayersMove: true, foundryRevealSquares: 0 });
  assert.equal((await ok('PUT', api(`/foundry/tokens/${jm.id}`), T.jess, { x: 20, y: 20 })).uncovered, false, 'reveal is off');
  assert.equal((await call('PATCH', api('/settings'), T.gm, { foundryStatuses: { Poisoned: 5 } })).status, 400);
  assert.equal((await call('PATCH', api('/settings'), T.gm, { foundryRevealSquares: 99 })).status, 400);
});
