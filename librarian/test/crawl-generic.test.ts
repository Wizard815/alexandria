// The generic API connector sets itself up: it finds an OpenAPI spec (or
// guesses from a sample), proposes endpoints with roles and mappings for the
// DM to review, saves the result as a preset, and crawls in tiers.
// Endpoints left unused are never called. Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';
import { calendarsFor, timelinesFor } from '../src/intake/records.ts';
import { mintTicket } from '../src/features/sound/ticket.ts';
import { discoverApi, endpointUsable, guessRole, mapFields, mapRoleFields } from '../src/intake/connectors/apiSetup.ts';
import { privateHost } from '../src/intake/connectors/api.ts';
import { cleanEndpoints } from '../src/intake/connectors/apiEndpoints.ts';
import { depthCounts, resetBuckets } from '../src/intake/tiers.ts';

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const dmViewer = { accountId: 'a', role: 'dm' as const };

// ---- an app that has a spec -------------------------------------------------------------------------------------

const WIKI = 'https://wiki.example.com/api/v1';
const wiki = { calls: [] as string[], auth: [] as (string | null)[] };
const CHARS = [
  { id: 1, name: 'Odda Fenwick', summary: 'A baker with a past.', is_private: false, updated_at: '2026-01-01T00:00:00Z', tags: [1] },
  { id: 2, name: 'Secret Duke', summary: 'Rules from the shadows.', is_private: true, updated_at: '2026-01-02T00:00:00Z', tags: [2] },
  { id: 3, name: 'Third Hero', summary: 'Number three.', is_private: false, updated_at: '2026-01-03T00:00:00Z', tags: [] },
];
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const SPEC = {
  openapi: '3.0.0', info: { title: 'Fake Wiki' }, servers: [{ url: WIKI }],
  components: {
    schemas: {
      Character: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, summary: { type: 'string' }, is_private: { type: 'boolean' }, updated_at: { type: 'string' }, tags: { type: 'array', items: { type: 'integer' } } } },
      CharacterList: { type: 'object', properties: { data: { type: 'array', items: ref('Character') }, links: { type: 'object', properties: { next: { type: 'string' } } }, meta: { type: 'object', properties: { last_page: { type: 'integer' } } } } },
      Tag: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } },
      Place: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, entry: { type: 'string' }, is_private: { type: 'boolean' } } },
    },
  },
  paths: {
    '/characters': { get: { tags: ['Characters'], parameters: [{ name: 'page', in: 'query' }, { name: 'limit', in: 'query' }, { name: 'lastSync', in: 'query' }], responses: { 200: { content: { 'application/json': { schema: ref('CharacterList') } } } } } },
    '/characters/{id}': { get: { tags: ['Characters'], parameters: [{ name: 'id', in: 'path', required: true }], responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, entry: { type: 'string' } } } } } } } } } } },
    '/locations': { get: { tags: ['Locations'], responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: ref('Place') } } } } } } } } },
    '/tags': { get: { tags: ['Tags'], responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: ref('Tag') } } } } } } } } },
    '/images': { get: { tags: ['Media'], responses: { 200: { content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, filename: { type: 'string' } } } } } } } } } },
    '/zzz': { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { foo: { type: 'string' } } } } } } } } } },
    '/internal/stats': { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { count: { type: 'integer' } } } } } } } } },
    '/accounts/{accountId}/members/{memberId}': { get: { parameters: [], responses: { 200: {} } } },
  },
};
const wikiFetch = (url: string, init?: any): Response | null => {
  if (!url.startsWith(WIKI)) return null;
  const u = new URL(url);
  const p = u.pathname.slice('/api/v1'.length);
  wiki.calls.push(p + (u.search || ''));
  wiki.auth.push(init?.headers?.Authorization ?? null);
  if (p === '/openapi.json') return json(SPEC);
  if (p === '/characters') {
    const page = Number(u.searchParams.get('page') ?? 1);
    const rows = CHARS.slice((page - 1) * 2, page * 2);
    return json({ data: rows, links: { next: page * 2 < CHARS.length ? `${WIKI}/characters?page=${page + 1}` : null }, meta: { last_page: 2 } });
  }
  const m = /^\/characters\/(\d+)$/.exec(p);
  if (m) { const c = CHARS.find((x) => x.id === Number(m[1])); return c ? json({ data: { ...c, entry: `CHARBODY${c.id} the full story of ${c.name}` } }) : json({}, 404); }
  if (p === '/tags') return json({ data: [{ id: 1, name: 'baker' }, { id: 2, name: 'noble' }] });
  if (p === '/locations') return json({ data: [{ id: 9, name: 'Nowhere', entry: 'PLACEBODY', is_private: false }] });
  if (p === '/images') return json([{ id: 'i1', filename: 'a.png' }]);
  return json({ error: 'not found' }, 404);
};

// ---- an app with no spec ----------------------------------------------------------------------------------------

const NOSPEC = 'https://nospec.example.com/api';
const nospec = { calls: [] as string[] };
const nospecFetch = (url: string): Response | null => {
  if (!url.startsWith(NOSPEC)) return null;
  const p = new URL(url).pathname.slice('/api'.length);
  nospec.calls.push(p);
  if (p === '') return json({ articles: `${NOSPEC}/articles`, people: `${NOSPEC}/people`, version: '3' });
  if (p === '/articles') return json({ items: [
    { uuid: 'a-1', title: 'The Harbour', content: '<p>Ships and <strong>salt</strong>.</p>', excerpt: 'Ships.', private: false, modified: '2026-01-05T00:00:00Z', tags: ['port'], parent: null },
    { uuid: 'a-2', title: 'The Vault', content: '<p>Hidden gold.</p>', excerpt: 'Gold.', private: true, modified: '2026-01-06T00:00:00Z', tags: [], parent: 'a-1' },
  ], next_cursor: null });
  if (p === '/people') return json({ items: [{ uuid: 'p-1', title: 'PERSONLEAK' }] });
  return json({ error: 'not found' }, 404);
};

// ---- an app with calendars and pictures ------------------------------------------------------------------------------

const MEDIA = 'https://media.example.com/api';
const CDN = 'https://cdn.example.net';
const PNG = (tag: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(tag)]);
const media = {
  calls: [] as string[],
  auth: {} as Record<string, string | null>,
  files: 0,
  updated: { i1: 'v1' } as Record<string, string>,
};
const mediaReset = () => { media.calls = []; media.auth = {}; media.files = 0; media.updated = { i1: 'v1' }; };
const mediaPages = [
  { id: 'p1', title: 'Public page', body: 'Seen by all.', is_private: false },
  { id: 'p2', title: 'Private page', body: 'Only the DM.', is_private: true },
  { id: 'p3', title: 'Shared page with a private picture', body: 'Shared text.', is_private: false },
];
const mediaImages = () => [
  { id: 'i1', name: 'Portrait', file: '/files/i1.png', page: 'p1', updated: media.updated.i1, is_private: false },
  { id: 'i2', name: 'Secret map', file: '/files/i2.png', page: 'p2', updated: 'v1', is_private: false },
  { id: 'i3', name: 'Elsewhere', file: `${CDN}/pics/i3.png`, page: 'p1', updated: 'v1', is_private: false },
  { id: 'i4', name: 'Huge', file: '/files/huge.png', page: 'p1', updated: 'v1', is_private: false },
  { id: 'i5', name: 'Vector', file: '/files/vector.svg', page: 'p1', updated: 'v1', is_private: false },
  { id: 'i6', name: 'Liar', file: '/files/liar.png', page: 'p1', updated: 'v1', is_private: false },
  { id: 'i7', name: 'Inside', file: 'http://127.0.0.1:9/inside.png', page: 'p1', updated: 'v1', is_private: false },
  { id: 'i8', name: 'Redirect', file: '/files/redirect.png', page: 'p1', updated: 'v1', is_private: false },
  { id: 'i9', name: 'Private picture', file: '/files/i9.png', page: 'p3', updated: 'v1', is_private: true },
];
const imageHeaders = (len?: number): Record<string, string> => ({ 'Content-Type': 'image/png', ...(len !== undefined ? { 'Content-Length': String(len) } : {}) });
const mediaFetch = (url: string, init?: any): Response | null => {
  const u = new URL(url);
  if (u.origin === CDN) {
    media.calls.push(`CDN${u.pathname}`);
    media.auth[`CDN${u.pathname}`] = init?.headers?.Authorization ?? null;
    return new Response(PNG('cdn'), { status: 200, headers: imageHeaders() });
  }
  if (u.origin !== 'https://media.example.com' && !url.startsWith('http://127.0.0.1:9')) return null;
  if (url.startsWith('http://127.0.0.1:9')) { media.calls.push('PRIVATE'); return new Response(PNG('private'), { status: 200, headers: imageHeaders() }); }
  const p = u.pathname.startsWith('/api') ? u.pathname.slice('/api'.length) : u.pathname;
  media.calls.push(p);
  media.auth[p] = init?.headers?.Authorization ?? null;
  if (p === '' || p === '/') return json({ version: 1 });
  if (p === '/pages') return json({ data: mediaPages });
  if (p === '/calendars') return json({ data: [
    {
      id: 'c1', name: 'Harptos', months: [{ name: 'Hammer', days: 30 }, { name: 'Midwinter', days: 1, intercalary: true }, { name: 'Alturiak', days: 30 }], weekdays: ['One', { name: 'Two' }], date: '1492-1-5', suffix: 'DR', epoch: 0, is_private: false,
      events: [{ id: 'e1', name: 'Festival', date: '1492-1-1', is_private: false }, { id: 'e2', name: 'SECRETEVENT', date: '1492-1-2', is_private: true }, { id: 'e3', name: 'No flag', date: '1492-1-3' }],
    },
    { id: 'c2', name: 'Hidden calendar', months: [{ name: 'Shadow', days: 20 }], weekdays: ['Dark'], is_private: true },
    { id: 'c3', name: 'Broken calendar', is_private: false },
  ] });
  if (p === '/images') return json({ data: mediaImages() });
  if (p === '/battlemaps') return json({ data: [
    { id: 'm1', name: 'Harbour map', file: '/files/map-4000.png', page: 'p1', updated: 'v1', is_private: false },
    { id: 'm2', name: 'Vault map', file: '/files/map-3000.png', page: 'p2', updated: 'v1', is_private: false },
    { id: 'm3', name: 'Enormous map', file: '/files/map-9000.png', page: 'p1', updated: 'v1', is_private: false },
    { id: 'm4', name: 'Loose map', file: '/files/map-1500.png', updated: 'v1', is_private: false },
  ] });
  if (p === '/unused-images') return json({ data: [{ id: 'u1', name: 'Never', file: '/files/never.png' }] });
  if (p.startsWith('/files/')) {
    media.files++;
    const mapSize = /^\/files\/map-(\d+)\.png$/.exec(p);
    if (mapSize) return new Response(PNG('m'.repeat(Number(mapSize[1]))), { status: 200, headers: imageHeaders() });
    if (p === '/files/huge.png') return new Response(PNG('x'.repeat(5000)), { status: 200, headers: imageHeaders(5000 + 12) });
    if (p === '/files/vector.svg') return new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } });
    if (p === '/files/liar.png') return new Response('<html>not a picture</html>', { status: 200, headers: imageHeaders() });
    if (p === '/files/redirect.png') return new Response(null, { status: 302, headers: { Location: `${CDN}/pics/redirected.png` } });
    return new Response(PNG(p.slice(7, 9)), { status: 200, headers: imageHeaders() });
  }
  return json({ error: 'not found' }, 404);
};

const fake = (async (url: any, init?: any) => {
  for (const h of [wikiFetch, nospecFetch, mediaFetch]) { const r = h(String(url), init); if (r) return r; }
  return json({ error: 'unexpected ' + url }, 404);
}) as typeof fetch;

async function boot(env: Record<string, string> = {}) {
  resetBuckets();
  wiki.calls = []; wiki.auth = []; nospec.calls = [];
  const made = createApp({ noScheduler: true, fetch: fake, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_CRAWL_RATE: '0', ...env } });
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
  const addPlayer = async (wid: string) => {
    const inv = await ok('POST', `/api/worlds/${wid}/invites`, { role: 'player' });
    const j = (await call('POST', '/api/join', null, { code: inv.code, username: 'jess' + Math.random().toString(36).slice(2, 6), password: 'player pass 123', characterName: 'Jess' })).body;
    return { token: j.token as string, accountId: j.account.id as string };
  };
  return { ...made, call, ok, admin, world, addPlayer, base, accountId: a.account.id as string };
}

// ---- guesses -----------------------------------------------------------------------------------------------------------

test('CrawlGeneric_RolesAreGuessedFromTheWordsOfThePath', () => {
  for (const [path, role] of [['/characters', 'people'], ['/api/v2/Locations', 'places'], ['/items', 'items'], ['/factions', 'organisations'], ['/timelines', 'events'], ['/calendars', 'calendars'], ['/tags', 'tags'], ['/uploads', 'images'], ['/articles', 'pages'], ['/projects/{id}/npcs', 'people']] as const) {
    assert.equal(guessRole(path).role, role, path);
  }
  assert.equal(guessRole('/zzz').role, 'unknown');
  assert.equal(guessRole('/zzz').confidence, 0);
  assert.equal(guessRole('/q', ['Characters']).role, 'people', 'the spec tags help when the path does not');
});

test('CrawlGeneric_FieldsAreGuessedAndVisibilityFailsClosed', () => {
  const m = mapFields([
    { name: 'id', kind: 'number', samples: [1] }, { name: 'name', kind: 'string', samples: ['A'] }, { name: 'entry', kind: 'string', samples: ['<p>Long body text here</p>'] },
    { name: 'is_private', kind: 'boolean', samples: [true] }, { name: 'updated_at', kind: 'string', samples: ['2026'] },
  ]);
  assert.deepEqual([m.fields.idField, m.fields.titleField, m.fields.bodyField, m.fields.bodyFormat, m.fields.visibilityField, m.fields.sharedValues, m.fields.updatedField], ['id', 'name', 'entry', 'html', 'is_private', 'false', 'updated_at']);
  const none = mapFields([{ name: 'id', kind: 'number', samples: [1] }, { name: 'title', kind: 'string', samples: ['A'] }]);
  assert.equal(none.fields.visibilityField, undefined);
  assert.ok(none.notes.some((n) => /DM-only/.test(n)), 'no visibility field: it says everything stays DM-only');
  const word = mapFields([{ name: 'id', kind: 'string', samples: ['x'] }, { name: 'name', kind: 'string', samples: ['A'] }, { name: 'visibility', kind: 'string', samples: ['public', 'secret', 'players'] }]);
  assert.equal(word.fields.sharedValues, 'public, players', 'only the words that mean everyone, never "secret"');
});

test('CrawlGeneric_EndpointListsAreCleaned', () => {
  const eps = cleanEndpoints([{ path: '/a', role: 'unknown', use: true }, { path: '/b', role: 'people', use: true, idField: 'id', evil: '<script>' }, { path: '/b', role: 'items', use: 'yes' }]);
  assert.equal(eps[0].use, false, 'an endpoint with no role is never used');
  assert.equal(eps[1].use, true);
  assert.equal((eps[1] as any).evil, undefined, 'unknown keys are dropped');
  assert.equal(eps[2].use, false, 'use must be exactly true');
  assert.notEqual(eps[1].key, eps[2].key, 'keys are unique');
  assert.throws(() => cleanEndpoints([{ role: 'people' }]), /no path/);
  assert.throws(() => cleanEndpoints('{nope'), /JSON/);
});

// ---- discovery from a spec -----------------------------------------------------------------------------------------------------

test('CrawlGeneric_FindsTheSpecAndGuessesRolesMappingsAndConfidence', async () => {
  const t = await boot();
  const out = (await t.ok('POST', '/api/admin/connections/api-discover', { baseUrl: WIKI, token: 'wiki-token-1234567890' }));
  assert.equal(out.source, 'openapi');
  assert.equal(out.specUrl, `${WIKI}/openapi.json`);
  assert.equal(out.title, 'Fake Wiki');
  const ep = (path: string) => out.endpoints.find((e: any) => e.path === path);
  const chars = ep('/characters');
  assert.equal(chars.role, 'people');
  assert.equal(chars.use, true);
  assert.ok(chars.confidence >= 0.8, `confidence ${chars.confidence}`);
  assert.deepEqual([chars.itemsPath, chars.idField, chars.titleField, chars.summaryField, chars.visibilityField, chars.sharedValues, chars.updatedField, chars.tagsField],
    ['data', 'id', 'name', 'summary', 'is_private', 'false', 'updated_at', 'tags']);
  assert.deepEqual([chars.paging, chars.nextPath, chars.pageSizeParam, chars.sinceParam, chars.detailPath], ['link', 'links.next', 'limit', 'lastSync', '/characters/{id}']);
  assert.equal(ep('/locations').role, 'places');
  assert.equal(ep('/tags').role, 'tags');
  // Recognised but not imported, and not sure: both stay unused.
  assert.equal(ep('/images').role, 'images');
  assert.equal(ep('/images').use, false);
  assert.equal(ep('/zzz').role, 'unknown');
  assert.equal(ep('/zzz').use, false);
  assert.equal(ep('/internal/stats'), undefined, 'not a list');
  assert.ok(!out.endpoints.some((e: any) => /members/.test(e.path)), 'a record under two ids is not a list');
  // The token went to the app's host, and discovery made only a few calls (the spec, and a sample for the list with a thin schema).
  assert.ok(wiki.auth.every((a) => a === 'Bearer wiki-token-1234567890'));
  assert.ok(out.calls <= 3, `${out.calls} calls: ${wiki.calls.join(' ')}`);
  assert.ok(!JSON.stringify(out).includes('wiki-token'), 'the answer never carries the token');
  assert.equal((await t.call('POST', '/api/admin/connections/api-discover', null, { baseUrl: WIKI })).status, 401);
  assert.equal((await t.call('POST', '/api/admin/connections/api-discover', t.admin, { baseUrl: 'ftp://nope' })).status, 400);
});

test('CrawlGeneric_ReviewedSetupCrawlsInTiersAndUnusedEndpointsAreNeverCalled', async () => {
  const t = await boot();
  const found = await t.ok('POST', '/api/admin/connections/api-discover', { baseUrl: WIKI, token: 'wiki-token-1234567890' });
  const conn = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'Fake Wiki', config: { transport: 'http', baseUrl: WIKI, token: 'wiki-token-1234567890' } });
  // The DM reviews: keeps characters and tags, leaves locations unused, never assigns the unknown one.
  const reviewed = found.endpoints.map((e: any) => (e.path === '/locations' ? { ...e, use: false } : e.path === '/zzz' ? { ...e, use: true } : e));
  const saved = await t.ok('PUT', `/api/admin/connections/${conn.id}/endpoints`, { endpoints: reviewed });
  const kept = JSON.parse(one<any>(t.deps.db, 'SELECT config FROM connections WHERE id = ?', conn.id)!.config);
  const eps = JSON.parse(kept.endpoints);
  assert.equal(eps.find((e: any) => e.path === '/zzz').use, false, 'an endpoint with no role cannot be switched on');
  assert.equal(eps.find((e: any) => e.path === '/locations').use, false);
  assert.ok(!JSON.stringify(saved).includes('wiki-token'));
  // At least one endpoint must be used.
  assert.equal((await t.call('PUT', `/api/admin/connections/${conn.id}/endpoints`, t.admin, { endpoints: eps.map((e: any) => ({ ...e, use: false })) })).status, 400);

  const wid = await t.world('Wiki World');
  const src = await t.ok('POST', `/api/admin/worlds/${wid}/sources`, { connectionId: conn.id, kind: 'api', name: 'Wiki', config: {}, defaultVisibility: 'party' });
  wiki.calls = [];
  const out = await t.ok('POST', `/api/admin/sources/${src.id}/sync?wait=1`, {});
  // Tier 1: the characters list (2 pages by next link) and the tag names. Nothing else, and no page-by-page calls.
  assert.deepEqual(wiki.calls.map((c) => c.split('?')[0]).sort(), ['/characters', '/characters', '/tags']);
  assert.equal(out.stats.indexCalls, 3);
  for (const never of ['/locations', '/images', '/zzz', '/internal/stats', '/openapi.json']) assert.ok(!wiki.calls.some((c) => c.startsWith(never)), `${never} was never called`);
  // The list had a summary but no entry, and the endpoint has a detail path: summary depth.
  assert.deepEqual(depthCounts(t.deps.db, src.id), { total: 3, index: 0, summary: 3, full: 0, stale: 0 });
  const row = one<any>(t.deps.db, 'SELECT * FROM pages WHERE world_id = ? AND title = ?', wid, 'Odda Fenwick');
  assert.deepEqual(JSON.parse(row.tags), ['baker'], 'tag ids became names');
  assert.equal(row.kind, 'character');
  assert.match(row.body, /A baker with a past/);
  assert.ok(!row.body.includes('CHARBODY'));
  // Visibility fails closed and follows the list's own flag.
  assert.equal(row.visibility, 'party');
  assert.equal(one<any>(t.deps.db, 'SELECT visibility FROM pages WHERE world_id = ? AND title = ?', wid, 'Secret Duke').visibility, 'dm');

  // Opening a page reads its detail path once.
  wiki.calls = [];
  const id = (t.deps.library.list(wid, dmViewer) as any[]).find((p) => p.title === 'Odda Fenwick').id;
  const page = await t.call('GET', `/api/worlds/${wid}/library/pages/${id}`, t.admin);
  assert.ok(page.text.includes('CHARBODY1'));
  assert.deepEqual(wiki.calls, ['/characters/1']);
  assert.equal(one<any>(t.deps.db, 'SELECT depth FROM pages WHERE id = ?', id).depth, 'full');
  // The private one is the DM's only, read or not.
  const duke = (t.deps.library.list(wid, dmViewer) as any[]).find((p) => p.title === 'Secret Duke').id;
  await t.call('GET', `/api/worlds/${wid}/library/pages/${duke}`, t.admin);
  assert.equal(one<any>(t.deps.db, 'SELECT visibility FROM pages WHERE id = ?', duke).visibility, 'dm');
  assert.equal(one<any>(t.deps.db, 'SELECT player_body FROM pages WHERE id = ?', duke).player_body, null);
  for (const never of ['/locations', '/images', '/zzz']) assert.ok(!wiki.calls.some((c) => c.startsWith(never)));
});

test('CrawlGeneric_TheReviewedSetupSavesAsAPresetOtherWorldsCanUse', async () => {
  const t = await boot();
  const found = await t.ok('POST', '/api/admin/connections/api-discover', { baseUrl: WIKI, token: 'wiki-token-1234567890' });
  const conn = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'Fake Wiki', config: { transport: 'http', baseUrl: WIKI, token: 'wiki-token-1234567890' } });
  await t.ok('PUT', `/api/admin/connections/${conn.id}/endpoints`, { endpoints: found.endpoints });
  const preset = await t.ok('POST', '/api/admin/connections/presets', { connectionId: conn.id, name: 'Fake Wiki setup', description: 'Found by the setup' });
  assert.ok(preset.config.endpoints && preset.config.baseUrl === WIKI, 'the endpoints and the base URL are in the preset');
  assert.ok(!JSON.stringify(preset).includes('wiki-token'), 'no secret in a preset');
  assert.equal(JSON.parse(preset.config.endpoints).find((e: any) => e.path === '/characters').role, 'people');
  const file = await t.ok('GET', `/api/admin/connections/presets/${preset.id}/export`);
  assert.ok(file.config.endpoints && !JSON.stringify(file).includes('wiki-token'));
  // Another connection starts from it and keeps its own token.
  const second = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'Second Wiki', presetId: preset.id, config: { token: 'other-token-0987654321' } });
  const stored = JSON.parse(one<any>(t.deps.db, 'SELECT config FROM connections WHERE id = ?', second.id)!.config);
  assert.equal(stored.token, 'other-token-0987654321');
  assert.deepEqual(JSON.parse(stored.endpoints), JSON.parse(preset.config.endpoints));
  // And an imported preset file carries them too.
  const imported = await t.ok('POST', '/api/admin/connections/presets/import', { preset: file });
  assert.equal(imported.config.endpoints, preset.config.endpoints);
});

// ---- discovery without a spec ----------------------------------------------------------------------------------------------------------

test('CrawlGeneric_WithoutASpecItSamplesTheBaseUrlAndTheListUrlsGiven', async () => {
  const t = await boot();
  const out = await t.ok('POST', '/api/admin/connections/api-discover', { baseUrl: NOSPEC, listUrls: ['/articles'] });
  assert.equal(out.source, 'sample');
  assert.equal(out.specUrl, null);
  assert.ok(out.notes.some((n: string) => /No OpenAPI or Swagger spec/.test(n)));
  // One sample for the base URL and one for the list; the rest were spec lookups.
  assert.equal(nospec.calls.filter((c) => c === '' ).length, 1 + 0 + 0 || 1, 'the base URL once');
  assert.equal(nospec.calls.filter((c) => c === '/articles').length, 1, 'the list once');
  assert.ok(out.calls <= 12, `${out.calls}`);
  const art = out.endpoints.find((e: any) => e.path === '/articles');
  assert.equal(art.role, 'pages');
  assert.deepEqual([art.itemsPath, art.idField, art.titleField, art.bodyField, art.bodyFormat, art.summaryField, art.visibilityField, art.sharedValues, art.updatedField, art.tagsField, art.parentField],
    ['items', 'uuid', 'title', 'content', 'html', 'excerpt', 'private', 'false', 'modified', 'tags', 'parent']);
  assert.equal(art.use, true);
  assert.ok(art.confidence >= 0.5 && art.confidence <= 1);
  // The base URL named another endpoint: shown, not used, never called.
  const people = out.endpoints.find((e: any) => e.path === '/people');
  assert.ok(people, 'named on the base URL');
  assert.equal(people.use, false);
  assert.equal(nospec.calls.filter((c) => c === '/people').length, 0, 'it was not called');

  // Crawl it: the body is in the list, so every page is full at once; the DM-only flag holds.
  const conn = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'No spec', config: { transport: 'http', baseUrl: NOSPEC } });
  await t.ok('PUT', `/api/admin/connections/${conn.id}/endpoints`, { endpoints: out.endpoints });
  const wid = await t.world('Nospec World');
  const src = await t.ok('POST', `/api/admin/worlds/${wid}/sources`, { connectionId: conn.id, kind: 'api', name: 'Nospec', config: {}, defaultVisibility: 'party' });
  nospec.calls = [];
  const res = await t.ok('POST', `/api/admin/sources/${src.id}/sync?wait=1`, {});
  assert.deepEqual(nospec.calls, ['/articles'], 'one list call; the unused endpoint is never called');
  assert.equal(res.stats.indexCalls, 1);
  assert.deepEqual(depthCounts(t.deps.db, src.id), { total: 2, index: 0, summary: 0, full: 2, stale: 0 });
  const vault = one<any>(t.deps.db, 'SELECT * FROM pages WHERE world_id = ? AND title = ?', wid, 'The Vault');
  assert.equal(vault.visibility, 'dm');
  assert.equal(vault.parent_external, 'a-1');
  assert.equal(one<any>(t.deps.db, 'SELECT visibility FROM pages WHERE world_id = ? AND title = ?', wid, 'The Harbour').visibility, 'party');
  assert.ok(!(await t.call('GET', `/api/worlds/${wid}/library/search?q=gold`, t.admin)).text.includes('PERSONLEAK'));
});

test('CrawlGeneric_AnEndpointWithNoSpecAndNothingUsableStaysBlank', async () => {
  const t = await boot();
  const out = await t.ok('POST', '/api/admin/connections/api-discover', { baseUrl: NOSPEC, listUrls: ['/nothing-here'] });
  assert.ok(out.notes.some((n: string) => /nothing-here/.test(n)), 'it says the list did not answer');
  assert.ok(!out.endpoints.some((e: any) => e.use), 'nothing is switched on');
  const direct = await discoverApi(fake, { baseUrl: NOSPEC, listUrls: ['/articles'] });
  assert.ok(direct.calls >= 2);
});

// ---- calendars and pictures ----------------------------------------------------------------------------------------------

const MEDIA_ENDPOINTS = (over: Record<string, any> = {}) => [
  { path: '/pages', role: 'pages', use: true, key: 'pages', itemsPath: 'data', idField: 'id', titleField: 'title', bodyField: 'body', visibilityField: 'is_private', sharedValues: 'false' },
  { path: '/calendars', role: 'calendars', use: true, key: 'calendars', itemsPath: 'data', idField: 'id', titleField: 'name', monthsField: 'months', weekdaysField: 'weekdays', currentDateField: 'date', yearSuffixField: 'suffix', epochYearField: 'epoch', eventsField: 'events', visibilityField: 'is_private', sharedValues: 'false', ...(over.calendars ?? {}) },
  { path: '/images', role: 'images', use: true, key: 'images', itemsPath: 'data', idField: 'id', titleField: 'name', urlField: 'file', pageField: 'page', updatedField: 'updated', visibilityField: 'is_private', sharedValues: 'false', ...(over.images ?? {}) },
  { path: '/unused-images', role: 'images', use: false, key: 'unused', itemsPath: 'data', idField: 'id', urlField: 'file' },
];

async function mediaWorld(t: Awaited<ReturnType<typeof boot>>, opts: { audience?: string; endpoints?: any[] } = {}) {
  mediaReset();
  const conn = await t.ok('POST', '/api/admin/connections', { kind: 'api', name: 'Media app', config: { transport: 'http', baseUrl: MEDIA, token: 'media-token-1234567890' } });
  await t.ok('PUT', `/api/admin/connections/${conn.id}/endpoints`, { endpoints: opts.endpoints ?? MEDIA_ENDPOINTS() });
  const wid = await t.world('Media World');
  const src = await t.ok('POST', `/api/admin/worlds/${wid}/sources`, { connectionId: conn.id, kind: 'api', name: 'Media', config: {}, defaultVisibility: 'party', ...(opts.audience ? { audience: opts.audience } : {}) });
  const sync = (body: unknown = {}) => t.ok('POST', `/api/admin/sources/${src.id}/sync?wait=1`, body);
  return { wid, sid: src.id as string, conn, sync };
}
const pageByTitle = (t: Awaited<ReturnType<typeof boot>>, wid: string, title: string) => (t.deps.library.list(wid, dmViewer) as any[]).find((p) => p.title === title).id as string;
const getPage = (t: Awaited<ReturnType<typeof boot>>, wid: string, token: string, pid: string) => t.call('GET', `/api/worlds/${wid}/library/pages/${pid}`, token);
const imageRow = (t: Awaited<ReturnType<typeof boot>>, ext: string) => one<any>(t.deps.db, 'SELECT * FROM intake_images WHERE external_id = ?', `img:images:${ext}`);

test('CrawlGeneric_CalendarsBecomeWorldCalendarsWithMonthsWeekdaysDateAndEvents', async () => {
  const t = await boot({});
  const w = await mediaWorld(t);
  await w.sync();
  const dm = { role: 'dm' as const };
  const cals = calendarsFor(t.deps.db, w.wid, dm);
  assert.deepEqual(cals.map((c) => c.name), ['Harptos', 'Hidden calendar'], 'a calendar with no months is skipped');
  const h = cals.find((c) => c.name === 'Harptos')!;
  assert.deepEqual(h.definition.months, [{ name: 'Hammer', days: 30 }, { name: 'Midwinter', days: 1, intercalary: true }, { name: 'Alturiak', days: 30 }]);
  assert.deepEqual(h.definition.weekdays, ['One', 'Two'], 'weekdays may be names or objects with a name');
  assert.equal(h.definition.yearSuffix, 'DR');
  assert.deepEqual(h.current, { year: 1492, month: 1, day: 5 });
  assert.equal(h.visibility, 'party');
  // Fail closed: the calendar the app marks private is the DM's, and so is every event with no shared flag of its own.
  assert.equal(cals.find((c) => c.name === 'Hidden calendar')!.visibility, 'dm');
  const player = { role: 'player' as const };
  assert.deepEqual(calendarsFor(t.deps.db, w.wid, player).map((c) => c.name), ['Harptos']);
  const tlDm = timelinesFor(t.deps.db, w.wid, dm).find((x: any) => x.name === 'Harptos events');
  assert.deepEqual(tlDm.groups[0].events.map((e: any) => [e.name, e.visibility]), [['Festival', 'party'], ['SECRETEVENT', 'dm'], ['No flag', 'dm']]);
  const tlPlayer = timelinesFor(t.deps.db, w.wid, player);
  assert.deepEqual(tlPlayer.flatMap((x: any) => x.groups.flatMap((g: any) => g.events.map((e: any) => e.name))), ['Festival']);
  assert.ok(!JSON.stringify(tlPlayer).includes('SECRETEVENT'));
  // The source's audience can keep every calendar DM-only.
  const t2 = await boot({});
  const w2 = await mediaWorld(t2, { audience: 'dm' });
  await w2.sync();
  assert.deepEqual(calendarsFor(t2.deps.db, w2.wid, player), []);
});

test('CrawlGeneric_PicturesAreDownloadedWithinTheLimitsAndLinkedToTheirPages', async () => {
  const t = await boot({ ALX_IMAGE_MAX_BYTES: '2000' });
  const w = await mediaWorld(t);
  const out = await w.sync();
  // Stored: the ones that are PNG, JPEG, GIF or WebP, small enough, and on an allowed host. Refused: too big, SVG, not really a picture, a private address, a redirect to another host.
  const stored = all<any>(t.deps.db, 'SELECT external_id, mime FROM intake_images ORDER BY external_id').map((r) => r.external_id.replace('img:images:', ''));
  assert.deepEqual(stored, ['i1', 'i2', 'i3', 'i9']);
  assert.ok(all<any>(t.deps.db, 'SELECT mime FROM intake_images').every((r) => r.mime === 'image/png'));
  assert.ok(!media.calls.includes('PRIVATE'), 'a private address is never fetched');
  assert.ok(!media.calls.includes('CDN/pics/redirected.png'), 'a redirect to another host is not followed');
  assert.ok(!media.calls.some((c) => c.startsWith('/unused-images') || c.includes('never')), 'an endpoint the DM left unused is never called');
  // The token goes to the API's own host and nowhere else.
  assert.equal(media.auth['/files/i1.png'], 'Bearer media-token-1234567890');
  assert.equal(media.auth['CDN/pics/i3.png'], null, 'an absolute address on another host is fetched without the token');
  // Calls: three lists (pages, calendars, images) are the index; every download is a detail call.
  assert.equal(out.stats.indexCalls, 3);
  assert.equal(out.stats.detailCalls, 8, 'each attempted download is counted');
  assert.equal(one<any>(t.deps.db, 'SELECT detail_calls AS n FROM connections_source_state WHERE source_id = ?', w.sid).n, 8);

  // The page links to its picture, and the picture is served through a signed address.
  const p1 = pageByTitle(t, w.wid, 'Public page');
  const dmPage = (await getPage(t, w.wid, t.admin, p1)).body;
  assert.match(dmPage.banner, /^\/api\/media\/intake\/[\w.-]+$/);
  const file = await fetch(t.base + dmPage.banner);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())].slice(0, 4), [0x89, 0x50, 0x4e, 0x47]);
  assert.equal((await fetch(t.base + '/api/media/intake/garbage.token')).status, 404);

  // A player sees the picture of a shared page...
  const tok = await t.addPlayer(w.wid);
  const playerPage = (await getPage(t, w.wid, tok.token, p1)).body;
  assert.match(playerPage.banner, /^\/api\/media\/intake\//);
  assert.equal((await fetch(t.base + playerPage.banner)).status, 200);
  // ...but never the picture of a private page, nor a private picture of a shared page, even with a ticket made for them.
  const p2 = pageByTitle(t, w.wid, 'Private page');
  assert.equal((await getPage(t, w.wid, tok.token, p2)).status, 404);
  assert.match((await getPage(t, w.wid, t.admin, p2)).body.banner, /^\/api\/media\/intake\//, 'the DM has it');
  const p3 = pageByTitle(t, w.wid, 'Shared page with a private picture');
  assert.equal((await getPage(t, w.wid, tok.token, p3)).body.banner, null, 'the picture the app marks private is the DM\'s');
  assert.match((await getPage(t, w.wid, t.admin, p3)).body.banner, /^\/api\/media\/intake\//);
  for (const ext of ['i2', 'i9']) {
    const forged = mintTicket({ w: w.wid, k: 'intake', f: imageRow(t, ext).id, a: tok.accountId });
    assert.equal((await fetch(`${t.base}/api/media/intake/${forged}`)).status, 404, `a player's ticket for ${ext} gets nothing`);
  }
  assert.ok(!(JSON.stringify(playerPage)).includes(imageRow(t, 'i2').id), 'no id of a private picture reaches a player');

  // Hiding the page takes the picture away at once: the ticket stays valid but the permission is checked again.
  run(t.deps.db, `UPDATE pages SET visibility = 'dm', player_body = NULL WHERE id = ?`, p1);
  assert.equal((await fetch(t.base + playerPage.banner)).status, 404);

  // Nothing is downloaded again when nothing changed, and a refused picture is not asked for again.
  const files = media.files;
  const again = await w.sync();
  assert.equal(media.files, files, 'no picture was fetched again');
  assert.equal(again.stats.detailCalls, 0);
  assert.equal(again.stats.indexCalls, 3, 'the lists are read again, nothing else');
  // A picture that changed at the source is fetched again, alone.
  media.updated.i1 = 'v2';
  const third = await w.sync();
  assert.equal(media.files, files + 1);
  assert.equal(third.stats.detailCalls, 1);
  assert.match(imageRow(t, 'i1').marker, /v2$/);
});

test('CrawlGeneric_PicturesAreDownloadedAFewAtATimeAndAnUnusedEndpointDropsThem', async () => {
  const t = await boot({ ALX_IMAGES_PER_RUN: '2', ALX_IMAGE_MAX_BYTES: '2000' });
  const w = await mediaWorld(t);
  const first = await w.sync();
  assert.equal(first.stats.detailCalls, 2, 'the run downloads at most its limit');
  assert.equal(all<any>(t.deps.db, 'SELECT 1 FROM intake_images').length, 2);
  for (let i = 0; i < 4; i++) await w.sync();
  assert.deepEqual(all<any>(t.deps.db, 'SELECT external_id FROM intake_images ORDER BY external_id').map((r) => r.external_id.replace('img:images:', '')), ['i1', 'i2', 'i3', 'i9']);
  // The DM turns the images endpoint off: it is not called again, and its pictures are gone.
  await t.ok('PUT', `/api/admin/connections/${w.conn.id}/endpoints`, { endpoints: MEDIA_ENDPOINTS({ images: { use: false } }) });
  media.calls = [];
  await w.sync();
  assert.ok(!media.calls.some((c) => c.startsWith('/images') || c.startsWith('/files') || c.startsWith('/unused-images')), `not called: ${media.calls}`);
  assert.equal(all<any>(t.deps.db, 'SELECT 1 FROM intake_images').length, 0);
  // A source set to DM-only shows no picture to players at all.
  const t2 = await boot({ ALX_IMAGE_MAX_BYTES: '2000' });
  const w2 = await mediaWorld(t2, { audience: 'dm' });
  await w2.sync();
  const tok = await t2.addPlayer(w2.wid);
  assert.equal((t2.deps.library.list(w2.wid, { accountId: 'p', role: 'player' }) as any[]).length, 0);
  assert.equal((await getPage(t2, w2.wid, tok.token, pageByTitle(t2, w2.wid, 'Public page'))).status, 404);
  assert.equal(all<any>(t2.deps.db, 'SELECT 1 FROM intake_images').length, 4, 'the DM still has them');
});

test('CrawlGeneric_CalendarAndPictureEndpointsAreGuessedWithTheirFields', async () => {
  const found = await discoverApi(fake, { baseUrl: MEDIA, listUrls: ['/calendars', '/images'] });
  const cal = found.endpoints.find((e) => e.path === '/calendars')!;
  assert.equal(cal.role, 'calendars');
  assert.deepEqual([cal.monthsField, cal.weekdaysField, cal.currentDateField, cal.epochYearField, cal.yearSuffixField, cal.eventsField, cal.visibilityField, cal.sharedValues], ['months', 'weekdays', 'date', 'epoch', 'suffix', 'events', 'is_private', 'false']);
  assert.equal(cal.use, true, 'a calendar with months is switched on');
  const img = found.endpoints.find((e) => e.path === '/images')!;
  assert.equal(img.role, 'images');
  assert.deepEqual([img.urlField, img.pageField, img.updatedField], ['file', 'page', 'updated']);
  assert.equal(img.use, true);
  // The earlier test's spec lists images with no address field: recognised, but unusable until the DM maps one.
  const noUrl = mapRoleFields('images', [{ name: 'id', kind: 'string', samples: ['a'] }, { name: 'filename', kind: 'string', samples: ['a.png'] }], mapFields([{ name: 'id', kind: 'string', samples: ['a'] }, { name: 'filename', kind: 'string', samples: ['a.png'] }]))!;
  assert.equal(noUrl.fields.urlField, undefined);
  assert.ok(noUrl.notes.some((n) => /No address field/.test(n)));
  assert.equal(endpointUsable({ path: '/x', role: 'images', use: false, key: 'x', idField: 'id' }), false);
  assert.equal(endpointUsable({ path: '/x', role: 'images', use: false, key: 'x', idField: 'id', detailPath: '/x/{id}/download' }), true, 'a download path is enough');
  assert.equal(endpointUsable({ path: '/x', role: 'calendars', use: false, key: 'x', idField: 'id', titleField: 'name' }), false, 'a calendar needs its months mapped');
  // The new keys survive the review's save, and nothing unknown does.
  const eps = cleanEndpoints([{ path: '/c', role: 'calendars', use: true, monthsField: 'months', eventsField: 'events', pageField: 'x', evil: 1 }]);
  assert.deepEqual([eps[0].monthsField, eps[0].eventsField, eps[0].pageField, (eps[0] as any).evil], ['months', 'events', 'x', undefined]);
});

test('CrawlGeneric_AddressesOnPrivateHostsAreNeverFetched', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.0.1', '169.254.169.254', '[::1]', 'printer.local', 'db.internal', '100.64.0.1']) assert.equal(privateHost(h), true, h);
  for (const h of ['cdn.example.net', '93.184.216.34', '172.32.0.1']) assert.equal(privateHost(h), false, h);
});

// ---- several pictures on one page, and maps --------------------------------------------------------------------------------

test('CrawlGeneric_APageShowsAllItsPicturesAndTheSecondOneNeverReachesAPlayerWhenItIsDmOnly', async () => {
  const t = await boot({ ALX_IMAGE_MAX_BYTES: '2000' });
  const w = await mediaWorld(t);
  await w.sync();
  const tok = await t.addPlayer(w.wid);
  const p1 = pageByTitle(t, w.wid, 'Public page');
  // Page 1 has two stored pictures (Portrait, Elsewhere); the first by the source's id is the banner.
  const dm = (await getPage(t, w.wid, t.admin, p1)).body;
  assert.deepEqual(dm.pictures.map((x: any) => x.name), ['Portrait', 'Elsewhere']);
  assert.equal(dm.banner, dm.pictures[0].url);
  assert.deepEqual(dm.pictures.map((x: any) => x.primary), [true, false]);
  for (const pic of dm.pictures) assert.equal((await fetch(t.base + pic.url)).status, 200);
  const both = (await getPage(t, w.wid, tok.token, p1)).body;
  assert.deepEqual(both.pictures.map((x: any) => x.name), ['Portrait', 'Elsewhere'], 'both are shared with the page');

  // The second picture is marked private at the source: the DM still has it, a player has no sign of it.
  run(t.deps.db, "UPDATE intake_images SET visibility = 'dm' WHERE external_id = 'img:images:i3'");
  const asPlayer = await getPage(t, w.wid, tok.token, p1);
  assert.deepEqual(asPlayer.body.pictures.map((x: any) => x.name), ['Portrait']);
  assert.ok(!asPlayer.text.includes('Elsewhere') && !asPlayer.text.includes(imageRow(t, 'i3').id), 'no name or id of the DM-only picture reaches a player');
  assert.equal((await getPage(t, w.wid, t.admin, p1)).body.pictures.length, 2);
  const forged = mintTicket({ w: w.wid, k: 'intake', f: imageRow(t, 'i3').id, a: tok.accountId });
  assert.equal((await fetch(`${t.base}/api/media/intake/${forged}`)).status, 404);
  // If the first picture is the DM-only one, the player's banner is the next one, never the private one.
  run(t.deps.db, "UPDATE intake_images SET visibility = 'dm' WHERE external_id = 'img:images:i1'");
  run(t.deps.db, "UPDATE intake_images SET visibility = 'party' WHERE external_id = 'img:images:i3'");
  const swapped = (await getPage(t, w.wid, tok.token, p1)).body;
  assert.deepEqual(swapped.pictures.map((x: any) => x.name), ['Elsewhere']);
  assert.equal(swapped.banner, swapped.pictures[0].url);
  // Hiding the page takes every picture away at once.
  run(t.deps.db, "UPDATE pages SET visibility = 'dm', player_body = NULL WHERE id = ?", p1);
  assert.equal((await getPage(t, w.wid, tok.token, p1)).status, 404);
  assert.equal((await fetch(t.base + swapped.pictures[0].url)).status, 404);
});

const MAP_ENDPOINTS = () => [...MEDIA_ENDPOINTS(), { path: '/battlemaps', role: 'map', use: true, key: 'maps', itemsPath: 'data', idField: 'id', titleField: 'name', urlField: 'file', pageField: 'page', updatedField: 'updated', visibilityField: 'is_private', sharedValues: 'false' }];

test('CrawlGeneric_MapEndpointsImportMapsWithTheirOwnSizeCapAndTheMapPageCanPickThem', async () => {
  const t = await boot({ ALX_IMAGE_MAX_BYTES: '2000', ALX_MAP_MAX_BYTES: '5000' });
  const w = await mediaWorld(t, { endpoints: MAP_ENDPOINTS() });
  const out = await w.sync();
  const maps = all<any>(t.deps.db, "SELECT external_id, kind, size, page_external FROM intake_images WHERE kind = 'map' ORDER BY external_id");
  assert.deepEqual(maps.map((m) => [m.external_id.replace('img:maps:', ''), m.page_external]), [['m1', 'p1'], ['m2', 'p2'], ['m4', null]], 'a map over ALX_MAP_MAX_BYTES is refused; a map with no page is stored but on no page');
  assert.ok(maps[0].size > 2000, 'maps may be bigger than pictures');
  assert.equal(all<any>(t.deps.db, "SELECT 1 FROM intake_images WHERE kind = 'picture'").length, 4, 'ordinary pictures are still capped at their own size');
  assert.equal(out.stats.indexCalls, 4, 'the map list is one more list call');
  // A map is on its page like any picture: the page's pictures list marks it.
  const p1 = pageByTitle(t, w.wid, 'Public page');
  const dm = (await getPage(t, w.wid, t.admin, p1)).body;
  assert.ok(dm.pictures.some((x: any) => x.map && x.name === 'Harbour map'));
  assert.equal(dm.pictures.filter((x: any) => !x.map).length, 2);
  // The Map page lists imported maps: the DM all of them, a player only maps of pages shared with them.
  const dmMaps = (await t.call('GET', `/api/worlds/${w.wid}/intake/map-images`, t.admin)).body;
  assert.deepEqual(dmMaps.map((m: any) => m.name), ['Harbour map', 'Loose map', 'Vault map']);
  assert.equal(dmMaps.find((m: any) => m.name === 'Harbour map').page.title, 'Public page');
  const tok = await t.addPlayer(w.wid);
  const playerMaps = (await t.call('GET', `/api/worlds/${w.wid}/intake/map-images`, tok.token)).body;
  assert.deepEqual(playerMaps.map((m: any) => m.name), ['Harbour map']);
  assert.ok(!JSON.stringify(playerMaps).includes(imageRow(t, 'm2')?.id ?? 'none'));
  const vault = one<any>(t.deps.db, "SELECT id FROM intake_images WHERE external_id = 'img:maps:m2'");
  const loose = one<any>(t.deps.db, "SELECT id FROM intake_images WHERE external_id = 'img:maps:m4'");
  for (const id of [vault.id, loose.id]) assert.equal((await fetch(`${t.base}/api/media/intake/${mintTicket({ w: w.wid, k: 'intake', f: id, a: tok.accountId })}`)).status, 404);
  assert.equal((await fetch(t.base + playerMaps[0].url)).status, 200);
  // Detail-tier budget: map downloads are detail calls and stay within the run's picture limit.
  assert.equal(out.stats.detailCalls, 8 + 4, 'every attempted download counts');
  const again = await w.sync();
  assert.equal(again.stats.detailCalls, 0, 'nothing is downloaded again');
});

test('CrawlGeneric_AMapRoleIsGuessedForMapFileEndpointsAndReviewedLikePictures', () => {
  assert.equal(guessRole('/maps').role, 'places', 'a plain /maps list stays a list of places (a map is also a page)');
  assert.equal(guessRole('/battlemaps').role, 'map');
  assert.equal(guessRole('/map-images').role, 'map');
  assert.equal(guessRole('/world-maps').role, 'map');
  const eps = cleanEndpoints([{ path: '/map-images', role: 'map', use: true, idField: 'id', urlField: 'file' }]);
  assert.equal(eps[0].role, 'map');
  assert.equal(eps[0].use, true);
  assert.equal(endpointUsable(eps[0]), true);
  assert.equal(endpointUsable({ ...eps[0], urlField: undefined, detailPath: undefined }), false);
  const f = mapRoleFields('map', [{ name: 'id', kind: 'string', samples: ['1'] }, { name: 'name', kind: 'string', samples: ['A'] }, { name: 'file_url', kind: 'string', samples: ['/f/a.png'] }, { name: 'page_id', kind: 'string', samples: ['p1'] }], { fields: { idField: 'id', titleField: 'name' }, score: 0.5, notes: [] });
  assert.equal(f?.fields.urlField, 'file_url');
  assert.equal(f?.fields.pageField, 'page_id');
});
