// The librarian started the way index.ts starts it, but with the fake outside
// services of bigworld-mocks.ts and a /__perf endpoint that reports the event
// loop delay and memory. Started by bigworld.ts; not for real use.
//
//   node --experimental-strip-types scripts/bigworld-server.ts --data DIR --port N
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import express from 'express';
import { LK_CFG, MODEL_BASE, makeMocks } from './bigworld-mocks.ts';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const dataDir = path.resolve(arg('data', '/tmp/bigworld'));
const port = Number(arg('port', '8490'));
const resources = Number(arg('resources', '700'));
void LK_CFG;

const mock = makeMocks(resources);
const env: Record<string, string | undefined> = { ...process.env, ALX_DATA_DIR: dataDir, ALX_RATE_LIMIT: '0', ALX_CRAWL_RATE: '0', ALX_ADMIN_TABLE_LOGIN: '1' };
const modelsOn = () => { env.ALX_MODEL_EXTRA_URL = MODEL_BASE; env.ALX_MODEL_EXTRA_MODEL = 'embed-mock'; env.ALX_MODEL_CHAT_URL = MODEL_BASE; env.ALX_MODEL_CHAT_MODEL = 'chat-mock'; };
const modelsOff = () => { for (const k of ['ALX_MODEL_EXTRA_URL', 'ALX_MODEL_EXTRA_MODEL', 'ALX_MODEL_CHAT_URL', 'ALX_MODEL_CHAT_MODEL', 'MODEL_BASE_URL', 'OPENAI_BASE_URL']) delete env[k]; };
if (arg('models', 'on') === 'on') modelsOn(); else modelsOff();

const hist = monitorEventLoopDelay({ resolution: 5 });
hist.enable();
// A second, plainer gauge: the longest gap between two 5 ms timer ticks.
let last = performance.now();
let maxGap = 0;
setInterval(() => { const t = performance.now(); maxGap = Math.max(maxGap, t - last - 5); last = t; }, 5).unref();
const t0 = performance.now();
let peakRss = 0;
setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 200).unref();

const dbFile = path.join(dataDir, 'librarian.db');
fs.mkdirSync(dataDir, { recursive: true });

const mod: any = await import('../src/app.ts');
let boot: any = null;
try { boot = await import('../src/server.ts'); } catch { /* the version before startServer existed */ }

const root = express();
root.get('/__perf', (req, res) => {
  const ms = (n: number) => Math.round((n / 1e6) * 10) / 10;
  const m = process.memoryUsage();
  const out = {
    loop: { p50: ms(hist.percentile(50)), p95: ms(hist.percentile(95)), p99: ms(hist.percentile(99)), max: ms(hist.max), maxGap: Math.round(maxGap * 10) / 10 },
    mem: { rssMb: Math.round(m.rss / 1048576), heapMb: Math.round(m.heapUsed / 1048576), peakRssMb: Math.round(Math.max(peakRss, m.rss) / 1048576) },
    mock: mock.stats, upSeconds: Math.round((performance.now() - t0) / 100) / 10,
  };
  if (req.query.reset) { hist.reset(); maxGap = 0; peakRss = m.rss; }
  res.json(out);
});
// Open or close the recording session (the scheduler runs the summary and rules passes for a session that is open).
root.post('/__perf/session', async (req, res) => {
  const { run } = await import('../src/core/db.ts');
  run((globalThis as any).__deps.db, 'UPDATE audio_sessions SET stopped_at = ? WHERE id = ?', req.query.open === '1' ? null : new Date().toISOString(), String(req.query.id));
  res.json({ ok: true });
});
root.post('/__perf/models', (req, res) => { if (req.query.on === '1') modelsOn(); else modelsOff(); res.json({ ok: true }); });
root.post('/__perf/latency', (req, res) => { for (const k of ['lk', 'embed', 'chat'] as const) if (req.query[k] !== undefined) mock.latency[k] = Number(req.query[k]); res.json(mock.latency); });
// Run the background passes of a recording session now (the scheduler runs them every 20 and 30 seconds).
root.post('/__perf/audio', async (_req, res) => {
  const a = await import('../src/features/audio/summary.ts');
  const r = await import('../src/features/audio/rulescheck.ts');
  const out: any = {};
  for (const s of a.recordingSessions(globalThis.__deps)) { out.summary = await a.updateBoth(globalThis.__deps, s.worldId, s.sessionId, { force: true }); out.rules = await r.rulesPass(globalThis.__deps, s.worldId, s.sessionId); }
  res.json(out);
});

const opts = { dbFile, dataDir, vaultsDir: null, webDir: null, fetch: mock.fetch, env };
let listenAt = 0;
if (boot?.startServer) {
  const s = await boot.startServer({ ...opts, port, extra: root, quiet: true, onListening: () => { listenAt = performance.now() - t0; } });
  (globalThis as any).__deps = s.deps;
} else {
  const { app, deps } = mod.createApp(opts);
  (globalThis as any).__deps = deps;
  root.use(app);
  root.listen(port, () => { listenAt = performance.now() - t0; });
}
process.on('SIGTERM', () => process.exit(0));
void listenAt;
console.log(`bigworld server on :${port}`);
