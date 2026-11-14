// Admin → Models, round four: Local / Cloud per job (filtering data and remembering),
// session mode for Argos (warm local jobs when a session starts, keep loaded, unload
// when it ends, load/unload all), the VRAM view (pool math, config snippet) and the
// fake Argos endpoints they run against. Nothing here may send world text to a model.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { chainFor } from '../src/core/ai.ts';
import { keepWarmTick } from '../src/features/models/index.ts';
import { argosSnippets, budgetFor, normalizePool, normalizeRunning, type PoolView } from '../src/features/models/pool.ts';
import { argosJobModels, gameSessionRunning, getSessionSettings, localJobs, settled, warmSnapshot } from '../src/features/models/session.ts';
import { startFakeModels, type FakeModels } from '../scripts/fake-models.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
let fake: FakeModels; // the Argos (local) one
let other: FakeModels; // a second server: a cloud provider, and a local non-Argos one
let inflight = 0;
let peak = 0;
const T: Record<string, string> = {};
let W = '';
const A = '/api/admin/models';
const SECRET = 'MOONSILVER-VAULT-PASSPHRASE';

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const job = (list: any, name: string) => list.jobs.find((j: any) => j.job === name);
const JOBS6 = ['chat', 'audit', 'audio', 'voice', 'extra', 'rerank'];
const MODEL: Record<string, string> = { chat: 'fake-chat', audit: 'fake-audit', audio: 'fake-whisper', voice: 'fake-kokoro', extra: 'fake-embed', rerank: 'fake-rerank' };

/** A fetch that counts model calls in flight, so a test can see they ran together. */
const tracked = async (url: any, init?: any) => {
  const model = (init?.method ?? 'GET') === 'POST' && String(url).includes('/v1/');
  if (model) { inflight++; peak = Math.max(peak, inflight); }
  try { return await fetch(url, init); } finally { if (model) inflight--; }
};

let argosId = '';
let cloudId = '';
let localOtherId = '';

before(async () => {
  fake = await startFakeModels(0, '127.0.0.1', { delayMs: 80 });
  other = await startFakeModels(0, '127.0.0.1');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-msession-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' }, fetch: tracked as any });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Sessionland', dmAccountId: dm.account.id })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  T.player = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jessamine' })).token;
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'dm/Vault', visibility: 'dm', markdown: `# Vault\nThe passphrase is ${SECRET}.\n` });
  argosId = (await ok('POST', `${A}/providers`, T.admin, { name: 'Argos', kind: 'argos', baseUrl: fake.baseUrl })).provider.id;
  cloudId = (await ok('POST', `${A}/providers`, T.admin, { name: 'Cloudy', kind: 'openai-compatible', baseUrl: other.baseUrl, location: 'cloud' })).provider.id;
  localOtherId = (await ok('POST', `${A}/providers`, T.admin, { name: 'Ollama box', kind: 'ollama', baseUrl: other.baseUrl.replace('127.0.0.1', 'localhost') })).provider.id;
});

after(async () => {
  server?.close();
  server?.closeAllConnections?.();
  await fake.close();
  await other.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const setJobs = (jobs: Record<string, unknown>) => ok('PUT', A, T.admin, { jobs });
const allOnArgos = () => setJobs(Object.fromEntries(JOBS6.map((j) => [j, { providerId: argosId, model: MODEL[j], enabled: true, fallback: null }])));
const setSession = (b: Record<string, boolean>) => ok('PUT', `${A}/session`, T.admin, b);
const startChat = () => ok('POST', `/api/worlds/${W}/sessionchat/sessions/start`, T.dm, { title: 'Test night' });
const endChat = () => ok('POST', `/api/worlds/${W}/sessionchat/sessions/end`, T.dm, {});
const modelCalls = (f: FakeModels) => f.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/v1/'));
const unloads = (f: FakeModels) => f.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/api/models/unload/')).map((r) => decodeURIComponent(r.path.split('/').pop()!));
const forget = (f: FakeModels) => { f.requests.length = 0; };

// ---- 1. Local or cloud, per job ------------------------------------------------------

test('ModelsLocation_JobsShowWhereTheyRunAndRememberTheLastModelPerLocation', async () => {
  await setJobs({ chat: { providerId: argosId, model: 'fake-chat', enabled: true } });
  let v = job(await ok('GET', A, T.admin), 'chat');
  assert.equal(v.location, 'local');
  assert.deepEqual(v.lastChoice.local, { providerId: argosId, model: 'fake-chat' });
  assert.equal(v.lastChoice.cloud, null);

  await setJobs({ chat: { providerId: cloudId, model: 'gpt-4o-mini' } });
  v = job(await ok('GET', A, T.admin), 'chat');
  assert.equal(v.location, 'cloud');
  assert.deepEqual(v.lastChoice.cloud, { providerId: cloudId, model: 'gpt-4o-mini' });
  assert.deepEqual(v.lastChoice.local, { providerId: argosId, model: 'fake-chat' }, 'the local choice is still remembered: switching back is one click');

  // The list the page filters: every provider says where it runs.
  const list = await ok('GET', A, T.admin);
  const at = (loc: string) => list.providers.filter((p: any) => p.location === loc).map((p: any) => p.name).sort();
  assert.deepEqual(at('local'), ['Argos', 'Ollama box']);
  assert.deepEqual(at('cloud'), ['Cloudy']);

  // A remembered provider that was removed is not offered.
  await setJobs({ chat: { providerId: argosId, model: 'fake-chat' } });
  const extra = (await ok('POST', `${A}/providers`, T.admin, { name: 'Temp', kind: 'openai', baseUrl: 'https://api.example.test/v1' })).provider.id;
  await setJobs({ chat: { providerId: extra, model: 'x-1' } });
  assert.equal(job(await ok('GET', A, T.admin), 'chat').lastChoice.cloud.providerId, extra);
  await setJobs({ chat: { providerId: argosId, model: 'fake-chat' } });
  await ok('DELETE', `${A}/providers/${extra}`, T.admin);
  assert.equal(job(await ok('GET', A, T.admin), 'chat').lastChoice.cloud, null);
});

test('ModelsLocation_TheFallbackShowsItsLocationAndTheCloudRuleStays', async () => {
  await setJobs({ chat: { providerId: argosId, model: 'fake-chat', fallback: { providerId: cloudId, model: 'gpt-4o-mini', allowCloud: false } } });
  let v = job(await ok('GET', A, T.admin), 'chat');
  assert.equal(v.fallback.location, 'cloud');
  assert.equal(v.location, 'local');
  assert.equal(v.fallbackBlocked, true, 'a cloud fallback behind a local model is off until allowed');
  assert.equal(chainFor(deps, 'chat').length, 1);
  await setJobs({ chat: { fallback: { providerId: cloudId, model: 'gpt-4o-mini', allowCloud: true } } });
  v = job(await ok('GET', A, T.admin), 'chat');
  assert.equal(v.fallbackBlocked, false);
  assert.equal(chainFor(deps, 'chat').length, 2);
  await setJobs({ chat: { fallback: null } });
});

// ---- 2. Session mode -------------------------------------------------------------------

test('ModelsSession_SettingsDefaultOffAndNeedBooleans', async () => {
  const s = await ok('GET', `${A}/session`, T.admin);
  assert.deepEqual(s.settings, { loadOnStart: false, keepLoaded: false, unloadOnEnd: false });
  assert.equal((await call('PUT', `${A}/session`, T.admin, { unloadOnEnd: 'yes' })).status, 400);
  assert.equal((await call('PUT', `${A}/session`, T.dm, { unloadOnEnd: true })).status, 403, 'admins only');
});

test('ModelsSession_StartingASessionWarmsEveryLocalJobInParallelAndSendsNoWorldText', async () => {
  await allOnArgos();
  await setJobs({ rerank: { providerId: cloudId, model: 'fake-rerank' } }); // a cloud job is never warmed by the session
  assert.deepEqual(localJobs(deps), ['chat', 'audit', 'audio', 'voice', 'extra']);

  // Off: a session start does nothing.
  forget(fake); forget(other);
  await startChat(); await settled(deps); await endChat();
  assert.equal(modelCalls(fake).length + modelCalls(other).length, 0);

  await setSession({ loadOnStart: true });
  inflight = 0; peak = 0;
  await startChat();
  await settled(deps);
  assert.ok(peak >= 5, `the five local jobs ran together (peak ${peak})`);
  const paths = modelCalls(fake).map((r) => r.path).sort();
  assert.deepEqual(paths, ['/v1/audio/speech', '/v1/audio/transcriptions', '/v1/chat/completions', '/v1/chat/completions', '/v1/embeddings']);
  assert.equal(modelCalls(other).length, 0, 'the cloud job got nothing');
  const snap = warmSnapshot(deps);
  assert.deepEqual(Object.keys(snap).sort(), ['audio', 'audit', 'chat', 'extra', 'voice']);
  for (const e of Object.values(snap)) assert.equal(e.state, 'ready');

  // Nothing from the world went out: only the fixed warm-up strings.
  const sent = JSON.stringify([...fake.requests, ...other.requests].map((r) => r.body));
  assert.ok(!sent.includes(SECRET) && !sent.includes('Vault') && !sent.includes('Sessionland') && !sent.includes('Test night'), 'no world text in any model request');
  await endChat();
});

test('ModelsSession_TheTablePageCardIsForTheDmOnly', async () => {
  const dm = await ok('GET', `/api/worlds/${W}/models/ready`, T.dm);
  assert.equal(dm.enabled, true);
  assert.deepEqual(Object.keys(dm.jobs).sort(), ['audio', 'audit', 'chat', 'extra', 'voice']);
  assert.equal(dm.jobs.chat.state, 'ready');
  const asPlayer = await call('GET', `/api/worlds/${W}/models/ready`, T.player);
  assert.ok([401, 403, 404].includes(asPlayer.status), `a player is refused (${asPlayer.status})`);
  assert.ok(!asPlayer.text.includes('fake-chat'));
});

test('ModelsSession_AFailedWarmUpShowsAsFailedNotAsReady', async () => {
  const dead = (await ok('POST', `${A}/providers`, T.admin, { name: 'Dead', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', location: 'local' })).provider.id;
  await setJobs({ extra: { providerId: dead, model: 'e' } });
  const r = await ok('POST', `${A}/warm-all`, T.admin, {});
  assert.equal(r.warm.extra.state, 'loading', 'answers at once, then progress is polled');
  await settled(deps);
  await new Promise((res) => setTimeout(res, 400));
  const s = await ok('GET', `${A}/session`, T.admin);
  assert.equal(s.warm.extra.state, 'failed');
  assert.match(s.warm.extra.error, /./);
  assert.equal(s.warm.chat.state, 'ready');
  await setJobs({ extra: { providerId: argosId, model: 'fake-embed' } });
  await ok('DELETE', `${A}/providers/${dead}`, T.admin);
});

test('ModelsSession_KeepLoadedPingsEveryLocalJobOnlyWhileASessionRuns', async () => {
  await setSession({ loadOnStart: false, keepLoaded: false });
  forget(fake);
  await startChat();
  assert.deepEqual(await keepWarmTick(deps), [], 'off: no job has its own keep-warm switch');
  await setSession({ keepLoaded: true });
  forget(fake);
  assert.equal(gameSessionRunning(deps), true);
  assert.deepEqual(await keepWarmTick(deps), ['chat', 'audit', 'audio', 'voice', 'extra']);
  assert.equal(modelCalls(fake).length, 5);
  await endChat();
  forget(fake);
  assert.deepEqual(await keepWarmTick(deps), [], 'no session: nothing is pinged');
  await setSession({ keepLoaded: false });
});

// ---- unload ---------------------------------------------------------------------------------

test('ModelsSession_UnloadOnEndOnlyWhenSwitchedOnAndOnlyForArgosJobModels', async () => {
  // rerank runs on a local non-Argos provider; extra is switched off. Neither may be touched.
  await setJobs({ rerank: { providerId: localOtherId, model: 'fake-rerank' }, extra: { enabled: false } });
  assert.deepEqual(argosJobModels(deps).map((t) => t.model).sort(), ['fake-audit', 'fake-chat', 'fake-kokoro', 'fake-whisper']);

  await setSession({ loadOnStart: false, unloadOnEnd: false });
  forget(fake); forget(other);
  await startChat(); await endChat(); await settled(deps);
  assert.deepEqual(unloads(fake), [], 'switched off: nothing is unloaded');

  await setSession({ unloadOnEnd: true });
  await startChat();
  await settled(deps);
  assert.deepEqual(unloads(fake), [], 'a session start never unloads');
  await endChat();
  await settled(deps);
  assert.deepEqual(unloads(fake).sort(), ['fake-audit', 'fake-chat', 'fake-kokoro', 'fake-whisper']);
  assert.deepEqual(unloads(other), [], 'a non-Argos provider is never asked to unload');
  assert.ok(fake.loaded().includes('fake-embed') && fake.loaded().includes('fake-rerank'), 'models no job uses stay loaded');
  assert.ok(!fake.loaded().includes('fake-chat'));
  // The unload call carries no body and no world text.
  assert.ok(fake.requests.filter((r) => r.path.startsWith('/api/models/unload/')).every((r) => r.body === null));
  await setSession({ unloadOnEnd: false });
  await setJobs({ rerank: { providerId: argosId, model: 'fake-rerank' }, extra: { enabled: true } });
});

test('ModelsSession_LoadAllAndUnloadAllNowWork', async () => {
  await allOnArgos();
  forget(fake);
  const u = await ok('POST', `${A}/unload-all`, T.admin, {});
  assert.deepEqual(u.results.map((x: any) => x.model).sort(), Object.values(MODEL).sort());
  assert.ok(u.results.every((x: any) => x.ok));
  assert.deepEqual(fake.loaded(), []);
  forget(fake);
  await ok('POST', `${A}/warm-all`, T.admin, {});
  await settled(deps);
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(fake.loaded().sort(), Object.values(MODEL).sort(), 'a request loads a model again, as Argos does');
});

// ---- 3. The VRAM view --------------------------------------------------------------------------

const pool = (over: Partial<PoolView> = {}): PoolView => ({
  enabled: true, router: 'pool',
  cards: [{ id: '0', capGiB: 32, usedGiB: 24, freeGiB: 8, models: ['chat'] }, { id: '1', capGiB: 32, usedGiB: 0, freeGiB: 32, models: [] }],
  models: [
    { id: 'chat', state: 'ready', sizeGiB: 24, sizeKnown: true, cards: ['0'], persistent: false },
    { id: 'audit', state: 'stopped', sizeGiB: 5, sizeKnown: true, cards: [], persistent: false },
    { id: 'whisper', state: 'stopped', sizeGiB: 3.5, sizeKnown: true, cards: [], persistent: true },
    { id: 'mystery', state: 'stopped', sizeGiB: 0, sizeKnown: false, cards: [], persistent: false },
    { id: 'huge', state: 'stopped', sizeGiB: 70, sizeKnown: true, cards: [], persistent: false },
  ],
  ...over,
});
const jm = (...pairs: [string, string][]) => pairs.map(([job, model]) => ({ job, model }));

test('ModelsPool_BudgetSumsDeclaredSizesAgainstFreeSpace', () => {
  const b = budgetFor(pool(), jm(['chat', 'chat'], ['audit', 'audit'], ['audio', 'whisper']));
  assert.equal(b.neededGiB, 32.5);
  assert.equal(b.freeGiB, 40);
  assert.equal(b.availableGiB, 64, 'free space plus what the job models already hold');
  assert.equal(b.totalGiB, 64);
  assert.equal(b.allFit, true);
  assert.equal(b.incomplete, false);
  assert.equal(b.rows.find((r) => r.job === 'chat')!.loaded, true);
  assert.equal(b.rows.find((r) => r.job === 'audit')!.loaded, false);
  assert.ok(b.rows.every((r) => r.fit === 'ok'));
});

test('ModelsPool_FlagsUndeclaredUnknownAndTooBigModels', () => {
  const b = budgetFor(pool(), jm(['chat', 'chat'], ['audit', 'mystery'], ['voice', 'not-in-argos'], ['extra', 'huge']));
  const fit = Object.fromEntries(b.rows.map((r) => [r.job, r.fit]));
  assert.deepEqual(fit, { chat: 'ok', audit: 'undeclared', voice: 'unknown-to-argos', extra: 'too-big' });
  assert.equal(b.incomplete, true, 'the sum is a lower bound while a size is missing');
  assert.equal(b.allFit, false, 'a model bigger than every card together can never fit');
  assert.equal(b.neededGiB, 24, 'only declared models count');
  assert.match(b.rows.find((r) => r.job === 'audit')!.note, /vram/i);
});

test('ModelsPool_FlagsAModelThatFitsAloneButNotNextToTheOthers', () => {
  const p = pool({
    cards: [{ id: '0', capGiB: 32, usedGiB: 0, freeGiB: 32, models: [] }, { id: '1', capGiB: 32, usedGiB: 0, freeGiB: 32, models: [] }],
    models: ['a', 'b', 'c'].map((id) => ({ id, state: 'stopped', sizeGiB: 20, sizeKnown: true, cards: [], persistent: false })),
  });
  const two = budgetFor(p, jm(['chat', 'a'], ['audit', 'b']));
  assert.equal(two.allFit, true, 'one 20 GiB model on each card');
  const three = budgetFor(p, jm(['chat', 'a'], ['audit', 'b'], ['audio', 'c']));
  assert.equal(three.neededGiB, 60);
  assert.equal(three.allFit, false, '60 GiB of models, but only 12 GiB is left on each card: no card has room for the third');
  assert.deepEqual(three.rows.map((r) => r.fit), ['ok', 'ok', 'wont-fit']);
  assert.match(three.rows[2].note, /next to the other/);
  // A model larger than one card but not than both is split, and fits.
  const split = budgetFor(pool({ ...p, models: [{ id: 'big', state: 'stopped', sizeGiB: 40, sizeKnown: true, cards: [], persistent: false }] }), jm(['chat', 'big']));
  assert.equal(split.allFit, true);
  assert.equal(split.rows[0].fit, 'ok');
  // The same model shared by two jobs counts once.
  assert.equal(budgetFor(p, jm(['chat', 'a'], ['audit', 'a'])).neededGiB, 20);
});

test('ModelsPool_ReadsArgosShapesAndAnOffPoolIsSaidSo', () => {
  const off = normalizePool({ router: 'group', enabled: false });
  assert.deepEqual(off, { enabled: false, router: 'group', cards: [], models: [] });
  const on = normalizePool({ router: 'pool', enabled: true, cards: [{ id: '0', cap_gib: 32, used_gib: 5, free_gib: 27, models: ['x'] }], models: [{ id: 'x', state: 'ready', size_gib: 5, size_known: true, cards: ['0'], persistent: true }] });
  assert.equal(on.cards[0].freeGiB, 27);
  assert.equal(on.models[0].persistent, true);
  assert.deepEqual(normalizeRunning({ running: [{ model: 'x', state: 'ready', ttl: 0 }, { nope: 1 }] }), [{ model: 'x', state: 'ready', ttl: 0 }]);
});

test('ModelsPool_VramEndpointReadsPoolAndRunningFromArgos', async () => {
  await allOnArgos();
  await ok('POST', `${A}/unload-all`, T.admin, {});
  await ok('POST', `${A}/warm-all`, T.admin, {});
  await settled(deps);
  await new Promise((r) => setTimeout(r, 500));
  const v = await ok('GET', `${A}/vram`, T.admin);
  assert.equal(v.providers.length, 1, 'only Argos providers');
  const p = v.providers[0];
  assert.equal(p.ok, true);
  assert.equal(p.pool.enabled, true);
  assert.equal(p.pool.cards.length, 2);
  assert.equal(p.budget.neededGiB, 36.4);
  assert.equal(p.budget.totalGiB, 64);
  assert.ok(p.budget.allFit);
  assert.ok(p.running.some((m: any) => m.model === 'fake-chat' && m.usedByJobs.includes('chat')));
  assert.match(p.config.group, /ttl: 0/);
  assert.match(p.config.pool, /vram: 24/, 'sizes the pool already knows are filled in');
});

test('ModelsPool_WithoutThePoolRouterItSaysSoAndShowsRunning', async () => {
  const g = await startFakeModels(0, '127.0.0.1', { router: 'group' });
  try {
    const gid = (await ok('POST', `${A}/providers`, T.admin, { name: 'Grouped', kind: 'argos', baseUrl: g.baseUrl })).provider.id;
    await setJobs({ chat: { providerId: gid, model: 'fake-chat' } });
    const v = await ok('GET', `${A}/vram`, T.admin);
    const p = v.providers.find((x: any) => x.id === gid);
    assert.equal(p.pool.enabled, false);
    assert.equal(p.budget, null);
    assert.equal(p.router, 'group');
    assert.equal(p.running.length, 6, 'GET /running still says what is loaded');
    await setJobs({ chat: { providerId: argosId, model: 'fake-chat' } });
    await ok('DELETE', `${A}/providers/${gid}`, T.admin);
  } finally { await g.close(); }
});

test('ModelsPool_AnUnreachableArgosIsReportedNotThrown', async () => {
  const gone = (await ok('POST', `${A}/providers`, T.admin, { name: 'Gone', kind: 'argos', baseUrl: 'http://127.0.0.1:1' })).provider.id;
  const v = await ok('GET', `${A}/vram`, T.admin);
  const p = v.providers.find((x: any) => x.id === gone);
  assert.equal(p.ok, false);
  assert.match(p.error, /./);
  await ok('DELETE', `${A}/providers/${gone}`, T.admin);
});

// ---- the Argos config snippet ------------------------------------------------------------------

test('ModelsConfig_SnippetKeepsTheJobModelsResident', () => {
  const s = argosSnippets(['qwen3-30b-a3b', 'qwen3-4b', 'whisper-large-v3-turbo', 'qwen3-4b'], { 'qwen3-30b-a3b': 24 });
  // group router
  assert.match(s.group, /use: group/);
  assert.match(s.group, /\n {8}dnd:\n/);
  assert.match(s.group, /persistent: true/);
  assert.match(s.group, /swap: false/);
  assert.match(s.group, /exclusive: false/);
  assert.match(s.group, /members: \[qwen3-30b-a3b, qwen3-4b, whisper-large-v3-turbo\]/, 'each model once');
  assert.equal((s.group.match(/ttl: 0/g) ?? []).length, 3);
  assert.match(s.group, /# vram: 0/, 'a placeholder where the size is not known');
  assert.match(s.group, /vram: 24/);
  // pool router
  assert.match(s.pool, /use: pool/);
  assert.match(s.pool, /persistent: \[qwen3-30b-a3b, qwen3-4b, whisper-large-v3-turbo\]/);
  assert.equal((s.pool.match(/ttl: 0/g) ?? []).length, 3);
  assert.doesNotMatch(s.pool, /swap: false/, 'those flags belong to the group router');
  // odd names are quoted so the YAML stays valid
  assert.match(argosSnippets(['has: colon']).group, /"has: colon":/);
  assert.match(argosSnippets([]).group, /no job uses an Argos model/);
});
