// The DM's model switcher (features/models/dmswitch.ts) and failover health (core/ai.ts): the DM picks a model and a
// backup per role, the admin's access level is enforced, the Historian asks before a re-index, a dead main model moves
// to its backup with a notice to the DM, is skipped while it rests, and the notice clears when it is back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { chat, clearJobHealth, jobHealth, setRestMs } from '../src/core/ai.ts';
import { startFakeModels, type FakeModels } from '../scripts/fake-models.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
let fake: FakeModels;
const T: Record<string, string> = {};
let W = '';
let live: AbortController | null = null;
const heard: any[] = [];

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const S = () => `/api/worlds/${W}/models`;
const role = (v: any, job: string) => v.roles.find((r: any) => r.job === job);

before(async () => {
  fake = await startFakeModels(0, '127.0.0.1');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-dmswitch-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Switchland', dmAccountId: dm.account.id })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  T.player = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jessamine' })).token;
  deps.hub.tap((_w: string, type: string, data: unknown) => { if (type === 'models-health') heard.push(data); });
});

after(async () => {
  live?.abort();
  server?.close();
  server?.closeAllConnections?.();
  await fake.close();
  setRestMs(60_000);
  clearJobHealth(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The DM has the world open (an event stream), so health notices have somewhere to go. */
async function openLive() {
  live = new AbortController();
  const r = await fetch(`${base}/api/worlds/${W}/events`, { headers: { Authorization: `Bearer ${T.dm}` }, signal: live.signal });
  assert.equal(r.status, 200);
  void r.body?.getReader().read().catch(() => {});
}

test('ModelsDmSwitch_DmPicksAModelAndBackupFromSavedProviders', async () => {
  const p = (await ok('POST', '/api/admin/models/providers', T.admin, { name: 'Box', kind: 'openai-compatible', baseUrl: fake.baseUrl, location: 'local' })).provider;
  assert.equal((await call('GET', `${S()}/switch`, T.player)).status, 403, 'players never see it');
  let v = await ok('GET', `${S()}/switch`, T.dm);
  assert.equal(v.access, 'setup', 'the default lets the DM set up models');
  assert.ok(v.providers.some((x: any) => x.id === p.id));
  assert.ok(!JSON.stringify(v).includes('apiKey'), 'no key field reaches the DM');
  assert.equal(role(v, 'dm').follows, 'chat');
  const found = await ok('POST', `${S()}/switch/discover`, T.dm, { providerId: p.id });
  assert.ok(found.ok && found.models.some((m: any) => m.id === 'fake-chat'));
  v = await ok('PUT', `${S()}/switch`, T.dm, { job: 'dm', providerId: p.id, model: 'fake-chat', fallback: { providerId: p.id, model: 'fake-audit' } });
  assert.equal(role(v, 'dm').model, 'fake-chat');
  assert.equal(role(v, 'dm').follows, null);
  assert.equal(role(v, 'dm').fallback.model, 'fake-audit');
  const t = await ok('POST', `${S()}/switch/test`, T.dm, { job: 'dm', which: 'fallback' });
  assert.equal(t.ok, true, JSON.stringify(t));
  // The admin page shows what the DM set, and the audit says which world did it.
  const adm = await ok('GET', '/api/admin/models', T.admin);
  assert.equal(adm.jobs.find((j: any) => j.job === 'dm').model, 'fake-chat');
  const row = deps.db.prepare("SELECT world_id, detail FROM audit WHERE action = 'models.dm_switch' ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.world_id, W);
  assert.match(row.detail, /dm: fake-chat, backup fake-audit/);
  // Back to following the Chat model.
  v = await ok('PUT', `${S()}/switch`, T.dm, { job: 'dm', follow: true });
  assert.equal(role(v, 'dm').follows, 'chat');
  assert.equal((await call('PUT', `${S()}/switch`, T.dm, { job: 'chat', follow: true })).status, 400, 'Chat has nothing to follow');
});

test('ModelsDmSwitch_AdminAccessLevelIsEnforced', async () => {
  const p = (await ok('POST', `${S()}/switch/providers`, T.dm, { name: 'DM box', kind: 'openai-compatible', baseUrl: fake.baseUrl, location: 'local' })).provider;
  assert.equal(p.name, 'DM box');
  await ok('PUT', '/api/admin/models/dm-access', T.admin, { level: 'switch' });
  assert.equal((await call('POST', `${S()}/switch/providers`, T.dm, { name: 'x', baseUrl: fake.baseUrl })).status, 403, 'switch: no new providers');
  const cloud = (await ok('POST', '/api/admin/models/providers', T.admin, { name: 'Cloud', kind: 'openai-compatible', baseUrl: fake.baseUrl, location: 'cloud' })).provider;
  assert.equal((await call('PUT', `${S()}/switch`, T.dm, { job: 'chat', providerId: p.id, model: 'fake-chat', fallback: { providerId: cloud.id, model: 'fake-chat', allowCloud: true } })).status, 403, 'switch: no local to cloud fallback');
  await ok('PUT', `${S()}/switch`, T.dm, { job: 'chat', providerId: p.id, model: 'fake-chat', fallback: { providerId: cloud.id, model: 'fake-chat' } });
  assert.equal(role(await ok('GET', `${S()}/switch`, T.dm), 'chat').fallbackBlocked, true, 'the cloud backup stays unused');
  await ok('PUT', '/api/admin/models/dm-access', T.admin, { level: 'off' });
  assert.equal((await ok('GET', `${S()}/switch`, T.dm)).access, 'off');
  assert.equal((await call('PUT', `${S()}/switch`, T.dm, { job: 'chat', providerId: p.id, model: 'fake-audit' })).status, 403);
  assert.equal((await call('PUT', '/api/admin/models/dm-access', T.admin, { level: 'all' })).status, 400);
  assert.equal((await call('PUT', '/api/admin/models/dm-access', T.dm, { level: 'setup' })).status, 403, 'a DM cannot raise it');
  await ok('PUT', '/api/admin/models/dm-access', T.admin, { level: 'setup' });
  await ok('PUT', `${S()}/switch`, T.dm, { job: 'chat', providerId: p.id, model: 'fake-chat', fallback: null });
});

test('ModelsDmSwitch_HistorianAsksBeforeANewEmbedder', async () => {
  const p = (await ok('GET', `${S()}/switch`, T.dm)).providers[0];
  await ok('PUT', `${S()}/switch`, T.dm, { job: 'extra', providerId: p.id, model: 'fake-embed' });
  const r = await call('PUT', `${S()}/switch`, T.dm, { job: 'extra', providerId: p.id, model: 'other-embed' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'reindex');
  assert.match(r.body.error, /re-embedded/);
  assert.equal(role(await ok('GET', `${S()}/switch`, T.dm), 'extra').model, 'fake-embed', 'nothing changed');
  const fb = await call('PUT', `${S()}/switch`, T.dm, { job: 'extra', providerId: p.id, model: 'fake-embed', fallback: { providerId: p.id, model: 'other-embed' } });
  assert.equal(fb.status, 409, 'a backup that is another embedder is asked about too');
  await ok('PUT', `${S()}/switch`, T.dm, { job: 'extra', providerId: p.id, model: 'fake-embed', fallback: { providerId: p.id, model: 'fake-embed' } });
  const yes = await ok('PUT', `${S()}/switch`, T.dm, { job: 'extra', providerId: p.id, model: 'other-embed', fallback: null, confirmReindex: true });
  assert.equal(yes.reembed, true);
  assert.equal(role(yes, 'extra').model, 'other-embed');
});

test('ModelsDmSwitch_DeadMainMovesToBackupAndTellsTheDM', async () => {
  await openLive();
  const dead = (await ok('POST', '/api/admin/models/providers', T.admin, { name: 'Dead box', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', location: 'local' })).provider;
  const good = (await ok('GET', `${S()}/switch`, T.dm)).providers.find((x: any) => x.name === 'Box');
  await ok('PUT', `${S()}/switch`, T.dm, { job: 'dm', providerId: dead.id, model: 'fake-chat', fallback: { providerId: good.id, model: 'fake-chat' } });
  heard.length = 0;
  const seen0 = fake.requests.length;
  const r1 = await chat(deps, 'dm', { messages: [{ role: 'user', content: 'hello' }], maxTokens: 8, noFloor: true });
  assert.ok(r1.content.length > 0);
  assert.equal(fake.requests.length - seen0, 1, 'the backup answered');
  const h = jobHealth().find((x) => x.job === 'dm');
  assert.equal(h?.state, 'fallback');
  assert.equal(h?.using, 'fake-chat');
  assert.equal(heard.length, 1, 'one notice, not one per call');
  assert.equal(heard[0].state, 'fallback');
  assert.equal((await ok('GET', `${S()}/health`, T.dm)).jobs[0].job, 'dm');
  assert.equal((await call('GET', `${S()}/health`, T.player)).status, 403);
  // While the dead one rests, calls go to the backup first and say nothing new.
  await chat(deps, 'dm', { messages: [{ role: 'user', content: 'again' }], maxTokens: 8, noFloor: true });
  assert.equal(heard.length, 1);
  // The DM switches the main model: the notice clears.
  await ok('PUT', `${S()}/switch`, T.dm, { job: 'dm', providerId: good.id, model: 'fake-chat', fallback: null });
  assert.equal(jobHealth().length, 0);
  assert.equal(heard.at(-1).state, 'ok');
});

test('ModelsDmSwitch_NoBackupSaysDownThenBackWhenItAnswers', async () => {
  const v = await ok('GET', `${S()}/switch`, T.dm);
  const good = v.providers.find((x: any) => x.name === 'Box');
  const dead = v.providers.find((x: any) => x.name === 'Dead box');
  await ok('PUT', `${S()}/switch`, T.dm, { job: 'player', providerId: dead.id, model: 'fake-chat', fallback: null });
  heard.length = 0;
  await assert.rejects(chat(deps, 'player', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8, noFloor: true }));
  assert.equal(jobHealth().find((x) => x.job === 'player')?.state, 'down');
  assert.equal(heard[0].state, 'down');
  // The main model comes back (here: the provider is pointed at a live server): the first answer clears it.
  setRestMs(0);
  await ok('PUT', `/api/admin/models/providers/${dead.id}`, T.admin, { baseUrl: fake.baseUrl });
  await chat(deps, 'player', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8, noFloor: true });
  assert.equal(jobHealth().length, 0);
  assert.equal(heard.at(-1).state, 'ok');
  await ok('PUT', `${S()}/switch`, T.dm, { job: 'player', providerId: good.id, model: 'fake-chat' });
  setRestMs(60_000);
});
