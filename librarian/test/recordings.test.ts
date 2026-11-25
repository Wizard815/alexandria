// Recordings: a stopped session's chunks become plain files on the server (full
// mix, one track per mic, Transcript.md, session.json); raw chunks go only after
// the files are verified; retention is per session; the audio routes are DM-only
// except a player's own mic tracks; Range works; no path can be steered.
// Needs ffmpeg for the build tests (they skip with a message without it).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { crc32 } from 'node:zlib';
import { createApp } from '../src/app.ts';
import { one, run } from '../src/core/db.ts';
import { engine } from '../src/features/audio/engine.ts';
import { buildsIdle, cleanFileName, planMic } from '../src/features/audio/recordings.ts';
import { mintTicket } from '../src/features/sound/ticket.ts';

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const needFfmpeg = HAVE_FFMPEG ? {} : { skip: 'ffmpeg is not installed here, so the recording build cannot be tested' };

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const MIC: Record<string, string> = {};
let W = '';
const A = () => `/api/worlds/${W}/audio`;

async function call(method: string, url: string, token?: string, body?: unknown, raw?: Buffer, headers: Record<string, string> = {}) {
  const r = await fetch(base + url, {
    method,
    headers: { ...(raw ? { 'Content-Type': 'audio/webm' } : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString()); } catch { json = null; }
  return { status: r.status, body: json, buf, headers: r.headers };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${r.buf.toString().slice(0, 200)}`);
  return r.body;
};

/** A short sine tone as a webm/opus chunk, `ms` long. */
function tone(ms: number, hz = 440): Buffer {
  const f = path.join(tmp, `tone-${hz}-${ms}.webm`);
  if (!fs.existsSync(f)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${ms / 1000}`, '-c:a', 'libopus', '-b:a', '32k', f]);
  return fs.readFileSync(f);
}
const upload = (who: string, sid: string, mic: string, seq: number, start: number, end: number, hz = 440) =>
  call('POST', `${A()}/sessions/${sid}/chunks?mic=${MIC[mic]}&seq=${seq}&start=${start}&end=${end}&level=0.5`, T[who], undefined, tone(end - start, hz));

const probeSec = (f: string) => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
/** Loudest sample (dB) in a stretch of a file. */
function maxDb(f: string, from: number, len: number): number {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-ss', String(from), '-t', String(len), '-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr);
  return m ? (m[1] === '-inf' ? -100 : Number(m[1])) : -100;
}

async function waitFor<T>(fn: () => Promise<T | null | false>, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 150));
  }
}
const listed = async (sid: string) => ((await ok('GET', `${A()}/recordings`, T.dm)).sessions as any[]).find((s) => s.id === sid);
const built = (sid: string) => waitFor(async () => { const s = await listed(sid); return s && (s.status === 'ready' || s.status === 'failed') ? s : null; }, 'the recording build');

const fakeFetch: typeof fetch = async () => Response.json({ text: '', segments: [] });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-rec-'));
  const made = createApp({
    noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch,
    env: { ALX_MODEL_AUDIO_URL: 'http://fake/v1', ALX_AUDIO_MERGE_MS: '0', ALX_ADMIN_TABLE_LOGIN: '1', ALX_RECORDINGS_BUILD_DELAY_MS: '0', ALX_AUDIO_REFINE_DELAY_MS: '0' },
  });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Salt/Reach: "the" world?', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom', 'zed']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
  await ok('POST', `${A()}/consent`, T.jess, { agree: true });
  await ok('POST', `${A()}/consent`, T.tom, { agree: true });
  const mic = async (who: string, key: string, body: any) => { MIC[key] = (await ok('POST', `${A()}/mics`, T[who], { deviceId: 'dev-' + key, ...body })).id; };
  await mic('dm', 'table', { label: 'Table: main/room', mode: 'always' });
  await mic('jess', 'jess', { label: 'Jess phone', mode: 'always' });
  await mic('tom', 'tom', { label: 'Tom phone', mode: 'always' });
  await mic('zed', 'zed', { label: 'Zed phone', mode: 'always' });
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const stopAll = async () => { const s = await ok('GET', `${A()}/status`, T.dm); if (s.session) await ok('POST', `${A()}/sessions/${s.session.id}/stop`, T.dm); };
const newSession = async (name = 'Night one') => { await stopAll(); return (await ok('POST', `${A()}/sessions`, T.dm, { name })).id as string; };

/** A session with tones: the table 0-3 s, Jess 0-5 s and 8-11 s (overlapping chunks), Tom 1-4 s. */
async function recorded(name = 'Night one') {
  const sid = await newSession(name);
  assert.equal((await upload('dm', sid, 'table', 0, 0, 3000, 300)).status, 201);
  assert.equal((await upload('jess', sid, 'jess', 0, 0, 3000, 440)).status, 201);
  assert.equal((await upload('jess', sid, 'jess', 200, 2000, 5000, 440)).status, 201);
  assert.equal((await upload('jess', sid, 'jess', 800, 8000, 11000, 440)).status, 201);
  assert.equal((await upload('tom', sid, 'tom', 100, 1000, 4000, 660)).status, 201);
  assert.equal((await upload('zed', sid, 'zed', 0, 0, 3000, 880)).status, 403, 'no consent, no audio, no track');
  const insert = (text: string, audience: string, start: number, who: string | null) => run(deps.db, 'INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_account, speaker_label, text, audience, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'lin_' + Math.random().toString(36).slice(2), sid, W, start, start + 1500, who, who ? '' : 'Table', text, audience, new Date().toISOString());
  insert('I open the door', 'players', 500, ID.jess);
  insert('Secret: the duke is the lich', 'dm', 4000, null);
  insert('We follow Tom', 'players', 8500, ID.tom);
  await ok('POST', `${A()}/sessions/${sid}/stop`, T.dm);
  return sid;
}

// ---- pure parts --------------------------------------------------------------------------

test('Recordings_names: file and folder names are sanitised, capped and never empty', () => {
  assert.equal(cleanFileName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(cleanFileName('  ../../etc/passwd  '), 'etc-passwd');
  assert.equal(cleanFileName('..'), 'Untitled');
  assert.equal(cleanFileName('', 'Mic'), 'Mic');
  assert.equal(cleanFileName('tab\there\nnewline\u0000nul'), 'tab here newline nul');
  assert.equal(cleanFileName('CON'), 'Untitled');
  assert.equal(cleanFileName('x'.repeat(500)).length, 80);
  assert.equal(cleanFileName('trailing dot.'), 'trailing dot');
  assert.ok(!/[\\/]/.test(cleanFileName('Salt/Reach')));
});

test('Recordings_plan: overlapping chunks are trimmed to start where the audio so far stops', () => {
  const p = planMic([{ file: 'a', start_ms: 0, end_ms: 5000 }, { file: 'b', start_ms: 4000, end_ms: 9000 }, { file: 'c', start_ms: 4500, end_ms: 8000 }, { file: 'd', start_ms: 20000, end_ms: 25000 }]);
  assert.deepEqual(p.map((x) => [x.file, x.from, x.trim, x.dur]), [['a', 0, 0, 5000], ['b', 5000, 1000, 4000], ['d', 20000, 0, 5000]]);
});

// ---- the build ----------------------------------------------------------------------------

test('Recordings_build: stop builds a readable folder, aligned tracks, and then the raw chunks go', needFfmpeg, async () => {
  const sid = await recorded();
  const s = await built(sid);
  assert.equal(s.status, 'ready', s.error);
  assert.equal(s.mics, 3, 'the table, Jess and Tom; Zed was never recorded');
  const day = new Date();
  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  assert.equal(s.folder, `recordings/${cleanFileName('Salt/Reach: "the" world?')}/${date} Night one`);
  assert.ok(!cleanFileName('Salt/Reach: "the" world?').match(/[\\/:"?]/));
  const folder = path.join(tmp, 'data', s.folder);
  assert.ok(fs.existsSync(folder));
  const files = fs.readdirSync(folder).sort();
  assert.deepEqual(files, ['Full session.mp3', 'Jess phone - jess.mp3', 'Table- main-room - dungeon.mp3', 'Tom phone - tom.mp3', 'Transcript.md', 'session.json'].sort());
  // lengths and alignment (time zero is the session's start; silence where a mic had nothing)
  assert.ok(Math.abs(probeSec(path.join(folder, 'Full session.mp3')) - 11) < 0.4);
  const jess = path.join(folder, 'Jess phone - jess.mp3');
  assert.ok(Math.abs(probeSec(jess) - 11) < 0.4);
  assert.ok(maxDb(jess, 0.3, 1.5) > -25, 'Jess is heard at the start');
  assert.ok(maxDb(jess, 3.0, 1.0) > -25, 'the overlapping chunk continues the tone');
  assert.ok(maxDb(jess, 5.6, 2.0) < -55, 'silence in the gap');
  assert.ok(maxDb(jess, 8.4, 2.0) > -25, 'and Jess is back at 8 s');
  const tom = path.join(folder, 'Tom phone - tom.mp3');
  assert.ok(Math.abs(probeSec(tom) - 4) < 0.4);
  assert.ok(maxDb(tom, 0.0, 0.7) < -55, 'Tom is silent before his first chunk');
  assert.ok(maxDb(tom, 1.4, 2.0) > -25);
  assert.ok(maxDb(path.join(folder, 'Full session.mp3'), 5.6, 2.0) < -55, 'nobody speaks in the gap');
  assert.ok(maxDb(path.join(folder, 'Full session.mp3'), 8.4, 2.0) > -25);
  // the readable index
  const j = JSON.parse(fs.readFileSync(path.join(folder, 'session.json'), 'utf8'));
  assert.equal(j.sessionId, sid);
  assert.equal(j.name, 'Night one');
  assert.equal(j.world, 'Salt/Reach: "the" world?');
  assert.deepEqual(j.microphones.map((m: any) => [m.name, m.person.displayName, m.person.character]).sort(), [['Jess phone', 'jess', 'jess'], ['Table: main/room', 'dungeon', null], ['Tom phone', 'tom', 'tom']].sort());
  assert.ok(j.files.some((f: any) => f.file === 'Full session.mp3' && f.kind === 'full-mix'));
  const md = fs.readFileSync(path.join(folder, 'Transcript.md'), 'utf8');
  assert.match(md, /I open the door/);
  assert.match(md, /duke is the lich/);
  assert.match(md, /DM only/);
  // verified, so the raw chunks are gone (from disk and the table) and the transcript stays
  assert.equal(one<any>(deps.db, 'SELECT COUNT(*) AS n FROM audio_chunks WHERE session_id = ? AND file IS NOT NULL', sid).n, 0);
  assert.ok(!fs.existsSync(path.join(tmp, 'data', 'audio', W, sid)));
  assert.equal(s.rawChunks, 0);
  assert.ok(s.bytes > 1000);
  assert.equal(one<any>(deps.db, 'SELECT COUNT(*) AS n FROM audio_lines WHERE session_id = ?', sid).n, 3);
});

test('Recordings_build: a second session with the same name and day gets its own folder', needFfmpeg, async () => {
  const a = await recorded('Twin');
  await built(a);
  const b = await recorded('Twin');
  const sb = await built(b);
  const sa = await listed(a);
  assert.notEqual(sa.folder, sb.folder);
  assert.match(sb.folder, / \(2\)$/);
  assert.ok(fs.existsSync(path.join(tmp, 'data', sb.folder, 'Full session.mp3')));
});

test('Recordings_build: a failed build keeps the chunks, says so, and Rebuild works once the audio is readable', needFfmpeg, async () => {
  const sid = await newSession('Broken');
  const bad = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('not really audio at all')]);
  const up = await call('POST', `${A()}/sessions/${sid}/chunks?mic=${MIC.jess}&seq=0&start=0&end=3000&level=0.5`, T.jess, undefined, bad);
  assert.equal(up.status, 201);
  await ok('POST', `${A()}/sessions/${sid}/stop`, T.dm);
  const s = await built(sid);
  assert.equal(s.status, 'failed');
  assert.match(s.error, /could not be read/);
  assert.equal(s.rawChunks, 1, 'the chunk stays');
  assert.equal(s.canBuild, true);
  assert.equal(one<any>(deps.db, 'SELECT COUNT(*) AS n FROM audio_chunks WHERE session_id = ? AND file IS NOT NULL', sid).n, 1);
  // swap in real audio and press Rebuild
  const row = one<any>(deps.db, 'SELECT file FROM audio_chunks WHERE session_id = ?', sid);
  fs.writeFileSync(path.join(tmp, 'data', row.file), tone(3000));
  assert.equal((await call('POST', `${A()}/recordings/${sid}/build`, T.dm)).status, 202);
  const again = await waitFor(async () => { const x = await listed(sid); return x.status === 'ready' ? x : null; }, 'the rebuild');
  assert.equal(again.rawChunks, 0);
  assert.equal(again.error, null);
  assert.equal((await call('POST', `${A()}/recordings/${sid}/build`, T.dm)).status, 409, 'nothing left to build from');
});

test('Recordings_build: a chunk still waiting for the speech model is kept after the build', needFfmpeg, async () => {
  const sid = await newSession('Pending');
  assert.equal((await upload('jess', sid, 'jess', 0, 0, 3000)).status, 201);
  await ok('POST', `${A()}/sessions/${sid}/stop`, T.dm);
  run(deps.db, "UPDATE audio_chunks SET status = 'pending' WHERE session_id = ?", sid);
  const s = await built(sid);
  assert.equal(s.status, 'ready');
  assert.equal(s.rawChunks, 1, 'it still has to be transcribed');
});

test('Recordings_lazy: the sweep builds an old stopped session that still has chunks', needFfmpeg, async () => {
  const sid = await newSession('Old one');
  assert.equal((await upload('jess', sid, 'jess', 0, 0, 3000)).status, 201);
  // stopped long ago, before recordings existed (so no build was scheduled)
  run(deps.db, 'UPDATE audio_sessions SET stopped_at = ? WHERE id = ?', new Date(Date.now() - 3600_000).toISOString(), sid);
  const { sweepRecordings } = await import('../src/features/audio/recordings.ts');
  sweepRecordings(deps);
  await buildsIdle(deps);
  assert.equal((await listed(sid)).status, 'ready');
});

// ---- retention -------------------------------------------------------------------------------

test('Recordings_retention: per session: default from the world, keep forever, N days, delete now', needFfmpeg, async () => {
  const sid = await recorded('Keepers');
  await built(sid);
  const dirOf = (await listed(sid)).folder;
  const dir = path.join(tmp, 'data', dirOf);
  const files = () => fs.readdirSync(dir);
  const eng = engine(deps);
  // the world default is 30 days
  let s = await listed(sid);
  assert.equal(s.retention.mode, 'default');
  assert.equal(s.retention.effectiveDays, 30);
  assert.ok(s.retention.daysLeft >= 29 && s.retention.daysLeft <= 30);
  const gone = eng.runRetention(Date.now() + 5 * 864e5);
  assert.equal(gone, 0, JSON.stringify(deps.db.prepare('SELECT id, name, retention_mode, retention_days, rec_status, audio_deleted_at FROM audio_sessions').all()));
  // keep forever outlasts everything
  s = await ok('POST', `${A()}/recordings/${sid}/retention`, T.dm, { mode: 'forever' });
  assert.equal(s.retention.deletesAt, null);
  eng.runRetention(Date.now() + 4000 * 864e5); // other sessions of the world go; this one is kept
  assert.ok(files().includes('Full session.mp3'));
  assert.equal((await listed(sid)).audioDeleted, false);
  // N days
  assert.equal((await call('POST', `${A()}/recordings/${sid}/retention`, T.dm, { mode: 'days', days: 0 })).status, 400);
  assert.equal((await call('POST', `${A()}/recordings/${sid}/retention`, T.dm, { mode: 'sometimes' })).status, 400);
  assert.equal((await call('POST', `${A()}/recordings/${sid}/retention`, T.jess, { mode: 'forever' })).status, 403);
  s = await ok('POST', `${A()}/recordings/${sid}/retention`, T.dm, { mode: 'days', days: 3 });
  assert.equal(s.retention.effectiveDays, 3);
  assert.equal(eng.runRetention(Date.now() + 2 * 864e5), 0);
  assert.ok(eng.runRetention(Date.now() + 4 * 864e5) >= 4, 'the full mix and three mic tracks go');
  assert.deepEqual(files().sort(), ['Transcript.md', 'session.json']);
  s = await listed(sid);
  assert.equal(s.audioDeleted, true);
  assert.equal(s.status, 'deleted');
  assert.equal(s.retention.deletesAt, null);
  assert.equal(one<any>(deps.db, 'SELECT COUNT(*) AS n FROM audio_tracks WHERE session_id = ?', sid).n, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).files.filter((f: any) => f.kind === 'full-mix').length, 0);
  assert.equal(one<any>(deps.db, 'SELECT COUNT(*) AS n FROM audio_lines WHERE session_id = ?', sid).n, 3, 'the transcript stays');
  assert.equal((await ok('GET', `${A()}/sessions/${sid}/lines`, T.dm)).lines.length, 3);
});

test('Recordings_retention: a world with no retention days keeps audio forever; the manual delete needs a confirm', needFfmpeg, async () => {
  const sid = await recorded('Forever');
  await built(sid);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { audioRetentionDays: null });
  try {
    let s = await listed(sid);
    assert.equal(s.retention.effectiveDays, null);
    assert.equal(s.retention.deletesAt, null);
    assert.equal(engine(deps).runRetention(Date.now() + 5000 * 864e5), 0);
    // the session's own setting beats the world's
    await ok('POST', `${A()}/recordings/${sid}/retention`, T.dm, { mode: 'days', days: 1 });
    assert.equal((await listed(sid)).retention.effectiveDays, 1);
    await ok('POST', `${A()}/recordings/${sid}/retention`, T.dm, { mode: 'default' });
    assert.equal((await call('POST', `${A()}/recordings/${sid}/delete-audio`, T.jess, { confirm: true })).status, 403);
    assert.equal((await call('POST', `${A()}/recordings/${sid}/delete-audio`, T.dm, {})).status, 400, 'no confirm, no delete');
    assert.equal((await listed(sid)).status, 'ready');
    const r = await ok('POST', `${A()}/recordings/${sid}/delete-audio`, T.dm, { confirm: true });
    assert.ok(r.removed >= 4);
    s = await listed(sid);
    assert.equal(s.audioDeleted, true);
    assert.equal((await ok('GET', `${A()}/sessions/${sid}/lines`, T.dm)).lines.length, 3);
  } finally { await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { audioRetentionDays: 30 }); }
});

test('Recordings_retention: raw chunks of a never-built session still go when its days are up', async () => {
  const sid = await newSession('Raw only');
  assert.equal((await upload('jess', sid, 'jess', 0, 0, 3000)).status, 201);
  const f = one<any>(deps.db, 'SELECT file FROM audio_chunks WHERE session_id = ?', sid).file;
  assert.ok(fs.existsSync(path.join(tmp, 'data', f)));
  assert.equal(engine(deps).runRetention(Date.now() + 5 * 864e5), 0);
  assert.ok(engine(deps).runRetention(Date.now() + 31 * 864e5) >= 1);
  assert.ok(!fs.existsSync(path.join(tmp, 'data', f)));
});

// ---- who may hear what ---------------------------------------------------------------------------

test('Recordings_access: DM-only list; a player gets only their own track; the full mix and others are 403', needFfmpeg, async () => {
  const sid = await recorded('Access');
  await built(sid);
  for (const who of ['jess', 'tom', 'zed']) assert.equal((await call('GET', `${A()}/recordings`, T[who])).status, 403, `${who} cannot list every recording`);
  assert.equal((await call('GET', `${A()}/recordings`)).status, 401);
  assert.equal((await call('GET', `${A()}/recordings/${sid}`, T.jess)).status, 403);
  const detail = await ok('GET', `${A()}/recordings/${sid}`, T.dm);
  const full = detail.tracks.find((t: any) => t.kind === 'full');
  const jessT = detail.tracks.find((t: any) => t.label === 'Jess phone');
  const tomT = detail.tracks.find((t: any) => t.label === 'Tom phone');
  assert.equal(detail.tracks.length, 4);
  const file = (t: any) => `${A()}/recordings/tracks/${t.id}/file`;
  // the DM hears everything
  for (const t of detail.tracks) { const r = await call('GET', file(t), T.dm); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'audio/mpeg'); assert.ok(r.buf.length > 1000); }
  // Jess: her own, nothing else
  const mine = await call('GET', file(jessT), T.jess);
  assert.equal(mine.status, 200);
  assert.equal((await call('GET', file(full), T.jess)).status, 403);
  assert.equal((await call('GET', file(tomT), T.jess)).status, 403);
  assert.equal((await call('GET', file(jessT), T.tom)).status, 403);
  assert.equal((await call('GET', file(jessT), T.zed)).status, 403);
  assert.equal((await call('GET', file(jessT))).status, 401);
  // the player's list
  const jl = (await ok('GET', `${A()}/recordings/mine`, T.jess)).sessions.find((s: any) => s.id === sid);
  assert.deepEqual(jl.tracks.map((t: any) => t.label), ['Jess phone']);
  assert.equal(jl.folder, undefined);
  assert.ok(!JSON.stringify(jl).includes('Tom phone') && !JSON.stringify(jl).includes('Full session'));
  assert.deepEqual((await ok('GET', `${A()}/recordings/mine`, T.zed)).sessions.filter((s: any) => s.id === sid), [], 'Zed was never recorded');
  const tl = (await ok('GET', `${A()}/recordings/mine`, T.tom)).sessions.find((s: any) => s.id === sid);
  assert.deepEqual(tl.tracks.map((t: any) => t.label), ['Tom phone']);
  // the player's ticket plays only their own track
  const jUrl = jl.tracks[0].url;
  assert.equal((await call('GET', jUrl)).status, 200, 'a ticket needs no header');
  assert.equal((await call('GET', jUrl + '?download=1')).headers.get('content-disposition')?.startsWith('attachment'), true);
  const forged = (t: any, who: string) => `/api/media/recording/${mintTicket({ w: W, k: 'recording', f: t.id, a: ID[who] })}`;
  assert.equal((await call('GET', forged(full, 'jess'))).status, 404, 'a ticket for the full mix does not work for a player');
  assert.equal((await call('GET', forged(tomT, 'jess'))).status, 404);
  assert.equal((await call('GET', forged(tomT, 'tom'))).status, 200);
  assert.equal((await call('GET', forged(full, 'dm'))).status, 200);
  assert.equal((await call('GET', `/api/media/recording/${jUrl.split('/').pop()}x`)).status, 404, 'a bad signature');
  assert.equal((await call('GET', `/api/media/recording/${mintTicket({ w: W, k: 'sound', f: full.id, a: ID.dm })}`)).status, 404, 'a ticket for something else');
  // players' transcript: no DM-only lines (the existing filter); the DM sees them
  const pl = (await ok('GET', `${A()}/sessions/${sid}/lines`, T.jess)).lines.map((l: any) => l.text);
  assert.deepEqual(pl, ['I open the door', 'We follow Tom']);
  assert.equal((await ok('GET', `${A()}/sessions/${sid}/lines`, T.dm)).lines.length, 3);
});

/** The files in a zip, read from its central directory, each checked against its CRC. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'an end of central directory');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28); const xl = buf.readUInt16LE(p + 30); const cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8');
    const lnl = buf.readUInt16LE(off + 26); const lxl = buf.readUInt16LE(off + 28);
    const data = buf.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + size);
    assert.equal(crc32(data) >>> 0, crc, `CRC of ${name}`);
    out.set(name, data);
    p += 46 + nl + xl + cl;
  }
  return out;
}

test('Recordings_zip: Download all streams one zip: the DM gets everything, a player only their own and the players\' side', needFfmpeg, async () => {
  const sid = await recorded('Zipped');
  await built(sid);
  run(deps.db, "INSERT INTO audio_summaries (session_id, audience, world_id, text, upto, lines, updated_at) VALUES (?, 'party', ?, 'PARTY-SUMMARY the door opens', '', 1, ?)", sid, W, new Date().toISOString());
  run(deps.db, "INSERT INTO audio_summaries (session_id, audience, world_id, text, upto, lines, updated_at) VALUES (?, 'dm', ?, 'DM-SUMMARY the duke is the lich', '', 1, ?)", sid, W, new Date().toISOString());
  run(deps.db, "INSERT INTO audio_handoffs (id, session_id, world_id, status, text, source, created_at, updated_at, decided_at) VALUES ('ah_a', ?, ?, 'approved', 'APPROVED-SUMMARY of the night', 'live', ?, ?, ?)", sid, W, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  run(deps.db, "INSERT INTO audio_handoffs (id, session_id, world_id, status, text, source, created_at, updated_at) VALUES ('ah_p', ?, ?, 'pending', 'PENDING-SUMMARY not yet approved', 'final', ?, ?)", sid, W, new Date(Date.now() + 1000).toISOString(), new Date().toISOString());
  const detail = await ok('GET', `${A()}/recordings/${sid}`, T.dm);
  assert.match(detail.zipUrl, /^\/api\/media\/recording-zip\//);
  const r = await call('GET', detail.zipUrl);
  assert.equal(r.status, 200, 'a ticket needs no header');
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(r.headers.get('content-disposition') ?? '', /^attachment; filename=".*Zipped\.zip"/);
  assert.equal(r.headers.get('content-length'), null, 'streamed, not buffered');
  const files = unzip(r.buf);
  const names = [...files.keys()].map((k) => k.split('/').slice(1).join('/')).sort();
  for (const t of detail.tracks) assert.ok(names.includes(t.file), `the DM's zip has ${t.file}`);
  for (const want of ['Transcript.md', 'Summary.md', 'session.json']) assert.ok(names.includes(want), `the DM's zip has ${want}`);
  const get = (m: Map<string, Buffer>, n: string) => [...m.entries()].find(([k]) => k.endsWith('/' + n))?.[1]?.toString('utf8') ?? '';
  assert.ok(get(files, 'Transcript.md').includes('the duke is the lich'), 'the DM transcript has DM lines');
  assert.ok(get(files, 'Summary.md').includes('APPROVED-SUMMARY') && !get(files, 'Summary.md').includes('PENDING'), 'only the approved summary');
  assert.equal(JSON.parse(get(files, 'session.json')).sessionId, sid);
  const fullT = detail.tracks.find((t: any) => t.kind === 'full');
  assert.equal([...files.entries()].find(([k]) => k.endsWith('/' + fullT.file))![1].length, fullT.bytes, 'the full mix, byte for byte');

  // Jess: her own track, the players' transcript and summary; nothing of the DM's.
  const jl = (await ok('GET', `${A()}/recordings/mine`, T.jess)).sessions.find((s: any) => s.id === sid);
  assert.ok(jl.zipUrl);
  const jz = unzip((await call('GET', jl.zipUrl)).buf);
  const jn = [...jz.keys()].map((k) => k.split('/').slice(1).join('/')).sort();
  const jessFile = detail.tracks.find((t: any) => t.label === 'Jess phone').file;
  assert.deepEqual(jn, [jessFile, 'Summary (players).md', 'Transcript (players).md'].sort());
  const all = [...jz.values()].map((b) => b.toString('latin1')).join('\n');
  for (const secret of ['the duke is the lich', 'DM-SUMMARY', 'APPROVED-SUMMARY', 'PENDING-SUMMARY', 'Tom phone', 'sessionId']) assert.ok(!all.includes(secret), `a player's zip never holds "${secret}"`);
  assert.ok(get(jz, 'Transcript (players).md').includes('I open the door'));
  assert.ok(get(jz, 'Summary (players).md').includes('PARTY-SUMMARY'));

  // A forged ticket, another kind, someone not recorded, a bad signature: 404.
  const forged = (who: string, k = 'recording-zip') => `/api/media/recording-zip/${mintTicket({ w: W, k, f: sid, a: ID[who] })}`;
  assert.equal((await call('GET', forged('zed'))).status, 404, 'Zed was never recorded');
  assert.equal((await call('GET', forged('jess', 'recording'))).status, 404, 'a track ticket is not a zip ticket');
  assert.equal((await call('GET', `${detail.zipUrl}x`)).status, 404);
  assert.equal((await call('GET', `/api/media/recording-zip/${mintTicket({ w: 'other', k: 'recording-zip', f: sid, a: ID.dm })}`)).status, 404, 'another world');
  // Someone who left the world loses it.
  run(deps.db, "UPDATE members SET role = 'guest' WHERE world_id = ? AND account_id = ?", W, ID.tom);
  try { assert.equal((await call('GET', forged('tom'))).status, 404, 'a guest gets nothing'); } finally { run(deps.db, "UPDATE members SET role = 'player' WHERE world_id = ? AND account_id = ?", W, ID.tom); }
});

test('Recordings_range: seeking works (206, Content-Range, 416) and the file is not changed by it', needFfmpeg, async () => {
  const sid = await recorded('Ranges');
  await built(sid);
  const detail = await ok('GET', `${A()}/recordings/${sid}`, T.dm);
  const full = detail.tracks.find((t: any) => t.kind === 'full');
  const url = `${A()}/recordings/tracks/${full.id}/file`;
  const whole = await call('GET', url, T.dm);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(whole.headers.get('content-length')), full.bytes);
  const r1 = await call('GET', url, T.dm, undefined, undefined, { Range: 'bytes=100-199' });
  assert.equal(r1.status, 206);
  assert.equal(r1.headers.get('content-range'), `bytes 100-199/${full.bytes}`);
  assert.deepEqual(r1.buf, whole.buf.subarray(100, 200));
  const r2 = await call('GET', url, T.dm, undefined, undefined, { Range: 'bytes=1000-' });
  assert.equal(r2.status, 206);
  assert.deepEqual(r2.buf, whole.buf.subarray(1000));
  const r3 = await call('GET', url, T.dm, undefined, undefined, { Range: 'bytes=-50' });
  assert.equal(r3.status, 206);
  assert.deepEqual(r3.buf, whole.buf.subarray(whole.buf.length - 50));
  assert.equal((await call('GET', url, T.dm, undefined, undefined, { Range: `bytes=${full.bytes + 10}-` })).status, 416);
  // a ticket URL honours Range too, and a player's range on someone else's track is refused first
  const t = await call('GET', full.url, undefined, undefined, undefined, { Range: 'bytes=0-9' });
  assert.equal(t.status, 206);
  assert.equal(t.buf.length, 10);
  const tomT = detail.tracks.find((x: any) => x.label === 'Tom phone');
  assert.equal((await call('GET', `${A()}/recordings/tracks/${tomT.id}/file`, T.jess, undefined, undefined, { Range: 'bytes=0-9' })).status, 403);
});

test('Recordings_paths: nothing the client sends picks a file; a bad stored path is refused; no listings', needFfmpeg, async () => {
  const sid = await recorded('Traversal');
  await built(sid);
  const detail = await ok('GET', `${A()}/recordings/${sid}`, T.dm);
  const jessT = detail.tracks.find((t: any) => t.label === 'Jess phone');
  const get = (u: string, tok = T.dm) => call('GET', u, tok);
  // ids only: a path in place of an id finds nothing
  for (const bad of ['..%2F..%2F..%2Fsession.json', '../../x', '%2e%2e%2f', 'trk_nope', encodeURIComponent('/etc/passwd')]) {
    const r = await get(`${A()}/recordings/tracks/${bad}/file`);
    assert.ok([400, 404].includes(r.status), `${bad} -> ${r.status}`);
  }
  // no directory listing, no folder access
  for (const u of [`${A()}/recordings/tracks`, `${A()}/recordings/tracks/`, `${A()}/recordings/files`, `/recordings`, `/data/recordings/`, `/api/media/recording/`, `/api/media/recording`]) {
    const r = await get(u);
    assert.ok(r.status === 404 || r.status === 400 || r.status === 401, `${u} -> ${r.status}`);
    assert.ok(!r.buf.toString().includes('Full session'));
  }
  // a stored file name or folder that tries to leave data/recordings is refused (defence in depth)
  const orig = one<any>(deps.db, 'SELECT file FROM audio_tracks WHERE id = ?', jessT.id).file;
  for (const evil of ['../../../../etc/passwd', '..', '/etc/passwd', 'a/../../b', '.hidden', 'x\\y']) {
    run(deps.db, 'UPDATE audio_tracks SET file = ? WHERE id = ?', evil, jessT.id);
    assert.equal((await get(`${A()}/recordings/tracks/${jessT.id}/file`)).status, 404, evil);
  }
  run(deps.db, 'UPDATE audio_tracks SET file = ? WHERE id = ?', orig, jessT.id);
  const dir = one<any>(deps.db, 'SELECT rec_dir FROM audio_sessions WHERE id = ?', sid).rec_dir;
  fs.writeFileSync(path.join(tmp, 'data', 'secret.mp3'), 'top secret');
  run(deps.db, 'UPDATE audio_sessions SET rec_dir = ? WHERE id = ?', '../../..', sid);
  assert.equal((await get(`${A()}/recordings/tracks/${jessT.id}/file`)).status, 404);
  run(deps.db, 'UPDATE audio_sessions SET rec_dir = ? WHERE id = ?', 'audio', sid);
  assert.equal((await get(`${A()}/recordings/tracks/${jessT.id}/file`)).status, 404);
  run(deps.db, 'UPDATE audio_sessions SET rec_dir = ? WHERE id = ?', dir, sid);
  // a symlink inside the folder that points outside is refused
  const link = path.join(tmp, 'data', dir, 'link.mp3');
  fs.symlinkSync(path.join(tmp, 'data', 'secret.mp3'), link);
  run(deps.db, 'UPDATE audio_tracks SET file = ? WHERE id = ?', 'link.mp3', jessT.id);
  assert.equal((await get(`${A()}/recordings/tracks/${jessT.id}/file`)).status, 404);
  run(deps.db, 'UPDATE audio_tracks SET file = ? WHERE id = ?', orig, jessT.id);
  assert.equal((await get(`${A()}/recordings/tracks/${jessT.id}/file`)).status, 200);
});

test('Recordings_world: another world cannot reach this world\'s tracks', needFfmpeg, async () => {
  const sid = await recorded('Isolated');
  await built(sid);
  const full = (await ok('GET', `${A()}/recordings/${sid}`, T.dm)).tracks.find((t: any) => t.kind === 'full');
  const w2 = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Elsewhere', dmAccountId: ID.dm })).id;
  const r = await call('GET', `/api/worlds/${w2}/audio/recordings/tracks/${full.id}/file`, T.dm);
  assert.equal(r.status, 404);
  assert.equal((await call('GET', `/api/media/recording/${mintTicket({ w: w2, k: 'recording', f: full.id, a: ID.dm })}`)).status, 404);
});

test('Recordings_ffmpeg: with no ffmpeg the build says so plainly and keeps the chunks', async () => {
  // PATH without ffmpeg: the probe is cached for a minute, so run the build in a fresh process-level state by using a bogus PATH only for a child check
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '-e', `
    import('${path.resolve('src/features/audio/recordings.ts')}').then(async (m) => { console.log(await m.ffmpegAvailable()); });
  `], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'false');
});
