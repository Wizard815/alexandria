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
import { SCHEMA, embeddingStats, syncEmbeddings } from './embeddings.ts';

const feature: Feature = {
  id: 'search',
  schema: SCHEMA,
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
      res.json({ semantic, ...(c.viewer.role === 'dm' ? embeddingStats(d.db, c.world.id) : {}) });
    });

    r.post('/reindex', requireDM, async (_req, res) => {
      res.json(await syncEmbeddings(d, { maxPages: 200 }));
    });

    return r;
  },

  mcpTools: [
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
    const tick = async () => {
      if (busy || !hasJob(d, 'extra')) return;
      busy = true;
      try { await syncEmbeddings(d); } catch { /* retried next time */ } finally { busy = false; }
    };
    const first = setTimeout(() => void tick(), 5000);
    const t = setInterval(() => void tick(), every);
    first.unref?.();
    t.unref?.();
    return () => { clearTimeout(first); clearInterval(t); };
  },
};
export default feature;
