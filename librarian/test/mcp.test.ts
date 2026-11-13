// MCP sources against a fake MCP server that speaks Streamable HTTP
// (session header, SSE replies) and returns mcp-kanka shaped data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { HttpMcp, jsonOf } from '../src/core/mcp.ts';
import { Library } from '../src/core/library.ts';
import { openDb, run } from '../src/core/db.ts';
import { runSync } from '../src/intake/sync.ts';
import { kankaBlocks } from '../src/intake/connectors/kanka.ts';
import { lkBlocks } from '../src/intake/connectors/legendkeeper.ts';
import { readOnlyMcp } from '../src/intake/registry.ts';
import { blocksToMarkdown } from '../src/intake/model.ts';

const ENTITIES = [
  { id: 1, entity_id: 101, name: 'Harbour Town', entity_type: 'location', type: 'City', entry: 'A port. Ask [entity:102|the harbourmaster].', tags: ['coast'], is_hidden: false },
  { id: 2, entity_id: 102, name: 'Harbourmaster', entity_type: 'character', type: 'NPC', entry: 'Lives in [entity:101].', tags: [], is_hidden: false, parent_id: null },
  { id: 3, entity_id: 103, name: 'Hidden Cult', entity_type: 'organization', entry: 'They run [entity:101].', tags: [], is_hidden: true },
  { id: 4, entity_id: 104, name: 'No Flag', entity_type: 'note', entry: 'Missing is_hidden.' },
];
const POSTS: Record<number, any[]> = {
  101: [{ id: 9, name: 'Rumours', entry: 'Fish is cheap.', is_hidden: false }, { id: 10, name: 'DM notes', entry: 'The docks are cursed.', is_hidden: true }],
  102: [{ id: 11, name: 'Admin post', entry: 'Secretly a spy.', is_hidden: false }],
};

function fakeMcp() {
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.method === 'DELETE') return res.end();
    if (req.headers.authorization !== 'Bearer t0ken') { res.statusCode = 401; return res.end(); }
    const m = JSON.parse(body);
    if (m.method !== 'initialize' && req.headers['mcp-session-id'] !== 'S1') { res.statusCode = 400; return res.end(); }
    if (m.id === undefined) { res.statusCode = 202; return res.end(); }
    let result: any;
    if (m.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-kanka' } };
    else if (m.method === 'tools/list') result = { tools: [{ name: 'find_entities' }, { name: 'delete_entities' }] };
    else if (m.method === 'tools/call') {
      const { name, arguments: a } = m.params;
      calls.push(name);
      let out: any;
      if (name === 'find_entities') out = { entities: a.page === 1 ? ENTITIES.filter((e) => e.entity_type === a.entity_type) : [], sync_info: {} };
      else if (name === 'get_entities') out = a.entity_ids.map((id: number) => ({ ...ENTITIES.find((e) => e.entity_id === id), success: true, posts: POSTS[id] ?? [] }));
      else out = { error: 'no' };
      result = { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false };
    }
    res.setHeader('Mcp-Session-Id', 'S1');
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`);
  });
  return { server, calls };
}

test('TestMcp_HttpClientHandshakeAndSse', async () => {
  const { server } = fakeMcp();
  server.listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  try {
    const c = new HttpMcp(url, 't0ken', fetch);
    assert.deepEqual((await c.listTools()).map((t) => t.name), ['find_entities', 'delete_entities']);
    const r = await c.call('find_entities', { entity_type: 'location', page: 1 });
    assert.equal(jsonOf(r).entities[0].name, 'Harbour Town');
    await assert.rejects(new HttpMcp(url, 'wrong', fetch).listTools(), /refused the token/);
  } finally {
    server.close();
  }
});

test('TestMcp_KankaImportFailsClosed', async () => {
  const { server, calls } = fakeMcp();
  server.listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const { app } = createApp({ env: { ALX_ADMIN_TABLE_LOGIN: '1' }, noScheduler: true });
  const api = app.listen(0);
  await new Promise((r) => api.once('listening', r));
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return r.json() as Promise<any>;
  };
  try {
    const a = await call('POST', '/api/setup', null, { username: 'wizard', password: 'correct horse battery' });
    const w = await call('POST', '/api/admin/worlds', a.token, { name: 'Test', dmAccountId: a.account.id });
    const inv = await call('POST', `/api/worlds/${w.id}/invites`, a.token, { role: 'player' });
    const p = await call('POST', '/api/join', null, { code: inv.code, username: 'jess', password: 'player pass 123' });
    const src = await call('POST', `/api/admin/worlds/${w.id}/sources`, a.token, { kind: 'mcp', name: 'Kanka MCP', defaultVisibility: 'party', config: { profile: 'kanka', url, token: 't0ken' } });
    assert.equal((await call('GET', `/api/admin/worlds/${w.id}/sources`, a.token))[0].config.token, '••••', 'token never comes back');
    assert.equal((await call('POST', `/api/admin/sources/${src.id}/sync?wait=1`, a.token)).pages, 4);
    assert.ok(calls.every((t) => ['find_entities', 'get_entities'].includes(t)), 'only read tools were called');

    const titles = (await call('GET', `/api/worlds/${w.id}/library/pages`, p.token)).map((x: any) => x.title).sort();
    assert.deepEqual(titles, ['Harbour Town', 'Harbourmaster'], 'hidden and unflagged entities are DM-only');
    const town = (await call('GET', `/api/worlds/${w.id}/library/pages`, p.token)).find((x: any) => x.title === 'Harbour Town');
    const pg = await call('GET', `/api/worlds/${w.id}/library/pages/${town.id}`, p.token);
    assert.ok(pg.body.includes('[[Harbourmaster|the harbourmaster]]'));
    assert.deepEqual(pg.tags, ['coast']);
    for (const leak of ['cursed', 'Fish is cheap']) assert.ok(!pg.body.includes(leak), `posts are DM-only by default: ${leak}`);
    const npc = (await call('GET', `/api/worlds/${w.id}/library/search?q=spy`, p.token));
    assert.equal(npc.length, 0);
    const dmBody = (await call('GET', `/api/worlds/${w.id}/library/pages/${town.id}`, a.token)).body;
    assert.ok(dmBody.includes('cursed') && dmBody.includes('Fish is cheap'));
  } finally {
    api.close();
    server.close();
  }
});

test('TestMcp_KankaBlocksAndMentions', () => {
  const md = blocksToMarkdown(kankaBlocks('<p>Ask [entity:5|her] or <strong>[entity:9]</strong>.</p>'), (m) => (m.ref === 'kanka:5' ? 'Odda' : null));
  assert.equal(md, 'Ask [[Odda|her]] or (hidden).');
});

test('TestMcp_ReadOnlyGuardRefusesWrites', async () => {
  const fake = { call: async () => ({ text: '{}', structured: null, isError: false }), listTools: async () => [], close() {} };
  const g = readOnlyMcp(fake as any, ['api_request', 'find_entities', 'delete_entities']);
  await assert.doesNotReject(g.call('find_entities', {}));
  assert.throws(() => g.call('delete_entities', {}), /not a read tool/, 'write-sounding names are refused even if listed');
  assert.throws(() => g.call('create_entities', {}), /not a read tool/);
  assert.throws(() => g.call('api_request', { method: 'POST', path: '/x' }), /non-GET/);
});

test('TestMcp_LegendKeeperBlocksKeepLayout', () => {
  const b = lkBlocks([
    { kind: 'infobox', layout: 'wrapRight', width: 40, rows: [{ kind: 'keyValue', title: 'Facts', rows: [{ key: 'Status', content: [{ text: 'alive' }] }] }] },
    { kind: 'paragraph', content: [{ text: 'Hi ', bold: true }, { mention: { resourceId: 'abc', name: 'Fuji' } }] },
    { kind: 'secret', children: [{ kind: 'paragraph', content: [{ text: 'hush' }] }] },
    { kind: 'someFutureBlock', foo: 1 },
  ]);
  assert.deepEqual(b.map((x) => x.kind), ['infobox', 'paragraph', 'secret', 'unsupported']);
  assert.equal((b[0] as any).width, 40);
  assert.deepEqual((b[1] as any).content[1], { mention: { ref: 'abc', name: 'Fuji' } });
});

test('TestMcp_LegendKeeperImportInheritsHiddenAndScrubsLinks', async () => {
  // Synthetic LegendKeeper data in the shapes the live API returns.
  const R = [
    { id: 'root1', name: 'World', parentId: null, isHidden: false, tags: [], documents: [{ id: 'd0', name: 'Main', type: 'page' }] },
    { id: 'town1', name: 'Port Town', parentId: 'root1', isHidden: false, tags: ['town'], iconGlyph: 'anchor', documents: [{ id: 'd1', name: 'Main', type: 'page' }] },
    { id: 'dmfold', name: 'DM Folder', parentId: 'root1', isHidden: true, tags: ['dm'], documents: [] },
    { id: 'plot1', name: 'Secret Plot', parentId: 'dmfold', isHidden: false, tags: [], documents: [{ id: 'd2', name: 'Main', type: 'page' }] },
    { id: 'npc1', name: 'Visible NPC', parentId: 'root1', isHidden: false, tags: [], documents: [{ id: 'd3', name: 'Main', type: 'page' }, { id: 'd4', name: 'GM notes', type: 'page' }] },
    { id: 'map1', name: 'Map', parentId: 'root1', isHidden: false, tags: [], documents: [{ id: 'd5', name: 'Map', type: 'map' }] },
  ];
  const P = (t: string) => ({ kind: 'paragraph', content: [{ text: t }] });
  const DOCS: Record<string, any[]> = {
    d0: [P('Welcome.')],
    d1: [{ kind: 'paragraph', content: [{ text: 'A port. See ' }, { mention: { resourceId: 'plot1', name: 'Secret Plot' } }, { text: ' and ' }, { mention: { resourceId: 'npc1', text: 'the NPC' } }, { text: '.' }] },
      { kind: 'secret', children: [P('Smugglers run the docks.')] }, P('Fish market.'), { kind: 'futureWidget' }],
    d2: [P('The plot twist.')],
    d3: [P('Friendly.')],
    d4: [P('Is a spy.')],
  };
  const calls: any[] = [];
  const ok = (x: any) => ({ text: JSON.stringify(x), structured: null, isError: false });
  const fake = {
    async call(tool: string, args: any) {
      calls.push([tool, args]);
      if (tool !== 'api_request') return { text: 'no', structured: null, isError: true };
      if (args.path === '/resources') return args.query.cursor ? ok({ data: R.slice(3), hasMore: false }) : ok({ data: R.slice(0, 3), hasMore: true, nextCursor: 'c2' });
      const m = /^\/resources\/([^/]+)(?:\/docs\/([^/]+)\/blocks)?$/.exec(args.path);
      if (!m) return ok({});
      const r = R.find((x) => x.id === m[1])!;
      if (m[2]) return ok({ id: m[2], blocks: DOCS[m[2]] });
      return ok({ ...r, permissions: {}, documents: r.documents.map((d) => ({ ...d, isHidden: d.id === 'd4' })), properties: r.id === 'town1' ? [{ kind: 'keyValue', title: 'Facts', isHidden: false, rows: [{ key: 'Ruler', content: [{ mention: { resourceId: 'plot1' } }] }, { key: 'DM notes', content: [{ text: 'bribed' }] }] }] : [], ancestors: [] });
    },
    async listTools() { return []; },
    close() {},
  };
  const db = openDb(':memory:');
  run(db, `INSERT INTO worlds (id, slug, name, created_at) VALUES ('w', 'w', 'W', 'now')`);
  run(db, `INSERT INTO accounts (id, username, display_name, created_at) VALUES ('a', 'a', 'a', 'now')`);
  run(db, `INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s', 'w', 'legendkeeper-mcp', 'LK', '{"url":"http://x/mcp"}', 'party')`);
  const lib = new Library(db, null);
  const out = await runSync({ db, library: lib, dataDir: null, vaultsDir: null, fetch, env: {}, mcp: fake as any }, 's', 'a');
  assert.equal(out.status, 'ok', out.error);
  assert.equal(out.stats.pages, 6, 'pages, and the map document as a page of its own');
  assert.ok(calls.every(([t, a]) => t === 'api_request' && a.method === 'GET'));
  const player = { accountId: 'p', role: 'player' as const };
  assert.deepEqual(lib.list('w', player).map((p: any) => p.title).sort(), ['Map', 'Port Town', 'Visible NPC', 'World'], 'hidden parent and hidden doc are DM-only');
  const town = lib.list('w', player).find((p: any) => p.title === 'Port Town') as any;
  const pg = lib.get('w', town.id, player) as any;
  const all = JSON.stringify(pg);
  for (const leak of ['Smugglers', 'Secret Plot', 'bribed', 'futureWidget', 'plot1']) assert.ok(!all.includes(leak), leak);
  assert.ok(pg.body.includes('Fish market') && pg.body.includes('[[Visible NPC|the NPC]]') && pg.body.includes('(hidden)'));
  assert.deepEqual(pg.icon, { glyph: 'anchor' });
  assert.deepEqual(pg.properties, [{ title: 'Facts', rows: [{ key: 'Ruler', value: [{ text: '(hidden)' }] }] }], 'DM rows and hidden links removed from facts');
  assert.equal(Object.values(pg.links).length, 1, 'only the visible NPC is linkable');
  assert.equal(lib.search('w', 'plot', player).length, 0);
  // The DM sees the whole page, secret block included.
  const dmPage = lib.get('w', town.id, { accountId: 'a', role: 'dm' }) as any;
  assert.ok(dmPage.blocks.some((b: any) => b.kind === 'secret') && JSON.stringify(dmPage).includes('Smugglers'));
  // A second sync with a page gone removes it.
  R.splice(R.findIndex((x) => x.id === 'npc1'), 1);
  const again = await runSync({ db, library: lib, dataDir: null, vaultsDir: null, fetch, env: {}, mcp: fake as any }, 's', 'a');
  assert.equal(again.stats.removed, 2);
});
