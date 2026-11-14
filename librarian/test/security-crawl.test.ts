// The leak crawler (docs/SECURITY.md). One world with a unique marker at every
// secret spot; then every route, live event, MCP tool, search and file is read
// as each kind of viewer, and a recording fake stands in for every model.
//
//   1. DM-only, broker and classified markers never reach a player.
//   2. A player's private marker never reaches another player or the DM.
//   3. The party chat marker never reaches the DM.
//   4. A classified marker never reaches any model request or MCP response.
//
// Routes are found by walking the Express router stack, so a new route is
// crawled with no change here. A new secret is covered by adding a marker in
// security-world.ts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.ts';
import { all } from '../src/core/db.ts';
import { toolsFor } from '../src/routes/mcpServer.ts';
import {
  EventTap, MODEL_ENV, MODEL_HOST, baseOf, hay, noteRead, readBy, classifiedIn, client, fakeModels, leaksFor, listRoutes, markers, recordMounts, tok, txt,
  type Marker, type RouteDef, type Who,
} from './security-kit.ts';
import { makeAccounts, seedContent, type Seed } from './security-world.ts';

recordMounts();

let server: any;
let tmp = '';
let deps: any;
let S: Seed;
let routes: RouteDef[] = [];
const taps: Record<string, EventTap> = {};
const models = fakeModels(fetch);
const http = client(() => baseOf(server));
const { call } = http;
const CALLER_MODEL = { 'X-Alexandria-Caller': 'model' };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-sec-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: models.fetch, env: { ...MODEL_ENV, ALX_RATE_LIMIT: '0' } });
  deps = made.deps;
  routes = listRoutes(made.app);
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const h = { ...http, deps };
  S = await makeAccounts(h);
  // Live streams are open before anything is seeded, so every event of the seeding is captured.
  for (const who of ['dm', 'jess', 'tom', 'guest'] as const) taps[who] = new EventTap(`${baseOf(server)}/api/worlds/${S.W}/events`, S.T[who]);
  await new Promise((r) => setTimeout(r, 100));
  await seedContent(h, S);
  await new Promise((r) => setTimeout(r, 150));
});

after(async () => {
  for (const t of Object.values(taps)) await t.close();
  server?.close();
  server?.closeAllConnections?.();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- the crawler ---------------------------------------------------------------------------------

const SPEC: Record<string, string> = {
  'library:id': 'SELECT id FROM pages WHERE world_id = ? UNION SELECT path FROM pages WHERE world_id = ?',
  'requests:id': 'SELECT id FROM requests WHERE world_id = ?',
  'messages:tid': 'SELECT id FROM threads WHERE world_id = ?',
  'quick-events:eid': 'SELECT id FROM quick_events WHERE world_id = ?',
  'calendar:sid': 'SELECT id FROM cal_sessions WHERE world_id = ?',
  'calendar:rid': 'SELECT id FROM cal_reschedules',
  'live:cid': 'SELECT id FROM combatants WHERE world_id = ?',
  'inventory:iid': 'SELECT id FROM items WHERE world_id = ?',
  'inventory:uid': 'SELECT id FROM uploads WHERE world_id = ?',
  'inventory:rid': 'SELECT id FROM coin_requests WHERE world_id = ?',
  'map:mapId': "SELECT 'world'",
  'map:mid': 'SELECT id FROM map_marks WHERE world_id = ?',
  '*:aid': 'SELECT account_id FROM members WHERE world_id = ?',
  '*:pid': 'SELECT id FROM people WHERE world_id = ?',
  '*:bid': 'SELECT id FROM profile_blocks WHERE world_id = ?',
  'whiteboard:v': 'SELECT 1 UNION SELECT 2',
  'broker:id': 'SELECT id FROM broker_requests WHERE world_id = ?',
  'broker:nid': 'SELECT id FROM broker_notes WHERE world_id = ?',
  'broker:pid': 'SELECT id FROM pages WHERE world_id = ?',
  'broker:oid': 'SELECT id FROM broker_offers WHERE world_id = ?',
  'approvals:id': 'SELECT id FROM item_changes WHERE world_id = ?',
  'agent:id': 'SELECT id FROM agent_chats WHERE world_id = ? UNION SELECT id FROM agent_actions WHERE world_id = ?',
  'agent:pageId': 'SELECT id FROM pages WHERE world_id = ?',
  'audio:sid': 'SELECT id FROM audio_sessions WHERE world_id = ?',
  'audio:id': 'SELECT id FROM audio_mics WHERE world_id = ? UNION SELECT id FROM audio_lines WHERE world_id = ?',
  'clock:id': 'SELECT id FROM clock_events WHERE world_id = ? UNION SELECT id FROM clock_log WHERE world_id = ?',
  'intake:sid': 'SELECT id FROM sources WHERE world_id = ?',
  'intake:kid': 'SELECT id FROM intake_keys WHERE world_id = ?',
  'itemcards:itemId': 'SELECT id FROM items WHERE world_id = ?',
  'sculpt:id': 'SELECT id FROM sculpt_templates WHERE world_id = ?',
  'sessionchat:mid': 'SELECT id FROM sessionchat_messages WHERE world_id = ?',
  'sessionchat:tid': 'SELECT id FROM sessionchat_trades WHERE world_id = ?',
  'sessionlog:id': 'SELECT id FROM sessionlog_drafts WHERE world_id = ? UNION SELECT id FROM sessionlog_entries WHERE world_id = ?',
  'sound:id': 'SELECT id FROM sound_scenes WHERE world_id = ? UNION SELECT id FROM sound_pads WHERE world_id = ?',
  'stage:cid': 'SELECT id FROM stage_cards WHERE world_id = ?',
  'stage:uid': 'SELECT id FROM stage_images WHERE world_id = ?',
  'voice:id': 'SELECT id FROM voice_presets WHERE world_id = ?',
  'worldlore:id': "SELECT id FROM pages WHERE world_id = ? AND path LIKE 'WorldLore/%'",
  '*:kind': "SELECT 'music' UNION SELECT 'ambience' UNION SELECT 'sfx'",
  '*:channel': "SELECT 'table' UNION SELECT 'party'",
  '*:source': "SELECT 'library' UNION SELECT 'x'",
};

/** Real ids for a path parameter, plus one that does not exist. */
function pool(ns: string, param: string): string[] {
  const sql = SPEC[`${ns}:${param}`] ?? SPEC[`*:${param}`];
  if (!sql) return ['x'];
  try {
    const n = (sql.match(/\?/g) ?? []).length;
    const rows = all<any>(deps.db, sql, ...Array(n).fill(S.W));
    return [...new Set([...rows.map((r) => String(Object.values(r)[0])), 'x'])].slice(0, 120);
  } catch { return ['x']; }
}

/** Query strings a route takes (the crawl asks each way, and without any). */
function queries(p: string): string[] {
  const words = ['harbour', 'vault', 'council', 'smuggler', 'lighthouse', 'zqx', 'secret', 'Ambusher', 'Goblin', 'Odda', 'classified'];
  const owners = ['me', 'party', S.ID.jess, S.ID.tom, S.ID.dm].map((o) => `?owner=${o}`);
  if (/\/(inventory|live\/ledger)\/?$/.test(p)) return owners;
  if (/\/library\/search$/.test(p)) return words.flatMap((w) => [`?q=${w}`, `?q=${w}&semantic=1`]);
  if (/\/search\/?$/.test(p)) return words.map((w) => `?q=${w}&kinds=page,person,term,transcript,log,item&limit=50`);
  if (/\/(modules\/terms|modules\/rules\/search)$/.test(p)) return words.map((w) => `?q=${w}`);
  if (/\/broker\/quote$/.test(p)) return words.map((w) => `?question=${w}%20and%20the%20${w}&length=full`);
  if (/\/sessionchat\/chat\/:channel$/.test(p)) return all<any>(deps.db, 'SELECT id FROM sessionchat_sessions WHERE world_id = ?', S.W).map((x) => `?session=${x.id}`);
  if (/\/agent\/transcript$/.test(p)) return [...words.map((w) => `?q=${w}`), '?session=ses_crawl'];
  if (/\/audio\/sessions\/:sid\/lines$/.test(p)) return ['?since=1970-01-01'];
  if (/\/quickgen\/items$/.test(p)) return ['?rarity=rare&count=30', '?type=weapon&count=30'];
  return [];
}

/** Concrete URLs for a route: every real id of each parameter. */
function urlsFor(r: RouteDef, world = S.W): string[] {
  const m = /^\/api\/worlds\/:world\/([^/]*)/.exec(r.path);
  const ns = m ? m[1] : '';
  let out = [r.path.replace(':world', world)];
  for (const param of [...new Set([...r.path.matchAll(/:(\w+)/g)].map((x) => x[1]))].filter((p) => p !== 'world')) {
    const vals = pool(ns, param);
    out = out.flatMap((u) => vals.map((v) => u.replaceAll(`:${param}`, encodeURIComponent(v)))).slice(0, 400);
  }
  return r.method === 'GET' ? out.flatMap((u) => [u, ...queries(r.path).map((q) => u + q)]) : out;
}

const PUBLIC_GET = [/^\/health$/, /^\/api\/setup$/, /^\/api\/admin-auth\/status$/, /^\/api\/media\//];
const SKIP_GET = [/\/events$/]; // live stream: read separately
const isAdminPath = (p: string) => /^\/api\/admin(-auth)?(\/|$)/.test(p);

interface Who2 { who: Who; token: string; label: string; headers?: Record<string, string> }
const viewers = (): Who2[] => [
  { who: 'jess', token: S.T.jess, label: 'jess session' },
  { who: 'jess', token: S.K.jessRead, label: 'jess read key' },
  { who: 'tom', token: S.T.tom, label: 'tom session' },
  { who: 'tom', token: S.K.tomRead, label: 'tom read key' },
  { who: 'guest', token: S.T.guest, label: 'guest session' },
  { who: 'guest', token: S.K.guestRead, label: 'guest read key' },
];

const ticketsIn = (text: string): string[] => [...text.matchAll(/\/api\/media\/(?:stage|sound|voice)\/([\w.-]+)/g)].map((m) => m[1]);
const ticketOwner = (t: string): string | null => { try { return JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString()).a ?? null; } catch { return null; } };

interface CrawlResult { leaks: string[]; requests: number; reached: Set<string> }

/** GET every route as one viewer and report markers that viewer must not see. */
async function crawlGets(v: Who2, check: (text: string) => Marker[] = (t) => leaksFor(v.who, t)): Promise<CrawlResult> {
  const out: CrawlResult = { leaks: [], requests: 0, reached: new Set() };
  const own = v.who === 'dm' ? S.ID.dm : S.ID[v.who as 'jess' | 'tom' | 'guest'];
  for (const r of routes.filter((x) => x.method === 'GET' && !SKIP_GET.some((re) => re.test(x.path)))) {
    for (const url of urlsFor(r)) {
      const res = await call('GET', url, v.token, undefined, v.headers);
      out.requests++;
      out.reached.add(`${r.method} ${r.path}`);
      if (!v.headers) noteRead(v.who, res.text);
      for (const m of check(res.text)) out.leaks.push(`${v.label}: GET ${url} (${res.status}) leaked "${m.id}" (${m.where})`);
      for (const t of ticketsIn(res.text)) if (ticketOwner(t) !== own) out.leaks.push(`${v.label}: GET ${url} handed out a media ticket made for another account`);
    }
  }
  return out;
}

const report = (leaks: string[]) => assert.equal(leaks.length, 0, `\n${[...new Set(leaks)].slice(0, 40).join('\n')}${leaks.length > 40 ? `\n... and ${leaks.length - 40} more` : ''}`);

// ---- the tests ---------------------------------------------------------------------------------------

test('TestSecurityCrawl_RoutesAreFoundAndMarkersSeeded', () => {
  assert.ok(routes.length > 250, `found ${routes.length} routes`);
  assert.ok(routes.some((r) => r.method === 'GET' && r.path === '/api/worlds/:world/library/pages/:id'));
  assert.ok(routes.some((r) => r.method === 'GET' && r.path === '/api/worlds/:world/stage/images/:uid'), 'feature routes are found too');
  assert.ok(Object.keys(markers).length > 90, `${Object.keys(markers).length} markers`);
  // Every marker is unique.
  const tokens = Object.values(markers).map((m) => m.token);
  assert.equal(new Set(tokens).size, tokens.length);
});

test('TestSecurityCrawl_CrawlerSeesWhatPlayersMaySee', async () => {
  // A crawl that finds nothing proves nothing: shared markers must show up where players read.
  const seen = (who: Who, token: string) => async (url: string) => (await call('GET', `/api/worlds/${S.W}${url}`, token)).text;
  for (const [who, token] of [['jess', S.T.jess], ['tom', S.T.tom]] as const) {
    const get = seen(who, token);
    const page = await get(`/library/pages/${S.pages.shared.id}`);
    assert.ok(page.includes(tok('public_page')), 'shared page text');
    assert.ok(!page.includes(tok('secret_block')));
    assert.ok((await get(`/library/pages/${S.pages.dm.id}`)).includes('Page not found'), 'a DM page is not found');
    assert.ok((await get('/whiteboard')).includes(tok('whiteboard_dm')));
    assert.ok((await get('/clock/events')).includes(tok('clock_party')));
    assert.ok((await get('/people')).includes(tok('quote_party')));
    assert.ok((await get('/sessionchat/chat/party')).includes(tok('chat_party')));
    assert.ok((await get('/sessionchat/chat/table')).includes(tok('chat_table')));
    assert.ok((await get(`/audio/sessions/ses_crawl/lines`)).includes(tok('transcript_public')));
  }
  assert.ok(taps.jess.text.includes(tok('chat_party')), 'live events reach the player');
  assert.ok(taps.dm.text.includes('event:'), 'the DM stream works');
  // The DM sees the DM side.
  const dmPage = await call('GET', `/api/worlds/${S.W}/library/pages/${S.pages.dm.id}`, S.T.dm);
  assert.ok(dmPage.text.includes(tok('dm_page')));
  const cls = await call('GET', `/api/worlds/${S.W}/library/pages/${S.pages.classified.id}`, S.T.dm);
  assert.ok(cls.text.includes(tok('classified_page')), 'the DM reads classified pages in the app');
  const asModel = await call('GET', `/api/worlds/${S.W}/library/pages/${S.pages.classified.id}`, S.T.dm, undefined, CALLER_MODEL);
  assert.equal(asModel.status, 404, 'a model does not');
});

test('TestSecurityCrawl_PlayersGetNoDmOrClassifiedContent', async () => {
  const leaks: string[] = [];
  let reached = new Set<string>();
  for (const v of viewers()) {
    const r = await crawlGets(v);
    leaks.push(...r.leaks);
    reached = new Set([...reached, ...r.reached]);
  }
  report(leaks);
  // Every GET route was requested (the world routes and the rest).
  const getRoutes = routes.filter((r) => r.method === 'GET' && !SKIP_GET.some((re) => re.test(r.path)));
  const missed = getRoutes.filter((r) => !reached.has(`GET ${r.path}`));
  assert.deepEqual(missed, []);
});

test('TestSecurityCrawl_PlayersCannotOpenAdminRoutes', async () => {
  for (const v of viewers()) {
    for (const r of routes.filter((x) => x.method === 'GET' && isAdminPath(x.path) && !PUBLIC_GET.some((re) => re.test(x.path)))) {
      for (const url of urlsFor(r)) {
        const res = await call('GET', url, v.token);
        assert.ok([401, 403, 404].includes(res.status), `${v.label} ${url} -> ${res.status}`);
      }
    }
  }
});

test('TestSecurityCrawl_PlayerPostsThatReturnData', async () => {
  const leaks: string[] = [];
  for (const v of viewers()) {
    const W = `/api/worlds/${S.W}`;
    if (v.label.includes('read key')) {
      // A read key cannot even ask: these POSTs are refused before anything is read.
      assert.equal((await call('POST', `${W}/library/pages/bulk`, v.token, { ids: S.ids.page })).status, 403);
      continue;
    }
    const sets: [string, string, unknown][] = [
      ['POST', `${W}/library/pages/bulk`, { ids: S.ids.page.slice(0, 500) }],
      ['POST', `${W}/modules/match`, { text: 'the harbour council and the sealed vault beneath the old lighthouse' }],
      ['POST', `${W}/broker/quote`, { question: 'Who secretly answers to the smuggler queen and what is in the vault under the lighthouse?', length: 'full' }],
      ['GET', `${W}/broker/quote?question=${encodeURIComponent('smuggler queen vault lighthouse')}&length=full`, undefined],
      ['POST', `${W}/quick-events/x/respond`, {}],
    ];
    for (const [method, url, body] of sets) {
      const res = await call(method, url, v.token, body);
      for (const m of leaksFor(v.who, res.text)) leaks.push(`${v.label}: ${method} ${url} (${res.status}) leaked "${m.id}"`);
    }
    // The bulk fetch (offline prefetch, and a way to ask for any id) only returns pages the viewer may open.
    const bulk = await call('POST', `${W}/library/pages/bulk`, v.token, { ids: S.ids.page });
    assert.ok(Array.isArray(bulk.json), `bulk -> ${bulk.status} ${bulk.text.slice(0, 200)}`);
    const got = (bulk.json as any[]).map((p) => p.id);
    assert.ok(got.includes(S.pages.shared.id));
    for (const k of ['dm', 'broker', 'classified']) assert.ok(!got.includes(S.pages[k].id), `${k} page in bulk`);
  }
  report(leaks);
});

/** Model calls that carry the crawler's own search words (a marker typed as a query), not anything the app chose to send. */
const exempt = new Set<object>();

test('TestSecurityCrawl_SearchNeverFindsASecretMarker', async () => {
  const startCalls = models.calls.length;
  const leaks: string[] = [];
  const W = `/api/worlds/${S.W}`;
  const words = Object.values(markers).flatMap((m) => [m.token, m.token.replace(/-/g, ' ')]);
  const queries = [...new Set([...words, 'zqx', 'vault lighthouse sealed bearers', 'smuggler queen'])];
  for (const v of [...viewers().filter((x) => !x.label.includes('read key')), { who: 'dm' as Who, token: S.T.dm, label: 'dm session' }]) {
    for (const q of queries) {
      for (const url of [`${W}/search?q=${encodeURIComponent(q)}&kinds=page,person,term,transcript,log,item&limit=50`, `${W}/library/search?q=${encodeURIComponent(q)}`, `${W}/library/search?q=${encodeURIComponent(q)}&semantic=1`, `${W}/modules/rules/search?q=${encodeURIComponent(q)}`]) {
        const res = await call('GET', url, v.token);
        // Search answers repeat the query: that is the asker's own text, not a leak.
        const echoed = res.json && typeof res.json === 'object' && !Array.isArray(res.json) ? JSON.stringify({ ...res.json, query: undefined, q: undefined }) : res.text;
        for (const m of leaksFor(v.who, echoed)) leaks.push(`${v.label}: ${url.slice(W.length, W.length + 60)} leaked "${m.id}"`);
      }
    }
  }
  for (const c of models.calls.slice(startCalls)) exempt.add(c);
  report(leaks);
});

test('TestSecurityCrawl_PlayersMcpEndpointLeaksNothing', async () => {
  const leaks: string[] = [];
  const rpc = async (key: string, method: string, params: unknown) => (await call('POST', '/mcp', key, { jsonrpc: '2.0', id: 1, method, params })).json;
  const argsFor = (props: Record<string, any>, pageRef: string): Record<string, unknown> => {
    const a: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(props)) {
      if (/^(page|pageId|ref)$/.test(k)) a[k] = pageRef;
      else if (/query|question|text|name|topic/i.test(k)) a[k] = 'harbour council vault lighthouse smuggler';
      else if (k === 'owner') a[k] = 'me';
      else if (p?.type === 'integer' || p?.type === 'number') a[k] = 3;
      else if (p?.type === 'boolean') a[k] = false;
      else if (p?.type === 'array') a[k] = [];
      else if (p?.type === 'object') a[k] = {};
      else a[k] = 'x';
    }
    return a;
  };
  for (const [who, key] of [['jess', S.K.jessRead], ['tom', S.K.tomRead]] as const) {
    const tools = toolsFor(false).filter((t) => !t.playerOnly || true);
    const listed = (await rpc(key, 'tools/list', {})).result.tools.map((t: any) => t.name);
    for (const t of tools) if (!t.write) assert.ok(listed.includes(t.name) || t.playerOnly, `${t.name} is listed`);
    assert.ok(!listed.some((n: string) => toolsFor(true).find((t) => t.name === n)?.write), 'no write tool for a read key');
    for (const name of listed) {
      const tool = toolsFor(false).find((t) => t.name === name)!;
      // Every page the viewer could ask for: all page ids and paths in the world.
      const refs = /page|read/.test(name) ? S.ids.page : ['x'];
      for (const ref of refs) {
        const r = await rpc(key, 'tools/call', { name, arguments: argsFor(tool.props, ref) });
        for (const m of leaksFor(who, JSON.stringify(r))) leaks.push(`${who} mcp ${name}(${ref.slice(0, 30)}) leaked "${m.id}"`);
      }
    }
    // A write tool is refused, whatever the client sends.
    const w = await rpc(key, 'tools/call', { name: 'save_page', arguments: { path: 'x/y', markdown: 'hello' } });
    assert.ok(w.error || w.result?.isError, 'save_page is refused for a read key');
  }
  report(leaks);
});

test('TestSecurityCrawl_PlayersOfflinePrefetchLeaksNothing', async () => {
  // web/src/lib/prefetch.ts: the screens it walks, then every visible library page.
  const src = fs.readFileSync(path.join(import.meta.dirname, '../../web/src/lib/prefetch.ts'), 'utf8');
  const literal = [...src.matchAll(/get\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(literal.length >= 8, 'found the literal prefetch routes');
  const screens = ['', '/members', '/library/pages', '/library/relations', '/requests', '/messages', '/quick-events', '/calendar', '/people', '/profiles/me', '/whiteboard', '/live', '/live/ledger?owner=me', '/live/ledger?owner=party', '/inventory?owner=me', '/inventory?owner=party', '/map/world/marks', ...literal];
  const leaks: string[] = [];
  for (const v of viewers()) {
    for (const s of screens) {
      const res = await call('GET', `/api/worlds/${S.W}${s}`, v.token);
      for (const m of leaksFor(v.who, res.text)) leaks.push(`${v.label}: prefetch ${s} leaked "${m.id}"`);
    }
    const list = (await call('GET', `/api/worlds/${S.W}/library/pages`, v.token)).json as any[];
    const ids = list.map((p) => p.id);
    for (const k of ['dm', 'broker', 'classified']) assert.ok(!ids.includes(S.pages[k].id), `${k} page is listed for a player`);
    const bulk = await call('POST', `/api/worlds/${S.W}/library/pages/bulk`, v.token, { ids });
    for (const m of leaksFor(v.who, bulk.text)) leaks.push(`${v.label}: prefetch bulk leaked "${m.id}"`);
  }
  report(leaks);
});

test('TestSecurityCrawl_PlayersFilesAndMediaLeakNothing', async () => {
  const W = `/api/worlds/${S.W}`;
  const cardsOf = async (token: string) => (await call('GET', `${W}/stage`, token)).json?.cards ?? [];
  // A stage picture that is not shown: a player gets nothing, with a ticket or without.
  const img = S.ids.stageimage[0];
  for (const who of ['jess', 'tom'] as const) {
    const direct = await call('GET', `${W}/stage/images/${img}`, S.T[who]);
    assert.equal(direct.status, 404);
    assert.ok(!direct.text.includes(tok('stage_image')));
    // A ticket the DM holds does not open it for a player, and a made-up one opens nothing.
    assert.equal((await call('GET', `/api/media/stage/${'a'.repeat(20)}.${'b'.repeat(20)}`)).status, 404);
  }
  // The DM can fetch it, and a ticket the DM holds fetches it for whoever holds it: tickets are for one account, so players are never handed one.
  const dmView = await cardsOf(S.T.dm);
  const ticketed = JSON.stringify(dmView).match(/\/api\/media\/stage\/([\w.-]+)/);
  assert.ok(ticketed, 'the DM stage view has a picture ticket');
  assert.equal(ticketOwner(ticketed![1]), S.ID.dm);
  for (const who of ['jess', 'tom'] as const) {
    const cards = JSON.stringify(await cardsOf(S.T[who]));
    for (const m of leaksFor(who, cards)) assert.fail(`${who} stage view leaked ${m.id}`);
    for (const t of ticketsIn(cards)) assert.equal(ticketOwner(t), S.ID[who], 'a player only gets tickets made for them');
  }
  // Item pictures belong to their item's owner.
  const itemImg = S.ids.image[0];
  assert.equal((await call('GET', `${W}/inventory/images/${itemImg}`, S.T.jess)).status, 200);
  const other = await call('GET', `${W}/inventory/images/${itemImg}`, S.T.tom);
  assert.equal(other.status, 404);
  assert.ok(!other.text.includes(tok('item_image')));
  // Sound and voice files: a player gets none until the DM sends them.
  for (const who of ['jess', 'tom'] as const) {
    for (const u of [`${W}/sound/file/music/x`, `${W}/sound/file/sfx/x`, `${W}/voice/file/x.mp3`, `${W}/sound/file/music/x/ticket`, `${W}/voice/file/x.mp3/ticket`]) {
      const res = await call('GET', u, S.T[who]);
      assert.ok(res.status >= 400, `${u} -> ${res.status}`);
    }
  }
});

test('TestSecurityCrawl_DmNeverSeesPartyChatOrAnotherPlayersPrivateNotes', async () => {
  const leaks: string[] = [];
  for (const v of [{ who: 'dm' as Who, token: S.T.dm, label: 'dm session' }, { who: 'dm' as Who, token: S.K.dmRead, label: 'dm read key' }, { who: 'dm' as Who, token: S.K.dmWrite, label: 'dm write key' }, { who: 'dm' as Who, token: S.T.dm, label: 'dm session as a model', headers: CALLER_MODEL }]) {
    const r = await crawlGets(v);
    leaks.push(...r.leaks);
    // The party chat is refused outright.
    assert.equal((await call('GET', `/api/worlds/${S.W}/sessionchat/chat/party`, v.token, undefined, v.headers)).status, 403);
  }
  // Through MCP too: the DM's write key can read tools but the party chat tool is for players only.
  const tools = (await call('POST', '/mcp', S.K.dmWrite, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json.result.tools.map((t: any) => t.name);
  assert.ok(!tools.includes('read_party_chat'));
  for (const name of tools) {
    const tool = toolsFor(true).find((t) => t.name === name)!;
    if (tool.write) continue;
    const args: Record<string, unknown> = {};
    for (const k of tool.required ?? []) args[k] = 'harbour';
    const res = await call('POST', '/mcp', S.K.dmWrite, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    for (const m of leaksFor('dm', JSON.stringify(res.json))) leaks.push(`dm mcp ${name} leaked "${m.id}"`);
  }
  report(leaks);
});

// ---- the AI crawler ------------------------------------------------------------------------------------------------

/** Wait until the agent has finished the reply in a chat. */
async function agentAnswer(token: string, chatId: string, body: unknown) {
  const W = `/api/worlds/${S.W}`;
  const r = await call('POST', `${W}/agent/chats/${chatId}/messages`, token, body);
  assert.ok(r.status < 300, `agent message -> ${r.status} ${r.text.slice(0, 200)}`);
  for (let i = 0; i < 100; i++) {
    const c = (await call('GET', `${W}/agent/chats/${chatId}`, token)).json;
    const last = c?.messages?.[c.messages.length - 1];
    if (last && last.role === 'assistant' && last.status !== 'working') return c;
    await new Promise((r2) => setTimeout(r2, 50));
  }
  throw new Error('the agent did not finish');
}

test('TestSecurityAI_NoModelRequestOrMcpAnswerHasClassifiedContent', async () => {
  const W = `/api/worlds/${S.W}`;
  const dm = (m: string, u: string, b?: unknown) => call(m, `${W}${u}`, S.T.dm, b);
  const pageIds = S.ids.page;
  models.plan.tools = (offered) => [
    { name: 'search_library', args: { query: 'vault lighthouse sealed harbour council' } },
    { name: 'search_world', args: { query: 'vault lighthouse sealed bearers' } },
    ...pageIds.map((p) => ({ name: 'read_page', args: { page: p } })),
    { name: 'list_pages', args: {} }, { name: 'get_live', args: {} }, { name: 'list_people', args: {} }, { name: 'get_combat', args: {} },
    { name: 'search_transcript', args: { query: '' } }, { name: 'list_relations', args: {} },
    { name: 'add_person', args: { name: 'Ferryman' } },
    ...(offered.includes('make_statblock') ? [{ name: 'make_statblock', args: { pageId: S.pages.classified.id } }] : []),
  ];

  // The players' own assistants first: what they are sent must hold nothing that player may not see.
  const seedCalls = models.calls.slice();
  const c0 = models.calls.length;
  await agentAnswer(S.T.jess, S.ids.agentchat[1], { text: 'What do I know about the harbour council and the vault under the lighthouse? Check my notes on the people I met.', page: S.pages.shared.id });
  const jessCalls = models.calls.slice(c0);
  const c1 = models.calls.length;
  const q = await call('POST', `${W}/broker/quote`, S.T.tom, { question: 'What does the lighthouse keeper know about the vault?', length: 'full' });
  assert.ok(q.status < 500, q.text);
  const tomCalls = models.calls.slice(c1);
  const dmStart = models.calls.length;

  // 1. The DM agent: prefetch and tools, with the classified page on screen and its words selected and asked about.
  const chat = S.ids.agentchat[0];
  const asks = [
    { text: 'What is under the old lighthouse? Search the library and read the vault page, list people and check combat.', page: S.pages.classified.path },
    { text: 'Who are the harbour council and what do the sealed vault bearers know? Read the page.', page: S.pages.classified.id, selection: txt('classified_page') },
    { text: 'Summarise the harbour council for me.', page: S.pages.shared.id, selection: 'The harbour is run by a council of seven captains.' },
  ];
  for (const a of asks) await agentAnswer(S.T.dm, chat, a);

  // 2. Sculpting: every template.
  const templates = (await dm('GET', '/sculpt/templates')).json.templates;
  assert.ok(templates.length >= 5, 'built-in templates');
  for (const t of templates) {
    const r = await dm('POST', '/sculpt/run', { templateId: t.id, values: {} });
    assert.ok(r.status < 500, `sculpt ${t.name} -> ${r.status} ${r.text.slice(0, 200)}`);
  }

  // 3. The session log: draft and revise.
  const draft = await dm('POST', '/sessionlog/drafts', { audioSessionId: 'ses_crawl', title: 'Again' });
  assert.ok(draft.status < 300, draft.text);
  const rev = await dm('POST', `/sessionlog/drafts/${draft.json.id}/revise`, { instruction: 'Make it shorter and mention the harbour.' });
  assert.ok(rev.status < 300, rev.text);

  // 4. A statblock from a page (including the classified one), quick-gen flavour, the voice.
  for (const pageId of [S.pages.shared.id, S.pages.classified.id, S.pages.dm.id]) await dm('POST', '/agent/statblock', { pageId });
  await dm('POST', '/quickgen/flavour', { kind: 'item', text: 'A rare dagger from the harbour' });
  const preset = (await dm('GET', '/voice/presets')).json?.[0]?.id ?? (await dm('POST', '/voice/presets', { name: 'Narrator', voice: 'af_heart', speed: 1 })).json?.id;
  const spoken = await dm('POST', '/voice/speak', { text: 'Welcome to the harbour.', presetId: preset, target: 'table' });
  await dm('GET', '/quickgen/items?rarity=rare&count=20');

  // 5. The broker: routing and answering.
  await dm('POST', '/broker/classify', { question: 'What is in the vault under the old lighthouse?' });

  // 5b. A recorded chunk of the table: the transcription model is sent a prompt of names from the library.
  const mic = await dm('POST', '/audio/mics', { deviceId: 'dev-crawl', label: 'Crawl mic', mode: 'always' });
  assert.ok(mic.status < 300, mic.text);
  const rec = await dm('POST', '/audio/sessions', { name: 'Live crawl' });
  assert.ok(rec.status < 300, rec.text);
  const chunk = await call('POST', `${W}/audio/sessions/${rec.json.id}/chunks?mic=${mic.json.id}&seq=0&start=0&end=3000`, S.T.dm, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]), { 'Content-Type': 'audio/webm' });
  assert.ok(chunk.status < 300, `${chunk.status} ${chunk.text}`);
  await dm('POST', `/audio/sessions/${rec.json.id}/stop`, {});

  // 6. Embeddings: index every page.
  const re = await dm('POST', '/search/reindex');
  assert.ok(re.status < 300, re.text);
  await call('GET', `${W}/search?q=vault+lighthouse&kinds=page&semantic=1`, S.T.dm);
  await call('GET', `${W}/library/search?q=vault&semantic=1`, S.T.dm);

  // 7. MCP with a DM write key: every tool, with the classified page as its subject where it takes one.
  const mcpLeaks: string[] = [];
  const rpc = async (method: string, params: unknown) => (await call('POST', '/mcp', S.K.dmWrite, { jsonrpc: '2.0', id: 2, method, params })).text;
  for (const t of toolsFor(true)) {
    const refs = /page|read|statblock/.test(t.name) ? [...pageIds, 'WorldLore/Classified Lore.md'] : ['x'];
    for (const ref of refs) {
      const args: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(t.props) as [string, any][]) {
        if (/^(page|pageId|ref)$/.test(k)) args[k] = ref;
        else if (/query|question|topic/i.test(k)) args[k] = 'vault lighthouse sealed bearers harbour';
        else if (k === 'markdown') args[k] = '# Note\nA harmless note.';
        else if (k === 'path') args[k] = 'crawl/ai-note.md';
        else if (p?.type === 'integer' || p?.type === 'number') args[k] = 1;
        else if (p?.type === 'boolean') args[k] = false;
        else if (p?.type === 'array') args[k] = [];
        else if (p?.type === 'object') args[k] = {};
        else args[k] = k === 'owner' ? 'me' : 'x';
      }
      const text = await rpc('tools/call', { name: t.name, arguments: args });
      for (const m of classifiedIn(text)) mcpLeaks.push(`mcp ${t.name}(${ref.slice(0, 24)}) returned "${m.id}"`);
    }
  }
  // Every GET the DM could make as a model.
  const asModel = await crawlGets({ who: 'dm', token: S.T.dm, label: 'dm as a model', headers: CALLER_MODEL }, (t) => classifiedIn(t));
  mcpLeaks.push(...asModel.leaks);
  const asKey = await crawlGets({ who: 'dm', token: S.K.dmWrite, label: 'dm write key (mcp client)', headers: CALLER_MODEL }, (t) => classifiedIn(t));
  mcpLeaks.push(...asKey.leaks);

  // 8. Everything any model was sent.
  assert.ok(models.calls.length > 20, `${models.calls.length} model requests recorded`);
  const paths = new Set(models.calls.map((c) => c.path.replace(/^\/v1/, '')));
  for (const p of ['/chat/completions', '/embeddings', '/audio/speech', '/audio/transcriptions']) assert.ok(paths.has(p), `the crawl reached ${p}`);
  const sent: string[] = [];
  for (const c of models.calls.filter((x) => !exempt.has(x))) for (const m of classifiedIn(c.body)) sent.push(`model request ${c.path} carried "${m.id}"`);
  // The prompts do carry library content (so the check above means something).
  const inCalls = (calls: typeof models.calls, id: string) => calls.some((c) => hay(c.body).includes(tok(id).toLowerCase()));
  assert.ok(inCalls(models.calls.slice(dmStart), 'dm_page'), 'the DM agent is given DM pages');
  assert.ok(inCalls(jessCalls, 'public_page'), 'the player assistant is given shared pages');
  // What a player's assistant or the broker is sent holds nothing that player may not see; what the DM's is sent holds no player's private notes.
  for (const [who, calls] of [['jess', jessCalls], ['tom', tomCalls]] as const) for (const c of calls) for (const m of leaksFor(who, c.given)) sent.push(`${who}'s model request ${c.path} carried "${m.id}" (${m.where})`);
  for (const c of [...seedCalls, ...models.calls.slice(dmStart)].filter((x) => !x.path.endsWith('/embeddings'))) for (const m of leaksFor('dm', c.given)) sent.push(`a DM-side model request ${c.path} carried "${m.id}" (${m.where})`);
  report([...sent, ...mcpLeaks]);
});

test('TestSecurityAI_ClassifiedTextTypedByTheDmIsRefusedNotSent', async () => {
  const W = `/api/worlds/${S.W}`;
  const before = models.calls.length;
  const phrase = txt('classified_page');
  const dm = (m: string, u: string, b?: unknown) => call(m, `${W}${u}`, S.T.dm, b);
  const tries = [
    dm('POST', '/quickgen/flavour', { kind: 'item', text: phrase }),
    dm('POST', '/voice/speak', { text: phrase, presetId: (await dm('GET', '/voice/presets')).json?.[0]?.id, target: 'table' }),
    dm('POST', `/sessionlog/drafts/${S.ids.draft[0]}/revise`, { instruction: `Add this: ${phrase}` }),
    dm('POST', '/sculpt/run', { template: 'npc', values: { name: phrase } }),
    call('POST', `/v1/chat/completions`, S.T.dm, { messages: [{ role: 'user', content: phrase }] }),
    call('POST', `/v1/embeddings`, S.T.dm, { input: [phrase] }),
  ];
  for (const r of await Promise.all(tries)) assert.ok(r.status < 500 || r.status === 503, `refused cleanly: ${r.status} ${r.text.slice(0, 120)}`);
  assert.equal(models.calls.slice(before).filter((c) => c.body.includes(tok('classified_page'))).length, 0, 'nothing carrying classified text was sent');
  const rows = all<any>(deps.db, `SELECT detail FROM audit WHERE action = 'ai.classified_refused'`);
  assert.ok(rows.length >= 4, `${rows.length} refusals were audited`);
  for (const r of rows) assert.ok(!r.detail.includes(tok('classified_page')), 'the audit row holds no classified text');
});

// ---- who may do what ----------------------------------------------------------------------------------------------------

/**
 * Every route a player may legitimately call to change something (answer a quick event, move an item,
 * write a note...). Any other route that is not a read must refuse a player outright (401, 403 or 404):
 * a 400 or 409 would mean the handler ran before it asked who is calling. A new player route is added here
 * on purpose, in review; a new DM route needs nothing and is checked automatically.
 */
const PLAYER_ROUTES = [
  'DELETE /agent/chats/:id', 'DELETE /inventory/:iid', 'DELETE /live/presence', 'DELETE /map/:mapId/marks/:mid', 'DELETE /profiles/me/blocks/:bid', 'DELETE /sessionchat/messages/:mid',
  'PATCH /inventory/:iid', 'PATCH /map/:mapId/marks/:mid', 'PATCH /sessionchat/messages/:mid',
  'POST /agent/chats', 'POST /agent/chats/:id/messages', 'POST /agent/chats/:id/stop',
  'POST /approvals/:id/ack', 'POST /approvals/:id/dispute',
  'POST /audio/consent', 'POST /audio/mics', 'POST /audio/sessions/:sid/chunks', 'POST /audio/sessions/:sid/holds', 'DELETE /audio/mics/:id',
  'POST /broker/:id/accept', 'POST /broker/:id/decline', 'POST /broker/ask', 'POST /broker/offers/:oid/decline', 'POST /broker/offers/:oid/pay', 'POST /broker/quote',
  'POST /calendar/:sid/chat', 'POST /calendar/:sid/reschedule', 'PUT /calendar/:sid/rsvp',
  'POST /inventory/', 'POST /inventory/:iid/move', 'POST /inventory/coin-requests', 'POST /inventory/images', 'POST /inventory/coin/transfer', 'POST /inventory/transfers/seen',
  'POST /inventory/coin-requests/:rid/give', 'POST /inventory/coin-requests/:rid/decline', 'POST /inventory/coin-requests/:rid/cancel',
  'POST /library/pages/bulk', 'POST /live/ledger', 'POST /map/:mapId/marks', 'POST /messages/', 'POST /messages/:tid', 'POST /messages/:tid/keep', 'POST /messages/:tid/members',
  'POST /modules/match', 'POST /quick-events/:eid/respond', 'POST /requests/', 'POST /sessionchat/chat/:channel', 'POST /sessionchat/messages/:mid/react', 'POST /sessionchat/read',
  'POST /sessionchat/trades', 'POST /sessionchat/trades/:tid/accept', 'POST /sessionchat/trades/:tid/decline', 'POST /sessionchat/trades/:tid/cancel',
  'PUT /clock/prefs', 'PUT /itemcards/:itemId/page', 'PUT /live/presence', 'PUT /people/:pid/note', 'PUT /profiles/me/blocks', 'PUT /sound/me/switches', 'PUT /whiteboard/', 'POST /whiteboard/wipe',
  'POST /stage/cards/:cid/buy',
];
/** Routes outside a world that are for any signed-in person, or for no one signed in. */
const EVERYONE = /^(POST|PUT|DELETE) \/api\/(setup|auth\/(login|reset|logout)|join|me\/(theme|password)|keys(\/:id)?|admin-auth\/(login|logout)|media\/|intake\/)/;

test('TestSecurityAuth_PlayersCannotCallDmRoutes', async () => {
  const mine = new Set(PLAYER_ROUTES.map((x) => `${x.split(' ')[0]} /api/worlds/:world${x.split(' ')[1]}`));
  const writes = routes.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
  const have = new Set(writes.map((r) => `${r.method} ${r.path}`));
  const typos = [...mine].filter((x) => !have.has(x));
  assert.deepEqual(typos, [], 'every allowed player route exists');
  const bad: string[] = [];
  for (const v of [{ label: 'jess', token: S.T.jess }, { label: 'tom', token: S.T.tom }, { label: 'guest', token: S.T.guest }]) {
    for (const r of writes) {
      const key = `${r.method} ${r.path}`;
      if (mine.has(key) || EVERYONE.test(key) || /^(GET|POST|DELETE) \/(mcp|v1)/.test(key)) continue;
      for (const url of urlsFor(r).slice(0, 8)) {
        const res = await call(r.method, url, v.token, {});
        if (![401, 403, 404].includes(res.status)) bad.push(`${v.label}: ${r.method} ${url.replace(S.W, ':world')} -> ${res.status}`);
      }
    }
  }
  assert.deepEqual([...new Set(bad)], [], '\nA player got past a DM route (the handler ran instead of refusing):');
  // The routes players may call still work for a player with a real body: the list is not just stale.
  assert.equal((await call('PUT', `/api/worlds/${S.W}/live/presence`, S.T.jess, { location: 'Dock' })).status, 200);
});

test('TestSecurityAuth_OtherWorldsAreClosedToEveryone', async () => {
  const ids = all<any>(deps.db, 'SELECT id, path FROM pages WHERE world_id = ?', S.W2);
  assert.ok(ids.length >= 3);
  const bad: string[] = [];
  // Someone who is in one world gets nothing from another, whatever they ask for and with whatever key.
  const other = await http.ok('POST', '/api/keys', S.T.dm2, { scope: 'scribe', worldId: S.W2, label: 'w2 write', access: 'write' });
  for (const r of routes.filter((x) => x.path.startsWith('/api/worlds/:world/') && !/\/events$/.test(x.path))) {
    for (const [label, token, world] of [['dm of world 1 in world 2', S.T.dm, S.W2], ['jess in world 2', S.T.jess, S.W2], ['dm of world 2 in world 1', S.T.dm2, S.W], ['a key of world 2 in world 1', other.key, S.W], ['a key of world 1 in world 2', S.K.dmWrite, S.W2]] as const) {
      for (const url of urlsFor(r, world).slice(0, 3)) {
        const res = await call(r.method, url, token, r.method === 'GET' ? undefined : {});
        if (![401, 403, 404].includes(res.status)) bad.push(`${label}: ${r.method} ${url.replace(world, ':w')} -> ${res.status}`);
        for (const m of leaksFor(label.startsWith('dm of world 2') || label.startsWith('a key of world 2') ? 'dm2' : 'jess', res.text)) bad.push(`${label}: ${url} leaked ${m.id}`);
      }
    }
  }
  // A page of another world asked for by id or path in this world is not found, for the DM too.
  for (const p of ids) for (const ref of [p.id, p.path]) {
    const res = await call('GET', `/api/worlds/${S.W}/library/pages/${encodeURIComponent(ref)}`, S.T.dm);
    if (res.status !== 404) bad.push(`world 1 served page ${ref} of world 2 -> ${res.status}`);
  }
  assert.deepEqual(bad, []);
});

test('TestSecurityAuth_RevokedAndSignedOutCredentialsStopWorking', async () => {
  const W = `/api/worlds/${S.W}`;
  const k = await http.ok('POST', '/api/keys', S.T.jess, { scope: 'scribe', worldId: S.W, label: 'short lived', access: 'read' });
  assert.equal((await call('GET', `${W}/library/pages`, k.key)).status, 200);
  assert.equal((await call('POST', '/mcp', k.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 200);
  assert.equal((await call('DELETE', `/api/keys/${k.id}`, S.T.jess)).status, 200);
  assert.equal((await call('GET', `${W}/library/pages`, k.key)).status, 401);
  assert.equal((await call('POST', '/mcp', k.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  // Someone else cannot revoke it.
  const k2 = await http.ok('POST', '/api/keys', S.T.jess, { scope: 'scribe', worldId: S.W, label: 'mine', access: 'read' });
  assert.equal((await call('DELETE', `/api/keys/${k2.id}`, S.T.tom)).status, 404);
  assert.equal((await call('GET', `${W}/library/pages`, k2.key)).status, 200);
  // A key does not make keys, and a player cannot make an admin key.
  assert.equal((await call('POST', '/api/keys', k2.key, { scope: 'scribe', worldId: S.W, label: 'x', access: 'read' })).status, 403);
  assert.equal((await call('POST', '/api/keys', S.T.jess, { scope: 'admin', label: 'x' })).status, 403);
  // Signing out ends the session.
  const login = await http.ok('POST', '/api/auth/login', null, { username: 'jess', password: 'player pass 123' });
  assert.equal((await call('GET', `${W}/library/pages`, login.token)).status, 200);
  await call('POST', '/api/auth/logout', login.token);
  assert.equal((await call('GET', `${W}/library/pages`, login.token)).status, 401);
  // Garbage and the wrong kind of token.
  for (const t of ['', 'alx_ses_nope', 'alx_scr_nope', 'alx_adm_nope', 'alx_ads_nope', 'Bearer', 'null', S.push.key]) assert.ok([401, 403].includes((await call('GET', `${W}/library/pages`, t || undefined)).status), t);
});

test('TestSecurityAuth_ReadKeysCannotWrite', async () => {
  const bad: string[] = [];
  const writes = routes.filter((r) => r.method !== 'GET' && r.method !== 'HEAD' && !/^\/api\/(setup|auth\/login|auth\/reset|join|admin-auth\/login)/.test(r.path) && !/^\/api\/intake|^\/mcp|^\/api\/media/.test(r.path));
  for (const [label, key] of [['jess read key', S.K.jessRead], ['dm read key', S.K.dmRead]] as const) {
    for (const r of writes) for (const url of urlsFor(r).slice(0, 4)) {
      const res = await call(r.method, url, key, {});
      if (res.status !== 403) bad.push(`${label}: ${r.method} ${url} -> ${res.status}`);
    }
  }
  assert.deepEqual(bad, []);
  // A write key whose owner is a player is read-only too: players cannot make one.
  const made = await call('POST', '/api/keys', S.T.jess, { scope: 'scribe', worldId: S.W, label: 'sneaky', access: 'write' });
  assert.equal(made.status, 403);
  // And through MCP a read key cannot call a write tool even if it names one.
  for (const t of toolsFor(true).filter((x) => x.write)) {
    const r = await call('POST', '/mcp', S.K.dmRead, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: t.name, arguments: {} } });
    assert.ok(r.json.error || r.json.result?.isError, `${t.name} refused for a read key`);
  }
});

test('TestSecurityAuth_AdminsAreNotDmsAndPushKeysCannotRead', async () => {
  const W = `/api/worlds/${S.W}`;
  const worldGets = routes.filter((r) => r.method === 'GET' && r.path.startsWith('/api/worlds/:world/') && !/\/events$/.test(r.path));
  const admin = await call('GET', '/api/me', S.T.admin);
  assert.equal(admin.json.account.is_admin, true);
  for (const r of worldGets) for (const url of urlsFor(r).slice(0, 3)) {
    // An admin who is not a member of the world gets nothing: with a table session, or a gateway admin session.
    const a = await call('GET', url, S.T.admin);
    assert.equal(a.status, 404, `admin session ${url} -> ${a.status}`);
    const b = await call('GET', url, S.T.ads);
    assert.equal(b.status, 403, `admin gateway session ${url} -> ${b.status}`);
  }
  const adminMcp = await call('POST', '/mcp', S.T.ads, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(adminMcp.status, 401);
  // A push key is for one source's three intake routes: it reads nothing else.
  for (const r of worldGets.slice(0, 40)) for (const url of urlsFor(r).slice(0, 1)) {
    const res = await call('GET', url, S.push.key);
    assert.equal(res.status, 401, `push key ${url} -> ${res.status}`);
  }
  assert.equal((await call('GET', '/api/me', S.push.key)).status, 401);
  assert.equal((await call('POST', '/mcp', S.push.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  assert.equal((await call('POST', `/api/intake/${S.push.sourceId}x/entries`, S.push.key, { entries: [] })).status, 403, 'a push key is for one source');
  assert.equal((await call('POST', `/api/intake/${S.push.sourceId}/entries`, S.K.dmWrite, { entries: [] })).status, 401, 'an account key is not a push key');
  void W;
});

test('TestSecurityAuth_MediaTicketsAreSignedAndForOneAccountAndKind', async () => {
  const W = `/api/worlds/${S.W}`;
  const dmView = JSON.stringify((await call('GET', `${W}/stage`, S.T.dm)).json);
  const ticket = dmView.match(/\/api\/media\/stage\/([\w.-]+)/)![1];
  assert.equal((await call('GET', `/api/media/stage/${ticket}`)).status, 200, 'the DM ticket opens the picture');
  // Another kind of file does not open with it.
  assert.equal((await call('GET', `/api/media/sound/${ticket}`)).status, 404);
  assert.equal((await call('GET', `/api/media/voice/${ticket}`)).status, 404);
  // Changing the account or the picture breaks the signature: a player cannot turn the DM's ticket into theirs.
  const [body, mac] = ticket.split('.');
  const edit = (patch: Record<string, unknown>) => `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), ...patch })).toString('base64url')}.${mac}`;
  for (const patch of [{ a: S.ID.jess }, { w: S.W2 }, { exp: Date.now() + 1e12 }, { f: 'stg_other' }]) assert.equal((await call('GET', `/api/media/stage/${edit(patch)}`)).status, 404, JSON.stringify(patch));
  assert.equal((await call('GET', `/api/media/stage/${body}.`)).status, 404);
  assert.equal((await call('GET', `/api/media/stage/${mac}.${body}`)).status, 404);
  // A player's own ticket for a picture they may see opens only that: show a card to tom only.
  const tomCards = JSON.stringify((await call('GET', `${W}/stage`, S.T.tom)).json);
  for (const t of ticketsIn(tomCards)) assert.equal(ticketOwner(t), S.ID.tom);
  const jessCards = JSON.stringify((await call('GET', `${W}/stage`, S.T.jess)).json);
  assert.ok(!jessCards.includes(tok('stage_card_tom')), 'a card shown to tom is not in the view of jess');
  // Hiding a picture takes it away even from a ticket already handed out (the check runs on every request).
  const card = S.ids.card[1];
  await call('POST', `${W}/stage/cards/${card}/show`, S.T.dm, { to: [S.ID.tom] });
  const shown = JSON.stringify((await call('GET', `${W}/stage`, S.T.tom)).json);
  const tomTicket = ticketsIn(shown)[0];
  assert.ok(tomTicket, 'tom is shown the picture');
  assert.equal((await call('GET', `/api/media/stage/${tomTicket}`)).status, 200);
  await call('POST', `${W}/stage/cards/${card}/hide`, S.T.dm, {});
  assert.equal((await call('GET', `/api/media/stage/${tomTicket}`)).status, 404, 'hiding the card takes the picture away');
});

// ---- the live streams, read last -------------------------------------------------------------------------------------------

test('TestSecurityCrawl_LiveEventsCarryNoSecretsToTheWrongViewer', async () => {
  // Make some more things happen while the streams are open.
  const W = `/api/worlds/${S.W}`;
  await call('PATCH', `${W}/live/combatants/${all<any>(deps.db, 'SELECT id FROM combatants WHERE world_id = ? LIMIT 1', S.W)[0].id}`, S.T.dm, { damage: 3 });
  await call('POST', `${W}/live/combat/next`, S.T.dm, {});
  await call('POST', `${W}/sessionchat/chat/party`, S.T.tom, { body: `${tok('chat_party')} again` });
  await new Promise((r) => setTimeout(r, 300));
  const leaks: string[] = [];
  for (const who of ['jess', 'tom', 'guest', 'dm'] as const) {
    for (const m of leaksFor(who, taps[who].text).filter((x) => !x.eventsOk)) leaks.push(`${who}'s live stream carried "${m.id}" (${m.where})`);
    for (const t of ticketsIn(taps[who].text)) if (ticketOwner(t) !== S.ID[who]) leaks.push(`${who}'s live stream carried a ticket made for someone else`);
  }
  assert.ok(taps.jess.text.length > 500 && taps.dm.text.length > taps.jess.text.length, 'the streams carried the seeding');
  report(leaks);
  void MODEL_HOST;
});

// ---- the crawler itself ----------------------------------------------------------------------------------------------------

test('TestSecurityCrawl_PlayersStillGetNothingAfterEverythingElseHasRun', async () => {
  // The same crawl again, now that the model features ran, the write routes were tried and the streams carried more.
  const leaks: string[] = [];
  for (const v of viewers()) leaks.push(...(await crawlGets(v)).leaks);
  report(leaks);
});

/** Seeded secrets that no HTTP response carries to anyone (bytes of a picture), so they are checked another way. */
const NOT_IN_JSON = new Set(['stage_image', 'item_image', 'audit_path']);

test('TestSecurityCrawl_EverySeededSecretCanBeReadByWhoOwnsIt', () => {
  // A crawl that never saw a secret proves nothing about it. Every marker was read, in some response or stream,
  // by someone who may read it (the DM for DM-only things, a player for a player's own).
  for (const who of ['dm', 'jess', 'tom', 'guest'] as const) if (taps[who]) noteRead(who, taps[who].text);
  const missing = Object.values(markers).filter((m) => !m.seen.includes('dm2') && !NOT_IN_JSON.has(m.id) && ![...m.seen].some((w) => readBy.get(m.id)?.has(w)));
  assert.deepEqual(missing.map((m) => `${m.id} (${m.where})`), [], '\nNo one allowed to read these was ever shown them: the seed did not land, or the crawl cannot reach them');
});

test('TestSecurityCrawl_TheCrawlerCatchesALeakWhenOneIsMade', async () => {
  const W = `/api/worlds/${S.W}`;
  // Share a DM-only page by mistake: the player crawl must notice.
  assert.equal((await call('PUT', `${W}/library/pages/${S.pages.dm.id}/level`, S.T.dm, { level: 'party' })).status, 200);
  const player = await crawlGets(viewers()[0]);
  assert.ok(player.leaks.some((l) => l.includes('"dm_page"')), 'the player crawl flags a shared DM page');
  assert.equal((await call('PUT', `${W}/library/pages/${S.pages.dm.id}/level`, S.T.dm, { level: 'dm' })).status, 200);
  // Downgrade a classified page to DM-only by mistake: the AI crawl must notice (models read DM-only pages).
  assert.equal((await call('PUT', `${W}/library/pages/${S.pages.classified.id}/level`, S.T.dm, { level: 'dm' })).status, 200);
  const model = await crawlGets({ who: 'dm', token: S.T.dm, label: 'dm as a model', headers: CALLER_MODEL }, (t) => classifiedIn(t));
  assert.ok(model.leaks.some((l) => l.includes('"classified_page"')), 'the AI crawl flags a classified page a model can read');
  assert.equal((await call('PUT', `${W}/library/pages/${S.pages.classified.id}/level`, S.T.dm, { level: 'classified' })).status, 200);
  const again = await crawlGets({ who: 'dm', token: S.T.dm, label: 'dm as a model', headers: CALLER_MODEL }, (t) => classifiedIn(t));
  assert.deepEqual(again.leaks, []);
});
