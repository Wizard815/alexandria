// Builds a realistic big world and measures the librarian against it.
//
//   node --experimental-strip-types librarian/scripts/bigworld.ts build --data /tmp/bigworld
//   node --experimental-strip-types librarian/scripts/bigworld.ts bench --data /tmp/bigworld --out results.json
//   node --experimental-strip-types librarian/scripts/bigworld.ts all   --data /tmp/bigworld
//
// build   ~3000 library pages with links and pictures, 700 LegendKeeper resources read through the
//         intake path (a fake LegendKeeper), 20 000 transcript lines, 50 MB of uploads, a game module.
// bench   starts the real server on that data (with the fake services), measures the time to /health,
//         then the latency of the calls players and the DM make all the time, first on an idle server
//         and then while each heavy admin job runs: a full crawl, a re-index, a module import, a big
//         upload, the session summary and rules check. Also the event loop delay and memory.
//
// Flags: --pages 3000 --resources 700 --lines 20000 --upload-mb 50 --quick (a tenth of everything)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { LK_CFG, makeMocks, paragraph, rng, sentence } from './bigworld-mocks.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'all';
const arg = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = (n: string) => argv.includes(`--${n}`);
const quick = flag('quick');
const N = {
  pages: Number(arg('pages', quick ? '300' : '3000')),
  resources: Number(arg('resources', quick ? '70' : '700')),
  lines: Number(arg('lines', quick ? '2000' : '20000')),
  uploadMb: Number(arg('upload-mb', quick ? '5' : '50')),
};
const dataDir = path.resolve(arg('data', '/tmp/bigworld'));
const outFile = arg('out', '');
const port = Number(arg('port', '8490'));
const base = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const metaFile = path.join(dataDir, 'bigworld.json');

// ---------------------------------------------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------------------------------------------

async function build() {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const { createApp } = await import('../src/app.ts');
  const { all, run, one } = await import('../src/core/db.ts');
  const { readPages } = await import('../src/intake/detail.ts');
  const mock = makeMocks(N.resources);
  mock.latency.lk = 0;
  const env: Record<string, string | undefined> = { ALX_DATA_DIR: dataDir, ALX_RATE_LIMIT: '0', ALX_CRAWL_RATE: '0', ALX_ADMIN_TABLE_LOGIN: '1' };
  const { app, deps } = createApp({ dbFile: path.join(dataDir, 'librarian.db'), dataDir, noScheduler: true, fetch: mock.fetch, env });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, p: string, token: string | null, body?: unknown) => {
    // A pass of the server that blocks for seconds closes idle sockets: try again on a fresh one.
    let r!: Response;
    for (let attempt = 0; ; attempt++) {
      try { r = await fetch(url + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); break; } catch (e) { if (attempt >= 3) throw e; await sleep(200); }
    }
    const text = await r.text();
    let j: any = text;
    try { j = JSON.parse(text); } catch { /* text */ }
    if (r.status >= 300) throw new Error(`${method} ${p} -> ${r.status} ${text.slice(0, 200)}`);
    return j;
  };
  const t = (label: string, t0: number) => console.log(`  ${label}: ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  console.log(`building a world in ${dataDir}`, N);
  const setup = await call('POST', '/api/setup', null, { username: 'wizard', password: 'correct horse battery' });
  const admin = setup.token as string;
  const wid = (await call('POST', '/api/admin/worlds', admin, { name: 'Big World', dmAccountId: setup.account.id })).id as string;
  const inv = await call('POST', `/api/worlds/${wid}/invites`, admin, { role: 'player' });
  const joined = await call('POST', '/api/join', null, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' });

  // Library pages: nested folders, links to other pages, pictures, a mix of levels.
  let t0 = performance.now();
  const r = rng(7);
  const titles: string[] = [];
  for (let i = 0; i < N.pages; i++) titles.push(`Page ${i + 1} ${sentence(r, 2).replace('.', '')}`);
  for (let i = 0; i < N.pages; i++) {
    const links = Array.from({ length: 4 + Math.floor(r() * 6) }, () => `[[${titles[Math.floor(r() * N.pages)]}]]`);
    const body = [`# ${titles[i]}`, paragraph(r, 6), `![map](https://img.example/maps/${i}.png)`, paragraph(r, 5), `See also ${links.join(', ')}.`, paragraph(r, 7), `![portrait](https://img.example/people/${i}.jpg)`, paragraph(r, 6), paragraph(r, 5)].join('\n\n');
    const roll = r();
    const visibility = roll < 0.3 ? 'party' : roll < 0.9 ? 'dm' : roll < 0.95 ? 'broker' : 'classified';
    deps.library.save(wid, { path: `Atlas/Region ${i % 40}/Area ${i % 7}/${titles[i]}.md`, title: titles[i], body, frontmatter: { tags: [i % 2 ? 'place' : 'person'], aliases: [`Alias ${i}`], ...(i % 5 === 0 ? { related: [`[[${titles[(i + 1) % N.pages]}]]`] } : {}) }, visibility }, null, { batch: true });
  }
  t(`${N.pages} pages saved`, t0);
  t0 = performance.now();
  deps.library.rebuildPlayerCopies(wid);
  t('player copies rebuilt (one pass over every page)', t0);

  // A game module, so the rules check has terms to find.
  const terms = Array.from({ length: 400 }, (_, i) => ({ term: ['Fireball', 'Grappled', 'Opportunity Attack', 'Shield', 'Counterspell', 'Prone'][i % 6] + (i >= 6 ? ` ${i}` : ''), kind: i % 3 ? 'spell' : 'rule', text: paragraph(r, 4), aliases: [] }));
  await call('POST', `/api/worlds/${wid}/modules/import`, admin, { type: 'json', json: { id: 'bigsrd', name: 'Big SRD', terms } });

  // LegendKeeper: the intake path (list, then read every page), through the fake site.
  t0 = performance.now();
  const src = await call('POST', `/api/admin/worlds/${wid}/sources`, admin, { kind: 'legendkeeper-api', name: 'Lore', config: LK_CFG, defaultVisibility: 'party' });
  await call('POST', `/api/admin/sources/${src.id}/sync?wait=1`, admin, {});
  const srow = one<any>(deps.db, 'SELECT * FROM sources WHERE id = ?', src.id);
  const pending = all<any>(deps.db, `SELECT id, external_id FROM pages WHERE source_id = ? AND depth <> 'full'`, src.id);
  for (let i = 0; i < pending.length; i += 50) await readPages({ db: deps.db, library: deps.library, dataDir, vaultsDir: null, fetch: mock.fetch, env }, srow, pending.slice(i, i + 50));
  t(`${N.resources} LegendKeeper resources listed and read (${mock.stats.lk} calls)`, t0);

  // Transcript: sessions of a long night each; the last one is still recording.
  t0 = performance.now();
  const sessions = 8;
  const per = Math.ceil(N.lines / sessions);
  const speakers = ['Dungeon Master', 'Jess', 'Ari', 'Bo', 'Cass'];
  const words = ['Fireball', 'grappled', 'the warden', 'opportunity attack', 'roll initiative', 'the gate', 'a shield', 'counterspell', 'the oath', 'prone'];
  const dmAcct = setup.account.id as string;
  deps.db.exec('BEGIN');
  for (let s = 0; s < sessions; s++) {
    const sid = `bws_${s}`;
    const started = new Date(Date.now() - (sessions - s) * 86400_000).toISOString();
    run(deps.db, 'INSERT INTO audio_sessions (id, world_id, name, started_at, started_by, stopped_at) VALUES (?, ?, ?, ?, ?, ?)', sid, wid, `Session ${s + 1}`, started, dmAcct, s === sessions - 1 ? null : new Date(Date.parse(started) + 3 * 3600_000).toISOString());
    for (let i = 0; i < per; i++) {
      const text = `${sentence(r, 6 + Math.floor(r() * 10)).replace('.', '')} ${words[Math.floor(r() * words.length)]} ${sentence(r, 4)}`;
      run(deps.db, 'INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_account, speaker_label, text, words, sources, audience, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        `bwl_${s}_${i}`, sid, wid, i * 4000, i * 4000 + 3000, i % 5 === 0 ? dmAcct : null, speakers[i % 5], text, '[]', '[]', i % 4 === 0 ? 'dm' : 'party', new Date(Date.parse(started) + i * 4000).toISOString());
    }
  }
  deps.db.exec('COMMIT');
  t(`${sessions * per} transcript lines`, t0);

  // Uploads: pictures kept in the database.
  t0 = performance.now();
  const chunk = 2 * 1024 * 1024;
  for (let i = 0; i < Math.ceil((N.uploadMb * 1024 * 1024) / chunk); i++) {
    run(deps.db, 'INSERT INTO uploads (id, world_id, mime, size, data, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)', `bwu_${i}`, wid, 'image/png', chunk, Buffer.alloc(chunk, i % 251), dmAcct, new Date().toISOString());
  }
  t(`${N.uploadMb} MB of uploads`, t0);

  // A few thousand items and ledger rows, like a long campaign.
  fs.writeFileSync(metaFile, JSON.stringify({ admin, player: joined.token, world: wid, source: src.id, session: `bws_${sessions - 1}`, N }, null, 2));
  deps.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  server.close();
  server.closeAllConnections?.();
  const size = (f: string) => (fs.existsSync(f) ? Math.round(fs.statSync(f).size / 1048576) : 0);
  console.log(`database ${size(path.join(dataDir, 'librarian.db'))} MB, pages ${one<any>(deps.db, 'SELECT count(*) AS n FROM pages')!.n}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------
// bench
// ---------------------------------------------------------------------------------------------------------------

const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10; };
const sum = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: pct(xs, 100) });

async function bench() {
  if (!fs.existsSync(metaFile)) throw new Error('No world here: run `build` first');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const { admin, player, world: wid } = meta;
  const results: any = { when: new Date().toISOString(), counts: meta.N, node: process.version };
  // A copy of the data, so every run starts from the same world.
  const work = `${dataDir}-run`;
  fs.rmSync(work, { recursive: true, force: true });
  fs.cpSync(dataDir, work, { recursive: true });

  const nodeArgs = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', ...(process.env.BW_NODE_ARGS ? process.env.BW_NODE_ARGS.split(' ') : []), path.join(here, 'bigworld-server.ts'), '--data', work, '--port', String(port), '--resources', String(meta.N.resources), '--models', 'off'];
  const spawnedAt = performance.now();
  const child = spawn(process.execPath, nodeArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production' } });
  let log = '';
  child.stdout.on('data', (b) => { log += b; });
  child.stderr.on('data', (b) => { log += b; });
  const stop = async () => { child.kill('SIGTERM'); await sleep(300); };
  process.on('exit', () => child.kill('SIGKILL'));
  try {
    // Startup: until /health answers ok.
    let up = 0;
    let health: any = null;
    let firstAny = 0;
    while (performance.now() - spawnedAt < 180_000) {
      try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
        if (!firstAny) firstAny = performance.now() - spawnedAt;
        if (r.status === 200) { health = await r.json(); up = performance.now() - spawnedAt; break; }
      } catch { /* not listening yet */ }
      await sleep(25);
    }
    if (!up) throw new Error('The server never answered /health:\n' + log.slice(-2000));
    results.startup = { toFirstAnswerMs: Math.round(firstAny), toHealthOkMs: Math.round(up), health };
    console.log(`startup: /health answered after ${Math.round(up)} ms`, health?.status ?? '');
    // A server that answers while it warms up is ready when its body says so. Wait for it, and say how long it took.
    let ready = up;
    while (health && (health.warming || health.status === 'warming') && performance.now() - spawnedAt < 300_000) {
      await sleep(250);
      try { health = await (await fetch(`${base}/health`)).json(); } catch { /* retry */ }
      ready = performance.now() - spawnedAt;
    }
    results.startup.toReadyMs = Math.round(ready);
    await sleep(500);

    const A = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
    const get = async (p: string, token: string) => { const r = await fetch(base + p, { headers: A(token) }); const b = await r.arrayBuffer(); return { status: r.status, bytes: b.byteLength }; };
    const w = `/api/worlds/${wid}`;
    const pages: any[] = await (await fetch(`${base}${w}/library/pages`, { headers: A(admin) })).json();
    const ids = pages.filter((_, i) => i % Math.max(1, Math.floor(pages.length / 60)) === 0).map((p) => p.id);
    const playerPages: any[] = await (await fetch(`${base}${w}/library/pages`, { headers: A(player) })).json();
    const pids = playerPages.slice(0, 40).map((p) => p.id);
    results.pageCounts = { dm: pages.length, player: playerPages.length };

    // The calls a table makes all the time.
    const probes: { name: string; run: () => Promise<number> }[] = [
      { name: 'health', run: () => timed(() => get('/health', admin)) },
      { name: 'world info', run: () => timed(() => get(w, player)) },
      { name: 'library tree (DM)', run: () => timed(() => get(`${w}/library/pages`, admin)) },
      { name: 'library tree (player)', run: () => timed(() => get(`${w}/library/pages`, player)) },
      { name: 'page read (DM)', run: () => timed(() => get(`${w}/library/pages/${ids[Math.floor(Math.random() * ids.length)]}`, admin)) },
      { name: 'page read (player)', run: () => timed(() => get(`${w}/library/pages/${pids[Math.floor(Math.random() * pids.length)]}`, player)) },
      { name: 'search', run: () => timed(() => get(`${w}/search?q=${['warden', 'ember crown', 'river', 'oath'][Math.floor(Math.random() * 4)]}&limit=20`, player)) },
      { name: 'library search', run: () => timed(() => get(`${w}/library/search?q=lantern`, admin)) },
      { name: 'live', run: () => timed(() => get(`${w}/live`, player)) },
      { name: 'events connect', run: () => sseConnect(`${base}${w}/events`, player) },
    ];
    const timed = async (f: () => Promise<{ status: number }>) => { const t0 = performance.now(); const r = await f(); if (r.status >= 500) throw new Error(`HTTP ${r.status}`); return performance.now() - t0; };
    const sseConnect = async (u: string, token: string) => {
      const t0 = performance.now();
      const ctl = new AbortController();
      const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
      const reader = r.body!.getReader();
      await reader.read();
      const ms = performance.now() - t0;
      ctl.abort();
      return ms;
    };

    /** Run every probe in turn, over and over, with `clients` loops side by side, until `until()` says stop. */
    const probeWhile = async (until: () => boolean, clients = 3, minMs = 4000) => {
      const lat: Record<string, number[]> = Object.fromEntries(probes.map((p) => [p.name, []]));
      const errors: Record<string, number> = {};
      const startedAt = performance.now();
      await Promise.all(Array.from({ length: clients }, async (_, c) => {
        for (let i = c; performance.now() - startedAt < minMs || !until(); i++) {
          const p = probes[i % probes.length];
          try { lat[p.name].push(await Promise.race([p.run(), sleep(30_000).then(() => { throw new Error('timeout'); })])); } catch (e: any) { errors[p.name] = (errors[p.name] ?? 0) + 1; lat[p.name].push(30_000); }
          if (performance.now() - startedAt > 600_000) break;
        }
      }));
      return { lat: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, sum(v)])), errors, all: sum(Object.values(lat).flat()) };
    };
    const perf = async (reset = false) => (await fetch(`${base}/__perf${reset ? '?reset=1' : ''}`)).json() as Promise<any>;
    const post = async (p: string, token: string, body?: unknown, raw?: BodyInit, headers: Record<string, string> = {}) => {
      const r = await fetch(base + p, { method: 'POST', headers: raw ? { Authorization: `Bearer ${token}`, ...headers } : A(token), body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
      const text = await r.text();
      let j: any = text; try { j = JSON.parse(text); } catch { /* text */ }
      return { status: r.status, body: j };
    };

    const scenarios: Record<string, any> = {};
    const scenario = async (name: string, start: () => Promise<() => boolean | Promise<boolean>>, clients = 3, cap = 150_000) => {
      console.log(`scenario: ${name}`);
      await perf(true);
      const t0 = performance.now();
      let finished = !start;
      let done: () => boolean | Promise<boolean> = () => true;
      let doneNow = false;
      let doneAt = 0;
      done = await start();
      const poll = (async () => { while (!doneNow) { if (await done()) { doneNow = true; doneAt = performance.now() - t0; } else await sleep(150); } })();
      const probed = await probeWhile(() => doneNow || performance.now() - t0 > cap, clients);
      const timedOut = !doneNow;
      if (timedOut) doneNow = true;
      await poll;
      // A job that outlasts the cap is waited for (up to 20 minutes) so the next scenario starts from a quiet server.
      let totalMs = 0;
      if (timedOut) {
        while (performance.now() - t0 < 1_200_000) { try { if (await done()) break; } catch { /* the server is busy */ } await sleep(2000); }
        totalMs = Math.round(performance.now() - t0);
      }
      const p = await perf();
      scenarios[name] = { jobMs: timedOut ? -1 : Math.round(doneAt), timedOut, totalMs, api: probed.all, calls: probed.lat, errors: probed.errors, loop: p.loop, mem: p.mem, mock: p.mock };
      const a = probed.all;
      console.log(`  job ${timedOut ? 'NOT FINISHED in ' + Math.round(cap / 1000) + ' s (took ' + Math.round(totalMs / 1000) + ' s)' : Math.round(doneAt) + ' ms'} | api p50 ${a.p50} p95 ${a.p95} p99 ${a.p99} max ${a.max} ms | loop p99 ${p.loop.p99} max ${p.loop.max} gap ${p.loop.maxGap} ms | rss peak ${p.mem.peakRssMb} MB`);
      void finished;
      await sleep(1500);
    };

    await post(`/__perf/session?open=0&id=${meta.session}`, admin);
    await scenario('idle', async () => { const end = performance.now() + 5000; return () => performance.now() > end; });

    await scenario('crawl (full, sources then embeddings)', async () => {
      await post('/__perf/models?on=1', admin);
      const s = await post(`/api/admin/worlds/${wid}/crawl`, admin, { full: true });
      if (s.status >= 300) throw new Error(JSON.stringify(s));
      return async () => { const c = await (await fetch(`${base}/api/admin/crawls/${s.body.id}`, { headers: A(admin) })).json(); return c.status !== 'running'; };
    });

    await scenario('crawl (sources only, no model)', async () => {
      await post('/__perf/models?on=0', admin);
      const s = await post(`/api/admin/worlds/${wid}/crawl`, admin, { full: true });
      if (s.status >= 300) throw new Error(JSON.stringify(s));
      return async () => { const c = await (await fetch(`${base}/api/admin/crawls/${s.body.id}`, { headers: A(admin) })).json(); return c.status !== 'running'; };
    });

    await scenario('re-index (embeddings, from scratch)', async () => {
      await post('/__perf/models?on=1', admin);
      const s = await post(`/api/admin/worlds/${wid}/reindex`, admin);
      if (s.status >= 300) throw new Error(JSON.stringify(s));
      return async () => { const c = await (await fetch(`${base}/api/admin/crawls/${s.body.id}`, { headers: A(admin) })).json(); return c.status !== 'running'; };
    });

    await scenario('module import (6000 terms)', async () => {
      const r = rng(11);
      const terms = Array.from({ length: 6000 }, (_, i) => ({ term: `Term ${i} ${sentence(r, 2).replace('.', '')}`, kind: ['spell', 'monster', 'rule', 'item'][i % 4], text: paragraph(r, 8), aliases: [`T${i}`] }));
      let finished = false;
      void post(`/api/worlds/${wid}/modules/import`, admin, { type: 'json', json: { id: `big-${Date.now()}`, name: 'Big import', terms } }).then((x) => { if (x.status >= 300) console.log('  import answered', x.status, JSON.stringify(x.body).slice(0, 200)); finished = true; });
      return () => finished;
    });

    await scenario(`big upload (${Math.min(45, meta.N.uploadMb)} MB document)`, async () => {
      const bytes = Buffer.alloc(Math.min(45, meta.N.uploadMb) * 1024 * 1024, 'x');
      let finished = false;
      void fetch(`${base}${w}/files?name=bigscan.pdf&kind=other&level=dm&title=Big+Scan`, { method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/pdf' }, body: Buffer.concat([Buffer.from('%PDF-1.4\n'), bytes]) }).then(async (r) => { const t = await r.text(); if (r.status >= 300) console.log('  upload answered', r.status, t.slice(0, 200)); finished = true; });
      return () => finished;
    });

    await scenario('session summary + rules check (long transcript)', async () => {
      await post('/__perf/models?on=1', admin);
      await post(`/__perf/session?open=1&id=${meta.session}`, admin);
      let finished = false;
      void (async () => { for (let i = 0; i < 3; i++) await post('/__perf/audio', admin); finished = true; })();
      return () => finished;
    });

    await post(`/__perf/session?open=0&id=${meta.session}`, admin);
    await scenario('DM overview + embedding status polled (admin page open)', async () => {
      let n = 0;
      let finished = false;
      void (async () => { while (n++ < 12) { await get(`/api/admin/worlds/${wid}/overview`, admin); await get(`${w}/search/status`, admin); await sleep(250); } finished = true; })();
      return () => finished;
    });

    results.scenarios = scenarios;
    results.finalPerf = await perf();
  } finally {
    await stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log('\nsummary (api = player and DM calls made while the job ran)');
  console.log('scenario'.padEnd(58), 'job ms'.padStart(8), 'p50'.padStart(7), 'p95'.padStart(8), 'max'.padStart(8), 'loop p99'.padStart(9), 'loop max'.padStart(9), 'rss MB'.padStart(7));
  for (const [k, s] of Object.entries<any>(results.scenarios)) console.log(k.padEnd(58), String(s.jobMs).padStart(8), String(s.api.p50).padStart(7), String(s.api.p95).padStart(8), String(s.api.max).padStart(8), String(s.loop.p99).padStart(9), String(s.loop.max).padStart(9), String(s.mem.peakRssMb).padStart(7));
  console.log('startup', JSON.stringify(results.startup));
}

if (cmd === 'build') await build();
else if (cmd === 'bench') await bench();
else { await new Promise<void>((resolve, reject) => { const c = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), 'build', ...argv.slice(1)], { stdio: 'inherit' }); c.on('exit', (code) => (code ? reject(new Error('build failed')) : resolve())); }); await bench(); }
