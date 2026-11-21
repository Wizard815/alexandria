// Scenes: one button sets the whole room. CRUD is DM-only; activation applies each set part (TV, sound, lights, table map and
// fog) and reports per part; a failing part does not stop the others; unset parts are left alone; undo puts back what the
// parts that worked changed, and says what it cannot; capture saves the room as it is; and the agent tool.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { toneWav, listen, wait } from './soundTone.ts';
import { allTools } from '../src/routes/mcpServer.ts';

let base = '';
let server: any;
let tmp = '';
let W = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const api = (p: string) => `/api/worlds/${W}${p}`;
const realFetch = globalThis.fetch;
const lightsSeen: string[] = [];

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await realFetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
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
const dm = (method: string, p: string, body?: unknown) => ok(method, api(p), T.dm, body);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-scenes-'));
  const put = (rel: string, hz: number) => { fs.mkdirSync(path.dirname(path.join(tmp, 'data', rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, 'data', rel), toneWav(1, hz)); };
  put('music/village/calm/meadow.wav', 330); put('music/combat/boss.wav', 150);
  put('ambience/rain/steady.wav', 800); put('ambience/tavern/crowd.wav', 500);
  // Lights are sent to a fake bridge; the librarian's own calls (scenes call themselves) go through.
  const fakeFetch: typeof fetch = async (input: any, init: any = {}) => {
    const u = String(input);
    if (u.startsWith('http://127.0.0.1')) return realFetch(input, init);
    lightsSeen.push(u);
    return new Response('{"success":true}');
  };
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_LIGHTS_MIN_MS: '0' } });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Sceneland', dmAccountId: ID.dm })).id;
  const inv = await ok('POST', api('/invites'), T.dm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' });
  T.jess = j.token;
});
after(() => { server?.close(); server?.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

const track = async (p: string) => (await dm('GET', '/sound/library')).music.find((t: any) => t.path === p).id as string;
const queue = async (title: string, vid: string) => { const r = await dm('POST', '/screen/media/items', { kind: 'youtube', url: `https://youtu.be/${vid}`, title }); return r.items.find((i: any) => i.title === title).id as string; };

test('TestScenes_CrudIsDMOnly', async () => {
  const made = await dm('POST', '/scenes', { name: 'Tavern', icon: 'fa-beer-mug-empty', color: '#c0392b', parts: { sound: { stopOthers: true }, junk: 1 } });
  assert.equal(made.name, 'Tavern');
  assert.deepEqual(made.parts, { sound: { stopOthers: true } }, 'unknown parts are dropped');
  for (const [m, p, b] of [
    ['GET', '/scenes', undefined], ['POST', '/scenes', { name: 'x' }], ['PUT', `/scenes/${made.id}`, { name: 'y' }], ['DELETE', `/scenes/${made.id}`, undefined],
    ['PUT', '/scenes/order', { ids: [made.id] }], ['POST', `/scenes/${made.id}/activate`, {}], ['POST', '/scenes/undo', {}], ['POST', '/scenes/capture', { name: 'z' }], ['GET', '/scenes/last', undefined],
  ] as const) assert.equal((await call(m, api(p), T.jess, b)).status, 403, `${m} ${p} is DM-only`);
  assert.equal((await call('GET', api('/scenes'))).status, 401);
  const second = await dm('POST', '/scenes', { name: 'Boss fight' });
  await dm('PUT', '/scenes/order', { ids: [second.id, made.id] });
  assert.deepEqual((await dm('GET', '/scenes')).scenes.map((s: any) => s.name), ['Boss fight', 'Tavern']);
  const up = await dm('PUT', `/scenes/${made.id}`, { name: 'The Tavern', parts: { lights: { off: true } } });
  assert.deepEqual([up.name, up.parts], ['The Tavern', { lights: { off: true } }]);
  assert.equal((await call('POST', api('/scenes'), T.dm, { name: '' })).status, 400);
  assert.equal((await call('POST', api('/scenes'), T.dm, { name: 'bad', color: 'red' })).status, 400);
  assert.equal((await call('POST', api('/scenes'), T.dm, { name: 'bad', parts: { tv: { mode: 'nope' } } })).status, 400);
  assert.equal((await call('POST', api('/scenes'), T.dm, { name: 'bad', parts: { sound: { volume: 4 } } })).status, 400);
  await dm('DELETE', `/scenes/${made.id}`);
  await dm('DELETE', `/scenes/${second.id}`);
  assert.deepEqual((await dm('GET', '/scenes')).scenes, []);
  assert.equal((await call('POST', api('/scenes/nothing/activate'), T.dm, {})).status, 404);
});

test('TestScenes_ActivateAppliesEveryPartAndUndoPutsItBack', async () => {
  const meadow = await track('village/calm/meadow.wav');
  const boss = await track('combat/boss.wav');
  const a = await queue('Tavern video', 'dQw4w9WgXcQ');
  await queue('Other video', 'aqz-KE-bpKQ');
  const card = (await dm('POST', '/stage/cards', { kind: 'text', title: 'Wanted poster', text: 'Wanted: the keeper.' })).id;
  const sun = (await dm('POST', '/lights/drivers', { kind: 'wled', name: 'Strip', config: { host: '192.168.1.50' } })).id;
  const group = (await dm('POST', '/lights/groups', { name: 'Room', driverId: sun, target: {} })).id;
  const warm = (await dm('POST', '/lights/scenes', { name: 'Warm', color: '#ff8800' })).id;
  const cold = (await dm('POST', '/lights/scenes', { name: 'Cold', color: '#0000ff' })).id;
  void group;
  await dm('POST', '/sound/ambience/scene', { layers: [{ kind: 'tavern', volume: 0.3 }], target: 'table' });
  await dm('POST', '/sound/music/play', { trackId: boss, volume: 0.5, target: 'table' });
  await dm('POST', '/lights/scenes/' + cold + '/run');
  await dm('PUT', '/screen/media', { mode: 'off' });
  await dm('PUT', '/fog/table', { mapId: 'world', pic: 'lib:before' });
  await dm('POST', '/sound/ambience/scene', { layers: [{ kind: 'tavern', volume: 0.3 }], target: 'table' });
  await dm('POST', '/sound/scenes', { name: 'Rainy night', layers: [{ kind: 'rain', volume: 0.8 }] });

  const sc = await dm('POST', '/scenes', {
    name: 'Cosy inn',
    parts: {
      tv: { mode: 'item', itemId: a },
      sound: { musicTrackId: meadow, ambience: 'Rainy night', volume: 0.5, target: 'both' },
      lights: { scene: warm },
      table: { mapId: 'inn', pic: 'lib:inn', fog: { enabled: true, base: null, ops: [{ k: 'c', x: 0.5, y: 0.5, r: 0.1, v: 1 }] } },
    },
  });
  const events = await listen(base, W, T.dm);
  const pev = await listen(base, W, T.jess);
  await wait(100);
  lightsSeen.length = 0;
  const r = await dm('POST', `/scenes/${sc.id}/activate`, {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(Object.keys(r.parts).sort(), ['lights', 'sound', 'table', 'tv']);
  for (const k of ['tv', 'sound', 'lights', 'table']) assert.equal(r.parts[k].status, 'ok', `${k}: ${JSON.stringify(r.parts[k])}`);
  assert.equal(r.undoable, true);

  // Every part really happened.
  const media = await dm('GET', '/screen/media');
  assert.deepEqual([media.mode, media.currentId], ['queue', a]);
  const now = await dm('GET', '/sound/now');
  assert.equal(now.music.id, meadow);
  assert.equal(now.music.volume, 0.5);
  assert.deepEqual(now.ambience.layers.map((l: any) => [l.kind, l.volume]), [['rain', 0.4]], 'the volume scales the ambience layers');
  assert.equal(now.music.target, 'both');
  await wait(60);
  assert.ok(lightsSeen.some((u) => u.includes('192.168.1.50')), 'the lights scene was sent to the bridge');
  assert.deepEqual(await dm('GET', '/fog/table'), { mapId: 'inn', pic: 'lib:inn', version: (await dm('GET', '/fog/table')).version });
  const fog = await dm('GET', '/fog/map/inn?pic=lib:inn');
  assert.deepEqual([fog.enabled, fog.ops.length], [true, 1]);
  // Players' screen shows it, and every screen got live events.
  assert.equal((await ok('GET', api('/screen/players'), T.jess)).media.current.id, a);
  const types = new Set(events.events.map((e) => e.type));
  for (const t of ['screen', 'sound', 'table-display', 'fog', 'scenes']) assert.ok(types.has(t), `the DM's screens got a ${t} event: ${[...types]}`);
  assert.ok(pev.events.some((e) => e.type === 'screen') && pev.events.some((e) => e.type === 'table-display'), 'players\' screens got theirs');
  assert.ok(!pev.events.some((e) => e.type === 'scenes'), 'the scenes event is DM-only');
  assert.equal((await dm('GET', '/scenes')).last.name, 'Cosy inn');

  // Undo: everything back as it was; what cannot be put back is said.
  const u = await dm('POST', '/scenes/undo', {});
  assert.equal(u.ok, true, JSON.stringify(u));
  assert.equal((await dm('GET', '/screen/media')).mode, 'off');
  const back = await dm('GET', '/sound/now');
  assert.equal(back.music.id, boss);
  assert.deepEqual(back.ambience.layers.map((l: any) => l.kind), ['tavern']);
  assert.equal((await dm('GET', '/fog/table')).pic, 'lib:before');
  assert.equal((await dm('GET', '/fog/map/inn?pic=lib:inn')).enabled, false, 'the fog the scene set is back to what it was');
  await wait(60);
  assert.ok(lightsSeen.length >= 2, 'the earlier lights preset was run again');
  assert.equal((await call('POST', api('/scenes/undo'), T.dm, {})).status, 409, 'one level of undo');
  assert.equal((await dm('GET', '/scenes')).last.canUndo, false);
  events.stop(); pev.stop();

  // A stage card in the spotlight is hidden again by undo, and a scene may be activated by name.
  assert.equal((await ok('GET', api('/stage'), T.jess)).cards.length, 0);
  const cs = await dm('POST', '/scenes', { name: 'Wanted', parts: { tv: { mode: 'card', cardId: card, spotlight: true } } });
  const ca = await dm('POST', `/scenes/${encodeURIComponent('wanted')}/activate`, {});
  assert.equal(ca.parts.tv.status, 'ok', JSON.stringify(ca));
  const shown = await ok('GET', api('/stage'), T.jess);
  assert.deepEqual([shown.cards.map((c: any) => c.id), shown.spotlightId], [[card], card]);
  await dm('POST', '/scenes/undo', {});
  const hidden = await ok('GET', api('/stage'), T.jess);
  assert.deepEqual([hidden.cards.length, hidden.spotlightId], [0, null]);
  await dm('DELETE', `/scenes/${cs.id}`);
});

test('TestScenes_AFailingPartDoesNotStopTheRest', async () => {
  const meadow = await track('village/calm/meadow.wav');
  const sc = await dm('POST', '/scenes', {
    name: 'Half broken',
    parts: { tv: { mode: 'off' }, sound: { musicTrackId: 'no-such-track' }, lights: { scene: 'lsc_gone' }, table: { mapId: 'world', pic: 'none' } },
  });
  const r = await dm('POST', `/scenes/${sc.id}/activate`, {});
  assert.equal(r.ok, false);
  assert.equal(r.parts.sound.status, 'failed');
  assert.match(r.parts.sound.error, /not found/i);
  assert.equal(r.parts.lights.status, 'failed');
  assert.equal(r.parts.tv.status, 'ok');
  assert.equal(r.parts.table.status, 'ok');
  assert.equal((await dm('GET', '/fog/table')).pic, 'none', 'the working parts still happened');
  // Music that works with ambience that fails: both are reported in the one sound part, and the music still plays.
  const both = await dm('POST', '/scenes', { name: 'Sound halves', parts: { sound: { musicTrackId: meadow, ambience: 'No such scene' } } });
  const r2 = await dm('POST', `/scenes/${both.id}/activate`, {});
  assert.equal(r2.parts.sound.status, 'failed');
  assert.match(r2.parts.sound.error, /ambience/i);
  assert.match(r2.parts.sound.error, /music/i, 'it says what did work');
  assert.equal((await dm('GET', '/sound/now')).music.id, meadow);
  // Undo only touches parts that worked.
  const u = await dm('POST', '/scenes/undo', {});
  assert.equal(u.parts.sound.status, 'skipped');
});

test('TestScenes_LightsWithNoRigAreReportedAndUnsetPartsAreLeftAlone', async () => {
  // A world with no light groups cannot show a lights preset: the scene says so instead of pretending.
  for (const g of await dm('GET', '/lights/groups')) await dm('DELETE', `/lights/groups/${g.id}`);
  const warm = (await dm('GET', '/lights/scenes'))[0].id;
  const sc = await dm('POST', '/scenes', { name: 'Lights only', parts: { lights: { scene: warm } } });
  const music = (await dm('GET', '/sound/now')).music;
  const media = await dm('GET', '/screen/media');
  const table = await dm('GET', '/fog/table');
  const r = await dm('POST', `/scenes/${sc.id}/activate`, {});
  assert.deepEqual(Object.keys(r.parts), ['lights'], 'only the set part is reported');
  assert.equal(r.parts.lights.status, 'failed');
  assert.match(r.parts.lights.error, /no light groups/i);
  assert.deepEqual((await dm('GET', '/sound/now')).music, music, 'sound untouched');
  assert.equal((await dm('GET', '/screen/media')).mode, media.mode, 'TV untouched');
  assert.deepEqual(await dm('GET', '/fog/table'), table, 'table untouched');
  const empty = await dm('POST', '/scenes', { name: 'Empty' });
  const e = await dm('POST', `/scenes/${empty.id}/activate`, {});
  assert.deepEqual([e.ok, e.empty, e.undoable], [true, true, false]);
});

test('TestScenes_SaveTheCurrentRoomAsAScene', async () => {
  const boss = await track('combat/boss.wav');
  await dm('POST', '/sound/music/play', { trackId: boss, volume: 0.6, target: 'both' });
  await dm('POST', '/sound/ambience/scene', { layers: [{ kind: 'rain', volume: 0.7 }], target: 'both' });
  await dm('PUT', '/fog/table', { mapId: 'world', pic: 'lib:cave' });
  await dm('PUT', '/fog/map/world/enabled', { pic: 'lib:cave', enabled: true });
  await dm('POST', '/fog/map/world/ops', { pic: 'lib:cave', op: { k: 'r', x: 0.1, y: 0.1, w: 0.3, h: 0.3, v: 1 } });
  const strip = (await dm('GET', '/lights/drivers'))[0].id;
  await dm('POST', '/lights/groups', { name: 'Room again', driverId: strip, target: {} });
  const warm = (await dm('GET', '/lights/scenes'))[0].id;
  await dm('POST', `/lights/scenes/${warm}/run`);
  const cap = await dm('POST', '/scenes/capture', { name: 'As it is', icon: 'fa-camera' });
  assert.equal(cap.scene.parts.sound.musicTrackId, boss);
  assert.deepEqual(cap.scene.parts.sound.ambienceLayers.map((l: any) => l.kind), ['rain']);
  assert.equal(cap.scene.parts.table.pic, 'lib:cave');
  assert.equal(cap.scene.parts.table.fog.ops.length, 1);
  assert.deepEqual(cap.scene.parts.lights, { scene: warm });
  assert.ok(cap.scene.parts.tv, 'the TV state is captured');
  // Change everything, then the saved scene brings it back.
  await dm('POST', '/sound/music/stop', {});
  await dm('POST', '/sound/ambience/stop', {});
  await dm('POST', '/fog/map/world/ops', { pic: 'lib:cave', op: { k: 'all', v: 0 } });
  await dm('PUT', '/fog/table', { pic: 'none' });
  const r = await dm('POST', `/scenes/${cap.scene.id}/activate`, {});
  assert.equal(r.ok, true, JSON.stringify(r));
  const now = await dm('GET', '/sound/now');
  assert.deepEqual([now.music.id, now.ambience.layers[0].kind], [boss, 'rain']);
  assert.equal((await dm('GET', '/fog/table')).pic, 'lib:cave');
  assert.equal((await dm('GET', '/fog/map/world?pic=lib:cave')).ops.length, 1, 'the saved fog state came back');
  // Capturing only some parts.
  const only = await dm('POST', '/scenes/capture', { name: 'Only sound', include: ['sound'] });
  assert.deepEqual(Object.keys(only.scene.parts), ['sound']);
});

test('TestScenes_AgentToolActivatesByName', async () => {
  const tool = allTools().find((t) => t.name === 'activate_scene')!;
  assert.ok(tool?.write, 'activate_scene is a write tool');
  const list = allTools().find((t) => t.name === 'list_scenes')!;
  assert.ok(list && !list.write && list.dmOnly);
  const c = tool.call({ scene: 'Half broken' });
  assert.equal(c.method, 'POST');
  const r = await dm(c.method, c.path, c.body);
  assert.equal(r.scene.name, 'Half broken');
});
