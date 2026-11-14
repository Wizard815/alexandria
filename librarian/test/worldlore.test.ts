// WorldLore: the AI's own wiki inside a world's source or the library.
// LegendKeeper (REST and MCP, against fakes built from the v3 API shapes),
// Markdown folders, the library, the root guard, auto-approval and leaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { one, all, run } from '../src/core/db.ts';
import { readOnlyMcp, makeMcpFactory, workspaceMcpFactory, connectorFor } from '../src/intake/registry.ts';
import { mdToLkBlocks } from '../src/intake/connectors/legendkeeper-write.ts';

// ---- a fake LegendKeeper project -------------------------------------------------------

interface Res { id: string; name: string; parentId?: string; isHidden: boolean; documents: { id: string; type: string; name: string }[]; blocks: Record<string, any[]> }

class FakeLK {
  res = new Map<string, Res>();
  calls: string[] = [];
  next = 1;
  constructor() {
    this.add('rootlore', 'WorldLore wiki', undefined);
    this.add('folderA', 'Folder A', 'rootlore');
    this.add('outside1', 'Secret Plans', undefined);
    this.add('outkid', 'Outside Child', 'outside1');
  }
  add(id: string, name: string, parentId?: string, blocks: any[] = [], hidden = true) {
    this.res.set(id, { id, name, parentId, isHidden: hidden, documents: [{ id: `d_${id}`, type: 'page', name: 'Main' }], blocks: { [`d_${id}`]: blocks } });
    return id;
  }
  ancestors(id: string) {
    const out: { id: string; name: string }[] = [];
    let p = this.res.get(id)?.parentId;
    while (p) { const r = this.res.get(p)!; out.unshift({ id: r.id, name: r.name }); p = r.parentId; }
    return out;
  }
  detail(id: string) { const r = this.res.get(id)!; return { id: r.id, name: r.name, parentId: r.parentId, isHidden: r.isHidden, documents: r.documents, tags: [], aliases: [], properties: [], ancestors: this.ancestors(id), permissions: { MEMBER: 0, ADMIN: 5 } }; }
  /** The same data over REST and over the MCP's api_request. */
  get(p: string, q: Record<string, string> = {}): { status: number; body: any } {
    this.calls.push(`GET ${p}`);
    let m: RegExpExecArray | null;
    if (p === '/resources') return { status: 200, body: { data: [...this.res.values()].map((r) => ({ id: r.id, name: r.name, parentId: r.parentId, isHidden: r.isHidden, documents: r.documents })), hasMore: false } };
    if ((m = /^\/resources\/([^/]+)$/.exec(p))) return this.res.has(m[1]) ? { status: 200, body: this.detail(m[1]) } : { status: 404, body: { error: 'NOT_FOUND' } };
    if ((m = /^\/resources\/([^/]+)\/docs\/([^/]+)\/blocks$/.exec(p))) return { status: 200, body: { id: m[2], version: '1', blocks: this.res.get(m[1])?.blocks[m[2]] ?? [] } };
    void q;
    return { status: 404, body: {} };
  }
}

const LK_API = 'https://lk.test/api/v3/projects/p1';

/** REST fake: Bearer lk_write_key_1234 may write, lk_read_key_12345 may only read. */
function restFetch(lk: FakeLK, writes: { method: string; path: string; body: any }[] = []) {
  return (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (url.host !== 'lk.test') return fetch(input, init);
    const p = url.pathname.replace('/api/v3/projects/p1', '');
    const method = String(init?.method ?? 'GET').toUpperCase();
    const key = String(init?.headers?.Authorization ?? '').replace('Bearer ', '');
    const json = (status: number, body: any) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'GET') { const r = lk.get(p); return json(r.status, r.body); }
    const body = init?.body ? JSON.parse(init.body) : undefined;
    writes.push({ method, path: p, body });
    lk.calls.push(`${method} ${p}`);
    if (key !== 'lk_write_key_1234') return json(403, { error: 'FORBIDDEN' });
    let m: RegExpExecArray | null;
    if (method === 'POST' && p === '/resources') {
      const id = `n${lk.next++}x`;
      const doc = body.documents?.[0];
      lk.add(id, body.name, body.parentId, doc?.blocks ?? [], body.isHidden !== false);
      return json(201, lk.detail(id));
    }
    if ((m = /^\/resources\/([^/]+)$/.exec(p)) && lk.res.has(m[1])) {
      const r = lk.res.get(m[1])!;
      if (method === 'PATCH') { if (body.name !== undefined) r.name = body.name; if (body.isHidden !== undefined) r.isHidden = body.isHidden; return json(200, lk.detail(r.id)); }
      if (method === 'DELETE') { lk.res.delete(r.id); return json(204, null); }
    }
    if ((m = /^\/resources\/([^/]+)\/move$/.exec(p)) && lk.res.has(m[1])) { lk.res.get(m[1])!.parentId = body.parentId ?? undefined; return json(200, lk.detail(m[1])); }
    if ((m = /^\/resources\/([^/]+)\/docs\/([^/]+)\/blocks$/.exec(p)) && method === 'PUT') { lk.res.get(m[1])!.blocks[m[2]] = body.blocks; return json(200, { id: m[2], version: '2', blocks: body.blocks }); }
    return json(404, { error: 'NOT_FOUND' });
  }) as typeof fetch;
}

/** MCP fake: api_request GET and the LegendKeeper write tools, recording each call. */
function fakeMcp(lk: FakeLK) {
  const calls: { tool: string; args: any }[] = [];
  const text = (o: any, isError = false) => ({ text: typeof o === 'string' ? o : JSON.stringify(o), structured: null, isError });
  return {
    calls,
    call: async (tool: string, args: any) => {
      calls.push({ tool, args });
      if (tool === 'api_request') { const r = lk.get(args.path, args.query); return text(r.body, r.status >= 400); }
      if (tool === 'create_resource') {
        const id = `m${lk.lastId()}x`;
        lk.add(id, args.name, args.parent, [{ kind: 'paragraph', content: [{ text: args.content ?? '' }] }], args.is_hidden !== false);
        return text({ id, documents: [] });
      }
      if (tool === 'write_page') { const r = lk.res.get(args.resource)!; r.blocks[r.documents[0].id] = [{ kind: 'paragraph', content: [{ text: args.markdown }] }]; return text('ok'); }
      if (tool === 'update_resource') { const r = lk.res.get(args.resource)!; if (args.name) r.name = args.name; if (args.is_hidden !== undefined) r.isHidden = args.is_hidden; return text('ok'); }
      if (tool === 'move_resource') { lk.res.get(args.resource)!.parentId = args.new_parent === 'root' ? undefined : args.new_parent; return text('ok'); }
      if (tool === 'delete_resource') { lk.res.delete(args.resource); return text('deleted'); }
      return text('ok');
    },
    listTools: async () => [],
    close() {},
  };
}
(FakeLK.prototype as any).lastId = function () { return this.next++; };

// ---- the app --------------------------------------------------------------------------

interface Env {
  base: string; deps: any; W: string; tmp: string; T: Record<string, string>; ID: Record<string, string>;
  call: (method: string, url: string, token?: string, body?: unknown) => Promise<{ status: number; body: any }>;
  ok: (method: string, url: string, token?: string, body?: unknown) => Promise<any>;
  lore: (method: string, sub: string, body?: unknown, token?: string) => Promise<{ status: number; body: any }>;
  close: () => void;
}

async function boot(opts: { fetch?: typeof fetch; testMcp?: any } = {}): Promise<Env> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-wl-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: opts.fetch, testMcp: opts.testMcp, env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let j: any = t;
    try { j = JSON.parse(t); } catch { /* text */ }
    return { status: r.status, body: j };
  };
  const ok = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await call(method, url, token, body);
    assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const T: Record<string, string> = {};
  const ID: Record<string, string> = {};
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  const W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Loreland', dmAccountId: ID.dm })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' });
  T.jess = j.token;
  ID.jess = j.account.id;
  return {
    base, deps: made.deps, W, tmp, T, ID, call, ok,
    lore: (method, sub, body, token) => call(method, `/api/worlds/${W}/worldlore${sub}`, token ?? T.dm, body),
    close: () => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

const addSource = (e: Env, kind: string, cfg: Record<string, unknown>, name = 'Source') => {
  const id = `src_${Math.random().toString(36).slice(2, 10)}`;
  run(e.deps.db, 'INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES (?, ?, ?, ?, ?, ?)', id, e.W, kind, name, JSON.stringify(cfg), 'dm');
  return id;
};
const setLore = (e: Env, cfg: Record<string, unknown> | null) => e.ok('PUT', `/api/worlds/${e.W}/worldlore/config`, e.T.dm, cfg ?? { enabled: false });
const autoApprove = async (e: Env) => (await e.ok('GET', `/api/worlds/${e.W}/settings`, e.T.dm)).agentAutoApprove as string[];
const syncs = (e: Env) => (one<any>(e.deps.db, 'SELECT COUNT(*) AS n FROM sync_runs', ) as any).n as number;
const pageRow = (e: Env, where: string, ...args: any[]) => one<any>(e.deps.db, `SELECT * FROM pages WHERE world_id = ? AND ${where}`, e.W, ...args);
const LK_CFG = { apiUrl: LK_API, apiKey: 'lk_write_key_1234' };

// ---- LegendKeeper over REST -------------------------------------------------------------

test('TestWorldLore_RestWritesCreateUpdateMoveDelete', async () => {
  const lk = new FakeLK();
  const writes: any[] = [];
  const e = await boot({ fetch: restFetch(lk, writes) });
  try {
    const src = addSource(e, 'legendkeeper-api', LK_CFG, 'LK');
    // Not set up yet: refused.
    assert.equal((await e.lore('POST', '/pages', { title: 'x', markdown: 'y' })).status, 409);
    await setLore(e, { kind: 'source', sourceId: src, root: 'rootlore', defaultLevel: 'broker' });

    const made = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'Odda the Fence', markdown: '# Odda\n\nShe sells **maps** and knows [[Velmira]].\n\n- one\n- two', by: 'agent' });
    assert.equal(made.created, true);
    assert.equal(made.level, 'broker', 'the workspace default applies');
    const post = writes.find((w) => w.method === 'POST' && w.path === '/resources');
    assert.equal(post.body.parentId, 'rootlore');
    assert.equal(post.body.isHidden, true);
    assert.deepEqual(post.body.documents[0].blocks.map((b: any) => b.kind), ['heading', 'paragraph', 'bulletList']);
    assert.ok(post.body.documents[0].blocks[1].content.some((r: any) => r.bold && r.text === 'maps'));

    // One-entry re-sync: in the library at once, with no sync run.
    assert.equal(syncs(e), 0);
    const row = pageRow(e, 'external_id = ?', made.ref);
    assert.equal(row.title, 'Odda the Fence');
    assert.equal(row.visibility, 'broker');
    assert.ok(row.body.includes('maps'));
    const list = await e.ok('GET', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm);
    assert.deepEqual(list.map((p: any) => [p.title, p.level, p.writtenBy]), [['Odda the Fence', 'broker', 'agent']]);

    // Update by id: blocks replaced, name kept.
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { id: row.id, markdown: 'Now she sells **charts**.', by: 'agent' });
    assert.ok(writes.some((w) => w.method === 'PUT' && /\/docs\/d_n1x\/blocks$/.test(w.path) || w.method === 'PUT'));
    assert.ok(pageRow(e, 'id = ?', row.id).body.includes('charts'));

    // Move into Folder A (inside the root).
    const mv = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages/${row.id}/move`, e.T.dm, { to: 'folderA', by: 'agent' });
    assert.equal(lk.res.get(mv.ref)!.parentId, 'folderA');

    // Delete.
    await e.ok('DELETE', `/api/worlds/${e.W}/worldlore/pages/${row.id}?by=agent`, e.T.dm);
    assert.ok(writes.some((w) => w.method === 'DELETE'));
    assert.equal(pageRow(e, 'id = ?', row.id), undefined);

    const kinds = all<any>(e.deps.db, `SELECT action, detail FROM audit WHERE world_id = ? AND action LIKE 'worldlore.%'`, e.W).map((a) => a.action);
    for (const k of ['worldlore.config', 'worldlore.create', 'worldlore.update', 'worldlore.move', 'worldlore.delete']) assert.ok(kinds.includes(k), `audited ${k}`);
    assert.ok(all<any>(e.deps.db, `SELECT detail FROM audit WHERE action = 'worldlore.create'`)[0].detail.startsWith('agent:'));
  } finally { e.close(); }
});

test('TestWorldLore_RootGuardRefusesOutsideRest', async () => {
  const lk = new FakeLK();
  const writes: any[] = [];
  const e = await boot({ fetch: restFetch(lk, writes) });
  try {
    const src = addSource(e, 'legendkeeper-api', LK_CFG, 'LK');
    await setLore(e, { kind: 'source', sourceId: src, root: 'rootlore', defaultLevel: 'dm' });
    const mutations = () => writes.length;
    const inside = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'Inside', markdown: 'text' });
    const before = mutations();

    // Delete a page outside the root.
    assert.equal((await e.lore('DELETE', '/pages/outkid')).status, 403);
    assert.equal((await e.lore('DELETE', '/pages/outside1')).status, 403);
    // Delete the root itself.
    assert.equal((await e.lore('DELETE', '/pages/rootlore')).status, 403);
    // Move a page out of the root, and an outside page in.
    assert.equal((await e.lore('POST', `/pages/${inside.ref}/move`, { to: 'outside1' })).status, 403);
    assert.equal((await e.lore('POST', '/pages/outkid/move', { to: 'rootlore' })).status, 403);
    // Create under an outside parent; update an outside page.
    assert.equal((await e.lore('POST', '/pages', { title: 'Sneaky', markdown: 'x', parent: 'outside1' })).status, 403);
    assert.equal((await e.lore('POST', '/pages', { id: 'outkid', markdown: 'overwritten' })).status, 403);
    // Ids that are not ids; a page that does not exist.
    assert.equal((await e.lore('POST', '/pages', { id: '../resources/x', markdown: 'x' })).status, 400);
    assert.equal((await e.lore('DELETE', '/pages/nothere')).status, 403);
    assert.equal(mutations(), before, 'nothing was sent to the source');
    assert.ok(lk.res.has('outkid') && lk.res.has('outside1') && lk.res.has('rootlore'));

    // A stale cache cannot talk its way in: the library believes Outside Child is under the root.
    run(e.deps.db, `INSERT INTO pages (id, world_id, path, title, visibility, body, source_id, external_id, parent_external, updated_at) VALUES ('pg_stale', ?, 'lk/outkid.md', 'Outside Child', 'dm', 'x', ?, 'outkid', 'rootlore', '2020-01-01')`, e.W, src);
    assert.equal((await e.lore('DELETE', '/pages/pg_stale')).status, 403);
    assert.equal(mutations(), before);
    assert.ok(lk.res.has('outkid'));

    // A name collision under the same parent.
    assert.equal((await e.lore('POST', '/pages', { title: 'inside', markdown: 'again' })).status, 409);
  } finally { e.close(); }
});

test('TestWorldLore_ReadKeyCannotWrite', async () => {
  const lk = new FakeLK();
  const e = await boot({ fetch: restFetch(lk) });
  try {
    const src = addSource(e, 'legendkeeper-api', { apiUrl: LK_API, apiKey: 'lk_read_key_12345' }, 'LK');
    await setLore(e, { kind: 'source', sourceId: src, root: 'rootlore', defaultLevel: 'dm' });
    const r = await e.lore('POST', '/pages', { title: 'Nope', markdown: 'x' });
    assert.equal(r.status, 403);
    assert.match(JSON.stringify(r.body), /cannot write|refused/i);
    assert.ok([...lk.res.values()].every((x) => x.name !== 'Nope'));
    // A scribe key with read access does not even list the lore write tools, and cannot call them.
    const k = await e.ok('POST', '/api/keys', e.T.dm, { scope: 'scribe', worldId: e.W, label: 'ro', access: 'read' });
    const rpc = async (key: string, method: string, params: any = {}) => (await e.call('POST', '/mcp', key, { jsonrpc: '2.0', id: 1, method, params })).body;
    const names = (await rpc(k.key ?? k.token, 'tools/list')).result.tools.map((t: any) => t.name);
    for (const t of ['lore_write', 'lore_move', 'lore_delete']) assert.ok(!names.includes(t), `${t} hidden from a read key`);
    const call = await rpc(k.key ?? k.token, 'tools/call', { name: 'lore_write', arguments: { markdown: 'x', title: 'y' } });
    assert.ok(call.error, 'unknown tool for a read key');
  } finally { e.close(); }
});

test('TestWorldLore_PlayersCannotUseLoreTools', async () => {
  const lk = new FakeLK();
  const e = await boot({ fetch: restFetch(lk) });
  try {
    const src = addSource(e, 'legendkeeper-api', LK_CFG, 'LK');
    await setLore(e, { kind: 'source', sourceId: src, root: 'rootlore', defaultLevel: 'dm' });
    const page = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'Hidden Lore', markdown: 'zxqv-secret-fact' });
    for (const [m, sub, b] of [['GET', '', undefined], ['GET', '/pages', undefined], ['GET', `/pages/${page.id}`, undefined], ['POST', '/pages', { title: 'p', markdown: 'x' }], ['POST', `/pages/${page.id}/move`, { to: 'folderA' }], ['DELETE', `/pages/${page.id}`, undefined], ['PUT', '/config', { enabled: false }], ['GET', '/options', undefined]] as const) {
      const r = await e.lore(m, sub, b, e.T.jess);
      assert.equal(r.status, 403, `${m} ${sub}`);
      assert.ok(!JSON.stringify(r.body).includes('zxqv'));
    }
    // Through MCP with the player's own key: read tools are listed but the call is refused.
    const k = await e.ok('POST', '/api/keys', e.T.jess, { scope: 'scribe', worldId: e.W, label: 'ai', access: 'read' });
    const out = await e.call('POST', '/mcp', k.key ?? k.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lore_list', arguments: {} } });
    assert.equal(out.body.result.isError, true);
    assert.ok(!JSON.stringify(out.body).includes('Hidden Lore'));
    assert.ok(!JSON.stringify((await e.call('GET', `/api/worlds/${e.W}/library/pages`, e.T.jess)).body).includes('Hidden Lore'));
    assert.equal((await e.call('PUT', `/api/worlds/${e.W}/worldlore/config`, e.T.jess, { kind: 'library', root: 'WorldLore', defaultLevel: 'party' })).status, 403);
  } finally { e.close(); }
});

// ---- LegendKeeper over MCP ---------------------------------------------------------------

test('TestWorldLore_McpWritesOnlyThroughTheNarrowAllowlist', async () => {
  const lk = new FakeLK();
  const mcp = fakeMcp(lk);
  const e = await boot({ testMcp: mcp });
  try {
    const src = addSource(e, 'legendkeeper-mcp', { transport: 'http', url: 'http://lk-mcp.test/mcp' }, 'LKMCP');
    await setLore(e, { kind: 'source', sourceId: src, root: 'rootlore', defaultLevel: 'dm' });
    const made = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'Mcp Page', markdown: 'Written through the MCP', level: 'broker', by: 'agent' });
    assert.equal(lk.res.get(made.ref)!.parentId, 'rootlore');
    assert.equal(lk.res.get(made.ref)!.isHidden, true);
    assert.equal(pageRow(e, 'external_id = ?', made.ref).visibility, 'broker');
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { id: made.id, markdown: 'Changed text' });
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages/${made.id}/move`, e.T.dm, { to: 'folderA' });
    await e.ok('DELETE', `/api/worlds/${e.W}/worldlore/pages/${made.id}`, e.T.dm);
    const used = new Set(mcp.calls.map((c) => c.tool));
    assert.deepEqual([...used].sort(), ['api_request', 'create_resource', 'delete_resource', 'move_resource', 'write_page'].sort());
    assert.equal(mcp.calls.find((c) => c.tool === 'delete_resource')!.args.confirm, true);
    for (const c of mcp.calls.filter((x) => x.tool === 'api_request')) assert.equal(c.args.method, 'GET');

    // Outside the root: refused before any write tool runs.
    const writesBefore = mcp.calls.filter((c) => c.tool !== 'api_request').length;
    assert.equal((await e.lore('DELETE', '/pages/outkid')).status, 403);
    assert.equal((await e.lore('POST', '/pages/folderA/move', { to: 'outside1' })).status, 403);
    assert.equal((await e.lore('POST', '/pages', { id: 'outside1', markdown: 'x' })).status, 403);
    assert.equal(mcp.calls.filter((c) => c.tool !== 'api_request').length, writesBefore);
    assert.ok(lk.res.has('outkid'));
  } finally { e.close(); }
});

test('TestWorldLore_McpGuardStillRefusesEveryOtherWrite', async () => {
  const lk = new FakeLK();
  const raw = fakeMcp(lk);
  const c = connectorFor('legendkeeper-mcp')!;
  const readTools = c.readTools!({});
  // Ordinary sources (sync, test, anything else): no write tool at all.
  const plain = readOnlyMcp(raw as any, readTools);
  for (const t of ['create_resource', 'write_page', 'update_resource', 'move_resource', 'delete_resource']) assert.throws(() => plain.call(t, { resource: 'x', confirm: true }), /not a read tool/, t);
  const viaFactory = makeMcpFactory(c, {}, {}, fetch, raw as any).factory();
  assert.throws(() => viaFactory.call('create_resource', { name: 'x' }), /not a read tool/);
  // The WorldLore client: the five tools only.
  const ws = workspaceMcpFactory(c, {}, {}, fetch, raw as any).factory();
  await assert.doesNotReject(ws.call('create_resource', { name: 'x', parent: 'rootlore' }));
  await assert.doesNotReject(ws.call('delete_resource', { resource: 'folderA', confirm: true }));
  assert.throws(() => ws.call('delete_resource', { resource: 'x' }), /confirm=true/);
  for (const t of ['delete_document', 'set_facts', 'create_map_feature', 'upload_image', 'restore_resource', 'create_resources', 'update_document', 'run_migration_plan']) assert.throws(() => ws.call(t, {}), /not a read tool/, t);
  assert.throws(() => ws.call('api_request', { method: 'DELETE', path: '/resources/x' }), /non-GET/);
  // Only the LegendKeeper MCP gets the exception.
  const other = workspaceMcpFactory(connectorFor('markdown-folder')!, {}, {}, fetch, raw as any).factory();
  assert.throws(() => other.call('create_resource', { name: 'x' }), /not a read tool/);
  // And only the connectors with a write capability can be a workspace.
  assert.equal(connectorFor('kanka-api')?.write, undefined);
  assert.ok(connectorFor('legendkeeper-api')?.write && connectorFor('legendkeeper-mcp')?.write && connectorFor('markdown-folder')?.write);
});

test('TestWorldLore_MarkdownToLkBlocks', () => {
  const b = mdToLkBlocks('# T\n\nHello `x` and [l](https://a.b)\n\n> [!secret] Hush\n> The twist\n\n1. a\n2. b\n\n```js\nlet x\n```\n\n---\n');
  assert.deepEqual(b.map((x) => x.kind), ['heading', 'paragraph', 'secret', 'orderedList', 'code', 'rule']);
  assert.ok(b[1].content.some((r: any) => r.code) && b[1].content.some((r: any) => r.link === 'https://a.b'));
});

// ---- Markdown folder --------------------------------------------------------------------

const mdSetup = async () => {
  const e = await boot();
  const vault = path.join(e.tmp, 'vaults', 'notes');
  fs.mkdirSync(path.join(vault, 'WorldLore'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'other.md'), '# Other\nNot in the workspace\n');
  fs.mkdirSync(path.join(e.tmp, 'outside'), { recursive: true });
  const src = addSource(e, 'markdown-folder', { folder: 'notes' }, 'Notes');
  await setLore(e, { kind: 'source', sourceId: src, root: 'WorldLore', defaultLevel: 'dm' });
  return { e, vault, src };
};

test('TestWorldLore_MarkdownFolderWritesStayInsideTheRoot', async () => {
  const { e, vault } = await mdSetup();
  try {
    const made = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { path: 'npcs/Odda', title: 'Odda', markdown: 'Odda sells charts.', level: 'broker', by: 'agent' });
    assert.equal(made.ref, 'WorldLore/npcs/Odda.md');
    const file = path.join(vault, 'WorldLore/npcs/Odda.md');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /title: Odda/);
    assert.match(text, /visibility: broker/);
    assert.ok(text.includes('Odda sells charts.'));
    assert.equal(syncs(e), 0, 'one-entry re-sync, not a whole sync');
    assert.equal(pageRow(e, 'external_id = ?', made.ref).visibility, 'broker');

    // Collision.
    assert.equal((await e.lore('POST', '/pages', { path: 'npcs/Odda', markdown: 'again' })).status, 409);
    assert.ok(fs.readFileSync(file, 'utf8').includes('sells charts'));

    // Traversal in every form.
    for (const p of ['../evil', 'npcs/../../evil', '/etc/evil', '..\\evil', '.hidden/x', 'C:/evil']) {
      const r = await e.lore('POST', '/pages', { path: p, markdown: 'x' });
      assert.ok(r.status === 403 || r.status === 400, `${p} -> ${r.status}`);
    }
    assert.ok(!fs.existsSync(path.join(vault, 'evil.md')) && !fs.existsSync(path.join(e.tmp, 'evil.md')) && !fs.existsSync('/etc/evil.md'));

    // A symlink inside the folder leading out.
    fs.symlinkSync(path.join(e.tmp, 'outside'), path.join(vault, 'WorldLore/link'));
    assert.equal((await e.lore('POST', '/pages', { path: 'link/x', markdown: 'escaped' })).status, 403);
    assert.deepEqual(fs.readdirSync(path.join(e.tmp, 'outside')), []);
    fs.symlinkSync(path.join(vault, 'other.md'), path.join(vault, 'WorldLore/sneaky.md'));
    assert.equal((await e.lore('POST', '/pages', { id: 'WorldLore/sneaky.md', markdown: 'overwrite' })).status, 403);
    assert.ok(fs.readFileSync(path.join(vault, 'other.md'), 'utf8').includes('Not in the workspace'));

    // Outside the root: update, move in and out, delete.
    assert.equal((await e.lore('POST', '/pages', { id: 'other.md', markdown: 'overwritten' })).status, 403);
    assert.equal((await e.lore('DELETE', `/pages/${encodeURIComponent('other.md')}`)).status, 403);
    assert.equal((await e.lore('DELETE', `/pages/${encodeURIComponent('WorldLore/../other.md')}`)).status, 403);
    assert.equal((await e.lore('POST', `/pages/${encodeURIComponent('other.md')}/move`, { to: 'moved' })).status, 403);
    assert.equal((await e.lore('POST', `/pages/${encodeURIComponent(made.ref)}/move`, { to: '../escaped' })).status, 403);
    assert.ok(fs.existsSync(path.join(vault, 'other.md')) && !fs.existsSync(path.join(vault, 'escaped.md')));

    // Move and delete inside.
    const mv = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages/${made.id}/move`, e.T.dm, { to: 'people/Odda Fence', by: 'agent' });
    assert.equal(mv.ref, 'WorldLore/people/Odda Fence.md');
    assert.ok(!fs.existsSync(file) && fs.existsSync(path.join(vault, mv.ref)));
    assert.equal(pageRow(e, 'external_id = ?', made.ref), undefined, 'the old entry is gone');
    assert.ok(pageRow(e, 'external_id = ?', mv.ref));
    await e.ok('DELETE', `/api/worlds/${e.W}/worldlore/pages/${mv.id}`, e.T.dm);
    assert.ok(!fs.existsSync(path.join(vault, mv.ref)));
    assert.equal(pageRow(e, 'external_id = ?', mv.ref), undefined);
  } finally { e.close(); }
});

// ---- Library mode ------------------------------------------------------------------------

test('TestWorldLore_LibraryModeWritesUnderWorldLoreOnly', async () => {
  const e = await boot();
  try {
    await e.ok('PUT', `/api/worlds/${e.W}/library/pages`, e.T.dm, { path: 'places/Saltmarsh', visibility: 'party', markdown: '# Saltmarsh\nA fishing town.' });
    await setLore(e, { kind: 'library', root: 'anything', defaultLevel: 'dm' });
    const cfg = (await e.ok('GET', `/api/worlds/${e.W}/worldlore`, e.T.dm)).config;
    assert.equal(cfg.root, 'WorldLore', 'the library folder is fixed');

    const made = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { path: 'npcs/Odda', title: 'Odda', markdown: 'Library lore.', level: 'broker', by: 'agent' });
    assert.equal(made.ref, 'WorldLore/npcs/Odda.md');
    assert.equal(pageRow(e, 'path = ?', made.ref).visibility, 'broker');
    assert.equal((await e.lore('POST', '/pages', { path: 'npcs/Odda', markdown: 'dup' })).status, 409);
    const trav = await e.lore('POST', '/pages', { path: '../places/Evil', markdown: 'x' });
    assert.ok([400, 403].includes(trav.status));
    assert.equal(pageRow(e, 'path = ?', 'places/Evil.md'), undefined);

    const salt = pageRow(e, 'path = ?', 'places/Saltmarsh.md');
    assert.equal((await e.lore('POST', '/pages', { id: salt.id, markdown: 'overwritten' })).status, 403);
    assert.equal((await e.lore('DELETE', `/pages/${salt.id}`)).status, 403);
    assert.equal((await e.lore('POST', `/pages/${salt.id}/move`, { to: 'WorldLore/stolen' })).status, 403);
    assert.ok([400, 403].includes((await e.lore('POST', `/pages/${made.id}/move`, { to: '../places/Moved' })).status));
    assert.ok(pageRow(e, 'path = ?', 'places/Saltmarsh.md').body.includes('fishing town'));

    const mv = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages/${made.id}/move`, e.T.dm, { to: 'people/Odda' });
    assert.equal(mv.ref, 'WorldLore/people/Odda.md');
    assert.equal(pageRow(e, 'path = ?', mv.ref).visibility, 'broker', 'the level moves with the page');
    await e.ok('DELETE', `/api/worlds/${e.W}/worldlore/pages/${mv.id}`, e.T.dm);
    assert.equal(pageRow(e, 'path = ?', mv.ref), undefined);
    assert.equal(syncs(e), 0);

    // Everywhere else the library is as before: the DM's write route still works, the agent's save_page still needs approval.
    const tools = (await import('../src/routes/mcpServer.ts')).toolsFor(true);
    assert.equal(tools.find((t) => t.name === 'save_page')!.write, true);
    assert.ok(!(await autoApprove(e)).includes('save_page'));
  } finally { e.close(); }
});

// ---- levels and leaks --------------------------------------------------------------------

test('TestWorldLore_BrokerLevelPageNeverReachesAPlayer', async () => {
  const { e, vault } = await mdSetup();
  try {
    const MARK = 'qxzv-broker-only-fact';
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { path: 'rumours/Harbour', title: 'Harbour rumour', markdown: `The harbourmaster owes a debt: ${MARK}.`, level: 'broker', by: 'agent' });
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { path: 'rumours/Sealed', title: 'Sealed order', markdown: `Sealed text ${MARK}-classified`, level: 'classified', by: 'agent' });
    const k = await e.ok('POST', '/api/keys', e.T.jess, { scope: 'scribe', worldId: e.W, label: 'ai', access: 'read' });
    const rpc = async (name: string, args: any) => JSON.stringify((await e.call('POST', '/mcp', k.key ?? k.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body);
    const seen = [
      JSON.stringify((await e.call('GET', `/api/worlds/${e.W}/library/pages`, e.T.jess)).body),
      JSON.stringify((await e.call('GET', `/api/worlds/${e.W}/library/search?q=${MARK}`, e.T.jess)).body),
      JSON.stringify((await e.call('GET', `/api/worlds/${e.W}/library/search?q=harbourmaster`, e.T.jess)).body),
      await rpc('search_library', { query: 'harbourmaster debt' }),
      await rpc('list_pages', {}),
    ];
    for (const row of all<any>(e.deps.db, 'SELECT id, path FROM pages WHERE world_id = ?', e.W)) {
      const r = await e.call('GET', `/api/worlds/${e.W}/library/pages/${row.id}`, e.T.jess);
      if (/WorldLore/.test(row.path)) assert.equal(r.status, 404, row.path);
      seen.push(JSON.stringify(r.body));
    }
    for (const s of seen) { assert.ok(!s.includes(MARK), 'the fact reached a player'); assert.ok(!s.includes('Harbour rumour') && !s.includes('Sealed order')); }
    // Player copies are empty; the files players can see hold nothing.
    for (const r of all<any>(e.deps.db, `SELECT player_body, player_blocks, visibility FROM pages WHERE world_id = ? AND path LIKE '%WorldLore%'`, e.W)) { assert.equal(r.player_body, null); assert.equal(r.player_blocks, null); assert.notEqual(r.visibility, 'party'); }
    // The DM sees it; the agent can read broker pages but never classified ones.
    const list = await e.ok('GET', `/api/worlds/${e.W}/worldlore/pages?ai=1`, e.T.dm);
    assert.deepEqual(list.map((p: any) => p.title), ['Harbour rumour']);
    const all2 = await e.ok('GET', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm);
    assert.deepEqual(all2.map((p: any) => p.level).sort(), ['broker', 'classified']);
    const broker = all2.find((p: any) => p.level === 'broker');
    assert.ok((await e.ok('GET', `/api/worlds/${e.W}/worldlore/pages/${broker.id}`, e.T.dm)).markdown.includes(MARK));
    const sealed = all2.find((p: any) => p.level === 'classified');
    const sr = await e.lore('GET', `/pages/${sealed.id}`);
    assert.equal(sr.status, 403);
    assert.ok(!JSON.stringify(sr.body).includes(MARK));
    assert.ok(fs.existsSync(path.join(vault, 'WorldLore/rumours/Sealed.md')));
  } finally { e.close(); }
});

test('TestWorldLore_PartyLevelNeedsTheDmsPartyDefault', async () => {
  const { e } = await mdSetup();
  try {
    const r = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { path: 'a/One', title: 'One', markdown: 'text', level: 'party', by: 'agent' });
    assert.equal(r.level, 'dm', 'an agent cannot publish to players on its own');
    assert.match(r.note, /party/);
    assert.equal((await e.lore('POST', '/pages', { path: 'a/Two', markdown: 'x', level: 'secret-ish' })).status, 400);
    const src = (await e.ok('GET', `/api/worlds/${e.W}/worldlore`, e.T.dm)).config.sourceId;
    await setLore(e, { kind: 'source', sourceId: src, root: 'WorldLore', defaultLevel: 'party' });
    const p = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { path: 'a/Three', title: 'Three', markdown: 'players may read this', by: 'agent' });
    assert.equal(p.level, 'party');
    assert.equal((await e.ok('GET', `/api/worlds/${e.W}/library/pages/${p.id}`, e.T.jess)).title, 'Three');
  } finally { e.close(); }
});

// ---- auto-approval, settings and options -------------------------------------------------

test('TestWorldLore_EnablingAddsToolsToAutoApproveAndDisablingRemovesThem', async () => {
  const e = await boot();
  try {
    await e.ok('PATCH', `/api/worlds/${e.W}/settings`, e.T.dm, { agentAutoApprove: ['next_turn'] });
    const src = addSource(e, 'markdown-folder', { folder: 'notes' }, 'Notes');
    await setLore(e, { kind: 'source', sourceId: src, root: 'WorldLore', defaultLevel: 'dm' });
    const on = await autoApprove(e);
    for (const t of ['next_turn', 'lore_write', 'lore_move', 'lore_delete', 'lore_list', 'lore_read']) assert.ok(on.includes(t), t);
    assert.ok(!on.includes('save_page') && !on.includes('add_coin'), 'nothing else is approved');
    await setLore(e, { kind: 'library', root: 'WorldLore', defaultLevel: 'broker' });
    assert.equal((await autoApprove(e)).filter((t) => t === 'lore_write').length, 1, 'no duplicates');
    await setLore(e, null);
    const off = await autoApprove(e);
    assert.deepEqual(off, ['next_turn']);
    assert.equal((await e.ok('GET', `/api/worlds/${e.W}/settings`, e.T.dm)).worldLore, null);
    assert.equal((await e.lore('POST', '/pages', { title: 'x', markdown: 'y' })).status, 409, 'off: the tools do nothing');
    // The lore write tools are write tools (so they would wait for approval without the setting).
    const tools = (await import('../src/routes/mcpServer.ts')).toolsFor(true);
    for (const t of ['lore_write', 'lore_move', 'lore_delete']) assert.equal(tools.find((x) => x.name === t)!.write, true);
    for (const t of ['lore_list', 'lore_read']) assert.ok(!tools.find((x) => x.name === t)!.write);
    // Bad settings are refused.
    assert.equal((await e.call('PATCH', `/api/worlds/${e.W}/settings`, e.T.dm, { worldLore: { kind: 'source', root: '../x', defaultLevel: 'dm' } })).status, 400);
    assert.equal((await e.lore('PUT', '/config', { kind: 'source', sourceId: 'nope', root: 'x', defaultLevel: 'dm' })).status, 404);
    assert.equal((await e.lore('PUT', '/config', { kind: 'source', sourceId: src, root: 'x', defaultLevel: 'classified' })).status, 400);
    // A source that cannot be written to (Kanka) is refused.
    const kanka = addSource(e, 'kanka-api', { apiUrl: 'https://kanka.test/api/1.0/campaigns/1', apiKey: 'xxxxxxxxxxxx' }, 'Kanka');
    assert.equal((await e.lore('PUT', '/config', { kind: 'source', sourceId: kanka, root: 'x', defaultLevel: 'dm' })).status, 400);
  } finally { e.close(); }
});

test('TestWorldLore_OptionsAndLinkForThePicker', async () => {
  const lk = new FakeLK();
  const e = await boot({ fetch: restFetch(lk) });
  try {
    fs.mkdirSync(path.join(e.tmp, 'vaults', 'notes', 'Places'), { recursive: true });
    const a = addSource(e, 'legendkeeper-api', LK_CFG, 'LK');
    addSource(e, 'markdown-folder', { folder: 'notes' }, 'Notes');
    addSource(e, 'kanka-api', { apiUrl: 'https://kanka.test/api/1.0/campaigns/1', apiKey: 'xxxxxxxxxxxx' }, 'Kanka');
    const o = await e.ok('GET', `/api/worlds/${e.W}/worldlore/options`, e.T.dm);
    assert.deepEqual(o.sources.map((s: any) => s.name).sort(), ['LK', 'Notes'], 'only writable sources');
    assert.deepEqual(o.sources.find((s: any) => s.name === 'LK').roots.map((r: any) => r.id).sort(), ['outside1', 'rootlore']);
    assert.ok(o.sources.find((s: any) => s.name === 'Notes').roots.some((r: any) => r.id === 'WorldLore'));
    const st = await setLore(e, { kind: 'source', sourceId: a, root: 'rootlore', defaultLevel: 'dm' });
    assert.match(st.links.url, /p1.*rootlore/);
    assert.equal(st.links.sourceName, 'LK');
    const own = await setLore(e, { kind: 'source', sourceId: a, root: 'rootlore', defaultLevel: 'dm', url: 'https://lk.test/my/link' });
    assert.equal(own.links.url, 'https://lk.test/my/link');
    // An admin can set it too.
    const adm = await e.ok('PUT', `/api/admin/worldlore/${e.W}/config`, e.T.admin, { kind: 'library', root: 'WorldLore', defaultLevel: 'dm' });
    assert.equal(adm.enabled, true);
    assert.ok((await autoApprove(e)).includes('lore_write'));
  } finally { e.close(); }
});

test('TestWorldLore_AgentRunsLoreWriteWithoutAskingAndOthersStillWait', async () => {
  // The harness runs a write tool at once only when it is in agentAutoApprove.
  const { selectTools } = await import('../src/features/agent/intent.ts');
  assert.ok(selectTools('add a note to the worldlore wiki about Odda', ['search_library', 'read_page', 'lore_write', 'lore_list', 'save_page']).includes('lore_write'));
  const e = await boot();
  try {
    const before = await autoApprove(e);
    assert.ok(!before.includes('lore_write'));
    await setLore(e, { kind: 'library', root: 'WorldLore', defaultLevel: 'dm' });
    const approve = new Set(await autoApprove(e));
    assert.ok(approve.has('lore_write') && approve.has('lore_delete') && approve.has('lore_move'));
    for (const t of ['save_page', 'add_coin', 'add_item', 'send_broker_offer', 'add_broker_note']) assert.ok(!approve.has(t), `${t} still needs the DM`);
  } finally { e.close(); }
});
