// The gateway admin's read-only summaries: real numbers, admins only, and never a secret,
// hidden context, answer or the text a guard stopped.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { run } from '../src/core/db.ts';
import { insertKey } from '../src/features/sourcekeys/store.ts';

const SECRET = 'SECRETKEYVALUE-GW1';
const HIDDEN = 'HIDDENCTX-GW2';
const ANSWER = 'DMANSWER-GW3';
const STOPPED = 'STOPPEDTEXT-GW4';
const PW = 'correct horse battery';

const { app, deps } = createApp({ noScheduler: true, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
after(() => { server.close(); server.closeAllConnections?.(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const call = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: json, text };
};

const admin = (await call('POST', '/api/setup', undefined, { username: 'wizard', password: PW })).body;
const adminToken = admin.token as string;
const player = (await call('POST', '/api/admin/accounts', adminToken, { username: 'jess', password: 'jess password 123' })).body.account;
const world = (await call('POST', '/api/admin/worlds', adminToken, { name: 'Gatewayland', dmAccountId: admin.account.id })).body.id as string;
await call('PUT', `/api/admin/worlds/${world}/members/${player.id}`, adminToken, { role: 'player' });
const playerToken = (await call('POST', '/api/auth/login', undefined, { username: 'jess', password: 'jess password 123' })).body.token as string;

run(deps.db, `INSERT INTO sources (id, world_id, kind, name) VALUES ('src_gw', ?, 'kanka', 'Campaign notes')`, world);
const key = insertKey(deps.db, { worldId: world, sourceId: 'src_gw', ownerId: player.id, label: 'Jess key', secret: SECRET, trust: 'per-user', claimed: 'per-user', users: [player.id], uses: ['library'], verified: true, probe: { verdict: 'per-user', note: HIDDEN } });
run(deps.db, `INSERT INTO sourcekeys_escalations (id, world_id, account_id, question, origin, mode, status, hidden, answer, created_at) VALUES ('esc_gw', ?, ?, 'Who funds the guild?', 'direct', 'dm-question', 'open', ?, ?, ?)`,
  world, player.id, JSON.stringify({ reason: HIDDEN, items: [{ title: 't', source: 's', text: HIDDEN }] }), ANSWER, new Date().toISOString());
run(deps.db, `INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, NULL, 'agent.leak_blocked', ?, ?)`, world, `chat 1: reply shared DM-only text ("${STOPPED}")`, new Date().toISOString());
run(deps.db, `INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, NULL, 'ai.classified_refused', ?, ?)`, world, `chat request refused: repeats classified text of page p1 ${STOPPED}`, new Date().toISOString());

test('TestGateway_AdminSeesKeysAndQuestionsWithoutSecrets', async () => {
  const r = await call('GET', '/api/admin/gateway/source-keys', adminToken);
  assert.equal(r.status, 200);
  const w = r.body.worlds.find((x: any) => x.id === world);
  assert.equal(w.keys.length, 1);
  assert.equal(w.keys[0].id, key.id);
  assert.equal(w.keys[0].userNames[0], 'jess');
  assert.equal(w.escalations[0].question, 'Who funds the guild?');
  assert.equal(w.escalations[0].status, 'open');
  for (const s of [SECRET, HIDDEN, ANSWER]) assert.ok(!r.text.includes(s), `leaked ${s}`);
});

test('TestGateway_GuardAndOverviewCountRealEventsButNotTheirText', async () => {
  const g = await call('GET', '/api/admin/gateway/guard', adminToken);
  assert.equal(g.status, 200);
  assert.equal(g.body.events.length, 2);
  assert.equal(g.body.perUserKeys, 1);
  assert.equal(g.body.blanketKeys, 0);
  const o = await call('GET', '/api/admin/gateway/overview', adminToken);
  assert.equal(o.body.waiting.questions, 1);
  assert.equal(o.body.guard.blocked7d, 2);
  const d = await call('GET', '/api/admin/gateway/devices', adminToken);
  assert.equal(d.status, 200);
  for (const x of [g, o, d]) assert.ok(!x.text.includes(STOPPED), 'guard text leaked');
});

test('TestGateway_PlayerAndAnonymousAreRefused', async () => {
  for (const p of ['/overview', '/source-keys', '/guard', '/devices']) {
    assert.ok([401, 403].includes((await call('GET', `/api/admin/gateway${p}`, playerToken)).status), `player ${p}`);
    assert.ok([401, 403].includes((await call('GET', `/api/admin/gateway${p}`)).status), `anon ${p}`);
  }
});
