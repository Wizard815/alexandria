// The audio pipeline: chunk -> speech to text -> per-mic words -> merged
// lines with an audience. Everything that decides who may read a line is in
// flush(): it fails closed (a line is DM-only unless every rule lets
// players have it).
import fs from 'node:fs';
import path from 'node:path';
import type { Deps } from '../../app.ts';
import { ModelUnavailable, transcribe } from '../../core/ai.ts';
import { all, one, run } from '../../core/db.ts';
import { everyone, type Audience } from '../../core/events.ts';
import { DEFAULT_SETTINGS, featureSetting } from '../../core/policy.ts';
import { id as newId, now, parseJson } from '../../core/util.ts';
import { groupUtterances, mergeGroup, similarity, token, utterances, type Word } from './merge.ts';

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
  audience TEXT NOT NULL DEFAULT 'dm',
  audience_override TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audio_lines_session ON audio_lines (session_id, start_ms);
`;

export const DEFAULT_CONSENT_TEXT = 'This session is recorded and turned into a text transcript so everyone can follow it. Your microphone is only used while a session is recording, and only if you turn it on. You can withdraw your consent at any time.';

export type Mode = 'always' | 'hold-to-talk' | 'hold-to-mute' | 'off';
export const MODES: readonly Mode[] = ['always', 'hold-to-talk', 'hold-to-mute', 'off'];
export const HOLD_KINDS = ['talk', 'mute', 'aside'] as const;

export interface MicRow { id: string; world_id: string; account_id: string; device_id: string; label: string; mode: Mode; players_transcript: number; aside: number; room: number; created_at: string }
export interface LineRow {
  id: string; session_id: string; world_id: string; start_ms: number; end_ms: number; speaker_account: string | null; speaker_label: string;
  text: string; words: string; sources: string; audience: 'players' | 'dm'; audience_override: 'players' | 'dm' | null; rev: number; updated_at: string;
}

const ASIDE_PAD = 250;

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
const CONTEXT = 20_000;
const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && a1 > b0;

/** What each kind of viewer is sent for a line. Players never get sources, words or the audience field. */
export function lineView(l: LineRow, dm: boolean, nameOf: (accountId: string) => string) {
  const speaker = l.speaker_account ? nameOf(l.speaker_account) : l.speaker_label;
  const base = { id: l.id, sessionId: l.session_id, start: l.start_ms, end: l.end_ms, speaker, speakerId: l.speaker_account, text: l.text, rev: l.rev, updatedAt: l.updated_at };
  if (!dm) return base;
  return { ...base, audience: l.audience, override: l.audience_override, sources: parseJson<string[]>(l.sources, []), words: parseJson<unknown[]>(l.words, []) };
}

const engines = new WeakMap<object, Engine>();
export const engine = (d: Deps): Engine => { let e = engines.get(d.db); if (!e) { e = new Engine(d); engines.set(d.db, e); } return e; };

export class Engine {
  d: Deps;
  private dirty = new Map<string, { from: number; to: number; timer?: ReturnType<typeof setTimeout> }>();
  private inflight = new Set<string>();
  private hints = new Map<string, { at: number; text: string }>();

  constructor(d: Deps) { this.d = d; }

  get delay() { const n = Number(this.d.env.ALX_AUDIO_MERGE_MS ?? 5000); return Number.isFinite(n) && n >= 0 ? n : 5000; }

  // ---- hints for the speech model --------------------------------------

  /** Library titles and aliases (the DM sees everything) and, when the modules feature is there, its term names. */
  hint(worldId: string): string {
    const c = this.hints.get(worldId);
    if (c && Date.now() - c.at < 60_000) return c.text;
    const names = new Set<string>();
    try {
      for (const p of all<any>(this.d.db, "SELECT title, frontmatter FROM pages WHERE world_id = ? AND visibility <> 'classified' ORDER BY updated_at DESC LIMIT 400", worldId)) {
        if (p.title && p.title.length <= 40) names.add(p.title);
        const al = parseJson<any>(p.frontmatter, {}).aliases;
        for (const a of Array.isArray(al) ? al : typeof al === 'string' ? [al] : []) if (typeof a === 'string' && a.length <= 40) names.add(a);
      }
    } catch { /* no pages table yet */ }
    try {
      const tables = all<any>(this.d.db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'modules\\_%' ESCAPE '\\'");
      for (const t of tables) {
        if (!/^[a-z0-9_]+$/.test(t.name)) continue;
        const cols = all<any>(this.d.db, `PRAGMA table_info(${t.name})`).map((x) => x.name);
        const col = ['term', 'name', 'title'].find((x) => cols.includes(x));
        if (!col) continue;
        const hasWorld = cols.includes('world_id');
        try {
          for (const r of all<any>(this.d.db, `SELECT DISTINCT ${col} AS n FROM ${t.name} ${hasWorld ? 'WHERE world_id = ?' : ''} LIMIT 300`, ...(hasWorld ? [worldId] : []))) {
            if (typeof r.n === 'string' && r.n.length <= 40) names.add(r.n);
          }
        } catch { /* a different shape: skip it */ }
      }
    } catch { /* modules feature not present */ }
    let text = '';
    for (const n of [...names].sort((a, b) => a.length - b.length)) {
      if ((text + n).length > 800) break;
      text += (text ? ', ' : 'Names and terms: ') + n;
    }
    this.hints.set(worldId, { at: Date.now(), text });
    return text;
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
      let t;
      try {
        t = await transcribe(this.d, bytes, ch.mime, { prompt: this.hint(ch.world_id) });
      } catch (err) {
        if (!(err instanceof ModelUnavailable)) console.error('audio: transcription failed', err);
        const attempts = ch.attempts + 1;
        run(this.d.db, 'UPDATE audio_chunks SET status = ?, attempts = ? WHERE id = ?', attempts >= 60 ? 'failed' : 'pending', attempts, chunkId);
        return 'pending';
      }
      const words: [string, number, number, number][] = [];
      for (const seg of t.segments) {
        if ((seg.noSpeechProb ?? 0) > 0.8) continue;
        const segConf = seg.avgLogprob !== undefined ? Math.exp(seg.avgLogprob) : 0.6;
        const ws = seg.words?.length ? seg.words : synth(seg.text, seg.start, seg.end);
        for (const w of ws) {
          if (!token(w.word)) continue;
          const conf = Math.min(1, Math.max(0, w.probability ?? segConf));
          words.push([w.word.trim(), Math.round(ch.start_ms + w.start * 1000), Math.round(ch.start_ms + Math.max(w.end, w.start + 0.05) * 1000), Math.round(conf * 1000) / 1000]);
        }
      }
      run(this.d.db, "UPDATE audio_chunks SET status = 'done', words = ?, attempts = attempts + 1 WHERE id = ?", JSON.stringify(words), chunkId);
      await this.touch(ch.session_id, ch.start_ms, ch.end_ms);
      return 'done';
    } finally { this.inflight.delete(chunkId); }
  }

  async retryPending(limit = 25): Promise<number> {
    const rows = all<any>(this.d.db, "SELECT id FROM audio_chunks WHERE status = 'pending' AND file IS NOT NULL ORDER BY created_at LIMIT ?", limit);
    let n = 0;
    for (const r of rows) if ((await this.process(r.id)) === 'done') n++;
    return n;
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

  private merge(sessionId: string, from: number, to: number) {
    const { db } = this.d;
    const session = one<any>(db, 'SELECT * FROM audio_sessions WHERE id = ?', sessionId);
    if (!session) return;
    const lo = from - CONTEXT;
    const hi = to + CONTEXT;
    const mics = new Map(all<MicRow>(db, 'SELECT * FROM audio_mics WHERE world_id = ?', session.world_id).map((m) => [m.id, m]));
    const roles = new Map(all<any>(db, 'SELECT account_id, role FROM members WHERE world_id = ?', session.world_id).map((m) => [m.account_id, m.role as string]));
    const chunks = all<any>(db, "SELECT mic_id, level, words FROM audio_chunks WHERE session_id = ? AND status = 'done' AND end_ms >= ? AND start_ms <= ?", sessionId, lo, hi);
    const holds = all<any>(db, 'SELECT mic_id, kind, start_ms, end_ms FROM audio_holds WHERE session_id = ? AND end_ms >= ? AND start_ms <= ?', sessionId, lo, hi);

    // Every mic's words in the window, before any hold rules.
    const raw = new Map<string, Word[]>();
    for (const c of chunks) {
      const list = raw.get(c.mic_id) ?? [];
      for (const [w, s, e, p] of parseJson<[string, number, number, number][]>(c.words, [])) list.push({ w, s, e, c: p, l: Math.max(0.02, Math.min(1, c.level)) });
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
      // A mic marked "aside" is an aside whenever it hears speech; a DM-only mic that is hold-to-talk likewise
      // (in case its hold events never arrived).
      if (m.aside || (!m.players_transcript && m.mode === 'hold-to-talk')) for (const u of utterances(micId, words, 1000)) aside.push([u.start, u.end]);
    }

    // Speech never joins across an aside's edges: without this a mic's talk just
    // before an aside and the aside itself become one utterance, and the merge
    // splices them together (the whole line then turns DM-only).
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
      utts.push(...utterances(micId, kept).flatMap((u) => splitAt(u, cuts)));
    }

    const lines = groupUtterances(utts).map(mergeGroup).filter((l) => l.words.length && l.end >= from && l.start <= to);
    const existing = all<LineRow>(db, 'SELECT * FROM audio_lines WHERE session_id = ? AND end_ms >= ? AND start_ms <= ? ORDER BY start_ms', sessionId, from, to);
    const used = new Set<string>();
    const nm = this.nameOf(session.world_id);

    for (const l of lines) {
      // Speaker: the strongest close signal. A player's own mic beats a room mic for that player's voice.
      let best = ''; let bestScore = -1;
      for (const [micId, st] of Object.entries(l.stats)) {
        const m = mics.get(micId);
        const own = m && !m.room && roles.get(m.account_id) === 'player' ? 1.5 : 1;
        const sc = st.level * (0.5 + st.conf) * own;
        if (sc > bestScore) { best = micId; bestScore = sc; }
      }
      const bm = mics.get(best);
      const personal = !!bm && !bm.room;
      const speakerAccount = personal ? bm!.account_id : null;
      const speakerLabel = bm?.label ?? '';

      // Audience: fail closed.
      const inAside = aside.some(([a, b]) => overlaps(l.start - ASIDE_PAD, l.end + ASIDE_PAD, a, b));
      const anyPlayersMic = l.mics.some((id) => mics.get(id)?.players_transcript === 1);
      const computed: 'players' | 'dm' = !anyPlayersMic || inAside ? 'dm' : 'players';

      const match = this.findExisting(existing, used, l.start, l.end, l.text);
      const sources = JSON.stringify(l.mics);
      const words = JSON.stringify(l.words.map((w) => ({ w: w.w, s: w.s, e: w.e, c: Math.round(w.c * 1000) / 1000, mic: w.mic })));
      if (match) {
        used.add(match.id);
        const audience = match.audience_override ?? computed;
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

  /** Live event: the DM gets every revision; a player only lines that are (or were just) theirs. */
  emitLine(l: LineRow, prevAudience: 'players' | 'dm' | null, nameOf: (id: string) => string, removed = false) {
    this.d.hub.emitPer(l.world_id, 'transcript-line', (v) => {
      if (v.role === 'dm') return removed ? { id: l.id, rev: l.rev, removed: true, sessionId: l.session_id } : { ...lineView(l, true, nameOf) };
      if (v.role !== 'player') return null;
      if (!removed && l.audience === 'players') return lineView(l, false, nameOf);
      // It was visible and now is not (marked DM-only, or gone): tell players to drop it.
      if (prevAudience === 'players') return { id: l.id, rev: l.rev, removed: true, sessionId: l.session_id };
      return null;
    });
  }

  /** DM marks a line (or clears the mark with 'auto'). */
  setAudience(line: LineRow, to: 'players' | 'dm' | 'auto', worldId: string) {
    const override = to === 'auto' ? null : to;
    let audience: 'players' | 'dm' = override ?? line.audience;
    if (to === 'auto') audience = 'dm'; // until the next merge recomputes it: fail closed
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

  /** Delete raw audio older than each world's audioRetentionDays. Transcripts stay. */
  runRetention(nowMs = Date.now()): number {
    const { db, dataDir } = this.d;
    if (!dataDir) return 0;
    let n = 0;
    for (const w of all<any>(db, 'SELECT id, settings FROM worlds')) {
      const s = { ...DEFAULT_SETTINGS, ...parseJson<any>(w.settings, {}) };
      const days = featureSetting<number | null>(s, 'audioRetentionDays');
      if (!days) continue;
      const cutoff = new Date(nowMs - days * 864e5).toISOString();
      const rows = all<any>(db, 'SELECT c.id, c.file, c.status FROM audio_chunks c JOIN audio_sessions s ON s.id = c.session_id WHERE s.world_id = ? AND c.file IS NOT NULL AND c.created_at < ?', w.id, cutoff);
      for (const r of rows) {
        try { fs.rmSync(path.join(dataDir, r.file), { force: true }); } catch { /* already gone */ }
        run(db, 'UPDATE audio_chunks SET file = NULL, status = ? WHERE id = ?', r.status === 'pending' ? 'expired' : r.status, r.id);
        n++;
      }
      if (rows.length) prune(path.join(dataDir, 'audio', w.id));
    }
    return n;
  }
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
