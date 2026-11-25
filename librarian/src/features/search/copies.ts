// The text each semantic scope is cut from, and which pages still need work
// (chunks to embed, facts to extract). Shared by the embedding job and the
// story bible: both read exactly the same copy per scope.
import { createHash } from 'node:crypto';
import type { Deps } from '../../app.ts';
import { type DB, all, run } from '../../core/db.ts';
import { factsText } from '../../core/pagesearch.ts';
import { type VecScope, SCOPE_COLS, SCOPE_GUARD, liftedForWorld } from './scopes.ts';

export interface Pending {
  id: string;
  world_id: string;
  scope: VecScope;
  title: string;
  updated_at: string;
  /** The page text of this copy plus its sidebar facts, as one string (never anything above the scope's level). */
  full: string;
  sig: number;
  /** Set for the lifted scope (its text is built live, so freshness is a hash of it). */
  hash: string | null;
}

// A page the guard refused to send to a model (ClassifiedRefused), or that a model keeps failing on, is left alone for a while, longer each time,
// so the background jobs do not ask again every tick. An edit of the page (new updated_at) clears it.
// The state is kept in the database (embed_backoff) so a restart does not start asking about every such page again; `refused` is its in-memory copy.
const refused = new Map<string, { until: number; tries: number }>();
const refusedKey = (r: { id: string; scope: string; updated_at: string }) => `${r.id}|${r.scope}|${r.updated_at}`;
const BACKOFF_MS = 10 * 60_000;
let backoffDb: DB | null = null;
export const BACKOFF_SCHEMA = `
CREATE TABLE IF NOT EXISTS embed_backoff (
  page_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  tries INTEGER NOT NULL,
  until INTEGER NOT NULL,
  PRIMARY KEY (page_id, scope, updated_at)
);`;
/** Keep the backoff in this database, and read what it already holds. */
export function bindBackoff(db: DB) {
  backoffDb = db;
  try {
    db.exec(BACKOFF_SCHEMA);
    const at = Date.now();
    db.prepare('DELETE FROM embed_backoff WHERE until < ?').run(at - 24 * 3_600_000);
    for (const r of db.prepare('SELECT page_id, scope, updated_at, tries, until FROM embed_backoff').all() as any[]) refused.set(refusedKey({ id: r.page_id, scope: r.scope, updated_at: r.updated_at }), { until: Number(r.until), tries: Number(r.tries) });
  } catch { /* the table is made by the search feature */ }
}
export function noteRefused(r: { id: string; scope: string; updated_at: string }, at = Date.now()) {
  const k = refusedKey(r);
  const tries = (refused.get(k)?.tries ?? 0) + 1;
  const until = at + Math.min(BACKOFF_MS * 2 ** (tries - 1), 24 * 3_600_000);
  refused.set(k, { until, tries });
  try { backoffDb?.prepare('INSERT INTO embed_backoff (page_id, scope, updated_at, tries, until) VALUES (?, ?, ?, ?, ?) ON CONFLICT (page_id, scope, updated_at) DO UPDATE SET tries = excluded.tries, until = excluded.until').run(r.id, r.scope, r.updated_at, tries, until); } catch { /* not persisted: still held in memory */ }
  if (refused.size > 5000) for (const [key, v] of refused) if (v.until < at) refused.delete(key);
}
export const isBackedOff = (r: { id: string; scope: string; updated_at: string }, at = Date.now()): boolean => (refused.get(refusedKey(r))?.until ?? 0) > at;
export const backedOffCount = (at = Date.now()): number => { let n = 0; for (const v of refused.values()) if (v.until > at) n++; return n; };
/** Tests: forget what is held in memory (a restart), keeping what the database holds. */
export const forgetBackoffMemory = () => refused.clear();
export const forgetRefusals = () => { refused.clear(); try { backoffDb?.exec('DELETE FROM embed_backoff'); } catch { /* none */ } };

export const hashOf = (s: string) => createHash('sha1').update(s).digest('hex');
/** Body then sidebar facts, one fact per paragraph. */
export const fullText = (body: string, props: unknown) => {
  const f = factsText(props).replace(/\n/g, '\n\n');
  return f ? `${body}\n\n${f}` : body;
};

/**
 * Pages of one scope whose rows in `stateTable` are missing or older than the
 * copy (or made by another model). `world` limits to one world.
 */
export function pendingCopies(d: Deps, scope: VecScope, stateTable: 'search_chunk_state' | 'bible_state', model: string, limit: number, worldId?: string): Pending[] {
  if (scope === 'lifted') return pendingLifted(d, stateTable, model, limit, worldId);
  const c = SCOPE_COLS[scope];
  const take = Math.max(limit * 3, 100);
  // A stored state is current when it was made by this model from this text. The text is what counts, not the page's updated_at:
  // a page touched without a change (a sync that gave it a new time) is not read by the model again. Rows whose only difference is the
  // time are checked by the hash of their text, below, and their state is brought up to date without a model call.
  for (let round = 0; round < 50; round++) {
    const rows = all<any>(d.db, `SELECT p.id, p.world_id, p.title, p.updated_at, ${c.body} AS text, ${c.props} AS props, length(${c.body}) + length(coalesce(${c.props}, '')) AS sig,
        s.page_id AS st_page, s.model AS st_model, s.sig AS st_sig, s.hash AS st_hash FROM pages p
      LEFT JOIN ${stateTable} s ON s.page_id = p.id AND s.scope = ?
      WHERE ${SCOPE_GUARD[scope]} ${worldId ? 'AND p.world_id = ?' : ''}
        AND (s.page_id IS NULL OR s.updated_at <> p.updated_at OR s.model <> ? OR s.sig <> length(${c.body}) + length(coalesce(${c.props}, '')))
      ORDER BY p.updated_at DESC LIMIT ?`, scope, ...(worldId ? [worldId] : []), model, take);
    const out: Pending[] = [];
    for (const r of rows) {
      const full = fullText(r.text, r.props);
      const hash = hashOf(full);
      if (r.st_page && r.st_model === model && Number(r.st_sig) === Number(r.sig) && r.st_hash === hash) {
        run(d.db, `UPDATE ${stateTable} SET updated_at = ? WHERE page_id = ? AND scope = ?`, r.updated_at, r.id, scope);
        continue;
      }
      out.push({ id: r.id, world_id: r.world_id, scope, title: r.title, updated_at: r.updated_at, full, sig: Number(r.sig), hash });
    }
    if (out.length || rows.length < take) return out.slice(0, limit);
  }
  return [];
}

function pendingLifted(d: Deps, stateTable: string, model: string, limit: number, worldId?: string): Pending[] {
  const out: Pending[] = [];
  const worlds = worldId ? [worldId] : all<{ id: string }>(d.db, 'SELECT id FROM worlds').map((w) => w.id);
  for (const w of worlds) {
    for (const id of liftedForWorld(d.library, w)) {
      if (out.length >= limit) return out;
      if (!all(d.db, `SELECT 1 FROM pages p WHERE p.id = ? AND ${SCOPE_GUARD.lifted}`, id).length) continue;
      const c = d.library.liftedCopy(w, id);
      if (!c) continue;
      const full = fullText(c.body, c.props);
      const hash = hashOf(full);
      const st = all<any>(d.db, `SELECT hash, model FROM ${stateTable} WHERE page_id = ? AND scope = 'lifted'`, id)[0];
      if (st && st.hash === hash && st.model === model) continue;
      out.push({ id, world_id: w, scope: 'lifted', title: c.title, updated_at: c.updatedAt, full, sig: full.length, hash });
    }
  }
  return out;
}

/** How many pages of a scope exist for a world (the lifted scope: pages some player may open now). */
export function eligibleCount(d: Deps, scope: VecScope, worldId: string): number {
  if (scope === 'lifted') return [...liftedForWorld(d.library, worldId)].filter((id) => all(d.db, `SELECT 1 FROM pages p WHERE p.id = ? AND ${SCOPE_GUARD.lifted}`, id).length).length;
  return Number(all<any>(d.db, `SELECT count(*) AS n FROM pages p WHERE p.world_id = ? AND ${SCOPE_GUARD[scope]}`, worldId)[0]?.n ?? 0);
}

/** The ids of the pages of a scope (see eligibleCount). */
export function eligibleIds(d: Deps, scope: VecScope, worldId: string): string[] {
  if (scope === 'lifted') return [...liftedForWorld(d.library, worldId)].filter((id) => all(d.db, `SELECT 1 FROM pages p WHERE p.id = ? AND ${SCOPE_GUARD.lifted}`, id).length);
  return all<any>(d.db, `SELECT p.id AS id FROM pages p WHERE p.world_id = ? AND ${SCOPE_GUARD[scope]}`, worldId).map((r) => String(r.id));
}

/** Is the page still exactly what `r` was cut from (same copy, same level)? Checked right before rows are written, with no await in between. */
export function isCurrent(d: Deps, r: Pending): boolean {
  if (r.scope === 'lifted') {
    if (!liftedForWorld(d.library, r.world_id).has(r.id) || !all(d.db, `SELECT 1 FROM pages p WHERE p.id = ? AND ${SCOPE_GUARD.lifted}`, r.id).length) return false;
    const c = d.library.liftedCopy(r.world_id, r.id);
    return !!c && hashOf(fullText(c.body, c.props)) === r.hash;
  }
  const c = SCOPE_COLS[r.scope];
  return all(d.db, `SELECT 1 FROM pages p WHERE p.id = ? AND p.world_id = ? AND ${SCOPE_GUARD[r.scope]} AND p.updated_at = ? AND length(${c.body}) + length(coalesce(${c.props}, '')) = ?`, r.id, r.world_id, r.updated_at, r.sig).length > 0;
}
