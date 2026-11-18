// The text each semantic scope is cut from, and which pages still need work
// (chunks to embed, facts to extract). Shared by the embedding job and the
// story bible: both read exactly the same copy per scope.
import { createHash } from 'node:crypto';
import type { Deps } from '../../app.ts';
import { all } from '../../core/db.ts';
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
  const rows = all<any>(d.db, `SELECT p.id, p.world_id, p.title, p.updated_at, ${c.body} AS text, ${c.props} AS props, length(${c.body}) + length(coalesce(${c.props}, '')) AS sig FROM pages p
    LEFT JOIN ${stateTable} s ON s.page_id = p.id AND s.scope = ?
    WHERE ${SCOPE_GUARD[scope]} ${worldId ? 'AND p.world_id = ?' : ''}
      AND (s.page_id IS NULL OR s.updated_at <> p.updated_at OR s.model <> ? OR s.sig <> length(${c.body}) + length(coalesce(${c.props}, '')))
    ORDER BY p.updated_at DESC LIMIT ?`, scope, ...(worldId ? [worldId] : []), model, limit);
  return rows.map((r) => ({ id: r.id, world_id: r.world_id, scope, title: r.title, updated_at: r.updated_at, full: fullText(r.text, r.props), sig: Number(r.sig), hash: null }));
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
