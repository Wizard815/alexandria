// Semantic scopes (dm, broker, party, lifted), related pages and the story
// bible: who reads what, and that every permission change deletes what it
// makes wrong at once. Fake embeddings (topic vectors) and a fake chat model
// that reads "FACT: subject | kind | text" lines out of the page it is given.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';
import { allTools } from '../src/routes/mcpServer.ts';
import { hybridPages, syncEmbeddings, semanticPages } from '../src/features/search/embeddings.ts';
import { relatedPages } from '../src/features/search/related.ts';
import { assembleBible } from '../src/features/bible/assemble.ts';
import { normSubject, syncBible } from '../src/features/bible/extract.ts';
import type { Viewer } from '../src/core/policy.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
let W = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const PG: Record<string, string> = {};
const sent: string[] = [];
let embedDown = false;
let chatDown = false;

const TOPICS = [['cat', 'kitten', 'feline', 'whiskers', 'purr'], ['ship', 'boat', 'sail', 'harbor', 'harbour'], ['gold', 'coin', 'treasure', 'money'], ['poison', 'venom', 'nightshade', 'toxin'], ['moon', 'night', 'midnight']];
const vec = (s: string) => {
  const v = TOPICS.map(() => 0);
  for (const w of s.toLowerCase().match(/[a-z]+/g) ?? []) TOPICS.forEach((t, i) => { if (t.includes(w)) v[i] += 1; });
  v.push(0.01);
  return v;
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const fakeFetch: typeof fetch = async (input: any, init?: any) => {
  const url = String(input);
  if (!url.startsWith('http://fake/')) return fetch(input, init);
  sent.push(String(init?.body ?? ''));
  if (url.endsWith('/embeddings')) {
    if (embedDown) throw new Error('embeddings down');
    const inputs: string[] = JSON.parse(init.body).input;
    return json({ data: inputs.map((t, index) => ({ index, embedding: vec(t) })) });
  }
  if (url.endsWith('/chat/completions')) {
    if (chatDown) return json({ error: { message: 'down' } }, 503);
    const b = JSON.parse(init.body);
    const u = String(b.messages[b.messages.length - 1].content);
    const title = /^Page: (.*)$/m.exec(u)?.[1] ?? 'Page';
    const facts = u.split('\n').map((l) => l.replace(/^[>\s]+/, '')).filter((l) => l.startsWith('FACT:')).map((l) => {
      const [subject, kind, fact] = l.slice(5).split('|').map((x) => x.trim());
      return { subject, kind, fact };
    });
    const other = u.split('\n').slice(1).map((l) => l.trim()).filter((l) => l.length > 12 && !l.startsWith('FACT:')).slice(0, 2).map((fact) => ({ subject: title, kind: 'lore', fact }));
    return json({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ facts: [...facts, ...other] }) } }] });
  }
  return json({ error: 'not found' }, 404);
};

async function call(method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, text };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${r.text}`);
  return r.body;
};
const viewer = (who: 'dm' | 'jess' | 'tom' | 'guest' | 'broker' | 'ai'): Viewer =>
  who === 'broker' ? { accountId: ID.dm, role: 'dm', audience: 'broker' } : who === 'ai' ? { accountId: ID.dm, role: 'dm', audience: 'ai' } : { accountId: ID[who], role: who === 'dm' ? 'dm' : who === 'guest' ? 'guest' : 'player' };
const put = (p: string, visibility: string, markdown: string) => ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: p, visibility, markdown }).then((r) => { PG[p] = r.id; return r; });
const index = async () => { await syncEmbeddings(deps, { maxPages: 500 }); return syncBible(deps, { maxPages: 500 }); };
const rows = (sql: string, ...a: unknown[]) => all<any>(deps.db, sql, ...a);
const count = (pageId: string, scope?: string) => Number(one<any>(deps.db, `SELECT (SELECT count(*) FROM search_chunks WHERE page_id = ? ${scope ? 'AND scope = ?' : ''}) + (SELECT count(*) FROM bible_facts WHERE page_id = ? ${scope ? 'AND scope = ?' : ''}) AS n`, ...(scope ? [pageId, scope, pageId, scope] : [pageId, pageId]))!.n);
const bible = (who: Parameters<typeof viewer>[0], f: Parameters<typeof assembleBible>[3] = {}) => assembleBible(deps, W, viewer(who), f);
const bibleText = (b: any) => JSON.stringify(b);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-memory-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch, env: {
    ALX_ADMIN_TABLE_LOGIN: '1', ALX_MODEL_EXTRA_URL: 'http://fake/v1', ALX_MODEL_EXTRA_MODEL: 'fake-embed', ALX_MODEL_CHAT_URL: 'http://fake/v1', ALX_MODEL_CHAT_MODEL: 'fake-chat', ALX_RELATED_MIN_SIM: '0.3',
  } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Memoryland', dmAccountId: ID.dm })).id;
  for (const [name, role] of [['jess', 'player'], ['tom', 'player'], ['visitor', 'guest']] as const) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name });
    const k = name === 'visitor' ? 'guest' : name;
    T[k] = j.token; ID[k] = j.account.id;
  }
  await put('lore/Whiskers', 'party', '# Whiskers\nA friendly kitten who purrs by the harbour.\nFACT: Whiskers | person | Whiskers is a kitten who lives at the harbour.\n\n> [!secret] DM\n> The kitten is a feline spy for the Zaxxar guild.\n> FACT: Zaxxar | faction | Zaxxar is a secret guild of cat spies.\n');
  await put('lore/Harbour', 'party', '# Harbour\nShips and boats sail in and out of the harbour all day.\nFACT: The Harbour | place | The harbour is ruled by seven captains.\n');
  await put('lore/Harbour Cats', 'party', '# Harbour Cats\nKittens and cats purr on every boat in the harbour.\nFACT: harbour | place | Cats ride the boats in the harbour.\n');
  await put('dm/Cat plot', 'dm', '# Feline plan\nThe cat Zaxxar steals gold from the temple.\nFACT: Zaxxar | faction | Zaxxar steals gold from the temple.\n');
  await put('dm/Poison', 'dm', '# Poison cellar\nNightshade toxin and venom are kept below the tavern.\nFACT: Poison cellar | place | The cellar holds nightshade toxin.\n');
  await put('broker/Fog charts', 'broker', '# Fog charts\nThe broker sells sail charts of the harbour for gold coin.\nFACT: Fog charts | item | The broker sells fog charts.\n');
  await put('dm/Vault', 'classified', '# Vault\nThe midnight moon treasure vault holds CLASSIFIEDVAULTWORDS under the old tower.\nFACT: Vault | place | The vault holds CLASSIFIEDVAULTWORDS.\n');
  await index();
});
after(async () => { server?.close(); server?.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---- scopes -----------------------------------------------------------------------

test('TestMemory_ChunksAreCutPerScopeAndNeverFromAbove', () => {
  const text = (scope: string) => rows(`SELECT text FROM search_chunks WHERE scope = ?`, scope).map((r) => r.text).join('\n');
  // dm: the AI copy. party: the player copy. broker: party + broker.
  assert.ok(text('dm').includes('Zaxxar') && text('dm').includes('Nightshade'));
  assert.ok(!text('party').includes('Zaxxar') && !text('party').includes('Nightshade') && !text('party').includes('Fog charts'));
  assert.ok(text('broker').includes('sail charts') && !text('broker').includes('Zaxxar') && !text('broker').includes('Nightshade'));
  assert.ok(text('party').includes('Whiskers'));
  assert.equal(rows(`SELECT 1 FROM search_chunks WHERE scope = 'lifted'`).length, 0, 'nothing is lifted until a page is shared or a key sees it');
});

test('TestMemory_ClassifiedIsNeverEmbeddedOrExtractedOrSent', () => {
  assert.equal(count(PG['dm/Vault']), 0);
  assert.ok(!sent.some((b) => b.includes('CLASSIFIEDVAULTWORDS')), 'no model request carried classified text');
  assert.ok(!rows('SELECT text FROM search_chunks').some((r) => r.text.includes('CLASSIFIEDVAULTWORDS')));
  assert.ok(!rows('SELECT fact FROM bible_facts').some((r) => r.fact.includes('CLASSIFIEDVAULTWORDS')));
});

test('TestMemory_SemanticSearchIsFilteredByViewer', async () => {
  const ids = async (q: string, who: Parameters<typeof viewer>[0]) => (await semanticPages(deps, W, 'party', q, 20, viewer(who))).map((h) => h.id);
  // "feline spy" lives in the DM copy only: a DM and a model find it, a player does not.
  assert.ok((await ids('feline', 'dm')).includes(PG['dm/Cat plot']));
  assert.ok((await ids('feline', 'ai')).includes(PG['dm/Cat plot']));
  assert.ok(!(await ids('feline', 'jess')).includes(PG['dm/Cat plot']));
  assert.ok((await ids('feline', 'jess')).includes(PG['lore/Whiskers']));
  // The broker copy: broker page yes, DM-only page no.
  assert.ok((await ids('sail gold', 'broker')).includes(PG['broker/Fog charts']));
  assert.ok(!(await ids('feline', 'broker')).includes(PG['dm/Cat plot']));
  // Players never read the broker or DM pages; guests read party only.
  for (const who of ['jess', 'tom', 'guest'] as const) { const got = await ids('sail gold', who); assert.ok(!got.includes(PG['broker/Fog charts']), who); }
  const hy = await hybridPages(deps, W, 'toxin', 'party', 10, viewer('jess'));
  assert.deepEqual(hy.map((h) => h.id), []);
});

test('TestMemory_LiftedPagesAreForTheAccountThatMaySeeThem', async () => {
  await ok('POST', `/api/worlds/${W}/library/pages/${PG['dm/Poison']}/share`, T.dm, { to: [ID.jess] });
  const r = await index();
  assert.equal(r.skipped, undefined);
  assert.ok(count(PG['dm/Poison'], 'lifted') > 0, 'the shared page is embedded in the lifted scope');
  assert.equal(count(PG['dm/Poison'], 'party'), 0);
  const ids = async (who: Parameters<typeof viewer>[0]) => (await semanticPages(deps, W, 'party', 'toxin', 20, viewer(who))).map((h) => h.id);
  assert.ok((await ids('jess')).includes(PG['dm/Poison']), 'jess finds the page shared with her by meaning');
  assert.ok(!(await ids('tom')).includes(PG['dm/Poison']), 'tom does not');
  assert.ok(!(await ids('guest')).includes(PG['dm/Poison']), 'a guest does not');
  // Her related pages and bible include it; tom\'s do not.
  const jessBible = bibleText(await bible('jess'));
  assert.ok(jessBible.includes('nightshade toxin'));
  assert.ok(!bibleText(await bible('tom')).includes('nightshade'));
  // A lifted page's own text still never carries what the page keeps from players (its secret blocks).
  assert.ok(!jessBible.includes('Zaxxar'));
});

// ---- related pages --------------------------------------------------------------------

test('TestMemory_RelatedPagesComeFromTheViewersOwnScope', async () => {
  const jess = relatedPages(deps, W, viewer('jess'), PG['lore/Whiskers'], 8);
  assert.equal(jess.indexed, true);
  assert.ok(jess.related.length >= 1 && jess.related.every((r) => r.percent >= 0 && r.percent <= 100));
  assert.ok(jess.related.some((r) => r.id === PG['lore/Harbour Cats']));
  const jt = JSON.stringify(jess);
  for (const bad of ['Zaxxar', 'Cat plot', 'Feline plan', 'Nightshade', 'Fog charts']) assert.ok(!jt.includes(bad), `${bad} in a player's related pages`);
  // Sorted by percent, with a reason that is a passage of the related page.
  for (let i = 1; i < jess.related.length; i++) assert.ok(jess.related[i - 1].percent >= jess.related[i].percent);
  assert.ok(jess.related.every((r) => r.reason.length > 0 && r.matchedWith.length > 0));
  // The DM's copy has more: the DM-only cat page is related and its text may be quoted to the DM.
  const dm = relatedPages(deps, W, viewer('dm'), PG['lore/Whiskers'], 20);
  assert.ok(dm.related.some((r) => r.id === PG['dm/Cat plot']));
  assert.ok(JSON.stringify(dm).includes('Zaxxar'));
  // A page the viewer cannot open is a 404, never a list.
  assert.throws(() => relatedPages(deps, W, viewer('tom'), PG['dm/Cat plot']), /not found/i);
  assert.throws(() => relatedPages(deps, W, viewer('tom'), PG['dm/Poison']), /not found/i);
  // Over HTTP, with the limit.
  const http = await ok('GET', `/api/worlds/${W}/library/pages/${PG['lore/Whiskers']}/related?limit=1`, T.jess);
  assert.equal(http.related.length, 1);
  assert.equal((await call('GET', `/api/worlds/${W}/library/pages/${PG['dm/Cat plot']}/related`, T.tom)).status, 404);
  // The tool exists and players get it.
  const tool = allTools().find((t: any) => t.name === 'related_pages');
  assert.ok(tool && !tool.dmOnly && !tool.write);
});

test('TestMemory_RelatedForALiftedPageIsOnlyForItsReaders', async () => {
  const jess = relatedPages(deps, W, viewer('jess'), PG['dm/Poison'], 8);
  assert.equal(jess.indexed, true);
  assert.ok(!JSON.stringify(jess).includes('Zaxxar'));
  assert.throws(() => relatedPages(deps, W, viewer('tom'), PG['dm/Poison']), /not found/i);
});

// ---- story bible ---------------------------------------------------------------------

test('TestMemory_BibleIsPerViewerGroupedAndCited', async () => {
  const dm = await bible('dm');
  const jess = await bible('jess');
  const tom = await bible('tom');
  const broker = await bible('broker');
  assert.equal(dm.scope, 'dm');
  assert.equal(jess.scope, 'party');
  assert.equal(broker.scope, 'broker');
  // The DM bible has the DM-only guild, players do not; the DM bible does not hold classified facts.
  assert.ok(bibleText(dm).includes('Zaxxar steals gold'));
  assert.ok(!bibleText(jess).includes('Zaxxar') && !bibleText(tom).includes('Zaxxar'));
  assert.ok(!bibleText(dm).includes('CLASSIFIEDVAULTWORDS'));
  // The broker bible has the broker page, not DM-only text.
  assert.ok(bibleText(broker).includes('fog charts') && !bibleText(broker).includes('Zaxxar'));
  // Duplicate subjects merge ("The Harbour" and "harbour"), each fact cites its page.
  const harbour = tom.subjects.filter((s) => s.key === normSubject('Harbour'));
  assert.equal(harbour.length, 1);
  assert.ok(harbour[0].facts.some((f) => f.text.includes('seven captains')) && harbour[0].facts.some((f) => f.text.includes('Cats ride the boats')));
  for (const f of harbour[0].facts) assert.ok(f.pages.length >= 1 && f.pages[0].id && f.pages[0].title);
  assert.ok(harbour[0].facts.some((f) => f.pages.some((p) => p.id === PG['lore/Harbour'])));
  // Filters: kind, subject, q.
  assert.ok((await bible('tom', { kind: 'place' })).subjects.every((s) => s.facts.every((f) => f.kind === 'place')));
  assert.equal((await bible('tom', { subject: 'whiskers' })).subjects[0].subject, 'Whiskers');
  const q = await bible('tom', { q: 'captains' });
  assert.deepEqual(q.subjects.map((s) => s.key), [normSubject('Harbour')]);
  // By meaning, with the embeddings model: "feline" finds the kitten facts of a player's own bible.
  assert.ok(bibleText(await bible('tom', { q: 'feline' })).includes('kitten'));
  // Over HTTP and the tool.
  const http = await ok('GET', `/api/worlds/${W}/bible?subject=zaxxar`, T.jess);
  assert.deepEqual(http.subjects, []);
  assert.ok((await ok('GET', `/api/worlds/${W}/bible?subject=zaxxar`, T.dm)).subjects.length === 1);
  const tool = allTools().find((t: any) => t.name === 'story_bible');
  assert.ok(tool && !tool.dmOnly);
});

test('TestMemory_BibleIsIncrementalAndBudgeted', async () => {
  const before = sent.length;
  const r = await syncBible(deps, { maxPages: 50 });
  assert.equal(r.pages, 0);
  assert.equal(sent.length, before, 'nothing changed, so no model is asked');
  await put('lore/Tower', 'party', '# Tower\nA tall tower.\nFACT: Old Tower | place | The tower leans.\n');
  const r2 = await syncBible(deps, { maxPages: 1 });
  assert.equal(r2.pages, 1, 'the budget is respected');
  assert.ok((await bible('tom', { subject: 'old tower' })).subjects.length === 1);
});

// ---- permission changes delete at once -----------------------------------------------------

test('TestMemory_UnsharingDeletesTheLiftedRowsAtOnce', async () => {
  assert.ok(count(PG['dm/Poison'], 'lifted') > 0);
  await ok('DELETE', `/api/worlds/${W}/library/pages/${PG['dm/Poison']}/share`, T.dm);
  assert.equal(count(PG['dm/Poison'], 'lifted'), 0, 'rows are gone before anything reads them');
  assert.ok(!bibleText(await bible('jess')).includes('nightshade'));
  assert.ok(!(await semanticPages(deps, W, 'party', 'toxin', 20, viewer('jess'))).some((h) => h.id === PG['dm/Poison']));
  assert.throws(() => relatedPages(deps, W, viewer('jess'), PG['dm/Poison']), /not found/i);
  // Back in the DM's own scope the page is still there.
  assert.ok(count(PG['dm/Poison'], 'dm') > 0);
});

test('TestMemory_ALevelChangeDeletesPartyRowsAtOnce', async () => {
  await put('lore/Lamp', 'party', '# Lamp\nA boat lamp that burns at midnight.\nFACT: The Lamp | item | The lamp burns at midnight.\n');
  await index();
  assert.ok(count(PG['lore/Lamp'], 'party') > 0);
  await ok('PUT', `/api/worlds/${W}/library/pages/${PG['lore/Lamp']}/level`, T.dm, { level: 'dm' });
  assert.equal(count(PG['lore/Lamp'], 'party'), 0, 'setLevel');
  assert.ok(!bibleText(await bible('tom')).includes('lamp burns'));
  await index();
  assert.equal(count(PG['lore/Lamp'], 'party'), 0, 'and it stays out of the party scope when embedded again');
  assert.ok(count(PG['lore/Lamp'], 'dm') > 0);
  // Moving text into a secret block takes the old party text away at once, before it is read again.
  await put('lore/Ledger', 'party', '# Ledger\nThe ledger of the harbour boats.\nFACT: Ledger | item | The ledger lists boats.\n');
  await index();
  assert.ok(rows(`SELECT text FROM search_chunks WHERE page_id = ? AND scope = 'party'`, PG['lore/Ledger']).some((r) => r.text.includes('ledger of the harbour')));
  await put('lore/Ledger', 'party', '# Ledger\n> [!secret] DM\n> The ledger of the harbour boats.\nFACT: Ledger | item | The ledger lists boats.\n');
  assert.equal(count(PG['lore/Ledger'], 'party'), 0, 'a saved page drops the old party rows until it is read again');
});

test('TestMemory_PageHiddenAtTheSourceLosesItsRowsAtOnce', async () => {
  const src = await ok('POST', `/api/admin/worlds/${W}/sources`, T.admin, { kind: 'push', name: 'Tool', config: {}, defaultVisibility: 'party' });
  const key = (await ok('POST', `/api/worlds/${W}/intake/sources/${src.id}/keys`, T.dm, { label: 'k' })).key;
  const push = (visibility: string) => ok('POST', `/api/intake/${src.id}/entries`, key, { entries: [{ externalId: 'e1', title: 'Gatehouse', visibility, type: 'page', blocks: [{ kind: 'paragraph', content: [{ text: 'FACT: Gatehouse | place | The gatehouse guards the harbour boats.' }] }] }] });
  await push('party');
  await index();
  const pid = one<any>(deps.db, `SELECT id FROM pages WHERE external_id = 'e1'`)!.id;
  assert.ok(count(pid, 'party') > 0);
  await push('dm');
  assert.equal(count(pid, 'party'), 0, 'hidden at the source: gone at once');
  assert.ok(!bibleText(await bible('jess')).includes('gatehouse'));
  // A source that stops sending the page removes every row.
  await index();
  assert.ok(count(pid, 'dm') > 0);
  d_removeMissing(src.id);
  assert.equal(count(pid), 0);
  // Changing a source's audience to dm takes its party pages away at once.
  await push('party');
  await index();
  const pid2 = one<any>(deps.db, `SELECT id FROM pages WHERE source_id = ? AND external_id = 'e1'`, src.id)!.id;
  assert.ok(count(pid2, 'party') > 0);
  run(deps.db, `UPDATE sources SET audience = 'dm' WHERE id = ?`, src.id);
  deps.library.applyAudience(W, src.id);
  assert.equal(count(pid2, 'party'), 0, 'source audience change');
});
function d_removeMissing(sourceId: string) { deps.library.removeMissing(W, sourceId, new Set()); }

test('TestMemory_StaleRowsAreIgnoredAtQueryTime', async () => {
  // A row that somehow survives (written behind the purge's back) for a page the viewer cannot open is never returned.
  const pid = PG['dm/Cat plot'];
  const v = new Uint8Array(new Float32Array(vec('feline kitten')).buffer);
  run(deps.db, `INSERT INTO search_chunks (world_id, page_id, scope, idx, text, vec) VALUES (?, ?, 'party', 0, 'STALEPARTYROW feline kitten', ?)`, W, pid, v);
  run(deps.db, `INSERT INTO search_chunk_state (page_id, scope, world_id, updated_at, sig, model, hash) VALUES (?, 'party', ?, 'x', 0, 'fake-embed|lv1', NULL)`, pid, W);
  run(deps.db, `INSERT INTO bible_facts (world_id, page_id, scope, subject, subject_norm, kind, fact, idx) VALUES (?, ?, 'party', 'Stale', 'stale', 'lore', 'STALEFACT', 0)`, W, pid);
  const got = await semanticPages(deps, W, 'party', 'feline kitten', 20, viewer('tom'));
  assert.ok(!got.some((h) => h.id === pid) && !JSON.stringify(got).includes('STALEPARTYROW'));
  assert.ok(!bibleText(await bible('tom')).includes('STALEFACT'));
  assert.ok(!JSON.stringify(relatedPages(deps, W, viewer('tom'), PG['lore/Whiskers'], 20)).includes('STALEPARTYROW'));
  deps.library.changed(W, [pid]);
  assert.equal(count(pid, 'party'), 0, 'and the next permission pass deletes them');
});

// ---- models missing or down -----------------------------------------------------------------

test('TestMemory_ModelUnavailableFallsBackQuietly', async () => {
  chatDown = true;
  await put('lore/Cellar', 'party', '# Cellar\nA cold cellar.\nFACT: Cellar | place | The cellar is cold.\n');
  const r = await syncBible(deps, { maxPages: 20 });
  assert.equal(r.pages, 0);
  assert.ok(r.skipped, 'skipped quietly');
  assert.ok(!bibleText(await bible('tom', { subject: 'cellar' })).includes('cold'), 'no facts yet, no error');
  chatDown = false;
  embedDown = true;
  // Search falls back to the keyword hits; the bible still answers; related pages come from stored vectors.
  const hy = await hybridPages(deps, W, 'harbour', 'party', 10, viewer('tom'));
  assert.ok(hy.length > 0);
  assert.ok((await bible('tom', { q: 'captains' })).subjects.length === 1);
  const sync = await syncEmbeddings(deps, { maxPages: 5 });
  assert.ok(sync.error, 'the embedding job reports it and stops');
  embedDown = false;
  assert.equal((await syncBible(deps, { maxPages: 20 })).skipped, undefined);
  assert.ok(bibleText(await bible('tom', { subject: 'cellar' })).includes('cold'), 'picked up when the model is back');
  await syncEmbeddings(deps, { maxPages: 50 });
});

// ---- admin ------------------------------------------------------------------------------------

test('TestMemory_AdminSeesCoverageAndCanReembedAWorld', async () => {
  const cov = await ok('GET', '/api/admin/embeddings', T.admin);
  assert.equal(cov.configured, true);
  const w = cov.worlds.find((x: any) => x.id === W);
  for (const s of ['dm', 'broker', 'party', 'lifted']) assert.ok(w.embeddings.scopes[s] && w.bible.scopes[s], s);
  assert.ok(w.embeddings.scopes.party.chunks > 0 && w.bible.scopes.party.facts > 0);
  assert.equal((await call('GET', '/api/admin/embeddings', T.dm)).status >= 400, true, 'not for a DM');
  const re = await ok('POST', `/api/admin/embeddings/${W}/reembed`, T.admin);
  assert.equal(re.embeddings.chunks, 0);
  assert.equal(rows('SELECT 1 FROM bible_facts WHERE world_id = ?', W).length, 0);
  await ok('POST', `/api/admin/embeddings/${W}/run`, T.admin);
  assert.ok((await ok('GET', '/api/admin/embeddings', T.admin)).worlds.find((x: any) => x.id === W).embeddings.chunks > 0);
  // The DM's own re-embed and the player's refusal.
  assert.equal((await call('POST', `/api/worlds/${W}/search/reembed`, T.jess)).status >= 400, true);
  assert.equal((await call('POST', `/api/worlds/${W}/bible/rebuild`, T.jess)).status >= 400, true);
  assert.equal((await call('POST', `/api/worlds/${W}/bible/refresh`, T.tom)).status >= 400, true);
  assert.ok((await ok('POST', `/api/worlds/${W}/bible/refresh`, T.dm)).pages >= 0);
});
