// Story bible (memory): facts read out of the library by the chat model,
// kept per page and per reader scope (see search/scopes.ts), assembled for
// whoever asks from the pages they may open right now.
//
//   GET  /api/worlds/:world/bible?subject=&kind=&q=&limit=   the bible for the caller
//   GET  /api/worlds/:world/bible/status                      (GM) extraction progress per scope
//   POST /api/worlds/:world/bible/refresh                     (GM) extract what is stale now
//   POST /api/worlds/:world/bible/rebuild                     (GM) forget every fact and read it all again (one bulk pass, a job)
//   POST /api/worlds/:world/bible/read-now   {all?: true}     (GM) read 25 pages now, or everything waiting in one bulk pass
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
import { hasJob, withPriority } from '../../core/ai.ts';
import { all, run } from '../../core/db.ts';
import { HttpError, int } from '../../core/util.ts';
import { ctx } from '../../routes/_shared.ts';
import { assembleBible, bibleCoverage } from './assemble.ts';
import { SCHEMA, bibleFailed, bibleLog, bibleNow, forgetFailures, syncBible } from './extract.ts';
import { auditBible } from './audit.ts';
import { BIBLE_RUNS, bibleRuns, mayRead, worldsToRead } from './when.ts';
import { BULK_KIND, bulkRunning, startBulkBuild } from '../search/bulkbuild.ts';

// A "read now" the GM started, by world, and the background reader's own stop button.
const manual = new Map<string, AbortController>();
let stopRunning: (worldId: string) => void = () => {};

const feature: Feature = {
  id: 'bible',
  schema: SCHEMA,
  settings: { bibleRuns: { type: 'enum', default: 'session', values: BIBLE_RUNS } },
  worldMount: 'bible',
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    const str = (v: unknown, n = 120) => (typeof v === 'string' ? v.slice(0, n) : undefined);

    const embedded = (w: string) => { const r = all<any>(d.db, 'SELECT count(*) AS n, sum(vec IS NOT NULL) AS v FROM bible_facts WHERE world_id = ?', w)[0]; return { facts: Number(r?.n ?? 0), withVectors: Number(r?.v ?? 0) }; };

    r.get('/', async (req, res) => {
      const c = ctx(res);
      res.json(await assembleBible(d, c.world.id, c.viewer, { subject: str(req.query.subject), kind: str(req.query.kind, 20), q: str(req.query.q, 200), limit: int(req.query.limit, 'limit', { min: 1, max: 1000, optional: true }) ?? undefined }));
    });

    r.get('/status', requireDM, (_req, res) => {
      const w = ctx(res).world.id;
      res.json({ chat: hasJob(d, 'bible'), building: bulkRunning(d, w), runs: bibleRuns(d.db, w), reading: mayRead(d.db, w), now: bibleNow(w), log: bibleLog(w), failed: bibleFailed().length, embedded: embedded(w), ...bibleCoverage(d, w) });
    });

    r.post('/refresh', requireDM, async (_req, res) => {
      res.json(await syncBible(d, { maxPages: 50, worldId: ctx(res).world.id }));
    });

    // "Read a few now": started, not waited for (a page can take half a minute). The status says how it goes.
    r.post('/read-now', requireDM, (req, res) => {
      if (!hasJob(d, 'bible')) throw new HttpError(503, 'No model is set for the story bible or chat (Admin → Models)');
      const w = ctx(res).world.id;
      // Everything waiting, in one bulk pass (several pages at once), tracked as a job.
      if (req.body?.all === true) { forgetFailures(); res.status(202).json({ ok: true, all: true, started: startBulkBuild(d, w, { bible: true }) }); return; }
      const ctl = new AbortController();
      manual.get(w)?.abort();
      manual.set(w, ctl);
      forgetFailures();
      void withPriority(0, () => syncBible(d, { maxPages: 25, worldId: w, signal: ctl.signal })).catch(() => {}).finally(() => { if (manual.get(w) === ctl) manual.delete(w); });
      res.status(202).json({ ok: true });
    });
    r.post('/stop', requireDM, (_req, res) => {
      const w = ctx(res).world.id;
      manual.get(w)?.abort();
      stopRunning(w);
      for (const j of d.jobs.list()) if (j.kind === BULK_KIND && j.worldId === w && j.status === 'running') d.jobs.cancel(j.id);
      res.json({ ok: true });
    });

    // Checks that need no model: waiting, failed and empty pages, facts whose subject the page never names, the same page read several times.
    r.get('/audit', requireDM, (_req, res) => { res.json(auditBible(d, ctx(res).world.id)); });
    // Forget what was written from these pages, so they are read again.
    r.post('/reread', requireDM, (req, res) => {
      const w = ctx(res).world.id;
      const ids: unknown = req.body?.pageIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some((x) => typeof x !== 'string')) throw new HttpError(400, 'pageIds must be a list of up to 500 page ids');
      const q = ids.map(() => '?').join(',');
      run(d.db, `DELETE FROM bible_facts WHERE world_id = ? AND page_id IN (${q})`, w, ...ids);
      const n = run(d.db, `DELETE FROM bible_state WHERE world_id = ? AND page_id IN (${q})`, w, ...ids);
      forgetFailures(ids as string[]);
      res.json({ ok: true, pages: n });
    });

    r.post('/rebuild', requireDM, (_req, res) => {
      const w = ctx(res).world.id;
      run(d.db, 'DELETE FROM bible_facts WHERE world_id = ?', w);
      run(d.db, 'DELETE FROM bible_state WHERE world_id = ?', w);
      const cov = bibleCoverage(d, w);
      // Read again in one bulk pass (a job), whatever "when it reads" says: the GM asked for it.
      res.json({ ok: true, ...cov, started: startBulkBuild(d, w, { bible: true }) });
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
    // ALX_BIBLE=off: the background build stays off (every fact is a chat model call per page).
    if (String(d.env.ALX_BIBLE ?? '').toLowerCase() === 'off') return;
    const every = Math.max(1000, Number(d.env.ALX_BIBLE_MS ?? 30_000) || 30_000);
    let busy = false;
    // Ended at once when the session does, whatever page it is on.
    let stop: { worldId: string; ctl: AbortController } | null = null;
    const untap = d.hub.tap((worldId, type) => {
      if ((type === 'chat-session' || type === 'recording' || type === 'settings') && stop?.worldId === worldId && !mayRead(d.db, worldId)) stop.ctl.abort();
    });
    stopRunning = (worldId) => { if (stop?.worldId === worldId) stop.ctl.abort(); };
    const tick = async () => {
      if (busy || !hasJob(d, 'bible') || d.jobs.pressure) return;
      busy = true;
      try {
        const until = Date.now() + 45_000;
        for (const worldId of worldsToRead(d.db)) {
          const ctl = new AbortController();
          stop = { worldId, ctl };
          while (mayRead(d.db, worldId) && Date.now() <= until) {
            // Background work: the table's own requests go first.
            const r = await withPriority(0, () => syncBible(d, { worldId, maxPages: 3, signal: ctl.signal }));
            if (!r.remaining || r.skipped || r.pages === 0 || ctl.signal.aborted) break;
          }
        }
      } catch { /* retried next time */ } finally { busy = false; stop = null; }
    };
    const first = setTimeout(() => void tick(), 8000);
    const t = setInterval(() => void tick(), every);
    first.unref?.();
    t.unref?.();
    return () => { clearTimeout(first); clearInterval(t); stop?.ctl.abort(); if (typeof untap === 'function') untap(); };
  },
};
export default feature;
