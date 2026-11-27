// The World Anvil connector (API v2, "Boromir") against a fake World Anvil
// that follows the shapes in its OpenAPI spec. Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one } from '../src/core/db.ts';
import { readPages, resetFailures } from '../src/intake/detail.ts';
import { depthCounts, resetBuckets } from '../src/intake/tiers.ts';
import { waBlocks, waDate, waShared, playerGroups } from '../src/intake/connectors/worldanvil.ts';
import { blocksToMarkdown } from '../src/intake/model.ts';
import { playerBlocks } from '../src/intake/player.ts';

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const BASE = 'https://www.worldanvil.com/api/external/boromir';
const WORLD = '11111111-1111-4111-8111-111111111111';
const PLAYERS = 'aaaaaaaa-0000-4000-8000-000000000001';
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const date = (d: string) => ({ date: `${d} 10:00:00.000000`, timezone: 'UTC', timezone_type: 3 });
const dmViewer = { accountId: 'a', role: 'dm' as const };

// ---- unit: BBCode and visibility -----------------------------------------------------------------------------------------

test('TestWorldAnvil_BBCodeKeepsTextAndHidesSecretsSubcontainersAndComments', () => {
  const groups = new Set([PLAYERS]);
  const secrets: Record<string, { title: string; content: string; shared: boolean }> = {
    [uid(901)]: { title: 'The heir', content: 'HIDDENHEIR is the true king', shared: false },
    [uid(902)]: { title: 'Known', content: 'REVEALED to the party', shared: true },
  };
  const bb = `[h2]History[/h2]The [b]old[/b] keep of @[Mira](person:${uid(5)}) stands.[br]
[secret:${uid(901)}]
[secret:${uid(902)}]
[subcontainer:${uid(77)}]SUBDM only for others[/subcontainer]
[subcontainer:${PLAYERS}]SUBPARTY for the players[/subcontainer]
[userstate:follower]FOLLOWERS only[/userstate]
/* AUTHORNOTE remember the trap */
[ul][li]One[/li][li]Two[/li][/ul]
[table][tr][th]Name[/th][th]HP[/th][/tr][tr][td]Orc[/td][td]15[/td][/tr][/table]
[quote]Fear the dark.|Old saying[/quote]
--Population::300--
[url:https://example.com]a site[/url] [img:42] [noparse][b]raw[/b][/noparse]`;
  const blocks = waBlocks(bb, { groups, secret: (id) => secrets[id], image: (id) => (id === '42' ? 'https://www.worldanvil.com/uploads/images/gate.png' : undefined) });
  const dm = blocksToMarkdown(blocks);
  for (const w of ['History', '**old**', 'HIDDENHEIR', 'REVEALED', 'SUBDM', 'SUBPARTY', 'FOLLOWERS', 'AUTHORNOTE', 'Orc', 'Fear the dark', 'Population:', '[a site](https://example.com)', 'gate.png', '\\[b\\]raw']) assert.ok(dm.includes(w), `the GM sees ${w}:\n${dm}`);
  const mention = JSON.stringify(blocks).includes(`"ref":"wa:${uid(5)}"`);
  assert.ok(mention, 'the mention points at the article');
  const pl = blocksToMarkdown(playerBlocks(blocks, () => false));
  for (const w of ['HIDDENHEIR', 'SUBDM', 'FOLLOWERS', 'AUTHORNOTE']) assert.ok(!pl.includes(w), `a player never sees ${w}`);
  for (const w of ['REVEALED', 'SUBPARTY', 'History', 'Orc']) assert.ok(pl.includes(w), `a player sees ${w}`);
  assert.ok(!/\[\/?(b|ul|li|table|td|subcontainer|userstate)\]/.test(pl.replace('[b]raw[/b]', '')), 'no tags are left');
});

test('TestWorldAnvil_VisibilityFailsClosed', () => {
  const g = playerGroups({ playerGroups: `My Players, ${uid(3)}` });
  assert.equal(waShared({ state: 'public' }, g), true);
  assert.equal(waShared({ state: 'public', isDraft: true }, g), false, 'a draft is the GM\'s');
  assert.equal(waShared({ state: 'private' }, g), false);
  assert.equal(waShared({ state: 'private', subscribergroups: [{ id: uid(9), title: 'Patrons' }] }, g), false);
  assert.equal(waShared({ state: 'private', subscribergroups: [{ id: uid(9), title: 'my players' }] }, g), true, 'a player group by name');
  assert.equal(waShared({ state: 'private', subscribergroups: [{ id: uid(3) }] }, g), true, 'a player group by id');
  assert.equal(waShared({}, g), false, 'no state: the GM\'s');
  assert.equal(waDate(date('2026-01-02')), '2026-01-02T10:00:00.000Z');
});

// ---- a fake World Anvil world ---------------------------------------------------------------------------------------------

interface Art { id: string; title: string; state: string; isDraft?: boolean; folderId?: string | null; content: string; updated: string; entityClass?: string; secrets?: string[]; groups?: string[]; cover?: string; extra?: Record<string, unknown> }
const wa = {
  arts: [] as Art[],
  cats: [] as { id: string; title: string; state: string; folderId?: string | null; description: string }[],
  secrets: {} as Record<string, { title: string; content: string; groups: string[] }>,
  maps: [] as { id: string; title: string; state: string; updated: string; image: string; markers: { id: string; title: string; x: number; y: number; target?: string; state: string }[] }[],
  timelines: [] as { id: string; title: string; state: string }[],
  histories: [] as { id: string; title: string; year: number; state: string; timelines: string[]; updated: string }[],
  images: [] as { id: number; url: string }[],
  calls: [] as string[],
  headers: [] as Record<string, string>[],
};
const reset = () => {
  wa.cats = [{ id: uid(100), title: 'People', state: 'public', description: 'CATBODY folk of the realm' }, { id: uid(101), title: 'Villains', state: 'private', folderId: uid(100), description: 'CATDM bad folk' }];
  wa.arts = Array.from({ length: 60 }, (_, i) => ({ id: uid(i + 1), title: `Article ${i + 1}`, state: 'public', folderId: uid(100), content: `WABODY${i + 1} words`, updated: '2026-01-01', entityClass: i % 2 ? 'Person' : 'Location' }));
  wa.arts[1] = { ...wa.arts[1], title: 'Secret Lord', state: 'private', folderId: uid(101), content: 'PRIVATEDM lord plots' };
  wa.arts[2] = { ...wa.arts[2], title: 'Party Notes', state: 'private', groups: [PLAYERS], content: 'GROUPSHARED notes' };
  wa.arts[3] = { ...wa.arts[3], title: 'Draft Idea', isDraft: true, content: 'DRAFTDM idea' };
  wa.arts[4] = { ...wa.arts[4], title: 'Mira', content: `Mira lives in @[Article 1](location:${uid(1)}). [secret:${uid(901)}] [img:42]`, secrets: [uid(901), uid(902)], cover: 'https://www.worldanvil.com/uploads/images/mira.png', extra: { species: { id: uid(1), title: 'Article 1', entityClass: 'Location' }, nickname: 'The Grey' } };
  wa.secrets = { [uid(901)]: { title: 'Her past', content: 'SECRETDM she was a spy', groups: [] }, [uid(902)]: { title: 'Her name', content: 'SECRETPARTY her real name', groups: [PLAYERS] } };
  wa.maps = [{ id: uid(500), title: 'Realm Map', state: 'public', updated: '2026-01-01', image: 'https://www.worldanvil.com/uploads/maps/realm.png', markers: [{ id: '1', title: 'Keep', x: 100, y: 200, target: uid(1), state: 'public' }, { id: '2', title: 'Lair', x: 5, y: 6, state: 'private' }] }];
  wa.timelines = [{ id: uid(600), title: 'Ages', state: 'public' }];
  wa.histories = [{ id: uid(700), title: 'The founding', year: 12, state: 'public', timelines: [uid(600)], updated: '2026-01-01' }, { id: uid(701), title: 'The betrayal', year: 40, state: 'private', timelines: [uid(600)], updated: '2026-01-01' }];
  wa.images = [{ id: 42, url: 'https://www.worldanvil.com/uploads/images/gate.png' }];
  wa.calls = []; wa.headers = [];
};
const grp = (ids: string[] = []) => ids.map((id) => ({ id, title: id === PLAYERS ? 'Players' : 'Other' }));
const artRef = (a: Art) => ({ id: a.id, title: a.title, slug: a.title.toLowerCase(), state: a.state, isWip: false, isDraft: !!a.isDraft, entityClass: a.entityClass ?? 'Article', url: `https://www.worldanvil.com/w/realm/a/${a.id}`, folderId: a.folderId ?? null, tags: 'lore', updateDate: date(a.updated), subscribergroups: grp(a.groups) });
const page = <T>(rows: T[], body: any) => rows.slice(Number(body?.offset ?? 0), Number(body?.offset ?? 0) + Number(body?.limit ?? 50));
const waFetch = async (url: string, init?: RequestInit): Promise<Response | null> => {
  if (!url.startsWith(BASE)) return null;
  const u = new URL(url);
  const p = u.pathname.slice('/api/external/boromir'.length);
  wa.calls.push(`${init?.method ?? 'GET'} ${p}${u.searchParams.get('id') ? '?' + u.searchParams.get('id') : ''}`);
  wa.headers.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])));
  const h = wa.headers[wa.headers.length - 1];
  if (h['x-application-key'] !== 'app-key-123456' || h['x-auth-token'] !== 'user-token-abcdef') return json({ success: false, error: { summary: 'Unauthorized' } }, 401);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const id = u.searchParams.get('id') ?? '';
  if (p === '/identity') return json({ id: 'user-1', username: 'wizard', success: true });
  if (p === '/user/worlds') return json({ success: true, entities: [{ id: WORLD, title: 'The Realm', slug: 'realm', url: 'https://www.worldanvil.com/w/realm' }] });
  if (p === '/world/categories') return json({ success: true, entities: page(wa.cats, body).map((c) => ({ id: c.id, title: c.title, state: c.state, folderId: c.folderId ?? null, updateDate: date('2026-01-01'), subscribergroups: [] })) });
  if (p === '/world/articles') return json({ success: true, entities: page(wa.arts, body).map(artRef) });
  if (p === '/world/maps') return json({ success: true, entities: page(wa.maps, body).map((m) => ({ id: m.id, title: m.title, state: m.state, updateDate: date(m.updated), subscribergroups: [] })) });
  if (p === '/world/images') return json({ success: true, entities: page(wa.images, body) });
  if (p === '/world/timelines') return json({ success: true, entities: page(wa.timelines, body) });
  if (p === '/world/histories') return json({ success: true, entities: page(wa.histories, body).map((h) => ({ id: h.id, title: h.title, state: h.state, updateDate: date(h.updated) })) });
  if (p === '/article') {
    const a = wa.arts.find((x) => x.id === id);
    if (!a) return json({ success: false }, 404);
    return json({ ...artRef(a), success: true, content: a.content, position: wa.arts.indexOf(a), category: a.folderId ? { id: a.folderId } : null, world: { id: WORLD, entityClass: 'World' }, secrets: (a.secrets ?? []).map((s) => ({ id: s, title: wa.secrets[s]?.title })), cover: a.cover ? { id: 1, url: a.cover } : null, seeded: 'SEEDDM a hook', showSeeded: false, ...(a.extra ?? {}) });
  }
  if (p === '/secret') { const s = wa.secrets[id]; return s ? json({ id, title: s.title, content: s.content, state: 'private', subscribergroups: grp(s.groups), success: true }) : json({ success: false }, 404); }
  if (p === '/category') { const c = wa.cats.find((x) => x.id === id); return c ? json({ id: c.id, title: c.title, state: c.state, description: c.description, parent: c.folderId ? { id: c.folderId } : null, updateDate: date('2026-01-01'), success: true }) : json({}, 404); }
  if (p === '/map') { const m = wa.maps.find((x) => x.id === id); return m ? json({ id: m.id, title: m.title, state: m.state, description: 'MAPBODY the realm', updateDate: date(m.updated), image: { id: 9, url: m.image }, markers: m.markers.map((k) => ({ id: k.id })), success: true }) : json({}, 404); }
  if (p === '/marker') { for (const m of wa.maps) { const k = m.markers.find((x) => x.id === id); if (k) return json({ id: k.id, title: k.title, state: k.state, geoX: k.x, geoY: k.y, targetArticle: k.target ? { id: k.target, title: 'x' } : null, success: true }); } return json({}, 404); }
  if (p === '/history') { const h = wa.histories.find((x) => x.id === id); return h ? json({ id: h.id, title: h.title, state: h.state, year: h.year, content: `${h.title} happened`, timelines: h.timelines.map((t) => ({ id: t })), success: true }) : json({}, 404); }
  return json({ success: false, error: 'unexpected ' + p }, 404);
};
const imgCalls: string[] = [];
const imgFetch = (url: string, init?: RequestInit): Response | null => {
  const u = new URL(url);
  if (!u.pathname.startsWith('/uploads/')) return null;
  imgCalls.push(u.pathname + ((init?.headers as any)?.['x-auth-token'] ? ' WITH-TOKEN' : ''));
  return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(64)]), { status: 200, headers: { 'Content-Type': 'image/png' } });
};
const fake = (async (url: any, init?: RequestInit) => {
  const s = String(url);
  const img = imgFetch(s, init);
  if (img) return img;
  return (await waFetch(s, init)) ?? json({ error: 'unexpected ' + s }, 500);
}) as typeof fetch;

async function boot() {
  resetBuckets();
  resetFailures();
  const made = createApp({ noScheduler: true, fetch: fake, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_CRAWL_RATE: '0' } });
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
  const wid = (await ok('POST', '/api/admin/worlds', { name: 'Realm', dmAccountId: a.account.id })).id as string;
  const addPlayer = async () => {
    const inv = await ok('POST', `/api/worlds/${wid}/invites`, { role: 'player' });
    return (await call('POST', '/api/join', null, { code: inv.code, username: 'jess' + Math.random().toString(36).slice(2, 6), password: 'player pass 123', characterName: 'Jess' })).body.token as string;
  };
  const sd = () => ({ db: made.deps.db, library: made.deps.library, dataDir: null, vaultsDir: null, fetch: fake, env: { ALX_CRAWL_RATE: '0' } as Record<string, string | undefined>, mcp: undefined });
  return { ...made, call, ok, admin, wid, addPlayer, sd };
}

async function source(t: Awaited<ReturnType<typeof boot>>, world = 'realm') {
  const conn = await t.ok('POST', '/api/admin/connections', { kind: 'worldanvil-api', name: 'My World Anvil', config: { token: 'user-token-abcdef', appKey: 'app-key-123456' } });
  const src = await t.ok('POST', `/api/admin/worlds/${t.wid}/sources`, { connectionId: conn.id, kind: 'worldanvil-api', name: 'World Anvil', config: { worldId: world, playerGroups: 'Players' }, defaultVisibility: 'party' });
  return src.id as string;
}
const readAll = async (t: Awaited<ReturnType<typeof boot>>, sid: string) => {
  const src = one<any>(t.deps.db, 'SELECT * FROM sources WHERE id = ?', sid);
  const pages = all<any>(t.deps.db, "SELECT id, external_id FROM pages WHERE source_id = ? AND (depth <> 'full' OR source_updated_at <> COALESCE(held_updated_at, ''))", sid);
  return readPages(t.sd(), src, pages);
};
const row = (t: Awaited<ReturnType<typeof boot>>, title: string) => one<any>(t.deps.db, 'SELECT * FROM pages WHERE world_id = ? AND title = ?', t.wid, title);

test('TestWorldAnvil_ImportsAWorldInTiersAndKeepsDmContentFromPlayers', async () => {
  reset();
  imgCalls.length = 0;
  const t = await boot();
  const sid = await source(t);
  const first = await t.ok('POST', `/api/admin/sources/${sid}/sync?wait=1`, {});
  assert.equal(first.status ?? first.run?.status ?? 'done', first.status ?? first.run?.status ?? 'done');
  // The world was found by its address name; 60 articles at 50 a page: 2 list calls. No article was read yet.
  assert.ok(wa.calls.includes('GET /identity') && wa.calls.includes('POST /user/worlds?user-1'));
  assert.equal(wa.calls.filter((c) => c.startsWith('POST /world/articles')).length, 2);
  assert.equal(wa.calls.filter((c) => c.startsWith('GET /article')).length, 0);
  assert.ok(wa.headers.every((h) => h['content-type'] === 'application/json' && /^Alexandria \(/.test(h['user-agent'])), 'every call names the app');
  const counts = depthCounts(t.deps.db, sid);
  assert.equal(counts.index, 60 + 2 + 1, 'articles, categories and the map are listed');
  assert.equal(row(t, 'Secret Lord').parent_external, `wa:${uid(101)}`, 'the tree comes from the list');

  // Markers and timelines came with the listing.
  const markers = all<any>(t.deps.db, 'SELECT * FROM intake_markers WHERE source_id = ? ORDER BY external_id', sid);
  assert.deepEqual(markers.map((m) => [m.name, m.latitude, m.longitude, m.visibility]), [['Keep', 200, 100, 'party'], ['Lair', 6, 5, 'dm']]);
  assert.equal(markers[0].ref, `wa:${uid(1)}`);
  const tl = all<any>(t.deps.db, 'SELECT * FROM intake_timelines WHERE source_id = ?', sid);
  assert.equal(tl.length, 1);
  assert.ok(tl[0].data.includes('The founding') && tl[0].data.includes('The betrayal'));
  assert.ok(imgCalls.includes('/uploads/maps/realm.png'), 'the map picture is stored here');

  // Tier 3: read every page.
  await readAll(t, sid);
  assert.equal(depthCounts(t.deps.db, sid).full, 63);
  const mira = row(t, 'Mira');
  assert.ok(mira.body.includes('SECRETDM') && mira.body.includes('SECRETPARTY') && mira.body.includes('SEEDDM'), 'the GM has every secret');
  assert.equal(mira.kind, 'location');
  assert.ok(JSON.stringify(mira).includes('The Grey'), 'template fields are facts');
  for (const [title, vis] of [['Article 1', 'party'], ['Secret Lord', 'dm'], ['Party Notes', 'party'], ['Draft Idea', 'dm'], ['Villains', 'dm'], ['People', 'party'], ['Realm Map', 'party']] as const) assert.equal(row(t, title).visibility, vis, title);

  // A player: no private, draft or secret words anywhere.
  const tok = await t.addPlayer();
  const listing = (await t.call('GET', `/api/worlds/${t.wid}/library/pages`, tok)).text;
  assert.ok(!listing.includes('Secret Lord') && !listing.includes('Draft Idea'));
  const miraPl = await t.call('GET', `/api/worlds/${t.wid}/library/pages/${mira.id}`, tok);
  assert.equal(miraPl.status, 200);
  assert.ok(miraPl.text.includes('SECRETPARTY'), 'a secret shared with the players\' group is theirs');
  for (const w of ['SECRETDM', 'SEEDDM', 'PRIVATEDM', 'DRAFTDM', 'CATDM']) {
    assert.ok(!miraPl.text.includes(w), `not in the page: ${w}`);
    const s = (await t.call('GET', `/api/worlds/${t.wid}/library/search?q=${w}`, tok)).text;
    assert.ok(!s.includes(w), `not in search: ${w}`);
  }
  assert.ok(!all<any>(t.deps.db, 'SELECT player_body FROM pages WHERE world_id = ?', t.wid).some((r) => /SECRETDM|PRIVATEDM|DRAFTDM|SEEDDM|CATDM/.test(String(r.player_body ?? ''))), 'no player copy holds GM words');

  // A second listing reads nothing again but what changed.
  wa.calls = [];
  wa.arts[0] = { ...wa.arts[0], content: 'WABODY1 edited', updated: '2026-02-01' };
  await t.ok('POST', `/api/admin/sources/${sid}/sync?wait=1`, {});
  assert.ok(!wa.calls.some((c) => c.startsWith('GET /marker') || c.startsWith('GET /history') || c.startsWith('GET /map')), `unchanged maps and events are not read again: ${wa.calls.join(' ')}`);
  await readAll(t, sid);
  assert.deepEqual(wa.calls.filter((c) => c.startsWith('GET /article')), [`GET /article?${uid(1)}`]);
  assert.ok(row(t, 'Article 1').body.includes('WABODY1 edited'));
  assert.ok(!imgCalls.some((c) => c.includes('WITH-TOKEN')), 'picture hosts never get the token');
});

test('TestWorldAnvil_WrongKeysAreReportedAndAMissingAppKeyIsRefused', async () => {
  reset();
  const t = await boot();
  const bad = await t.call('POST', `/api/admin/worlds/${t.wid}/sources`, t.admin, { kind: 'worldanvil-api', name: 'WA', config: { worldId: WORLD, token: 'user-token-abcdef' } });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Application key/);
  const conn = await t.ok('POST', '/api/admin/connections', { kind: 'worldanvil-api', name: 'Bad', config: { token: 'user-token-wrong!', appKey: 'app-key-123456' } });
  const src = await t.ok('POST', `/api/admin/worlds/${t.wid}/sources`, { connectionId: conn.id, kind: 'worldanvil-api', name: 'WA', config: { worldId: WORLD } });
  const r = await t.call('POST', `/api/admin/sources/${src.id}/test`, t.admin, {});
  assert.ok(/refused the keys \(401\)/.test(r.text), r.text);
});
