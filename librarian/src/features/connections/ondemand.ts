// Tier 3, on demand: a page that is only held at index depth is read from its
// source the moment someone opens it, the agent reads it, or a search finds
// it, and only then served. Called from the page route, the search route and
// the agent's context builder. Never throws: when the source cannot be
// reached the page is served as it is (the index line), still DM-only.
import type { Deps } from '../../app.ts';
import { one } from '../../core/db.ts';
import { ensureFull, ensureMany } from '../../intake/detail.ts';
import { ensureTierSchema, markWanted } from '../../intake/tiers.ts';

const syncDeps = (d: Deps) => ({ db: d.db, library: d.library, dataDir: d.dataDir, vaultsDir: d.vaultsDir, fetch: d.fetch, env: d.env, mcp: d.testMcp });

/** A page is being opened or read. Reads it from its source first when it is not held in full. */
export async function readOnOpen(d: Deps, worldId: string, pageRef: string): Promise<'ready' | 'fetched' | 'unavailable'> {
  try { return await ensureFull(syncDeps(d), worldId, String(pageRef)); } catch { return 'unavailable'; }
}

/** The first hits of a search (a DM's, or the agent's): read the ones held at index depth, up to `max`, so the answer is built from the page. Returns how many were read. */
export async function readSearchHits(d: Deps, worldId: string, hits: { id: string }[], max = 3): Promise<number> {
  try {
    ensureTierSchema(d.db);
    const ids = hits.slice(0, 10).map((h) => h.id);
    // Whatever was found is worth reading soon, even past the first few.
    markWanted(d.db, ids);
    const shallow = ids.filter((id) => one<any>(d.db, `SELECT 1 AS x FROM pages WHERE id = ? AND depth = 'index' AND source_id IS NOT NULL`, id));
    return shallow.length ? await ensureMany(syncDeps(d), worldId, shallow, max) : 0;
  } catch { return 0; }
}
