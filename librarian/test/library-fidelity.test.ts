// The Library is faithful to its sources: order, links, source pages, and what
// survives the import. LegendKeeper and Kanka are faked from their official
// API docs; Markdown is a real folder. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library, safeSourceUrl } from '../src/core/library.ts';
import { openDb, run } from '../src/core/db.ts';
import { runSync } from '../src/intake/sync.ts';
import { lkBlocks, lkPositions, lkUrl } from '../src/intake/connectors/legendkeeper.ts';
import { kankaEntityUrl, kankaPositions } from '../src/intake/connectors/kanka.ts';
import { markdownEntry, obsidianUrl, setMarkdownPositions } from '../src/intake/connectors/markdown.ts';
import { markdownToBlocks, mentionsIn, relativeLinkName } from '../src/intake/model.ts';
import { CONNECTORS } from '../src/intake/registry.ts';
import { buildTree, treeTitles, type PageRow } from '../../web/src/pages/library/treeModel.ts';
import { mentionView, safeHref, safeImageUrl, sourceLink } from '../../web/src/pages/library/links.ts';

const player = { accountId: 'p', role: 'player' as const };
const dm = { accountId: 'a', role: 'dm' as const };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const P = (t: string) => ({ kind: 'paragraph', content: [{ text: t }] });

function world(kind: string, config: Record<string, unknown>, vis = 'party') {
  const db = openDb(':memory:');
  run(db, `INSERT INTO worlds (id, slug, name, created_at) VALUES ('w', 'w', 'W', 'now')`);
  run(db, `INSERT INTO accounts (id, username, display_name, created_at) VALUES ('a', 'a', 'a', 'now')`);
  run(db, `INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s', 'w', ?, 'S', ?, ?)`, kind, JSON.stringify(config), vis);
  return { db, lib: new Library(db, null) };
}
const sync = (db: any, lib: Library, fetchImpl: typeof fetch, vaultsDir: string | null = null) => runSync({ db, library: lib, dataDir: null, vaultsDir, fetch: fetchImpl, env: { ALX_CRAWL_RATE: '0' }, mcp: null as any }, 's', 'a');
const byTitle = (lib: Library, viewer: any, t: string) => (lib.list('w', viewer) as any[]).find((p) => p.title === t);

// ---------- LegendKeeper ----------

// Names run Zed, Alpha, Mid; ranks say Mid, Zed, Alpha. LegendKeeper shows rank order.
const LK = [
  { id: 'root', name: 'World', parentId: null, rank: 'a0', isHidden: false, tags: [], aliases: [], iconGlyph: 'globe', iconColor: '#C49454', documents: [{ id: 'dr', name: 'Main', type: 'page' }] },
  { id: 'zed', name: 'Zed Town', parentId: 'root', rank: 'a2', isHidden: false, tags: ['town'], aliases: ['Zedville'], iconGlyph: 'city', documents: [{ id: 'dz', name: 'Main', type: 'page' }, { id: 'dz2', name: 'Extra', type: 'page' }, { id: 'dz3', name: 'Another', type: 'page' }] },
  { id: 'alpha', name: 'Alpha Keep', parentId: 'root', rank: 'a3', isHidden: false, tags: [], aliases: [], documents: [{ id: 'da', name: 'Main', type: 'page' }] },
  { id: 'mid', name: 'Mid Road', parentId: 'root', rank: 'a1', isHidden: false, tags: [], aliases: [], documents: [{ id: 'dm', name: 'Main', type: 'page' }] },
  { id: 'norank', name: 'Unranked', parentId: 'root', rank: null, isHidden: false, tags: [], aliases: [], documents: [{ id: 'du', name: 'Main', type: 'page' }] },
  { id: 'tpl', name: 'A Template', parentId: null, rank: 'a5', isTemplate: true, isHidden: false, tags: [], aliases: [], documents: [{ id: 'dt', name: 'Main', type: 'page' }] },
];
const lkBlocksOf: Record<string, any[]> = {
  root: [P('Home')],
  zed: [{ kind: 'paragraph', content: [{ text: 'Visit ' }, { text: 'the keep', link: 'lk://resources/alpha' }, { text: ' and ' }, { text: 'bad', link: 'javascript:alert(1)' }, { text: ' ' }, { mention: { resourceId: 'zed', documentId: 'dz', text: 'self' } }] }],
  alpha: [{ kind: 'paragraph', content: [{ mention: { resourceId: 'ghost' } }, { text: ' and ' }, { mention: { resourceId: 'mid' } }] }, { kind: 'map', resourceId: 'mid', documentId: 'dm', title: 'Road map' }],
  mid: [P('Road.')], norank: [P('?')],
};
function lkFetch(extraProps: Record<string, any[]> = {}) {
  return (async (url: string) => {
    const u = new URL(url);
    const p = u.pathname.replace('/api/v3/projects/proj1', '');
    if (p === '/resources') return json({ data: LK, hasMore: false, nextCursor: null });
    const m = /^\/resources\/([^/]+)(?:\/docs\/([^/]+)\/blocks)?$/.exec(p);
    if (!m) return json({ code: 'NOT_FOUND' }, 404);
    const r = LK.find((x) => x.id === m[1])!;
    if (m[2]) return json({ id: m[2], blocks: lkBlocksOf[r.id] ?? [] });
    return json({ ...r, permissions: { MEMBER: 5, ADMIN: 3, OWNER: 3 }, ancestors: [], documents: r.documents.map((d, i) => ({ ...d, rank: `r${3 - i}`, isHidden: false })), properties: extraProps[r.id] ?? [] });
  }) as typeof fetch;
}
const LK_CFG = { apiUrl: 'https://www.legendkeeper.com/api/v3/projects/proj1', apiKey: 'lk_testkey_123' };

test('TestLibraryFidelity_LegendKeeperOrderFollowsRankNotName', async () => {
  assert.deepEqual([...lkPositions(LK).entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id), ['root', 'mid', 'zed', 'alpha', 'norank', 'tpl'], 'rank compared as plain strings, no rank last, DFS from the root');
  const { db, lib } = world('legendkeeper-api', LK_CFG);
  const out = await sync(db, lib, lkFetch());
  assert.equal(out.status, 'ok', out.error);
  const rows = lib.list('w', dm) as PageRow[];
  const tree = buildTree(rows);
  // The tree shows source order by default.
  assert.deepEqual(treeTitles(tree[0].children[0].children), ['Mid Road', 'Zed Town', 'Zed Town · Another', 'Zed Town · Extra', 'Alpha Keep', 'Unranked']);
  // Extra tabs follow their page in the order LegendKeeper ranks the tabs (dz3 is ranked before dz2 here).
  const pos = (t: string) => (rows.find((r) => r.title === t) as any).position as number;
  assert.ok(pos('Zed Town') < pos('Zed Town · Another') && pos('Zed Town · Another') < pos('Zed Town · Extra') && pos('Zed Town · Extra') < pos('Alpha Keep'));
  // A–Z is a different order from the source's.
  assert.deepEqual([...rows].sort((a, b) => a.title.localeCompare(b.title)).map((r) => r.title).slice(0, 3), ['Alpha Keep', 'Mid Road', 'Unranked']);
  // The children list on a page follows the source order too.
  const root = lib.get('w', byTitle(lib, dm, 'World').id, dm) as any;
  assert.deepEqual(root.children.map((c: any) => c.title), ['Mid Road', 'Zed Town', 'Alpha Keep', 'Unranked']);
});

test('TestLibraryFidelity_LegendKeeperOrderIsStableAcrossResyncs', async () => {
  const { db, lib } = world('legendkeeper-api', LK_CFG);
  await sync(db, lib, lkFetch());
  const snap = () => (lib.list('w', dm) as any[]).map((r) => [r.title, r.position]).sort().join('|');
  const first = snap();
  await sync(db, lib, lkFetch());
  assert.equal(snap(), first, 'a second sync keeps every position');
  // An edit that does not move anything keeps the order; moving a page changes only its place.
  lkBlocksOf.mid = [P('Road, edited.')];
  await sync(db, lib, lkFetch());
  assert.equal(snap(), first);
  LK[3].rank = 'a9';
  try {
    await sync(db, lib, lkFetch());
    const rows = lib.list('w', dm) as any[];
    assert.deepEqual(treeTitles(buildTree(rows)[0].children[0].children), ['Zed Town', 'Zed Town · Another', 'Zed Town · Extra', 'Alpha Keep', 'Mid Road', 'Unranked']);
  } finally { LK[3].rank = 'a1'; lkBlocksOf.mid = [P('Road.')]; }
});

test('TestLibraryFidelity_LegendKeeperLinksImagesAndMapBlocks', async () => {
  const { db, lib } = world('legendkeeper-api', LK_CFG);
  const props = { zed: [
    { kind: 'image', title: 'Portrait', isHidden: false, url: 'https://cdn.example/zed.png' },
    { kind: 'image', title: 'Secret map', isHidden: true, url: 'https://cdn.example/secret.png' },
    { kind: 'image', title: 'Bad', isHidden: false, url: 'javascript:alert(1)' },
  ] };
  await sync(db, lib, lkFetch(props));
  const zed = byTitle(lib, dm, 'Zed Town');
  const pg = lib.get('w', zed.id, dm) as any;
  // lk:// link marks become mentions; javascript: is not kept as a link.
  const ms = mentionsIn(pg.blocks);
  assert.ok(ms.some((m) => m.ref === 'alpha' && m.text === 'the keep'), 'lk:// link is a mention');
  assert.ok(!JSON.stringify(pg.blocks).includes('javascript'), 'bad link scheme dropped');
  const self = ms.find((m) => m.ref === 'zed#dz')!;
  assert.equal(pg.links['ref:zed#dz'], zed.id, 'a mention of the first tab resolves to the page');
  assert.equal(mentionView(self, pg.links, pg.linkTitles).target, zed.id);
  // The sidebar portrait is kept; the hidden one is a DM-only secret; the bad URL is dropped.
  assert.equal(pg.blocks[0].kind, 'image');
  assert.equal(pg.blocks[1].kind, 'secret');
  assert.ok(!JSON.stringify(pg.blocks).includes('alert'));
  const pp = JSON.stringify(lib.get('w', zed.id, player));
  assert.ok(pp.includes('zed.png') && !pp.includes('secret.png'), 'players get the shared portrait only');
  // A map block is a link to the map page, never an unsupported block.
  const alpha = lib.get('w', byTitle(lib, dm, 'Alpha Keep').id, dm) as any;
  assert.ok(!JSON.stringify(alpha.blocks).includes('unsupported'));
  assert.ok(mentionsIn(alpha.blocks).some((m) => m.ref === 'mid#dm' && m.text === 'Road map'));
  assert.equal(alpha.links['ref:mid#dm'], byTitle(lib, dm, 'Mid Road').id, 'map-tab ref falls back to the resource page');
});

test('TestLibraryFidelity_LegendKeeperUrlPatternIsConfigurable', () => {
  assert.equal(lkUrl({ apiUrl: 'https://www.legendkeeper.com/api/v3/projects/proj1' }, 'res9'), 'https://www.legendkeeper.com/app/project/proj1/resource/res9', 'default pattern, project id from the API URL');
  assert.equal(lkUrl({ projectId: 'p2', webUrl: 'https://lk.example/{project}/r/{id}?d={doc}' }, 'a b', 'd1'), 'https://lk.example/p2/r/a%20b?d=d1');
  assert.equal(lkUrl({}, 'x'), null, 'no project id, no link');
  assert.equal(lkUrl({ projectId: 'p', webUrl: 'javascript:alert(1)//{id}' }, 'x'), null, 'only http(s)');
});

// ---------- Kanka ----------

test('TestLibraryFidelity_KankaOrderIsModuleThenName', () => {
  const rows = [
    { mod: 'locations', e: { entity_id: 3, name: 'beta' } }, { mod: 'characters', e: { entity_id: 2, name: 'Zoe' } },
    { mod: 'characters', e: { entity_id: 1, name: 'adam' } }, { mod: 'locations', e: { entity_id: 4, name: 'Alpha 10' } }, { mod: 'locations', e: { entity_id: 5, name: 'Alpha 9' } },
  ];
  const pos = kankaPositions(rows, (r) => r.mod, (r) => r.e.name, (r) => String(r.e.entity_id));
  assert.deepEqual([...pos.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k), ['1', '2', '5', '4', '3'], 'characters before locations; names case-insensitive, numbers natural');
});

test('TestLibraryFidelity_KankaUrlsPointAtTheEntityInTheCampaign', async () => {
  assert.equal(kankaEntityUrl({ campaignId: '42' }, 1001), 'https://app.kanka.io/w/42/entities/1001');
  assert.equal(kankaEntityUrl({ campaignId: '42', apiUrl: 'https://wiki.example.org/api/1.0' }, 7), 'https://wiki.example.org/w/42/entities/7');
  assert.equal(kankaEntityUrl({ campaignId: 'x' }, 7), null);
  const ent = (id: number, name: string, extra: Record<string, unknown> = {}) => ({ id, entity_id: id + 1000, name, entry: name, is_private: false, tags: [], ...extra });
  const fake = (async (url: string) => {
    const u = new URL(url);
    const mod = u.pathname.split('/').pop()!;
    const data = mod === 'characters' ? [ent(2, 'Zoe', { urls: { view: 'https://app.kanka.io/w/42/entities/1002' } }), ent(1, 'Adam')] : mod === 'locations' ? [ent(3, 'Cave')] : [];
    return json({ data, links: { next: null }, meta: { current_page: 1, last_page: 1 } });
  }) as typeof fetch;
  const { db, lib } = world('kanka-api', { campaignId: '42', token: 'x'.repeat(24) });
  const out = await sync(db, lib, fake);
  assert.equal(out.status, 'ok', out.error);
  const get = (t: string) => lib.get('w', byTitle(lib, dm, t).id, dm) as any;
  assert.equal(get('Zoe').url, 'https://app.kanka.io/w/42/entities/1002', 'the API url is used');
  assert.equal(get('Adam').url, 'https://app.kanka.io/w/42/entities/1001', 'built from campaign and entity id when the API gave none');
  assert.equal(get('Adam').source_app, 'kanka');
  assert.deepEqual(treeTitles(buildTree(lib.list('w', dm) as PageRow[])[0].children), ['Characters', 'Adam', 'Zoe', 'Locations', 'Cave']);
});

// ---------- Markdown ----------

test('TestLibraryFidelity_MarkdownOrderFoldersFirstThenFrontmatterOrder', () => {
  const e = (p: string, fm = '') => markdownEntry(p, `${fm}Body of ${p}.`, 'dm');
  const entries = [e('b.md'), e('Notes/zeta.md'), e('Notes/alpha.md', '---\norder: 2\n---\n'), e('Notes/beta.md', '---\nposition: 1\n---\n'), e('a10.md'), e('a9.md'), e('Archive/x.md')];
  setMarkdownPositions(entries);
  assert.deepEqual(entries.slice().sort((a, b) => a.position! - b.position!).map((x) => x.externalId), ['Archive/x.md', 'Notes/beta.md', 'Notes/alpha.md', 'Notes/zeta.md', 'a9.md', 'a10.md', 'b.md']);
  setMarkdownPositions(entries.slice().reverse());
  assert.deepEqual(entries.slice().sort((a, b) => a.position! - b.position!).map((x) => x.externalId)[1], 'Notes/beta.md', 'file order on disk does not matter');
});

test('TestLibraryFidelity_MarkdownOpenFileLinkNeedsAVaultName', () => {
  assert.equal(obsidianUrl('My Vault', 'People/Mira Voss.md'), 'obsidian://open?vault=My%20Vault&file=People%2FMira%20Voss');
  assert.equal(obsidianUrl('', 'a.md'), null);
  assert.equal(markdownEntry('a.md', 'x', 'dm').url, null);
  assert.equal(markdownEntry('a.md', 'x', 'dm', 'V').url, 'obsidian://open?vault=V&file=a');
  assert.equal(safeSourceUrl('javascript:alert(1)'), null);
  assert.equal(safeSourceUrl('data:text/html,hi'), null);
  assert.equal(safeSourceUrl('obsidian://open?vault=V&file=a'), 'obsidian://open?vault=V&file=a');
});

test('TestLibraryFidelity_MarkdownFolderSyncStoresOrderAndUrl', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-vault-'));
  try {
    fs.mkdirSync(path.join(dir, 'v', 'Cast'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'v', 'Cast', 'Zara.md'), '---\norder: 1\nvisibility: party\n---\nZara knows [[Mira Voss]] and [the inn](The%20Inn.md) and ![[map.png]].');
    fs.writeFileSync(path.join(dir, 'v', 'Cast', 'Abel.md'), '---\nvisibility: party\n---\nAbel.');
    fs.writeFileSync(path.join(dir, 'v', 'The Inn.md'), '---\ntitle: The Rusty Anchor\nvisibility: party\n---\nAn inn. Also see [site](https://example.org/a).');
    fs.writeFileSync(path.join(dir, 'v', 'mira-note.md'), '---\ntitle: Mira Voss\nvisibility: dm\n---\nSecret.');
    const { db, lib } = world('markdown-folder', { folder: 'v', vaultName: 'Test Vault' });
    const out = await sync(db, lib, fetch, dir);
    assert.equal(out.status, 'ok', out.error);
    const rows = lib.list('w', dm) as any[];
    assert.deepEqual(treeTitles(buildTree(rows as PageRow[])[0].children), ['Cast', 'Zara', 'Abel', 'Mira Voss', 'The Rusty Anchor'], 'folders first, order: 1 before the unnumbered file');
    const zara = lib.get('w', byTitle(lib, dm, 'Zara').id, dm) as any;
    assert.equal(zara.url, 'obsidian://open?vault=Test%20Vault&file=Cast%2FZara');
    assert.equal(zara.source_app, 'markdown');
    assert.ok(zara.synced_at, 'last sync time shown');
    // The relative link and the wiki link by title resolve; the embedded picture is not a link or a stray "!".
    assert.ok(zara.links['name:the inn'], 'a link to the file The Inn.md reaches the page titled The Rusty Anchor');
    assert.ok(zara.links['name:mira voss']);
    assert.ok(!JSON.stringify(zara.blocks).includes('map.png') && !JSON.stringify(zara.blocks).includes('"!"'));
    // For a player the page titled Mira Voss is DM-only, so the link is "(hidden)" and nothing of it leaks.
    const zp = JSON.stringify(lib.get('w', byTitle(lib, player, 'Zara').id, player));
    assert.ok(zp.includes('(hidden)') && !zp.includes('Mira Voss'));
    assert.ok(!byTitle(lib, player, 'Mira Voss'));
    // Re-sync keeps positions.
    const before = JSON.stringify(rows.map((r) => [r.title, r.position]).sort());
    await sync(db, lib, fetch, dir);
    assert.equal(JSON.stringify((lib.list('w', dm) as any[]).map((r) => [r.title, r.position]).sort()), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- Links ----------

test('TestLibraryFidelity_InternalLinkResolutionEdgeCases', () => {
  const { db, lib } = world('api', {});
  const save = (externalId: string, title: string, visibility: 'party' | 'dm', blocks: any[], extra: any = {}) => lib.saveEntry('w', 's', null, { externalId, title, visibility, blocks, ...extra }, null);
  const ref = (r: string, text?: string) => ({ mention: { ref: r, ...(text ? { text } : {}) } });
  const name = (n: string) => ({ mention: { name: n } });
  save('open', 'Open Page', 'party', [P('x')]);
  save('secret', 'Secret Page', 'dm', [P('y')], { aliases: ['The Shadow'] });
  save('src', 'Source', 'party', [{ kind: 'paragraph', content: [ref('open'), { text: ' | ' }, ref('secret'), { text: ' | ' }, ref('missing'), { text: ' | ' }, ref('missing', 'my words'), { text: ' | ' }, name('Open Page'), { text: ' | ' }, name('the shadow'), { text: ' | ' }, name('Nowhere'), { text: ' | ' }, ref('open#tab9')] }]);
  lib.rebuildPlayerCopies('w');
  const srcId = (lib.list('w', dm) as any[]).find((r) => r.title === 'Source').id;
  const openId = (lib.list('w', dm) as any[]).find((r) => r.title === 'Open Page').id;
  const p = lib.get('w', srcId, player) as any;
  const text = JSON.stringify(p.blocks);
  assert.equal(p.links['ref:open'], openId, 'mention by ref opens the right page');
  assert.equal(p.links['name:open page'], openId, 'mention by title');
  assert.equal(p.links['ref:open#tab9'], openId, 'a tab that does not exist falls back to the page');
  assert.ok(!('ref:secret' in p.links) && !('name:the shadow' in p.links), 'no link to pages players cannot see');
  assert.ok(!text.includes('Secret Page') && !text.includes('Shadow'), 'neither the title nor an alias of a hidden page leaks');
  assert.equal((text.match(/\(hidden\)/g) ?? []).length, 3, 'hidden target, hidden alias and a ref nothing resolves are all "(hidden)" for players');
  assert.ok(text.includes('my words'), 'an unresolved link keeps the words the author wrote');
  assert.ok(text.includes('Nowhere'), 'a [[link]] to a page that was never imported stays plain text');
  assert.ok(!('name:nowhere' in p.links), 'and has no target, so nothing 404s');
  const d = lib.get('w', srcId, dm) as any;
  assert.ok(d.links['ref:secret'] && d.links['name:the shadow'], 'the DM can open hidden pages');
  assert.ok(!('ref:missing' in d.links), 'an unimported page is plain text for the DM');
  // What the page shows for each case.
  assert.deepEqual(mentionView({ ref: 'missing' }, d.links, d.linkTitles), { text: '(page not imported)', target: null });
  assert.deepEqual(mentionView({ ref: 'open' }, d.links, d.linkTitles), { text: 'Open Page', target: openId }, 'a mention with no words shows the page title');
  assert.deepEqual(mentionView({ ref: 'open', text: 'the open one' }, d.links, d.linkTitles), { text: 'the open one', target: openId });
  assert.equal(mentionView({ name: 'Nowhere' }, d.links, d.linkTitles).target, null);
  void db;
});

test('TestLibraryFidelity_ExternalLinksOpenSafely', () => {
  for (const ok of ['https://example.org/a?b=1', 'http://example.org', 'mailto:a@b.c']) assert.equal(safeHref(ok), ok);
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd', '//evil.example', 'obsidian://open?vault=x', '', null, undefined, 'https://a b']) assert.equal(safeHref(bad), null, String(bad));
  assert.equal(safeImageUrl('javascript:alert(1)'), null);
  assert.equal(safeImageUrl('https://x/y".png'), null, 'no quote that could break out of the banner CSS');
  assert.equal(safeImageUrl('https://x/y.png'), 'https://x/y.png');
  // Markdown: only http, https and mailto links survive the import.
  const b = markdownToBlocks('[a](https://x.org) [b](javascript:alert(1)) [c](data:text/html,x) [d](mailto:q@x.org) [e](Other.md)');
  const inl = (b[0] as any).content;
  assert.deepEqual(inl.filter((x: any) => x.link).map((x: any) => x.link), ['https://x.org', 'mailto:q@x.org']);
  assert.ok(!JSON.stringify(inl).includes('javascript:') || !inl.some((x: any) => x.link?.startsWith('javascript')));
  assert.deepEqual(mentionsIn(b).map((m) => m.name), ['Other']);
  assert.equal(relativeLinkName('../Folder/Note%20Two.md#Part'), 'Note Two');
  assert.equal(relativeLinkName('pic.png'), null);
  assert.equal(relativeLinkName('https://x.org/a.md'), null);
  assert.equal(relativeLinkName('#part'), null);
  // LegendKeeper: the link mark is checked at import too.
  const lk = lkBlocks([{ kind: 'paragraph', content: [{ text: 'x', link: 'javascript:alert(1)' }, { text: 'y', link: 'https://ok.example' }, { text: 'z', link: 'data:text/html,1' }] }]);
  assert.deepEqual((lk[0] as any).content.map((c: any) => c.link ?? null), [null, 'https://ok.example', null]);
});

// ---------- Open in the source ----------

test('TestLibraryFidelity_SourcePageLinkIsHiddenFromPlayersUnlessAllowed', async () => {
  const mk = (cfg: Record<string, unknown>) => {
    const { db, lib } = world('legendkeeper-api', { ...LK_CFG, ...cfg });
    return { db, lib };
  };
  for (const [cfg, playersGet] of [[{}, false], [{ playersMayOpen: false }, false], [{ playersMayOpen: 'true' }, false], [{ playersMayOpen: true }, true]] as const) {
    const { db, lib } = mk(cfg);
    await sync(db, lib, lkFetch());
    const id = byTitle(lib, dm, 'Mid Road').id;
    const d = lib.get('w', id, dm) as any;
    assert.equal(d.url, 'https://www.legendkeeper.com/app/project/proj1/resource/mid', 'the DM always gets it');
    assert.equal(d.source_app, 'legendkeeper');
    const pl = lib.get('w', id, player) as any;
    assert.equal(!!pl.url, playersGet, JSON.stringify(cfg));
    assert.equal(pl.source, 'S', 'players still see the source and when it was read');
    assert.ok(pl.synced_at);
    // A model and the broker never get a source link, whatever the setting.
    for (const role of ['broker', 'ai'] as const) {
      const v = { accountId: 'a', role: 'dm' as const, audience: role };
      assert.ok(!(lib.get('w', id, v) as any).url, role);
    }
    assert.ok(!JSON.stringify(lib.list('w', player)).includes('legendkeeper.com/app'), 'the list never carries the link');
  }
  assert.ok(sourceLink({ url: 'https://www.legendkeeper.com/app/project/p/resource/r', source_app: 'legendkeeper' })?.label === 'Open in LegendKeeper');
  assert.equal(sourceLink({ url: 'https://x', source_app: 'kanka' })?.label, 'Open in Kanka');
  assert.equal(sourceLink({ url: 'obsidian://open?vault=V&file=a', source_app: 'markdown' })?.label, 'Open file');
  assert.equal(sourceLink({ url: 'javascript:alert(1)', source_app: 'kanka' }), null);
  assert.equal(sourceLink({ url: 'data:text/html,x' }), null);
  assert.equal(sourceLink({ source_app: 'kanka' }), null);
});

test('TestLibraryFidelity_EverySourceHasThePlayersMayOpenSetting', () => {
  for (const c of CONNECTORS.filter((x) => !x.push && x.id !== 'git' && x.id !== 'api')) {
    const f = c.fields.find((x) => x.key === 'playersMayOpen');
    assert.ok(f && f.type === 'boolean' && f.default === false, `${c.id}: off by default`);
  }
});
