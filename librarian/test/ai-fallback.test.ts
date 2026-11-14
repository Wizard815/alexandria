// core/ai.ts providers and fallback: a job's main provider is tried first and,
// when it cannot answer (no connection, timeout, 5xx, 503 while loading, a model
// that is unloaded or not found), the fallback once. A 4xx about the request
// never falls back. Leaving a local provider for a cloud one needs the job's
// switch. The classified guard screens every attempt. Rerank has a time budget.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ClassifiedRefused, ModelUnavailable, canFallBack, chainFor, chat, chatStream, embed, inferLocation, pinned, rerank, rerankItems, setJobResolver, speak, transcribe, type Job, type JobConfig } from '../src/core/ai.ts';
import { levelWords } from '../src/core/levels.ts';

type Reply = Response | ((url: string, body: any, headers: Record<string, string>) => Response | Promise<Response>);
interface Call { url: string; body: any; headers: Record<string, string> }

const LOCAL = 'http://argos.lan:8080/v1';
const CLOUD = 'https://api.openai.com/v1';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (content = 'hi') => json({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const err = (status: number, message: string) => json({ error: { message } }, status);
const msgs = [{ role: 'user' as const, content: 'Where is the keep?' }];

/** Deps whose fetch answers by host: `primary` for argos.lan, `second` for api.openai.com. */
function setup(primary: Reply, second: Reply, cfg: { main?: Partial<JobConfig>; fb?: Partial<JobConfig>; allowCloud?: boolean; jobs?: Job[]; library?: unknown } = {}) {
  const calls: Call[] = [];
  const d: any = {
    env: {},
    library: cfg.library,
    fetch: async (url: string, init: any) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      calls.push({ url, body, headers: init.headers });
      const r = url.startsWith(LOCAL) ? primary : second;
      if (typeof r !== 'function') return r.clone();
      const sig: AbortSignal | undefined = init.signal;
      if (sig?.aborted) throw new DOMException('Aborted', 'AbortError');
      // Like real fetch: an abort rejects the call even while the server is still thinking.
      const gone = new Promise<never>((_, rej) => sig?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')), { once: true }));
      return Promise.race([Promise.resolve().then(() => r(url, body, init.headers)), gone]);
    },
  };
  const jobs = new Set<Job>(cfg.jobs ?? ['chat', 'audit', 'audio', 'voice', 'extra', 'rerank']);
  setJobResolver((_d, job) => {
    if (!jobs.has(job)) return null;
    return {
      baseUrl: LOCAL, model: 'local-model', location: 'local', providerId: 'p1', ...cfg.main,
      allowCloudFallback: cfg.allowCloud,
      fallback: { baseUrl: CLOUD, model: 'cloud-model', apiKey: 'sk-cloud', location: 'cloud', providerId: 'p2', ...cfg.fb },
    };
  });
  return { d, calls, hosts: () => calls.map((c) => (c.url.startsWith(LOCAL) ? 'local' : 'cloud')) };
}
afterEach(() => setJobResolver(null));

// ---- which failures fall back ----

for (const [label, reply] of [
  ['a 500', () => err(500, 'boom')],
  ['a 502', () => err(502, 'bad gateway')],
  ['a 503 while the model loads', () => err(503, 'model is loading')],
  ['a model that is not found (404)', () => err(404, 'model "local-model" not found')],
  ['an unloaded model told as a 400 (LM Studio)', () => err(400, 'No models loaded. Please load a model in the developer page.')],
  ['no connection', () => { throw new TypeError('fetch failed'); }],
] as [string, Reply][]) {
  test(`AIFallback_FallsBackOn_${label.replace(/\W+/g, '_')}`, async () => {
    const f = setup(reply, () => ok('from the fallback'), { allowCloud: true, main: { location: 'local' }, fb: { location: 'local', baseUrl: 'https://argos2.lan/v1' } });
    // The fallback host is anything not LOCAL.
    const r = await chat(f.d, 'chat', { messages: msgs });
    assert.equal(r.content, 'from the fallback');
    assert.deepEqual(f.hosts(), ['local', 'cloud'], 'main tried first, the fallback once');
    assert.equal(f.calls[1].body.model, 'cloud-model');
  });
}

test('AIFallback_FallsBackOnTimeout', async () => {
  const hang: Reply = (_u, _b, _h) => new Promise<Response>(() => { /* never answers; the guard aborts */ });
  const f = setup(async (u, b, h) => { await new Promise((r) => setTimeout(r, 200)); return hang(u, b, h); }, () => ok('late but here'), { allowCloud: true, main: { options: { timeoutMs: 40 }, location: 'local' }, fb: { location: 'local', baseUrl: 'https://argos2.lan/v1' } });
  const r = await chat(f.d, 'chat', { messages: msgs });
  assert.equal(r.content, 'late but here');
  assert.deepEqual(f.hosts(), ['local', 'cloud']);
});

for (const status of [400, 401, 403, 422]) {
  test(`AIFallback_NeverFallsBackOn_${status}`, async () => {
    const f = setup(() => err(status, 'the request itself is wrong: messages must be an array'), () => ok('should not be called'), { allowCloud: true });
    await assert.rejects(chat(f.d, 'chat', { messages: msgs }), (e: any) => e instanceof ModelUnavailable && e.status === status);
    assert.deepEqual(f.hosts().filter((h) => h === 'cloud'), [], 'the fallback was never asked');
  });
}

test('AIFallback_OnlyOnceAndTheFallbackErrorSurfaces', async () => {
  const f = setup(() => err(500, 'main down'), () => err(500, 'fallback down too'), { allowCloud: true });
  await assert.rejects(chat(f.d, 'chat', { messages: msgs }), /fallback down too/);
  assert.equal(f.calls.length, 2, 'one try on each, no more');
});

test('AIFallback_CanFallBackRules', () => {
  assert.equal(canFallBack(new ModelUnavailable('chat', 'x', 500)), true);
  assert.equal(canFallBack(new ModelUnavailable('chat', 'x')), true);
  assert.equal(canFallBack(new ModelUnavailable('chat', 'x', 400)), false);
  assert.equal(canFallBack(new ModelUnavailable('chat', 'x', 429)), false);
  assert.equal(canFallBack(new ClassifiedRefused('chat')), false);
  assert.equal(canFallBack(new DOMException('Aborted', 'AbortError')), false);
  assert.equal(canFallBack(new Error('a bug')), false);
});

test('AIFallback_AllJobsFallBack', async () => {
  const wavBytes = new Uint8Array([1, 2, 3]);
  const f = setup(() => err(503, 'loading'), (u) => {
    if (u.endsWith('/embeddings')) return json({ data: [{ embedding: [1, 0] }] });
    if (u.endsWith('/audio/speech')) return new Response(new Uint8Array([9, 9]), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    if (u.endsWith('/audio/transcriptions')) return json({ text: 'heard it', segments: [] });
    if (u.endsWith('/rerank')) return json({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] });
    return ok('chat fallback');
  }, { allowCloud: true });
  assert.deepEqual(await embed(f.d, ['a']), [[1, 0]]);
  assert.equal((await speak(f.d, 'hello')).audio.length, 2);
  assert.equal((await transcribe(f.d, wavBytes, 'audio/wav')).text, 'heard it');
  assert.deepEqual((await rerank(f.d, 'q', ['a', 'b'])).map((h) => h.index), [1, 0]);
  assert.equal((await chat(f.d, 'audit', { messages: msgs })).content, 'chat fallback');
});

// ---- streaming ----

const sseOf = (parts: string[]) => new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;

test('AIFallback_StreamFallsBackBeforeAnyText', async () => {
  const f = setup(() => err(503, 'loading'), () => sseOf([chunk('Hello '), chunk('there'), 'data: [DONE]\n\n']), { allowCloud: true });
  const got: string[] = [];
  const r = await chatStream(f.d, 'chat', { messages: msgs }, (t) => got.push(t));
  assert.equal(r.content, 'Hello there');
  assert.deepEqual(got.join(''), 'Hello there');
  assert.deepEqual(f.hosts(), ['local', 'cloud']);
});

test('AIFallback_StreamNeverRestartsAfterTextWasShown', async () => {
  const broken = () => {
    let n = 0;
    return new Response(new ReadableStream({ pull(c) { if (n++ === 0) c.enqueue(new TextEncoder().encode(chunk('Half an '))); else throw new Error('connection reset'); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const f = setup(broken, () => ok('should not be used'), { allowCloud: true });
  const got: string[] = [];
  await assert.rejects(chatStream(f.d, 'chat', { messages: msgs }, (t) => got.push(t)), ModelUnavailable);
  assert.deepEqual(got, ['Half an ']);
  assert.deepEqual(f.hosts(), ['local'], 'the fallback must not start a second answer on top of the first');
});

// ---- local to cloud ----

test('AIFallback_LocalToCloudNeedsTheSwitch', async () => {
  const off = setup(() => err(500, 'down'), () => ok('cloud answer'), { allowCloud: false });
  assert.equal(chainFor(off.d, 'chat').length, 1, 'no cloud step in the chain');
  await assert.rejects(chat(off.d, 'chat', { messages: msgs }), /500/);
  assert.deepEqual(off.hosts(), ['local'], 'world text did not leave for the cloud');

  const on = setup(() => err(500, 'down'), () => ok('cloud answer'), { allowCloud: true });
  assert.equal(chainFor(on.d, 'chat').length, 2);
  assert.equal((await chat(on.d, 'chat', { messages: msgs })).content, 'cloud answer');
  assert.equal(on.calls[1].headers.Authorization, 'Bearer sk-cloud');
});

test('AIFallback_SwitchIsOnlyNeededForLocalToCloud', async () => {
  // cloud to cloud, local to local and cloud to local all work without it.
  for (const [main, fb] of [['cloud', 'cloud'], ['local', 'local'], ['cloud', 'local']] as const) {
    const f = setup(() => err(500, 'down'), () => ok('second'), { allowCloud: false, main: { location: main, baseUrl: LOCAL }, fb: { location: fb } });
    assert.equal(chainFor(f.d, 'chat').length, 2, `${main} to ${fb}`);
  }
});

test('AIFallback_LocationIsGuessedFromTheUrlWhenUnset', () => {
  assert.equal(inferLocation('http://127.0.0.1:8080/v1'), 'local');
  assert.equal(inferLocation('http://192.168.1.50:8080/v1'), 'local');
  assert.equal(inferLocation('http://argos:8080/v1'), 'local');
  assert.equal(inferLocation('http://host.docker.internal:8080/v1'), 'local');
  assert.equal(inferLocation('http://box.tailnet.ts.net/v1'), 'local');
  assert.equal(inferLocation('https://api.openai.com/v1'), 'cloud');
  assert.equal(inferLocation('https://models.example.com/v1'), 'cloud');
  const f = setup(() => err(500, 'down'), () => ok('x'), { allowCloud: false, main: { location: undefined }, fb: { location: undefined } });
  assert.equal(chainFor(f.d, 'chat').length, 1, 'argos.lan to api.openai.com is local to cloud');
});

test('AIFallback_PinnedUsesOnlyThatProvider', async () => {
  const f = setup(() => ok('main'), () => ok('fallback'), { allowCloud: true });
  assert.equal((await chat(pinned(f.d, 'fallback'), 'chat', { messages: msgs })).content, 'fallback');
  assert.deepEqual(f.hosts(), ['cloud']);
  f.calls.length = 0;
  setJobResolver(() => ({ baseUrl: LOCAL, model: 'm', location: 'local', fallback: undefined }));
  assert.equal(chainFor(pinned(f.d, 'fallback'), 'chat').length, 0);
});

// ---- the classified guard on the fallback path ----

const SECRET = 'The sealed vault beneath the old lighthouse opens only for the bearer of the moonlit brass key';
const library = (grams: Set<string>) => ({ classifiedGrams: () => Object.assign(grams, { whereIs: () => 'w1|secret/vault.md' }) });

test('AIFallback_ClassifiedTextIsRefusedAndNeverFallsBack', async () => {
  const f = setup(() => err(500, 'down'), () => ok('cloud answer'), { allowCloud: true, library: library(levelWords(SECRET)) });
  await assert.rejects(chat(f.d, 'chat', { messages: [{ role: 'user', content: `Summarise: ${SECRET}.` }] }), (e: any) => e instanceof ClassifiedRefused);
  assert.equal(f.calls.length, 0, 'neither the main provider nor the fallback was called');
  // A refusal is not an outage: it must not be retried elsewhere even if it looks like one.
  assert.equal(canFallBack(new ClassifiedRefused('chat')), false);
});

test('AIFallback_FallbackAttemptIsScreenedAgain', async () => {
  // The classified index changes while the main provider is failing (a page was just classified):
  // the fallback attempt must see the new index and refuse.
  const grams = new Set<string>();
  const f = setup(() => { for (const g of levelWords(SECRET)) grams.add(g); return err(500, 'down'); }, () => ok('leaked'), { allowCloud: true, library: library(grams) });
  await assert.rejects(chat(f.d, 'chat', { messages: [{ role: 'user', content: `Tell me: ${SECRET}.` }] }), (e: any) => e instanceof ClassifiedRefused);
  assert.deepEqual(f.hosts(), ['local'], 'only the main provider was called; the fallback was refused before sending');
});

test('AIFallback_EmbedAndRerankFallbackAreScreenedToo', async () => {
  const f = setup(() => err(500, 'down'), () => json({ data: [{ embedding: [1] }], results: [{ index: 0, relevance_score: 1 }] }), { allowCloud: true, library: library(levelWords(SECRET)) });
  await assert.rejects(embed(f.d, ['fine', SECRET]), ClassifiedRefused);
  await assert.rejects(rerank(f.d, 'q', ['fine', SECRET]), ClassifiedRefused);
  assert.equal(f.calls.length, 0);
});

// ---- rerank ----

const docs = ['A cat naps on the windowsill.', 'The dragon sleeps under the mountain.', 'Ships dock at the harbour.'];

test('AIRerank_ReordersWithinTheBudget', async () => {
  const f = setup((_u, body) => json({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.1 }].slice(0, body.top_n) }), () => err(500, 'unused'));
  const out = await rerankItems(f.d, 'harbour', docs, (x) => x, { budgetMs: 300 });
  assert.deepEqual(out, [docs[2], docs[0], docs[1]]);
  assert.equal(f.calls[0].url, `${LOCAL}/rerank`);
  assert.deepEqual(Object.keys(f.calls[0].body).sort(), ['documents', 'model', 'query', 'top_n']);
  assert.equal(f.calls[0].body.model, 'local-model');
  assert.equal(f.calls[0].body.top_n, 3);
  assert.deepEqual(f.calls[0].body.documents, docs);
});

test('AIRerank_SlowRerankerLeavesTheKeywordOrder', async () => {
  const f = setup(() => new Promise<Response>((r) => setTimeout(() => r(json({ results: [{ index: 2, relevance_score: 1 }] })), 400)), () => err(500, 'unused'), { allowCloud: false });
  const t0 = Date.now();
  const out = await rerankItems(f.d, 'harbour', docs, (x) => x, { budgetMs: 60 });
  assert.deepEqual(out, docs, 'the keyword order stands');
  assert.ok(Date.now() - t0 < 300, `gave up at the budget, took ${Date.now() - t0} ms`);
});

test('AIRerank_FailureAndNoJobLeaveTheOrder', async () => {
  const bad = setup(() => err(400, 'bad'), () => err(500, 'x'));
  assert.deepEqual(await rerankItems(bad.d, 'q', docs, (x) => x), docs);
  const none = setup(() => ok(), () => ok(), { jobs: ['chat'] });
  assert.deepEqual(await rerankItems(none.d, 'q', docs, (x) => x), docs);
  assert.equal(none.calls.length, 0);
  const junk = setup(() => json({ results: [{ index: 99, relevance_score: 1 }, { nope: true }] }), () => err(500, 'x'));
  assert.deepEqual(await rerankItems(junk.d, 'q', docs, (x) => x), docs);
});

test('AIRerank_FallsBackInsideTheBudget', async () => {
  const f = setup(() => err(503, 'loading'), () => json({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }, { index: 2, relevance_score: 0.1 }] }), { allowCloud: true });
  const out = await rerankItems(f.d, 'dragon', docs, (x) => x, { budgetMs: 300 });
  assert.equal(out[0], docs[1]);
  assert.deepEqual(f.hosts(), ['local', 'cloud']);
});

test('AIRerank_KeepsHitsTheModelDidNotReturnAndTheTail', async () => {
  const many = Array.from({ length: 25 }, (_, i) => `doc ${i}`);
  const f = setup((_u, body) => json({ results: [{ index: 4, relevance_score: 0.9 }, { index: 1, relevance_score: 0.5 }] }), () => err(500, 'x'));
  const out = await rerankItems(f.d, 'q', many, (x) => x);
  assert.equal(f.calls[0].body.documents.length, 20, 'only the top 20 are sent');
  assert.deepEqual(out.slice(0, 4), ['doc 4', 'doc 1', 'doc 0', 'doc 2']);
  assert.equal(out.length, 25);
  assert.deepEqual(out.slice(20), many.slice(20));
});

test('AIRerank_ClassifiedDocumentIsRefusedAndOrderStands', async () => {
  const f = setup(() => json({ results: [{ index: 1, relevance_score: 1 }] }), () => err(500, 'x'), { library: library(levelWords(SECRET)) });
  const items = ['harmless line', `leaky ${SECRET}`];
  assert.deepEqual(await rerankItems(f.d, 'q', items, (x) => x), items);
  assert.equal(f.calls.length, 0, 'nothing was sent');
});
