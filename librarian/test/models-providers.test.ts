// Admin → Models providers: the Argos preset and Discover, jobs that pick a
// provider and a model, fallback, the local to cloud switch, old settings
// migrated to providers, keys that never come back, warm up and status, and
// rerank in library search. Uses the fake Argos-shaped models server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';
import { ModelUnavailable, chainFor, chat, embed, hasJob, jobConfig, rerank } from '../src/core/ai.ts';
import { hybridPages } from '../src/features/search/embeddings.ts';
import { keepWarmTick, listVoiceNames } from '../src/features/models/index.ts';
import { migrateJobsToProviders } from '../src/features/models/providers.ts';
import { normalizeModel, suggestJobs, argosWebUrl, normalizeArgosUrl } from '../src/features/models/argos.ts';
import { fakeRelevance, startFakeModels, type FakeModels } from '../scripts/fake-models.ts';

const DEAD = 'http://127.0.0.1:1/v1';
let base = '';
let server: any;
let tmp = '';
let deps: any;
let fake: FakeModels;
let keyed: FakeModels;
let adminT = '';
let dmT = '';
const A = '/api/admin/models';

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

before(async () => {
  fake = await startFakeModels(0, '127.0.0.1', { unloaded: ['fake-rerank'] });
  keyed = await startFakeModels(0, '127.0.0.1', { apiKey: 'sk-argos-secret' });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-providers-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  adminT = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  await ok('POST', '/api/admin/accounts', adminT, { username: 'dungeon', password: 'dm password 123' });
  dmT = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
});

after(async () => {
  server?.close();
  server?.closeAllConnections?.();
  await fake.close();
  await keyed.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- Discover: the mapping from Argos-shaped records ---------------------------------

const rec = (id: string, over: Record<string, unknown> = {}) => ({ id, object: 'model', owned_by: 'argos', status: { value: 'loaded' }, ...over });
const arch = (i: string[], o: string[]) => ({ architecture: { input_modalities: i, output_modalities: o } });

test('ModelsDiscover_MapsAMixedArgosSetAndLeavesUnknownsUnset', () => {
  const models = [
    rec('qwen3-32b', { ...arch(['text'], ['text']), capabilities: { tools: true, function_calling: true }, context_length: 32768, description: 'Main chat model' }),
    rec('qwen3-4b', { ...arch(['text'], ['text']), context_length: 8192, status: { value: 'unloaded' } }),
    rec('whisper-large-v3', { ...arch(['audio'], ['text']), capabilities: { audio_transcriptions: true } }),
    rec('kokoro', { ...arch(['text'], ['audio']), capabilities: { audio_speech: true } }),
    rec('bge-m3', { ...arch(['text'], ['text']), description: 'Embedding model' }),
    rec('bge-reranker', { ...arch(['text'], ['text']), capabilities: { reranker: true } }),
    rec('flux-schnell', { ...arch(['text'], ['image']) }),
    rec('mystery-model'), // no metadata at all
  ].map((r) => normalizeModel(r)!);
  const s = suggestJobs(models);
  assert.equal(s.chat.model, 'qwen3-32b');
  assert.match(s.chat.reason, /tool/i);
  assert.equal(s.audit.model, 'qwen3-4b', 'the smallest text model');
  assert.equal(s.audio.model, 'whisper-large-v3', 'audio in, text out');
  assert.equal(s.voice.model, 'kokoro', 'audio out');
  assert.equal(s.extra.model, 'bge-m3', 'embed in the name or description');
  assert.equal(s.rerank.model, 'bge-reranker', 'the reranker capability');
  const by = Object.fromEntries(models.map((m) => [m.id, m]));
  assert.equal(by['qwen3-4b'].status, 'unloaded');
  assert.equal(by['qwen3-32b'].contextLength, 32768);
  assert.equal(by['qwen3-32b'].tools, true);
  assert.equal(by['flux-schnell'].role, 'other', 'an image model fits no job');
  assert.equal(by['mystery-model'].role, 'unknown');
  for (const j of Object.values(s)) assert.ok(j.reason.length > 5, 'every job says why');
  assert.ok(!Object.values(s).some((j) => j.model === 'mystery-model' || j.model === 'flux-schnell'));
});

test('ModelsDiscover_NamedAuditorBeatsSmallest', () => {
  const s = suggestJobs([
    rec('big-chat', { ...arch(['text'], ['text']), capabilities: { tools: true } }),
    rec('tiny-1b', { ...arch(['text'], ['text']) }),
    rec('spoiler-classifier', { ...arch(['text'], ['text']), context_length: 4096 }),
  ].map((r) => normalizeModel(r)!));
  assert.equal(s.audit.model, 'spoiler-classifier');
  assert.match(s.audit.reason, /classifier/);
});

test('ModelsDiscover_UnsureLeavesTheJobUnsetAndSaysWhy', () => {
  // Text models but none that call tools: chat is not guessed.
  const none = suggestJobs([rec('a-model', { ...arch(['text'], ['text']) }), rec('b-model', { ...arch(['text'], ['text']) })].map((r) => normalizeModel(r)!));
  assert.equal(none.chat.model, null);
  assert.match(none.chat.reason, /tool/i);
  assert.equal(none.audit.model, null, 'two text models and nothing to tell their size apart');
  assert.match(none.audit.reason, /choose/i);
  assert.equal(none.audio.model, null);
  assert.match(none.audio.reason, /speech to text/i);
  assert.equal(none.rerank.model, null);
  // One text model only: it is the chat model, and audit is not invented.
  const one = suggestJobs([rec('solo', { ...arch(['text'], ['text']), capabilities: { tools: true } })].map((r) => normalizeModel(r)!));
  assert.equal(one.chat.model, 'solo');
  assert.equal(one.audit.model, null);
  assert.match(one.audit.reason, /only one text model/i);
  // Nothing at all.
  const empty = suggestJobs([]);
  for (const j of ['chat', 'audit', 'audio', 'voice', 'extra', 'rerank'] as const) assert.equal(empty[j].model, null);
});

test('ModelsDiscover_AddressWithOrWithoutV1', () => {
  assert.equal(normalizeArgosUrl('http://argos:8080'), 'http://argos:8080/v1');
  assert.equal(normalizeArgosUrl('http://argos:8080/'), 'http://argos:8080/v1');
  assert.equal(normalizeArgosUrl('http://argos:8080/v1'), 'http://argos:8080/v1');
  assert.equal(normalizeArgosUrl('http://argos:8080/v1/'), 'http://argos:8080/v1');
  assert.equal(argosWebUrl('http://argos:8080/v1'), 'http://argos:8080');
});

test('ModelsDiscover_EndpointAgainstTheFakeArgos', async () => {
  const bare = fake.baseUrl.replace(/\/v1$/, '');
  const d = await ok('POST', `${A}/discover`, adminT, { kind: 'argos', baseUrl: bare });
  assert.equal(d.ok, true);
  assert.equal(d.baseUrl, bare + '/v1');
  assert.equal(d.webUrl, bare, 'the Argos web page is the address without /v1');
  assert.equal(d.models.length, 6);
  const rr = d.models.find((m: any) => m.id === 'fake-rerank');
  assert.equal(rr.status, 'unloaded');
  assert.equal(rr.reranker, true);
  assert.equal(d.models.find((m: any) => m.id === 'fake-chat').contextLength, 32768);
  assert.deepEqual(Object.fromEntries(Object.entries(d.suggestions).map(([k, v]: any) => [k, v.model])), { chat: 'fake-chat', audit: 'fake-audit', audio: 'fake-whisper', voice: 'fake-kokoro', extra: 'fake-embed', rerank: 'fake-rerank' });
  assert.deepEqual(d.voices, ['af_heart', 'af_bella', 'bm_george', 'bf_emma']);
  // A bad address is an answer, not a crash.
  const bad = await ok('POST', `${A}/discover`, adminT, { kind: 'argos', baseUrl: DEAD });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /reach|answer/i);
  assert.equal((await call('POST', `${A}/discover`, adminT, { kind: 'argos', baseUrl: 'ftp://x' })).status, 400);
});

// ---- providers ------------------------------------------------------------------------

let argosId = '';

test('ModelsProviders_CreateArgosNormalizesAndNeverReturnsTheKey', async () => {
  const bare = keyed.baseUrl.replace(/\/v1$/, '');
  const made = await call('POST', `${A}/providers`, adminT, { name: 'My Argos', kind: 'argos', baseUrl: bare, apiKey: 'sk-argos-secret' });
  assert.equal(made.status, 201);
  assert.ok(!made.text.includes('sk-argos-secret'), 'POST leaked the key');
  assert.equal(made.body.provider.baseUrl, bare + '/v1');
  assert.equal(made.body.provider.apiKey, '••••');
  assert.equal(made.body.provider.location, 'local');
  assert.equal(made.body.provider.webUrl, bare);
  argosId = made.body.provider.id;

  const list = await call('GET', A, adminT);
  assert.ok(!list.text.includes('sk-argos-secret'), 'GET leaked the key');
  assert.equal(list.body.providers.find((p: any) => p.id === argosId).apiKey, '••••');

  // Mask or no key keeps it; the stored value is untouched.
  const put = await call('PUT', `${A}/providers/${argosId}`, adminT, { name: 'Argos at home', apiKey: '••••' });
  assert.ok(!put.text.includes('sk-argos-secret'));
  assert.equal(one<any>(deps.db, 'SELECT api_key FROM models_providers WHERE id = ?', argosId).api_key, 'sk-argos-secret');
  assert.equal(put.body.provider.name, 'Argos at home');

  const dis = await call('POST', `${A}/discover`, adminT, { providerId: argosId });
  assert.ok(!dis.text.includes('sk-argos-secret'), 'discover leaked the key');
  const log = await call('GET', '/api/admin/audit', adminT);
  assert.ok(!log.text.includes('sk-argos-secret'), 'the audit log has the key');
  assert.ok(log.text.includes('models.provider.create'));
});

test('ModelsProviders_ArgosKeyIsSentAsBearer', async () => {
  keyed.requests.length = 0;
  const d = await ok('POST', `${A}/discover`, adminT, { providerId: argosId });
  assert.equal(d.ok, true);
  assert.ok(keyed.requests.length >= 1);
  for (const r of keyed.requests) assert.equal(r.authorization, 'Bearer sk-argos-secret', `${r.path} carried the key`);

  // Without the key Argos says 401, and Discover explains.
  const no = await ok('POST', `${A}/discover`, adminT, { kind: 'argos', baseUrl: keyed.baseUrl });
  assert.equal(no.ok, false);
  assert.match(no.error, /rejected the API key|401/);
  // A key typed into the form works before anything is saved.
  const typed = await ok('POST', `${A}/discover`, adminT, { kind: 'argos', baseUrl: keyed.baseUrl, apiKey: 'sk-argos-secret' });
  assert.equal(typed.ok, true);

  // A job on this provider sends it on every kind of call.
  await ok('PUT', A, adminT, { jobs: { chat: { providerId: argosId, model: 'fake-chat' }, extra: { providerId: argosId, model: 'fake-embed' } } });
  keyed.requests.length = 0;
  assert.match((await chat(deps, 'chat', { messages: [{ role: 'user', content: 'hello keep' }] })).content, /hello keep/);
  assert.equal((await embed(deps, ['x'])).length, 1);
  assert.deepEqual(keyed.requests.map((r) => r.authorization), ['Bearer sk-argos-secret', 'Bearer sk-argos-secret']);
  assert.deepEqual(keyed.requests.map((r) => r.path), ['/v1/chat/completions', '/v1/embeddings']);
  assert.equal(keyed.requests[0].body.model, 'fake-chat');
});

test('ModelsProviders_ValidationAndGuards', async () => {
  assert.equal((await call('POST', `${A}/providers`, adminT, { kind: 'nope', baseUrl: 'http://x' })).status, 400);
  assert.equal((await call('POST', `${A}/providers`, adminT, { kind: 'argos' })).status, 400);
  assert.equal((await call('POST', `${A}/providers`, adminT, { kind: 'openai', baseUrl: 'ftp://x' })).status, 400);
  assert.equal((await call('POST', `${A}/providers`, adminT, { kind: 'openai', baseUrl: 'https://api.openai.com/v1', location: 'moon' })).status, 400);
  assert.equal((await call('PUT', `${A}/providers/nope`, adminT, { name: 'x' })).status, 404);
  assert.equal((await call('PUT', A, adminT, { jobs: { chat: { providerId: 'nope' } } })).status, 400);
  assert.equal((await call('PUT', A, adminT, { jobs: { chat: { fallback: { providerId: 'nope' } } } })).status, 400);
  // In use: cannot be deleted.
  assert.equal((await call('DELETE', `${A}/providers/${argosId}`, adminT)).status, 409);
  // Admins only.
  for (const [m, u, b] of [['POST', `${A}/providers`, { kind: 'argos', baseUrl: 'http://x' }], ['PUT', `${A}/providers/${argosId}`, {}], ['DELETE', `${A}/providers/${argosId}`, undefined], ['POST', `${A}/discover`, {}], ['GET', `${A}/status`, undefined], ['POST', `${A}/chat/warm`, undefined], ['GET', `${A}/providers/${argosId}/voices`, undefined]] as const) {
    assert.equal((await call(m, u, dmT, b)).status, 403, `${m} ${u}`);
    assert.equal((await call(m, u, undefined, b)).status, 401, `${m} ${u} signed out`);
  }
});

test('ModelsProviders_OpenAiDefaultsToCloudAndOllamaGetsV1', async () => {
  const o = (await ok('POST', `${A}/providers`, adminT, { kind: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'sk-openai' })).provider;
  assert.equal(o.location, 'cloud');
  assert.equal(o.baseUrl, 'https://api.openai.com/v1');
  const ol = (await ok('POST', `${A}/providers`, adminT, { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' })).provider;
  assert.equal(ol.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(ol.location, 'local');
  const c = (await ok('POST', `${A}/providers`, adminT, { kind: 'openai-compatible', baseUrl: 'https://models.example.com/v1' })).provider;
  assert.equal(c.location, 'cloud', 'an unknown public host is cloud');
  for (const p of [o, ol, c]) await ok('DELETE', `${A}/providers/${p.id}`, adminT);
});

// ---- jobs: providers, fallback, the local to cloud switch ------------------------------------

test('ModelsJobs_PickAProviderAndAModel', async () => {
  const p = (await ok('POST', `${A}/providers`, adminT, { name: 'Fake Argos', kind: 'argos', baseUrl: fake.baseUrl })).provider;
  const saved = await ok('PUT', A, adminT, { jobs: {
    chat: { providerId: p.id, model: 'fake-chat' }, audit: { providerId: p.id, model: 'fake-audit' }, audio: { providerId: p.id, model: 'fake-whisper' },
    voice: { providerId: p.id, model: 'fake-kokoro', options: { voice: 'bm_george' } }, extra: { providerId: p.id, model: 'fake-embed' }, rerank: { providerId: p.id, model: 'fake-rerank' },
  } });
  assert.equal(job(saved, 'rerank').source, 'saved');
  assert.equal(job(saved, 'chat').providerId, p.id);
  assert.equal(job(saved, 'chat').effective.provider, 'Fake Argos');
  assert.equal(jobConfig(deps, 'voice')!.options!.voice, 'bm_george');
  assert.equal(jobConfig(deps, 'chat')!.providerId, p.id);
  assert.equal(hasJob(deps, 'rerank'), true);
  for (const j of ['chat', 'audit', 'audio', 'voice', 'extra', 'rerank']) {
    const t = await ok('POST', `${A}/${j}/test`, adminT);
    assert.equal(t.ok, true, `${j}: ${JSON.stringify(t)}`);
  }
  // Changing a provider's address moves every job on it.
  const r = (await ok('GET', A, adminT)).providers.find((x: any) => x.id === p.id);
  assert.deepEqual([...r.usedBy].sort(), ['audio', 'audit', 'chat', 'extra', 'rerank', 'voice']);
});

test('ModelsJobs_FallbackOnAnOutageAndTheCloudSwitch', async () => {
  const main = (await ok('POST', `${A}/providers`, adminT, { name: 'Home Argos (down)', kind: 'argos', baseUrl: DEAD })).provider;
  const lan = (await ok('POST', `${A}/providers`, adminT, { name: 'Spare box', kind: 'openai-compatible', baseUrl: fake.baseUrl, location: 'local' })).provider;
  const cloud = (await ok('POST', `${A}/providers`, adminT, { name: 'Frontier', kind: 'openai-compatible', baseUrl: fake.baseUrl, location: 'cloud', apiKey: 'sk-frontier' })).provider;

  // local to local: no switch needed.
  let v = await ok('PUT', A, adminT, { jobs: { chat: { providerId: main.id, model: 'fake-chat', fallback: { providerId: lan.id, model: 'fake-chat' } } } });
  assert.equal(job(v, 'chat').fallback.providerId, lan.id);
  assert.equal(job(v, 'chat').fallbackBlocked, false);
  assert.match((await chat(deps, 'chat', { messages: [{ role: 'user', content: 'who rules the keep' }] })).content, /who rules the keep/);

  // local to cloud: blocked until the switch is on, and the page is told.
  v = await ok('PUT', A, adminT, { jobs: { chat: { fallback: { providerId: cloud.id, model: 'frontier-chat' } } } });
  assert.equal(job(v, 'chat').fallbackBlocked, true);
  assert.equal(job(v, 'chat').fallback.allowCloud, false);
  assert.equal(chainFor(deps, 'chat').length, 1);
  fake.requests.length = 0;
  await assert.rejects(chat(deps, 'chat', { messages: [{ role: 'user', content: 'who rules the keep' }] }), ModelUnavailable);
  assert.equal(fake.requests.length, 0, 'nothing went to the cloud provider');

  v = await ok('PUT', A, adminT, { jobs: { chat: { fallback: { allowCloud: true } } } });
  assert.equal(job(v, 'chat').fallbackBlocked, false);
  assert.equal(job(v, 'chat').fallback.allowCloud, true);
  const r = await chat(deps, 'chat', { messages: [{ role: 'user', content: 'who rules the keep' }] });
  assert.match(r.content, /who rules the keep/);
  assert.equal(fake.requests.at(-1)!.authorization, 'Bearer sk-frontier');
  assert.equal(fake.requests.at(-1)!.body.model, 'frontier-chat');
  assert.ok(all<any>(deps.db, "SELECT detail FROM audit WHERE action = 'models.cloud_fallback_allowed'").some((a) => /chat/.test(a.detail)), 'turning the switch on is audited');

  // Test can reach each side on its own.
  assert.equal((await ok('POST', `${A}/chat/test`, adminT)).ok, false, 'the main provider is down');
  const tf = await ok('POST', `${A}/chat/test?which=fallback`, adminT);
  assert.equal(tf.ok, true);

  // Clearing it.
  v = await ok('PUT', A, adminT, { jobs: { chat: { fallback: null } } });
  assert.equal(job(v, 'chat').fallback, null);
  assert.equal(job(v, 'chat').fallbackBlocked, false);
  assert.equal((await call('PUT', A, adminT, { jobs: { audit: { providerId: '', fallback: { providerId: lan.id } } } })).status, 400, 'a fallback needs a main provider');
  // Put chat back on the fake Argos for the tests below.
  const fakeArgos = v.providers.find((p: any) => p.name === 'Fake Argos');
  await ok('PUT', A, adminT, { jobs: { chat: { providerId: fakeArgos.id, model: 'fake-chat' } } });
});

test('ModelsJobs_NoFallbackOnARequestError', async () => {
  const bad = (await ok('POST', `${A}/providers`, adminT, { name: 'Strict', kind: 'openai-compatible', baseUrl: fake.baseUrl + '/nope', location: 'local' })).provider;
  // fake-models answers an unknown path with 404 "no route": a missing model, which does fall back.
  const lan = listProviders().find((p: any) => p.name === 'Spare box');
  await ok('PUT', A, adminT, { jobs: { extra: { providerId: bad.id, model: 'm', fallback: { providerId: lan.id, model: 'fake-embed' } } } });
  assert.equal((await embed(deps, ['x'])).length, 1, '404 (not found) falls back');
  const fake400 = await startRejecting();
  const strict = (await ok('POST', `${A}/providers`, adminT, { name: 'Rejects', kind: 'openai-compatible', baseUrl: fake400.url, location: 'local' })).provider;
  await ok('PUT', A, adminT, { jobs: { extra: { providerId: strict.id, model: 'm', fallback: { providerId: lan.id, model: 'fake-embed' } } } });
  fake.requests.length = 0;
  await assert.rejects(embed(deps, ['x']), (e: any) => e instanceof ModelUnavailable && e.status === 400);
  assert.equal(fake.requests.length, 0, 'a 400 about the request never falls back');
  await fake400.close();
  const fakeArgos = listProviders().find((p: any) => p.name === 'Fake Argos');
  await ok('PUT', A, adminT, { jobs: { extra: { providerId: fakeArgos.id, model: 'fake-embed', fallback: null } } });
});

const listProviders = () => all<any>(deps.db, 'SELECT * FROM models_providers');

async function startRejecting() {
  const http = await import('node:http');
  const s = http.createServer((_req, res) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'input must be a list of strings' } })); });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`, close: () => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.(); }) };
}

// ---- migration of old per-job settings ---------------------------------------------------------

test('ModelsMigration_OldJobSettingsBecomeOneProviderPerBaseUrl', () => {
  run(deps.db, 'DELETE FROM models_jobs');
  run(deps.db, 'DELETE FROM models_providers');
  run(deps.db, "DELETE FROM models_meta WHERE key = 'providers_migrated'");
  const ins = (job: string, url: string, model: string, key: string, opts = '{}') =>
    run(deps.db, "INSERT INTO models_jobs (job, base_url, model, api_key, options, enabled, updated_at) VALUES (?,?,?,?,?,1,'2025-01-01')", job, url, model, key, opts);
  ins('chat', 'http://argos.lan:8080/v1', 'qwen', 'sk-lan');
  ins('audit', 'http://argos.lan:8080/v1', 'qwen-small', '');
  ins('extra', 'http://argos.lan:8080/v1', 'bge', 'sk-lan');
  ins('audio', 'http://whisper:8000/v1', 'large-v3', '');
  ins('voice', 'https://api.openai.com/v1', 'tts-1', 'sk-openai', '{"voice":"alloy"}');
  ins('rerank', 'http://argos.lan:8080/v1/', 'bge-reranker', 'sk-other');

  assert.equal(migrateJobsToProviders(deps.db), 4, 'argos.lan, whisper, openai, and argos.lan again for the job with a different key');
  const provs = listProviders();
  const byUrl = (u: string) => provs.filter((p: any) => p.base_url === u);
  assert.equal(byUrl('http://argos.lan:8080/v1').length, 2);
  assert.equal(byUrl('http://whisper:8000/v1').length, 1);
  assert.equal(byUrl('https://api.openai.com/v1')[0].kind, 'openai');
  assert.equal(byUrl('https://api.openai.com/v1')[0].location, 'cloud');
  assert.equal(byUrl('http://whisper:8000/v1')[0].location, 'local');

  const row = (j: string) => one<any>(deps.db, 'SELECT * FROM models_jobs WHERE job = ?', j);
  assert.equal(row('chat').provider_id, row('audit').provider_id, 'same URL and no conflicting key: one provider');
  assert.equal(row('chat').provider_id, row('extra').provider_id);
  assert.notEqual(row('chat').provider_id, row('rerank').provider_id, 'a different key is a different provider');
  assert.equal(row('chat').base_url, '', 'the copies on the job rows are cleared');
  assert.equal(row('chat').api_key, '');
  assert.equal(row('chat').model, 'qwen', 'models stay on the job');
  assert.equal(row('voice').options, '{"voice":"alloy"}');

  // The jobs resolve exactly as before.
  const c = jobConfig(deps, 'chat')!;
  assert.deepEqual([c.baseUrl, c.model, c.apiKey], ['http://argos.lan:8080/v1', 'qwen', 'sk-lan']);
  assert.equal(jobConfig(deps, 'audit')!.apiKey, 'sk-lan', 'the keyless job joined the provider that has the key');
  assert.equal(jobConfig(deps, 'voice')!.options!.voice, 'alloy');
  assert.equal(jobConfig(deps, 'rerank')!.apiKey, 'sk-other');

  // Once: a second run does nothing, and a new legacy row is not touched automatically.
  assert.equal(migrateJobsToProviders(deps.db), 0);
  assert.equal(listProviders().length, provs.length);

  // Put the fake Argos back for the tests that follow.
  run(deps.db, 'DELETE FROM models_jobs');
  run(deps.db, 'DELETE FROM models_providers');
  run(deps.db, "INSERT INTO models_providers (id, name, kind, base_url, api_key, location, created_at, updated_at) VALUES ('prov_fake', 'Fake Argos', 'argos', ?, '', 'local', '2025-01-01', '2025-01-01')", fake.baseUrl);
});

test('ModelsMigration_RunsOnStartAndKeepsEnvVarsWorking', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-migrate-'));
  try {
    const dataDir = path.join(dir, 'data');
    const first = createApp({ noScheduler: true, dbFile: path.join(dir, 'a.db'), dataDir, vaultsDir: path.join(dir, 'vaults'), env: {} });
    // An install from before providers: the settings table has only the old columns.
    first.deps.db.exec('DROP TABLE models_jobs; DROP TABLE models_providers; DROP TABLE models_meta;');
    first.deps.db.exec("CREATE TABLE models_jobs (job TEXT PRIMARY KEY, base_url TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', api_key TEXT NOT NULL DEFAULT '', options TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)");
    first.deps.db.exec("INSERT INTO models_jobs (job, base_url, model, api_key, updated_at) VALUES ('chat', 'http://old.lan:8080/v1', 'old-model', 'sk-old', '2025-01-01'), ('audit', 'http://old.lan:8080/v1', 'old-small', 'sk-old', '2025-01-01')");
    first.deps.db.close?.();
    const second = createApp({ noScheduler: true, dbFile: path.join(dir, 'a.db'), dataDir, vaultsDir: path.join(dir, 'vaults'), env: { ALX_MODEL_EXTRA_URL: 'http://env.lan/v1', ALX_MODEL_EXTRA_MODEL: 'env-embed', ALX_MODEL_RERANK_URL: 'http://env.lan/v1', ALX_MODEL_RERANK_MODEL: 'env-rerank' } });
    const d = second.deps;
    const provs = all<any>(d.db, 'SELECT * FROM models_providers');
    assert.equal(provs.length, 1, 'one provider for the one URL');
    assert.equal(provs[0].api_key, 'sk-old');
    assert.equal(jobConfig(d, 'chat')!.model, 'old-model');
    assert.equal(jobConfig(d, 'audit')!.apiKey, 'sk-old');
    // Env variables still work for jobs with nothing saved, rerank included.
    assert.equal(jobConfig(d, 'extra')!.model, 'env-embed');
    assert.equal(jobConfig(d, 'rerank')!.model, 'env-rerank');
    // MODEL_BASE_URL alone does not switch rerank on: not every server has it.
    assert.equal(jobConfig({ ...d, env: { MODEL_BASE_URL: 'http://env.lan/v1' } }, 'rerank'), null);
    assert.equal(jobConfig({ ...d, env: { MODEL_BASE_URL: 'http://env.lan/v1' } }, 'voice')!.baseUrl, 'http://env.lan/v1');
    d.db.close?.();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- status, warm up, keep warm, voices -------------------------------------------------------------

test('ModelsStatus_ShowsLoadedAndUnloadedFromArgos', async () => {
  const fakeArgos = listProviders().find((p: any) => p.name === 'Fake Argos');
  await ok('PUT', A, adminT, { jobs: {
    chat: { providerId: fakeArgos.id, model: 'fake-chat', enabled: true }, rerank: { providerId: fakeArgos.id, model: 'fake-rerank', enabled: true }, audio: { providerId: fakeArgos.id, model: 'not-a-model', enabled: true },
    audit: { providerId: fakeArgos.id, model: 'fake-audit', enabled: true }, voice: { providerId: fakeArgos.id, model: 'fake-kokoro', enabled: true }, extra: { providerId: fakeArgos.id, model: 'fake-embed', enabled: true },
  } });
  const s = await ok('GET', `${A}/status`, adminT);
  assert.equal(s.jobs.chat.primary, 'loaded');
  assert.equal(s.jobs.rerank.primary, 'unloaded');
  assert.equal(s.jobs.audio.primary, 'missing');
  assert.equal(s.providers[fakeArgos.id].ok, true);
  const dead = (await ok('POST', `${A}/providers`, adminT, { kind: 'argos', baseUrl: DEAD, name: 'Offline' })).provider;
  await ok('PUT', A, adminT, { jobs: { audio: { providerId: dead.id, model: 'w' } } });
  const s2 = await ok('GET', `${A}/status`, adminT);
  assert.equal(s2.jobs.audio.primary, 'unreachable');
  assert.equal(s2.providers[dead.id].ok, false);
  await ok('PUT', A, adminT, { jobs: { audio: { providerId: fakeArgos.id, model: 'fake-whisper' } } });
  await ok('DELETE', `${A}/providers/${dead.id}`, adminT);
});

test('ModelsWarm_SendsATinyRequestToTheMainProvider', async () => {
  fake.requests.length = 0;
  const w = await ok('POST', `${A}/chat/warm`, adminT);
  assert.equal(w.ok, true);
  assert.deepEqual(fake.requests.map((r) => r.path), ['/v1/chat/completions']);
  assert.ok(fake.requests[0].body.max_tokens <= 16, 'a tiny request');
  assert.equal((await call('POST', `${A}/bogus/warm`, adminT)).status, 404);
  const wr = await ok('POST', `${A}/rerank/warm`, adminT);
  assert.equal(wr.ok, true);
});

test('ModelsKeepWarm_OffByDefaultAndOnlyWhileASessionIsLive', async () => {
  fake.requests.length = 0;
  assert.deepEqual(await keepWarmTick(deps), [], 'no job asked for it');
  const v = await ok('PUT', A, adminT, { jobs: { chat: { keepWarm: true } } });
  assert.equal(job(v, 'chat').keepWarm, true);
  assert.equal(job(v, 'audit').keepWarm, false, 'default off');
  assert.deepEqual(await keepWarmTick(deps), [], 'no session is live');
  assert.equal(fake.requests.length, 0);

  run(deps.db, "INSERT INTO accounts (id, username, display_name, pass_hash, is_admin, created_at) VALUES ('a_kw', 'kw', 'KW', 'x', 0, '2025-01-01')");
  run(deps.db, "INSERT INTO worlds (id, slug, name, created_at) VALUES ('w_kw', 'kw', 'KW', '2025-01-01')");
  run(deps.db, "INSERT INTO audio_sessions (id, world_id, name, started_at) VALUES ('s_kw', 'w_kw', 'Game night', ?)", new Date().toISOString());
  assert.deepEqual(await keepWarmTick(deps), ['chat']);
  assert.deepEqual(fake.requests.map((r) => r.path), ['/v1/chat/completions']);
  run(deps.db, "UPDATE audio_sessions SET stopped_at = ? WHERE id = 's_kw'", new Date().toISOString());
  assert.deepEqual(await keepWarmTick(deps), []);
  await ok('PUT', A, adminT, { jobs: { chat: { keepWarm: false } } });
});

test('ModelsVoices_PresetNamesForTheVoiceFeature', async () => {
  assert.deepEqual(await listVoiceNames(deps), ['af_heart', 'af_bella', 'bm_george', 'bf_emma']);
  const fakeArgos = listProviders().find((p: any) => p.name === 'Fake Argos');
  const v = await ok('GET', `${A}/providers/${fakeArgos.id}/voices?model=fake-kokoro`, adminT);
  assert.deepEqual(v.voices, ['af_heart', 'af_bella', 'bm_george', 'bf_emma']);
  assert.ok(fake.requests.some((r) => r.path === '/v1/audio/voices'));
  // A voice job on a plain OpenAI-style provider has no preset list.
  const plain = (await ok('POST', `${A}/providers`, adminT, { kind: 'openai-compatible', baseUrl: fake.baseUrl, location: 'local', name: 'Plain' })).provider;
  await ok('PUT', A, adminT, { jobs: { voice: { providerId: plain.id } } });
  assert.deepEqual(await listVoiceNames(deps), []);
  await ok('PUT', A, adminT, { jobs: { voice: { providerId: fakeArgos.id } } });
});

// ---- rerank in library search --------------------------------------------------------------------------

test('ModelsRerank_ReordersLibrarySearchAndOnlyReadsThisViewersCopy', async () => {
  const f = await startFakeModels(0);
  const { deps: d } = createApp({ noScheduler: true, env: { ALX_MODEL_RERANK_URL: f.baseUrl, ALX_MODEL_RERANK_MODEL: 'fake-rerank' } });
  try {
    run(d.db, "INSERT INTO worlds (id, slug, name, created_at) VALUES ('w_rr', 'rr', 'RR', '2025-01-01')");
    const L = d.library;
    const DM_ONLY = 'zzsecretmarker the smuggler hides contraband';
    L.save('w_rr', { path: 'a/one', title: 'Harbour captains', body: 'Long ago the old pier saw many ships and merchants and sailors and gulls and nets and barrels and ropes. The harbour captains rarely agree. Nobody writes these long dull stories down any more, because everybody already knows them all.', visibility: 'party' }, null);
    L.save('w_rr', { path: 'a/two', title: 'Rumour', body: 'harbour captains', visibility: 'party' }, null);
    L.save('w_rr', { path: 'a/three', title: 'Harbour smugglers', body: `${DM_ONLY} harbour captains`, visibility: 'dm' }, null);
    const plain = (d.library.search('w_rr', 'harbour captains', { accountId: '', role: 'player' }, 20) as any[]);
    assert.equal(plain.length, 2, 'two shared pages match');
    const hits = await hybridPages(d, 'w_rr', 'harbour captains', 'party', 20);
    const sentDocs: string[] = f.requests.find((r) => r.path === '/v1/rerank')!.body.documents;
    const best = sentDocs.map((t, i) => ({ i, s: fakeRelevance('harbour captains', t) })).sort((a, b) => b.s - a.s)[0].i;
    assert.equal(plain[0].title, 'Harbour captains', 'the keyword order has the long page first');
    assert.equal(hits[0].title, 'Rumour', 'the reranker moved the short, dense page up');
    assert.equal(hits[0].title, plain[best].title, `the reranker's choice is first (keyword order was ${plain.map((h) => h.title).join(', ')})`);
    assert.deepEqual(new Set(hits.map((h) => h.id)), new Set(plain.map((h) => h.id)), 'nothing added or lost');
    assert.equal(f.requests.filter((r) => r.path === '/v1/rerank').length, 1);
    const sent = JSON.stringify(f.requests.map((r) => r.body));
    assert.ok(!sent.includes('zzsecretmarker'), 'the player search sent no DM-only text');
    assert.ok(!sent.includes('Harbour smugglers'));
    assert.equal(f.requests.find((r) => r.path === '/v1/rerank')!.body.top_n, hits.length);
  } finally { await f.close(); }
});

test('ModelsRerank_KeywordOrderStandsWhenTheRerankerIsDownOrSlow', async () => {
  for (const env of [{ ALX_MODEL_RERANK_URL: DEAD }, {}]) {
    const { deps: d } = createApp({ noScheduler: true, env });
    run(d.db, "INSERT INTO worlds (id, slug, name, created_at) VALUES ('w_rr2', 'rr2', 'RR2', '2025-01-01')");
    d.library.save('w_rr2', { path: 'a/one', title: 'Lantern', body: 'A lantern.', visibility: 'party' }, null);
    d.library.save('w_rr2', { path: 'a/two', title: 'Lantern festival', body: 'A festival of lanterns.', visibility: 'party' }, null);
    const kw = (d.library.search('w_rr2', 'lantern', { accountId: '', role: 'player' }, 20) as any[]).map((h) => h.id);
    const t0 = Date.now();
    const got = (await hybridPages(d, 'w_rr2', 'lantern', 'party', 20)).map((h) => h.id);
    assert.deepEqual(got, kw);
    assert.ok(Date.now() - t0 < 1500);
  }
  // And a rerank call that is too slow gives up at the budget (see ai-fallback.test.ts): here, just the exported call fails cleanly.
  const { deps: d } = createApp({ noScheduler: true, env: {} });
  await assert.rejects(rerank(d, 'q', ['a']), ModelUnavailable);
});
