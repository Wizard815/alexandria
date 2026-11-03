// Personal and party inventories. Weight only appears when the world tracks
// it. dm_note is for the DM alone (e.g. "this ring is cursed") and is never
// sent to players.
import { Router, type Response } from 'express';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { one, all, run } from '../core/db.ts';
import { requirePlayerOrDM } from '../core/auth.ts';
import { dmAnd } from '../core/events.ts';
import { HttpError, id, int, now, str } from '../core/util.ts';
import { ctx, isDM, me, memberIds, settings } from './_shared.ts';

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

  function shape(res: Response, it: any) {
    const s = settings(res);
    const out: any = { id: it.id, owner: it.owner, name: it.name, qty: it.qty, note: it.note, link: it.link, updated_at: it.updated_at, updated_by: it.updated_by };
    if (s.trackWeight) out.weight = it.weight;
    if (isDM(res)) out.dm_note = it.dm_note;
    return out;
  }

  const notify = (res: Response, it: any, type: string) => {
    const c = ctx(res);
    const s = settings(res);
    d.hub.emitPer(c.world.id, type, (v) => {
      if (it.owner !== 'party' && v.role !== 'dm' && v.accountId !== it.owner) return null;
      const out: any = { id: it.id, owner: it.owner, name: it.name, qty: it.qty, note: it.note, link: it.link };
      if (s.trackWeight) out.weight = it.weight;
      if (v.role === 'dm') out.dm_note = it.dm_note;
      return out;
    });
  };

  r.get('/', (req, res) => {
    const c = ctx(res);
    const o = owner(res, String(req.query.owner ?? 'me'), false);
    const items = all(db, 'SELECT * FROM items WHERE world_id = ? AND owner = ? ORDER BY name', c.world.id, o).map((it) => shape(res, it));
    const s = settings(res);
    const out: any = { owner: o, items, trackWeight: s.trackWeight, coins: s.coins };
    if (s.trackWeight) out.totalWeight = items.reduce((n: number, it: any) => n + (it.weight ?? 0) * it.qty, 0);
    res.json(out);
  });

  r.post('/', requirePlayerOrDM, (req, res) => {
    const c = ctx(res);
    const b = req.body ?? {};
    const o = owner(res, String(b.owner ?? 'me'), true);
    const it = {
      id: id('itm_'), owner: o, name: str(b.name, 'name', { max: 120 }), qty: int(b.qty, 'qty', { min: 0, max: 1_000_000, optional: true }) ?? 1,
      weight: b.weight !== undefined && b.weight !== null ? Number(b.weight) || 0 : null,
      note: str(b.note, 'note', { max: 500, optional: true }), dm_note: isDM(res) ? str(b.dmNote, 'dmNote', { max: 500, optional: true }) : '',
      link: str(b.link, 'link', { max: 300, optional: true }) || null, updated_at: now(), updated_by: me(res),
    };
    run(db, 'INSERT INTO items (id, world_id, owner, name, qty, weight, note, dm_note, link, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      it.id, c.world.id, it.owner, it.name, it.qty, it.weight, it.note, it.dm_note, it.link, it.updated_at, it.updated_by);
    audit(db, c.world.id, me(res), 'item.add', `${o} ${it.name} x${it.qty}`);
    notify(res, it, 'item');
    res.status(201).json(shape(res, it));
  });

  r.patch('/:iid', requirePlayerOrDM, (req, res) => {
    const c = ctx(res);
    const it = one<any>(db, 'SELECT * FROM items WHERE id = ? AND world_id = ?', String(req.params.iid), c.world.id);
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
    run(db, 'UPDATE items SET owner = ?, name = ?, qty = ?, weight = ?, note = ?, dm_note = ?, link = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      next.owner, next.name, next.qty, next.weight, next.note, next.dm_note, next.link, next.updated_at, next.updated_by, it.id);
    audit(db, c.world.id, me(res), 'item.update', `${it.owner}->${next.owner} ${next.name} x${next.qty}`);
    notify(res, next, 'item');
    if (next.owner !== it.owner) d.hub.emit(c.world.id, 'item-moved', { id: it.id, from: it.owner }, it.owner === 'party' ? () => true : dmAnd(it.owner));
    res.json(shape(res, next));
  });

  r.delete('/:iid', requirePlayerOrDM, (req, res) => {
    const c = ctx(res);
    const it = one<any>(db, 'SELECT * FROM items WHERE id = ? AND world_id = ?', String(req.params.iid), c.world.id);
    if (!it) throw new HttpError(404, 'Item not found');
    owner(res, it.owner, true);
    run(db, 'DELETE FROM items WHERE id = ?', it.id);
    audit(db, c.world.id, me(res), 'item.remove', `${it.owner} ${it.name}`);
    d.hub.emit(c.world.id, 'item-removed', { id: it.id }, it.owner === 'party' ? () => true : dmAnd(it.owner));
    res.json({ ok: true });
  });

  return r;
}
