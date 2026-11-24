// The crawl: the first sync of a world's sources, then embeddings for every
// page, with live progress (pages listed, saved, levels found, chunks
// embedded, errors, and the calls made to each source). It can be cancelled;
// the world and its sources are saved either way, and whatever was fetched
// stays in the library.
//
// A source that crawls in tiers (LegendKeeper, Kanka, a generic API with
// mapped endpoints) is only listed here: the fewest calls that put every page
// in the library with its title, type, tags and parent. The pages themselves
// are read afterwards, on demand and in the background within the source's
// call budget (intake/detail.ts); the progress shows both.
//
// Progress is kept in connections_crawls (so the page can be reloaded) and
// sent to the DM's live stream as a `crawl` event. Never to players.
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { dmOnly } from '../../core/events.ts';
import { hasJob } from '../../core/ai.ts';
import { HttpError, id, now } from '../../core/util.ts';
import type { JobCtx } from '../../core/jobs.ts';
import { connectorFor } from '../../intake/registry.ts';
import { effectiveConfig } from '../../intake/connections.ts';
import { runSync, stopSync } from '../../intake/sync.ts';
import { budgetOf, depthCounts, getState, tieredOf } from '../../intake/tiers.ts';
import { embeddingCoverage, pruneChunks, syncEmbeddings } from '../search/embeddings.ts';
import { syncBible } from '../bible/extract.ts';

export const CRAWL_SCHEMA = `
CREATE TABLE IF NOT EXISTS connections_crawls (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'crawl',
  status TEXT NOT NULL DEFAULT 'running',
  progress TEXT NOT NULL DEFAULT '{}',
  log TEXT NOT NULL DEFAULT '',
  error TEXT,
  started_by TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS connections_crawls_world ON connections_crawls (world_id, started_at);
`;

export type CrawlStatus = 'running' | 'ok' | 'error' | 'stopped';
export interface Progress {
  phase: 'sync' | 'embed' | 'done';
  sources: { total: number; done: number; current: string | null };
  fetched: number;
  saved: number;
  skipped: number;
  removed: number;
  errors: number;
  errorSamples: string[];
  levels: { party: number; broker: number; dm: number; classified: number };
  /** Calls made to the sources by this crawl, by tier. */
  calls: { index: number; detail: number };
  /** Pages by how much of them is held. */
  depth: { index: number; summary: number; full: number };
  /** One line per tiered source: what the world page shows ("Index: 14 calls, 2,031 pages · Details: 120 of 2,031 · Budget 30/min"). */
  tiers: TierLine[];
  embedding: { state: 'waiting' | 'running' | 'done' | 'no-model' | 'error' | 'cancelled'; model: string | null; pagesTotal: number; pagesDone: number; chunks: number };
}

export interface TierLine { sourceId: string; name: string; pages: number; read: number; indexCalls: number; budget: number; paused: boolean; fetchAll: boolean }

const active = new Map<string, { id: string; ctl: AbortController; current: string | null }>();
export const crawlRunning = (worldId: string) => active.has(worldId);

export function stopCrawl(worldId: string): boolean {
  const a = active.get(worldId);
  if (!a) return false;
  a.ctl.abort();
  if (a.current) stopSync(a.current);
  return true;
}

const parse = (s: string | null | undefined) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
export const shapeCrawl = (r: any, withLog = false) => r && ({ id: r.id, world_id: r.world_id, mode: r.mode, status: r.status as CrawlStatus, progress: parse(r.progress) as Progress, error: r.error, started_at: r.started_at, finished_at: r.finished_at, running: active.get(r.world_id)?.id === r.id, ...(withLog ? { log: r.log } : {}) });

export const latestCrawl = (d: Deps, worldId: string) => shapeCrawl(one<any>(d.db, 'SELECT id, world_id, mode, status, progress, error, started_at, finished_at FROM connections_crawls WHERE world_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1', worldId)) ?? null;

/** Page counts by level for a world. */
export function levelCounts(d: Deps, worldId: string): Progress['levels'] {
  const out = { party: 0, broker: 0, dm: 0, classified: 0 };
  for (const r of all<any>(d.db, 'SELECT visibility, COUNT(*) AS n FROM pages WHERE world_id = ? GROUP BY visibility', worldId)) {
    if (r.visibility in out) (out as any)[r.visibility] = r.n; else out.dm += r.n; // anything unknown counts as dm
  }
  return out;
}

/** Page counts by depth for a world (pages not from a tiered source count as full). */
export function depthTotals(d: Deps, worldId: string): Progress['depth'] {
  const out = { index: 0, summary: 0, full: 0 };
  try { for (const r of all<any>(d.db, 'SELECT depth, COUNT(*) AS n FROM pages WHERE world_id = ? GROUP BY depth', worldId)) if (r.depth in out) (out as any)[r.depth] = r.n; } catch { /* the depth column is made by the first tiered sync */ }
  return out;
}

/** Start a crawl (the sources are listed, then embeddings) or a re-index (embeddings only, from scratch). Returns at once; the work runs in the background. */
export function startCrawl(d: Deps, worldId: string, opts: { mode?: 'crawl' | 'reindex'; sourceIds?: string[]; by: string | null; full?: boolean }) {
  if (!one(d.db, 'SELECT 1 FROM worlds WHERE id = ?', worldId)) throw new HttpError(404, 'World not found');
  if (active.has(worldId)) throw new HttpError(409, 'This world is already being crawled');
  const mode = opts.mode ?? 'crawl';
  let sources = all<any>(d.db, 'SELECT * FROM sources WHERE world_id = ? AND enabled = 1 ORDER BY name', worldId)
    .filter((s) => !connectorFor(s.kind, effectiveConfig(d.db, s))?.push);
  if (opts.sourceIds) {
    const want = new Set(opts.sourceIds);
    sources = sources.filter((s) => want.has(s.id));
  }
  if (mode === 'reindex') sources = [];
  const cid = id('crl_');
  const ctl = new AbortController();
  active.set(worldId, { id: cid, ctl, current: null });
  run(d.db, 'INSERT INTO connections_crawls (id, world_id, mode, status, started_by, started_at) VALUES (?, ?, ?, ?, ?, ?)', cid, worldId, mode, 'running', opts.by, now());
  // A job the admin page lists, stops and (after a restart) starts again: the sources are synced again from where their state left off and
  // the embeddings carry on with the pages not yet read.
  const title = mode === 'reindex' ? 'Re-index (embeddings)' : 'Crawl (sources, then embeddings)';
  void d.jobs.track({ kind: 'crawl', title, worldId, resume: { worldId, mode, sourceIds: opts.sourceIds, full: !!opts.full }, cancel: () => { stopCrawl(worldId); } },
    (job) => work(d, worldId, cid, mode, sources, ctl, !!opts.full, job)).catch(() => {});
  return { id: cid };
}

async function work(d: Deps, worldId: string, cid: string, mode: 'crawl' | 'reindex', sources: any[], ctl: AbortController, full: boolean, job?: JobCtx) {
  const slot = active.get(worldId)!;
  const lines: string[] = [];
  const log = (m: string) => { lines.push(`${new Date().toISOString().slice(11, 19)} ${m}`); if (lines.length > 500) lines.splice(0, lines.length - 500); };
  const P: Progress = {
    phase: 'sync', sources: { total: sources.length, done: 0, current: null }, fetched: 0, saved: 0, skipped: 0, removed: 0, errors: 0, errorSamples: [],
    levels: levelCounts(d, worldId), calls: { index: 0, detail: 0 }, depth: depthTotals(d, worldId), tiers: [], embedding: { state: 'waiting', model: null, pagesTotal: 0, pagesDone: 0, chunks: 0 },
  };
  let status: CrawlStatus = 'running';
  let error: string | null = null;
  let lastSave = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const publish = (force = false) => {
    const t = Date.now();
    // Quick updates are batched; the last one always goes out a moment later.
    if (!force && t - lastSave < 250) { trailing ??= setTimeout(() => { trailing = null; if (active.get(worldId)?.id === cid) publish(true); }, 260); return; }
    if (trailing) { clearTimeout(trailing); trailing = null; }
    lastSave = t;
    P.levels = levelCounts(d, worldId);
    P.depth = depthTotals(d, worldId);
    run(d.db, 'UPDATE connections_crawls SET progress = ?, log = ?, status = ? WHERE id = ?', JSON.stringify(P), lines.join('\n'), status, cid);
    d.hub.emit(worldId, 'crawl', { id: cid, status, progress: P }, dmOnly);
    if (P.phase === 'embed') job?.progress(P.embedding.pagesDone, P.embedding.pagesTotal, `Embedding: ${P.embedding.pagesDone} of ${P.embedding.pagesTotal} pages`);
    else job?.progress(P.sources.done, Math.max(1, P.sources.total), `${P.sources.current ? `Syncing ${P.sources.current}: ` : ''}${P.saved} pages saved`);
  };
  const tierLine = (s: any, indexCalls: number): TierLine | null => {
    const cfg = effectiveConfig(d.db, s);
    const t = tieredOf(s.kind, cfg);
    if (!t) return null;
    const st = getState(d.db, s.id);
    const c = depthCounts(d.db, s.id);
    return { sourceId: s.id, name: s.name, pages: c.total, read: c.full, indexCalls, budget: budgetOf(st, t), paused: st.paused, fetchAll: st.fetchAll };
  };
  const setTier = (s: any, indexCalls: number) => {
    const line = tierLine(s, indexCalls);
    if (!line) return;
    const i = P.tiers.findIndex((x) => x.sourceId === s.id);
    if (i >= 0) P.tiers[i] = line; else P.tiers.push(line);
  };
  const failure = (m: string) => { P.errors++; if (P.errorSamples.length < 5) P.errorSamples.push(m.slice(0, 200)); };
  try {
    log(mode === 'reindex' ? 'Re-index: reading every page again' : `Crawl started: ${sources.length} source${sources.length === 1 ? '' : 's'}`);
    publish(true);
    let succeeded = 0;
    for (const s of sources) {
      if (ctl.signal.aborted) break;
      slot.current = s.id;
      P.sources.current = s.name;
      log(`Syncing ${s.name}`);
      publish(true);
      const baseFetched = P.fetched;
      const baseSaved = P.saved;
      const baseSkipped = P.skipped;
      const baseIndexCalls = P.calls.index;
      const baseDetailCalls = P.calls.detail;
      try {
        const out = await runSync({
          db: d.db, library: d.library, dataDir: d.dataDir, vaultsDir: d.vaultsDir, fetch: d.fetch, env: d.env, mcp: d.testMcp,
          onEntry: (st) => {
            if (ctl.signal.aborted) stopSync(s.id);
            P.saved = baseSaved + (st.pages ?? 0);
            P.skipped = baseSkipped + (st.skipped ?? 0);
            P.fetched = baseFetched + (st.pages ?? 0) + (st.skipped ?? 0);
            P.calls.index = baseIndexCalls + (st.indexCalls ?? 0);
            P.calls.detail = baseDetailCalls + (st.detailCalls ?? 0);
            publish();
          },
        }, s.id, null, { tiered: true, full, nested: true });
        P.calls.index = baseIndexCalls + (out.stats.indexCalls ?? 0);
        P.calls.detail = baseDetailCalls + (out.stats.detailCalls ?? 0);
        setTier(s, out.stats.indexCalls ?? 0);
        P.saved = baseSaved + (out.stats.pages ?? 0);
        P.skipped = baseSkipped + (out.stats.skipped ?? 0);
        P.fetched = baseFetched + (out.stats.pages ?? 0) + (out.stats.skipped ?? 0);
        P.removed += out.stats.removed ?? 0;
        for (const l of String(out.log ?? '').split('\n')) if (/ Skipped .+: /.test(l)) failure(l.replace(/^\S+ /, ''));
        if (out.status === 'ok') {
          succeeded++;
          const t = P.tiers.find((x) => x.sourceId === s.id);
          log(t ? `${s.name}: ${out.stats.pages ?? 0} pages saved. Index: ${out.stats.indexCalls ?? 0} calls, ${t.pages} pages; ${t.read} read in full; the rest are read on demand and in the background (${t.budget} calls a minute).` : `${s.name}: ${out.stats.pages ?? 0} pages saved`);
        }
        else if (out.status === 'stopped') log(`${s.name}: stopped`);
        else { failure(`${s.name}: ${out.error ?? out.status}`); log(`${s.name}: failed (${out.error ?? out.status})`); }
      } catch (err: any) {
        failure(`${s.name}: ${err.message}`);
        log(`${s.name}: could not start (${err.message})`);
      }
      slot.current = null;
      P.sources.done++;
      publish(true);
    }
    P.sources.current = null;

    if (ctl.signal.aborted) {
      P.embedding.state = 'cancelled';
      status = 'stopped';
      log('Crawl cancelled. What was fetched is saved in the library.');
    } else {
      P.phase = 'embed';
      const cov = embeddingCoverage(d, worldId);
      P.embedding.model = cov.model;
      if (!cov.configured) {
        P.embedding.state = 'no-model';
        log('No embeddings model is set, so semantic search is off. The library part is finished; set one in Admin > Models and press Re-index.');
      } else {
        if (mode === 'reindex') {
          run(d.db, 'DELETE FROM search_chunks WHERE world_id = ?', worldId);
          run(d.db, 'DELETE FROM search_chunk_state WHERE world_id = ?', worldId);
        }
        pruneChunks(d.db);
        // Pages, not copies: a page with a DM copy and a party copy is one page, so "done" never passes "of".
        P.embedding.pagesTotal = embeddingCoverage(d, worldId).pages.pending;
        const donePages = new Set<string>();
        P.embedding.state = 'running';
        log(`Embedding ${P.embedding.pagesTotal} pages with ${cov.model}`);
        publish(true);
        const res = await syncEmbeddings(d, {
          maxPages: 1_000_000, worldId, signal: ctl.signal,
          onPage: (x) => { donePages.add(x.id); P.embedding.pagesDone = donePages.size; P.embedding.pagesTotal = Math.max(P.embedding.pagesTotal, donePages.size); P.embedding.chunks = x.embedded; publish(); },
        });
        P.embedding.pagesDone = donePages.size;
        P.embedding.pagesTotal = Math.max(P.embedding.pagesTotal, donePages.size);
        P.embedding.chunks = res.embedded;
        if (ctl.signal.aborted) { P.embedding.state = 'cancelled'; status = 'stopped'; log('Crawl cancelled during embedding. The library part is finished.'); }
        else if (res.error) { P.embedding.state = 'error'; failure(`Embeddings: ${res.error}`); log(`Embedding stopped: ${res.error}. Press Re-index to continue.`); }
        else { P.embedding.state = 'done'; log(`Embedded ${res.embedded} chunks from ${donePages.size} pages`); }
      }
      // The story bible reads new and changed pages too (in the background, with the chat model; nothing happens without one).
      if (!ctl.signal.aborted && hasJob(d, 'chat')) { log('Reading the library into the story bible in the background'); void syncBible(d, { maxPages: 1_000_000, worldId }).catch(() => {}); }
      if (status === 'running') status = sources.length && succeeded === 0 && P.errors > 0 ? 'error' : 'ok';
    }
  } catch (err: any) {
    status = ctl.signal.aborted ? 'stopped' : 'error';
    error = String(err?.message ?? err).slice(0, 500);
    log(`Failed: ${error}`);
  } finally {
    if (trailing) clearTimeout(trailing);
    P.phase = 'done';
    active.delete(worldId);
    P.levels = levelCounts(d, worldId);
    P.depth = depthTotals(d, worldId);
    run(d.db, 'UPDATE connections_crawls SET progress = ?, log = ?, status = ?, error = ?, finished_at = ? WHERE id = ?', JSON.stringify(P), lines.join('\n'), status, error, now(), cid);
    d.hub.emit(worldId, 'crawl', { id: cid, status, progress: P }, dmOnly);
  }
}
