// Connections, source audiences, presets, and the world crawl. Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';
import { effectiveConfig, migrateSources } from '../src/intake/connections.ts';
import { levelForAudience } from '../src/core/library.ts';
import { exportPreset, parsePresetImport } from '../src/intake/presets.ts';

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const KANKA_TOKEN = 'kanka-token-aaaaaaaaaaaaaaaaaaaa';
const KANKA_TOKEN_2 = 'kanka-token-bbbbbbbbbbbbbbbbbbbb';

// What the fake "world API" serves. Page 2 can be held back with `gate` to test cancelling.
const SECRET_BLOCK = 'SECRETBLOCK the duke hides a second family in the cellar';
const CLASSIFIED_TEXT = 'CLASSIFIEDTEXT the vault code is nine nine nine nine nine';
const BROKER_TEXT = 'BROKERTEXT the harbour master sells maps';
const HIDDEN_TEXT = 'HIDDENTEXT the flagged page of the source';
const ITEMS: any[] = [
  { id: 1, name: 'Open Page', body: 'Everyone may read this open page about the harbour.', is_private: false },
  { id: 2, name: 'Flagged Page', body: HIDDEN_TEXT, is_private: true },
  { id: 3, name: 'Mixed Page', body: `Plain words about the guild hall.\n\n> [!secret] DM\n> ${SECRET_BLOCK}\n`, is_private: false },
  { id: 4, name: 'Classified Page', body: CLASSIFIED_TEXT, is_private: false, tags: ['classified'] },
  { id: 5, name: 'Broker Page', body: BROKER_TEXT, is_private: false, tags: ['broker'] },
];
const gate = { page2: null as null | Promise<void>, requests: [] as string[], embedCalls: 0, embedTexts: [] as string[] };
const fake = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.startsWith('http://fake.test/v1/embeddings')) {
    const body = JSON.parse(init.body);
    gate.embedCalls++;
    gate.embedTexts.push(...body.input);
    return json({ data: body.input.map((t: string, i: number) => ({ index: i, embedding: [1, (t.length % 7) / 7, 0.3, 0.1] })) });
  }
  if (u.startsWith('https://api.example.com/')) {
    gate.requests.push(u);
    const x = new URL(u);
    const page = Number(x.searchParams.get('page') ?? 1);
    if (/paged/.test(x.pathname)) {
      if (page === 2 && gate.page2) await gate.page2;
      const items = page === 1 ? ITEMS.slice(0, 2) : page === 2 ? ITEMS.slice(2) : [];
      return json({ data: items });
    }
    if (/worlds\/(\w+)\//.test(x.pathname)) return json({ data: x.pathname.includes('/worlds/alpha/') ? ITEMS.slice(0, 3) : ITEMS.slice(3) });
    return json({ data: ITEMS });
  }
  return json({ error: 'unexpected ' + u }, 500);
}) as typeof fetch;

async function boot(env: Record<string, string> = {}) {
  const made = createApp({ noScheduler: true, fetch: fake, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ...env } });
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
  return { ...made, call, ok, admin, accountId: a.account.id as string, world, base };
}

const API_MAPPING = { transport: 'http', paging: 'none', itemsPath: 'data', idField: 'id', titleField: 'name', bodyField: 'body', tagsField: 'tags', visibilityField: 'is_private', sharedValues: 'false' };
const player = { accountId: 'p', role: 'player' as const };
const dmViewer = { accountId: 'a', role: 'dm' as const };

async function waitSync(t: Awaited<ReturnType<typeof boot>>, sourceId: string) {
  const out = await t.ok('POST', `/api/admin/sources/${sourceId}/sync?wait=1`);
  return out;
}

// ---- connections ------------------------------------------------------------

test('TestConnections_CrudMasksSecretsAndKeepsThemOnTheMask', async () => {
  const t = await boot();
  const c = await t.ok('POST', '/api/admin/connections', { kind: 'kanka-api', name: 'My Kanka', config: { token: KANKA_TOKEN }, notes: 'personal token' });
  assert.equal(c.config.token, '••••');
  assert.ok(!JSON.stringify(c).includes(KANKA_TOKEN));
  assert.equal(c.kind, 'kanka-api');
  assert.equal(c.sources, 0);
  // Listing and reading never return the secret.
  for (const path of ['/api/admin/connections', `/api/admin/connections/${c.id}`]) assert.ok(!(await t.call('GET', path, t.admin)).text.includes(KANKA_TOKEN), path);
  // The mask keeps the stored secret; a new value replaces it; rename keeps it too.
  await t.ok('PATCH', `/api/admin/connections/${c.id}`, { config: { token: '••••', apiUrl: 'https://kanka.example.com/api/1.0' }, name: 'Home Kanka' });
  assert.equal(JSON.parse(one<any>(t.deps.db, 'SELECT config FROM connections WHERE id = ?', c.id)!.config).token, KANKA_TOKEN);
  await t.ok('PATCH', `/api/admin/connections/${c.id}`, { config: { token: KANKA_TOKEN_2 } });
  assert.equal(JSON.parse(one<any>(t.deps.db, 'SELECT config FROM connections WHERE id = ?', c.id)!.config).token, KANKA_TOKEN_2);
  assert.equal((await t.ok('GET', `/api/admin/connections/${c.id}`)).name, 'Home Kanka');
  // Required connection settings are checked; a campaign id is a source setting, not a connection one.
  assert.equal((await t.call('POST', '/api/admin/connections', t.admin, { kind: 'kanka-api', name: 'No token', config: {} })).status, 400);
  assert.equal((await t.call('POST', '/api/admin/connections', t.admin, { kind: 'markdown-folder', name: 'Folder', config: {} })).status, 400, 'a folder has nothing to keep on a connection');
  // Only admins.
  assert.equal((await t.call('GET', '/api/admin/connections', null)).status, 401);
  // Delete works when nothing uses it.
  assert.equal((await t.call('DELETE', `/api/admin/connections/${c.id}`, t.admin)).status, 200);
  assert.equal((await t.call('GET', `/api/admin/connections/${c.id}`, t.admin)).status, 404);
  assert.ok(all<any>(t.deps.db, `SELECT detail FROM audit WHERE action LIKE 'connection.%'`).length >= 3, 'connection changes are in the audit log');
});

test('TestConnections_TestNeedsASampleForWorldSettingsAndNeverEchoesTheToken', async () => {
  const t = await boot();
  const c = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'Wiki API', config: { ...API_MAPPING, url: 'https://api.example.com/worlds/{world}/list', token: 'secret-wiki-token-123' } });
  const bare = await t.ok('POST', `/api/admin/connections/${c.id}/test`, {});
  assert.equal(bare.ok, false);
  assert.match(bare.message, /\{world\}/);
  const good = await t.ok('POST', `/api/admin/connections/${c.id}/test`, { sample: { world: 'alpha' } });
  assert.equal(good.ok, true, good.message);
  assert.ok(gate.requests.some((u) => u.includes('/worlds/alpha/list')), 'the sample value filled {world}');
  assert.ok(!JSON.stringify(good).includes('secret-wiki-token-123'));
  // An unsaved connection can be tried too; the mask means "the saved secret".
  const again = await t.ok('POST', '/api/admin/connections/test', { kind: 'api', connectionId: c.id, config: { ...API_MAPPING, url: 'https://api.example.com/worlds/{world}/list', token: '••••' }, sample: { world: 'alpha' } });
  assert.equal(again.ok, true, again.message);
});

// ---- migration ------------------------------------------------------------------

test('TestConnections_MigrationMakesOneConnectionPerCredentialSet', async () => {
  const t = await boot();
  const db = t.deps.db;
  const w1 = await t.world('One');
  const w2 = await t.world('Two');
  const ins = (sid: string, wid: string, kind: string, cfg: object) => run(db, `INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES (?, ?, ?, ?, ?, 'dm')`, sid, wid, kind, sid, JSON.stringify(cfg));
  // The way sources were stored before connections: everything in one config, and an older kind name.
  ins('s_k1', w1, 'kanka', { campaignId: '11', token: KANKA_TOKEN });
  ins('s_k2', w2, 'kanka-api', { campaignId: '22', token: KANKA_TOKEN });
  ins('s_k3', w2, 'kanka-api', { campaignId: '33', token: KANKA_TOKEN_2 });
  ins('s_md', w1, 'markdown-folder', { folder: 'notes' });
  ins('s_lk', w1, 'legendkeeper-api', { apiUrl: 'https://www.legendkeeper.com/api/v3/projects/p1', apiKey: 'lk-key-1234567890' });
  assert.equal(migrateSources(db), 4, 'the folder has no account settings and is left alone');
  assert.equal(migrateSources(db), 0, 'running it again changes nothing');
  const conns = all<any>(db, 'SELECT * FROM connections ORDER BY created_at, rowid');
  assert.equal(conns.length, 3, 'two Kanka tokens and one LegendKeeper key');
  const s = (sid: string) => one<any>(db, 'SELECT * FROM sources WHERE id = ?', sid)!;
  assert.equal(s('s_k1').connection_id, s('s_k2').connection_id, 'the same token is one connection');
  assert.notEqual(s('s_k1').connection_id, s('s_k3').connection_id);
  assert.equal(s('s_md').connection_id, null);
  assert.equal(s('s_k1').kind, 'kanka-api', 'old kind names become the connector id');
  // The source keeps only its own settings; the token is on the connection.
  assert.deepEqual(JSON.parse(s('s_k1').config), { campaignId: '11' });
  assert.deepEqual(JSON.parse(s('s_lk').config), { apiUrl: 'https://www.legendkeeper.com/api/v3/projects/p1' });
  assert.deepEqual(effectiveConfig(db, s('s_k2')), { campaignId: '22', token: KANKA_TOKEN });
  // The old source API still answers, with the same shape and the secret masked.
  const list = await t.ok('GET', `/api/admin/worlds/${w2}/sources`);
  const k2 = list.find((x: any) => x.id === 's_k2');
  assert.equal(k2.config.token, '••••');
  assert.equal(k2.config.campaignId, '22');
  assert.equal(k2.connection.name, conns.find((c) => c.id === s('s_k2').connection_id).name);
  assert.ok(!JSON.stringify(list).includes(KANKA_TOKEN));
  // A source made the old way (everything in config) is adopted by the same connection.
  const made = await t.ok('POST', `/api/admin/worlds/${w1}/sources`, { kind: 'kanka-api', name: 'Old way', config: { campaignId: '44', token: KANKA_TOKEN } });
  assert.equal(made.connection.id, s('s_k1').connection_id);
  assert.equal(all<any>(db, 'SELECT id FROM connections').length, 3);
  // An old-style edit that sends the connection's own settings back unchanged works; changing them points at the connection.
  await t.ok('PATCH', `/api/admin/sources/${made.id}`, { config: { campaignId: '45', token: '••••' } });
  assert.equal(effectiveConfig(db, s(made.id)).campaignId, '45');
  const refused = await t.call('PATCH', `/api/admin/sources/${made.id}`, t.admin, { config: { campaignId: '45', token: 'some-other-token-value-123456' } });
  assert.equal(refused.status, 409);
  // A connection in use cannot be deleted.
  assert.equal((await t.call('DELETE', `/api/admin/connections/${s('s_k1').connection_id}`, t.admin)).status, 409);
});

// ---- many worlds, many sources -------------------------------------------------------

test('TestConnections_OneConnectionServesTwoWorldsAndTwoSourcesFeedOneWorld', async () => {
  const t = await boot();
  const c = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'Wiki API', config: { ...API_MAPPING, url: 'https://api.example.com/worlds/{world}/list', token: 'secret-wiki-token-123' } });
  const w1 = await t.world('Alpha World');
  const w2 = await t.world('Beta World');
  const s1 = await t.ok('POST', `/api/admin/worlds/${w1}/sources`, { connectionId: c.id, name: 'Alpha wiki', config: { world: 'alpha' }, defaultVisibility: 'party' });
  const s2 = await t.ok('POST', `/api/admin/worlds/${w2}/sources`, { connectionId: c.id, name: 'Beta wiki', config: { world: 'beta' }, defaultVisibility: 'party' });
  const s3 = await t.ok('POST', `/api/admin/worlds/${w1}/sources`, { connectionId: c.id, name: 'Alpha extras', config: { world: 'beta' }, defaultVisibility: 'party' });
  assert.equal(s1.connection.id, c.id);
  assert.equal(s1.config.token, '••••');
  assert.equal(s1.config.world, 'alpha');
  const info = await t.ok('GET', `/api/admin/connections/${c.id}`);
  assert.equal(info.sources, 3);
  assert.equal(info.worlds, 2);
  // Connection settings sent with a source are ignored: the connection decides them.
  const sneaky = await t.ok('POST', `/api/admin/worlds/${w2}/sources`, { connectionId: c.id, name: 'Sneaky', config: { world: 'beta', url: 'https://evil.example.com/x', token: 'other-token-value-123456' } });
  assert.equal(effectiveConfig(t.deps.db, one<any>(t.deps.db, 'SELECT * FROM sources WHERE id = ?', sneaky.id)!).url, 'https://api.example.com/worlds/{world}/list');
  await t.ok('DELETE', `/api/admin/sources/${sneaky.id}`);
  assert.equal((await t.call('POST', `/api/admin/worlds/${w1}/sources`, t.admin, { connectionId: 'con_missing', name: 'x', config: {} })).status, 404);
  assert.equal((await t.call('POST', `/api/admin/worlds/${w1}/sources`, t.admin, { connectionId: c.id, kind: 'kanka-api', name: 'x', config: {} })).status, 400, 'a connection only serves its own kind');

  await waitSync(t, s1.id);
  await waitSync(t, s2.id);
  await waitSync(t, s3.id);
  const titles = (wid: string) => (t.deps.library.list(wid, dmViewer) as any[]).map((p) => p.title).sort();
  // Alpha reads items 1-3 from "alpha" and 4-5 from "beta" (two sources, one world); Beta reads 4-5.
  assert.deepEqual(titles(w1), ['Broker Page', 'Classified Page', 'Flagged Page', 'Mixed Page', 'Open Page']);
  assert.deepEqual(titles(w2), ['Broker Page', 'Classified Page']);
  assert.ok(gate.requests.some((u) => u.includes('/worlds/alpha/')) && gate.requests.some((u) => u.includes('/worlds/beta/')));
  // Changing the connection once changes it for every source (here: its token is only on the connection).
  await t.ok('PATCH', `/api/admin/connections/${c.id}`, { config: { token: 'rotated-token-value-123456' } });
  for (const sid of [s1.id, s2.id, s3.id]) assert.equal(effectiveConfig(t.deps.db, one<any>(t.deps.db, 'SELECT * FROM sources WHERE id = ?', sid)!).token, 'rotated-token-value-123456');
  const sum = await t.ok('GET', `/api/worlds/${w1}/world-sources`);
  assert.equal(sum.sources.length, 2);
  assert.ok(!JSON.stringify(sum).includes('rotated-token'), 'the agent tool never carries a secret');
});

// ---- audience ---------------------------------------------------------------------

test('TestAudience_LevelRule', () => {
  assert.equal(levelForAudience('auto', 'party', 'party'), 'party');
  assert.equal(levelForAudience('auto', 'dm', 'party'), 'dm');
  assert.equal(levelForAudience('dm', 'party', 'party'), 'dm');
  assert.equal(levelForAudience('dm', 'broker', 'broker'), 'dm', 'dm is at least dm');
  assert.equal(levelForAudience('dm', 'classified', 'classified'), 'classified', 'it never lowers a level');
  assert.equal(levelForAudience('party', 'dm', 'party'), 'party', 'the source flag is overridden');
  assert.equal(levelForAudience('party', 'dm', 'broker'), 'broker', 'a marker still applies');
  assert.equal(levelForAudience('party', 'party', 'classified'), 'classified');
});

const everything = (lib: any, wid: string, viewer: any) => {
  const out: string[] = [];
  for (const p of lib.list(wid, viewer)) { try { out.push(JSON.stringify(lib.get(wid, p.id, viewer))); } catch { /* not allowed */ } }
  return out.join('\n');
};
const dbCopies = (db: any, wid: string, col: 'player' | 'broker' | 'ai') => all<any>(db, `SELECT title, ${col}_body AS body, ${col}_blocks AS blocks, ${col}_properties AS props, ${col}_frontmatter AS fm FROM pages WHERE world_id = ?`, wid)
  .map((r) => JSON.stringify(r)).join('\n');

test('TestAudience_DmNeverShowsAnythingToPlayersAndPartyKeepsSecretsOut', async () => {
  const t = await boot();
  const c = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'Wiki API', config: { ...API_MAPPING, url: 'https://api.example.com/all/list' } });
  const wid = await t.world('Audience World');
  const lib = t.deps.library;
  const src = await t.ok('POST', `/api/admin/worlds/${wid}/sources`, { connectionId: c.id, name: 'Wiki', config: {}, defaultVisibility: 'party' });
  assert.equal(src.audience, 'auto');
  await waitSync(t, src.id);
  const playerTitles = () => (lib.list(wid, player) as any[]).map((p) => p.title).sort();

  // auto: the source's own flags. The page the source flagged private, and anything with a broker or classified marker, are not for players.
  assert.deepEqual(playerTitles(), ['Mixed Page', 'Open Page']);
  let text = everything(lib, wid, player);
  for (const leak of [HIDDEN_TEXT, SECRET_BLOCK, CLASSIFIED_TEXT, BROKER_TEXT]) assert.ok(!text.includes(leak), `auto leaked ${leak.slice(0, 20)}`);

  // dm: nothing from this source reaches a player, whatever the source says.
  const dmOn = await t.ok('PATCH', `/api/admin/sources/${src.id}`, { audience: 'dm' });
  assert.equal(dmOn.audience, 'dm');
  assert.equal(dmOn.audience_label, 'DM only');
  assert.deepEqual(playerTitles(), []);
  assert.equal(all<any>(t.deps.db, 'SELECT id FROM pages WHERE world_id = ? AND player_body IS NOT NULL', wid).length, 0, 'no player copy exists');
  assert.equal(everything(lib, wid, player), '');
  assert.deepEqual((lib.search(wid, 'harbour', player) as any[]).length, 0, 'search shows players nothing');
  assert.ok(everything(lib, wid, dmViewer).includes('Everyone may read'), 'the DM still has it all');
  // ... and a fresh sync under dm keeps it that way.
  await waitSync(t, src.id);
  assert.deepEqual(playerTitles(), []);
  assert.equal(all<any>(t.deps.db, 'SELECT id FROM pages WHERE world_id = ? AND player_body IS NOT NULL', wid).length, 0);

  // party needs an explicit yes, and the yes is in the audit log.
  const refused = await t.call('PATCH', `/api/admin/sources/${src.id}`, t.admin, { audience: 'party' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /confirm/i);
  assert.deepEqual(playerTitles(), [], 'a refused change changes nothing');
  await t.ok('PATCH', `/api/admin/sources/${src.id}`, { audience: 'party', confirmParty: true });
  assert.ok(all<any>(t.deps.db, `SELECT detail FROM audit WHERE action = 'source.audience'`).some((r) => /dm -> party \(confirmed/.test(r.detail)), 'party is recorded');
  // party: the flagged page is shared too; secret blocks, broker and classified pages are not.
  assert.deepEqual(playerTitles(), ['Flagged Page', 'Mixed Page', 'Open Page']);
  text = everything(lib, wid, player);
  assert.ok(text.includes(HIDDEN_TEXT), 'the flagged page is shared under party');
  for (const leak of [SECRET_BLOCK, CLASSIFIED_TEXT, BROKER_TEXT, 'SECRETBLOCK', 'CLASSIFIEDTEXT', 'BROKERTEXT']) assert.ok(!text.includes(leak), `party leaked ${leak.slice(0, 20)}`);
  const stored = dbCopies(t.deps.db, wid, 'player');
  for (const leak of ['SECRETBLOCK', 'CLASSIFIEDTEXT', 'BROKERTEXT']) assert.ok(!stored.includes(leak), `a player copy holds ${leak}`);
  const ai = dbCopies(t.deps.db, wid, 'ai');
  assert.ok(!ai.includes('CLASSIFIEDTEXT'), 'no model ever sees classified text');
  assert.ok(!dbCopies(t.deps.db, wid, 'broker').includes('CLASSIFIEDTEXT'));
  assert.ok(!(lib.search(wid, 'cellar', player) as any[]).length && !(lib.search(wid, 'nine', player) as any[]).length, 'search finds no hidden words');
  // A sync under party keeps the same result.
  await waitSync(t, src.id);
  assert.deepEqual(playerTitles(), ['Flagged Page', 'Mixed Page', 'Open Page']);
  assert.ok(!everything(lib, wid, player).includes('SECRETBLOCK'));

  // Switching back rebuilds the copies: dm hides everything again, auto follows the source again.
  await t.ok('PATCH', `/api/admin/sources/${src.id}`, { audience: 'dm' });
  assert.deepEqual(playerTitles(), []);
  assert.equal(all<any>(t.deps.db, 'SELECT id FROM pages WHERE world_id = ? AND player_body IS NOT NULL', wid).length, 0);
  const auto = await t.ok('PATCH', `/api/admin/sources/${src.id}`, { audience: 'auto' });
  assert.equal(auto.audience_label, 'Follows the source');
  assert.deepEqual(playerTitles(), ['Mixed Page', 'Open Page'], 'back to what the source flags');
  text = everything(lib, wid, player);
  for (const leak of [HIDDEN_TEXT, SECRET_BLOCK, CLASSIFIED_TEXT, BROKER_TEXT]) assert.ok(!text.includes(leak), `auto again leaked ${leak.slice(0, 20)}`);
  const rows = all<any>(t.deps.db, 'SELECT title, visibility FROM pages WHERE world_id = ? ORDER BY title', wid);
  assert.deepEqual(rows.map((r) => `${r.title}:${r.visibility}`), ['Broker Page:broker', 'Classified Page:classified', 'Flagged Page:dm', 'Mixed Page:party', 'Open Page:party']);
});

test('TestAudience_CreatedAsPartyNeedsConfirmationAndPlayersGetNothingFromTheAgentTool', async () => {
  const t = await boot();
  const c = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'Wiki API', config: { ...API_MAPPING, url: 'https://api.example.com/all/list' } });
  const wid = await t.world('Tool World');
  const body = { connectionId: c.id, name: 'Shared wiki', config: {}, audience: 'party' };
  assert.equal((await t.call('POST', `/api/admin/worlds/${wid}/sources`, t.admin, body)).status, 400);
  assert.equal((await t.call('POST', `/api/admin/worlds/${wid}/sources`, t.admin, { ...body, audience: 'nonsense' })).status, 400);
  const src = await t.ok('POST', `/api/admin/worlds/${wid}/sources`, { ...body, confirmParty: true });
  assert.equal(src.audience, 'party');
  // The DM's tool tells the agent what is connected; a player gets nothing.
  const dmView = await t.ok('GET', `/api/worlds/${wid}/world-sources`);
  assert.equal(dmView.sources[0].audience, 'party');
  assert.equal(dmView.sources[0].audience_label, 'Shared with players');
  assert.match(dmView.summary, /Shared shared wiki|Shared wiki \(.*shared with players/i);
  const inv = await t.ok('POST', `/api/worlds/${wid}/invites`, { role: 'player' });
  const joined = (await t.call('POST', '/api/join', null, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' })).body;
  const mine = await t.call('GET', `/api/worlds/${wid}/world-sources`, joined.token);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body, { sources: [] });
  assert.ok(!mine.text.includes('Shared wiki'));
  // The tool is listed for the DM only.
  const { allTools } = await import('../src/routes/mcpServer.ts');
  const tool = allTools().find((x: any) => x.name === 'world_sources') as any;
  assert.ok(tool?.dmOnly, 'world_sources is a DM-only read tool');
  assert.equal(tool.write, undefined);
});

// ---- presets -------------------------------------------------------------------------

test('TestPresets_BuiltInSaveApplyImportExport', async () => {
  const t = await boot();
  const list = await t.ok('GET', '/api/admin/connections/presets');
  const names = list.map((p: any) => p.name);
  for (const n of ['Generic REST list + detail', 'Generic MCP tool', 'Kanka via generic API', 'LegendKeeper via generic API']) assert.ok(names.includes(n), n);
  assert.ok(list.filter((p: any) => p.builtin).every((p: any) => p.unverified && /unverified/i.test(p.note)), 'built-ins are labelled community and unverified');
  assert.match(list.find((p: any) => p.name === 'Kanka via generic API').note, /dedicated Kanka connector.*recommended/);
  assert.match(list.find((p: any) => p.name === 'LegendKeeper via generic API').note, /recommended/);
  assert.equal((await t.call('DELETE', '/api/admin/connections/presets/builtin%3Arest-list', t.admin)).status, 400);

  // Apply a built-in when making a connection: the mapping comes from the preset, the token from the admin.
  const c = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'From preset', presetId: 'builtin:rest-list', config: { token: 'secret-wiki-token-123' } });
  const row = JSON.parse(one<any>(t.deps.db, 'SELECT config FROM connections WHERE id = ?', c.id)!.config);
  assert.equal(row.url, 'https://api.example.com/v1/worlds/{world}/articles');
  assert.equal(row.itemsPath, 'data');
  assert.equal(row.token, 'secret-wiki-token-123');

  // Save a connection's mapping as a preset: no secret, nothing world-specific.
  const saved = await t.ok('POST', '/api/admin/connections/presets', { connectionId: c.id, name: 'My wiki mapping', description: 'paged list' });
  assert.equal(saved.builtin, false);
  assert.equal(saved.config.itemsPath, 'data');
  assert.ok(!('token' in saved.config), 'a preset never holds a secret');
  assert.ok(!JSON.stringify(await t.ok('GET', '/api/admin/connections/presets')).includes('secret-wiki-token-123'));
  const own = await t.ok('POST', '/api/admin/connections/presets', { name: 'Typed', config: { url: 'https://x.example.com/{world}', token: 'nope', world: 'secret-world', idField: 'uuid', evil: 'x' } });
  assert.deepEqual(own.config, { url: 'https://x.example.com/{world}', idField: 'uuid' }, 'secrets, per-world values and unknown keys are dropped');

  // Export and import as JSON.
  const exp = await t.ok('GET', `/api/admin/connections/presets/${saved.id}/export`);
  assert.equal(exp.format, 'alexandria-api-preset');
  assert.ok(!JSON.stringify(exp).includes('secret-wiki-token-123') && !('id' in exp));
  const imported = await t.ok('POST', '/api/admin/connections/presets/import', { preset: exp });
  assert.notEqual(imported.id, saved.id);
  assert.deepEqual(imported.config, saved.config);
  const asText = await t.ok('POST', '/api/admin/connections/presets/import', { json: JSON.stringify({ ...exp, name: 'As text' }) });
  assert.equal(asText.name, 'As text');
  assert.equal((await t.call('POST', '/api/admin/connections/presets/import', t.admin, { preset: { format: 'something-else', name: 'x', config: {} } })).status, 400);
  assert.equal((await t.call('POST', '/api/admin/connections/presets/import', t.admin, { json: '{not json' })).status, 400);
  assert.equal((await t.call('POST', '/api/admin/connections/presets/import', t.admin, { preset: { format: 'alexandria-api-preset', name: 'Empty', config: { token: 'x' } } })).status, 400, 'a preset with nothing usable is refused');
  assert.throws(() => parsePresetImport({ format: 'alexandria-api-preset', name: 'x', config: { paging: 'sideways' } }));
  assert.deepEqual(parsePresetImport(exportPreset({ name: 'Round', description: 'd', config: { idField: 'id', paging: 'page' } })).config, { idField: 'id', paging: 'page' });

  // Apply to an existing connection: replaces the mapping, keeps the token.
  const other = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'Other', config: { ...API_MAPPING, url: 'https://api.example.com/other', token: 'another-secret-token-12' } });
  await t.ok('POST', `/api/admin/connections/${other.id}/preset`, { presetId: 'builtin:mcp-tool' });
  const after2 = JSON.parse(one<any>(t.deps.db, 'SELECT config FROM connections WHERE id = ?', other.id)!.config);
  assert.equal(after2.transport, 'mcp');
  assert.equal(after2.token, 'another-secret-token-12');
  assert.equal(after2.url, undefined);

  // The connector picker: dedicated connectors first, then the generic API with its presets.
  const connectors = await t.ok('GET', '/api/admin/connectors');
  const ids = connectors.map((x: any) => x.id);
  assert.equal(ids.at(-1), 'api');
  assert.deepEqual(ids.slice(0, 8), ['legendkeeper-mcp', 'legendkeeper-api', 'kanka-api', 'kanka-mcp', 'markdown-folder', 'git', 'mcp-files', 'push']);
  assert.equal(connectors.at(-1).group, 'generic');
  assert.ok(connectors.at(-1).presets.length >= 5);
  const kanka = connectors.find((x: any) => x.id === 'kanka-api');
  assert.deepEqual(kanka.fields.filter((f: any) => f.scope === 'connection').map((f: any) => f.key).sort(), ['apiUrl', 'maxPerMinute', 'maxPerSecond', 'spreadMinutes', 'token']);
  assert.equal(kanka.fields.find((f: any) => f.key === 'campaignId').scope, 'source');

  // A source of a preset-made connection fills the placeholder from its own world value.
  const wid = await t.world('Preset World');
  const gen = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'Alpha lists', config: { ...API_MAPPING, url: 'https://api.example.com/worlds/{world}/list' } });
  assert.equal((await t.call('POST', `/api/admin/worlds/${wid}/sources`, t.admin, { connectionId: gen.id, name: 'No value', config: {} })).status, 400, 'a source must give the {world} value');
  const s = await t.ok('POST', `/api/admin/worlds/${wid}/sources`, { connectionId: gen.id, name: 'Alpha', config: { world: 'alpha' } });
  assert.equal((await waitSync(t, s.id)).pages, 3);
});

// ---- world crawl ---------------------------------------------------------------------

async function pollCrawl(t: Awaited<ReturnType<typeof boot>>, wid: string, until: (c: any) => boolean) {
  let last: any = null;
  for (let i = 0; i < 400; i++) {
    last = (await t.ok('GET', `/api/admin/worlds/${wid}/overview`)).crawl;
    if (last && until(last)) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`the crawl never got there: ${JSON.stringify(last)}`);
}

test('TestCrawl_FetchesSavesCountsLevelsThenEmbedsEveryPage', async () => {
  const t = await boot({ ALX_MODEL_EXTRA_URL: 'http://fake.test/v1', ALX_MODEL_EXTRA_MODEL: 'fake-embed' });
  const c = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'Wiki API', config: { ...API_MAPPING, paging: 'page', url: 'https://api.example.com/paged/list' } });
  const wid = await t.world('Crawl World');
  const s1 = await t.ok('POST', `/api/admin/worlds/${wid}/sources`, { connectionId: c.id, name: 'Wiki', config: {}, defaultVisibility: 'party' });
  const before = await t.ok('GET', `/api/admin/worlds/${wid}/overview`);
  assert.equal(before.pages, 0);
  assert.equal(before.embeddings.configured, true);
  assert.equal(before.embeddings.model, 'fake-embed');
  assert.equal(before.crawl, null);

  const events: any[] = [];
  const sub = t.deps.hub.tap((w: string, type: string, data: any) => { if (w === wid && type === 'crawl') events.push(JSON.parse(JSON.stringify(data))); });
  let release!: () => void;
  gate.page2 = new Promise<void>((r) => { release = r; });
  const started = await t.call('POST', `/api/admin/worlds/${wid}/crawl`, t.admin, {});
  assert.equal(started.status, 202);
  assert.equal((await t.call('POST', `/api/admin/worlds/${wid}/crawl`, t.admin, {})).status, 409, 'one crawl at a time');
  assert.equal((await t.call('POST', `/api/admin/worlds/${wid}/reindex`, t.admin, {})).status, 409);
  release();
  gate.page2 = null;
  const done = await pollCrawl(t, wid, (x) => x.status !== 'running');
  sub();
  assert.equal(done.status, 'ok', JSON.stringify(done));
  const p = done.progress;
  assert.equal(p.phase, 'done');
  assert.equal(p.fetched, 5);
  assert.equal(p.saved, 5);
  assert.equal(p.errors, 0);
  assert.deepEqual(p.levels, { party: 2, broker: 1, dm: 1, classified: 1 }, 'levels found: open and mixed are party, the flagged page dm');
  assert.equal(p.sources.done, 1);
  assert.equal(p.embedding.state, 'done');
  assert.ok(p.embedding.chunks >= 3 && p.embedding.pagesDone >= 3, JSON.stringify(p.embedding));
  // Progress was live: events came for the sync, the pages and the embedding.
  assert.ok(events.length >= 3);
  assert.ok(events.some((e) => e.progress.phase === 'sync') && events.some((e) => e.progress.phase === 'embed') && events.at(-1).status === 'ok');
  // The run log tells the story.
  const full = await t.ok('GET', `/api/admin/crawls/${done.id}`);
  assert.match(full.log, /Crawl started/);
  assert.match(full.log, /5 pages saved/);
  assert.match(full.log, /Embedded \d+ chunks/);
  // The source's own sync run is in its history, too.
  assert.equal((await t.ok('GET', `/api/admin/sources/${s1.id}/runs`))[0].stats.pages, 5);

  // Embeddings were indexed after the crawl: coverage is complete and chunks exist for what each side may read.
  const after1 = await t.ok('GET', `/api/admin/worlds/${wid}/overview`);
  assert.equal(after1.embeddings.pages.pending, 0);
  assert.equal(after1.embeddings.pages.indexed, after1.embeddings.pages.eligible);
  assert.ok(after1.embeddings.dmChunks >= 4, 'DM-side chunks of every page but the classified one');
  assert.ok(after1.embeddings.partyChunks >= 2, 'player-side chunks only for the shared pages');
  // Nothing a player may not read, and nothing classified, was sent to the embeddings model.
  const sent = gate.embedTexts.join('\n');
  assert.ok(!sent.includes('CLASSIFIEDTEXT'), 'classified text never reaches the embeddings model');
  const playerChunks = all<any>(t.deps.db, `SELECT text FROM search_chunks WHERE world_id = ? AND scope = 'party'`, wid).map((r) => r.text).join('\n');
  for (const leak of ['SECRETBLOCK', HIDDEN_TEXT, 'BROKERTEXT', 'CLASSIFIEDTEXT']) assert.ok(!playerChunks.includes(leak), `player chunks hold ${leak.slice(0, 12)}`);
  assert.ok(all<any>(t.deps.db, `SELECT text FROM search_chunks WHERE world_id = ?`, wid).every((r) => !r.text.includes('CLASSIFIEDTEXT')));

  // Re-index starts from scratch and reads every page again.
  const callsBefore = gate.embedCalls;
  assert.equal((await t.call('POST', `/api/admin/worlds/${wid}/reindex`, t.admin, {})).status, 202);
  const re = await pollCrawl(t, wid, (x) => x.id !== done.id && x.status !== 'running');
  assert.equal(re.mode, 'reindex');
  assert.equal(re.status, 'ok');
  assert.ok(gate.embedCalls > callsBefore);
  assert.equal((await t.ok('GET', `/api/admin/worlds/${wid}/overview`)).embeddings.pages.pending, 0);
});

test('TestCrawl_WithoutAnEmbeddingsModelFinishesTheLibraryPartAndSaysSo', async () => {
  const t = await boot();
  const c = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'Wiki API', config: { ...API_MAPPING, url: 'https://api.example.com/all/list' } });
  const wid = await t.world('No Model World');
  await t.ok('POST', `/api/admin/worlds/${wid}/sources`, { connectionId: c.id, name: 'Wiki', config: {} });
  await t.ok('POST', `/api/admin/worlds/${wid}/crawl`, {});
  const done = await pollCrawl(t, wid, (x) => x.status !== 'running');
  assert.equal(done.status, 'ok');
  assert.equal(done.progress.saved, 5);
  assert.equal(done.progress.embedding.state, 'no-model');
  assert.match((await t.ok('GET', `/api/admin/crawls/${done.id}`)).log, /No embeddings model is set/);
  const ov = await t.ok('GET', `/api/admin/worlds/${wid}/overview`);
  assert.equal(ov.embeddings.configured, false);
  assert.equal(ov.pages, 5, 'the library part is done');
});

test('TestCrawl_CancelKeepsTheWorldItsSourcesAndWhatWasFetched', async () => {
  const t = await boot({ ALX_MODEL_EXTRA_URL: 'http://fake.test/v1', ALX_MODEL_EXTRA_MODEL: 'fake-embed' });
  const c = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'Wiki API', config: { ...API_MAPPING, paging: 'page', url: 'https://api.example.com/paged/list' } });
  const wid = await t.world('Cancel World');
  const src = await t.ok('POST', `/api/admin/worlds/${wid}/sources`, { connectionId: c.id, name: 'Wiki', config: {}, defaultVisibility: 'party' });
  let release!: () => void;
  gate.page2 = new Promise<void>((r) => { release = r; });
  const embedBefore = gate.embedCalls;
  try {
    await t.ok('POST', `/api/admin/worlds/${wid}/crawl`, {});
    // The first page is saved while the second is held back.
    const mid = await pollCrawl(t, wid, (x) => x.status === 'running' && x.progress.saved >= 2);
    assert.equal(mid.progress.phase, 'sync');
    assert.equal(mid.running, true);
    assert.equal((await t.ok('POST', `/api/admin/worlds/${wid}/crawl/stop`, {})).stopped, true);
  } finally { release(); gate.page2 = null; }
  const stopped = await pollCrawl(t, wid, (x) => x.status !== 'running');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.progress.embedding.state, 'cancelled');
  assert.equal(gate.embedCalls, embedBefore, 'a cancelled crawl embeds nothing');
  assert.match((await t.ok('GET', `/api/admin/crawls/${stopped.id}`)).log, /cancelled/i);
  // The world, its connection and its source are all still there; the pages fetched so far are in the library.
  assert.ok(one(t.deps.db, 'SELECT 1 FROM worlds WHERE id = ?', wid));
  assert.ok(one(t.deps.db, 'SELECT 1 FROM sources WHERE id = ?', src.id));
  assert.ok(one(t.deps.db, 'SELECT 1 FROM connections WHERE id = ?', c.id));
  const titles = (t.deps.library.list(wid, dmViewer) as any[]).map((p) => p.title).sort();
  assert.deepEqual(titles, ['Flagged Page', 'Open Page'], 'page one was saved before the cancel');
  assert.equal((await t.ok('GET', `/api/admin/worlds/${wid}/sources`))[0].last_status.startsWith('stopped'), true);
  // The crawl can be started again after a cancel.
  await t.ok('POST', `/api/admin/worlds/${wid}/crawl`, {});
  const again = await pollCrawl(t, wid, (x) => x.id !== stopped.id && x.status !== 'running');
  assert.equal(again.status, 'ok');
  assert.equal(again.progress.embedding.state, 'done');
  assert.equal((t.deps.library.list(wid, dmViewer) as any[]).length, 5);
});

test('TestCrawl_AFailingSourceIsCountedAndTheCrawlSaysError', async () => {
  const t = await boot();
  const c = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'Broken API', config: { ...API_MAPPING, url: 'https://down.example.com/list' } });
  const wid = await t.world('Failing World');
  await t.ok('POST', `/api/admin/worlds/${wid}/sources`, { connectionId: c.id, name: 'Down', config: {} });
  await t.ok('POST', `/api/admin/worlds/${wid}/crawl`, {});
  const done = await pollCrawl(t, wid, (x) => x.status !== 'running');
  assert.equal(done.status, 'error');
  assert.ok(done.progress.errors >= 1);
  assert.ok(done.progress.errorSamples[0].includes('Down'));
});
