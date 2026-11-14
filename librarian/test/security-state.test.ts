// What is stored, not just what is served (docs/SECURITY.md): classified text
// lives only in the DM columns of a page and its DM search index; no other
// table, index or file holds it. And when a page's level changes, every copy,
// index and file follows at once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.ts';
import { all, one } from '../src/core/db.ts';
import { baseOf, client, leaksFor, mark, markers, recordMounts, tok, type Marker } from './security-kit.ts';
import { makeAccounts, seedContent, type Seed } from './security-world.ts';

recordMounts();

let server: any;
let tmp = '';
let dataDir = '';
let deps: any;
let S: Seed;
const http = client(() => baseOf(server));
const { call } = http;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-secstate-'));
  dataDir = path.join(tmp, 'data');
  const made = createApp({ noScheduler: true, dataDir, vaultsDir: path.join(tmp, 'vaults'), env: { ALX_RATE_LIMIT: '0' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const h = { ...http, deps };
  S = await makeAccounts(h);
  await seedContent(h, S);
});

after(() => {
  server?.close();
  server?.closeAllConnections?.();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const classified = (): Marker[] => Object.values(markers).filter((m) => !m.ai);
/** What an index would hold for a token: the middle word of ZQX-NAME-run (a full token is split on the dashes). */
const probe = (m: Marker) => (m.re ? null : m.token.split('-')[1].toLowerCase());
const asText = (v: unknown): string => (typeof v === 'string' ? v : v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v === null || v === undefined ? '' : String(v));

function tablesOf(): string[] { return all<any>(deps.db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name); }

test('TestSecurityState_ClassifiedTextLivesOnlyInPagesAndTheDmIndex', () => {
  const probes = classified().map((m) => ({ m, p: probe(m)! }));
  assert.ok(probes.length >= 10);
  const found: string[] = [];
  for (const t of tablesOf()) {
    // A page's DM columns and the DM search index (and the internals of it) are where it may be.
    if (t === 'pages' || /^fts_dm/.test(t)) continue;
    let rows: any[];
    try { rows = all<any>(deps.db, `SELECT * FROM "${t}"`); } catch { continue; }
    for (const row of rows) {
      const hay = Object.values(row).map(asText).join('\n').toLowerCase();
      for (const { m, p } of probes) if (hay.includes(p)) found.push(`table ${t} holds "${m.id}"`);
    }
  }
  // In pages: only the plain (DM) columns.
  const pageRows = all<any>(deps.db, 'SELECT * FROM pages');
  assert.ok(pageRows.length > 15);
  for (const row of pageRows) {
    for (const [col, v] of Object.entries(row)) {
      const h = asText(v).toLowerCase();
      const aiOrPlayer = /^(player|broker|ai)_/.test(col);
      for (const { m, p } of probes) if (aiOrPlayer && h.includes(p)) found.push(`pages.${col} of ${row.path} holds "${m.id}"`);
      if (/^player_/.test(col) && !row.path.startsWith('w2/')) for (const x of Object.values(markers)) if (!x.seen.includes('jess') && !x.re && h.includes(x.token.toLowerCase())) found.push(`pages.${col} of ${row.path} holds "${x.id}"`);
    }
  }
  // The search indexes of players, the broker and models.
  for (const t of ['fts_party', 'fts_broker', 'fts_ai']) {
    for (const { m, p } of probes) {
      const n = one<any>(deps.db, `SELECT count(*) AS n FROM ${t} WHERE ${t} MATCH ?`, `"${p}"`)!.n;
      if (n) found.push(`${t} finds "${m.id}"`);
    }
  }
  // The DM index does have it: the check above can find things.
  assert.ok(one<any>(deps.db, 'SELECT count(*) AS n FROM fts_dm WHERE fts_dm MATCH ?', `"${probes[0].p}"`)!.n > 0, 'the DM index holds classified pages');
  assert.deepEqual(found, []);
});

test('TestSecurityState_FilesOnDiskFollowTheSameRules', () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(f); } };
  walk(dataDir);
  assert.ok(files.some((f) => f.includes(`${path.sep}vault${path.sep}`)));
  const bad: string[] = [];
  for (const f of files) {
    const text = fs.readFileSync(f).toString('latin1').toLowerCase();
    const sub = f.slice(dataDir.length + 1).split(path.sep);
    const area = sub[2]; // worlds/<slug>/<area>/...
    const playerFacing = area === 'party' || area === '_api';
    for (const m of Object.values(markers)) {
      if (m.re || !text.includes(m.token.toLowerCase())) continue;
      if (area === 'vault' && sub[0] === 'worlds') continue; // the DM's own Markdown vault
      if (m.id === 'w2_public' && sub[1] === 'elsewhere') continue; // that world's own players
      if (!m.ai || (playerFacing && !m.seen.includes('jess')) || !playerFacing) bad.push(`${f.slice(dataDir.length)} holds "${m.id}"`);
    }
  }
  assert.deepEqual(bad, []);
});

const W = () => `/api/worlds/${S.W}`;
const asJess = (u: string) => call('GET', `${W()}${u}`, S.T.jess);
const level = (id: string, l: string) => call('PUT', `${W()}/library/pages/${id}/level`, S.T.dm, { level: l });

test('TestSecurityState_UnsharingAPageTakesItBackEverywhere', async () => {
  const pg = S.pages.shared;
  const m = tok('public_page');
  assert.ok((await asJess(`/library/pages/${pg.id}`)).text.includes(m));
  assert.ok(fs.existsSync(path.join(dataDir, 'worlds', 'harbourtown', 'party', pg.path)) || all<any>(deps.db, 'SELECT slug FROM worlds').length);
  const slug = one<any>(deps.db, 'SELECT slug FROM worlds WHERE id = ?', S.W)!.slug;
  const partyFile = path.join(dataDir, 'worlds', slug, 'party', pg.path);
  const apiFile = path.join(dataDir, 'worlds', slug, '_api', pg.path.replace(/\.md$/, '.json'));
  assert.ok(fs.existsSync(partyFile) && fs.existsSync(apiFile));
  // The page had been embedded for players: a stale chunk of its player copy must not be served once it is DM-only.
  deps.db.prepare("INSERT INTO search_chunks (world_id, page_id, scope, idx, text, vec) VALUES (?, ?, 'party', 0, ?, ?)").run(S.W, pg.id, `The captains meet ${m}`, new Uint8Array(new Float32Array([0.5, 0.5, 0.5]).buffer));
  assert.equal((await level(pg.id, 'dm')).status, 200);
  const sem = await asJess('/library/search?q=captains&semantic=1');
  assert.ok(!sem.text.includes(m), 'a stale player chunk is not served');
  assert.ok(!(await asJess('/search?q=captains+council&kinds=page&semantic=1')).text.includes(m));
  assert.equal((await asJess(`/library/pages/${pg.id}`)).status, 404);
  assert.ok(!(await asJess(`/library/search?q=captains`)).text.includes(m));
  assert.ok(!(await asJess(`/search?q=captains&kinds=page`)).text.includes(m));
  assert.ok(!(await asJess('/library/pages')).text.includes(pg.id));
  assert.ok(!fs.existsSync(partyFile) && !fs.existsSync(apiFile), 'the player files are gone');
  assert.equal(one<any>(deps.db, 'SELECT count(*) AS n FROM fts_party WHERE fts_party MATCH ?', `"${m.split('-')[1].toLowerCase()}"`)!.n, 0);
  // Put it back: players see it again.
  assert.equal((await level(pg.id, 'party')).status, 200);
  assert.ok((await asJess(`/library/pages/${pg.id}`)).text.includes(m));
  assert.deepEqual(leaksFor('jess', (await asJess(`/library/pages/${pg.id}`)).text).map((x) => x.id), []);
});

test('TestSecurityState_AWithdrawnPageDisappearsFromCardsAndLinks', async () => {
  // A page is shared, used (on the stage, on an item card, in a person), then taken back: nothing keeps showing it.
  const text = mark('lc_docks', ['dm', 'jess', 'tom'], 'a page that is shared and then withdrawn');
  const pg = await call('PUT', `${W()}/library/pages`, S.T.dm, { path: 'lifecycle/Docks.md', visibility: 'party', body: `# Docks\nThe docks smell of tar. ${text}\n`, frontmatter: { title: 'Docks' } });
  const id = pg.json.id;
  const item = (await call('POST', `${W()}/inventory`, S.T.dm, { owner: S.ID.jess, name: 'Dock Pass', qty: 1, reason: 'given' })).json;
  const link = await call('PUT', `${W()}/itemcards/${item.id}/page`, S.T.dm, { pageId: id });
  assert.ok(link.status < 300, link.text);
  const card = await call('POST', `${W()}/stage/cards`, S.T.dm, { kind: 'place', ref: id, title: 'The docks', show: true });
  assert.ok(card.status < 300, card.text);
  const person = await call('POST', `${W()}/people`, S.T.dm, { name: 'Dockhand', visibility: 'party', pageId: id });
  assert.ok(person.status < 300, person.text);
  const seen = async () => (await Promise.all([asJess(`/itemcards/${item.id}`), asJess('/stage'), asJess('/people'), asJess(`/library/pages/${id}`), asJess('/library/pages')])).map((r) => r.text).join('\n');
  assert.ok((await seen()).includes(text), 'while shared, players see it');
  assert.equal((await level(id, 'dm')).status, 200);
  const after = await seen();
  assert.deepEqual(leaksFor('jess', after).map((m) => m.id), [], 'the withdrawn page is gone from every card');
  assert.ok(!after.includes(text) && !after.includes('The docks smell of tar'));
  // A card made with a page players cannot open is refused outright.
  const again = await call('POST', `${W()}/stage/cards`, S.T.dm, { kind: 'place', ref: id, title: 'The docks', show: true });
  assert.equal(again.status, 409);
});

test('TestSecurityState_BrokerLevelAnswersWaitForTheDm', async () => {
  // A broker-level page can be sold, but not before the DM has read the answer.
  const q = 'Who sells fog charts to the harbour council?';
  await call('PATCH', `${W()}/settings`, S.T.dm, { brokerEnabled: true });
  const quote = await call('POST', `${W()}/broker/quote`, S.T.jess, { question: q, length: 'full' });
  assert.equal(quote.status, 200, quote.text);
  const ask = await call('POST', `${W()}/broker/ask`, S.T.jess, { quoteId: quote.json.quoteId });
  assert.ok(ask.status < 300, `${ask.status} ${ask.text.slice(0, 300)}`);
  const id = ask.json.id;
  const row = all<any>(deps.db, 'SELECT status, needs_review, broker_level, answer, tier FROM broker_requests WHERE id = ?', id)[0];
  assert.ok(row.answer && row.answer.includes(tok('broker_page')) && row.needs_review === 1 && row.broker_level === 1, `the answer is stored for review: ${JSON.stringify({ ...row, answer: String(row.answer).slice(0, 80) })}`);
  const text = tok('broker_page');
  const mine = async () => (await call('GET', `${W()}/broker`, S.T.jess)).text;
  const gets = [ask.text, await mine(), (await call('GET', `${W()}/broker/${id}`, S.T.jess)).text];
  const dmView = await call('GET', `${W()}/broker`, S.T.dm);
  assert.ok(dmView.text.includes(id), 'the DM sees the request');
  // While it waits, the answer is not in anything the player can read, however long it takes.
  for (const g of gets) assert.ok(!g.includes(text), 'a broker-level answer is held for the DM');
  for (const t of ['jess']) assert.deepEqual(leaksFor(t as any, gets.join('')).map((m) => m.id), []);
});

test('TestSecurityState_SculptingForPlayersNeverUsesDmPages', async () => {
  const dm = (m: string, u: string, b?: unknown) => call(m, `${W()}${u}`, S.T.dm, b);
  const templates = (await dm('GET', '/sculpt/templates')).json.templates;
  const scene = templates.find((t: any) => t.perspective === 'player');
  assert.ok(scene, 'a player-perspective template');
  for (const location of [S.pages.dm.id, S.pages.shared.id, S.pages.classified.id, 'imp-dm']) {
    const values: Record<string, string> = { location, description: 'The wind rises over the water.' };
    const sent = await dm('POST', '/sculpt/send', { templateId: scene.id, values });
    const ran = await dm('POST', '/sculpt/run', { templateId: scene.id, values });
    const checked = await dm('POST', '/sculpt/check', { templateId: scene.id, values });
    for (const r of [sent, ran, checked]) for (const m of leaksFor('jess', r.text)) if (!['dm_page', 'classified_page'].includes(m.id) || r === sent) assert.fail(`${r.status} ${r.text.slice(0, 200)} leaked ${m.id}`);
    // What the players got in their chat.
    const threads = (await asJess('/messages')).json as any[];
    for (const t of threads) for (const m of leaksFor('jess', JSON.stringify((await asJess(`/messages/${t.id}`)).json))) assert.fail(`a sent scene leaked ${m.id}`);
  }
});

test('TestSecurityState_ClassifyingAPageRemovesItFromEveryCopyAndIndex', async () => {
  const pg = S.pages.dm; // a DM page: models may read it
  const m = tok('dm_page');
  const asModel = (u: string) => call('GET', `${W()}${u}`, S.T.dm, undefined, { 'X-Alexandria-Caller': 'model' });
  assert.ok((await asModel(`/library/pages/${pg.id}`)).text.includes(m));
  assert.ok((await asModel(`/library/search?q=smuggler`)).text.toLowerCase().includes('smuggler'));
  // Pretend it was embedded: a chunk of its text for the DM scope.
  deps.db.prepare("INSERT INTO search_chunks (world_id, page_id, scope, idx, text, vec) VALUES (?, ?, 'dm', 0, ?, ?)").run(S.W, pg.id, `chunk ${m}`, new Uint8Array(new Float32Array([0.5, 0.5, 0.5]).buffer));
  assert.equal((await level(pg.id, 'classified')).status, 200);
  assert.equal((await asModel(`/library/pages/${pg.id}`)).status, 404, 'a model can no longer read it');
  assert.ok(!(await asModel('/library/pages')).text.includes(pg.id));
  assert.ok(!(await asModel(`/library/search?q=smuggler`)).text.includes(m));
  assert.equal((await call('GET', `${W()}/library/pages/${pg.id}`, S.T.dm)).status, 200, 'the DM still reads it in the app');
  assert.equal(one<any>(deps.db, 'SELECT count(*) AS n FROM search_chunks WHERE page_id = ?', pg.id)!.n, 0, 'its embedded chunks are gone');
  const row = one<any>(deps.db, 'SELECT ai_body, ai_blocks, ai_properties, ai_frontmatter, player_body, broker_body FROM pages WHERE id = ?', pg.id)!;
  assert.deepEqual(Object.values(row), [null, null, null, null, null, null]);
  // And the guard now knows its text.
  assert.ok(deps.library.classifiedGrams().size > 0);
  // Back to DM-only: models read it again and the guard forgets it.
  const grams = deps.library.classifiedGrams().size;
  assert.equal((await level(pg.id, 'dm')).status, 200);
  assert.ok((await asModel(`/library/pages/${pg.id}`)).text.includes(m));
  assert.ok(deps.library.classifiedGrams().size < grams || grams === 0);
});

test('TestSecurityState_DeletingAPageLeavesNothingBehind', async () => {
  const pg = S.pages.classified;
  const slug = one<any>(deps.db, 'SELECT slug FROM worlds WHERE id = ?', S.W)!.slug;
  const before = deps.library.classifiedGrams().size;
  assert.equal((await call('DELETE', `${W()}/library/pages/${pg.id}`, S.T.dm)).status, 200);
  assert.equal(one<any>(deps.db, 'SELECT count(*) AS n FROM pages WHERE id = ?', pg.id)!.n, 0);
  for (const sub of ['vault', 'party']) assert.ok(!fs.existsSync(path.join(dataDir, 'worlds', slug, sub, pg.path)));
  assert.ok(!fs.existsSync(path.join(dataDir, 'worlds', slug, '_api', pg.path.replace(/\.md$/, '.json'))));
  assert.ok(deps.library.classifiedGrams().size < before, 'the guard forgot the page');
  const found = new Set<string>();
  for (const t of tablesOf()) {
    let rows: any[];
    try { rows = all<any>(deps.db, `SELECT * FROM "${t}"`); } catch { continue; }
    for (const row of rows) if (Object.values(row).map(asText).join('\n').toLowerCase().includes(tok('classified_page').toLowerCase())) found.add(t);
  }
  assert.deepEqual([...found], [], 'no table still holds the deleted classified text');
  // A shared page leaves its player files too (the Markdown copy and the JSON copy).
  const shared = S.pages.shared;
  const apiFile = path.join(dataDir, 'worlds', slug, '_api', shared.path.replace(/\.md$/, '.json'));
  assert.ok(fs.existsSync(apiFile));
  assert.equal((await call('DELETE', `${W()}/library/pages/${shared.id}`, S.T.dm)).status, 200);
  assert.ok(!fs.existsSync(apiFile) && !fs.existsSync(path.join(dataDir, 'worlds', slug, 'party', shared.path)));
});
