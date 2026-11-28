// What the GM's sharing grants, read live (nothing is copied or stored per page):
//   folder rules   everything in a folder or a whole source (pages and files, also ones added or moved in later)
//   file shares    one file, for the whole party ('*') or chosen players, whatever its page says
// Only pages and files at the GM-only level can be lifted this way. A broker or
// classified page or file, or one with a broker or classified marker, is never
// granted: every check here fails closed, and a missing table grants nothing.
import { type DB, all, one } from '../../core/db.ts';
import { normLevel } from '../../core/levels.ts';

export const SCHEMA = `
-- A rule on a folder: all pages and files in it (and below it) are shared with the party or chosen players.
-- source_id is '' for pages written in Alexandria; path is the folder names joined with '/' ('' for the whole source).
CREATE TABLE IF NOT EXISTS libshare_folders (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  path TEXT NOT NULL,
  mode TEXT NOT NULL,
  players TEXT NOT NULL DEFAULT '[]',
  by_id TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (world_id, source_id, path)
);
-- A file shared with the party ('*') or one player, whatever level its page has.
CREATE TABLE IF NOT EXISTS libshare_files (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  by_id TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (world_id, file_id, to_id)
);
CREATE INDEX IF NOT EXISTS libshare_files_to ON libshare_files (world_id, to_id);
-- "Send to players": what was sent, so players see it as new on Home and in the Library.
CREATE TABLE IF NOT EXISTS libshare_sent (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  to_ids TEXT NOT NULL,
  by_id TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS libshare_sent_world ON libshare_sent (world_id, at);
CREATE TABLE IF NOT EXISTS libshare_seen (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (world_id, account_id)
);
`;

export interface FolderRule { sourceId: string; path: string; mode: 'party' | 'players'; players: string[]; by: string | null; at: string }

const safeList = (s: unknown): string[] => { try { const v = JSON.parse(String(s)); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };

export function rulesOf(db: DB, worldId: string): FolderRule[] {
  try {
    return all<any>(db, 'SELECT source_id, path, mode, players, by_id, at FROM libshare_folders WHERE world_id = ?', worldId)
      .map((r) => ({ sourceId: r.source_id, path: r.path, mode: r.mode === 'party' ? 'party' as const : 'players' as const, players: safeList(r.players), by: r.by_id, at: r.at }));
  } catch { return []; }
}

export const folderPath = (folder: unknown): string => {
  let list: unknown = folder;
  if (typeof folder === 'string') { try { list = JSON.parse(folder || '[]'); } catch { list = []; } }
  return Array.isArray(list) ? list.map(String).join('/') : '';
};

/** Is a page (its source and folder) inside this rule's folder? A rule with no path covers its whole source. */
export const inRule = (r: FolderRule, sourceId: string | null, folder: unknown): boolean => {
  if ((sourceId ?? '') !== r.sourceId || typeof r.path !== 'string') return false;
  if (!r.path) return true;
  const p = folderPath(folder);
  return p === r.path || p.startsWith(`${r.path}/`);
};

export const ruleReaches = (r: FolderRule, accountId: string): boolean => r.mode === 'party' || r.players.includes(accountId);

/** May a grant lift this page? Only a GM-only page with no broker or classified marker. */
export const liftable = (p: { visibility?: unknown; marker_level?: unknown }): boolean =>
  normLevel(p.visibility) === 'gm' && (p.marker_level == null || p.marker_level === 'party');

const isPlayer = (db: DB, worldId: string, accountId: string) => one<any>(db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', worldId, accountId)?.role === 'player';

/** The ids of the pages one player may open through a folder rule. `only` limits the check to one page. */
export function folderLifted(db: DB, worldId: string, accountId: string, only?: string): Set<string> {
  const out = new Set<string>();
  if (!accountId) return out;
  const rules = rulesOf(db, worldId).filter((r) => ruleReaches(r, accountId));
  if (!rules.length) return out;
  try {
    if (!isPlayer(db, worldId, accountId)) return out;
    const rows = all<any>(db, `SELECT id, visibility, marker_level, folder, source_id FROM pages WHERE world_id = ? ${only ? 'AND id = ?' : ''}`, worldId, ...(only ? [only] : []));
    for (const p of rows) if (liftable(p) && rules.some((r) => inRule(r, p.source_id, p.folder))) out.add(p.id);
  } catch { /* fail closed */ }
  return out;
}

/**
 * Is this file given to this player by a share on the file or a folder rule?
 * The file must be party or GM level and its page GM-only or party: never broker or classified.
 */
export function fileGranted(db: DB, f: { id: string; world_id: string; page_id: string; level: string }, accountId: string): boolean {
  if (!accountId) return false;
  try {
    const lvl = normLevel(f.level);
    if (lvl !== 'party' && lvl !== 'gm') return false;
    const pg = one<any>(db, 'SELECT visibility, marker_level, folder, source_id FROM pages WHERE id = ? AND world_id = ?', f.page_id, f.world_id);
    if (!pg) return false;
    const pl = normLevel(pg.visibility);
    if ((pl !== 'party' && pl !== 'gm') || (pg.marker_level != null && pg.marker_level !== 'party')) return false;
    if (!isPlayer(db, f.world_id, accountId)) return false;
    if (one(db, `SELECT 1 FROM libshare_files WHERE world_id = ? AND file_id = ? AND (to_id = '*' OR to_id = ?)`, f.world_id, f.id, accountId)) return true;
    return rulesOf(db, f.world_id).some((r) => ruleReaches(r, accountId) && inRule(r, pg.source_id, pg.folder));
  } catch { return false; }
}
