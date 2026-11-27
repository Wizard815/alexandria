// Library sharing for the GM: per-player shares of pages and files, folder rules, the classified block,
// "send to players" (new from the GM) and that nothing reaches a player it was not meant for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';

const PNG = (extra = 'x') => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`pad ${extra} pad`)]);

async function boot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-ls-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let j: any = t;
    try { j = JSON.parse(t); } catch { /* text */ }
    return { status: r.status, body: j };
  };
  const ok = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await call(method, url, token, body);
    assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const T: Record<string, string> = {};
  const ID: Record<string, string> = {};
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.gm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'gm password 123' })).account.id;
  T.gm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'gm password 123' })).token;
  const W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Sharedland', gmAccountId: ID.gm })).id;
  for (const [u, c] of [['jess', 'Jess'], ['tom', 'Tom'], ['ana', 'Ana']]) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.gm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: u, password: 'player pass 123', characterName: c });
    T[u] = j.token; ID[u] = j.account.id;
  }
  const up = async (query: string, bytes: Buffer) => {
    const r = await fetch(`${base}/api/worlds/${W}/files?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${T.gm}` }, body: bytes as any });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const bytes = async (url: string) => { const r = await fetch(base + url); return { status: r.status }; };
  const lib = `/api/worlds/${W}/library`;
  const ls = `/api/worlds/${W}/libshare`;
  const page = (p: string, visibility: string, body = 'Open text.') => ok('PUT', `${lib}/pages`, T.gm, { path: p, visibility, body });
  const titles = async (who: string) => ((await ok('GET', `${lib}/pages`, T[who])) as any[]).map((x) => x.title).sort();
  const share = (b: any) => call('PUT', `${ls}/share`, T.gm, b);
  return { base, deps: made.deps, W, T, ID, call, ok, up, bytes, lib, ls, page, titles, share, close: () => { server.close(); server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

test('TestLibShare_PagePerPlayerAndEveryone', async () => {
  const e = await boot();
  try {
    const pg = await e.page('lore/Secret Cove.md', 'gm', 'The cove is hidden.\n\n> [!secret] GM\n> GMSECRET smugglers\n');
    assert.deepEqual(await e.titles('jess'), []);
    const r = await e.share({ kind: 'page', id: pg.id, mode: 'players', players: [e.ID.jess] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await e.titles('jess'), ['Secret Cove']);
    assert.deepEqual(await e.titles('tom'), [], 'another player does not get a per-player share');
    assert.equal((await e.call('GET', `${e.lib}/pages/${pg.id}`, e.T.tom)).status, 404);
    const got = await e.ok('GET', `${e.lib}/pages/${pg.id}`, e.T.jess);
    assert.ok(!JSON.stringify(got).includes('GMSECRET'), 'secret blocks never reach the player');
    // Changing who: from jess to tom
    await e.share({ kind: 'page', id: pg.id, mode: 'players', players: [e.ID.tom] });
    assert.deepEqual(await e.titles('jess'), []);
    assert.deepEqual(await e.titles('tom'), ['Secret Cove']);
    // Everyone
    await e.share({ kind: 'page', id: pg.id, mode: 'party' });
    assert.deepEqual(await e.titles('ana'), ['Secret Cove']);
    // GM only again
    await e.share({ kind: 'page', id: pg.id, mode: 'gm' });
    for (const p of ['jess', 'tom', 'ana']) assert.deepEqual(await e.titles(p), []);
    assert.equal((await e.call('GET', `${e.lib}/pages/${pg.id}`, e.T.jess)).status, 404);
  } finally { e.close(); }
});

test('TestLibShare_OnlyTheGmCanShareAndPlayersGetNoOverview', async () => {
  const e = await boot();
  try {
    const pg = await e.page('lore/A.md', 'gm');
    for (const body of [{ kind: 'page', id: pg.id, mode: 'party' }]) {
      assert.equal((await e.call('PUT', `${e.ls}/share`, e.T.jess, body)).status, 403);
      assert.equal((await e.call('PUT', `${e.ls}/share`, undefined, body)).status, 401);
    }
    assert.equal((await e.call('GET', `${e.ls}/overview`, e.T.jess)).status, 403);
    assert.equal((await e.call('GET', `${e.ls}/preview?kind=page&id=${pg.id}`, e.T.jess)).status, 403);
    assert.deepEqual(await e.titles('jess'), []);
  } finally { e.close(); }
});

test('TestLibShare_ClassifiedAndBrokerCanNeverBeShared', async () => {
  const e = await boot();
  try {
    const cl = await e.page('lore/Cl.md', 'classified');
    const br = await e.page('lore/Br.md', 'broker');
    for (const pg of [cl, br]) for (const mode of ['party', 'players']) {
      const r = await e.share({ kind: 'page', id: pg.id, mode, players: [e.ID.jess] });
      assert.equal(r.status, 409, `${pg.path} ${mode}`);
    }
    assert.match((await e.share({ kind: 'page', id: cl.id, mode: 'party' })).body.error, /classified/i);
    assert.deepEqual(await e.titles('jess'), []);
    // A classified file, and a file on a classified page.
    const open = await e.page('lore/Open.md', 'gm');
    const f1 = await e.up(`page=${open.id}&name=a.png&level=classified`, PNG('a'));
    assert.equal((await e.share({ kind: 'file', id: f1.body.id, mode: 'party' })).status, 409);
    const f2 = await e.up(`page=${cl.id}&name=b.png&level=gm`, PNG('b'));
    assert.equal((await e.share({ kind: 'file', id: f2.body.id, mode: 'party' })).status, 409, 'its page is classified');
    // Folder: classified and broker pages are skipped even with a rule over them.
    await e.page('Vault/Open Note.md', 'gm');
    await e.page('Vault/Classified Note.md', 'classified');
    await e.page('Vault/Broker Note.md', 'broker');
    const gmClassifiedTag = await e.ok('PUT', `${e.lib}/pages`, e.T.gm, { path: 'Vault/Tagged.md', visibility: 'gm', body: 'x #classified' });
    assert.equal(gmClassifiedTag.visibility, 'classified');
    const rule = await e.share({ kind: 'folder', sourceId: '', path: 'Vault', mode: 'party', confirm: true });
    assert.equal(rule.status, 200, JSON.stringify(rule.body));
    assert.deepEqual(await e.titles('jess'), ['Open Note'], 'only the GM-only page is lifted');
    const ids = new Map(all<any>(e.deps.db, 'SELECT id, title FROM pages').map((p) => [p.title, p.id]));
    for (const t of ['Classified Note', 'Broker Note', 'Tagged']) assert.equal((await e.call('GET', `${e.lib}/pages/${ids.get(t)}`, e.T.jess)).status, 404, t);
    // A page becoming classified later drops out of the rule at once.
    await e.ok('PUT', `${e.lib}/pages/${ids.get('Open Note')}/level`, e.T.gm, { level: 'classified' });
    assert.deepEqual(await e.titles('jess'), []);
  } finally { e.close(); }
});

test('TestLibShare_ConfirmNeededForFoldersAndClassifiedText', async () => {
  const e = await boot();
  try {
    await e.page('Notes/One.md', 'gm');
    const noConfirm = await e.share({ kind: 'folder', sourceId: '', path: 'Notes', mode: 'party' });
    assert.equal(noConfirm.status, 409);
    assert.equal(noConfirm.body.needsConfirm, true);
    assert.equal(all(e.deps.db, 'SELECT * FROM libshare_folders').length, 0);
    const mixed = await e.page('Notes/Mixed.md', 'gm', 'Open words.\n\n> [!classified] Classified\n> CLASSIFIEDTEXT\n');
    const first = await e.share({ kind: 'page', id: mixed.id, mode: 'party' });
    assert.equal(first.status === 409 ? first.body.needsConfirm : 'no-classified-blocks', true, JSON.stringify(first.body));
    const prev = await e.ok('GET', `${e.ls}/preview?kind=page&id=${mixed.id}`, e.T.gm);
    assert.equal(prev.classifiedText, true);
    assert.equal((await e.share({ kind: 'page', id: mixed.id, mode: 'party', confirm: true })).status, 200);
    const got = await e.ok('GET', `${e.lib}/pages/${mixed.id}`, e.T.jess);
    assert.ok(!JSON.stringify(got).includes('CLASSIFIEDTEXT'));
    const fp = await e.ok('GET', `${e.ls}/preview?kind=folder&sourceId=&path=Notes`, e.T.gm);
    assert.equal(fp.pages, 2);
  } finally { e.close(); }
});

test('TestLibShare_FolderRuleCoversPagesAddedAndMovedLater', async () => {
  const e = await boot();
  try {
    await e.page('Town/Inn.md', 'gm', 'The inn.');
    await e.page('Elsewhere/Cave.md', 'gm', 'The cave.');
    assert.equal((await e.share({ kind: 'folder', sourceId: '', path: 'Town', mode: 'players', players: [e.ID.tom], confirm: true })).status, 200);
    assert.deepEqual(await e.titles('tom'), ['Inn']);
    assert.deepEqual(await e.titles('jess'), []);
    // Added later, and in a sub folder.
    await e.page('Town/Market/Stall.md', 'gm', 'A stall.');
    assert.deepEqual(await e.titles('tom'), ['Inn', 'Stall']);
    // Moved in (saved at a new path) and out.
    const cave = one<any>(e.deps.db, `SELECT id FROM pages WHERE title = 'Cave'`)!;
    run(e.deps.db, `UPDATE pages SET folder = '["Town"]' WHERE id = ?`, cave.id);
    assert.deepEqual(await e.titles('tom'), ['Cave', 'Inn', 'Stall']);
    run(e.deps.db, `UPDATE pages SET folder = '["Elsewhere"]' WHERE id = ?`, cave.id);
    assert.deepEqual(await e.titles('tom'), ['Inn', 'Stall']);
    // Other players still cannot open it by id.
    const inn = one<any>(e.deps.db, `SELECT id FROM pages WHERE title = 'Inn'`)!;
    assert.equal((await e.call('GET', `${e.lib}/pages/${inn.id}`, e.T.jess)).status, 404);
    assert.equal((await e.call('GET', `${e.lib}/pages/${inn.id}`, e.T.tom)).status, 200);
    // The overview shows the rule and who it is for.
    const ov = await e.ok('GET', `${e.ls}/overview`, e.T.gm);
    assert.equal(ov.folders.length, 1);
    assert.deepEqual(ov.folders[0].to, [e.ID.tom]);
    assert.deepEqual(ov.pages[inn.id].to, [e.ID.tom]);
    assert.ok(ov.pages[inn.id].via.includes('folder'));
    // Search finds it for tom only.
    assert.equal((await e.ok('GET', `${e.lib}/search?q=inn`, e.T.tom)).length, 1);
    assert.equal((await e.ok('GET', `${e.lib}/search?q=inn`, e.T.jess)).length, 0);
    // Turning the rule off ends it.
    assert.equal((await e.share({ kind: 'folder', sourceId: '', path: 'Town', mode: 'off' })).status, 200);
    assert.deepEqual(await e.titles('tom'), []);
  } finally { e.close(); }
});

test('TestLibShare_FileSharedToOnePlayerAndItsPageStaysHidden', async () => {
  const e = await boot();
  try {
    const pg = await e.page('lore/GM Page.md', 'gm', 'GMPAGETEXT');
    const f = await e.up(`page=${pg.id}&name=handout.png&level=gm`, PNG('h'));
    assert.equal(f.status, 201);
    const fileUrl = (who: string) => e.call('GET', `/api/worlds/${e.W}/files/${f.body.id}`, e.T[who]);
    assert.equal((await fileUrl('jess')).status, 404);
    assert.equal((await e.share({ kind: 'file', id: f.body.id, mode: 'players', players: [e.ID.jess] })).status, 200);
    assert.equal((await fileUrl('jess')).status, 200);
    assert.equal((await fileUrl('tom')).status, 404, 'a per-player file share stays with that player');
    const list = await e.ok('GET', `/api/worlds/${e.W}/files`, e.T.jess);
    assert.equal(list.files.length, 1);
    assert.equal(list.files[0].pageId, null, 'the hidden page is not named');
    assert.equal(list.files[0].pageTitle, undefined);
    assert.equal((await e.call('GET', `${e.lib}/pages/${pg.id}`, e.T.jess)).status, 404, 'its page stays hidden');
    assert.equal((await e.ok('GET', `/api/worlds/${e.W}/files`, e.T.tom)).files.length, 0);
    // The ticket url works for jess's account only.
    const url = list.files[0].url as string;
    assert.equal((await e.bytes(url)).status, 200);
    const tomList = await e.ok('GET', `/api/worlds/${e.W}/files/${f.body.id}/ticket`, e.T.gm);
    assert.equal((await e.bytes(tomList.url)).status, 200, 'the GM reads it');
    // Everyone, with the page.
    assert.equal((await e.share({ kind: 'file', id: f.body.id, mode: 'party', withPage: true })).status, 200);
    assert.equal((await fileUrl('tom')).status, 200);
    assert.equal((await e.call('GET', `${e.lib}/pages/${pg.id}`, e.T.tom)).status, 200);
    // Back to GM only: file and page close again.
    assert.equal((await e.share({ kind: 'file', id: f.body.id, mode: 'gm' })).status, 200);
    assert.equal((await fileUrl('jess')).status, 404);
    assert.equal((await e.bytes(url)).status, 404, 'a ticket already handed out stops working');
  } finally { e.close(); }
});

test('TestLibShare_FolderRuleCoversFilesAddedLaterButNotClassifiedOnes', async () => {
  const e = await boot();
  try {
    const pg = await e.page('Maps/Region.md', 'gm', 'Region.');
    await e.share({ kind: 'folder', sourceId: '', path: 'Maps', mode: 'players', players: [e.ID.ana], confirm: true });
    const later = await e.up(`page=${pg.id}&name=later.png&level=gm`, PNG('l'));
    const secret = await e.up(`page=${pg.id}&name=secret.png&level=classified`, PNG('s'));
    const brokered = await e.up(`page=${pg.id}&name=broker.png&level=broker`, PNG('b'));
    const get = (who: string, id: string) => e.call('GET', `/api/worlds/${e.W}/files/${id}`, e.T[who]).then((r) => r.status);
    assert.equal(await get('ana', later.body.id), 200);
    assert.equal(await get('jess', later.body.id), 404);
    assert.equal(await get('ana', secret.body.id), 404);
    assert.equal(await get('ana', brokered.body.id), 404);
    const ov = await e.ok('GET', `${e.ls}/overview`, e.T.gm);
    assert.equal(ov.files[later.body.id].mode, 'players');
    assert.equal(ov.files[secret.body.id].mode, 'classified');
  } finally { e.close(); }
});

test('TestLibShare_SendToPlayersIsNewForThemOnly', async () => {
  const e = await boot();
  try {
    const pg = await e.page('lore/Letter.md', 'gm', 'A letter.');
    const secret = await e.page('lore/Hidden.md', 'gm', 'Not sent.');
    const r = await e.share({ kind: 'page', id: pg.id, mode: 'players', players: [e.ID.jess], notify: true });
    assert.equal(r.status, 200);
    const mine = await e.ok('GET', `${e.ls}/new`, e.T.jess);
    assert.equal(mine.newCount, 1);
    assert.equal(mine.items[0].title, 'Letter');
    assert.equal(mine.items[0].pageId, pg.id);
    assert.deepEqual((await e.ok('GET', `${e.ls}/new`, e.T.tom)).items, [], 'another player is not told');
    await e.ok('POST', `${e.ls}/seen`, e.T.jess, {});
    assert.equal((await e.ok('GET', `${e.ls}/new`, e.T.jess)).newCount, 0);
    assert.equal((await e.ok('GET', `${e.ls}/new`, e.T.jess)).items.length, 1, 'it stays listed under From the GM');
    // Quiet share: nothing is recorded.
    await e.share({ kind: 'page', id: secret.id, mode: 'party' });
    assert.equal((await e.ok('GET', `${e.ls}/new`, e.T.ana)).items.length, 0);
    // Unshared after sending: it disappears from the list (checked again on every read).
    await e.share({ kind: 'page', id: pg.id, mode: 'gm' });
    assert.equal((await e.ok('GET', `${e.ls}/new`, e.T.jess)).items.length, 0);
    // The GM sees the send log with who it went to.
    const log = await e.ok('GET', `${e.ls}/new`, e.T.gm);
    assert.equal(log.items[0].toNames[0], 'Jess');
  } finally { e.close(); }
});

test('TestLibShare_NewEventReachesOnlyTheRecipients', async () => {
  const e = await boot();
  try {
    const pg = await e.page('lore/Scroll.md', 'gm');
    const hub = e.deps.hub as any;
    const sent: ((v: any) => boolean)[] = [];
    const real = hub.emit.bind(hub);
    hub.emit = (w: string, type: string, data: unknown, aud: (v: any) => boolean) => { if (type === 'libshare-new') sent.push(aud); return real(w, type, data, aud); };
    const gets = (v: any) => sent.filter((a) => a(v)).length;
    await e.share({ kind: 'page', id: pg.id, mode: 'players', players: [e.ID.jess], notify: true });
    assert.equal(gets({ accountId: e.ID.jess, role: 'player' }), 1);
    assert.equal(gets({ accountId: e.ID.tom, role: 'player' }), 0);
    assert.equal(gets({ accountId: e.ID.gm, role: 'gm' }), 1);
    assert.equal(gets({ accountId: '', role: 'guest' }), 0);
  } finally { e.close(); }
});

test('TestLibShare_SharedViewListsWhatPlayersCanSee', async () => {
  const e = await boot();
  try {
    await e.page('a/Party Page.md', 'party');
    const gm = await e.page('a/Gm Page.md', 'gm');
    const some = await e.page('a/Some.md', 'gm');
    await e.share({ kind: 'page', id: some.id, mode: 'players', players: [e.ID.jess, e.ID.tom] });
    const ov = await e.ok('GET', `${e.ls}/overview`, e.T.gm);
    const byTitle = Object.fromEntries(ov.shared.map((s: any) => [s.title, s]));
    assert.equal(byTitle['Party Page'].mode, 'party');
    assert.equal(byTitle['Some'].mode, 'players');
    assert.equal(byTitle['Some'].to.length, 2);
    assert.equal(byTitle['Gm Page'], undefined);
    void gm;
  } finally { e.close(); }
});

test('TestLibShare_PlayerLeavingTheWorldLosesAFileShare', async () => {
  const e = await boot();
  try {
    const pg = await e.page('lore/P.md', 'gm');
    const f = await e.up(`page=${pg.id}&name=p.png&level=gm`, PNG('p'));
    await e.share({ kind: 'file', id: f.body.id, mode: 'players', players: [e.ID.jess] });
    run(e.deps.db, `DELETE FROM members WHERE world_id = ? AND account_id = ?`, e.W, e.ID.jess);
    const ov = await e.ok('GET', `${e.ls}/overview`, e.T.gm);
    assert.equal(ov.files[f.body.id].mode, 'gm');
  } finally { e.close(); }
});

test('TestLibShare_WholeSourceIsSharedOnlyWhenAskedForByName', async () => {
  const e = await boot();
  try {
    await e.page('Town/Inn.md', 'gm', 'The inn.');
    await e.page('Top.md', 'gm', 'At the top.');
    await e.page('Vault/Sealed.md', 'classified', 'Sealed.');
    // A missing path is never read as the whole source.
    assert.equal((await e.share({ kind: 'folder', sourceId: '', mode: 'players', players: [e.ID.tom], confirm: true })).status, 400);
    assert.equal((await e.call('GET', `${e.ls}/preview?kind=folder&sourceId=`, e.T.gm)).status, 400);
    const pv = await e.ok('GET', `${e.ls}/preview?kind=folder&sourceId=&whole=1`, e.T.gm);
    assert.equal(pv.pages, 3);
    assert.equal(pv.skippedClassified, 1);
    const ask = await e.share({ kind: 'folder', sourceId: '', path: '', whole: true, mode: 'players', players: [e.ID.tom] });
    assert.equal(ask.status, 409);
    assert.match(ask.body.error, /whole source/);
    assert.equal((await e.share({ kind: 'folder', sourceId: '', path: '', whole: true, mode: 'players', players: [e.ID.tom], confirm: true })).status, 200);
    assert.deepEqual(await e.titles('tom'), ['Inn', 'Top']);
    assert.deepEqual(await e.titles('jess'), []);
    // Added later, anywhere in the source.
    await e.page('New Folder/Later.md', 'gm', 'Later.');
    assert.deepEqual(await e.titles('tom'), ['Inn', 'Later', 'Top']);
    const ov = await e.ok('GET', `${e.ls}/overview`, e.T.gm);
    assert.equal(ov.folders.length, 1);
    assert.equal(ov.folders[0].whole, true);
    assert.equal((await e.share({ kind: 'folder', sourceId: '', path: '', whole: true, mode: 'off' })).status, 200);
    assert.deepEqual(await e.titles('tom'), []);
  } finally { e.close(); }
});

test('TestLibShare_TwoSourcesWithOneNameAreSharedApart', async () => {
  const e = await boot();
  try {
    const a = await e.page('Harbor.md', 'gm', 'From the first.');
    const b = await e.page('Tower.md', 'gm', 'From the second.');
    run(e.deps.db, `INSERT INTO sources (id, world_id, kind, name) VALUES ('src_one', ?, 'kanka', 'Wiki'), ('src_two', ?, 'obsidian', 'Wiki')`, e.W, e.W);
    run(e.deps.db, `UPDATE pages SET source_id = 'src_one' WHERE id = ?`, a.id);
    run(e.deps.db, `UPDATE pages SET source_id = 'src_two' WHERE id = ?`, b.id);
    e.deps.library.changed(e.W);
    // The GM's list carries the source id and type, so the tree keeps them apart.
    const list = await e.ok('GET', `${e.lib}/pages`, e.T.gm);
    assert.deepEqual(list.filter((p: any) => p.source === 'Wiki').map((p: any) => `${p.sourceId}:${p.sourceKind}`).sort(), ['src_one:kanka', 'src_two:obsidian']);
    assert.equal((await e.ok('GET', `${e.lib}/pages`, e.T.jess)).some((p: any) => 'sourceKind' in p || 'sourceId' in p), false, 'players get neither');
    assert.equal((await e.share({ kind: 'folder', sourceId: 'src_two', path: '', whole: true, mode: 'party', confirm: true })).status, 200);
    assert.deepEqual(await e.titles('jess'), ['Tower'], 'only the source asked for is shared');
    const ov = await e.ok('GET', `${e.ls}/overview`, e.T.gm);
    assert.equal(ov.folders[0].source, 'Wiki (obsidian)', 'the rule says which Wiki');
  } finally { e.close(); }
});

test('TestLibShare_LiveEventsNameOnlyPagesThePlayerCanOpenOrJustLost', async () => {
  const e = await boot();
  try {
    const inn = await e.page('Town/Inn.md', 'gm', 'The inn.');
    const cave = await e.page('Town/Cave.md', 'gm', 'The cave.');
    const hidden = await e.page('lore/Hidden.md', 'gm', 'Hidden.');
    const f = await e.up(`page=${hidden.id}&name=handout.png&level=gm`, PNG('ev'));
    const hub = e.deps.hub as any;
    let seen: { type: string; data: any; aud: (v: any) => boolean }[] = [];
    const real = hub.emit.bind(hub);
    hub.emit = (w: string, type: string, data: any, aud: (v: any) => boolean) => { seen.push({ type, data, aud }); return real(w, type, data, aud); };
    const P = (who: string) => ({ accountId: e.ID[who], role: 'player' });
    const idsFor = (v: any) => seen.filter((x) => x.aud(v)).flatMap((x) => [x.data?.id, x.data?.pageId]).filter(Boolean).sort();
    const gotAny = (v: any) => seen.filter((x) => x.aud(v)).length;
    try {
      // A page shared to Jess: Jess hears its id, Tom hears no id at all, the GM hears it.
      await e.share({ kind: 'page', id: inn.id, mode: 'players', players: [e.ID.jess] });
      assert.deepEqual(idsFor(P('jess')), [inn.id, inn.id]);
      assert.deepEqual(idsFor(P('tom')), [], 'another player learns no page id');
      assert.ok(seen.some((x) => x.type === 'libshare' && x.aud(P('tom')) && !Object.keys(x.data).length), 'only an id-free refresh');
      assert.ok(idsFor({ accountId: e.ID.gm, role: 'gm' }).includes(inn.id));
      assert.equal(gotAny({ accountId: '', role: 'guest' }), 0, 'a guest hears nothing');
      // Moved from Jess to Tom: Jess hears the page she lost, Tom the page he gained, Ana nothing.
      seen = [];
      await e.share({ kind: 'page', id: inn.id, mode: 'players', players: [e.ID.tom] });
      assert.deepEqual(idsFor(P('jess')), [inn.id, inn.id]);
      assert.deepEqual(idsFor(P('tom')), [inn.id, inn.id]);
      assert.deepEqual(idsFor(P('ana')), []);
      // A folder rule for Ana: she hears both pages in it, the others none of them (Tom still has the Inn).
      seen = [];
      await e.share({ kind: 'folder', sourceId: '', path: 'Town', mode: 'players', players: [e.ID.ana], confirm: true });
      assert.deepEqual(idsFor(P('ana')), [cave.id, cave.id, inn.id, inn.id].sort());
      assert.ok(!idsFor(P('jess')).length);
      assert.ok(!idsFor(P('tom')).includes(cave.id), 'tom never learns the cave id');
      // A file given alone: its hidden page id is never sent, only an id-free file signal.
      seen = [];
      await e.share({ kind: 'file', id: f.body.id, mode: 'players', players: [e.ID.jess] });
      assert.ok(!JSON.stringify(seen.filter((x) => x.aud(P('jess'))).map((x) => x.data)).includes(hidden.id), 'the file page stays unnamed');
      assert.ok(seen.some((x) => x.type === 'libfile' && x.aud(P('jess')) && !x.data.pageId));
      assert.deepEqual(idsFor(P('tom')), []);
      // Fail closed: if who can see what cannot be worked out, players get no ids at all.
      seen = [];
      const lib = e.deps.library as any;
      const lifted = lib.liftedPages;
      lib.liftedPages = () => { throw new Error('broken'); };
      try { await e.share({ kind: 'page', id: cave.id, mode: 'party' }); } finally { lib.liftedPages = lifted; }
      for (const p of ['jess', 'tom', 'ana']) assert.deepEqual(idsFor(P(p)), [], `${p} gets no ids when reach is unknown`);
      assert.ok(seen.some((x) => x.type === 'libshare' && x.aud(P('jess'))), 'still told to refresh');
    } finally { hub.emit = real; }
  } finally { e.close(); }
});
