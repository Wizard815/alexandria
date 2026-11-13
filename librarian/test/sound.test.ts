// Sound: libraries, mood map, file access, players' switches, uploads, Spotify.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.ts';
import { toneWav, listen, wait, baseOf } from './soundTone.ts';

let base = '';
let server: any;
let tmp = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const S = () => `/api/worlds/${W}/sound`;
const spotifyCalls: { url: string; method: string; body: string; auth?: string }[] = [];
let playStatus = 204;

async function call(method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const raw = body instanceof Uint8Array;
  const r = await fetch(base + url, {
    method,
    headers: { ...(raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : raw ? (body as any) : JSON.stringify(body),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString()); } catch { /* binary */ }
  return { status: r.status, body: json, headers: r.headers, buf };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${r.buf.toString().slice(0, 200)}`);
  return r.body;
};
const put = (rel: string, buf = toneWav()) => { fs.mkdirSync(path.dirname(path.join(tmp, 'data', rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, 'data', rel), buf); };

// Pretends to be Spotify.
const fakeFetch: typeof fetch = async (input: any, init: any = {}) => {
  const u = String(input);
  const body = String(init.body ?? '');
  if (u.startsWith('https://accounts.spotify.com/api/token')) {
    spotifyCalls.push({ url: u, method: init.method, body });
    const f = new URLSearchParams(body);
    if (f.get('grant_type') === 'authorization_code') {
      if (f.get('code') !== 'good-code' || !f.get('code_verifier')) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      return new Response(JSON.stringify({ access_token: 'acc-1', refresh_token: 'ref-1', expires_in: 3600 }));
    }
    if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'ref-1') return new Response(JSON.stringify({ access_token: 'acc-2', expires_in: 3600 }));
    return new Response('{}', { status: 400 });
  }
  if (u.startsWith('https://api.spotify.com/v1/me/player/play')) {
    spotifyCalls.push({ url: u, method: init.method, body, auth: init.headers?.Authorization });
    if (init.headers?.Authorization === 'Bearer acc-1' && playStatus === 401) return new Response(null, { status: 401 });
    return new Response(null, { status: playStatus === 401 ? 204 : playStatus });
  }
  throw new Error(`unexpected fetch ${u}`);
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-snd-'));
  put('music/village/market/bazaar.wav');
  put('music/village/calm/meadow.wav');
  put('music/combat/boss.wav');
  put('music/dungeon/calm/drip.wav');
  put('music/dungeon/combat/clash.wav');
  put('music/dungeon/odd.wav');
  fs.writeFileSync(path.join(tmp, 'data/music/dungeon/moods.yaml'), '# spots\n"odd.wav": {x: 0.1, y: 0.9}\n');
  put('ambience/rain/rain.wav');
  put('ambience/tavern/chatter.wav');
  put('sfx/doors/creak.wav');
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: {}, fetch: fakeFetch });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = baseOf(server);
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Soundland', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const lib = async () => ok('GET', `${S()}/library`, T.dm);
const trackId = async (p: string) => (await lib()).music.find((t: any) => t.path === p).id as string;

test('TestSound_MusicIndexAndMoods', async () => {
  const l = await lib();
  assert.deepEqual(l.areas, ['combat', 'dungeon', 'village']);
  const t = (p: string) => l.music.find((x: any) => x.path === p);
  assert.equal(t('village/market/bazaar.wav').sub, 'market');
  assert.equal(t('village/market/bazaar.wav').mood, null);
  assert.equal(t('village/market/bazaar.wav').duration, 1);
  const boss = t('combat/boss.wav').mood;
  assert.ok(boss.src === 'folder' && boss.x > 0.7 && boss.y > 0.7, 'combat folder = combat corner');
  const drip = t('dungeon/calm/drip.wav').mood;
  assert.ok(drip.x < 0.3 && drip.y < 0.3, 'calm folder = calm corner');
  assert.deepEqual({ ...t('dungeon/odd.wav').mood }, { x: 0.1, y: 0.9, src: 'yaml' });
  assert.deepEqual(l.layers, ['rain', 'tavern']);
  assert.deepEqual(l.banks, ['doors']);
});

test('TestSound_MoodPickPlaysNearestAndCrossfades', async () => {
  let r = await ok('POST', `${S()}/music/mood`, T.dm, { x: 0.95, y: 0.95 });
  assert.equal(r.changed, true);
  assert.ok(['combat/boss.wav', 'dungeon/combat/clash.wav'].includes(r.track.path));
  assert.equal(r.fadeMs, 4000);
  r = await ok('POST', `${S()}/music/mood`, T.dm, { x: 0.95, y: 0.95, area: 'dungeon' });
  assert.equal(r.track.path, 'dungeon/combat/clash.wav');
  // Same spot again: nothing changes, no new crossfade.
  const again = await ok('POST', `${S()}/music/mood`, T.dm, { x: 0.9, y: 0.9, area: 'dungeon' });
  assert.equal(again.changed, false);
  r = await ok('POST', `${S()}/music/mood`, T.dm, { x: 0.05, y: 0.05, area: 'dungeon' });
  assert.equal(r.track.path, 'dungeon/calm/drip.wav');
  // Sneaky corner finds the yaml spot.
  r = await ok('POST', `${S()}/music/mood`, T.dm, { x: 0.05, y: 0.95, area: 'dungeon' });
  assert.equal(r.track.path, 'dungeon/odd.wav');
  // The DM can move a track.
  const id = await trackId('village/market/bazaar.wav');
  await ok('PUT', `${S()}/tracks/${id}/mood`, T.dm, { x: 0.5, y: 0.5 });
  r = await ok('POST', `${S()}/music/mood`, T.dm, { x: 0.5, y: 0.5, area: 'village' });
  assert.equal(r.track.path, 'village/market/bazaar.wav');
  assert.equal((await call('POST', `${S()}/music/mood`, T.dm, { x: 2, y: 0 })).status, 400);
  const none = await ok('POST', `${S()}/music/mood`, T.dm, { x: 0.5, y: 0.5, area: 'nowhere' });
  assert.equal(none.track, null);
  await ok('POST', `${S()}/music/stop`, T.dm, {});
});

test('TestSound_PlayerCannotFetchWhatIsNotPlaying', async () => {
  const id = await trackId('combat/boss.wav');
  const file = `${S()}/file/music/${id}`;
  assert.equal((await call('GET', file, T.dm)).status, 200);
  assert.equal((await call('GET', file, T.jess)).status, 404, 'nothing is playing');
  await ok('POST', `${S()}/music/play`, T.dm, { trackId: id, target: 'table' });
  assert.equal((await call('GET', file, T.jess)).status, 404, 'table only');
  await ok('POST', `${S()}/music/play`, T.dm, { trackId: id, target: 'both' });
  const got = await call('GET', file, T.jess);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'audio/wav');
  // A ticket lets an <audio> tag play it, and stops working when the DM moves on.
  const tk = await ok('GET', `${file}/ticket`, T.jess);
  assert.match(tk.url, /^\/api\/media\/sound\//);
  assert.equal((await call('GET', tk.url)).status, 200);
  assert.equal((await call('GET', tk.url + 'x')).status, 404, 'a forged ticket');
  assert.equal((await call('GET', `${S()}/file/music/${await trackId('dungeon/odd.wav')}/ticket`, T.jess)).status, 404, 'no ticket for what is not playing');
  // Another track stays closed, and so does a file of another kind under the wrong path.
  const other = await trackId('dungeon/odd.wav');
  assert.equal((await call('GET', `${S()}/file/music/${other}`, T.jess)).status, 404);
  assert.equal((await call('GET', `${S()}/file/sfx/${id}`, T.dm)).status, 404);
  assert.equal((await call('GET', `${S()}/file/music/../../etc/passwd`, T.dm)).status, 404);
  // Range.
  const part = await call('GET', file, T.jess, undefined, { Range: 'bytes=0-99' });
  assert.equal(part.status, 206);
  assert.equal(part.buf.length, 100);
  assert.match(part.headers.get('content-range')!, /^bytes 0-99\/\d+$/);
  assert.equal((await call('GET', file, T.jess, undefined, { Range: 'bytes=999999-' })).status, 416);
  // No sign-in, no file.
  assert.equal((await call('GET', file)).status, 401);
  // Playing something else closes the first one again; stopping closes all.
  await ok('POST', `${S()}/music/play`, T.dm, { trackId: other, target: 'both' });
  assert.equal((await call('GET', file, T.jess)).status, 404);
  assert.equal((await call('GET', `${S()}/file/music/${other}`, T.jess)).status, 200);
  assert.equal((await call('GET', tk.url)).status, 404, 'the ticket stops working once the track is replaced');
  await ok('POST', `${S()}/music/stop`, T.dm, {});
  assert.equal((await call('GET', `${S()}/file/music/${other}`, T.jess)).status, 404);
  // A sound effect is open to players for a while after the DM sends it to devices.
  const sfx = (await lib()).sfx[0].id;
  assert.equal((await call('GET', `${S()}/file/sfx/${sfx}`, T.jess)).status, 404);
  await ok('POST', `${S()}/sfx/play`, T.dm, { id: sfx, target: 'players' });
  assert.equal((await call('GET', `${S()}/file/sfx/${sfx}`, T.jess)).status, 200);
});

test('TestSound_SwitchesListenersAndLiveEvents', async () => {
  const dev = 'device-jess-phone';
  const sw = await ok('GET', `${S()}/me/switches?device=${dev}`, T.jess);
  assert.deepEqual([sw.music, sw.ambience, sw.sfx], [false, false, false], 'all start off');
  assert.deepEqual(await ok('GET', `${S()}/listeners`, T.dm), []);

  const jess = await listen(base, W, T.jess);
  const tom = await listen(base, W, T.tom);
  const dm = await listen(base, W, T.dm);
  await wait();
  const id = await trackId('combat/boss.wav');
  await ok('POST', `${S()}/music/play`, T.dm, { trackId: id, target: 'both' });
  await wait();
  assert.equal(jess.events.filter((e) => e.type === 'sound').length, 0, 'switch off: nothing sent');
  assert.equal(dm.events.filter((e) => e.type === 'sound').length, 1);

  await ok('PUT', `${S()}/me/switches`, T.jess, { device: dev, music: true, label: 'Phone', volumes: { music: 0.5 } });
  const ls = await ok('GET', `${S()}/listeners`, T.dm);
  assert.equal(ls.length, 1);
  assert.equal(ls[0].name, 'jess');
  assert.equal(ls[0].music, true);
  assert.equal(ls[0].sfx, false);
  assert.equal(ls[0].volumes.music, 0.5);
  assert.ok(dm.events.some((e) => e.type === 'sound-listeners'));
  // She catches up with what is already playing.
  const now = await ok('GET', `${S()}/now`, T.jess);
  assert.equal(now.music.id, id);

  await ok('POST', `${S()}/music/play`, T.dm, { trackId: await trackId('dungeon/odd.wav'), target: 'players', fadeMs: 2000 });
  await ok('POST', `${S()}/music/play`, T.dm, { trackId: id, target: 'table' });
  await wait();
  const ev = jess.events.filter((e) => e.type === 'sound');
  assert.equal(ev.length, 1, 'only the players-targeted play reaches her; the table-only one does not');
  assert.equal(ev[0].data.channel, 'music');
  assert.equal(ev[0].data.target, 'players');
  assert.equal(ev[0].data.fadeMs, 2000);
  assert.match(ev[0].data.url, new RegExp(`^/api/worlds/${W}/sound/file/music/`));
  assert.equal(tom.events.filter((e) => e.type === 'sound').length, 0, 'tom has everything off');
  // Players' /now hides table-only music.
  assert.equal((await ok('GET', `${S()}/now`, T.jess)).music, null);
  // Sound effects follow the sfx switch only.
  const sfx = (await lib()).sfx[0].id;
  await ok('POST', `${S()}/sfx/play`, T.dm, { id: sfx, target: 'players' });
  await wait();
  assert.equal(jess.events.filter((e) => e.type === 'sound').length, 1);
  await ok('PUT', `${S()}/me/switches`, T.jess, { device: dev, sfx: true });
  await ok('POST', `${S()}/sfx/play`, T.dm, { id: sfx, target: 'players' });
  await wait();
  assert.equal(jess.events.filter((e) => e.type === 'sound').length, 2);
  assert.equal((await call('PUT', `${S()}/me/switches`, T.jess, { device: 'x' })).status, 400);
  jess.stop(); tom.stop(); dm.stop();
  await ok('POST', `${S()}/music/stop`, T.dm, {});
});

test('TestSound_AmbienceScenesAndPads', async () => {
  const r = await ok('POST', `${S()}/ambience/scene`, T.dm, { layers: [{ kind: 'rain', volume: 0.4 }, { kind: 'tavern', volume: 0.7 }, { kind: 'volcano', volume: 1 }], target: 'both' });
  assert.deepEqual(r.layers.map((l: any) => l.kind), ['rain', 'tavern']);
  assert.deepEqual(r.missing, ['volcano']);
  assert.equal(r.events[0].loop, true);
  const rainId = (await lib()).ambience.find((a: any) => a.layer === 'rain').id;
  assert.equal((await call('GET', `${S()}/file/ambience/${rainId}`, T.tom)).status, 200);
  const scene = await ok('POST', `${S()}/scenes`, T.dm, { name: 'Stormy night', area: 'village', layers: [{ kind: 'rain', volume: 0.4 }] });
  assert.equal((await ok('GET', `${S()}/scenes`, T.dm)).length, 1);
  const played = await ok('POST', `${S()}/scenes/${scene.id}/play`, T.dm, {});
  const stops = played.events.filter((e: any) => e.action === 'stop');
  assert.equal(stops.length, 1, 'the tavern layer fades out');
  assert.equal((await call('GET', `${S()}/file/ambience/${rainId}`, T.tom)).status, 404, 'table only now');
  await ok('PUT', `${S()}/scenes/${scene.id}`, T.dm, { name: 'Storm' });
  await ok('DELETE', `${S()}/scenes/${scene.id}`, T.dm);
  await ok('POST', `${S()}/ambience/stop`, T.dm, {});

  const sfx = (await lib()).sfx[0].id;
  assert.equal((await call('POST', `${S()}/pads`, T.dm, { label: 'Bad', file: 'nope' })).status, 400);
  const pad = await ok('POST', `${S()}/pads`, T.dm, { label: 'Door creak', file: sfx, key: '1', volume: 0.6, loop: false, target: 'both' });
  assert.equal(pad.bank, 'doors');
  await ok('PUT', `${S()}/pads/${pad.id}`, T.dm, { volume: 0.3 });
  const played2 = await ok('POST', `${S()}/sfx/play`, T.dm, { padId: pad.id });
  assert.equal(played2.event.volume, 0.3);
  assert.equal(played2.event.target, 'both');
  assert.equal((await ok('GET', `${S()}/pads`, T.dm))[0].key, '1');
  await ok('DELETE', `${S()}/pads/${pad.id}`, T.dm);
});

test('TestSound_UploadChecksMagicBytesAndSize', async () => {
  assert.equal((await call('POST', `${S()}/upload?kind=sfx&bank=Thunder&name=boom`, T.dm, Buffer.from('#!/bin/sh\necho not audio at all\n'))).status, 415);
  assert.equal((await call('POST', `${S()}/upload?kind=sfx&name=boom`, T.jess, new Uint8Array(toneWav()))).status, 403);
  const up = await call('POST', `${S()}/upload?kind=sfx&bank=Thunder&name=boom.mp3`, T.dm, new Uint8Array(toneWav()));
  assert.equal(up.status, 201, up.buf.toString());
  assert.equal(up.body.bank, 'Thunder');
  assert.ok(fs.existsSync(path.join(tmp, 'data/sfx/Thunder/boom.wav')), 'named by what the bytes are, not what the name says');
  const up2 = await call('POST', `${S()}/upload?kind=ambience&bank=Cave&name=drips`, T.dm, new Uint8Array(toneWav()));
  assert.equal(up2.status, 201);
  assert.equal(up2.body.layer, 'cave');
  assert.ok((await lib()).layers.includes('cave'));
  // Over the limit.
  const big = Buffer.concat([toneWav(), Buffer.alloc(11 * 1024 * 1024)]);
  assert.equal((await call('POST', `${S()}/upload?kind=sfx&name=huge`, T.dm, new Uint8Array(big))).status, 413);
  // Folder names cannot climb out.
  const evil = await call('POST', `${S()}/upload?kind=sfx&bank=../../evil&name=x`, T.dm, new Uint8Array(toneWav()));
  assert.equal(evil.status, 201);
  assert.ok(!fs.existsSync(path.join(tmp, 'evil')));
  fs.rmSync(path.join(tmp, 'data/sfx/Thunder'), { recursive: true });
  assert.equal((await ok('POST', `${S()}/rescan`, T.dm)).sfx >= 1, true);
});

test('TestSound_SpotifyFlowWithFakeFetch', async () => {
  const cb = `${S()}/spotify`;
  assert.equal((await call('POST', `${cb}/login`, T.dm, { redirectUri: 'http://localhost/cb' })).status, 400, 'needs a client id first');
  await ok('PUT', cb, T.dm, { clientId: 'abcd1234efgh5678' });
  const { url } = await ok('POST', `${cb}/login`, T.dm, { redirectUri: 'http://localhost:5173/w/x/dm/sound' });
  const q = new URL(url).searchParams;
  assert.equal(new URL(url).origin + new URL(url).pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('client_id'), 'abcd1234efgh5678');
  assert.match(q.get('scope')!, /user-modify-playback-state/);
  assert.equal((await call('POST', `${cb}/callback`, T.dm, { code: 'good-code', state: 'wrong' })).status, 400);
  const st = await ok('POST', `${cb}/callback`, T.dm, { code: 'good-code', state: q.get('state') });
  assert.equal(st.connected, true);
  assert.ok(!JSON.stringify(st).includes('ref-1') && !JSON.stringify(st).includes('acc-1'), 'tokens never leave the server');
  const exchange = spotifyCalls.find((c) => c.body.includes('authorization_code'))!;
  assert.equal(new URLSearchParams(exchange.body).get('code_verifier')!.length >= 43, true);

  assert.equal((await call('PUT', `${cb}/events`, T.dm, { events: { combat: 'not a playlist' } })).status, 400);
  const ev = await ok('PUT', `${cb}/events`, T.dm, { events: { Combat: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc', tavern: 'spotify:playlist:1111111111aaaaaaaaaa' } });
  assert.equal(ev.events.combat, 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');

  spotifyCalls.length = 0;
  await ok('POST', `${cb}/play`, T.dm, { event: 'combat' });
  const play = spotifyCalls.find((c) => c.url.includes('/me/player/play'))!;
  assert.equal(play.method, 'PUT');
  assert.equal(play.auth, 'Bearer acc-1');
  assert.deepEqual(JSON.parse(play.body), { context_uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M' });
  assert.equal((await call('POST', `${cb}/play`, T.dm, { event: 'nothing' })).status, 404);

  // An expired token is refreshed once and the call retried.
  playStatus = 401;
  spotifyCalls.length = 0;
  await ok('POST', `${cb}/play`, T.dm, { event: 'tavern' });
  assert.ok(spotifyCalls.some((c) => c.body.includes('refresh_token')));
  assert.equal(spotifyCalls.filter((c) => c.url.includes('/play')).at(-1)!.auth, 'Bearer acc-2');
  // No device.
  playStatus = 404;
  const nodev = await call('POST', `${cb}/play`, T.dm, { event: 'tavern' });
  assert.equal(nodev.status, 409);
  assert.match(nodev.body.error, /active device/);
  playStatus = 204;

  // Spotify is DM only and never produces a live event for players.
  const tom = await listen(base, W, T.tom);
  await wait();
  await ok('POST', `${cb}/play`, T.dm, { event: 'combat' });
  await wait();
  assert.equal(tom.events.length, 0);
  tom.stop();
  for (const [m, p, b] of [['GET', cb], ['PUT', cb, { clientId: 'abcd1234efgh5678' }], ['POST', `${cb}/play`, { event: 'combat' }], ['PUT', `${cb}/events`, { events: {} }], ['POST', `${cb}/login`, { redirectUri: 'http://x.test/' }]] as const) {
    assert.equal((await call(m, p, T.jess, b)).status, 403, `${m} ${p}`);
  }
  assert.equal((await ok('DELETE', cb, T.dm)).connected, false);
  assert.equal((await call('POST', `${cb}/play`, T.dm, { event: 'combat' })).status, 409);
});

test('TestSound_PlayersCannotUseDMEndpoints', async () => {
  const id = await trackId('combat/boss.wav');
  const sfx = (await lib()).sfx[0].id;
  const calls: [string, string, unknown?][] = [
    ['GET', '/library'], ['POST', '/rescan'], ['PUT', `/tracks/${id}/mood`, { x: 0, y: 0 }],
    ['POST', '/music/play', { trackId: id }], ['POST', '/music/mood', { x: 0.5, y: 0.5 }], ['POST', '/music/stop', {}],
    ['POST', '/ambience/scene', { layers: [] }], ['POST', '/ambience/stop', {}], ['GET', '/scenes'], ['POST', '/scenes', { name: 'x', layers: [] }],
    ['POST', '/sfx/play', { id: sfx }], ['POST', '/sfx/stop', { id: sfx }], ['GET', '/pads'], ['POST', '/pads', { file: sfx }],
    ['POST', '/upload?kind=sfx&name=x', new Uint8Array(toneWav())], ['GET', '/listeners'],
  ];
  for (const [m, p, b] of calls) assert.equal((await call(m, S() + p, T.jess, b)).status, 403, `${m} ${p}`);
});
