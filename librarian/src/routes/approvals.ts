// DM approvals. Players can't change coin or items directly: their changes
// wait here. The DM's own changes to someone else's items show up for the
// owner as alerts they can confirm or dispute; a dispute comes back here.
//
// DM:      GET /approvals            pending coin, pending items, disputes, open alerts
//          POST /approvals/:id       {action: approve | edit | reject | revert, ...}
// Player:  GET /approvals/mine       my pending changes and the alerts on my (and party) items
//          POST /approvals/:id/ack   "Looks right"
//          POST /approvals/:id/dispute {note}
import { Router, type Response } from 'express';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { one, all, run } from '../core/db.ts';
import { requireDM } from '../core/auth.ts';
import { dmAnd } from '../core/events.ts';
import { HttpError, int, now, oneOf, str } from '../core/util.ts';
import { ctx, isDM, me, memberIds, settings } from './_shared.ts';
import { applyChange, rejectChange, revertChange } from './inventory.ts';

export default function approvalsRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;

  const parse = (ch: any, dm: boolean) => {
    const s = (j: any) => {
      if (!j) return null;
      const o = JSON.parse(j);
      if (!dm) delete o.dm_note;
      return o;
    };
    return { id: ch.id, type: 'item', item_id: ch.item_id, owner: ch.owner, kind: ch.kind, before: s(ch.before_json), after: s(ch.after_json), reason: ch.reason, by: ch.by_id, at: ch.at, status: ch.status, dispute_note: ch.dispute_note, decided_at: ch.decided_at };
  };
  const coin = (e: any) => ({ id: e.id, type: 'coin', owner: e.owner, amount_cp: e.amount_cp, note: e.note, by: e.by_id, at: e.at, status: e.status, decided_at: e.decided_at ?? null });
  const event = (res: Response, payload: any, owner: string) => {
    const c = ctx(res);
    d.hub.emit(c.world.id, 'approval', payload, dmAnd(me(res), ...(owner === 'party' ? memberIds(db, c.world.id) : [owner])));
  };

  r.get('/', requireDM, (_req, res) => {
    const w = ctx(res).world.id;
    const ch = all<any>(db, `SELECT * FROM item_changes WHERE world_id = ? AND status IN ('pending', 'disputed', 'alert') ORDER BY at`, w).map((x) => parse(x, true));
    res.json({
      coin: all<any>(db, `SELECT * FROM ledger WHERE world_id = ? AND status = 'pending' ORDER BY at`, w).map(coin),
      items: ch.filter((x) => x.status === 'pending'),
      disputes: ch.filter((x) => x.status === 'disputed'),
      alerts: ch.filter((x) => x.status === 'alert'),
      recent: all<any>(db, `SELECT * FROM item_changes WHERE world_id = ? AND status IN ('approved', 'rejected', 'reverted', 'ok') ORDER BY COALESCE(decided_at, at) DESC LIMIT 30`, w).map((x) => parse(x, true)),
      counts: {
        coin: one<any>(db, `SELECT COUNT(*) AS n FROM ledger WHERE world_id = ? AND status = 'pending'`, w)!.n,
        items: ch.filter((x) => x.status === 'pending').length,
        disputes: ch.filter((x) => x.status === 'disputed').length,
      },
    });
  });

  r.get('/mine', (_req, res) => {
    const w = ctx(res).world.id;
    const mine = me(res);
    const party = settings(res).partyPurse;
    res.json({
      coin: all<any>(db, `SELECT * FROM ledger WHERE world_id = ? AND by_id = ? AND status IN ('pending', 'rejected') ORDER BY at DESC LIMIT 30`, w, mine).map(coin),
      items: all<any>(db, `SELECT * FROM item_changes WHERE world_id = ? AND by_id = ? AND status IN ('pending', 'rejected', 'approved') ORDER BY at DESC LIMIT 30`, w, mine).map((x) => parse(x, false)),
      alerts: all<any>(db, `SELECT * FROM item_changes WHERE world_id = ? AND status IN ('alert', 'disputed', 'reverted', 'ok') AND by_id <> ? AND (owner = ? OR owner = 'party') ORDER BY at DESC LIMIT 30`, w, mine, mine).map((x) => parse(x, false)),
      party,
    });
  });

  const alertFor = (res: Response, cid: string) => {
    const ch = one<any>(db, 'SELECT * FROM item_changes WHERE id = ? AND world_id = ?', cid, ctx(res).world.id);
    if (!ch || (ch.owner !== me(res) && ch.owner !== 'party')) throw new HttpError(404, 'Change not found');
    if (!['alert', 'disputed', 'ok'].includes(ch.status)) throw new HttpError(409, 'Nothing to answer on this change');
    return ch;
  };
  r.post('/:id/ack', (req, res) => {
    const ch = alertFor(res, String(req.params.id));
    run(db, `UPDATE item_changes SET status = 'ok', decided_at = ? WHERE id = ?`, now(), ch.id);
    event(res, { id: ch.id, status: 'ok' }, ch.owner);
    res.json({ ok: true });
  });
  r.post('/:id/dispute', (req, res) => {
    const ch = alertFor(res, String(req.params.id));
    const note = str(req.body?.note, 'note', { max: 500 });
    run(db, `UPDATE item_changes SET status = 'disputed', dispute_note = ?, decided_at = ? WHERE id = ?`, note, now(), ch.id);
    audit(db, ctx(res).world.id, me(res), 'item.dispute', ch.id);
    event(res, { id: ch.id, status: 'disputed' }, ch.owner);
    res.json({ ok: true });
  });

  r.post('/:id', requireDM, (req, res) => {
    const w = ctx(res).world.id;
    const rid = String(req.params.id);
    const action = oneOf(req.body?.action, 'action', ['approve', 'edit', 'reject', 'revert'] as const);
    if (rid.startsWith('led_')) {
      const e = one<any>(db, `SELECT * FROM ledger WHERE id = ? AND world_id = ? AND status = 'pending'`, rid, w);
      if (!e) throw new HttpError(404, 'Nothing waiting with that id');
      if (action === 'reject') run(db, `UPDATE ledger SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?`, me(res), now(), e.id);
      else if (action === 'approve' || action === 'edit') {
        const amount = req.body?.amountCp !== undefined ? int(req.body.amountCp, 'amountCp', { min: -100_000_000, max: 100_000_000 })! : e.amount_cp;
        if (amount === 0) throw new HttpError(400, 'amountCp cannot be zero');
        const note = req.body?.note !== undefined ? str(req.body.note, 'note', { max: 200, optional: true }) : e.note;
        run(db, `UPDATE ledger SET status = 'approved', amount_cp = ?, note = ?, decided_by = ?, decided_at = ? WHERE id = ?`, amount, note, me(res), now(), e.id);
      } else throw new HttpError(400, 'Coin requests can be approved, edited or rejected');
      audit(db, w, me(res), `coin.${action}`, e.id);
      const balance = one<any>(db, `SELECT COALESCE(SUM(amount_cp), 0) AS cp FROM ledger WHERE world_id = ? AND owner = ? AND status = 'approved'`, w, e.owner)!.cp;
      d.hub.emit(w, 'coin', { owner: e.owner, balance }, e.owner === 'party' ? () => true : dmAnd(e.owner, e.by_id));
      event(res, { id: e.id, type: 'coin', status: action === 'reject' ? 'rejected' : 'approved' }, e.by_id);
      return res.json(coin(one<any>(db, 'SELECT * FROM ledger WHERE id = ?', e.id)));
    }
    const ch = one<any>(db, 'SELECT * FROM item_changes WHERE id = ? AND world_id = ?', rid, w);
    if (!ch) throw new HttpError(404, 'Nothing waiting with that id');
    if (action === 'revert') {
      if (!['alert', 'disputed', 'ok'].includes(ch.status)) throw new HttpError(409, 'Only your own changes can be reverted');
      revertChange(db, ch, me(res));
    } else {
      if (ch.status !== 'pending') throw new HttpError(409, 'This change is not waiting for you');
      if (action === 'reject') rejectChange(db, ch, me(res));
      else {
        const over: Record<string, any> = {};
        const b = req.body?.item ?? {};
        if (action === 'edit') {
          if (b.name !== undefined) over.name = str(b.name, 'name', { max: 120 });
          if (b.qty !== undefined) over.qty = int(b.qty, 'qty', { min: 0, max: 1_000_000 });
          if (b.note !== undefined) over.note = str(b.note, 'note', { max: 500, optional: true });
          if (b.dmNote !== undefined) over.dm_note = str(b.dmNote, 'dmNote', { max: 500, optional: true });
          if (b.weight !== undefined) over.weight = b.weight === null ? null : Number(b.weight) || 0;
          if (b.owner !== undefined) {
            const o = String(b.owner);
            if (o !== 'party' && !memberIds(db, w).includes(o)) throw new HttpError(400, 'Owner not found');
            over.owner = o;
          }
        }
        applyChange(db, ch, over, me(res));
      }
    }
    audit(db, w, me(res), `item.${action}`, ch.id);
    const after = one<any>(db, 'SELECT * FROM item_changes WHERE id = ?', ch.id);
    event(res, { id: ch.id, type: 'item', status: after.status }, ch.owner);
    if (ch.by_id !== ch.owner) event(res, { id: ch.id, type: 'item', status: after.status }, ch.by_id);
    d.hub.emit(w, 'item', { id: ch.item_id }, ch.owner === 'party' ? () => true : dmAnd(ch.owner, ch.by_id));
    res.json(parse(after, isDM(res)));
  });

  return r;
}
