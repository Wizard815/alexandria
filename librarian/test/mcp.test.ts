// MCP sources against a fake MCP server that speaks Streamable HTTP
// (session header, SSE replies) and returns mcp-kanka shaped data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { HttpMcp, jsonOf } from '../src/core/mcp.ts';
import { kankaMentions, lkLinks, READ_TOOLS, stripLkHeader, syncSource } from '../src/core/sources.ts';
import { Library } from '../src/core/library.ts';
import { openDb, run } from '../src/core/db.ts';

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
  const { app } = createApp({ env: {} });
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
    assert.equal((await call('POST', `/api/admin/sources/${src.id}/sync`, a.token)).pages, 4);
    assert.ok(calls.every((t) => READ_TOOLS.has(t)), 'only read tools were called');

    const titles = (await call('GET', `/api/worlds/${w.id}/library/pages`, p.token)).map((x: any) => x.title).sort();
    assert.deepEqual(titles, ['Harbour Town', 'Harbourmaster'], 'hidden and unflagged entities are DM-only');
    const town = (await call('GET', `/api/worlds/${w.id}/library/pages`, p.token)).find((x: any) => x.title === 'Harbour Town');
    const pg = await call('GET', `/api/worlds/${w.id}/library/pages/${town.id}`, p.token);
    assert.ok(pg.body.includes('[[Harbourmaster|the harbourmaster]]'));
    assert.deepEqual(pg.frontmatter.tags, ['coast']);
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

test('TestMcp_KankaMentions', () => {
  const names = new Map([[5, 'Odda']]);
  assert.equal(kankaMentions('[entity:5] and [entity:5|her] and [entity:9|someone] and [entity:9]', names), '[[Odda]] and [[Odda|her]] and [[someone]] and (hidden)');
});

test('TestMcp_LegendKeeperImportInheritsHiddenAndScrubsLinks', async () => {
  // Synthetic LegendKeeper data in the shapes the live MCP returns.
  const R = [
    { id: 'root1', name: 'World', parentId: null, isHidden: false, tags: [], documents: [{ id: 'd0', name: 'Main', type: 'page' }] },
    { id: 'town1', name: 'Port Town', parentId: 'root1', isHidden: false, tags: ['town'], documents: [{ id: 'd1', name: 'Main', type: 'page' }] },
    { id: 'dmfold', name: 'DM Folder', parentId: 'root1', isHidden: true, tags: ['dm'], documents: [] },
    { id: 'plot1', name: 'Secret Plot', parentId: 'dmfold', isHidden: false, tags: [], documents: [{ id: 'd2', name: 'Main', type: 'page' }] },
    { id: 'npc1', name: 'Visible NPC', parentId: 'root1', isHidden: false, tags: [], documents: [{ id: 'd3', name: 'Main', type: 'page' }, { id: 'd4', name: 'GM notes', type: 'page' }] },
    { id: 'map1', name: 'Map', parentId: 'root1', isHidden: false, tags: [], documents: [{ id: 'd5', name: 'Map', type: 'map' }] },
  ];
  const DOCS: Record<string, string> = {
    d0: 'Welcome.',
    d1: 'A port. See [Secret Plot](lk://resources/plot1) and [the NPC](lk://resources/npc1).\n\n> [!secret]\n> Smugglers run the docks.\n\nFish market.',
    d2: 'The plot twist.',
    d3: 'Friendly. \\[\\[Port Town\\]\\]',
    d4: 'Is a spy.',
  };
  const calls: any[] = [];
  const fake = {
    async call(tool: string, args: any) {
      calls.push([tool, args]);
      const ok = (x: any) => ({ text: typeof x === 'string' ? x : JSON.stringify(x), structured: null, isError: false });
      if (tool === 'api_request' && args.path === '/resources') return args.query.cursor ? ok({ data: R.slice(3), hasMore: false }) : ok({ data: R.slice(0, 3), hasMore: true, nextCursor: 'c2' });
      if (tool === 'api_request') { const doc = args.path.split('/').pop(); return ok({ id: doc, isHidden: doc === 'd4' }); }
      if (tool === 'read_document') return ok(`Resource "x" (id ${args.resource}) › document "Main" (id ${args.document}, type page) · version 1\nPath: World\n---\n${DOCS[args.document]}`);
      return { text: 'no', structured: null, isError: true };
    },
    async listTools() { return []; },
    close() {},
  };
  const db = openDb(':memory:');
  run(db, `INSERT INTO worlds (id, slug, name, created_at) VALUES ('w', 'w', 'W', 'now')`);
  run(db, `INSERT INTO accounts (id, username, display_name, created_at) VALUES ('a', 'a', 'a', 'now')`);
  run(db, `INSERT INTO sources (id, world_id, kind, name) VALUES ('s', 'w', 'mcp', 'LK')`);
  const lib = new Library(db, null);
  const src = { id: 's', world_id: 'w', kind: 'mcp' as const, name: 'LK', config: JSON.stringify({ profile: 'legendkeeper' }), default_visibility: 'party' };
  const n = await syncSource(src, { library: lib, dataDir: null, vaultsDir: null, fetch, mcp: fake as any }, 'a');
  assert.equal(n, 5, 'pages only, maps skipped');
  assert.ok(calls.every(([t, a]) => READ_TOOLS.has(t) && (t !== 'api_request' || a.method === 'GET')));
  const player = { accountId: 'p', role: 'player' as const };
  const titles = lib.list('w', player).map((p: any) => p.title).sort();
  assert.deepEqual(titles, ['Port Town', 'Visible NPC', 'World'], 'hidden parent and hidden doc are DM-only');
  const town = lib.list('w', player).find((p: any) => p.title === 'Port Town') as any;
  const body = (lib.get('w', town.id, player) as any).body;
  assert.ok(body.includes('Fish market') && body.includes('[[Visible NPC|the NPC]]'));
  for (const leak of ['Smugglers', 'Secret Plot']) assert.ok(!body.includes(leak), leak);
  assert.ok(body.includes('(hidden)'), 'link to a DM-only page is replaced');
  const npc = lib.list('w', player).find((p: any) => p.title === 'Visible NPC') as any;
  assert.ok((lib.get('w', npc.id, player) as any).body.includes('[[Port Town]]'), 'escaped wikilinks are restored');
  assert.equal(lib.search('w', 'plot', player).length, 0);
  assert.equal(stripLkHeader('no header'), 'no header');
  assert.equal(lkLinks('[x](lk://resources/zz)', new Map()), '[[x]]');
});
