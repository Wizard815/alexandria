// WorldLore on World Anvil: one category is the home; the agent creates,
// updates, moves and deletes articles under it (nested with articleParent).
// Runs against a fake World Anvil built from the API v2 (Boromir) schemas.
// Everything outside the root stays untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { one, run } from '../src/core/db.ts';
import { mdToBbcode, levelTags } from '../src/intake/connectors/worldanvil-write.ts';

const BASE = 'https://www.worldanvil.com/api/external/boromir';
const WORLD = '11111111-1111-4111-8111-111111111111';
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROOT = u(1); const SUB = u(2); const OUT = u(9);
const CFG = { worldId: WORLD, token: 'user-token-abcdef', appKey: 'app-key-123456' };

interface Art { id: string; title: string; content: string; category: string | null; parent: string | null; state: string; tags: string }
class FakeWA {
  cats = new Map<string, { id: string; title: string; parent: string | null }>();
  arts = new Map<string, Art>();
  writes: { method: string; id?: string; body?: any }[] = [];
  next = 100;
  constructor() {
    this.cats.set(ROOT, { id: ROOT, title: 'WorldLore', parent: null });
    this.cats.set(SUB, { id: SUB, title: 'WorldLore NPCs', parent: ROOT });
    this.cats.set(OUT, { id: OUT, title: 'Player Handouts', parent: null });
    this.art(u(10), 'Inside page', SUB, null);
    this.art(u(11), 'Inside child', SUB, u(10));
    this.art(u(90), 'Outside page', OUT, null);
  }
  art(id: string, title: string, category: string | null, parent: string | null) { this.arts.set(id, { id, title, content: '', category, parent, state: 'private', tags: '' }); }
  articleJson(a: Art) {
    return { id: a.id, title: a.title, state: a.state, isDraft: false, entityClass: 'Article', tags: a.tags, content: a.content, url: `https://www.worldanvil.com/w/realm/a/${a.id}`, updateDate: { date: '2026-02-01 10:00:00.000000', timezone: 'UTC' },
      category: a.category ? { id: a.category, title: this.cats.get(a.category)?.title } : null, articleParent: a.parent ? { id: a.parent } : null, world: { id: WORLD, entityClass: 'World' }, success: true };
  }
  fetch = (async (url: any, init?: RequestInit) => {
    const s = String(url);
    if (!s.startsWith(BASE)) return new Response('{}', { status: 500 });
    const q = new URL(s);
    const p = q.pathname.slice('/api/external/boromir'.length);
    const id = q.searchParams.get('id') ?? '';
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const h = (init?.headers ?? {}) as Record<string, string>;
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    if (h['x-application-key'] !== 'app-key-123456' || h['x-auth-token'] !== 'user-token-abcdef') return json({ success: false }, 401);
    if (p === '/article' && method === 'GET') { const a = this.arts.get(id); return a ? json(this.articleJson(a)) : json({ success: false }, 404); }
    if (p === '/category' && method === 'GET') { const c = this.cats.get(id); return c ? json({ id: c.id, title: c.title, state: 'private', parent: c.parent ? { id: c.parent } : null, world: { id: WORLD }, success: true }) : json({ success: false }, 404); }
    if (p === '/world/categories') return json({ success: true, entities: [...this.cats.values()].map((c) => ({ id: c.id, title: c.title })) });
    if (p === '/article' && method === 'PUT') {
      this.writes.push({ method, body });
      const nid = u(this.next++);
      this.arts.set(nid, { id: nid, title: body.title, content: body.content, category: body.category?.id ?? null, parent: body.articleParent?.id ?? null, state: body.state, tags: body.tags ?? '' });
      return json({ id: nid, title: body.title, success: true });
    }
    if (p === '/article' && method === 'PATCH') {
      this.writes.push({ method, id, body });
      const a = this.arts.get(id);
      if (!a) return json({ success: false }, 404);
      if (body.title !== undefined) a.title = body.title;
      if (body.content !== undefined) a.content = body.content;
      if (body.state !== undefined) a.state = body.state;
      if (body.tags !== undefined) a.tags = body.tags;
      if (body.category !== undefined) a.category = body.category?.id ?? null;
      if ('articleParent' in body) a.parent = body.articleParent?.id || null;
      return json({ id, success: true });
    }
    if (p === '/article' && method === 'DELETE') { this.writes.push({ method, id }); this.arts.delete(id); return json({ success: true }); }
    return json({ success: false }, 404);
  }) as typeof fetch;
}

async function boot(fetchImpl: typeof fetch) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-wlwa-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fetchImpl, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_CRAWL_RATE: '0' } });
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
  const ok = async (method: string, url: string, token?: string, body?: unknown) => { const r = await call(method, url, token, body); assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const gmId = (await ok('POST', '/api/admin/accounts', admin, { username: 'dungeon', password: 'gm password 123' })).account.id;
  const gm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'gm password 123' })).token;
  const W = (await ok('POST', '/api/admin/worlds', admin, { name: 'Realm', gmAccountId: gmId })).id;
  const src = `src_${Math.random().toString(36).slice(2, 10)}`;
  run(made.deps.db, 'INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES (?, ?, ?, ?, ?, ?)', src, W, 'worldanvil-api', 'World Anvil', JSON.stringify(CFG), 'party');
  const lore = (method: string, sub: string, body?: unknown) => call(method, `/api/worlds/${W}/worldlore${sub}`, gm, body);
  return { deps: made.deps, W, src, gm, ok, call, lore, close: () => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

test('TestWorldLoreWorldAnvil_CreateUpdateMoveDeleteInsideTheCategory', async () => {
  const wa = new FakeWA();
  const e = await boot(wa.fetch);
  try {
    // The options list the world's categories; the root is saved as wa:<id>.
    const o = await e.ok('GET', `/api/worlds/${e.W}/worldlore/options`, e.gm);
    assert.ok(JSON.stringify(o).includes(`wa:${ROOT}`));
    await e.ok('PUT', `/api/worlds/${e.W}/worldlore/config`, e.gm, { kind: 'source', sourceId: e.src, root: ROOT, defaultLevel: 'gm' });
    // Create at the top of the workspace: an article in the root category, private, BBCode content.
    const made = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.gm, { title: 'Odda the Fence', markdown: `# Odda\n\nShe sells **maps** and knows [[@wa:${u(10)}|the inside page]].\n\n- one\n- two`, by: 'agent' });
    assert.equal(made.created, true);
    const put = wa.writes.find((w) => w.method === 'PUT')!;
    assert.deepEqual([put.body.category, put.body.world, put.body.templateType, put.body.state], [{ id: ROOT }, { id: WORLD }, 'article', 'private']);
    assert.match(put.body.content, /\[h1\]Odda\[\/h1\]/);
    assert.match(put.body.content, /\[b\]maps\[\/b\]/);
    assert.ok(put.body.content.includes(`@[the inside page](article:${u(10)})`));
    assert.match(put.body.content, /\[ul\]\[li\]one\[\/li\]\[li\]two\[\/li\]\[\/ul\]/);
    const row = one<any>(e.deps.db, 'SELECT * FROM pages WHERE world_id = ? AND external_id = ?', e.W, made.ref);
    assert.equal(row.title, 'Odda the Fence');
    assert.equal(row.visibility, 'gm');
    assert.equal(row.parent_external, `wa:${ROOT}`);

    // Nested under an article inside the root (in a sub-category).
    const deep = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.gm, { title: 'Under', markdown: 'Down here', parent: `wa:${u(11)}` });
    const d = wa.arts.get(deep.ref.slice(3))!;
    assert.deepEqual([d.category, d.parent], [SUB, u(11)]);

    // Update, move under the inside page, move back to the top, delete.
    const id = made.ref.slice(3);
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.gm, { id: row.id, markdown: 'Now she sells **charts**.' });
    assert.match(wa.arts.get(id)!.content, /\[b\]charts\[\/b\]/);
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages/${row.id}/move`, e.gm, { to: `wa:${u(10)}` });
    assert.deepEqual([wa.arts.get(id)!.category, wa.arts.get(id)!.parent], [SUB, u(10)]);
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages/${row.id}/move`, e.gm, { to: null });
    assert.deepEqual([wa.arts.get(id)!.category, wa.arts.get(id)!.parent], [ROOT, null]);
    await e.ok('DELETE', `/api/worlds/${e.W}/worldlore/pages/${row.id}`, e.gm);
    assert.equal(wa.arts.has(id), false);
    assert.ok(wa.arts.has(u(90)), 'the outside article is untouched');
  } finally { e.close(); }
});

test('TestWorldLoreWorldAnvil_GuardRefusesOutsideTheRootTheRootItselfAndCategories', async () => {
  const wa = new FakeWA();
  const e = await boot(wa.fetch);
  try {
    // An article is not a home: the root must be a category.
    await e.ok('PUT', `/api/worlds/${e.W}/worldlore/config`, e.gm, { kind: 'source', sourceId: e.src, root: `wa:${u(10)}`, defaultLevel: 'gm' });
    assert.equal((await e.lore('POST', '/pages', { title: 'x', markdown: 'y' })).status, 403);
    await e.ok('PUT', `/api/worlds/${e.W}/worldlore/config`, e.gm, { kind: 'source', sourceId: e.src, root: `wa:${ROOT}`, defaultLevel: 'gm' });
    assert.equal((await e.call('PUT', `/api/worlds/${e.W}/worldlore/config`, e.gm, { kind: 'source', sourceId: e.src, root: 'not-an-id', defaultLevel: 'gm' })).status, 400);
    const refuse = async (r: Promise<{ status: number; body: any }>, what: string) => { const x = await r; assert.equal(x.status, 403, `${what} -> ${JSON.stringify(x.body)}`); };
    await refuse(e.lore('POST', '/pages', { id: `wa:${u(90)}`, markdown: 'x' }), 'update outside');
    await refuse(e.lore('DELETE', `/pages/wa:${u(90)}`), 'delete outside');
    await refuse(e.lore('POST', '/pages', { title: 'sneaky', markdown: 'x', parent: `wa:${u(90)}` }), 'create under outside');
    await refuse(e.lore('POST', '/pages', { title: 'sneaky', markdown: 'x', parent: `wa:${OUT}` }), 'create in an outside category');
    await refuse(e.lore('POST', `/pages/wa:${u(90)}/move`, { to: `wa:${ROOT}` }), 'move an outside page in');
    await refuse(e.lore('POST', `/pages/wa:${u(10)}/move`, { to: `wa:${OUT}` }), 'move out of the root');
    await refuse(e.lore('DELETE', `/pages/wa:${ROOT}`), 'delete the root');
    await refuse(e.lore('POST', '/pages', { id: `wa:${ROOT}`, title: 'Renamed' }), 'rename the root');
    await refuse(e.lore('POST', '/pages', { id: `wa:${SUB}`, markdown: 'x' }), 'a category is never written');
    assert.equal((await e.lore('POST', `/pages/wa:${u(10)}/move`, { to: `wa:${u(11)}` })).status, 400, 'into its own child');
    assert.deepEqual(wa.writes, [], 'nothing reached World Anvil');
  } finally { e.close(); }
});

test('TestWorldLoreWorldAnvil_LevelsSetStateAndTagsAndSecretTextStaysPrivate', async () => {
  const wa = new FakeWA();
  const e = await boot(wa.fetch);
  try {
    await e.ok('PUT', `/api/worlds/${e.W}/worldlore/config`, e.gm, { kind: 'source', sourceId: e.src, root: `wa:${ROOT}`, defaultLevel: 'party' });
    const open = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.gm, { title: 'Open', markdown: 'players may read this' });
    assert.equal(wa.arts.get(open.ref.slice(3))!.state, 'public');
    const twist = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.gm, { title: 'Half secret', markdown: 'Public line\n\n> [!secret]\n> the twist', level: 'party' });
    assert.equal(wa.arts.get(twist.ref.slice(3))!.state, 'private', 'secret text makes the article private');
    const br = await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.gm, { title: 'For sale', markdown: 'x', level: 'broker' });
    assert.deepEqual([wa.arts.get(br.ref.slice(3))!.state, wa.arts.get(br.ref.slice(3))!.tags], ['private', 'broker']);
    await e.ok('POST', `/api/worlds/${e.W}/worldlore/pages`, e.gm, { id: br.ref, level: 'classified' });
    assert.equal(wa.arts.get(br.ref.slice(3))!.tags, 'classified');
  } finally { e.close(); }
});

test('TestWorldLoreWorldAnvil_MarkdownToBbcodeNeutralisesTags', () => {
  const bb = mdToBbcode('Hi [secret:abc] and [subcontainer:x]sneak[/subcontainer] `code [b]` [site](https://example.com)\n\n## Two\n\n1. a\n2. b\n\n---');
  assert.ok(!bb.includes('[secret:') && !bb.includes('[subcontainer'), bb);
  assert.ok(bb.includes('[url:https://example.com]site[/url]') && bb.includes('[h2]Two[/h2]') && bb.includes('[ol][li]a[/li][li]b[/li][/ol]') && bb.includes('[hr]'), bb);
  assert.deepEqual(levelTags(['lore', 'broker'], 'classified'), ['lore', 'classified']);
  assert.deepEqual(levelTags(['lore', 'broker'], 'gm'), ['lore']);
});
