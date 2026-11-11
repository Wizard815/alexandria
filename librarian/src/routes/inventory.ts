// Personal and party inventories. Weight only appears when the world tracks
// it. dm_note is for the DM alone (e.g. "this ring is cursed") and is never
// sent to players.
//
// Players can't change items directly: an add, edit, move or remove is a
// proposal (item_changes, status pending) until the DM approves it. A
// player-added item exists as status 'pending' and shows as "Waiting for the
// DM". The DM's changes to someone else's items apply at once but leave an
// alert the owner can confirm or dispute; the DM can revert a dispute.
import { Router, type Response } from 'express';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { type DB, one, all, run, tx } from '../core/db.ts';
import { requirePlayerOrDM } from '../core/auth.ts';
import { dmAnd } from '../core/events.ts';
import { HttpError, id, int, now, str } from '../core/util.ts';
import { ctx, isDM, me, memberIds, settings } from './_shared.ts';

const ITEM_COLS = ['owner', 'name', 'qty', 'weight', 'note', 'dm_note', 'link'] as const;
export const itemSnapshot = (it: any) => Object.fromEntries(ITEM_COLS.map((k) => [k, it[k] ?? null]));

/** Apply a pending change (approve). `over` lets the DM edit it first. */
export function applyChange(db: DB, ch: any, over: Record<string, any> = {}, by: string) {
  const after = { ...JSON.parse(ch.after_json || '{}'), ...over };
  tx(db, () => {
    if (ch.kind === 'add') {
      run(db, `UPDATE items SET status = 'approved', owner = ?, name = ?, qty = ?, weight = ?, note = ?, dm_note = ?, link = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
        after.owner, after.name, after.qty, after.weight, after.note ?? '', after.dm_note ?? '', after.link, now(), by, ch.item_id);
    } else if (ch.kind === 'edit') {
      const it = one<any>(db, 'SELECT * FROM items WHERE id = ?', ch.item_id);
      if (!it) throw new HttpError(409, 'That item no longer exists');
      const n = { ...it, ...after };
      run(db, 'UPDATE items SET owner = ?, name = ?, qty = ?, weight = ?, note = ?, dm_note = ?, link = ?, updated_at = ?, updated_by = ? WHERE id = ?',
        n.owner, n.name, n.qty, n.weight, n.note, n.dm_note, n.link, now(), by, it.id);
    } else if (ch.kind === 'remove') {
      run(db, 'DELETE FROM items WHERE id = ?', ch.item_id);
    }
    run(db, `UPDATE item_changes SET status = 'approved', after_json = ?, decided_by = ?, decided_at = ? WHERE id = ?`, JSON.stringify(after), by, now(), ch.id);
  });
}

/** Reject a pending change: nothing happens, and a proposed new item goes away. */
export function rejectChange(db: DB, ch: any, by: string) {
  tx(db, () => {
    if (ch.kind === 'add') run(db, `DELETE FROM items WHERE id = ? AND status = 'pending'`, ch.item_id);
    run(db, `UPDATE item_changes SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?`, by, now(), ch.id);
  });
}

/** Undo a DM change the owner disputed (or any DM change): put the item back as it was. */
export function revertChange(db: DB, ch: any, by: string) {
  const before = ch.before_json ? JSON.parse(ch.before_json) : null;
  tx(db, () => {
    if (ch.kind === 'add') run(db, 'DELETE FROM items WHERE id = ?', ch.item_id);
    else if (before) {
      const it = one<any>(db, 'SELECT id FROM items WHERE id = ?', ch.item_id);
      if (it) run(db, 'UPDATE items SET owner = ?, name = ?, qty = ?, weight = ?, note = ?, dm_note = ?, link = ?, updated_at = ?, updated_by = ? WHERE id = ?', before.owner, before.name, before.qty, before.weight, before.note ?? '', before.dm_note ?? '', before.link, now(), by, ch.item_id);
      else run(db, `INSERT INTO items (id, world_id, owner, name, qty, weight, note, dm_note, link, updated_at, updated_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`, ch.item_id, ch.world_id, before.owner, before.name, before.qty, before.weight, before.note ?? '', before.dm_note ?? '', before.link, now(), by);
    }
    run(db, `UPDATE item_changes SET status = 'reverted', decided_by = ?, decided_at = ? WHERE id = ?`, by, now(), ch.id);
  });
}

export default function inventoryRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;

  function owner(res: Response, raw: string, writing: boolean) {
    if (raw === 'party') return 'party';
    if (raw === 'me' || raw === me(res)) return me(res);
    if (!isDM(res)) throw new HttpError(403, 'You can only see your own and the party inventory');
    if (writing && !settings(res).dmEditsInventory) throw new HttpError(403, 'DM edits to player inventories are off in World settings');
    if (!memberIds(db, ctx(res).world.id).includes(raw)) throw new HttpError(404, 'Player not found');
    return raw;
  }

  const playerShown = (s: any, it: any) => {
    const out: any = { owner: it.owner, name: it.name, qty: it.qty, note: it.note, link: it.link };
    if (s.trackWeight) out.weight = it.weight;
    return out;
  };

  function shape(res: Response, it: any) {
    const s = settings(res);
    const out: any = { id: it.id, owner: it.owner, name: it.name, qty: it.qty, note: it.note, link: it.link, updated_at: it.updated_at, updated_by: it.updated_by, status: it.status ?? 'approved' };
    if (s.trackWeight) out.weight = it.weight;
    if (isDM(res)) out.dm_note = it.dm_note;
    // A proposed edit, move or removal waiting for the DM.
    const ch = one<any>(db, `SELECT id, kind, after_json, by_id, at FROM item_changes WHERE item_id = ? AND status = 'pending' ORDER BY at DESC LIMIT 1`, it.id);
    if (ch && (isDM(res) || ch.by_id === me(res) || it.owner === 'party')) {
      const after = JSON.parse(ch.after_json || '{}');
      out.pendingChange = { id: ch.id, kind: ch.kind, by: ch.by_id, at: ch.at, ...(ch.kind === 'edit' ? { to: isDM(res) ? after : playerShown(s, { ...it, ...after }) } : {}) };
    }
    return out;
  }

  const notify = (res: Response, it: any, type: string) => {
    const c = ctx(res);
    const s = settings(res);
    d.hub.emitPer(c.world.id, type, (v) => {
      if (it.owner !== 'party' && v.role !== 'dm' && v.accountId !== it.owner) return null;
      const out: any = { id: it.id, owner: it.owner, name: it.name, qty: it.qty, note: it.note, link: it.link, status: it.status ?? 'approved' };
      if (s.trackWeight) out.weight = it.weight;
      if (v.role === 'dm') out.dm_note = it.dm_note;
      return out;
    });
  };
  const approvalEvent = (res: Response, ch: { id: string; owner: string; kind: string }, status: string) => {
    const c = ctx(res);
    const party = ch.owner === 'party' ? memberIds(db, c.world.id) : [];
    d.hub.emit(c.world.id, 'approval', { id: ch.id, kind: ch.kind, status }, dmAnd(me(res), ...(ch.owner !== 'party' ? [ch.owner] : party)));
  };

  // The DM changed someone else's items: record it so the owner is told.
  function dmAlert(res: Response, kind: 'add' | 'edit' | 'remove', itemId: string, ownerId: string, before: any, after: any, reason: string) {
    const c = ctx(res);
    if (ownerId === me(res)) return;
    const ch = { id: id('chg_'), owner: ownerId, kind };
    run(db, `INSERT INTO item_changes (id, world_id, item_id, owner, kind, before_json, after_json, reason, by_id, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'alert')`,
      ch.id, c.world.id, itemId, ownerId, kind, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason, me(res), now());
    approvalEvent(res, ch, 'alert');
  }
  function dmReason(res: Response, b: any, ownerId: string) {
    const reason = str(b?.reason, 'reason', { max: 300, optional: true });
    if (isDM(res) && ownerId !== me(res) && settings(res).dmChangeReason && !reason.trim()) throw new HttpError(400, 'Say why you are changing this player’s items (reason)');
    return reason;
  }
  const needsApproval = (res: Response) => !isDM(res) && settings(res).playerChangesNeedApproval;

  r.get('/', (req, res) => {
    const c = ctx(res);
    const o = owner(res, String(req.query.owner ?? 'me'), false);
    const items = all(db, `SELECT * FROM items WHERE world_id = ? AND owner = ? AND status IN ('approved', 'pending') ORDER BY status, name`, c.world.id, o).map((it) => shape(res, it));
    const s = settings(res);
    const out: any = { owner: o, items, trackWeight: s.trackWeight, coins: s.coins };
    if (s.trackWeight) out.totalWeight = items.filter((it: any) => it.status === 'approved').reduce((n: number, it: any) => n + (it.weight ?? 0) * it.qty, 0);
    res.json(out);
  });

  r.post('/', requirePlayerOrDM, (req, res) => {
    const c = ctx(res);
    const b = req.body ?? {};
    const o = owner(res, String(b.owner ?? 'me'), true);
    const pending = needsApproval(res);
    const reason = dmReason(res, b, o);
    const it = {
      id: id('itm_'), owner: o, name: str(b.name, 'name', { max: 120 }), qty: int(b.qty, 'qty', { min: 0, max: 1_000_000, optional: true }) ?? 1,
      weight: b.weight !== undefined && b.weight !== null ? Number(b.weight) || 0 : null,
      note: str(b.note, 'note', { max: 500, optional: true }), dm_note: isDM(res) ? str(b.dmNote, 'dmNote', { max: 500, optional: true }) : '',
      link: str(b.link, 'link', { max: 300, optional: true }) || null, updated_at: now(), updated_by: me(res), status: pending ? 'pending' : 'approved',
    };
    tx(db, () => {
      run(db, 'INSERT INTO items (id, world_id, owner, name, qty, weight, note, dm_note, link, updated_at, updated_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        it.id, c.world.id, it.owner, it.name, it.qty, it.weight, it.note, it.dm_note, it.link, it.updated_at, it.updated_by, it.status);
      if (pending) {
        const chId = id('chg_');
        run(db, `INSERT INTO item_changes (id, world_id, item_id, owner, kind, after_json, reason, by_id, at, status) VALUES (?, ?, ?, ?, 'add', ?, ?, ?, ?, 'pending')`,
          chId, c.world.id, it.id, o, JSON.stringify(itemSnapshot(it)), str(b.reason, 'reason', { max: 300, optional: true }), me(res), now());
        approvalEvent(res, { id: chId, owner: o, kind: 'add' }, 'pending');
      } else if (isDM(res)) dmAlert(res, 'add', it.id, o, null, itemSnapshot(it), reason);
    });
    audit(db, c.world.id, me(res), pending ? 'item.request' : 'item.add', `${o} ${it.name} x${it.qty}`);
    if (!pending) notify(res, it, 'item');
    res.status(pending ? 202 : 201).json({ ...shape(res, it), pending });
  });

  r.patch('/:iid', requirePlayerOrDM, (req, res) => {
    const c = ctx(res);
    const it = one<any>(db, `SELECT * FROM items WHERE id = ? AND world_id = ? AND status IN ('approved', 'pending')`, String(req.params.iid), c.world.id);
    if (!it) throw new HttpError(404, 'Item not found');
    owner(res, it.owner, true);
    const b = req.body ?? {};
    const next = {
      ...it,
      name: b.name !== undefined ? str(b.name, 'name', { max: 120 }) : it.name,
      qty: b.qty !== undefined ? int(b.qty, 'qty', { min: 0, max: 1_000_000 }) : it.qty,
      weight: b.weight !== undefined ? (b.weight === null ? null : Number(b.weight) || 0) : it.weight,
      note: b.note !== undefined ? str(b.note, 'note', { max: 500, optional: true }) : it.note,
      dm_note: b.dmNote !== undefined && isDM(res) ? str(b.dmNote, 'dmNote', { max: 500, optional: true }) : it.dm_note,
      link: b.link !== undefined ? str(b.link, 'link', { max: 300, optional: true }) || null : it.link,
      owner: b.owner !== undefined ? owner(res, String(b.owner), true) : it.owner,
      updated_at: now(), updated_by: me(res),
    };
    if (needsApproval(res)) {
      if (it.status === 'pending') {
        // Still only a proposal: the proposer may adjust it.
        const ch = one<any>(db, `SELECT * FROM item_changes WHERE item_id = ? AND kind = 'add' AND status = 'pending'`, it.id);
        if (!ch || ch.by_id !== me(res)) throw new HttpError(409, 'This item is waiting for the DM');
        tx(db, () => {
          run(db, 'UPDATE items SET owner = ?, name = ?, qty = ?, weight = ?, note = ?, link = ?, updated_at = ? WHERE id = ?', next.owner, next.name, next.qty, next.weight, next.note, next.link, now(), it.id);
          run(db, 'UPDATE item_changes SET owner = ?, after_json = ? WHERE id = ?', next.owner, JSON.stringify(itemSnapshot(next)), ch.id);
        });
        return res.status(202).json({ ...shape(res, next), pending: true });
      }
      const chId = id('chg_');
      tx(db, () => {
        run(db, `UPDATE item_changes SET status = 'rejected', decided_by = ?, decided_at = ? WHERE item_id = ? AND status = 'pending' AND by_id = ?`, me(res), now(), it.id, me(res));
        run(db, `INSERT INTO item_changes (id, world_id, item_id, owner, kind, before_json, after_json, reason, by_id, at, status) VALUES (?, ?, ?, ?, 'edit', ?, ?, ?, ?, ?, 'pending')`,
          chId, c.world.id, it.id, it.owner, JSON.stringify(itemSnapshot(it)), JSON.stringify(Object.fromEntries(Object.entries(itemSnapshot(next)).filter(([k, v]) => k !== 'dm_note' && v !== itemSnapshot(it)[k]))), str(b.reason, 'reason', { max: 300, optional: true }), me(res), now());
      });
      audit(db, c.world.id, me(res), 'item.request', `edit ${it.name}`);
      approvalEvent(res, { id: chId, owner: it.owner, kind: 'edit' }, 'pending');
      return res.status(202).json({ ...shape(res, it), pending: true });
    }
    const reason = dmReason(res, b, it.owner);
    tx(db, () => {
      run(db, 'UPDATE items SET owner = ?, name = ?, qty = ?, weight = ?, note = ?, dm_note = ?, link = ?, updated_at = ?, updated_by = ? WHERE id = ?',
        next.owner, next.name, next.qty, next.weight, next.note, next.dm_note, next.link, next.updated_at, next.updated_by, it.id);
      if (isDM(res)) dmAlert(res, 'edit', it.id, it.owner, itemSnapshot(it), itemSnapshot(next), reason);
    });
    audit(db, c.world.id, me(res), 'item.update', `${it.owner}->${next.owner} ${next.name} x${next.qty}`);
    notify(res, next, 'item');
    if (next.owner !== it.owner) d.hub.emit(c.world.id, 'item-moved', { id: it.id, from: it.owner }, it.owner === 'party' ? () => true : dmAnd(it.owner));
    res.json(shape(res, next));
  });

  r.delete('/:iid', requirePlayerOrDM, (req, res) => {
    const c = ctx(res);
    const it = one<any>(db, `SELECT * FROM items WHERE id = ? AND world_id = ? AND status IN ('approved', 'pending')`, String(req.params.iid), c.world.id);
    if (!it) throw new HttpError(404, 'Item not found');
    owner(res, it.owner, true);
    if (needsApproval(res)) {
      if (it.status === 'pending') {
        // Withdraw your own proposal.
        const ch = one<any>(db, `SELECT * FROM item_changes WHERE item_id = ? AND kind = 'add' AND status = 'pending'`, it.id);
        if (!ch || ch.by_id !== me(res)) throw new HttpError(409, 'This item is waiting for the DM');
        rejectChange(db, ch, me(res));
        return res.json({ ok: true, withdrawn: true });
      }
      const chId = id('chg_');
      run(db, `INSERT INTO item_changes (id, world_id, item_id, owner, kind, before_json, reason, by_id, at, status) VALUES (?, ?, ?, ?, 'remove', ?, ?, ?, ?, 'pending')`,
        chId, c.world.id, it.id, it.owner, JSON.stringify(itemSnapshot(it)), str(req.body?.reason ?? req.query.reason, 'reason', { max: 300, optional: true }), me(res), now());
      audit(db, c.world.id, me(res), 'item.request', `remove ${it.name}`);
      approvalEvent(res, { id: chId, owner: it.owner, kind: 'remove' }, 'pending');
      return res.status(202).json({ ok: true, pending: true });
    }
    const reason = dmReason(res, { reason: req.body?.reason ?? req.query.reason }, it.owner);
    tx(db, () => {
      run(db, 'DELETE FROM items WHERE id = ?', it.id);
      if (isDM(res)) dmAlert(res, 'remove', it.id, it.owner, itemSnapshot(it), null, reason);
    });
    audit(db, c.world.id, me(res), 'item.remove', `${it.owner} ${it.name}`);
    d.hub.emit(c.world.id, 'item-removed', { id: it.id }, it.owner === 'party' ? () => true : dmAnd(it.owner));
    res.json({ ok: true });
  });

  return r;
}
