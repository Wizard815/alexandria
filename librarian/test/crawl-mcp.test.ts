// A generic source reached through another MCP server gets a detail tier: the list tool makes the index, and a per-item read tool (guessed from
// the server's tool names and schemas, chosen in setup) gives whole pages later, on demand and in the background. Fake MCP server, synthetic data.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one } from '../src/core/db.ts';
import type { McpClient } from '../src/core/mcp.ts';
import { detailTick } from '../src/intake/detail.ts';
import { guessMcpTools } from '../src/intake/connectors/apiSetup.ts';
import { depthCounts, resetBuckets } from '../src/intake/tiers.ts';

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });
const gmViewer = { accountId: 'a', role: 'gm' as const };

// ---- a fake MCP server of a world app -----------------------------------------------------------------------------

const ARTICLES = [
  { id: 1, title: 'The Harbour', summary: 'Ships and salt.', private: false, updated: '2026-01-01', body: 'HARBOURBODY the long story of the harbour' },
  { id: 2, title: 'The Vault', summary: 'Gold.', private: true, updated: '2026-01-02', body: 'VAULTBODY the dragon sleeps here' },
  { id: 3, title: 'Unmarked Note', updated: '2026-01-03', body: 'UNMARKEDBODY no visibility field anywhere' },
  { id: 4, title: 'Second Quay', summary: 'Quays.', private: false, updated: '2026-01-04', body: 'QUAYBODY the second quay' },
];
const TOOLS = [
  { name: 'list_articles', description: 'List the articles', inputSchema: { type: 'object', properties: {} } },
  { name: 'search_articles', description: 'Search', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
  { name: 'get_article', description: 'Read one article', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  { name: 'read_settings', description: 'Settings', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_article', description: 'Make one', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
  { name: 'delete_article', description: 'Remove one', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
];
const mcp = { calls: [] as { tool: string; args: any }[], failGet: false };
const text = (v: unknown, isError = false) => ({ text: typeof v === 'string' ? v : JSON.stringify(v), structured: null, isError });
const fakeMcp: McpClient = {
  async call(tool, args) {
    mcp.calls.push({ tool, args });
    if (tool === 'list_articles') return text({ items: ARTICLES.map(({ body, ...rest }) => rest) });
    if (tool === 'get_article') {
      if (mcp.failGet) return text('internal error', true);
      const a = ARTICLES.find((x) => x.id === Number(args.id));
      return a ? text({ data: a }) : text('Article not found', true);
    }
    return text('unexpected tool ' + tool, true);
  },
  async listTools() { return TOOLS; },
  close() {},
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fake = (async (url: any) => json({ error: 'unexpected ' + url }, 500)) as typeof fetch;

async function boot() {
  resetBuckets();
  mcp.calls = []; mcp.failGet = false;
  const made = createApp({ noScheduler: true, fetch: fake, testMcp: fakeMcp, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_CRAWL_RATE: '0' } });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  cleanups.push(() => { server.close(); server.closeAllConnections?.(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let j: any = t;
    try { j = JSON.parse(t); } catch { /* text */ }
    return { status: r.status, body: j, text: t };
  };
  const a = (await call('POST', '/api/setup', null, { username: 'wizard', password: 'correct horse battery' })).body;
  const admin = a.token as string;
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, admin, body);
    assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${r.text.slice(0, 300)}`);
    return r.body;
  };
  const world = async (name: string) => (await ok('POST', '/api/admin/worlds', { name, gmAccountId: a.account.id })).id as string;
  const addPlayer = async (wid: string) => {
    const inv = await ok('POST', `/api/worlds/${wid}/invites`, { role: 'player' });
    return (await call('POST', '/api/join', null, { code: inv.code, username: 'jess' + Math.random().toString(36).slice(2, 6), password: 'player pass 123', characterName: 'Jess' })).body.token as string;
  };
  const sd = () => ({ db: made.deps.db, library: made.deps.library, dataDir: null, vaultsDir: null, fetch: fake, env: { ALX_CRAWL_RATE: '0' } as Record<string, string | undefined>, mcp: fakeMcp });
  return { ...made, call, ok, admin, world, addPlayer, sd };
}
type T = Awaited<ReturnType<typeof boot>>;

const MCP_CONFIG = {
  transport: 'mcp', mcpUrl: 'http://mcp.test/mcp', tool: 'list_articles', itemsPath: 'items', idField: 'id', titleField: 'title', summaryField: 'summary',
  visibilityField: 'private', sharedValues: 'false', updatedField: 'updated', bodyField: 'body',
};
async function mcpWorld(t: T, extra: Record<string, unknown> = {}) {
  const conn = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'World app over MCP', config: { ...MCP_CONFIG, ...extra } });
  const wid = await t.world('MCP World');
  const src = await t.ok('POST', `/api/admin/worlds/${wid}/sources`, { connectionId: conn.id, kind: 'api', name: 'Articles', config: {}, defaultVisibility: 'party' });
  const sync = (body: unknown = {}) => t.ok('POST', `/api/admin/sources/${src.id}/sync?wait=1`, body);
  return { wid, sid: src.id as string, conn, sync };
}
const DETAIL = { detailTool: 'get_article', detailIdArg: 'id', detailIdType: 'number', detailItemPath: 'data' };
const pid = (t: T, wid: string, title: string) => (t.deps.library.list(wid, gmViewer) as any[]).find((p) => p.title === title).id as string;
const getPage = (t: T, wid: string, token: string, id: string) => t.call('GET', `/api/worlds/${wid}/library/pages/${id}`, token);
const depthOf = (t: T, wid: string, title: string) => one<any>(t.deps.db, 'SELECT depth FROM pages WHERE world_id = ? AND title = ?', wid, title)?.depth as string;
const readCalls = () => mcp.calls.filter((c) => c.tool === 'get_article');

// ---- setup: the tools are guessed ---------------------------------------------------------------------------------------

test('CrawlMcp_ListAndReadToolsAreGuessedFromToolNamesAndSchemas', async () => {
  const g = guessMcpTools(TOOLS);
  assert.equal(g.listTool?.name, 'list_articles');
  assert.deepEqual(g.detailTools.map((d) => [d.name, d.idArg, d.idType]), [['get_article', 'id', 'number']], 'only a tool that reads one record from an id; never create_ or delete_, nor a read with no id');
  assert.ok(g.detailTools[0].confidence >= 0.8, 'the noun matches the list tool');
  const none = guessMcpTools([{ name: 'list_things', inputSchema: { type: 'object', properties: {} } }]);
  assert.equal(none.detailTools.length, 0);
  assert.ok(none.notes.some((n) => /leave the read tool blank/.test(n)));
  const slug = guessMcpTools([{ name: 'list_pages' }, { name: 'fetch_page', inputSchema: { type: 'object', properties: { slug: { type: 'string' }, project: { type: 'string' } }, required: ['slug', 'project'] } }]);
  assert.deepEqual([slug.detailTools[0].name, slug.detailTools[0].idArg], ['fetch_page', 'slug']);
  assert.ok(slug.detailTools[0].confidence < 0.9, 'a required argument we have no value for makes it less sure');

  const t = await boot();
  const found = await t.ok('POST', '/api/admin/connections/mcp-discover', { config: { mcpUrl: 'http://mcp.test/mcp' } });
  assert.equal(found.listTool.name, 'list_articles');
  assert.equal(found.detailTools[0].name, 'get_article');
  assert.equal((await t.call('POST', '/api/admin/connections/mcp-discover', null, { config: { mcpUrl: 'http://mcp.test/mcp' } })).status, 401);
  assert.equal((await t.call('POST', '/api/admin/connections/mcp-discover', t.admin, { config: {} })).status, 400);
  assert.equal(mcp.calls.length, 0, 'listing tools calls no tool');
});

test('CrawlMcp_ReadToolMustBeAReadTool', async () => {
  const t = await boot();
  const make = async (extra: Record<string, unknown>) => {
    const conn = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'Bad ' + Math.random(), config: { ...MCP_CONFIG, ...extra } });
    return t.call('POST', `/api/admin/worlds/${await t.world('W' + Math.random())}/sources`, t.admin, { connectionId: conn.id, kind: 'api', name: 'Bad', config: {} });
  };
  const bad = await make({ detailTool: 'delete_article' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /only reads/);
  assert.equal((await make({ detailTool: 'get article; drop' })).status, 400);
  assert.equal((await make({ detailTool: 'get_article', detailArgs: '[1]' })).status, 400);
  assert.equal((await make({ detailTool: 'get_article', detailIdArg: 'id; x' })).status, 400);
  assert.equal((await make({ detailTool: 'get_article' })).status, 201);
});

// ---- tier 1: the list tool only -------------------------------------------------------------------------------------------

test('CrawlMcp_TheListToolMakesTheIndexAndNoPageIsReadYet', async () => {
  const t = await boot();
  const w = await mcpWorld(t, DETAIL);
  const out = await w.sync();
  assert.deepEqual(mcp.calls.map((c) => c.tool), ['list_articles'], 'one list call, no read');
  assert.equal(out.stats.indexCalls, 1);
  assert.equal(out.stats.detailCalls, 0);
  assert.equal(depthOf(t, w.wid, 'The Harbour'), 'summary', 'an excerpt came with the list');
  assert.equal(depthOf(t, w.wid, 'Unmarked Note'), 'index', 'nothing but the title');
  assert.ok(!one<any>(t.deps.db, 'SELECT body FROM pages WHERE world_id = ? AND title = ?', w.wid, 'The Harbour').body.includes('HARBOURBODY'));
  // Visibility fails closed: the list's own flag, and no flag means GM-only.
  const vis = (title: string) => one<any>(t.deps.db, 'SELECT visibility FROM pages WHERE world_id = ? AND title = ?', w.wid, title).visibility;
  assert.deepEqual(['The Harbour', 'The Vault', 'Unmarked Note'].map(vis), ['party', 'gm', 'gm']);
  const tok = await t.addPlayer(w.wid);
  const titles = ((await t.call('GET', `/api/worlds/${w.wid}/library/pages`, tok)).body as any[]).map((p) => p.title).sort();
  assert.deepEqual(titles, ['Second Quay', 'The Harbour']);
  // The detail tier is on the world page's tier line.
  const tiers = await t.ok('GET', `/api/admin/connections/tiers/world/${w.wid}`);
  assert.equal(tiers[0].tiered, true);
  assert.equal(tiers[0].pages, 4);
});

// ---- tier 3: on demand and in the background -------------------------------------------------------------------------------

test('CrawlMcp_OpeningAPageReadsItThroughTheReadToolAndNothingGmOnlyReachesAPlayer', async () => {
  const t = await boot();
  const w = await mcpWorld(t, DETAIL);
  await w.sync();
  const tok = await t.addPlayer(w.wid);
  mcp.calls = [];
  const harbour = await getPage(t, w.wid, tok, pid(t, w.wid, 'The Harbour'));
  assert.equal(harbour.status, 200);
  assert.ok(harbour.text.includes('HARBOURBODY'), 'a player opening a shared page reads it in full');
  assert.deepEqual(readCalls().map((c) => c.args), [{ id: 1 }], 'one read, the id as a number');
  assert.equal(depthOf(t, w.wid, 'The Harbour'), 'full');
  // Opened again: no second read.
  await getPage(t, w.wid, tok, pid(t, w.wid, 'The Harbour'));
  assert.equal(readCalls().length, 1);
  // The GM-only page: asking for it may read it (that is how a page's visibility becomes known), but the player gets nothing of it.
  const vault = await getPage(t, w.wid, tok, pid(t, w.wid, 'The Vault'));
  assert.equal(vault.status, 404);
  assert.ok(!vault.text.includes('VAULTBODY'));
  // The body is the GM's alone, in the page, in search and in the player copy.
  const gm = await getPage(t, w.wid, t.admin, pid(t, w.wid, 'The Vault'));
  assert.ok(gm.text.includes('VAULTBODY'));
  assert.equal(one<any>(t.deps.db, 'SELECT visibility FROM pages WHERE world_id = ? AND title = ?', w.wid, 'The Vault').visibility, 'gm');
  assert.equal(one<any>(t.deps.db, 'SELECT player_body FROM pages WHERE world_id = ? AND title = ?', w.wid, 'The Vault').player_body, null);
  for (const q of ['VAULTBODY', 'dragon']) assert.ok(!(await t.call('GET', `/api/worlds/${w.wid}/library/search?q=${q}`, tok)).text.includes('VAULTBODY'));
  // A page whose read has no visibility flag stays GM-only, read or not.
  const note = await getPage(t, w.wid, t.admin, pid(t, w.wid, 'Unmarked Note'));
  assert.ok(note.text.includes('UNMARKEDBODY'));
  assert.equal(depthOf(t, w.wid, 'Unmarked Note'), 'full');
  assert.equal(one<any>(t.deps.db, 'SELECT visibility FROM pages WHERE world_id = ? AND title = ?', w.wid, 'Unmarked Note').visibility, 'gm');
  assert.equal((await getPage(t, w.wid, tok, pid(t, w.wid, 'Unmarked Note'))).status, 404);
  // No write tool was ever called.
  assert.ok(!mcp.calls.some((c) => /create|delete/.test(c.tool)));
});

test('CrawlMcp_ASearchByTheGmReadsItsBestHitsAndAFailedReadLeavesTheIndexLine', async () => {
  const t = await boot();
  const w = await mcpWorld(t, DETAIL);
  await w.sync();
  mcp.calls = [];
  const found = await t.call('GET', `/api/worlds/${w.wid}/library/search?q=Quay`, t.admin);
  assert.equal(found.status, 200);
  assert.ok(readCalls().length >= 1, 'a GM search reads its top hits');
  assert.equal(depthOf(t, w.wid, 'Second Quay'), 'full');
  // The server is failing: the page opens as the index line, still GM-only for others, and nothing is thrown at the reader.
  mcp.failGet = true;
  const failed = await getPage(t, w.wid, t.admin, pid(t, w.wid, 'The Harbour'));
  assert.equal(failed.status, 200);
  assert.ok(!failed.text.includes('HARBOURBODY'));
  assert.equal(depthOf(t, w.wid, 'The Harbour'), 'summary');
});

test('CrawlMcp_TheBackgroundReaderSpendsItsBudgetOnWantedPagesFirstThenEverythingWhenAsked', async () => {
  const t = await boot();
  const w = await mcpWorld(t, DETAIL);
  await w.sync();
  mcp.calls = [];
  // Nothing was asked for and "fetch everything" is off: nothing is read.
  await detailTick(t.sd(), { at: Date.now() });
  assert.equal(readCalls().length, 0);
  // A page somebody opened is read, the rest are not.
  await getPage(t, w.wid, t.admin, pid(t, w.wid, 'Second Quay'));
  assert.deepEqual(readCalls().map((c) => c.args.id), [4]);
  await t.ok('PATCH', `/api/admin/connections/tiers/${w.sid}`, { budget: 60, fetchAll: true });
  const tick = await detailTick(t.sd(), { at: Date.now() + 60_000 });
  assert.equal(tick[0].read, 3, 'the other three pages');
  assert.deepEqual(readCalls().map((c) => c.args.id).sort(), [1, 2, 3, 4], 'each page was read once');
  assert.equal(depthCounts(t.deps.db, w.sid).full, 4);
  // Done: the switch turns itself off and no more reads follow.
  await detailTick(t.sd(), { at: Date.now() + 120_000 });
  assert.equal(readCalls().length, 4);
  assert.equal(one<any>(t.deps.db, 'SELECT fetch_all FROM connections_source_state WHERE source_id = ?', w.sid).fetch_all, 0);
  assert.equal(one<any>(t.deps.db, 'SELECT detail_calls AS n FROM connections_source_state WHERE source_id = ?', w.sid).n, 4, 'reads are accounted');
});

test('CrawlMcp_WithNoReadToolTheListIsAllThereIsAndNoReadIsEverMade', async () => {
  const t = await boot();
  const w = await mcpWorld(t, {});
  await w.sync();
  await getPage(t, w.wid, t.admin, pid(t, w.wid, 'The Harbour'));
  await t.call('GET', `/api/worlds/${w.wid}/library/search?q=Harbour`, t.admin);
  await detailTick(t.sd(), { at: Date.now() });
  assert.deepEqual([...new Set(mcp.calls.map((c) => c.tool))], ['list_articles']);
  assert.equal(all<any>(t.deps.db, `SELECT 1 FROM pages WHERE world_id = ? AND depth <> 'full'`, w.wid).length, 0, 'every page counts as read: there is nothing deeper');
});
