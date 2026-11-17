// The gateway admin's leak check, the Worlds cards, the admin search, the MCP access summary and the
// default-password warning: real data, admins only, and never a secret, hidden text or leaked words.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { run, one } from '../src/core/db.ts';
import { whenDone } from '../src/features/gateway/leakcheck.ts';

const PW = 'correct horse battery';
const DM_TEXT = 'the baron quietly poisons every harbour well at midnight under the full moon';
const NEVER = 'UNIQUEHIDDENTITLE';

const { app, deps } = createApp({ noScheduler: true, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
after(() => { server.close(); server.closeAllConnections?.(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const call = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: json, text };
};
const finish = async () => { await whenDone(); };

const admin = (await call('POST', '/api/setup', undefined, { username: 'wizard', password: PW })).body;
const adminToken = admin.token as string;
const mk = async (username: string) => (await call('POST', '/api/admin/accounts', adminToken, { username, password: `${username} password 123` })).body.account;
const dm = await mk('dmitri');
const jess = await mk('jess');
const login = async (u: string) => (await call('POST', '/api/auth/login', undefined, { username: u, password: `${u} password 123` })).body.token as string;
// Two worlds. The admin is the DM of the first and not a member of the second.
const wA = (await call('POST', '/api/admin/worlds', adminToken, { name: 'Alpha', dmAccountId: admin.account.id })).body.id as string;
const wB = (await call('POST', '/api/admin/worlds', adminToken, { name: 'Beta', dmAccountId: dm.id })).body.id as string;
for (const w of [wA, wB]) await call('PUT', `/api/admin/worlds/${w}/members/${jess.id}`, adminToken, { role: 'player' });
const playerToken = await login('jess');
const dmToken = await login('dmitri');

const put = (token: string, w: string, path: string, visibility: string, markdown: string) => call('PUT', `/api/worlds/${w}/library/pages`, token, { path, visibility, markdown });
await put(adminToken, wA, 'Plot', 'dm', `# Plot\n${DM_TEXT}.`);
await put(adminToken, wA, 'Port', 'party', '# Port\nA busy harbour town with salt and gulls everywhere.');
const betaParty = (await put(dmToken, wB, 'Kesh', 'party', '# Kesh\nAn old city of the coast.')).body;
await put(dmToken, wB, `${NEVER} Plans`, 'dm', '# Hidden plans\nSomething the players must never read about the vault below.');

run(deps.db, `INSERT INTO sources (id, world_id, kind, name) VALUES ('src_lk', ?, 'legendkeeper', 'Lore'), ('src_kn', ?, 'kanka', 'Campaign notes')`, wB, wB);
const sourced = (id: string, path: string, title: string, src: string, vis: string) =>
  run(deps.db, `INSERT INTO pages (id, world_id, path, title, visibility, body, player_body, source_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, wB, path, title, vis, 'text', 'text', src, new Date().toISOString());
sourced('pg_lk1', 'lk/ysolde', 'Ysolde Varn', 'src_lk', 'party');
sourced('pg_kn1', 'kn/ysolde', 'Ysolde Varn', 'src_kn', 'party');
sourced('pg_lk2', 'lk/vault', 'Vault Master', 'src_lk', 'dm');
sourced('pg_kn2', 'kn/vault', 'Vault Master', 'src_kn', 'dm');

const G = '/api/admin/gateway';

test('TestGatewayLeak_CleanWorldsFindNothingAndTheRunIsStored', async () => {
  const start = await call('POST', `${G}/leak-check/run`, adminToken);
  assert.equal(start.status, 202);
  await finish();
  const r = await call('GET', `${G}/leak-check`, adminToken);
  assert.equal(r.body.running, false);
  const last = r.body.runs[0];
  assert.equal(last.status, 'done');
  assert.equal(last.leaks, 0);
  assert.equal(last.worlds, 2);
  assert.ok(last.viewers >= 3, 'jess in two worlds plus a guest with no account in each');
  assert.ok(last.pages >= 2);
  const o = await call('GET', `${G}/overview`, adminToken);
  assert.equal(o.body.leak.leaks, 0);
});

test('TestGatewayLeak_AFoundLeakIsStoredAsIdsAndKindsNotWords', async () => {
  // A shared page whose title repeats a DM-only sentence: the library list would show it to every player.
  const rumour = (await call('PUT', `/api/worlds/${wA}/library/pages`, adminToken, { path: 'Rumour', visibility: 'party', title: DM_TEXT, markdown: 'Gossip about nothing in particular.' })).body;
  const port = rumour;
  await call('POST', `${G}/leak-check/run`, adminToken);
  await finish();
  const r = await call('GET', `${G}/leak-check`, adminToken);
  const last = r.body.runs[0];
  assert.ok(last.leaks >= 1, 'the leak is found');
  assert.ok(last.findings.some((f: any) => f.pageId === port.id && f.surface === 'list'));
  assert.ok(!r.text.toLowerCase().includes('poisons'), 'the leaked words are not stored');
  const o = await call('GET', `${G}/overview`, adminToken);
  assert.ok(o.body.leak.leaks >= 1);
  assert.ok(!o.text.toLowerCase().includes('poisons'));
});

test('TestGatewayWorlds_CardsHaveCountsAndSuggestionsWithoutHiddenTitles', async () => {
  run(deps.db, `INSERT INTO sourcekeys_shares (world_id, page_id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, '*', 'dm', ?), (?, ?, ?, ?, 'share', ?)`,
    wB, betaParty.id, dm.id, new Date().toISOString(), wB, betaParty.id, jess.id, dm.id, new Date().toISOString());
  const r = await call('GET', `${G}/worlds`, adminToken);
  assert.equal(r.status, 200);
  const b = r.body.worlds.find((w: any) => w.id === wB);
  assert.equal(b.shares.total, 2);
  assert.equal(b.shares.withParty, 1);
  assert.equal(b.keys.total, 0);
  // The admin is not Beta's DM: the party pair shows, the DM-only pair is only counted.
  assert.equal(b.sameThing.pairs.length, 1);
  assert.equal(b.sameThing.pairs[0].a.title, 'Ysolde Varn');
  assert.equal(b.sameThing.hidden, 1);
  assert.ok(!r.text.includes('Vault Master'));
  assert.ok(!r.text.includes(NEVER));
  // The admin is Alpha's DM, so Alpha's list is not hidden from them.
  assert.equal(r.body.worlds.find((w: any) => w.id === wA).sameThing.hidden, 0);
});

test('TestGatewayWorlds_LinkAndTrustDecisionsAreStored', async () => {
  assert.equal((await call('POST', `${G}/worlds/${wB}/links`, adminToken, { a: 'pg_lk1', b: 'pg_kn1', status: 'linked' })).body.pairs[0].status, 'linked');
  assert.equal((await call('POST', `${G}/worlds/${wB}/links`, adminToken, { a: 'pg_kn1', b: 'pg_lk1', status: 'different' })).body.pairs[0].status, 'different');
  // A page the admin may not read is not there.
  assert.equal((await call('POST', `${G}/worlds/${wB}/links`, adminToken, { a: 'pg_lk2', b: 'pg_kn2', status: 'linked' })).status, 404);
  assert.equal((await call('POST', `${G}/worlds/${wB}/links`, adminToken, { a: 'pg_lk1', b: 'pg_kn1', status: 'nonsense' })).status, 400);
  const p = await call('PUT', `${G}/worlds/${wB}/prefs`, adminToken, { first: 'src_kn', showBoth: false });
  assert.deepEqual([p.body.first, p.body.showBoth, p.body.stored], ['src_kn', false, true]);
  assert.equal((await call('PUT', `${G}/worlds/${wB}/prefs`, adminToken, { first: 'src_elsewhere' })).status, 400);
  const w = (await call('GET', `${G}/worlds`, adminToken)).body.worlds.find((x: any) => x.id === wB);
  assert.equal(w.disagree.first, 'src_kn');
});

test('TestGatewaySearch_ReadsPartyCopiesUnlessTheAdminIsTheDM', async () => {
  const hidden = await call('GET', `${G}/search?q=${NEVER}`, adminToken);
  assert.equal(hidden.status, 200);
  assert.equal(hidden.body.results.length, 0, 'not the DM of Beta, so the DM-only page is not found');
  assert.ok(!hidden.text.includes('vault below'));
  const kesh = await call('GET', `${G}/search?q=Kesh`, adminToken);
  assert.ok(kesh.body.results.some((x: any) => x.title === 'Kesh' && x.world.id === wB));
  assert.equal(kesh.body.worlds.find((w: any) => w.id === wB).copy, 'party');
  assert.equal(kesh.body.worlds.find((w: any) => w.id === wA).copy, 'dm');
  const own = await call('GET', `${G}/search?q=baron+poisons`, adminToken);
  assert.ok(own.body.results.some((x: any) => x.world.id === wA), 'their own world, as its DM');
  assert.equal((await call('GET', `${G}/search?q=Kesh&world=${wA}`, adminToken)).body.results.length, 0);
  assert.equal((await call('GET', `${G}/search?q=k`, adminToken)).status, 400);
});

test('TestGatewayMcp_ListsToolsAndKeysWithoutSecrets', async () => {
  const k = (await call('POST', `/api/worlds/${wA}/keys`, adminToken, { label: 'Claude Desktop', access: 'write' }));
  const r = await call('GET', `${G}/mcp`, adminToken);
  assert.equal(r.status, 200);
  assert.ok(r.body.tools.some((t: any) => t.name === 'read_page' && !t.write));
  assert.ok(r.body.tools.some((t: any) => t.name === 'save_page' && t.write));
  if (k.status < 300) {
    assert.ok(r.body.keys.list.some((x: any) => x.label === 'Claude Desktop'));
    for (const key of [k.body.key, k.body.token, k.body.secret]) if (typeof key === 'string') assert.ok(!r.text.includes(key), 'a key leaked');
  }
  assert.ok(!r.text.includes('alx_scr_'));
});

test('TestGatewaySecurity_DefaultPasswordIsOnlyAYesOrNo', async () => {
  const before = (await call('GET', `${G}/overview`, adminToken)).body.security;
  assert.deepEqual(before, { defaultAdminPassword: false });
  const weak = await call('POST', '/api/admin/accounts', adminToken, { username: 'rootless', password: 'changeme123', isAdmin: true });
  assert.equal(weak.status, 201);
  const o = await call('GET', `${G}/overview`, adminToken);
  assert.deepEqual(o.body.security, { defaultAdminPassword: true });
  assert.ok(!o.text.includes('changeme'));
  assert.equal((await call('DELETE', `/api/admin/accounts/${weak.body.account.id}`, adminToken)).status, 200);
  assert.equal((await call('GET', `${G}/overview`, adminToken)).body.security.defaultAdminPassword, false);
});

test('TestGatewayDevices_SpeakersComeFromTheSoundBoardAndAppsAreNotTracked', async () => {
  run(deps.db, `INSERT INTO sound_listeners (world_id, account_id, device, label, music, seen_at) VALUES (?, ?, 'd1', 'Kitchen speaker', 1, ?)`, wA, admin.account.id, new Date().toISOString());
  const r = await call('GET', `${G}/devices`, adminToken);
  assert.equal(r.body.worlds.find((w: any) => w.id === wA).speakers[0].label, 'Kitchen speaker');
  assert.equal(r.body.worlds.find((w: any) => w.id === wA).speakers[0].connected, true);
  assert.equal(r.body.desktopApps, null);
});

test('TestGatewayLeak_PlayersAndAnonymousAreRefused', async () => {
  const gets = ['/leak-check', '/worlds', '/search?q=port', '/mcp', '/overview', '/devices'];
  for (const p of gets) {
    assert.ok([401, 403].includes((await call('GET', `${G}${p}`, playerToken)).status), `player ${p}`);
    assert.ok([401, 403].includes((await call('GET', `${G}${p}`)).status), `anon ${p}`);
  }
  const writes: [string, string, unknown][] = [['POST', '/leak-check/run', {}], ['POST', `/worlds/${wB}/links`, { a: 'x', b: 'y', status: 'linked' }], ['PUT', `/worlds/${wB}/prefs`, { first: 'newest' }]];
  for (const [m, p, b] of writes) {
    assert.ok([401, 403].includes((await call(m, `${G}${p}`, playerToken, b)).status), `player ${m} ${p}`);
    assert.ok([401, 403].includes((await call(m, `${G}${p}`, dmToken, b)).status), `dm ${m} ${p}`);
    assert.ok([401, 403].includes((await call(m, `${G}${p}`, undefined, b)).status), `anon ${m} ${p}`);
  }
});
