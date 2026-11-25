// Game night: the model lifecycle per backend. Fake Argos, llama-swap, Ollama and plain
// OpenAI-compatible servers record every request, and the tests assert exactly which calls
// happen on start, during, at the end (after the grace period), on a crash, after a restart,
// and that nothing at all is sent while no session is live. Time is passed in, not waited for.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { startLifecycle, lifecycleTick, lifecycleView, resume, setManual, sessionLive, settled, warmSnapshot } from '../src/features/models/lifecycle.ts';
import { run } from '../src/core/db.ts';

type Type = 'argos' | 'llama-swap' | 'ollama' | 'plain';
interface Call { method: string; path: string; body: any }
interface Fake { url: string; calls: Call[]; loaded: Set<string>; ttl: number; close: () => Promise<void> }

/** A server that answers like the given backend and records everything it is asked. */
async function fake(type: Type): Promise<Fake> {
  const f: Fake = { url: '', calls: [], loaded: new Set(), ttl: 0, close: async () => {} };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* none */ }
      const p = (req.url ?? '').split('?')[0];
      f.calls.push({ method: req.method ?? 'GET', path: p, body });
      const json = (code: number, v: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
      const miss = () => json(404, { error: 'not found' });
      const running = () => ({ running: [...f.loaded].map((model) => ({ model, state: 'ready', ttl: f.ttl })) });
      if (p === '/v1/chat/completions') { f.loaded.add(body?.model); return json(200, { choices: [{ message: { role: 'assistant', content: 'ready' } }] }); }
      if (p === '/v1/embeddings') { f.loaded.add(body?.model); return json(200, { data: [{ embedding: [0.1, 0.2], index: 0 }] }); }
      if (type === 'argos' || type === 'llama-swap') {
        if (p === '/api/models/modes') return type === 'argos' ? json(200, { ok: true, modes: {}, valid: ['standard'], enabled: true }) : miss();
        if (p === '/running') return json(200, running());
        const m = /^\/api\/models\/unload\/(.+)$/.exec(p);
        if (m && req.method === 'POST') { f.loaded.delete(decodeURIComponent(m[1])); res.writeHead(200); return res.end('OK'); }
        return miss();
      }
      if (type === 'ollama') {
        if (p === '/api/ps') return json(200, { models: [...f.loaded].map((name) => ({ name, model: name, expires_at: '2318-01-01T00:00:00Z' })) });
        if (p === '/api/generate' || p === '/api/embed') {
          if (body?.keep_alive === 0) f.loaded.delete(body.model); else f.loaded.add(body.model);
          return json(200, { done: true });
        }
      }
      miss();
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  f.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  f.close = () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
  return f;
}

let tmp = '';
let base = '';
let server: any;
let deps: any;
let admin = '';
const A = '/api/admin/models';
const MODELS = { chat: 'm-chat', audit: 'm-audit', extra: 'm-embed' };
const T0 = Date.parse('2030-01-01T20:00:00Z');
const min = (n: number) => n * 60_000;

async function api(method: string, url: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-lifecycle-'));
  const made = createApp({ noScheduler: true, dbFile: path.join(tmp, 'alx.db'), dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  admin = (await api('POST', '/api/setup', { username: 'wizard', password: 'correct horse battery' })).token;
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** Point chat, audit and extra at a fake server (a new provider; the earlier one stops being used). */
async function pointAt(f: Fake, kind: string, location: 'local' | 'cloud' = 'local', settings: Record<string, unknown> = {}) {
  const p = (await api('POST', `${A}/providers`, { name: `${kind}-${Math.random().toString(36).slice(2, 6)}`, kind, baseUrl: kind === 'openai-compatible' ? `${f.url}/v1` : f.url, location })).provider;
  if (Object.keys(settings).length) await api('PUT', `${A}/providers/${p.id}`, settings);
  await api('PUT', A, { jobs: Object.fromEntries(Object.entries(MODELS).map(([job, model]) => [job, { providerId: p.id, model }])) });
  return p.id as string;
}
const endSession = () => setManual(deps, false);
const sig = (f: Fake) => f.calls.map((c) => `${c.method} ${c.path}${c.body?.keep_alive !== undefined ? ` keep_alive=${c.body.keep_alive}` : ''}`);
const posts = (f: Fake) => f.calls.filter((c) => c.method === 'POST');
const clear = (f: Fake) => { f.calls.length = 0; };

test('Lifecycle_SessionLiveIsOneRule_ManualRecordingOrChatSession', async () => {
  assert.equal(sessionLive(deps).live, false);
  setManual(deps, true);
  assert.deepEqual(sessionLive(deps).reasons, ['manual']);
  setManual(deps, false);
  const w = 'w1';
  run(deps.db, "INSERT INTO worlds (id, slug, name, settings, created_at) VALUES (?, 'x', 'x', '{}', ?)", w, new Date().toISOString());
  run(deps.db, 'INSERT INTO audio_sessions (id, world_id, name, started_at) VALUES (?,?,?,?)', 'a1', w, 'n', new Date().toISOString());
  assert.deepEqual(sessionLive(deps).reasons, ['recording']);
  run(deps.db, 'UPDATE audio_sessions SET stopped_at = ? WHERE id = ?', new Date().toISOString(), 'a1');
  run(deps.db, "INSERT INTO sessionchat_sessions (id, world_id, title, started_at) VALUES ('c1', ?, 't', ?)", w, new Date().toISOString());
  assert.deepEqual(sessionLive(deps).reasons, ['chat']);
  run(deps.db, 'UPDATE sessionchat_sessions SET ended_at = ? WHERE id = ?', new Date().toISOString(), 'c1');
  assert.equal(sessionLive(deps).live, false);
  run(deps.db, "INSERT INTO audio_sessions (id, world_id, name, started_at) VALUES ('stale', ?, 'n', ?)", w, new Date(Date.now() - 3 * 86400_000).toISOString());
  assert.equal(sessionLive(deps).live, false, 'a recording that never stopped does not hold models for days');
  run(deps.db, "DELETE FROM audio_sessions WHERE id = 'stale'");
});

test('Lifecycle_Argos_HoldsDuringTheNightAndUnloadsAfterTheGrace', async () => {
  const f = await fake('argos');
  await pointAt(f, 'argos');
  // idle: ticking does nothing, not even a probe
  for (let i = 0; i < 5; i++) await lifecycleTick(deps, T0 + i * 20_000);
  assert.deepEqual(f.calls, [], 'zero calls while no session is live');

  setManual(deps, true);
  await lifecycleTick(deps, T0 + min(1));
  const start = sig(f);
  assert.ok(start.includes('GET /api/models/modes'), 'detected once');
  assert.equal(start.filter((s) => s === 'POST /v1/chat/completions').length, 2, 'chat and audit get one tiny request each');
  assert.equal(start.filter((s) => s === 'POST /v1/embeddings').length, 1);
  assert.ok(start.includes('GET /running'));
  assert.equal(posts(f).filter((c) => c.path.includes('unload')).length, 0);
  assert.equal(lifecycleView(deps).phase, 'ready');
  assert.deepEqual(warmSnapshot(deps).chat.state, 'ready');

  clear(f);
  await lifecycleTick(deps, T0 + min(1) + 30_000);
  assert.deepEqual(f.calls, [], 'nothing between checks');
  await lifecycleTick(deps, T0 + min(2) + 5_000);
  assert.ok(sig(f).every((s) => s === 'GET /running'));
  assert.equal(posts(f).length, 0, 'ttl 0 never unloads, so no requests are needed');

  // a model that Argos dropped is loaded again
  f.loaded.delete('m-chat');
  clear(f);
  await lifecycleTick(deps, T0 + min(3) + 10_000);
  assert.ok(sig(f).includes('POST /v1/chat/completions'), 'reloaded after it went missing');
  assert.equal(posts(f).filter((c) => c.body?.model === 'm-chat').length, 1);
  assert.ok(f.loaded.has('m-chat'));

  // end of the night: nothing happens during the grace period
  endSession();
  clear(f);
  await lifecycleTick(deps, T0 + min(4));
  assert.equal(lifecycleView(deps).phase, 'releasing');
  await lifecycleTick(deps, T0 + min(13));
  assert.deepEqual(f.calls, [], 'no calls during the grace period');
  await lifecycleTick(deps, T0 + min(14) + 1_000);
  assert.deepEqual(sig(f).sort(), ['POST /api/models/unload/m-audit', 'POST /api/models/unload/m-chat', 'POST /api/models/unload/m-embed']);
  assert.equal(f.loaded.size, 0);
  assert.equal(lifecycleView(deps).phase, 'off');
  clear(f);
  await lifecycleTick(deps, T0 + min(40));
  assert.deepEqual(f.calls, [], 'idle again: zero calls');
  await f.close();
});

test('Lifecycle_Argos_ANonZeroTtlIsRefreshedJustInsideIt', async () => {
  const f = await fake('argos');
  f.ttl = 100;
  await pointAt(f, 'argos');
  setManual(deps, true);
  await lifecycleTick(deps, T0);
  clear(f);
  await lifecycleTick(deps, T0 + 50_000);
  assert.equal(posts(f).length, 0, 'still inside the ttl margin');
  await lifecycleTick(deps, T0 + 65_000);
  assert.equal(posts(f).filter((c) => c.path === '/v1/chat/completions').length, 2, 'refreshed at 60 percent of the ttl');
  endSession();
  await lifecycleTick(deps, T0 + 70_000);
  await lifecycleTick(deps, T0 + 70_000 + min(11));
  await f.close();
});

test('Lifecycle_LlamaSwap_PingsInsideTheTtlTheDmSetsAndUnloadsPerModel', async () => {
  const f = await fake('llama-swap');
  await pointAt(f, 'openai-compatible', 'local', { ttl: 120 });
  setManual(deps, true);
  await lifecycleTick(deps, T0);
  const start = sig(f);
  assert.ok(start.includes('GET /running'), 'told apart from Argos by /running without Argos endpoints');
  assert.equal(start.filter((s) => s === 'POST /v1/chat/completions').length, 2, JSON.stringify(start) + JSON.stringify(lifecycleView(deps).holds));
  clear(f);
  await lifecycleTick(deps, T0 + 40_000);
  assert.equal(posts(f).length, 0);
  await lifecycleTick(deps, T0 + 75_000);
  assert.equal(posts(f).filter((c) => c.path === '/v1/chat/completions').length, 2, 'a tiny request at 60 percent of the 120 s ttl');
  clear(f);
  f.loaded.clear(); // llama-swap restarted: models gone
  await lifecycleTick(deps, T0 + 150_000);
  assert.ok(posts(f).length >= 3, 'crashed models are loaded again');
  endSession();
  await lifecycleTick(deps, T0 + 160_000);
  clear(f);
  await lifecycleTick(deps, T0 + 160_000 + min(10) + 1000);
  assert.deepEqual(sig(f).sort(), ['POST /api/models/unload/m-audit', 'POST /api/models/unload/m-chat', 'POST /api/models/unload/m-embed']);
  await f.close();
});

test('Lifecycle_Ollama_KeepAliveMinusOneThenZero', async () => {
  const f = await fake('ollama');
  await pointAt(f, 'ollama');
  setManual(deps, true);
  await lifecycleTick(deps, T0);
  const start = f.calls.filter((c) => c.method === 'POST').map((c) => `${c.path}:${c.body.model}:${c.body.keep_alive}`).sort();
  assert.deepEqual(start, ['/api/embed:m-embed:-1', '/api/generate:m-audit:-1', '/api/generate:m-chat:-1']);
  assert.ok(!f.calls.some((c) => c.path.startsWith('/v1/')), 'no OpenAI requests needed');
  clear(f);
  await lifecycleTick(deps, T0 + min(1) + 1000);
  assert.ok(sig(f).length > 0 && sig(f).every((x) => x === 'GET /api/ps'), 'only a look at what is loaded');
  f.loaded.delete('m-audit');
  clear(f);
  await lifecycleTick(deps, T0 + min(2) + 2000);
  assert.deepEqual(posts(f).map((c) => `${c.body.model}:${c.body.keep_alive}`), ['m-audit:-1']);
  endSession();
  await lifecycleTick(deps, T0 + min(3));
  clear(f);
  await lifecycleTick(deps, T0 + min(14));
  assert.deepEqual(posts(f).map((c) => `${c.body.model}:${c.body.keep_alive}`).sort(), ['m-audit:0', 'm-chat:0', 'm-embed:0']);
  assert.equal(f.loaded.size, 0);
  await f.close();
});

test('Lifecycle_PlainOpenAi_NoWarmCallsUnlessAPingIntervalIsSet', async () => {
  const f = await fake('plain');
  const pid = await pointAt(f, 'openai-compatible');
  setManual(deps, true);
  await lifecycleTick(deps, T0);
  await lifecycleTick(deps, T0 + min(30));
  assert.equal(posts(f).length, 0, 'a server that cannot hold models gets no requests at all');
  assert.ok(sig(f).every((s) => s.startsWith('GET ')), 'only the one detection probe');
  assert.equal((await api('GET', `${A}/lifecycle`)).providers.find((p: any) => p.id === pid).backend, 'generic');
  endSession();
  await lifecycleTick(deps, T0 + min(31));
  await lifecycleTick(deps, T0 + min(50));
  assert.equal(posts(f).length, 0, 'nothing to unload');

  // opt in: a slow ping, only during the night
  await api('PUT', `${A}/providers/${pid}`, { pingMinutes: 5 });
  clear(f);
  setManual(deps, true);
  await lifecycleTick(deps, T0 + min(60));
  assert.equal(posts(f).filter((c) => c.path === '/v1/chat/completions').length, 2, 'warmed once at the start');
  clear(f);
  await lifecycleTick(deps, T0 + min(63));
  assert.equal(posts(f).length, 0);
  await lifecycleTick(deps, T0 + min(66));
  assert.equal(posts(f).filter((c) => c.path === '/v1/chat/completions').length, 2, 'then every 5 minutes');
  endSession();
  await lifecycleTick(deps, T0 + min(67));
  clear(f);
  await lifecycleTick(deps, T0 + min(90));
  assert.deepEqual(f.calls, [], 'no unload on a server that has none, and no pings after the night');
  await f.close();
});

test('Lifecycle_HostedApi_NeverCalledNotEvenToDetect', async () => {
  const f = await fake('plain');
  await pointAt(f, 'openai-compatible', 'cloud');
  setManual(deps, true);
  await lifecycleTick(deps, T0);
  await lifecycleTick(deps, T0 + min(30));
  endSession();
  await lifecycleTick(deps, T0 + min(31));
  await lifecycleTick(deps, T0 + min(60));
  assert.deepEqual(f.calls, [], 'hosted APIs cost money: zero calls');
  const v = await api('GET', `${A}/lifecycle`);
  assert.ok(v.providers.some((p: any) => p.backend === 'hosted' && /nothing to load/.test(p.summary)));
  assert.deepEqual(f.calls, []);
  await f.close();
});

test('Lifecycle_JobPolicy_OnDemandJobsAreNotHeldAndAnOverrideWins', async () => {
  const f = await fake('argos');
  const pid = await pointAt(f, 'argos');
  await api('PUT', `${A}/lifecycle`, { policies: { audit: 'ondemand', extra: 'ondemand' } });
  setManual(deps, true);
  await lifecycleTick(deps, T0);
  assert.deepEqual(posts(f).map((c) => c.body.model), ['m-chat'], 'only the keep-loaded job is warmed');
  endSession();
  await lifecycleTick(deps, T0 + min(1));
  await lifecycleTick(deps, T0 + min(12));
  await api('PUT', `${A}/lifecycle`, { policies: { audit: 'hold', extra: 'hold' } });
  // override the detected type
  await api('PUT', `${A}/providers/${pid}`, { backend: 'generic' });
  const v = await api('GET', `${A}/lifecycle`);
  const p = v.providers.find((x: any) => x.id === pid);
  assert.equal(p.backend, 'generic');
  assert.equal(p.detected, 'argos');
  await api('PUT', `${A}/providers/${pid}`, { backend: 'auto' });
  await f.close();
});

test('Lifecycle_Thrash_AModelTheServerKeepsEvictingIsNotReloadedForever', async () => {
  const f = await fake('argos');
  await pointAt(f, 'argos');
  await api('PUT', `${A}/lifecycle`, { policies: { audit: 'hold', extra: 'ondemand', chat: 'ondemand' } });
  setManual(deps, true);
  await lifecycleTick(deps, T0);
  clear(f);
  for (let i = 1; i <= 8; i++) { f.loaded.delete('m-audit'); await lifecycleTick(deps, T0 + i * min(1) + 1000); }
  assert.ok(posts(f).filter((c) => c.body?.model === 'm-audit').length <= 4, 'gives up after a few reloads');
  assert.match(lifecycleView(deps).holds[0].error ?? '', /keeps unloading/);
  endSession();
  await lifecycleTick(deps, T0 + min(9));
  await lifecycleTick(deps, T0 + min(30));
  await api('PUT', `${A}/lifecycle`, { policies: { audit: 'hold', extra: 'hold', chat: 'hold' } });
  await f.close();
});

test('Lifecycle_Restart_ReWarmsMidSessionAndReleasesAfterOne', async () => {
  const f = await fake('ollama');
  await pointAt(f, 'ollama');
  setManual(deps, true);
  await lifecycleTick(deps, T0);
  assert.equal(f.loaded.size, 3);

  // Alexandria restarts while the night is on: a new process re-warms
  const boot = () => createApp({ noScheduler: true, dbFile: path.join(tmp, 'alx.db'), dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } }).deps;
  const up = (d: any) => { const stop = startLifecycle(d); return settled(d).then(stop); };
  f.loaded.clear();
  clear(f);
  const d2 = boot();
  await up(d2);
  assert.deepEqual(posts(f).map((c) => `${c.body.model}:${c.body.keep_alive}`).sort(), ['m-audit:-1', 'm-chat:-1', 'm-embed:-1']);
  assert.equal(f.loaded.size, 3);

  // it stops and the night ends while it is down; the next process releases what was held
  setManual(d2, false);
  clear(f);
  const d3 = boot();
  await up(d3);
  assert.deepEqual(posts(f).map((c) => `${c.body.model}:${c.body.keep_alive}`).sort(), ['m-audit:0', 'm-chat:0', 'm-embed:0']);
  assert.equal(f.loaded.size, 0);
  clear(f);
  await lifecycleTick(d3, T0 + min(90));
  assert.deepEqual(f.calls, [], 'and then it stays quiet');
  await f.close();
});

test('Lifecycle_Events_ARecordingStartingStartsTheLifecycleAtOnce', async () => {
  const f = await fake('argos');
  await pointAt(f, 'argos');
  clear(f);
  run(deps.db, 'INSERT INTO audio_sessions (id, world_id, name, started_at) VALUES (?,?,?,?)', 'rec1', 'w1', 'Night', new Date().toISOString());
  deps.hub.emit('w1', 'recording', { on: true }, () => true);
  await settled(deps);
  assert.ok(posts(f).some((c) => c.path === '/v1/chat/completions'));
  run(deps.db, 'UPDATE audio_sessions SET stopped_at = ? WHERE id = ?', new Date().toISOString(), 'rec1');
  deps.hub.emit('w1', 'recording', { on: false }, () => true);
  await settled(deps);
  assert.equal(lifecycleView(deps).phase, 'releasing');
  await lifecycleTick(deps, Date.now() + min(11));
  assert.equal(lifecycleView(deps).phase, 'off');
  assert.equal(f.loaded.size, 0);
  await f.close();
});

test('Lifecycle_Admin_StartAndEndButtonsDriveTheStripAndRefuseNonAdmins', async () => {
  const f = await fake('argos');
  await pointAt(f, 'argos');
  const s = await api('POST', `${A}/game-night/start`, {});
  assert.equal(s.live, true);
  await settled(deps);
  const v = await api('GET', `${A}/lifecycle`);
  assert.equal(v.phase, 'ready');
  assert.equal(v.progress.ready, 3);
  const e = await api('POST', `${A}/game-night/end`, { now: true });
  assert.equal(e.phase, 'off');
  assert.equal(f.loaded.size, 0);
  const r = await fetch(base + `${A}/lifecycle`);
  assert.ok(r.status === 401 || r.status === 403);
  await f.close();
});

// ---- the real Argos ---------------------------------------------------------------------------------------
// Runs only with ARGOS_DIR pointing at a checkout of Argos (it builds the binary and its simple-responder).
const ARGOS_DIR = process.env.ARGOS_DIR;
test('Lifecycle_RealArgos_HoldsAndUnloadsThroughItsOwnApi', { skip: !ARGOS_DIR }, async () => {
  const bin = path.join(tmp, 'argos');
  const rb = path.join(tmp, 'simple-responder');
  for (const [out, pkg] of [[bin, '.'], [rb, './cmd/simple-responder']] as const) {
    const b = spawnSync('go', ['build', '-o', out, pkg], { cwd: ARGOS_DIR, encoding: 'utf8' });
    assert.equal(b.status, 0, b.stderr);
  }
  const port = 18000 + Math.floor(Math.random() * 1000);
  const cfg = path.join(tmp, 'argos.yaml');
  const model = (name: string) => `  ${name}:\n    cmd: ${rb} --port \${PORT} --silent\n    proxy: http://127.0.0.1:\${PORT}\n    ttl: 0\n`;
  fs.writeFileSync(cfg, `healthCheckTimeout: 30\nmodels:\n${model('m-chat')}${model('m-audit')}${model('m-embed')}routing:\n  router:\n    use: group\n    settings:\n      groups:\n        night:\n          swap: false\n          exclusive: false\n          members: [m-chat, m-audit, m-embed]\n`);
  const child = spawn(bin, ['-config', cfg, '-listen', `127.0.0.1:${port}`], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
    const f: Fake = { url: `http://127.0.0.1:${port}`, calls: [], loaded: new Set(), ttl: 0, close: async () => {} };
    await pointAt(f, 'argos');
    const running = async () => ((await (await fetch(`${f.url}/running`)).json()) as any).running.map((r: any) => r.model).sort();
    setManual(deps, true);
    await lifecycleTick(deps, T0);
    // simple-responder answers chat in a shape the probe does not accept and has no embeddings route, so the holds read failed; what matters here is that real Argos loaded the models and unloads them through its own API
    assert.equal(lifecycleView(deps).holds[0].backend, 'argos');
    assert.ok((await running()).includes('m-chat') && (await running()).includes('m-audit'), `running ${JSON.stringify(await running())} held: ${JSON.stringify(lifecycleView(deps).holds)}`);
    endSession();
    await lifecycleTick(deps, T0 + min(1));
    await lifecycleTick(deps, T0 + min(12));
    assert.deepEqual(await running(), []);
  } finally { child.kill(); }
});
