// Speech to text on the recording devices, and the final synced transcript, through the API. Devices send their own
// text for a chunk (POST .../chunks/:seq/text after uploading it with wait=1); the server transcribes whatever a
// device does not send (too late, gave up, fell behind, or the world runs speech to text on the server). The fake
// speech model answers from the chunk bytes (`FAKE:<words>`) and counts what it is asked, so a test can tell who
// transcribed a chunk. The model-file routes are checked against a fake upstream: nothing is downloaded.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';
import { engine } from '../src/features/audio/engine.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const MIC: Record<string, string> = {};
let W = '';
const A = () => `/api/worlds/${W}/audio`;
let asked = 0;
const upstream: string[] = [];

const fakeFetch: typeof fetch = async (input: any, init?: any) => {
  const url = String(input);
  if (url.startsWith('https://cdn.example/') || url.startsWith('https://models.example/')) {
    upstream.push(url);
    if (url.includes('missing')) return new Response('no', { status: 404 });
    return new Response(`// ${url.split('/').pop()}\n`, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  if (!url.endsWith('/audio/transcriptions')) return new Response('nope', { status: 404 });
  asked++;
  const text = Buffer.from(await (init.body.get('file') as Blob).arrayBuffer()).toString('latin1');
  const m = /FAKE:([^\u0000]*)/.exec(text);
  const ws = (m?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
  const words = ws.map((word, i) => ({ word: ' ' + word, start: i * 0.4, end: i * 0.4 + 0.35, probability: 0.9 }));
  return Response.json({ text: ws.join(' '), language: 'en', segments: ws.length ? [{ start: 0, end: ws.length * 0.4, text: ws.join(' '), avg_logprob: -0.1, no_speech_prob: 0.01, words }] : [] });
};

async function call(method: string, url: string, token?: string, body?: unknown, raw?: Buffer) {
  const r = await fetch(base + url, {
    method,
    headers: { ...(raw ? { 'Content-Type': 'audio/webm' } : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text, headers: r.headers };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const audio = (text: string) => Buffer.concat([WEBM, Buffer.from('FAKE:' + text)]);
const setting = (k: string, v: unknown) => ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { [k]: v });

/** Upload a chunk. `wait`: the device promises its own text. `sent`: the device's own clock reading at sending. */
async function upload(who: string, sid: string, mic: string, start: number, serverText: string, o: { wait?: boolean; end?: number; level?: number; sent?: number } = {}) {
  const end = o.end ?? start + 5000;
  const q = `mic=${MIC[mic]}&seq=${Math.floor(start / 10)}&start=${start}&end=${end}&level=${o.level ?? 0.5}${o.wait ? '&wait=1' : ''}${o.sent !== undefined ? `&sent=${o.sent}` : ''}`;
  const r = await call('POST', `${A()}/sessions/${sid}/chunks?${q}`, T[who], undefined, audio(serverText));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
/** The text a device made: `text` spoken from `from` ms into the chunk, one word every `step` ms. */
const deviceText = (text: string, from = 0, step = 400) => ({
  segments: [{ start: from / 1000, end: (from + text.split(' ').length * step) / 1000, text, words: text.split(' ').map((w, i) => ({ word: ' ' + w, start: (from + i * step) / 1000, end: (from + i * step + step * 0.85) / 1000, probability: 0.92 })) }],
  stt: { model: 'whisper-base', backend: 'webgpu', ms: 600, rtf: 0.12 },
});
const sendText = (who: string, sid: string, mic: string, start: number, body: unknown) => call('POST', `${A()}/sessions/${sid}/chunks/${Math.floor(start / 10)}/text?mic=${MIC[mic]}`, T[who], body);
const chunkRow = (sid: string, mic: string, start: number) => one<any>(deps.db, 'SELECT * FROM audio_chunks WHERE session_id = ? AND mic_id = ? AND start_ms = ?', sid, MIC[mic], start);
async function newSession(name = 'Device test') {
  const act = await ok('GET', `${A()}/status`, T.dm);
  if (act.session) await ok('POST', `${A()}/sessions/${act.session.id}/stop`, T.dm);
  return (await ok('POST', `${A()}/sessions`, T.dm, { name })).id as string;
}
const lines = async (who: string, sid: string, q = '') => (await ok('GET', `${A()}/sessions/${sid}/lines${q}`, T[who])).lines as any[];

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-stt-'));
  const made = createApp({
    noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch,
    env: {
      ALX_MODEL_AUDIO_URL: 'http://fake/v1', ALX_AUDIO_MERGE_MS: '0', ALX_AUDIO_REFINE_DELAY_MS: '3600000', ALX_AUDIO_FINAL_WAIT_MS: '0', ALX_ADMIN_TABLE_LOGIN: '1',
      ALX_STT_LIB_URL: 'https://cdn.example/dist/', ALX_STT_MODEL_URL: 'https://models.example/',
    },
  });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Deviceland', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name === 'jess' ? 'Jessamine' : 'Tomas' });
    T[name] = j.token;
    ID[name] = j.account.id;
    await ok('POST', `${A()}/consent`, T[name], { agree: true });
  }
  const mic = async (who: string, key: string, body: any) => { MIC[key] = (await ok('POST', `${A()}/mics`, T[who], { deviceId: 'dev-' + key, ...body })).id; };
  await mic('dm', 'table', { label: 'Table mic', mode: 'always' });
  await mic('jess', 'jess', { label: 'Jess phone', mode: 'always' });
  await mic('tom', 'tom', { label: 'Tom phone', mode: 'always' });
});

after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---- the mode ----------------------------------------------------------------------------------------------------

test('Stt_mode: server by default; the GM picks server, device or auto; players read it but cannot change it', async () => {
  assert.equal((await ok('GET', `${A()}/status`, T.jess)).transcription.stt, 'server');
  await setting('speechToText', 'auto');
  assert.equal((await ok('GET', `${A()}/status`, T.jess)).transcription.stt, 'auto');
  assert.equal((await call('PATCH', `/api/worlds/${W}/settings`, T.dm, { speechToText: 'device-first' })).status, 400, 'only the three modes');
  assert.equal((await call('PATCH', `/api/worlds/${W}/settings`, T.jess, { speechToText: 'server' })).status, 403);
  await setting('speechToText', 'server');
});

// ---- device text ------------------------------------------------------------------------------------------------

test('Stt_device: a chunk promised by its device waits; the device text becomes the line and the server model is never asked', async () => {
  await setting('speechToText', 'device');
  const sid = await newSession();
  const before = asked;
  const up = await upload('jess', sid, 'jess', 0, 'server words here', { wait: true });
  assert.equal(up.status, 'awaiting');
  assert.equal((await lines('dm', sid)).length, 0, 'nothing yet');
  const r = await sendText('jess', sid, 'jess', 0, deviceText('The ferryman wants twelve silver pieces'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.accepted, r.body.status, r.body.words], [true, 'done', 6]);
  assert.equal(asked, before, 'the server model was not used');
  const ls = await lines('jess', sid);
  assert.equal(ls.length, 1);
  assert.equal(ls[0].text, 'The ferryman wants twelve silver pieces');
  assert.equal(ls[0].speaker, 'Jessamine');
  const row = chunkRow(sid, 'jess', 0);
  assert.equal(row.source, 'device');
  assert.deepEqual(JSON.parse(row.stt), { model: 'whisper-base', backend: 'webgpu', ms: 600, rtf: 0.12 });
  // A second copy of the same text (a retry) changes nothing; the GM sees where each mic's text came from.
  assert.equal((await sendText('jess', sid, 'jess', 0, deviceText('The ferryman wants twelve silver pieces'))).body.accepted, true);
  assert.equal((await lines('jess', sid)).length, 1);
  await ok('POST', `${A()}/mics/${MIC.jess}/stt`, T.jess, { state: 'running', model: 'whisper-base', backend: 'webgpu', rtf: 0.12, backlog: 0 });
  const mics = await ok('GET', `${A()}/mics`, T.dm);
  const jm = mics.find((m: any) => m.id === MIC.jess);
  assert.equal(jm.stt.mode, 'device');
  assert.deepEqual(jm.stt.chunks, { device: 1, server: 0, awaiting: 0, pending: 0 });
  assert.deepEqual([jm.stt.device.state, jm.stt.device.backend, jm.stt.device.rtf, jm.stt.lastBackend], ['running', 'webgpu', 0.12, 'webgpu']);
  const mine = await ok('GET', `${A()}/mics`, T.tom);
  assert.ok(mine.every((m: any) => m.id === MIC.tom), 'a player only sees their own mic');
});

test('Stt_device: device text goes through the same filters as the server model (hallucinations, outros, bad numbers)', async () => {
  await setting('speechToText', 'auto');
  const sid = await newSession();
  await upload('tom', sid, 'tom', 0, '', { wait: true });
  const r = await sendText('tom', sid, 'tom', 0, { segments: [{ start: 0, end: 2, text: 'Thanks for watching!', words: [{ word: ' Thanks', start: 0, end: 0.5 }, { word: ' for', start: 0.5, end: 1 }, { word: ' watching!', start: 1, end: 2 }] }] });
  assert.equal(r.body.words, 0, 'a known outro never becomes a line');
  assert.equal((await lines('dm', sid)).length, 0);
  await upload('tom', sid, 'tom', 5000, '', { wait: true });
  assert.equal((await sendText('tom', sid, 'tom', 5000, { segments: [{ start: 0, end: 999, text: 'x', words: [] }] })).status, 400, 'times outside the chunk are refused');
  assert.equal((await sendText('tom', sid, 'tom', 5000, { words: [{ word: 'hi', start: 'soon', end: 1 }] })).status, 400);
  assert.equal((await sendText('tom', sid, 'tom', 5000, { nothing: true })).status, 400);
  assert.equal((await sendText('tom', sid, 'tom', 5000, { words: Array.from({ length: 3001 }, (_, i) => ({ word: 'w', start: (i % 50) / 10, end: (i % 50) / 10 + 0.05 })) })).status, 400, 'too many words');
  // A flat word list works too.
  const flat = await sendText('tom', sid, 'tom', 5000, { words: [{ word: 'Roll', start: 0.2, end: 0.5 }, { word: 'for', start: 0.5, end: 0.7 }, { word: 'initiative', start: 0.7, end: 1.3 }] });
  assert.equal(flat.body.accepted, true);
  assert.equal((await lines('dm', sid))[0].text, 'Roll for initiative');
});

test('Stt_device: only the mic\'s owner may send its text, and only for a chunk that was uploaded', async () => {
  await setting('speechToText', 'device');
  const sid = await newSession();
  await upload('jess', sid, 'jess', 0, '', { wait: true });
  assert.equal((await sendText('tom', sid, 'jess', 0, deviceText('I am Jess honest'))).status, 403, 'another player cannot speak for Jess');
  assert.equal((await sendText('dm', sid, 'jess', 0, deviceText('I am Jess honest'))).status, 403, 'nor can the GM');
  assert.equal((await sendText('jess', sid, 'jess', 5000, deviceText('never uploaded'))).status, 404);
  await ok('POST', `${A()}/consent`, T.jess, { agree: false });
  assert.equal((await sendText('jess', sid, 'jess', 0, deviceText('after withdrawing'))).status, 403, 'consent withdrawn: refused');
  await ok('POST', `${A()}/consent`, T.jess, { agree: true });
  assert.equal(chunkRow(sid, 'jess', 0).status, 'awaiting');
});

test('Stt_device: a GM-only title in a device\'s line hides that line from the players, as with the server model', async () => {
  await setting('speechToText', 'device');
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'dm/Pale Vault.md', visibility: 'dm', markdown: '# The Pale Vault\nSealed.\n' });
  engine(deps).resetHint();
  const sid = await newSession();
  await upload('jess', sid, 'jess', 0, '', { wait: true });
  await sendText('jess', sid, 'jess', 0, deviceText('maybe the Pale Vault holds the key'));
  assert.equal((await lines('dm', sid)).length, 1);
  assert.equal((await lines('jess', sid)).length, 0, 'the player never reads it');
});

// ---- the server takes over --------------------------------------------------------------------------------------

test('Stt_fallback: in server mode a promise of text is ignored: the server transcribes at once and late device text is not used', async () => {
  await setting('speechToText', 'server');
  const sid = await newSession();
  const before = asked;
  const up = await upload('tom', sid, 'tom', 0, 'goblins burst through the door', { wait: true });
  assert.equal(up.status, 'done');
  assert.equal(asked, before + 1);
  const r = await sendText('tom', sid, 'tom', 0, deviceText('something else entirely'));
  assert.equal(r.body.accepted, false);
  assert.equal((await lines('dm', sid))[0].text, 'goblins burst through the door');
  assert.equal(chunkRow(sid, 'tom', 0).source, 'server');
});

test('Stt_fallback: a device that gives up on a chunk hands it to the server straight away', async () => {
  await setting('speechToText', 'device');
  const sid = await newSession();
  await upload('tom', sid, 'tom', 0, 'the bridge is out', { wait: true });
  const before = asked;
  const r = await sendText('tom', sid, 'tom', 0, { giveUp: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'done');
  assert.equal(asked, before + 1);
  assert.equal(chunkRow(sid, 'tom', 0).source, 'server');
  assert.equal((await lines('tom', sid))[0].text, 'the bridge is out');
  // The device's text arriving after that is not used.
  assert.equal((await sendText('tom', sid, 'tom', 0, deviceText('late words'))).body.accepted, false);
});

test('Stt_fallback: text that never comes is transcribed by the server after the wait, with no gap in the transcript', async () => {
  await setting('speechToText', 'auto');
  const sid = await newSession();
  await upload('jess', sid, 'jess', 0, 'first chunk words', { wait: true });
  await sendText('jess', sid, 'jess', 0, deviceText('first chunk words'));
  await upload('jess', sid, 'jess', 5000, 'second chunk the phone dropped', { wait: true });
  await upload('jess', sid, 'jess', 10000, 'third chunk', { wait: true });
  await sendText('jess', sid, 'jess', 10000, deviceText('third chunk'));
  assert.equal(chunkRow(sid, 'jess', 5000).status, 'awaiting');
  assert.equal(await engine(deps).expireAwaiting(sid, 60_000), 0, 'not yet: inside the wait');
  run(deps.db, "UPDATE audio_chunks SET created_at = '2000-01-01T00:00:00.000Z' WHERE session_id = ? AND start_ms = 5000", sid);
  assert.equal(await engine(deps).expireAwaiting(), 1);
  const row = chunkRow(sid, 'jess', 5000);
  assert.deepEqual([row.status, row.source], ['done', 'server']);
  const text = (await lines('dm', sid)).map((l) => l.text).join(' ');
  assert.match(text, /first chunk words.*second chunk the phone dropped.*third chunk/);
});

test('Stt_fallback: a device that says it is behind or failed has its waiting chunks done by the server now', async () => {
  await setting('speechToText', 'device');
  const sid = await newSession();
  await upload('tom', sid, 'tom', 0, 'one two three', { wait: true });
  await upload('tom', sid, 'tom', 5000, 'four five six', { wait: true });
  await upload('jess', sid, 'jess', 0, 'not hers to drop', { wait: true });
  await ok('POST', `${A()}/mics/${MIC.tom}/stt`, T.tom, { state: 'behind', backlog: 9, rtf: 2.4, model: 'whisper-tiny', backend: 'wasm' });
  for (let i = 0; i < 50 && chunkRow(sid, 'tom', 5000).status === 'awaiting'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(chunkRow(sid, 'tom', 0).source, 'server');
  assert.equal(chunkRow(sid, 'tom', 5000).source, 'server');
  assert.equal(chunkRow(sid, 'jess', 0).status, 'awaiting', "only that device's chunks");
  assert.equal((await call('POST', `${A()}/mics/${MIC.tom}/stt`, T.jess, { state: 'error' })).status, 403, "a player cannot report on another's mic");
  assert.equal((await call('POST', `${A()}/mics/${MIC.tom}/stt`, T.tom, { state: 'sleepy' })).status, 400);
  const m = (await ok('GET', `${A()}/mics`, T.dm)).find((x: any) => x.id === MIC.tom);
  assert.deepEqual([m.stt.device.state, m.stt.device.rtf, m.stt.device.backlog, m.stt.chunks.server], ['behind', 2.4, 9, 2]);
});

test('Stt_fallback: chunks waiting for text keep their audio when a built session cleans up', async () => {
  await setting('speechToText', 'device');
  const sid = await newSession();
  await upload('jess', sid, 'jess', 0, 'kept', { wait: true });
  const { cleanChunks } = await import('../src/features/audio/recordings.ts');
  cleanChunks(deps, sid);
  assert.ok(chunkRow(sid, 'jess', 0).file, 'the awaiting chunk still has its file');
});

// ---- the final transcript ---------------------------------------------------------------------------------------

const S1 = 'The ferryman wants twelve silver pieces before crossing toward Saltmarsh tonight';
const S2 = 'Nobody trusts that smuggler after what happened beneath the lighthouse yesterday';

test('Final_api: two phones with clocks seconds apart give one line per sentence after the final pass; live version kept; undo', async () => {
  await setting('speechToText', 'device');
  const sid = await newSession('Final test');
  // Jess speaks S1 at 1 s, Tom S2 at 10 s; each phone hears both. Tom's clock runs 4 s late, so live his copy of S1
  // lands where nobody else heard it and the live transcript has it twice.
  const LATE = 4000;
  const say = async (who: string, at: number, text: string, level: number) => {
    const start = Math.floor(at / 5000) * 5000;
    await upload(who, sid, who, start, '', { wait: true, level, end: start + 8000, sent: who === 'tom' ? start - LATE : start });
    const r = await sendText(who, sid, who, start, deviceText(text, at - start, 300));
    assert.equal(r.body.accepted, true);
  };
  await say('jess', 1000, S1, 0.8);
  await say('tom', 1000 + LATE, S1, 0.15);
  await say('tom', 10000 + LATE, S2, 0.8);
  await say('jess', 10000, S2, 0.15);
  const live = await lines('dm', sid);
  assert.ok(live.filter((l) => l.text.includes('ferryman')).length >= 2, `live has S1 twice: ${live.map((l) => l.text).join(' / ')}`);

  assert.equal((await call('POST', `${A()}/sessions/${sid}/final`, T.dm, {})).status, 409, 'stop the recording first');
  await ok('POST', `${A()}/sessions/${sid}/stop`, T.dm);
  assert.equal((await call('POST', `${A()}/sessions/${sid}/final`, T.jess, {})).status, 403);
  await engine(deps).finalize(sid);
  const fin = (await ok('GET', `${A()}/sessions/${sid}/final`, T.dm)).final;
  assert.equal(fin.status, 'done');
  assert.equal(fin.stats.mics, 2);
  assert.ok(Math.abs(fin.offsets[MIC.tom].ms + LATE) <= 50 || Math.abs(fin.offsets[MIC.jess].ms - LATE) <= 50, JSON.stringify(fin.offsets));
  const after = await lines('dm', sid);
  assert.deepEqual(after.map((l) => l.text), [S1, S2], after.map((l) => `${l.start} ${l.text}`).join(' / '));
  assert.deepEqual(after.map((l) => l.speaker), ['Jessamine', 'Tomas'], 'each line is credited to the closest phone');
  assert.ok(after[1].start - after[0].start > 7000 && after[1].start - after[0].start < 11000, 'the two sentences are ~9 s apart on one clock');
  // Players read the final transcript too; the live version is the GM's.
  assert.deepEqual((await lines('tom', sid)).map((l) => l.text), [S1, S2]);
  assert.equal((await call('GET', `${A()}/sessions/${sid}/lines?version=live`, T.tom)).status, 403);
  assert.ok((await lines('dm', sid, '?version=live')).length >= 3);
  assert.equal((await call('GET', `${A()}/sessions/${sid}/final`, T.tom)).status, 403);

  const undo = await ok('POST', `${A()}/sessions/${sid}/final/undo`, T.dm);
  assert.ok(undo.restored >= 3);
  assert.equal(undo.final.status, 'undone');
  assert.ok((await lines('dm', sid)).filter((l) => l.text.includes('ferryman')).length >= 2, 'the live lines are back');
  // Again: the second pass starts from the live version, not from the first final.
  await engine(deps).finalize(sid);
  assert.deepEqual((await lines('dm', sid)).map((l) => l.text), [S1, S2]);
});

test('Final_api: GM-only stays GM-only through the final pass; Transcript.md and session.json are rewritten', async () => {
  await setting('speechToText', 'device');
  const sid = await newSession('Final files');
  await ok('POST', `${A()}/mics`, T.dm, { deviceId: 'dev-table', label: 'Table mic', mode: 'always', playersTranscript: false });
  await upload('dm', sid, 'table', 0, '', { wait: true, level: 0.6 });
  await sendText('dm', sid, 'table', 0, deviceText('secret plans for the drowned chapel'));
  await upload('tom', sid, 'tom', 5000, 'the tavern is warm', { level: 0.6 });
  await ok('POST', `${A()}/sessions/${sid}/stop`, T.dm);
  // A recording folder as the build leaves it.
  const rel = path.join('recordings', 'Deviceland', 'test Final files');
  const dir = path.join(deps.dataDir, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.json'), '{}');
  run(deps.db, 'UPDATE audio_sessions SET rec_dir = ? WHERE id = ?', rel, sid);
  await engine(deps).finalize(sid);
  const ls = await lines('dm', sid);
  assert.equal(ls.find((l) => /secret/.test(l.text))?.audience, 'dm');
  assert.ok(!(await lines('tom', sid)).some((l) => /secret/.test(l.text)), 'players never read the GM-only line');
  const md = fs.readFileSync(path.join(dir, 'Transcript.md'), 'utf8');
  assert.match(md, /Final transcript: 2 microphones synced onto one timeline/);
  assert.match(md, /\(\*\*GM only\*\*\): secret plans for the drowned chapel/);
  assert.match(md, /\*\*Tomas\*\*: the tavern is warm/);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  assert.equal(doc.transcript.status, 'done');
  assert.equal(doc.transcript.mics, 2);
  await ok('POST', `${A()}/mics`, T.dm, { deviceId: 'dev-table', label: 'Table mic', mode: 'always', playersTranscript: true });
});

test('Final_api: chunks still waiting for a device when the pass starts are transcribed by the server first', async () => {
  await setting('speechToText', 'device');
  const sid = await newSession('Final waits');
  await upload('jess', sid, 'jess', 0, 'the phone never answered', { wait: true });
  await ok('POST', `${A()}/sessions/${sid}/stop`, T.dm);
  await engine(deps).finalize(sid);
  assert.equal(chunkRow(sid, 'jess', 0).source, 'server');
  assert.deepEqual((await lines('dm', sid)).map((l) => l.text), ['the phone never answered']);
});

// ---- model files --------------------------------------------------------------------------------------------------

test('Stt_assets: a member gets a ticket URL; the library and allowed model files are fetched once and then served from the cache', async () => {
  const a = (await ok('GET', `${A()}/stt/assets`, T.jess)).assets;
  assert.match(a.lib, /^\/api\/stt\/[^/]+\/lib\/$/);
  assert.match(a.models, /^\/api\/stt\/[^/]+\/models\/$/);
  assert.equal(a.lib.split('/')[3], a.models.split('/')[3], 'one ticket for both');
  assert.equal((await ok('GET', `${A()}/stt/assets`, T.jess)).assets.lib, a.lib, 'the same URL again, so the browser cache keeps the library');
  upstream.length = 0;
  const lib = await call('GET', `${a.lib}transformers.min.js`);
  assert.equal(lib.status, 200);
  assert.match(lib.headers.get('content-type') ?? '', /javascript/);
  assert.match(lib.headers.get('cache-control') ?? '', /private.*immutable/);
  assert.equal((await call('GET', `${a.lib}transformers.min.js`)).status, 200);
  assert.deepEqual(upstream, ['https://cdn.example/dist/transformers.min.js'], 'fetched once');
  assert.equal((await call('GET', `${a.lib}ort-wasm-simd-threaded.jsep.wasm`)).headers.get('content-type'), 'application/wasm');
  assert.equal((await call('GET', `${a.lib}evil.js`)).status, 404, 'only the pinned files');
  assert.equal((await call('GET', `${a.lib}..%2F..%2Fdata.db`)).status, 404);

  const cfg = await call('GET', `${a.models}onnx-community/whisper-tiny_timestamped/resolve/main/config.json`);
  assert.equal(cfg.status, 200);
  assert.ok(upstream.includes('https://models.example/onnx-community/whisper-tiny_timestamped/resolve/main/config.json'));
  assert.equal((await call('GET', `${a.models}onnx-community/whisper-tiny_timestamped/resolve/main/onnx/encoder_model_q4.onnx`)).status, 200);
  assert.equal((await call('GET', `${a.models}someone/whatever/resolve/main/config.json`)).status, 404, 'only the listed models');
  assert.equal((await call('GET', `${a.models}onnx-community/whisper-tiny_timestamped/resolve/main/../../x.json`)).status, 404);
  assert.equal((await call('GET', `${a.models}onnx-community/whisper-tiny_timestamped/resolve/main/onnx/other.bin`)).status, 404, 'only model files');
  assert.equal((await call('GET', `/api/stt/not-a-ticket/models/onnx-community/whisper-tiny_timestamped/resolve/main/config.json`)).status, 404, 'a ticket is needed');
  assert.equal((await call('GET', `${a.models}onnx-community/whisper-tiny_timestamped/resolve/main/missing.json`)).status, 404, 'upstream 404 passes through');
  assert.ok(!fs.readdirSync(path.join(deps.dataDir, 'stt-cache/models/onnx-community/whisper-tiny_timestamped/main')).some((f) => f.includes('missing')), 'nothing cached for a failure');

  deps.env.ALX_STT_ASSETS = 'off';
  try {
    assert.equal((await ok('GET', `${A()}/stt/assets`, T.jess)).assets, null);
    assert.equal((await call('GET', `${a.lib}transformers.min.js`)).status, 404);
  } finally { delete deps.env.ALX_STT_ASSETS; }
});

test('Stt_assets: nothing is served or downloaded without a signed-in member\'s ticket', async () => {
  const a = (await ok('GET', `${A()}/stt/assets`, T.jess)).assets;
  const ticket = a.lib.split('/')[3];
  upstream.length = 0;
  for (const f of ['transformers.min.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
    for (const url of [`/api/stt/lib/${f}`, `/api/stt/x/lib/${f}`, `/api/stt/${ticket.slice(0, -2)}xx/lib/${f}`, `/api/stt/${ticket.split('.')[0]}/lib/${f}`]) {
      const r = await call('GET', url);
      assert.ok(r.status === 404 || r.status === 401, `${url} without a good ticket answered ${r.status}`);
    }
  }
  // A ticket minted for another kind of file is not a speech ticket.
  const { mintTicket } = await import('../src/features/sound/ticket.ts');
  const other = mintTicket({ w: deps.db.prepare('SELECT world_id FROM members LIMIT 1').get().world_id, k: 'track', f: '', a: ID.jess });
  assert.equal((await call('GET', `/api/stt/${other}/lib/transformers.min.js`)).status, 404);
  // Someone who has left the world loses it.
  const stranger = mintTicket({ w: 'no-such-world', k: 'stt', f: '', a: ID.jess });
  assert.equal((await call('GET', `/api/stt/${stranger}/lib/transformers.min.js`)).status, 404);
  assert.equal((await call('GET', `/api/stt/${stranger}/models/onnx-community/whisper-tiny_timestamped/resolve/main/config.json`)).status, 404);
  assert.deepEqual(upstream, [], 'the server downloaded nothing for them');
  // Not signed in: the assets route itself is 401.
  assert.equal((await call('GET', `${A()}/stt/assets`)).status, 401);
});

test('Stt_live: changing where speech to text runs tells every device at once, once per change', async () => {
  const seen: { type: string; data: any }[] = [];
  const untap = deps.hub.tap((_w: string, type: string, data: unknown) => { if (type === 'stt-mode') seen.push({ type, data }); });
  try {
    await setting('speechToText', 'server');
    seen.length = 0;
    await setting('speechToText', 'device');
    assert.deepEqual(seen.map((s) => s.data), [{ mode: 'device' }]);
    await setting('speechToText', 'device');
    await setting('transcriptHint', 'on');
    assert.equal(seen.length, 1, 'no event when the mode did not change');
    await setting('speechToText', 'auto');
    await setting('speechToText', 'server');
    assert.deepEqual(seen.map((s) => s.data.mode), ['device', 'auto', 'server']);
    assert.deepEqual(Object.keys(seen[0].data), ['mode'], 'only the mode is sent');
  } finally { untap(); }
});

test('Stt_csp: the app page allows WebAssembly from its own origin and nothing else new', async () => {
  const web = path.join(tmp, 'web');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>x</title>');
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data2'), vaultsDir: path.join(tmp, 'vaults2'), fetch: fakeFetch, env: {}, webDir: web } as any);
  const srv = made.app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  try {
    const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const csp = (await fetch(b + '/w/x/dm/audio')).headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/);
    assert.match(csp, /connect-src 'self';/);
    assert.ok(!/unsafe-eval'/.test(csp.replace("'wasm-unsafe-eval'", '')), 'no plain unsafe-eval');
    const screen = (await fetch(b + '/w/x/screen/players')).headers.get('content-security-policy') ?? '';
    assert.equal((screen.match(/script-src/g) ?? []).length, 1, 'the players\' screen still has one script-src');
    assert.match(screen, /script-src 'self' https:\/\/www.youtube.com;/);
  } finally { srv.close(); }
});

test('Stt_counts: nothing in the database is left awaiting after the tests that finished their sessions', () => {
  const stuck = all<any>(deps.db, "SELECT c.session_id FROM audio_chunks c JOIN audio_sessions s ON s.id = c.session_id WHERE c.status = 'awaiting' AND s.name LIKE 'Final%'");
  assert.equal(stuck.length, 0);
});
