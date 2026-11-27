// The audio pipeline: chunk -> speech to text -> per-mic words -> merged
// lines with an audience. Everything that decides who may read a line is in
// flush(): it fails closed (a line is GM-only unless every rule lets
// players have it).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Deps } from '../../app.ts';
import { jobConfig, ModelUnavailable, transcribe } from '../../core/ai.ts';
import { all, one, run } from '../../core/db.ts';
import { everyone, type Audience } from '../../core/events.ts';
import { DEFAULT_SETTINGS, featureSetting } from '../../core/policy.ts';
import { HttpError, id as newId, now, parseJson } from '../../core/util.ts';
import { groupUtterances, MAX_UTTERANCE_MS, mergeGroup, similarity, token, utterances, type Word } from './merge.ts';
import { cleanWords, echoesPrompt, junkReason, QUIET_LEVEL, type Pw } from './clean.ts';
import { buildHint, containsTerm, gmOnlyTerms } from './hint.ts';
import { notifyLine } from './hooks.ts';
import { runRecordingRetention, rewriteTranscript } from './recordings.ts';
import { chooseOffsets, dedupeLines, tidyLines, type OffsetEstimate } from './final.ts';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS audio_consent (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agreed INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (world_id, account_id)
);
CREATE TABLE IF NOT EXISTS audio_sessions (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  started_by TEXT,
  stopped_at TEXT
);
CREATE INDEX IF NOT EXISTS audio_sessions_world ON audio_sessions (world_id, started_at);
CREATE TABLE IF NOT EXISTS audio_mics (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  label TEXT NOT NULL,
  mode TEXT NOT NULL,
  players_transcript INTEGER NOT NULL DEFAULT 1,
  aside INTEGER NOT NULL DEFAULT 0,
  room INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (world_id, account_id, device_id)
);
CREATE TABLE IF NOT EXISTS audio_chunks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES audio_sessions(id) ON DELETE CASCADE,
  mic_id TEXT NOT NULL REFERENCES audio_mics(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  level REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL,
  file TEXT,
  mime TEXT NOT NULL,
  words TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  source TEXT,
  stt TEXT NOT NULL DEFAULT '',
  skew_ms INTEGER,
  UNIQUE (session_id, mic_id, seq)
);
CREATE INDEX IF NOT EXISTS audio_chunks_time ON audio_chunks (session_id, end_ms);
CREATE TABLE IF NOT EXISTS audio_holds (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES audio_sessions(id) ON DELETE CASCADE,
  mic_id TEXT,
  kind TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audio_holds_time ON audio_holds (session_id, end_ms);
CREATE TABLE IF NOT EXISTS audio_lines (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES audio_sessions(id) ON DELETE CASCADE,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  speaker_account TEXT,
  speaker_label TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  words TEXT NOT NULL DEFAULT '[]',
  sources TEXT NOT NULL DEFAULT '[]',
  audience TEXT NOT NULL DEFAULT 'gm',
  audience_override TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audio_lines_session ON audio_lines (session_id, start_ms);
CREATE TABLE IF NOT EXISTS audio_final (
  session_id TEXT PRIMARY KEY REFERENCES audio_sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  step TEXT NOT NULL DEFAULT '',
  pct INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  live_lines TEXT NOT NULL DEFAULT '[]',
  offsets TEXT NOT NULL DEFAULT '{}',
  stats TEXT NOT NULL DEFAULT '{}',
  error TEXT
);
`;

/** Columns audio_chunks gains (additive). */
export function migrateStt(db: import('../../core/db.ts').DB) {
  const cols = (db.prepare('PRAGMA table_info(audio_chunks)').all() as any[]).map((c) => c.name);
  if (!cols.includes('source')) db.exec('ALTER TABLE audio_chunks ADD COLUMN source TEXT');
  if (!cols.includes('stt')) db.exec("ALTER TABLE audio_chunks ADD COLUMN stt TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('skew_ms')) db.exec('ALTER TABLE audio_chunks ADD COLUMN skew_ms INTEGER');
}

export const DEFAULT_CONSENT_TEXT = 'This session is recorded and turned into a text transcript so everyone can follow it. Your microphone is only used while a session is recording, and only if you turn it on. You can withdraw your consent at any time.';

export type SttMode = 'server' | 'device' | 'auto';
export type Mode = 'always' | 'hold-to-talk' | 'hold-to-mute' | 'off';
export const MODES: readonly Mode[] = ['always', 'hold-to-talk', 'hold-to-mute', 'off'];
export const HOLD_KINDS = ['talk', 'mute', 'aside'] as const;

export interface MicRow { id: string; world_id: string; account_id: string; device_id: string; label: string; mode: Mode; players_transcript: number; aside: number; room: number; created_at: string }
export interface LineRow {
  id: string; session_id: string; world_id: string; start_ms: number; end_ms: number; speaker_account: string | null; speaker_label: string;
  text: string; words: string; sources: string; audience: 'players' | 'gm'; audience_override: 'players' | 'gm' | null; rev: number; updated_at: string;
}

// A line is GM-only only if it overlaps the aside (plus a little for clock jitter between devices); the lines either side stay with the table.
const ASIDE_PAD = 40;

/** Split an utterance wherever a cut time falls between two of its words. */
function splitAt<U extends { start: number; end: number; words: Word[] }>(u: U, cuts: number[]): U[] {
  if (!cuts.length) return [u];
  const side = (w: Word) => cuts.filter((c) => (w.s + w.e) / 2 >= c).length;
  const out: U[] = [];
  for (const w of u.words) {
    const last = out[out.length - 1];
    if (last && side(last.words[last.words.length - 1]) === side(w)) { last.words.push(w); last.end = Math.max(last.end, w.e); }
    else out.push({ ...u, start: w.s, end: w.e, words: [w] });
  }
  return out;
}
const CONTEXT = 30_000;
/** A personal mic is credited with a line only when it is this much louder than every other mic that heard it. */
const CLOSE_RATIO = 1.5;
export const TABLE = 'Table';
const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && a1 > b0;

/** What each kind of viewer is sent for a line. Players never get sources, words or the audience field. */
export function lineView(l: LineRow, gm: boolean, nameOf: (accountId: string) => string) {
  const speaker = l.speaker_account ? nameOf(l.speaker_account) : l.speaker_label;
  const base = { id: l.id, sessionId: l.session_id, start: l.start_ms, end: l.end_ms, speaker, speakerId: l.speaker_account, text: l.text, rev: l.rev, updatedAt: l.updated_at };
  if (!gm) return base;
  return { ...base, audience: l.audience, override: l.audience_override, sources: parseJson<string[]>(l.sources, []), words: parseJson<unknown[]>(l.words, []) };
}

const engines = new WeakMap<object, Engine>();
export const engine = (d: Deps): Engine => { let e = engines.get(d.db); if (!e) { e = new Engine(d); engines.set(d.db, e); } return e; };

export class Engine {
  d: Deps;
  private dirty = new Map<string, { from: number; to: number; timer?: ReturnType<typeof setTimeout> }>();
  private inflight = new Set<string>();
  private hints = new Map<string, { at: number; text: string }>();
  private terms = new Map<string, { at: number; list: string[][] }>();
  /** Segments thrown away since the server started, by reason (hallucinations and echoes). */
  dropped: Record<string, number> = {};

  constructor(d: Deps) { this.d = d; }

  get delay() { const n = Number(this.d.env.ALX_AUDIO_MERGE_MS ?? 5000); return Number.isFinite(n) && n >= 0 ? n : 5000; }

  // ---- hints for the speech model --------------------------------------

  /** What a world's players may read: see hint.ts. Never a GM-only, broker or classified title. */
  hint(worldId: string): string {
    const c = this.hints.get(worldId);
    if (c && Date.now() - c.at < 15_000) return c.text;
    let text = '';
    try { text = buildHint(this.d.db, worldId); } catch (err) { console.error('audio: hint failed', err); }
    this.hints.set(worldId, { at: Date.now(), text });
    return text;
  }
  resetHint(worldId?: string) { if (worldId) this.hints.delete(worldId); else this.hints.clear(); this.terms.clear(); }

  /** GM-only titles and aliases of a world, as token lists (cached for a short while). */
  private gmTerms(worldId: string): string[][] {
    const c = this.terms.get(worldId);
    if (c && Date.now() - c.at < 15_000) return c.list;
    let list: string[][] = [];
    try { list = gmOnlyTerms(this.d.db, worldId); } catch { /* none */ }
    this.terms.set(worldId, { at: Date.now(), list });
    return list;
  }

  private worldSetting(worldId: string, key: string): unknown {
    const w = one<any>(this.d.db, 'SELECT settings FROM worlds WHERE id = ?', worldId);
    return featureSetting({ ...DEFAULT_SETTINGS, ...parseJson<any>(w?.settings, {}) }, key);
  }

  // ---- chunks ------------------------------------------------------------

  /** Transcribe a stored chunk. A missing or unreachable model leaves it 'pending' for the retry job. */
  async process(chunkId: string): Promise<'done' | 'pending' | 'skipped'> {
    if (this.inflight.has(chunkId)) return 'skipped';
    const ch = one<any>(this.d.db, 'SELECT c.*, s.world_id FROM audio_chunks c JOIN audio_sessions s ON s.id = c.session_id WHERE c.id = ?', chunkId);
    if (!ch || !ch.file || !this.d.dataDir) return 'skipped';
    this.inflight.add(chunkId);
    try {
      let bytes: Buffer;
      try { bytes = fs.readFileSync(path.join(this.d.dataDir, ch.file)); } catch { run(this.d.db, "UPDATE audio_chunks SET status = 'failed' WHERE id = ?", chunkId); return 'skipped'; }
      const hintOn = this.worldSetting(ch.world_id, 'transcriptHint') !== 'off';
      // A quiet chunk gets no vocabulary: a prompt on near silence is what the model repeats back.
      const hint = hintOn && ch.level >= QUIET_LEVEL ? this.hint(ch.world_id) : '';
      const context = this.worldSetting(ch.world_id, 'transcriptContext') === 'on' ? this.contextFor(ch) : '';
      const prompt = [hint, context].filter(Boolean).join(' ');
      let t: Awaited<ReturnType<typeof transcribe>>;
      // Segments the model made up (a loop, or text it was unsure of) and the words it was sure of.
      const madeUp = (x: typeof t) => x.segments.filter((s) => ['compression', 'logprob'].includes(junkReason(s) ?? '')).length;
      const sure = (x: typeof t) => x.segments.filter((s) => !junkReason(s)).reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
      try {
        t = await transcribe(this.d, bytes, ch.mime, { prompt });
        let asked = prompt;
        // Names the speech does not contain can pull a small model off course: on real speech
        // it wrote "grocery, Target" with the hint and "or bats, and then there's a door" without.
        // So a chunk with made-up text is asked again without the hint, and the surer answer kept.
        if (ch.level >= 0.1 && hint && madeUp(t)) {
          try { const alt = await transcribe(this.d, bytes, ch.mime, { prompt: context }); if (sure(alt) > sure(t)) { t = alt; asked = context; } } catch { /* keep the first answer */ }
        }
        // Still nothing but a loop or made-up text on a chunk with signal: once more, a little warmer.
        if (ch.level >= 0.1 && t.segments.length && madeUp(t) === t.segments.length) {
          try { t = await transcribe(this.d, bytes, ch.mime, { prompt: asked, temperature: 0.4 }); } catch { /* keep the answer we have */ }
        }
      } catch (err) {
        if (!(err instanceof ModelUnavailable)) console.error('audio: transcription failed', err);
        const attempts = ch.attempts + 1;
        run(this.d.db, 'UPDATE audio_chunks SET status = ?, attempts = ? WHERE id = ?', attempts >= 60 ? 'failed' : 'pending', attempts, chunkId);
        return 'pending';
      }
      const words = this.wordsOf(t.segments, ch.start_ms, hint);
      run(this.d.db, "UPDATE audio_chunks SET status = 'done', source = 'server', words = ?, attempts = attempts + 1 WHERE id = ?", JSON.stringify(words), chunkId);
      await this.touch(ch.session_id, ch.start_ms, ch.end_ms);
      return 'done';
    } finally { this.inflight.delete(chunkId); }
  }

  // ---- speech to text on the device ---------------------------------------------------

  /**
   * Where speech to text runs for a world: 'server' (the server's speech model), 'device' (every recording device runs
   * its own model, WebGPU or else WASM) or 'auto' (a device runs its own model when it has a GPU the browser can use).
   * Whatever a device does not send text for, the server transcribes itself, so the transcript has no gaps.
   */
  sttMode(worldId: string): SttMode {
    const v = this.worldSetting(worldId, 'speechToText');
    return v === 'device' || v === 'auto' ? v : 'server';
  }

  /** How long a chunk waits for its device's text before the server (or nobody) takes it. */
  get textWaitMs() { const n = Number(this.d.env.ALX_AUDIO_TEXT_WAIT_MS ?? 45_000); return Number.isFinite(n) && n >= 0 ? n : 45_000; }

  /**
   * A chunk was just stored. `wait`: its device says text is coming, so the chunk waits for it (the server takes it
   * when the text does not come in time, or the device gives up). Otherwise the server listens now.
   */
  async intake(chunkId: string, wait: boolean): Promise<string> {
    const ch = one<any>(this.d.db, 'SELECT c.id, s.world_id FROM audio_chunks c JOIN audio_sessions s ON s.id = c.session_id WHERE c.id = ?', chunkId);
    if (!ch) return 'skipped';
    if (wait && this.sttMode(ch.world_id) !== 'server') { run(this.d.db, "UPDATE audio_chunks SET status = 'awaiting' WHERE id = ?", chunkId); return 'awaiting'; }
    return this.process(chunkId);
  }

  /** The device could not transcribe a chunk it promised text for (its model failed, or it fell behind): the server does it now. */
  async giveUp(chunkId: string): Promise<{ status: string; accepted: boolean; words: number }> {
    const ch = one<any>(this.d.db, 'SELECT status FROM audio_chunks WHERE id = ?', chunkId);
    if (!ch) throw new HttpError(404, 'Chunk not found');
    if (ch.status !== 'awaiting') return { status: ch.status, accepted: false, words: 0 };
    const r = await this.process(chunkId);
    return { status: r === 'done' ? 'done' : r, accepted: false, words: 0 };
  }

  /**
   * The words a device heard in a chunk (segments or a flat word list, seconds from the chunk's start). They go through
   * the same filters as the server model's (loops, hallucinations, an echo of the vocabulary prompt), so a device cannot
   * put anything on the transcript the server's own model could not. Late text for a chunk the server already did is ignored.
   */
  async acceptText(chunkId: string, body: any): Promise<{ status: string; accepted: boolean; words: number }> {
    const ch = one<any>(this.d.db, 'SELECT c.*, s.world_id FROM audio_chunks c JOIN audio_sessions s ON s.id = c.session_id WHERE c.id = ?', chunkId);
    if (!ch) throw new HttpError(404, 'Chunk not found');
    if (body?.giveUp === true) return this.giveUp(chunkId);
    if (this.sttMode(ch.world_id) === 'server') return { status: ch.status, accepted: false, words: 0 };
    // The server got there first (the text came too late), or the chunk is gone: the device's text is not needed.
    if ((ch.status === 'done' && ch.source === 'server') || !['awaiting', 'pending', 'queued', 'done'].includes(ch.status)) return { status: ch.status, accepted: false, words: 0 };
    if (this.inflight.has(chunkId)) return { status: ch.status, accepted: false, words: 0 };
    const num = (v: unknown, lo: number, hi: number, what: string) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `${what} is out of range`); return n; };
    const span = (ch.end_ms - ch.start_ms) / 1000;
    const rawSegs: any[] | null = Array.isArray(body?.segments) ? body.segments : Array.isArray(body?.words) ? [{ start: 0, end: span, text: body.words.map((w: any) => String(w?.word ?? '')).join(' '), words: body.words }] : null;
    if (!rawSegs) throw new HttpError(400, 'Send segments or words');
    if (rawSegs.length > 200 || rawSegs.reduce((n, sg) => n + (Array.isArray(sg?.words) ? sg.words.length : 0), 0) > 3000) throw new HttpError(400, 'That is too many words for one chunk');
    const segments = rawSegs.map((sg) => {
      const words = (Array.isArray(sg?.words) ? sg.words : []).map((w: any) => {
        if (typeof w?.word !== 'string') throw new HttpError(400, 'Each word needs a word');
        return { word: w.word.slice(0, 80), start: num(w.start, -5, span + 5, 'start'), end: num(w.end, -5, span + 10, 'end'), probability: w.probability === undefined ? undefined : num(w.probability, 0, 1, 'probability') };
      });
      return {
        start: num(sg?.start ?? 0, -5, span + 5, 'start'), end: num(sg?.end ?? span, -5, span + 10, 'end'), text: String(sg?.text ?? words.map((w: any) => w.word).join(' ')).slice(0, 4000),
        avgLogprob: typeof sg?.avgLogprob === 'number' ? sg.avgLogprob : undefined, noSpeechProb: typeof sg?.noSpeechProb === 'number' ? sg.noSpeechProb : undefined,
        compressionRatio: typeof sg?.compressionRatio === 'number' ? sg.compressionRatio : undefined, words: words.length ? words : undefined,
      };
    });
    const hint = this.worldSetting(ch.world_id, 'transcriptHint') !== 'off' && ch.level >= QUIET_LEVEL ? this.hint(ch.world_id) : '';
    const words = this.wordsOf(segments, ch.start_ms, hint);
    const s = body?.stt ?? {};
    const info = JSON.stringify({ model: String(s.model ?? '').slice(0, 60), backend: String(s.backend ?? '').slice(0, 20), ms: Number.isFinite(Number(s.ms)) ? Math.round(Number(s.ms)) : null, rtf: Number.isFinite(Number(s.rtf)) ? Math.round(Number(s.rtf) * 100) / 100 : null });
    run(this.d.db, "UPDATE audio_chunks SET status = 'done', source = 'device', stt = ?, words = ? WHERE id = ?", info, JSON.stringify(words), chunkId);
    await this.touch(ch.session_id, ch.start_ms, ch.end_ms);
    return { status: 'done', accepted: true, words: words.length };
  }

  /** Chunks whose device text never came (in time): the server takes them. Narrowed to a session or one mic. */
  async expireAwaiting(sessionId?: string, olderThanMs = this.textWaitMs, micId?: string): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const rows = all<any>(this.d.db, `SELECT c.id FROM audio_chunks c WHERE c.status = 'awaiting' AND c.created_at <= ? ${sessionId ? 'AND c.session_id = ?' : ''} ${micId ? 'AND c.mic_id = ?' : ''} ORDER BY c.created_at LIMIT 200`, cutoff, ...(sessionId ? [sessionId] : []), ...(micId ? [micId] : []));
    let n = 0;
    for (const r of rows) if ((await this.process(r.id)) === 'done') n++;
    return n;
  }

  /** What each mic's device last said about itself (model, backend, speed, backlog), by mic id. */
  sttStatus = new Map<string, { at: number; model: string; backend: string; state: string; rtf: number | null; backlog: number; progress: number | null; note: string }>();

  /** Speech-model segments -> the words we keep: hallucinations, prompt echoes and loops removed, dice written the table's way. */
  wordsOf(segments: { start: number; end: number; text: string; avgLogprob?: number; noSpeechProb?: number; compressionRatio?: number; words?: { word: string; start: number; end: number; probability?: number }[] }[], startMs: number, hint: string): Pw[] {
    const words: Pw[] = [];
    const drop = (why: string) => { this.dropped[why] = (this.dropped[why] ?? 0) + 1; };
    for (const seg of segments) {
      const why = junkReason(seg);
      if (why) { drop(why); continue; }
      if (echoesPrompt(seg.text, hint)) { drop('hint-echo'); continue; }
      const segConf = seg.avgLogprob !== undefined ? Math.exp(seg.avgLogprob) : 0.6;
      const ws = seg.words?.length ? seg.words : synth(seg.text, seg.start, seg.end);
      for (const w of ws) {
        if (!token(w.word)) continue;
        const conf = Math.min(1, Math.max(0, w.probability ?? segConf));
        words.push([w.word.trim(), Math.round(startMs + w.start * 1000), Math.round(startMs + Math.max(w.end, w.start + 0.05) * 1000), Math.round(conf * 1000) / 1000]);
      }
    }
    const kept = cleanWords(words);
    if (kept.length < words.length) drop('repeat');
    return kept;
  }

  /** The last few words this mic said before the chunk: what the model is told came just before. */
  private contextFor(ch: any): string {
    const prev = all<any>(this.d.db, "SELECT words FROM audio_chunks WHERE mic_id = ? AND session_id = ? AND status = 'done' AND end_ms <= ? AND end_ms >= ? ORDER BY end_ms DESC LIMIT 2", ch.mic_id, ch.session_id, ch.end_ms, ch.start_ms - 15_000);
    const ws: string[] = [];
    for (const p of prev.reverse()) for (const [w, , e] of parseJson<[string, number, number, number][]>(p.words, [])) if (e <= ch.start_ms) ws.push(w);
    const text = ws.join(' ');
    return text.length > 100 ? text.slice(text.length - 100).replace(/^\S*\s/, '') : text;
  }

  // ---- the second listen -----------------------------------------------------------

  /** Glue chunk files (each minus the start it repeats from the one before) into one wav. Null when it cannot (no ffmpeg). */
  joiner: (files: { path: string; trimMs: number }[]) => Promise<Buffer | null> = ffmpegJoin;

  /** The refine pass that is waiting or running for a session (the recording is built after it, which needs the same chunks). */
  refining = new Map<string, Promise<unknown>>();

  scheduleRefine(sessionId: string) {
    const n = Number(this.d.env.ALX_AUDIO_REFINE_DELAY_MS ?? 20_000);
    let go!: () => void;
    const p = new Promise<void>((resolve) => { go = resolve; }).then(() => this.refine(sessionId)).catch((e) => console.error('audio: refine failed', e))
      .then(() => {
        const w = one<any>(this.d.db, 'SELECT world_id FROM audio_sessions WHERE id = ?', sessionId);
        if (w && this.worldSetting(w.world_id, 'finalTranscript') !== 'off') return this.finalize(sessionId).catch((e) => console.error('audio: final transcript failed', e));
      }).finally(() => { this.refining.delete(sessionId); });
    this.refining.set(sessionId, p);
    const t = setTimeout(go, Number.isFinite(n) ? n : 20_000);
    t.unref?.();
  }

  /**
   * After a recording stops: listen to the kept audio again in windows of up to 60 s with the audio job's `refineModel`
   * (a bigger model; longer context is worth about ten points of word error over 5 s pieces) and replace the words. Lines
   * keep their ids and GM-only flags, and a line that was GM-only stays GM-only (nothing is loosened). Off unless the
   * world's transcriptRefine is on and the job names a refineModel. Returns how many windows were redone.
   */
  async refine(sessionId: string, opts: { force?: boolean } = {}): Promise<number> {
    const { db, dataDir } = this.d;
    const session = one<any>(db, 'SELECT * FROM audio_sessions WHERE id = ?', sessionId);
    if (!session || !session.stopped_at || !dataDir) return 0;
    if (!opts.force && this.worldSetting(session.world_id, 'transcriptRefine') !== 'on') return 0;
    const model = jobConfig(this.d, 'audio')?.options?.refineModel;
    if (!opts.force && (typeof model !== 'string' || !model)) return 0;
    if (opts.force && !jobConfig(this.d, 'audio')) return 0;
    const hint = this.hint(session.world_id);
    let redone = 0;
    const mics = all<any>(db, "SELECT DISTINCT mic_id FROM audio_chunks WHERE session_id = ? AND status = 'done' AND file IS NOT NULL", sessionId);
    for (const { mic_id } of mics) {
      const chunks = all<any>(db, "SELECT id, file, mime, start_ms, end_ms FROM audio_chunks WHERE session_id = ? AND mic_id = ? AND status = 'done' AND file IS NOT NULL ORDER BY start_ms", sessionId, mic_id);
      const windows: { chunk: any; trim: number; from: number }[][] = [];
      let cur: { chunk: any; trim: number; from: number }[] = [];
      let covered = 0;
      for (const c of chunks) {
        const from = Math.max(c.start_ms, covered);
        if (cur.length && (c.start_ms > covered + 300 || c.end_ms - cur[0].from > 60_000)) { windows.push(cur); cur = []; }
        const first = !cur.length;
        const f = first ? c.start_ms : Math.max(c.start_ms, covered);
        if (c.end_ms <= covered && !first) continue;
        cur.push({ chunk: c, trim: f - c.start_ms, from: f });
        covered = Math.max(covered, c.end_ms);
        void from;
      }
      if (cur.length) windows.push(cur);
      for (const win of windows) {
        const start = win[0].from;
        const end = win[win.length - 1].chunk.end_ms;
        const wav = await this.joiner(win.map((x) => ({ path: path.join(dataDir, x.chunk.file), trimMs: x.trim })));
        if (!wav) return redone;
        let t;
        try { t = await transcribe(this.d, wav, 'audio/wav', { prompt: hint, ...(typeof model === 'string' && model ? { model } : {}) }); } catch (err) { if (!(err instanceof ModelUnavailable)) console.error('audio: refine failed', err); return redone; }
        const words = this.wordsOf(t.segments, start, hint);
        // Each word goes back to the chunk that owns that moment.
        const owned = new Map<string, Pw[]>(win.map((x) => [x.chunk.id, []]));
        for (const w of words) {
          const mid = (w[1] + w[2]) / 2;
          const x = win.find((y) => mid >= y.from && mid <= y.chunk.end_ms) ?? win[win.length - 1];
          owned.get(x.chunk.id)!.push(w);
        }
        for (const [id, ws] of owned) run(db, "UPDATE audio_chunks SET words = ?, status = 'done', source = 'server' WHERE id = ?", JSON.stringify(ws), id);
        this.merge(sessionId, start, end, true);
        redone++;
      }
    }
    return redone;
  }

  async retryPending(limit = 25): Promise<number> {
    await this.expireAwaiting();
    const rows = all<any>(this.d.db, "SELECT id FROM audio_chunks WHERE status = 'pending' AND file IS NOT NULL ORDER BY created_at LIMIT ?", limit);
    let n = 0;
    for (const r of rows) if ((await this.process(r.id)) === 'done') n++;
    return n;
  }

  // ---- the final transcript ---------------------------------------------------------

  private finalizing = new Map<string, Promise<void>>();
  isFinalizing(sessionId: string) { return this.finalizing.has(sessionId); }

  private setFinal(sessionId: string, worldId: string, p: { status?: string; step?: string; pct?: number; error?: string | null; offsets?: unknown; stats?: unknown; finished?: boolean }) {
    const sets: string[] = []; const vals: unknown[] = [];
    if (p.status !== undefined) { sets.push('status = ?'); vals.push(p.status); }
    if (p.step !== undefined) { sets.push('step = ?'); vals.push(p.step); }
    if (p.pct !== undefined) { sets.push('pct = ?'); vals.push(Math.max(0, Math.min(100, Math.round(p.pct)))); }
    if (p.error !== undefined) { sets.push('error = ?'); vals.push(p.error); }
    if (p.offsets !== undefined) { sets.push('offsets = ?'); vals.push(JSON.stringify(p.offsets)); }
    if (p.stats !== undefined) { sets.push('stats = ?'); vals.push(JSON.stringify(p.stats)); }
    if (p.finished) { sets.push('finished_at = ?'); vals.push(now()); }
    if (sets.length) run(this.d.db, `UPDATE audio_final SET ${sets.join(', ')} WHERE session_id = ?`, ...vals, sessionId);
    const row = one<any>(this.d.db, 'SELECT status, step, pct FROM audio_final WHERE session_id = ?', sessionId);
    if (row) this.d.hub.emit(worldId, 'transcript-final', { sessionId, status: row.status, step: row.step, pct: row.pct }, (v) => v.role === 'gm');
  }

  /** The final pass of a session (running, finished or undone), for the GM. */
  finalView(sessionId: string) {
    const f = one<any>(this.d.db, 'SELECT * FROM audio_final WHERE session_id = ?', sessionId);
    if (!f) return null;
    return {
      status: f.status as 'running' | 'done' | 'failed' | 'undone', step: f.step as string, pct: f.pct as number, startedAt: f.started_at as string, finishedAt: f.finished_at as string | null, error: f.error as string | null,
      offsets: parseJson<Record<string, unknown>>(f.offsets, {}), stats: parseJson<Record<string, unknown>>(f.stats, {}), hasLive: parseJson<unknown[]>(f.live_lines, []).length > 0,
    };
  }

  /** The lines as they were live, before the final pass (as the GM's view). */
  liveLines(sessionId: string): LineRow[] {
    const f = one<any>(this.d.db, 'SELECT live_lines FROM audio_final WHERE session_id = ?', sessionId);
    return f ? parseJson<LineRow[]>(f.live_lines, []) : [];
  }

  /** Wait (a little) for devices' text that is on its way, then hand what never came to the server. */
  private async settleAwaiting(sessionId: string) {
    const n = Number(this.d.env.ALX_AUDIO_FINAL_WAIT_MS ?? 15_000);
    const until = Date.now() + (Number.isFinite(n) ? n : 15_000);
    while (Date.now() < until && one(this.d.db, "SELECT 1 FROM audio_chunks WHERE session_id = ? AND status = 'awaiting'", sessionId)) await new Promise((r) => setTimeout(r, 200));
    await this.expireAwaiting(sessionId, 0);
  }

  /**
   * The final transcript of a stopped session: every mic's words put on one timeline (clock offsets from the words they
   * share and from the clock samples of their uploads), the best mic for each moment, duplicates across mics removed,
   * speakers from the mic's owner, line breaks fixed. It replaces the live lines (kept in audio_final for comparing and
   * undo); GM-only lines stay GM-only and a GM's own audience marks are kept. With `retranscribe` the kept audio is first
   * listened to again with the server's speech model. Transcript.md is written again after.
   */
  finalize(sessionId: string, opts: { retranscribe?: boolean } = {}): Promise<void> {
    const running = this.finalizing.get(sessionId);
    if (running) return running;
    const p = this.runFinal(sessionId, opts).finally(() => { this.finalizing.delete(sessionId); });
    this.finalizing.set(sessionId, p);
    return p;
  }

  private async runFinal(sessionId: string, opts: { retranscribe?: boolean }) {
    const { db } = this.d;
    const session = one<any>(db, 'SELECT * FROM audio_sessions WHERE id = ?', sessionId);
    if (!session || !session.stopped_at) throw new HttpError(409, 'Stop the recording first');
    const w = session.world_id as string;
    const prev = one<any>(db, 'SELECT status, live_lines FROM audio_final WHERE session_id = ?', sessionId);
    // The live version is kept from the first pass; a second pass compares against that, not against the first final.
    const live = prev && prev.status !== 'undone' && parseJson<unknown[]>(prev.live_lines, []).length ? prev.live_lines : JSON.stringify(all<LineRow>(db, 'SELECT * FROM audio_lines WHERE session_id = ?', sessionId));
    run(db, `INSERT INTO audio_final (session_id, status, step, pct, started_at, live_lines) VALUES (?, 'running', 'Waiting for the last chunks', 0, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET status = 'running', step = 'Waiting for the last chunks', pct = 0, started_at = excluded.started_at, finished_at = NULL, error = NULL, live_lines = excluded.live_lines`, sessionId, now(), live);
    this.setFinal(sessionId, w, {});
    try {
      await this.settleAwaiting(sessionId);
      if (opts.retranscribe) {
        this.setFinal(sessionId, w, { step: 'Listening again with the server model', pct: 5 });
        await this.refine(sessionId, { force: true });
      }
      this.flush(sessionId);

      // Every mic's words over the whole session, and the clock samples its uploads carried.
      const chunks = all<any>(db, "SELECT mic_id, level, words, start_ms, end_ms, skew_ms FROM audio_chunks WHERE session_id = ? AND status = 'done'", sessionId);
      const streams = new Map<string, Word[]>();
      const skews = new Map<string, number[]>();
      let duration = 0;
      for (const c of chunks) {
        duration = Math.max(duration, c.end_ms);
        const l = streams.get(c.mic_id) ?? [];
        for (const [x, s0, e0, p] of parseJson<[string, number, number, number][]>(c.words, [])) l.push({ w: x, s: s0, e: e0, c: p, l: Math.max(0.02, Math.min(1, c.level)) });
        streams.set(c.mic_id, l);
        if (c.skew_ms !== null) { const k = skews.get(c.mic_id) ?? []; k.push(c.skew_ms); skews.set(c.mic_id, k); }
      }
      const micCount = streams.size;
      this.setFinal(sessionId, w, { step: `Syncing ${micCount} mic${micCount === 1 ? '' : 's'}`, pct: 10 });
      const est = chooseOffsets(streams, skews);
      const offsets = new Map<string, number>([...est].map(([m, e]) => [m, e.ms]));
      const offOut: Record<string, OffsetEstimate> = {};
      for (const [m, e] of est) offOut[m] = e;
      this.setFinal(sessionId, w, { offsets: offOut });

      // No device or model produced a single word (tones, a test, a dead model): the lines stay as they are.
      const heard = [...streams.values()].reduce((n, l) => n + l.length, 0);
      const WIN = 10 * 60_000;
      const windows = Math.max(1, Math.ceil((duration + Math.max(0, ...[...offsets.values()].map((v) => Math.abs(v)))) / WIN));
      for (let i = 0; i < (heard ? windows : 0); i++) {
        this.merge(sessionId, i * WIN, (i + 1) * WIN, true, { offsets, final: true });
        this.setFinal(sessionId, w, { step: `Merging ${micCount} mic${micCount === 1 ? '' : 's'} (${i + 1} of ${windows})`, pct: 15 + (75 * (i + 1)) / windows });
        await new Promise((r) => setImmediate(r));
      }
      this.setFinal(sessionId, w, { step: 'Writing Transcript.md', pct: 92 });
      const liveRows = parseJson<LineRow[]>(live, []);
      const finalRows = all<LineRow>(db, 'SELECT id FROM audio_lines WHERE session_id = ?', sessionId);
      this.setFinal(sessionId, w, { status: 'done', step: 'Done', pct: 100, finished: true, stats: { mics: micCount, words: heard, liveLines: liveRows.length, finalLines: finalRows.length, retranscribed: !!opts.retranscribe } });
      rewriteTranscript(this.d, sessionId);
    } catch (e) {
      this.setFinal(sessionId, w, { status: 'failed', step: 'Failed', error: String((e as Error)?.message ?? e).slice(0, 300), finished: true });
      throw e;
    }
  }

  /** Put the live lines back (the GM prefers them) and write Transcript.md again. */
  undoFinal(sessionId: string): number {
    const { db } = this.d;
    const f = one<any>(db, 'SELECT * FROM audio_final WHERE session_id = ?', sessionId);
    const session = one<any>(db, 'SELECT * FROM audio_sessions WHERE id = ?', sessionId);
    if (!f || !session || f.status === 'running') throw new HttpError(409, f?.status === 'running' ? 'The final transcript is still being made' : 'There is no final transcript to undo');
    const rows = parseJson<LineRow[]>(f.live_lines, []);
    if (!rows.length && f.status === 'undone') throw new HttpError(409, 'The live transcript is already back');
    const nm = this.nameOf(session.world_id);
    const current = all<LineRow>(db, 'SELECT * FROM audio_lines WHERE session_id = ?', sessionId);
    const keep = new Map(current.map((l) => [l.id, l]));
    db.exec('BEGIN');
    try {
      run(db, 'DELETE FROM audio_lines WHERE session_id = ?', sessionId);
      for (const l of rows) run(db, 'INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_account, speaker_label, text, words, sources, audience, audience_override, rev, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        l.id, l.session_id, l.world_id, l.start_ms, l.end_ms, l.speaker_account, l.speaker_label, l.text, l.words, l.sources, l.audience, l.audience_override, (keep.get(l.id)?.rev ?? l.rev) + 1, now());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    const restored = new Set(rows.map((l) => l.id));
    for (const l of current) if (!restored.has(l.id)) this.emitLine({ ...l, rev: l.rev + 1 }, l.audience, nm, true);
    for (const l of all<LineRow>(db, 'SELECT * FROM audio_lines WHERE session_id = ?', sessionId)) this.emitLine(l, keep.get(l.id)?.audience ?? null, nm);
    run(db, "UPDATE audio_final SET status = 'undone', step = 'Live transcript restored', pct = 100 WHERE session_id = ?", sessionId);
    this.setFinal(sessionId, session.world_id, {});
    rewriteTranscript(this.d, sessionId);
    return rows.length;
  }

  // ---- merging -----------------------------------------------------------

  /** Something changed between from and to (ms): merge soon. With no delay (tests), now. */
  async touch(sessionId: string, from: number, to: number) {
    const cur = this.dirty.get(sessionId);
    if (cur) { cur.from = Math.min(cur.from, from); cur.to = Math.max(cur.to, to); } else this.dirty.set(sessionId, { from, to });
    if (this.delay === 0) { this.flush(sessionId); return; }
    const e = this.dirty.get(sessionId)!;
    if (!e.timer) {
      e.timer = setTimeout(() => { try { this.flush(sessionId); } catch (err) { console.error('audio: merge failed', err); } }, this.delay);
      e.timer.unref?.();
    }
  }

  /** Merge everything waiting for a session now (a session stopped, or a test). */
  flush(sessionId: string) {
    const e = this.dirty.get(sessionId);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    this.dirty.delete(sessionId);
    this.merge(sessionId, e.from, e.to);
  }
  flushAll() { for (const k of [...this.dirty.keys()]) this.flush(k); }

  private merge(sessionId: string, from: number, to: number, keepGm = false, opts: { offsets?: Map<string, number>; final?: boolean } = {}) {
    const { db } = this.d;
    const session = one<any>(db, 'SELECT * FROM audio_sessions WHERE id = ?', sessionId);
    if (!session) return;
    const offs = opts.offsets ?? new Map<string, number>();
    const pad = Math.max(0, ...[...offs.values()].map((v) => Math.abs(v)));
    const lo = from - CONTEXT - pad;
    const hi = to + CONTEXT + pad;
    const mics = new Map(all<MicRow>(db, 'SELECT * FROM audio_mics WHERE world_id = ?', session.world_id).map((m) => [m.id, m]));
    const roles = new Map(all<any>(db, 'SELECT account_id, role FROM members WHERE world_id = ?', session.world_id).map((m) => [m.account_id, m.role as string]));
    const chunks = all<any>(db, "SELECT mic_id, level, words, start_ms, end_ms FROM audio_chunks WHERE session_id = ? AND status = 'done' AND end_ms >= ? AND start_ms <= ?", sessionId, lo, hi);
    const holds = all<any>(db, 'SELECT mic_id, kind, start_ms, end_ms FROM audio_holds WHERE session_id = ? AND end_ms >= ? AND start_ms <= ?', sessionId, lo, hi);
    // The final pass puts every device's times on the reference clock.
    for (const c of chunks) { const o = offs.get(c.mic_id) ?? 0; c.off = o; c.start_ms += o; c.end_ms += o; }
    for (const h of holds) { const o = h.mic_id ? offs.get(h.mic_id) ?? 0 : 0; h.start_ms += o; h.end_ms += o; }

    // Every mic's words in the window, before any hold rules. Chunks overlap (each carries a little of the one before for
    // context): a stretch of time belongs to the chunk whose middle is nearest it, so no word is counted twice.
    const raw = new Map<string, Word[]>();
    const spans = new Map<string, { s: number; e: number }[]>();
    for (const c of chunks) { const l = spans.get(c.mic_id) ?? []; l.push({ s: c.start_ms, e: c.end_ms }); spans.set(c.mic_id, l); }
    for (const c of chunks) {
      const list = raw.get(c.mic_id) ?? [];
      const mine = spans.get(c.mic_id)!;
      const edge = (x: { s: number; e: number }, t: number) => Math.min(t - x.s, x.e - t);
      for (const [w, s0, e0, p] of parseJson<[string, number, number, number][]>(c.words, [])) {
        const s = s0 + (c.off ?? 0);
        const e = e0 + (c.off ?? 0);
        const mid = (s + e) / 2;
        const own = edge({ s: c.start_ms, e: c.end_ms }, mid);
        if (mine.some((x) => (x.s !== c.start_ms || x.e !== c.end_ms) && mid >= x.s && mid <= x.e && (edge(x, mid) > own || (edge(x, mid) === own && x.s < c.start_ms)))) continue;
        list.push({ w, s, e, c: p, l: Math.max(0.02, Math.min(1, c.level)) });
      }
      raw.set(c.mic_id, list);
    }

    // Aside windows, from every source. They cover EVERY mic for their time span.
    const aside: [number, number][] = [];
    for (const h of holds) {
      const m = h.mic_id ? mics.get(h.mic_id) : undefined;
      if (h.kind === 'aside') aside.push([h.start_ms, h.end_ms]);
      else if (h.kind === 'talk' && m && (!m.players_transcript || m.aside)) aside.push([h.start_ms, h.end_ms]);
    }
    for (const [micId, words] of raw) {
      const m = mics.get(micId);
      if (!m) continue;
      // A mic marked "aside" is an aside whenever it hears speech; a GM-only mic that is hold-to-talk likewise
      // (in case its hold events never arrived).
      if (m.aside || (!m.players_transcript && m.mode === 'hold-to-talk')) for (const u of utterances(micId, words, 1000)) aside.push([u.start, u.end]);
    }

    // Speech never joins across an aside's edges: without this a mic's talk just
    // before an aside and the aside itself become one utterance, and the merge
    // splices them together (the whole line then turns GM-only).
    const cuts = [...new Set(aside.flatMap(([a, b]) => [a, b]))].sort((x, y) => x - y);

    // Per mic: apply its mode and hold windows, then split into utterances.
    const utts = [];
    for (const [micId, words] of raw) {
      const m = mics.get(micId);
      if (!m || m.mode === 'off') continue;
      const talk = holds.filter((h) => h.mic_id === micId && h.kind === 'talk');
      const mute = holds.filter((h) => h.mic_id === micId && h.kind === 'mute');
      const kept = words.filter((w) => {
        const mid = (w.s + w.e) / 2;
        if (m.mode === 'hold-to-talk' && !talk.some((h) => mid >= h.start_ms - 150 && mid <= h.end_ms + 150)) return false;
        if (mute.some((h) => mid >= h.start_ms - 100 && mid <= h.end_ms + 100)) return false;
        return true;
      });
      utts.push(...utterances(micId, kept, 700, MAX_UTTERANCE_MS).flatMap((u) => splitAt(u, cuts)));
    }

    let merged = groupUtterances(utts).map(mergeGroup).filter((l) => l.words.length);
    if (opts.final) merged = tidyLines(dedupeLines(merged), cuts);
    const lines = merged.filter((l) => l.end >= from && l.start <= to);
    // Lines already stored are looked for over what was produced, not just the chunk's own range: a line that began in an
    // earlier chunk and has grown into this one is the same line (it used to be inserted again).
    const lowest = Math.min(from, ...lines.map((l) => l.start)) - 500;
    const highest = Math.max(to, ...lines.map((l) => l.end)) + 500;
    const existing = all<LineRow>(db, 'SELECT * FROM audio_lines WHERE session_id = ? AND end_ms >= ? AND start_ms <= ? ORDER BY start_ms', sessionId, lowest, highest);
    const used = new Set<string>();
    const nm = this.nameOf(session.world_id);
    const terms = this.gmTerms(session.world_id);

    for (const l of lines) {
      // Speaker: a personal mic is credited only when it is clearly the close one; otherwise it is the table.
      const heard = Object.entries(l.stats).map(([id, st]) => ({ id, m: mics.get(id), level: st.level, conf: st.conf })).filter((x) => x.m);
      const personal = heard.filter((x) => !x.m!.room).sort((a, b) => b.level * (0.5 + b.conf) - a.level * (0.5 + a.conf));
      let speakerAccount: string | null = null;
      let speakerLabel = TABLE;
      if (personal.length) {
        const top = personal[0];
        const rest = Math.max(0, ...heard.filter((x) => x !== top).map((x) => x.level));
        if (top.level >= rest * CLOSE_RATIO) { speakerAccount = top.m!.account_id; speakerLabel = top.m!.label; }
      }

      // Audience: fail closed.
      const inAside = aside.some(([a, b]) => overlaps(l.start - ASIDE_PAD, l.end + ASIDE_PAD, a, b));
      const anyPlayersMic = l.mics.some((id) => mics.get(id)?.players_transcript === 1);
      // A GM-only title in a line that only one mic heard may be the speech model repeating something it was given: GM-only.
      const echoRisk = l.mics.length < 2 && containsTerm(l.text, terms);
      const computed: 'players' | 'gm' = !anyPlayersMic || inAside || echoRisk ? 'gm' : 'players';

      const match = this.findExisting(existing, used, l.start, l.end, l.text);
      const sources = JSON.stringify(l.mics);
      const words = JSON.stringify(l.words.map((w) => ({ w: w.w, s: w.s, e: w.e, c: Math.round(w.c * 1000) / 1000, mic: w.mic })));
      if (match) {
        used.add(match.id);
        const audience = match.audience_override ?? (keepGm && match.audience === 'gm' ? 'gm' : computed);
        if (match.text === l.text && match.start_ms === l.start && match.end_ms === l.end && match.audience === audience && match.speaker_account === speakerAccount && match.speaker_label === speakerLabel && match.sources === sources) continue;
        const next: LineRow = { ...match, start_ms: l.start, end_ms: l.end, text: l.text, words, sources, speaker_account: speakerAccount, speaker_label: speakerLabel, audience, rev: match.rev + 1, updated_at: now() };
        run(db, 'UPDATE audio_lines SET start_ms = ?, end_ms = ?, text = ?, words = ?, sources = ?, speaker_account = ?, speaker_label = ?, audience = ?, rev = ?, updated_at = ? WHERE id = ?',
          next.start_ms, next.end_ms, next.text, next.words, next.sources, next.speaker_account, next.speaker_label, next.audience, next.rev, next.updated_at, next.id);
        this.emitLine(next, match.audience, nm);
      } else {
        const row: LineRow = { id: newId('aln_'), session_id: sessionId, world_id: session.world_id, start_ms: l.start, end_ms: l.end, speaker_account: speakerAccount, speaker_label: speakerLabel, text: l.text, words, sources, audience: computed, audience_override: null, rev: 1, updated_at: now() };
        run(db, 'INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_account, speaker_label, text, words, sources, audience, audience_override, rev, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          row.id, row.session_id, row.world_id, row.start_ms, row.end_ms, row.speaker_account, row.speaker_label, row.text, row.words, row.sources, row.audience, null, row.rev, row.updated_at);
        this.emitLine(row, null, nm);
      }
    }
    // A line that nothing produces any more (a mute window arrived late) goes away.
    for (const old of existing) {
      if (used.has(old.id)) continue;
      // Only lines this merge could have produced go away (in its range, or taken over by a line that grew into them).
      const len = Math.max(1, old.end_ms - old.start_ms);
      const inRange = old.end_ms >= from && old.start_ms <= to;
      if (!inRange && !lines.some((l) => Math.min(l.end, old.end_ms) - Math.max(l.start, old.start_ms) > 0.3 * len)) continue;
      run(db, 'DELETE FROM audio_lines WHERE id = ?', old.id);
      this.emitLine({ ...old, rev: old.rev + 1 }, old.audience, nm, true);
    }
  }

  private findExisting(existing: LineRow[], used: Set<string>, start: number, end: number, text: string): LineRow | undefined {
    let best: LineRow | undefined;
    let bestScore = 0;
    const t = text.split(/\s+/).map(token).filter(Boolean);
    for (const e of existing) {
      if (used.has(e.id)) continue;
      const ov = Math.min(end, e.end_ms) - Math.max(start, e.start_ms);
      if (ov <= 0) continue;
      const frac = ov / Math.max(1, Math.min(end - start, e.end_ms - e.start_ms));
      const sim = similarity(e.text.split(/\s+/).map(token).filter(Boolean), t);
      if (frac >= 0.4 && sim >= 0.3 && frac + sim > bestScore) { best = e; bestScore = frac + sim; }
    }
    return best;
  }

  nameOf(worldId: string) {
    const m = new Map(all<any>(this.d.db, 'SELECT a.id, a.display_name, m.character_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ?', worldId).map((r) => [r.id, r.character_name || r.display_name]));
    return (accountId: string) => m.get(accountId) ?? 'Someone';
  }

  /** Live event: the GM gets every revision; a player only lines that are (or were just) theirs. */
  emitLine(l: LineRow, prevAudience: 'players' | 'gm' | null, nameOf: (id: string) => string, removed = false) {
    notifyLine(this.d, l.world_id, l.id, removed);
    this.d.hub.emitPer(l.world_id, 'transcript-line', (v) => {
      if (v.role === 'gm') return removed ? { id: l.id, rev: l.rev, removed: true, sessionId: l.session_id } : { ...lineView(l, true, nameOf) };
      if (v.role !== 'player') return null;
      if (!removed && l.audience === 'players') return lineView(l, false, nameOf);
      // It was visible and now is not (marked GM-only, or gone): tell players to drop it.
      if (prevAudience === 'players') return { id: l.id, rev: l.rev, removed: true, sessionId: l.session_id };
      return null;
    });
  }

  /** GM marks a line (or clears the mark with 'auto'). */
  setAudience(line: LineRow, to: 'players' | 'gm' | 'auto', worldId: string) {
    const override = to === 'auto' ? null : to;
    let audience: 'players' | 'gm' = override ?? line.audience;
    if (to === 'auto') audience = 'gm'; // until the next merge recomputes it: fail closed
    const next: LineRow = { ...line, audience_override: override, audience, rev: line.rev + 1, updated_at: now() };
    run(this.d.db, 'UPDATE audio_lines SET audience = ?, audience_override = ?, rev = ?, updated_at = ? WHERE id = ?', next.audience, override, next.rev, next.updated_at, next.id);
    this.emitLine(next, line.audience, this.nameOf(worldId));
    if (to === 'auto') void this.touch(line.session_id, line.start_ms, line.end_ms);
    return next;
  }

  broadcastRecording(worldId: string, on: boolean, session: { id: string; started_at: string } | null, audience: Audience = everyone) {
    this.d.hub.emit(worldId, 'recording', { on, sessionId: session?.id ?? null, startedAt: session?.started_at ?? null }, audience);
  }

  // ---- retention -----------------------------------------------------------

  /** Delete each session's audio when its own days are up (its setting, else the world's audioRetentionDays). Transcripts stay. */
  runRetention(nowMs = Date.now()): number {
    return runRecordingRetention(this.d, nowMs);
  }
}

/** ffmpeg: every chunk trimmed of the start it shares with the one before, end to end, as 16 kHz mono wav. */
function ffmpegJoin(files: { path: string; trimMs: number }[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `alx-refine-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    const inputs = files.flatMap((f) => ['-i', f.path]);
    const trims = files.map((f, i) => `[${i}:a]atrim=start=${(f.trimMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    const graph = `${trims.join(';')};${files.map((_, i) => `[a${i}]`).join('')}concat=n=${files.length}:v=0:a=1[out]`;
    execFile('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...inputs, '-filter_complex', graph, '-map', '[out]', '-ar', '16000', '-ac', '1', out], { timeout: 120_000 }, (err) => {
      let b: Buffer | null = null;
      if (!err) { try { b = fs.readFileSync(out); } catch { /* none */ } }
      try { fs.rmSync(out, { force: true }); } catch { /* gone */ }
      resolve(b);
    });
  });
}

function synth(text: string, start: number, end: number) {
  const ws = text.split(/\s+/).filter(Boolean);
  const step = (end - start) / Math.max(1, ws.length);
  return ws.map((word, i) => ({ word, start: start + i * step, end: start + (i + 1) * step, probability: undefined as number | undefined }));
}

function prune(dir: string) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) prune(path.join(dir, e.name));
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* not there */ }
}
