// Lights (PLAN §16.2): each driver's request shape against a fake, the
// OpenRGB packet bytes over a real local socket, scenes, hooks that follow the
// game (off by default), rate limit and debounce, and lights that fail or hang
// without ever breaking a game action.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { toneWav } from './soundTone.ts';
import { rgbToXy, moodColor, parseColor } from '../src/features/lights/color.ts';
import { cleanHost, orgbPackets, wledBody, type LightState } from '../src/features/lights/drivers.ts';
import { observe } from '../src/features/lights/hooks.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
let W = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const L = () => `/api/worlds/${W}/lights`;
const realFetch = globalThis.fetch;

interface Seen { url: string; method: string; headers: Record<string, string>; body: any }
const seen: Seen[] = [];
let mode: 'ok' | 'fail' | 'hang' = 'ok';
let hueButton = false;
const env: Record<string, string> = { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_LIGHTS_MIN_MS: '0' };

const fakeFetch: typeof fetch = async (input: any, init: any = {}) => {
  const u = String(input);
  if (u.startsWith('http://127.0.0.1')) return realFetch(input, init);
  const rec: Seen = { url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
  seen.push(rec);
  if (mode === 'hang') return new Promise<Response>(() => {});
  if (mode === 'fail') return new Response('nope', { status: 500 });
  if (u === 'http://hue.local/api' && rec.method === 'POST') return new Response(JSON.stringify(hueButton ? [{ success: { username: 'hue-user-1' } }] : [{ error: { type: 101, description: 'link button not pressed' } }]));
  if (u.startsWith('http://hue.local/api/')) return new Response(JSON.stringify([{ success: { '/groups/2/action/on': true } }]));
  return new Response('{"success":true}');
};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const lastTo = (host: string) => [...seen].reverse().find((s) => s.url.includes(host));

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
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

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-lights-'));
  const put = (rel: string) => { fs.mkdirSync(path.dirname(path.join(tmp, 'data', rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, 'data', rel), toneWav()); };
  put('music/combat/boss.wav'); put('music/village/calm/meadow.wav');
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch, env });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Lightland', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
});
after(() => { server?.close(); server?.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

const mkDriver = (kind: string, name: string, config: any) => ok('POST', `${L()}/drivers`, T.dm, { kind, name, config });
const mkGroup = (name: string, driverId: string, target: any = {}) => ok('POST', `${L()}/groups`, T.dm, { name, driverId, target });
const mkScene = (name: string, color: string, extra: any = {}) => ok('POST', `${L()}/scenes`, T.dm, { name, color, ...extra });

test('TestLights_ColoursAndMoodMap', () => {
  assert.deepEqual(parseColor('#ff8800'), [255, 136, 0]);
  assert.deepEqual(parseColor('f80'), [255, 136, 0]);
  assert.equal(parseColor('red'), null);
  const [x, y] = rgbToXy([255, 0, 0]);
  assert.ok(x > 0.6 && y < 0.35, `red is at the red end of the Hue gamut: ${x},${y}`);
  assert.deepEqual(moodColor(1, 1), [214, 40, 40]);
  assert.deepEqual(moodColor(0, 0), [63, 167, 214]);
});

test('TestLights_HostsMustBeOnTheLocalNetwork', () => {
  for (const ok_ of ['wled.local', '192.168.1.50', '10.0.0.4:80', '127.0.0.1', 'homeassistant.local:8123', '172.20.0.9']) assert.equal(cleanHost(ok_), ok_);
  for (const bad of ['http://x', '8.8.8.8', '169.254.169.254', '0.0.0.0', 'a/b', '', 'x y', '300.1.1.1']) assert.throws(() => cleanHost(bad), /host|address|local/i, bad);
});

test('TestLights_WledRequestShape', async () => {
  const d = await mkDriver('wled', 'Desk strip', { host: '192.168.1.50' });
  assert.deepEqual(d.config, { host: '192.168.1.50' });
  const g = await mkGroup('Desk', d.id);
  await mkScene('Warm', '#ff8800', { brightness: 50, effect: 'breathe', transitionMs: 700 });
  seen.length = 0;
  await ok('POST', `${L()}/scenes/${(await ok('GET', `${L()}/scenes`, T.dm))[0].id}/run`, T.dm);
  await tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, 'http://192.168.1.50/json/state');
  assert.deepEqual(seen[0].body, { on: true, bri: 128, transition: 7, seg: [{ col: [[255, 136, 0]], fx: 2 }] });
  assert.deepEqual(wledBody({ on: false, color: [0, 0, 0], brightness: 1, effect: '', transitionMs: 400 } as LightState), { on: false, transition: 4 });
  // The test button waits for the answer.
  const t = await ok('POST', `${L()}/drivers/${d.id}/test`, T.dm, { color: '#00ff00' });
  assert.equal(t.ok, true);
  assert.deepEqual(lastTo('192.168.1.50')!.body.seg[0].col, [[0, 255, 0]]);
  mode = 'fail';
  const bad = await ok('POST', `${L()}/drivers/${d.id}/test`, T.dm, {});
  mode = 'ok';
  assert.equal(bad.ok, false);
  assert.match(bad.results[0].error, /500/);
  await ok('DELETE', `${L()}/groups/${g.id}`, T.dm);
  await ok('DELETE', `${L()}/drivers/${d.id}`, T.dm);
  for (const s of await ok('GET', `${L()}/scenes`, T.dm)) await ok('DELETE', `${L()}/scenes/${s.id}`, T.dm);
});

test('TestLights_HuePairingAndRequestShape', async () => {
  const d = await mkDriver('hue', 'Bridge', { host: 'hue.local' });
  assert.equal(d.paired, false);
  // Before the button: the bridge says so, nothing is saved.
  seen.length = 0;
  let p = await call('POST', `${L()}/drivers/${d.id}/pair`, T.dm);
  assert.equal(p.status, 409);
  assert.equal(p.body.waiting, true);
  assert.deepEqual(seen[0].body, { devicetype: 'alexandria#gateway' });
  hueButton = true;
  p = await call('POST', `${L()}/drivers/${d.id}/pair`, T.dm);
  assert.equal(p.status, 200);
  assert.equal(p.body.paired, true);
  const after_ = (await ok('GET', `${L()}/drivers`, T.dm))[0];
  assert.equal(after_.paired, true);
  assert.equal(after_.config.user, '••••••', 'the username is masked');
  assert.ok(!JSON.stringify(await ok('GET', `${L()}/status`, T.dm)).includes('hue-user-1'));
  const g = await mkGroup('Ceiling', d.id, { group: '2' });
  assert.deepEqual(g.target, { group: '2' });
  assert.equal((await call('POST', `${L()}/groups`, T.dm, { name: 'Bad', driverId: d.id, target: { group: 'abc' } })).status, 400);
  const sc = await mkScene('Blue', '#0000ff', { brightness: 100, transitionMs: 1000 });
  seen.length = 0;
  await ok('POST', `${L()}/scenes/${sc.id}/run`, T.dm);
  await tick();
  assert.equal(seen[0].method, 'PUT');
  assert.equal(seen[0].url, 'http://hue.local/api/hue-user-1/groups/2/action');
  assert.equal(seen[0].body.on, true);
  assert.equal(seen[0].body.bri, 254);
  assert.equal(seen[0].body.transitiontime, 10);
  assert.deepEqual(seen[0].body.xy, rgbToXy([0, 0, 255]));
  assert.equal(seen[0].body.effect, 'none');
  await ok('DELETE', `${L()}/drivers/${d.id}`, T.dm);
  await ok('DELETE', `${L()}/scenes/${sc.id}`, T.dm);
  hueButton = false;
});

test('TestLights_HomeAssistantRequestShapeAndSecretMasking', async () => {
  const d = await mkDriver('ha', 'HA', { baseUrl: 'http://homeassistant.local:8123/', token: 'LONG-LIVED-SECRET' });
  assert.equal(d.config.token, '••••••');
  assert.equal(d.config.baseUrl, 'http://homeassistant.local:8123');
  assert.ok(!JSON.stringify(await ok('GET', `${L()}/drivers`, T.dm)).includes('LONG-LIVED-SECRET'));
  // Saving the masked value back keeps the real token.
  await ok('PUT', `${L()}/drivers/${d.id}`, T.dm, { config: { baseUrl: 'http://homeassistant.local:8123', token: d.config.token } });
  const g = await mkGroup('Lamps', d.id, { entities: ['light.desk', 'light.shelf'] });
  const sc = await mkScene('Teal', '#00aaaa', { brightness: 40, effect: 'candle', transitionMs: 2000 });
  seen.length = 0;
  await ok('POST', `${L()}/scenes/${sc.id}/run`, T.dm);
  await tick();
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, 'http://homeassistant.local:8123/api/services/light/turn_on');
  assert.equal(seen[0].headers.Authorization, 'Bearer LONG-LIVED-SECRET');
  assert.deepEqual(seen[0].body, { entity_id: ['light.desk', 'light.shelf'], rgb_color: [0, 170, 170], brightness: 102, effect: 'candle', transition: 2 });
  await ok('POST', `${L()}/off`, T.dm);
  await tick();
  assert.equal(seen[1].url, 'http://homeassistant.local:8123/api/services/light/turn_off');
  assert.equal((await call('POST', `${L()}/groups`, T.dm, { name: 'Bad', driverId: d.id, target: { entities: ['evil; drop'] } })).status, 400);
  assert.equal((await call('POST', `${L()}/drivers`, T.dm, { kind: 'ha', name: 'x', config: { baseUrl: 'http://8.8.8.8', token: 't' } })).status, 400, 'not the local network');
  assert.equal((await call('POST', `${L()}/drivers`, T.dm, { kind: 'ha', name: 'x', config: { baseUrl: 'http://homeassistant.local' } })).status, 400, 'token needed');
  void g;
  await ok('DELETE', `${L()}/drivers/${d.id}`, T.dm);
  await ok('DELETE', `${L()}/scenes/${sc.id}`, T.dm);
});

test('TestLights_OpenRgbSendsSdkPackets', async () => {
  // The packet bytes themselves.
  const bytes = orgbPackets([{ index: 1, leds: 2 }], { on: true, color: [255, 128, 0], brightness: 50, effect: '', transitionMs: 0 });
  let off = 0;
  const packets: { dev: number; id: number; data: Buffer }[] = [];
  while (off < bytes.length) {
    assert.equal(bytes.toString('ascii', off, off + 4), 'ORGB');
    const size = bytes.readUInt32LE(off + 12);
    packets.push({ dev: bytes.readUInt32LE(off + 4), id: bytes.readUInt32LE(off + 8), data: bytes.subarray(off + 16, off + 16 + size) });
    off += 16 + size;
  }
  assert.deepEqual(packets.map((p) => [p.dev, p.id]), [[0, 50], [1, 1100], [1, 1050]]);
  assert.equal(packets[0].data.toString('ascii'), 'Alexandria\0');
  const leds = packets[2].data;
  assert.equal(leds.readUInt32LE(0), leds.length, 'the size field counts itself');
  assert.equal(leds.readUInt16LE(4), 2);
  assert.deepEqual([...leds.subarray(6)], [128, 64, 0, 0, 128, 64, 0, 0], 'half brightness, 4 bytes a LED');

  // And over a real socket, through the driver and the test button.
  const got: Buffer[] = [];
  const srv = net.createServer((s) => { s.on('data', (b) => got.push(b)); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const d = await mkDriver('openrgb', 'PC', { host: '127.0.0.1', port });
    await mkGroup('Keyboard', d.id, { devices: [{ index: 0, leds: 3 }] });
    assert.equal((await call('POST', `${L()}/groups`, T.dm, { name: 'Bad', driverId: d.id, target: { devices: [] } })).status, 400);
    const t = await ok('POST', `${L()}/drivers/${d.id}/test`, T.dm, { color: '#102030' });
    assert.equal(t.ok, true, JSON.stringify(t));
    await tick(50);
    const all_ = Buffer.concat(got);
    assert.equal(all_.toString('ascii', 0, 4), 'ORGB');
    // 60% brightness test colour: 16, 32, 48 scaled.
    assert.ok(all_.includes(Buffer.from([10, 19, 29, 0, 10, 19, 29, 0, 10, 19, 29, 0])), 'LED colours are in the packet');
    // A port with nothing listening fails fast and is reported, not thrown.
    srv.close();
    const dead = await ok('POST', `${L()}/drivers/${d.id}/test`, T.dm, {});
    assert.equal(dead.ok, false);
  } finally { srv.close(); }
});

test('TestLights_PlayersAreShutOut', async () => {
  for (const [m, u] of [['GET', '/drivers'], ['GET', '/groups'], ['GET', '/scenes'], ['GET', '/hooks'], ['GET', '/status'], ['POST', '/drivers'], ['POST', '/scenes'], ['PUT', '/hooks'], ['POST', '/off']] as const) {
    assert.equal((await call(m, L() + u, T.jess, {})).status, 403, `${m} ${u}`);
  }
  // But a player can pick their own turn colour, and only their own.
  assert.equal((await call('PUT', `${L()}/me`, T.jess, { color: 'nope' })).status, 400);
  assert.equal((await ok('PUT', `${L()}/me`, T.jess, { color: '#00FF00' })).color, '#00ff00');
  assert.equal((await ok('GET', `${L()}/me`, T.jess)).color, '#00ff00');
  assert.equal((await ok('GET', `${L()}/me`, T.tom)).color, null);
});

test('TestLights_HooksAreOffUntilTurnedOnAndFollowTheGame', async () => {
  const w = `/api/worlds/${W}`;
  await ok('PUT', `${L()}/me`, T.jess, { color: null });
  const d = await mkDriver('wled', 'Room strip', { host: 'wled.local' });
  await mkGroup('Room', d.id);
  const fight = await mkScene('Fight', '#ff0000');
  const calm = await mkScene('Calm', '#0000ff');
  const rest = await mkScene('Rest', '#ffaa55', { brightness: 20 });
  const rec = await mkScene('Recording', '#aa00aa');
  const evt = await mkScene('Event', '#00ffff');
  const hooks = await ok('GET', `${L()}/hooks`, T.dm);
  for (const k of Object.keys(hooks)) assert.equal(hooks[k].on, false, `${k} is off by default`);
  await ok('POST', `${w}/live/combatants`, T.dm, { name: 'Brenna', initiative: 18, hp: 30, maxHp: 30, accountId: ID.jess });
  await ok('POST', `${w}/live/combatants`, T.dm, { name: 'Orc', initiative: 10, hp: 20, maxHp: 20 });
  observe(deps, W); // the first look only remembers
  seen.length = 0;

  // Everything off: the game moves and no light does.
  await ok('PUT', `${w}/live/combat`, T.dm, { active: true });
  await ok('POST', `${w}/live/combat/next`, T.dm);
  await ok('POST', `${w}/live/combat/next`, T.dm);
  await ok('POST', `${w}/clock/advance`, T.dm, { preset: 'long-rest' });
  observe(deps, W);
  await tick();
  assert.equal(seen.length, 0, 'hooks off: lights untouched');
  await ok('PUT', `${w}/live/combat`, T.dm, { active: false });
  observe(deps, W);

  // Bad settings are refused.
  assert.equal((await call('PUT', `${L()}/hooks`, T.dm, { combatStart: { on: 'yes' } })).status, 400);
  assert.equal((await call('PUT', `${L()}/hooks`, T.dm, { combatStart: { scene: 'lsc_nothing' } })).status, 400);
  assert.equal((await call('PUT', `${L()}/hooks`, T.dm, { damage: { color: 'red' } })).status, 400);
  assert.equal((await call('PUT', `${L()}/hooks`, T.dm, { turn: { colors: { acc_nobody: '#fff' } } })).status, 400);

  await ok('PUT', `${L()}/hooks`, T.dm, {
    combatStart: { on: true, scene: fight.id }, combatEnd: { on: true, scene: calm.id },
    turn: { on: true, colors: { [ID.jess]: '#112233' }, defaultColor: '#eeeeee', brightness: 100 },
    damage: { on: true, color: '#ff0000', ms: 100 }, longRest: { on: true, scene: rest.id },
    mood: { on: true, brightness: 70 }, recording: { on: true, scene: rec.id }, quickEvent: { on: true, scene: evt.id },
  });
  observe(deps, W);
  seen.length = 0;
  const col = () => lastTo('wled.local')?.body?.seg?.[0]?.col?.[0];

  // Combat starts and ends.
  await ok('PUT', `${w}/live/combat`, T.dm, { active: true });
  observe(deps, W, ['combat']);
  await tick();
  assert.deepEqual(col(), [255, 0, 0], 'combat start scene');
  // A player's turn: the GM's colour for her, her own pick over it.
  await ok('POST', `${w}/live/combat/next`, T.dm); // the orc
  observe(deps, W, ['combat']);
  await tick();
  assert.deepEqual(col(), [238, 238, 238], 'a creature uses the default colour');
  await ok('POST', `${w}/live/combat/next`, T.dm); // Brenna (jess), round 2
  observe(deps, W, ['combat']);
  await tick();
  assert.deepEqual(col(), [0x11, 0x22, 0x33], "the GM's colour for her");
  await ok('PUT', `${L()}/me`, T.jess, { color: '#00ff00' });
  await ok('POST', `${w}/live/combat/next`, T.dm);
  await ok('POST', `${w}/live/combat/next`, T.dm);
  observe(deps, W, ['combat']);
  await tick();
  assert.deepEqual(col(), [0, 255, 0], 'her own pick wins');
  // Damage flashes, then puts the colour back.
  const cb = (await ok('GET', `${w}/live/combat`, T.dm)).combatants.find((x: any) => x.name === 'Brenna');
  const orcRow = (await ok('GET', `${w}/live/combat`, T.dm)).combatants.find((x: any) => x.name === 'Orc');
  await ok('PATCH', `${w}/live/combatants/${orcRow.id}`, T.dm, { damage: 3 });
  observe(deps, W, ['combat']);
  await tick();
  assert.deepEqual(col(), [0, 255, 0], 'monsters do not flash (pcOnly)');
  await ok('PATCH', `${w}/live/combatants/${cb.id}`, T.dm, { damage: 4 });
  observe(deps, W, ['combat']);
  await tick(10);
  assert.deepEqual(col(), [255, 0, 0], 'a hit on a player flashes red');
  await tick(200);
  assert.deepEqual(col(), [0, 255, 0], 'and the colour comes back');
  await ok('PUT', `${w}/live/combat`, T.dm, { active: false });
  observe(deps, W, ['combat']);
  await tick();
  assert.deepEqual(col(), [0, 0, 255], 'combat end scene');

  // Long rest.
  await ok('POST', `${w}/clock/advance`, T.dm, { preset: 'short-rest' });
  observe(deps, W, ['clock']);
  await tick();
  assert.deepEqual(col(), [0, 0, 255], 'a short rest changes nothing');
  await ok('POST', `${w}/clock/advance`, T.dm, { preset: 'long-rest' });
  observe(deps, W, ['clock']);
  await tick();
  assert.deepEqual(col(), [255, 170, 85], 'long rest scene');
  observe(deps, W, ['clock']);
  seen.length = 0;
  observe(deps, W, ['clock']);
  await tick();
  assert.equal(seen.length, 0, 'the same long rest does not fire twice');

  // Music mood: the boss track sits in the combat corner, so the lights go red.
  await ok('POST', `${w}/sound/music/mood`, T.dm, { x: 0.95, y: 0.95 });
  observe(deps, W, ['sound']);
  await tick();
  const mc = col();
  assert.ok(mc[0] > 180 && mc[1] < 90, `combat mood is red: ${mc}`);
  await ok('POST', `${w}/sound/music/mood`, T.dm, { x: 0.05, y: 0.05 });
  observe(deps, W, ['sound']);
  await tick();
  const cc = col();
  assert.ok(cc[2] > cc[0], `calm mood is blue: ${cc}`);

  // Recording on, found through the live hub with no help (the tap is installed).
  const s = await ok('POST', `${w}/audio/sessions`, T.dm, { name: 'Tonight' });
  await tick(60);
  assert.deepEqual(col(), [170, 0, 170], 'recording scene, from the hub');
  await ok('POST', `${w}/audio/sessions/${s.id}/stop`, T.dm);

  // A quick event.
  await ok('POST', `${w}/quick-events`, T.dm, { kind: 'notice', title: 'Noise', prompt: 'Something creaks.' });
  observe(deps, W, ['quick-event']);
  await tick();
  assert.deepEqual(col(), [0, 255, 255], 'quick event scene');
  await ok('PUT', `${L()}/hooks`, T.dm, { combatStart: { on: false }, combatEnd: { on: false }, turn: { on: false }, damage: { on: false }, longRest: { on: false }, mood: { on: false }, recording: { on: false }, quickEvent: { on: false } });
  const status = await ok('GET', `${L()}/status`, T.dm);
  assert.deepEqual(status.hooksOn, []);
  assert.ok(status.drivers.find((x: any) => x.name === 'Room strip').status.ok > 5);
  assert.equal(status.lastScene.name, 'Event');
});

test('TestLights_RateLimitAndDebounceKeepOnlyTheNewest', async () => {
  const d = await mkDriver('wled', 'Busy strip', { host: 'busy.local' });
  const g = await mkGroup('Busy', d.id);
  const scenes = [];
  for (let i = 0; i < 8; i++) scenes.push(await mkScene(`Flicker ${i}`, `#0000${(i * 16 + 15).toString(16).padStart(2, '0')}`));
  deps.env.ALX_LIGHTS_MIN_MS = '250';
  seen.length = 0;
  const t0 = Date.now();
  for (const s of scenes) await ok('POST', `${L()}/scenes/${s.id}/run`, T.dm);
  const sentNow = seen.filter((x) => x.url.includes('busy.local')).length;
  assert.ok(Date.now() - t0 < 250, 'the requests themselves were quick');
  assert.equal(sentNow, 1, 'one update goes out at once, the rest wait for the next slot');
  await tick(320);
  const sent = seen.filter((x) => x.url.includes('busy.local'));
  assert.equal(sent.length, 2, 'then one more, with the newest state');
  assert.deepEqual(sent[1].body.seg[0].col, [[0, 0, 7 * 16 + 15]]);
  // Over a longer stretch it never goes above four a second.
  seen.length = 0;
  const t1 = Date.now();
  while (Date.now() - t1 < 1000) { await ok('POST', `${L()}/scenes/${scenes[Date.now() % 8].id}/run`, T.dm); await tick(15); }
  await tick(300);
  const n = seen.filter((x) => x.url.includes('busy.local')).length;
  assert.ok(n <= 6 && n >= 3, `about four a second, got ${n} in 1.3 s`);
  assert.ok((await ok('GET', `${L()}/status`, T.dm)).drivers.find((x: any) => x.id === d.id).status.dropped > 0);
  deps.env.ALX_LIGHTS_MIN_MS = '0';
  await ok('DELETE', `${L()}/groups/${g.id}`, T.dm);
  await ok('DELETE', `${L()}/drivers/${d.id}`, T.dm);
});

test('TestLights_ADownOrHangingLightNeverBreaksTheGame', async () => {
  const w = `/api/worlds/${W}`;
  const d = await mkDriver('wled', 'Flaky', { host: 'flaky.local' });
  await mkGroup('Flaky group', d.id);
  const sc = await mkScene('Boom', '#ff00ff');
  await ok('PUT', `${L()}/hooks`, T.dm, { combatStart: { on: true, scene: sc.id }, combatEnd: { on: true, scene: sc.id } });
  observe(deps, W);
  // Down: the scene run and the game action both succeed; the failure is only counted.
  mode = 'fail';
  let r = await call('POST', `${L()}/scenes/${sc.id}/run`, T.dm);
  assert.equal(r.status, 200);
  await ok('PUT', `${w}/live/combat`, T.dm, { active: true });
  observe(deps, W, ['combat']);
  const act = await call('POST', `/api/worlds/${W}/actions/run`, T.dm, { action: 'combat.next' });
  assert.equal(act.status, 200, 'a game action is unaffected by a failing light');
  await tick(50);
  let st = (await ok('GET', `${L()}/status`, T.dm)).drivers.find((x: any) => x.id === d.id).status;
  assert.ok(st.failed >= 1);
  assert.match(st.lastError, /500/);
  // Hanging: the request is cut off after a second, and nothing waited for it.
  mode = 'hang';
  const t0 = Date.now();
  r = await call('POST', `${L()}/scenes/${sc.id}/run`, T.dm);
  assert.equal(r.status, 200);
  await ok('PUT', `${w}/live/combat`, T.dm, { active: false });
  observe(deps, W, ['combat']);
  const act2 = await call('POST', `/api/worlds/${W}/actions/run`, T.dm, { action: 'combat.start' });
  assert.equal(act2.status, 200);
  assert.ok(Date.now() - t0 < 500, 'the game never waited on a hung light');
  const before = st.failed;
  await tick(1200);
  st = (await ok('GET', `${L()}/status`, T.dm)).drivers.find((x: any) => x.id === d.id).status;
  assert.ok(st.failed > before, 'the hung request timed out and was counted');
  assert.match(st.lastError, /no answer|timed out|abort/i);
  mode = 'ok';
  // A scene that no longer exists, and a deleted driver, are quiet too.
  await ok('DELETE', `${L()}/scenes/${sc.id}`, T.dm);
  observe(deps, W, ['combat']);
  await ok('PUT', `${w}/live/combat`, T.dm, { active: false });
  observe(deps, W, ['combat']);
  await ok('PUT', `${L()}/hooks`, T.dm, { combatStart: { on: false }, combatEnd: { on: false } });
});
