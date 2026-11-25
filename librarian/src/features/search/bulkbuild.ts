// One fast pass over a whole world: embed every page that is waiting, then
// read every page that is waiting into the story bible. Started after a first
// import (a crawl), a re-embed or a story bible rebuild, and by
// POST /worlds/:w/search/build, instead of leaving the backlog to the small
// background ticks (25 pages every 20 s, 3 pages every 30 s during sessions).
//
// It is a job (Admin > Jobs lists it, it can be stopped, a restart starts it
// again). Its model calls go in at background priority, so the table's own
// requests still go first, and it is as wide as the models allow
// (search/batching.ts). The background ticks keep handling small edits.
import type { Deps } from '../../app.ts';
import { hasJob, withPriority } from '../../core/ai.ts';
import { bibleCoverage } from '../bible/assemble.ts';
import { bibleRunning, forgetFailures, syncBible } from '../bible/extract.ts';
import { embeddingCoverage, syncEmbeddings } from './embeddings.ts';
import { VEC_SCOPES } from './scopes.ts';

export const BULK_KIND = 'index-build';
export interface BulkWhat { embeddings?: boolean; bible?: boolean }
export interface BulkResult { embeddings?: { pages: number; chunks: number; error?: string }; bible?: { pages: number; facts: number; skipped?: string } }

const waitingBible = (d: Deps, worldId: string) => { const c = bibleCoverage(d, worldId); return VEC_SCOPES.reduce((n, s) => n + c.scopes[s].pending, 0); };

/** Is a bulk build running for this world? */
export const bulkRunning = (d: Deps, worldId: string) => d.jobs.running(BULK_KIND, worldId);

/**
 * Start a bulk build of one world in the background. False when one is already
 * running for it, or when no model is set for anything asked for.
 */
export function startBulkBuild(d: Deps, worldId: string, what: BulkWhat = { embeddings: true, bible: true }): boolean {
  const emb = !!what.embeddings && hasJob(d, 'extra');
  const bib = !!what.bible && hasJob(d, 'bible');
  if ((!emb && !bib) || bulkRunning(d, worldId)) return false;
  void runBulkBuild(d, worldId, { embeddings: emb, bible: bib }).catch(() => {});
  return true;
}

/** The bulk build itself, as a tracked job. Resolves when it is done or stopped. */
export function runBulkBuild(d: Deps, worldId: string, what: BulkWhat): Promise<BulkResult> {
  const title = what.embeddings && what.bible ? 'Indexing the world (embeddings and story bible)' : what.embeddings ? 'Indexing the world (embeddings)' : 'Reading the world into the story bible';
  return d.jobs.track({ kind: BULK_KIND, title, worldId, resume: { worldId, embeddings: !!what.embeddings, bible: !!what.bible } }, (job) => withPriority(0, async () => {
    const out: BulkResult = {};
    if (what.embeddings && hasJob(d, 'extra')) {
      const e = (out.embeddings = { pages: 0, chunks: 0 } as NonNullable<BulkResult['embeddings']>);
      const total = embeddingCoverage(d, worldId).progress.pending;
      const say = () => job.progress(e.pages, Math.max(total, e.pages), `Embeddings: ${e.pages} of ${Math.max(total, e.pages)} page copies`);
      say();
      // One pass reads everything waiting; another only when pages changed while it ran.
      for (let round = 0; round < 5 && !job.signal.aborted; round++) {
        const p0 = e.pages;
        const c0 = e.chunks;
        const r = await syncEmbeddings(d, { maxPages: 1_000_000, worldId, signal: job.signal, onPage: (x) => { e.pages = p0 + x.pages; e.chunks = c0 + x.embedded; say(); } });
        e.pages = p0 + r.pages;
        e.chunks = c0 + r.embedded;
        if (r.error) { e.error = r.error; break; }
        if (!r.remaining || r.pages === 0) break;
      }
    }
    if (what.bible && hasJob(d, 'bible') && !job.signal.aborted) {
      const b = (out.bible = { pages: 0, facts: 0 } as NonNullable<BulkResult['bible']>);
      // A page that failed earlier gets its chances again in a build someone asked for.
      forgetFailures();
      const total = waitingBible(d, worldId);
      const say = () => job.progress(b.pages, Math.max(total, b.pages), `Story bible: ${b.pages} of ${Math.max(total, b.pages)} page copies, ${b.facts} facts`);
      say();
      for (let round = 0; round < 5 && !job.signal.aborted; round++) {
        // The background reader may hold this world for a moment: wait for it to let go.
        for (let i = 0; i < 120 && bibleRunning(d, worldId) && !job.signal.aborted; i++) await new Promise((r) => setTimeout(r, 500));
        const p0 = b.pages;
        const f0 = b.facts;
        const r = await syncBible(d, { maxPages: 1_000_000, worldId, signal: job.signal, onPage: (x) => { b.pages = p0 + x.pages; b.facts = f0 + x.facts; say(); } });
        b.pages = p0 + r.pages;
        b.facts = f0 + r.facts;
        if (r.skipped) { b.skipped = r.skipped; if (r.skipped !== 'already running') break; continue; }
        if (!r.remaining || r.pages === 0) break;
      }
      say();
    }
    return out;
  }));
}
