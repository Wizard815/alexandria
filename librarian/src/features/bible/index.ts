// Story bible (memory): facts read out of the library by the chat model,
// kept per page and per reader scope (see search/scopes.ts), assembled for
// whoever asks from the pages they may open right now.
//
//   GET  /api/worlds/:world/bible?subject=&kind=&q=&limit=   the bible for the caller
//   GET  /api/worlds/:world/bible/status                      (DM) extraction progress per scope
//   POST /api/worlds/:world/bible/refresh                     (DM) extract what is stale now
//   POST /api/worlds/:world/bible/rebuild                     (DM) forget every fact and read it all again
//   MCP  story_bible
//
// Extraction is incremental (only pages whose copy changed), budgeted and runs
// in the background; without a chat model nothing is extracted and the bible
// is simply empty. A permission change deletes the facts it makes wrong at
// once (Library.changed), before anything can read them.
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { requireDM } from '../../core/auth.ts';
import { hasJob } from '../../core/ai.ts';
import { run } from '../../core/db.ts';
import { int } from '../../core/util.ts';
import { ctx } from '../../routes/_shared.ts';
import { assembleBible, bibleCoverage } from './assemble.ts';
import { SCHEMA, syncBible } from './extract.ts';

const feature: Feature = {
  id: 'bible',
  schema: SCHEMA,
  worldMount: 'bible',
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    const str = (v: unknown, n = 120) => (typeof v === 'string' ? v.slice(0, n) : undefined);

    r.get('/', async (req, res) => {
      const c = ctx(res);
      res.json(await assembleBible(d, c.world.id, c.viewer, { subject: str(req.query.subject), kind: str(req.query.kind, 20), q: str(req.query.q, 200), limit: int(req.query.limit, 'limit', { min: 1, max: 1000, optional: true }) ?? undefined }));
    });

    r.get('/status', requireDM, (_req, res) => {
      res.json({ chat: hasJob(d, 'chat'), ...bibleCoverage(d, ctx(res).world.id) });
    });

    r.post('/refresh', requireDM, async (_req, res) => {
      res.json(await syncBible(d, { maxPages: 50, worldId: ctx(res).world.id }));
    });

    r.post('/rebuild', requireDM, (_req, res) => {
      const w = ctx(res).world.id;
      run(d.db, 'DELETE FROM bible_facts WHERE world_id = ?', w);
      run(d.db, 'DELETE FROM bible_state WHERE world_id = ?', w);
      res.json({ ok: true, ...bibleCoverage(d, w) });
    });

    return r;
  },

  mcpTools: [
    {
      name: 'story_bible',
      description: 'The campaign\'s story bible: facts about people, places, factions, items, events and lore, grouped by subject, each citing the library page it came from. You get the facts of pages YOU may open, in your own copy. Filter by subject name, kind (person, place, faction, item, event, lore) or search by words or meaning with q. Use it for context before answering about the world.',
      props: {
        subject: { type: 'string', description: 'A name to look up (person, place, faction...)' },
        kind: { type: 'string', description: 'person, place, faction, item, event or lore' },
        q: { type: 'string', description: 'Search the facts by words or meaning' },
        limit: { type: 'number', description: 'How many subjects (default 50, at most 1000)' },
      },
      call: (a) => {
        const p = new URLSearchParams();
        for (const k of ['subject', 'kind', 'q']) if (a[k]) p.set(k, String(a[k]));
        p.set('limit', String(a.limit ?? 50));
        return { method: 'GET', path: `/bible?${p}` };
      },
    },
  ],

  // Extract facts for new and changed pages, a few at a time. Does nothing without a chat model.
  start: (d: Deps) => {
    const every = Math.max(1000, Number(d.env.ALX_BIBLE_MS ?? 30_000) || 30_000);
    let busy = false;
    const tick = async () => {
      if (busy || !hasJob(d, 'chat')) return;
      busy = true;
      try { await syncBible(d); } catch { /* retried next time */ } finally { busy = false; }
    };
    const first = setTimeout(() => void tick(), 8000);
    const t = setInterval(() => void tick(), every);
    first.unref?.();
    t.unref?.();
    return () => { clearTimeout(first); clearInterval(t); };
  },
};
export default feature;
