// Read aloud: presets, speaking with a fake TTS, DM-only text confirmation.
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
let ttsDown = false;
const ttsCalls: any[] = [];
const V = () => `/api/worlds/${W}/voice`;

const fakeFetch: typeof fetch = async (input: any, init: any = {}) => {
  const u = String(input);
  if (u === 'http://tts.test/v1/audio/speech') {
    if (ttsDown) return new Response('boom', { status: 500 });
    ttsCalls.push(JSON.parse(init.body));
    return new Response(new Uint8Array(toneWav()), { headers: { 'content-type': 'audio/wav' } });
  }
  throw new Error(`unexpected fetch ${u}`);
};

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await r.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString()); } catch { /* binary */ }
  return { status: r.status, body: json, buf, headers: r.headers };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${r.buf.toString().slice(0, 200)}`);
  return r.body;
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-voice-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_MODEL_VOICE_URL: 'http://tts.test/v1', ALX_MODEL_VOICE_MODEL: 'kokoro', ALX_ADMIN_TABLE_LOGIN: '1' }, fetch: fakeFetch });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = baseOf(server);
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Voiceland', dmAccountId: ID.dm })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'jess' });
  T.jess = j.token;
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'places/Saltmarsh', visibility: 'party', markdown: `---\nknowledge: local\n---\n# Saltmarsh\nSaltmarsh is a fishing town ruled by the harbour council.\n\n> [!secret] DM\n> The harbour council secretly answers to the smuggler queen Velmira.\n` });
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'dm/Plans', visibility: 'dm', markdown: `# Plans\nThe lich awakens beneath the old chapel on midsummer night.\n` });
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('TestVoice_PresetsCrud', async () => {
  const p = await ok('POST', `${V()}/presets`, T.dm, { name: 'Narrator', voice: 'bm_george', speed: 0.9, pitch: 0.8, effect: 'echo', target: 'both' });
  assert.equal(p.effect, 'echo');
  assert.equal((await call('POST', `${V()}/presets`, T.dm, { name: 'Bad', effect: 'robot' })).status, 400);
  assert.equal((await call('POST', `${V()}/presets`, T.dm, { name: 'Bad', speed: 9 })).status, 400);
  await ok('PUT', `${V()}/presets/${p.id}`, T.dm, { speed: 1.1 });
  const list = await ok('GET', `${V()}/presets`, T.dm);
  assert.equal(list.length, 1);
  assert.equal(list[0].speed, 1.1);
  assert.equal(list[0].name, 'Narrator');
  await ok('POST', `${V()}/presets`, T.dm, { name: 'Villain', effect: 'radio', target: 'table' });
});

test('TestVoice_SpeakWithFakeTtsStoresAudioAndEmitsEvent', async () => {
  const [narrator, villain] = [(await ok('GET', `${V()}/presets`, T.dm)).find((p: any) => p.name === 'Narrator'), (await ok('GET', `${V()}/presets`, T.dm)).find((p: any) => p.name === 'Villain')];
  const dm = await listen(base, W, T.dm);
  const jess = await listen(base, W, T.jess);
  await wait();
  const r = await ok('POST', `${V()}/speak`, T.dm, { text: 'You enter the misty valley.', presetId: villain.id });
  assert.equal(ttsCalls.at(-1).input, 'You enter the misty valley.');
  assert.equal(ttsCalls.at(-1).response_format, 'wav');
  assert.equal(r.event.channel, 'voice');
  assert.equal(r.event.effect, 'radio');
  assert.equal(r.event.target, 'table');
  assert.ok(fs.existsSync(path.join(tmp, 'data/voice', r.file)));
  // The DM can fetch the line; a player cannot (table only).
  const f = await call('GET', `${V()}/file/${r.file}`, T.dm);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'audio/wav');
  assert.equal((await call('GET', `${V()}/file/${r.file}`, T.jess)).status, 404);
  // Sent to players: only a player whose sound-effects switch is on hears it live.
  const r2 = await ok('POST', `${V()}/speak`, T.dm, { text: 'Welcome, travellers.', presetId: narrator.id });
  assert.equal(r2.event.target, 'both');
  assert.equal((await call('GET', `${V()}/file/${r2.file}`, T.jess)).status, 200);
  assert.equal((await call('GET', `${V()}/file/..%2F..%2Fx.wav`, T.dm)).status, 404);
  const tk = await ok('GET', `${V()}/file/${r2.file}/ticket`, T.jess);
  assert.equal((await call('GET', tk.url)).status, 200);
  assert.equal((await call('GET', `${V()}/file/${r.file}/ticket`, T.jess)).status, 404, 'a table-only line gets no ticket');
  await wait();
  assert.equal(dm.events.filter((e) => e.type === 'sound').length, 2);
  assert.equal(jess.events.filter((e) => e.type === 'sound').length, 0, 'her switch is off');
  await ok('PUT', `/api/worlds/${W}/sound/me/switches`, T.jess, { device: 'jess-laptop-1', sfx: true });
  await ok('POST', `${V()}/speak`, T.dm, { text: 'Welcome again.', presetId: narrator.id });
  await wait();
  assert.equal(jess.events.filter((e) => e.type === 'sound').length, 1);
  // A target given with the request beats the preset's.
  const r3 = await ok('POST', `${V()}/speak`, T.dm, { text: 'Only for me.', presetId: narrator.id, target: 'table' });
  assert.equal((await call('GET', `${V()}/file/${r3.file}`, T.jess)).status, 404);
  dm.stop(); jess.stop();
});

test('TestVoice_DmOnlyTextNeedsConfirmBeforePlayers', async () => {
  const presets = await ok('GET', `${V()}/presets`, T.dm);
  const narrator = presets.find((p: any) => p.name === 'Narrator');
  const villain = presets.find((p: any) => p.name === 'Villain');
  const secret = 'The harbour council secretly answers to the smuggler queen Velmira.';
  const before = ttsCalls.length;
  const blocked = await call('POST', `${V()}/speak`, T.dm, { text: secret, presetId: narrator.id });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.needsConfirm, true);
  assert.equal(ttsCalls.length, before, 'nothing is spoken until the DM confirms');
  // A part of a DM-only page counts, even inside longer text.
  assert.equal((await call('POST', `${V()}/speak`, T.dm, { text: `Listen closely. ${secret} Tell no one.`, presetId: narrator.id })).status, 409);
  assert.equal((await call('POST', `${V()}/speak`, T.dm, { text: 'The lich awakens beneath the old chapel on midsummer night.', presetId: narrator.id })).status, 409, 'a DM-only page');
  // Text players can read is fine.
  await ok('POST', `${V()}/speak`, T.dm, { text: 'Saltmarsh is a fishing town ruled by the harbour council.', presetId: narrator.id });
  // To the table only needs no confirmation; confirm: true lets it through to players.
  await ok('POST', `${V()}/speak`, T.dm, { text: secret, presetId: villain.id });
  await ok('POST', `${V()}/speak`, T.dm, { text: secret, presetId: narrator.id, confirm: true });
  assert.equal((await call('POST', `${V()}/speak`, T.dm, { text: secret, presetId: narrator.id, confirm: 'yes' })).status, 409);
});

test('TestVoice_NoModelIsAClear503', async () => {
  const presets = await ok('GET', `${V()}/presets`, T.dm);
  ttsDown = true;
  const down = await call('POST', `${V()}/speak`, T.dm, { text: 'Hello.', presetId: presets[0].id });
  assert.equal(down.status, 503);
  assert.match(down.body.error, /not available/);
  ttsDown = false;
  // A world whose app has no voice model at all.
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data2'), vaultsDir: path.join(tmp, 'vaults2'), env: { ALX_ADMIN_TABLE_LOGIN: '1' }, fetch: fakeFetch });
  const s2: any = made.app.listen(0);
  await new Promise((r) => s2.once('listening', r));
  const b2 = baseOf(s2);
  const hdr = (t?: string, json = true) => ({ ...(json ? { 'Content-Type': 'application/json' } : {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) });
  const adm = (await (await fetch(b2 + '/api/setup', { method: 'POST', headers: hdr(), body: JSON.stringify({ username: 'wizard', password: 'correct horse battery' }) })).json()).token;
  const acc = await (await fetch(b2 + '/api/admin/accounts', { method: 'POST', headers: hdr(adm), body: JSON.stringify({ username: 'dm2', password: 'dm password 123' }) })).json();
  const w2 = await (await fetch(b2 + '/api/admin/worlds', { method: 'POST', headers: hdr(adm), body: JSON.stringify({ name: 'Quietland', dmAccountId: acc.account.id }) })).json();
  const dmTok = (await (await fetch(b2 + '/api/auth/login', { method: 'POST', headers: hdr(), body: JSON.stringify({ username: 'dm2', password: 'dm password 123' }) })).json()).token;
  const pr = await (await fetch(`${b2}/api/worlds/${w2.id}/voice/presets`, { method: 'POST', headers: hdr(dmTok), body: JSON.stringify({ name: 'Narrator' }) })).json();
  const r = await fetch(`${b2}/api/worlds/${w2.id}/voice/speak`, { method: 'POST', headers: hdr(dmTok), body: JSON.stringify({ text: 'Hello there.', presetId: pr.id }) });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /No model is set/);
  s2.close();
});

test('TestVoice_PlayersCannotCallDMEndpoints', async () => {
  const presets = await ok('GET', `${V()}/presets`, T.dm);
  const calls: [string, string, unknown?][] = [
    ['GET', '/presets'], ['POST', '/presets', { name: 'x' }], ['PUT', `/presets/${presets[0].id}`, { name: 'y' }], ['DELETE', `/presets/${presets[0].id}`],
    ['POST', '/speak', { text: 'hello there', presetId: presets[0].id }],
  ];
  for (const [m, p, b] of calls) assert.equal((await call(m, V() + p, T.jess, b)).status, 403, `${m} ${p}`);
  assert.equal((await call('POST', `${V()}/speak`, undefined, { text: 'hi' })).status, 401);
});
