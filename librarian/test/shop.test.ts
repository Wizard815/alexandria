// The Shop: the item database (SRD seed, imports and dedupe), the shop generator, buying (own coin or the party
// pouch, overdraw, two buyers racing for the last one, DM approval), selling back, and what players never see.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';
import { balance, spendable } from '../src/core/coin.ts';
import { generateShop } from '../src/features/shop/gen.ts';
import { nameKey, parseCost, parseCsv } from '../src/features/shop/items.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const P = () => `/api/worlds/${W}/shop`;

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
const set = (patch: Record<string, unknown>) => ok('PATCH', `/api/worlds/${W}/settings`, T.dm, patch);
const setCoin = (owner: string, cp: number) => { run(deps.db, 'DELETE FROM ledger WHERE world_id = ? AND owner = ?', W, owner); if (cp) run(deps.db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, 'Test', ?, ?, 'approved')`, `led_t${Math.random()}`, W, owner, cp, ID.dm, new Date().toISOString()); };
const coin = (owner: string) => balance(deps.db, W, owner);
const invQty = (owner: string, name: string) => all<any>(deps.db, `SELECT qty FROM items WHERE world_id = ? AND owner = ? AND name = ? AND status = 'approved'`, W, owner, name).reduce((n, x) => n + x.qty, 0);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-shop-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Shopland', dmAccountId: ID.dm })).id;
  for (const [u, c] of [['jess', 'Jess'], ['tom', 'Tom']]) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: u, password: 'player pass 123', characterName: c });
    T[u] = j.token; ID[u] = j.account.id;
  }
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'guest' });
  T.guest = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'visitor', password: 'guest pass 1234', characterName: 'Visitor' })).token;
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('TestShop_ParseHelpers', () => {
  assert.equal(parseCost('15 gp'), 1500);
  assert.equal(parseCost('2 sp 5 cp'), 25);
  assert.equal(parseCost('1,250'), 125000);
  assert.equal(parseCost(''), null);
  assert.throws(() => parseCost('lots'), RangeError);
  assert.equal(nameKey("Thieves' Tools"), nameKey('thieves tools'));
  const rows = parseCsv('name,cost,description\r\n"Rope, hempen",1 gp,"50 feet, ""strong"""\nTorch,1 cp,\n');
  assert.deepEqual(rows.map((r) => [r.name, r.cost, r.description]), [['Rope, hempen', '1 gp', '50 feet, "strong"'], ['Torch', '1 cp', '']]);
});

test('TestShop_ItemDatabaseIsSeededFromTheSrdWithAttribution', async () => {
  const r = await ok('GET', `${P()}/items?q=longsword`, T.dm);
  assert.ok(r.all > 300, `seeded ${r.all} items`);
  const ls = r.items.find((x: any) => x.name === 'Longsword');
  assert.equal(ls.costCp, 1500);
  assert.equal(ls.type, 'weapon');
  assert.equal(ls.weight, 3);
  assert.equal(ls.sourceLabel, 'SRD 5.2');
  assert.match(ls.attribution, /System Reference Document 5\.2.*Creative Commons Attribution 4\.0/);
  const ring = (await ok('GET', `${P()}/items?q=ring%20of%20protection`, T.dm)).items[0];
  assert.equal(ring.rarity, 'rare');
  assert.equal(ring.attunement, true);
  assert.ok(ring.costCp > 0, 'a magic item gets a price from its rarity band');
  // Filters.
  const potions = await ok('GET', `${P()}/items?type=potion&rarity=common`, T.dm);
  assert.ok(potions.total > 0 && potions.items.every((x: any) => x.type === 'potion' && x.rarity === 'common'));
  // Players and guests never reach the item database.
  assert.equal((await call('GET', `${P()}/items`, T.jess)).status, 403);
  assert.equal((await call('GET', `${P()}/items/export`, T.jess)).status, 403);
  assert.equal((await call('GET', `${P()}/shops`, T.guest)).status, 403);
});

test('TestShop_ImportDedupesAndExportRoundTrips', async () => {
  const before = (await ok('GET', `${P()}/items?limit=1`, T.dm)).all;
  // The SRD 5.1 has many of the same items: those are skipped, new ones (mounts, more gear) are added.
  const pre = await ok('POST', `${P()}/items/import`, T.dm, { type: 'module', module: 'dnd-2014', preview: true });
  assert.equal((await ok('GET', `${P()}/items?limit=1`, T.dm)).all, before, 'a preview saves nothing');
  const im = await ok('POST', `${P()}/items/import`, T.dm, { type: 'module', module: 'dnd-2014' });
  assert.equal(im.added, pre.added);
  assert.ok(im.skipped > 100, `skipped ${im.skipped} duplicates`);
  assert.ok(im.added > 10);
  const longswords = (await ok('GET', `${P()}/items?q=longsword&limit=50`, T.dm)).items.filter((x: any) => x.name === 'Longsword');
  assert.equal(longswords.length, 1, 'one Longsword, not two');
  const again = await ok('POST', `${P()}/items/import`, T.dm, { type: 'module', module: 'dnd-2014' });
  assert.equal(again.added, 0);
  // JSON: duplicates inside the batch, against the database, a bad record, and the attribution kept.
  const j = await ok('POST', `${P()}/items/import`, T.dm, { type: 'json', source: 'homebrew-pack', sourceLabel: 'Homebrew pack', attribution: 'By the table, CC-BY-4.0', json: { items: [
    { name: 'Lantern of Whispers', type: 'wondrous', rarity: 'uncommon', cost: '300 gp', description: 'Speaks softly.', tags: 'light, homebrew', dm_notes: 'cursed' },
    { name: 'lantern of whispers!', cost: '1 gp' },
    { name: 'Longsword', cost: '1 gp' },
    { name: '', cost: '1 gp' },
    { name: 'Glass Rose', cost: 'pricey' },
  ] } });
  assert.equal(j.added, 1);
  assert.equal(j.skipped, 2);
  assert.equal(j.errors.length, 2);
  const lw = (await ok('GET', `${P()}/items?q=whispers`, T.dm)).items[0];
  assert.equal(lw.costCp, 30000);
  assert.equal(lw.type, 'wondrous item');
  assert.equal(lw.attribution, 'By the table, CC-BY-4.0');
  assert.deepEqual(lw.tags, ['light', 'homebrew']);
  assert.equal(lw.dmNotes, 'cursed');
  // Update mode refreshes rows from the same source only.
  const up = await ok('POST', `${P()}/items/import`, T.dm, { type: 'json', source: 'homebrew-pack', onDuplicate: 'update', json: [{ name: 'Lantern of Whispers', cost: '350 gp', rarity: 'uncommon', type: 'wondrous item' }, { name: 'Longsword', cost: '1 gp' }] });
  assert.equal(up.updated, 1);
  assert.equal(up.skipped, 1);
  assert.equal((await ok('GET', `${P()}/items?q=whispers`, T.dm)).items[0].costCp, 35000);
  assert.equal((await ok('GET', `${P()}/items?q=longsword`, T.dm)).items.find((x: any) => x.name === 'Longsword').costCp, 1500, 'an SRD row is not overwritten by another source');
  // CSV in.
  const c = await ok('POST', `${P()}/items/import`, T.dm, { type: 'csv', csv: 'name,type,rarity,cost,weight,attunement,description,tags\nSalt Knife,weapon,mundane,3 gp,1,,A knife for salting fish,"fish;kitchen"\nTorch,gear,mundane,1 cp,1,,,\n' });
  assert.equal(c.added, 1);
  assert.equal(c.skipped, 1);
  // Export JSON and CSV, and import the CSV export into the same world: nothing new.
  const ex = await ok('GET', `${P()}/items/export?format=json`, T.dm);
  assert.equal(ex.format, 'alexandria-items');
  assert.ok(ex.items.some((x: any) => x.name === 'Salt Knife' && x.costCp === 300));
  const csv = await call('GET', `${P()}/items/export?format=csv`, T.dm);
  assert.match(csv.text, /^name,type,category,rarity,cost/);
  const round = await ok('POST', `${P()}/items/import`, T.dm, { type: 'csv', csv: csv.text });
  assert.equal(round.added, 0);
  assert.equal(round.errors.length, 0, JSON.stringify(round.errors.slice(0, 3)));
});

test('TestShop_DMCreatesEditsAndDuplicatesItems', async () => {
  const it = await ok('POST', `${P()}/items`, T.dm, { name: 'Moonpetal Tea', type: 'food', cost: '5 sp', description: 'Calming.', dmNotes: 'Really a sleeping draught' });
  assert.equal(it.costCp, 50);
  assert.equal(it.source, 'custom');
  assert.equal((await call('POST', `${P()}/items`, T.dm, { name: 'moonpetal tea' })).status, 409);
  const ed = await ok('PATCH', `${P()}/items/${it.id}`, T.dm, { cost: '1 gp', rarity: 'common' });
  assert.equal(ed.costCp, 100);
  assert.equal(ed.rarity, 'common');
  assert.equal(ed.dmNotes, 'Really a sleeping draught');
  const dup = await ok('POST', `${P()}/items/${it.id}/duplicate`, T.dm, {});
  assert.equal(dup.name, 'Moonpetal Tea (copy)');
  assert.equal(dup.costCp, 100);
  await ok('DELETE', `${P()}/items/${dup.id}`, T.dm);
  assert.equal((await call('GET', `${P()}/items/${dup.id}`, T.dm)).status, 404);
  assert.equal((await call('POST', `${P()}/items`, T.jess, { name: 'Free Gold' })).status, 403);
});

test('TestShop_GeneratorIsRepeatableAndFollowsSizeAndLevel', async () => {
  const a = await generateShop(deps, W, { kind: 'magic', size: 'city', level: 7, seed: 'mage-1' });
  const b = await generateShop(deps, W, { kind: 'magic', size: 'city', level: 7, seed: 'mage-1' });
  assert.deepEqual(a.stock.map((x) => x.name), b.stock.map((x) => x.name), 'same seed, same stock');
  assert.equal(a.name, b.name);
  assert.equal(a.stock.length, 16);
  assert.equal(a.maxRarity, 'rare', 'a city lets very rare in, but a level 7 party caps it at rare');
  assert.ok(a.stock.every((x) => ['mundane', 'common', 'uncommon', 'rare'].includes(x.rarity)), JSON.stringify(a.stock.map((x) => x.rarity)));
  assert.ok(a.stock.every((x) => x.priceCp !== null && x.priceCp! >= 0));
  assert.ok(a.keeper.name && a.keeper.look && a.keeper.voice, 'a keeper from the NPC generator');
  const hamlet = await generateShop(deps, W, { kind: 'magic', size: 'hamlet', level: 20, seed: 'h' });
  assert.ok(hamlet.stock.every((x) => x.rarity === 'common' || x.rarity === 'mundane'), 'a hamlet sells nothing above common');
  const smith = await generateShop(deps, W, { kind: 'blacksmith', size: 'town', level: 3, seed: 's' });
  assert.ok(smith.stock.filter((x) => ['weapon', 'armor', 'shield', 'ammunition'].includes(x.type)).length >= smith.stock.length - 2, JSON.stringify(smith.stock.map((x) => x.type)));
  // A guide steers it offline.
  const g = await generateShop(deps, W, { kind: 'general', size: 'town', level: 5, seed: 'g' }, 'Stock 5 items, no magic, markup 20%.');
  assert.equal(g.stock.length, 5);
  assert.ok(g.stock.every((x) => x.rarity === 'mundane'));
  assert.equal(g.markupPct, 20);
  assert.equal(g.guided, true);
  await assert.rejects(() => generateShop(deps, W, { kind: 'spaceport' }), RangeError);
  // Over HTTP: a draft, then saved hidden.
  const dr = await ok('POST', `${P()}/generate`, T.dm, { kind: 'alchemist', size: 'village', level: 2, seed: 'alc' });
  assert.ok(dr.draft.stock.length > 0);
  assert.equal((await call('POST', `${P()}/generate`, T.dm, { kind: 'alchemist', size: 'nowhere' })).status, 400);
  const saved = await ok('POST', `${P()}/generate`, T.dm, { kind: 'alchemist', size: 'village', level: 2, seed: 'alc', save: true });
  assert.equal(saved.shop.status, 'hidden');
  assert.deepEqual(saved.shop.stock.map((x: any) => x.name).sort(), dr.draft.stock.map((x: any) => x.name).sort());
  assert.equal((await call('POST', `${P()}/generate`, T.jess, { kind: 'general' })).status, 403);
});

/** A shop with a few lines, open. */
async function makeShop(name: string, lines: { item: string; qty: number | null; price?: number; hidden?: boolean }[], status = 'open') {
  const items = (await ok('GET', `${P()}/items?limit=500`, T.dm)).items;
  const stock = lines.map((l) => ({ itemId: items.find((x: any) => x.name === l.item).id, qty: l.qty, priceCp: l.price, hidden: l.hidden }));
  return ok('POST', `${P()}/shops`, T.dm, { name, kind: 'general', status, stock, keeper: { name: 'Odo', look: 'Round', voice: 'Squeaky', personality: 'Kind', secret: 'SHOPSECRET_KEEPER fences for the smugglers' }, haggle: 'SHOPSECRET_HAGGLE drops 10% for dwarves', dmNotes: 'SHOPSECRET_NOTES restocked by the guild' });
}
const lineOf = (shop: any, name: string) => shop.stock.find((x: any) => x.name === name);

test('TestShop_BuyWithOwnCoinThenOverdrawIs402', async () => {
  await set({ shopApproval: false });
  const shop = await makeShop('Odo Goods', [{ item: 'Rope', qty: 5 }, { item: 'Torch', qty: null, price: 2 }]);
  setCoin(ID.jess, 300);
  const view = await ok('GET', `${P()}/shops/${shop.id}`, T.jess);
  const rope = lineOf(view, 'Rope');
  assert.ok(rope.priceCp > 0);
  const r = await ok('POST', `${P()}/shops/${shop.id}/buy`, T.jess, { stockId: rope.id, qty: 2 });
  assert.equal(r.pending, false);
  assert.equal(coin(ID.jess), 300 - rope.priceCp * 2);
  assert.equal(invQty(ID.jess, 'Rope'), 2);
  assert.equal(lineOf(await ok('GET', `${P()}/shops/${shop.id}`, T.jess), 'Rope').qty, 3);
  // Buying more stacks onto the same inventory line.
  await ok('POST', `${P()}/shops/${shop.id}/buy`, T.jess, { stockId: rope.id, qty: 1 });
  assert.equal(all<any>(deps.db, `SELECT id FROM items WHERE world_id = ? AND owner = ? AND name = 'Rope'`, W, ID.jess).length, 1);
  // Unlimited line with a price override.
  const torch = lineOf(view, 'Torch');
  assert.equal(torch.unlimited, true);
  assert.equal(torch.priceCp, 2);
  // Overdraw: 402, and nothing moved.
  const before = coin(ID.jess);
  const big = await call('POST', `${P()}/shops/${shop.id}/buy`, T.jess, { stockId: torch.id, qty: 1000 });
  assert.equal(big.status, 402);
  assert.match(big.body.error, /Not enough coin/);
  assert.equal(coin(ID.jess), before);
  assert.equal(invQty(ID.jess, 'Torch'), 0);
  // More than in stock: 409.
  assert.equal((await call('POST', `${P()}/shops/${shop.id}/buy`, T.jess, { stockId: rope.id, qty: 50 })).status, 409);
  // The log says what was bought, to the buyer.
  assert.ok(one<any>(deps.db, `SELECT 1 FROM ledger WHERE world_id = ? AND owner = ? AND note LIKE 'Shop: Rope%'`, W, ID.jess));
});

test('TestShop_PartyPouchPaysAndTheLogStaysNeutral', async () => {
  const shop = await makeShop('Pouch Shop', [{ item: 'Lantern of Whispers', qty: 2 }]);
  setCoin('party', 100_000);
  const line = lineOf(await ok('GET', `${P()}/shops/${shop.id}`, T.tom), 'Lantern of Whispers');
  await ok('POST', `${P()}/shops/${shop.id}/buy`, T.tom, { stockId: line.id, from: 'party', to: 'party' });
  assert.equal(coin('party'), 100_000 - line.priceCp);
  assert.equal(invQty('party', 'Lantern of Whispers'), 1);
  const entry = one<any>(deps.db, `SELECT note FROM ledger WHERE world_id = ? AND owner = 'party' AND amount_cp < 0 ORDER BY at DESC LIMIT 1`, W);
  assert.equal(entry.note, 'Shop purchase (paid by Tom from the party pouch)');
  // The party log a player reads never names the item.
  const log = await ok('GET', `/api/worlds/${W}/live/ledger?owner=party`, T.jess);
  assert.ok(!JSON.stringify(log).includes('Lantern'));
  // The DM's own note on the item never reaches the inventory.
  assert.equal(one<any>(deps.db, `SELECT dm_note FROM items WHERE world_id = ? AND owner = 'party' AND name = 'Lantern of Whispers'`, W).dm_note, '');
  // The pouch can be switched off for shops.
  await set({ shopPartyPay: false });
  assert.equal((await call('POST', `${P()}/shops/${shop.id}/buy`, T.tom, { stockId: line.id, from: 'party' })).status, 403);
  assert.equal((await ok('GET', `${P()}/pay-options`, T.tom)).party.allowed, false);
  await set({ shopPartyPay: true });
});

test('TestShop_TwoBuyersRaceForTheLastOne', async () => {
  const shop = await makeShop('Last One', [{ item: 'Salt Knife', qty: 1 }]);
  setCoin(ID.jess, 10_000); setCoin(ID.tom, 10_000);
  const line = lineOf(await ok('GET', `${P()}/shops/${shop.id}`, T.jess), 'Salt Knife');
  const [a, b] = await Promise.all([
    call('POST', `${P()}/shops/${shop.id}/buy`, T.jess, { stockId: line.id }),
    call('POST', `${P()}/shops/${shop.id}/buy`, T.tom, { stockId: line.id }),
  ]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [201, 409], JSON.stringify([a.body, b.body]));
  assert.equal(invQty(ID.jess, 'Salt Knife') + invQty(ID.tom, 'Salt Knife'), 1);
  assert.equal(coin(ID.jess) + coin(ID.tom), 20_000 - line.priceCp, 'only one paid');
  assert.equal(lineOf(await ok('GET', `${P()}/shops/${shop.id}`, T.jess), 'Salt Knife').qty, 0);
  assert.match((await call('POST', `${P()}/shops/${shop.id}/buy`, T.jess, { stockId: line.id })).body.error, /sold out/);
  // Two buyers racing for the same purse: the pouch never goes below zero.
  setCoin('party', 0);
  const s2 = await makeShop('Race Pouch', [{ item: 'Torch', qty: null, price: 60 }]);
  setCoin('party', 100);
  const t = lineOf(await ok('GET', `${P()}/shops/${s2.id}`, T.jess), 'Torch');
  const both = await Promise.all([T.jess, T.tom].map((tk) => call('POST', `${P()}/shops/${s2.id}/buy`, tk, { stockId: t.id, from: 'party' })));
  assert.deepEqual(both.map((x) => x.status).sort(), [201, 402]);
  assert.equal(coin('party'), 40);
});

test('TestShop_DMApprovesPurchasesWhenTheSettingIsOn', async () => {
  await set({ shopApproval: true });
  const shop = await makeShop('Careful Shop', [{ item: 'Torch', qty: 3, price: 100 }]);
  setCoin(ID.jess, 150);
  const had = invQty(ID.jess, 'Torch');
  const line = lineOf(await ok('GET', `${P()}/shops/${shop.id}`, T.jess), 'Torch');
  const r = await call('POST', `${P()}/shops/${shop.id}/buy`, T.jess, { stockId: line.id });
  assert.equal(r.status, 202);
  assert.equal(r.body.pending, true);
  assert.equal(invQty(ID.jess, 'Torch'), had, 'nothing delivered yet');
  assert.equal(coin(ID.jess), 150, 'the balance is unchanged...');
  assert.equal(spendable(deps.db, W, ID.jess), 50, '...but the coin is held');
  assert.equal(lineOf(await ok('GET', `${P()}/shops/${shop.id}`, T.jess), 'Torch').qty, 2, 'and the stock reserved');
  // Held coin cannot be spent twice.
  assert.equal((await call('POST', `${P()}/shops/${shop.id}/buy`, T.jess, { stockId: line.id })).status, 402);
  // It is decided on the Shops page, not as a bare coin request.
  const ap = await ok('GET', `/api/worlds/${W}/approvals`, T.dm);
  assert.ok(!ap.coin.some((c: any) => c.id === r.body.order.id || /Shop/.test(c.note)), 'not in the coin approvals');
  const led = one<any>(deps.db, 'SELECT ledger_id FROM shop_orders WHERE id = ?', r.body.order.id).ledger_id;
  assert.equal((await call('POST', `/api/worlds/${W}/approvals/${led}`, T.dm, { action: 'approve' })).status, 409);
  assert.equal((await call('POST', `${P()}/orders/${r.body.order.id}`, T.jess, { action: 'approve' })).status, 403);
  const mine = await ok('GET', `${P()}/orders`, T.jess);
  assert.equal(mine.orders[0].status, 'pending');
  await ok('POST', `${P()}/orders/${r.body.order.id}`, T.dm, { action: 'approve' });
  assert.equal(invQty(ID.jess, 'Torch'), had + 1);
  assert.equal(coin(ID.jess), 50);
  // A rejected one gives the coin and the stock back.
  setCoin(ID.jess, 500);
  const r2 = await ok('POST', `${P()}/shops/${shop.id}/buy`, T.jess, { stockId: line.id });
  await ok('POST', `${P()}/orders/${r2.order.id}`, T.dm, { action: 'reject' });
  assert.equal(spendable(deps.db, W, ID.jess), 500);
  assert.equal(lineOf(await ok('GET', `${P()}/shops/${shop.id}`, T.jess), 'Torch').qty, 2);
  // And a player can take back their own.
  const r3 = await ok('POST', `${P()}/shops/${shop.id}/buy`, T.jess, { stockId: line.id });
  assert.equal((await call('POST', `${P()}/orders/${r3.order.id}/cancel`, T.tom)).status, 404);
  await ok('POST', `${P()}/orders/${r3.order.id}/cancel`, T.jess);
  assert.equal(spendable(deps.db, W, ID.jess), 500);
  await set({ shopApproval: false });
});

test('TestShop_SellBackWaitsForTheDM', async () => {
  const shop = await makeShop('Buyback', [{ item: 'Rope', qty: 1 }]);
  const rope = one<any>(deps.db, `SELECT id, qty FROM items WHERE world_id = ? AND owner = ? AND name = 'Rope'`, W, ID.jess);
  assert.equal((await call('POST', `${P()}/shops/${shop.id}/sell`, T.jess, { itemId: rope.id })).status, 403, 'off by default');
  await set({ shopSellBack: true, shopSellBackPct: 50 });
  assert.equal((await ok('GET', `${P()}/shops/${shop.id}`, T.jess)).sellPct, 50);
  // Not someone else's things.
  assert.equal((await call('POST', `${P()}/shops/${shop.id}/sell`, T.tom, { itemId: rope.id })).status, 404);
  const cost = (await ok('GET', `${P()}/items?q=rope`, T.dm)).items.find((x: any) => x.name === 'Rope').costCp;
  setCoin(ID.jess, 0);
  const r = await call('POST', `${P()}/shops/${shop.id}/sell`, T.jess, { itemId: rope.id, qty: 1 });
  assert.equal(r.status, 202);
  assert.equal(r.body.order.totalCp, Math.floor(cost / 2));
  assert.equal((await call('POST', `${P()}/shops/${shop.id}/sell`, T.jess, { itemId: rope.id, qty: 1 })).status, 409, 'offered once');
  await ok('POST', `${P()}/orders/${r.body.order.id}`, T.dm, { action: 'approve' });
  assert.equal(coin(ID.jess), Math.floor(cost / 2));
  assert.equal(invQty(ID.jess, 'Rope'), rope.qty - 1);
  await set({ shopSellBack: false });
});

test('TestShop_PlayersNeverSeeHiddenShopsLinesOrDMNotes', async () => {
  const open = await makeShop('Open Shop', [{ item: 'Torch', qty: 4 }, { item: 'Moonpetal Tea', qty: 1, hidden: true }]);
  await ok('PATCH', `${P()}/shops/${open.id}/stock/${lineOf(open, 'Torch').id}`, T.dm, { dmNote: 'SHOPSECRET_LINE stolen from the temple' });
  const hidden = await makeShop('SHOPSECRET_HIDDENSHOP Den', [{ item: 'Torch', qty: 1 }], 'hidden');
  const closed = await makeShop('Closed Shop', [{ item: 'Torch', qty: 1 }], 'closed');
  for (const who of ['jess', 'tom']) {
    const list = await call('GET', `${P()}/shops`, T[who]);
    const one1 = await call('GET', `${P()}/shops/${open.id}`, T[who]);
    const hay = list.text + one1.text;
    for (const secret of ['SHOPSECRET', 'Moonpetal', 'sleeping draught', 'cursed']) assert.ok(!hay.includes(secret), `${who} sees ${secret}`);
    assert.ok(list.body.shops.some((s: any) => s.id === open.id));
    assert.ok(!list.body.shops.some((s: any) => s.id === hidden.id));
    assert.equal((await call('GET', `${P()}/shops/${hidden.id}`, T[who])).status, 404);
    assert.equal((await call('POST', `${P()}/shops/${hidden.id}/buy`, T[who], { stockId: hidden.stock[0].id })).status, 404);
    // A closed shop shows, with no stock, and sells nothing.
    const c = await ok('GET', `${P()}/shops/${closed.id}`, T[who]);
    assert.equal(c.status, 'closed');
    assert.deepEqual(c.stock, []);
    assert.equal((await call('POST', `${P()}/shops/${closed.id}/buy`, T[who], { stockId: closed.stock[0].id })).status, 409);
    // A hidden line cannot be bought by id.
    assert.equal((await call('POST', `${P()}/shops/${open.id}/buy`, T[who], { stockId: lineOf(open, 'Moonpetal Tea').id })).status, 404);
    // No DM write for players.
    assert.equal((await call('POST', `${P()}/shops/${open.id}/status`, T[who], { status: 'hidden' })).status, 403);
  }
  // The DM sees it all.
  const dm = await ok('GET', `${P()}/shops/${open.id}`, T.dm);
  assert.equal(dm.keeper.secret, 'SHOPSECRET_KEEPER fences for the smugglers');
  assert.ok(lineOf(dm, 'Moonpetal Tea').hidden);
  // Hiding a shop takes it away from players at once; opening it brings it back.
  await ok('POST', `${P()}/shops/${open.id}/status`, T.dm, { status: 'hidden' });
  assert.equal((await call('GET', `${P()}/shops/${open.id}`, T.jess)).status, 404);
  await ok('POST', `${P()}/shops/${open.id}/status`, T.dm, { status: 'open' });
  assert.equal((await call('GET', `${P()}/shops/${open.id}`, T.jess)).status, 200);
});

test('TestShop_RestockOnTheWorldClockAndByHand', async () => {
  const shop = await makeShop('Restocker', [{ item: 'Torch', qty: 2, price: 1 }]);
  setCoin(ID.tom, 100);
  const line = lineOf(shop, 'Torch');
  await ok('POST', `${P()}/shops/${shop.id}/buy`, T.tom, { stockId: line.id, qty: 2 });
  assert.equal(lineOf(await ok('GET', `${P()}/shops/${shop.id}`, T.dm), 'Torch').qty, 0);
  await ok('POST', `${P()}/shops/${shop.id}/restock`, T.dm);
  assert.equal(lineOf(await ok('GET', `${P()}/shops/${shop.id}`, T.dm), 'Torch').qty, 2);
  await ok('PATCH', `${P()}/shops/${shop.id}`, T.dm, { restock: { rule: 'days', days: 1 } });
  await ok('GET', `${P()}/shops/${shop.id}`, T.dm);
  await ok('POST', `${P()}/shops/${shop.id}/buy`, T.tom, { stockId: line.id, qty: 2 });
  await ok('POST', `/api/worlds/${W}/clock/advance`, T.dm, { minutes: 1500 });
  assert.equal(lineOf(await ok('GET', `${P()}/shops/${shop.id}`, T.jess), 'Torch').qty, 2, 'restocked after a game day');
});

test('TestShop_StageCardHasNoDMText', async () => {
  const shop = await makeShop('Stage Shop', [{ item: 'Torch', qty: 3 }, { item: 'Moonpetal Tea', qty: 1, hidden: true }]);
  const r = await ok('POST', `${P()}/shops/${shop.id}/stage`, T.dm, { show: false });
  const card = one<any>(deps.db, 'SELECT * FROM stage_cards WHERE id = ?', r.cardId);
  const text = JSON.stringify(card);
  assert.ok(text.includes('Torch'));
  assert.ok(!text.includes('Moonpetal') && !text.includes('SHOPSECRET'), text);
});
