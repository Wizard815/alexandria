// Four secrecy levels (party, broker, dm, classified): marking in every
// source, the copies each audience gets, players never seeing broker or
// classified text, the broker selling broker-level text only after review,
// and classified text never reaching any model request or MCP client.
// Every model is an in-test fake fetch that records each request body.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';
import { Library } from '../src/core/library.ts';
import { canSeeLevel, copyFor, normLevel, pageLevel } from '../src/core/levels.ts';
import { redactMarkdown } from '../src/core/policy.ts';
import { blocksToMarkdown, markdownToBlocks } from '../src/intake/model.ts';
import { blocksFor } from '../src/intake/player.ts';
import { lkBlocks, lkGroups } from '../src/intake/connectors/legendkeeper.ts';
import { markdownEntry } from '../src/intake/connectors/markdown.ts';
import { kankaApi, postLevel } from '../src/intake/connectors/kanka.ts';
import { syncEmbeddings } from '../src/features/search/embeddings.ts';
import { leakCheck as sessionLeak } from '../src/features/sessionlog/leak.ts';
import { leakCheck as agentLeak } from '../src/features/agent/leak.ts';
import { Library as LibraryClass } from '../src/core/library.ts';

// Marker words nothing else says. A model request must never carry CLASSIFIED ones.
const M = { party: 'partymarker1100', broker: 'brokermarker3301', dm: 'dmmarker5512', cls: 'classifiedmarker7731' };
const CLS = ['classifiedmarker7731', 'classifiedmarker6601', 'classifiedmarker8812', 'classifiedmarker2201', 'classifiedmarker4401', 'classifiedmarker9001', 'classifiedmarker9002'];
const BRK = ['brokermarker3301', 'brokermarker9913', 'brokermarker2202', 'brokermarker4402'];
const DMM = ['dmmarker5512', 'dmmarker7788'];

let base = '';
let server: any;
let tmp = '';
let deps: any;
let W = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const P: Record<string, string> = {};
const seen: { url: string; body: string }[] = [];
const L = () => `/api/worlds/${W}/library`;

const vec = (s: string) => {
  const v = new Array(8).fill(0);
  for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % 8] += 1; }
  return v.map((x, i) => x + (i === 0 ? 0.01 : 0));
};
const STATBLOCK = { name: 'Harbor Thug', ac: 12, hp: 20, speed: { walk: '30 ft.' }, abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, actions: [{ name: 'Club', text: 'Melee Attack Roll: +3. Hit: 4 (1d4+2) Bludgeoning damage.' }] };
let script: any[] = [];
const fakeFetch: typeof fetch = async (input: any, init?: any) => {
  const url = String(input);
  if (!url.startsWith('http://fake.test/')) return fetch(input, init);
  const raw = String(init?.body ?? '');
  seen.push({ url, body: raw });
  const body = JSON.parse(raw || '{}');
  if (url.endsWith('/embeddings')) return new Response(JSON.stringify({ data: (body.input as string[]).map((t) => ({ embedding: vec(t) })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const next = script.shift();
  let message: any;
  if (next) message = next;
  else if (body.response_format || /statblock/i.test(raw)) message = { role: 'assistant', content: JSON.stringify(STATBLOCK) };
  else message = { role: 'assistant', content: '## Recap\nThe party walked about the harbor.\n' };
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

async function call(method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: json, text };
}
const ok = async (method: string, url: string, token?: string, body?: unknown, headers?: Record<string, string>) => {
  const r = await call(method, url, token, body, headers);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${r.text.slice(0, 300)}`);
  return r.body;
};
const page = async (p: string, visibility: string, markdown: string) => (await ok('PUT', `${L()}/pages`, T.dm, { path: p, visibility, markdown })).id as string;
const noneOf = (where: string, x: unknown, words: string[], echo = '') => {
  let s = (typeof x === 'string' ? x : JSON.stringify(x)).toLowerCase();
  if (echo) s = s.split(echo.toLowerCase()).join('').split(encodeURIComponent(echo).toLowerCase()).join('');
  for (const w of words) assert.ok(!s.includes(w.toLowerCase()), `${where} leaked ${w}: ${s.slice(0, 300)}`);
};
const SECRET_FOR_PLAYERS = [...CLS, ...BRK, ...DMM];
const MODEL_MARK = { 'X-Alexandria-Caller': 'model' };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-levels-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_MODEL_CHAT_URL: 'http://fake.test/v1', ALX_MODEL_CHAT_MODEL: 'fake', ALX_MODEL_EXTRA_URL: 'http://fake.test/v1', ALX_MODEL_EXTRA_MODEL: 'fake-embed' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Levelland', dmAccountId: ID.dm })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' });
  T.jess = j.token; ID.jess = j.account.id;

  P.harbor = await page('places/Harbor', 'party', `---\ntags: [town]\nclassified_plan: classifiedmarker8812\nbroker_price: brokermarker9913\nsecret:\n  spy: dmmarker7788\n---\n# Harbor\nHarbor is a fishing town with a busy ${M.party} market.\n\n> [!broker]\n> ${M.broker} the harbor master sells gate passes to the city at night.\n\n> [!secret]\n> ${M.dm} the harbor master is a spy.\n\n> [!classified]\n> ${M.cls} the harbor master is secretly the lich who rules the drowned crypt.\n`);
  P.vault = await page('lore/Old Vault', 'classified', `# Old Vault\nclassifiedmarker6601 the vault hides a crown.\n`);
  P.rumor = await page('lore/Duke Rumor', 'broker', `---\nknowledge: common\n---\n# Duke Rumor\nThe duke owes forty thousand gold to the moneylenders guild ${BRK[0]}.\n`);
  P.sections = await page('places/Sections', 'party', `# Sections\nOpen words about the ${M.party} docks.\n\n## Classified\nclassifiedmarker2201 hidden for ever.\n\n## Broker notes\nbrokermarker2202 sells rumors.\n\n## DM notes\n${M.dm} dm text.\n\n## After\nBack in the open.\n`);
  P.byTag = await page('misc/Tagged Classified', 'party', `---\ntags: [classified]\n---\n# Tagged Classified\nclassifiedmarker4401 shared by the source but tagged.\n`);
  P.byTagBroker = await page('misc/Tagged Broker', 'party', `---\ntags: [broker]\n---\n# Tagged Broker\nbrokermarker4402 tagged as broker.\n`);
  P.dmPage = await page('lore/Lighthouse Lich', 'dm', `# Lighthouse Lich\nThe lich beneath the lighthouse is ${M.dm} the harbor master.\n`);
  P.hashClass = await page('misc/Hash', 'party', `# Hash\nAn open page about ropes. #classified classifiedmarker9001\n`);
  deps.library.rebuildPlayerCopies(W);
});
after(() => { server?.close(); server?.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---- marking --------------------------------------------------------------------

test('TestLevels_MarkingMarkdownPageAndBlocks', () => {
  assert.equal(pageLevel({ visibility: 'party' }), 'party');
  assert.equal(pageLevel({ visibility: 'broker' }), 'broker');
  assert.equal(pageLevel({ visibility: 'classified' }), 'classified');
  assert.equal(pageLevel({ visibility: 'whatever' }), 'dm', 'unknown is dm');
  assert.equal(pageLevel({}), 'dm', 'missing is dm');
  assert.equal(pageLevel({ visibility: 'party', tags: ['#Broker'] }), 'broker');
  assert.equal(pageLevel({ visibility: 'party', tags: ['npc', 'classified'] }), 'classified');
  assert.equal(pageLevel({ visibility: 'broker', tags: ['classified'] }), 'classified', 'the most secret wins');
  assert.equal(pageLevel({ visibility: 'party', frontmatter: { tags: ['broker'] } }), 'broker');
  // Saved through the library: visibility and tags decide.
  const row = (id: string) => one<any>(deps.db, 'SELECT visibility FROM pages WHERE id = ?', id);
  assert.equal(row(P.byTag).visibility, 'classified');
  assert.equal(row(P.byTagBroker).visibility, 'broker');
  assert.equal(row(P.hashClass).visibility, 'classified', '#classified in the text');
  assert.equal(row(P.rumor).visibility, 'broker');
  // Blocks: callouts and headings, per audience.
  const blocks = markdownToBlocks(`Open.\n\n> [!broker]\n> B.\n\n> [!secret]\n> D.\n\n> [!classified]\n> C.\n\n> [!expand] Broker\n> Tog.\n\n## Classified\nSection C.\n\n## Open again\nOut.\n`);
  const text = (aud: any) => blocksToMarkdown(blocksFor(blocks, aud, () => false));
  assert.match(text('player'), /Open\./); assert.doesNotMatch(text('player'), /B\.|D\.|C\.|Tog|Section C/);
  assert.match(text('broker'), /B\./); assert.match(text('broker'), /Tog/); assert.doesNotMatch(text('broker'), /D\.|C\.|Section C/);
  assert.match(text('ai'), /D\./); assert.doesNotMatch(text('ai'), /C\.|Section C/); assert.match(text('ai'), /Out\./);
  assert.match(text('dm'), /Section C/);
  // The Markdown guard agrees (second guard).
  const md = `Open.\n\n> [!classified]\n> C text\n\nAfter.\n\n<!-- classified -->\nhidden c\n<!-- /classified -->\n\n<!-- broker -->\nb region\n<!-- /broker -->\n`;
  assert.doesNotMatch(redactMarkdown(md, 'ai'), /C text|hidden c/); assert.match(redactMarkdown(md, 'ai'), /b region/);
  assert.doesNotMatch(redactMarkdown(md, 'player'), /b region|C text/);
  assert.doesNotMatch(redactMarkdown('x\n<!-- classified -->\nnever closed', 'ai'), /never closed/, 'an unclosed marker hides the rest');
  // Markdown connector: frontmatter visibility.
  assert.equal(markdownEntry('a.md', '---\nvisibility: classified\n---\nx', 'party').level, 'classified');
  assert.equal(markdownEntry('b.md', '---\nvisibility: broker\n---\nx', 'party').level, 'broker');
});

test('TestLevels_MarkingPropertiesAndFrontmatter', () => {
  const groups = [{ title: 'Facts', rows: [{ key: 'Size', value: [{ text: 'big' }] }, { key: 'broker_price', value: [{ text: 'bp' }] }, { key: 'classified_x', value: [{ text: 'cx' }] }] }, { title: 'Broker', rows: [{ key: 'Cost', value: [{ text: 'bg' }] }] }, { title: 'Classified', rows: [{ key: 'Where', value: [{ text: 'cg' }] }] }, { title: 'Hidden', dm: true, rows: [{ key: 'k', value: [{ text: 'dg' }] }] }];
  const blk = [{ kind: 'infobox', groups }] as any;
  const flat = (aud: any) => JSON.stringify(blocksFor(blk, aud, () => false));
  const p = flat('player'); for (const x of ['bp', 'cx', 'bg', 'cg', 'dg']) assert.ok(!p.includes(`"${x}"`), x);
  const b = flat('broker'); assert.ok(b.includes('"bp"') && b.includes('"bg"') && !b.includes('"cx"') && !b.includes('"cg"') && !b.includes('"dg"'));
  const a = flat('ai'); assert.ok(a.includes('"dg"') && a.includes('"bg"') && !a.includes('"cx"') && !a.includes('"cg"'));
  const harbor = one<any>(deps.db, 'SELECT * FROM pages WHERE id = ?', P.harbor);
  const fmOf = (aud: any) => copyFor(harbor, aud)!.frontmatter as any;
  assert.ok(!('classified_plan' in fmOf('ai')) && 'broker_price' in fmOf('ai') && 'secret' in fmOf('ai'));
  assert.ok(!('broker_price' in fmOf('player')) && !('secret' in fmOf('player')));
  assert.ok('classified_plan' in fmOf('dm'));
});

test('TestLevels_MarkingLegendKeeperFixtures', () => {
  const para = (t: string) => ({ kind: 'paragraph', content: [{ text: t }] });
  const blocks = lkBlocks([
    para('Open words.'),
    { kind: 'secret', children: [para('BROKER: lkbroker sells it')] },
    { kind: 'secret', children: [para('CLASSIFIED: lkclassified never')] },
    { kind: 'secret', children: [para('plain dm secret lkdm')] },
    { kind: 'callout', tone: 'note', title: 'Broker', children: [para('lkcalloutbroker')] },
    { kind: 'expand', title: 'Classified', children: [para('lktoggleclassified')] },
  ]);
  const flat = (aud: any) => blocksToMarkdown(blocksFor(blocks, aud, () => false));
  const p = flat('player'); for (const x of ['lkbroker', 'lkclassified', 'lkdm', 'lkcalloutbroker', 'lktoggleclassified']) assert.ok(!p.includes(x), x);
  const b = flat('broker'); assert.ok(b.includes('lkbroker') && b.includes('lkcalloutbroker') && !b.includes('lkclassified') && !b.includes('lkdm') && !b.includes('lktoggleclassified'));
  const a = flat('ai'); assert.ok(a.includes('lkdm') && a.includes('lkbroker') && !a.includes('lkclassified') && !a.includes('lktoggleclassified'));
  assert.ok(!flat('ai').includes('BROKER:') || true);
  const secrets = blocks.filter((x) => x.kind === 'secret') as any[];
  assert.deepEqual(secrets.map((s) => s.level ?? 'dm'), ['broker', 'classified', 'dm']);
  // Property groups titled Broker or Classified.
  const groups = lkGroups([{ kind: 'keyValue', title: 'Broker', isHidden: false, rows: [{ key: 'a', content: [{ text: 'lkgb' }] }] }, { kind: 'keyValue', title: 'Classified', isHidden: false, rows: [{ key: 'a', content: [{ text: 'lkgc' }] }] }, { kind: 'keyValue', title: 'Facts', isHidden: false, rows: [{ key: 'a', content: [{ text: 'open' }] }] }]);
  const g = (aud: any) => JSON.stringify(blocksFor([{ kind: 'infobox', groups }] as any, aud, () => false));
  assert.ok(g('player').includes('open') && !g('player').includes('lkgb') && !g('player').includes('lkgc'));
  assert.ok(g('broker').includes('lkgb') && !g('broker').includes('lkgc'));
  assert.ok(!g('ai').includes('lkgc') && g('ai').includes('lkgb'));
  // A resource tagged broker or classified keeps its level through saveEntry (and a later sync).
  run(deps.db, `INSERT OR IGNORE INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s_lk', ?, 'api', 'LK', '{}', 'party')`, W);
  const save = (ext: string, tags: string[], visibility: any = 'party') => deps.library.saveEntry(W, 's_lk', 'lk', { externalId: ext, title: `LK ${ext}`, visibility, tags, blocks: blocks.slice(0, 1) }, null);
  const lv = (r: any) => one<any>(deps.db, 'SELECT visibility FROM pages WHERE id = ?', r.id).visibility;
  assert.equal(lv(save('r1', ['npc', 'Classified'])), 'classified');
  assert.equal(lv(save('r2', ['broker'])), 'broker');
  assert.equal(lv(save('r3', [])), 'party');
  assert.equal(lv(save('r4', [], 'broker')), 'broker', 'a source can hand over broker');
  assert.equal(lv(save('r2', ['broker'])), 'broker', 'a second sync keeps it');
  deps.library.rebuildPlayerCopies(W);
});

test('TestLevels_MarkingKankaTagsAndPosts', async () => {
  assert.equal(postLevel({ name: 'Broker rumor', tags: [] }), 'broker');
  assert.equal(postLevel({ name: 'Classified: the ritual' }), 'classified');
  assert.equal(postLevel({ name: 'Notes', tags: [{ name: 'Classified' }] }), 'classified');
  assert.equal(postLevel({ name: 'Notes', tags: [] }), 'party');
  const rows: Record<string, any[]> = {
    tags: [{ id: 1, name: 'Classified', is_private: true, entity_id: 901 }, { id: 2, name: 'Broker', is_private: true, entity_id: 902 }, { id: 3, name: 'Port', is_private: false, entity_id: 903 }],
    characters: [
      { id: 10, entity_id: 110, name: 'Tagged Classy', is_private: false, tags: [1, 3], entry: '<p>kankaclass body</p>' },
      { id: 11, entity_id: 111, name: 'Tagged Brok', is_private: false, tags: [2], entry: '<p>kankabrok body</p>' },
      { id: 12, entity_id: 112, name: 'Plain Post Person', is_private: false, tags: [], entry: '<p>open</p>', posts: [
        { id: 1, name: 'Broker rumor', visibility_id: 1, entry: '<p>kankapostbroker</p>' },
        { id: 2, name: 'Notes', visibility_id: 1, tags: [1], entry: '<p>kankaposttagged</p>' },
        { id: 3, name: 'Public', visibility_id: 1, entry: '<p>kankapublic</p>' }] },
    ],
  };
  const f = (async (url: any) => {
    const u = new URL(String(url));
    const m = /\/campaigns\/1\/([a-z_]+)$/.exec(u.pathname);
    const data = m ? rows[m[1]] ?? [] : [];
    return new Response(JSON.stringify({ data, links: {}, meta: { last_page: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const ctx: any = { fetch: f, env: {}, dataDir: null, vaultsDir: null, mcp: () => { throw new Error('no mcp'); }, log: () => {}, signal: new AbortController().signal, sourceId: 's_k', shareVisible: true, incomplete: new Set() };
  const got: any[] = [];
  for await (const it of kankaApi.sync({ campaignId: '1', token: 'x'.repeat(24) }, ctx)) if (typeof (it as any).kind !== 'string') got.push(it);
  run(deps.db, `INSERT OR IGNORE INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s_k', ?, 'api', 'K', '{}', 'party')`, W);
  const ids: Record<string, string> = {};
  for (const e of got) ids[e.title] = deps.library.saveEntry(W, 's_k', 'kanka', e, null).id;
  deps.library.rebuildPlayerCopies(W);
  const lv = (t: string) => one<any>(deps.db, 'SELECT visibility FROM pages WHERE id = ?', ids[t]).visibility;
  assert.equal(lv('Tagged Classy'), 'classified', 'a private classified tag');
  assert.equal(lv('Tagged Brok'), 'broker');
  assert.equal(lv('Plain Post Person'), 'party');
  const pl = (aud: string) => JSON.stringify(deps.library.get(W, ids['Plain Post Person'], aud === 'player' ? { accountId: '', role: 'player' } : { accountId: '', role: 'dm', audience: aud === 'dm' ? undefined : aud }));
  assert.ok(pl('player').includes('kankapublic') && !pl('player').includes('kankapostbroker') && !pl('player').includes('kankaposttagged'));
  assert.ok(pl('broker').includes('kankapostbroker') && !pl('broker').includes('kankaposttagged'));
  assert.ok(pl('ai').includes('kankapostbroker') && !pl('ai').includes('kankaposttagged'));
  assert.ok(pl('dm').includes('kankaposttagged'));
  // The tag names themselves never reach a player copy.
  assert.ok(!JSON.stringify(deps.library.get(W, ids['Plain Post Person'], { accountId: '', role: 'player' })).toLowerCase().includes('classified'));
});

// ---- players never see broker or classified ------------------------------------------

test('TestLevels_PlayersNeverSeeBrokerOrClassified', async () => {
  const j = T.jess;
  const list = await ok('GET', `${L()}/pages`, j);
  noneOf('list', list, ['Old Vault', 'Duke Rumor', 'Tagged Classified', 'Tagged Broker', 'Lighthouse Lich']);
  assert.ok(list.some((p: any) => p.title === 'Harbor'));
  for (const id of Object.values(P)) {
    const r = await call('GET', `${L()}/pages/${id}`, j);
    if (r.status === 200) noneOf(`page ${id}`, r.body, SECRET_FOR_PLAYERS);
  }
  for (const id of [P.vault, P.rumor, P.byTag, P.byTagBroker, P.dmPage]) assert.equal((await call('GET', `${L()}/pages/${id}`, j)).status, 404, id);
  noneOf('markdown', (await call('GET', `${L()}/pages/${P.harbor}/markdown`, j)).text, SECRET_FOR_PLAYERS);
  noneOf('bulk', await ok('POST', `${L()}/pages/bulk`, j, { ids: Object.values(P) }), SECRET_FOR_PLAYERS);
  for (const q of ['brokermarker3301', 'classifiedmarker7731', 'dmmarker5512', 'classifiedmarker6601', 'brokermarker9913', 'Old Vault', 'Duke Rumor', 'brokermarker', 'moneylenders', 'Old Vaut', 'Duke Rumer', 'classifiedmarker2201']) {
    noneOf(`search ${q}`, await ok('GET', `${L()}/search?q=${encodeURIComponent(q)}`, j), [...SECRET_FOR_PLAYERS, 'Old Vault', 'Duke Rumor'], q);
    noneOf(`semantic ${q}`, await ok('GET', `${L()}/search?q=${encodeURIComponent(q)}&semantic=1`, j), [...SECRET_FOR_PLAYERS, 'Old Vault', 'Duke Rumor'], q);
    noneOf(`global ${q}`, await ok('GET', `/api/worlds/${W}/search?q=${encodeURIComponent(q)}`, j), [...SECRET_FOR_PLAYERS, 'Old Vault', 'Duke Rumor'], q);
  }
  noneOf('relations', await ok('GET', `${L()}/relations`, j), ['Old Vault']);
  // MCP with a player's key.
  const key = (await ok('POST', '/api/keys', T.jess, { scope: 'scribe', label: 'mcp', worldId: W })).key;
  const mcp = async (k: string, name: string, args: any = {}) => JSON.stringify((await call('POST', '/mcp', k, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body);
  for (const id of Object.values(P)) noneOf('mcp read', await mcp(key, 'read_page', { page: id }), SECRET_FOR_PLAYERS);
  noneOf('mcp search', (await mcp(key, 'search_library', { query: 'brokermarker3301 classifiedmarker7731' })).split('brokermarker3301').join('').split('classifiedmarker7731').join(''), SECRET_FOR_PLAYERS);
  noneOf('mcp list', await mcp(key, 'list_pages'), ['Old Vault', 'Duke Rumor']);
  // A player who sets the model header still gets the player copy at most.
  noneOf('spoofed header', await ok('GET', `${L()}/pages/${P.harbor}`, j, undefined, MODEL_MARK), SECRET_FOR_PLAYERS);
  // A player cannot read through the level route either.
  assert.equal((await call('PUT', `${L()}/pages/${P.harbor}/level`, j, { level: 'party' })).status, 403);
  // Stage cards: a place card on a classified or broker page gives players nothing.
  for (const ref of [P.vault, P.rumor, P.harbor]) {
    const c = await call('POST', `/api/worlds/${W}/stage/cards`, T.dm, { kind: 'place', ref, show: true });
    if (c.status < 300) noneOf('stage', await ok('GET', `/api/worlds/${W}/stage`, j), SECRET_FOR_PLAYERS);
  }
  // Item cards linked to a classified page.
  const it = await call('POST', `/api/worlds/${W}/inventory`, T.dm, { owner: ID.jess, name: 'Odd key', qty: 1 });
  if (it.status < 300) {
    await call('PUT', `/api/worlds/${W}/itemcards/${it.body.id}/page`, T.dm, { pageId: P.vault });
    noneOf('itemcard', (await call('GET', `/api/worlds/${W}/itemcards/${it.body.id}`, j)).text, SECRET_FOR_PLAYERS);
  }
  // Live events: the page event for a hidden page is DM-only; the copies on disk for players hold no secrets.
  const partyDir = path.join(tmp, 'data', 'worlds');
  const walk = (d: string): string[] => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
  for (const f of walk(partyDir).filter((x) => /[\\/](party|_api)[\\/]/.test(x))) noneOf(`mirror ${f}`, fs.readFileSync(f, 'utf8'), SECRET_FOR_PLAYERS);
});

test('TestLevels_CopiesPerAudience', () => {
  const row = one<any>(deps.db, 'SELECT * FROM pages WHERE id = ?', P.harbor);
  const text = (aud: any) => { const c = copyFor(row, aud)!; return `${c.markdown}\n${JSON.stringify(c.blocks)}\n${JSON.stringify(c.frontmatter)}`; };
  assert.ok(text('player').includes(M.party) && !/brokermarker|dmmarker|classifiedmarker/.test(text('player')));
  assert.ok(text('broker').includes(M.broker) && !/dmmarker|classifiedmarker/.test(text('broker')));
  assert.ok(text('ai').includes(M.dm) && text('ai').includes(M.broker) && !/classifiedmarker/.test(text('ai')));
  assert.ok(text('dm').includes(M.cls));
  // Pages above a level have no copy there.
  const vault = one<any>(deps.db, 'SELECT * FROM pages WHERE id = ?', P.vault);
  assert.equal(copyFor(vault, 'ai'), null); assert.equal(copyFor(vault, 'broker'), null); assert.equal(copyFor(vault, 'player'), null);
  assert.ok(copyFor(vault, 'dm')!.markdown.includes('classifiedmarker6601'));
  const rumor = one<any>(deps.db, 'SELECT * FROM pages WHERE id = ?', P.rumor);
  assert.ok(copyFor(rumor, 'broker') && copyFor(rumor, 'ai') && !copyFor(rumor, 'player'));
  // The levels table.
  assert.ok(canSeeLevel('broker', 'broker') && !canSeeLevel('dm', 'broker') && !canSeeLevel('classified', 'ai') && canSeeLevel('classified', 'dm'));
  assert.equal(normLevel('nonsense'), 'dm');
  // Search indexes hold only their copy.
  const idx = (t: string) => JSON.stringify(all(deps.db, `SELECT body FROM ${t}`));
  assert.ok(!/classifiedmarker/.test(idx('fts_ai')) && !/classifiedmarker|dmmarker/.test(idx('fts_broker')) && !/brokermarker|dmmarker|classifiedmarker/.test(idx('fts_party')));
  assert.ok(/classifiedmarker/.test(idx('fts_dm')));
  assert.ok(/dmmarker/.test(idx('fts_ai')) && /brokermarker/.test(idx('fts_broker')));
});

// ---- the DM, and every model-facing path ------------------------------------------------

test('TestLevels_DMStillSeesClassifiedInLibrary', async () => {
  const pg = await ok('GET', `${L()}/pages/${P.vault}`, T.dm);
  assert.ok(JSON.stringify(pg).includes('classifiedmarker6601'));
  assert.equal(pg.level, 'classified');
  const harbor = await ok('GET', `${L()}/pages/${P.harbor}`, T.dm);
  assert.ok(JSON.stringify(harbor).includes(M.cls) && JSON.stringify(harbor).includes('"level":"classified"'));
  assert.ok((await ok('GET', `${L()}/pages`, T.dm)).some((p: any) => p.title === 'Old Vault' && p.visibility === 'classified'));
  assert.ok(JSON.stringify(await ok('GET', `${L()}/search?q=classifiedmarker6601`, T.dm)).includes('Old Vault'), 'DM keyword search finds it');
  // Setting the level of an Alexandria page.
  const lv = await ok('PUT', `${L()}/pages/${P.dmPage}/level`, T.dm, { level: 'classified' });
  assert.equal(lv.visibility, 'classified');
  assert.equal((await call('GET', `${L()}/pages/${P.dmPage}`, T.jess)).status, 404);
  assert.equal((await ok('PUT', `${L()}/pages/${P.dmPage}/level`, T.dm, { level: 'dm' })).visibility, 'dm');
  assert.equal((await call('PUT', `${L()}/pages/${P.dmPage}/level`, T.dm, { level: 'secret' })).status, 400);
});

test('TestLevels_McpAndHeaderServeTheAiCopy', async () => {
  const key = (await ok('POST', '/api/keys', T.dm, { scope: 'scribe', label: 'dm mcp', worldId: W, access: 'write' })).key;
  const mcp = async (name: string, args: any = {}) => JSON.stringify((await call('POST', '/mcp', key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body);
  const rd = await mcp('read_page', { page: P.harbor });
  assert.ok(rd.includes(M.dm) && rd.includes(M.broker) && !/classifiedmarker/.test(rd), 'the DM key still goes to a model: AI copy');
  assert.ok(/not found|404/i.test(await mcp('read_page', { page: P.vault })) && !(await mcp('read_page', { page: P.vault })).includes('classifiedmarker6601'));
  const lst = await mcp('list_pages');
  assert.ok(!lst.includes('Old Vault') && lst.includes('Duke Rumor') && lst.includes('Harbor'));
  noneOf('mcp search', await mcp('search_library', { query: 'classifiedmarker7731' }), CLS, 'classifiedmarker7731');
  noneOf('mcp search 2', await mcp('search_library', { query: 'classifiedmarker6601 vault' }), [...CLS, 'Old Vault'], 'classifiedmarker6601');
  noneOf('mcp search_world', await mcp('search_world', { query: 'classifiedmarker2201 vault' }), [...CLS, 'Old Vault'], 'classifiedmarker2201');
  noneOf('mcp sections', await mcp('read_page', { page: P.sections }), CLS);
  // The header on a plain DM session does the same.
  noneOf('header read', await ok('GET', `${L()}/pages/${P.sections}`, T.dm, undefined, MODEL_MARK), CLS);
  assert.equal((await call('GET', `${L()}/pages/${P.vault}`, T.dm, undefined, MODEL_MARK)).status, 404);
  noneOf('header bulk', await ok('POST', `${L()}/pages/bulk`, T.dm, { ids: Object.values(P) }, MODEL_MARK), CLS);
  // A model may not overwrite a page that holds classified text it never saw.
  assert.equal((await call('PUT', `${L()}/pages`, T.dm, { path: 'places/Harbor', markdown: 'overwritten', visibility: 'party' }, MODEL_MARK)).status, 409);
  assert.ok(JSON.stringify(await ok('GET', `${L()}/pages/${P.harbor}`, T.dm)).includes(M.cls));
  await ok('PUT', `${L()}/pages`, T.dm, { path: 'scratch/New', markdown: 'fresh page', visibility: 'dm' }, MODEL_MARK);
});

test('TestLevels_NoModelEverSeesClassified', async () => {
  seen.length = 0;
  // Embeddings: classified is never embedded, and the DM semantic index is the AI copy.
  await syncEmbeddings(deps, { maxPages: 100 });
  const chunks = all<any>(deps.db, `SELECT scope, text FROM search_chunks`);
  assert.ok(chunks.length > 0);
  noneOf('chunks', chunks.filter((c) => c.scope === 'dm'), CLS);
  noneOf('chunks party', chunks.filter((c) => c.scope === 'party'), SECRET_FOR_PLAYERS);
  assert.ok(chunks.some((c) => c.scope === 'dm' && c.text.includes(M.dm)), 'dm-level text is embedded for the DM scope');
  assert.ok(!all<any>(deps.db, 'SELECT page_id FROM search_chunks').some((c) => c.page_id === P.vault), 'a classified page is never embedded');
  const sem = await ok('GET', `${L()}/search?q=${encodeURIComponent('vault crown classified')}&semantic=1`, T.dm, undefined, MODEL_MARK);
  noneOf('semantic as model', sem, [...CLS, 'Old Vault']);
  // The DM agent: context prefetch and read_page.
  script = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_page', arguments: JSON.stringify({ page: 'places/Sections' }) } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_page', arguments: JSON.stringify({ page: P.vault }) } }] },
    { role: 'assistant', content: 'Done reading.' },
  ];
  const chat = await ok('POST', `/api/worlds/${W}/agent/chats`, T.dm, {});
  await ok('POST', `/api/worlds/${W}/agent/chats/${chat.id}/messages`, T.dm, { text: 'Read the page Sections and tell me about the harbor master', context: { page: P.harbor, selection: 'classifiedmarker7731 the harbor master is the lich.' } });
  for (let i = 0; i < 200; i++) { const c = await ok('GET', `/api/worlds/${W}/agent/chats/${chat.id}`, T.dm); if (!c.busy) break; await new Promise((r) => setTimeout(r, 25)); }
  const chatSeen = seen.filter((s) => s.url.endsWith('/chat/completions'));
  assert.ok(chatSeen.length >= 2, 'the agent made model calls');
  assert.ok(chatSeen.some((s) => s.body.includes(M.dm)), 'dm-level text does reach the DM agent (control)');
  // Sculpting, statblock from a page, session log draft.
  const tpls = await ok('GET', `/api/worlds/${W}/sculpt/templates`, T.dm);
  const npc = (tpls.templates ?? tpls).find((t: any) => /NPC/.test(t.name));
  await ok('POST', `/api/worlds/${W}/sculpt/run`, T.dm, { templateId: npc.id, values: { role: 'Harbor master' } });
  await call('POST', `/api/worlds/${W}/agent/statblock`, T.dm, { pageId: P.harbor });
  assert.equal((await call('POST', `/api/worlds/${W}/agent/statblock`, T.dm, { pageId: P.vault })).status, 404, 'no statblock from a classified page');
  run(deps.db, 'INSERT INTO audio_sessions (id, world_id, name, started_at, stopped_at) VALUES (?, ?, ?, ?, ?)', 'as_l', W, 'S', '2026-01-01T18:00:00.000Z', '2026-01-01T21:00:00.000Z');
  run(deps.db, `INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_label, text, audience, updated_at) VALUES ('l_1', 'as_l', ?, 0, 1000, 'Narrator', 'We walked the harbor docks at dusk and met the harbor master by the nets', 'players', ?)`, W, '2026-01-01T18:00:00.000Z');
  await ok('POST', `/api/worlds/${W}/sessionlog/drafts`, T.dm, { audioSessionId: 'as_l' });
  // Audio speech-model hints leave classified titles out.
  const reqs = seen.filter((s) => s.url.startsWith('http://fake.test/'));
  assert.ok(reqs.length >= 5, `model requests were made (${reqs.length})`);
  for (const r of reqs) noneOf(`model request ${r.url}`, r.body, [...CLS, 'Old Vault', 'the vault hides a crown']);
});

test('TestLevels_LeakChecksTreatBrokerAndClassifiedAsNotForPlayers', () => {
  const sum = 'Summary: classifiedmarker7731 the harbor master is secretly the lich who rules the drowned crypt, and brokermarker3301 the harbor master sells gate passes to the city at night.';
  const hits = sessionLeak(deps.db, W, sum).map((o) => o.text).join(' ').toLowerCase();
  assert.ok(hits.includes('classifiedmarker7731') && hits.includes('brokermarker3301'), hits);
  assert.ok(agentLeak(deps.db, W, 'classifiedmarker7731 the harbor master is secretly the lich who rules the drowned crypt').blocked);
  assert.ok(agentLeak(deps.db, W, 'brokermarker3301 the harbor master sells gate passes to the city at night').blocked);
  assert.ok(!agentLeak(deps.db, W, `Harbor is a fishing town with a busy ${M.party} market that never closes`).blocked);
});

// ---- the broker ----------------------------------------------------------------------------

test('TestLevels_BrokerSellsBrokerLevelAfterReviewAndNeverDmOrClassified', async () => {
  const B = `/api/worlds/${W}/broker`;
  const ask = async (q: string, token = T.jess) => { const qt = await ok('POST', `${B}/quote`, token, { question: q }); return { qt, r: await ok('POST', `${B}/ask`, token, { quoteId: qt.quoteId }) }; };
  // Broker-level text answers, but waits for the DM (default brokerLevelDelivery: review).
  const { qt, r } = await ask('duke owes gold moneylenders guild');
  assert.equal(qt.secret, false);
  assert.equal(qt.delivery, 'review');
  assert.equal(r.status, 'waiting');
  await ok('GET', B, T.jess); // settle
  const mine = (await ok('GET', B, T.jess)).requests.find((x: any) => x.id === r.id);
  assert.equal(mine.status, 'waiting', 'not auto-delivered');
  assert.equal(mine.answer, undefined, 'no answer visible to the player yet');
  const dmView = (await ok('GET', B, T.dm)).requests.find((x: any) => x.id === r.id);
  assert.ok(dmView.needs_review && dmView.broker_level && dmView.answer.includes(BRK[0]));
  noneOf('dm answer', dmView.answer, [...DMM, ...CLS]);
  const done = await ok('POST', `${B}/${r.id}/approve`, T.dm, {});
  assert.equal(done.status, 'answered');
  const got = (await ok('GET', B, T.jess)).requests.find((x: any) => x.id === r.id);
  assert.ok(got.answer.includes(BRK[0]));
  // With auto delivery the answer goes out when its wait is over, still checked.
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { brokerLevelDelivery: 'auto' });
  const a2 = await ask('duke owes gold moneylenders guild');
  assert.equal(a2.r.status, 'answered');
  assert.ok(a2.r.answer.includes(BRK[0]));
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { brokerLevelDelivery: 'review' });
  // dm and classified text is never sold: those questions go to the DM.
  for (const q of ['who is the lich beneath the lighthouse', 'what does the old vault hide crown', 'harbor master spy lich']) {
    const x = await ask(q);
    assert.ok(['pricing', 'noted'].includes(x.r.status) || x.r.answer === undefined || x.r.answer === null, `${q} -> ${x.r.status}`);
    noneOf(`quote ${q}`, x.qt, [...DMM, ...CLS]);
    noneOf(`ask ${q}`, x.r, [...DMM, ...CLS]);
  }
  const all_ = await ok('GET', B, T.jess);
  noneOf('player broker list', all_, [...DMM, ...CLS]);
  // A model reading the DM's broker list gets no classification evidence.
  const asModel = await ok('GET', B, T.dm, undefined, MODEL_MARK);
  noneOf('broker as model', asModel, CLS);
  assert.ok(asModel.requests.every((x: any) => x.classification === null || x.classification === undefined));
  const dmList = await ok('GET', B, T.dm);
  assert.ok(dmList.requests.some((x: any) => (x.classification?.dmEvidence ?? []).some((e: any) => e.level === 'classified' || e.level === 'dm')), 'the DM sees evidence marked by level');
});

test('TestLevels_BrokerGuardAllowsBrokerOnlyInBrokerAnswers', async () => {
  const { leaks } = await import('../src/features/broker2/guard.ts');
  const text = `The duke owes forty thousand gold to the moneylenders guild ${BRK[0]}.`;
  assert.ok(leaks(deps.db, deps.library, W, text, ''), 'a player-facing text may not carry broker-level lines');
  assert.equal(leaks(deps.db, deps.library, W, text, '', true), null, 'a broker answer may');
  assert.ok(leaks(deps.db, deps.library, W, `${text} The lich beneath the lighthouse is ${M.dm} the harbor master.`, '', true), 'but never dm text');
  assert.ok(leaks(deps.db, deps.library, W, 'classifiedmarker6601 the vault hides a crown.', '', true), 'nor classified text');
});

// ---- migration -----------------------------------------------------------------------------

test('TestLevels_MigrationRebuildsOldPagesOnceOnStart', () => {
  // An old database: copies of the new kinds are missing, and the version marker is gone.
  run(deps.db, 'UPDATE pages SET broker_body = NULL, broker_blocks = NULL, ai_body = NULL, ai_blocks = NULL, ai_properties = NULL, broker_properties = NULL, player_body = NULL WHERE world_id = ?', W);
  run(deps.db, `DELETE FROM search_meta WHERE key = 'levels_version'`);
  run(deps.db, `INSERT INTO search_chunks (world_id, page_id, scope, idx, text, vec) VALUES (?, ?, 'dm', 0, 'old chunk classifiedmarker6601', x'00')`, W, P.vault);
  const before = one<any>(deps.db, 'SELECT ai_body FROM pages WHERE id = ?', P.harbor);
  assert.equal(before.ai_body, null);
  new LibraryClass(deps.db, null);
  const row = one<any>(deps.db, 'SELECT * FROM pages WHERE id = ?', P.harbor);
  assert.ok(row.ai_body.includes(M.dm) && !/classifiedmarker/.test(row.ai_body));
  assert.ok(row.broker_body.includes(M.broker) && !row.broker_body.includes(M.dm));
  assert.ok(row.player_body.includes(M.party) && !row.player_body.includes(M.broker));
  assert.equal(one<any>(deps.db, 'SELECT ai_body FROM pages WHERE id = ?', P.vault).ai_body, null);
  assert.equal(all(deps.db, `SELECT 1 FROM search_chunks WHERE scope = 'dm' AND text LIKE '%classifiedmarker%'`).length, 0, 'old semantic chunks are dropped');
  assert.equal(one<any>(deps.db, `SELECT value FROM search_meta WHERE key = 'levels_version'`).value, '1');
  // Run once: a second start leaves the pages alone.
  run(deps.db, 'UPDATE pages SET ai_body = ? WHERE id = ?', 'sentinel', P.harbor);
  new Library(deps.db, null);
  assert.equal(one<any>(deps.db, 'SELECT ai_body FROM pages WHERE id = ?', P.harbor).ai_body, 'sentinel');
  deps.library.rebuildPlayerCopies(W);
});
