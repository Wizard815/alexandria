// Who may read which semantic rows. One place for the permission model of the
// vector store (chunks), related pages and the story bible (facts).
//
// Rows are cut from one copy of a page and carry that copy's scope:
//
//   dm       the AI copy (everything but classified): the DM and every model
//   broker   the broker copy (party + broker content): the information broker
//   party    the player copy of a party-level page: every player and guest
//   lifted   the player copy of a page that is NOT party-level but that some
//            account may open as a player right now (its own per-user source
//            key, a DM grant or another player's share). The text is the same
//            for everyone who may see it; who may see it is decided live.
//
// A viewer reads `base` plus, for a player, the lifted rows of exactly the
// pages that player may open now (Library.liftedPages: access sets, shares,
// the sharer still seeing it). Nothing is ever read across scopes.
import type { Deps } from '../../app.ts';
import { type DB, all, run, tx } from '../../core/db.ts';
import type { Library } from '../../core/library.ts';
import { audienceOf, type Viewer } from '../../core/policy.ts';
import type { Scope } from '../../core/pagesearch.ts';

export type VecScope = 'dm' | 'broker' | 'party' | 'lifted';
export const VEC_SCOPES: readonly VecScope[] = ['dm', 'broker', 'party', 'lifted'];

/** Pages-table condition (alias p) under which a page has this scope's copy. `lifted` also needs the live per-account check. */
export const SCOPE_GUARD: Record<VecScope, string> = {
  dm: `p.ai_body IS NOT NULL AND p.visibility <> 'classified'`,
  broker: `p.broker_body IS NOT NULL AND p.visibility IN ('party', 'broker')`,
  party: `p.player_body IS NOT NULL AND p.visibility = 'party'`,
  lifted: `p.visibility = 'dm'`,
};
/** The pages columns the copy is cut from. */
export const SCOPE_COLS: Record<Exclude<VecScope, 'lifted'>, { body: string; props: string }> = {
  dm: { body: 'p.ai_body', props: 'p.ai_properties' },
  broker: { body: 'p.broker_body', props: 'p.broker_properties' },
  party: { body: 'p.player_body', props: 'p.player_properties' },
};

export interface Reach {
  /** The scope every viewer of this kind reads. */
  base: Exclude<VecScope, 'lifted'>;
  /** Pages this player may open although they are not party-level (read from the 'lifted' scope). */
  lifted: Set<string>;
  accountId: string;
}

/** What a library search scope reads (callers that have no viewer, only a scope: they never get lifted pages). */
export const reachOfScope = (scope: Scope): Reach => ({ base: scope === 'party' ? 'party' : scope === 'broker' ? 'broker' : 'dm', lifted: new Set(), accountId: '' });

/** The scopes a viewer reads, right now. Players add the pages their own key, a DM grant or a share lifts. */
export function reachOf(d: { library: Library }, worldId: string, v: Viewer): Reach {
  const aud = audienceOf(v);
  if (aud === 'dm' || aud === 'ai') return { base: 'dm', lifted: new Set(), accountId: v.accountId };
  if (aud === 'broker') return { base: 'broker', lifted: new Set(), accountId: v.accountId };
  // Guests and players read the party scope; only a player with an account may also read lifted pages.
  const lifted = v.role === 'player' && v.accountId ? d.library.liftedPages(worldId, v.accountId) : new Set<string>();
  return { base: 'party', lifted, accountId: v.accountId };
}

export const reachScopes = (r: Reach): VecScope[] => (r.lifted.size ? [r.base, 'lifted'] : [r.base]);

/**
 * Of these page ids, the ones this reach may open right now: the page must
 * still exist in the world and still have the copy of the base scope, or be
 * one of the lifted pages and still DM-level. Checked against the pages table,
 * so a stale row can never name a page the viewer lost.
 */
export function openable(db: DB, worldId: string, reach: Reach, ids: Iterable<string>): Set<string> {
  const list = [...new Set(ids)];
  const out = new Set<string>();
  if (!list.length) return out;
  const q = list.map(() => '?').join(',');
  for (const r of all<{ id: string }>(db, `SELECT p.id FROM pages p WHERE p.world_id = ? AND p.id IN (${q}) AND ${SCOPE_GUARD[reach.base]}`, worldId, ...list)) out.add(r.id);
  const lifted = list.filter((i) => reach.lifted.has(i) && !out.has(i));
  if (lifted.length) for (const r of all<{ id: string }>(db, `SELECT p.id FROM pages p WHERE p.world_id = ? AND p.id IN (${lifted.map(() => '?').join(',')}) AND ${SCOPE_GUARD.lifted}`, worldId, ...lifted)) out.add(r.id);
  return out;
}

/** The ids of every page some player of this world may open as a lifted page now. */
export function liftedForWorld(lib: Library, worldId: string): Set<string> {
  const out = new Set<string>();
  for (const m of all<{ account_id: string }>(lib.db, `SELECT account_id FROM members WHERE world_id = ? AND role = 'player'`, worldId)) for (const id of lib.liftedPages(worldId, m.account_id)) out.add(id);
  return out;
}

// ---- keeping the stores in step with permissions -----------------------------

/** Tables that hold rows per (page, scope): chunk rows, chunk state, bible facts, bible state. */
const STORES = ['search_chunks', 'search_chunk_state', 'bible_facts', 'bible_state'];

/** Is the row's page copy older than the page's current copy? (Same test the embedding job uses to decide what to redo.) */
const staleSql = (scope: Exclude<VecScope, 'lifted'>, st: string) => {
  const c = SCOPE_COLS[scope];
  return `(${st}.updated_at <> p.updated_at OR ${st}.sig <> length(${c.body}) + length(coalesce(${c.props}, '')))`;
};

/**
 * Delete every stored row that the page's permissions no longer allow, or that
 * was cut from text the page no longer has: rows of a scope the page has no
 * copy for (made DM-only, hidden at the source, classified, removed, no longer
 * lifted for anyone) and rows older than the copy. Synchronous and pure SQL
 * except for the lifted scope, so callers run it in the same step as the
 * change (Library.changed). Re-embedding and re-extraction happen later in
 * the background. `ids` limits the work to those pages.
 */
export function reconcile(lib: Library, worldId: string, ids?: string[]) {
  const db = lib.db;
  const only = ids?.length ? `AND x.page_id IN (${ids.map(() => '?').join(',')})` : '';
  const args = ids?.length ? ids : [];
  // Each list of pages is worked out once (an uncorrelated subquery), not again for every one of thousands of rows.
  tx(db, () => {
    for (const store of STORES) {
      const st = 'x';
      const stateLike = store === 'search_chunk_state' || store === 'bible_state';
      try {
        // Gone pages.
        run(db, `DELETE FROM ${store} AS x WHERE x.world_id = ? ${only} AND x.page_id NOT IN (SELECT p.id FROM pages p WHERE p.world_id = ?)`, worldId, ...args, worldId);
        for (const scope of ['dm', 'broker', 'party'] as const) {
          // A page without this scope's copy.
          run(db, `DELETE FROM ${store} AS x WHERE x.world_id = ? AND x.scope = ? ${only} AND x.page_id NOT IN (SELECT p.id FROM pages p WHERE ${SCOPE_GUARD[scope]})`, worldId, scope, ...args);
          // Rows cut from an older copy: the state row says which text they were made from; the chunk and fact rows follow their page's state.
          if (stateLike) run(db, `DELETE FROM ${store} AS x WHERE x.world_id = ? AND x.scope = ? ${only} AND EXISTS (SELECT 1 FROM pages p WHERE p.id = x.page_id AND ${staleSql(scope, st)})`, worldId, scope, ...args);
          else run(db, `DELETE FROM ${store} AS x WHERE x.world_id = ? AND x.scope = ? ${only} AND x.page_id NOT IN (SELECT s.page_id FROM ${store.replace(/chunks$/, 'chunk_state').replace(/facts$/, 'state')} s JOIN pages p ON p.id = s.page_id WHERE s.scope = ? AND NOT ${staleSql(scope, 's')})`, worldId, scope, ...args, scope);
        }
      } catch { /* the store's feature is not installed */ }
    }
  });
  // Lifted rows: only for pages that are still DM-level and that some player may open now.
  const lifted = new Set<string>();
  let any = false;
  for (const store of STORES) {
    try { if (all(db, `SELECT 1 FROM ${store} AS x WHERE x.world_id = ? AND x.scope = 'lifted' ${only} LIMIT 1`, worldId, ...args).length) { any = true; break; } } catch { /* not installed */ }
  }
  if (!any) return;
  for (const id of liftedForWorld(lib, worldId)) lifted.add(id);
  tx(db, () => {
    for (const store of STORES) {
      try {
        const rows = all<{ page_id: string }>(db, `SELECT DISTINCT x.page_id FROM ${store} AS x WHERE x.world_id = ? AND x.scope = 'lifted' ${only}`, worldId, ...args);
        for (const r of rows) {
          const keep = lifted.has(r.page_id) && all(db, `SELECT 1 FROM pages p WHERE p.id = ? AND ${SCOPE_GUARD.lifted}`, r.page_id).length > 0;
          if (!keep) run(db, `DELETE FROM ${store} WHERE page_id = ? AND scope = 'lifted'`, r.page_id);
        }
      } catch { /* not installed */ }
    }
  });
}

/** For code that has Deps and a world: the same, by hand (a crawl, a key revoked). */
export const reconcileWorld = (d: Deps, worldId: string, ids?: string[]) => reconcile(d.library, worldId, ids);
