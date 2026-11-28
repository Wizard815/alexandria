// Biblio: the world library Alexandria hosts itself. Articles are written in
// Alexandria and published into the library as pages of the world's Biblio
// source, so the player copies, search, relations and the agents' tools work on
// them like on any imported page. These tests check what a player, a model and
// the GM each get, and that nothing GM-only or classified leaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { one } from '../src/core/db.ts';
import { dateSort } from '../src/features/biblio/store.ts';

async function boot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-biblio-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let j: any = t;
    try { j = JSON.parse(t); } catch { /* text */ }
    return { status: r.status, body: j };
  };
  const ok = async (method: string, url: string, token?: string, body?: unknown, headers?: Record<string, string>) => {
    const r = await call(method, url, token, body, headers);
    assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const T: Record<string, string> = {};
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const gmId = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'gamemaster', password: 'gm password 123' })).account.id;
  T.gm = (await ok('POST', '/api/auth/login', undefined, { username: 'gamemaster', password: 'gm password 123' })).token;
  const W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Bibland', dmAccountId: gmId })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.gm, { role: 'player' });
  T.jess = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' })).token;
  const B = `/api/worlds/${W}/biblio`;
  const MODEL = { 'X-Alexandria-Caller': 'model' };
  const text = (x: unknown) => JSON.stringify(x);
  return { base, deps: made.deps, W, T, B, MODEL, call, ok, text, close: () => { server.close(); server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

test('TestBiblio_PlayersGetOnlyTheirCopy', async () => {
  const t = await boot();
  try {
    const odda = await t.ok('POST', `${t.B}/articles`, t.T.gm, {
      title: 'Odda the Smith', template: 'character', level: 'party', summary: 'The smith of Old Kesh.',
      fields: { occupation: 'Smith', home: 'Old Kesh', member_of: '[[The Gilded Hand]]', secret: 'GMSECRET_FIELD she forged the false crown' },
      body: 'Odda works the forge by the river.\n\n> [!secret]\n> GMSECRET_CALLOUT she owes the Hand a debt.',
    });
    const plot = await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'The Crown Plot', body: 'GMSECRET_PAGE the duke means to crown a puppet.' });
    assert.equal(plot.article.level, 'dm', 'a new article is GM only by default');

    // The GM gets the article itself and the full copy.
    assert.equal(odda.article.fields.secret, 'GMSECRET_FIELD she forged the false crown');
    assert.ok(t.text(odda.page).includes('GMSECRET_CALLOUT'));

    // The player lists only the shared article, and reads a copy with no GM-only field, callout or text.
    const list = await t.ok('GET', t.B, t.T.jess);
    assert.deepEqual(list.articles.map((a: any) => a.title), ['Odda the Smith']);
    assert.equal(list.gm, false);
    const seen = await t.ok('GET', `${t.B}/articles/${odda.id}`, t.T.jess);
    const s = t.text(seen);
    for (const m of ['GMSECRET_FIELD', 'GMSECRET_CALLOUT', 'GMSECRET_PAGE']) assert.ok(!s.includes(m), `player copy leaks ${m}`);
    assert.equal(seen.article, undefined, 'players never get the stored article');
    assert.ok(s.includes('Smith') && s.includes('forge by the river'));
    const rows = seen.page.properties.flatMap((g: any) => g.rows.map((r: any) => r.key));
    assert.ok(rows.includes('Occupation') && !rows.includes('Secret'));
    assert.equal((await t.call('GET', `${t.B}/articles/${plot.id}`, t.T.jess)).status, 404);

    // The same through the library and its search: Biblio pages are library pages.
    const lib = await t.ok('GET', `/api/worlds/${t.W}/library/pages`, t.T.jess);
    assert.deepEqual(lib.map((p: any) => p.title), ['Odda the Smith']);
    const hits = await t.ok('GET', `/api/worlds/${t.W}/library/search?q=puppet`, t.T.jess);
    assert.equal(hits.length, 0);
    assert.equal((await t.ok('GET', `${t.B}/search?q=forge`, t.T.jess))[0].articleId, odda.id);

    // A relation from a link field shows on the Relations page.
    const rels = await t.ok('GET', `/api/worlds/${t.W}/library/relations`, t.T.gm);
    assert.ok(t.text(rels).includes('The Gilded Hand'), t.text(rels));

    // Players cannot write.
    assert.equal((await t.call('POST', `${t.B}/articles`, t.T.jess, { title: 'Mine' })).status, 403);
    assert.equal((await t.call('PATCH', `${t.B}/articles/${odda.id}`, t.T.jess, { body: 'x' })).status, 403);
  } finally { t.close(); }
});

test('TestBiblio_LinksBacklinksAndTree', async () => {
  const t = await boot();
  try {
    const kesh = await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'Old Kesh', template: 'location', level: 'party', aliases: ['Kesh'] });
    const market = await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'Kesh Market', parentId: kesh.id, level: 'party', body: 'The market of [[Kesh]].' });
    const spy = await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'Spy Report', body: 'Agents watch [[Old Kesh]].' });

    const gmView = await t.ok('GET', `${t.B}/articles/${kesh.id}`, t.T.gm);
    assert.deepEqual(gmView.backlinks.map((b: any) => b.title).sort(), ['Kesh Market', 'Spy Report']);
    assert.deepEqual(gmView.children.map((c: any) => c.title), ['Kesh Market']);
    // The player does not learn that a GM-only page mentions the town.
    const pView = await t.ok('GET', `${t.B}/articles/${kesh.id}`, t.T.jess);
    assert.deepEqual(pView.backlinks.map((b: any) => b.title), ['Kesh Market']);
    assert.equal(pView.backlinks[0].articleId, market.id);
    // The alias link resolves to the article's page.
    const m = await t.ok('GET', `${t.B}/articles/${market.id}`, t.T.jess);
    assert.equal(Object.values(m.page.links)[0], kesh.pageId);
    assert.equal(m.parent.id, kesh.id);

    // A child under a GM-only parent shows at the top for the player.
    const vault = await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'Hidden Vault' });
    await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'Vault Rumour', parentId: vault.id, level: 'party' });
    const tree = (await t.ok('GET', t.B, t.T.jess)).articles;
    assert.equal(tree.find((a: any) => a.title === 'Vault Rumour').parentId, null);
    assert.ok(!t.text(tree).includes('Hidden Vault'));

    // No cycles.
    assert.equal((await t.call('POST', `${t.B}/articles/${kesh.id}/move`, t.T.gm, { parentId: market.id })).status, 400);
    // Moving and renaming carries the children's folders along.
    await t.ok('PATCH', `${t.B}/articles/${kesh.id}`, t.T.gm, { title: 'Kesh-on-River' });
    const pg = one<any>(t.deps.db, 'SELECT folder FROM pages WHERE id = ?', market.pageId);
    assert.deepEqual(JSON.parse(pg.folder), ['Kesh-on-River']);

    // Trash takes the children too, restore brings both back.
    const gone = await t.ok('DELETE', `${t.B}/articles/${kesh.id}`, t.T.gm);
    assert.equal(gone.trashed.length, 2);
    assert.equal((await t.ok('GET', `/api/worlds/${t.W}/library/pages`, t.T.jess)).some((p: any) => p.title === 'Kesh Market'), false);
    assert.equal((await t.ok('GET', `${t.B}/trash`, t.T.gm)).length, 2);
    await t.ok('POST', `${t.B}/articles/${kesh.id}/restore`, t.T.gm);
    const back = (await t.ok('GET', t.B, t.T.jess)).articles.map((a: any) => a.title).sort();
    assert.deepEqual(back, ['Kesh Market', 'Kesh-on-River', 'Vault Rumour']);
    void spy;
  } finally { t.close(); }
});

test('TestBiblio_RevisionsAndStaleEdits', async () => {
  const t = await boot();
  try {
    const a = await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'The Long War', template: 'event', body: 'First draft.' });
    await t.ok('PATCH', `${t.B}/articles/${a.id}`, t.T.gm, { body: 'Second draft.', rev: 1 });
    // An edit made from version 1 after version 2 was saved is refused.
    const stale = await t.call('PATCH', `${t.B}/articles/${a.id}`, t.T.gm, { body: 'Clobber.', rev: 1 });
    assert.equal(stale.status, 409);
    const revs = await t.ok('GET', `${t.B}/articles/${a.id}/revisions`, t.T.gm);
    assert.deepEqual(revs.map((r: any) => r.rev), [2, 1]);
    assert.equal((await t.ok('GET', `${t.B}/articles/${a.id}/revisions/1`, t.T.gm)).article.body, 'First draft.');
    const back = await t.ok('POST', `${t.B}/articles/${a.id}/revisions/1/restore`, t.T.gm);
    assert.equal(back.article.body, 'First draft.');
    assert.equal(back.article.rev, 3);
    // Old versions hold everything: not for players, not for a model.
    assert.equal((await t.call('GET', `${t.B}/articles/${a.id}/revisions/1`, t.T.jess)).status, 403);
    assert.equal((await t.call('GET', `${t.B}/articles/${a.id}/revisions/1`, t.T.gm, undefined, t.MODEL)).status, 403);
  } finally { t.close(); }
});

test('TestBiblio_ModelsNeverSeeOrOverwriteClassified', async () => {
  const t = await boot();
  try {
    const cls = await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'The Bell', level: 'classified', body: 'CLASSIFIED_BELL three silver keys at the ebb tide.' });
    const mixed = await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'Harbour', level: 'dm', body: 'The harbour.\n\n> [!classified]\n> CLASSIFIED_MIXED the keeper is the queen.' });
    const plain = await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'Lighthouse', body: 'A tall tower.' });
    const list = await t.ok('GET', t.B, t.T.gm, undefined, t.MODEL);
    assert.ok(!t.text(list).includes('The Bell'), 'a model does not list classified articles');
    assert.equal((await t.call('GET', `${t.B}/articles/${cls.id}`, t.T.gm, undefined, t.MODEL)).status, 404);
    const h = await t.ok('GET', `${t.B}/articles/${mixed.id}`, t.T.gm, undefined, t.MODEL);
    assert.ok(!t.text(h).includes('CLASSIFIED_MIXED'));
    assert.equal(h.article, undefined, 'a model gets its copy, not the stored article');
    // Writing over what it never saw is refused; so is writing classified.
    assert.equal((await t.call('PATCH', `${t.B}/articles/${mixed.id}`, t.T.gm, { body: 'Rewritten.' }, t.MODEL)).status, 409);
    assert.equal((await t.call('PATCH', `${t.B}/articles/${plain.id}`, t.T.gm, { level: 'classified' }, t.MODEL)).status, 400);
    assert.equal((await t.call('POST', `${t.B}/articles`, t.T.gm, { title: 'X', body: '> [!classified]\n> nope' }, t.MODEL)).status, 400);
    // Ordinary edits from a model work, and are marked as the AI's in the history.
    await t.ok('PATCH', `${t.B}/articles/${plain.id}`, t.T.gm, { append: 'Its lamp is blue.' }, t.MODEL);
    const revs = await t.ok('GET', `${t.B}/articles/${plain.id}/revisions`, t.T.gm);
    assert.equal(revs[0].byKind, 'ai');
    assert.equal((await t.ok('GET', `${t.B}/articles/${plain.id}`, t.T.gm)).article.body, 'A tall tower.\n\nIts lamp is blue.');
  } finally { t.close(); }
});

test('TestBiblio_SuggestionsTimelineTemplates', async () => {
  const t = await boot();
  try {
    const war = await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'The Long War', template: 'event', level: 'party', fields: { date: 'Spring of 1040 AR', ended: '1044 AR' } });
    await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'Founding of Kesh', template: 'event', level: 'party', fields: { date: '-300' } });
    await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'Secret Coup', template: 'event', fields: { date: '1043 AR' } });
    // A GM-only date field (a custom template) never reaches the player's timeline.
    await t.ok('POST', `${t.B}/templates`, t.T.gm, { name: 'Ship', icon: 'fa-ship', fields: [{ label: 'Launched', type: 'date' }, { label: 'Sinks', type: 'date', gm: true }, { label: 'Captain', type: 'link' }] });
    await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'The Gull', template: 'ship', level: 'party', fields: { launched: '1041', sinks: 'GMSECRET 1045' } });

    const gmT = await t.ok('GET', `${t.B}/timeline`, t.T.gm);
    assert.deepEqual(gmT.map((e: any) => e.when), ['-300', 'Spring of 1040 AR', '1041', '1043 AR', '1044 AR', 'GMSECRET 1045']);
    const pT = await t.ok('GET', `${t.B}/timeline`, t.T.jess);
    assert.deepEqual(pT.map((e: any) => e.when), ['-300', 'Spring of 1040 AR', '1041', '1044 AR']);
    assert.equal(dateSort('3 Frostfall 1042 AR'), 1042);
    assert.equal(dateSort('no year'), null);
    assert.equal(dateSort('212 BR'), -212);

    // A player suggests an edit and a new article; the GM accepts both.
    const s1 = await t.ok('POST', `${t.B}/suggestions`, t.T.jess, { articleId: war.id, body: 'My grandfather fought at the ford.' });
    const s2 = await t.ok('POST', `${t.B}/suggestions`, t.T.jess, { title: 'The Ford', body: 'A crossing on the river.' });
    assert.equal((await t.ok('GET', `${t.B}/suggestions`, t.T.jess)).length, 2);
    assert.equal((await t.call('POST', `${t.B}/suggestions/${s1.id}/accept`, t.T.jess)).status, 403);
    await t.ok('POST', `${t.B}/suggestions/${s1.id}/accept`, t.T.gm);
    const made = await t.ok('POST', `${t.B}/suggestions/${s2.id}/accept`, t.T.gm, { level: 'party', template: 'location' });
    const w = await t.ok('GET', `${t.B}/articles/${war.id}`, t.T.jess);
    assert.ok(w.page.body.includes('My grandfather fought at the ford.') && w.page.body.includes('From Jess'));
    assert.equal(made.article.title, 'The Ford');
    assert.equal((await t.ok('GET', `${t.B}/suggestions`, t.T.gm)).every((x: any) => x.status === 'accepted'), true);
    // A template in use cannot be deleted.
    assert.equal((await t.call('DELETE', `${t.B}/templates/ship`, t.T.gm)).status, 409);
    assert.equal((await t.call('DELETE', `${t.B}/templates/character`, t.T.gm)).status, 409);
  } finally { t.close(); }
});

test('TestBiblio_ImportExportAndGuards', async () => {
  const t = await boot();
  try {
    // A page that came from somewhere else (here: written straight into the library).
    const src = await t.ok('PUT', `/api/worlds/${t.W}/library/pages`, t.T.gm, {
      path: 'npcs/Brother Tamsin', visibility: 'party',
      markdown: '---\ntags: [monk]\naliases: [Tamsin]\n---\nA quiet monk.\n\n> [!secret]\n> GMSECRET_IMPORT he is the spy.',
    });
    const out = await t.ok('POST', `${t.B}/import`, t.T.gm, { pageIds: [src.id] });
    assert.equal(out.imported.length, 1);
    const art = await t.ok('GET', `${t.B}/articles/${out.imported[0].articleId}`, t.T.gm);
    assert.equal(art.article.level, 'party');
    assert.deepEqual(art.article.tags, ['monk']);
    assert.deepEqual(art.article.aliases, ['Tamsin']);
    const p = await t.ok('GET', `${t.B}/articles/${art.id}`, t.T.jess);
    assert.ok(!t.text(p).includes('GMSECRET_IMPORT'), 'the secret stays secret in Biblio');
    assert.equal((await t.ok('POST', `${t.B}/import`, t.T.gm, { pageIds: [src.id] })).skipped[0].why, 'Copied before');
    assert.equal((await t.call('POST', `${t.B}/import`, t.T.gm, { pageIds: [src.id] }, t.MODEL)).status, 403);

    // Export and load into another world keeps the tree.
    const kid = await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'Tamsin\'s Cell', parentId: art.id });
    const dump = await t.ok('GET', `${t.B}/export`, t.T.gm);
    assert.equal(dump.articles.length, 2);
    const gm2 = (await t.ok('POST', '/api/admin/accounts', t.T.admin, { username: 'gm2', password: 'gm password 456' })).account.id;
    const tok2 = (await t.ok('POST', '/api/auth/login', undefined, { username: 'gm2', password: 'gm password 456' })).token;
    const W2 = (await t.ok('POST', '/api/admin/worlds', t.T.admin, { name: 'Otherland', dmAccountId: gm2 })).id;
    assert.equal((await t.ok('POST', `/api/worlds/${W2}/biblio/export`, tok2, dump)).articles, 2);
    const tree2 = (await t.ok('GET', `/api/worlds/${W2}/biblio`, tok2)).articles;
    const cell = tree2.find((a: any) => a.title === "Tamsin's Cell");
    assert.equal(tree2.find((a: any) => a.id === cell.parentId).title, 'Brother Tamsin');
    // Worlds stay apart.
    assert.equal((await t.call('GET', `/api/worlds/${W2}/biblio/articles/${kid.id}`, tok2)).status, 404);

    // The library does not write over a Biblio page, and the Biblio source is not deleted with the sources.
    const pg = one<any>(t.deps.db, 'SELECT path FROM pages WHERE id = ?', art.pageId);
    assert.equal((await t.call('PUT', `/api/worlds/${t.W}/library/pages`, t.T.gm, { path: pg.path, body: 'overwritten' })).status, 409);
    const sid = (await t.ok('GET', t.B, t.T.gm)).sourceId;
    assert.equal((await t.call('DELETE', `/api/admin/sources/${sid}`, t.T.admin)).status, 409);
    // A change request on a Biblio article is applied through Biblio.
    const req = await t.ok('POST', `/api/worlds/${t.W}/requests`, t.T.jess, { kind: 'edit', pageId: art.pageId, title: 'Add', body: 'He hums at dawn.' });
    await t.ok('POST', `/api/worlds/${t.W}/requests/${req.id}/decide`, t.T.gm, { decision: 'accepted', apply: { mode: 'append' } });
    const after = await t.ok('GET', `${t.B}/articles/${art.id}`, t.T.gm);
    assert.ok(after.article.body.endsWith('He hums at dawn.'));
    assert.ok(t.text(after.page).includes('GMSECRET_IMPORT'), 'the article kept its secret');
  } finally { t.close(); }
});

test('TestBiblio_McpTools', async () => {
  const t = await boot();
  try {
    await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'Odda', level: 'party', body: 'The smith.' });
    await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'The Bell', level: 'classified', body: 'CLASSIFIED_BELL keys.' });
    await t.ok('POST', `${t.B}/articles`, t.T.gm, { title: 'Spy Ring', body: 'GMONLY_RING runs the docks.' });
    const wk = (await t.ok('POST', '/api/keys', t.T.gm, { label: 'gm ai', scope: 'scribe', worldId: t.W, access: 'write' })).key;
    const rk = (await t.ok('POST', '/api/keys', t.T.jess, { label: 'jess ai', scope: 'scribe', worldId: t.W, access: 'read' })).key;
    const rpc = async (token: string, method: string, params: any = {}) => (await t.ok('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method, params })).result;
    const gmTools = (await rpc(wk, 'tools/list')).tools.map((x: any) => x.name);
    for (const n of ['biblio_list', 'biblio_read', 'biblio_find', 'biblio_timeline', 'biblio_templates', 'biblio_write', 'biblio_move', 'biblio_trash']) assert.ok(gmTools.includes(n), `${n} listed for the GM`);
    const pTools = (await rpc(rk, 'tools/list')).tools.map((x: any) => x.name);
    assert.ok(pTools.includes('biblio_list') && pTools.includes('biblio_read'));
    assert.ok(!pTools.includes('biblio_write') && !pTools.includes('biblio_templates'));

    // The GM's AI sees GM-only articles but never classified ones; the player's AI sees only the shared one.
    const gmList = JSON.stringify(await rpc(wk, 'tools/call', { name: 'biblio_list', arguments: {} }));
    assert.ok(gmList.includes('Spy Ring') && gmList.includes('Odda') && !gmList.includes('The Bell'));
    const pList = JSON.stringify(await rpc(rk, 'tools/call', { name: 'biblio_list', arguments: {} }));
    assert.ok(pList.includes('Odda') && !pList.includes('Spy Ring') && !pList.includes('The Bell'));

    // A write key's AI can write an article.
    const made = await rpc(wk, 'tools/call', { name: 'biblio_write', arguments: { title: 'Gull Inn', template: 'location', fields: { type: 'Inn' }, body: 'Cheap beds.' } });
    assert.equal(made.isError, false, JSON.stringify(made));
    const gm = await t.ok('GET', t.B, t.T.gm);
    const inn = gm.articles.find((a: any) => a.title === 'Gull Inn');
    assert.ok(inn && inn.level === 'dm');
    const revs = await t.ok('GET', `${t.B}/articles/${inn.id}/revisions`, t.T.gm);
    assert.equal(revs[0].byKind, 'ai', 'an MCP client counts as an AI');
  } finally { t.close(); }
});
