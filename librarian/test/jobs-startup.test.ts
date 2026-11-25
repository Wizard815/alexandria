// The job runner, a quick start, and a restart that does not start over.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { startServer, closeOrphans } from '../src/server.ts';
import { Jobs, takeInterrupted } from '../src/core/jobs.ts';
import { openDb, all, one, run } from '../src/core/db.ts';
import { Slice, tick } from '../src/core/yield.ts';
import { memoryState } from '../src/core/memguard.ts';

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Jobs_TrackShowsProgressAndFinishes', async () => {
  const jobs = new Jobs(openDb(':memory:'));
  const seen: string[] = [];
  jobs.onChange((j) => seen.push(`${j.status}:${j.progress.done}`));
  const p = jobs.track({ kind: 'crawl', title: 'A crawl', worldId: 'w1' }, async (ctx) => { ctx.progress(1, 3, 'one'); await tick(); ctx.progress(3, 3, 'three'); return 7; });
  assert.equal(jobs.busy(), 1);
  assert.equal(jobs.list()[0].title, 'A crawl');
  assert.equal(await p, 7);
  assert.equal(jobs.busy(), 0);
  const done = jobs.list()[0];
  assert.equal(done.status, 'done');
  assert.deepEqual(done.progress, { done: 3, total: 3, message: 'three' });
  assert.ok(seen.includes('running:1') && seen.includes('done:3'));
  assert.equal(jobs.running('crawl', 'w1'), false);
});

test('Jobs_CancelStopsAJobThatCanBeStoppedAndNotOneThatCannot', async () => {
  const jobs = new Jobs(null);
  let stoppedByHook = false;
  const a = jobs.track({ kind: 'sync', title: 'Sync', cancel: () => { stoppedByHook = true; } }, async (ctx) => { while (!ctx.signal.aborted) await tick(); });
  const id = jobs.list()[0].id;
  assert.equal(jobs.cancel(id), true);
  await a;
  assert.equal(stoppedByHook, true);
  assert.equal(jobs.get(id)?.status, 'cancelled');
  let release!: () => void;
  const b = jobs.track({ kind: 'rebuild', title: 'Copies', cancellable: false }, () => new Promise<void>((r) => { release = r; }));
  const id2 = jobs.list()[0].id;
  assert.equal(jobs.cancel(id2), false, 'a rebuild is never left half done');
  release();
  await b;
  assert.equal(jobs.get(id2)?.status, 'done');
  await assert.rejects(jobs.track({ kind: 'x', title: 'Fails' }, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(jobs.list()[0].status, 'error');
  assert.equal(jobs.list()[0].error, 'boom');
});

test('Jobs_AJobRunningAtStopIsFoundAgainAtStart', async () => {
  const db = openDb(':memory:');
  const jobs = new Jobs(db);
  let release!: () => void;
  void jobs.track({ kind: 'crawl', title: 'Crawl', worldId: 'w9', resume: { worldId: 'w9', mode: 'crawl', full: true } }, () => new Promise<void>((r) => { release = r; }));
  void jobs.track({ kind: 'embeddings', title: 'Not resumable' }, () => new Promise<void>(() => {}));
  const taken = takeInterrupted(db); // what a new process finds
  assert.equal(taken.length, 1, 'only a job that said how to start again');
  assert.deepEqual(taken[0].params, { worldId: 'w9', mode: 'crawl', full: true });
  assert.equal(one<any>(db, `SELECT status FROM jobs WHERE id = ?`, taken[0].id).status, 'interrupted');
  assert.equal(takeInterrupted(db).length, 0, 'taken once');
  release();
});

test('Yield_ASliceGivesTheLoopBackAndTheLoopStaysQuick', async () => {
  let worst = 0;
  let last = performance.now();
  const t = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last - 5); last = n; }, 5);
  const slice = new Slice(10);
  let yields = 0;
  const until = performance.now() + 300;
  while (performance.now() < until) { for (let i = 0; i < 20000; i++) Math.sqrt(i); if (await slice.maybe()) yields++; }
  clearInterval(t);
  assert.ok(yields > 5, 'it yielded');
  assert.ok(worst < 80, `the loop was never held for long (worst ${Math.round(worst)} ms)`);
});

test('Memory_StateReportsTheHeapAgainstItsLimit', () => {
  const m = memoryState({ ALX_MEMORY_MB: '1' });
  assert.equal(m.limitMb, 1);
  assert.equal(m.level, 'critical');
  assert.equal(memoryState({ ALX_MEMORY_MB: '100000' }).level, 'ok');
});

async function prepareOldDatabase(file: string, dataDir: string) {
  const made = createApp({ dbFile: file, dataDir, noScheduler: true, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (p: string, token: string | null, body: unknown) => (await (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json()) as any;
  const setup = await post('/api/setup', null, { username: 'wizard', password: 'correct horse battery' });
  const world = await post('/api/admin/worlds', setup.token, { name: 'Old World', dmAccountId: setup.account.id });
  for (let i = 0; i < 30; i++) made.deps.library.save(world.id, { path: `Page ${i}.md`, title: `Page ${i}`, body: `# Page ${i}\n\nText of page ${i}. [[Page ${(i + 1) % 30}]]`, visibility: i % 2 ? 'party' : 'dm' }, null, { batch: true });
  made.deps.library.rebuildPlayerCopies(world.id);
  // An old database: no version marker for the copies.
  run(made.deps.db, `DELETE FROM search_meta WHERE key = 'levels_version'`);
  // A crawl and a rebuild that were running when the process died.
  run(made.deps.db, `INSERT INTO connections_crawls (id, world_id, mode, status, started_at) VALUES ('crl_dead', ?, 'crawl', 'running', ?)`, world.id, new Date().toISOString());
  run(made.deps.db, `INSERT INTO jobs (id, kind, title, world_id, params, status, started_at, updated_at) VALUES ('job_dead', 'rebuild', 'Updating the player copies', ?, ?, 'running', ?, ?)`, world.id, JSON.stringify({ worldId: world.id }), new Date().toISOString(), new Date().toISOString());
  server.close();
  server.closeAllConnections?.();
  made.deps.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  made.deps.db.close();
  return { worldId: world.id as string, admin: setup.token as string };
}

test('Startup_ListensFirstSaysWarmingThenOkAndFinishesWhatAStopLeftHalfDone', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-start-'));
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, 'librarian.db');
  const old = await prepareOldDatabase(file, path.join(tmp, 'data'));
  const t0 = performance.now();
  const s = await startServer({ port: 0, dbFile: file, dataDir: path.join(tmp, 'data'), noScheduler: true, quiet: true, env: { ALX_RATE_LIMIT: '0' } });
  cleanups.push(() => { s.server.close(); s.server.closeAllConnections?.(); });
  const base = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`;
  const listenedIn = performance.now() - t0;
  const h1 = await (await fetch(`${base}/health`)).json() as any;
  assert.equal(h1.warming, true, 'right after listening the server says it is warming up');
  assert.equal(h1.status, 'warming');
  assert.ok(listenedIn < 2000, `it listened first (${Math.round(listenedIn)} ms)`);
  // The copies were cleared at once (nothing stale can be read), and are made again in the background.
  await s.warm;
  const h2 = await (await fetch(`${base}/health`)).json() as any;
  assert.equal(h2.status, 'ok');
  assert.equal(h2.warming, false);
  assert.equal(one<any>(s.deps.db, `SELECT count(*) AS n FROM pages WHERE ai_body IS NULL`).n, 0, 'every page has its copies again');
  assert.equal(one<any>(s.deps.db, `SELECT count(*) AS n FROM pages WHERE visibility = 'party' AND player_body IS NULL`).n, 0);
  assert.equal(one<any>(s.deps.db, `SELECT value FROM search_meta WHERE key = 'levels_version'`).value, '1', 'the version is recorded when the rebuild is done');
  // What was running when the process died is over, and the rebuild was started again.
  assert.equal(one<any>(s.deps.db, `SELECT status FROM connections_crawls WHERE id = 'crl_dead'`).status, 'stopped');
  assert.equal(one<any>(s.deps.db, `SELECT status FROM jobs WHERE id = 'job_dead'`).status, 'interrupted');
  await sleep(50);
  while (s.deps.jobs.busy()) await sleep(20);
  assert.ok(s.deps.jobs.list().some((j) => j.kind === 'rebuild' && j.status === 'done'), 'the rebuild ran again');
  // The admin page's list.
  const jobs = await (await fetch(`${base}/api/admin/jobs`, { headers: { Authorization: `Bearer ${old.admin}` } })).json() as any;
  assert.equal(jobs.busy, 0);
  assert.ok(Array.isArray(jobs.jobs) && jobs.memory.heapMb > 0);
  assert.equal((await fetch(`${base}/api/admin/jobs`)).status, 401);
  void all; void closeOrphans;
});

test('Startup_AServerBusyWithAJobStillAnswersHealthAtOnce', async () => {
  const made = createApp({ noScheduler: true, env: { ALX_RATE_LIMIT: '0' } });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  cleanups.push(() => { server.close(); server.closeAllConnections?.(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let release!: () => void;
  void made.deps.jobs.track({ kind: 'crawl', title: 'Busy' }, () => new Promise<void>((r) => { release = r; }));
  const h = await (await fetch(`${base}/health`)).json() as any;
  assert.equal(h.status, 'ok');
  assert.equal(h.busyJobs, 1);
  release();
});
