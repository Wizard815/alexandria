// The tiered crawl (docs/CONNECTORS.md): list calls first, pages later.
// Fake LegendKeeper and Kanka servers count every call. Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';
import { detailTick, ensureFull, resetFailures } from '../src/intake/detail.ts';
import { resetAncestorMemo } from '../src/intake/connectors/legendkeeper.ts';
import { mintTicket } from '../src/features/sound/ticket.ts';
import { depthCounts, resetBuckets } from '../src/intake/tiers.ts';

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const LK_BASE = 'https://www.legendkeeper.com/api/v3/projects/p1';
const LK_CFG = { apiUrl: LK_BASE, apiKey: 'lk_testkey_1234567890' };
const dmViewer = { accountId: 'a', role: 'dm' as const };
const player = { accountId: 'p', role: 'player' as const };

// ---- a fake LegendKeeper project ---------------------------------------------------------------------------------

interface LkRes { id: string; name: string; parentId: string | null; isHidden: boolean; updatedAt: string; tags: string[]; text: string; perms: Record<string, number>; links?: string[]; map?: string }
const lk = {
  res: [] as LkRes[],
  calls: { list: 0, calendars: 0, detail: 0, blocks: 0, other: 0 },
  detailIds: [] as string[],
  failListPage: 0, // make this list page (1-based) answer 500
  blocks401: false, // the key is refused for page content
  blocks404: new Set<string>(), // resources whose document is gone
};
const lkReset = (n: number) => {
  lk.res = Array.from({ length: n }, (_, i) => ({
    id: `r${i + 1}`, name: `Page ${i + 1}`, parentId: i === 0 ? null : i < 10 ? 'r1' : `r${(i % 9) + 2}`, isHidden: false, updatedAt: '2026-01-01T00:00:00Z', tags: i % 3 === 0 ? ['npc'] : [],
    text: `LKBODY${i + 1} words about page ${i + 1}`, perms: { MEMBER: 5, ADMIN: 3, OWNER: 3 },
  }));
  lk.calls = { list: 0, calendars: 0, detail: 0, blocks: 0, other: 0 };
  lk.detailIds = [];
  lk.failListPage = 0;
  lk.blocks401 = false;
  lk.blocks404 = new Set();
  resetAncestorMemo();
};
const lkListItem = (r: LkRes) => ({ id: r.id, name: r.name, parentId: r.parentId, tags: r.tags, aliases: [], rank: `r${r.id.length}${r.id}`, isHidden: r.isHidden, updatedAt: r.updatedAt, documents: [{ id: `d-${r.id}`, name: 'Main', type: r.map ? 'map' : 'page' }], hasChildren: false });
const lkFetch = (url: string): Response | null => {
  if (!url.startsWith(LK_BASE)) return null;
  const u = new URL(url);
  const p = u.pathname.slice('/api/v3/projects/p1'.length);
  if (p === '/resources') {
    lk.calls.list++;
    const start = Number(u.searchParams.get('cursor') ?? 0);
    const page = start / 100 + 1;
    if (lk.failListPage && page === lk.failListPage) return json({ code: 'SERVER' }, 500);
    const slice = lk.res.slice(start, start + 100);
    const more = start + 100 < lk.res.length;
    return json({ data: slice.map(lkListItem), hasMore: more, nextCursor: more ? String(start + 100) : null });
  }
  if (p === '/calendars') { lk.calls.calendars++; return json({ data: [] }); }
  if (/\/features$/.test(p)) return json({ data: [] });
  let m = /^\/resources\/([^/]+)\/docs\/([^/]+)\/blocks$/.exec(p);
  if (m) {
    lk.calls.blocks++;
    if (lk.blocks401) return json({ code: 'UNAUTHENTICATED', message: 'Unauthorized' }, 401);
    if (lk.blocks404.has(m![1])) return json({ code: 'NOT_FOUND' }, 404);
    const r = lk.res.find((x) => x.id === m![1]);
    if (!r) return json({ code: 'NOT_FOUND' }, 404);
    const mention = (r.links ?? []).map((l) => ({ mention: { resourceId: l, name: `Page ${l.slice(1)}` } }));
    return json({ blocks: [{ kind: 'paragraph', content: [{ text: r.text }, ...mention] }] });
  }
  m = /^\/resources\/([^/]+)$/.exec(p);
  if (m) {
    lk.calls.detail++;
    lk.detailIds.push(m[1]);
    const r = lk.res.find((x) => x.id === m![1]);
    if (!r) return json({ code: 'NOT_FOUND' }, 404);
    return json({ ...lkListItem(r), permissions: r.perms, ancestors: [], properties: [], documents: [{ id: `d-${r.id}`, name: 'Main', type: r.map ? 'map' : 'page', isHidden: false, rank: 'a', ...(r.map ? { mapImage: { url: r.map, width: 100, height: 80 } } : {}) }] });
  }
  lk.calls.other++;
  return json({ code: 'NOT_FOUND' }, 404);
};

// ---- a fake Kanka campaign -----------------------------------------------------------------------------------------

const KANKA_BASE = 'https://api.kanka.io/1.0/campaigns/1';
const kk = {
  chars: [] as any[],
  cals: [] as any[],
  maps: [] as any[],
  markers: {} as Record<number, any[]>,
  rels: [] as any[],
  calls: [] as string[],
  sync: '2026-02-01T00:00:00Z',
};
const kkReset = (n: number) => {
  kk.chars = Array.from({ length: n }, (_, i) => ({ id: i + 1, entity_id: 1000 + i + 1, name: `Hero ${i + 1}`, entry: `<p>KKBODY${i + 1} story</p>`, is_private: i % 5 === 0, tags: [], type: 'NPC', updated_at: '2026-01-01T00:00:00Z' }));
  kk.cals = []; kk.maps = []; kk.markers = {}; kk.rels = [];
  kk.calls = [];
};
const kkFetch = (url: string): Response | null => {
  if (!url.startsWith(KANKA_BASE)) return null;
  kk.calls.push(url.slice(KANKA_BASE.length));
  const u = new URL(url);
  const mod = u.pathname.slice('/1.0/campaigns/1/'.length);
  const page = Number(u.searchParams.get('page') ?? 1);
  const since = u.searchParams.get('lastSync');
  const rel = /^entities\/(\d+)\/relations$/.exec(mod);
  if (rel) return json({ data: kk.rels.filter((r) => String(r.owner_id) === rel[1]), links: { next: null }, meta: { last_page: 1 } });
  if (mod === 'relations') return json({ data: kk.rels, links: { next: null }, meta: { last_page: 1 } });
  const mk = /^maps\/(\d+)\/map_markers$/.exec(mod);
  if (mk) return json({ data: kk.markers[Number(mk[1])] ?? [], links: { next: null }, meta: { last_page: 1 } });
  if (mod === 'characters' || mod === 'calendars' || mod === 'maps') {
    let rows = mod === 'characters' ? kk.chars : mod === 'calendars' ? kk.cals : kk.maps;
    if (since) rows = rows.filter((c) => c.updated_at > since);
    const per = 45;
    const last = Math.max(1, Math.ceil(rows.length / per));
    return json({ data: rows.slice((page - 1) * per, page * per), sync: kk.sync, links: { next: page < last ? 'x' : null }, meta: { current_page: page, last_page: last, per_page: per, total: rows.length } });
  }
  return json({ data: [], sync: kk.sync, links: { next: null }, meta: { current_page: 1, last_page: 1, per_page: 45, total: 0 } });
};

// ---- the app --------------------------------------------------------------------------------------------------------------

// Pictures of maps: PNGs of a size the test chooses (the path says how many bytes).
const imgCalls: string[] = [];
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const imgFetch = (url: string): Response | null => {
  const u = new URL(url);
  if (u.hostname !== 'images.kanka.io' && u.hostname !== 'cdn.lk.example') return null;
  imgCalls.push(`${u.hostname}${u.pathname}`);
  const n = Number(/-(\d+)\.png$/.exec(u.pathname)?.[1] ?? 100);
  return new Response(new Uint8Array([...PNG_HEAD, ...new Uint8Array(n)]), { status: 200, headers: { 'Content-Type': 'image/png' } });
};
let handlers: ((u: string) => Response | null)[] = [lkFetch, kkFetch, imgFetch];
const fake = (async (url: any) => {
  for (const h of handlers) { const r = h(String(url)); if (r) return r; }
  return json({ error: 'unexpected ' + url }, 500);
}) as typeof fetch;

async function boot(env: Record<string, string> = {}) {
  resetBuckets();
  const made = createApp({ noScheduler: true, fetch: fake, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_CRAWL_RATE: '0', ...env } });
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
  const admin = a.token as string;
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, admin, body);
    assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${r.text.slice(0, 300)}`);
    return r.body;
  };
  const accounts = new Map<string, string>();
  const world = async (name: string) => (await ok('POST', '/api/admin/worlds', { name, dmAccountId: a.account.id })).id as string;
  const addPlayer = async (wid: string) => {
    const inv = await ok('POST', `/api/worlds/${wid}/invites`, { role: 'player' });
    const j = (await call('POST', '/api/join', null, { code: inv.code, username: 'jess' + Math.random().toString(36).slice(2, 6), password: 'player pass 123', characterName: 'Jess' })).body;
    accounts.set(j.token, j.account.id);
    return j.token as string;
  };
  const sd = () => ({ db: made.deps.db, library: made.deps.library, dataDir: null, vaultsDir: null, fetch: fake, env: { ALX_CRAWL_RATE: '0' } as Record<string, string | undefined>, mcp: undefined });
  return { ...made, call, ok, admin, world, addPlayer, base, sd, accountOf: (token: string) => accounts.get(token) ?? '' };
}
type T = Awaited<ReturnType<typeof boot>>;

async function lkWorld(t: T, n: number, opts: { audience?: string } = {}) {
  lkReset(n);
  const wid = await t.world('LK World ' + n);
  const src = await t.ok('POST', `/api/admin/worlds/${wid}/sources`, { kind: 'legendkeeper-api', name: 'Lore', config: LK_CFG, defaultVisibility: 'party', ...(opts.audience ? { audience: opts.audience } : {}) });
  return { wid, sid: src.id as string };
}
const sync = (t: T, sid: string, body: unknown = {}) => t.ok('POST', `/api/admin/sources/${sid}/sync?wait=1`, body);
const pageId = (t: T, wid: string, title: string) => (t.deps.library.list(wid, dmViewer) as any[]).find((p) => p.title === title)!.id as string;
const depthOf = (t: T, wid: string, title: string) => one<any>(t.deps.db, 'SELECT depth FROM pages WHERE world_id = ? AND title = ?', wid, title)?.depth as string;
const getPage = (t: T, wid: string, token: string, id: string) => t.call('GET', `/api/worlds/${wid}/library/pages/${id}`, token);

// ---- tier 1: the index ----------------------------------------------------------------------------------------------------

test('CrawlTiers_IndexMakesListCallsOnlyNotOnePerPage', async () => {
  const t = await boot();
  const small = await lkWorld(t, 250);
  const out = await sync(t, small.sid);
  // 250 resources, 100 a call: 3 list calls, 1 calendar call. No detail, no blocks.
  assert.deepEqual(lk.calls, { list: 3, calendars: 1, detail: 0, blocks: 0, other: 0 });
  assert.equal(out.stats.indexCalls, 4);
  assert.equal(out.stats.detailCalls, 0);
  assert.equal(depthCounts(t.deps.db, small.sid).index, 250, 'every page exists at once, at index depth');
  assert.equal(depthCounts(t.deps.db, small.sid).full, 0);
  // Four times the pages, about four times the calls: pages / page size, not pages.
  const big = await lkWorld(t, 1000);
  lk.calls = { list: 0, calendars: 0, detail: 0, blocks: 0, other: 0 };
  const out2 = await sync(t, big.sid);
  assert.equal(lk.calls.list, 10);
  assert.equal(out2.stats.indexCalls, 11);
  assert.ok(lk.calls.detail === 0 && lk.calls.blocks === 0);
  // The tree is there with title, type, tags and parent, and a line of text to search.
  const row = one<any>(t.deps.db, 'SELECT * FROM pages WHERE world_id = ? AND title = ?', small.wid, 'Page 4');
  assert.equal(row.kind, 'npc');
  assert.deepEqual(JSON.parse(row.tags), ['npc']);
  assert.equal(row.parent_external, 'r1');
  assert.match(row.body, /Page 4 \(npc\)/);
  assert.ok(!row.body.includes('LKBODY'), 'the body has not been read');
});

test('CrawlTiers_IndexPagesAreDmOnlyUntilKnown', async () => {
  const t = await boot();
  const { wid, sid } = await lkWorld(t, 30);
  await sync(t, sid);
  const tok = await t.addPlayer(wid);
  // LegendKeeper keeps permissions in the resource detail, so a listed page is DM-only until read, even one the list calls visible.
  assert.deepEqual((t.deps.library.list(wid, player) as any[]).length, 0);
  assert.equal((await t.call('GET', `/api/worlds/${wid}/library/pages`, tok)).body.length, 0);
  assert.equal(all<any>(t.deps.db, 'SELECT id FROM pages WHERE world_id = ? AND player_body IS NOT NULL', wid).length, 0, 'no player copy exists');
  assert.equal((t.deps.library.search(wid, 'Page', player) as any[]).length, 0);
  assert.equal((t.deps.library.list(wid, dmViewer) as any[]).length, 30, 'the DM has every page');
  assert.ok(!all<any>(t.deps.db, 'SELECT visibility FROM pages WHERE world_id = ?', wid).some((r) => r.visibility === 'party'));
});

// ---- tier 3: on demand ------------------------------------------------------------------------------------------------------

test('CrawlTiers_OpeningAPageReadsItFirst_ForTheDmAndForAPlayer', async () => {
  const t = await boot();
  const { wid, sid } = await lkWorld(t, 20);
  lk.res[4].text = 'LKBODY5 open words';
  lk.res[1].isHidden = true; lk.res[1].text = 'HIDDENDM secret words';
  lk.res[2].perms = { MEMBER: 0, ADMIN: 3, OWNER: 3 }; lk.res[2].text = 'NOACCESS secret words';
  await sync(t, sid);
  const tok = await t.addPlayer(wid);
  const before = { ...lk.calls };

  // A player opening a page that is only listed spends no call: until it is read it is DM-only (nothing says yet that the source shares it).
  const listed = await getPage(t, wid, tok, pageId(t, wid, 'Page 5'));
  assert.equal(listed.status, 404);
  assert.deepEqual(lk.calls, before, 'no call was made for a page the player could not see');
  assert.equal(depthOf(t, wid, 'Page 5'), 'index');
  // The DM opens it: it is read, then served, and the player may open it too.
  assert.equal((await getPage(t, wid, t.admin, pageId(t, wid, 'Page 5'))).status, 200);
  const mid0 = { ...lk.calls };
  const open = await getPage(t, wid, tok, pageId(t, wid, 'Page 5'));
  assert.equal(open.status, 200, open.text.slice(0, 200));
  assert.deepEqual(lk.calls, mid0, 'the player\'s open costs nothing');
  assert.ok(open.text.includes('LKBODY5'), 'the player gets the page itself, not the index line');
  assert.equal(mid0.detail - before.detail, 1 + 1, 'the page and its parent (permissions)');
  assert.equal(mid0.blocks - before.blocks, 1);
  assert.equal(depthOf(t, wid, 'Page 5'), 'full');
  // Opening it again costs nothing.
  const mid = { ...lk.calls };
  assert.equal((await getPage(t, wid, tok, pageId(t, wid, 'Page 5'))).status, 200);
  assert.deepEqual(lk.calls, mid);

  // A hidden page and a page with no access for players: the DM reads them, a player never does.
  for (const [title, word] of [['Page 2', 'HIDDENDM'], ['Page 3', 'NOACCESS']] as const) {
    const id = pageId(t, wid, title);
    assert.equal((await getPage(t, wid, tok, id)).status, 404, `${title} is not the player's`);
    assert.ok(!all<any>(t.deps.db, 'SELECT player_body, player_blocks FROM pages WHERE id = ?', id).some((r) => JSON.stringify(r).includes(word)));
    const dm = await getPage(t, wid, t.admin, id);
    assert.equal(dm.status, 200);
    assert.ok(dm.text.includes(word), 'the DM has the content');
    assert.equal(depthOf(t, wid, title), 'full');
    assert.equal((await getPage(t, wid, tok, id)).status, 404, 'still not the player\'s after it was read');
  }
  const leaks = (await t.call('GET', `/api/worlds/${wid}/library/search?q=secret`, tok)).text + (await t.call('GET', `/api/worlds/${wid}/library/pages`, tok)).text;
  assert.ok(!leaks.includes('HIDDENDM') && !leaks.includes('NOACCESS'));
});

test('CrawlTiers_ASearchReadsItsBestIndexHitsForTheDm', async () => {
  const t = await boot();
  const { wid, sid } = await lkWorld(t, 12);
  lk.res[6].name = 'Zephyr Keep';
  lk.res[6].text = 'LKBODY7 the keep sits above the zephyr cliffs';
  await sync(t, sid);
  const before = lk.calls.blocks;
  const hits = (await t.call('GET', `/api/worlds/${wid}/library/search?q=Zephyr`, t.admin)).body as any[];
  assert.equal(hits[0].title, 'Zephyr Keep');
  assert.equal(lk.calls.blocks - before, 1, 'the hit was read');
  assert.equal(depthOf(t, wid, 'Zephyr Keep'), 'full');
  assert.match(hits.map((h) => h.snippet).join(' '), /cliffs/);
});

// ---- tier 3: the background, within a budget ------------------------------------------------------------------------------------------

test('CrawlTiers_BackgroundReadsWithinTheBudgetAndStartsWithWhatPeopleOpenOrLinkTo', async () => {
  const t = await boot();
  const { wid, sid } = await lkWorld(t, 40);
  lk.res[4].links = ['r6'];
  lk.res[4].text = 'LKBODY5 mentions another page';
  await sync(t, sid);
  const dep = t.sd();
  const t0 = Date.now();
  // Nothing was opened and nothing is linked to: with "fetch everything" off, nothing is read.
  assert.deepEqual(await detailTick(dep, { at: t0 }), []);
  assert.equal(lk.calls.detail, 0);
  // Opening page 5 reads it, and the page it links to (6) is now worth reading.
  await getPage(t, wid, t.admin, pageId(t, wid, 'Page 5'));
  const afterOpen = lk.calls.detail;
  const r1 = await detailTick(dep, { at: t0 });
  assert.equal(r1.length, 1);
  assert.deepEqual(lk.detailIds.slice(afterOpen).filter((x) => x !== 'r1'), ['r6'], 'the linked page was read');
  assert.equal(depthOf(t, wid, 'Page 6'), 'full');
  assert.equal(depthOf(t, wid, 'Page 20'), 'index', 'nothing else was');
  // "Fetch everything" at 6 calls a minute: the budget decides how fast.
  await t.ok('PATCH', `/api/admin/connections/tiers/${sid}`, { budget: 6, fetchAll: true });
  resetBuckets();
  const base = lk.calls.detail + lk.calls.blocks;
  const a = await detailTick(dep, { at: t0 });
  const first = lk.calls.detail + lk.calls.blocks - base;
  assert.ok(first >= 1 && first <= 6 + 3, `the first turn spent about its budget (${first})`);
  assert.equal(a[0].calls, first);
  assert.deepEqual(await detailTick(dep, { at: t0 }), [], 'out of budget until time passes');
  const b = await detailTick(dep, { at: t0 + 60_000 });
  const second = lk.calls.detail + lk.calls.blocks - base - first;
  assert.ok(second >= 1 && second <= 6 + 3, `a minute later, about its budget again (${second})`);
  assert.equal(b[0].calls, second);
  // Pause stops it.
  await t.ok('PATCH', `/api/admin/connections/tiers/${sid}`, { paused: true });
  const frozen = lk.calls.detail;
  assert.deepEqual(await detailTick(dep, { at: t0 + 600_000 }), []);
  assert.equal(lk.calls.detail, frozen);
  // Run to the end: everything is read, and "fetch everything" turns itself off.
  await t.ok('PATCH', `/api/admin/connections/tiers/${sid}`, { paused: false, budget: 120 });
  for (let i = 1; i < 60 && depthCounts(t.deps.db, sid).index > 0; i++) await detailTick(dep, { at: t0 + 700_000 + i * 60_000 });
  assert.equal(depthCounts(t.deps.db, sid).index, 0);
  await detailTick(dep, { at: t0 + 90_000_000 });
  const st = (await t.ok('GET', `/api/admin/connections/tiers/world/${wid}`))[0];
  assert.equal(st.fetchAll, false, 'it switched itself off when nothing was left');
  assert.equal(st.read, 40);
  // Players now see what is shared.
  const tok = await t.addPlayer(wid);
  assert.ok((await t.call('GET', `/api/worlds/${wid}/library/pages`, tok)).body.length > 30);
});

test('CrawlTiers_TierSettingsAreValidatedAndShownWithCounts', async () => {
  const t = await boot();
  const { wid, sid } = await lkWorld(t, 10);
  await sync(t, sid);
  assert.equal((await t.call('PATCH', `/api/admin/connections/tiers/${sid}`, t.admin, { budget: -1 })).status, 400);
  assert.equal((await t.call('PATCH', `/api/admin/connections/tiers/${sid}`, t.admin, { budget: 'lots' })).status, 400);
  assert.equal((await t.call('PATCH', `/api/admin/connections/tiers/${sid}`, null, { budget: 5 })).status, 401);
  const s = await t.ok('PATCH', `/api/admin/connections/tiers/${sid}`, { budget: 12 });
  assert.equal(s.budget, 12);
  assert.equal(s.pages, 10);
  assert.deepEqual(s.depth, { index: 10, summary: 0, full: 0, stale: 0 });
  assert.equal(s.calls.index, 2, 'one list call and the calendars');
  const reset = await t.ok('PATCH', `/api/admin/connections/tiers/${sid}`, { budget: null });
  assert.equal(reset.budget, reset.budgetDefault);
  // The DM's badge list and a player's nothing.
  const depths = (await t.ok('GET', `/api/worlds/${wid}/world-sources/depths`)).depths;
  assert.equal(Object.keys(depths).length, 10);
  assert.ok(Object.values(depths).every((v) => v === 'index'));
  const tok = await t.addPlayer(wid);
  assert.deepEqual((await t.call('GET', `/api/worlds/${wid}/world-sources/depths`, tok)).body, { depths: {} });
  // The agent's one-line summary says pages are listed, not read.
  assert.match((await t.ok('GET', `/api/worlds/${wid}/world-sources`)).summary, /10 pages are listed but not read yet/);
});

// ---- incremental re-crawls and removal ---------------------------------------------------------------------------------------------------

test('CrawlTiers_RecrawlReadsOnlyWhatChangedAndAHiddenPageLosesItsPlayerCopyAtOnce', async () => {
  const t = await boot();
  const { wid, sid } = await lkWorld(t, 15);
  await sync(t, sid);
  const tok = await t.addPlayer(wid);
  // A page that is only listed has no player copy yet: the DM opening it reads it, and then it is the player's too.
  for (const n of [5, 7, 9]) assert.equal((await getPage(t, wid, t.admin, pageId(t, wid, `Page ${n}`))).status, 200);
  for (const n of [5, 7, 9]) assert.equal((await getPage(t, wid, tok, pageId(t, wid, `Page ${n}`))).status, 200);
  assert.equal(depthCounts(t.deps.db, sid).full, 3);
  const detailBefore = lk.calls.detail;

  // Page 7 is edited at the source: the next listing notes it, and only it is stale.
  lk.res[6].updatedAt = '2026-03-01T00:00:00Z';
  lk.res[6].text = 'LKBODY7 edited words';
  const out = await sync(t, sid);
  assert.equal(lk.calls.detail, detailBefore, 'the re-crawl made no detail calls');
  assert.equal(out.stats.detailCalls, 0);
  const counts = depthCounts(t.deps.db, sid);
  assert.equal(counts.stale, 1);
  assert.equal(depthOf(t, wid, 'Page 7'), 'full');
  assert.ok(one<any>(t.deps.db, 'SELECT body FROM pages WHERE world_id = ? AND title = ?', wid, 'Page 7').body.includes('LKBODY7 words'), 'the old text is held until the change is read');
  // The next time it is opened, only that page is read again.
  const ids0 = lk.detailIds.length;
  const reopened = await getPage(t, wid, tok, pageId(t, wid, 'Page 7'));
  assert.ok(reopened.text.includes('edited words'));
  assert.ok(lk.detailIds.slice(ids0).every((x) => x === 'r7' || x === 'r1'), `only page 7 (and its parent) were read: ${lk.detailIds.slice(ids0)}`);
  assert.equal(depthCounts(t.deps.db, sid).stale, 0);
  // Unchanged pages are never read again.
  const n = lk.calls.detail;
  await sync(t, sid);
  assert.equal(lk.calls.detail, n);

  // The list says page 5 is hidden now: its player copy is gone at once, with no detail call.
  lk.res[4].isHidden = true;
  await sync(t, sid);
  assert.equal(lk.calls.detail, n);
  assert.equal((await getPage(t, wid, tok, pageId(t, wid, 'Page 5'))).status, 404, 'a hidden page is not served');
  assert.equal(one<any>(t.deps.db, 'SELECT player_body FROM pages WHERE world_id = ? AND title = ?', wid, 'Page 5').player_body, null);
  assert.equal((await getPage(t, wid, t.admin, pageId(t, wid, 'Page 5'))).status, 200, 'the DM still has it');
  assert.ok(!(await t.call('GET', `/api/worlds/${wid}/library/search?q=LKBODY5`, tok)).text.includes('LKBODY5'));
});

test('CrawlTiers_RemovalOnlyAfterACompleteListing', async () => {
  const t = await boot();
  const { wid, sid } = await lkWorld(t, 150);
  await sync(t, sid);
  assert.equal(depthCounts(t.deps.db, sid).total, 150);
  // The second list page fails: a partial listing removes nothing.
  lk.res.splice(10, 1);
  lk.failListPage = 2;
  const bad = await t.call('POST', `/api/admin/sources/${sid}/sync?wait=1`, t.admin, {});
  assert.equal(bad.status, 502);
  assert.equal(depthCounts(t.deps.db, sid).total, 150, 'nothing was removed');
  // A complete listing removes the page the source dropped.
  lk.failListPage = 0;
  const ok = await sync(t, sid);
  assert.equal(ok.stats.removed, 1);
  assert.equal(depthCounts(t.deps.db, sid).total, 149);
  assert.equal((t.deps.library.list(wid, dmViewer) as any[]).find((p) => p.title === 'Page 11'), undefined);
});

// ---- Kanka: the list already has the entry ---------------------------------------------------------------------------------------------------

test('CrawlTiers_KankaListsCarryTheWholeEntryAndLaterListingsAskOnlyForChanges', async () => {
  const t = await boot();
  kkReset(100);
  const wid = await t.world('Kanka World');
  const conn = await t.ok('POST', '/api/admin/connections', { kind: 'kanka-api', name: 'My Kanka', config: { token: 'kanka-token-aaaaaaaaaaaaaaaaaaaa' } });
  const src = await t.ok('POST', `/api/admin/worlds/${wid}/sources`, { connectionId: conn.id, kind: 'kanka-api', name: 'Kanka', config: { campaignId: '1' }, defaultVisibility: 'party' });
  const first = await sync(t, src.id);
  // 100 characters at 45 a page: 3 list calls, plus one call for each of the other 15 modules, plus relations. Nothing per page.
  assert.equal(kk.calls.filter((c) => c.startsWith('/characters')).length, 3);
  assert.equal(first.stats.indexCalls, 3 + 15 + 1);
  assert.equal(kk.calls.length, 19);
  const counts = depthCounts(t.deps.db, src.id);
  assert.deepEqual([counts.total, counts.full, counts.index], [100, 100, 0], 'the list gave the whole page');
  // Private entries stay DM-only; shared ones are the player\'s.
  assert.equal(one<any>(t.deps.db, 'SELECT visibility FROM pages WHERE world_id = ? AND title = ?', wid, 'Hero 1').visibility, 'dm');
  assert.equal(one<any>(t.deps.db, 'SELECT visibility FROM pages WHERE world_id = ? AND title = ?', wid, 'Hero 2').visibility, 'party');
  assert.ok(one<any>(t.deps.db, 'SELECT body FROM pages WHERE world_id = ? AND title = ?', wid, 'Hero 2').body.includes('KKBODY2'));

  // Changed: Hero 3 is edited and Hero 4 is deleted at the source. The re-crawl sends lastSync and sees only what changed.
  kk.calls = [];
  kk.chars[2].entry = '<p>KKBODY3 edited</p>'; kk.chars[2].updated_at = '2026-03-01T00:00:00Z';
  kk.chars.splice(3, 1);
  const second = await sync(t, src.id);
  assert.ok(kk.calls.filter((c) => !c.startsWith('/entities/')).every((c) => c.includes('lastSync=')), `every list asked for changes only: ${kk.calls.join(' ')}`);
  assert.deepEqual(kk.calls.filter((c) => c.startsWith('/entities/')).map((c) => c.split('?')[0]), ['/entities/1003/relations'], 'relations are read for the one changed entity only, never the whole campaign');
  assert.equal(kk.calls.length, 17, 'one list call per module, and one relations call for the changed entity');
  assert.equal(second.stats.indexCalls, 17);
  assert.equal(second.stats.pages, 1);
  assert.equal(second.stats.removed, 0, 'a listing of changes cannot remove');
  assert.ok(one<any>(t.deps.db, 'SELECT body FROM pages WHERE world_id = ? AND title = ?', wid, 'Hero 3').body.includes('KKBODY3 edited'));
  assert.ok(one<any>(t.deps.db, 'SELECT id FROM pages WHERE world_id = ? AND title = ?', wid, 'Hero 4'), 'the deleted entity stays until a complete listing');
  // A complete listing removes it.
  kk.calls = [];
  const third = await sync(t, src.id, { full: true });
  assert.equal(third.stats.removed, 1);
  assert.equal(one<any>(t.deps.db, 'SELECT id FROM pages WHERE world_id = ? AND title = ?', wid, 'Hero 4'), undefined);
  assert.ok(kk.calls.every((c) => !c.includes('lastSync=')));
});

test('CrawlTiers_KankaIncrementalRefreshesRelationsMarkersAndCalendarsOfChangedEntitiesOnly', async () => {
  const t = await boot();
  kkReset(6);
  const OLD = '2026-01-01T00:00:00Z';
  const NEW = '2026-03-01T00:00:00Z';
  kk.cals = [{ id: 1, entity_id: 2001, name: 'Calendar of Tests', is_private: false, updated_at: OLD, date: '1-2-3', months: [{ name: 'Firstmonth', length: 30 }], weekdays: ['Mon', 'Tue'] }];
  kk.maps = [{ id: 1, entity_id: 3001, name: 'Map of Tests', is_private: false, updated_at: OLD }];
  kk.markers = { 1: [{ id: 5, name: 'Old pin', latitude: 1, longitude: 2, shape_id: 1, is_private: false, visibility_id: 1 }] };
  kk.rels = [
    { id: 1, owner_id: 1002, target_id: 1004, relation: 'ally', visibility_id: 1, is_private: false },
    { id: 2, owner_id: 1003, target_id: 1004, relation: 'friend', visibility_id: 1, is_private: false },
    { id: 3, owner_id: 1002, target_id: 1005, relation: 'rival', visibility_id: 1, is_private: false },
  ];
  const wid = await t.world('Kanka Records World');
  const conn = await t.ok('POST', '/api/admin/connections', { kind: 'kanka-api', name: 'My Kanka', config: { token: 'kanka-token-aaaaaaaaaaaaaaaaaaaa' } });
  const src = await t.ok('POST', `/api/admin/worlds/${wid}/sources`, { connectionId: conn.id, kind: 'kanka-api', name: 'Kanka', config: { campaignId: '1' }, defaultVisibility: 'party' });
  const rels = () => all<any>(t.deps.db, 'SELECT external_id, from_ref, label FROM intake_relations WHERE source_id = ? ORDER BY external_id', src.id).map((r) => `${r.from_ref}:${r.label}`);
  await sync(t, src.id);
  assert.equal(rels().length, 3);
  assert.equal(one<any>(t.deps.db, 'SELECT name FROM intake_markers WHERE source_id = ?', src.id).name, 'Old pin');
  assert.equal(JSON.parse(one<any>(t.deps.db, 'SELECT definition FROM intake_calendars WHERE source_id = ?', src.id).definition).months[0].name, 'Firstmonth');

  // At the source: Hero 2 changed and one of its relations was edited and another deleted; Hero 3's relation was edited too, but Hero 3 did not change.
  // The calendar and the map changed.
  kk.sync = '2026-03-02T00:00:00Z';
  kk.chars[1].updated_at = NEW;
  kk.rels[0].relation = 'sworn enemy';
  kk.rels.splice(2, 1);
  kk.rels[1].relation = 'ex-friend';
  kk.cals[0].months = [{ name: 'Renamedmonth', length: 31 }]; kk.cals[0].updated_at = NEW;
  kk.maps[0].updated_at = NEW;
  kk.markers[1] = [{ id: 5, name: 'New pin', latitude: 4, longitude: 5, shape_id: 1, is_private: false, visibility_id: 1 }];
  kk.calls = [];
  const out = await sync(t, src.id);
  const rel = kk.calls.filter((c) => /relations/.test(c)).map((c) => c.split('?')[0]);
  assert.deepEqual(rel.sort(), ['/entities/1002/relations', '/entities/2001/relations', '/entities/3001/relations'], `relations were read for the three changed entities only: ${kk.calls.join(' ')}`);
  assert.ok(!kk.calls.some((c) => c.startsWith('/relations') || c.includes('/entities/1003')), 'no campaign-wide relations call, none for an unchanged entity');
  assert.equal(kk.calls.filter((c) => c.includes('map_markers')).length, 1, 'markers for the one changed map');
  assert.equal(out.stats.indexCalls, kk.calls.length, 'every call is counted in the tier line');
  assert.equal(out.stats.removed, 0, 'a listing of changes removes no pages');
  assert.ok(rels().includes('kanka:1002:sworn enemy'), 'the edited relation was refreshed');
  assert.ok(!rels().some((r) => r.endsWith(':rival')), 'a relation deleted at the source is gone from a changed entity');
  assert.ok(rels().includes('kanka:1003:friend'), 'an unchanged entity keeps its relations as they were (the next complete listing refreshes them)');
  assert.equal(one<any>(t.deps.db, 'SELECT name FROM intake_markers WHERE source_id = ?', src.id).name, 'New pin');
  assert.equal(JSON.parse(one<any>(t.deps.db, 'SELECT definition FROM intake_calendars WHERE source_id = ?', src.id).definition).months[0].name, 'Renamedmonth');
  assert.equal(all<any>(t.deps.db, 'SELECT 1 FROM intake_calendars WHERE source_id = ?', src.id).length, 1, 'the calendar was replaced, not duplicated');

  // A run where nothing changed reads no relations at all.
  kk.sync = '2026-03-03T00:00:00Z';
  kk.calls = [];
  await sync(t, src.id);
  assert.ok(!kk.calls.some((c) => /relations|map_markers/.test(c)), `nothing changed, no relation or marker call: ${kk.calls.join(' ')}`);

  // A complete listing refreshes the rest.
  await sync(t, src.id, { full: true });
  assert.ok(rels().includes('kanka:1003:ex-friend'));
});

// ---- the crawl's progress ---------------------------------------------------------------------------------------------------------------------

test('CrawlTiers_CrawlProgressShowsCallsAndWhatIsRead', async () => {
  const t = await boot();
  const { wid, sid } = await lkWorld(t, 120);
  await t.ok('POST', `/api/admin/worlds/${wid}/crawl`, {});
  let c: any = null;
  for (let i = 0; i < 100; i++) {
    c = (await t.ok('GET', `/api/admin/worlds/${wid}/crawls`))[0];
    if (c && c.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(c.status, 'ok', JSON.stringify(c));
  assert.deepEqual(c.progress.calls, { index: 3, detail: 0 }, '120 resources: two list calls and the calendars');
  assert.deepEqual(c.progress.depth, { index: 120, summary: 0, full: 0 });
  const line = c.progress.tiers[0];
  assert.deepEqual([line.sourceId, line.pages, line.read, line.indexCalls], [sid, 120, 0, 3]);
  assert.ok(line.budget >= 1);
});

// ---- the leak guard at every depth ---------------------------------------------------------------------------------------------------------------

test('CrawlTiers_ASourceSetToDmOnlyStaysDmOnlyAtEveryDepth', async () => {
  const t = await boot();
  const { wid, sid } = await lkWorld(t, 8, { audience: 'dm' });
  await sync(t, sid);
  const tok = await t.addPlayer(wid);
  await getPage(t, wid, t.admin, pageId(t, wid, 'Page 4'));
  assert.equal(depthOf(t, wid, 'Page 4'), 'full');
  assert.equal((await getPage(t, wid, tok, pageId(t, wid, 'Page 4'))).status, 404);
  assert.equal((await t.call('GET', `/api/worlds/${wid}/library/pages`, tok)).body.length, 0);
  run(t.deps.db, 'SELECT 1');
});

// ---- map images --------------------------------------------------------------------------------------------------------------

const mapRow = (t: T, ext: string) => one<any>(t.deps.db, 'SELECT * FROM intake_images WHERE external_id = ?', ext);

test('CrawlTiers_KankaMapPicturesAreStoredAsMapsWithTheirOwnSizeCapAndFollowTheirPage', async () => {
  imgCalls.length = 0;
  // Pictures are capped at 1,000 bytes here; maps at 4,000.
  const t = await boot({ ALX_IMAGE_MAX_BYTES: '1000', ALX_MAP_MAX_BYTES: '4000' });
  kkReset(2);
  kk.maps = [
    { id: 1, entity_id: 2001, name: 'Realm Map', entry: '<p>MAPBODY1</p>', is_private: false, image_full: 'https://images.kanka.io/m1-3000.png', has_custom_image: true, updated_at: '2026-01-01T00:00:00Z' },
    { id: 2, entity_id: 2002, name: 'Secret Map', entry: '<p>MAPBODY2</p>', is_private: true, image_full: 'https://images.kanka.io/m2-2000.png', has_custom_image: true, updated_at: '2026-01-01T00:00:00Z' },
    { id: 3, entity_id: 2003, name: 'Huge Map', entry: '<p>MAPBODY3</p>', is_private: false, image_full: 'https://images.kanka.io/m3-9000.png', has_custom_image: true, updated_at: '2026-01-01T00:00:00Z' },
    { id: 4, entity_id: 2004, name: 'No Image Map', entry: '<p>MAPBODY4</p>', is_private: false, image_full: 'https://images.kanka.io/default.png', has_custom_image: false, updated_at: '2026-01-01T00:00:00Z' },
  ];
  const wid = await t.world('Kanka Map World');
  const conn = await t.ok('POST', '/api/admin/connections', { kind: 'kanka-api', name: 'My Kanka', config: { token: 'kanka-token-aaaaaaaaaaaaaaaaaaaa' } });
  const src = await t.ok('POST', `/api/admin/worlds/${wid}/sources`, { connectionId: conn.id, kind: 'kanka-api', name: 'Kanka', config: { campaignId: '1' }, defaultVisibility: 'party' });
  const first = await sync(t, src.id);
  assert.deepEqual(imgCalls.sort(), ['images.kanka.io/m1-3000.png', 'images.kanka.io/m2-2000.png', 'images.kanka.io/m3-9000.png'], 'a map with no custom image is not downloaded');
  assert.equal(first.stats.detailCalls, 3, 'downloads are detail calls');
  const rows = all<any>(t.deps.db, "SELECT external_id, kind, visibility, size FROM intake_images ORDER BY external_id");
  assert.deepEqual(rows.map((r) => [r.external_id, r.kind, r.visibility]), [['kanka:mapimg:2001', 'map', 'party'], ['kanka:mapimg:2002', 'map', 'dm']], 'the huge map is over the map cap and is refused; a private map is the DM\'s');
  assert.ok(rows[0].size > 1000, 'a map may be bigger than a picture');

  const tok = await t.addPlayer(wid);
  const dmPage = (await getPage(t, wid, t.admin, pageId(t, wid, 'Realm Map'))).body;
  assert.equal(dmPage.pictures.length, 1);
  assert.equal(dmPage.pictures[0].map, true);
  assert.equal(dmPage.banner, 'https://images.kanka.io/m1-3000.png', 'the page keeps the address Kanka gave it as its banner');
  assert.equal(dmPage.pictures[0].primary, false);
  assert.equal((await fetch(t.base + dmPage.pictures[0].url)).status, 200);
  const playerPage = (await getPage(t, wid, tok, pageId(t, wid, 'Realm Map'))).body;
  assert.equal(playerPage.pictures.length, 1, 'a shared map follows its shared page');
  assert.equal((await getPage(t, wid, tok, pageId(t, wid, 'Secret Map'))).status, 404);
  assert.equal((await getPage(t, wid, t.admin, pageId(t, wid, 'Secret Map'))).body.pictures.length, 1, 'the DM has the private map');

  // The Map page can pick imported maps: the DM sees both, a player only the shared one.
  const dmMaps = (await t.call('GET', `/api/worlds/${wid}/intake/map-images`, t.admin)).body;
  assert.deepEqual(dmMaps.map((m: any) => m.name).sort(), ['Realm Map', 'Secret Map']);
  assert.equal((await fetch(t.base + dmMaps[0].url)).status, 200);
  const playerMaps = (await t.call('GET', `/api/worlds/${wid}/intake/map-images`, tok)).body;
  assert.deepEqual(playerMaps.map((m: any) => m.name), ['Realm Map']);
  assert.ok(!JSON.stringify(playerMaps).includes(mapRow(t, 'kanka:mapimg:2002').id), 'no id of a private map reaches a player');
  const forged = mintTicket({ w: wid, k: 'intake', f: mapRow(t, 'kanka:mapimg:2002').id, a: t.accountOf(tok) });
  assert.equal((await fetch(`${t.base}/api/media/intake/${forged}`)).status, 404);

  // An unchanged map is not downloaded again; a changed one is, alone.
  imgCalls.length = 0;
  await sync(t, src.id, { full: true });
  assert.deepEqual(imgCalls.filter((c) => !c.includes('m3-')), [], 'nothing was fetched again');
  kk.maps[0].updated_at = '2026-04-01T00:00:00Z';
  imgCalls.length = 0;
  await sync(t, src.id);
  assert.deepEqual(imgCalls, ['images.kanka.io/m1-3000.png']);

  // The source's audience can keep every map DM-only.
  run(t.deps.db, "UPDATE sources SET audience = 'dm' WHERE id = ?", src.id);
  await t.ok('PATCH', `/api/admin/sources/${src.id}`, { audience: 'dm' });
  await sync(t, src.id, { full: true });
  assert.deepEqual((await t.call('GET', `/api/worlds/${wid}/intake/map-images`, tok)).body, []);
});

test('CrawlTiers_LegendKeeperMapImagesComeWithTheMapPageWhenItIsReadAndStayDmOnlyForAHiddenOne', async () => {
  imgCalls.length = 0;
  const t = await boot();
  const { wid, sid } = await lkWorld(t, 4);
  lk.res[1].map = 'https://cdn.lk.example/world-2500.png'; lk.res[1].name = 'World Map';
  lk.res[2].map = 'https://cdn.lk.example/secret-2500.png'; lk.res[2].name = 'Hidden Map'; lk.res[2].isHidden = true;
  await sync(t, sid);
  assert.equal(all<any>(t.deps.db, 'SELECT 1 FROM intake_images').length, 0, 'the index only lists: no picture yet');
  assert.deepEqual(imgCalls, []);
  const tok = await t.addPlayer(wid);
  // Opening the pages reads them, and their pictures come with them.
  assert.equal((await getPage(t, wid, t.admin, pageId(t, wid, 'World Map'))).status, 200);
  assert.equal((await getPage(t, wid, t.admin, pageId(t, wid, 'Hidden Map'))).status, 200);
  assert.deepEqual(imgCalls.sort(), ['cdn.lk.example/secret-2500.png', 'cdn.lk.example/world-2500.png']);
  assert.deepEqual(all<any>(t.deps.db, 'SELECT kind, visibility FROM intake_images ORDER BY name').map((r) => [r.kind, r.visibility]), [['map', 'dm'], ['map', 'party']]);
  const maps = (await t.call('GET', `/api/worlds/${wid}/intake/map-images`, tok)).body;
  assert.deepEqual(maps.map((m: any) => m.name), ['World Map']);
  assert.equal((await getPage(t, wid, tok, pageId(t, wid, 'World Map'))).body.pictures.length, 1);
  assert.equal((await getPage(t, wid, tok, pageId(t, wid, 'Hidden Map'))).status, 404);
  assert.ok(!(await t.call('GET', `/api/worlds/${wid}/library/pages`, tok)).text.includes('secret-2500'));
});

test('CrawlTiers_RefusedKeyStopsTheBackgroundAndABadPageDoesNotBlockTheQueue', async () => {
  const t = await boot();
  resetFailures(); resetBuckets();
  const { wid, sid } = await lkWorld(t, 12);
  await sync(t, sid);
  await t.ok('PATCH', `/api/admin/connections/tiers/${sid}`, { budget: 20, fetchAll: true });
  const dep = t.sd();
  // The key is refused for page content: one turn finds out, the next turns make no calls at all.
  lk.blocks401 = true;
  const now = Date.now();
  const a = await detailTick(dep, { at: now });
  assert.equal(a.length, 1);
  assert.ok(lk.calls.blocks <= 1, `the first refusal stopped the turn (${lk.calls.blocks} blocks calls)`);
  const spent = lk.calls.detail + lk.calls.blocks;
  assert.deepEqual(await detailTick(dep, { at: now + 120_000 }), [], 'a source whose key is refused is left alone for a while');
  assert.equal(lk.calls.detail + lk.calls.blocks, spent);
  // The key works again and one page is gone at the source: the other pages are still read, in the same turn.
  resetFailures(); resetBuckets();
  lk.blocks401 = false;
  lk.blocks404.add('r3');
  for (let i = 0; i < 6; i++) await detailTick(dep, { at: now + 1_000_000 + i * 60_000 });
  assert.ok(depthCounts(t.deps.db, sid).full >= 10, 'everything but the bad page was read');
  const before = lk.calls.detail + lk.calls.blocks;
  await detailTick(dep, { at: now + 2_000_000 });
  assert.ok(lk.calls.detail + lk.calls.blocks - before <= 2, 'the bad page is not tried again straight away');
  void wid;
});

test('CrawlTiers_PagesReadOneByOneAskForTheirSharedFolderOnlyOnce', async () => {
  const t = await boot();
  const { wid, sid } = await lkWorld(t, 10);
  await sync(t, sid);
  // Pages 2 to 9 sit under r1: reading them one at a time still reads r1's permissions once.
  for (const n of [2, 3, 4, 5, 6]) await getPage(t, wid, t.admin, pageId(t, wid, `Page ${n}`));
  assert.equal(lk.detailIds.filter((x) => x === 'r1').length, 1, 'the folder was read once for five pages');
  assert.equal(lk.detailIds.filter((x) => x === 'r2').length, 1, 'and each page once');
});
