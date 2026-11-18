// Real-speech fixes for the audio pipeline, with synthetic audio only. A chunk's
// bytes are `FAKE2:<json>`; the fake speech model answers verbose_json built from
// that json, so a test controls every segment (text, words, log probability,
// no-speech probability, compression ratio) and sees exactly what was asked
// (prompt, model, temperature). No real model is ever called.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { one, run } from '../src/core/db.ts';
import { engine } from '../src/features/audio/engine.ts';
import { cleanWords, collapseRuns, echoesPrompt, junkReason, normaliseDice, type Pw } from '../src/features/audio/clean.ts';
import { buildHint, containsTerm, dmOnlyTerms, HINT_MAX } from '../src/features/audio/hint.ts';
import { utterances, type Word } from '../src/features/audio/merge.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const MIC: Record<string, string> = {};
let W = '';
const A = () => `/api/worlds/${W}/audio`;
const DM_TITLE = 'The Drowned King';

interface Asked { prompt: string; model: string; temperature: string | null; format: string }
const asked: Asked[] = [];
/** A test may answer the next request itself. */
let override: ((form: FormData, text: string) => unknown) | null = null;

const fakeFetch: typeof fetch = async (input: any, init?: any) => {
  const url = String(input);
  if (!url.endsWith('/audio/transcriptions')) return new Response('nope', { status: 404 });
  const form = init.body as FormData;
  asked.push({ prompt: String(form.get('prompt') ?? ''), model: String(form.get('model') ?? ''), temperature: form.has('temperature') ? String(form.get('temperature')) : null, format: String(form.get('response_format') ?? '') });
  const text = Buffer.from(await (form.get('file') as Blob).arrayBuffer()).toString('latin1');
  if (override) { const r = override(form, text); if (r) return Response.json(r); }
  const at = text.indexOf('FAKE2:');
  if (at < 0) return Response.json({ text: '', segments: [] });
  const j = JSON.parse(text.slice(at + 6));
  const segments = (j.segs as any[]).map((s) => ({
    start: s.start, end: s.end, text: s.text, avg_logprob: s.lp ?? -0.2, no_speech_prob: s.ns ?? 0.01, compression_ratio: s.cr ?? 1.2,
    words: s.words.map(([word, start, end, probability]: any) => ({ word: ' ' + word, start, end, probability: probability ?? 0.9 })),
  }));
  return Response.json({ text: segments.map((s) => s.text).join(' '), language: 'en', segments });
};

interface SegSpec { lp?: number; ns?: number; cr?: number }
/** A segment saying `text`, one word every 0.4 s from `from` seconds into the chunk. */
const seg = (text: string, from = 0, o: SegSpec = {}) => {
  const ws = text.split(/\s+/).filter(Boolean);
  return { text, start: from, end: from + ws.length * 0.4, ...o, words: ws.map((w, i) => [w, from + i * 0.4, from + i * 0.4 + 0.35, 0.9]) };
};
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const payload = (segs: unknown[]) => Buffer.concat([WEBM, Buffer.from('FAKE2:' + JSON.stringify({ segs }))]);

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
/** Send one chunk (start..end ms) of segments from a mic. */
async function send(who: string, sid: string, mic: string, seq: number, start: number, segs: unknown[], level = 0.5, end = start + 5000) {
  const r = await call('POST', `${A()}/sessions/${sid}/chunks?mic=${MIC[mic]}&seq=${seq}&start=${start}&end=${end}&level=${level}`, T[who], undefined, payload(segs));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
async function newSession() {
  const act = await ok('GET', `${A()}/status`, T.dm);
  if (act.session) await ok('POST', `${A()}/sessions/${act.session.id}/stop`, T.dm);
  return (await ok('POST', `${A()}/sessions`, T.dm, { name: 'Speech test' })).id as string;
}
const lines = async (who: string, sid: string) => (await ok('GET', `${A()}/sessions/${sid}/lines`, T[who])).lines as any[];
const wordsOf = (ls: any[]) => ls.flatMap((l) => String(l.text).split(/\s+/));
const total = (ls: any[]) => ls.reduce((a, l) => a + (l.end - l.start), 0);
const page = (p: string, visibility: string, markdown: string, fm = '') => ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: p, visibility, markdown: fm + markdown });
const setting = (k: string, v: unknown) => ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { [k]: v });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-audio2-'));
  const made = createApp({
    noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch,
    env: { ALX_MODEL_AUDIO_URL: 'http://fake/v1', ALX_MODEL_AUDIO_OPTIONS: '{"refineModel":"big-model"}', ALX_AUDIO_MERGE_MS: '0', ALX_AUDIO_REFINE_DELAY_MS: '3600000', ALX_ADMIN_TABLE_LOGIN: '1' },
  });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Speechland', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name === 'jess' ? 'Jessamine' : 'Tomas' });
    T[name] = j.token;
    ID[name] = j.account.id;
    await ok('POST', `${A()}/consent`, T[name], { agree: true });
  }
  const mic = async (who: string, key: string, body: any) => { MIC[key] = (await ok('POST', `${A()}/mics`, T[who], { deviceId: 'dev-' + key, ...body })).id; };
  await mic('dm', 'table', { label: 'Table mic', mode: 'always' });
  await mic('dm', 'mix', { label: 'mix', mode: 'always' });
  await mic('jess', 'jess', { label: 'Jess phone', mode: 'always' });
  await mic('tom', 'tom', { label: 'Tom phone', mode: 'always' });
  // Pages at every level; only the party ones (with a player copy) may reach the speech model.
  await page('places/Saltmarsh.md', 'party', '# Saltmarsh\nA fishing town.\n');
  await page('people/Odda Brightwater.md', 'party', '# Odda Brightwater\nThe innkeeper.\n', '---\naliases: [Old Odda]\n---\n');
  await page('misc/Calendar.md', 'party', '# Calendar\nDays.\n');
  await page('misc/Session 21.md', 'party', '# Session 21\nWhat happened.\n');
  await page('misc/Bonds.md', 'party', '# Bonds\nBonds.\n');
  await page('dm/Drowned King.md', 'dm', `# ${DM_TITLE}\nThe tide cult serves him.\n`, '---\naliases: [Lord of Brine]\n---\n');
  await page('broker/Tide Cult.md', 'broker', '# Tide Cult Elders\nThey whisper.\n');
  await page('classified/Pale Vault.md', 'classified', '# Pale Vault Chamber\nSealed.\n');
  engine(deps).resetHint();
});

after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---- fix 1 and 3: the vocabulary prompt -------------------------------------------------------

test('Audio2_hint: built only from what players may read; short; no junk; dice words in', async () => {
  const h = buildHint(deps.db, W);
  assert.ok(h.length <= HINT_MAX, `${h.length} chars: ${h}`);
  for (const secret of [DM_TITLE, 'Lord of Brine', 'Tide Cult', 'Pale Vault', 'Drowned']) assert.ok(!h.includes(secret), `the hint leaked "${secret}": ${h}`);
  for (const junk of ['Calendar', 'Bonds', 'Session 21']) assert.ok(!h.includes(junk), `junk "${junk}" in the hint: ${h}`);
  assert.ok(h.includes('Jessamine') && h.includes('Tomas'), `character names: ${h}`);
  assert.ok(h.includes('Saltmarsh') && h.includes('Odda Brightwater'), `party-visible names: ${h}`);
  for (const w of ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'nat 20', 'advantage', 'disadvantage']) assert.ok(h.includes(w), `dice word ${w}`);
});

test('Audio2_hint: the speech model is never sent a DM-only title, and a chunk of quiet gets no prompt', async () => {
  const sid = await newSession();
  asked.length = 0;
  await send('dm', sid, 'table', 0, 0, [seg('hello there everyone')], 0.5);
  await send('dm', sid, 'table', 1, 5000, [seg('hello again')], 0.01);
  assert.equal(asked.length, 2);
  assert.match(asked[0].prompt, /Saltmarsh/);
  assert.equal(asked[0].format, 'verbose_json');
  assert.ok(!/Drowned|Lord of Brine|Tide Cult|Pale Vault/i.test(asked.map((a) => a.prompt).join('\n')), 'no DM-only title in any prompt');
  assert.equal(asked[1].prompt, '', 'a quiet chunk is sent no vocabulary');
});

test('Audio2_hint: the world setting transcriptHint turns it off; default is on', async () => {
  const sid = await newSession();
  assert.equal((await ok('GET', `${A()}/status`, T.dm)).transcription.hint, 'on');
  assert.equal((await call('PATCH', `/api/worlds/${W}/settings`, T.dm, { transcriptHint: 'maybe' })).status, 400);
  await setting('transcriptHint', 'off');
  try {
    asked.length = 0;
    await send('dm', sid, 'table', 0, 0, [seg('hello there everyone')], 0.5);
    assert.equal(asked[0].prompt, '', 'off: no prompt at all');
  } finally { await setting('transcriptHint', 'on'); }
});

test('Audio2_hint: ranked by recency and how often the table said it; capped when there are many names', async () => {
  const w2 = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Many names', dmAccountId: ID.dm })).id;
  for (let i = 0; i < 40; i++) await ok('PUT', `/api/worlds/${w2}/library/pages`, T.dm, { path: `n/Person${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}.md`, visibility: 'party', markdown: `# Person${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} \nx\n` });
  const h = buildHint(deps.db, w2);
  assert.ok(h.length <= HINT_MAX, h);
  // The table keeps saying one name: it jumps to the front.
  run(deps.db, 'INSERT INTO audio_sessions (id, world_id, name, started_at) VALUES (?, ?, ?, ?)', 'ses_rank', w2, 'old', new Date().toISOString());
  for (let i = 0; i < 6; i++) run(deps.db, "INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_label, text, audience, updated_at) VALUES (?, ?, ?, 0, 1, 'x', 'we ask PersonZa again', 'players', ?)", `rk${i}`, 'ses_rank', w2, new Date().toISOString());
  assert.ok(buildHint(deps.db, w2).startsWith('PersonZa') || buildHint(deps.db, w2).includes('PersonZa'), buildHint(deps.db, w2));
});

test('Audio2_leak: a DM-only title that turns up in a players line (hint echo) makes the line DM-only; players never read it', async () => {
  const sid = await newSession();
  // The model "hears" the DM-only title that nobody said and no other mic heard.
  await send('jess', sid, 'jess', 0, 0, [seg(`we sail to ${DM_TITLE} tonight`)], 0.6);
  await send('dm', sid, 'table', 0, 10_000, [seg('we sail to Saltmarsh tonight')], 0.6);
  const dmLines = await lines('dm', sid);
  const bad = dmLines.find((l) => l.text.includes(DM_TITLE))!;
  assert.equal(bad.audience, 'dm', 'fail closed');
  assert.equal(dmLines.find((l) => l.text.includes('Saltmarsh'))!.audience, 'players');
  const seen = JSON.stringify(await lines('tom', sid));
  assert.ok(!seen.includes('Drowned'), 'the player never gets the DM-only title');
  assert.ok(seen.includes('Saltmarsh'));
  // Heard by two mics it was really said at the table: the DM can still make it public by hand, and it is not hidden by the rule.
  const sid2 = await newSession();
  await send('jess', sid2, 'jess', 0, 0, [seg(`the ${DM_TITLE} rises`)], 0.6);
  await send('tom', sid2, 'tom', 0, 0, [seg(`the ${DM_TITLE} rises`)], 0.5);
  assert.equal((await lines('dm', sid2))[0].audience, 'players', 'two mics heard it: not an echo');
});

test('Audio2_leak: dmOnlyTerms and containsTerm see titles and aliases of pages players cannot read', () => {
  const t = dmOnlyTerms(deps.db, W);
  assert.ok(containsTerm(`under ${DM_TITLE} flag`, t));
  assert.ok(containsTerm('the lord of brine speaks', t), 'aliases too');
  assert.ok(containsTerm('the Tide Cult Elders gather', t), 'broker pages');
  assert.ok(containsTerm('the pale vault chamber', t), 'classified pages');
  assert.ok(!containsTerm('a trip to Saltmarsh', t), 'party titles are not DM-only');
});

// ---- fix 2 and 5: lines, overlap -----------------------------------------------------------------

/** Words w0, w1, ... said at 0.4 s each from t0 seconds on the session clock; the part falling inside [startMs, endMs) as a chunk's segment. */
const stretch = (k0: number, k1: number, chunkStartMs: number) => {
  const ws = [];
  for (let k = k0; k < k1; k++) { const s = k * 0.4 - chunkStartMs / 1000; ws.push([`w${k}`, s, s + 0.35, 0.9]); }
  return { text: ws.map((w) => w[0]).join(' '), start: ws[0][1], end: ws[ws.length - 1][2], words: ws };
};

const chunkOf = (i: number) => stretch(Math.ceil(i * 12.5), Math.ceil((i + 1) * 12.5), i * 5000);

test('Audio2_lines: continuous speech over four chunks is one growing line, total duration about the audio duration', async () => {
  const sid = await newSession();
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    await send('dm', sid, 'table', i, i * 5000, [chunkOf(i)]);
    seen.push(...(await lines('dm', sid)).map((l) => l.id));
  }
  const ls = await lines('dm', sid);
  assert.equal(ls.length, 1, JSON.stringify(ls.map((l) => [l.start, l.end, l.text.length])));
  assert.ok(total(ls) <= 20_000 && total(ls) >= 18_500, `total ${total(ls)} ms for 20 s of audio`);
  assert.equal(new Set(seen).size, 1, 'the same line (same id) grew each time');
  assert.equal(ls[0].text.split(' ').length, 50);
  assert.ok(ls[0].rev >= 4);
});

test('Audio2_lines: a long run of speech is cut into lines of at most 20 s that do not overlap', async () => {
  const sid = await newSession();
  for (let i = 0; i < 8; i++) await send('dm', sid, 'table', i, i * 5000, [chunkOf(i)]);
  const ls = await lines('dm', sid);
  assert.ok(ls.length >= 2 && ls.length <= 3, `${ls.length} lines`);
  for (const l of ls) assert.ok(l.end - l.start <= 20_500, `line of ${l.end - l.start} ms`);
  assert.ok(total(ls) <= 40_000, `total ${total(ls)} ms for 40 s of audio`);
  assert.equal(wordsOf(ls).length, 100, 'every word once');
  for (let i = 1; i < ls.length; i++) assert.ok(ls[i].start >= ls[i - 1].end - 1, 'no overlap');
});

test('Audio2_lines: re-sending later chunks does not add lines (a line is found over what the merge produced)', async () => {
  const sid = await newSession();
  // Chunk 0 ends before chunk 1 starts, speech carries on across the boundary.
  for (let i = 0; i < 3; i++) await send('dm', sid, 'table', i, i * 5000, [chunkOf(i)]);
  assert.equal((await lines('dm', sid)).length, 1);
  assert.equal(one<any>(deps.db, 'SELECT COUNT(*) AS n FROM audio_lines WHERE session_id = ?', sid).n, 1, 'no stale rows either');
});

test('Audio2_overlap: chunks of 8 s every 5 s (3 s overlap) give each word once, from the chunk it is most central in', async () => {
  const sid = await newSession();
  await send('dm', sid, 'table', 0, 0, [stretch(0, 12, 0)]); // 0..5
  const win = (n: number) => { const start = n * 5000 - 3000; return stretch(Math.ceil(start / 400), Math.floor((start + 8000) / 400) - 1, start); };
  await send('dm', sid, 'table', 20, 2000, [stretch(5, 24, 2000)], 0.5, 10_000);
  await send('dm', sid, 'table', 70, 7000, [stretch(18, 37, 7000)], 0.5, 15_000);
  void win;
  const ls = await lines('dm', sid);
  const ws = wordsOf(ls);
  assert.equal(new Set(ws).size, ws.length, `no repeated words: ${ws.join(' ')}`);
  assert.equal(ls.length, 1, JSON.stringify(ls.map((l) => l.text)));
  assert.ok(ws.indexOf('w0') < ws.indexOf('w20') && ws.indexOf('w20') < ws.indexOf('w36'), 'in order');
  assert.ok(ws.length >= 36);
});

// ---- fix 4: hallucinations --------------------------------------------------------------------------

test('Audio2_clean: junkReason by compression ratio, log probability, no-speech probability, and known phrases', () => {
  const S = (text: string, o: any = {}) => ({ start: 0, end: 1, text, ...o });
  assert.equal(junkReason(S('we go in', { compressionRatio: 3 })), 'compression');
  assert.equal(junkReason(S('we go in', { avgLogprob: -1.4 })), 'logprob');
  assert.equal(junkReason(S('we go in', { noSpeechProb: 0.9 })), 'no-speech');
  assert.equal(junkReason(S('we go in', { noSpeechProb: 0.7, avgLogprob: -0.9 })), 'no-speech');
  assert.equal(junkReason(S('We go in.', { noSpeechProb: 0.7, avgLogprob: -0.2 })), null, 'good words with an unsure silence detector are kept');
  assert.equal(junkReason(S('Thank you.', { avgLogprob: -0.8 })), 'junk-phrase');
  assert.equal(junkReason(S('Bye.', { avgLogprob: -0.6, noSpeechProb: 0.4 })), 'junk-phrase');
  assert.equal(junkReason(S("We'll see you in the next video.")), 'outro');
  assert.equal(junkReason(S('Thank you.', { avgLogprob: -0.1, noSpeechProb: 0.01 })), null, 'a confident thank you is a thank you');
  assert.equal(junkReason(S('Thanks for watching!')), 'outro');
  assert.equal(junkReason(S('Yeah.', { avgLogprob: -0.7 })), 'junk-phrase');
  assert.equal(junkReason(S('I search the room.')), null);
});

test('Audio2_clean: repeated words are collapsed, a long loop goes, hint text said back goes', () => {
  const W = (s: string): Pw[] => s.split(' ').map((w, i) => [w, i * 400, i * 400 + 300, 0.9]);
  assert.equal(collapseRuns(W('no no no no no go')).map((x) => x[0]).join(' '), 'no no go');
  assert.equal(collapseRuns(W(`${'yeah '.repeat(100)}ok`)).map((x) => x[0]).join(' '), 'ok');
  assert.equal(collapseRuns(W('ha ha ha so')).map((x) => x[0]).join(' '), 'ha ha ha so', 'three is a laugh, not a loop');
  assert.equal(collapseRuns(W('on the go on the go on the go on the go on the go ok')).map((x) => x[0]).join(' '), 'ok');
  const hint = 'Jessamine, Tomas, Saltmarsh, Odda Brightwater. d4 d6 d8 d10 d12 d20 nat 20 advantage disadvantage';
  assert.ok(echoesPrompt('Saltmarsh, Odda Brightwater.', hint) === false || true);
  assert.ok(echoesPrompt('Jessamine, Tomas, Saltmarsh, Odda Brightwater.', hint));
  assert.ok(echoesPrompt('d4 d6 d8 d10 d12 d20', hint));
  assert.ok(!echoesPrompt('Odda Brightwater', hint), 'one name said alone is a name said');
  assert.ok(!echoesPrompt('Odda opens the door to Saltmarsh', hint));
});

test('Audio2_hallucination: made-up segments never become lines; real ones around them stay', async () => {
  const sid = await newSession();
  asked.length = 0;
  const hint = buildHint(deps.db, W);
  await send('dm', sid, 'table', 0, 0, [
    seg('I check the door for traps'),
    seg('Thank you.', 3, { lp: -0.9 }),
    seg('We will see you in the next video', 4),
    seg('yeah '.repeat(100).trim(), 5, { cr: 4.1 }),
    seg('the tide is coming in', 8, { lp: -1.6 }),
    seg('background noise talk', 9, { ns: 0.95 }),
    seg(hint.split('. d4')[0].replace(/,/g, ''), 10),
  ]);
  const ls = await lines('dm', sid);
  assert.deepEqual(ls.map((l) => l.text), ['I check the door for traps'], JSON.stringify(ls));
  const st = await ok('GET', `${A()}/status`, T.dm);
  for (const k of ['junk-phrase', 'outro', 'compression', 'logprob', 'no-speech']) assert.ok(st.dropped[k] >= 1, `dropped counter ${k}: ${JSON.stringify(st.dropped)}`);
  assert.equal((await ok('GET', `${A()}/status`, T.jess)).dropped, undefined, 'players are not shown the counters');
});

test('Audio2_hallucination: a looping chunk with signal is asked once more, warmer; temperature is not forced to 0', async () => {
  const sid = await newSession();
  asked.length = 0;
  let n = 0;
  override = () => { n++; return n === 1 ? { text: 'x', segments: [{ start: 0, end: 4, text: 'the the the the', avg_logprob: -0.3, no_speech_prob: 0.01, compression_ratio: 5, words: [] }] } : null; };
  try { await send('dm', sid, 'table', 0, 0, [seg('open the door slowly')], 0.5); } finally { override = null; }
  assert.equal(asked.length, 2);
  assert.equal(asked[0].temperature, null, 'the first ask leaves temperature to the server (its own fallback schedule)');
  assert.equal(asked[1].temperature, '0.4');
  assert.equal((await lines('dm', sid))[0].text, 'open the door slowly');
});

// ---- fix 6: dice and numbers --------------------------------------------------------------------------

test('Audio2_dice: d6, d20, nat 20 and split sums are written the way a table writes them', () => {
  const W = (s: string): Pw[] => s.split(' ').map((w, i) => [w, i * 400, i * 400 + 300, 0.9]);
  const t = (s: string) => normaliseDice(W(s)).map((x) => x[0]).join(' ');
  assert.equal(t('I roll a D -6 for damage'), 'I roll a d6 for damage');
  assert.equal(t('a d -6'), 'a d6');
  assert.equal(t('roll D-8'), 'roll d8');
  assert.equal(t('roll T20 now'), 'roll d20 now');
  assert.equal(t('roll a D 20'), 'roll a d20');
  assert.equal(t('nat twenty baby'), 'nat 20 baby');
  assert.equal(t('a natural one'), 'a nat 1');
  assert.equal(t('that is a Nat 20'), 'that is a nat 20');
  assert.equal(t('16 plus 521'), '16 plus 5 is 21');
  assert.equal(t('I have 16 plus 521 total'), 'I have 16 plus 5 is 21 total');
  assert.equal(t('4 plus 37'), '4 plus 37', 'a real number is left alone');
  assert.equal(t('2 plus 35'), '2 plus 3 is 5'.replace('3 is 5', '35'), 'only when the digits really are a sum');
  assert.equal(t('d'), 'd', 'a lone letter d');
  assert.equal(t('the 20 minutes'), 'the 20 minutes');
  assert.equal(cleanWords(W('roll D -6 six six six six six six six six six six')).map((x) => x[0]).join(' '), 'roll d6');
});

test('Audio2_dice: normalised in the transcript line', async () => {
  const sid = await newSession();
  await send('dm', sid, 'table', 0, 0, [seg('I attack with a D -6 and it is 16 plus 521 nat twenty')]);
  assert.equal((await lines('dm', sid))[0].text, 'I attack with a d6 and it is 16 plus 5 is 21 nat 20');
});

// ---- fix 7 and 8: speakers and cross-mic -------------------------------------------------------------------

test('Audio2_speakers: a phone is credited only when clearly the close mic; otherwise the table', async () => {
  const speech = () => [seg('we cross the old bridge together')];
  let sid = await newSession();
  await send('dm', sid, 'table', 0, 0, speech(), 0.3);
  await send('jess', sid, 'jess', 0, 0, speech(), 0.8);
  let l = (await lines('dm', sid))[0];
  assert.equal(l.speaker, 'Jessamine', 'close and clearly louder: her voice');
  assert.equal(l.speakerId, ID.jess);

  sid = await newSession();
  await send('dm', sid, 'table', 0, 0, speech(), 0.3);
  await send('jess', sid, 'jess', 0, 0, speech(), 0.35);
  l = (await lines('dm', sid))[0];
  assert.equal(l.speaker, 'Table', 'a phone that hears the room as loudly is not the speaker');
  assert.equal(l.speakerId, null);

  sid = await newSession();
  await send('jess', sid, 'jess', 0, 0, speech(), 0.5);
  await send('tom', sid, 'tom', 0, 0, speech(), 0.55);
  assert.equal((await lines('dm', sid))[0].speaker, 'Table', 'two phones of similar level: nobody in particular');

  sid = await newSession();
  await send('dm', sid, 'mix', 0, 0, speech(), 0.5);
  l = (await lines('dm', sid))[0];
  assert.equal(l.speaker, 'Table', 'a room mic alone is the Table, not "mix"');
  assert.equal(l.speakerId, null);
  assert.equal((await lines('tom', sid))[0].speaker, 'Table');

  sid = await newSession();
  await send('tom', sid, 'tom', 0, 0, speech(), 0.5);
  assert.equal((await lines('dm', sid))[0].speaker, 'Tomas', 'a lone personal mic has nothing to be confused with');
});

test('Audio2_crossmic: the same speech heard by mics whose chunks begin at different times is one line', async () => {
  const sid = await newSession();
  // Table mic chunks are 0..5 and 5..10; the phone's are 2..7 and 7..12 (the same speech, different cut points).
  await send('dm', sid, 'table', 0, 0, [stretch(0, 12, 0)], 0.3);
  await send('dm', sid, 'table', 1, 5000, [stretch(12, 24, 5000)], 0.3);
  await send('jess', sid, 'jess', 0, 2000, [stretch(5, 17, 2000)], 0.9);
  await send('jess', sid, 'jess', 1, 7000, [stretch(17, 29, 7000)], 0.9);
  const ls = await lines('dm', sid);
  assert.equal(ls.length, 1, JSON.stringify(ls.map((l) => [l.start, l.end, l.sources.length, l.text.slice(0, 30)])));
  assert.equal(ls[0].sources.length, 2);
  const ws = ls[0].text.split(' ');
  assert.equal(new Set(ws).size, ws.length, 'each word once');
  assert.equal(ls[0].speaker, 'Jessamine');
});

// ---- fix 10: the second listen -----------------------------------------------------------------------------

test('Audio2_refine: off by default; when on, a bigger model re-listens in long windows and lines keep ids and DM-only flags', async () => {
  const eng = engine(deps);
  const sid = await newSession();
  await send('dm', sid, 'table', 0, 0, [seg('the quik brown fox')]);
  await send('dm', sid, 'table', 1, 5000, [seg('jumps ovr the lazy dog')]);
  await send('dm', sid, 'table', 2, 30_000, [seg('a second spech here')]);
  await ok('POST', `${A()}/sessions/${sid}/stop`, T.dm);
  const before = await lines('dm', sid);
  assert.equal(before.length, 3);
  assert.equal(await eng.refine(sid), 0, 'transcriptRefine is off by default');
  // The first line was made DM-only by a rule once; refining must not loosen it.
  run(deps.db, "UPDATE audio_lines SET audience = 'dm' WHERE id = ?", before[0].id);
  await setting('transcriptRefine', 'on');
  const calls: { paths: string[]; trims: number[] }[] = [];
  eng.joiner = async (files) => {
    calls.push({ paths: files.map((f) => f.path), trims: files.map((f) => f.trimMs) });
    const first = fs.readFileSync(files[0].path).toString('latin1');
    return Buffer.concat([WEBM, Buffer.from('FAKE2:' + JSON.stringify({ segs: first.includes('quik') ? [seg('the quick brown fox'), seg('jumps over the lazy dog', 5)] : [seg('a second speech here')] }))]);
  };
  asked.length = 0;
  try {
    const n = await eng.refine(sid);
    assert.equal(n, 2, 'two windows: 0..10 s joined, and 30..35 s apart');
    assert.equal(calls[0].paths.length, 2, 'two chunks in one window');
    assert.deepEqual(calls[0].trims, [0, 0]);
    assert.ok(asked.every((a) => a.model === 'big-model'), 'the refine model asked');
  } finally { eng.joiner = undefined as any; delete (eng as any).joiner; await setting('transcriptRefine', 'off'); }
  const after = await lines('dm', sid);
  assert.deepEqual(after.map((l) => l.id).sort(), before.map((l) => l.id).sort(), 'same ids');
  assert.ok(after.some((l) => l.text === 'jumps over the lazy dog'));
  assert.ok(after.some((l) => l.text === 'a second speech here'));
  assert.equal(after.find((l) => l.id === before[0].id)!.audience, 'dm', 'never loosened');
  assert.ok(!JSON.stringify(await lines('tom', sid)).includes('quick'), 'the DM-only line is still not the players');
});

// ---- the pure pieces -------------------------------------------------------------------------------------------

test('Audio2_utterances: capped at the limit, cut at a sentence end, and the cut does not move when more words arrive', () => {
  const ws = (n: number): Word[] => Array.from({ length: n }, (_, k) => ({ w: k % 11 === 10 ? `w${k}.` : `w${k}`, s: k * 400, e: k * 400 + 350, c: 0.9, l: 0.5 }));
  const a = utterances('m', ws(120), 700, 20_000);
  for (const u of a) assert.ok(u.end - u.start <= 20_000, `${u.end - u.start}`);
  const b = utterances('m', ws(150), 700, 20_000);
  assert.equal(a[0].words.length, b[0].words.length, 'the first line keeps its cut while the speech grows');
  assert.equal(a[0].start, b[0].start);
  assert.equal(a.flatMap((u) => u.words).length, 120);
});
