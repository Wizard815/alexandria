// The assistant's read-aloud endpoint and the chat list: the voice job turns a reply into audio for the DM's own device
// only, the markdown is stripped and capped first, and every account sees only its own chats.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { speakable, SPEAK_MAX } from '../src/features/agent/speakable.ts';

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

async function boot(withVoice: boolean) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-agspeech-'));
  const tts: any[] = [];
  const fake = (async (url: any, init?: any) => {
    const u = String(url);
    if (u === 'http://tts.test/v1/audio/speech') { tts.push(JSON.parse(init.body)); return new Response(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]), { headers: { 'content-type': 'audio/mpeg' } }); }
    return fetch(url, init);
  }) as typeof fetch;
  const env: Record<string, string> = { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ...(withVoice ? { ALX_MODEL_VOICE_URL: 'http://tts.test/v1', ALX_MODEL_VOICE_MODEL: 'kokoro' } : {}) };
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env, fetch: fake });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => { server.close(); server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const call = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const buf = Buffer.from(await r.arrayBuffer());
    let json: any = null;
    try { json = JSON.parse(buf.toString()); } catch { /* binary */ }
    return { status: r.status, body: json, buf, type: r.headers.get('content-type') ?? '' };
  };
  const ok = async (method: string, url: string, token?: string, body?: unknown) => { const r = await call(method, url, token, body); assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${r.buf.toString().slice(0, 200)}`); return r.body; };
  const admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dmAcct = await ok('POST', '/api/admin/accounts', admin, { username: 'dungeon', password: 'dm password 123' });
  const dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  const W = (await ok('POST', '/api/admin/worlds', admin, { name: 'Speechland', dmAccountId: dmAcct.account.id })).id;
  const players: Record<string, string> = {};
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, dm, { role: 'player' });
    players[name] = (await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name })).token;
  }
  return { call, ok, W, dm, jess: players.jess, tom: players.tom, tts, deps: made.deps };
}

const voice = await boot(true);
const mute = await boot(false);

test('TestAgentSpeech_StripsMarkdownAndCapsLength', () => {
  assert.equal(speakable('## Plan\n\n- **Bold** move at [[Saltmarsh|the town]]\n- see [the map](https://x.test/m) and `code`\n\n```js\nsecret()\n```'), 'Plan Bold move at the town see the map and code');
  assert.equal(speakable('***'), '');
  const long = 'A sentence that goes on a bit. '.repeat(100);
  const cut = speakable(long);
  assert.ok(cut.length <= SPEAK_MAX && cut.endsWith('.'), `${cut.length}`);
});

test('TestAgentSpeech_DmGetsAudioFromTheVoiceJob', async () => {
  const r = await voice.call('POST', `/api/worlds/${voice.W}/agent/speak`, voice.dm, { text: '**The vault** is under [[Saltmarsh]]. ' + 'x'.repeat(3000) });
  assert.equal(r.status, 200);
  assert.match(r.type, /audio/);
  assert.ok(r.buf.length > 0);
  const sent = voice.tts.at(-1);
  assert.ok(sent.input.startsWith('The vault is under Saltmarsh.'), sent.input.slice(0, 60));
  assert.ok(sent.input.length <= SPEAK_MAX && !sent.input.includes('*') && !sent.input.includes('[['));
  assert.equal(sent.response_format, 'mp3');
});

test('TestAgentSpeech_PlayersAndAnonymousAreRefusedAndNothingIsSynthesised', async () => {
  const n = voice.tts.length;
  for (const t of [voice.jess, voice.tom, undefined]) {
    const r = await voice.call('POST', `/api/worlds/${voice.W}/agent/speak`, t, { text: 'The vault code is 7739.' });
    assert.ok([401, 403].includes(r.status), `${r.status}`);
  }
  assert.equal(voice.tts.length, n, 'no audio was made for a player');
});

test('TestAgentSpeech_NoVoiceJobIs503AndEmptyTextIs400', async () => {
  const r = await mute.call('POST', `/api/worlds/${mute.W}/agent/speak`, mute.dm, { text: 'Hello there' });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /voice/i);
  assert.equal((await voice.call('POST', `/api/worlds/${voice.W}/agent/speak`, voice.dm, { text: '```x```' })).status, 400);
  assert.equal((await voice.call('POST', `/api/worlds/${voice.W}/agent/speak`, voice.dm, {})).status, 400);
});

test('TestAgentChats_ListRenameDeleteAreOwnOnly', async () => {
  const e = voice;
  const A = `/api/worlds/${e.W}/agent/chats`;
  const c1 = await e.ok('POST', A, e.dm, { title: 'First' });
  const c2 = await e.ok('POST', A, e.dm, { title: 'Second' });
  const p1 = await e.ok('POST', A, e.jess, { title: 'Jess private' });
  assert.deepEqual((await e.ok('GET', A, e.dm)).chats.map((c: any) => c.title).sort(), ['First', 'Second']);
  assert.deepEqual((await e.ok('GET', A, e.jess)).chats.map((c: any) => c.title), ['Jess private']);
  assert.deepEqual((await e.ok('GET', A, e.tom)).chats, []);
  // Rename: own chat only, a title is required.
  assert.equal((await e.ok('PATCH', `${A}/${c1.id}`, e.dm, { title: 'Harbour plans' })).id, c1.id);
  assert.ok((await e.ok('GET', A, e.dm)).chats.some((c: any) => c.id === c1.id && c.title === 'Harbour plans'));
  assert.equal((await e.call('PATCH', `${A}/${c1.id}`, e.dm, { title: '  ' })).status, 400);
  assert.equal((await e.call('PATCH', `${A}/${c1.id}`, e.jess, { title: 'mine now' })).status, 404);
  assert.equal((await e.call('PATCH', `${A}/${p1.id}`, e.dm, { title: 'not yours' })).status, 404);
  assert.equal((await e.call('DELETE', `${A}/${p1.id}`, e.dm)).status, 404);
  assert.equal((await e.call('GET', `${A}/${p1.id}`, e.dm)).status, 404);
  await e.ok('DELETE', `${A}/${c2.id}`, e.dm);
  assert.deepEqual((await e.ok('GET', A, e.dm)).chats.map((c: any) => c.id), [c1.id]);
  assert.equal((await e.ok('GET', A, e.jess)).chats.length, 1, 'the player chat is untouched');
});
