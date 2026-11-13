// Item cards: items linked to library pages, the card a DM or player gets,
// who may link, and that DM-only page content never reaches a player.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { run } from '../src/core/db.ts';
import { excerpt } from '../src/features/itemcards/index.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const P: Record<string, string> = {};
let W = '';
const IC = () => `/api/worlds/${W}/itemcards`;
const INV = () => `/api/worlds/${W}/inventory`;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const SECRET_WORDS = ['Ashgrove cult', 'Mordane', 'cursed by the lich', 'Buried truth'];
const noSecrets = (where: string, x: unknown) => {
  const s = typeof x === 'string' ? x : JSON.stringify(x);
  for (const w of SECRET_WORDS) assert.ok(!s.includes(w), `${where} leaked "${w}": ${s.slice(0, 400)}`);
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-itemcards-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: {} });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Cardland', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
  const page = async (p: string, visibility: string, markdown: string) => (await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: p, visibility, markdown })).id;
  P.md = await page('items/Moonblade', 'party', `# Moonblade\nA silver sword that glows near undead.\n\n> [!secret] DM\n> The blade is cursed by the lich Mordane.\n\n## History\nForged in Westmarch.\n`);
  P.dmOnly = await page('dm/Ashgrove', 'dm', `# Ashgrove\nThe Ashgrove cult meets under the old mill.\n`);

  // A structured (LegendKeeper-style) page with facts, a DM fact group and a secret block.
  run(deps.db, `INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s1', ?, 'api', 'Wiki', '{}', 'party')`, W);
  P.lk = deps.library.saveEntry(W, 's1', 'wiki', {
    externalId: 'e1', title: 'Ring of Warding', visibility: 'party', folder: ['Items'],
    properties: [
      { title: 'Facts', rows: [{ key: 'Rarity', value: [{ text: 'Rare' }] }] },
      { title: 'DM facts', dm: true, rows: [{ key: 'Curse', value: [{ text: 'Mordane watches the wearer' }] }] },
    ],
    blocks: [
      { kind: 'paragraph', content: [{ text: 'A plain iron ring.' }] },
      { kind: 'secret', children: [{ kind: 'paragraph', content: [{ text: 'Buried truth: it was made by the Ashgrove cult.' }] }] },
      { kind: 'heading', level: 2, content: [{ text: 'Later' }] },
      { kind: 'paragraph', content: [{ text: 'More text.' }] },
    ],
  }, null).id;
  deps.library.rebuildPlayerCopies(W);
});

after(async () => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const add = (token: string, body: Record<string, unknown>) => ok('POST', INV(), token, body);

test('TestItemCards_DMSeesFullCardAndPlayerOnlyThePlayerCopy', async () => {
  const dmIt = await add(T.dm, { owner: ID.jess, name: 'Moonblade', qty: 1, note: 'Family heirloom', dmNote: 'Handle with care', pageId: P.md, reason: 'gift' });
  assert.equal(dmIt.pageId, P.md);
  const lkIt = await add(T.dm, { owner: ID.jess, name: 'Ring of Warding', pageId: P.lk, dmNote: 'secret note', reason: 'gift' });

  const dmCard = await ok('GET', `${IC()}/${dmIt.id}`, T.dm);
  assert.equal(dmCard.item.dmNote, 'Handle with care');
  assert.equal(dmCard.page.title, 'Moonblade');
  assert.ok(JSON.stringify(dmCard.page.excerpt).includes('silver sword'));
  assert.ok(dmCard.page.openPath.includes('/dm/library?page='));

  const pCard = await ok('GET', `${IC()}/${dmIt.id}`, T.jess);
  assert.equal(pCard.item.note, 'Family heirloom');
  assert.equal(pCard.item.dmNote, undefined);
  assert.equal(pCard.page.title, 'Moonblade');
  assert.ok(JSON.stringify(pCard.page.excerpt).includes('silver sword'));
  assert.ok(!pCard.page.openPath.includes('/dm/'));
  noSecrets('markdown card', pCard);
  assert.ok(!JSON.stringify(pCard).includes('Handle with care'));

  // Structured page: facts and the DM fact group.
  const dmLk = await ok('GET', `${IC()}/${lkIt.id}`, T.dm);
  assert.ok(dmLk.page.facts.some((g: any) => g.dm));
  const pLk = await ok('GET', `${IC()}/${lkIt.id}`, T.jess);
  assert.deepEqual(pLk.page.facts.map((g: any) => g.title), ['Facts']);
  assert.ok(JSON.stringify(pLk.page.excerpt).includes('plain iron ring'));
  noSecrets('structured card', pLk);
  assert.equal(pLk.item.dmNote, undefined);
  // The inventory list itself carries pageId.
  const list = await ok('GET', `${INV()}?owner=me`, T.jess);
  assert.ok(list.items.some((i: any) => i.pageId === P.md));
});

test('TestItemCards_DMOnlyPageGivesPlayersNothingFromThePage', async () => {
  const it = await add(T.dm, { owner: ID.jess, name: 'Ashen token', note: 'A burnt token', pageId: P.dmOnly, reason: 'gift' });
  const dmCard = await ok('GET', `${IC()}/${it.id}`, T.dm);
  assert.ok(JSON.stringify(dmCard.page).includes('Ashgrove cult'));
  const pCard = await ok('GET', `${IC()}/${it.id}`, T.jess);
  assert.equal(pCard.page, null);
  assert.equal(pCard.item.note, 'A burnt token');
  noSecrets('dm-only page card', pCard);
  assert.ok(!JSON.stringify(pCard).includes('Ashgrove'));

  // Missing player copy (page was shared, then went back to DM-only).
  const pg = await ok('GET', `/api/worlds/${W}/library/pages/${P.md}`, T.dm);
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: pg.path, visibility: 'dm', body: pg.body });
  const md = (await ok('GET', `${INV()}?owner=me`, T.jess)).items.find((i: any) => i.name === 'Moonblade');
  const hidden = await ok('GET', `${IC()}/${md.id}`, T.jess);
  assert.equal(hidden.page, null);
  noSecrets('unshared page', hidden);
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: pg.path, visibility: 'party', body: pg.body });
});

test('TestItemCards_OnlyOwnerOrDMCanLink', async () => {
  const it = await add(T.dm, { owner: ID.jess, name: 'Lantern', reason: 'gift' });
  // Another player may not even see the card, and cannot link.
  assert.equal((await call('GET', `${IC()}/${it.id}`, T.tom)).status, 404);
  assert.equal((await call('PUT', `${IC()}/${it.id}/page`, T.tom, { pageId: P.md })).status, 404);
  assert.equal((await call('PATCH', `${INV()}/${it.id}`, T.tom, { pageId: P.md })).status, 403);
  assert.equal((await ok('GET', `${INV()}?owner=me`, T.jess)).items.find((i: any) => i.id === it.id).pageId, null);
  // The owner may, via the card endpoint or the item edit endpoint.
  await ok('PUT', `${IC()}/${it.id}/page`, T.jess, { pageId: P.md });
  assert.equal((await ok('GET', `${IC()}/${it.id}`, T.jess)).page.title, 'Moonblade');
  await ok('PATCH', `${INV()}/${it.id}`, T.jess, { pageId: P.lk });
  assert.equal((await ok('GET', `${IC()}/${it.id}`, T.jess)).page.title, 'Ring of Warding');
  // The DM may too, and can unlink.
  await ok('PUT', `${IC()}/${it.id}/page`, T.dm, { pageId: null });
  assert.equal((await ok('GET', `${IC()}/${it.id}`, T.jess)).page, null);
  assert.equal((await call('PUT', `${IC()}/${it.id}/page`, T.dm, {})).status, 400);
  assert.equal((await call('PUT', `${IC()}/${it.id}/page`, T.dm, { pageId: 'pg_nope' })).status, 400);
});

test('TestItemCards_PlayerCannotLinkADMOnlyPage', async () => {
  const it = await add(T.dm, { owner: ID.jess, name: 'Candle', reason: 'gift' });
  assert.equal((await call('PUT', `${IC()}/${it.id}/page`, T.jess, { pageId: P.dmOnly })).status, 400);
  assert.equal((await call('PATCH', `${INV()}/${it.id}`, T.jess, { pageId: P.dmOnly })).status, 400);
  // Adding an item through the player flow with a DM-only page is refused too.
  assert.equal((await call('POST', INV(), T.jess, { owner: 'me', name: 'Trick', pageId: P.dmOnly })).status, 400);
  // A player's own proposed item can carry a shared page.
  const mine = await call('POST', INV(), T.jess, { owner: 'me', name: 'Brooch', pageId: P.lk });
  assert.ok(mine.status < 300, JSON.stringify(mine.body));
  assert.equal(mine.body.pageId, P.lk);
});

test('TestItemCards_PlayerPageSearchNeverListsDMOnlyPages', async () => {
  const dm = await ok('GET', `${IC()}/pages?q=ashgrove`, T.dm);
  assert.ok(dm.some((p: any) => p.id === P.dmOnly));
  const dmAll = await ok('GET', `${IC()}/pages`, T.dm);
  assert.ok(dmAll.length >= 3);
  const pl = await ok('GET', `${IC()}/pages?q=ashgrove`, T.jess);
  assert.deepEqual(pl, []);
  const plAll = await ok('GET', `${IC()}/pages`, T.jess);
  assert.ok(plAll.length >= 2 && plAll.every((p: any) => p.id !== P.dmOnly && p.visibility === undefined));
  assert.ok(!JSON.stringify(plAll).includes('Ashgrove'));
  const m = await ok('GET', `${IC()}/pages?q=moon`, T.jess);
  assert.deepEqual(m.map((p: any) => p.title), ['Moonblade']);
});

test('TestItemCards_CardReflectsPageEdits', async () => {
  const it = await add(T.dm, { owner: ID.tom, name: 'Banner', pageId: P.md, reason: 'gift' });
  const before = await ok('GET', `${IC()}/${it.id}`, T.tom);
  assert.ok(JSON.stringify(before.page.excerpt).includes('silver sword'));
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'items/Moonblade', visibility: 'party', markdown: '# Moonblade\nNow a golden sword.\n' });
  const after = await ok('GET', `${IC()}/${it.id}`, T.tom);
  assert.ok(JSON.stringify(after.page.excerpt).includes('golden sword'));
  assert.ok(!JSON.stringify(after).includes('silver sword'));
  // Deleting the page unlinks it (the item survives).
  await ok('DELETE', `/api/worlds/${W}/library/pages/${P.md}`, T.dm);
  const gone = await ok('GET', `${IC()}/${it.id}`, T.tom);
  assert.equal(gone.page, null);
  assert.equal(gone.item.name, 'Banner');
});

test('TestItemCards_MovedItemKeepsItsLink', async () => {
  const it = await add(T.dm, { owner: ID.jess, name: 'Rope', qty: 2, pageId: P.lk, reason: 'gift' });
  const mv = await ok('POST', `${INV()}/${it.id}/move`, T.jess, { to: 'party', qty: 1 });
  assert.equal(mv.moved.pageId, P.lk);
});

test('TestItemCards_ExcerptTakesTheLeadOrFirstSection', () => {
  const p = (t: string) => ({ kind: 'paragraph', content: [{ text: t }] }) as any;
  const h = (l: number, t: string) => ({ kind: 'heading', level: l, content: [{ text: t }] }) as any;
  const a = excerpt([p('Lead'), h(2, 'One'), p('x')]);
  assert.equal(a.blocks.length, 1);
  assert.equal(a.truncated, true);
  const b = excerpt([h(1, 'Title'), p('In title'), h(2, 'Sub'), p('deeper'), h(1, 'Next'), p('later')]);
  assert.equal(b.blocks.length, 4);
  const c = excerpt([p('a'.repeat(500)), p('b'.repeat(500))]);
  assert.equal(c.blocks.length, 1);
  assert.equal(c.truncated, true);
});

test('TestItemCards_MCPTools', async () => {
  const dmKey = await ok('POST', '/api/keys', T.dm, { scope: 'scribe', worldId: W, label: 'ai', access: 'write' });
  const plKey = await ok('POST', '/api/keys', T.jess, { scope: 'scribe', worldId: W, label: 'ai', access: 'read' });
  const mcp = async (key: string, name: string, args: Record<string, unknown> = {}) => {
    const r = await call('POST', '/mcp', key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    return JSON.stringify(r.body);
  };
  const tools = JSON.stringify((await call('POST', '/mcp', plKey.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body);
  assert.ok(tools.includes('get_item_card') && !tools.includes('link_item_page'));
  const it = await add(T.dm, { owner: ID.jess, name: 'Amulet', reason: 'gift' });
  assert.ok((await mcp(dmKey.key, 'link_item_page', { itemId: it.id, pageId: P.dmOnly })).includes(P.dmOnly));
  const asPlayer = await mcp(plKey.key, 'get_item_card', { itemId: it.id });
  assert.ok(asPlayer.includes('Amulet'));
  noSecrets('MCP card', asPlayer);
  assert.ok(!asPlayer.includes('Ashgrove'));
  assert.ok((await mcp(dmKey.key, 'get_item_card', { itemId: it.id })).includes('Ashgrove'));
});
