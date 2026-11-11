// The LegendKeeper and Kanka connectors against the shapes in the official
// docs: LegendKeeper's v3 OpenAPI spec and developer guide, and Kanka's
// API docs (app.kanka.io/api-docs/1.0). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/core/library.ts';
import { openDb, run } from '../src/core/db.ts';
import { runSync } from '../src/intake/sync.ts';
import { lkBlocks, lkGroups } from '../src/intake/connectors/legendkeeper.ts';
import { kankaBlocks, kankaProperties } from '../src/intake/connectors/kanka.ts';
import { playerBlocks, playerProperties } from '../src/intake/player.ts';
import { blocksToMarkdown } from '../src/intake/model.ts';

const P = (t: string) => ({ kind: 'paragraph', content: [{ text: t }] });
const nothingHidden = () => false;
const player = { accountId: 'p', role: 'player' as const };
const dm = { accountId: 'a', role: 'dm' as const };

function world(kind: string, config: Record<string, unknown>) {
  const db = openDb(':memory:');
  run(db, `INSERT INTO worlds (id, slug, name, created_at) VALUES ('w', 'w', 'W', 'now')`);
  run(db, `INSERT INTO accounts (id, username, display_name, created_at) VALUES ('a', 'a', 'a', 'now')`);
  run(db, `INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s', 'w', ?, 'S', ?, 'party')`, kind, JSON.stringify(config));
  return { db, lib: new Library(db, null) };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

// ---------- LegendKeeper ----------

test('TestConnectorsDocs_LegendKeeperBlockKindsFromSpec', () => {
  const b = lkBlocks([
    { kind: 'layout', children: [{ kind: 'layoutColumn', width: 50, children: [P('Left')] }, { kind: 'layoutColumn', width: 50, children: [{ kind: 'secret', children: [P('col secret')] }] }] },
    { kind: 'taskList', children: [{ kind: 'taskItem', checked: true, content: [{ text: 'Done it' }] }] },
    { kind: 'callout', tone: 'warning', children: [P('Careful')] },
    { kind: 'rule' },
    { kind: 'code', text: 'x = 1', language: 'py' },
    { kind: 'quote', children: [P('Said')] },
    { kind: 'expand', title: 'More', children: [P('Inside')] },
    { kind: 'paragraph', content: [{ text: 'a' }, { break: true }, { text: 'b' }, { icon: { name: 'fas fa-heart' } }] },
    { kind: 'keyValue', title: 'Stats', rows: [{ key: 'HP', content: [], text: '12' }] },
    { kind: 'meter', mode: 'bar', title: 'Supplies', isTitleHidden: false, items: [{ name: 'Food', current: 3, max: 10 }] },
    { kind: 'resourceLink', title: 'See', isTitleHidden: false, items: [{ resourceId: 'r9' }] },
    { kind: 'textField', title: 'Notes', isTitleHidden: false, children: [P('Field text')] },
    { kind: 'embed', provider: 'youtube', url: 'https://youtube.com/watch?v=1' },
    { kind: 'map', resourceId: 'm', documentId: 'd' },
    { kind: 'unsupported', id: 'u1' },
  ]);
  assert.deepEqual(b.map((x) => x.kind), ['paragraph', 'secret', 'bulletList', 'callout', 'divider', 'codeBlock', 'blockquote', 'toggle', 'paragraph', 'infobox', 'infobox', 'heading', 'bulletList', 'heading', 'paragraph', 'paragraph', 'unsupported', 'unsupported']);
  assert.equal((b[2] as any).children[0].checked, true);
  assert.equal((b[2] as any).children[0].children[0].content[0].text, 'Done it', 'taskItem runs are kept');
  assert.equal((b[3] as any).variant, 'warning', 'callout tone is read');
  assert.equal((b[8] as any).content[1].text, '\n', 'break run becomes a line break');
  assert.equal((b[9] as any).groups[0].rows[0].value[0].text, '12', 'keyValue row text is used when content is empty');
  assert.equal((b[10] as any).groups[0].rows[0].value[0].text, '3 / 10');
  assert.deepEqual((b[12] as any).children[0].children[0].content[0], { mention: { ref: 'r9' } });
  // The secret inside a layout column stays a secret and is dropped for players.
  assert.ok(!blocksToMarkdown(playerBlocks(b, nothingHidden)).includes('col secret'));
});

test('TestConnectorsDocs_LegendKeeperHiddenPropertiesNeverReachPlayers', () => {
  const groups = lkGroups([
    { kind: 'keyValue', title: 'Facts', isHidden: false, rows: [{ key: 'Ruler', content: [{ text: 'the queen' }], text: 'the queen' }] },
    { kind: 'keyValue', title: 'Motives', isHidden: true, rows: [{ key: 'Wants', content: [{ text: 'the throne' }], text: 'the throne' }] },
    { kind: 'keyValue', title: 'No flag', rows: [{ key: 'Debt', content: [{ text: 'owes the guild' }], text: 'owes the guild' }] },
    { kind: 'textField', title: 'Bio', isHidden: false, children: [P('Born at sea.'), { kind: 'secret', children: [P('actually a kraken')] }] },
    { kind: 'resourceLink', title: 'Allies', isHidden: false, items: [{ resourceId: 'ally' }] },
    { kind: 'image', title: 'Portrait', isHidden: false, url: 'https://x/y.png' },
    { kind: 'unsupported', id: 'u', isHidden: false },
  ]);
  assert.deepEqual(groups.map((g) => [g.title, !!g.dm]), [['Facts', false], ['Motives', true], ['No flag', true], ['Bio', false], ['Allies', false]]);
  const infobox = lkBlocks([{ kind: 'infobox', rows: [{ kind: 'keyValue', title: 'Secret stats', isHidden: true, rows: [{ key: 'True name', content: [{ text: 'Vex' }] }] }, { kind: 'keyValue', title: 'Stats', isHidden: false, rows: [{ key: 'Age', content: [{ text: '40' }] }] }] }]);
  const out = JSON.stringify([playerProperties(groups, nothingHidden), playerBlocks(infobox, nothingHidden)]);
  for (const leak of ['the throne', 'owes the guild', 'kraken', 'Vex', 'Secret stats']) assert.ok(!out.includes(leak), leak);
  for (const kept of ['the queen', 'Born at sea', '40']) assert.ok(out.includes(kept), kept);
});

test('TestConnectorsDocs_LegendKeeperRestSyncPermissionsAndRetry', async () => {
  const R = [
    { id: 'root', name: 'World', parentId: null, isHidden: false, tags: [], aliases: [], documents: [{ id: 'd0', name: 'Main', type: 'page' }], hasChildren: true },
    { id: 'locked', name: 'Locked Folder', parentId: 'root', isHidden: false, tags: [], aliases: [], documents: [], hasChildren: true },
    { id: 'inlocked', name: 'Behind Lock', parentId: 'locked', isHidden: false, tags: [], aliases: [], documents: [{ id: 'd1', name: 'Main', type: 'page' }], hasChildren: false },
    { id: 'oneplayer', name: 'Not For Jess', parentId: 'root', isHidden: false, tags: [], aliases: [], documents: [{ id: 'd2', name: 'Main', type: 'page' }], hasChildren: false },
    { id: 'town', name: 'Port Town', parentId: 'root', isHidden: false, tags: [], aliases: [], documents: [{ id: 'd3', name: 'Main', type: 'page' }], hasChildren: false },
  ];
  const PERMS: Record<string, any> = { root: { ADMIN: 3, OWNER: 3 }, locked: { MEMBER: 0 }, inlocked: { MEMBER: 1 }, oneplayer: { MEMBER: 4, user_jess: 0 }, town: { MEMBER: 5 } };
  const seen: string[] = [];
  let limited = false;
  const fakeFetch = (async (url: string, init: any) => {
    assert.equal(init.headers.Authorization, 'Bearer lk_testkey_123', 'API key as a bearer token');
    const u = new URL(url);
    seen.push(u.pathname + u.search);
    const path = u.pathname.replace('/api/v3/projects/proj1', '');
    if (path === '/resources') {
      if (!limited) { limited = true; return json({ message: 'slow down', code: 'RATE_LIMITED', requestId: 'r' }, 429, { 'Retry-After': '0' }); }
      return u.searchParams.get('cursor') ? json({ data: R.slice(2), hasMore: false, nextCursor: null }) : json({ data: R.slice(0, 2), hasMore: true, nextCursor: 'opaque' });
    }
    const m = /^\/resources\/([^/]+)(?:\/docs\/([^/]+)\/blocks)?$/.exec(path);
    if (!m) return json({ message: 'no', code: 'NOT_FOUND', requestId: 'r' }, 404);
    const r = R.find((x) => x.id === m[1])!;
    if (m[2]) return json({ id: m[2], version: '1', schema: 1, text: '', blocks: [P(`Body of ${r.name}`)] });
    return json({
      ...r, rank: 'a', permissions: PERMS[r.id], ancestors: [],
      documents: r.documents.map((d) => ({ ...d, rank: 'a', isHidden: false })),
      properties: r.id === 'town' ? [
        { kind: 'keyValue', id: 'p1', title: 'Facts', isHidden: false, rows: [{ id: 'x', rank: 'a', key: 'Harbour', content: [{ text: 'deep' }], text: 'deep' }] },
        { kind: 'keyValue', id: 'p2', title: 'Smuggling', isHidden: true, rows: [{ id: 'y', rank: 'a', key: 'Boss', content: [{ text: 'Old Mags' }], text: 'Old Mags' }] },
      ] : [],
    });
  }) as typeof fetch;
  const { db, lib } = world('legendkeeper-api', { apiUrl: 'https://www.legendkeeper.com/api/v3/projects/proj1', apiKey: 'lk_testkey_123' });
  const out = await runSync({ db, library: lib, dataDir: null, vaultsDir: null, fetch: fakeFetch, env: {}, mcp: null as any }, 's', 'a');
  assert.equal(out.status, 'ok', out.error);
  assert.ok(seen.includes('/api/v3/projects/proj1/resources?limit=100&cursor=opaque'), 'cursor paging');
  assert.ok(limited, '429 was retried after Retry-After');
  assert.deepEqual(lib.list('w', player).map((p: any) => p.title).sort(), ['Port Town', 'World'], 'No Access on an ancestor or for one player keeps a page DM-only');
  assert.equal(lib.list('w', dm).length, 4);
  const town = lib.list('w', player).find((p: any) => p.title === 'Port Town') as any;
  const pg = JSON.stringify(lib.get('w', town.id, player));
  assert.ok(pg.includes('deep') && !pg.includes('Old Mags') && !pg.includes('Smuggling'), 'hidden sidebar property stays DM-only');
  assert.ok(JSON.stringify(lib.get('w', town.id, dm)).includes('Old Mags'), 'the DM still sees it');
});

// ---------- Kanka ----------

test('TestConnectorsDocs_KankaMentionFormats', () => {
  const titles: Record<string, string> = { 'kanka:76': 'Baldur', 'kanka:5': 'Waterdeep', 'kanka:9': 'Mira' };
  const md = (raw: string) => blocksToMarkdown(kankaBlocks(raw), (m) => titles[m.ref ?? ''] ?? null);
  assert.equal(md('Before [character:76] and [location:5|the city].'), 'Before [[Baldur]] and [[Waterdeep|the city]].');
  assert.equal(md('Ask [entity:9|field:title].'), 'Ask [[Mira]].', 'key:value options are not labels');
  assert.equal(md('<p>See <a href="https://app.kanka.io/w/1/entities/76" class="entity-mention" data-entity-type="character" data-id="76">Baldur Gates</a></p>'), 'See [[Baldur|Baldur Gates]]');
  assert.equal(md('<p>Meet <a class="entity-mention" data-id="9">Mira</a></p>'), 'Meet [[Mira]]');
  assert.equal(md('[character:404]'), '(hidden)', 'unknown targets are hidden');
});

test('TestConnectorsDocs_KankaAttributesTraitsAndPrivateLinks', () => {
  const lookup = (mod: string, id: unknown) => ({ 'races:3': '30', 'races:2': '20', 'families:34': '340' } as Record<string, string>)[`${mod}:${id}`];
  const base = { type: 'NPC', title: 'Captain', races: [3], private_races: [2], families: [34], is_personality_visible: false,
    traits: [{ name: 'Hair', entry: 'Red', section: 'appearance', is_private: false }, { name: 'Fear', entry: 'Drowning', section: 'personality', is_private: false }],
    attributes: [{ name: 'STR', value: '14', type_id: 1, is_private: false }, { name: 'Bounty', value: '500gp', type_id: 1, is_private: true }, { name: 'Section', type_id: 4, is_private: false }] };
  const shared = kankaProperties({ ...base, is_attributes_private: false }, 'character', lookup);
  const pp = JSON.stringify(playerProperties(shared, () => false));
  for (const kept of ['Captain', 'kanka:30', 'kanka:340', 'Red', 'STR']) assert.ok(pp.includes(kept), kept);
  for (const leak of ['kanka:20', 'Drowning', '500gp', 'Section']) assert.ok(!pp.includes(leak), leak);
  // is_attributes_private (or no flag at all) makes every attribute DM-only.
  for (const flag of [true, undefined]) {
    const props = kankaProperties({ ...base, is_attributes_private: flag }, 'character', lookup);
    assert.ok(!JSON.stringify(playerProperties(props, () => false)).includes('14'), `is_attributes_private=${flag}`);
    assert.ok(JSON.stringify(props).includes('14'), 'kept for the DM');
  }
});

test('TestConnectorsDocs_KankaApiSyncFollowsDocs', async () => {
  const CHAR = [
    { id: 1, entity_id: 101, name: 'Mira', entry: '<p>Lives in [location:201].</p>', is_private: false, is_attributes_private: true, tags: [7, 8], races: [], families: [],
      attributes: [{ name: 'Gold', value: '12', type_id: 1, is_private: false }],
      posts: [
        { id: 1, name: 'Public', entry: 'Known to all.', visibility_id: 1, permissions: [] },
        { id: 2, name: 'Members', entry: 'Members know.', visibility_id: 5, permissions: [{ role_id: 3, permission: 0 }] },
        { id: 3, name: 'Admin', entry: 'Admin only.', visibility_id: 2 },
        { id: 4, name: 'SelfAdmin', entry: 'Self admin.', visibility_id: 3 },
        { id: 5, name: 'Self', entry: 'Just me.', visibility_id: 4 },
        { id: 6, name: 'Future', entry: 'New value.', visibility_id: 9 },
        { id: 7, name: 'NoVis', entry: 'No visibility.' },
        { id: 8, name: 'Denied', entry: 'Denied to a role.', visibility_id: 1, permissions: [{ role_id: 2, permission: 2 }] },
      ] },
    { id: 2, entity_id: 102, name: 'Template Guy', entry: 'tpl', is_private: false, is_template: true, tags: [] },
  ];
  const LOC_P1 = [{ id: 1, entity_id: 200, name: 'Coast', entry: 'Sea.', is_private: false, tags: [] }];
  const LOC_P2 = [{ id: 2, entity_id: 201, name: 'Harbour', entry: 'Docks.', is_private: false, parent_id: 200, tags: [] }];
  const TAGS = [{ id: 7, entity_id: 700, name: 'Sailor', is_private: false, is_hidden: false, tags: [] }, { id: 8, entity_id: 800, name: 'Traitor', is_private: true, is_hidden: false, tags: [] }];
  const urls: string[] = [];
  let limited = false;
  const fakeFetch = (async (url: string, init: any) => {
    assert.equal(init.headers.Authorization, 'Bearer ' + 'k'.repeat(24));
    assert.equal(init.headers.Accept, 'application/json');
    urls.push(url);
    const u = new URL(url);
    assert.equal(u.origin, 'https://api.kanka.io', 'never leaves the API host');
    const mod = u.pathname.split('/').pop();
    const page = Number(u.searchParams.get('page'));
    const listing = (data: any[], last: number) => json({ data, links: { next: page < last ? 'https://evil.example/next' : null }, meta: { current_page: page, last_page: last, per_page: 45 } });
    if (mod === 'characters') {
      if (!limited) { limited = true; return json({ message: 'Too Many Attempts.' }, 429, { 'Retry-After': '0' }); }
      return listing(CHAR, 1);
    }
    if (mod === 'locations') return listing(page === 1 ? LOC_P1 : LOC_P2, 2);
    if (mod === 'tags') return listing(TAGS, 1);
    return listing([], 1);
  }) as typeof fetch;
  const { db, lib } = world('kanka-api', { campaignId: '42', token: 'k'.repeat(24) });
  const out = await runSync({ db, library: lib, dataDir: null, vaultsDir: null, fetch: fakeFetch, env: {}, mcp: null as any }, 's', 'a');
  assert.equal(out.status, 'ok', out.error);
  assert.ok(limited, '429 retried');
  assert.ok(urls.includes('https://api.kanka.io/1.0/campaigns/42/locations?related=1&page=2'), 'page 2 keeps related=1');
  assert.ok(!urls.some((u) => u.includes('evil')), 'links.next is not followed off-host');
  const titles = lib.list('w', player).map((p: any) => p.title).sort();
  assert.ok(titles.includes('Mira') && titles.includes('Harbour') && !titles.includes('Template Guy'), 'templates are skipped');
  const harbour = lib.list('w', dm).find((p: any) => p.title === 'Harbour') as any;
  const coast = lib.list('w', dm).find((p: any) => p.title === 'Coast') as any;
  assert.equal(harbour.parent_id ?? harbour.parentId, coast.id, 'parent_id is the parent entity id');
  const mira = lib.list('w', player).find((p: any) => p.title === 'Mira') as any;
  const pg = lib.get('w', mira.id, player) as any;
  const all = JSON.stringify(pg);
  for (const kept of ['Known to all', 'Members know', '[[Harbour]]']) assert.ok(all.includes(kept), kept);
  for (const leak of ['Admin only', 'Self admin', 'Just me', 'New value', 'No visibility', 'Denied to a role', 'Traitor', 'Gold']) assert.ok(!all.includes(leak), leak);
  assert.deepEqual(pg.tags, ['Sailor'], 'private tag names are not shown');
  const dmAll = JSON.stringify(lib.get('w', mira.id, dm));
  assert.ok(dmAll.includes('Admin only') && dmAll.includes('Gold'), 'the DM sees posts and attributes');
});
