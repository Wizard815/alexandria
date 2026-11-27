// Bulk indexing: a whole world's embeddings go in a few large requests, several
// in flight at once; the story bible reads several pages at once and embeds
// their facts together; one bulk build (a job) does both after an import; and
// a single edit afterwards is still one small request.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all } from '../src/core/db.ts';
import { embeddingCoverage, semanticPages, syncEmbeddings } from '../src/features/search/embeddings.ts';
import { forgetRefusals } from '../src/features/search/copies.ts';
import { syncBible } from '../src/features/bible/extract.ts';
import { bibleCoverage } from '../src/features/bible/assemble.ts';
import { pool } from '../src/features/search/batching.ts';

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

const stats = { embedCalls: 0, embedInputs: 0, chatCalls: 0, inFlight: 0, maxEmbedInFlight: 0, maxChatInFlight: 0 };
const reset = () => Object.assign(stats, { embedCalls: 0, embedInputs: 0, chatCalls: 0, inFlight: 0, maxEmbedInFlight: 0, maxChatInFlight: 0 });
let chatIn = 0;
const sentInputs: string[] = [];
let embedIn = 0;
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fake = (async (url: any, init?: any) => {
  const u = String(url);
  const body = JSON.parse(init?.body ?? '{}');
  if (u.endsWith('/embeddings')) {
    stats.embedCalls++;
    stats.embedInputs += body.input.length;
    sentInputs.push(...body.input);
    embedIn++;
    stats.maxEmbedInFlight = Math.max(stats.maxEmbedInFlight, embedIn);
    await sleep(15);
    embedIn--;
    return json({ data: body.input.map((t: string, i: number) => ({ index: i, embedding: [t.length % 7 + 1, 1, 0.5] })) });
  }
  if (u.endsWith('/chat/completions')) {
    stats.chatCalls++;
    chatIn++;
    stats.maxChatInFlight = Math.max(stats.maxChatInFlight, chatIn);
    await sleep(20);
    chatIn--;
    const title = /^Page: (.*)$/m.exec(String(body.messages.at(-1).content))?.[1] ?? 'Page';
    return json({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ facts: [{ subject: title, kind: 'place', fact: `${title} stands by the harbour.` }, { subject: title, kind: 'lore', fact: `${title} is old.` }] }) } }] });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

async function boot(host: string, env: Record<string, string> = {}) {
  forgetRefusals();
  const made = createApp({ noScheduler: true, fetch: fake, env: {
    ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0',
    ALX_MODEL_EXTRA_URL: `http://${host}/v1`, ALX_MODEL_EXTRA_MODEL: 'fake-embed',
    ALX_MODEL_CHAT_URL: `http://${host}/v1`, ALX_MODEL_CHAT_MODEL: 'fake-chat',
    ...env,
  } });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  cleanups.push(() => { server.close(); server.closeAllConnections?.(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let j: any = text;
    try { j = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, body: j, text };
  };
  const a = (await call('POST', '/api/setup', null, { username: 'wizard', password: 'correct horse battery' })).body;
  const tok = a.token as string;
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, tok, body);
    assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${r.text.slice(0, 300)}`);
    return r;
  };
  const world = (await ok('POST', '/api/admin/worlds', { name: 'Bulkhaven', dmAccountId: a.account.id })).body.id as string;
  const put = async (path: string, markdown: string, visibility = 'dm') => (await ok('PUT', `/api/worlds/${world}/library/pages`, { path, visibility, markdown })).body;
  return { ...made, call, ok, world, put };
}

const seed = async (h: Awaited<ReturnType<typeof boot>>, n: number) => {
  for (let i = 0; i < n; i++) await h.put(`Places/Place ${i}`, `# Place ${i}\n\nPlace ${i} is a small town by the grey harbour, known for its lanterns and its quiet market.\n`);
};

test('TestBulk_EmbeddingsPackManyPagesIntoFewParallelRequests', async () => {
  const h = await boot('bulk-embed', { ALX_EMBED_BATCH: '8', ALX_EMBED_PARALLEL: '4' });
  await seed(h, 40);
  reset();
  const r = await syncEmbeddings(h.deps, { worldId: h.world, maxPages: 1_000_000 });
  assert.equal(r.error, undefined);
  assert.equal(r.pages, 40, 'every page in one pass');
  assert.equal(r.remaining, false);
  assert.equal(embeddingCoverage(h.deps, h.world).progress.pending, 0);
  // One short chunk a page, eight chunks a request: five requests, not forty.
  assert.equal(stats.embedInputs, 40);
  assert.ok(stats.embedCalls <= 6, `few requests (${stats.embedCalls})`);
  // A local model takes two at a time (the queue in core/ai.ts): both slots are used, never more.
  assert.equal(stats.maxEmbedInFlight, 2, `in flight at once: ${stats.maxEmbedInFlight}`);
  const perPage = all<any>(h.deps.db, `SELECT page_id, count(*) AS n FROM search_chunks WHERE world_id = ? AND scope = 'dm' GROUP BY page_id`, h.world);
  assert.equal(perPage.length, 40);
  assert.ok(perPage.every((x) => Number(x.n) === 1), 'each page has its own chunks, none mixed up');

  // A single edit afterwards is one small request.
  await h.put('Places/Place 7', '# Place 7\n\nPlace 7 burned down last winter; only the lighthouse is left.\n');
  reset();
  const one = await syncEmbeddings(h.deps, { worldId: h.world });
  assert.equal(one.pages, 1);
  assert.equal(stats.embedCalls, 1);
});

test('TestBulk_BibleReadsSeveralPagesAtOnceAndEmbedsFactsTogether', async () => {
  const h = await boot('bulk-bible', { ALX_EMBED_BATCH: '64', ALX_BIBLE_PARALLEL: '4' });
  await seed(h, 12);
  await syncEmbeddings(h.deps, { worldId: h.world, maxPages: 1_000_000 });
  reset();
  const r = await syncBible(h.deps, { worldId: h.world, maxPages: 1_000_000 });
  assert.equal(r.skipped, undefined);
  assert.equal(r.pages, 12);
  assert.equal(r.facts, 24);
  assert.equal(r.remaining, false);
  assert.equal(stats.chatCalls, 12, 'one chat call a page');
  assert.ok(stats.maxChatInFlight >= 2, `pages read at once: ${stats.maxChatInFlight}`);
  // 24 facts: embedded in a few requests, not one per page.
  assert.ok(stats.embedCalls < 12, `fact embedding requests: ${stats.embedCalls}`);
  const withVec = all<any>(h.deps.db, 'SELECT count(*) AS n, sum(vec IS NOT NULL) AS v FROM bible_facts WHERE world_id = ?', h.world)[0];
  assert.equal(Number(withVec.n), 24);
  assert.equal(Number(withVec.v), 24, 'every fact has its vector');

  // The budget still holds for the small background passes.
  await h.put('Places/Place 3', '# Place 3\n\nPlace 3 now has a new mayor.\n');
  await h.put('Places/Place 4', '# Place 4\n\nPlace 4 lost its bridge.\n');
  const small = await syncBible(h.deps, { worldId: h.world, maxPages: 1 });
  assert.equal(small.pages, 1);
  assert.equal(small.remaining, true);
});

test('TestBulk_BuildEndpointIndexesTheWholeWorldAsOneJob', async () => {
  const h = await boot('bulk-build', { ALX_EMBED_BATCH: '16' });
  await seed(h, 20);
  reset();
  const r = await h.ok('POST', `/api/worlds/${h.world}/search/build`, {});
  assert.equal(r.status, 202);
  assert.equal(r.body.started, true);
  const again = await h.ok('POST', `/api/worlds/${h.world}/search/build`, {});
  assert.equal(again.body.started, false, 'one build per world at a time');
  for (let i = 0; i < 400 && h.deps.jobs.running('index-build', h.world); i++) await sleep(20);
  assert.equal(h.deps.jobs.running('index-build', h.world), false);
  const job = h.deps.jobs.list().find((j: any) => j.kind === 'index-build' && j.worldId === h.world)!;
  assert.equal(job.status, 'done', job.error ?? '');
  assert.equal(embeddingCoverage(h.deps, h.world).progress.pending, 0, 'every page embedded');
  assert.equal(bibleCoverage(h.deps, h.world).progress.pending, 0, 'every page read into the story bible');
  assert.ok(stats.chatCalls >= 20);
  // The GM-only endpoint.
  const player = await h.call('POST', `/api/worlds/${h.world}/search/build`, null, {});
  assert.ok(player.status >= 400);
});

test('TestBulk_PoolStopsAtTheFirstErrorAndRunsInParallel', async () => {
  let inFlight = 0;
  let most = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  let i = 0;
  const seen: number[] = [];
  await pool(3, () => (i < items.length ? items[i++] : null), async (x) => { inFlight++; most = Math.max(most, inFlight); await sleep(5); seen.push(x); inFlight--; });
  assert.equal(most, 3);
  assert.deepEqual([...seen].sort((a, b) => a - b), items);
  i = 0;
  let ran = 0;
  await assert.rejects(pool(2, () => (i < items.length ? items[i++] : null), async (x) => { ran++; await sleep(2); if (x === 3) throw new Error('down'); }), /down/);
  assert.ok(ran < items.length, 'the rest were not started');
});

test('TestBulk_WrongKeyStopsThePassInsteadOfBackingOffEveryPage', async () => {
  const h = await boot('bulk-badkey', { ALX_EMBED_BATCH: '8' });
  await seed(h, 20);
  let calls = 0;
  const real = h.deps.fetch;
  h.deps.fetch = (async (url: any, init?: any) => {
    if (String(url).endsWith('/embeddings')) { calls++; return new Response(JSON.stringify({ error: { message: 'User not found.', code: 401 } }), { status: 401, headers: { 'Content-Type': 'application/json' } }); }
    return real(url, init);
  }) as typeof fetch;
  const r = await syncEmbeddings(h.deps, { worldId: h.world, maxPages: 1_000_000 });
  assert.ok(r.error, 'the pass reports the error');
  assert.equal(r.refused, undefined, 'no page is blamed for a wrong key');
  assert.ok(calls <= 2, `stops early (${calls} requests)`);
  assert.equal(embeddingCoverage(h.deps, h.world).progress.refused ?? 0, 0);
  // With the key fixed, every page goes at once, with no wait.
  h.deps.fetch = real;
  const ok = await syncEmbeddings(h.deps, { worldId: h.world, maxPages: 1_000_000 });
  assert.equal(ok.error, undefined);
  assert.equal(ok.pages, 20);
});

test('TestBulk_IdenticalCopiesOfAPageAreReadOnce', async () => {
  const h = await boot('bulk-twins', { ALX_BIBLE_PARALLEL: '4' });
  // Party pages: the party, broker and GM copies hold the same text.
  await seed(h, 10);
  for (let i = 0; i < 10; i++) await h.put(`Open/Open ${i}`, `# Open ${i}\n\nOpen ${i} is a ferry landing where everyone may go, with tar barrels and gulls.\n`, 'party');
  reset();
  const e = await syncEmbeddings(h.deps, { worldId: h.world, maxPages: 1_000_000 });
  assert.equal(e.error, undefined);
  const copies = embeddingCoverage(h.deps, h.world).progress.eligible;
  assert.ok(copies >= 30, `the party pages have several copies (${copies})`);
  assert.equal(e.pages, copies, 'every copy is indexed');
  assert.equal(stats.embedInputs, 20, 'each distinct text is embedded once');
  assert.equal(e.reused, copies - 20);
  // The twins hold the very same vectors as the copy that was embedded.
  const vecs = all<any>(h.deps.db, `SELECT c.scope, hex(c.vec) AS v FROM search_chunks c JOIN pages p ON p.id = c.page_id WHERE p.path LIKE 'Open/Open 3%'`);
  assert.ok(vecs.length >= 2 && new Set(vecs.map((x) => x.v)).size === 1, JSON.stringify(vecs.map((x) => x.scope)));
  reset();
  const b = await syncBible(h.deps, { worldId: h.world, maxPages: 1_000_000 });
  assert.ok((b.reused ?? 0) >= 10, `facts reused for the twin copies (${b.reused})`);
  assert.equal(stats.chatCalls, 20, 'one chat call per distinct text');
  assert.equal(bibleCoverage(h.deps, h.world).progress.pending, 0, 'every copy has its facts');
  // An edit that changes one copy only: that copy alone is read again, the others keep theirs.
  await h.put('Open/Open 3', '# Open 3\n\nThe ferry landing burned down.\n', 'party');
  reset();
  await syncEmbeddings(h.deps, { worldId: h.world });
  assert.equal(stats.embedInputs, 1, 'one new text, embedded once for all its copies');
});

test('TestBulk_DocumentAndQueryPrefixesFromTheModelOptions', async () => {
  const h = await boot('bulk-prefix', { ALX_MODEL_EXTRA_OPTIONS: JSON.stringify({ docPrefix: 'search_document: ', queryPrefix: 'search_query: ' }) });
  await seed(h, 3);
  sentInputs.length = 0;
  await syncEmbeddings(h.deps, { worldId: h.world, maxPages: 1_000_000 });
  assert.ok(sentInputs.length > 0 && sentInputs.every((t) => t.startsWith('search_document: Place ')), sentInputs[0]);
  sentInputs.length = 0;
  await semanticPages(h.deps, h.world, 'dm', 'lanterns by the harbour');
  assert.deepEqual(sentInputs, ['search_query: lanterns by the harbour']);
  // The prefix is part of what the chunks were made with: changing it embeds the world again.
  const state = all<any>(h.deps.db, 'SELECT DISTINCT model FROM search_chunk_state WHERE world_id = ?', h.world).map((x) => x.model);
  assert.equal(state.length, 1);
  assert.match(state[0], /^fake-embed\|p:[0-9a-f]{8}\|lv1$/);
});
