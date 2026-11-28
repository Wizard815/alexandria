// The /v1 model gateway: who may spend the GM's provider credit, and how much.
// And: no route that reaches a model works without a sign-in.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, type Kit } from './audit-kit.ts';
import { createKey } from '../src/core/auth.ts';
import { createApp } from '../src/app.ts';
import type { AddressInfo } from 'node:net';

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

let upstream: { url: string; body: any }[] = [];
const fake = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.startsWith('http://models.test/v1')) {
    const body = (() => { try { return JSON.parse(String(init?.body ?? '{}')); } catch { return {}; } })();
    upstream.push({ url: u, body });
    if (u.endsWith('/embeddings')) return new Response(JSON.stringify({ data: (body.input ?? []).map(() => ({ embedding: [0.1, 0.2, 0.3] })), usage: { prompt_tokens: 7 } }), { headers: { 'Content-Type': 'application/json' } });
    if (u.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'chat-mock' }] }), { headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 11, completion_tokens: 5 } }), { headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

const MODELS_ENV = { ALX_MODEL_CHAT_URL: 'http://models.test/v1', ALX_MODEL_CHAT_MODEL: 'chat-mock', ALX_MODEL_EXTRA_URL: 'http://models.test/v1', ALX_MODEL_EXTRA_MODEL: 'embed-mock' };
async function kit(env: Record<string, string> = {}): Promise<Kit> {
  const k = await boot({ fetch: fake, env: { ...MODELS_ENV, ...env } });
  cleanups.push(k.close);
  upstream = [];
  return k;
}
const chat = { model: 'x', messages: [{ role: 'user', content: 'hello' }] };

test('ModelGateway_NothingReachesAModelWithoutASignIn', async () => {
  const k = await kit();
  const routes: [string, string, unknown?][] = [
    ['GET', '/v1/models'], ['POST', '/v1/chat/completions', chat], ['POST', '/v1/embeddings', { input: ['a'] }],
    ['POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
    ['GET', k.w('/search?q=dragon')], ['POST', k.w('/search/reindex')], ['POST', k.w('/agent/chats')], ['POST', k.w('/agent/chats/x/messages'), { text: 'hi' }],
    ['POST', k.w('/agent/speak'), { text: 'hi' }], ['POST', k.w('/voice/speak'), { text: 'hi' }], ['POST', k.w('/agent/dictate')], ['GET', k.w('/library/search?q=a')],
    ['GET', `/api/admin/models/activity`], ['GET', `/api/admin/models/access`], ['GET', '/api/admin/jobs'],
  ];
  for (const [m, p, b] of routes) {
    const r = await k.call(m, p, null, b);
    assert.equal(r.status, 401, `${m} ${p} without a token answered ${r.status}`);
  }
  assert.equal(upstream.length, 0, 'no request left for a model');
});

test('ModelGateway_PlayersAndGuestsAreRefusedTheGmAndAdminAreNot', async () => {
  const k = await kit();
  for (const who of ['jess', 'visitor']) {
    for (const [m, p, b] of [['GET', '/v1/models'], ['POST', '/v1/chat/completions', chat], ['POST', '/v1/embeddings', { input: ['a'] }]] as [string, string, unknown?][]) {
      const r = await k.call(m, p, k.T[who], b);
      assert.equal(r.status, 403, `${who} ${m} ${p} -> ${r.status}`);
      assert.match(r.body.error, /GM and the admin/);
    }
  }
  assert.equal(upstream.length, 0, 'a refused caller never reaches the model');
  assert.equal((await k.call('POST', '/v1/chat/completions', k.T.gm, chat)).status, 200, 'the GM may');
  assert.equal((await k.call('POST', '/v1/embeddings', k.T.gm, { input: ['a'] })).status, 200);
  // The admin is not a member of the world, and may.
  assert.equal((await k.call('GET', '/v1/models', k.T.admin)).status, 200);
  // Another world's GM is a GM too: the gateway is the server's, not a world's.
  assert.equal((await k.call('GET', '/v1/models', k.T.gm2)).status, 200);
});

test('ModelGateway_AScribeKeyIsRefusedEvenOnTheGmsAccountUntilTheAdminListsIt', async () => {
  const k = await kit();
  const key = createKey(k.deps.db, k.ID.gm, 'scribe', 'leaky', k.W, 'write');
  const r = await k.call('POST', '/v1/chat/completions', key.key, chat);
  assert.equal(r.status, 403, 'a leaked scribe key cannot spend the credit');
  assert.equal(upstream.length, 0);
  await k.ok('PUT', '/api/admin/models/access', k.T.admin, { kind: 'key', id: key.id, note: 'the scribe app' });
  assert.equal((await k.call('POST', '/v1/chat/completions', key.key, chat)).status, 200);
  await k.ok('DELETE', `/api/admin/models/access/key/${key.id}`, k.T.admin);
  assert.equal((await k.call('POST', '/v1/chat/completions', key.key, chat)).status, 403);
  // A player cannot list themselves.
  assert.equal((await k.call('PUT', '/api/admin/models/access', k.T.jess, { kind: 'account', id: k.ID.jess })).status, 403);
});

test('ModelGateway_AListedPlayerHasADailyCapWithAClear429', async () => {
  const k = await kit();
  await k.ok('PUT', '/api/admin/models/access', k.T.admin, { kind: 'account', id: k.ID.jess, dailyRequests: 2, note: 'jess may ask twice a day' });
  assert.equal((await k.call('POST', '/v1/chat/completions', k.T.jess, chat)).status, 200);
  assert.equal((await k.call('POST', '/v1/chat/completions', k.T.jess, chat)).status, 200);
  const third = await k.call('POST', '/v1/chat/completions', k.T.jess, chat);
  assert.equal(third.status, 429);
  assert.match(third.body.error, /Daily limit reached: 2 of 2 model requests/);
  assert.ok(Number(third.headers.get('retry-after')) > 0);
  assert.equal(upstream.length, 2, 'the refused request never reached the model');
  // Someone else is not affected.
  assert.equal((await k.call('POST', '/v1/chat/completions', k.T.gm, chat)).status, 200);
});

test('ModelGateway_ATokenCapStopsAnAccountThatSpentItsTokens', async () => {
  const k = await kit();
  await k.ok('PUT', '/api/admin/models/access', k.T.admin, { kind: 'account', id: k.ID.tom, dailyTokens: 20 });
  assert.equal((await k.call('POST', '/v1/chat/completions', k.T.tom, chat)).status, 200, 'first: 16 tokens used');
  assert.equal((await k.call('POST', '/v1/chat/completions', k.T.tom, chat)).status, 200, 'second: 32 tokens used, now over');
  const r = await k.call('POST', '/v1/chat/completions', k.T.tom, chat);
  assert.equal(r.status, 429);
  assert.match(r.body.error, /tokens today/);
});

test('ModelGateway_APerMinuteRateLimitAnswers429', async () => {
  const k = await kit({ ALX_V1_RATE_PER_MIN_GM: '3' });
  for (let i = 0; i < 3; i++) assert.equal((await k.call('GET', '/v1/models', k.T.gm)).status, 200);
  const r = await k.call('GET', '/v1/models', k.T.gm);
  assert.equal(r.status, 429);
  assert.match(r.body.error, /3 a minute/);
});

test('ModelGateway_EveryCallIsLoggedForTheModelActivityView', async () => {
  const k = await kit();
  await k.ok('POST', '/v1/chat/completions', k.T.gm, chat);
  await k.ok('POST', '/v1/embeddings', k.T.gm, { input: ['a', 'b'] });
  const a = await k.ok('GET', '/api/admin/models/activity', k.T.admin);
  const chatJob = a.jobs.find((j: any) => j.job === 'chat');
  assert.ok(chatJob && chatJob.lastHour >= 1, 'the chat call is counted');
  assert.ok(a.jobs.find((j: any) => j.job === 'extra'));
  const row = a.recent.find((r: any) => r.job === 'chat' && r.via === 'gateway');
  assert.equal(row.accountId, k.ID.gm);
  assert.equal(row.tokensIn, 11);
  assert.equal(row.tokensOut, 5);
  assert.ok(a.callers.some((c: any) => c.via === 'gateway' && c.job === 'chat'));
  // Only the admin reads it.
  assert.equal((await k.call('GET', '/api/admin/models/activity', k.T.gm)).status, 403);
});

test('ModelGateway_TheRateLimiterAndCorsCoverTheGateway', async () => {
  const hit = async (limit: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const made = createApp({ noScheduler: true, fetch: fake, env: { ...MODELS_ENV, ALX_RATE_LIMIT: limit } });
    const server = made.app.listen(0);
    await new Promise((r) => server.once('listening', r));
    cleanups.push(() => { server.close(); server.closeAllConnections?.(); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const out: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < 6; i++) {
      last = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      out.push(last.status);
      await last.text();
    }
    return { codes: out, last: last! };
  };
  assert.ok((await hit('4', 'GET', '/v1/models')).codes.includes(429), 'the per-IP limiter reaches /v1');
  assert.ok((await hit('3', 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })).codes.includes(429), 'and /mcp');
  // CORS is closed unless an origin is listed.
  const { last } = await hit('0', 'GET', '/v1/models', undefined, { Origin: 'https://evil.example' });
  assert.equal(last.headers.get('access-control-allow-origin'), null);
});

test('ModelGateway_TheCallLogShowsWhoWhenModelTokensAndRefusedOrLimitedButNoPrompt', async () => {
  const k = await kit();
  await k.ok('PUT', '/api/admin/models/access', k.T.admin, { kind: 'account', id: k.ID.jess, dailyRequests: 1 });
  await k.ok('POST', '/v1/chat/completions', k.T.gm, { ...chat, messages: [{ role: 'user', content: 'SECRET-PROMPT-TEXT' }] });
  assert.equal((await k.call('POST', '/v1/chat/completions', k.T.jess, chat)).status, 200);
  assert.equal((await k.call('POST', '/v1/chat/completions', k.T.jess, chat)).status, 429, 'over the cap');
  assert.equal((await k.call('POST', '/v1/chat/completions', k.T.tom, chat)).status, 403, 'not listed');
  const g = await k.ok('GET', '/api/admin/models/activity/gateway', k.T.admin);
  assert.ok(!JSON.stringify(g).includes('SECRET-PROMPT-TEXT'), 'the prompt is never in the log');
  const gmCall = g.calls.find((c: any) => c.accountId === k.ID.gm);
  assert.equal(gmCall.outcome, 'passed');
  assert.equal(gmCall.tokensIn, 11);
  assert.equal(gmCall.model, 'chat-mock');
  assert.ok(gmCall.username && gmCall.at && gmCall.status === 200);
  assert.ok(g.calls.some((c: any) => c.accountId === k.ID.jess && c.outcome === 'limited' && c.status === 429));
  assert.ok(g.calls.some((c: any) => c.accountId === k.ID.tom && c.outcome === 'refused' && c.status === 403));
  const jess = g.users.find((u: any) => u.accountId === k.ID.jess);
  assert.equal(jess.requests, 1, 'a limited call does not count against the cap');
  assert.equal(jess.limited, 1);
  assert.equal(jess.caps.dailyRequests, 1);
  assert.equal(jess.role, 'listed');
  const gm = g.users.find((u: any) => u.accountId === k.ID.gm);
  assert.equal(gm.tokens, 16);
  assert.equal(gm.role, 'gm');
  assert.equal(g.users.find((u: any) => u.accountId === k.ID.tom).refused, 1);
  // Only the admin reads it; without a sign-in it is 401.
  assert.equal((await k.call('GET', '/api/admin/models/activity/gateway', k.T.gm)).status, 403);
  assert.equal((await k.call('GET', '/api/admin/models/activity/gateway', k.T.jess)).status, 403);
  assert.equal((await k.call('GET', '/api/admin/models/activity/gateway', null)).status, 401);
});
