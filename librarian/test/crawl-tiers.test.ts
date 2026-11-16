// The tiered crawl (docs/CONNECTORS.md): list calls first, pages later.
// Fake LegendKeeper and Kanka servers count every call. Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';
import { detailTick, ensureFull } from '../src/intake/detail.ts';
import { depthCounts, resetBuckets } from '../src/intake/tiers.ts';

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const LK_BASE = 'https://www.legendkeeper.com/api/v3/projects/p1';
const LK_CFG = { apiUrl: LK_BASE, apiKey: 'lk_testkey_1234567890' };
const dmViewer = { accountId: 'a', role: 'dm' as const };
const player = { accountId: 'p', role: 'player' as const };

// ---- a fake LegendKeeper project ---------------------------------------------------------------------------------

interface LkRes { id: string; name: string; parentId: string | null; isHidden: boolean; updatedAt: string; tags: string[]; text: string; perms: Record<string, number>; links?: string[] }
const lk = {
  res: [] as LkRes[],
  calls: { list: 0, calendars: 0, detail: 0, blocks: 0, other: 0 },
  detailIds: [] as string[],
  failListPage: 0, // make this list page (1-based) answer 500
};
const lkReset = (n: number) => {
  lk.res = Array.from({ length: n }, (_, i) => ({
    id: `r${i + 1}`, name: `Page ${i + 1}`, parentId: i === 0 ? null : i < 10 ? 'r1' : `r${(i % 9) + 2}`, isHidden: false, updatedAt: '2026-01-01T00:00:00Z', tags: i % 3 === 0 ? ['npc'] : [],
    text: `LKBODY${i + 1} words about page ${i + 1}`, perms: { MEMBER: 5, ADMIN: 3, OWNER: 3 },
  }));
  lk.calls = { list: 0, calendars: 0, detail: 0, blocks: 0, other: 0 };
  lk.detailIds = [];
  lk.failListPage = 0;
};
const lkListItem = (r: LkRes) => ({ id: r.id, name: r.name, parentId: r.parentId, tags: r.tags, aliases: [], rank: `r${r.id.length}${r.id}`, isHidden: r.isHidden, updatedAt: r.updatedAt, documents: [{ id: `d-${r.id}`, name: 'Main', type: 'page' }], hasChildren: false });
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
  let m = /^\/resources\/([^/]+)\/docs\/([^/]+)\/blocks$/.exec(p);
  if (m) {
    lk.calls.blocks++;
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
    return json({ ...lkListItem(r), permissions: r.perms, ancestors: [], properties: [], documents: [{ id: `d-${r.id}`, name: 'Main', type: 'page', isHidden: false, rank: 'a' }] });
  }
  lk.calls.other++;
  return json({ code: 'NOT_FOUND' }, 404);
};

// ---- a fake Kanka campaign -----------------------------------------------------------------------------------------

const KANKA_BASE = 'https://api.kanka.io/1.0/campaigns/1';
const kk = {
  chars: [] as any[],
  calls: [] as string[],
  sync: '2026-02-01T00:00:00Z',
};
const kkReset = (n: number) => {
  kk.chars = Array.from({ length: n }, (_, i) => ({ id: i + 1, entity_id: 1000 + i + 1, name: `Hero ${i + 1}`, entry: `<p>KKBODY${i + 1} story</p>`, is_private: i % 5 === 0, tags: [], type: 'NPC', updated_at: '2026-01-01T00:00:00Z' }));
  kk.calls = [];
};
const kkFetch = (url: string): Response | null => {
  if (!url.startsWith(KANKA_BASE)) return null;
  kk.calls.push(url.slice(KANKA_BASE.length));
  const u = new URL(url);
  const mod = u.pathname.slice('/1.0/campaigns/1/'.length);
  const page = Number(u.searchParams.get('page') ?? 1);
  const since = u.searchParams.get('lastSync');
  if (mod === 'characters') {
    let rows = kk.chars;
    if (since) rows = rows.filter((c) => c.updated_at > since);
    const per = 45;
    const last = Math.max(1, Math.ceil(rows.length / per));
    return json({ data: rows.slice((page - 1) * per, page * per), sync: kk.sync, links: { next: page < last ? 'x' : null }, meta: { current_page: page, last_page: last, per_page: per, total: rows.length } });
  }
  return json({ data: [], sync: kk.sync, links: { next: null }, meta: { current_page: 1, last_page: 1, per_page: 45, total: 0 } });
};

// ---- the app --------------------------------------------------------------------------------------------------------------

let handlers: ((u: string) => Response | null)[] = [lkFetch, kkFetch];
const fake = (async (url: any) => {
  for (const h of handlers) { const r = h(String(url)); if (r) return r; }
  return json({ error: 'unexpected ' + url }, 500);
}) as typeof fetch;

async function boot() {
  resetBuckets();
  const made = createApp({ noScheduler: true, fetch: fake, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_CRAWL_RATE: '0' } });
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
  const world = async (name: string) => (await ok('POST', '/api/admin/worlds', { name, dmAccountId: a.account.id })).id as string;
  const addPlayer = async (wid: string) => {
    const inv = await ok('POST', `/api/worlds/${wid}/invites`, { role: 'player' });
    const j = (await call('POST', '/api/join', null, { code: inv.code, username: 'jess' + Math.random().toString(36).slice(2, 6), password: 'player pass 123', characterName: 'Jess' })).body;
    return j.token as string;
  };
  const sd = () => ({ db: made.deps.db, library: made.deps.library, dataDir: null, vaultsDir: null, fetch: fake, env: { ALX_CRAWL_RATE: '0' } as Record<string, string | undefined>, mcp: undefined });
  return { ...made, call, ok, admin, world, addPlayer, base, sd };
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

  // A player opens a page the source shares: it is read, then served.
  const open = await getPage(t, wid, tok, pageId(t, wid, 'Page 5'));
  assert.equal(open.status, 200, open.text.slice(0, 200));
  assert.ok(open.text.includes('LKBODY5'), 'the player gets the page itself, not the index line');
  assert.equal(lk.calls.detail - before.detail, 1 + 1, 'the page and its parent (permissions)');
  assert.equal(lk.calls.blocks - before.blocks, 1);
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
  assert.ok(kk.calls.every((c) => c.includes('lastSync=')), `every list asked for changes only: ${kk.calls.join(' ')}`);
  assert.equal(kk.calls.length, 16, 'one list call per module, no relations');
  assert.equal(second.stats.indexCalls, 16);
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
