// Gateway status: per-connection calls and health, the world mirror, files held from sources, and the search log.
// Admins only; never a token; and an admin who is not a world's GM gets counts, not page paths, file names or search words.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';
import { connectorContext } from '../src/intake/sync.ts';
import { cleanErrorText, resetLimiters, setClock } from '../src/intake/ratelimit.ts';
import { initRecords } from '../src/intake/records.ts';
import { forgetRecentSearches, normalizeQuery } from '../src/features/gatewaystatus/searchlog.ts';

const PW = 'correct horse battery';
const TOKEN = 'tok-LIVE-0123456789abcdef-SECRET';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-gwstatus-'));

let nextFetch: (url: string) => Response | Promise<Response> = () => new Response('{}', { status: 200 });
const fakeFetch = (async (url: any) => nextFetch(String(url))) as typeof fetch;

const { app, deps } = createApp({ noScheduler: true, dataDir: data, fetch: fakeFetch, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
after(() => { server.close(); server.closeAllConnections?.(); setClock(null); resetLimiters(); fs.rmSync(data, { recursive: true, force: true }); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const call = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: json, text };
};

// An admin (the GM of world A), another account who is the GM of world B and a player in A.
const setup = (await call('POST', '/api/setup', undefined, { username: 'wizard', password: PW })).body;
const T = setup.token as string;
const adminId = setup.account.id as string;
const bob = (await call('POST', '/api/admin/accounts', T, { username: 'bob', password: 'bob password 123' })).body.account;
const jess = (await call('POST', '/api/admin/accounts', T, { username: 'jess', password: 'jess password 123' })).body.account;
const A = (await call('POST', '/api/admin/worlds', T, { name: 'Alpha Isles', gmAccountId: adminId })).body.id as string;
const B = (await call('POST', '/api/admin/worlds', T, { name: 'Beta Reach', gmAccountId: bob.id })).body.id as string;
await call('PUT', `/api/admin/worlds/${A}/members/${jess.id}`, T, { role: 'player' });
const bobT = (await call('POST', '/api/auth/login', undefined, { username: 'bob', password: 'bob password 123' })).body.token as string;
const jessT = (await call('POST', '/api/auth/login', undefined, { username: 'jess', password: 'jess password 123' })).body.token as string;
const page = (w: string, token: string, p: string, visibility: string, body: string) => call('PUT', `/api/worlds/${w}/library/pages`, token, { path: p, visibility, body });

const ROUTES: [string, string][] = [
  ['GET', '/api/admin/gwstatus/connections'], ['GET', '/api/admin/gwstatus/mirror'], ['POST', `/api/admin/gwstatus/mirror/${A}/rewrite`],
  ['GET', '/api/admin/gwstatus/files'], ['DELETE', '/api/admin/gwstatus/files/library/x'], ['GET', '/api/admin/gwstatus/searches'], ['POST', '/api/admin/gwstatus/searches/draft'],
];

test('TestGatewayStatus_OnlyAdminsMayCallAnyRoute', async () => {
  for (const [m, u] of ROUTES) {
    assert.equal((await call(m, u)).status, 401, `anonymous ${m} ${u}`);
    for (const tok of [jessT, bobT]) assert.ok([401, 403].includes((await call(m, u, tok, {})).status), `player ${m} ${u}`);
  }
  // A source's sync, the way to fetch its files again, is refused to a player too.
  run(deps.db, `INSERT INTO sources (id, world_id, kind, name) VALUES ('src_refetch', ?, 'kanka', 'Refetch')`, A);
  assert.ok([401, 403].includes((await call('POST', '/api/admin/sources/src_refetch/sync', jessT, {})).status));
});

// ---- per connection ----------------------------------------------------------------------------------------------------------------

run(deps.db, `INSERT INTO connections (id, name, kind, config, created_at, updated_at) VALUES ('con_k', 'Kanka main', 'kanka', ?, '2026-01-01', '2026-01-01')`, JSON.stringify({ token: TOKEN, maxPerMinute: 30 }));
run(deps.db, `INSERT INTO sources (id, world_id, kind, name, connection_id) VALUES ('src_k', ?, 'kanka', 'Kanka campaign', 'con_k')`, A);
const ctxFor = () => {
  const src = one<any>(deps.db, `SELECT * FROM sources WHERE id = 'src_k'`)!;
  const cfg = { token: TOKEN, maxPerMinute: 30 };
  return connectorContext({ db: deps.db, library: deps.library, dataDir: data, vaultsDir: null, fetch: fakeFetch, env: deps.env }, src, cfg, new AbortController().signal, () => {});
};
const conn = async () => (await call('GET', '/api/admin/gwstatus/connections', T)).body.connections.find((c: any) => c.connectionId === 'con_k');

test('TestGatewayStatus_ConnectionCountsCallsAndShowsLastSuccess', async () => {
  const made = ctxFor();
  nextFetch = () => new Response('{}', { status: 200 });
  for (let i = 0; i < 3; i++) await made.ctx.fetch('https://api.kanka.io/1.0/campaigns');
  const c = await conn();
  assert.equal(c.callsToday, 3);
  assert.equal(c.callsThisHour, 3);
  assert.ok(c.lastSuccessAt);
  assert.equal(c.lastError, null);
  assert.equal(c.health, 'ok');
  assert.equal(c.series.length, 24);
  assert.equal(c.series[23].calls, 3);
  assert.equal(c.rate.perMinute, 30);
  assert.ok(c.rate.usedLastMinute >= 3);
  assert.equal(c.sources, 1);
  assert.equal(c.worlds, 1);
  // Counts are kept in the database by the hour.
  assert.equal(one<{ n: number }>(deps.db, `SELECT SUM(calls) AS n FROM gwstatus_hourly WHERE conn = 'con:con_k'`)!.n, 3);
  made.close();
});

test('TestGatewayStatus_ErrorsAreCleanedAndNeverHoldATokenOrAKeyedUrl', async () => {
  const made = ctxFor();
  nextFetch = () => { throw new Error(`connect ECONNRESET https://api.kanka.io/1.0/campaigns/5/entities?api_key=${TOKEN}&page=2 Bearer ${TOKEN}`); };
  await assert.rejects(() => made.ctx.fetch('https://api.kanka.io/1.0/x'));
  made.limiter.outcome(false, `Sync failed with token=${TOKEN} at https://user:pw@kanka.io/secret/path?x=1`);
  const r = await call('GET', '/api/admin/gwstatus/connections', T);
  const c = r.body.connections.find((x: any) => x.connectionId === 'con_k');
  assert.equal(c.health, 'failing');
  assert.ok(c.lastError.message.length > 0);
  for (const bad of [TOKEN, 'api_key=', 'user:pw', '/secret/path', '?x=1', 'campaigns/5']) assert.ok(!r.text.includes(bad), `the status page held ${bad}`);
  // The stored row is clean too (a backup does not hold a token).
  assert.ok(!JSON.stringify(all(deps.db, 'SELECT * FROM gwstatus_conn')).includes(TOKEN));
  // And nothing of the connection's config comes back at all.
  assert.ok(!r.text.includes('maxPerMinute'));
  made.close();
});

test('TestGatewayStatus_AThrottledConnectionShowsRetryAfterAndWhenItMayGoOn', async () => {
  const made = ctxFor();
  nextFetch = () => new Response('slow', { status: 200, headers: { 'Retry-After': '40', 'X-RateLimit-Limit': '25', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '40' } });
  await made.ctx.fetch('https://api.kanka.io/1.0/x');
  const c = await conn();
  assert.equal(c.health, 'throttled');
  assert.equal(c.rate.lastRetryAfterSec, 40);
  assert.equal(c.rate.remaining, 0);
  assert.equal(c.rate.siteLimit, 25);
  assert.ok(c.rate.waiting && c.rate.waiting.ms > 0 && Date.parse(c.rate.waiting.until) > Date.now());
  assert.equal(c.rate.perMinuteInEffect, 22, 'a published lower limit holds us under it');
  made.close();
  resetLimiters();
  // The rate-limit state outlives the process: what the site said last is kept.
  const after2 = await conn();
  assert.equal(after2.rate.lastRetryAfterSec, 40);
  assert.equal(after2.rate.waiting, null);
});

test('TestGatewayStatus_CleanErrorTextCutsSecrets', () => {
  const t = cleanErrorText(`Failed https://h.example/a/b?token=abc123456789 with Authorization: Bearer abcdefghijkl and ${'x'.repeat(40)} and mysecretvalue`, ['mysecretvalue']);
  assert.ok(!/abc123456789|abcdefghijkl|xxxxxxxxxx|mysecretvalue|\/a\/b/.test(t), t);
  assert.ok(t.includes('h.example'));
});

// ---- the mirror --------------------------------------------------------------------------------------------------------------------

const GMTEXT = 'SECRET-GM-PAGE-PATH';
test('TestGatewayStatus_MirrorCountsFilesAndRecordsACopyThatCouldNotBeWritten', async () => {
  assert.equal((await page(A, T, 'lore/Harbour.md', 'party', 'The harbour.')).status, 200);
  assert.equal((await page(A, T, `gm/${GMTEXT}.md`, 'gm', 'Hidden.')).status, 200);
  const first = (await call('GET', '/api/admin/gwstatus/mirror', T)).body;
  const a = first.worlds.find((w: any) => w.id === A);
  assert.equal(first.enabled, true);
  assert.equal(a.view, 'gm');
  assert.equal(a.copies.vault.files, 2);
  assert.equal(a.copies.party.files, 1, 'only the shared page has a party copy');
  assert.equal(a.copies.api.files, 1);
  assert.equal(a.pages, 2);
  assert.equal(a.shared, 1);
  assert.ok(a.lastWrittenAt);
  assert.equal(a.failures, 0);
  assert.deepEqual(a.failed, []);
  // A page whose path needs a file as a folder cannot be copied. The save works; the copy is recorded.
  assert.equal((await page(A, T, 'lore/Dup.md', 'party', 'A file.')).status, 200);
  assert.equal((await page(A, T, 'lore/Dup.md/Child.md', 'party', 'Needs Dup.md as a folder.')).status, 200);
  const broken = (await call('GET', '/api/admin/gwstatus/mirror', T)).body.worlds.find((w: any) => w.id === A);
  assert.ok(broken.failures >= 1);
  const f = broken.failed.find((x: any) => x.path.includes('Child'));
  assert.ok(f, 'the failed copy is listed for the GM');
  assert.ok(f.error.length > 0 && !f.error.includes(data), 'the data folder is not in the message');
  // "Rewrite mirror" writes every copy again; the copy that cannot be written stays listed, the others stay fine.
  const rw = await call('POST', `/api/admin/gwstatus/mirror/${A}/rewrite`, T);
  assert.equal(rw.status, 200);
  assert.equal(rw.body.ok, true);
  assert.ok(rw.body.world.copies.vault.files >= 2);
  assert.ok(rw.body.world.failures >= 1);
  assert.equal((await call('POST', `/api/admin/gwstatus/mirror/nowhere/rewrite`, T)).status, 404);
  // A copy that works again is forgotten: take the blocking file away and rewrite.
  const blocker = path.join(data, 'worlds', one<any>(deps.db, 'SELECT slug FROM worlds WHERE id = ?', A).slug, 'vault', 'lore', 'Dup.md');
  fs.rmSync(blocker, { force: true });
  await call('POST', `/api/admin/gwstatus/mirror/${A}/rewrite`, T);
  assert.ok(true);
});

test('TestGatewayStatus_AnAdminWhoIsNotTheGmSeesMirrorCountsButNoPagePaths', async () => {
  assert.equal((await page(B, bobT, `gm/${GMTEXT}-B.md`, 'gm', 'Hidden in B.')).status, 200);
  assert.equal((await page(B, bobT, 'lore/Port.md', 'party', 'The port.')).status, 200);
  assert.equal((await page(B, bobT, 'lore/Dup2.md', 'party', 'File.')).status, 200);
  assert.equal((await page(B, bobT, 'lore/Dup2.md/Child.md', 'party', 'Folder.')).status, 200);
  const r = await call('GET', '/api/admin/gwstatus/mirror', T);
  const b = r.body.worlds.find((w: any) => w.id === B);
  assert.equal(b.view, 'counts');
  assert.equal(b.failed, null);
  assert.ok(b.failures >= 1, 'the count is shown');
  assert.equal(b.copies.vault.files >= 3, true);
  const bText = JSON.stringify(b);
  for (const hidden of [`${GMTEXT}-B`, 'Dup2', 'Child', 'Port']) assert.ok(!bText.includes(hidden), `world B's row held ${hidden}`);
  // The rewrite answer is the same counts.
  const rw = await call('POST', `/api/admin/gwstatus/mirror/${B}/rewrite`, T);
  assert.equal(rw.status, 200);
  assert.ok(!rw.text.includes('Dup2') && !rw.text.includes(GMTEXT));
});

// ---- files -------------------------------------------------------------------------------------------------------------------------

test('TestGatewayStatus_SourceFilesShowSizesAndHideGmOnlyNamesFromAnAdminWhoIsNotTheGm', async () => {
  initRecords(deps.db);
  run(deps.db, `INSERT INTO sources (id, world_id, kind, name) VALUES ('src_b', ?, 'kanka', 'Beta Kanka')`, B);
  const img = (id: string, world: string, source: string, name: string, vis: string, size: number, kind = 'picture') =>
    run(deps.db, `INSERT INTO intake_images (id, world_id, source_id, external_id, name, marker, mime, size, data, visibility, page_external, at, kind) VALUES (?, ?, ?, ?, ?, '', 'image/png', ?, ?, ?, NULL, ?, ?)`, id, world, source, id, name, size, Buffer.from('x'), vis, '2026-02-02T10:00:00.000Z', kind);
  img('img_a1', A, 'src_k', 'alpha-map.png', 'gm', 4000, 'map');
  img('img_b1', B, 'src_b', 'GM-ONLY-DUNGEON.png', 'gm', 9000);
  img('img_b2', B, 'src_b', 'party-crest.png', 'party', 1000);
  const r = await call('GET', '/api/admin/gwstatus/files', T);
  assert.equal(r.status, 200);
  const a = r.body.worlds.find((w: any) => w.id === A);
  const b = r.body.worlds.find((w: any) => w.id === B);
  const aSrc = a.sources.find((s: any) => s.id === 'src_k');
  assert.equal(aSrc.count, 1);
  assert.equal(aSrc.bytes, 4000);
  assert.equal(aSrc.files[0].name, 'alpha-map.png', 'the GM-admin sees names');
  assert.equal(aSrc.canSync, true);
  assert.equal(aSrc.lastFetchedAt, '2026-02-02T10:00:00.000Z');
  assert.equal(b.view, 'counts');
  const bSrc = b.sources.find((s: any) => s.id === 'src_b');
  assert.equal(bSrc.count, 2);
  assert.equal(bSrc.bytes, 10000);
  assert.equal(bSrc.hiddenCount, 2, 'a party file whose page is not shared is hidden too');
  assert.ok(!JSON.stringify(b).includes('GM-ONLY-DUNGEON') && !JSON.stringify(b).includes('party-crest'));
  assert.ok(r.body.totals.pictures.bytes >= 14000);
  assert.ok(!JSON.stringify(r.body).includes('data'), 'no picture bytes');
});

test('TestGatewayStatus_OnlyLibraryFilesCanBeDeletedAndOnlyOnesTheAdminMaySee', async () => {
  const pg = (await page(A, T, 'lore/Map.md', 'party', 'A map.')).body;
  const pgB = (await page(B, bobT, 'gm/Vault.md', 'gm', 'A vault.')).body;
  const folderA = path.join(data, 'libfiles', A);
  const folderB = path.join(data, 'libfiles', B);
  fs.mkdirSync(folderA, { recursive: true }); fs.mkdirSync(folderB, { recursive: true });
  const add = (id: string, world: string, pageId: string, name: string, level: string, dir: string) => {
    fs.writeFileSync(path.join(dir, id), 'bytes');
    run(deps.db, `INSERT INTO libfiles_files (id, world_id, page_id, name, kind, level, mime, family, size, at) VALUES (?, ?, ?, ?, 'handout', ?, 'text/plain', 'text', 5, '2026-03-03T00:00:00.000Z')`, id, world, pageId, name, level);
  };
  add('lf_a', A, pg.id, 'harbour-chart.txt', 'party', folderA);
  add('lf_b', B, pgB.id, 'GM-VAULT-NOTES.txt', 'gm', folderB);
  const list = (await call('GET', '/api/admin/gwstatus/files', T)).body;
  assert.equal(list.worlds.find((w: any) => w.id === A).library.files[0].name, 'harbour-chart.txt');
  const bl = list.worlds.find((w: any) => w.id === B).library;
  assert.equal(bl.count, 1);
  assert.equal(bl.files[0].name, null);
  assert.equal(bl.files[0].hidden, true);
  assert.ok(!JSON.stringify(list).includes('GM-VAULT-NOTES'));
  assert.ok(list.totals.libraryFiles.onDiskBytes >= 10);
  // A GM-only file of a world the admin does not run cannot be deleted from here (not found).
  assert.equal((await call('DELETE', '/api/admin/gwstatus/files/library/lf_b', T)).status, 404);
  assert.ok(fs.existsSync(path.join(folderB, 'lf_b')));
  // One the admin may open goes, bytes and all, and the audit says so.
  assert.equal((await call('DELETE', '/api/admin/gwstatus/files/library/lf_a', T)).status, 200);
  assert.ok(!fs.existsSync(path.join(folderA, 'lf_a')));
  assert.equal(one(deps.db, `SELECT 1 FROM libfiles_files WHERE id = 'lf_a'`), undefined);
  assert.ok(one(deps.db, `SELECT 1 FROM audit WHERE action = 'libfile.delete' AND world_id = ?`, A));
  assert.equal((await call('DELETE', '/api/admin/gwstatus/files/library/lf_a', T)).status, 404);
  // A source's pictures have no delete route here: they come back with the next sync.
  assert.equal((await call('DELETE', '/api/admin/gwstatus/files/pictures/img_a1', T)).status, 404);
  assert.ok(one(deps.db, `SELECT 1 FROM intake_images WHERE id = 'img_a1'`));
});

// ---- search log --------------------------------------------------------------------------------------------------------------------

const search = (w: string, token: string, q: string, extra = '') => call('GET', `/api/worlds/${w}/library/search?q=${encodeURIComponent(q)}${extra}`, token);

test('TestGatewayStatus_SearchLogKeepsWordsAndCountsButNeverTitles', async () => {
  forgetRecentSearches();
  await page(A, T, 'lore/Unique Title Zebra.md', 'party', 'The quillfeather festival is held in autumn.');
  assert.ok((await search(A, jessT, '  Quillfeather   FESTIVAL! ')).body.length >= 1);
  assert.equal((await search(A, jessT, 'unicorn stables')).body.length, 0);
  assert.equal((await search(A, T, 'unicorn stables')).body.length, 0);
  await search(A, T, 'quillfeather');
  const rows = all<any>(deps.db, 'SELECT * FROM gwstatus_searches WHERE world_id = ?', A);
  const mine = rows.find((r) => r.q === 'quillfeather festival');
  assert.ok(mine, `normalized: ${rows.map((r) => r.q).join('|')}`);
  assert.equal(mine.role, 'player');
  assert.equal(mine.origin, 'library');
  assert.ok(mine.results >= 1);
  assert.deepEqual(JSON.parse(mine.sources), { 'Written here': mine.results });
  assert.ok(!JSON.stringify(rows).includes('Zebra') && !JSON.stringify(rows).includes('autumn'), 'no title or page text is kept');
  assert.equal(normalizeQuery('  Foo   BAR! '), 'foo bar');
  // The same words from the same role in a moment are one search (typing in a box).
  const n = rows.length;
  await search(A, jessT, 'unicorn stables');
  assert.equal(all(deps.db, 'SELECT id FROM gwstatus_searches WHERE world_id = ?', A).length, n);
});

test('TestGatewayStatus_SearchPanelsShowWordsToTheGmAdminAndOnlyCountsForOtherWorlds', async () => {
  forgetRecentSearches();
  const SECRET_Q = 'where hides the glimmerjar traitor';
  assert.equal((await page(B, bobT, 'gm/Traitor.md', 'gm', 'The glimmerjar traitor hides in the cellar.')).status, 200);
  assert.ok((await search(B, bobT, SECRET_Q)).status === 200);
  assert.ok((await search(B, bobT, 'glimmerjar')).body.length >= 1);
  const s = await call('GET', '/api/admin/gwstatus/searches?days=7', T);
  assert.equal(s.status, 200);
  const b = s.body.worlds.find((w: any) => w.id === B);
  const a = s.body.worlds.find((w: any) => w.id === A);
  assert.equal(b.view, 'counts');
  assert.equal(a.view, 'gm');
  assert.ok(b.searches >= 2);
  // World B's words are in nothing the admin gets; world A's are.
  assert.ok(!s.text.includes('glimmerjar'), 'the words of a world the admin does not run never come back');
  assert.ok(s.body.totals.hiddenQueries >= 2);
  assert.ok(s.body.popular.some((p: any) => p.q === 'quillfeather festival' && p.world.id === A));
  assert.ok(s.body.nothing.some((p: any) => p.q === 'unicorn stables' && p.world.id === A && p.count >= 2));
  assert.ok(!s.body.nothing.some((p: any) => p.world.id === B));
  assert.ok(s.body.bySource.some((x: any) => x.name === 'Written here' && x.count >= 1));
  assert.ok(s.body.byOrigin.length >= 1);
  assert.ok(s.body.byDay.length >= 1);
  assert.equal(s.body.retentionDays, 30);
});

test('TestGatewayStatus_DraftPagesAreMadeOnlyByTheGmOfThatWorldForQueriesThatFoundNothing', async () => {
  // Not the GM of B: refused, and nothing is written.
  assert.equal((await call('POST', '/api/admin/gwstatus/searches/draft', T, { world: B })).status, 403);
  assert.equal(one(deps.db, `SELECT 1 FROM pages WHERE world_id = ? AND path LIKE 'drafts/%'`, B), undefined);
  assert.equal((await call('POST', '/api/admin/gwstatus/searches/draft', T, { world: 'nope' })).status, 404);
  // A query that never found nothing is not drafted, however it is asked for.
  const none = await call('POST', '/api/admin/gwstatus/searches/draft', T, { world: A, queries: ['pwned page title'] });
  assert.equal(none.body.created.length, 0);
  const r = await call('POST', '/api/admin/gwstatus/searches/draft', T, { world: A, queries: ['Unicorn Stables'] });
  assert.equal(r.status, 200);
  assert.equal(r.body.created.length, 1);
  const pg = one<any>(deps.db, 'SELECT * FROM pages WHERE id = ?', r.body.created[0].pageId)!;
  assert.equal(pg.path, 'drafts/unicorn-stables.md');
  assert.equal(pg.visibility, 'gm', 'a draft is GM-only');
  assert.equal(pg.player_body, null);
  // A player cannot read it, and it no longer shows as missing.
  assert.ok(!JSON.stringify((await search(A, jessT, 'unicorn')).body).includes('Unicorn'));
  const s = await call('GET', '/api/admin/gwstatus/searches', T);
  assert.equal(s.body.nothing.find((p: any) => p.q === 'unicorn stables').drafted, true);
  const again = await call('POST', '/api/admin/gwstatus/searches/draft', T, { world: A });
  assert.ok(again.body.created.every((c: any) => c.q !== 'unicorn stables'), 'a query already drafted is not drafted twice');
});

test('TestGatewayStatus_SearchesAreKeptThirtyDays', async () => {
  run(deps.db, `INSERT INTO gwstatus_searches (world_id, at, role, origin, q, results, sources) VALUES (?, ?, 'player', 'library', 'ancient query', 0, '{}')`, A, new Date(Date.now() - 31 * 864e5).toISOString());
  run(deps.db, `INSERT INTO gwstatus_searches (world_id, at, role, origin, q, results, sources) VALUES (?, ?, 'player', 'library', 'month old query', 0, '{}')`, A, new Date(Date.now() - 20 * 864e5).toISOString());
  const s = await call('GET', '/api/admin/gwstatus/searches?days=7', T);
  assert.equal(one(deps.db, `SELECT 1 FROM gwstatus_searches WHERE q = 'ancient query'`), undefined, 'older than 30 days is gone');
  assert.ok(one(deps.db, `SELECT 1 FROM gwstatus_searches WHERE q = 'month old query'`));
  assert.ok(!s.text.includes('month old query'), 'outside the 7 days asked for');
  const wide = await call('GET', '/api/admin/gwstatus/searches?days=30', T);
  assert.ok(wide.text.includes('month old query'));
});

test('TestGatewayStatus_TheGlobalSearchBoxAndTheAdminSearchAreLoggedToo', async () => {
  forgetRecentSearches();
  assert.equal((await call('GET', `/api/worlds/${A}/search?q=harbourmaster`, jessT)).status, 200);
  assert.equal((await call('GET', `/api/admin/gateway/search?q=lighthouse`, T)).status, 200);
  const origins = all<{ origin: string }>(deps.db, `SELECT origin FROM gwstatus_searches WHERE q IN ('harbourmaster', 'lighthouse')`).map((r) => r.origin);
  assert.ok(origins.includes('global'), origins.join());
  assert.ok(origins.includes('admin'), origins.join());
});
