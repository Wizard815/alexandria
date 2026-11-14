// Quick generators: names, items and coin amounts. Seeds repeat, filters
// hold, prices stay in their bands, coins follow the world's coin setting,
// players are shut out unless the DM allows names, and "give to" works.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { genCoins, genItems, genNames, isOffensive, PRICE_BANDS, RACES } from '../src/features/quickgen/api.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const QG = () => `/api/worlds/${W}/quickgen`;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
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

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-quickgen-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Quickland', dmAccountId: ID.dm })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' });
  T.jess = j.token;
  ID.jess = j.account.id;
});
after(async () => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('QuickGen_names: a seed repeats, another differs, and there are no duplicates', () => {
  const a = genNames({ race: 'any', count: 50, seed: 'abc' });
  const b = genNames({ race: 'any', count: 50, seed: 'abc' });
  const c = genNames({ race: 'any', count: 50, seed: 'abd' });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.names, c.names);
  assert.equal(a.names.length, 50);
  assert.equal(new Set(a.names.map((n) => n.name.toLowerCase())).size, 50);
});

test('QuickGen_names: race and gender filters hold, and any mixes', () => {
  for (const race of RACES) {
    for (const gender of ['male', 'female']) {
      const r = genNames({ race, gender, count: 20, seed: race + gender });
      assert.ok(r.names.length >= 15, `${race} ${gender} gave ${r.names.length}`);
      assert.ok(r.names.every((n) => n.race === race && n.gender === gender && n.name.startsWith(n.given)), race);
    }
  }
  const mixed = genNames({ race: 'any', gender: 'any', count: 100, seed: 'mix' });
  assert.ok(new Set(mixed.names.map((n) => n.race)).size > 6);
  assert.deepEqual([...new Set(mixed.names.map((n) => n.gender))].sort(), ['female', 'male']);
  const virtues = genNames({ race: 'tiefling', style: 'virtue', count: 10, seed: 1 });
  assert.ok(virtues.names.every((n) => n.family === '' && /^[A-Z][a-z]+$/.test(n.name)));
  assert.throws(() => genNames({ race: 'beholder' }), RangeError);
  assert.throws(() => genNames({ gender: 'robot' }), RangeError);
});

test('QuickGen_names: nothing offensive gets through the filter', () => {
  assert.ok(isOffensive('Bigfuckton') && isOffensive("Ni'gger") && !isOffensive('Elowen Thornweave'));
  const big = genNames({ race: 'any', count: 2000, seed: 'filter' });
  assert.ok(big.names.every((n) => !isOffensive(n.name)));
});

test('QuickGen_names: 1000 names are fast', () => {
  genNames({ count: 50, seed: 'warm' });
  const t = performance.now();
  const r = genNames({ race: 'any', count: 1000, seed: 'speed' });
  const ms = performance.now() - t;
  assert.equal(r.names.length, 1000);
  assert.ok(ms < 200, `1000 names took ${ms.toFixed(1)} ms`);
});

test('QuickGen_items: rarity and type filters, seeds, and prices inside the bands', () => {
  const db = deps.db;
  const a = genItems(db, W, { rarity: 'rare', type: 'weapon', count: 8, seed: 's1' });
  assert.deepEqual(a, genItems(db, W, { rarity: 'rare', type: 'weapon', count: 8, seed: 's1' }));
  assert.ok(a.items.length > 0);
  for (const it of a.items) {
    assert.equal(it.rarity, 'rare');
    assert.equal(it.type, 'weapon');
    const [lo, hi] = PRICE_BANDS.rare;
    assert.ok(it.priceGp! >= lo && it.priceGp! <= hi, `${it.name} ${it.priceGp}`);
    assert.match(it.termId ?? '', /^dnd-2024:item-/);
  }
  for (const rarity of ['common', 'uncommon', 'rare', 'very rare', 'legendary']) {
    const r = genItems(db, W, { rarity, count: 30, seed: rarity });
    assert.ok(r.items.length > 0, rarity);
    for (const it of r.items) {
      assert.equal(it.rarity, rarity);
      assert.ok(it.priceGp! >= PRICE_BANDS[rarity][0] && it.priceGp! <= PRICE_BANDS[rarity][1], `${rarity} ${it.name} ${it.priceGp}`);
    }
  }
  for (const type of ['armor', 'potion', 'ring', 'staff', 'wand', 'wondrous item', 'ammunition']) {
    const r = genItems(db, W, { rarity: 'any', type, count: 10, seed: type });
    assert.ok(r.items.length > 0, type);
    assert.ok(r.items.every((it) => it.type === type && it.rarity !== 'mundane'), type);
  }
  const art = genItems(db, W, { rarity: 'artifact', count: 3, seed: 1 });
  assert.ok(art.items.every((it) => it.rarity === 'artifact' && it.priceGp === null));
  const names = genItems(db, W, { rarity: 'any', count: 40, seed: 'u' }).items.map((i) => i.name);
  assert.equal(new Set(names).size, names.length);
  assert.throws(() => genItems(db, W, { rarity: 'shiny' }), RangeError);
});

test('QuickGen_items: mundane gear uses its listed cost', () => {
  const r = genItems(deps.db, W, { type: 'gear', count: 40, seed: 'g' });
  assert.ok(r.items.length > 10);
  for (const it of r.items) {
    assert.equal(it.rarity, 'mundane');
    assert.equal(it.type, 'gear');
    assert.ok(typeof it.priceGp === 'number' && it.priceGp >= 0, it.name);
  }
  const club = genItems(deps.db, W, { rarity: 'mundane', type: 'weapon', count: 200, seed: 'w' }).items.find((i) => i.name === 'Club');
  assert.equal(club?.priceGp, 0.1);
});

test('QuickGen_items: pages tagged item join the pool', async () => {
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'items/Moonlit Lantern', visibility: 'dm', markdown: `---\ntags: [item]\nrarity: rare\ntype: wondrous item\nprice: 1200 gp\n---\n# Moonlit Lantern\nA pale lantern that never gutters.\n` });
  const r = genItems(deps.db, W, { rarity: 'rare', type: 'wondrous item', count: 200, seed: 'lib' });
  const mine = r.items.find((i) => i.name === 'Moonlit Lantern');
  assert.ok(mine, 'library item present');
  assert.equal(mine.source, 'library');
  assert.equal(mine.priceGp, 1200);
  assert.ok(mine.pageId);
  assert.equal(genItems(deps.db, W, { rarity: 'rare', type: 'wondrous item', count: 200, seed: 'lib', library: false }).items.some((i) => i.name === 'Moonlit Lantern'), false);
});

test('QuickGen_coins: scales with level, repeats with a seed, total adds up', () => {
  const a = genCoins({ mode: 'hoard', level: 5, seed: 'c' });
  assert.deepEqual(a, genCoins({ mode: 'hoard', level: 5, seed: 'c' }));
  for (const mode of ['individual', 'hoard']) {
    for (const coins of ['gsc', 'all', 'gold']) {
      for (let level = 1; level <= 20; level++) {
        const c = genCoins({ mode, level, seed: `${mode}${level}`, coins });
        assert.equal(c.totalCp, c.pp * 1000 + c.gp * 100 + c.ep * 50 + c.sp * 10 + c.cp);
        assert.ok(c.totalCp > 0);
        if (coins === 'gold') assert.deepEqual([c.pp, c.ep, c.sp, c.cp], [0, 0, 0, 0]);
        if (coins === 'gsc') assert.deepEqual([c.pp, c.ep], [0, 0]);
      }
    }
  }
  const avg = (level: number) => { let t = 0; for (let i = 0; i < 40; i++) t += genCoins({ mode: 'hoard', level, seed: `avg${i}` }).totalCp; return t / 40; };
  assert.ok(avg(1) < avg(8) && avg(8) < avg(13) && avg(13) < avg(19));
  assert.equal(genCoins({ mode: 'individual', cr: '1/2', seed: 1 }).level, 1);
  assert.equal(genCoins({ mode: 'individual', cr: 7.2, seed: 1 }).level, 8);
  assert.ok(genCoins({ mode: 'hoard', level: 20, seed: 'big', coins: 'all' }).pp > 0);
  assert.throws(() => genCoins({ level: 0 }), RangeError);
  assert.throws(() => genCoins({ mode: 'pile', level: 3 }), RangeError);
});

test('QuickGen_routes: options, names, items, coins as the DM; coins follow the world setting', async () => {
  const o = await ok('GET', `${QG()}/options`, T.dm);
  assert.ok(o.races.includes('dragonborn') && o.rarities.includes('very rare') && o.types.includes('wondrous item') && o.genders.length === 3);
  const n = await ok('GET', `${QG()}/names?race=dwarf&gender=female&count=5&seed=z`, T.dm);
  assert.equal(n.names.length, 5);
  assert.deepEqual(n, await ok('GET', `${QG()}/names?race=dwarf&gender=female&count=5&seed=z`, T.dm));
  const it = await ok('GET', `${QG()}/items?rarity=uncommon&type=ring&count=3&seed=z`, T.dm);
  assert.ok(it.items.length > 0 && it.items.every((x: any) => x.rarity === 'uncommon' && x.type === 'ring'));
  assert.equal((await call('GET', `${QG()}/items?rarity=nope`, T.dm)).status, 400);
  const c1 = await ok('GET', `${QG()}/coins?mode=hoard&level=15&seed=z`, T.dm);
  assert.equal(c1.coinSetting, 'gsc');
  assert.equal(c1.pp + c1.ep, 0);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { coins: 'all' });
  const c2 = await ok('GET', `${QG()}/coins?mode=hoard&level=18&seed=z`, T.dm);
  assert.equal(c2.coinSetting, 'all');
  assert.ok(c2.pp > 0);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { coins: 'gold' });
  const c3 = await ok('GET', `${QG()}/coins?mode=individual&cr=3&seed=z`, T.dm);
  assert.deepEqual([c3.pp, c3.ep, c3.sp, c3.cp], [0, 0, 0, 0]);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { coins: 'gsc' });
  assert.equal((await call('GET', `${QG()}/coins?mode=hoard&level=40`, T.dm)).status, 400);
});

test('QuickGen_players: 403 unless quickgenPlayers is on, and then names only', async () => {
  for (const p of ['names', 'items?rarity=rare', 'coins?level=3', 'options']) assert.equal((await call('GET', `${QG()}/${p}`, T.jess)).status, 403, p);
  assert.equal((await call('GET', `${QG()}/names`)).status, 401);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { quickgenPlayers: true });
  const n = await ok('GET', `${QG()}/names?count=4&seed=p`, T.jess);
  assert.equal(n.names.length, 4);
  const o = await ok('GET', `${QG()}/options`, T.jess);
  assert.deepEqual([o.rarities, o.types, o.dm], [[], [], false]);
  assert.equal((await call('GET', `${QG()}/items?rarity=rare`, T.jess)).status, 403);
  assert.equal((await call('GET', `${QG()}/coins?level=3`, T.jess)).status, 403);
  assert.equal((await call('POST', `${QG()}/flavour`, T.jess, { text: 'x' })).status, 403);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { quickgenPlayers: false });
  assert.equal((await call('GET', `${QG()}/names`, T.jess)).status, 403);
  assert.equal((await call('PATCH', `/api/worlds/${W}/settings`, T.dm, { quickgenPlayers: 'yes' })).status, 400);
});

test('QuickGen_give: a rolled item and coin land in the inventory and the purse', async () => {
  const it = (await ok('GET', `${QG()}/items?rarity=common&type=potion&count=1&seed=give`, T.dm)).items[0];
  await ok('POST', `/api/worlds/${W}/inventory`, T.dm, { owner: ID.jess, name: it.name, qty: 1, note: `${it.rarity} ${it.type}`, reason: 'Quick gen' });
  const inv = await ok('GET', `/api/worlds/${W}/inventory?owner=${ID.jess}`, T.dm);
  assert.ok(inv.items.some((x: any) => x.name === it.name));
  await ok('POST', `/api/worlds/${W}/inventory`, T.dm, { owner: 'party', name: it.name, qty: 1, reason: 'Quick gen' });
  assert.ok((await ok('GET', `/api/worlds/${W}/inventory?owner=party`, T.dm)).items.some((x: any) => x.name === it.name));
  const c = await ok('GET', `${QG()}/coins?mode=hoard&level=6&seed=give`, T.dm);
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: 'party', amountCp: c.totalCp, note: 'Quick gen hoard' });
  assert.equal((await ok('GET', `/api/worlds/${W}/live/ledger?owner=party`, T.dm)).cp, c.totalCp);
});

test('QuickGen_flavour: falls back to null with no model', async () => {
  const f = await ok('POST', `${QG()}/flavour`, T.dm, { kind: 'item', text: 'Ring of Protection' });
  assert.equal(f.flavour, null);
  assert.equal((await call('POST', `${QG()}/flavour`, T.dm, {})).status, 400);
});

test('QuickGen_mcp: read tools are listed, work for the DM and refuse a player key', async () => {
  const rpc = async (key: string, method: string, params: any = {}) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await r.json()) as any;
  };
  const dk = (await ok('POST', '/api/keys', T.dm, { scope: 'scribe', label: 'qg', worldId: W })).key;
  const tools = (await rpc(dk, 'tools/list')).result.tools.map((t: any) => t.name);
  for (const t of ['generate_names', 'generate_items', 'generate_coins']) assert.ok(tools.includes(t), t);
  const n = await rpc(dk, 'tools/call', { name: 'generate_names', arguments: { race: 'elf', count: 3, seed: 'm' } });
  assert.equal(JSON.parse(n.result.content[0].text).names.length, 3);
  const c = await rpc(dk, 'tools/call', { name: 'generate_coins', arguments: { mode: 'hoard', level: 4, seed: 'm' } });
  assert.ok(JSON.parse(c.result.content[0].text).totalCp > 0);
  const pk = (await ok('POST', '/api/keys', T.jess, { scope: 'scribe', label: 'qg', worldId: W })).key;
  const denied = await rpc(pk, 'tools/call', { name: 'generate_items', arguments: { rarity: 'rare' } });
  assert.ok(denied.error || denied.result?.isError, 'a player key gets no items');
});
