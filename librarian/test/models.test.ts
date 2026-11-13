// Admin → Models: saved settings drive core/ai.ts, keys are write-only, the
// Test button works against the fake models server, and only admins get in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { chat, chatJson, embed, speak, transcribe, hasJob, jobConfig, ModelUnavailable } from '../src/core/ai.ts';
import { startFakeModels, type FakeModels } from '../scripts/fake-models.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
let fake: FakeModels;
let adminT = '';
let dmT = '';

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
  fake = await startFakeModels(0);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-models-'));
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
  await fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('Models_NonAdminsGet403', async () => {
  assert.equal((await call('GET', '/api/admin/models', dmT)).status, 403);
  assert.equal((await call('PUT', '/api/admin/models', dmT, { jobs: { chat: { baseUrl: 'http://x/v1' } } })).status, 403);
  assert.equal((await call('POST', '/api/admin/models/chat/test', dmT)).status, 403);
  assert.equal((await call('GET', '/api/admin/models')).status, 401);
});

test('Models_ListsFiveJobsEmpty', async () => {
  const l = await ok('GET', '/api/admin/models', adminT);
  assert.deepEqual(l.jobs.map((j: any) => j.job), ['chat', 'audit', 'audio', 'voice', 'extra']);
  for (const j of l.jobs) { assert.equal(j.source, 'none'); assert.equal(j.enabled, true); }
  assert.equal(hasJob(deps, 'chat'), false);
  await assert.rejects(chat(deps, 'chat', { messages: [{ role: 'user', content: 'hi' }] }), ModelUnavailable);
  const t = await ok('POST', '/api/admin/models/chat/test', adminT);
  assert.equal(t.ok, false);
});

test('Models_ValidatesInput', async () => {
  assert.equal((await call('PUT', '/api/admin/models', adminT, { jobs: { nope: {} } })).status, 400);
  assert.equal((await call('PUT', '/api/admin/models', adminT, { jobs: { chat: { baseUrl: 'ftp://x' } } })).status, 400);
  assert.equal((await call('PUT', '/api/admin/models', adminT, { jobs: { chat: { baseUrl: 'not a url' } } })).status, 400);
  assert.equal((await call('PUT', '/api/admin/models', adminT, { jobs: { chat: { options: '{bad' } } })).status, 400);
  assert.equal((await call('PUT', '/api/admin/models', adminT, { jobs: { chat: { options: '[1]' } } })).status, 400);
  assert.equal((await call('POST', '/api/admin/models/bogus/test', adminT)).status, 404);
});

test('Models_SavedSettingsDriveAi', async () => {
  const saved = await ok('PUT', '/api/admin/models', adminT, {
    jobs: {
      chat: { baseUrl: fake.baseUrl + '/', model: 'fake-chat', apiKey: 'sk-secret-123', enabled: true },
      audit: { baseUrl: fake.baseUrl, model: 'fake-audit' },
      audio: { baseUrl: fake.baseUrl, model: 'fake-whisper' },
      voice: { baseUrl: fake.baseUrl, model: 'fake-kokoro', options: { voice: 'bm_george' } },
      extra: { baseUrl: fake.baseUrl, model: 'fake-embed' },
    },
  });
  assert.equal(job(saved, 'chat').source, 'saved');
  assert.equal(job(saved, 'chat').baseUrl, fake.baseUrl); // trailing slash trimmed

  const cfg = jobConfig(deps, 'chat')!;
  assert.equal(cfg.apiKey, 'sk-secret-123');
  assert.equal(cfg.model, 'fake-chat');

  fake.requests.length = 0;
  const r = await chat(deps, 'chat', { messages: [{ role: 'user', content: 'Where is the keep?' }] });
  assert.match(r.content, /Where is the keep/);
  assert.equal(fake.requests.at(-1)!.authorization, 'Bearer sk-secret-123');
  assert.equal(fake.requests.at(-1)!.body.model, 'fake-chat');

  await speak(deps, 'hello', { format: 'wav' });
  assert.equal(fake.requests.at(-1)!.body.voice, 'bm_george');
  assert.equal(fake.requests.at(-1)!.body.model, 'fake-kokoro');

  const t = await transcribe(deps, new TextEncoder().encode('FAKE: hello there.'), 'audio/wav');
  assert.equal(t.text, 'hello there.');
  assert.equal((await embed(deps, ['a', 'b'])).length, 2);
  assert.deepEqual(await chatJson(deps, 'audit', [{ role: 'system', content: 'FAKE_JSON: {"scope":"world"}' }, { role: 'user', content: 'x' }]), { scope: 'world' });
});

test('Models_KeysNeverComeBack', async () => {
  const get = await call('GET', '/api/admin/models', adminT);
  assert.ok(!get.text.includes('sk-secret-123'), 'GET leaked the key');
  assert.equal(job(get.body, 'chat').apiKey, '••••');
  assert.equal(job(get.body, 'audit').apiKey, '');

  // Sending the mask back, or no key, keeps the saved one.
  const put = await call('PUT', '/api/admin/models', adminT, { jobs: { chat: { model: 'fake-chat-2', apiKey: '••••' } } });
  assert.ok(!put.text.includes('sk-secret-123'), 'PUT leaked the key');
  assert.equal(jobConfig(deps, 'chat')!.apiKey, 'sk-secret-123');
  assert.equal(jobConfig(deps, 'chat')!.model, 'fake-chat-2');
  await ok('PUT', '/api/admin/models', adminT, { jobs: { chat: { baseUrl: fake.baseUrl } } });
  assert.equal(jobConfig(deps, 'chat')!.apiKey, 'sk-secret-123');

  // The test endpoint must not echo it either.
  const t = await call('POST', '/api/admin/models/chat/test', adminT);
  assert.ok(!t.text.includes('sk-secret-123'));

  // The audit log has the change but not the key.
  const log = await call('GET', '/api/admin/audit', adminT);
  assert.ok(!log.text.includes('sk-secret-123'));
  assert.ok(log.text.includes('models.update'));

  // An empty string clears it.
  await ok('PUT', '/api/admin/models', adminT, { jobs: { chat: { apiKey: '' } } });
  assert.equal(jobConfig(deps, 'chat')!.apiKey, undefined);
  assert.equal(job(await ok('GET', '/api/admin/models', adminT), 'chat').apiKey, '');
});

test('Models_TestEndpointRunsEachJob', async () => {
  const expectSample: Record<string, RegExp> = { chat: /You said/, audit: /You said/, audio: /inaudible|silence/, voice: /bytes of audio\/wav/, extra: /64-dimension/ };
  for (const j of ['chat', 'audit', 'audio', 'voice', 'extra']) {
    const t = await ok('POST', `/api/admin/models/${j}/test`, adminT);
    assert.equal(t.ok, true, `${j}: ${JSON.stringify(t)}`);
    assert.equal(t.job, j);
    assert.equal(typeof t.ms, 'number');
    assert.match(t.sample, expectSample[j]);
  }
});

test('Models_TestReportsFailure', async () => {
  await ok('PUT', '/api/admin/models', adminT, { jobs: { extra: { baseUrl: 'http://127.0.0.1:1/v1' } } });
  const t = await ok('POST', '/api/admin/models/extra/test', adminT);
  assert.equal(t.ok, false);
  assert.match(t.error, /did not answer/);
  await ok('PUT', '/api/admin/models', adminT, { jobs: { extra: { baseUrl: fake.baseUrl } } });
});

test('Models_DisabledJobFallsBackToEnv', async () => {
  await ok('PUT', '/api/admin/models', adminT, { jobs: { voice: { enabled: false } } });
  assert.equal(hasJob(deps, 'voice'), false);
  assert.equal(job(await ok('GET', '/api/admin/models', adminT), 'voice').source, 'none');
  const withEnv = { ...deps, env: { ALX_MODEL_VOICE_URL: fake.baseUrl, ALX_MODEL_VOICE_MODEL: 'env-voice' } };
  assert.equal(jobConfig(withEnv, 'voice')!.model, 'env-voice');
  // Saved settings beat env when on.
  await ok('PUT', '/api/admin/models', adminT, { jobs: { voice: { enabled: true } } });
  assert.equal(jobConfig(withEnv, 'voice')!.model, 'fake-kokoro');
});

test('Models_V1PassthroughUsesChatJob', async () => {
  const m = await call('GET', '/v1/models', adminT);
  assert.equal(m.status, 200);
  assert.ok(m.body.data.some((x: any) => x.id === 'fake-chat'));
});

// ---- the fake server itself --------------------------------------------------

const post = (p: string, body: unknown) => fetch(fake.baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('FakeModels_ListsModels', async () => {
  const j: any = await (await fetch(fake.baseUrl + '/models')).json();
  assert.equal(j.object, 'list');
  assert.ok(j.data.length >= 5);
});

test('FakeModels_ChatEchoesAndUsesContext', async () => {
  const j: any = await (await post('/chat/completions', { messages: [{ role: 'system', content: 'Be brief.\nContext: The keep sits on a hill. It is old.' }, { role: 'user', content: 'Tell me about the keep' }] })).json();
  const c = j.choices[0].message.content;
  assert.match(c, /Tell me about the keep/);
  assert.match(c, /The keep sits on a hill\./);
  assert.doesNotMatch(c, /It is old/);
  const again: any = await (await post('/chat/completions', { messages: [{ role: 'system', content: 'Be brief.\nContext: The keep sits on a hill. It is old.' }, { role: 'user', content: 'Tell me about the keep' }] })).json();
  assert.equal(again.choices[0].message.content, c); // deterministic
});

test('FakeModels_ChatToolCall', async () => {
  const tools = [{ type: 'function', function: { name: 'list_pages', description: 'x', parameters: { type: 'object' } } }, { type: 'function', function: { name: 'get_page', description: 'x', parameters: { type: 'object' } } }];
  const j: any = await (await post('/chat/completions', { messages: [{ role: 'user', content: 'please run list_pages now' }], tools })).json();
  assert.equal(j.choices[0].finish_reason, 'tool_calls');
  assert.equal(j.choices[0].message.tool_calls[0].function.name, 'list_pages');
  // No tool named: plain text. After a tool result: plain text.
  const plain: any = await (await post('/chat/completions', { messages: [{ role: 'user', content: 'hello' }], tools })).json();
  assert.equal(plain.choices[0].message.tool_calls, undefined);
  const after: any = await (await post('/chat/completions', { messages: [{ role: 'user', content: 'run list_pages' }, { role: 'tool', content: '[]', tool_call_id: 'x' }], tools })).json();
  assert.equal(after.choices[0].message.tool_calls, undefined);
});

test('FakeModels_ChatJson', async () => {
  const a: any = await (await post('/chat/completions', { response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Route it.\nFAKE_JSON: {"scope":"rules","confidence":0.9}\nThanks' }, { role: 'user', content: 'q' }] })).json();
  assert.deepEqual(JSON.parse(a.choices[0].message.content), { scope: 'rules', confidence: 0.9 });
  const b: any = await (await post('/chat/completions', { response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'q' }] })).json();
  assert.deepEqual(JSON.parse(b.choices[0].message.content), {});
});

function upload(bytes: Uint8Array) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'audio/wav' }), 'a.wav');
  fd.append('model', 'fake-whisper');
  fd.append('response_format', 'verbose_json');
  return fetch(fake.baseUrl + '/audio/transcriptions', { method: 'POST', body: fd });
}

test('FakeModels_TranscribesSidecarText', async () => {
  const j: any = await (await upload(new TextEncoder().encode('FAKE: The orc|p=0.4 attacks. Roll initiative'))).json();
  assert.equal(j.text, 'The orc attacks. Roll initiative');
  assert.equal(j.segments.length, 2);
  const words = j.segments.flatMap((s: any) => s.words);
  assert.deepEqual(words.map((w: any) => w.word), ['The', 'orc', 'attacks.', 'Roll', 'initiative']);
  assert.equal(words[1].probability, 0.4);
  assert.equal(words[0].probability, 0.95);
  // Evenly spaced.
  for (let i = 1; i < words.length; i++) assert.ok(Math.abs((words[i].start - words[i - 1].start) - 0.4) < 0.011);
  // The ai.ts client reads it the same way.
  const t = await transcribe(deps, new TextEncoder().encode('FAKE: The orc|p=0.4 attacks.'), 'audio/wav');
  assert.equal(t.segments[0].words![1].probability, 0.4);
});

test('FakeModels_InaudibleWithoutSidecar', async () => {
  const j: any = await (await upload(new Uint8Array([1, 2, 3, 4, 5, 6]))).json();
  assert.equal(j.text, '(inaudible)');
});

test('FakeModels_SpeechIsWav', async () => {
  const r = await post('/audio/speech', { model: 'x', input: 'hi', voice: 'v' });
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  const b = Buffer.from(await r.arrayBuffer());
  assert.equal(b.subarray(0, 4).toString(), 'RIFF');
  assert.equal(b.subarray(8, 12).toString(), 'WAVE');
  const rate = b.readUInt32LE(24);
  const samples = b.readUInt32LE(40) / 2;
  assert.ok(Math.abs(samples / rate - 0.3) < 0.01);
  assert.ok(b.some((x, i) => i > 44 && x !== 0)); // not silence
});

test('FakeModels_EmbeddingsAreStable64', async () => {
  const j: any = await (await post('/embeddings', { model: 'x', input: ['alpha', 'beta'] })).json();
  assert.equal(j.data.length, 2);
  assert.equal(j.data[0].embedding.length, 64);
  assert.notDeepEqual(j.data[0].embedding, j.data[1].embedding);
  const k: any = await (await post('/embeddings', { model: 'x', input: 'alpha' })).json();
  assert.deepEqual(k.data[0].embedding, j.data[0].embedding);
});
