// Shops: a name, a kind, a shopkeeper card, a place, stock lines that point at
// the item database, a markup, and a status. What players get is built here
// and only here (playerShop), from a short allow-list of fields, so nothing
// the DM keeps (notes, the haggle note, the keeper's secret, hidden stock
// lines) can ride along.
import type { Deps } from '../../app.ts';
import { type DB, all, one, run } from '../../core/db.ts';
import { parseJson } from '../../core/util.ts';
import type { Viewer } from '../../core/policy.ts';
import { getClock } from '../clock/api.ts';
import type { ItemRow } from './items.ts';

export const SHOP_KINDS = ['general', 'blacksmith', 'alchemist', 'magic', 'tavern', 'fence'] as const;
export type ShopKind = (typeof SHOP_KINDS)[number];
export const KIND_LABEL: Record<ShopKind, string> = { general: 'General store', blacksmith: 'Blacksmith', alchemist: 'Alchemist', magic: 'Magic shop', tavern: 'Tavern shop', fence: 'Fence' };
export const STATUSES = ['hidden', 'closed', 'open'] as const;
export type ShopStatus = (typeof STATUSES)[number];
export const RESTOCK_RULES = ['manual', 'days'] as const;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'general',
  description TEXT NOT NULL DEFAULT '',
  keeper TEXT NOT NULL DEFAULT '{}',
  location_page_id TEXT,
  markup_pct INTEGER NOT NULL DEFAULT 0,
  haggle TEXT NOT NULL DEFAULT '',
  dm_notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'hidden',
  restock_rule TEXT NOT NULL DEFAULT 'manual',
  restock_days INTEGER NOT NULL DEFAULT 7,
  restocked_min INTEGER,
  restocked_at TEXT,
  sell_pct INTEGER,
  gen TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shops_world ON shops (world_id);
CREATE TABLE IF NOT EXISTS shop_stock (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  world_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES shop_items(id) ON DELETE CASCADE,
  price_cp INTEGER,
  qty INTEGER,
  base_qty INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0,
  dm_note TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS shop_stock_shop ON shop_stock (shop_id);
CREATE TABLE IF NOT EXISTS shop_orders (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  shop_id TEXT NOT NULL,
  stock_id TEXT,
  item_id TEXT,
  kind TEXT NOT NULL,
  account_id TEXT NOT NULL,
  payer TEXT,
  dest TEXT,
  qty INTEGER NOT NULL,
  unit_cp INTEGER NOT NULL,
  total_cp INTEGER NOT NULL,
  ledger_id TEXT,
  inv_item_id TEXT,
  item_name TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS shop_orders_world ON shop_orders (world_id, status);
`;

export interface Keeper { name?: string; race?: string; role?: string; look?: string; voice?: string; personality?: string; secret?: string; pageId?: string | null; seed?: string }
export interface ShopRow {
  id: string; world_id: string; name: string; kind: string; description: string; keeper: string; location_page_id: string | null;
  markup_pct: number; haggle: string; dm_notes: string; status: string; restock_rule: string; restock_days: number; restocked_min: number | null;
  restocked_at: string | null; sell_pct: number | null; gen: string; created_at: string; updated_at: string;
}
export interface StockRow { id: string; shop_id: string; world_id: string; item_id: string; price_cp: number | null; qty: number | null; base_qty: number | null; hidden: number; dm_note: string; sort: number }

/** The price of one, in copper: the line's own price, else the item's cost with the shop's markup. null: not for sale. */
export const unitPrice = (shop: Pick<ShopRow, 'markup_pct'>, st: Pick<StockRow, 'price_cp'>, it: Pick<ItemRow, 'cost_cp'>): number | null => {
  if (st.price_cp !== null && st.price_cp !== undefined) return st.price_cp;
  if (it.cost_cp === null || it.cost_cp === undefined) return null;
  return Math.max(0, Math.round((it.cost_cp * (100 + shop.markup_pct)) / 100));
};

export const keeperOf = (s: ShopRow): Keeper => parseJson<Keeper>(s.keeper, {});

export function stockRows(db: DB, shopId: string): (StockRow & { item: ItemRow })[] {
  return all<any>(db, `SELECT s.*, i.name AS i_name, i.id AS i_id FROM shop_stock s JOIN shop_items i ON i.id = s.item_id WHERE s.shop_id = ? ORDER BY s.sort, i.name COLLATE NOCASE`, shopId)
    .map((r) => ({ ...r, item: one<ItemRow>(db, 'SELECT * FROM shop_items WHERE id = ?', r.item_id)! }));
}

/** Lazy restock on the world clock: when the rule says "every N days" and that much game time has passed, stock goes back to its base. */
export function settleRestock(db: DB, shop: ShopRow): boolean {
  if (shop.restock_rule !== 'days' || shop.restock_days < 1) return false;
  const nowMin = getClock(db, shop.world_id).minutes;
  if (shop.restocked_min === null) { run(db, 'UPDATE shops SET restocked_min = ? WHERE id = ?', nowMin, shop.id); shop.restocked_min = nowMin; return false; }
  if (nowMin < shop.restocked_min + shop.restock_days * 1440) return false;
  restock(db, shop.id, nowMin);
  return true;
}

export function restock(db: DB, shopId: string, nowMin?: number) {
  const s = one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ?', shopId);
  if (!s) return;
  run(db, 'UPDATE shop_stock SET qty = base_qty WHERE shop_id = ? AND base_qty IS NOT NULL AND (qty IS NULL OR qty < base_qty)', shopId);
  run(db, 'UPDATE shops SET restocked_min = ?, restocked_at = ? WHERE id = ?', nowMin ?? getClock(db, s.world_id).minutes, new Date().toISOString(), shopId);
}

/** The location page, only if this viewer can open it (players: a page shared with them). */
export function locationFor(d: Deps, s: ShopRow, viewer: Viewer): { id: string; title: string } | null {
  if (!s.location_page_id) return null;
  try { const p: any = d.library.get(s.world_id, s.location_page_id, viewer); return { id: String(p.id), title: String(p.title) }; } catch { return null; }
}

/** Shops a player may see: not hidden. */
export const playerVisible = (s: Pick<ShopRow, 'status'>) => s.status === 'open' || s.status === 'closed';

/** One stock line as a player sees it. */
export function playerLine(shop: ShopRow, st: StockRow, it: ItemRow) {
  return {
    id: st.id, name: it.name, type: it.type, category: it.category, rarity: it.rarity, weight: it.weight,
    description: it.description, properties: it.properties, attunement: !!it.attunement, source: it.source_label, attribution: it.attribution,
    priceCp: unitPrice(shop, st, it), qty: st.qty, unlimited: st.qty === null,
  };
}

/**
 * A shop for a player: the public parts only, and the stock only while it is open. Fail closed: a hidden shop is null,
 * hidden lines never appear, and the keeper card carries name, race, look, voice and personality (never the secret).
 */
export function playerShop(d: Deps, db: DB, s: ShopRow, viewer: Viewer, withStock = true) {
  if (!playerVisible(s)) return null;
  const k = keeperOf(s);
  const out: any = {
    id: s.id, name: s.name, kind: s.kind, kindLabel: KIND_LABEL[s.kind as ShopKind] ?? s.kind, description: s.description, status: s.status,
    keeper: k.name ? { name: k.name ?? '', race: k.race ?? '', role: k.role ?? '', look: k.look ?? '', voice: k.voice ?? '', personality: k.personality ?? '' } : null,
    location: locationFor(d, s, viewer), sellPct: null as number | null,
  };
  if (withStock && s.status === 'open') out.stock = stockRows(db, s.id).filter((r) => !r.hidden).map((r) => playerLine(s, r, r.item));
  else out.stock = [];
  return out;
}

/** The whole shop for the DM. */
export function dmShop(d: Deps, db: DB, s: ShopRow, viewer: Viewer) {
  const k = keeperOf(s);
  return {
    id: s.id, name: s.name, kind: s.kind, kindLabel: KIND_LABEL[s.kind as ShopKind] ?? s.kind, description: s.description, status: s.status,
    keeper: k, locationPageId: s.location_page_id, location: locationFor(d, s, viewer), markupPct: s.markup_pct, haggle: s.haggle, dmNotes: s.dm_notes,
    restock: { rule: s.restock_rule, days: s.restock_days, at: s.restocked_at }, sellPct: s.sell_pct, gen: parseJson<Record<string, unknown>>(s.gen, {}),
    stock: stockRows(db, s.id).map((r) => ({ ...playerLine(s, r, r.item), itemId: r.item_id, priceOverrideCp: r.price_cp, costCp: r.item.cost_cp, baseQty: r.base_qty, hidden: !!r.hidden, dmNote: r.dm_note, dmNotes: r.item.dm_notes })),
    createdAt: s.created_at, updatedAt: s.updated_at,
  };
}
