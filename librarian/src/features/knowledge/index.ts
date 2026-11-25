// Knowledge: where the DM sees how current everything the AI knows about the
// world is, and refreshes it all in one step (refresh.ts).
//
//   GET  /api/worlds/:world/knowledge                  (DM) status: sources, pictures, index, story bible, Minerva, the last refresh
//   POST /api/worlds/:world/knowledge/refresh  {full?}  (DM) start "Refresh world" (202), 409 when one is running
//   POST /api/worlds/:world/knowledge/refresh/stop     (DM) stop it
//   MCP  refresh_world (DM write key)
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { requireDM } from '../../core/auth.ts';
import { all, one, run } from '../../core/db.ts';
import { now } from '../../core/util.ts';
import { ctx, me } from '../../routes/_shared.ts';
import { pictureCounts } from '../../intake/records.ts';
import { bibleCoverage } from '../bible/assemble.ts';
import { crawlRunning } from '../connections/crawl.ts';
import { codexLinkStatus } from '../minerva/relink.ts';
import { bulkRunning } from '../search/bulkbuild.ts';
import { embeddingCoverage } from '../search/embeddings.ts';
import { REFRESH_KIND, REFRESH_SCHEMA, refreshRunning, refreshState, startRefresh, stopRefresh } from './refresh.ts';

const audit = (d: Deps, worldId: string, who: string | null, action: string, detail = '') => run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, who, action, detail.slice(0, 500), now());

/** Everything the Knowledge page shows, for one world. Every part fails soft: a part whose tables are missing reads as empty. */
export function knowledgeStatus(d: Deps, worldId: string) {
  const pics = new Map(pictureCounts(d.db, worldId).map((p) => [p.source_id, p]));
  const sources = all<any>(d.db, 'SELECT id, name, kind, enabled, last_sync_at, last_status FROM sources WHERE world_id = ? ORDER BY name COLLATE NOCASE', worldId).map((s) => ({
    id: s.id, name: s.name, kind: s.kind, enabled: s.enabled === 1, lastSyncAt: s.last_sync_at ?? null, lastStatus: s.last_status ?? null,
    pages: Number(one<any>(d.db, 'SELECT COUNT(*) AS n FROM pages WHERE world_id = ? AND source_id = ?', worldId, s.id)?.n ?? 0),
    pictures: pics.get(s.id) ?? { held: 0, waiting: 0, failed: 0, bytes: 0 },
  }));
  const pages = Number(one<any>(d.db, `SELECT COUNT(*) AS n FROM pages WHERE world_id = ? AND path NOT LIKE 'Minerva/%'`, worldId)?.n ?? 0);
  const soft = <T,>(f: () => T, dflt: T): T => { try { return f(); } catch { return dflt; } };
  const emb = soft(() => embeddingCoverage(d, worldId), null as ReturnType<typeof embeddingCoverage> | null);
  const bib = soft(() => bibleCoverage(d, worldId), null as ReturnType<typeof bibleCoverage> | null);
  return {
    running: refreshRunning(worldId), crawling: crawlRunning(worldId), indexing: bulkRunning(d, worldId),
    refresh: refreshState(d, worldId),
    pages, sources,
    pictures: [...pics.values()].reduce((a, p) => ({ held: a.held + p.held, waiting: a.waiting + p.waiting, failed: a.failed + p.failed, bytes: a.bytes + p.bytes }), { held: 0, waiting: 0, failed: 0, bytes: 0 }),
    embeddings: emb ? { configured: emb.configured, model: emb.model, eligible: emb.pages.eligible, indexed: emb.pages.indexed, pending: emb.pages.pending, chunks: emb.chunks } : null,
    bible: bib ? { configured: bib.configured, model: bib.model, eligible: bib.pages.eligible, indexed: bib.pages.indexed, pending: bib.pages.pending, facts: Object.values(bib.scopes).reduce((n, s) => n + s.facts, 0) } : null,
    minerva: soft(() => codexLinkStatus(d, worldId), { on: false, pages: 0, linked: 0, broken: 0 }),
  };
}

const feature: Feature = {
  id: 'knowledge',
  schema: REFRESH_SCHEMA,
  worldMount: 'knowledge',
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    r.get('/', requireDM, (_req, res) => { res.json(knowledgeStatus(d, ctx(res).world.id)); });
    r.post('/refresh', requireDM, (req, res) => {
      const w = ctx(res).world.id;
      const st = startRefresh(d, w, { by: me(res), full: req.body?.full === true });
      audit(d, w, me(res), 'world.refresh', st.id);
      res.status(202).json({ started: true, refresh: st });
    });
    r.post('/refresh/stop', requireDM, (_req, res) => { res.json({ stopped: stopRefresh(d, ctx(res).world.id) }); });
    return r;
  },
  mcpTools: [{
    name: 'refresh_world', write: true,
    description: 'Refresh everything known about the world in one job: sync every source, store their pictures, rebuild the search index and story bible, and mend Minerva\'s codex links. Runs in the background; returns at once.',
    props: { full: { type: 'boolean', description: 'A complete listing of every source (slower; also removes pages a source no longer has).' } },
    call: (a) => ({ method: 'POST', path: '/knowledge/refresh', body: { full: a?.full === true } }),
  }],
};
export { REFRESH_KIND };
export default feature;
