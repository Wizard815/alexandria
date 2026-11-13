// Intake capabilities, the records sources give besides pages (relations,
// timelines, calendars, map markers) and the push API. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { Library } from '../src/core/library.ts';
import { all, openDb, run } from '../src/core/db.ts';
import { runSync } from '../src/intake/sync.ts';
import { CONNECTORS } from '../src/intake/registry.ts';
import { CAPABILITIES } from '../src/intake/connector.ts';
import { calendarsFor, markersFor, timelinesFor } from '../src/intake/records.ts';
import { kankaCalendar, kankaDate } from '../src/intake/connectors/kanka.ts';
import { playerBlocks } from '../src/intake/player.ts';

const player = { accountId: 'p', role: 'player' as const };
const dm = { accountId: 'a', role: 'dm' as const };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function world(kind: string, config: Record<string, unknown>) {
  const db = openDb(':memory:');
  run(db, `INSERT INTO worlds (id, slug, name, created_at) VALUES ('w', 'w', 'W', 'now')`);
  run(db, `INSERT INTO accounts (id, username, display_name, created_at) VALUES ('a', 'a', 'a', 'now')`);
  run(db, `INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s', 'w', ?, 'S', ?, 'party')`, kind, JSON.stringify(config));
  return { db, lib: new Library(db, null) };
}
const sync = (db: any, lib: Library, fetchImpl: typeof fetch) => runSync({ db, library: lib, dataDir: null, vaultsDir: null, fetch: fetchImpl, env: {}, mcp: null as any }, 's', 'a');

// ---------- Kanka ----------

const ent = (id: number, name: string, extra: Record<string, unknown> = {}) => ({ id, entity_id: id + 1000, name, entry: `About ${name}.`, is_private: false, tags: [], ...extra });

function kankaFake() {
  const CHARS = [ent(1, 'Mira'), ent(2, 'Odo'), ent(3, 'Velmira Secret', { is_private: true })];
  const MAPS = [ent(5, 'Coast Map'), ent(6, 'Vault Map', { is_private: true })];
  const CALS = [ent(7, 'Harptos', { date: '1492-3-14', suffix: 'DR', skip_year_zero: true,
    months: [{ name: 'Hammer', length: 30, type: 'standard' }, { name: 'Midwinter', length: 1, type: 'intercalary' }], weekdays: ['Sul', 'Mol'],
    moons: [{ name: 'Selune', fullmoon: '30', offset: 4, colour: 'white' }], seasons: [{ name: 'Winter', month: 1, day: 1 }] })];
  const TLS = [
    ent(8, 'Ages', { eras: [{ id: 26, name: 'Anno Domani', abbreviation: 'AD', position: 1, entry: '<p>The age of rivers.</p>', elements: [
      { id: 41, name: 'Kemali Uprising', entry: '<p>An uprising begins.</p>', date: '3rd of Appen 114', visibility_id: 1, position: 1, entity_id: 1001 },
      { id: 42, name: 'The Secret Coup', entry: '<p>Velmira did it.</p>', date: '4th of Appen 114', visibility_id: 2, position: 2 },
      { id: 43, name: 'Quiet Pact', entry: '<p>Signed in hiding.</p>', date: '9th', visibility_id: 1, position: 3, entity_id: 1003 },
    ] }] }),
    ent(9, 'Vault Ages', { is_private: true, eras: [{ id: 27, name: 'Hidden Era', position: 1, elements: [{ id: 44, name: 'Never Told', entry: '<p>Nobody knows.</p>', visibility_id: 1 }] }] }),
  ];
  const RELS = [
    { id: 1, owner_id: 1001, target_id: 1002, relation: 'Friends', attitude: 40, visibility_id: 1 },
    { id: 2, owner_id: 1001, target_id: 1002, relation: 'Rival of', attitude: -20, visibility_id: 2 },
    { id: 3, owner_id: 1001, target_id: 1003, relation: 'Spies for', attitude: 0, visibility_id: 1 },
    { id: 4, owner_id: 1002, target_id: 1001, relation: 'Owes a debt', attitude: -5, visibility_id: 1, is_private: true },
    { id: 5, owner_id: 1002, target_id: 1001, relation: 'Cousins', attitude: 10, visibility_id: 5 },
  ];
  const MARKERS: Record<string, any[]> = {
    5: [
      { id: 1, name: 'Lighthouse', latitude: '10.5', longitude: '20', shape_id: 1, colour: '#ff0000', is_private: false, visibility_id: 1 },
      { id: 2, name: 'Admin Cache', latitude: '1', longitude: '2', shape_id: 1, is_private: false, visibility_id: 2 },
      { id: 3, name: 'Velmira Hideout', latitude: '3', longitude: '4', shape_id: 1, entity_id: 1003, is_private: false, visibility_id: 1 },
      { id: 4, name: 'Private Flag', latitude: '5', longitude: '6', shape_id: 1, is_private: true, visibility_id: 1 },
    ],
    6: [{ id: 5, name: 'Vault Door', latitude: '7', longitude: '8', shape_id: 1, is_private: false, visibility_id: 1 }],
  };
  const listing = (data: any[]) => json({ data, links: { next: null }, meta: { current_page: 1, last_page: 1 } });
  const urls: string[] = [];
  const fake = (async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    const parts = u.pathname.split('/');
    const mod = parts.pop()!;
    if (mod === 'characters') return listing(CHARS);
    if (mod === 'maps') return listing(MAPS);
    if (mod === 'calendars') return listing(CALS);
    if (mod === 'timelines') return listing(TLS);
    if (mod === 'relations') return listing(RELS);
    if (mod === 'map_markers') return listing(MARKERS[parts[parts.length - 1]] ?? []);
    return listing([]);
  }) as typeof fetch;
  return { fake, urls };
}

test('TestIntakeRecords_KankaRelationsWithPrivateOnesHiddenFromPlayers', async () => {
  const { db, lib } = world('kanka-api', { campaignId: '42', token: 'k'.repeat(24) });
  const { fake, urls } = kankaFake();
  const out = await sync(db, lib, fake);
  assert.equal(out.status, 'ok', out.error);
  assert.ok(urls.includes('https://api.kanka.io/1.0/campaigns/42/relations?page=1'));
  assert.equal(out.stats.records > 0, true);
  const mine = lib.relations('w', dm) as any[];
  assert.deepEqual(mine.map((r) => `${r.from_title}|${r.kind}|${r.to_title}|${r.visibility}`).sort(), [
    'Mira|Friends|Odo|party', 'Mira|Rival of|Odo|dm', 'Mira|Spies for|Velmira Secret|dm', 'Odo|Cousins|Mira|party', 'Odo|Owes a debt|Mira|dm',
  ].sort(), 'the DM sees every imported relation, with who may see it');
  assert.equal(mine.find((r) => r.kind === 'Friends').attitude, 40);
  const seen = lib.relations('w', player) as any[];
  assert.deepEqual(seen.map((r) => r.kind).sort(), ['Cousins', 'Friends'], 'players get only shared relations between shared pages');
  const text = JSON.stringify(seen);
  for (const leak of ['Rival', 'Spies', 'Velmira', 'debt']) assert.ok(!text.includes(leak), leak);
});

test('TestIntakeRecords_KankaCalendarsLandInTheTableWithTheExactShape', async () => {
  const { db, lib } = world('kanka-api', { campaignId: '42', token: 'k'.repeat(24) });
  const out = await sync(db, lib, kankaFake().fake);
  assert.equal(out.status, 'ok', out.error);
  // The table is shared by contract with the clock: columns, order, key.
  const cols = all<any>(db, 'PRAGMA table_info(intake_calendars)').map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`);
  assert.deepEqual(cols, ['world_id:TEXT:1:1', 'source_id:TEXT:1:2', 'external_id:TEXT:1:3', 'name:TEXT:1:0', 'definition:TEXT:1:0', 'visibility:TEXT:1:0', 'current:TEXT:0:0']);
  const row = all<any>(db, 'SELECT * FROM intake_calendars')[0];
  assert.equal(row.world_id, 'w');
  assert.equal(row.source_id, 's');
  assert.equal(row.external_id, 'kanka:1007');
  assert.equal(row.name, 'Harptos');
  assert.equal(row.visibility, 'party');
  assert.deepEqual(JSON.parse(row.current), { year: 1492, month: 3, day: 14 });
  assert.deepEqual(JSON.parse(row.definition), {
    name: 'Harptos', epochYear: 1, yearSuffix: 'DR',
    months: [{ name: 'Hammer', days: 30 }, { name: 'Midwinter', days: 1, intercalary: true }],
    weekdays: ['Sul', 'Mol'],
    moons: [{ name: 'Selune', cycleDays: 30, offsetDays: 4 }],
    seasons: [{ name: 'Winter', month: 1, day: 1 }],
  });
  assert.deepEqual(kankaDate('bad'), null);
  assert.equal(kankaCalendar({ name: 'X', months: [], weekdays: [] }).months.length, 0, 'the raw mapper keeps what the source has; storing fills safe defaults');
  assert.equal(calendarsFor(db, 'w', player).length, 1, 'a shared calendar is visible to players');
});

test('TestIntakeRecords_KankaTimelinesAndMarkersNeverLeakPrivateOnes', async () => {
  const { db, lib } = world('kanka-api', { campaignId: '42', token: 'k'.repeat(24) });
  const out = await sync(db, lib, kankaFake().fake);
  assert.equal(out.status, 'ok', out.error);
  // Timelines: a private timeline and a non-shared element stay DM-only.
  const dmTl = timelinesFor(db, 'w', dm);
  assert.equal(dmTl.length, 2);
  const pTl = timelinesFor(db, 'w', player);
  assert.deepEqual(pTl.map((t: any) => t.name), ['Ages']);
  const names = pTl[0].groups[0].events.map((e: any) => e.name);
  assert.deepEqual(names, ['Kemali Uprising', 'Quiet Pact'], 'the admin-only element is dropped');
  const pj = JSON.stringify(pTl);
  for (const leak of ['Secret Coup', 'Velmira did it', 'Never Told', 'Hidden Era', 'Vault Ages']) assert.ok(!pj.includes(leak), leak);
  assert.ok(pj.includes('An uprising begins') && pj.includes('The age of rivers'));
  const quiet = pTl[0].groups[0].events.find((e: any) => e.name === 'Quiet Pact');
  assert.equal(quiet.page, null, 'an event linked to a private entity shows no link, and its page name is not given');
  assert.ok(JSON.stringify(dmTl).includes('Secret Coup'), 'the DM sees all');
  // Markers.
  const dmM = markersFor(db, 'w', dm);
  assert.equal(dmM.length, 5);
  const pM = markersFor(db, 'w', player);
  assert.deepEqual(pM.map((m: any) => m.name), ['Lighthouse'], 'admin-only, private, private-entity and private-map markers are hidden');
  assert.deepEqual([pM[0].latitude, pM[0].longitude, pM[0].shape, pM[0].map.title], [10.5, 20, 'marker', 'Coast Map']);
  const mj = JSON.stringify(pM);
  for (const leak of ['Admin Cache', 'Velmira', 'Private Flag', 'Vault Door', 'Vault Map']) assert.ok(!mj.includes(leak), leak);
  // A second sync that can't read relations keeps the stored ones.
  const broken = (async (url: string) => (String(url).includes('/relations') ? json({ message: 'no' }, 500) : kankaFake().fake(url))) as unknown as typeof fetch;
  const again = await sync(db, lib, broken);
  assert.equal(again.status, 'ok', again.error);
  assert.equal((lib.relations('w', dm) as any[]).length, 5, 'an unreadable listing never removes what was stored');
});

// ---------- LegendKeeper ----------

test('TestIntakeRecords_LegendKeeperCalendarsTimelinesAndMaps', async () => {
  const R = [
    { id: 'atlas', name: 'Atlas', parentId: null, isHidden: false, tags: [], aliases: [], documents: [{ id: 'dmap', name: 'Main', type: 'map' }, { id: 'dtl', name: 'History', type: 'time' }] },
    { id: 'town', name: 'Port Town', parentId: null, isHidden: false, tags: [], aliases: [], documents: [{ id: 'd3', name: 'Main', type: 'page' }] },
    { id: 'plot', name: 'Secret Plot', parentId: null, isHidden: true, tags: [], aliases: [], documents: [{ id: 'd4', name: 'Main', type: 'page' }] },
  ];
  const CAL = { id: 'cal1', name: 'Old Reckoning', hasZeroYear: false, hoursInDay: 20, minutesInHour: 60, weekdays: [{ id: 'a', name: 'First' }, { id: 'b', name: 'Second' }],
    months: [{ id: 'm1', name: 'Thaw', length: 28, isIntercalary: false }, { id: 'm2', name: 'Feast', length: 3, isIntercalary: true }],
    moons: [{ id: 'mo', name: 'Pale', phase: 28 * 1200, shift: 1200 }], positiveEras: [{ id: 'e', name: 'Era', abbr: 'OR', startsAt: 0, resetMode: 'none' }], version: '1' };
  const FEATURES = [
    { id: 'f1', name: 'Harbour', type: 'pin', pos: [-10, 20], uri: 'lk://resources/town', isHidden: false },
    { id: 'f2', name: 'Hidden Lair', type: 'pin', pos: [-30, 40], isHidden: true },
    { id: 'f3', name: 'Plot Site', type: 'pin', pos: [-50, 60], uri: 'lk://resources/plot', isHidden: false },
    { id: 'f4', name: 'Open Camp', type: 'pin', pos: [-70, 80], isHidden: false },
  ];
  const fake = (async (url: string) => {
    const u = new URL(url);
    const path = u.pathname.replace('/api/v3/projects/proj1', '');
    if (path === '/resources') return json({ data: R, hasMore: false });
    if (path === '/calendars') return json({ data: [CAL], hasMore: false });
    let m = /^\/resources\/([^/]+)$/.exec(path);
    if (m) {
      const r = R.find((x) => x.id === m![1])!;
      return json({ ...r, permissions: {}, ancestors: [], properties: [], documents: r.documents.map((d) => ({ ...d, isHidden: false, ...(d.type === 'map' ? { mapImage: { url: 'https://cdn.example/map.png', width: 800, height: 600 } } : {}) })) });
    }
    m = /^\/resources\/([^/]+)\/docs\/([^/]+)\/(blocks|features|lanes|events)$/.exec(path);
    if (m) {
      if (m[3] === 'blocks') return json({ blocks: [{ kind: 'paragraph', content: [{ text: `Body of ${m[1]}` }] }] });
      if (m[3] === 'features') return json({ data: FEATURES });
      if (m[3] === 'lanes') return json({ data: [{ id: 'l1', name: 'Wars', rank: 'a', size: 'sm' }] });
      return json({ data: [
        { id: 'ev1', laneId: 'l1', type: 'event', start: 10, formattedStart: '1 Thaw 10', name: 'Siege', isHidden: false, uri: 'lk://resources/town' },
        { id: 'ev2', laneId: 'l1', type: 'event', start: 20, formattedStart: '2 Thaw 20', name: 'Betrayal', isHidden: true },
      ] });
    }
    return json({ message: 'no' }, 404);
  }) as typeof fetch;
  const { db, lib } = world('legendkeeper-api', { apiUrl: 'https://www.legendkeeper.com/api/v3/projects/proj1', apiKey: 'lk_testkey_123' });
  const out = await sync(db, lib, fake);
  assert.equal(out.status, 'ok', out.error);
  // Calendar: definition in the shared shape. LegendKeeper has no hidden flag for calendars, so DM-only.
  const cal = all<any>(db, 'SELECT * FROM intake_calendars')[0];
  assert.equal(cal.visibility, 'dm');
  assert.equal(cal.current, null);
  assert.deepEqual(JSON.parse(cal.definition), {
    name: 'Old Reckoning', epochYear: 1, yearSuffix: 'OR', months: [{ name: 'Thaw', days: 28 }, { name: 'Feast', days: 3, intercalary: true }],
    weekdays: ['First', 'Second'], moons: [{ name: 'Pale', cycleDays: 28, offsetDays: 1 }],
  });
  assert.equal(calendarsFor(db, 'w', player).length, 0);
  // Map as a page with its own block kind; hidden pins and pins for hidden pages never reach players.
  const atlasP = lib.list('w', player).find((p: any) => p.title === 'Atlas') as any;
  const mapPage = lib.get('w', atlasP.id, player) as any;
  const mapBlock = mapPage.blocks.find((b: any) => b.kind === 'map');
  assert.deepEqual(mapBlock.pins.map((p: any) => p.name).sort(), ['Harbour', 'Open Camp']);
  assert.equal(mapBlock.image, 'https://cdn.example/map.png');
  const pj = JSON.stringify(mapPage);
  for (const leak of ['Hidden Lair', 'Plot Site', 'Secret Plot']) assert.ok(!pj.includes(leak), leak);
  const dmMap = lib.get('w', atlasP.id, dm) as any;
  assert.equal(dmMap.blocks.find((b: any) => b.kind === 'map').pins.length, 4);
  // Timeline: events carry their own hidden flag.
  const tl = timelinesFor(db, 'w', player);
  assert.equal(tl.length, 1);
  assert.deepEqual(tl[0].groups[0].events.map((e: any) => e.name), ['Siege']);
  assert.ok(!JSON.stringify(tl).includes('Betrayal'));
  assert.equal(timelinesFor(db, 'w', dm)[0].groups[0].events.length, 2);
});

test('TestIntakeRecords_MapBlockFailsClosedInThePlayerGuard', () => {
  const b = playerBlocks([{ kind: 'map', title: 'M', image: 'javascript:alert(1)', pins: [{ name: 'A', lat: 1, lng: 2 }, { name: 'B', lat: 1, lng: 2, dm: true }, { name: 'C', lat: 1, lng: 2, ref: 'x' }, null as any] }], (m) => m.ref === 'x');
  assert.deepEqual(b, [{ kind: 'map', title: 'M', pins: [{ name: 'A', lat: 1, lng: 2 }] }]);
});

// ---------- Capabilities and push (HTTP) ----------

async function boot(env: Record<string, string> = {}, fetchImpl?: typeof fetch) {
  const made = createApp({ env: { ALX_ADMIN_TABLE_LOGIN: '1', ...env }, noScheduler: true, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = text;
    try { b = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, body: b, headers: r.headers };
  };
  const ok = async (...a: Parameters<typeof call>) => {
    const r = await call(...a);
    assert.ok(r.status < 300, `${a[0]} ${a[1]} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const admin = (await ok('POST', '/api/setup', null, { username: 'wizard', password: 'correct horse battery' })).token as string;
  const dmAcc = await ok('POST', '/api/admin/accounts', admin, { username: 'dungeon', password: 'dm password 123' });
  const dmTok = (await ok('POST', '/api/auth/login', null, { username: 'dungeon', password: 'dm password 123' })).token as string;
  const W = (await ok('POST', '/api/admin/worlds', admin, { name: 'Pushland', dmAccountId: dmAcc.account.id })).id as string;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, dmTok, { role: 'player' });
  const pl = await ok('POST', '/api/join', null, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'jess' });
  return { server, call, ok, admin, dm: dmTok, player: pl.token as string, W, done: () => server.close() };
}

test('TestIntakeCapabilities_ConnectorsDeclareThemAndWorldsUnionThem', async () => {
  for (const c of CONNECTORS) assert.ok(c.capabilities.length && c.capabilities.every((x) => (CAPABILITIES as readonly string[]).includes(x)), c.id);
  const t = await boot();
  try {
    const list = await t.ok('GET', '/api/admin/connectors', t.admin);
    const by = Object.fromEntries(list.map((c: any) => [c.id, c]));
    assert.ok(by['kanka-api'].capabilities.includes('relations') && by['kanka-api'].capabilities.includes('calendars'));
    assert.ok(by['legendkeeper-api'].capabilities.includes('timelines') && !by['legendkeeper-api'].capabilities.includes('relations'), 'LegendKeeper has no relations');
    assert.equal(by.push.push, true);
    // No sources: nothing.
    assert.deepEqual((await t.ok('GET', `/api/worlds/${t.W}/intake/capabilities`, t.player)).capabilities, []);
    await t.ok('POST', `/api/admin/worlds/${t.W}/sources`, t.admin, { kind: 'push', name: 'Tool', config: {} });
    assert.deepEqual((await t.ok('GET', `/api/worlds/${t.W}/intake/capabilities`, t.player)).capabilities, ['pages', 'properties', 'tags', 'images']);
    await t.ok('POST', `/api/admin/worlds/${t.W}/sources`, t.admin, { kind: 'kanka-api', name: 'K', config: { campaignId: '1', token: 'k'.repeat(24) } });
    const dmView = await t.ok('GET', `/api/worlds/${t.W}/intake/capabilities`, t.dm);
    assert.deepEqual(dmView.capabilities, ['pages', 'properties', 'tags', 'images', 'relations', 'timelines', 'maps', 'calendars', 'items', 'characters'], 'the union, in a fixed order');
    assert.equal(dmView.sources.length, 2);
    const pView = await t.ok('GET', `/api/worlds/${t.W}/intake/capabilities`, t.player);
    assert.equal(pView.sources, undefined, 'source names are for the DM');
  } finally { t.done(); }
});

test('TestIntakePush_SecretNeverReachesThePlayerCopyAndKeysStayInTheirLane', async () => {
  const t = await boot();
  try {
    const mk = async (name: string, share: boolean) => (await t.ok('POST', `/api/admin/worlds/${t.W}/sources`, t.admin, { kind: 'push', name, config: {}, defaultVisibility: share ? 'party' : 'dm' })).id as string;
    const A = await mk('Tool A', true);
    const B = await mk('Tool B', true);
    const dmOnly = await mk('Tool C', false);
    // Players can't make keys; the DM and admin can. The key is shown once.
    assert.equal((await t.call('POST', `/api/worlds/${t.W}/intake/sources/${A}/keys`, t.player, { label: 'x' })).status, 403);
    const made = await t.ok('POST', `/api/worlds/${t.W}/intake/sources/${A}/keys`, t.dm, { label: 'my tool' });
    assert.match(made.key, /^alx_push_/);
    const listed = await t.ok('GET', `/api/worlds/${t.W}/intake/sources/${A}/keys`, t.dm);
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes(made.key), 'only a prefix is ever shown again');
    const adminKey = await t.ok('POST', `/api/admin/intake/sources/${B}/keys`, t.admin, { label: 'b' });
    const cKey = await t.ok('POST', `/api/admin/intake/sources/${dmOnly}/keys`, t.admin, { label: 'c' });
    const url = (s: string, rest = 'entries') => `/api/intake/${s}/${rest}`;

    const entries = [
      { externalId: 'npc-1', title: 'Captain Odda', type: 'character', visibility: 'party', tags: ['npc'],
        properties: [{ title: 'Facts', rows: [{ key: 'Age', value: [{ text: '40' }] }] }, { title: 'Secret', rows: [{ key: 'Lover', value: [{ text: 'Brother Tamsin' }] }] }],
        blocks: [
          { kind: 'paragraph', content: [{ text: 'A harbour captain.' }] },
          { kind: 'secret', children: [{ kind: 'paragraph', content: [{ text: 'She smuggles for Velmira.' }] }] },
          { kind: 'callout', variant: 'gm', children: [{ kind: 'paragraph', content: [{ text: 'GM callout twist' }] }] },
          { kind: 'futureWidget', payload: 'widget secret' },
        ] },
      { externalId: 'npc-2', title: 'Private Pete', visibility: 'dm', blocks: [{ kind: 'paragraph', content: [{ text: 'Only the DM.' }] }] },
      { externalId: 'md-1', title: 'Markdown Page', visibility: 'party', markdown: '# Hi\n\nOpen text.\n\n> [!secret] DM\n> md twist\n' },
    ];
    const res = await t.ok('POST', url(A), made.key, { entries });
    assert.deepEqual([res.saved, res.shared, res.errors], [3, 2, []]);

    const pages = await t.ok('GET', `/api/worlds/${t.W}/library/pages`, t.player);
    assert.deepEqual(pages.map((p: any) => p.title).sort(), ['Captain Odda', 'Markdown Page'], 'a DM-only entry is not listed');
    const odda = pages.find((p: any) => p.title === 'Captain Odda');
    const page = await t.ok('GET', `/api/worlds/${t.W}/library/pages/${odda.id}`, t.player);
    const all = JSON.stringify(page);
    assert.ok(all.includes('A harbour captain') && all.includes('Age'));
    for (const leak of ['Velmira', 'twist', 'widget secret', 'futureWidget', 'Tamsin', 'Lover']) assert.ok(!all.includes(leak), `player copy leaked ${leak}`);
    const md = pages.find((p: any) => p.title === 'Markdown Page');
    assert.ok(!JSON.stringify(await t.ok('GET', `/api/worlds/${t.W}/library/pages/${md.id}`, t.player)).includes('md twist'));
    const found = await t.ok('GET', `/api/worlds/${t.W}/library/search?q=Velmira`, t.player);
    assert.equal(found.length, 0, 'search finds nothing of the secret');
    assert.ok(JSON.stringify(await t.ok('GET', `/api/worlds/${t.W}/library/pages/${odda.id}`, t.dm)).includes('Velmira'), 'the DM still sees it');

    // A source that does not share: "party" is ignored (fail closed).
    const r2 = await t.ok('POST', url(dmOnly), cKey.key, { entries: [{ externalId: 'x', title: 'Asked To Share', visibility: 'party', blocks: [] }] });
    assert.equal(r2.shared, 0);
    assert.ok(!(await t.ok('GET', `/api/worlds/${t.W}/library/pages`, t.player)).some((p: any) => p.title === 'Asked To Share'));

    // The key writes only to its own source.
    const other = await t.call('POST', url(B), made.key, { entries: [{ externalId: 'z', title: 'Z', blocks: [] }] });
    assert.equal(other.status, 403);
    assert.equal((await t.call('DELETE', url(B, 'entries/npc-1'), made.key)).status, 403);
    assert.equal((await t.call('POST', url(B, 'sync'), made.key)).status, 403);
    // ...and reads nothing, and is no account token anywhere else.
    for (const [m, p] of [['GET', `/api/worlds/${t.W}/library/pages`], ['GET', `/api/worlds/${t.W}/library/relations`], ['GET', '/api/admin/connectors'], ['GET', `/api/worlds/${t.W}/intake/capabilities`], ['GET', `/api/worlds/${t.W}/intake/calendars`], ['GET', url(A)], ['POST', '/mcp']] as const) {
      const r = await t.call(m, p, made.key, m === 'POST' ? {} : undefined);
      assert.ok(r.status === 401 || r.status === 404 || r.status === 405, `${m} ${p} -> ${r.status}`);
    }
    // Bad input.
    assert.equal((await t.call('POST', url(A), null, { entries })).status, 401);
    assert.equal((await t.call('POST', url(A), 'alx_push_nonsense_nonsense', { entries })).status, 401);
    assert.equal((await t.call('POST', url(A), made.key, { entries: 'no' })).status, 400);
    const badEntry = await t.call('POST', url(A), made.key, { entries: [{ externalId: 'e', title: 'T', blocks: [{ kind: 'paragraph', content: 'not a list' }] }, { title: 'No id', blocks: [] }] });
    assert.equal(badEntry.status, 400);
    assert.equal(badEntry.body.errors.length, 2);
    const mixed = await t.call('POST', url(A), made.key, { entries: [{ externalId: 'ok1', title: 'Fine', blocks: [] }, { externalId: 'e', title: 'T', blocks: 5 }] });
    assert.equal(mixed.status, 200);
    assert.deepEqual([mixed.body.saved, mixed.body.errors.length], [1, 1]);
    assert.equal((await t.call('POST', url(A), made.key, { entries: Array.from({ length: 101 }, (_, i) => ({ externalId: `n${i}`, title: 'n', blocks: [] })) })).status, 413);
    assert.equal((await t.call('POST', url(A), made.key, { entries: [{ externalId: 'big', title: 'Big', blocks: [{ kind: 'paragraph', content: [{ text: 'x'.repeat(450_000) }] }] }] })).status, 400);

    // Delete an entry; a push source has nothing to sync.
    assert.equal((await t.call('DELETE', url(A, 'entries/ok1'), made.key)).status, 200);
    assert.equal((await t.call('DELETE', url(A, 'entries/ok1'), made.key)).status, 404);
    assert.equal((await t.call('POST', url(A, 'sync'), made.key)).status, 400);
    assert.equal((await t.call('POST', `/api/admin/sources/${A}/sync`, t.admin)).status, 400);

    // Revoke.
    await t.ok('DELETE', `/api/worlds/${t.W}/intake/keys/${made.id}`, t.dm);
    assert.equal((await t.call('POST', url(A), made.key, { entries })).status, 401);
    assert.equal((await t.call('DELETE', `/api/worlds/${t.W}/intake/keys/${adminKey.id}`, t.player)).status, 403);
  } finally { t.done(); }
});

test('TestIntakePush_RateLimitsAndWebhookSync', async () => {
  const fakeApi = (async () => json([{ id: 'a', title: 'Alpha', body: '# Alpha\nText', vis: 'public' }])) as typeof fetch;
  const t = await boot({ ALX_PUSH_REQUESTS_PER_MIN: '4' }, fakeApi);
  try {
    const push = (await t.ok('POST', `/api/admin/worlds/${t.W}/sources`, t.admin, { kind: 'push', name: 'P', config: {} })).id;
    const key = (await t.ok('POST', `/api/admin/intake/sources/${push}/keys`, t.admin, { label: 'k' })).key;
    const e = { entries: [{ externalId: 'a', title: 'A', blocks: [] }] };
    for (let i = 0; i < 4; i++) assert.equal((await t.call('POST', `/api/intake/${push}/entries`, key, e)).status, 200);
    const limited = await t.call('POST', `/api/intake/${push}/entries`, key, e);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);

    // A webhook starts a sync of a pull source, and can't be hammered.
    const cfg = { transport: 'http', url: 'https://api.example.com/x', idField: 'id', titleField: 'title', bodyField: 'body', visibilityField: 'vis', sharedValues: 'public' };
    const pull = (await t.ok('POST', `/api/admin/worlds/${t.W}/sources`, t.admin, { kind: 'api', name: 'Wiki', config: cfg, defaultVisibility: 'party' })).id;
    const hook = (await t.ok('POST', `/api/admin/intake/sources/${pull}/keys`, t.admin, { label: 'hook' })).key;
    const started = await t.call('POST', `/api/intake/${pull}/sync`, hook);
    assert.equal(started.status, 202);
    assert.equal((await t.call('POST', `/api/intake/${pull}/sync`, hook)).status, 429);
    // The sync key can't push entries into a pull source.
    assert.equal((await t.call('POST', `/api/intake/${pull}/entries`, hook, e)).status, 400);
    let runs: any[] = [];
    for (let i = 0; i < 60; i++) {
      runs = (await t.ok('GET', `/api/admin/sources/${pull}/runs`, t.admin)) as any[];
      if (runs[0]?.status && runs[0].status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(runs[0].status, 'ok');
    assert.equal(runs[0].stats.pages, 1);
  } finally { t.done(); }
});
