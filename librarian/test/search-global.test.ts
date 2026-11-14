// Global search (every kind, visibility per kind), the search_world MCP
// tool, and hybrid semantic search with a fake embeddings model.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { run, all, one } from '../src/core/db.ts';
import { allTools } from '../src/routes/mcpServer.ts';
import { chunkText, pruneChunks, rrf, syncEmbeddings, hybridPages } from '../src/features/search/embeddings.ts';
import { globalSearch } from '../src/features/search/global.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
let W = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let embedCalls: string[][] = [];
let embedDown = false;

// A tiny fake embeddings model: each word adds to the axis of its topic.
const TOPICS = [['cat', 'kitten', 'feline', 'whiskers', 'purr'], ['ship', 'boat', 'sail', 'harbor', 'harbour'], ['gold', 'coin', 'treasure', 'money'], ['poison', 'venom', 'nightshade', 'toxin'], ['moon', 'night', 'midnight']];
const vec = (s: string) => {
  const v = TOPICS.map(() => 0);
  for (const w of s.toLowerCase().match(/[a-z]+/g) ?? []) TOPICS.forEach((t, i) => { if (t.includes(w)) v[i] += 1; });
  v.push(0.01); // never an all-zero vector
  return v;
};
const fakeFetch: typeof fetch = async (input: any, init?: any) => {
  const url = String(input);
  if (!url.startsWith('http://fake/')) return fetch(input, init);
  if (embedDown) throw new Error('embeddings down');
  assert.ok(url.endsWith('/embeddings'), url);
  const inputs: string[] = JSON.parse(init.body).input;
  embedCalls.push(inputs);
  return new Response(JSON.stringify({ data: inputs.map((t, index) => ({ index, embedding: vec(t) })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

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
const S = (q: string, tok: string, extra = '') => ok('GET', `/api/worlds/${W}/search?q=${encodeURIComponent(q)}${extra}`, tok).then((b) => b.results as any[]);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-search-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_MODEL_EXTRA_URL: 'http://fake/v1', ALX_MODEL_EXTRA_MODEL: 'fake-embed' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Searchland', dmAccountId: ID.dm })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jessamine' });
  T.jess = j.token; ID.jess = j.account.id;
  const inv2 = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  const j2 = await ok('POST', '/api/join', undefined, { code: inv2.code, username: 'bo', password: 'player pass 123', characterName: 'Bo' });
  T.bo = j2.token; ID.bo = j2.account.id;

  const put = (p: string, visibility: string, markdown: string) => ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: p, visibility, markdown });
  await put('places/Saltmarsh', 'party', '# Saltmarsh\nA fishing town with a lighthouse.\n\n> [!secret] DM\n> The mayor poisons the wells with nightshade.\n');
  await put('dm/Crown', 'dm', '# Crown\nThe lighthouse hides a cursed crown called Gloomcrest.\n');
  await put('lore/Lighthouse', 'party', '# Lighthouse\nA tall tower. Visit the lighthouse at night.\n');
  await put('lore/Whiskers', 'party', '# Whiskers\nA friendly kitten who purrs by the harbour.\n\n> [!secret]\n> The kitten is a spy for the Zaxxar guild.\n');
  await put('dm/Cat plot', 'dm', '# Feline plan\nThe cat Zaxxar steals gold from the temple.\n');

  // People
  const alder = await ok('POST', `/api/worlds/${W}/people`, T.dm, { name: 'Captain Lighthouse Aldous', role: 'harbor master', visibility: 'party', met: 'Day 2' });
  await ok('POST', `/api/worlds/${W}/people/${alder.id}/quotes`, T.dm, { text: 'Never sail past the old lighthouse after dark', visibility: 'party' });
  await ok('POST', `/api/worlds/${W}/people/${alder.id}/quotes`, T.dm, { text: 'I secretly serve the Gloomcrest cult', visibility: 'dm' });
  await ok('POST', `/api/worlds/${W}/people`, T.dm, { name: 'Vexmoor the Spy', role: 'secret agent of Gloomcrest', visibility: 'dm' });

  // Transcript
  run(deps.db, "INSERT INTO audio_sessions (id, world_id, name, started_at, stopped_at) VALUES ('as1', ?, 'Table', '2026-01-01T18:00:00.000Z', NULL)", W);
  const line = (n: number, text: string, audience: string) => run(deps.db, 'INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_label, text, audience, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', `l${n}`, 'as1', W, n * 10000, n * 10000 + 5000, 'Narrator', text, audience, '2026-01-01T18:00:00.000Z');
  line(1, 'We climbed the lighthouse stairs together', 'players');
  line(2, 'The lighthouse keeper is really the Gloomcrest vampire', 'dm');

  // Session log: one published, one unpublished
  const entry = (id: string, n: number, title: string, summary: string, unpub: string | null) => run(deps.db, `INSERT INTO sessionlog_entries (id, world_id, number, title, summary, session_at, world_from_minutes, world_to_minutes, published_at, unpublished_at) VALUES (?, ?, ?, ?, ?, '2026-01-01', 0, 10, '2026-01-02', ?)`, id, W, n, title, summary, unpub);
  entry('sle1', 1, 'The lighthouse', 'The party visited the lighthouse and met the keeper.', null);
  entry('sle2', 2, 'Retracted', 'A lighthouse draft with the secret Gloomcrest plot.', '2026-01-03');

  // Items: party stash, Jess's, Bo's (hidden from Jess), with a DM note
  const item = (id: string, owner: string, name: string, note: string, dmNote: string, status = 'approved') => run(deps.db, `INSERT INTO items (id, world_id, owner, name, qty, note, dm_note, updated_at, updated_by, status) VALUES (?, ?, ?, ?, 1, ?, ?, '2026-01-01', ?, ?)`, id, W, owner, name, note, dmNote, ID.dm, status);
  item('it1', 'party', 'Lighthouse lamp', 'Bright lamp from the tower', 'Cursed by Gloomcrest');
  item('it2', ID.jess, 'Lighthouse key', 'Opens the tower door', '');
  item('it3', ID.bo, 'Lighthouse map', 'Bo private map', '');
  item('it4', ID.jess, 'Plain rope', 'Strong rope', 'Secretly a Gloomcrest relic');
  item('it5', ID.jess, 'Lighthouse charm', 'pending one', '', 'pending');
});
after(async () => { server?.close(); server?.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

const kindsOf = (r: any[]) => [...new Set(r.map((x) => x.kind))].sort();

test('TestGlobalSearch_CoversEveryKindForTheDM', async () => {
  const dm = await S('lighthouse', T.dm, '&semantic=0');
  assert.deepEqual(kindsOf(dm), ['item', 'log', 'page', 'person', 'term', 'transcript']);
  for (const h of dm) for (const k of ['kind', 'title', 'snippet', 'link', 'score']) assert.ok(k in h, `${k} in ${JSON.stringify(h)}`);
  assert.ok(dm.every((h) => typeof h.score === 'number' && h.link));
  // Sorted by score.
  for (let i = 1; i < dm.length; i++) assert.ok(dm[i - 1].score >= dm[i].score);
  // A game rule term (the built-in module).
  const rule = await S('grappled', T.dm, '&semantic=0');
  assert.ok(rule.some((h) => h.kind === 'term'), JSON.stringify(rule.map((r) => r.kind)));
  // The DM finds DM-only text of every kind.
  const g = await S('gloomcrest', T.dm, '&semantic=0');
  assert.deepEqual(kindsOf(g), ['item', 'log', 'page', 'person', 'transcript']);
  // kinds filter, aliases and a bad kind.
  assert.deepEqual(kindsOf(await S('lighthouse', T.dm, '&kinds=item,log&semantic=0')), ['item', 'log']);
  assert.deepEqual(kindsOf(await S('lighthouse', T.dm, '&kinds=people&semantic=0')), ['person']);
  assert.equal((await call('GET', `/api/worlds/${W}/search?q=x&kinds=bogus`, T.dm)).status, 400);
  assert.deepEqual(await S('', T.dm), []);
  assert.equal((await call('GET', `/api/worlds/${W}/search?q=lighthouse`)).status, 401);
});

test('TestGlobalSearch_RanksExactNamesFirst', async () => {
  const r = await S('lighthouse', T.dm, '&semantic=0');
  assert.equal(r[0].title, 'Lighthouse', 'the exact page title comes first');
  assert.equal(r[0].kind, 'page');
  const fz = await S('Lighthose', T.dm, '&semantic=0');
  assert.ok(fz.some((h) => h.kind === 'page' && h.title === 'Lighthouse'), 'typos find pages');
  assert.ok((await S('lighthouse -aldous', T.dm, '&kinds=person&semantic=0')).length === 0);
  assert.ok((await S('"old lighthouse"', T.dm, '&kinds=person&semantic=0')).length === 1);
});

test('TestGlobalSearch_PlayersOnlySeeWhatTheyMay', async () => {
  const jess = await S('lighthouse', T.jess, '&semantic=0');
  assert.deepEqual(kindsOf(jess), ['item', 'log', 'page', 'person', 'term', 'transcript']);
  const titles = (k: string) => jess.filter((h) => h.kind === k).map((h) => h.title).sort();
  assert.deepEqual(titles('page'), ['Lighthouse', 'Saltmarsh'], 'shared pages only (the DM page that mentions the lighthouse is not there)');
  assert.deepEqual(titles('item'), ['Lighthouse key', 'Lighthouse lamp'], "own and party items, not Bo's and not pending");
  assert.deepEqual(titles('log'), ['Session 1: The lighthouse'], 'published entries only');
  assert.equal(jess.filter((h) => h.kind === 'transcript').length, 1, "players' lines only");
  assert.deepEqual(titles('person'), ['Captain Lighthouse Aldous']);
  // Bo sees his own item instead.
  assert.ok((await S('lighthouse map', T.bo, '&kinds=item&semantic=0')).some((h) => h.title === 'Lighthouse map'));
  assert.ok(!(await S('lighthouse map', T.jess, '&kinds=item&semantic=0')).some((h) => h.title === 'Lighthouse map'));

  // Nothing DM-only is found, by any route: DM page, secret block, DM line, DM quote, DM person, DM note, unpublished entry.
  for (const q of ['gloomcrest', 'Gloomcrest', 'Gloomcres', 'Gloomcrst', 'vampire', 'Vexmoor', 'nightshade', 'poisons', 'Zaxxar', 'cursed crown', 'secretly serve', 'secret agent', 'Retracted', 'Cat plot', 'Feline plan', 'relic', 'Bo private']) {
    for (const tok of [T.jess]) {
      const r = await S(q, tok, '&semantic=0&kinds=page,person,transcript,log,item'); // rules are public SRD text
      assert.deepEqual(r.filter((h) => !['Lighthouse lamp'].includes(h.title) || h.kind !== 'item'), [], `player must not find "${q}": ${JSON.stringify(r.map((h) => [h.kind, h.title]))}`);
    }
  }
  // Snippets of what they do see never carry DM text.
  const dump = JSON.stringify(await S('lighthouse tower keeper secret', T.jess, '&semantic=0'));
  for (const bad of ['Gloomcrest', 'vampire', 'nightshade', 'Zaxxar', 'Cursed by', 'secretly']) assert.ok(!dump.includes(bad), `${bad} leaked: ${dump}`);
  // Typos and exclusions are no side channel either.
  assert.deepEqual(await S('Gloomcrst', T.jess, '&semantic=0&kinds=page,person,transcript,log,item'), []);
  assert.deepEqual((await S('lighthouse -gloomcrest', T.jess, '&semantic=0')).map((h) => h.id), (await S('lighthouse', T.jess, '&semantic=0')).map((h) => h.id));
  // The library endpoint agrees.
  const lib = await ok('GET', `/api/worlds/${W}/library/search?q=gloomcrest`, T.jess);
  assert.deepEqual(lib, []);
  const libDm = await ok('GET', `/api/worlds/${W}/library/search?q=gloomcrest`, T.dm);
  assert.ok(libDm.length >= 1 && 'snippet' in libDm[0] && 'path' in libDm[0] && 'id' in libDm[0] && 'title' in libDm[0]);
});

test('TestGlobalSearch_McpToolSearchesTheWorld', async () => {
  const tool = allTools().find((t) => t.name === 'search_world');
  assert.ok(tool && !tool.write);
  const req = tool.call({ query: 'lighthouse', kinds: 'page,item', limit: 5 });
  assert.equal(req.method, 'GET');
  assert.ok(req.path.startsWith('/search?q=lighthouse') && req.path.includes('kinds=page%2Citem'));
  const r = await ok('GET', `/api/worlds/${W}${req.path}&semantic=0`, T.jess);
  assert.ok(r.results.length && r.results.every((h: any) => ['page', 'item'].includes(h.kind)));
});

test('TestGlobalSearch_DefensiveWhenFeatureTablesAreMissing', async () => {
  run(deps.db, 'ALTER TABLE audio_lines RENAME TO audio_lines_gone');
  run(deps.db, 'ALTER TABLE sessionlog_entries RENAME TO sessionlog_entries_gone');
  try {
    const r = await S('lighthouse', T.jess, '&semantic=0');
    assert.ok(r.length && !r.some((h) => h.kind === 'transcript' || h.kind === 'log'));
  } finally {
    run(deps.db, 'ALTER TABLE audio_lines_gone RENAME TO audio_lines');
    run(deps.db, 'ALTER TABLE sessionlog_entries_gone RENAME TO sessionlog_entries');
  }
});

// ---- hybrid -------------------------------------------------------------------

test('TestHybrid_ChunkingAndFusion', () => {
  const para = 'word '.repeat(60).trim();
  const chunks = chunkText(`${para}\n\n${para}\n\nshort one\n\n${'x'.repeat(1300)}`);
  assert.ok(chunks.length >= 4);
  assert.ok(chunks.every((c) => c.length <= 520 && c.length > 0), chunks.map((c) => c.length).join());
  assert.ok(chunks.every((c) => c.trim() === c));
  const f = rrf([['a', 'b', 'c'], ['c', 'a', 'd']]);
  assert.ok(f.get('a')! > f.get('b')!);
  assert.ok(f.get('c')! > f.get('d')!);
  assert.ok(f.get('a')! > f.get('c')!, 'a is first and third; c third and first: a edges it on rank order');
  assert.ok([...f.keys()].length === 4);
});

test('TestHybrid_EmbedsInTheBackgroundAndMergesWithKeywordSearch', async () => {
  embedCalls = [];
  const r1 = await syncEmbeddings(deps, { maxPages: 100 });
  assert.equal(r1.error, undefined);
  assert.ok(r1.embedded > 0 && r1.pages >= 5, JSON.stringify(r1));
  // Idempotent: nothing stale the second time.
  embedCalls = [];
  assert.equal((await syncEmbeddings(deps)).embedded, 0);
  assert.equal(embedCalls.length, 0);

  // Player and DM copies are kept apart; DM text is never in the party index.
  const party = all<any>(deps.db, `SELECT text FROM search_chunks WHERE scope = 'party'`).map((r) => r.text).join('\n');
  const dmChunks = all<any>(deps.db, `SELECT text FROM search_chunks WHERE scope = 'dm'`).map((r) => r.text).join('\n');
  for (const bad of ['Zaxxar', 'nightshade', 'Gloomcrest', 'Feline plan']) assert.ok(!party.includes(bad), `${bad} in the party index`);
  for (const must of ['Zaxxar', 'nightshade', 'Gloomcrest']) assert.ok(dmChunks.includes(must), `${must} missing from the DM index`);
  assert.equal(all(deps.db, `SELECT 1 FROM search_chunks WHERE scope = 'party' AND page_id IN (SELECT id FROM pages WHERE visibility = 'dm')`).length, 0);

  // "feline" appears in no player-visible page; the kitten page is found by meaning.
  const kw = await S('feline', T.jess, '&semantic=0&kinds=page');
  assert.deepEqual(kw, []);
  const hy = await S('feline', T.jess, '&kinds=page');
  assert.deepEqual(hy.map((h) => h.title), ['Whiskers'], JSON.stringify(hy));
  // The DM's semantic results include the DM-only page; the player's never do.
  const dmHy = await S('feline', T.dm, '&kinds=page');
  assert.ok(dmHy.some((h) => h.title === 'Cat plot' || h.title === 'Whiskers'));
  assert.ok(!JSON.stringify(hy).includes('Zaxxar') && !JSON.stringify(hy).includes('Cat plot'));
  assert.ok(hy[0].snippet && hy[0].snippetHtml && !hy[0].snippetHtml.includes('<script'));

  // Exact keyword matches stay first in the merged list.
  const both = await hybridPages(deps, W, 'lighthouse', 'party', 10);
  assert.equal(both[0].title, 'Lighthouse');
  // library endpoint with semantic=1 returns the same page-shaped rows
  const lib = await ok('GET', `/api/worlds/${W}/library/search?q=feline&semantic=1`, T.jess);
  assert.deepEqual(lib.map((h: any) => h.title), ['Whiskers']);

  // Changes are picked up: edit a page, hide a page.
  embedCalls = [];
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'lore/Whiskers', visibility: 'party', markdown: '# Whiskers\nNow a ship cat who loves gold coins.\n' });
  const r2 = await syncEmbeddings(deps);
  assert.ok(r2.pages >= 1 && embedCalls.length >= 1);
  assert.deepEqual((await S('treasure', T.jess, '&kinds=page')).map((h) => h.title), ['Whiskers']);
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'lore/Whiskers', visibility: 'dm', markdown: '# Whiskers\nNow a ship cat who loves gold coins.\n' });
  await syncEmbeddings(deps);
  assert.deepEqual(await S('treasure', T.jess, '&kinds=page'), [], 'a page that is no longer shared leaves the party index');
  assert.equal(one<any>(deps.db, `SELECT count(*) AS n FROM search_chunks sc JOIN pages p ON p.id = sc.page_id WHERE sc.scope = 'party' AND p.title = 'Whiskers'`)!.n, 0);
  // Deleted pages are pruned.
  const pid = one<any>(deps.db, `SELECT id FROM pages WHERE title = 'Lighthouse'`)!.id;
  deps.library.remove(W, pid);
  pruneChunks(deps.db);
  assert.equal(one<any>(deps.db, 'SELECT count(*) AS n FROM search_chunks WHERE page_id = ?', pid)!.n, 0);
});

test('TestHybrid_FallsBackToKeywordWhenTheModelIsDown', async () => {
  embedDown = true;
  try {
    const r = await S('saltmarsh', T.jess, '&kinds=page');
    assert.ok(r.some((h) => h.title === 'Saltmarsh'));
    deps.library.save(W, { path: 'lore/New thing', title: 'New thing', body: 'A fresh page.', visibility: 'party' }, null);
    const sync = await syncEmbeddings(deps);
    assert.ok(sync.error && sync.remaining, 'a model that is down is reported and retried later');
  } finally { embedDown = false; }
});

test('TestHybrid_NoEmbeddingsModelMeansKeywordOnly', async () => {
  const { deps: d2 } = createApp({ noScheduler: true, env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  run(d2.db, `INSERT INTO worlds (id, slug, name, created_at) VALUES ('w9', 'nine', 'Nine', '2025-01-01')`);
  d2.library.save('w9', { path: 'a', title: 'Alpha', body: 'beta gamma', visibility: 'party' }, null);
  assert.deepEqual((await syncEmbeddings(d2)).embedded, 0);
  assert.equal((await globalSearch(d2, 'w9', { accountId: 'x', role: 'player' }, 'beta'))[0].title, 'Alpha');
  assert.equal((await hybridPages(d2, 'w9', 'beta', 'party', 5))[0].title, 'Alpha');
});
