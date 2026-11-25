// The running summary of a recording session: what has happened so far, what is happening right now, and the open
// threads, kept up to date while the table plays. A model with a small window can then follow a four-hour night
// (it gets the summary and the last few lines, not the whole transcript), the session log has notes to start from,
// and a player's assistant can say what happened tonight.
//
// Two summaries per session, never mixed:
//   dm     from every line the DM can read (asides included). DM only.
//   party  from the lines players can read, nothing else. What a player's assistant is given.
// A line holding classified content is left out before anything is sent to a model. The summary is folded forward:
// the model gets the summary so far and the lines that came in since, and returns the new summary.
import type { Deps } from '../../app.ts';
import { chat, hasJob, ModelUnavailable, withPriority, wouldBeRefused } from '../../core/ai.ts';
import { all, one, run } from '../../core/db.ts';
import { now } from '../../core/util.ts';
import { listSessions, sessionLines, type TranscriptLine } from './api.ts';

export const SUMMARY_SCHEMA = `
CREATE TABLE IF NOT EXISTS audio_summaries (
  session_id TEXT NOT NULL REFERENCES audio_sessions(id) ON DELETE CASCADE,
  audience TEXT NOT NULL CHECK (audience IN ('dm', 'party')),
  world_id TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  upto TEXT NOT NULL DEFAULT '',
  lines INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, audience)
);`;

/** Fold in new lines once this many have come in... */
export const SUMMARY_LINES = 25;
/** ...or once this long has passed with anything new. */
export const SUMMARY_EVERY_MS = 4 * 60_000;
/** Lines sent in one model call; a long backlog is folded in several steps, oldest first. */
const STEP_LINES = 120;
const STEP_CHARS = 14_000;
const MAX_WORDS = 350;

export type Audience = 'dm' | 'party';
export interface SessionSummary { sessionId: string; audience: Audience; text: string; lines: number; updatedAt: string | null }

const busy = new Set<string>();

export function getSummary(d: Deps, sessionId: string, audience: Audience): SessionSummary {
  const r = one<any>(d.db, 'SELECT * FROM audio_summaries WHERE session_id = ? AND audience = ?', sessionId, audience);
  return { sessionId, audience, text: r?.text ?? '', lines: r?.lines ?? 0, updatedAt: r?.updated_at ?? null };
}

/** The summary of the latest session (recording, or ended in the last 12 hours), for the assistant's context. */
export function latestSummary(d: Deps, worldId: string, audience: Audience): (SessionSummary & { name: string; active: boolean }) | null {
  const s = listSessions(d.db, worldId)[0];
  if (!s) return null;
  if (!s.active && s.stoppedAt && Date.now() - Date.parse(s.stoppedAt) > 12 * 3600_000) return null;
  const sum = getSummary(d, s.id, audience);
  return sum.text ? { ...sum, name: s.name, active: s.active } : null;
}

const lineText = (l: TranscriptLine) => `${l.speaker || 'Someone'}: ${l.text}`;

function system(audience: Audience): string {
  return [
    'You keep the running summary of a tabletop RPG game session from its transcript.',
    'You get the summary so far and the transcript lines that came in since. Return the whole updated summary.',
    `Markdown, at most ${MAX_WORDS} words, these three sections and nothing else:`,
    '**So far**: short bullets in order: what happened, decisions, people met, places, items and coin found, fights and how they ended. Merge and shorten older bullets as the night goes on.',
    '**Right now**: one or two sentences: the scene, where the party is, what is going on.',
    '**Open threads**: bullets: questions, plans, promises, unfinished business.',
    'Facts only from the summary and the lines: never invent names, numbers or events. Keep names as they were spoken. Table talk that is not the game (food, jokes, real life) is left out.',
    audience === 'party' ? 'This summary is for the players: only what they said, heard and saw.' : 'This summary is for the Dungeon Master.',
  ].join('\n');
}

/**
 * Bring one session's summary up to date for one audience. `force` folds in whatever is new now (the session ended,
 * or someone asked); otherwise only when enough has come in. Never throws for a model problem.
 */
export async function updateSummary(d: Deps, worldId: string, sessionId: string, audience: Audience, opts: { force?: boolean; at?: number } = {}): Promise<{ ran: boolean; reason?: string; lines: number }> {
  if (!hasJob(d, 'chat')) return { ran: false, reason: 'No chat model', lines: 0 };
  const key = `${sessionId}|${audience}`;
  if (busy.has(key)) return { ran: false, reason: 'Already running', lines: 0 };
  busy.add(key);
  try {
    const cur = one<any>(d.db, 'SELECT * FROM audio_summaries WHERE session_id = ? AND audience = ?', sessionId, audience);
    const upto: string = cur?.upto ?? '';
    // The same test the outgoing screen uses (any classified page, by shared word runs), so a line that would make the
    // whole request refused is left out instead and the summary still runs.
    const secret = (t: string) => d.library.containsClassified(worldId, t) || wouldBeRefused(d, t);
    const lines = sessionLines(d.db, worldId, sessionId, { includeDm: audience === 'dm' });
    // Newer than the summary first, then the secret test: the whole night is not tested again on every pass.
    const fresh = lines.filter((l) => l.updatedAt > upto && !secret(l.text)).sort((a, b) => a.start - b.start);
    if (!fresh.length) return { ran: false, reason: 'Nothing new', lines: 0 };
    // The first summary waits like the rest: from the start of the session.
    const since = cur?.updated_at ?? one<any>(d.db, 'SELECT started_at FROM audio_sessions WHERE id = ?', sessionId)?.started_at;
    const ago = since ? (opts.at ?? Date.now()) - Date.parse(since) : Infinity;
    if (!opts.force && fresh.length < SUMMARY_LINES && ago < SUMMARY_EVERY_MS) return { ran: false, reason: 'Too soon', lines: fresh.length };
    let text: string = cur?.text ?? '';
    let done = 0;
    let newest = upto;
    // Oldest first, in steps: the summary carries everything before each step.
    for (let i = 0; i < fresh.length;) {
      const step: TranscriptLine[] = [];
      let chars = 0;
      while (i < fresh.length && step.length < STEP_LINES && chars < STEP_CHARS) { step.push(fresh[i]); chars += fresh[i].text.length + 20; i++; }
      let out = '';
      try {
        const r = await withPriority(0, () => chat(d, 'chat', { messages: [{ role: 'system', content: system(audience) }, { role: 'user', content: `Summary so far:\n${text || '(nothing yet: the session just started)'}\n\nNew transcript lines (oldest first):\n${step.map(lineText).join('\n')}` }], maxTokens: 900, temperature: 0.2 }));
        out = r.content.trim().replace(/^```(?:markdown)?\s*|```$/g, '').trim();
      } catch (e) {
        if (!(e instanceof ModelUnavailable)) console.error('audio: session summary failed', (e as any)?.message ?? e);
        break;
      }
      if (!out) break;
      text = out.slice(0, 6000);
      done += step.length;
      for (const l of step) if (l.updatedAt > newest) newest = l.updatedAt;
    }
    if (!done) return { ran: false, reason: 'The model gave nothing', lines: 0 };
    run(d.db, `INSERT INTO audio_summaries (session_id, audience, world_id, text, upto, lines, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, audience) DO UPDATE SET text = excluded.text, upto = excluded.upto, lines = audio_summaries.lines + ?, updated_at = excluded.updated_at`,
      sessionId, audience, worldId, text, newest, done, now(), done);
    d.hub.emit(worldId, 'audio-summary', { sessionId, audience }, (v) => audience === 'party' || v.role === 'dm');
    return { ran: true, lines: done };
  } finally { busy.delete(key); }
}

/** Both summaries of one session. */
export async function updateBoth(d: Deps, worldId: string, sessionId: string, opts: { force?: boolean } = {}) {
  const dm = await updateSummary(d, worldId, sessionId, 'dm', opts);
  const party = await updateSummary(d, worldId, sessionId, 'party', opts);
  return { dm, party };
}

/**
 * A session left open (the app closed, the machine slept, the server restarted mid-session) keeps the summary, the rules check and the
 * live passes working for nobody, forever. One with no line and no audio for this long is closed, at the time of its last activity,
 * and the audit says so. ALX_AUDIO_STALE_MIN sets the minutes (30; 0 turns it off).
 */
export function closeStaleSessions(d: Deps, at = Date.now()): { sessionId: string; worldId: string; stoppedAt: string }[] {
  const mins = Number(d.env?.ALX_AUDIO_STALE_MIN ?? 30);
  if (!(mins > 0)) return [];
  const out: { sessionId: string; worldId: string; stoppedAt: string }[] = [];
  for (const s of all<any>(d.db, `SELECT s.id, s.world_id, s.started_at,
      max(coalesce((SELECT max(updated_at) FROM audio_lines WHERE session_id = s.id), ''), coalesce((SELECT max(created_at) FROM audio_chunks WHERE session_id = s.id), ''), s.started_at) AS last
    FROM audio_sessions s WHERE s.stopped_at IS NULL`)) {
    if (at - Date.parse(s.last) < mins * 60_000) continue;
    run(d.db, 'UPDATE audio_sessions SET stopped_at = ? WHERE id = ? AND stopped_at IS NULL', s.last, s.id);
    run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', s.world_id, null, 'audio.auto_close', `Session ${s.id} had no activity for ${mins} minutes and was closed at ${s.last}`, new Date(at).toISOString());
    d.hub.emit(String(s.world_id), 'audio-closed', { sessionId: s.id, at: s.last, reason: 'idle' }, (v) => v.role === 'dm');
    out.push({ sessionId: String(s.id), worldId: String(s.world_id), stoppedAt: String(s.last) });
  }
  return out;
}

/** Sessions recording now: the scheduler's list (a session that has been silent too long is closed first). */
export function recordingSessions(d: Deps): { worldId: string; sessionId: string }[] {
  try { closeStaleSessions(d); } catch { /* the list below is still right */ }
  return all<any>(d.db, 'SELECT id, world_id FROM audio_sessions WHERE stopped_at IS NULL').map((r) => ({ worldId: String(r.world_id), sessionId: String(r.id) }));
}
