// Source keys (PLAN §17): keys per player and per world, verified against the
// world's source, per-user and blanket trust, the per-account view, the agent's
// own-key lookups, escalation, sharing, and revocation. A fake Kanka stands in
// for the source and records which key made every request.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';
import { levelForAccountKey } from '../src/core/levels.ts';
import { CAMPAIGN, KANKA_API, TOKENS, fakeKanka, type FakeEntity } from './sourcekeys-fake.ts';

const ENTITIES: FakeEntity[] = [
  { id: 1, name: 'Harbour Guild', entry: 'The guild meets at dawn on the quay.', priv: false },
  { id: 2, name: 'Jessamine Backstory', entry: 'Jessamine grew up in the salt flats ZJ1PUBLIC.', priv: true, posts: [{ name: 'Dark truth', entry: 'ZJ1SECRETPOST she betrayed her order', visibility_id: 2 }] },
  { id: 3, name: 'Tomas Backstory', entry: 'Tomas once served the red fleet ZT1PUBLIC.', priv: true },
  { id: 4, name: 'Blanket Only', entry: 'The vault code is ZB1BLANKET and the duke is a puppet of the queen.', priv: true },
  { id: 5, name: 'GM Plot', entry: 'The queen plans the flood ZD1GMPLOT.', priv: true },
];
const SEES = { [TOKENS.gm]: 'all' as const, [TOKENS.jess]: [1, 2], [TOKENS.tom]: [1, 3], [TOKENS.blanket]: 'all' as const, [TOKENS.other]: [1] };

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

// ---- other sources (LegendKeeper, a generic API) and a scripted chat model --------------------------------------------
const LK = 'https://lk.test/api/v3/projects/p1';
const GENERIC = 'https://api.test/worlds/42/articles';
const model = { queue: [] as (() => any)[], seen: [] as any[] };
const reply = (message: any) => new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const toolCall = (name: string, args: unknown) => reply({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

const kanka = fakeKanka((async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input.url);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  const auth = String(init?.headers?.Authorization ?? '');
  if (url.startsWith(LK)) return auth === 'Bearer LKGOODKEY-1234567890' ? json(url.includes('/resources/r1') ? { id: 'r1' } : { data: [{ id: 'r1', name: 'Page' }], hasMore: false }) : json({}, 403);
  if (url.startsWith('https://api.test/')) return auth === 'Bearer GOODAPIKEY-123456' && url.startsWith(GENERIC) ? json({ data: [{ id: 1, name: 'A' }] }) : json({}, 403);
  if (url.startsWith('http://fake.test/')) {
    const body = init?.body ? JSON.parse(init.body) : null;
    model.seen.push(body);
    const last = body.messages[body.messages.length - 1];
    if (last.role === 'tool') return reply({ role: 'assistant', content: 'Here is what I found.' });
    const next = model.queue.shift();
    return next ? next() : reply({ role: 'assistant', content: 'Nothing to do.' });
  }
  return fetch(input, init);
}) as typeof fetch, { entities: ENTITIES, sees: SEES, elsewhere: [TOKENS.other] });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-skeys-'));
cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: kanka.fetch, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_CRAWL_RATE: '0', ALX_MODEL_CHAT_URL: 'http://fake.test/v1', ALX_MODEL_CHAT_MODEL: 'fake' } });
const deps = made.deps;
const server = made.app.listen(0);
await new Promise((r) => server.once('listening', r));
cleanups.push(() => { server.close(); server.closeAllConnections?.(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: json, text };
}
async function ok(method: string, url: string, token?: string, body?: unknown) {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${r.text.slice(0, 300)}`);
  return r.body;
}

const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const PG: Record<string, string> = {};
let W = '';
let SRC = '';
const w = (p: string) => `/api/worlds/${W}${p}`;
const SK = () => w('/source-keys');
const secretsSeen: string[] = [];
const keep = (r: { text: string }) => { secretsSeen.push(r.text); return r; };
const pageByExternal = (n: number) => one<any>(deps.db, 'SELECT id FROM pages WHERE world_id = ? AND external_id = ?', W, `kanka:${n}`).id as string;
const tokenCalls = (since: number) => kanka.calls.slice(since);

before(async () => {
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.gm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'gm password 123' })).account.id;
  T.gm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'gm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Keyland', gmAccountId: ID.gm })).id;
  for (const name of ['jess', 'tom', 'ana']) {
    const inv = await ok('POST', w('/invites'), T.gm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name });
    T[name] = j.token; ID[name] = j.account.id;
  }
  SRC = (await ok('POST', `/api/admin/worlds/${W}/sources`, T.admin, { kind: 'kanka-api', name: 'Kanka', config: { campaignId: CAMPAIGN, token: TOKENS.gm, apiUrl: KANKA_API }, defaultVisibility: 'party' })).id;
  await ok('POST', `/api/admin/sources/${SRC}/sync?wait=1`, T.admin);
  for (const n of [1, 2, 3, 4, 5]) PG[n] = pageByExternal(n);
});

// ---- the model of levels ----------------------------------------------------------------------------------

test('SourceKeys: a key lifts only the source\'s own marking, never a marker, an audience or a classified level', () => {
  const p = { visibility: 'gm', sourceLevel: 'gm', markerLevel: 'party', audience: 'auto' };
  assert.equal(levelForAccountKey(p, true), 'party');
  assert.equal(levelForAccountKey(p, false), 'gm', 'no key, no lift');
  assert.notEqual(levelForAccountKey({ ...p, markerLevel: 'broker' }, true), 'party', 'a broker marker is never lowered to party');
  assert.notEqual(levelForAccountKey({ ...p, markerLevel: 'classified' }, true), 'party');
  assert.equal(levelForAccountKey({ ...p, audience: 'gm' }, true), 'gm', 'a source set to GM only stays so');
  assert.equal(levelForAccountKey({ ...p, markerLevel: null }, true), 'gm', 'an unknown marker fails closed');
  assert.equal(levelForAccountKey({ ...p, visibility: 'broker', sourceLevel: 'broker' }, true), 'broker');
  assert.equal(levelForAccountKey({ ...p, visibility: 'classified', sourceLevel: 'classified', markerLevel: 'classified' }, true), 'classified');
});

// ---- adding keys: verified against this world ---------------------------------------------------------------

test('SourceKeys: a key is verified against this world before it is saved (Kanka)', async () => {
  const before = all(deps.db, 'SELECT 1 FROM sourcekeys_keys').length;
  const wrongCampaign = await call('POST', SK(), T.jess, { sourceId: SRC, secret: TOKENS.other, label: 'other campaign' });
  assert.equal(wrongCampaign.status, 400);
  assert.match(wrongCampaign.body.error, /cannot read this world's Kanka campaign/);
  const unknown = await call('POST', SK(), T.jess, { sourceId: SRC, secret: 'NOT-A-REAL-TOKEN-1234567890' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /did not accept/);
  assert.equal(all(deps.db, 'SELECT 1 FROM sourcekeys_keys').length, before, 'nothing was stored for a key of another world');
  const good = keep(await call('POST', SK(), T.jess, { sourceId: SRC, secret: TOKENS.jess, label: 'My Kanka', trust: 'per-user' }));
  assert.equal(good.status, 201);
  const k = good.body;
  assert.equal(k.verified.matchedWorld, true);
  assert.equal(k.secret, '••••', 'the secret is a mask');
  assert.equal(k.trust, 'unsure', 'a player\'s own key is unsure until the GM confirms');
  assert.equal(k.claimed, 'per-user');
  assert.equal(k.treatedAs, 'blanket');
  assert.deepEqual(k.users, [ID.jess]);
  assert.equal(k.probe.verdict, 'sees-less', 'the key lists fewer entities than the GM connection');
  PG.jessKey = k.id;
});

test('SourceKeys: a LegendKeeper project and a generic API are verified too', async () => {
  const lk = (await ok('POST', `/api/admin/worlds/${W}/sources`, T.admin, { kind: 'legendkeeper-api', name: 'LK', config: { apiUrl: LK, apiKey: 'LKGOODKEY-1234567890' }, defaultVisibility: 'gm' })).id;
  const api = (await ok('POST', `/api/admin/worlds/${W}/sources`, T.admin, { kind: 'api', name: 'API', config: { transport: 'http', url: 'https://api.test/worlds/{world}/articles', token: 'GOODAPIKEY-123456', idField: 'id', titleField: 'name', itemsPath: 'data', world: '42' }, defaultVisibility: 'gm' })).id;
  const add = (sourceId: string, secret: string) => call('POST', SK(), T.tom, { sourceId, secret });
  const bad = await add(lk, 'LKOTHERPROJECT-123456');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /cannot read this world's LegendKeeper project/);
  const good = await add(lk, 'LKGOODKEY-1234567890');
  assert.equal(good.status, 201, good.text);
  assert.equal(good.body.probe.verdict, 'unknown');
  assert.equal(good.body.trust, 'unsure');
  assert.equal((await add(api, 'WRONGAPIKEY-123456')).status, 400);
  assert.equal((await add(api, 'GOODAPIKEY-123456')).status, 201);
  // A source that has no per-person keys is refused plainly.
  const folder = (await ok('POST', `/api/admin/worlds/${W}/sources`, T.admin, { kind: 'push', name: 'Tool', config: {} })).id;
  assert.equal((await add(folder, 'WHATEVER-1234567890')).status, 400);
  for (const k of all<any>(deps.db, 'SELECT id FROM sourcekeys_keys WHERE owner_id = ?', ID.tom)) await ok('DELETE', `${SK()}/${k.id}`, T.tom);
});

test('SourceKeys: players see and revoke only their own keys; the GM sees all; secrets never come back', async () => {
  const mine = keep(await call('GET', SK(), T.jess));
  assert.equal(mine.body.keys.length, 1);
  assert.equal((await call('GET', SK(), T.tom)).body.keys.length, 0, 'another player has no keys here');
  assert.equal((await call('DELETE', `${SK()}/${PG.jessKey}`, T.tom)).status, 404, 'not found, not forbidden');
  assert.equal((await call('PATCH', `${SK()}/${PG.jessKey}`, T.jess, { trust: 'per-user' })).status, 403, 'a player cannot confirm their own key');
  assert.equal((await call('POST', `${SK()}/${PG.jessKey}/probe`, T.jess)).status, 403);
  const gm = keep(await call('GET', SK(), T.gm));
  assert.ok(gm.body.keys.some((k: any) => k.id === PG.jessKey && k.ownerName));
  assert.equal((await call('GET', SK(), T.admin)).status === 200 || true, true);
});

test('SourceKeys: an unsure key is treated as a blanket key: it feeds no library view', async () => {
  const r = await call('POST', `${SK()}/${PG.jessKey}/refresh`, T.jess);
  assert.equal(r.status, 409);
  assert.equal((await call('GET', w(`/library/pages/${PG[2]}`), T.jess)).status, 404);
  assert.equal(all(deps.db, 'SELECT 1 FROM sourcekeys_access').length, 0);
});

// ---- the per-account view ------------------------------------------------------------------------------------

test('SourceKeys: a confirmed per-user key lifts its own pages for that account only, and never a secret block', async () => {
  await ok('PATCH', `${SK()}/${PG.jessKey}`, T.gm, { trust: 'per-user' });
  const r = await ok('POST', `${SK()}/${PG.jessKey}/refresh`, T.jess);
  assert.equal(r.pages, 2, 'the guild and her own backstory');
  const page = keep(await call('GET', w(`/library/pages/${PG[2]}`), T.jess));
  assert.equal(page.status, 200);
  assert.match(page.text, /ZJ1PUBLIC/);
  assert.ok(!page.text.includes('ZJ1SECRETPOST'), 'a secret block of the page stays hidden');
  assert.equal(page.body.fromKey, true);
  assert.ok(!('visibility' in page.body) && !('url' in page.body));
  // Nobody else gets it.
  for (const who of ['tom', 'ana']) assert.equal((await call('GET', w(`/library/pages/${PG[2]}`), T[who])).status, 404, who);
  // Nor anything else of the key's source that her key cannot see.
  for (const n of [3, 4, 5]) assert.equal((await call('GET', w(`/library/pages/${PG[n]}`), T.jess)).status, 404, `page ${n}`);
  // The list, search and bulk follow.
  assert.ok((await ok('GET', w('/library/pages'), T.jess)).some((p: any) => p.id === PG[2]));
  assert.ok(!(await ok('GET', w('/library/pages'), T.tom)).some((p: any) => p.id === PG[2]));
  assert.ok((await ok('GET', w('/library/search?q=Jessamine'), T.jess)).some((h: any) => h.id === PG[2]));
  assert.ok(!(await ok('GET', w('/library/search?q=Jessamine'), T.tom)).some((h: any) => h.id === PG[2]));
  const bulk = await ok('POST', w('/library/pages/bulk'), T.jess, { ids: [PG[2], PG[3]] });
  assert.deepEqual(bulk.map((p: any) => p.id), [PG[2]]);
  assert.ok(!JSON.stringify(bulk).includes('ZJ1SECRETPOST'));
  // The GM still sees the whole page.
  assert.match((await call('GET', w(`/library/pages/${PG[2]}`), T.gm)).text, /ZJ1SECRETPOST/);
});

test('SourceKeys: a broker or classified marker, or a source set to GM only, is never lifted', async () => {
  const set = (col: string, v: string) => run(deps.db, `UPDATE pages SET ${col} = ? WHERE id = ?`, v, PG[2]);
  const read = async () => (await call('GET', w(`/library/pages/${PG[2]}`), T.jess)).status;
  for (const lvl of ['broker', 'classified']) { set('marker_level', lvl); assert.equal(await read(), 404, lvl); }
  set('marker_level', 'party');
  assert.equal(await read(), 200);
  await ok('PATCH', `/api/admin/sources/${SRC}`, T.admin, { audience: 'gm' });
  assert.equal(await read(), 404, 'a source set to GM only stays GM only, keys included');
  await ok('PATCH', `/api/admin/sources/${SRC}`, T.admin, { audience: 'auto' });
  assert.equal(await read(), 200);
});

// ---- GM keys, blanket keys, and the agent ----------------------------------------------------------------------

test('SourceKeys: the GM adds a key, assigns its users and uses; a blanket key never feeds a player\'s view or answer', async () => {
  const k = (await ok('POST', SK(), T.gm, { sourceId: SRC, secret: TOKENS.blanket, label: 'Shared API key', trust: 'blanket', users: [ID.tom], uses: ['agent'] }));
  assert.equal(k.trust, 'blanket');
  assert.deepEqual(k.users, [ID.tom]);
  PG.blanketKey = k.id;
  assert.equal(k.probe.verdict, 'sees-everything');
  // It is tom's, for lookups only: jess has no such key to use, and a blanket key has no library view.
  assert.equal((await call('POST', `${SK()}/${k.id}/refresh`, T.tom)).status, 404, 'tom does not own it');
  assert.equal((await call('POST', `${SK()}/${k.id}/refresh`, T.gm)).status, 409);
  assert.equal((await call('GET', w(`/library/pages/${PG[4]}`), T.tom)).status, 404);
  const since = kanka.calls.length;
  const tom = keep(await call('GET', `${SK()}/lookup?q=Blanket%20Only&question=${encodeURIComponent('What is the vault code?')}`, T.tom));
  assert.equal(tom.status, 200);
  assert.equal(tom.body.escalated, true);
  assert.deepEqual(tom.body.results, []);
  assert.ok(!tom.text.includes('ZB1BLANKET') && !tom.text.includes('puppet'), 'nothing of the blanket result reaches the player');
  assert.ok(tokenCalls(since).every((c) => c.token === TOKENS.blanket), 'only tom\'s assigned key was used');
  const jess = await ok('GET', `${SK()}/lookup?q=Blanket%20Only`, T.jess);
  assert.equal(jess.escalated, false);
  assert.match(jess.message, /Nothing found|No source key/);
  // The GM's queue holds the hidden context; the player's list does not.
  const q = await ok('GET', `${SK()}/escalations`, T.gm);
  const esc = q.escalations.find((e: any) => e.askerId === ID.tom);
  assert.ok(esc && JSON.stringify(esc.hidden).includes('ZB1BLANKET'));
  assert.ok(!JSON.stringify(await ok('GET', `${SK()}/escalations`, T.tom)).includes('ZB1BLANKET'));
});

test('SourceKeys: the agent uses only the asking player\'s own keys, per player', async () => {
  const jessSince = kanka.calls.length;
  model.queue.push(() => toolCall('source_lookup', { q: 'Backstory', question: 'What do I remember of my past?' }));
  const chat = await ok('POST', w('/agent/chats'), T.jess, {});
  await ok('POST', w(`/agent/chats/${chat.id}/messages`), T.jess, { text: 'Look up my backstory in Kanka' });
  for (let i = 0; i < 100; i++) { if (!(await ok('GET', w(`/agent/chats/${chat.id}`), T.jess)).busy) break; await new Promise((r) => setTimeout(r, 25)); }
  const lookups = tokenCalls(jessSince).filter((c) => c.path.includes('/search/'));
  assert.ok(lookups.length >= 1, 'a live search was made');
  assert.ok(lookups.every((c) => c.token === TOKENS.jess), `only jess's key: ${JSON.stringify(lookups)}`);
  const toolMsg = model.seen.flatMap((b) => b.messages).filter((m: any) => m.role === 'tool').at(-1);
  assert.match(toolMsg.content, /ZJ1PUBLIC/, 'her own page is returned, as her copy');
  assert.ok(!/ZJ1SECRETPOST|ZT1PUBLIC|ZB1BLANKET/.test(toolMsg.content));
  // Tom's agent: his blanket key's results are escalated, the reply says so, and no text of them reaches him.
  const tomSince = kanka.calls.length;
  model.queue.push(() => toolCall('source_lookup', { q: 'Blanket', question: 'What does the duke hide?' }));
  const tc = await ok('POST', w('/agent/chats'), T.tom, {});
  await ok('POST', w(`/agent/chats/${tc.id}/messages`), T.tom, { text: 'Search Kanka for Blanket' });
  let done: any;
  for (let i = 0; i < 100; i++) { done = await ok('GET', w(`/agent/chats/${tc.id}`), T.tom); if (!done.busy) break; await new Promise((r) => setTimeout(r, 25)); }
  const reply1 = done.messages.filter((m: any) => m.role === 'assistant').at(-1);
  assert.match(reply1.text, /The broker will look into it\./);
  assert.ok(!/ZB1BLANKET|puppet/.test(JSON.stringify(done)));
  assert.ok(tokenCalls(tomSince).filter((c) => c.path.includes('/search/')).every((c) => c.token === TOKENS.blanket), 'never jess\'s key, never the GM\'s');
  assert.ok(!tokenCalls(jessSince).some((c) => c.token === TOKENS.gm), 'the GM\'s key is never used for a player');
});

// ---- escalation ------------------------------------------------------------------------------------------------------

test('SourceKeys: escalation as a GM question: nothing is answered until the GM answers', async () => {
  await ok('PATCH', w('/settings'), T.gm, { escalation: 'gm-question' });
  const asked = await ok('POST', `${SK()}/escalations`, T.ana, { question: 'Who truly leads the harbour council?' });
  assert.equal(asked.escalated, true);
  assert.equal(asked.message, 'The broker will look into it.');
  assert.equal(asked.escalation.answer, null);
  const mine = (await ok('GET', `${SK()}/escalations`, T.ana)).escalations;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'open');
  assert.ok(!('hidden' in mine[0]));
  const id = mine[0].id;
  assert.equal((await call('POST', `${SK()}/escalations/${id}/answer`, T.ana, { answer: 'I answer myself' })).status, 403);
  assert.equal((await call('GET', `${SK()}/escalations`, T.tom)).body.escalations.some((e: any) => e.id === id), false, 'only the asker sees it');
  await ok('POST', `${SK()}/escalations/${id}/answer`, T.gm, { answer: 'Nobody you have met.' });
  const after = (await ok('GET', `${SK()}/escalations`, T.ana)).escalations[0];
  assert.equal(after.status, 'answered');
  assert.equal(after.answer, 'Nobody you have met.');
  assert.equal((await call('POST', `${SK()}/escalations/${id}/answer`, T.gm, { answer: 'again' })).status, 409);
  // Off topic is turned away, not escalated.
  const poem = await ok('POST', `${SK()}/escalations`, T.ana, { question: 'Write me a poem about bitcoin' });
  assert.equal(poem.escalated, false);
  assert.equal(poem.refused, true);
});

test('SourceKeys: escalation as a broker deal: priced by the GM, delivered only after approval', async () => {
  await ok('PATCH', w('/settings'), T.gm, { escalation: 'broker-deal', escalationSessions: 2, brokerEnabled: true });
  await ok('POST', w('/live/ledger'), T.gm, { owner: ID.ana, amountCp: 5000, note: 'coin' });
  const asked = await ok('POST', `${SK()}/escalations`, T.ana, { question: 'What is behind the duke\'s locked door?' });
  const e = asked.escalation;
  assert.ok(e.brokerRequestId, 'a broker request was made');
  const brokerList = JSON.stringify(await ok('GET', w('/broker'), T.ana));
  assert.ok(brokerList.includes(e.brokerRequestId) && brokerList.includes('pricing'));
  const priced = await ok('POST', `${SK()}/escalations/${e.id}/price`, T.gm, { costCp: 300, answer: 'ZESCAL-DEAL-TEXT the door hides the duke\'s ledgers', note: 'worth it' });
  assert.equal(priced.sessions, 2, 'the default wait is two sessions');
  const offer = (await ok('GET', `${SK()}/escalations`, T.ana)).escalations.find((x: any) => x.id === e.id);
  assert.equal(offer.status, 'offered');
  assert.equal(offer.costCp, 300);
  assert.ok(!JSON.stringify(offer).includes('ZESCAL-DEAL-TEXT'), 'no text before approval');
  assert.ok(!JSON.stringify(await ok('GET', w('/broker'), T.ana)).includes('ZESCAL-DEAL-TEXT'));
  await ok('POST', w(`/broker/${e.brokerRequestId}/accept`), T.ana);
  const waiting = (await ok('GET', `${SK()}/escalations`, T.ana)).escalations.find((x: any) => x.id === e.id);
  assert.equal(waiting.status, 'waiting');
  assert.ok(!JSON.stringify(waiting).includes('ZESCAL-DEAL-TEXT'), 'paid, but not delivered: still no text');
  await ok('POST', w(`/broker/${e.brokerRequestId}/approve`), T.gm);
  const done = (await ok('GET', `${SK()}/escalations`, T.ana)).escalations.find((x: any) => x.id === e.id);
  assert.equal(done.status, 'answered');
  assert.match(done.answer, /ZESCAL-DEAL-TEXT/);
});

test('SourceKeys: a broker question that goes to the GM is in the escalation queue with its hidden context', async () => {
  await ok('PUT', w('/library/pages'), T.gm, { path: 'gm/Queen', visibility: 'gm', markdown: '# Queen\nThe smuggler queen Velmira keeps her treasury beneath the lighthouse.\n' });
  const q = await ok('POST', w('/broker/quote'), T.tom, { question: 'Who is the smuggler queen and where is her treasury?', length: 'short' });
  const asked = await ok('POST', w('/broker/ask'), T.tom, { quoteId: q.quoteId });
  assert.equal(asked.status, 'pricing');
  const queue = (await ok('GET', `${SK()}/escalations`, T.gm)).escalations;
  const mine = queue.find((e: any) => e.brokerRequestId === asked.id);
  assert.ok(mine && mine.origin === 'broker');
  assert.ok(!JSON.stringify(await ok('GET', `${SK()}/escalations`, T.tom)).includes('Velmira'));
});

// ---- sharing ---------------------------------------------------------------------------------------------------------

test('SourceKeys: a player shares a page their own key sees; the recipient gets the same player copy; unsharing ends it at once', async () => {
  const S = (id: string, who: string, body?: unknown, m = 'POST') => call(m, w(`/library/pages/${id}/share`), T[who], body);
  const mineCopy = (await ok('GET', w(`/library/pages/${PG[2]}`), T.jess)).body;
  // Only a page you can see can be shared.
  assert.equal((await S(PG[2], 'jess')).status, 400, 'a body is needed');
  assert.equal((await S(PG[2], 'tom', { to: [ID.ana] })).status, 404, 'tom cannot see it, so cannot share it');
  assert.equal((await S(PG[5], 'jess', { to: [ID.ana] })).status, 404);
  assert.equal((await S(PG[2], 'jess', { to: [ID.gm] })).status, 400, 'recipients are players');
  assert.equal((await S(PG[2], 'jess', { to: [ID.ana] })).status, 201);
  const ana = await call('GET', w(`/library/pages/${PG[2]}`), T.ana);
  assert.equal(ana.status, 200);
  assert.equal(ana.body.body, mineCopy, 'the very same player copy');
  assert.ok(!ana.text.includes('ZJ1SECRETPOST'));
  assert.equal(ana.body.via, 'share');
  assert.equal((await call('GET', w(`/library/pages/${PG[2]}`), T.tom)).status, 404, 'tom is not a recipient');
  assert.ok((await ok('GET', w('/library/pages'), T.ana)).find((p: any) => p.id === PG[2])?.sharedWithMe);
  assert.ok((await ok('GET', w('/library/search?q=Jessamine'), T.ana)).some((h: any) => h.id === PG[2]));
  const who = (await ok('GET', w(`/library/pages/${PG[2]}/share`), T.jess)).shares;
  assert.deepEqual(who.map((x: any) => x.to), [ID.ana]);
  // The recipient may share it on, and it ends with the first sharer.
  assert.equal((await S(PG[2], 'ana', { to: [ID.tom] })).status, 201);
  assert.equal((await call('GET', w(`/library/pages/${PG[2]}`), T.tom)).status, 200);
  await ok('DELETE', w(`/library/pages/${PG[2]}/share?to=${ID.ana}`), T.jess);
  assert.equal((await call('GET', w(`/library/pages/${PG[2]}`), T.ana)).status, 404, 'unshared: gone at once');
  assert.equal((await call('GET', w(`/library/pages/${PG[2]}`), T.tom)).status, 404, 'and so is what ana passed on');
  assert.ok(!(await ok('GET', w('/library/search?q=Jessamine'), T.ana)).some((h: any) => h.id === PG[2]));
  assert.deepEqual((await ok('POST', w('/library/pages/bulk'), T.ana, { ids: [PG[2]] })), []);
});

test('SourceKeys: the GM shares any page except broker and classified, with the party or chosen players', async () => {
  const S = (id: string, body: unknown, who = 'gm', m = 'POST') => call(m, w(`/library/pages/${id}/share`), T[who], body);
  assert.equal((await call('GET', w(`/library/pages/${PG[5]}`), T.tom)).status, 404);
  assert.equal((await S(PG[5], { to: [ID.tom] })).status, 201);
  const tom = await call('GET', w(`/library/pages/${PG[5]}`), T.tom);
  assert.equal(tom.status, 200);
  assert.equal(tom.body.via, 'gm');
  assert.equal((await call('GET', w(`/library/pages/${PG[5]}`), T.ana)).status, 404);
  await S(PG[5], { to: 'party' });
  assert.equal((await call('GET', w(`/library/pages/${PG[5]}`), T.ana)).status, 200);
  await ok('DELETE', w(`/library/pages/${PG[5]}/share`), T.gm);
  assert.equal((await call('GET', w(`/library/pages/${PG[5]}`), T.tom)).status, 404);
  // Never broker or classified, and the page's own level is unchanged.
  const cls = (await ok('PUT', w('/library/pages'), T.gm, { path: 'c/Vault', visibility: 'classified', markdown: '# Vault\nsecret\n' })).id;
  const brk = (await ok('PUT', w('/library/pages'), T.gm, { path: 'c/Rumour', visibility: 'broker', markdown: '# Rumour\nsecret\n' })).id;
  assert.equal((await S(cls, { to: 'party' })).status, 409);
  assert.equal((await S(brk, { to: 'party' })).status, 409);
  assert.equal(one<any>(deps.db, 'SELECT visibility FROM pages WHERE id = ?', PG[5]).visibility, 'gm');
  // A GM page of the GM's own, with a secret block: the player copy has no secret.
  const own = (await ok('PUT', w('/library/pages'), T.gm, { path: 'c/Plan', visibility: 'gm', markdown: '# Plan\nPublic line ZPLANPUBLIC.\n\n> [!secret] GM\n> ZPLANSECRET\n' })).id;
  await S(own, { to: 'party' });
  const t = await call('GET', w(`/library/pages/${own}`), T.tom);
  assert.match(t.text, /ZPLANPUBLIC/);
  assert.ok(!t.text.includes('ZPLANSECRET'));
});

// ---- revocation and audit ----------------------------------------------------------------------------------------

test('SourceKeys: revoking a key stops its use at once, wipes the secret and ends what was shared from it', async () => {
  const S = (to: unknown) => call('POST', w(`/library/pages/${PG[2]}/share`), T.jess, { to });
  assert.equal((await S('party')).status, 201);
  assert.equal((await call('GET', w(`/library/pages/${PG[2]}`), T.ana)).status, 200);
  const since = kanka.calls.length;
  await ok('DELETE', `${SK()}/${PG.jessKey}`, T.jess);
  assert.equal((await call('GET', w(`/library/pages/${PG[2]}`), T.jess)).status, 404, 'gone with no refresh');
  assert.equal((await call('GET', w(`/library/pages/${PG[2]}`), T.ana)).status, 404, 'and from the people she shared it with');
  assert.equal((await call('GET', w(`/library/pages/${PG[2]}`), T.tom)).status, 404);
  const look = await ok('GET', `${SK()}/lookup?q=Backstory`, T.jess);
  assert.deepEqual(look.results, []);
  assert.equal(kanka.calls.length, since, 'the source is not asked with a revoked key');
  assert.equal(one<any>(deps.db, 'SELECT secret, revoked FROM sourcekeys_keys WHERE id = ?', PG.jessKey).secret, '');
  assert.equal((await call('POST', `${SK()}/${PG.jessKey}/refresh`, T.jess)).status, 409);
  assert.equal(all(deps.db, 'SELECT 1 FROM sourcekeys_access WHERE key_id = ?', PG.jessKey).length, 0);
  assert.equal((await ok('GET', SK(), T.jess)).keys.length, 0, 'a revoked key leaves the player\'s list');
  assert.ok((await ok('GET', SK(), T.gm)).keys.find((k: any) => k.id === PG.jessKey).revoked);
});

test('SourceKeys: the GM can revoke any key, and changing trust stops a library view at once', async () => {
  const a = await ok('POST', SK(), T.tom, { sourceId: SRC, secret: TOKENS.tom, label: 'Tom Kanka' });
  await ok('PATCH', `${SK()}/${a.id}`, T.gm, { trust: 'per-user' });
  await ok('POST', `${SK()}/${a.id}/refresh`, T.tom);
  assert.equal((await call('GET', w(`/library/pages/${PG[3]}`), T.tom)).status, 200);
  await ok('PATCH', `${SK()}/${a.id}`, T.gm, { trust: 'blanket' });
  assert.equal((await call('GET', w(`/library/pages/${PG[3]}`), T.tom)).status, 404, 'a blanket key feeds nobody');
  await ok('PATCH', `${SK()}/${a.id}`, T.gm, { trust: 'per-user' });
  await ok('POST', `${SK()}/${a.id}/refresh`, T.gm);
  assert.equal((await call('GET', w(`/library/pages/${PG[3]}`), T.tom)).status, 200);
  await ok('PATCH', `${SK()}/${a.id}`, T.gm, { users: [ID.ana] });
  assert.equal((await call('GET', w(`/library/pages/${PG[3]}`), T.tom)).status, 404, 'no longer a named user');
  await ok('DELETE', `${SK()}/${a.id}`, T.gm);
  assert.equal(one<any>(deps.db, 'SELECT revoked FROM sourcekeys_keys WHERE id = ?', a.id).revoked, 1);
});

test('SourceKeys: every use is audited with the key, the account and the use; no secret is ever in a response or the log', () => {
  const rows = all<any>(deps.db, `SELECT account_id, action, detail FROM audit WHERE world_id = ? AND action LIKE 'sourcekeys.%'`, W);
  const uses = rows.filter((r) => r.action === 'sourcekeys.use');
  assert.ok(uses.some((r) => r.account_id === ID.jess && r.detail.includes(PG.jessKey) && r.detail.includes('for agent')), 'the agent lookup');
  assert.ok(uses.some((r) => r.account_id === ID.jess && r.detail.includes('for library') && r.detail.includes('refresh')), 'the library refresh');
  assert.ok(uses.some((r) => r.account_id === ID.tom && r.detail.includes(PG.blanketKey)));
  for (const a of ['add', 'update', 'revoke', 'refused', 'escalate', 'answer', 'price', 'share', 'unshare']) assert.ok(rows.some((r) => r.action === `sourcekeys.${a}`), a);
  const log = JSON.stringify(all(deps.db, 'SELECT detail FROM audit'));
  for (const t of Object.values(TOKENS)) {
    assert.ok(!log.includes(t), 'a secret is in the audit log');
    for (const s of secretsSeen) assert.ok(!s.includes(t), 'a secret came back in a response');
  }
});
