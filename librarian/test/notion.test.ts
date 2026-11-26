// The Notion connector and its WorldLore write-back against a fake Notion that follows the API reference
// (developers.notion.com, version 2022-06-28). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/core/library.ts';
import { openDb, run } from '../src/core/db.ts';
import { runSync } from '../src/intake/sync.ts';
import { WriteRefused } from '../src/intake/connector.ts';
import { notionAccess, notionBlocks, notionId } from '../src/intake/connectors/notion.ts';
import { mdToNotion, notionWrite } from '../src/intake/connectors/notion-write.ts';
import { blocksToMarkdown } from '../src/intake/model.ts';
import { playerBlocks } from '../src/intake/player.ts';

const player = { accountId: 'p', role: 'player' as const };
const dm = { accountId: 'a', role: 'dm' as const };
const TOKEN = 'ntn_' + 'x'.repeat(40);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rt = (t: string, extra: Record<string, unknown> = {}) => [{ type: 'text', plain_text: t, text: { content: t }, annotations: {}, href: null, ...extra }];

function world(config: Record<string, unknown>) {
  const db = openDb(':memory:');
  run(db, `INSERT INTO worlds (id, slug, name, created_at) VALUES ('w', 'w', 'W', 'now')`);
  run(db, `INSERT INTO accounts (id, username, display_name, created_at) VALUES ('a', 'a', 'a', 'now')`);
  run(db, `INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s', 'w', 'notion-api', 'S', ?, 'party')`, JSON.stringify(config));
  return { db, lib: new Library(db, null) };
}

// ---- a fake Notion workspace -------------------------------------------------------------------------------------------

interface Obj { object: 'page' | 'database'; id: string; parent: any; properties?: any; title?: any[]; public_url?: string | null; archived?: boolean; last_edited_time: string; url: string }
function fakeNotion() {
  const objs = new Map<string, Obj>();
  const blocks = new Map<string, any[]>(); // parent id -> children
  const calls: string[] = [];
  let n = 1000;
  const page = (id: string, title: string, parent: any, extra: Partial<Obj> = {}): Obj => {
    const o: Obj = { object: 'page', id, parent, properties: { title: { id: 'title', type: 'title', title: rt(title) } }, public_url: null, last_edited_time: '2026-11-01T00:00:00.000Z', url: `https://www.notion.so/${id.replace(/-/g, '')}`, ...extra };
    objs.set(id, o);
    return o;
  };
  const f = (async (url: string, init: any = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const path = u.pathname.replace(/^\/v1/, '');
    calls.push(`${method} ${path}`);
    if (init.headers?.Authorization !== `Bearer ${TOKEN}` || init.headers?.['Notion-Version'] !== '2022-06-28') return json({ object: 'error', status: 401, message: 'bad token' }, 401);
    const body = init.body ? JSON.parse(init.body) : {};
    let m: RegExpExecArray | null;
    if (path === '/users/me') return json({ object: 'user', id: uid(1), name: 'Alexandria', type: 'bot' });
    if (path === '/search' && method === 'POST') {
      const list = [...objs.values()].filter((o) => !o.archived && (!body.query || JSON.stringify(o).toLowerCase().includes(String(body.query).toLowerCase())));
      const start = Number(body.start_cursor ?? 0);
      const size = 2; // tiny pages, so paging is exercised
      const slice = list.slice(start, start + size);
      return json({ object: 'list', results: slice, has_more: start + size < list.length, next_cursor: start + size < list.length ? String(start + size) : null });
    }
    if ((m = /^\/(pages|databases)\/([0-9a-f-]{36})$/.exec(path))) {
      const o = objs.get(m[2]);
      if (!o || o.object !== (m[1] === 'pages' ? 'page' : 'database')) return json({ object: 'error', status: 404 }, 404);
      if (method === 'GET') return json(o);
      if (method === 'PATCH') { if (body.archived) o.archived = true; if (body.properties) Object.assign(o.properties, body.properties); o.last_edited_time = '2026-11-02T00:00:00.000Z'; return json(o); }
    }
    if ((m = /^\/blocks\/([0-9a-f-]{36})\/children$/.exec(path))) {
      const kids = blocks.get(m[1]) ?? [];
      if (method === 'GET') {
        const start = Number(u.searchParams.get('start_cursor') ?? 0);
        const size = Number(u.searchParams.get('page_size') ?? 100);
        return json({ object: 'list', results: kids.slice(start, start + size), has_more: start + size < kids.length, next_cursor: start + size < kids.length ? String(start + size) : null });
      }
      if (method === 'PATCH') { for (const c of body.children) kids.push({ ...c, id: uid(n++), has_children: !!c[c.type]?.children?.length }); blocks.set(m[1], kids); return json({ object: 'list', results: kids }); }
    }
    if ((m = /^\/blocks\/([0-9a-f-]{36})$/.exec(path))) {
      if (method === 'DELETE') { for (const [k, v] of blocks) blocks.set(k, v.filter((b) => b.id !== m![1])); return json({ object: 'block', id: m[1], archived: true }); }
      for (const [k, v] of blocks) { const b = v.find((x) => x.id === m![1]); if (b) return json({ ...b, parent: objs.has(k) ? { type: 'page_id', page_id: k } : { type: 'block_id', block_id: k } }); }
      return json({ object: 'error', status: 404 }, 404);
    }
    if (path === '/pages' && method === 'POST') {
      const id = uid(n++);
      const parent = body.parent.page_id ? { type: 'page_id', page_id: body.parent.page_id } : { type: 'database_id', database_id: body.parent.database_id };
      const o: Obj = { object: 'page', id, parent, properties: Object.fromEntries(Object.entries<any>(body.properties).map(([k, v]) => [k, v.title ? { type: 'title', title: v.title.map((t: any) => ({ ...t, plain_text: t.text?.content ?? '' })) } : { type: Object.keys(v)[0], ...v }])), public_url: null, last_edited_time: '2026-11-02T00:00:00.000Z', url: `https://www.notion.so/${id.replace(/-/g, '')}` };
      objs.set(id, o);
      blocks.set(id, (body.children ?? []).map((c: any) => ({ ...c, id: uid(n++), has_children: false })));
      return json(o);
    }
    return json({ object: 'error', status: 400, message: `unknown ${method} ${path}` }, 400);
  }) as unknown as typeof fetch;
  return { f, objs, blocks, calls, page };
}

const P = (t: string) => ({ type: 'paragraph', id: uid(9000 + Math.floor(Math.random() * 999)), has_children: false, paragraph: { rich_text: rt(t) } });

function realm() {
  const n = fakeNotion();
  const ROOT = uid(10), TOWN = uid(11), PLOT = uid(12), DB = uid(13), MIRA = uid(14), VILLAIN = uid(15), OUT = uid(16);
  n.page(ROOT, 'The Realm', { type: 'workspace', workspace: true }, { public_url: 'https://realm.notion.site/x' });
  n.page(TOWN, 'Port Town', { type: 'page_id', page_id: ROOT }, { public_url: 'https://realm.notion.site/town' });
  n.page(PLOT, 'The plot', { type: 'page_id', page_id: ROOT });
  n.objs.set(DB, { object: 'database', id: DB, parent: { type: 'page_id', page_id: ROOT }, title: rt('People'), properties: { Name: { type: 'title' }, Visibility: { type: 'select', select: { options: [] } } }, last_edited_time: '2026-11-01T00:00:00.000Z', url: `https://www.notion.so/${DB.replace(/-/g, '')}`, public_url: null });
  n.page(MIRA, 'Mira', { type: 'database_id', database_id: DB }, { properties: { Name: { type: 'title', title: rt('Mira') }, Visibility: { type: 'select', select: { name: 'Party' } }, Tags: { type: 'multi_select', multi_select: [{ name: 'innkeeper' }] }, Age: { type: 'number', number: 41 }, Home: { type: 'relation', relation: [{ id: TOWN }] } } });
  n.page(VILLAIN, 'The Lich', { type: 'database_id', database_id: DB }, { public_url: 'https://realm.notion.site/lich', properties: { Name: { type: 'title', title: rt('The Lich') }, Visibility: { type: 'select', select: { name: 'DM' } } } });
  n.page(OUT, 'Shopping list', { type: 'workspace', workspace: true }, { public_url: 'https://realm.notion.site/shop' });
  n.blocks.set(TOWN, [
    { type: 'heading_2', id: uid(100), has_children: false, heading_2: { rich_text: rt('Harbour') } },
    P('A busy harbour.'),
    { type: 'paragraph', id: uid(101), has_children: false, paragraph: { rich_text: [{ type: 'mention', plain_text: 'Mira', mention: { type: 'page', page: { id: MIRA } }, annotations: {} }, ...rt(' runs the inn.')] } },
    { type: 'toggle', id: uid(102), has_children: true, toggle: { rich_text: rt('🔒 DM notes') } },
    { type: 'callout', id: uid(103), has_children: false, callout: { rich_text: rt('Secret: SMUGGLERS use the old pier'), icon: { type: 'emoji', emoji: '🤫' } } },
    { type: 'bulleted_list_item', id: uid(104), has_children: false, bulleted_list_item: { rich_text: rt('Fish') } },
    { type: 'bulleted_list_item', id: uid(105), has_children: false, bulleted_list_item: { rich_text: rt('Rope') } },
    { type: 'child_page', id: uid(106), has_children: false, child_page: { title: 'Docks' } },
  ]);
  n.blocks.set(uid(102), [P('TIDETRAP at midnight')]);
  n.blocks.set(PLOT, [P('PLOTTWIST the duke is the lich.')]);
  n.blocks.set(MIRA, [P('Keeps the inn.')]);
  n.blocks.set(VILLAIN, [P('LICHNAME is Vorn.')]);
  return { n, ROOT, TOWN, PLOT, DB, MIRA, VILLAIN, OUT };
}

// ---- unit ---------------------------------------------------------------------------------------------------------------

test('TestNotion_IdsFromAddressesAndDashes', () => {
  assert.equal(notionId('https://www.notion.so/My-Realm-0123456789abcdef0123456789abcdef?pvs=4'), '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(notionId('0123456789ABCDEF0123456789ABCDEF'), '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(notionId('notion:01234567-89ab-cdef-0123-456789abcdef'), '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(notionId('not an id'), null);
});

test('TestNotion_VisibilityFailsClosed', () => {
  const sel = (name: string) => ({ properties: { Visibility: { type: 'select', select: { name } } } });
  assert.deepEqual(notionAccess(sel('Party'), {}), { shared: true });
  assert.deepEqual(notionAccess(sel('Players'), {}), { shared: true });
  assert.equal(notionAccess(sel('DM'), {}).shared, false);
  assert.equal(notionAccess({ ...sel('GM only'), public_url: 'https://x.notion.site/p' }, {}).shared, false, 'the property wins over publishing');
  assert.deepEqual(notionAccess(sel('Broker'), {}), { shared: false, level: 'broker' });
  assert.equal(notionAccess({ properties: { Visibility: { type: 'multi_select', multi_select: [{ name: 'party' }, { name: 'dm' }] } } }, {}).shared, false, 'mixed: the DM\'s');
  assert.equal(notionAccess({ public_url: 'https://x.notion.site/p' }, {}).shared, true, 'published to the web');
  assert.equal(notionAccess({}, {}).shared, false);
  assert.equal(notionAccess({}, { defaultShared: true }).shared, true);
});

test('TestNotion_SecretTogglesAndCalloutsNeverReachPlayers', () => {
  const b = notionBlocks([
    P('Open text'),
    { type: 'toggle', toggle: { rich_text: rt('Secret') }, children: [P('HIDDEN1')] },
    { type: 'heading_3', heading_3: { rich_text: rt('GM notes'), is_toggleable: true }, children: [P('HIDDEN2')] },
    { type: 'callout', callout: { rich_text: rt('DM: HIDDEN3') } },
    { type: 'toggle', toggle: { rich_text: rt('Rumours') }, children: [P('Shown')] },
    { type: 'numbered_list_item', numbered_list_item: { rich_text: rt('One') } },
    { type: 'numbered_list_item', numbered_list_item: { rich_text: rt('Two') } },
    { type: 'to_do', to_do: { rich_text: rt('Done'), checked: true } },
    { type: 'table', table: { has_column_header: true }, children: [{ type: 'table_row', table_row: { cells: [rt('Name'), rt('HP')] } }, { type: 'table_row', table_row: { cells: [rt('Orc'), rt('15')] } }] },
  ]);
  const md = blocksToMarkdown(b);
  for (const w of ['Open text', 'HIDDEN1', 'HIDDEN2', 'HIDDEN3', 'Rumours', 'Orc']) assert.ok(md.includes(w), `the DM sees ${w}`);
  const pl = blocksToMarkdown(playerBlocks(b, () => false));
  for (const w of ['HIDDEN1', 'HIDDEN2', 'HIDDEN3']) assert.ok(!pl.includes(w), `a player never sees ${w}`);
  assert.ok(pl.includes('Shown') && pl.includes('Orc'));
  assert.equal(b.filter((x) => x.kind === 'orderedList').length, 1, 'neighbouring items are one list');
});

// ---- sync ---------------------------------------------------------------------------------------------------------------

test('TestNotion_SyncReadsPagesDatabasesAndKeepsDmContentBack', async () => {
  const { n } = realm();
  const { db, lib } = world({ token: TOKEN, rootPage: 'https://www.notion.so/The-Realm-' + uid(10).replace(/-/g, '') });
  const out = await runSync({ db, library: lib, dataDir: null, vaultsDir: null, fetch: n.f, env: {}, mcp: null as any }, 's', 'a');
  assert.equal(out.status, 'ok', out.error);
  const dmTitles = lib.list('w', dm).map((p: any) => p.title).sort();
  assert.deepEqual(dmTitles, ['Mira', 'People', 'Port Town', 'The Lich', 'The Realm', 'The plot'], 'only pages under the root page');
  const plTitles = lib.list('w', player).map((p: any) => p.title).sort();
  assert.deepEqual(plTitles, ['Mira', 'Port Town', 'The Realm'], 'Visibility = party or published; a DM row stays DM-only even when published');
  const town = lib.list('w', player).find((p: any) => p.title === 'Port Town') as any;
  const pl = JSON.stringify(lib.get('w', town.id, player));
  assert.ok(pl.includes('busy harbour'));
  for (const w of ['TIDETRAP', 'SMUGGLERS']) assert.ok(!pl.includes(w), `a player never sees ${w}`);
  const dmTown = JSON.stringify(lib.get('w', town.id, dm));
  assert.ok(dmTown.includes('TIDETRAP') && dmTown.includes('SMUGGLERS'), 'the DM sees the hidden parts (nested toggle children were read)');
  const mira = lib.list('w', dm).find((p: any) => p.title === 'Mira') as any;
  const miraJ = JSON.stringify(lib.get('w', mira.id, dm));
  assert.ok(miraJ.includes('innkeeper') && miraJ.includes('41'), 'database properties and tags');
  assert.ok(!n.calls.some((c) => c.includes(uid(16))), 'a page outside the root is never read');
});

test('TestNotion_BadTokenFailsTheTest', async () => {
  const { n } = realm();
  const { notionApi } = await import('../src/intake/connectors/notion.ts');
  const ctx: any = { fetch: n.f, env: {}, signal: new AbortController().signal, log: () => {} };
  assert.equal((await notionApi.test({ token: 'ntn_' + 'y'.repeat(40) }, ctx)).ok, false);
  const good = await notionApi.test({ token: TOKEN }, ctx);
  assert.equal(good.ok, true, good.message);
});

// ---- write-back ---------------------------------------------------------------------------------------------------------

test('TestNotion_MarkdownToBlocksTurnsSecretCalloutsIntoSecretToggles', () => {
  const b = mdToNotion('# Title\n\nSome **bold** text and [[@notion:' + uid(14) + '|Mira]].\n\n> [!secret]\n> HIDDEN plan\n\n- one\n- [x] done\n\n```js\nx = 1\n```');
  assert.deepEqual(b.map((x) => x.type), ['heading_1', 'paragraph', 'toggle', 'bulleted_list_item', 'to_do', 'code']);
  assert.equal(b[2].toggle.rich_text[0].text.content, 'Secret');
  assert.ok(b[1].paragraph.rich_text.some((r: any) => r.type === 'mention' && r.mention.page.id === uid(14)));
  // Read back, it is a secret.
  const back = notionBlocks([{ ...b[2], children: b[2].toggle.children.map((c: any) => ({ ...c, paragraph: { rich_text: c.paragraph.rich_text.map((r: any) => ({ ...r, plain_text: r.text.content })) } })), toggle: { rich_text: [{ plain_text: 'Secret', type: 'text' }] } }]);
  assert.equal(back[0].kind, 'secret');
});

test('TestNotion_WorldLoreWritesStayUnderTheRoot', async () => {
  const { n, ROOT, TOWN, DB, MIRA, OUT } = realm();
  const cfg = { token: TOKEN };
  const ctx: any = { fetch: n.f, env: {}, signal: new AbortController().signal, log: () => {}, shareVisible: true };
  const root = `notion:${ROOT}`;
  const made = await notionWrite.createPage(cfg, ctx, { root, title: 'The Guild', markdown: 'A guild.\n\n> [!secret]\n> GUILDSECRET', level: 'party' });
  const gid = notionId(made.externalId)!;
  assert.equal(n.objs.get(gid)?.parent.page_id, ROOT);
  assert.ok(n.blocks.get(gid)!.some((b) => b.type === 'toggle'), 'the secret went in as a Secret toggle');
  // Under a database with a Visibility property, the level is written there (raised by the secret text to dm).
  const row = await notionWrite.createPage(cfg, ctx, { root, parent: `notion:${DB}`, title: 'Spy', markdown: '> [!secret]\n> SPY', level: 'party' });
  const rid = notionId(row.externalId)!;
  assert.equal(n.objs.get(rid)?.properties.Visibility.select.name, 'dm');
  assert.ok('Name' in n.objs.get(rid)!.properties, 'the database\'s own title property is used');
  await notionWrite.updatePage(cfg, ctx, { root, id: row.externalId, markdown: 'Now harmless.', level: 'party' });
  assert.equal(n.objs.get(rid)?.properties.Visibility.select.name, 'party');
  assert.deepEqual(n.blocks.get(rid)!.map((b) => b.type), ['paragraph'], 'old blocks replaced');
  await notionWrite.deletePage(cfg, ctx, { root, id: made.externalId });
  assert.equal(n.objs.get(gid)?.archived, true, 'archived (Notion trash)');
  await assert.rejects(() => notionWrite.movePage(cfg, ctx, { root, id: `notion:${MIRA}`, to: null }), (e: any) => e instanceof WriteRefused && /cannot move/.test(e.message));
  for (const bad of [
    () => notionWrite.updatePage(cfg, ctx, { root, id: `notion:${OUT}`, markdown: 'x' }),
    () => notionWrite.deletePage(cfg, ctx, { root, id: root }),
    () => notionWrite.createPage(cfg, ctx, { root, parent: `notion:${OUT}`, title: 'x', markdown: 'x', level: 'dm' }),
    () => notionWrite.updatePage(cfg, ctx, { root: `notion:${TOWN}`, id: `notion:${MIRA}`, markdown: 'x' }),
  ]) await assert.rejects(bad, WriteRefused);
  assert.ok(!n.calls.some((c) => c.startsWith('PATCH') && c.includes(OUT)), 'nothing outside the root was changed');
  const roots = await notionWrite.roots!(cfg, ctx);
  assert.ok(roots.some((r) => r.id === root && r.title === 'The Realm'));
});
