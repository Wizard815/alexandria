// Search across the world (library pages, people, game module terms,
// transcript lines, session log entries, items) and, when an embeddings model
// is set, semantic search over page chunks merged with keyword search.
//
//   GET  /api/worlds/:world/search?q=&kinds=&limit=&semantic=
//   GET  /api/worlds/:world/search/status        (embedding progress)
//   POST /api/worlds/:world/search/reindex       (DM: embed what is stale now)
//   MCP  search_world
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { requireDM } from '../../core/auth.ts';
import { hasJob } from '../../core/ai.ts';
import { HttpError, int } from '../../core/util.ts';
import { ctx } from '../../routes/_shared.ts';
import { KINDS, globalSearch, parseKinds } from './global.ts';
import { SCHEMA, embeddingCoverage, migrateSearch, syncEmbeddings } from './embeddings.ts';
import { vectorStore } from './vectorstore.ts';
import { jobConfig } from '../../core/ai.ts';
import { all, run } from '../../core/db.ts';
import { bibleCoverage } from '../bible/assemble.ts';

const feature: Feature = {
  id: 'search',
  schema: SCHEMA,
  migrate: migrateSearch,
  worldMount: 'search',
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });

    r.get('/', async (req, res) => {
      const c = ctx(res);
      const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
      const kinds = parseKinds(req.query.kinds);
      if (!kinds.length) throw new HttpError(400, `kinds must be a comma separated list of: ${KINDS.join(', ')}`);
      const limit = int(req.query.limit, 'limit', { min: 1, max: 100, optional: true }) ?? 40;
      const results = await globalSearch(d, c.world.id, c.viewer, q, { kinds, limit, semantic: req.query.semantic !== '0' });
      res.json({ query: q, results });
    });

    r.get('/status', (_req, res) => {
      const c = ctx(res);
      const semantic = hasJob(d, 'extra');
      res.json({ semantic, ...(c.viewer.role === 'dm' ? embeddingCoverage(d, c.world.id) : {}) });
    });

    r.post('/reindex', requireDM, async (_req, res) => {
      res.json(await syncEmbeddings(d, { maxPages: 200 }));
    });

    // DM: drop every vector of this world and read it all again in the background (the next ticks, or Library > pull all).
    r.post('/reembed', requireDM, async (_req, res) => {
      const c = ctx(res);
      vectorStore(d.db).deleteWorld(c.world.id);
      d.library.changed(c.world.id);
      res.json({ ok: true, ...embeddingCoverage(d, c.world.id) });
    });

    return r;
  },

  // Admin > Models: the embeddings job and how much of each world it has read, per scope; re-embed one world.
  adminMount: 'embeddings',
  adminRoutes: (d: Deps) => {
    const r = Router();
    const worldRow = (id: string) => { const w = all<any>(d.db, 'SELECT id, name FROM worlds WHERE id = ?', id)[0]; if (!w) throw new HttpError(404, 'World not found'); return w; };
    r.get('/', (_req, res) => {
      const cfg = jobConfig(d, 'extra');
      res.json({
        configured: !!cfg, model: cfg?.model ?? null, location: cfg?.location ?? null, chat: hasJob(d, 'chat'),
        worlds: all<any>(d.db, 'SELECT id, name FROM worlds ORDER BY name').map((w) => ({ id: w.id, name: w.name, embeddings: embeddingCoverage(d, w.id), bible: bibleCoverage(d, w.id) })),
      });
    });
    r.post('/:world/reembed', (req, res) => {
      const w = worldRow(String(req.params.world));
      vectorStore(d.db).deleteWorld(w.id);
      run(d.db, 'DELETE FROM bible_facts WHERE world_id = ?', w.id);
      run(d.db, 'DELETE FROM bible_state WHERE world_id = ?', w.id);
      d.library.changed(w.id);
      res.json({ ok: true, embeddings: embeddingCoverage(d, w.id), bible: bibleCoverage(d, w.id) });
    });
    r.post('/:world/run', async (req, res) => {
      const w = worldRow(String(req.params.world));
      const sync = await syncEmbeddings(d, { maxPages: 200, worldId: w.id });
      res.json({ ok: true, sync, embeddings: embeddingCoverage(d, w.id), bible: bibleCoverage(d, w.id) });
    });
    return r;
  },

  mcpTools: [
    {
      name: 'related_pages',
      description: 'Pages that read like a given library page, each with a similarity percent and the passage that matched. Only pages you may open, and the percent comes from your own copy of both pages. Empty when the page has not been read by the embeddings model yet.',
      props: { page: { type: 'string', description: 'The page id or path' }, limit: { type: 'number', description: 'How many (default 8, at most 50)' } },
      required: ['page'],
      call: (a) => ({ method: 'GET', path: `/library/pages/${encodeURIComponent(String(a.page ?? ''))}/related?limit=${encodeURIComponent(String(a.limit ?? 8))}` }),
    },
    {
      name: 'search_world',
      description: 'Search everything in the world you can see in one ranked list: library pages, people, game rules and terms, session transcript lines, session log entries and items. Each result has a kind, title, snippet, link and score. Quote "exact phrases" and use -word to exclude.',
      props: {
        query: { type: 'string', description: 'Words to search for' },
        kinds: { type: 'string', description: 'Optional comma separated filter: page, person, term, transcript, log, item' },
        limit: { type: 'number', description: 'How many results (default 20, at most 100)' },
      },
      required: ['query'],
      call: (a) => ({ method: 'GET', path: `/search?q=${encodeURIComponent(String(a.query ?? ''))}&limit=${encodeURIComponent(String(a.limit ?? 20))}${a.kinds ? `&kinds=${encodeURIComponent(String(a.kinds))}` : ''}` }),
    },
  ],

  // Keep page embeddings current after saves and syncs. Does nothing without an embeddings model.
  start: (d: Deps) => {
    const every = Math.max(1000, Number(d.env.ALX_SEARCH_EMBED_MS ?? 20_000) || 20_000);
    let busy = false;
    // A model that fails is not asked again every tick: the wait doubles up to half an hour, and a good pass resets it.
    let failures = 0;
    let notBefore = 0;
    const tick = async () => {
      if (busy || !hasJob(d, 'extra') || d.jobs.pressure || Date.now() < notBefore) return;
      busy = true;
      try {
        // While there is a backlog (a re-embed), keep going for a while instead of one small batch every tick.
        // Nothing to read is a few small queries and no model call; reading is a job the admin page shows.
        const until = Date.now() + 45_000;
        let r = await syncEmbeddings(d);
        if (r.pages > 0 && r.remaining && !r.error) {
          await d.jobs.track({ kind: 'embeddings', title: 'Reading new and changed pages (embeddings)', cancellable: true }, async (job) => {
            let pages = r.pages;
            while (!job.signal.aborted && !d.jobs.pressure) {
              job.progress(pages, pages, `${pages} pages read`);
              if (!r.remaining || r.error || r.pages === 0 || Date.now() > until) break;
              r = await syncEmbeddings(d, { signal: job.signal });
              pages += r.pages;
            }
          });
        }
        if (r.error) { failures++; notBefore = Date.now() + Math.min(30 * 60_000, every * 2 ** Math.min(failures, 7)); } else { failures = 0; notBefore = 0; }
      } catch { /* retried next time */ } finally { busy = false; }
    };
    const first = setTimeout(() => void tick(), 5000);
    const t = setInterval(() => void tick(), every);
    first.unref?.();
    t.unref?.();
    return () => { clearTimeout(first); clearInterval(t); };
  },
};
export default feature;
