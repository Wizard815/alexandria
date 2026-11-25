// Recordings: after a session stops, the raw 5-second chunks are joined with
// ffmpeg into plain files on the server (data/recordings/<World>/<date> <Session>/):
// one file for the whole table and one per microphone, each starting at the
// session's time zero (silence where a mic had nothing), next to a readable
// transcript and a session.json. The files are the source of truth for audio:
// once they are verified the raw chunks go. Retention is per session.
//
// Format: MP3 (mono, 24 kHz, constant bit rate). Every browser plays it,
// including iOS Safari and Chromium builds without proprietary codecs, and a
// constant bit rate seeks accurately. If this ffmpeg has no MP3 encoder the
// build falls back to AAC in .m4a (Safari plays that too).
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Deps } from '../../app.ts';
import type { DB } from '../../core/db.ts';
import type { JobCtx } from '../../core/jobs.ts';
import { all, one, run } from '../../core/db.ts';
import { DEFAULT_SETTINGS, featureSetting } from '../../core/policy.ts';
import { id as newId, now, parseJson } from '../../core/util.ts';

export const REC_SCHEMA = `
CREATE TABLE IF NOT EXISTS audio_tracks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES audio_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  mic_id TEXT,
  account_id TEXT,
  label TEXT NOT NULL,
  person TEXT NOT NULL DEFAULT '',
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audio_tracks_session ON audio_tracks (session_id);
`;

/** Columns audio_sessions gains (additive). */
export function migrateRecordings(db: DB) {
  const cols = (db.prepare('PRAGMA table_info(audio_sessions)').all() as any[]).map((c) => c.name);
  const add = (name: string, def: string) => { if (!cols.includes(name)) db.exec(`ALTER TABLE audio_sessions ADD COLUMN ${name} ${def}`); };
  add('rec_status', 'TEXT');
  add('rec_dir', 'TEXT');
  add('rec_error', 'TEXT');
  add('rec_built_at', 'TEXT');
  add('rec_duration_ms', 'INTEGER');
  add('rec_warnings', "TEXT NOT NULL DEFAULT '[]'");
  add('retention_mode', "TEXT NOT NULL DEFAULT 'default'");
  add('retention_days', 'INTEGER');
  add('audio_deleted_at', 'TEXT');
}

export interface SessionRow {
  id: string; world_id: string; name: string; started_at: string; stopped_at: string | null;
  rec_status: 'queued' | 'building' | 'ready' | 'failed' | 'deleted' | null; rec_dir: string | null; rec_error: string | null; rec_built_at: string | null;
  rec_duration_ms: number | null; rec_warnings: string; retention_mode: 'default' | 'forever' | 'days'; retention_days: number | null; audio_deleted_at: string | null;
}
export interface TrackRow { id: string; session_id: string; kind: 'full' | 'mic'; mic_id: string | null; account_id: string | null; label: string; person: string; file: string; mime: string; duration_ms: number; bytes: number; created_at: string }

export class BuildError extends Error {}

// ---- names on disk ---------------------------------------------------------

/** A name safe as one file or folder name anywhere: no separators, control characters or reserved punctuation; capped. */
export function cleanFileName(raw: unknown, fallback = 'Untitled', max = 80): string {
  let s = String(raw ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  s = [...s].slice(0, max).join('').trim();
  s = s.replace(/^[.\s-]+/, '').replace(/[.\s]+$/, '');
  if (!s || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) return fallback;
  return s;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const localDate = (iso: string) => { const t = new Date(iso); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };

/** The folder (relative to the data dir) a session's files live in; keeps the one it already has, else a new name that no other session uses. */
export function pickDir(d: Deps, s: SessionRow, worldName: string): string {
  if (s.rec_dir) return s.rec_dir;
  const base = path.join('recordings', cleanFileName(worldName, 'World'), `${localDate(s.started_at)} ${cleanFileName(s.name, 'Session')}`);
  for (let n = 1; n < 1000; n++) {
    const cand = n === 1 ? base : `${base} (${n})`;
    if (!one(d.db, 'SELECT 1 FROM audio_sessions WHERE rec_dir = ? AND id != ?', cand, s.id) && !fs.existsSync(path.join(d.dataDir!, cand))) return cand;
  }
  return `${base} (${s.id})`;
}

// ---- ffmpeg ------------------------------------------------------------------------

const probeCache: { ok?: boolean; at: number; mp3?: boolean } = { at: 0 };
function ffmpegInfo(): Promise<{ ok: boolean; mp3: boolean }> {
  if (probeCache.ok !== undefined && Date.now() - probeCache.at < 60_000) return Promise.resolve({ ok: probeCache.ok, mp3: !!probeCache.mp3 });
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      probeCache.ok = !err;
      probeCache.mp3 = !err && /libmp3lame/.test(String(out));
      probeCache.at = Date.now();
      resolve({ ok: !err, mp3: !!probeCache.mp3 });
    });
  });
}
export const ffmpegAvailable = async () => (await ffmpegInfo()).ok;

const RATE = 24_000;

/** One chunk as raw 16-bit mono PCM, from `trimMs` into it for `durMs`. Null when ffmpeg cannot read it. */
function decodeChunk(file: string, trimMs: number, durMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-hide_banner', '-v', 'error', '-ss', (trimMs / 1000).toFixed(3), '-t', (durMs / 1000 + 0.05).toFixed(3), '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (err, out) => resolve(err ? null : (out as Buffer)));
  });
}

interface Encoder { write(b: Buffer): Promise<void>; end(): Promise<void> }
/** An ffmpeg process that encodes PCM fed to it into `out` (written as it goes, never held in memory). */
function startEncoder(out: string, mp3: boolean, bitrate: string): Encoder {
  const codec = mp3 ? ['-c:a', 'libmp3lame', '-b:a', bitrate, '-f', 'mp3'] : ['-c:a', 'aac', '-b:a', bitrate, '-movflags', '+faststart', '-f', 'mp4'];
  const p = spawn('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0', ...codec, out], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (c) => { err += c; });
  p.stdin.on('error', () => { /* reported by the exit code */ });
  const done = new Promise<void>((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new BuildError(`ffmpeg could not encode the audio (${err.trim().slice(-200) || 'exit ' + code})`))));
  });
  done.catch(() => {});
  return {
    write: (b) => new Promise((resolve, reject) => {
      if (p.exitCode !== null) return reject(new BuildError('ffmpeg stopped early'));
      if (p.stdin.write(b)) return resolve();
      const stop = () => reject(new BuildError('ffmpeg stopped early'));
      p.once('close', stop);
      p.stdin.once('drain', () => { p.off('close', stop); resolve(); });
    }),
    end: () => { p.stdin.end(); return done; },
  };
}

function ffprobeDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30_000 }, (err, out) => {
      const n = err ? NaN : parseFloat(String(out).trim());
      resolve(Number.isFinite(n) ? Math.round(n * 1000) : 0);
    });
  });
}

function mixTracks(files: string[], out: string, mp3: boolean) {
  return new Promise<void>((resolve, reject) => {
    const n = files.length;
    const graph = `${n === 1 ? '[0:a]anull[m]' : `${files.map((_, i) => `[${i}:a]`).join('')}amix=inputs=${n}:duration=longest:normalize=0[m]`};[m]alimiter=limit=0.97[out]`;
    const codec = mp3 ? ['-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3'] : ['-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-f', 'mp4'];
    execFile('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...files.flatMap((f) => ['-i', f]), '-filter_complex', graph, '-map', '[out]', '-ar', String(RATE), '-ac', '1', ...codec, out],
      { timeout: 6 * 3600_000, maxBuffer: 1024 * 1024 }, (err, _o, se) => (err ? reject(new BuildError(`ffmpeg could not mix the tracks (${String(se).trim().slice(-200)})`)) : resolve()));
  });
}

// ---- the build queue ---------------------------------------------------------------------

interface Q { chain: Promise<void>; waiting: Set<string>; progress: Map<string, { pct: number; step: string }>; jobCtx: Map<string, JobCtx> }
const queues = new WeakMap<DB, Q>();
const queueOf = (d: Deps): Q => { let q = queues.get(d.db); if (!q) { q = { chain: Promise.resolve(), waiting: new Set(), progress: new Map(), jobCtx: new Map() }; queues.set(d.db, q); } return q; };

export const buildProgress = (d: Deps, sessionId: string) => queueOf(d).progress.get(sessionId) ?? null;
/** Resolves when every queued build has finished (tests). */
export const buildsIdle = (d: Deps) => queueOf(d).chain;

const sessionRow = (db: DB, sid: string) => one<SessionRow>(db, 'SELECT * FROM audio_sessions WHERE id = ?', sid);
export const chunkFiles = (d: Deps, sid: string) => all<any>(d.db, 'SELECT * FROM audio_chunks WHERE session_id = ? AND file IS NOT NULL ORDER BY mic_id, start_ms, seq', sid)
  .filter((c) => d.dataDir && fs.existsSync(path.join(d.dataDir, c.file)));

/** Queue a build (one runs at a time, so a long session never competes with another for the disk and CPU). */
export function enqueueBuild(d: Deps, sessionId: string): boolean {
  const q = queueOf(d);
  if (q.waiting.has(sessionId)) return false;
  q.waiting.add(sessionId);
  run(d.db, "UPDATE audio_sessions SET rec_status = 'queued', rec_error = NULL WHERE id = ?", sessionId);
  q.chain = q.chain.then(async () => {
    // Shown in the admin's jobs bar; not stoppable (ffmpeg is half way through files) and not resumed by the job runner (the sweep queues it again).
    const work = async () => { try { await buildRecording(d, sessionId); } catch (e) { console.error('audio: recording build crashed', e); } };
    try {
      if (d.jobs) await d.jobs.track({ kind: 'recording', title: `Building a session recording`, worldId: sessionRow(d.db, sessionId)?.world_id ?? null, cancellable: false }, (ctx) => { q.jobCtx.set(sessionId, ctx); return work(); });
      else await work();
    } finally { q.waiting.delete(sessionId); q.progress.delete(sessionId); q.jobCtx.delete(sessionId); }
  });
  return true;
}

export const isBuilding = (d: Deps, sid: string) => queueOf(d).waiting.has(sid);

/** Builds that were running when the server stopped did not finish; forget them (they are queued again by the sweep). */
export function resetStuckBuilds(db: DB) {
  run(db, "UPDATE audio_sessions SET rec_status = NULL WHERE rec_status IN ('queued', 'building')");
}

/** Stopped sessions that still have raw chunks and no recording: build them, oldest first. Also clears chunks of built sessions. */
export function sweepRecordings(d: Deps, nowMs = Date.now()) {
  if (!d.dataDir) return;
  const cutoff = new Date(nowMs - 5 * 60_000).toISOString();
  for (const s of all<SessionRow>(d.db, "SELECT * FROM audio_sessions WHERE stopped_at IS NOT NULL AND stopped_at < ? AND audio_deleted_at IS NULL AND (rec_status IS NULL OR rec_status = 'ready') ORDER BY started_at", cutoff)) {
    if (s.rec_status === 'ready') { cleanChunks(d, s.id); continue; }
    if (chunkFiles(d, s.id).length) enqueueBuild(d, s.id);
  }
}

/** Delete a built session's raw chunks (kept: any still waiting for the speech model). */
export function cleanChunks(d: Deps, sessionId: string): number {
  let n = 0;
  for (const c of all<any>(d.db, "SELECT id, file FROM audio_chunks WHERE session_id = ? AND file IS NOT NULL AND status NOT IN ('pending', 'queued', 'awaiting')", sessionId)) {
    try { fs.rmSync(path.join(d.dataDir!, c.file), { force: true }); } catch { /* already gone */ }
    run(d.db, 'UPDATE audio_chunks SET file = NULL WHERE id = ?', c.id);
    n++;
  }
  if (n) prune(path.join(d.dataDir!, 'audio', one<{ w: string }>(d.db, 'SELECT world_id AS w FROM audio_sessions WHERE id = ?', sessionId)?.w ?? '-'));
  return n;
}

function setProgress(d: Deps, sid: string, pct: number, step: string) {
  const q = queueOf(d);
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  q.progress.set(sid, { pct: p, step });
  q.jobCtx.get(sid)?.progress(p, 100, step);
}

export const fmtTime = (ms: number) => { const s = Math.floor(ms / 1000); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`; };

interface Plan { file: string; from: number; trim: number; dur: number }
/** The stretch of each chunk to use: a chunk repeats the end of the one before it, so it is trimmed to start where the audio so far stops. */
export function planMic(chunks: { file: string; start_ms: number; end_ms: number }[]): Plan[] {
  const plan: Plan[] = [];
  let covered = 0;
  for (const c of chunks) {
    if (c.end_ms <= covered) continue;
    const from = Math.max(c.start_ms, covered);
    plan.push({ file: c.file, from, trim: from - c.start_ms, dur: c.end_ms - from });
    covered = c.end_ms;
  }
  return plan;
}

async function buildRecording(d: Deps, sessionId: string): Promise<void> {
  const db = d.db;
  const s = sessionRow(db, sessionId);
  if (!s || !s.stopped_at || s.audio_deleted_at) return;
  const fail = (msg: string) => run(db, "UPDATE audio_sessions SET rec_status = 'failed', rec_error = ? WHERE id = ?", msg.slice(0, 500), sessionId);
  if (!d.dataDir) return void fail('The librarian has no data folder to keep recordings in.');
  run(db, "UPDATE audio_sessions SET rec_status = 'building', rec_error = NULL WHERE id = ?", sessionId);
  const made: string[] = [];
  try {
    const info = await ffmpegInfo();
    if (!info.ok) throw new BuildError('ffmpeg is not installed on this server, so the recording could not be built. The raw chunks are kept: install ffmpeg (the Docker image has it) and press Rebuild.');
    const ext = info.mp3 ? 'mp3' : 'm4a';
    const mime = info.mp3 ? 'audio/mpeg' : 'audio/mp4';
    const chunks = chunkFiles(d, sessionId);
    if (!chunks.length) throw new BuildError('No raw audio is left for this session, so there is nothing to build from.');
    const world = one<{ name: string }>(db, 'SELECT name FROM worlds WHERE id = ?', s.world_id);
    const rel = pickDir(d, s, world?.name ?? 'World');
    const dir = path.join(d.dataDir, rel);
    fs.mkdirSync(dir, { recursive: true });

    const byMic = new Map<string, any[]>();
    for (const c of chunks) { const l = byMic.get(c.mic_id) ?? []; l.push(c); byMic.set(c.mic_id, l); }
    const people = new Map(all<any>(db, 'SELECT a.id, a.display_name, m.character_name, m.role FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ?', s.world_id).map((r) => [r.id, r]));
    const mics = all<any>(db, `SELECT * FROM audio_mics WHERE id IN (${[...byMic.keys()].map(() => '?').join(',')}) ORDER BY created_at`, ...byMic.keys());

    const used = new Set(['full session', 'transcript', 'session']);
    const uniqueName = (base: string) => {
      let n = 1, name = base;
      while (used.has(name.toLowerCase())) name = `${base} (${++n})`;
      used.add(name.toLowerCase());
      return name;
    };

    const totalChunks = chunks.length;
    let done = 0;
    let skipped = 0;
    const micOut: { mic: any; person: any; file: string; tmp: string; expectMs: number }[] = [];
    for (const mic of mics) {
      const person = people.get(mic.account_id);
      const who = person?.display_name ?? 'Unknown';
      const file = `${uniqueName(`${cleanFileName(mic.label, 'Mic', 60)} - ${cleanFileName(who, 'Unknown', 40)}`)}.${ext}`;
      const tmp = path.join(dir, `${file}.part`);
      made.push(tmp);
      const plan = planMic(byMic.get(mic.id)!.map((c) => ({ ...c, file: path.join(d.dataDir!, c.file) })));
      const enc = startEncoder(tmp, info.mp3, '48k');
      let written = 0;
      let usable = 0;
      const zeros = Buffer.alloc(RATE * 2 * 10);
      const LOOK = 4;
      const jobs = new Map<number, Promise<Buffer | null>>();
      const launch = (i: number) => { if (i < plan.length && !jobs.has(i)) jobs.set(i, decodeChunk(plan[i].file, plan[i].trim, plan[i].dur)); };
      for (let i = 0; i < LOOK; i++) launch(i);
      try {
        for (let i = 0; i < plan.length; i++) {
          const pcm = await jobs.get(i)!;
          jobs.delete(i);
          launch(i + LOOK);
          done++;
          setProgress(d, sessionId, (done / totalChunks) * 85, `Joining ${mic.label}`);
          if (!pcm || pcm.length < 2) { skipped++; continue; }
          const target = Math.round((plan[i].from * RATE) / 1000);
          let buf = pcm.subarray(0, pcm.length - (pcm.length % 2));
          if (written > target) buf = buf.subarray(Math.min(buf.length, (written - target) * 2));
          let gap = target - written;
          while (gap > 0) { const k = Math.min(gap, zeros.length / 2); await enc.write(zeros.subarray(0, k * 2)); gap -= k; written += k; }
          await enc.write(buf);
          written += buf.length / 2;
          usable++;
        }
      } finally {
        await enc.end().catch((e) => { if (usable) throw e; });
      }
      if (!usable) throw new BuildError(`The audio of "${mic.label}" could not be read (none of its chunks could be decoded).`);
      micOut.push({ mic, person: { ...(person ?? {}), who }, file, tmp, expectMs: plan.length ? plan[plan.length - 1].from + plan[plan.length - 1].dur : 0 });
    }

    setProgress(d, sessionId, 88, 'Mixing the whole table');
    const fullFile = `Full session.${ext}`;
    const fullTmp = path.join(dir, `${fullFile}.part`);
    made.push(fullTmp);
    await mixTracks(micOut.map((m) => m.tmp), fullTmp, info.mp3);

    setProgress(d, sessionId, 95, 'Checking the files');
    const expectedAll = Math.max(...micOut.map((m) => m.expectMs));
    const checked: { name: string; tmp: string; durationMs: number; bytes: number }[] = [];
    for (const f of [{ name: fullFile, tmp: fullTmp, expect: expectedAll }, ...micOut.map((m) => ({ name: m.file, tmp: m.tmp, expect: m.expectMs }))]) {
      const durationMs = await ffprobeDuration(f.tmp);
      const bytes = fs.statSync(f.tmp).size;
      if (durationMs <= 0 || bytes < 500 || bytes < durationMs / 1000 * 500) throw new BuildError(`The joined file "${f.name}" did not check out (length ${durationMs} ms, ${bytes} bytes).`);
      if (durationMs < f.expect * 0.95 - 1500) throw new BuildError(`The joined file "${f.name}" is shorter than the recording (${Math.round(durationMs / 1000)} s of ${Math.round(f.expect / 1000)} s).`);
      checked.push({ name: f.name, tmp: f.tmp, durationMs, bytes });
    }

    // Verified: put the files in place, replacing an earlier build's.
    const before = all<TrackRow>(db, 'SELECT * FROM audio_tracks WHERE session_id = ?', sessionId);
    for (const c of checked) fs.renameSync(c.tmp, path.join(dir, c.name));
    const names = new Set(checked.map((c) => c.name));
    for (const old of before) if (!names.has(old.file)) { try { fs.rmSync(path.join(dir, old.file), { force: true }); } catch { /* gone */ } }
    const stamp = now();
    const dm = new Map(all<any>(db, 'SELECT a.id, m.role FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ?', s.world_id).map((r) => [r.id, r.role]));
    db.exec('BEGIN');
    try {
      run(db, 'DELETE FROM audio_tracks WHERE session_id = ?', sessionId);
      const fullC = checked[0];
      run(db, "INSERT INTO audio_tracks (id, session_id, kind, mic_id, account_id, label, person, file, mime, duration_ms, bytes, created_at) VALUES (?, ?, 'full', NULL, NULL, 'Full session', 'Everyone', ?, ?, ?, ?, ?)", newId('trk_'), sessionId, fullC.name, mime, fullC.durationMs, fullC.bytes, stamp);
      micOut.forEach((m, i) => {
        const c = checked[i + 1];
        run(db, "INSERT INTO audio_tracks (id, session_id, kind, mic_id, account_id, label, person, file, mime, duration_ms, bytes, created_at) VALUES (?, ?, 'mic', ?, ?, ?, ?, ?, ?, ?, ?, ?)", newId('trk_'), sessionId, m.mic.id, m.mic.account_id, m.mic.label, m.person.who, c.name, mime, c.durationMs, c.bytes, stamp);
      });
      const warnings = skipped ? [`${skipped} audio chunk${skipped === 1 ? '' : 's'} could not be read and ${skipped === 1 ? 'is' : 'are'} silence in the files.`] : [];
      run(db, "UPDATE audio_sessions SET rec_status = 'ready', rec_dir = ?, rec_error = NULL, rec_built_at = ?, rec_duration_ms = ?, rec_warnings = ? WHERE id = ?", rel, stamp, checked[0].durationMs, JSON.stringify(warnings), sessionId);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    writeTranscript(d, sessionRow(db, sessionId)!, dir);
    writeSessionJson(d, sessionRow(db, sessionId)!, world?.name ?? '', dir, dm);
    cleanChunks(d, sessionId);
    setProgress(d, sessionId, 100, 'Done');
  } catch (e) {
    for (const f of made) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
    const msg = e instanceof BuildError ? e.message : `The build failed: ${(e as Error).message}`;
    if (!(e instanceof BuildError)) console.error('audio: recording build failed', e);
    // A build that fails after an earlier good one leaves those files alone.
    fail(msg);
  }
}

// ---- the readable files beside the audio --------------------------------------------------------

/** The DM's transcript as Markdown: players' lines and the DM-only ones, marked. */
export function transcriptMarkdown(d: Deps, s: SessionRow, worldName: string): string {
  const people = new Map(all<any>(d.db, 'SELECT a.id, a.display_name, m.character_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ?', s.world_id).map((r) => [r.id, r.character_name || r.display_name]));
  const lines = all<any>(d.db, 'SELECT * FROM audio_lines WHERE session_id = ? ORDER BY start_ms, id', s.id);
  const fin = one<{ status: string; finished_at: string | null; stats: string }>(d.db, 'SELECT status, finished_at, stats FROM audio_final WHERE session_id = ?', s.id);
  const out = [`# ${s.name}`, '', `${worldName} - ${localDate(s.started_at)}`, '', 'Lines marked **DM only** were not shown to the players.', ''];
  const fs0 = parseJson<{ mics?: number; words?: number }>(fin?.stats, {});
  if (fin?.status === 'done' && fs0.words) {
    const n = fs0.mics;
    out.push(`Final transcript: ${n ? `${n} microphone${n === 1 ? '' : 's'} synced onto one timeline` : 'synced onto one timeline'}, duplicates removed.`, '');
  }
  for (const l of lines) {
    const who = l.speaker_account ? people.get(l.speaker_account) ?? 'Someone' : l.speaker_label;
    out.push(`- \`${fmtTime(l.start_ms)}\` **${who}**${l.audience === 'dm' ? ' (**DM only**)' : ''}: ${String(l.text).replace(/\s+/g, ' ').trim()}`);
  }
  out.push('');
  return out.join('\n');
}

/** Write Transcript.md again from the session's current lines (the final pass, or its undo). False when the session has no recording folder yet (the build writes it). */
export function rewriteTranscript(d: Deps, sessionId: string): boolean {
  const s = sessionRow(d.db, sessionId);
  if (!s?.rec_dir || !d.dataDir) return false;
  const dir = path.join(d.dataDir, s.rec_dir);
  if (!fs.existsSync(dir)) return false;
  writeTranscript(d, s, dir);
  if (fs.existsSync(path.join(dir, 'session.json'))) {
    const world = one<{ name: string }>(d.db, 'SELECT name FROM worlds WHERE id = ?', s.world_id);
    writeSessionJson(d, s, world?.name ?? '', dir);
  }
  return true;
}

/**
 * How the session's transcript was made, for session.json: per mic, where its speech to text ran (chunks done on the
 * device and on the server) and the clock offset the final pass applied; and the final pass itself.
 */
export function transcriptInfo(d: Deps, s: SessionRow) {
  const fin = one<{ status: string; finished_at: string | null; offsets: string; stats: string }>(d.db, 'SELECT status, finished_at, offsets, stats FROM audio_final WHERE session_id = ?', s.id);
  const offsets = parseJson<Record<string, { ms: number; method: string }>>(fin?.offsets, {});
  const mics: Record<string, { device: number; server: number; models: string[]; offsetMs: number | null; syncedBy: string | null }> = {};
  for (const r of all<{ mic_id: string; source: string | null; stt: string; n: number }>(d.db, "SELECT mic_id, source, stt, COUNT(*) AS n FROM audio_chunks WHERE session_id = ? AND status = 'done' GROUP BY mic_id, source, stt", s.id)) {
    const m = mics[r.mic_id] ??= { device: 0, server: 0, models: [], offsetMs: offsets[r.mic_id]?.ms ?? null, syncedBy: offsets[r.mic_id]?.method ?? null };
    if (r.source === 'device') {
      m.device += r.n;
      const info = parseJson<{ model?: string; backend?: string }>(r.stt, {});
      const name = [info.model, info.backend].filter(Boolean).join(' on ');
      if (name && !m.models.includes(name)) m.models.push(name);
    } else m.server += r.n;
  }
  return { final: fin ? { status: fin.status, finishedAt: fin.finished_at, ...parseJson<Record<string, unknown>>(fin.stats, {}) } : null, speechToText: mics };
}

function writeTranscript(d: Deps, s: SessionRow, dir: string) {
  const world = one<{ name: string }>(d.db, 'SELECT name FROM worlds WHERE id = ?', s.world_id);
  fs.writeFileSync(path.join(dir, 'Transcript.md'), transcriptMarkdown(d, s, world?.name ?? ''));
}

export function writeSessionJson(d: Deps, s: SessionRow, worldName: string, dir: string, roles?: Map<string, string>) {
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(sessionJsonDoc(d, s, worldName, roles), null, 2) + '\n');
}

/** The session.json document (the DM's: every mic, every person). */
export function sessionJsonDoc(d: Deps, s: SessionRow, worldName: string, roles?: Map<string, string>) {
  const tracks = all<TrackRow>(d.db, "SELECT * FROM audio_tracks WHERE session_id = ? ORDER BY CASE kind WHEN 'full' THEN 0 ELSE 1 END, created_at, label", s.id);
  const people = new Map(all<any>(d.db, 'SELECT a.id, a.username, a.display_name, m.character_name, m.role FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ?', s.world_id).map((r) => [r.id, r]));
  const info = transcriptInfo(d, s);
  const doc = {
    format: 'alexandria-recording/1',
    sessionId: s.id, worldId: s.world_id, world: worldName, name: s.name,
    date: localDate(s.started_at), startedAt: s.started_at, stoppedAt: s.stopped_at,
    durationMs: s.rec_duration_ms, builtAt: s.rec_built_at, audioDeletedAt: s.audio_deleted_at,
    note: 'Every audio file starts at the session\'s time zero. Silence fills the gaps where a microphone had nothing.',
    warnings: parseJson<string[]>(s.rec_warnings, []),
    retention: { mode: s.retention_mode, days: s.retention_mode === 'days' ? s.retention_days : null },
    files: [
      ...tracks.map((t) => ({ file: t.file, kind: t.kind === 'full' ? 'full-mix' : 'microphone', durationMs: t.duration_ms, bytes: t.bytes, mime: t.mime })),
      { file: 'Transcript.md', kind: 'transcript', note: 'Everything the DM can read; DM-only lines are marked.' },
      { file: 'session.json', kind: 'index' },
    ],
    microphones: tracks.filter((t) => t.kind === 'mic').map((t) => {
      const p = t.account_id ? people.get(t.account_id) : null;
      const stt = t.mic_id ? info.speechToText[t.mic_id] : undefined;
      return { micId: t.mic_id, name: t.label, file: t.file, person: { accountId: t.account_id, username: p?.username ?? null, displayName: p?.display_name ?? t.person, character: p?.character_name || null, role: p?.role ?? roles?.get(t.account_id ?? '') ?? null }, ...(stt ? { speechToText: { deviceChunks: stt.device, serverChunks: stt.server, deviceModels: stt.models }, syncOffsetMs: stt.offsetMs, syncedBy: stt.syncedBy } : {}) };
    }),
    transcript: info.final,
  };
  return doc;
}

// ---- retention ------------------------------------------------------------------------------

/** The days after the session ends that its audio is kept: its own setting, else the world's (blank: forever). Null: forever. */
export function effectiveDays(d: Deps, s: SessionRow): number | null {
  if (s.retention_mode === 'forever') return null;
  if (s.retention_mode === 'days' && s.retention_days) return s.retention_days;
  const w = one<{ settings: string }>(d.db, 'SELECT settings FROM worlds WHERE id = ?', s.world_id);
  const days = featureSetting<number | null>({ ...DEFAULT_SETTINGS, ...parseJson<any>(w?.settings, {}) }, 'audioRetentionDays');
  return days || null;
}

/** When the audio's days start counting: the end of the session (a session still running: its latest chunk). */
export function retentionBasis(d: Deps, s: SessionRow): string {
  if (s.stopped_at) return s.stopped_at;
  return one<{ t: string | null }>(d.db, 'SELECT MAX(created_at) AS t FROM audio_chunks WHERE session_id = ?', s.id)?.t ?? s.started_at;
}

export function deletesAt(d: Deps, s: SessionRow): string | null {
  const days = effectiveDays(d, s);
  return days ? new Date(Date.parse(retentionBasis(d, s)) + days * 864e5).toISOString() : null;
}

/** Remove a session's audio (raw chunks and the joined files). Its transcript, summary and logs stay, and so do Transcript.md and session.json. */
export function deleteSessionAudio(d: Deps, s: SessionRow): number {
  if (!d.dataDir) return 0;
  let n = 0;
  for (const c of all<any>(d.db, 'SELECT id, file, status FROM audio_chunks WHERE session_id = ? AND file IS NOT NULL', s.id)) {
    try { fs.rmSync(path.join(d.dataDir, c.file), { force: true }); } catch { /* already gone */ }
    run(d.db, 'UPDATE audio_chunks SET file = NULL, status = ? WHERE id = ?', ['pending', 'queued', 'awaiting'].includes(c.status) ? 'expired' : c.status, c.id);
    n++;
  }
  const tracks = all<TrackRow>(d.db, 'SELECT * FROM audio_tracks WHERE session_id = ?', s.id);
  if (s.rec_dir) {
    for (const t of tracks) { try { fs.rmSync(path.join(d.dataDir, s.rec_dir, t.file), { force: true }); n++; } catch { /* gone */ } }
    for (const f of fs.existsSync(path.join(d.dataDir, s.rec_dir)) ? fs.readdirSync(path.join(d.dataDir, s.rec_dir)) : []) if (f.endsWith('.part')) { try { fs.rmSync(path.join(d.dataDir, s.rec_dir, f), { force: true }); } catch { /* gone */ } }
  }
  run(d.db, 'DELETE FROM audio_tracks WHERE session_id = ?', s.id);
  if (n || s.rec_dir) {
    run(d.db, "UPDATE audio_sessions SET rec_status = 'deleted', rec_error = NULL, audio_deleted_at = ? WHERE id = ?", now(), s.id);
    if (s.rec_dir && fs.existsSync(path.join(d.dataDir, s.rec_dir, 'session.json'))) {
      const world = one<{ name: string }>(d.db, 'SELECT name FROM worlds WHERE id = ?', s.world_id);
      try { writeSessionJson(d, sessionRow(d.db, s.id)!, world?.name ?? '', path.join(d.dataDir, s.rec_dir)); } catch { /* the folder is gone */ }
    }
  }
  prune(path.join(d.dataDir, 'audio', s.world_id));
  return n;
}

/** Each session's audio goes when its own days are up. Returns how many files were removed. */
export function runRecordingRetention(d: Deps, nowMs = Date.now()): number {
  if (!d.dataDir) return 0;
  let n = 0;
  for (const s of all<SessionRow>(d.db, 'SELECT * FROM audio_sessions WHERE audio_deleted_at IS NULL')) {
    if (isBuilding(d, s.id)) continue;
    const days = effectiveDays(d, s);
    if (!days) continue;
    if (Date.parse(retentionBasis(d, s)) + days * 864e5 > nowMs) continue;
    n += deleteSessionAudio(d, s);
  }
  // Chunk files with no session row mark left from before sessions had their own setting are cleaned with their session above.
  return n;
}

function prune(dir: string) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) prune(path.join(dir, e.name));
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* not there */ }
}
