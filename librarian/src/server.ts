// Starting the server: do the least before listening, the rest after, in the background.
//
//   before listen   open the database and make the tables (createApp), clear what a crash left "running"
//   after listen    /health answers at once (200, status "warming" until this is done), then, one step at a time with the loop free between:
//                     1. finish the versioned rebuild of the page copies, and rebuild pages a stop left without copies
//                     2. start again the jobs that were running when the server stopped (a crawl, a sync, a rebuild)
//                     3. warm the caches the first search or model request would otherwise build while somebody waits
//
// A memory guard watches the heap; see core/memguard.ts.
import type { Server } from 'node:http';
import { createApp, type AppOptions, type Deps } from './app.ts';
import { all, run } from './core/db.ts';
import { takeInterrupted } from './core/jobs.ts';
import { BULK_KIND, startBulkBuild } from './features/search/bulkbuild.ts';
import { startMemoryGuard } from './core/memguard.ts';
import { now } from './core/util.ts';
import { tick } from './core/yield.ts';
import { startCrawl } from './features/connections/crawl.ts';
import { closeStaleSessions } from './features/audio/summary.ts';
import { vectorStore } from './features/search/vectorstore.ts';
import { runSync } from './intake/sync.ts';
import { VEC_SCOPES } from './features/search/scopes.ts';

export interface StartOptions extends AppOptions {
  port: number;
  host?: string;
  /** Another Express app mounted in front (the load bench's /__perf). */
  extra?: { use: (...a: any[]) => any; listen: (...a: any[]) => any };
  quiet?: boolean;
  onListening?: () => void;
}

/** What a crash or a kill left half done: crawls and syncs still marked running are over (the jobs table starts them again). */
export function closeOrphans(d: Pick<Deps, 'db'>) {
  const at = now();
  try { run(d.db, `UPDATE connections_crawls SET status = 'stopped', error = 'The server restarted while this was running', finished_at = ? WHERE status = 'running'`, at); } catch { /* no crawls table */ }
  try { run(d.db, `UPDATE sync_runs SET status = 'stopped', error = 'The server restarted while this was running', finished_at = ? WHERE status = 'running'`, at); } catch { /* no runs table */ }
}

/** Start the jobs that were running when the server stopped, one after another. */
export async function resumeJobs(d: Deps) {
  for (const j of takeInterrupted(d.db)) {
    try {
      if (j.kind === 'crawl' && j.params?.worldId) startCrawl(d, j.params.worldId, { mode: j.params.mode, sourceIds: j.params.sourceIds, by: null, full: !!j.params.full });
      else if (j.kind === 'sync' && j.params?.sourceId) void runSync({ db: d.db, library: d.library, dataDir: d.dataDir, vaultsDir: d.vaultsDir, fetch: d.fetch, env: d.env, mcp: d.testMcp }, j.params.sourceId, null, { tiered: !!j.params.tiered, full: !!j.params.full }).catch(() => {});
      else if (j.kind === BULK_KIND && j.params?.worldId) startBulkBuild(d, j.params.worldId, { embeddings: !!j.params.embeddings, bible: !!j.params.bible });
      else if (j.kind === 'rebuild' && j.params?.worldId) void d.library.rebuildPlayerCopiesAsync(j.params.worldId).catch(() => {});
      else continue;
      console.log(`Resumed: ${j.title}`);
    } catch (err: any) { console.warn(`Could not resume "${j.title}": ${err?.message ?? err}`); }
    await tick();
  }
}

/** The work after listen. Never throws. */
export async function warmUp(d: Deps) {
  const phase = (p: string) => { d.startup.phase = p; };
  try {
    phase('copies');
    await d.library.finishMigrations();
    for (const [worldId, ids] of d.library.pagesWithoutCopies()) await d.library.rebuildPlayerCopiesAsync(worldId, { only: ids.length > 500 ? undefined : ids });
    phase('jobs');
    try { closeStaleSessions(d); } catch { /* the audio feature's tables are not there */ }
    await resumeJobs(d);
    phase('caches');
    // The classified-text index and the vector rows are built on first use; building them now, between requests, keeps the first search quick.
    for (const w of all<{ id: string }>(d.db, 'SELECT id FROM worlds')) {
      d.library.containsClassified(w.id, 'warm up the classified text index');
      await tick();
      for (const scope of VEC_SCOPES) { try { vectorStore(d.db).rows(w.id, scope); } catch { /* no search tables */ } await tick(); }
    }
  } catch (err: any) {
    console.error('Start-up work failed (the server keeps running):', err?.message ?? err);
  } finally {
    d.startup.warming = false;
    d.startup.phase = '';
  }
}

export async function startServer(opts: StartOptions): Promise<{ app: ReturnType<typeof createApp>['app']; deps: Deps; server: Server; warm: Promise<void> }> {
  const { port, host, extra, quiet, onListening, ...appOpts } = opts;
  const { app, deps } = createApp({ ...appOpts, deferMigration: true });
  closeOrphans(deps);
  deps.startup.warming = true;
  deps.startup.phase = 'starting';
  const outer: any = extra ?? app;
  if (extra) extra.use(app);
  const server: Server = await new Promise((resolve) => {
    const s: Server = host ? outer.listen(port, host, () => resolve(s)) : outer.listen(port, () => resolve(s));
  });
  // The client may keep a connection open for long (event streams); a request that takes minutes (an upload, a backup) must not be cut short by Node's defaults.
  server.requestTimeout = 30 * 60_000;
  server.keepAliveTimeout = 65_000;
  if (!quiet) {
    console.log(`Alexandria librarian on :${port} (data in ${opts.dataDir ?? 'memory'})`);
    console.log('First run? POST /api/setup with {username, password} to create the admin.');
  }
  onListening?.();
  startMemoryGuard(deps);
  const warm = warmUp(deps);
  return { app, deps, server, warm };
}
