// "Refresh world": one job that brings everything the AI knows about a world
// up to date, in order, with one progress readout:
//
//   1. sources     every enabled source synced (the crawl, sources only)
//   2. pictures    every picture the sources queued downloaded and stored here
//   3. index       embeddings and story bible, in one bulk pass (search/bulkbuild.ts)
//   4. minerva     the codex's links to library pages mended (minerva/relink.ts)
//
// Each step runs even when an earlier one had errors (a source that failed
// leaves the others' pages to index). It is a job: Admin > Jobs lists it, it
// can be stopped, and a restart starts it again. One per world at a time.
// The last run of each world is kept (knowledge_refreshes) for the Knowledge page.
import type { Deps } from '../../app.ts';
import { hasJob } from '../../core/ai.ts';
import { all, one, run } from '../../core/db.ts';
import { gmOnly } from '../../core/events.ts';
import { HttpError, id, now } from '../../core/util.ts';
import { drainPictures, retryFailedPictures, waitingPictures } from '../../intake/imagequeue.ts';
import { crawlRunning, latestCrawl, startCrawl, stopCrawl } from '../connections/crawl.ts';
import { relinkCodex } from '../minerva/relink.ts';
import { BULK_KIND, bulkRunning, runBulkBuild } from '../search/bulkbuild.ts';

export const REFRESH_KIND = 'refresh-world';
export const REFRESH_SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_refreshes (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export type StepId = 'sources' | 'pictures' | 'index' | 'minerva';
export type StepState = 'waiting' | 'running' | 'done' | 'skipped' | 'error' | 'stopped';
export interface Step { id: StepId; label: string; state: StepState; detail: string }
export interface RefreshState {
  id: string;
  worldId: string;
  status: 'running' | 'ok' | 'error' | 'stopped';
  full: boolean;
  startedAt: string;
  finishedAt: string | null;
  by: string | null;
  steps: Step[];
}

const LABELS: Record<StepId, string> = { sources: 'Sync sources', pictures: 'Store pictures', index: 'Search index and story bible', minerva: "Minerva's codex links" };
const live = new Map<string, { state: RefreshState; ctl: AbortController; bulkJob: string | null }>();

export const refreshRunning = (worldId: string) => live.has(worldId);

/** The running refresh of a world, else its last one, else null. */
export function refreshState(d: Pick<Deps, 'db'>, worldId: string): RefreshState | null {
  const l = live.get(worldId);
  if (l) return l.state;
  try { const r = one<any>(d.db, 'SELECT state FROM knowledge_refreshes WHERE world_id = ?', worldId); return r ? JSON.parse(r.state) : null; } catch { return null; }
}

/** Start a refresh in the background. 409 when one (or a crawl) is already running for the world. `full`: a complete listing of every source. */
export function startRefresh(d: Deps, worldId: string, opts: { by: string | null; full?: boolean } = { by: null }): RefreshState {
  if (!one(d.db, 'SELECT 1 FROM worlds WHERE id = ?', worldId)) throw new HttpError(404, 'World not found');
  if (live.has(worldId)) throw new HttpError(409, 'This world is already being refreshed');
  if (crawlRunning(worldId)) throw new HttpError(409, 'A crawl of this world is running. Wait for it, or stop it, then refresh.');
  const state: RefreshState = {
    id: id('rfr_'), worldId, status: 'running', full: !!opts.full, startedAt: now(), finishedAt: null, by: opts.by,
    steps: (Object.keys(LABELS) as StepId[]).map((s) => ({ id: s, label: LABELS[s], state: 'waiting', detail: '' })),
  };
  const ctl = new AbortController();
  const slot = { state, ctl, bulkJob: null as string | null };
  live.set(worldId, slot);
  void d.jobs.track({
    kind: REFRESH_KIND, title: 'Refresh world', worldId, resume: { worldId, full: !!opts.full },
    cancel: () => { ctl.abort(); stopCrawl(worldId); if (slot.bulkJob) d.jobs.cancel(slot.bulkJob); },
  }, (job) => work(d, slot, (done, total, msg) => job.progress(done, total, msg))).catch(() => {});
  return state;
}

/** Stop the world's refresh. False when none is running. */
export function stopRefresh(d: Deps, worldId: string): boolean {
  const l = live.get(worldId);
  if (!l) return false;
  l.ctl.abort();
  stopCrawl(worldId);
  if (l.bulkJob) d.jobs.cancel(l.bulkJob);
  return true;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function work(d: Deps, slot: { state: RefreshState; ctl: AbortController; bulkJob: string | null }, progress: (done: number, total: number, msg: string) => void) {
  const { state, ctl } = slot;
  const w = state.worldId;
  const step = (sid: StepId) => state.steps.find((s) => s.id === sid)!;
  let lastEmit = 0;
  const publish = (force = false) => {
    const t = Date.now();
    if (!force && t - lastEmit < 500) return;
    lastEmit = t;
    const n = state.steps.filter((s) => s.state !== 'waiting' && s.state !== 'running').length;
    const cur = state.steps.find((s) => s.state === 'running');
    progress(n, state.steps.length, cur ? `${cur.label}: ${cur.detail}` : 'Refresh world');
    try { d.hub.emit(w, 'knowledge', state, gmOnly); } catch { /* no listeners */ }
  };
  const set = (sid: StepId, st: StepState, detail?: string) => { const s = step(sid); s.state = st; if (detail !== undefined) s.detail = detail; publish(true); };
  const stopped = () => ctl.signal.aborted;
  try {
    // 1. Sources: the crawl, sources only. Its progress is read while it runs.
    const sources = all<any>(d.db, `SELECT id FROM sources WHERE world_id = ? AND enabled = 1 AND kind <> 'push'`, w);
    if (!sources.length) set('sources', 'skipped', 'No sources to sync');
    else {
      set('sources', 'running', 'Starting');
      const c = startCrawl(d, w, { mode: 'crawl', by: state.by, full: state.full, index: false });
      const t = setInterval(() => {
        const p = latestCrawl(d, w)?.progress;
        if (p) { step('sources').detail = `${p.sources.done} of ${p.sources.total} sources${p.sources.current ? ` (now ${p.sources.current})` : ''}, ${p.saved} pages saved${p.errors ? `, ${p.errors} errors` : ''}`; publish(); }
      }, 1000);
      try { await c.done; } finally { clearInterval(t); }
      const cr = latestCrawl(d, w);
      const p = cr?.progress;
      const detail = p ? `${p.saved} pages saved, ${p.removed} removed${p.errors ? `, ${p.errors} errors${p.errorSamples?.[0] ? ` (${p.errorSamples[0]})` : ''}` : ''}` : '';
      set('sources', stopped() || cr?.status === 'stopped' ? 'stopped' : cr?.status === 'error' ? 'error' : 'done', detail);
    }
    if (stopped()) return;

    // 2. Pictures: everything queued, every source, with another chance for the ones that failed before.
    retryFailedPictures(d.db, w);
    const total = waitingPictures(d.db, { worldId: w });
    if (!total) set('pictures', 'done', 'Nothing waiting');
    else {
      set('pictures', 'running', `0 of ${total}`);
      let stored = 0;
      let failed = 0;
      const notes: string[] = [];
      for (const s of all<any>(d.db, 'SELECT id FROM sources WHERE world_id = ?', w)) {
        if (stopped()) break;
        const s0 = stored;
        const f0 = failed;
        const r = await drainPictures(d, s.id, { signal: ctl.signal, onEach: (x) => { stored = s0 + x.downloaded; failed = f0 + x.failed; step('pictures').detail = `${stored + failed} of ${total}`; publish(); } });
        stored = s0 + r.downloaded;
        failed = f0 + r.failed;
        if (r.stoppedAt) notes.push(`stopped at ${r.stoppedAt}`);
      }
      const left = waitingPictures(d.db, { worldId: w });
      set('pictures', stopped() ? 'stopped' : 'done', `${stored} stored${failed ? `, ${failed} could not be downloaded` : ''}${left ? `, ${left} still waiting` : ''}${notes.length ? ` (${notes[0]})` : ''}`);
    }
    if (stopped()) return;

    // 3. Embeddings and story bible in one bulk pass. One already running (after a rebuild, say) is waited for first.
    const emb = hasJob(d, 'extra');
    const bib = hasJob(d, 'bible');
    if (!emb && !bib) set('index', 'skipped', 'No embeddings or story bible model is set (Admin > Models)');
    else {
      set('index', 'running', 'Starting');
      for (let i = 0; i < 7200 && bulkRunning(d, w) && !stopped(); i++) { step('index').detail = 'Waiting for the indexing already running'; publish(); await wait(500); }
      if (stopped()) return;
      const bulk = runBulkBuild(d, w, { embeddings: emb, bible: bib });
      const t = setInterval(() => {
        const j = d.jobs.list().find((x) => x.kind === BULK_KIND && x.worldId === w && x.status === 'running');
        if (j) { slot.bulkJob = j.id; step('index').detail = j.progress.message || 'Indexing'; publish(); }
      }, 1000);
      try {
        const r = await bulk;
        const parts = [
          r.embeddings ? `embeddings: ${r.embeddings.pages} page copies${r.embeddings.error ? ` (stopped: ${r.embeddings.error})` : ''}` : emb ? '' : 'no embeddings model',
          r.bible ? `story bible: ${r.bible.pages} page copies, ${r.bible.facts} facts${r.bible.skipped ? ` (${r.bible.skipped})` : ''}` : bib ? '' : 'no story bible model',
        ].filter(Boolean);
        set('index', stopped() ? 'stopped' : r.embeddings?.error ? 'error' : 'done', parts.join('; ') || 'Nothing waiting');
      } catch (err: any) {
        set('index', stopped() ? 'stopped' : 'error', String(err?.message ?? err).slice(0, 200));
      } finally { clearInterval(t); slot.bulkJob = null; }
    }
    if (stopped()) return;

    // 4. Minerva's codex links.
    set('minerva', 'running', 'Checking links');
    const m = relinkCodex(d, w, state.by);
    if (m.off) set('minerva', 'skipped', 'Minerva is off for this world');
    else set('minerva', 'done', `${m.linked} of ${m.pages} codex pages linked${m.renamed ? `, ${m.renamed} renamed` : ''}${m.relinked ? `, ${m.relinked} found again` : ''}${m.added ? `, ${m.added} newly linked` : ''}${m.broken.length ? `; no library page for: ${m.broken.slice(0, 5).join(', ')}${m.broken.length > 5 ? ` and ${m.broken.length - 5} more` : ''}` : ''}`);
  } catch (err: any) {
    const cur = state.steps.find((s) => s.state === 'running');
    if (cur) { cur.state = stopped() ? 'stopped' : 'error'; cur.detail = String(err?.message ?? err).slice(0, 200); }
  } finally {
    for (const s of state.steps) if (s.state === 'running' || (stopped() && s.state === 'waiting')) s.state = stopped() ? 'stopped' : s.state === 'running' ? 'error' : s.state;
    state.status = stopped() ? 'stopped' : state.steps.some((s) => s.state === 'error') ? 'error' : 'ok';
    state.finishedAt = now();
    live.delete(w);
    try { run(d.db, 'INSERT INTO knowledge_refreshes (world_id, state, updated_at) VALUES (?, ?, ?) ON CONFLICT (world_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at', w, JSON.stringify(state), now()); } catch { /* the world is gone */ }
    publish(true);
  }
}
