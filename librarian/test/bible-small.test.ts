// The story bible on a small model (0.5 to 2B): the model is told to write facts in the caveman voice, a JSON schema is
// sent, a long page is read in short pieces, and a fact about a name the page never mentions is dropped.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all } from '../src/core/db.ts';
import { isSmallModel, piecesOf, revectorFacts, syncBible } from '../src/features/bible/extract.ts';

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
const seen: any[] = [];
let embedSeed = 1;
const fake = (async (url: any, init?: any) => {
  const u = String(url);
  const body = JSON.parse(init?.body ?? '{}');
  if (u.endsWith('/embeddings')) return json({ data: body.input.map((_t: string, i: number) => ({ index: i, embedding: [embedSeed, 0.5, 0.25] })) });
  if (u.endsWith('/chat/completions')) {
    seen.push(body);
    const user = String(body.messages.at(-1).content);
    const facts = [{ subject: 'Mira Vell', kind: 'person', fact: 'Runs harbour guild.' }, { subject: 'Zorbulax', kind: 'person', fact: 'Made-up name.' }];
    if (!user.includes('Mira Vell')) facts.shift();
    return json({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ facts }) } }] });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

async function boot(bibleModel: string) {
  const made = createApp({ noScheduler: true, fetch: fake, env: {
    ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0',
    ALX_MODEL_EXTRA_URL: 'http://small/v1', ALX_MODEL_EXTRA_MODEL: 'nomic-embed-text-v1.5',
    ALX_MODEL_CHAT_URL: 'http://small/v1', ALX_MODEL_CHAT_MODEL: 'big-chat',
    ALX_MODEL_BIBLE_URL: 'http://small/v1', ALX_MODEL_BIBLE_MODEL: bibleModel,
  } });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  cleanups.push(() => { server.close(); server.closeAllConnections?.(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return r.json() as Promise<any>;
  };
  const a = await call('POST', '/api/setup', null, { username: 'wizard', password: 'correct horse battery' });
  const world = (await call('POST', '/api/admin/worlds', a.token, { name: 'Smallhaven', dmAccountId: a.account.id })).id as string;
  const para = (i: number) => `Paragraph ${i}. Mira Vell runs the harbour guild and keeps its ledgers in the old customs house by the water, where ships unload at dawn.`;
  await call('PUT', `/api/worlds/${world}/library/pages`, a.token, { path: 'People/Mira Vell', visibility: 'dm', markdown: `# Mira Vell\n\n${Array.from({ length: 30 }, (_, i) => para(i)).join('\n\n')}\n` });
  return { deps: made.deps, world };
}

test('TestBible_KnowsSmallModelsByName', () => {
  for (const m of ['qwen3-0.6b', 'Qwen3-1.7B-Instruct-Q8_0', 'liquid/lfm-3-1.7b', 'gemma-3-1b-it', 'llama-3.2-1b', 'tencent/hy-mt2-1.8b', 'qwen2.5-0.5b-instruct']) assert.equal(isSmallModel(m), true, m);
  for (const m of ['qwen3-30b-a3b', 'tencent/hy4-flash', 'qwen3-4b', 'prism-ml/ternary-bonsai-2-9b', 'big-chat', 'gpt-4o-mini', 'liquid/lfm-2.5-24b-a2b']) assert.equal(isSmallModel(m), false, m);
  assert.equal(isSmallModel('my-tiny-thing', { smallModel: true }), true, 'the job option wins');
  assert.equal(isSmallModel('qwen3-0.6b', { smallModel: false }), false);
});

test('TestBible_PiecesBreakAtParagraphsAndStayShort', () => {
  const text = Array.from({ length: 10 }, (_, i) => `Para ${i}. ${'word '.repeat(60)}`).join('\n\n');
  const p = piecesOf(text, 800);
  assert.ok(p.length > 1);
  assert.ok(p.every((x) => x.length <= 800));
  assert.ok(p.every((x) => x.startsWith('Para ')), 'each piece starts at a paragraph');
  assert.equal(piecesOf('short', 800).length, 1);
  assert.ok(piecesOf('x'.repeat(2000), 800).every((x) => x.length <= 800), 'one long run is cut too');
});

test('TestBible_SmallModelReadsInPiecesWithCavemanFactsAndASchema', async () => {
  const h = await boot('qwen3-0.6b');
  seen.length = 0;
  const r = await syncBible(h.deps, { worldId: h.world, maxPages: 100 });
  assert.ok(r.pages >= 1, JSON.stringify(r));
  const forPage = seen.filter((b) => String(b.messages.at(-1).content).startsWith('Page: Mira Vell'));
  assert.ok(forPage.length > 1, `a long page is several short calls (${forPage.length})`);
  assert.ok(forPage.every((b) => String(b.messages.at(-1).content).length < 2100), 'each piece is short');
  const sys = String(forPage[0].messages[0].content);
  assert.match(sys, /caveman style/);
  assert.match(sys, /At most 10 facts/);
  assert.equal(forPage[0].response_format?.type, 'json_schema');
  const facts = all<any>(h.deps.db, 'SELECT subject, fact FROM bible_facts WHERE world_id = ?', h.world);
  assert.ok(facts.some((f) => f.subject === 'Mira Vell'));
  assert.ok(!facts.some((f) => f.subject === 'Zorbulax'), 'a name the page never says is dropped');
});

test('TestBible_BigModelReadsAPageInOneCall', async () => {
  const h = await boot('qwen3-30b-a3b');
  seen.length = 0;
  await syncBible(h.deps, { worldId: h.world, maxPages: 100 });
  const forPage = seen.filter((b) => String(b.messages.at(-1).content).startsWith('Page: Mira Vell'));
  assert.ok(forPage.length >= 1 && forPage.length <= 4, `one call per page copy (${forPage.length})`);
  assert.match(String(forPage[0].messages[0].content), /At most 30 facts/);
});

test('TestBible_NewEmbedderRemakesFactVectorsAndKeepsTheFacts', async () => {
  const h = await boot('qwen3-0.6b');
  await syncBible(h.deps, { worldId: h.world, maxPages: 100 });
  const before = all<any>(h.deps.db, 'SELECT id, fact, vec FROM bible_facts WHERE world_id = ? ORDER BY id', h.world);
  assert.ok(before.length > 0);
  seen.length = 0;
  embedSeed = 3;
  const n = await revectorFacts(h.deps, h.world);
  assert.equal(n, before.length);
  const after = all<any>(h.deps.db, 'SELECT id, fact, vec FROM bible_facts WHERE world_id = ? ORDER BY id', h.world);
  assert.deepEqual(after.map((r) => r.fact), before.map((r) => r.fact), 'the same facts');
  assert.notDeepEqual(Buffer.from(after[0].vec), Buffer.from(before[0].vec), 'new vectors');
  assert.equal(seen.length, 0, 'no page read again by the chat model');
  embedSeed = 1;
});
