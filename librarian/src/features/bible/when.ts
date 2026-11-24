// When the story bible may read in the background (every page read is a chat model call).
//   session   only while a game session runs in that world: the table chat is open or a recording is on (the default)
//   always    whenever there is something to read
//   off       never; "Read now" on the bible page still works
import { all, one } from '../../core/db.ts';
import type { DB } from '../../core/db.ts';
import { featureSetting } from '../../core/policy.ts';

export const BIBLE_RUNS = ['session', 'always', 'off'] as const;
export type BibleRuns = (typeof BIBLE_RUNS)[number];
/** A session nobody ended stops counting after this long, so a forgotten one does not keep the models busy for days. */
export const SESSION_MAX_MS = 12 * 3_600_000;

export function worldInSession(db: DB, worldId: string, at = Date.now()): boolean {
  const since = new Date(at - SESSION_MAX_MS).toISOString();
  try { if (one(db, 'SELECT 1 FROM audio_sessions WHERE world_id = ? AND stopped_at IS NULL AND started_at > ?', worldId, since)) return true; } catch { /* no audio feature */ }
  try { return !!one(db, 'SELECT 1 FROM sessionchat_sessions WHERE world_id = ? AND ended_at IS NULL AND started_at > ?', worldId, since); } catch { return false; }
}

export function bibleRuns(db: DB, worldId: string): BibleRuns {
  const row = one<{ settings: string }>(db, 'SELECT settings FROM worlds WHERE id = ?', worldId);
  return row ? (featureSetting<BibleRuns>(JSON.parse(row.settings || '{}'), 'bibleRuns') ?? 'session') : 'off';
}

export function mayRead(db: DB, worldId: string, at = Date.now()): boolean {
  const when = bibleRuns(db, worldId);
  return when === 'always' || (when === 'session' && worldInSession(db, worldId, at));
}

/** The worlds whose bible may read now. */
export const worldsToRead = (db: DB): string[] => all<{ id: string }>(db, 'SELECT id FROM worlds').map((w) => w.id).filter((id) => mayRead(db, id));
