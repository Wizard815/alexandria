// Regression guard for "very slow, and the server goes offline when something big happens on the admin side".
// Skipped unless PERF=1 (it builds a world with a thousand pages and runs a full crawl with embeddings):
//
//   PERF=1 npm test -- test/perf.test.ts        (or: PERF=1 node --experimental-strip-types --test test/perf.test.ts)
//
// While a full crawl (700 LegendKeeper pages through the intake path, then embeddings of every page) and a transcript pass run, the event
// loop must stay free (p99 delay under 200 ms) and the calls players make all the time must stay quick (p95 under 400 ms). The numbers
// of a bigger world, before and after the fixes, come from scripts/bigworld.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createApp } from '../src/app.ts';
import { run } from '../src/core/db.ts';
import { LK_CFG, MODEL_BASE, makeMocks, paragraph, rng } from '../scripts/bigworld-mocks.ts';
import { rulesPass } from '../src/features/audio/rulescheck.ts';

const PERF = process.env.PERF === '1';
const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };

test('Perf_TheLoopStaysFreeAndCallsStayQuickWhileAFullCrawlRuns', { skip: !PERF, timeout: 600_000 }, async () => {
  const mock = makeMocks(700);
  mock.latency.lk = 2;
  mock.latency.embed = 20;
  mock.latency.chat = 30;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-perf-'));
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const env: Record<string, string | undefined> = { ALX_RATE_LIMIT: '0', ALX_CRAWL_RATE: '0', ALX_ADMIN_TABLE_LOGIN: '1', ALX_MODEL_EXTRA_URL: MODEL_BASE, ALX_MODEL_EXTRA_MODEL: 'embed', ALX_MODEL_CHAT_URL: MODEL_BASE, ALX_MODEL_CHAT_MODEL: 'chat' };
  const made = createApp({ dbFile: path.join(tmp, 'perf.db'), dataDir: path.join(tmp, 'data'), noScheduler: true, fetch: mock.fetch, env });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  cleanups.push(() => { server.close(); server.closeAllConnections?.(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, token: string | null, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j: any = await r.json().catch(() => ({}));
    return { status: r.status, body: j };
  };
  const setup = (await call('POST', '/api/setup', null, { username: 'wizard', password: 'correct horse battery' })).body;
  const admin = setup.token as string;
  const wid = (await call('POST', '/api/admin/worlds', admin, { name: 'Perf', dmAccountId: setup.account.id })).body.id as string;
  const inv = (await call('POST', `/api/worlds/${wid}/invites`, admin, { role: 'player' })).body;
  const player = (await call('POST', '/api/join', null, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' })).body.token as string;
  const r = rng(3);
  for (let i = 0; i < 1000; i++) made.deps.library.save(wid, { path: `Atlas/Area ${i % 20}/Page ${i}.md`, title: `Page ${i}`, body: `# Page ${i}\n\n${paragraph(r, 8)}\n\nSee [[Page ${(i * 7) % 1000}]] and [[Page ${(i * 13) % 1000}]].\n\n${paragraph(r, 6)}`, visibility: i % 3 ? 'dm' : 'party' }, null, { batch: true });
  await made.deps.library.rebuildPlayerCopiesAsync(wid);
  // A night's transcript with a session still open.
  run(made.deps.db, 'INSERT INTO audio_sessions (id, world_id, name, started_at) VALUES (?, ?, ?, ?)', 's1', wid, 'Tonight', new Date().toISOString());
  made.deps.db.exec('BEGIN');
  for (let i = 0; i < 6000; i++) run(made.deps.db, 'INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_label, text, audience, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', `l${i}`, 's1', wid, i * 3000, i * 3000 + 2000, 'Jess', `${paragraph(r, 1)} Fireball and the warden.`, 'players', new Date(Date.now() - 6000 * 1000 + i * 1000).toISOString());
  made.deps.db.exec('COMMIT');
  const src = (await call('POST', `/api/admin/worlds/${wid}/sources`, admin, { kind: 'legendkeeper-api', name: 'Lore', config: LK_CFG, defaultVisibility: 'party' })).body;
  assert.ok(src.id, 'source made');

  const pages: any[] = (await call('GET', `/api/worlds/${wid}/library/pages`, player)).body;
  const ids = pages.slice(0, 40).map((p) => p.id);
  const lat: number[] = [];
  const hist = monitorEventLoopDelay({ resolution: 5 });
  hist.enable();
  const crawl = (await call('POST', `/api/admin/worlds/${wid}/crawl`, admin, { full: true })).body;
  assert.ok(crawl.id, 'crawl started');
  let finished = false;
  const poll = (async () => { for (;;) { const c = (await call('GET', `/api/admin/crawls/${crawl.id}`, admin)).body; if (c.status !== 'running') { finished = true; return c; } await new Promise((x) => setTimeout(x, 200)); } })();
  // A transcript pass while it runs (it walks every line of the session).
  const pass = rulesPass(made.deps, wid, 's1');
  const probes = [
    () => call('GET', `/api/worlds/${wid}`, player), () => call('GET', `/api/worlds/${wid}/library/pages`, player), () => call('GET', `/api/worlds/${wid}/library/pages/${ids[Math.floor(Math.random() * ids.length)]}`, player),
    () => call('GET', `/api/worlds/${wid}/search?q=warden&limit=20`, player), () => call('GET', `/api/worlds/${wid}/live`, player),
  ];
  const clients = [0, 1].map(async (c) => { for (let i = c; !finished; i++) { const t0 = performance.now(); await probes[i % probes.length](); lat.push(performance.now() - t0); await new Promise((x) => setTimeout(x, 5)); } });
  const done = await poll;
  await Promise.all([...clients, pass]);
  hist.disable();
  const ms = (n: number) => n / 1e6;
  const loopP99 = ms(hist.percentile(99));
  const apiP95 = pct(lat, 95);
  console.log(`crawl ${done.status}: ${done.progress.saved} pages, ${lat.length} calls, api p50 ${Math.round(pct(lat, 50))} p95 ${Math.round(apiP95)} max ${Math.round(Math.max(...lat))} ms, loop p99 ${Math.round(loopP99)} max ${Math.round(ms(hist.max))} ms`);
  assert.equal(done.status, 'ok');
  assert.ok(lat.length > 20, 'the calls ran while the crawl did');
  assert.ok(loopP99 < 200, `the event loop's p99 delay stayed under 200 ms (was ${Math.round(loopP99)} ms)`);
  assert.ok(apiP95 < 400, `the calls' p95 stayed under 400 ms (was ${Math.round(apiP95)} ms)`);
  assert.ok(ms(hist.max) < 1500, `no single block over 1.5 s (was ${Math.round(ms(hist.max))} ms)`);
});
