// Runs a source's connector and stores what it yields.
// - one sync_runs row per sync, with stats and a log the admin panel shows
// - entries are saved in batch (player copies empty until the end)
// - pages the source no longer has are removed, only after a complete listing
// - player copies are rebuilt last, so links to DM-only pages are scrubbed
import type { DB } from '../core/db.ts';
import { one, all, run } from '../core/db.ts';
import type { Library } from '../core/library.ts';
import type { McpClient } from '../core/mcp.ts';
import { HttpError, id, now } from '../core/util.ts';
import { CallCounter, isRecord, type ConnectorContext, type SyncRecord, type TierState } from './connector.ts';
import { connectorFor, makeMcpFactory } from './registry.ts';
import { RECORD_CAPABILITY, saveRecords } from './records.ts';
import { effectiveConfig, normAudience } from './connections.ts';
import { depthCounts, getState, needsFullListing, rateGate, saveIndexState, storeEntry, tieredOf } from './tiers.ts';

export interface SyncDeps {
  db: DB;
  library: Library;
  dataDir: string | null;
  vaultsDir: string | null;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  /** Tests inject an MCP client instead of connecting. */
  mcp?: McpClient;
  /** Called on progress so the admin panel can update live. */
  onProgress?: (runId: string, stats: Record<string, number>) => void;
  /** Called after every page, with the running numbers (a crawl shows them live). */
  onEntry?: (stats: Record<string, number>) => void;
}

const running = new Map<string, AbortController>();

export function isRunning(sourceId: string) {
  return running.has(sourceId);
}

export function stopSync(sourceId: string) {
  running.get(sourceId)?.abort();
}

export function prefixFor(kind: string, name: string): string | null {
  if (['markdown-folder', 'git', 'mcp-files', 'vault'].includes(kind)) return null; // keep the vault's own layout
  return String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || kind;
}

export interface RunOptions {
  /**
   * Crawl in tiers: list calls only (the index), pages read later (intake/detail.ts). Without it the connector's own `sync` reads everything
   * in one go, details included. The crawl, the schedule and the admin panel's sync use tiers.
   */
  tiered?: boolean;
  /** Ask for a complete listing, so pages the source dropped are removed and records are read again. */
  full?: boolean;
}

/** Make the context a connector runs with. */
export function connectorContext(d: SyncDeps, src: any, cfg: any, signal: AbortSignal, log: (m: string) => void) {
  const c = connectorFor(src.kind, cfg);
  if (!c) throw new HttpError(400, `Unknown source kind: ${src.kind}`);
  const mcp = makeMcpFactory(c, cfg, d.env, d.fetch, d.mcp);
  const ctx: ConnectorContext = {
    fetch: d.fetch, env: d.env, dataDir: d.dataDir, vaultsDir: d.vaultsDir, signal, log,
    mcp: mcp.factory, sourceId: src.id, shareVisible: src.default_visibility === 'party', incomplete: new Set(),
  };
  return { c, ctx, close: mcp.close };
}

/** Sync one source. Resolves with the finished run. */
export async function runSync(d: SyncDeps, sourceId: string, by: string | null, opts: RunOptions = {}): Promise<any> {
  const src = one<any>(d.db, 'SELECT * FROM sources WHERE id = ?', sourceId);
  if (!src) throw new HttpError(404, 'Source not found');
  if (running.has(sourceId)) throw new HttpError(409, 'This source is already syncing');
  const cfg = effectiveConfig(d.db, src);
  if (connectorFor(src.kind, cfg)?.push) throw new HttpError(400, 'A push source receives entries from your tool; there is nothing to sync');
  const runId = id('run_');
  const lines: string[] = [];
  const log = (m: string) => { lines.push(`${new Date().toISOString().slice(11, 19)} ${m}`); if (lines.length > 500) lines.splice(0, lines.length - 500); };
  const stats = { pages: 0, shared: 0, dmOnly: 0, removed: 0, skipped: 0, records: 0, indexCalls: 0, detailCalls: 0, indexed: 0, kept: 0 };
  const records: SyncRecord[] = [];
  const ctl = new AbortController();
  running.set(sourceId, ctl);
  run(d.db, 'INSERT INTO sync_runs (id, source_id, world_id, status, started_at) VALUES (?, ?, ?, ?, ?)', runId, sourceId, src.world_id, 'running', now());
  const save = (status: string, error: string | null = null) => {
    run(d.db, 'UPDATE sync_runs SET status = ?, finished_at = ?, stats = ?, log = ?, error = ? WHERE id = ?', status, status === 'running' ? null : now(), JSON.stringify(stats), lines.join('\n'), error, runId);
  };
  let close = () => {};
  try {
    const made = connectorContext(d, src, cfg, ctl.signal, log);
    close = made.close;
    log(`Started ${made.c.label}`);
    const seen = new Set<string>();
    const prefix = prefixFor(made.c.id, src.name);
    // A tiered connector lists first (tier 1) and reads the pages later; without `tiered` the connector's own sync reads everything.
    const tier = opts.tiered ? tieredOf(src.kind, cfg) : null;
    const state = getState(d.db, sourceId);
    let ts: TierState | undefined;
    const counter = new CallCounter();
    if (connectorFor(src.kind, cfg)?.tiered) {
      counter.gate = rateGate(sourceId, tier?.budgetPerMinute ?? connectorFor(src.kind, cfg)!.tiered!(cfg)?.budgetPerMinute ?? 0, d.env, ctl.signal);
      counter.onHit = () => { stats.indexCalls = counter.index; stats.detailCalls = counter.detail; d.onEntry?.(stats); };
      made.ctx.calls = counter;
    }
    if (tier) {
      ts = { token: state.token, cache: state.cache, full: needsFullListing(state, opts.full), complete: true, next: { token: state.token, cache: state.cache } };
      made.ctx.tier = ts;
      log(ts.full ? 'Listing everything (tier 1: list calls only)' : 'Listing what changed since the last crawl (tier 1)');
    }
    const demoted: string[] = [];
    for await (const e of tier ? tier.index(cfg, made.ctx) : made.c.sync(cfg, made.ctx)) {
      if (ctl.signal.aborted) throw new Error('Sync stopped');
      if (isRecord(e)) {
        // Records are kept only for what the connector says it provides.
        if (made.c.capabilities.includes(RECORD_CAPABILITY[e.kind])) records.push(e); else stats.skipped++;
        continue;
      }
      if (!e?.externalId || seen.has(e.externalId)) { stats.skipped++; continue; }
      seen.add(e.externalId);
      try {
        const out = storeEntry({ db: d.db, library: d.library }, src.world_id, src.id, prefix, e, by);
        if (out.how === 'demote') demoted.push(out.id!);
        if (out.how === 'saved') {
          stats.pages++;
          if (e.depth === 'index') stats.indexed++;
          if (e.visibility === 'party') stats.shared++; else stats.dmOnly++;
        } else { stats.pages++; stats.kept++; }
      } catch (err: any) {
        stats.skipped++;
        log(`Skipped ${e.title}: ${err.message}`);
      }
      d.onEntry?.(stats);
      if (stats.pages % 50 === 0) { save('running'); d.onProgress?.(runId, stats); }
    }
    stats.indexCalls = counter.index;
    stats.detailCalls = counter.detail;
    // A page the list says is hidden loses its player copy now, not when its details are next read.
    if (demoted.length) { d.library.applyAudience(src.world_id, src.id); log(`${demoted.length} pages are hidden at the source: made DM-only`); }
    // Only a complete listing may delete. A listing of what changed lists nothing else.
    if (!ts || ts.complete) stats.removed = d.library.removeMissing(src.world_id, src.id, seen);
    else log('Only changed pages were listed, so nothing is removed this time');
    if (ts) saveIndexState(d.db, sourceId, { token: ts.next.token, cache: ts.next.cache, complete: ts.complete, calls: counter.index });
    // The source's audience decides what its records are: DM only, or shared (a reader still needs the pages they point at shared).
    const audience = normAudience(src.audience);
    if (audience !== 'auto') {
      for (const r of records as any[]) {
        r.visibility = audience;
        for (const g of r.groups ?? []) for (const ev of g.events ?? []) ev.visibility = audience;
      }
    }
    const saved = saveRecords(d.db, src.world_id, src.id, records, made.ctx.incomplete);
    stats.records = saved.relations + saved.timelines + saved.calendars + saved.markers;
    if (stats.records) log(`Saved ${saved.relations} relations, ${saved.timelines} timelines, ${saved.calendars} calendars, ${saved.markers} map markers`);
    log(`Saved ${stats.pages} pages (${stats.shared} shared, ${stats.dmOnly} DM-only), removed ${stats.removed}`);
    if (tier) {
      const dc = depthCounts(d.db, sourceId);
      log(`Index: ${counter.index} calls, ${dc.total} pages · read in full: ${dc.full + dc.summary} of ${dc.total}`);
    }
    save('ok');
    run(d.db, 'UPDATE sources SET last_sync_at = ?, last_status = ? WHERE id = ?', now(), `ok: ${stats.pages} pages`, sourceId);
  } catch (err: any) {
    const stopped = ctl.signal.aborted;
    log(`${stopped ? 'Stopped' : 'Failed'}: ${err.message}`);
    save(stopped ? 'stopped' : 'error', String(err.message).slice(0, 500));
    run(d.db, 'UPDATE sources SET last_sync_at = ?, last_status = ? WHERE id = ?', now(), `${stopped ? 'stopped' : 'error'}: ${String(err.message).slice(0, 200)}`, sourceId);
  } finally {
    close();
    running.delete(sourceId);
    // Always rebuild: a partial sync left batch-saved pages without player copies.
    d.library.rebuildPlayerCopies(src.world_id);
    d.onProgress?.(runId, stats);
  }
  return getRun(d.db, runId);
}

export function getRun(db: DB, runId: string) {
  const r = one<any>(db, 'SELECT * FROM sync_runs WHERE id = ?', runId);
  return r && { ...r, stats: JSON.parse(r.stats || '{}') };
}

export function listRuns(db: DB, sourceId: string, limit = 20) {
  return all<any>(db, 'SELECT id, status, started_at, finished_at, stats, error FROM sync_runs WHERE source_id = ? ORDER BY started_at DESC LIMIT ?', sourceId, limit).map((r) => ({ ...r, stats: JSON.parse(r.stats || '{}') }));
}

/** Sources with schedule_minutes sync on their own; checked once a minute. */
export function startScheduler(d: SyncDeps) {
  const t = setInterval(() => {
    const due = all<any>(d.db, `SELECT id, last_sync_at, schedule_minutes FROM sources WHERE enabled = 1 AND kind <> 'push' AND schedule_minutes IS NOT NULL AND schedule_minutes > 0`);
    for (const s of due) {
      const last = s.last_sync_at ? Date.parse(s.last_sync_at) : 0;
      if (Date.now() - last >= s.schedule_minutes * 60_000 && !running.has(s.id)) runSync(d, s.id, null, { tiered: true }).catch(() => {});
    }
  }, 60_000);
  t.unref();
  return t;
}
