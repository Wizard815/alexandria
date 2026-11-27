// The market around the shops: towns with a price level, the keeper's purse,
// what each keeper remembers about each player (reputation, what they spent
// and sold, haggles won and lost), deals (a percentage off, from a haggle or
// given by the GM) and sending a shop to a player's screen (an NPC walks up
// and says "come and see my wares"). See docs/SHOPS.md.
//
// Prices, in order: the item's cost, the town's price level, the shop's
// markup (a line's own price replaces those three), then for one player their
// reputation with the keeper and their best deal on that line.
import type { Deps } from '../../app.ts';
import { type DB, all, one, run } from '../../core/db.ts';
import { HttpError, id as newId, now } from '../../core/util.ts';
import { getClock } from '../clock/api.ts';
import { keeperOf, listPrice, playerVisible, priceWord, type ShopRow } from './shops.ts';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS shop_towns (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  size TEXT NOT NULL DEFAULT 'town',
  price_pct INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  dm_notes TEXT NOT NULL DEFAULT '',
  location_page_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shop_towns_world ON shop_towns (world_id);
CREATE TABLE IF NOT EXISTS shop_rep (
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  world_id TEXT NOT NULL,
  rep INTEGER NOT NULL DEFAULT 0,
  spent_cp INTEGER NOT NULL DEFAULT 0,
  sold_cp INTEGER NOT NULL DEFAULT 0,
  purchases INTEGER NOT NULL DEFAULT 0,
  haggles_won INTEGER NOT NULL DEFAULT 0,
  haggles_lost INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  last_at TEXT,
  PRIMARY KEY (shop_id, account_id)
);
CREATE TABLE IF NOT EXISTS shop_deals (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  world_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  stock_id TEXT,
  pct INTEGER NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  asked_pct INTEGER,
  created_min INTEGER NOT NULL,
  expires_min INTEGER,
  order_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shop_deals_who ON shop_deals (shop_id, account_id, status);
`;

const cols = (db: DB, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
/** Columns added to the first shop tables. Safe to run again. */
export function migrate(db: DB) {
  const sc = cols(db, 'shops');
  if (!sc.includes('town_id')) db.exec('ALTER TABLE shops ADD COLUMN town_id TEXT');
  if (!sc.includes('gold_cp')) db.exec('ALTER TABLE shops ADD COLUMN gold_cp INTEGER');
  if (!sc.includes('barter_pct')) db.exec('ALTER TABLE shops ADD COLUMN barter_pct INTEGER NOT NULL DEFAULT 10');
  const oc = cols(db, 'shop_orders');
  if (!oc.includes('deal_id')) db.exec('ALTER TABLE shop_orders ADD COLUMN deal_id TEXT');
  if (!oc.includes('list_cp')) db.exec('ALTER TABLE shop_orders ADD COLUMN list_cp INTEGER');
}

export interface TownRow { id: string; world_id: string; name: string; size: string; price_pct: number; description: string; dm_notes: string; location_page_id: string | null; created_at: string; updated_at: string }
export interface RepRow { shop_id: string; account_id: string; world_id: string; rep: number; spent_cp: number; sold_cp: number; purchases: number; haggles_won: number; haggles_lost: number; note: string; last_at: string | null }
export interface DealRow { id: string; shop_id: string; world_id: string; account_id: string; stock_id: string | null; pct: number; status: string; source: string; note: string; asked_pct: number | null; created_min: number; expires_min: number | null; order_id: string | null; created_at: string }

/** How many game minutes a haggled deal lasts, and how long a keeper remembers a refused haggle. */
export const DEAL_MINUTES = 1440;
export const REP_MIN = -100;
export const REP_MAX = 100;
const clampRep = (n: number) => Math.max(REP_MIN, Math.min(REP_MAX, Math.round(n)));

// ---------------- prices ----------------

export { listPrice, priceWord };

/** Reputation as a price change in percent off: +100 rep with effect 10 is 10% off, -100 is 10% more. */
export const repDiscount = (rep: number, effect: number) => Math.trunc((clampRep(rep) * Math.max(0, effect)) / 100);

/** What one player pays: the list price less their reputation discount and their deal. Never below 10% of list. */
export function personalPrice(list: number, repPct: number, dealPct: number): number {
  const off = Math.max(-50, Math.min(90, repPct + dealPct));
  return Math.max(0, Math.round((list * (100 - off)) / 100));
}

/** A standing a player can read: what the keeper thinks of them. */
export const standing = (rep: number) => (rep <= -60 ? 'Unwelcome' : rep <= -20 ? 'Distrusted' : rep < 10 ? 'Stranger' : rep < 30 ? 'Customer' : rep < 60 ? 'Regular' : rep < 90 ? 'Friend' : 'Trusted friend');

// ---------------- haggling ----------------

export interface HaggleIn { askPct: number; barterPct: number; rep: number; roll: number }
export interface HaggleOut { accepted: boolean; pct: number; counterPct: number; chance: number; limit: number; repDelta: number; mood: 'agreed' | 'grudging' | 'refused' | 'insulted' | 'never' }

/**
 * A haggle, decided by the keeper's barter percent, the player's reputation and a roll in [0, 1).
 * The keeper will go as far as `limit` = barter % + rep/10. Up to half of it they always agree; up to all of it the
 * chance falls from 100% to 30%; past it they refuse and offer half the limit; past twice the limit they are insulted.
 */
export function haggleOutcome({ askPct, barterPct, rep, roll }: HaggleIn): HaggleOut {
  const limit = Math.max(0, Math.min(90, barterPct + Math.round(clampRep(rep) / 10)));
  const half = Math.floor(limit / 2);
  if (barterPct <= 0 || limit <= 0) return { accepted: false, pct: 0, counterPct: 0, chance: 0, limit, repDelta: 0, mood: 'never' };
  if (askPct <= limit / 2) return { accepted: true, pct: askPct, counterPct: 0, chance: 1, limit, repDelta: 0, mood: 'agreed' };
  if (askPct <= limit) {
    const chance = 1 - (0.7 * (askPct - limit / 2)) / (limit / 2);
    if (roll < chance) return { accepted: true, pct: askPct, counterPct: 0, chance, limit, repDelta: 0, mood: 'grudging' };
    return { accepted: false, pct: 0, counterPct: half, chance, limit, repDelta: -1, mood: 'refused' };
  }
  if (askPct <= limit * 2) return { accepted: false, pct: 0, counterPct: half, chance: 0, limit, repDelta: -2, mood: 'refused' };
  return { accepted: false, pct: 0, counterPct: 0, chance: 0, limit, repDelta: -5, mood: 'insulted' };
}

// ---------------- memory ----------------

export const townOf = (db: DB, s: Pick<ShopRow, 'world_id'> & { town_id?: string | null }): TownRow | null =>
  s.town_id ? one<TownRow>(db, 'SELECT * FROM shop_towns WHERE id = ? AND world_id = ?', s.town_id, s.world_id) ?? null : null;

export const repOf = (db: DB, shopId: string, accountId: string): RepRow | null =>
  one<RepRow>(db, 'SELECT * FROM shop_rep WHERE shop_id = ? AND account_id = ?', shopId, accountId) ?? null;

/** Change what a keeper remembers about a player (creates the row). Reputation is kept in -100..100. */
export function remember(db: DB, s: Pick<ShopRow, 'id' | 'world_id'>, accountId: string, ch: { rep?: number; setRep?: number; spent?: number; sold?: number; purchase?: boolean; won?: boolean; lost?: boolean; note?: string }) {
  if (!accountId || accountId === 'party') return;
  run(db, 'INSERT INTO shop_rep (shop_id, account_id, world_id) VALUES (?, ?, ?) ON CONFLICT (shop_id, account_id) DO NOTHING', s.id, accountId, s.world_id);
  const cur = repOf(db, s.id, accountId)!;
  const rep = clampRep(ch.setRep ?? cur.rep + (ch.rep ?? 0));
  run(db, 'UPDATE shop_rep SET rep = ?, spent_cp = spent_cp + ?, sold_cp = sold_cp + ?, purchases = purchases + ?, haggles_won = haggles_won + ?, haggles_lost = haggles_lost + ?, note = ?, last_at = ? WHERE shop_id = ? AND account_id = ?',
    rep, ch.spent ?? 0, ch.sold ?? 0, ch.purchase ? 1 : 0, ch.won ? 1 : 0, ch.lost ? 1 : 0, ch.note ?? cur.note, now(), s.id, accountId);
}

/** Reputation for a purchase: +1, and +1 more for every 50 gp in it (at most +5). */
export const purchaseRep = (totalCp: number) => 1 + Math.min(4, Math.floor(totalCp / 5000));

/** Expire deals whose game time has run out. */
export function settleDeals(db: DB, worldId: string, nowMin = getClock(db, worldId).minutes) {
  run(db, `UPDATE shop_deals SET status = 'expired' WHERE world_id = ? AND status = 'active' AND expires_min IS NOT NULL AND expires_min <= ?`, worldId, nowMin);
}

/** A player's active deals at a shop. */
export const activeDeals = (db: DB, shopId: string, accountId: string) =>
  all<DealRow>(db, `SELECT * FROM shop_deals WHERE shop_id = ? AND account_id = ? AND status = 'active' ORDER BY pct DESC, created_at`, shopId, accountId);

/** The best active deal a player has on a line (a deal on the line, or on the whole shop). */
export const bestDeal = (db: DB, shopId: string, accountId: string, stockId: string): DealRow | null =>
  one<DealRow>(db, `SELECT * FROM shop_deals WHERE shop_id = ? AND account_id = ? AND status = 'active' AND (stock_id = ? OR stock_id IS NULL) ORDER BY pct DESC, created_at LIMIT 1`, shopId, accountId, stockId) ?? null;

export function addDeal(db: DB, s: Pick<ShopRow, 'id' | 'world_id'>, d: { accountId: string; stockId: string | null; pct: number; source: 'haggle' | 'counter' | 'dm' | 'refused'; minutes: number | null; note?: string; askedPct?: number; status?: string }): DealRow {
  const nowMin = getClock(db, s.world_id).minutes;
  const did = newId('dl_');
  run(db, 'INSERT INTO shop_deals (id, shop_id, world_id, account_id, stock_id, pct, status, source, note, asked_pct, created_min, expires_min, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    did, s.id, s.world_id, d.accountId, d.stockId, d.pct, d.status ?? 'active', d.source, (d.note ?? '').slice(0, 300), d.askedPct ?? null, nowMin, d.minutes === null ? null : nowMin + d.minutes, now());
  return one<DealRow>(db, 'SELECT * FROM shop_deals WHERE id = ?', did)!;
}

export const dealOut = (x: DealRow, lineName?: string) => ({ id: x.id, stockId: x.stock_id, line: lineName ?? null, pct: x.pct, source: x.source, status: x.status, expiresMin: x.expires_min, at: x.created_at });

// ---------------- sending a shop to a player ----------------

export interface PresentOpts { to: string[] | 'all'; open?: boolean; message?: string; by?: string | null }

/**
 * Put a shop on players' screens: an NPC walks up and offers their wares. Used by the GM's "Send to player",
 * the present_shop agent tool, and other features (NPC encounters) from code. A hidden shop is refused unless
 * `open` is set, which opens it (players cannot buy from a shop they cannot see). Returns who it went to.
 */
export function presentShop(d: Deps, worldId: string, shopId: string, o: PresentOpts): { shop: ShopRow; sentTo: string[]; opened: boolean } {
  const { db } = d;
  let s = one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ? AND world_id = ?', shopId, worldId);
  if (!s) throw new HttpError(404, 'Shop not found');
  let opened = false;
  if (s.status !== 'open') {
    if (!o.open) throw new HttpError(409, s.status === 'hidden' ? 'This shop is hidden from players: open it first (or send it with open)' : 'This shop is closed: open it first (or send it with open)');
    run(db, `UPDATE shops SET status = 'open', updated_at = ? WHERE id = ?`, now(), s.id);
    opened = true;
    s = one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ?', s.id)!;
    d.hub.emit(worldId, 'shop', { id: s.id }, (v) => v.role === 'dm' || v.role === 'player');
  }
  const players = all<{ account_id: string }>(db, `SELECT account_id FROM members WHERE world_id = ? AND role = 'player'`, worldId).map((r) => r.account_id);
  const sentTo = o.to === 'all' ? players : [...new Set(o.to)].filter((a) => players.includes(a));
  if (!sentTo.length) throw new HttpError(400, o.to === 'all' ? 'This world has no players yet' : 'Pick players of this world to send it to');
  const k = keeperOf(s);
  const payload = { shopId: s.id, shopName: s.name, keeper: k.name ?? null, role: k.role ?? null, message: (o.message ?? '').slice(0, 300) || null };
  d.hub.emit(worldId, 'shop-present', payload, (v) => v.role === 'player' && sentTo.includes(v.accountId) && playerVisible(s!));
  return { shop: s, sentTo, opened };
}

/**
 * A player's own prices on their view of a shop: each line gets listPriceCp (what everyone pays), priceCp (what
 * this player pays: reputation and their best deal applied) and dealPct; `you` says how the keeper sees them.
 */
export function personalize(db: DB, s: ShopRow, view: any, accountId: string, repEffect: number) {
  if (!view || !accountId) return view;
  settleDeals(db, s.world_id);
  const r = repOf(db, s.id, accountId);
  const rep = r?.rep ?? 0;
  const repPct = repDiscount(rep, repEffect);
  const deals = activeDeals(db, s.id, accountId);
  const names = new Map<string, string>((view.stock ?? []).map((l: any) => [l.id, l.name]));
  for (const l of view.stock ?? []) {
    const deal = deals.find((x) => x.stock_id === l.id || x.stock_id === null);
    l.listPriceCp = l.priceCp;
    l.dealPct = deal?.pct ?? 0;
    l.priceCp = l.priceCp === null ? null : personalPrice(l.priceCp, repPct, l.dealPct);
  }
  view.you = { standing: standing(rep), repPct, deals: deals.filter((x) => x.stock_id === null || names.has(x.stock_id)).map((x) => dealOut(x, x.stock_id ? names.get(x.stock_id) : undefined)) };
  return view;
}
