// Minerva's tables, state and the small shared helpers (docs/MINERVA.md).
// Every table is prefixed minerva_; each row belongs to a world.
import type { Deps } from '../../app.ts';
import type { DB } from '../../core/db.ts';
import { all, one, run } from '../../core/db.ts';
import { featureSetting, type WorldSettings, DEFAULT_SETTINGS } from '../../core/policy.ts';
import { HttpError, now, parseJson } from '../../core/util.ts';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS minerva_state (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  seeded_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS minerva_arcs (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (world_id, slug)
);
-- Session logs filed into the vault: one row per published log entry.
CREATE TABLE IF NOT EXISTS minerva_sessions (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  arc_slug TEXT NOT NULL,
  rel TEXT NOT NULL,
  filed_at TEXT NOT NULL,
  PRIMARY KEY (world_id, entry_id)
);
-- What Minerva proposes (or a player's tool wrote) and the GM decides on the review page.
CREATE TABLE IF NOT EXISTS minerva_drafts (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  review TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  op TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  by_account TEXT,
  tool TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS minerva_drafts_world ON minerva_drafts(world_id, status, created_at);
CREATE TABLE IF NOT EXISTS minerva_mysteries (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  conclusion TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  arc TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (world_id, slug)
);
CREATE TABLE IF NOT EXISTS minerva_clues (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  n INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (world_id, slug, n)
);
-- Who found which clue, what they guessed, who reached the conclusion. kind: clue | theory | reached.
CREATE TABLE IF NOT EXISTS minerva_found (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  clue_n INTEGER NOT NULL DEFAULT 0,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'clue',
  text TEXT NOT NULL DEFAULT '',
  session_n INTEGER,
  at TEXT NOT NULL,
  marked_by TEXT,
  UNIQUE (world_id, slug, clue_n, account_id, kind, text)
);
CREATE INDEX IF NOT EXISTS minerva_found_player ON minerva_found(world_id, account_id);
-- Where the live suggestion pass got to in the session being recorded.
CREATE TABLE IF NOT EXISTS minerva_live (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  seen_ids TEXT NOT NULL DEFAULT '[]',
  last_at TEXT
);
`;

export const audit = (d: Deps, worldId: string, who: string | null, action: string, detail = '') =>
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, who, action, detail.slice(0, 500), now());

export interface State { enabled: boolean; seededAt: string | null }
export function stateOf(db: DB, worldId: string): State {
  const r = one<any>(db, 'SELECT enabled, seeded_at FROM minerva_state WHERE world_id = ?', worldId);
  return { enabled: r?.enabled === 1, seededAt: r?.seeded_at ?? null };
}
export function setEnabled(db: DB, worldId: string, on: boolean) {
  run(db, `INSERT INTO minerva_state (world_id, enabled, seeded_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (world_id) DO UPDATE SET enabled = excluded.enabled, seeded_at = COALESCE(minerva_state.seeded_at, excluded.seeded_at), updated_at = excluded.updated_at`, worldId, on ? 1 : 0, on ? now() : null, now());
}
export function requireEnabled(db: DB, worldId: string) {
  if (!stateOf(db, worldId).enabled) throw new HttpError(409, 'Turn Minerva on first');
}

export function worldSettings(d: Deps, worldId: string): WorldSettings {
  return { ...DEFAULT_SETTINGS, ...parseJson(one<any>(d.db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings ?? '{}', {}) };
}
/** What the GM calls the assistant (default Minerva). Only the GM side ever uses it. */
export function agentName(d: Deps, worldId: string): string {
  const v = String(featureSetting<string>(worldSettings(d, worldId), 'agentName') ?? '').trim();
  return v || 'Minerva';
}
/** Tools the GM turned auto-approve on. */
export const autoApproved = (d: Deps, worldId: string, tool: string): boolean => (featureSetting<string[]>(worldSettings(d, worldId), 'agentAutoApprove') ?? []).includes(tool);

// ---- arcs ----------------------------------------------------------------------

export interface Arc { id: string; n: number; slug: string; title: string; status: 'open' | 'closed'; openedAt: string; closedAt: string | null }
const arcOut = (r: any): Arc => ({ id: r.id, n: r.n, slug: r.slug, title: r.title, status: r.status, openedAt: r.opened_at, closedAt: r.closed_at });
export const listArcs = (db: DB, worldId: string): Arc[] => all<any>(db, 'SELECT * FROM minerva_arcs WHERE world_id = ? ORDER BY n', worldId).map(arcOut);
export const openArc = (db: DB, worldId: string): Arc | null => { const r = one<any>(db, "SELECT * FROM minerva_arcs WHERE world_id = ? AND status = 'open' ORDER BY n DESC", worldId); return r ? arcOut(r) : null; };
export function findArc(db: DB, worldId: string, ref: string): Arc | null {
  const q = String(ref ?? '').trim().toLowerCase();
  if (!q) return openArc(db, worldId);
  return listArcs(db, worldId).find((a) => a.id === ref || a.slug.toLowerCase() === q || String(a.n) === q || a.title.toLowerCase() === q || a.slug.toLowerCase().endsWith(`-${q}`)) ?? null;
}

/**
 * The session number now in progress: the one after the last session log published, or the number the table gave the
 * session being recorded (a recording named "Session 22" is session 22, whatever the log count says).
 */
export function currentSession(db: DB, worldId: string): number {
  const logged = one<any>(db, 'SELECT MAX(number) AS n FROM sessionlog_entries WHERE world_id = ?', worldId)?.n ?? 0;
  const filed = one<any>(db, 'SELECT MAX(number) AS n FROM minerva_sessions WHERE world_id = ?', worldId)?.n ?? 0;
  const next = Math.max(logged, filed) + 1;
  let named = 0;
  try {
    const rec = one<any>(db, 'SELECT name FROM audio_sessions WHERE world_id = ? ORDER BY started_at DESC LIMIT 1', worldId);
    const m = /\bsession\s+#?(\d{1,4})\b/i.exec(String(rec?.name ?? ''));
    if (m) named = Number(m[1]);
  } catch { /* no recordings */ }
  return named > Math.max(logged, filed) ? named : next;
}
