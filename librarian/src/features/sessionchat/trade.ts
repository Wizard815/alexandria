// Trade offers between two players: A gives an item and/or coin, B gives an
// item and/or coin back. Accepting makes both moves in one transaction, using
// the same rules as free giving in the inventory (you can only hand over what
// you own, stacks merge, every move is logged in `transfers` and the coin
// ledger). Declining or cancelling moves nothing.
import { type DB, all, one, run, tx } from '../../core/db.ts';
import { balance, money } from '../../core/coin.ts';
import { HttpError, id, now } from '../../core/util.ts';

export interface TradeInput {
  fromId: string; toId: string;
  offerItemId: string | null; offerQty: number; offerCp: number;
  wantItemName: string | null; wantQty: number; wantCp: number;
  note: string;
}

const sameItem = (db: DB, worldId: string, owner: string, it: any, exceptId: string) =>
  one<any>(db, `SELECT * FROM items WHERE world_id = ? AND owner = ? AND status = 'approved' AND lower(name) = lower(?) AND IFNULL(link, '') = IFNULL(?, '') AND IFNULL(image, '') = IFNULL(?, '') AND IFNULL(page_id, '') = IFNULL(?, '') AND dm_note = ? AND IFNULL(weight, -1) = IFNULL(?, -1) AND id <> ?`,
    worldId, owner, it.name, it.link, it.image, it.page_id, it.dm_note, it.weight, exceptId);

/** An item a player owns outright: approved, theirs, no change waiting for the DM, enough in the stack. */
export function ownedItem(db: DB, worldId: string, owner: string, itemId: string, qty: number) {
  const it = one<any>(db, `SELECT * FROM items WHERE id = ? AND world_id = ? AND status = 'approved'`, itemId, worldId);
  if (!it || it.owner !== owner) throw new HttpError(403, 'You can only trade items you own');
  if (one(db, `SELECT 1 FROM item_changes WHERE item_id = ? AND status = 'pending'`, it.id)) throw new HttpError(409, `${it.name} has a change waiting for the DM`);
  if (qty > it.qty) throw new HttpError(400, `There are only ${it.qty} ${it.name}`);
  return it;
}

/** Move qty of an item to another owner (inside a transaction). Returns the item name. */
function moveItem(db: DB, worldId: string, it: any, to: string, qty: number, by: string) {
  const same = sameItem(db, worldId, to, it, it.id);
  if (qty === it.qty && !same) run(db, 'UPDATE items SET owner = ?, updated_at = ?, updated_by = ? WHERE id = ?', to, now(), by, it.id);
  else {
    if (qty === it.qty) run(db, 'DELETE FROM items WHERE id = ?', it.id);
    else run(db, 'UPDATE items SET qty = qty - ?, updated_at = ?, updated_by = ? WHERE id = ?', qty, now(), by, it.id);
    if (same) run(db, 'UPDATE items SET qty = qty + ?, updated_at = ?, updated_by = ? WHERE id = ?', qty, now(), by, same.id);
    else {
      const nid = id('itm_');
      run(db, `INSERT INTO items (id, world_id, owner, name, qty, weight, note, dm_note, link, image, updated_at, updated_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`,
        nid, worldId, to, it.name, qty, it.weight, it.note, it.dm_note, it.link, it.image, now(), by);
      if (it.page_id) run(db, 'UPDATE items SET page_id = ? WHERE id = ?', it.page_id, nid);
    }
  }
}

function logTransfer(db: DB, worldId: string, by: string, t: { kind: 'coin' | 'item'; from: string; to: string; amount?: number; item?: string; qty?: number; note: string }) {
  const tid = id('trf_');
  run(db, 'INSERT INTO transfers (id, world_id, kind, from_owner, to_owner, amount_cp, item_name, qty, note, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    tid, worldId, t.kind, t.from, t.to, t.amount ?? null, t.item ?? null, t.qty ?? null, t.note, by, now());
  return tid;
}

function moveCoin(db: DB, worldId: string, from: string, to: string, amount: number, by: string, note: string, label: (x: string) => string) {
  if (balance(db, worldId, from) < amount) throw new HttpError(402, `Not enough coin: ${label(from)} would need ${money(amount)}`);
  const tid = logTransfer(db, worldId, by, { kind: 'coin', from, to, amount, note });
  run(db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status, transfer_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?)`, id('led_'), worldId, from, -amount, `Trade with ${label(to)}`.slice(0, 200), by, now(), tid);
  run(db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status, transfer_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?)`, id('led_'), worldId, to, amount, `Trade with ${label(from)}`.slice(0, 200), by, now(), tid);
}

export const tradeOut = (t: any) => ({
  id: t.id, from: t.from_id, to: t.to_id,
  offer: { itemId: t.offer_item_id, item: t.offer_item_name, qty: t.offer_qty, cp: t.offer_cp },
  want: { item: t.want_item_name, qty: t.want_qty, cp: t.want_cp },
  note: t.note, status: t.status, reason: t.fail_reason, at: t.created_at, decidedAt: t.decided_at,
});

export function createTrade(db: DB, worldId: string, t: TradeInput) {
  if (t.fromId === t.toId) throw new HttpError(400, 'Pick someone else to trade with');
  if (!t.offerItemId && !t.offerCp) throw new HttpError(400, 'Offer an item or some coin');
  if (!t.wantItemName && !t.wantCp) throw new HttpError(400, 'Ask for an item or some coin');
  let offerName: string | null = null;
  if (t.offerItemId) offerName = ownedItem(db, worldId, t.fromId, t.offerItemId, t.offerQty).name;
  if (t.offerCp && balance(db, worldId, t.fromId) < t.offerCp) throw new HttpError(402, `You only have ${money(Math.max(0, balance(db, worldId, t.fromId)))}`);
  const row = { id: id('trd_'), world_id: worldId, from_id: t.fromId, to_id: t.toId, offer_item_id: t.offerItemId, offer_item_name: offerName, offer_qty: t.offerItemId ? t.offerQty : 0, offer_cp: t.offerCp,
    want_item_name: t.wantItemName, want_qty: t.wantItemName ? t.wantQty : 0, want_cp: t.wantCp, note: t.note, status: 'open', fail_reason: null, created_at: now(), decided_at: null };
  run(db, `INSERT INTO sessionchat_trades (id, world_id, from_id, to_id, offer_item_id, offer_item_name, offer_qty, offer_cp, want_item_name, want_qty, want_cp, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    row.id, worldId, row.from_id, row.to_id, row.offer_item_id, row.offer_item_name, row.offer_qty, row.offer_cp, row.want_item_name, row.want_qty, row.want_cp, row.note, row.created_at);
  return row;
}

/**
 * B accepts. Everything is checked again against today's inventories and then
 * both sides move, or nothing does. `wantItemId` picks which of B's items to
 * hand over when B has several that match the name.
 */
export function acceptTrade(db: DB, worldId: string, tradeId: string, by: string, wantItemId: string | null, label: (x: string) => string) {
  return tx(db, () => {
    const t = one<any>(db, 'SELECT * FROM sessionchat_trades WHERE id = ? AND world_id = ?', tradeId, worldId);
    if (!t) throw new HttpError(404, 'Trade not found');
    if (t.to_id !== by) throw new HttpError(403, 'Only the person it was offered to can accept');
    if (t.status !== 'open') throw new HttpError(409, `This trade is already ${t.status}`);
    let mine: any = null;
    if (t.want_item_name) {
      if (wantItemId) mine = ownedItem(db, worldId, by, wantItemId, t.want_qty);
      else {
        const candidates = all<any>(db, `SELECT * FROM items WHERE world_id = ? AND owner = ? AND status = 'approved' AND lower(name) = lower(?) ORDER BY qty DESC`, worldId, by, t.want_item_name);
        const found = candidates.find((c) => c.qty >= t.want_qty);
        if (!found) throw new HttpError(409, `You do not have ${t.want_qty} ${t.want_item_name}`);
        mine = ownedItem(db, worldId, by, found.id, t.want_qty);
      }
      if (mine.name.toLowerCase() !== String(t.want_item_name).toLowerCase()) throw new HttpError(400, `That is not ${t.want_item_name}`);
    }
    // Re-check what A still has: the offer may have gone stale.
    let theirs: any = null;
    if (t.offer_item_id) {
      try { theirs = ownedItem(db, worldId, t.from_id, t.offer_item_id, t.offer_qty); }
      catch (e: any) { throw new HttpError(409, `The offer is no longer possible: ${e.message}`); }
    }
    if (t.offer_cp && balance(db, worldId, t.from_id) < t.offer_cp) throw new HttpError(409, 'The offer is no longer possible: not enough coin on their side');
    if (t.want_cp && balance(db, worldId, by) < t.want_cp) throw new HttpError(402, `Not enough coin: you need ${money(t.want_cp)}`);
    // Stacks may merge during the first move, so read each row again before moving it.
    const fresh = (it: any) => one<any>(db, 'SELECT * FROM items WHERE id = ?', it.id)!;
    if (theirs) { moveItem(db, worldId, fresh(theirs), by, t.offer_qty, by); logTransfer(db, worldId, by, { kind: 'item', from: t.from_id, to: by, item: theirs.name, qty: t.offer_qty, note: 'Trade' }); }
    if (mine) { moveItem(db, worldId, fresh(mine), t.from_id, t.want_qty, by); logTransfer(db, worldId, by, { kind: 'item', from: by, to: t.from_id, item: mine.name, qty: t.want_qty, note: 'Trade' }); }
    if (t.offer_cp) moveCoin(db, worldId, t.from_id, by, t.offer_cp, by, 'Trade', label);
    if (t.want_cp) moveCoin(db, worldId, by, t.from_id, t.want_cp, by, 'Trade', label);
    run(db, `UPDATE sessionchat_trades SET status = 'accepted', decided_at = ? WHERE id = ?`, now(), t.id);
    return one<any>(db, 'SELECT * FROM sessionchat_trades WHERE id = ?', t.id)!;
  });
}

export function closeTrade(db: DB, worldId: string, tradeId: string, by: string, how: 'declined' | 'cancelled') {
  const t = one<any>(db, 'SELECT * FROM sessionchat_trades WHERE id = ? AND world_id = ?', tradeId, worldId);
  if (!t) throw new HttpError(404, 'Trade not found');
  if (how === 'declined' ? t.to_id !== by : t.from_id !== by) throw new HttpError(403, how === 'declined' ? 'Only the person it was offered to can decline' : 'Only the person who offered can cancel');
  if (t.status !== 'open') throw new HttpError(409, `This trade is already ${t.status}`);
  run(db, 'UPDATE sessionchat_trades SET status = ?, decided_at = ? WHERE id = ?', how, now(), t.id);
  return one<any>(db, 'SELECT * FROM sessionchat_trades WHERE id = ?', t.id)!;
}
