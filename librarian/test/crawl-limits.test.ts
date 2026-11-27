// A source's rate limits are respected: one limiter per connection (shared by every world and key that uses it), the site's own
// headers and 429s slow us down, a scan can be spread over a window, and a page a player may not see costs no call.
// A fake clock runs minutes in milliseconds. Synthetic data only.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';
import { Limiter, limiterFor, limiterState, limitedFetch, limitKeyOf, limitsOf, projectOf, projectWindow, resetLimiters, setClock } from '../src/intake/ratelimit.ts';
import { worldStatus } from '../src/features/connections/status.ts';
import { budgetOf, getState, tieredOf } from '../src/intake/tiers.ts';
import { tierSummary, ensureFull } from '../src/intake/detail.ts';
import { resetBuckets } from '../src/intake/tiers.ts';
import { CallCounter } from '../src/intake/connector.ts';

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); setClock(null); });
afterEach(() => setClock(null));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** A clock that only moves when somebody sleeps. */
function fakeClock(start = 1_000_000) {
  const c = { t: start, sleeps: [] as number[], onSleep: undefined as undefined | (() => void), now: () => c.t, sleep: async (ms: number) => { c.sleeps.push(ms); c.onSleep?.(); c.t += ms; } };
  setClock(c);
  return c;
}

// ---- the limiter itself ---------------------------------------------------------------------------------------------

test('RateLimit_LimitsAreTheConnectorsDefaultsUntilTheConnectionSaysOtherwise', () => {
  assert.deepEqual(limitsOf('kanka-api', {}), { perMinute: 30, perSecond: 0, spreadMinutes: 1, perHour: 0 }, 'Kanka documents no hourly cap');
  assert.deepEqual(limitsOf('legendkeeper-api', {}), { perMinute: 200, perSecond: 2, spreadMinutes: 1, perHour: 6000 }, 'the tightest tier a real key reported, and the documented hourly cap');
  assert.deepEqual(limitsOf('legendkeeper-mcp', {}), { perMinute: 200, perSecond: 2, spreadMinutes: 1, perHour: 6000 });
  assert.deepEqual(limitsOf('api', {}), { perMinute: 60, perSecond: 0, spreadMinutes: 1, perHour: 0 });
  assert.deepEqual(limitsOf('kanka-api', { maxPerMinute: 90, maxPerSecond: 3, spreadMinutes: 0 }), { perMinute: 90, perSecond: 3, spreadMinutes: 0, perHour: 0 });
  assert.equal(limitsOf('legendkeeper-api', { maxPerHour: 3000 }).perHour, 3000);
  assert.equal(limitsOf('legendkeeper-api', { maxPerHour: 0 }).perHour, 0, 'zero: no hourly cap');
  assert.equal(limitsOf('kanka-api', { maxPerHour: 1000 }).perHour, 1000, 'any connection can be given an hourly cap');
  assert.equal(limitsOf('kanka-api', { maxPerMinute: 'junk' }).perMinute, 30, 'a bad value falls back to the default');
  assert.equal(limitsOf('kanka-api', { maxPerMinute: 0 }).perMinute, 30, 'zero calls a minute is not a limit, it is the default');
  assert.equal(limitsOf('kanka-api', { maxPerMinute: 90 }, {}, 5).spreadMinutes, 5, 'a source can have its own spread');
  assert.equal(limitsOf('kanka-api', { maxPerMinute: 90 }, { ALX_CRAWL_RATE: '0' }).perMinute, 0, 'ALX_CRAWL_RATE=0 switches limits off (tests)');
});

test('RateLimit_BucketCapsCallsAMinuteAndAnySecond', async () => {
  const clock = fakeClock();
  const lim = new Limiter('k', { perMinute: 5, perSecond: 2, spreadMinutes: 0 });
  const times: number[] = [];
  for (let i = 0; i < 12; i++) { await lim.acquire(); times.push(clock.t); }
  for (let i = 0; i + 2 < times.length; i++) assert.ok(times[i + 2] - times[i] >= 1000, `no more than 2 calls in any second (${i})`);
  for (let i = 0; i + 5 < times.length; i++) assert.ok(times[i + 5] - times[i] >= 60_000, `no more than 5 calls in any minute (${i})`);
  assert.ok(times[11] - times[0] >= 60_000, '12 calls at 5 a minute take over a minute');
});

test('RateLimit_ATooHighLimitIsLoweredToWhatTheSiteSays', async () => {
  const clock = fakeClock();
  const lim = new Limiter('k', { perMinute: 90, perSecond: 0, spreadMinutes: 0 });
  lim.observe(new Headers({ 'X-RateLimit-Limit': '30', 'X-RateLimit-Remaining': '29' }), 200);
  assert.equal(lim.perMinute, 27, 'stays a tenth under the limit the site published');
  const times: number[] = [];
  for (let i = 0; i < 30; i++) { await lim.acquire(); times.push(clock.t); }
  for (let i = 0; i + 27 < times.length; i++) assert.ok(times[i + 27] - times[i] >= 60_000);
});

test('RateLimit_ARateLimitHeaderThatSaysNoneLeftWaitsForTheReset', async () => {
  const clock = fakeClock();
  const lim = new Limiter('k', { perMinute: 60, perSecond: 0, spreadMinutes: 0 });
  await lim.acquire();
  const t0 = clock.t;
  lim.observe(new Headers({ 'RateLimit-Limit': '60', 'RateLimit-Remaining': '0', 'RateLimit-Reset': '12' }), 200);
  assert.equal(lim.throttle()?.reason, 'asked');
  await lim.acquire();
  assert.ok(clock.t - t0 >= 12_000, 'waited for the reset');
});

test('RateLimit_A429WaitsRetryAfterAndAsksOnceMoreNotRepeatedly', async () => {
  const clock = fakeClock();
  const lim = new Limiter('k', { perMinute: 60, perSecond: 0, spreadMinutes: 0 });
  const calls: number[] = [];
  const inner = (async () => { calls.push(clock.t); return calls.length === 1 ? new Response('slow down', { status: 429, headers: { 'Retry-After': '9' } }) : json({ ok: true }); }) as unknown as typeof fetch;
  const counter = new CallCounter();
  const f = limitedFetch(inner, lim, new AbortController().signal, counter);
  const r = await f('https://x.example/a');
  assert.equal(r.status, 200);
  assert.equal(calls.length, 2, 'one retry, no more');
  assert.ok(calls[1] - calls[0] >= 9000, 'it waited what the site asked');
  // Without Retry-After: exponential back-off with jitter, and it never hammers: it gives up after a few tries and returns the 429.
  calls.length = 0;
  const always = (async () => { calls.push(clock.t); return new Response('', { status: 429 }); }) as unknown as typeof fetch;
  const r2 = await limitedFetch(always, lim, new AbortController().signal, counter)('https://x.example/b');
  assert.equal(r2.status, 429);
  assert.equal(calls.length, 5, 'the first call and four retries');
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i] - calls[i - 1] >= 2 ** (i - 1) * 1000, `back-off grows (${i})`);
});

test('RateLimit_SpacingPacesTheScan', async () => {
  const clock = fakeClock();
  const lim = new Limiter('k', { perMinute: 600, perSecond: 0, spreadMinutes: 2 });
  const times: number[] = [];
  for (let i = 0; i < 4; i++) { await lim.acquire(undefined, 30_000); times.push(clock.t); }
  assert.deepEqual(times.slice(1).map((t, i) => t - times[i]), [30_000, 30_000, 30_000]);
  // Unpaced calls (details) are not held back by the pace.
  const before = clock.t;
  await lim.acquire(undefined, 0);
  assert.equal(clock.t, before);
});

// ---- hourly caps, the project allowance, the site's own limit, the reserve for opens --------------------------------------------------

test('RateLimit_AnHourlyCapHoldsInAnyHourAndRecovers', async () => {
  const clock = fakeClock();
  const lim = new Limiter('h', { perMinute: 0, perSecond: 0, spreadMinutes: 0, perHour: 10 });
  const times: number[] = [];
  for (let i = 0; i < 14; i++) { await lim.acquire(); times.push(clock.t); }
  for (let i = 0; i + 10 < times.length; i++) assert.ok(times[i + 10] - times[i] >= 3_600_000, `no more than 10 calls in any hour (${i})`);
  assert.ok(times[10] - times[0] >= 3_600_000, 'the 11th call waited for the first to leave the hour');
  assert.equal(lim.snapshot().perHour, 10);
});

test('RateLimit_EveryKeyOfOneLegendKeeperProjectSharesOneHourlyAllowance', async () => {
  const clock = fakeClock();
  const db = {};
  const win = projectWindow(db, 'proj:abc', 12);
  const a = new Limiter('key-a', { perMinute: 0, perSecond: 0, spreadMinutes: 0, perHour: 100 });
  const b = new Limiter('key-b', { perMinute: 0, perSecond: 0, spreadMinutes: 0, perHour: 100 });
  a.project = win; b.project = projectWindow(db, 'proj:abc', 12);
  assert.equal(b.project, win, 'the same project is the same window, whichever limiter asks');
  const times: number[] = [];
  for (let i = 0; i < 16; i++) { await (i % 2 ? b : a).acquire(); times.push(clock.t); }
  assert.ok(times[12] - times[0] >= 3_600_000, 'two keys together made 12 calls in the hour, the 13th waits');
  for (let i = 0; i + 12 < times.length; i++) assert.ok(times[i + 12] - times[i] >= 3_600_000);
  // Another project, or another database, has its own.
  assert.notEqual(projectWindow(db, 'proj:other', 12), win);
  assert.notEqual(projectWindow({}, 'proj:abc', 12), win);
  // The project comes from the connection's own settings (LegendKeeper only), whichever way the address is given.
  assert.deepEqual(projectOf('legendkeeper-api', { apiUrl: 'https://www.legendkeeper.com/api/v3/projects/ABC123/' }), { id: 'abc123', perHour: 12000 });
  assert.deepEqual(projectOf('legendkeeper-mcp', { project: 'My World' }), { id: 'my world', perHour: 12000 });
  assert.equal(projectOf('kanka-api', { campaignId: '1' }), null);
  assert.equal(projectOf('legendkeeper-api', {}), null);
});

test('RateLimit_TheSitesOwnPerMinuteLimitIsAdoptedWhenLowerThanOurs', async () => {
  const clock = fakeClock();
  const lim = new Limiter('k', { perMinute: 300, perSecond: 0, spreadMinutes: 0, perHour: 0 });
  lim.observe(new Headers({ 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '199' }), 200);
  assert.equal(lim.perMinute, 180, 'the real key answered 200 a minute: stay a tenth under it');
  // Not lower than ours: nothing changes.
  const same = new Limiter('k2', { perMinute: 200, perSecond: 0, spreadMinutes: 0, perHour: 0 });
  same.observe(new Headers({ 'X-RateLimit-Limit': '200' }), 200);
  assert.equal(same.perMinute, 200);
  const times: number[] = [];
  for (let i = 0; i < 190; i++) { await lim.acquire(); times.push(clock.t); }
  for (let i = 0; i + 180 < times.length; i++) assert.ok(times[i + 180] - times[i] >= 60_000);
});

test('RateLimit_BackgroundReadsNeverTakeTheReserveKeptForOpens', async () => {
  const clock = fakeClock();
  const lim = new Limiter('r', { perMinute: 10, perSecond: 0, spreadMinutes: 0, perHour: 0 });
  // 8 background calls fit in the minute (80%); the 9th waits for the minute to pass.
  const bg: number[] = [];
  for (let i = 0; i < 9; i++) { await lim.acquire(undefined, 0, true); bg.push(clock.t); }
  assert.equal(bg[7] - bg[0], 0, 'eight went at once');
  assert.ok(bg[8] - bg[0] >= 60_000, 'the ninth background call waited: the last two are for opens');
  // After eight background calls, a page somebody opens goes straight away.
  const clock2 = fakeClock();
  const lim2 = new Limiter('r2', { perMinute: 10, perSecond: 0, spreadMinutes: 0, perHour: 0 });
  for (let i = 0; i < 8; i++) await lim2.acquire(undefined, 0, true);
  const t0 = clock2.t;
  await lim2.acquire(); await lim2.acquire();
  assert.equal(clock2.t, t0, 'both reserved calls were available at once');
  // The same for the hour.
  const clock3 = fakeClock();
  const lim3 = new Limiter('r3', { perMinute: 0, perSecond: 0, spreadMinutes: 0, perHour: 10 });
  const hb: number[] = [];
  for (let i = 0; i < 9; i++) { await lim3.acquire(undefined, 0, true); hb.push(clock3.t); }
  assert.ok(hb[8] - hb[0] >= 3_600_000, 'background stops at 80% of the hour');
  const t1 = clock3.t;
  await lim3.acquire();
  assert.equal(clock3.t, t1, 'an open takes the reserve');
});

test('RateLimit_TheBackgroundBudgetDefaultsToFortyForLegendKeeperAndStaysUnderTheCaps', async () => {
  resetLimiters();
  const made = createApp({ noScheduler: true, fetch: siteFetch, env: { ALX_RATE_LIMIT: '0' } });
  const st = getState(made.deps.db, 'none');
  const lk = tieredOf('legendkeeper-api', { apiUrl: 'https://www.legendkeeper.com/api/v3/projects/p1', apiKey: 'lk_testkey_1234567890' })!;
  assert.equal(budgetOf(st, lk), 40);
  assert.ok(lk.budgetPerMinute >= 40 && lk.budgetPerMinute <= 160, 'under 80% of 200 a minute');
  assert.ok(lk.budgetPerMinute * 60 <= 6000 * 0.8, 'and under 80% of the hourly cap');
  // A low per-minute setting or an hourly cap pulls the budget down with it.
  const low = tieredOf('legendkeeper-api', { apiUrl: 'https://www.legendkeeper.com/api/v3/projects/p1', apiKey: 'lk_testkey_1234567890', maxPerMinute: 30 })!;
  assert.equal(budgetOf(st, low), 24);
  const hourly = tieredOf('legendkeeper-api', { apiUrl: 'https://www.legendkeeper.com/api/v3/projects/p1', apiKey: 'lk_testkey_1234567890', maxPerHour: 1200 })!;
  assert.equal(budgetOf(st, hourly), 16, '80% of 1,200 an hour is 16 a minute');
  const kanka = tieredOf('kanka-api', { token: 'kanka-token-aaaaaaaaaaaaaaaaaaaa', campaignId: '1' })!;
  assert.equal(budgetOf(st, kanka), 12, 'Kanka keeps half of its 80% of 30 a minute');
});

// ---- the app: a generic API source with a limit -----------------------------------------------------------------------------------

const SITE = 'https://limits.example.com/api';
const site = { calls: [] as { path: string; at: number }[], now: () => 0, answer: undefined as undefined | ((p: string, n: number) => Response | null), counts: {} as Record<string, number> };
const PAGES = [
  { id: 'p1', title: 'Shared index', is_private: false },
  { id: 'p2', title: 'Private index', is_private: true },
  { id: 'p3', title: 'No visibility known' },
];
const siteFetch = (async (url: any) => {
  const u = new URL(String(url));
  if (u.origin !== 'https://limits.example.com') return json({ error: 'unexpected ' + url }, 404);
  const p = u.pathname.slice('/api'.length);
  site.calls.push({ path: p, at: site.now() });
  site.counts[p] = (site.counts[p] ?? 0) + 1;
  const special = site.answer?.(p, site.counts[p]);
  if (special) return special;
  if (p === '/pages') return json({ data: PAGES });
  if (p === '/places') return json({ data: [{ id: 'q1', title: 'A place', is_private: false }] });
  if (p === '/things') return json({ data: [{ id: 't1', title: 'A thing', is_private: false }] });
  const m = /^\/pages\/(\w+)$/.exec(p);
  if (m) { const r = PAGES.find((x) => x.id === m[1]); return r ? json({ data: { ...r, body: `FULLBODY ${r.id} secret-ish text` } }) : json({}, 404); }
  return json({ error: 'not found' }, 404);
}) as typeof fetch;

const ENDPOINTS = [
  { path: '/pages', role: 'pages', use: true, key: 'pages', itemsPath: 'data', idField: 'id', titleField: 'title', bodyField: 'body', detailPath: '/pages/{id}', visibilityField: 'is_private', sharedValues: 'false' },
  { path: '/places', role: 'places', use: true, key: 'places', itemsPath: 'data', idField: 'id', titleField: 'title', visibilityField: 'is_private', sharedValues: 'false' },
  { path: '/things', role: 'items', use: true, key: 'things', itemsPath: 'data', idField: 'id', titleField: 'title', visibilityField: 'is_private', sharedValues: 'false' },
];

async function boot(env: Record<string, string> = {}) {
  resetBuckets();
  resetLimiters();
  site.calls = []; site.answer = undefined; site.counts = {}; site.now = () => 0;
  const made = createApp({ noScheduler: true, fetch: siteFetch, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ...env } });
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
  const addPlayer = async (wid: string) => {
    const inv = await ok('POST', `/api/worlds/${wid}/invites`, { role: 'player' });
    const j = (await call('POST', '/api/join', null, { code: inv.code, username: 'jess' + Math.random().toString(36).slice(2, 6), password: 'player pass 123', characterName: 'Jess' })).body;
    return { token: j.token as string, accountId: j.account.id as string };
  };
  const connection = async (limits: Record<string, number>) => {
    const conn = await ok('POST', '/api/admin/connections', { kind: 'api', name: 'Limited app', config: { transport: 'http', baseUrl: SITE, token: 'limit-token-1234567890', ...limits } });
    await ok('PUT', `/api/admin/connections/${conn.id}/endpoints`, { endpoints: ENDPOINTS });
    return conn;
  };
  const world = async (name: string, conn: any) => {
    const wid = (await ok('POST', '/api/admin/worlds', { name, gmAccountId: a.account.id })).id as string;
    const src = await ok('POST', `/api/admin/worlds/${wid}/sources`, { connectionId: conn.id, kind: 'api', name, config: {}, defaultVisibility: 'party' });
    const sync = () => ok('POST', `/api/admin/sources/${src.id}/sync?wait=1`, {});
    return { wid, sid: src.id as string, sync };
  };
  return { ...made, call, ok, admin, addPlayer, base, connection, world, accountId: a.account.id as string };
}

test('RateLimit_TwoWorldsOnOneConnectionShareOneBucket', async () => {
  const clock = fakeClock();
  const t = await boot();
  site.now = () => clock.t;
  const conn = await t.connection({ maxPerMinute: 4, maxPerSecond: 0, spreadMinutes: 0 });
  const one_ = await t.world('World one', conn);
  const two = await t.world('World two', conn);
  await one_.sync();
  await two.sync();
  const at = site.calls.map((c) => c.at);
  assert.equal(at.length, 6, 'three list calls for each world');
  for (let i = 0; i + 4 < at.length; i++) assert.ok(at[i + 4] - at[i] >= 60_000, `the second world waits for the first one's calls to leave the minute (${i})`);
  // The setting is the connection's: the world page shows it, and changing it there changes it for both worlds.
  const tiers = await t.ok('GET', `/api/admin/connections/tiers/world/${two.wid}`);
  assert.equal(tiers[0].limits.perMinute, 4);
  assert.equal(tiers[0].limits.spreadMinutes, 0);
  await t.ok('PATCH', `/api/admin/connections/tiers/${two.sid}`, { limits: { perMinute: 7, perSecond: 1 }, spread: 3 });
  const after2 = await t.ok('GET', `/api/admin/connections/tiers/world/${one_.wid}`);
  assert.deepEqual([after2[0].limits.perMinute, after2[0].limits.perSecond, after2[0].limits.spreadMinutes], [7, 1, 0], 'the other world has the new limits, and its own spread');
  const mine = await t.ok('GET', `/api/admin/connections/tiers/world/${two.wid}`);
  assert.deepEqual([mine[0].limits.spreadMinutes, mine[0].limits.spreadOwn], [3, true]);
  assert.equal((await t.call('PATCH', `/api/admin/connections/tiers/${two.sid}`, t.admin, { limits: { perMinute: 0 } })).status, 400, 'at least one call a minute');
  assert.equal((await t.call('PATCH', `/api/admin/connections/tiers/${two.sid}`, t.admin, { spread: -1 })).status, 400);
});

test('RateLimit_ASecondCapHoldsAcrossRealCalls', async () => {
  const clock = fakeClock();
  const t = await boot();
  site.now = () => clock.t;
  const conn = await t.connection({ maxPerMinute: 600, maxPerSecond: 1, spreadMinutes: 0 });
  const w = await t.world('Fast world', conn);
  await w.sync();
  const at = site.calls.map((c) => c.at);
  assert.equal(at.length, 3);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 1000, 'one call a second');
});

test('RateLimit_A429OnARealSyncWaitsTheTimeTheSiteAskedAndIsShownLive', async () => {
  const clock = fakeClock();
  const t = await boot();
  site.now = () => clock.t;
  site.answer = (p, n) => (p === '/places' && n === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '14' } }) : null);
  const conn = await t.connection({ maxPerMinute: 60, maxPerSecond: 0, spreadMinutes: 0 });
  const w = await t.world('Throttled world', conn);
  const seen: any[] = [];
  clock.onSleep = () => { const src = one<any>(t.deps.db, 'SELECT * FROM sources WHERE id = ?', w.sid)!; const th = (tierSummary(t.deps, src) as any).throttle; if (th) seen.push(th); };
  const out = await w.sync();
  assert.equal(out.status, 'ok');
  const places = site.calls.filter((c) => c.path === '/places');
  assert.equal(places.length, 2, 'asked again once, after the wait');
  assert.ok(places[1].at - places[0].at >= 14_000);
  assert.ok(seen.some((x) => x.reason === 'asked' && x.waitMs > 0), 'the world page can say the site asked us to slow down');
  assert.equal((await t.ok('GET', `/api/admin/connections/tiers/world/${w.wid}`))[0].throttle, null, 'nothing is shown once it clears');
  // Headers on a good answer slow the next call down too.
  const w2 = await t.world('Header world', conn);
  site.calls = []; site.counts = {};
  site.answer = (p) => (p === '/pages' ? json({ data: PAGES }, 200, { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '20' }) : null);
  await w2.sync();
  const [first, second] = site.calls;
  assert.equal(first.path, '/pages');
  assert.ok(second.at - first.at >= 20_000, 'the next call waited for the reset');
});

test('RateLimit_TheFirstScanIsSpreadOverTheWindowAndNeverAboveTheLimit', async () => {
  const clock = fakeClock();
  const t = await boot();
  site.now = () => clock.t;
  const conn = await t.connection({ maxPerMinute: 600, maxPerSecond: 0, spreadMinutes: 0 });
  const w = await t.world('Spread world', conn);
  // The last complete scan made 6 calls: spreading it over 3 minutes puts 30 s between calls.
  run(t.deps.db, 'INSERT OR IGNORE INTO connections_source_state (source_id) VALUES (?)', w.sid);
  run(t.deps.db, 'UPDATE connections_source_state SET last_index_calls = 6 WHERE source_id = ?', w.sid);
  await t.ok('PATCH', `/api/admin/connections/tiers/${w.sid}`, { spread: 3 });
  await w.sync();
  const at = site.calls.map((c) => c.at);
  assert.equal(at.length, 3);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 30_000, `calls are spread out (${i})`);
  // Zero: as fast as the limits allow.
  const w2 = await t.world('Fast spread world', conn);
  await t.ok('PATCH', `/api/admin/connections/tiers/${w2.sid}`, { spread: 0 });
  site.calls = [];
  const t0 = clock.t;
  await w2.sync();
  assert.equal(site.calls.length, 3);
  assert.ok(clock.t - t0 < 1000, 'no pacing');
  // The setting is shown, and the default is a minute.
  const w3 = await t.world('Default world', conn);
  const c2 = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'Plain', config: { transport: 'http', baseUrl: SITE, token: 'limit-token-1234567890' } });
  assert.equal(limitsOf('api', {}, {}, null).spreadMinutes, 1);
  assert.ok(w3 && c2);
});

// ---- opening a page you may not see costs nothing -----------------------------------------------------------------------------------

test('RateLimit_APlayerOpeningAPageTheyCannotSeeSpendsNoCallAndTheGmSpendsOne', async () => {
  const t = await boot({ ALX_CRAWL_RATE: '0' });
  const conn = await t.connection({});
  const w = await t.world('On-demand world', conn);
  await w.sync();
  const gmView = { accountId: t.accountId, role: 'gm' as const };
  const idOf = (title: string) => (t.deps.library.list(w.wid, gmView) as any[]).find((p) => p.title === title).id as string;
  const depth = (id: string) => one<any>(t.deps.db, 'SELECT depth FROM pages WHERE id = ?', id).depth;
  const hidden = idOf('No visibility known');
  const priv = idOf('Private index');
  assert.equal(depth(hidden), 'index');
  const player = await t.addPlayer(w.wid);
  const open = (token: string, id: string) => t.call('GET', `/api/worlds/${w.wid}/library/pages/${id}`, token);
  site.calls = []; site.counts = {};
  for (const id of [hidden, priv]) {
    const r = await open(player.token, id);
    assert.equal(r.status, 404);
    assert.ok(!r.text.includes('FULLBODY'));
  }
  assert.equal(site.calls.length, 0, 'a player opening GM-only pages costs no call');
  assert.equal(depth(hidden), 'index', 'and nothing was read');
  assert.equal(one<any>(t.deps.db, 'SELECT wanted FROM pages WHERE id = ?', hidden).wanted, 0, 'it is not even marked as wanted');
  const r = await open(t.admin, hidden);
  assert.equal(r.status, 200);
  assert.equal(site.calls.length, 1, 'the GM opening it reads it once');
  assert.equal(site.calls[0].path, '/pages/p3');
  assert.match(r.text, /FULLBODY p3/);
  // The player still cannot see it after it was read (it has no visibility from the source: GM-only), and the audit of the call count stays at one.
  assert.equal((await open(player.token, hidden)).status, 404);
  assert.equal(site.calls.length, 1);
  // The model's GM harness path is the same function: an unseen page for a player viewer reads nothing.
  site.calls = [];
  const { readOnOpen } = await import('../src/features/connections/ondemand.ts');
  assert.equal(await readOnOpen(t.deps, w.wid, priv, { accountId: player.accountId, role: 'player' }), 'unavailable');
  assert.equal(site.calls.length, 0);
  assert.ok(ensureFull);
  assert.ok(all);
});

// ---- the GM is told when a page they opened is waiting for the site ----------------------------------------------------------------

test('RateLimit_AnOpenHeldBackByTheSiteShowsAsAWaitForTheGm_AndABackgroundOnlyWaitDoesNot', async () => {
  const clock = fakeClock();
  const t = await boot();
  site.now = () => clock.t;
  const conn = await t.connection({ maxPerMinute: 10, maxPerSecond: 0, spreadMinutes: 0 });
  const w = await t.world('Waiting world', conn);
  await w.sync();
  const src = one<any>(t.deps.db, 'SELECT * FROM sources WHERE id = ?', w.sid)!;
  const lim = limiterFor(limitKeyOf(src, t.deps.db), limitsOf('api', { maxPerMinute: 10, maxPerSecond: 0, spreadMinutes: 0 }));
  assert.equal(worldStatus(t.deps, w.wid).waiting, null, 'nothing to wait for');
  // The site says slow down: the GM's Library says how long, whoever caused it.
  lim.observe(new Headers({ 'Retry-After': '20' }), 429);
  const waiting = worldStatus(t.deps, w.wid).waiting!;
  assert.ok(waiting && waiting.seconds >= 19 && waiting.seconds <= 20 && waiting.reason === 'asked', JSON.stringify(waiting));
  assert.equal((await t.ok('GET', `/api/worlds/${w.wid}/world-sources/status`)).waiting.reason, 'asked');
  // A player is told nothing.
  const p = await t.addPlayer(w.wid);
  assert.equal((await t.call('GET', `/api/worlds/${w.wid}/world-sources/status`, p.token)).body.waiting, null);
  // It clears with time.
  clock.t += 25_000;
  assert.equal(worldStatus(t.deps, w.wid).waiting, null);
  // Background reads giving way to the reserve are not a wait the GM would share: a page they open goes straight through.
  const lim2 = new Limiter('bg', { perMinute: 10, perSecond: 0, spreadMinutes: 0, perHour: 0 });
  for (let i = 0; i < 8; i++) await lim2.acquire(undefined, 0, true);
  clock.onSleep = () => assert.equal(lim2.throttle(), null, 'a background-only wait is not shown');
  await lim2.acquire(undefined, 0, true);
  clock.onSleep = undefined;
});
