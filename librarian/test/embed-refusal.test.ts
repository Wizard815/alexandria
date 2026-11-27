// The classified guard and the background embedding job: a page the guard
// refuses is not sent again every tick, a bare URL in the GM copy and the same
// URL as a link in the AI copy is not "classified text", scopes are read in
// turn, progress is reported, and the fake embeddings make related pages.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one } from '../src/core/db.ts';
import { ClassifiedIndex } from '../src/core/library.ts';
import { levelWords } from '../src/core/levels.ts';
import { syncEmbeddings, embeddingCoverage } from '../src/features/search/embeddings.ts';
import { forgetRefusals } from '../src/features/search/copies.ts';
import { fakeEmbedding } from '../scripts/fake-models.ts';

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

let embedCalls = 0;
const fake = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.startsWith('http://fake.test/v1/embeddings')) {
    const body = JSON.parse(init.body);
    embedCalls++;
    return new Response(JSON.stringify({ data: body.input.map((t: string, i: number) => ({ index: i, embedding: fakeEmbedding(t) })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

async function boot() {
  const made = createApp({ noScheduler: true, fetch: fake, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_MODEL_EXTRA_URL: 'http://fake.test/v1', ALX_MODEL_EXTRA_MODEL: 'fake-embed' } });
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
    return r.body;
  };
  const world = (await ok('POST', '/api/admin/worlds', { name: 'Saltreach', gmAccountId: a.account.id })).id as string;
  const put = (path: string, visibility: 'party' | 'gm', markdown: string) => ok('PUT', `/api/worlds/${world}/library/pages`, { path, visibility, markdown });
  return { ...made, call, ok, world, put, tok };
}

const FOOTER = '_This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode._';

test('TestEmbeddings_BareUrlInTheGmCopyIsNotClassifiedText', async () => {
  const h = await boot();
  await h.put('Generated/Monsters/Giant Spider', 'gm', `# Giant Spider\n\n## Concept\n\nLarge beast, CR 2.\n\n> [!secret] Tactics\n> Uses the terrain: attacks from cover and breaks off if hurt.\n\n**Saving throws** str +6, dex +5  \n**Skills** Perception +5, Stealth +7  \n\n${FOOTER}\n`);
  assert.equal(h.deps.library.classifiedGrams().size, 0, 'nothing here is classified');
  // A real classified passage is still found.
  await h.put('Vault/Code', 'gm', '# Vault\n\n> [!classified] The code\n> The vault under the old lighthouse opens only for bearers of three silver keys.\n');
  const idx = h.deps.library.classifiedGrams();
  assert.ok(idx.size > 0, 'a classified callout is indexed');
  assert.ok([...idx].some((g) => g.includes('silver keys') || g.includes('three silver')), 'its words are in the index');
  assert.ok(![...idx].some((g) => g.includes('dndbeyond')), 'a license footer is not');
});

test('TestEmbeddings_RefusedPageIsNotSentAgainEveryTick', async () => {
  forgetRefusals();
  const h = await boot();
  const bad = 'The keeper of the drowned bell whispers a long rhyme about the tide and the moon over the harbour wall';
  await h.put('Notes/Poison', 'gm', `# Poison\n\n${bad}.\n`);
  for (const n of ['Alpha', 'Beta', 'Gamma']) await h.put(`Notes/${n}`, 'gm', `# ${n}\n\nPlain words about ${n} and the market square at dawn.\n`);
  // The guard's index says the first words of that page are classified.
  const idx = new ClassifiedIndex();
  idx.put([...levelWords(bad)][0]!, `${h.world}|pg_poison`);
  (h.deps.library as any).classifiedGrams = () => idx;
  const refusals = () => one<any>(h.deps.db, `SELECT COUNT(*) AS n FROM audit WHERE action = 'ai.classified_refused'`)!.n as number;

  const first = await syncEmbeddings(h.deps, { worldId: h.world });
  assert.equal(first.refused, 1, 'one page was refused');
  assert.equal(refusals(), 1);
  assert.equal(first.pages, 3, 'the others were embedded');
  for (let i = 0; i < 4; i++) await syncEmbeddings(h.deps, { worldId: h.world });
  assert.equal(refusals(), 1, 'not asked again on every tick');
  const last = await syncEmbeddings(h.deps, { worldId: h.world });
  assert.equal(last.remaining, false, 'a refused page is not an endless backlog');
  const cov = embeddingCoverage(h.deps, h.world);
  assert.equal(cov.progress.refused, 1);
  // Editing the page makes it fresh again.
  await h.put('Notes/Poison', 'gm', '# Poison\n\nA different text about nothing in particular, the lamp and the harbour.\n');
  const after = await syncEmbeddings(h.deps, { worldId: h.world });
  assert.equal(after.pages, 1);
  assert.equal(refusals(), 1);
});

test('TestEmbeddings_ScopesAreReadInTurnAndProgressIsReported', async () => {
  forgetRefusals();
  const h = await boot();
  for (let i = 0; i < 6; i++) await h.put(`Notes/GM ${i}`, 'gm', `# GM ${i}\n\nSomething only the GM knows about thing number ${i}.\n`);
  await h.put('Open/Party Page', 'party', '# Party Page\n\nEveryone may read this page about the harbour.\n');
  const before = embeddingCoverage(h.deps, h.world);
  assert.equal(before.progress.indexed, 0);
  assert.ok(before.progress.pending >= 7);
  assert.equal(before.progress.etaSeconds, null, 'no pace known yet');
  // Four pages: the party copy and the GM copy take turns, so the GM's pages do not wait for the whole party backlog.
  const r = await syncEmbeddings(h.deps, { worldId: h.world, maxPages: 4 });
  assert.equal(r.pages, 4);
  const cov = embeddingCoverage(h.deps, h.world);
  assert.ok(cov.scopes.gm.indexed >= 3, 'the GM copy has its turn in the same round');
  assert.ok(cov.scopes.party.indexed === 1, 'the party copy is not starved either');
  assert.ok(cov.scopes.gm.pending > 0 && cov.progress.pending > 0);
  assert.equal(cov.progress.indexed, cov.progress.eligible - cov.progress.pending);
  await syncEmbeddings(h.deps, { worldId: h.world, maxPages: 50 });
  const done = embeddingCoverage(h.deps, h.world);
  assert.equal(done.progress.pending, 0);
  assert.equal(done.progress.etaSeconds, null);
  assert.ok(done.progress.perMinute === null || done.progress.perMinute > 0);
  assert.ok(embedCalls > 0);
});

test('TestEmbeddings_RelatedPagesComeBackOnceBothAreIndexed', async () => {
  forgetRefusals();
  const h = await boot();
  const a = await h.put('Places/Lighthouse', 'party', '# The Lighthouse\n\nThe lighthouse keeper darkened the lamp at night, and the ships on the reef lost their way.\n');
  const b = await h.put('Notes/Keeper', 'party', '# The Keeper\n\nWho paid the lighthouse keeper to darken the lamp? The keeper will not say.\n');
  const c = await h.put('Places/Market', 'party', '# Market\n\nBakers sell warm bread, cheese and apples on the cobbled square every morning.\n');
  const rel = async (id: string) => (await h.ok('GET', `/api/worlds/${h.world}/library/pages/${id}/related`)).related as { id: string; percent: number }[];
  assert.deepEqual(await rel(a.id), [], 'nothing before they are read');
  await syncEmbeddings(h.deps, { worldId: h.world });
  const hits = await rel(a.id);
  assert.ok(hits.some((x) => x.id === b.id && x.percent >= 25), `the keeper page is related: ${JSON.stringify(hits)}`);
  assert.ok(!hits.some((x) => x.id === c.id), 'the market is not');
  void all;
});
