// The generic API connector sets itself up: it finds an OpenAPI spec (or
// guesses from a sample), proposes endpoints with roles and mappings for the
// DM to review, saves the result as a preset, and crawls in tiers.
// Endpoints left unused are never called. Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { one } from '../src/core/db.ts';
import { discoverApi, guessRole, mapFields } from '../src/intake/connectors/apiSetup.ts';
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
    '/characters/{id}': { get: { tags: ['Characters'], parameters: [{ name: 'id', in: 'path', required: true }], responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { data: ref('Character') } } } } } } } },
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

const fake = (async (url: any, init?: any) => {
  for (const h of [wikiFetch, nospecFetch]) { const r = h(String(url), init); if (r) return r; }
  return json({ error: 'unexpected ' + url }, 404);
}) as typeof fetch;

async function boot() {
  resetBuckets();
  wiki.calls = []; wiki.auth = []; nospec.calls = [];
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
  const world = async (name: string) => (await ok('POST', '/api/admin/worlds', { name, dmAccountId: a.account.id })).id as string;
  return { ...made, call, ok, admin, world, accountId: a.account.id as string };
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
