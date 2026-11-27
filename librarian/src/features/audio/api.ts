// Typed read access for other features (the session log uses this). Players'
// views never include GM-only lines; pass includeGm only for a GM.
import type { DB } from '../../core/db.ts';
import { all } from '../../core/db.ts';
import { names } from '../../routes/_shared.ts';
import { lineView, type LineRow } from './engine.ts';

export interface AudioSession { id: string; name: string; startedAt: string; stoppedAt: string | null; active: boolean }
export interface TranscriptLine {
  id: string; sessionId: string; start: number; end: number; speaker: string; speakerId: string | null; text: string; rev: number; updatedAt: string;
  /** Only with includeGm. */
  audience?: 'players' | 'gm'; sources?: string[]; words?: unknown[]; override?: 'players' | 'gm' | null;
}

export function listSessions(db: DB, worldId: string): AudioSession[] {
  return all<any>(db, 'SELECT * FROM audio_sessions WHERE world_id = ? ORDER BY started_at DESC', worldId)
    .map((s) => ({ id: s.id, name: s.name, startedAt: s.started_at, stoppedAt: s.stopped_at, active: !s.stopped_at }));
}

/** A session's merged lines in time order. Without includeGm only 'players' lines are returned. */
export function sessionLines(db: DB, worldId: string, sessionId: string, opts: { includeGm?: boolean } = {}): TranscriptLine[] {
  const gm = opts.includeGm === true;
  const nm = names(db, worldId);
  const rows = all<LineRow>(db, `SELECT * FROM audio_lines WHERE world_id = ? AND session_id = ? ${gm ? '' : "AND audience = 'players'"} ORDER BY start_ms, id`, worldId, sessionId);
  return rows.map((l) => lineView(l, gm, (a) => nm[a] ?? 'Someone') as TranscriptLine);
}
