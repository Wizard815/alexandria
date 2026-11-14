// WorldLore on Kanka: a note or journal is the home page; the agent creates,
// updates, moves and deletes child pages of the same type under it. REST (token)
// and mcp-kanka run against fakes built from the Kanka API docs and the
// mcp-kanka tool schemas. Everything outside the root stays untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { one, all, run } from '../src/core/db.ts';
import { workspaceMcpFactory, makeMcpFactory, readOnlyMcp, connectorFor } from '../src/intake/registry.ts';
import { mdToKankaHtml, levelPlan, markdownLevel } from '../src/intake/connectors/kanka-write.ts';

// ---- a fake Kanka campaign -----------------------------------------------------------------

interface Ent { eid: number; kind: string; name: string; entry: string; parent: number | null; isPrivate: boolean; tags: number[]; type?: string }

class FakeKanka {
  ents = new Map<number, Ent>();
  tags = new Map<number, { id: number; name: string; isPrivate: boolean }>();
  nextEid = 100;
  nextTag = 1000;
  /** Does GET entities/{id} list every ancestor (`parents`)? Off: the guard walks parent_id. */
  listParents = true;
  calls: string[] = [];
  /** Answer 429 (Retry-After: 0) to the next n requests. */
  throttle = 0;
  constructor() {
    this.add(10, 'note', 'WorldLore home', null);
    this.add(11, 'note', 'Folder', 10);
    this.add(12, 'note', 'Deeper', 11);
    this.add(13, 'note', 'Deepest', 12);
    this.add(20, 'note', 'Private Plans', null);
    this.add(21, 'note', 'Plans child', 20);
    this.add(40, 'journal', 'Session Log', null);
    this.add(41, 'journal', 'A journal wrongly under the note root', 10);
    this.add(50, 'character', 'Aldric', null);
    this.tags.set(901, { id: 901, name: 'Lore', isPrivate: false });
    this.ents.get(11)!.tags = [901];
  }
  add(eid: number, kind: string, name: string, parent: number | null, entry = '') {
    this.ents.set(eid, { eid, kind, name, entry, parent, isPrivate: true, tags: [] });
    return eid;
  }
  child = (eid: number) => eid + 500;
  byChild = (kind: string, child: number) => [...this.ents.values()].find((e) => e.kind === kind && this.child(e.eid) === child);
  ancestors(eid: number): number[] {
    const out: number[] = [];
    let p = this.ents.get(eid)?.parent;
    while (p != null) { out.push(p); p = this.ents.get(p)?.parent; }
    return out;
  }
  entityJson(e: Ent) {
    return { id: e.eid, name: e.name, entity_type: e.kind, child_id: this.child(e.eid), type: 'Lore', is_private: e.isPrivate, parent_id: e.parent, ...(this.listParents ? { parents: this.ancestors(e.eid) } : {}) };
  }
  moduleJson(e: Ent, related: boolean) {
    return {
      id: this.child(e.eid), entity_id: e.eid, name: e.name, entry: e.entry, is_private: e.isPrivate, parent_id: e.parent, updated_at: '2026-01-02T03:04:05.000000Z',
      urls: { view: `https://app.kanka.io/w/7/entities/${e.eid}` }, has_custom_image: false,
      tags: related ? e.tags.map((id) => ({ id, name: this.tags.get(id)!.name, is_private: this.tags.get(id)!.isPrivate, is_hidden: false })) : e.tags,
      ...(related ? { posts: [] } : {}),
    };
  }
  tagNames(e: Ent) { return e.tags.map((id) => this.tags.get(id)!.name); }
}

const KANKA = 'https://kanka.test/api/1.0';
const TOKEN = 'kanka_write_token_0123456789';
const READ_TOKEN = 'kanka_read_only_token_0123';
const CFG = { apiUrl: KANKA, campaignId: '7', token: TOKEN };

/** REST fake: TOKEN may write; READ_TOKEN gets 403 on any change. */
function kankaFetch(k: FakeKanka, writes: { method: string; path: string; body: any }[] = []) {
  return (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (url.host !== 'kanka.test') return fetch(input, init);
    const method = String(init?.method ?? 'GET').toUpperCase();
    const p = url.pathname.replace('/api/1.0/campaigns/7', '');
    const json = (status: number, body: any) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (k.throttle > 0) { k.throttle--; return new Response('{}', { status: 429, headers: { 'retry-after': '0' } }); }
    const key = String(init?.headers?.Authorization ?? '').replace('Bearer ', '');
    if (key !== TOKEN && key !== READ_TOKEN) return json(401, {});
    k.calls.push(`${method} ${p}`);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    let m: RegExpExecArray | null;
    if (method !== 'GET') {
      writes.push({ method, path: p, body });
      if (key !== TOKEN) return json(403, { message: 'forbidden' });
    }
    if (method === 'GET' && (m = /^\/entities\/(\d+)$/.exec(p))) { const e = k.ents.get(Number(m[1])); return e ? json(200, { data: k.entityJson(e) }) : json(404, {}); }
    if (method === 'GET' && p === '/tags') return json(200, { data: [...k.tags.values()].map((t) => ({ id: t.id, name: t.name, is_private: t.isPrivate })), links: { next: null }, meta: { last_page: 1 } });
    if (method === 'POST' && p === '/tags') { const id = k.nextTag++; k.tags.set(id, { id, name: body.name, isPrivate: body.is_private === true }); return json(201, { data: { id, name: body.name } }); }
    if ((m = /^\/(notes|journals)$/.exec(p))) {
      const kind = m[1] === 'notes' ? 'note' : 'journal';
      if (method === 'GET') {
        const q = url.searchParams.get('name')?.toLowerCase();
        const rows = [...k.ents.values()].filter((e) => e.kind === kind && (!q || e.name.toLowerCase().includes(q))).map((e) => k.moduleJson(e, false));
        return json(200, { data: rows, links: { next: null }, meta: { last_page: 1 } });
      }
      if (method === 'POST') {
        if (!body.name) return json(422, { errors: { name: ['required'] } });
        const eid = k.nextEid++;
        k.add(eid, kind, body.name, body.parent_id ?? null, body.entry ?? '');
        const e = k.ents.get(eid)!;
        e.isPrivate = body.is_private !== false;
        e.tags = body.tags ?? [];
        return json(201, { data: k.moduleJson(e, false) });
      }
    }
    if ((m = /^\/(notes|journals)\/(\d+)$/.exec(p))) {
      const kind = m[1] === 'notes' ? 'note' : 'journal';
      const e = k.byChild(kind, Number(m[2]));
      if (!e) return json(404, {});
      if (method === 'GET') return json(200, { data: k.moduleJson(e, url.searchParams.get('related') === '1') });
      if (method === 'PATCH') {
        if (body.name !== undefined) e.name = body.name;
        if (body.entry !== undefined) e.entry = body.entry;
        if (body.is_private !== undefined) e.isPrivate = body.is_private;
        if (body.tags !== undefined) e.tags = body.tags;
        if ('parent_id' in body) e.parent = body.parent_id;
        return json(200, { data: k.moduleJson(e, false) });
      }
      if (method === 'DELETE') { k.ents.delete(e.eid); return json(200, { success: true }); }
    }
    return json(404, { message: 'no such route' });
  }) as typeof fetch;
}

// ---- a fake mcp-kanka server -----------------------------------------------------------------

function fakeKankaMcp(k: FakeKanka) {
  const calls: { tool: string; args: any }[] = [];
  const text = (o: any, isError = false) => ({ text: JSON.stringify(o), structured: null, isError });
  const ent = (e: Ent) => ({ id: k.child(e.eid), entity_id: e.eid, name: e.name, entity_type: e.kind, type: 'Lore', entry: e.entry, tags: k.tagNames(e), is_hidden: e.isPrivate, parent_id: e.parent, updated_at: '2026-01-02T03:04:05Z', success: true, error: null, posts: [] });
  const tagIds = (names: string[]) => names.map((n) => { let t = [...k.tags.values()].find((x) => x.name.toLowerCase() === n.toLowerCase()); if (!t) { t = { id: k.nextTag++, name: n, isPrivate: false }; k.tags.set(t.id, t); } return t.id; });
  return {
    calls,
    call: async (tool: string, args: any) => {
      calls.push({ tool, args });
      if (tool === 'get_entities') return text(args.entity_ids.map((id: number) => (k.ents.has(id) ? ent(k.ents.get(id)!) : { entity_id: id, success: false, error: 'not found' })));
      if (tool === 'find_entities') {
        const q = String(args.name ?? '').toLowerCase();
        const list = [...k.ents.values()].filter((e) => e.kind === args.entity_type && (!q || e.name.toLowerCase().includes(q)));
        return text({ entities: list.map((e) => ({ entity_id: e.eid, name: e.name, entity_type: e.kind, parent_id: e.parent })), sync_info: { last_page: 1 } });
      }
      if (tool === 'create_entities') {
        return text(args.entities.map((x: any) => {
          const eid = k.nextEid++;
          k.add(eid, x.entity_type, x.name, x.parent_id ?? null, x.entry ?? '');
          const e = k.ents.get(eid)!;
          e.isPrivate = x.is_hidden !== false;
          e.tags = tagIds(x.tags ?? []);
          return { id: k.child(eid), entity_id: eid, name: x.name, success: true, error: null };
        }));
      }
      if (tool === 'update_entities') {
        return text(args.updates.map((u: any) => {
          const e = k.ents.get(u.entity_id);
          if (!e) return { entity_id: u.entity_id, success: false, error: 'not found' };
          if (u.name !== undefined) e.name = u.name;
          if (u.entry !== undefined) e.entry = u.entry;
          if (u.is_hidden !== undefined) e.isPrivate = u.is_hidden;
          if (u.tags !== undefined) e.tags = tagIds(u.tags);
          if ('parent_id' in u) e.parent = u.parent_id;
          return { entity_id: u.entity_id, success: true, error: null };
        }));
      }
      if (tool === 'delete_entities') return text(args.entity_ids.map((id: number) => { k.ents.delete(id); return { entity_id: id, success: true, error: null }; }));
      return text('ok');
    },
    listTools: async () => [],
    close() {},
  };
}

// ---- the app -------------------------------------------------------------------------------

interface Env {
  base: string; deps: any; W: string; tmp: string; T: Record<string, string>;
  call: (method: string, url: string, token?: string, body?: unknown) => Promise<{ status: number; body: any }>;
  ok: (method: string, url: string, token?: string, body?: unknown) => Promise<any>;
  lore: (method: string, sub: string, body?: unknown, token?: string) => Promise<{ status: number; body: any }>;
  close: () => void;
}

async function boot(opts: { fetch?: typeof fetch; testMcp?: any } = {}): Promise<Env> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-wlk-'));
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
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  const W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Loreland', dmAccountId: dm })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  T.jess = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' })).token;
  return {
    base, deps: made.deps, W, tmp, T, call, ok,
    lore: (method, sub, body, token) => call(method, `/api/worlds/${W}/worldlore${sub}`, token ?? T.dm, body),
    close: () => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

const addSource = (e: Env, kind: string, cfg: Record<string, unknown>, name = 'Kanka', visibility = 'dm') => {
  const id = `src_${Math.random().toString(36).slice(2, 10)}`;
  run(e.deps.db, 'INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES (?, ?, ?, ?, ?, ?)', id, e.W, kind, name, JSON.stringify(cfg), visibility);
  return id;
};
const setLore = (e: Env, cfg: Record<string, unknown> | null) => e.ok('PUT', `/api/worlds/${e.W}/worldlore/config`, e.T.dm, cfg ?? { enabled: false });
const syncs = (e: Env) => (one<any>(e.deps.db, 'SELECT COUNT(*) AS n FROM sync_runs') as any).n as number;
const pageRow = (e: Env, where: string, ...args: any[]) => one<any>(e.deps.db, `SELECT * FROM pages WHERE world_id = ? AND ${where}`, e.W, ...args);
const lorePage = (e: Env, body: unknown) => e.lore('POST', '/pages', body);
const kinds = (writes: { method: string }[]) => writes.map((w) => w.method);

// ---- REST -----------------------------------------------------------------------------------

test('TestWorldLoreKanka_RestWritesCreateUpdateMoveDelete', async () => {
  const k = new FakeKanka();
  const writes: any[] = [];
  const e = await boot({ fetch: kankaFetch(k, writes) });
  try {
    const src = addSource(e, 'kanka-api', CFG);
    assert.equal((await lorePage(e, { title: 'x', markdown: 'y' })).status, 409, 'not set up yet');
    await setLore(e, { kind: 'source', sourceId: src, root: 'kanka:10', defaultLevel: 'dm' });

    // Create under the root, as a note, with HTML from Markdown and the mention kept.
    const made = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'Odda the Fence', markdown: '# Odda\n\nShe sells **maps** and knows [entity:50|Aldric] and [[@kanka:50|Aldric again]].\n\n- one\n- two', by: 'agent' });
    assert.equal(made.created, true);
    assert.match(made.ref, /^kanka:\d+$/);
    const post = writes.find((w) => w.method === 'POST' && w.path === '/notes');
    assert.equal(post.body.parent_id, 10);
    assert.equal(post.body.is_private, true);
    assert.match(post.body.entry, /<h1>Odda<\/h1>/);
    assert.match(post.body.entry, /<strong>maps<\/strong>/);
    assert.match(post.body.entry, /\[entity:50\|Aldric\]/);
    assert.match(post.body.entry, /\[entity:50\|Aldric again\]/);
    assert.match(post.body.entry, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
    const eid = Number(made.ref.slice(6));
    assert.equal(k.ents.get(eid)!.kind, 'note');

    // Re-sync of that one page: in the library at once, no sync run, level kept.
    assert.equal(syncs(e), 0);
    const row = pageRow(e, 'external_id = ?', made.ref);
    assert.equal(row.title, 'Odda the Fence');
    assert.equal(row.visibility, 'dm');
    assert.equal(row.parent_external, 'kanka:10');
    assert.ok(row.body.includes('maps'));
    assert.equal(row.url, `https://app.kanka.io/w/7/entities/${eid}`);

    // A page nested under a page inside the root (three deep), by a path with folders.
    const deep = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'Under deepest', markdown: 'Down here', parent: 'kanka:13' });
    assert.equal(k.ents.get(Number(deep.ref.slice(6)))!.parent, 13);
    const viaPath = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { path: 'npcs/Odda II', markdown: 'Folder made as a note' });
    const folder = [...k.ents.values()].find((x) => x.name === 'npcs')!;
    assert.equal(folder.kind, 'note');
    assert.equal(folder.parent, 10);
    assert.equal(k.ents.get(Number(viaPath.ref.slice(6)))!.parent, folder.eid);

    // Update by id: entry replaced, name kept, parent kept.
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { id: row.id, markdown: 'Now she sells **charts**.', by: 'agent' });
    const patch = writes.filter((w) => w.method === 'PATCH').pop();
    assert.equal(patch.path, `/notes/${eid + 500}`);
    assert.equal(patch.body.name, 'Odda the Fence');
    assert.match(patch.body.entry, /charts/);
    assert.ok(!('parent_id' in patch.body));
    assert.ok(pageRow(e, 'id = ?', row.id).body.includes('charts'));
    assert.equal(k.ents.get(eid)!.parent, 10);

    // Move within the root: under Folder (11), then to the top of the workspace.
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages/${row.id}/move`, e.T.dm, { to: 'kanka:11', by: 'agent' });
    assert.equal(k.ents.get(eid)!.parent, 11);
    assert.equal(pageRow(e, 'id = ?', row.id).parent_external, 'kanka:11');
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages/${row.id}/move`, e.T.dm, { to: null });
    assert.equal(k.ents.get(eid)!.parent, 10);

    // Delete.
    await e.ok('DELETE', `/api/worlds/${e.W}/worldlore/pages/${row.id}?by=agent`, e.T.dm);
    assert.equal(k.ents.has(eid), false);
    assert.equal(pageRow(e, 'id = ?', row.id), undefined);
    assert.ok(writes.some((w) => w.method === 'DELETE' && w.path === `/notes/${eid + 500}`));

    const audited = all<any>(e.deps.db, `SELECT action FROM audit WHERE world_id = ? AND action LIKE 'worldlore.%'`, e.W).map((a) => a.action);
    for (const a of ['worldlore.config', 'worldlore.create', 'worldlore.update', 'worldlore.move', 'worldlore.delete']) assert.ok(audited.includes(a), a);
    // Nothing outside the root was ever written.
    for (const id of [20, 21, 40, 50]) assert.ok(k.ents.has(id));
    assert.equal(writes.filter((w) => /\/(20|21|40|50|520|521|540|550)\b/.test(w.path)).length, 0);
  } finally { e.close(); }
});

test('TestWorldLoreKanka_JournalRootMakesJournalChildren', async () => {
  const k = new FakeKanka();
  const writes: any[] = [];
  const e = await boot({ fetch: kankaFetch(k, writes) });
  try {
    const src = addSource(e, 'kanka-api', CFG);
    await setLore(e, { kind: 'source', sourceId: src, root: '40', defaultLevel: 'dm' });
    const made = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'Session 9', markdown: 'They met a fence.' });
    assert.ok(writes.some((w) => w.method === 'POST' && w.path === '/journals' && w.body.parent_id === 40));
    assert.equal(k.ents.get(Number(made.ref.slice(6)))!.kind, 'journal');
    // A note is a different type from this root.
    assert.equal((await e.lore('POST', '/pages', { id: 'kanka:11', markdown: 'x' })).status, 403);
  } finally { e.close(); }
});

test('TestWorldLoreKanka_RootGuardRefusesOutsideMoveOutDeleteRootAndOtherTypes', async () => {
  for (const listParents of [true, false]) {
    const k = new FakeKanka();
    k.listParents = listParents;
    const writes: any[] = [];
    const e = await boot({ fetch: kankaFetch(k, writes) });
    try {
      const src = addSource(e, 'kanka-api', CFG);
      await setLore(e, { kind: 'source', sourceId: src, root: 'kanka:10', defaultLevel: 'dm' });
      const inside = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'Inside', markdown: 'text', parent: 'kanka:12' });
      const before = writes.length;
      const refuse = async (r: Promise<{ status: number; body: any }>, what: string) => { const x = await r; assert.equal(x.status, 403, `${what} (parents listed: ${listParents}) -> ${JSON.stringify(x.body)}`); };

      // Outside the root: update, delete, create under it, move it, move into it.
      await refuse(e.lore('POST', '/pages', { id: 'kanka:21', markdown: 'x' }), 'update outside');
      await refuse(e.lore('DELETE', '/pages/kanka:21'), 'delete outside');
      await refuse(e.lore('DELETE', '/pages/kanka:20'), 'delete outside top-level');
      await refuse(e.lore('POST', '/pages', { title: 'sneaky', markdown: 'x', parent: 'kanka:21' }), 'create under outside');
      await refuse(e.lore('POST', '/pages/kanka:21/move', { to: 'kanka:10' }), 'move an outside page in');
      // Moving out of the root.
      await refuse(e.lore('POST', `/pages/${inside.ref}/move`, { to: 'kanka:20' }), 'move out of the root');
      await refuse(e.lore('POST', `/pages/${inside.ref}/move`, { to: 'kanka:40' }), 'move to another entity');
      // The root itself: delete, move, rename.
      await refuse(e.lore('DELETE', '/pages/kanka:10'), 'delete the root');
      await refuse(e.lore('POST', '/pages/kanka:10/move', { to: 'kanka:11' }), 'move the root');
      await refuse(e.lore('POST', '/pages', { id: 'kanka:10', title: 'Renamed' }), 'rename the root');
      // Another entity type: a character, and a journal, even one parented under the note root.
      await refuse(e.lore('POST', '/pages', { id: 'kanka:50', markdown: 'x' }), 'a character');
      await refuse(e.lore('DELETE', '/pages/kanka:41'), 'a journal under a note root');
      await refuse(e.lore('POST', '/pages', { title: 'x', markdown: 'y', parent: 'kanka:40' }), 'create under a journal');
      // A page cannot move into its own child.
      assert.equal((await e.lore('POST', '/pages/kanka:11/move', { to: 'kanka:13' })).status, 400, 'into its own child');
      // Junk ids.
      assert.equal((await e.lore('DELETE', '/pages/kanka:1;DROP')).status >= 400, true);
      assert.equal((await e.lore('POST', '/pages', { id: 'abc', markdown: 'x' })).status >= 400, true);

      assert.equal(writes.length, before, `no write reached Kanka (parents listed: ${listParents})`);
      for (const id of [10, 11, 20, 21, 40, 41, 50]) assert.ok(k.ents.has(id), `entity ${id} untouched`);
      assert.equal(k.ents.get(11)!.parent, 10);
    } finally { e.close(); }
  }
});

test('TestWorldLoreKanka_GuardReadsTheParentChainFreshEveryWrite', async () => {
  const k = new FakeKanka();
  const writes: any[] = [];
  const e = await boot({ fetch: kankaFetch(k, writes) });
  try {
    const src = addSource(e, 'kanka-api', CFG);
    await setLore(e, { kind: 'source', sourceId: src, root: 'kanka:10', defaultLevel: 'dm' });
    const page = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'Mover', markdown: 'text' });
    const eid = Number(page.ref.slice(6));
    // Someone moves the page out of the root inside Kanka itself. Alexandria's library still thinks it is inside.
    k.ents.get(eid)!.parent = 20;
    assert.ok(pageRow(e, 'external_id = ?', page.ref).parent_external === 'kanka:10', 'the library cache is stale');
    k.calls.length = 0;
    const before = writes.length;
    assert.equal((await e.lore('POST', '/pages', { id: page.id, markdown: 'changed' })).status, 403, 'stale cache must not be trusted');
    assert.equal((await e.lore('DELETE', `/pages/${page.id}`)).status, 403);
    assert.equal(writes.length, before);
    assert.ok(k.calls.some((c) => c === `GET /entities/${eid}`), 'the target was read from Kanka');
    assert.ok(k.calls.some((c) => c === 'GET /entities/10'), 'and so was the root');
  } finally { e.close(); }
});

test('TestWorldLoreKanka_ReadOnlyTokenCannotWriteAnd429IsRetried', async () => {
  const k = new FakeKanka();
  const writes: any[] = [];
  const e = await boot({ fetch: kankaFetch(k, writes) });
  try {
    const ro = addSource(e, 'kanka-api', { ...CFG, token: READ_TOKEN }, 'RO');
    await setLore(e, { kind: 'source', sourceId: ro, root: 'kanka:10', defaultLevel: 'dm' });
    const r = await lorePage(e, { title: 'x', markdown: 'y' });
    assert.equal(r.status, 403);
    assert.match(JSON.stringify(r.body), /token/i);
    assert.equal([...k.ents.values()].filter((x) => x.name === 'x').length, 0);

    const rw = addSource(e, 'kanka-api', CFG, 'RW');
    await setLore(e, { kind: 'source', sourceId: rw, root: 'kanka:10', defaultLevel: 'dm' });
    k.throttle = 3;
    const made = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'After the throttle', markdown: 'ok' });
    assert.equal(k.throttle, 0, 'the 429s were waited out and retried');
    assert.ok(k.ents.has(Number(made.ref.slice(6))));
    assert.equal(kinds(writes).filter((m) => m === 'POST').length >= 2, true);
  } finally { e.close(); }
});

// ---- levels ----------------------------------------------------------------------------------

test('TestWorldLoreKanka_LevelsSetIsPrivateAndTheBrokerAndClassifiedTags', async () => {
  const k = new FakeKanka();
  const writes: any[] = [];
  const e = await boot({ fetch: kankaFetch(k, writes) });
  try {
    const src = addSource(e, 'kanka-api', CFG, 'Kanka', 'party');
    // Workspace default dm: party is not allowed, saved DM-only.
    await setLore(e, { kind: 'source', sourceId: src, root: 'kanka:10', defaultLevel: 'dm' });
    const asked = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'Wants party', markdown: 'x', level: 'party' });
    assert.equal(asked.level, 'dm');
    assert.equal(k.ents.get(Number(asked.ref.slice(6)))!.isPrivate, true);

    await setLore(e, { kind: 'source', sourceId: src, root: 'kanka:10', defaultLevel: 'party' });
    const open = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'Open', markdown: 'players may read this' });
    const openEnt = k.ents.get(Number(open.ref.slice(6)))!;
    assert.equal(open.level, 'party');
    assert.equal(openEnt.isPrivate, false, 'party only when the workspace default allows it');
    assert.deepEqual(openEnt.tags, []);
    assert.equal(pageRow(e, 'external_id = ?', open.ref).visibility, 'party');

    // dm: private, no level tag.
    const dm = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'Dm only', markdown: 'x', level: 'dm' });
    assert.equal(k.ents.get(Number(dm.ref.slice(6)))!.isPrivate, true);
    assert.deepEqual(k.ents.get(Number(dm.ref.slice(6)))!.tags, []);

    // broker: private, and the tag `broker` is created when missing.
    assert.ok(![...k.tags.values()].some((t) => t.name === 'broker'));
    const br = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'For sale', markdown: 'x', level: 'broker' });
    const brEnt = k.ents.get(Number(br.ref.slice(6)))!;
    assert.equal(brEnt.isPrivate, true);
    assert.deepEqual(k.tagNames(brEnt), ['broker']);
    const brokerTag = [...k.tags.values()].find((t) => t.name === 'broker')!;
    assert.equal(brokerTag.isPrivate, true, 'the level tags are private in Kanka');
    assert.equal(pageRow(e, 'external_id = ?', br.ref).visibility, 'broker');

    // classified: private + tag `classified`, the broker tag reused only for broker.
    const cl = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'Never an AI', markdown: 'zz-classified-fact', level: 'classified' });
    const clEnt = k.ents.get(Number(cl.ref.slice(6)))!;
    assert.deepEqual(k.tagNames(clEnt), ['classified']);
    assert.equal(pageRow(e, 'external_id = ?', cl.ref).visibility, 'classified');

    // A second broker page reuses the tag.
    const br2 = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'For sale 2', markdown: 'x', level: 'broker' });
    assert.deepEqual(k.ents.get(Number(br2.ref.slice(6)))!.tags, [brokerTag.id]);
    assert.equal([...k.tags.values()].filter((t) => t.name === 'broker').length, 1);

    // Changing the level swaps the level tag and keeps the page's other tags.
    const folder = k.ents.get(11)!;
    assert.deepEqual(folder.tags, [901]);
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { id: 'kanka:11', level: 'broker' });
    assert.deepEqual(k.tagNames(folder).sort(), ['Lore', 'broker']);
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { id: 'kanka:11', level: 'classified' });
    assert.deepEqual(k.tagNames(folder).sort(), ['Lore', 'classified']);
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { id: 'kanka:11', level: 'party' });
    assert.deepEqual(k.tagNames(folder), ['Lore']);
    assert.equal(folder.isPrivate, false);
    // An update without a level keeps tags and privacy.
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { id: br.ref, markdown: 'new text' });
    assert.deepEqual(k.tagNames(brEnt), ['broker']);
    assert.equal(brEnt.isPrivate, true);

    // Secret text in a party page makes Kanka's page private (never a public blockquote).
    const sneaky = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'Half secret', markdown: 'Public line\n\n> [!secret]\n> the twist', level: 'party' });
    assert.equal(k.ents.get(Number(sneaky.ref.slice(6)))!.isPrivate, true);
  } finally { e.close(); }
});

test('TestWorldLoreKanka_LevelPlanAndMarkdownHelpers', () => {
  assert.deepEqual(levelPlan('party', 'plain'), { level: 'party', isPrivate: false });
  assert.deepEqual(levelPlan('dm', 'plain'), { level: 'dm', isPrivate: true });
  assert.deepEqual(levelPlan('broker', undefined), { level: 'broker', isPrivate: true });
  assert.deepEqual(levelPlan(undefined, 'plain'), {});
  assert.deepEqual(levelPlan(undefined, '> [!secret]\n> x'), { isPrivate: true });
  assert.deepEqual(levelPlan('party', '> [!classified]\n> x'), { level: 'classified', isPrivate: true });
  assert.equal(markdownLevel('## Broker notes\n\nx'), 'broker');
  assert.equal(markdownLevel('# Title\n\nHello'), 'party');
  const html = mdToKankaHtml('A <script>alert(1)</script> & `code`\n\n1. a\n2. b\n\n> quote\n\n---\n\n[link](https://x.test/a?b=1&c=2) and [entity:12]');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ol><li>a<\/li><li>b<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>quote<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<a href="https:\/\/x\.test\/a\?b=1&amp;c=2">link<\/a>/);
  assert.match(html, /\[entity:12\]/);
  assert.ok(!/href="javascript/.test(mdToKankaHtml('[x](javascript:alert(1))')));
});

// ---- the picker ---------------------------------------------------------------------------------

test('TestWorldLoreKanka_OptionsListTopLevelNotesAndJournalsSearchAndLink', async () => {
  const k = new FakeKanka();
  const e = await boot({ fetch: kankaFetch(k) });
  try {
    const src = addSource(e, 'kanka-api', CFG, 'Kanka');
    const o = await e.ok('GET', `/api/worlds/${e.W}/worldlore/options`, e.T.dm);
    const s = o.sources.find((x: any) => x.name === 'Kanka');
    assert.deepEqual(s.roots.map((r: any) => r.id).sort(), ['kanka:10', 'kanka:20', 'kanka:40'], 'top-level notes and journals only');
    assert.equal(s.roots.find((r: any) => r.id === 'kanka:40').kind, 'journal');
    const found = await e.ok('GET', `/api/worlds/${e.W}/worldlore/options/search?source=${src}&q=deep`, e.T.dm);
    assert.deepEqual(found.roots.map((r: any) => r.id).sort(), ['kanka:12', 'kanka:13']);
    assert.deepEqual((await e.ok('GET', `/api/worlds/${e.W}/worldlore/options/search?source=${src}&q=`, e.T.dm)).roots, []);
    assert.equal((await e.call('GET', `/api/worlds/${e.W}/worldlore/options/search?source=${src}&q=x`, e.T.jess)).status, 403);

    // A bad root is refused when saving; a good one gets a link to the Kanka page.
    assert.equal((await e.lore('PUT', '/config', { kind: 'source', sourceId: src, root: 'My note', defaultLevel: 'dm' })).status, 400);
    const st = await e.ok('PUT', `/api/worlds/${e.W}/worldlore/config`, e.T.dm, { kind: 'source', sourceId: src, root: '10', defaultLevel: 'dm' });
    assert.equal(st.config.root, 'kanka:10');
    assert.equal(st.links.url, 'https://kanka.test/w/7/entities/10', 'a self-hosted Kanka: its own address, marked as a guess');
    assert.equal(st.links.guess, true);
    const cloud = addSource(e, 'kanka-api', { ...CFG, apiUrl: 'https://api.kanka.io/1.0' }, 'Cloud');
    const cl = await e.ok('PUT', `/api/worlds/${e.W}/worldlore/config`, e.T.dm, { kind: 'source', sourceId: cloud, root: 'kanka:10', defaultLevel: 'dm' });
    assert.equal(cl.links.url, 'https://app.kanka.io/w/7/entities/10');
    assert.equal(cl.links.guess, false);
    await setLore(e, { kind: 'source', sourceId: src, root: '10', defaultLevel: 'dm' });
    assert.ok(st.config.root && (await e.ok('GET', `/api/worlds/${e.W}/settings`, e.T.dm)).agentAutoApprove.includes('lore_write'));
    // A root that turns out not to be a note or journal is refused at write time.
    await setLore(e, { kind: 'source', sourceId: src, root: 'kanka:50', defaultLevel: 'dm' });
    assert.equal((await lorePage(e, { title: 'x', markdown: 'y' })).status, 403);
  } finally { e.close(); }
});

test('TestWorldLoreKanka_PlayersCannotUseLoreTools', async () => {
  const k = new FakeKanka();
  const writes: any[] = [];
  const e = await boot({ fetch: kankaFetch(k, writes) });
  try {
    const src = addSource(e, 'kanka-api', CFG);
    await setLore(e, { kind: 'source', sourceId: src, root: 'kanka:10', defaultLevel: 'dm' });
    const page = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'Hidden Lore', markdown: 'zxqv-secret-fact' });
    const before = writes.length;
    for (const [m, sub, b] of [['GET', '', undefined], ['GET', '/pages', undefined], ['GET', `/pages/${page.id}`, undefined], ['POST', '/pages', { title: 'p', markdown: 'x' }], ['POST', `/pages/${page.id}/move`, { to: 'kanka:11' }], ['DELETE', `/pages/${page.id}`, undefined], ['PUT', '/config', { enabled: false }], ['GET', '/options', undefined], ['GET', `/options/search?source=${src}&q=a`, undefined]] as const) {
      const r = await e.lore(m, sub, b, e.T.jess);
      assert.equal(r.status, 403, `${m} ${sub}`);
      assert.ok(!JSON.stringify(r.body).includes('zxqv'));
    }
    const key = await e.ok('POST', '/api/keys', e.T.jess, { scope: 'scribe', worldId: e.W, label: 'ai', access: 'read' });
    const out = await e.call('POST', '/mcp', key.key ?? key.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lore_write', arguments: { title: 'by a player', markdown: 'x' } } });
    assert.ok(out.body?.result?.isError === true || out.body?.error || out.status >= 400, JSON.stringify(out.body));
    assert.equal(writes.length, before, 'no write reached Kanka');
    assert.ok(![...k.ents.values()].some((x) => x.name === 'by a player'));
    assert.ok(!JSON.stringify((await e.call('GET', `/api/worlds/${e.W}/library/pages`, e.T.jess)).body).includes('Hidden Lore'));
  } finally { e.close(); }
});

// ---- MCP --------------------------------------------------------------------------------------------

test('TestWorldLoreKanka_McpWritesOnlyThroughTheNarrowAllowlist', async () => {
  const k = new FakeKanka();
  const mcp = fakeKankaMcp(k);
  const e = await boot({ testMcp: mcp });
  try {
    const src = addSource(e, 'kanka-mcp', { transport: 'http', url: 'http://kanka-mcp.test/mcp' }, 'KankaMCP');
    await setLore(e, { kind: 'source', sourceId: src, root: 'kanka:10', defaultLevel: 'dm' });

    const made = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'Mcp Page', markdown: 'Written through the MCP, see [entity:50]', level: 'broker', by: 'agent' });
    const eid = Number(made.ref.slice(6));
    const created = mcp.calls.find((c) => c.tool === 'create_entities')!.args.entities[0];
    assert.deepEqual([created.entity_type, created.parent_id, created.is_hidden, created.tags], ['note', 10, true, ['broker']]);
    assert.equal(k.ents.get(eid)!.parent, 10);
    assert.equal(pageRow(e, 'external_id = ?', made.ref).visibility, 'broker');
    assert.equal(syncs(e), 0, 're-synced one page');

    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { id: made.id, markdown: 'Changed text', level: 'dm' });
    assert.deepEqual(k.tagNames(k.ents.get(eid)!), []);
    assert.equal(pageRow(e, 'id = ?', made.id).visibility, 'dm');
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages/${made.id}/move`, e.T.dm, { to: 'kanka:12' });
    assert.equal(k.ents.get(eid)!.parent, 12);
    await e.ok('DELETE', `/api/worlds/${e.W}/worldlore/pages/${made.id}`, e.T.dm);
    assert.equal(k.ents.has(eid), false);

    const used = new Set(mcp.calls.map((c) => c.tool));
    assert.deepEqual([...used].sort(), ['create_entities', 'delete_entities', 'get_entities', 'update_entities']);

    // Outside the root, the root itself, other types: refused before any write tool runs.
    const writesBefore = () => mcp.calls.filter((c) => c.tool !== 'get_entities' && c.tool !== 'find_entities').length;
    const n = writesBefore();
    for (const [m, sub, b] of [['DELETE', '/pages/kanka:21', undefined], ['POST', '/pages/kanka:11/move', { to: 'kanka:20' }], ['POST', '/pages', { id: 'kanka:20', markdown: 'x' }], ['DELETE', '/pages/kanka:10', undefined], ['POST', '/pages', { id: 'kanka:50', markdown: 'x' }], ['POST', '/pages', { title: 'x', markdown: 'y', parent: 'kanka:21' }], ['DELETE', '/pages/kanka:41', undefined]] as const) {
      assert.equal((await e.lore(m, sub, b)).status, 403, `${m} ${sub}`);
    }
    assert.equal(writesBefore(), n);
    assert.ok(k.ents.has(21) && k.ents.has(20) && k.ents.has(10) && k.ents.has(50));
  } finally { e.close(); }
});

test('TestWorldLoreKanka_McpPickerListsTopLevelAndSearches', async () => {
  const k = new FakeKanka();
  const mcp = fakeKankaMcp(k);
  const e = await boot({ testMcp: mcp });
  try {
    const src = addSource(e, 'kanka-mcp', { transport: 'http', url: 'http://kanka-mcp.test/mcp' }, 'KankaMCP');
    const o = await e.ok('GET', `/api/worlds/${e.W}/worldlore/options`, e.T.dm);
    assert.deepEqual(o.sources.find((s: any) => s.name === 'KankaMCP').roots.map((r: any) => r.id).sort(), ['kanka:10', 'kanka:20', 'kanka:40']);
    const found = await e.ok('GET', `/api/worlds/${e.W}/worldlore/options/search?source=${src}&q=plans`, e.T.dm);
    assert.deepEqual(found.roots.map((r: any) => r.id).sort(), ['kanka:20', 'kanka:21']);
    assert.ok(mcp.calls.every((c) => c.tool === 'find_entities'), 'only read tools for the picker');
  } finally { e.close(); }
});

test('TestWorldLoreKanka_EveryOtherPathStillRefusesKankaWriteTools', async () => {
  const k = new FakeKanka();
  const raw = fakeKankaMcp(k);
  const c = connectorFor('kanka-mcp')!;
  const readTools = c.readTools!({});
  assert.deepEqual(readTools.sort(), ['find_entities', 'get_entities']);
  const WRITES = ['create_entities', 'update_entities', 'delete_entities', 'create_posts', 'update_posts', 'delete_posts', 'manage_relations', 'manage_attributes', 'manage_entity_tags', 'manage_permissions', 'manage_inventory', 'manage_entity_image', 'manage_calendars', 'manage_calendar_events', 'calendar_advance_date', 'run_migration_plan', 'manage_map_markers', 'manage_timeline_elements', 'manage_organisation_members'];

  // Sync, test and every other caller: no write tool at all.
  const plain = readOnlyMcp(raw as any, readTools);
  for (const t of WRITES) assert.throws(() => plain.call(t, { entities: [{ entity_type: 'note', name: 'x' }], updates: [{ entity_id: 1 }], entity_ids: [1] }), /not a read tool/, t);
  const viaFactory = makeMcpFactory(c, {}, {}, fetch, raw as any).factory();
  for (const t of WRITES) assert.throws(() => viaFactory.call(t, {}), /not a read tool/, t);
  // Even listed as "read tools", write-sounding names stay refused.
  const sneaky = readOnlyMcp(raw as any, [...readTools, ...WRITES]);
  for (const t of WRITES) assert.throws(() => sneaky.call(t, { entity_ids: [1] }), /not a read tool/, t);
  assert.equal(raw.calls.length, 0, 'nothing reached the server');

  // The WorldLore client: the three entity tools, notes and journals only, and nothing else.
  const ws = workspaceMcpFactory(c, {}, {}, fetch, raw as any).factory();
  await assert.doesNotReject(ws.call('create_entities', { entities: [{ entity_type: 'note', name: 'x', parent_id: 10 }] }));
  await assert.doesNotReject(ws.call('create_entities', { entities: [{ entity_type: 'journal', name: 'x', parent_id: 40 }] }));
  await assert.doesNotReject(ws.call('update_entities', { updates: [{ entity_id: 11, name: 'y' }] }));
  await assert.doesNotReject(ws.call('delete_entities', { entity_ids: [11] }));
  assert.throws(() => ws.call('create_entities', { entities: [{ entity_type: 'character', name: 'x' }] }), /notes and journals only/);
  assert.throws(() => ws.call('create_entities', { entities: [] }), /one to/);
  assert.throws(() => ws.call('update_entities', { updates: [{ name: 'no id' }] }), /entity_id/);
  assert.throws(() => ws.call('delete_entities', { entity_ids: ['11'] }), /integer/);
  assert.throws(() => ws.call('delete_entities', { entity_ids: Array.from({ length: 50 }, (_, i) => i + 1) }), /one to/);
  for (const t of WRITES.filter((x) => !['create_entities', 'update_entities', 'delete_entities'].includes(x))) assert.throws(() => ws.call(t, {}), /not a read tool/, t);
  // The LegendKeeper write tools are not reachable on the Kanka server, nor Kanka's on other connectors.
  for (const t of ['create_resource', 'write_page', 'delete_resource', 'api_request']) assert.throws(() => ws.call(t, { confirm: true }), /not a read tool/, t);
  const lk = workspaceMcpFactory(connectorFor('legendkeeper-mcp')!, {}, {}, fetch, raw as any).factory();
  for (const t of ['create_entities', 'update_entities', 'delete_entities']) assert.throws(() => lk.call(t, { entities: [{ entity_type: 'note' }], updates: [{ entity_id: 1 }], entity_ids: [1] }), /not a read tool/, t);
  const md = workspaceMcpFactory(connectorFor('markdown-folder')!, {}, {}, fetch, raw as any).factory();
  assert.throws(() => md.call('delete_entities', { entity_ids: [1] }), /not a read tool/);
  const rest = connectorFor('kanka-api')!;
  assert.equal(rest.readTools, undefined);
});

test('TestWorldLoreKanka_McpPostsRelationsAndOtherToolsNeverRunFromWorldLore', async () => {
  // Whatever the agent asks, the workspace code path only ever calls the entity tools.
  const k = new FakeKanka();
  const mcp = fakeKankaMcp(k);
  const e = await boot({ testMcp: mcp });
  try {
    const src = addSource(e, 'kanka-mcp', { transport: 'http', url: 'http://kanka-mcp.test/mcp' }, 'KankaMCP');
    await setLore(e, { kind: 'source', sourceId: src, root: 'kanka:10', defaultLevel: 'dm' });
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.T.dm, { title: 'a', markdown: 'b' });
    await e.lore('POST', '/pages', { id: 'kanka:20', markdown: 'x' });
    const bad = mcp.calls.filter((c) => !['get_entities', 'find_entities', 'create_entities', 'update_entities', 'delete_entities'].includes(c.tool));
    assert.deepEqual(bad, []);
  } finally { e.close(); }
});
