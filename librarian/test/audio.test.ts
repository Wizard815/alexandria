// Audio capture and the live transcript: consent, mics, upload, the many-mic
// merge, asides (fail closed), hold windows, retention and backups. Speech to
// text is faked: a chunk's bytes are `FAKE:<words>|p=<confidences>` and the
// fake model answers /audio/transcriptions with verbose_json built from them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { one, run } from '../src/core/db.ts';
import { engine } from '../src/features/audio/engine.ts';
import { sessionLines, listSessions } from '../src/features/audio/api.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
let modelUp = true;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const MIC: Record<string, string> = {};
let W = '';
const A = () => `/api/worlds/${W}/audio`;
const SECRET = 'xyzzyplugh';

const fakeFetch: typeof fetch = async (input: any, init?: any) => {
  const url = String(input);
  if (!url.endsWith('/audio/transcriptions')) return new Response('nope', { status: 404 });
  if (!modelUp) return new Response('down', { status: 503 });
  const f = init.body.get('file') as Blob;
  const text = Buffer.from(await f.arrayBuffer()).toString('latin1');
  const m = /FAKE:([^|\u0000]*)(?:\|p=([0-9.,]+))?/.exec(text);
  if (!m) return Response.json({ text: '', segments: [] });
  const ws = m[1].trim().split(/\s+/).filter(Boolean);
  const ps = (m[2] ?? '0.9').split(',').map(Number);
  const words = ws.map((word, i) => ({ word: ' ' + word, start: i * 0.4, end: i * 0.4 + 0.35, probability: ps[i % ps.length] }));
  return Response.json({ text: ws.join(' '), language: 'en', segments: [{ start: 0, end: ws.length * 0.4, text: ws.join(' '), avg_logprob: -0.1, no_speech_prob: 0.01, words }] });
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
  return { status: r.status, body: json, text };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const chunk = (text: string) => Buffer.concat([WEBM, Buffer.from('FAKE:' + text)]);

async function upload(who: string, sid: string, mic: string, seq: number, start: number, text: string, level = 0.5, end = start + 5000) {
  return call('POST', `${A()}/sessions/${sid}/chunks?mic=${MIC[mic]}&seq=${seq}&start=${start}&end=${end}&level=${level}`, T[who], undefined, chunk(text));
}
const upOk = async (...a: Parameters<typeof upload>) => {
  const r = await upload(...a);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
async function newSession() {
  const act = await ok('GET', `${A()}/status`, T.dm);
  if (act.session) await ok('POST', `${A()}/sessions/${act.session.id}/stop`, T.dm);
  return (await ok('POST', `${A()}/sessions`, T.dm, { name: 'Test session' })).id as string;
}
const lines = async (who: string, sid: string) => (await ok('GET', `${A()}/sessions/${sid}/lines`, T[who])).lines as any[];
const hold = (who: string, sid: string, mic: string | null, kind: string, start: number, end: number) =>
  ok('POST', `${A()}/sessions/${sid}/holds`, T[who], { micId: mic ? MIC[mic] : undefined, kind, start, end });

/** Read a live event stream into an array of "type data" strings. */
function listen(token: string) {
  const ctl = new AbortController();
  const events: { type: string; data: any }[] = [];
  const raw: string[] = [];
  const ready = (async () => {
    const res = await fetch(`${base}/api/worlds/${W}/events`, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const c = buf.slice(0, i); buf = buf.slice(i + 2); raw.push(c);
            const t = /^event: (.*)$/m.exec(c); const d = /^data: (.*)$/m.exec(c);
            if (t && d) events.push({ type: t[1], data: JSON.parse(d[1]) });
          }
        }
      } catch { /* aborted */ }
    })();
  })();
  return { events, raw, ready, stop: () => ctl.abort() };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-audio-'));
  const made = createApp({
    noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch,
    env: { ALX_MODEL_AUDIO_URL: 'http://fake/v1', ALX_AUDIO_MERGE_MS: '0' },
  });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Audioland', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom', 'zed']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name === 'jess' ? 'Jessamine' : name });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
  await ok('POST', `${A()}/consent`, T.jess, { agree: true });
  await ok('POST', `${A()}/consent`, T.tom, { agree: true });
  const mic = async (who: string, key: string, body: any) => { MIC[key] = (await ok('POST', `${A()}/mics`, T[who], { deviceId: 'dev-' + key, ...body })).id; };
  await mic('dm', 'table', { label: 'Table', mode: 'always', playersTranscript: true, aside: false });
  await mic('dm', 'headset', { label: 'DM headset', mode: 'hold-to-talk', playersTranscript: false, aside: false });
  await mic('dm', 'dmalways', { label: 'DM private', mode: 'always', playersTranscript: false, aside: false, room: false });
  await mic('dm', 'talkpub', { label: 'Talk mic', mode: 'hold-to-talk', playersTranscript: true, aside: false });
  await mic('dm', 'mutable', { label: 'Mute mic', mode: 'hold-to-mute', playersTranscript: true, aside: false });
  await mic('jess', 'jess', { label: 'Jess phone', mode: 'always' });
  await mic('tom', 'tom', { label: 'Tom phone', mode: 'always' });
  await mic('zed', 'zed', { label: 'Zed phone', mode: 'always' });
});

after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Audio_consent: players must agree before any upload is accepted', async () => {
  const sid = await newSession();
  const r = await upload('zed', sid, 'zed', 0, 0, 'hello there friend');
  assert.equal(r.status, 403, 'no consent, no upload');
  assert.ok(!fs.existsSync(path.join(tmp, 'data', 'audio', W, sid)), 'nothing was stored');
  assert.equal(one<any>(deps.db, 'SELECT COUNT(*) AS n FROM audio_chunks WHERE session_id = ?', sid).n, 0);
  assert.equal((await ok('GET', `${A()}/sessions/${sid}/lines`, T.dm)).lines.length, 0);
  await ok('POST', `${A()}/consent`, T.zed, { agree: true });
  await upOk('zed', sid, 'zed', 0, 0, 'hello there friend');
  await ok('POST', `${A()}/consent`, T.zed, { agree: false });
  assert.equal((await upload('zed', sid, 'zed', 1, 5000, 'again now')).status, 403, 'withdrawn consent stops uploads');
  const st = await ok('GET', `${A()}/status`, T.zed);
  assert.equal(st.consent.agreed, false);
  assert.equal(st.recording, true);
  // the DM's consent text is a world setting
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { recordingConsentText: 'Everyone agrees, ok?' });
  assert.equal((await ok('GET', `${A()}/consent`, T.zed)).text, 'Everyone agrees, ok?');
  assert.equal((await call('PATCH', `/api/worlds/${W}/settings`, T.dm, { audioRetentionDays: 0 })).status, 400);
});

test('Audio_mics: a player has one mic; a player cannot use another account\'s mic', async () => {
  const again = await ok('POST', `${A()}/mics`, T.jess, { deviceId: 'other-device', label: 'New phone', mode: 'hold-to-talk' });
  assert.equal(again.id, MIC.jess, 'the single player mic is reused');
  assert.equal((await ok('GET', `${A()}/mics`, T.jess)).length, 1);
  assert.ok((await ok('GET', `${A()}/mics`, T.dm)).length >= 8);
  await ok('POST', `${A()}/mics`, T.jess, { deviceId: 'dev-jess', label: 'Jess phone', mode: 'always', aside: true, playersTranscript: false });
  const m = (await ok('GET', `${A()}/mics`, T.jess))[0];
  assert.equal(m.aside, false, 'players cannot make an aside mic');
  assert.equal(m.playersTranscript, true);
  const sid = await newSession();
  assert.equal((await upload('tom', sid, 'jess', 0, 0, 'borrowed mic')).status, 403);
  assert.equal((await call('POST', `${A()}/sessions/${sid}/holds`, T.jess, { micId: MIC.jess, kind: 'aside', start: 0, end: 10 })).status, 403, 'players cannot mark asides');
  assert.equal((await call('POST', `${A()}/sessions`, T.jess, {})).status, 403);
  assert.equal((await call('POST', `${A()}/sessions`, T.dm, {})).status, 409, 'one active session at a time');
  await ok('POST', `${A()}/mics`, T.jess, { deviceId: 'dev-jess', label: 'Jess phone', mode: 'always' });
});

test('Audio_upload: format, size and ownership are checked', async () => {
  const sid = await newSession();
  const bad = await call('POST', `${A()}/sessions/${sid}/chunks?mic=${MIC.table}&seq=0&start=0&end=5000`, T.dm, undefined, Buffer.from('not audio at all'));
  assert.equal(bad.status, 415);
  const big = await call('POST', `${A()}/sessions/${sid}/chunks?mic=${MIC.table}&seq=0&start=0&end=5000`, T.dm, undefined, Buffer.concat([WEBM, Buffer.alloc(2.1 * 1024 * 1024)]));
  assert.equal(big.status, 413);
  const r = await upOk('dm', sid, 'table', 0, 0, 'plain words here');
  assert.equal(r.status, 'done');
  const dup = await upload('dm', sid, 'table', 0, 0, 'plain words here');
  assert.equal(dup.body.duplicate, true);
  assert.ok(fs.existsSync(path.join(tmp, 'data', 'audio', W, sid, MIC.table, '0.webm')), 'stored under audio/<world>/<session>/<mic>/<seq>.webm');
});

test('Audio_merge: three mics hearing the same words make one line, credited to the closest mic', async () => {
  const sid = await newSession();
  await upOk('dm', sid, 'table', 0, 10_000, 'the quick brown fox', 0.3);
  await upOk('jess', sid, 'jess', 0, 10_000, 'the quick brown fox', 0.8);
  await upOk('tom', sid, 'tom', 0, 10_000, 'the quick brown fox', 0.2);
  const ls = await lines('dm', sid);
  assert.equal(ls.length, 1, JSON.stringify(ls));
  assert.equal(ls[0].text, 'the quick brown fox');
  assert.equal(ls[0].speakerId, ID.jess);
  assert.equal(ls[0].speaker, 'Jessamine');
  assert.equal(ls[0].sources.length, 3);
  assert.equal(ls[0].audience, 'players');
  assert.equal((await lines('tom', sid)).length, 1, 'a player sees it too');
  // a different, later line stays separate
  await upOk('dm', sid, 'table', 1, 16_000, 'roll for initiative everyone');
  assert.equal((await lines('dm', sid)).length, 2);
});

test('Audio_merge: the word-level merge takes the clearest mic for each word', async () => {
  const sid = await newSession();
  // the table mic is unsure of "brawn"; the phone is unsure of "fax"
  await upOk('dm', sid, 'table', 0, 0, 'the quick brawn fox|p=0.9,0.9,0.2,0.9', 0.5);
  await upOk('tom', sid, 'tom', 0, 0, 'the quick brown fax|p=0.9,0.9,0.9,0.2', 0.5);
  const ls = await lines('dm', sid);
  assert.equal(ls.length, 1, JSON.stringify(ls));
  assert.equal(ls[0].text, 'the quick brown fox', 'better than either mic alone');
});

test('Audio_merge: words the best mic missed are filled in from another mic', async () => {
  const sid = await newSession();
  await upOk('jess', sid, 'jess', 0, 0, 'we open the heavy door', 0.8);
  await upOk('tom', sid, 'tom', 0, 0, 'we open the door', 0.2);
  const ls = await lines('dm', sid);
  assert.equal(ls.length, 1);
  assert.equal(ls[0].text, 'we open the heavy door');
});

test('Audio_aside: an aside makes overlapping lines from every mic DM-only', async () => {
  const sid = await newSession();
  // Before the aside: ordinary table talk.
  await upOk('dm', sid, 'table', 0, 0, 'welcome back adventurers');
  // The DM talks into the headset (hold to talk) while the table and a phone also hear it.
  await upOk('dm', sid, 'headset', 0, 20_000, `the ${SECRET} is hidden`);
  await hold('dm', sid, 'headset', 'talk', 20_000, 21_800);
  await upOk('dm', sid, 'table', 1, 20_000, `the ${SECRET} is hidden`);
  await upOk('jess', sid, 'jess', 0, 20_000, `the ${SECRET} is hidden`);
  // Different speech, partly overlapping the end of the aside
  await upOk('tom', sid, 'tom', 0, 21_700, 'what did he say');
  // Later table talk is public again.
  await upOk('dm', sid, 'table', 2, 40_000, 'back to the story');
  const dmLines = await lines('dm', sid);
  const secret = dmLines.filter((l) => l.text.includes(SECRET));
  assert.equal(secret.length, 1, JSON.stringify(dmLines));
  assert.equal(secret[0].audience, 'dm');
  assert.equal(dmLines.find((l) => l.text === 'what did he say')!.audience, 'dm', 'a partial overlap fails closed');
  assert.equal(dmLines.find((l) => l.text === 'welcome back adventurers')!.audience, 'players');
  assert.equal(dmLines.find((l) => l.text === 'back to the story')!.audience, 'players');
  const pl = await lines('jess', sid);
  assert.deepEqual(pl.map((l) => l.text).sort(), ['back to the story', 'welcome back adventurers']);
  assert.ok(!JSON.stringify(pl).includes(SECRET));
});

test('Audio_aside: an explicit aside key window arriving after the line removes it from players', async () => {
  const sid = await newSession();
  const feed = listen(T.jess);
  const dmFeed = listen(T.dm);
  await feed.ready; await dmFeed.ready;
  await upOk('dm', sid, 'table', 0, 0, `${SECRET} treasure map`);
  assert.equal((await lines('jess', sid)).length, 1, 'visible until the aside is recorded');
  await hold('dm', sid, null, 'aside', 100, 1500);
  assert.equal((await lines('jess', sid)).length, 0, 'now DM-only');
  assert.equal((await lines('dm', sid)).length, 1);
  await wait(100);
  feed.stop(); dmFeed.stop();
  // The player was told to drop the line, without the text.
  const rm = feed.events.filter((e) => e.type === 'transcript-line' && e.data.removed);
  assert.equal(rm.length, 1);
  assert.ok(Object.keys(rm[0].data).every((k) => ['id', 'rev', 'removed', 'sessionId'].includes(k)));
  const secretSeenByDm = dmFeed.events.filter((e) => e.type === 'transcript-line' && JSON.stringify(e.data).includes(SECRET));
  assert.ok(secretSeenByDm.length >= 1, 'the DM stream carries it');
});

test('Audio_audience: a mic with players\' transcript off is DM-only; players never receive DM lines (REST and live)', async () => {
  const sid = await newSession();
  const feed = listen(T.jess);
  const dmFeed = listen(T.dm);
  await feed.ready; await dmFeed.ready;
  await upOk('dm', sid, 'dmalways', 0, 0, `${SECRET} the duke is a vampire`);
  await upOk('jess', sid, 'jess', 0, 30_000, 'I search the room');
  const dl = await lines('dm', sid);
  assert.equal(dl.find((l) => l.text.includes(SECRET)).audience, 'dm');
  assert.equal(dl.find((l) => l.text === 'I search the room').audience, 'players');
  const pl = await lines('jess', sid);
  assert.equal(pl.length, 1);
  assert.equal(pl[0].text, 'I search the room');
  assert.equal(pl[0].audience, undefined, 'no audience, sources or words in a player view');
  assert.equal(pl[0].sources, undefined);
  assert.equal(pl[0].words, undefined);
  // guests and non-members get nothing
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'guest' });
  const g = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'watcher', password: 'guest pass 1234' });
  assert.equal((await call('GET', `${A()}/sessions/${sid}/lines`, g.token)).status, 403);
  // the DM marks a public line DM-only later: it disappears from players
  await ok('PATCH', `${A()}/lines/${pl[0].id}`, T.dm, { audience: 'dm' });
  assert.equal((await lines('jess', sid)).length, 0);
  assert.equal((await call('PATCH', `${A()}/lines/${pl[0].id}`, T.jess, { audience: 'players' })).status, 403, 'players cannot change audiences');
  await wait(100);
  feed.stop(); dmFeed.stop();
  for (const raw of feed.raw) assert.ok(!raw.includes(SECRET), `leaked to a player's live stream: ${raw}`);
  assert.ok(dmFeed.raw.some((r) => r.includes(SECRET)));
  const playerLineEvents = feed.events.filter((e) => e.type === 'transcript-line');
  assert.ok(playerLineEvents.some((e) => e.data.text === 'I search the room'));
  assert.ok(playerLineEvents.some((e) => e.data.removed), 'told to drop the line the DM hid');
  // the typed API for the session log
  const sl = sessionLines(deps.db, W, sid, { includeDm: false });
  assert.ok(sl.every((l) => !l.text.includes(SECRET)));
  assert.equal(sessionLines(deps.db, W, sid, { includeDm: true }).length, 2);
  assert.ok(listSessions(deps.db, W).some((s) => s.id === sid));
});

test('Audio_holds: hold-to-talk keeps only words inside talk windows; hold-to-mute drops words inside', async () => {
  const sid = await newSession();
  // words are 0.4 s apart: one@0 two@0.4 three@0.8 four@1.2 (ms after the chunk start)
  await upOk('dm', sid, 'talkpub', 0, 60_000, 'one two three four');
  assert.equal((await lines('dm', sid)).length, 0, 'no talk window: nothing kept');
  await hold('dm', sid, 'talkpub', 'talk', 60_000, 60_800);
  let ls = await lines('dm', sid);
  assert.equal(ls.length, 1);
  assert.equal(ls[0].text, 'one two');
  assert.equal(ls[0].audience, 'players');
  // mute
  await upOk('dm', sid, 'mutable', 0, 70_000, 'alpha beta gamma delta');
  assert.equal((await lines('dm', sid)).find((l) => l.text.startsWith('alpha')).text, 'alpha beta gamma delta');
  await hold('dm', sid, 'mutable', 'mute', 70_700, 71_700);
  ls = await lines('dm', sid);
  assert.equal(ls.find((l) => l.text.startsWith('alpha')).text, 'alpha beta');
  // a mic that is off is refused
  await ok('POST', `${A()}/mics`, T.dm, { deviceId: 'dev-off', label: 'Unused', mode: 'off' });
  const off = (await ok('GET', `${A()}/mics`, T.dm)).find((m: any) => m.label === 'Unused');
  const r = await call('POST', `${A()}/sessions/${sid}/chunks?mic=${off.id}&seq=0&start=0&end=5000`, T.dm, undefined, chunk('ignored'));
  assert.equal(r.status, 409);
});

test('Audio_pending: no model means the audio is kept and a retry transcribes it', async () => {
  const sid = await newSession();
  modelUp = false;
  const r = await upOk('jess', sid, 'jess', 0, 0, 'saved for later');
  modelUp = true;
  assert.equal(r.status, 'pending');
  assert.equal((await lines('dm', sid)).length, 0);
  assert.ok(fs.existsSync(path.join(tmp, 'data', 'audio', W, sid, MIC.jess, '0.webm')));
  const retry = await ok('POST', `${A()}/retry`, T.dm);
  assert.ok(retry.transcribed >= 1);
  const ls = await lines('dm', sid);
  assert.equal(ls[0].text, 'saved for later');
});

test('Audio_retention: old raw audio is deleted, transcripts stay', async () => {
  const sid = await newSession();
  await upOk('jess', sid, 'jess', 0, 0, 'old memories');
  const file = path.join(tmp, 'data', 'audio', W, sid, MIC.jess, '0.webm');
  assert.ok(fs.existsSync(file));
  assert.equal(engine(deps).runRetention(Date.now() + 5 * 864e5), 0, 'not yet 30 days old');
  assert.ok(fs.existsSync(file));
  assert.ok(engine(deps).runRetention(Date.now() + 31 * 864e5) >= 1);
  assert.ok(!fs.existsSync(file));
  assert.equal(one<any>(deps.db, 'SELECT file FROM audio_chunks WHERE session_id = ?', sid).file, null);
  assert.equal((await lines('dm', sid))[0].text, 'old memories');
  // a world can shorten it
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { audioRetentionDays: 1 });
  const sid2 = await newSession();
  await upOk('jess', sid2, 'jess', 0, 0, 'recent news');
  run(deps.db, 'UPDATE audio_chunks SET created_at = ? WHERE session_id = ?', new Date(Date.now() - 2 * 864e5).toISOString(), sid2);
  assert.equal(engine(deps).runRetention(), 1);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { audioRetentionDays: 30 });
});

test('Audio_recording: the recording indicator is a live event for everyone', async () => {
  const feed = listen(T.jess);
  await feed.ready;
  const sid = await newSession();
  await ok('POST', `${A()}/sessions/${sid}/stop`, T.dm);
  await wait(100);
  feed.stop();
  const rec = feed.events.filter((e) => e.type === 'recording');
  assert.ok(rec.some((e) => e.data.on === true && e.data.sessionId));
  assert.equal(rec[rec.length - 1].data.on, false);
  assert.equal((await ok('GET', `${A()}/status`, T.jess)).recording, false);
});

function untar(buf: Buffer) {
  const out: Record<string, Buffer> = {};
  let o = 0;
  while (o + 512 <= buf.length) {
    const h = buf.subarray(o, o + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/, '').trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    assert.equal(sum, parseInt(h.toString('ascii', 148, 154), 8), 'tar checksum');
    out[prefix ? `${prefix}/${name}` : name] = buf.subarray(o + 512, o + 512 + size);
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

test('Audio_backup: the admin backup is a tar.gz with the database and the audio folder', async () => {
  const sid = await newSession();
  await upOk('jess', sid, 'jess', 0, 0, 'backup me up');
  const r = await fetch(`${base}/api/admin/backup`, { headers: { Authorization: `Bearer ${T.admin}` } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') ?? '', /\.tar\.gz/);
  const files = untar(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())));
  assert.ok(files['librarian.db'], Object.keys(files).join(', '));
  assert.equal(files['librarian.db'].toString('latin1', 0, 15), 'SQLite format 3');
  const audioName = `audio/${W}/${sid}/${MIC.jess}/0.webm`;
  assert.ok(files[audioName], Object.keys(files).filter((k) => k.startsWith('audio')).join(', '));
  assert.ok(files[audioName].toString('latin1').includes('FAKE:backup me up'));
  // the old plain download
  const plain = await fetch(`${base}/api/admin/backup?db=1`, { headers: { Authorization: `Bearer ${T.admin}` } });
  assert.equal(Buffer.from(await plain.arrayBuffer()).toString('latin1', 0, 15), 'SQLite format 3');
  assert.equal((await call('GET', '/api/admin/backup', T.dm)).status, 403);
});
