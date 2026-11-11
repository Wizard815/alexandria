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
import type { ConnectorContext } from './connector.ts';
import { connectorFor, makeMcpFactory } from './registry.ts';

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
}

const running = new Map<string, AbortController>();

export function isRunning(sourceId: string) {
  return running.has(sourceId);
}

export function stopSync(sourceId: string) {
  running.get(sourceId)?.abort();
}

function prefixFor(kind: string, name: string): string | null {
  if (['markdown-folder', 'git', 'mcp-files', 'vault'].includes(kind)) return null; // keep the vault's own layout
  return String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || kind;
}

/** Make the context a connector runs with. */
export function connectorContext(d: SyncDeps, src: any, cfg: any, signal: AbortSignal, log: (m: string) => void) {
  const c = connectorFor(src.kind, cfg);
  if (!c) throw new HttpError(400, `Unknown source kind: ${src.kind}`);
  const mcp = makeMcpFactory(c, cfg, d.env, d.fetch, d.mcp);
  const ctx: ConnectorContext = {
    fetch: d.fetch, env: d.env, dataDir: d.dataDir, vaultsDir: d.vaultsDir, signal, log,
    mcp: mcp.factory, sourceId: src.id, shareVisible: src.default_visibility === 'party',
  };
  return { c, ctx, close: mcp.close };
}

/** Sync one source. Resolves with the finished run. */
export async function runSync(d: SyncDeps, sourceId: string, by: string | null): Promise<any> {
  const src = one<any>(d.db, 'SELECT * FROM sources WHERE id = ?', sourceId);
  if (!src) throw new HttpError(404, 'Source not found');
  if (running.has(sourceId)) throw new HttpError(409, 'This source is already syncing');
  const cfg = JSON.parse(src.config || '{}');
  const runId = id('run_');
  const lines: string[] = [];
  const log = (m: string) => { lines.push(`${new Date().toISOString().slice(11, 19)} ${m}`); if (lines.length > 500) lines.splice(0, lines.length - 500); };
  const stats = { pages: 0, shared: 0, dmOnly: 0, removed: 0, skipped: 0 };
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
    for await (const e of made.c.sync(cfg, made.ctx)) {
      if (ctl.signal.aborted) throw new Error('Sync stopped');
      if (!e?.externalId || seen.has(e.externalId)) { stats.skipped++; continue; }
      seen.add(e.externalId);
      try {
        d.library.saveEntry(src.world_id, src.id, prefix, e, by);
        stats.pages++;
        if (e.visibility === 'party') stats.shared++; else stats.dmOnly++;
      } catch (err: any) {
        stats.skipped++;
        log(`Skipped ${e.title}: ${err.message}`);
      }
      if (stats.pages % 50 === 0) { save('running'); d.onProgress?.(runId, stats); }
    }
    // Only a complete listing may delete.
    stats.removed = d.library.removeMissing(src.world_id, src.id, seen);
    log(`Saved ${stats.pages} pages (${stats.shared} shared, ${stats.dmOnly} DM-only), removed ${stats.removed}`);
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
    const due = all<any>(d.db, `SELECT id, last_sync_at, schedule_minutes FROM sources WHERE enabled = 1 AND schedule_minutes IS NOT NULL AND schedule_minutes > 0`);
    for (const s of due) {
      const last = s.last_sync_at ? Date.parse(s.last_sync_at) : 0;
      if (Date.now() - last >= s.schedule_minutes * 60_000 && !running.has(s.id)) runSync(d, s.id, null).catch(() => {});
    }
  }, 60_000);
  t.unref();
  return t;
}
