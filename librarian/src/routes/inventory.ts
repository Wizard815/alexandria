// Personal and party inventories. Weight only appears when the world tracks
// it. dm_note is for the DM alone (e.g. "this ring is cursed") and is never
// sent to players.
//
// Players can't change items directly: an add, edit, move or remove is a
// proposal (item_changes, status pending) until the DM approves it. A
// player-added item exists as status 'pending' and shows as "Waiting for the
// DM". The DM's changes to someone else's items apply at once but leave an
// alert the owner can confirm or dispute; the DM can revert a dispute.
//
// Giving is different: players hand each other coin and items, and move
// things in and out of the party stash, without asking (world setting
// playerTransfers). Those moves are checked (you can only give what you
// have) and logged in `transfers` for the DM, who gets a non-blocking alert.
// Players can also ask each other for coin (coin_requests), e.g. to afford a
// broker offer.
//
// Items may have a picture: an upload (stored in the database, images only,
// 2 MB) or an http(s) URL. An upload is shown only to people who can see an
// item that uses it.
import express, { Router, type Response } from 'express';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { type DB, one, all, run, tx } from '../core/db.ts';
import { requirePlayerOrDM } from '../core/auth.ts';
import { dmAnd } from '../core/events.ts';
import { HttpError, id, int, now, str } from '../core/util.ts';
import { ctx, isDM, me, memberIds, names, settings } from './_shared.ts';
import { balance, money } from '../core/coin.ts';

const ITEM_COLS = ['owner', 'name', 'qty', 'weight', 'note', 'dm_note', 'link', 'image'] as const;
export const itemSnapshot = (it: any) => Object.fromEntries(ITEM_COLS.map((k) => [k, it[k] ?? null]));

/** Apply a pending change (approve). `over` lets the DM edit it first. */
export function applyChange(db: DB, ch: any, over: Record<string, any> = {}, by: string) {
  const after = { ...JSON.parse(ch.after_json || '{}'), ...over };
  tx(db, () => {
    if (ch.kind === 'add') {
      run(db, `UPDATE items SET status = 'approved', owner = ?, name = ?, qty = ?, weight = ?, note = ?, dm_note = ?, link = ?, image = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
        after.owner, after.name, after.qty, after.weight, after.note ?? '', after.dm_note ?? '', after.link, after.image ?? null, now(), by, ch.item_id);
    } else if (ch.kind === 'edit') {
      const it = one<any>(db, 'SELECT * FROM items WHERE id = ?', ch.item_id);
      if (!it) throw new HttpError(409, 'That item no longer exists');
      const n = { ...it, ...after };
      run(db, 'UPDATE items SET owner = ?, name = ?, qty = ?, weight = ?, note = ?, dm_note = ?, link = ?, image = ?, updated_at = ?, updated_by = ? WHERE id = ?',
        n.owner, n.name, n.qty, n.weight, n.note, n.dm_note, n.link, n.image ?? null, now(), by, it.id);
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
      if (it) run(db, 'UPDATE items SET owner = ?, name = ?, qty = ?, weight = ?, note = ?, dm_note = ?, link = ?, image = ?, updated_at = ?, updated_by = ? WHERE id = ?', before.owner, before.name, before.qty, before.weight, before.note ?? '', before.dm_note ?? '', before.link, before.image ?? null, now(), by, ch.item_id);
      else run(db, `INSERT INTO items (id, world_id, owner, name, qty, weight, note, dm_note, link, image, updated_at, updated_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`, ch.item_id, ch.world_id, before.owner, before.name, before.qty, before.weight, before.note ?? '', before.dm_note ?? '', before.link, before.image ?? null, now(), by);
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
    const out: any = { owner: it.owner, name: it.name, qty: it.qty, note: it.note, link: it.link, image: it.image ?? null };
    if (s.trackWeight) out.weight = it.weight;
    return out;
  };

  function shape(res: Response, it: any) {
    const s = settings(res);
    const out: any = { id: it.id, owner: it.owner, name: it.name, qty: it.qty, note: it.note, link: it.link, image: it.image ?? null, updated_at: it.updated_at, updated_by: it.updated_by, status: it.status ?? 'approved' };
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
      const out: any = { id: it.id, owner: it.owner, name: it.name, qty: it.qty, note: it.note, link: it.link, image: it.image ?? null, status: it.status ?? 'approved' };
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

  // ---- Pictures ----

  /** An item's picture: an upload id from this world, an http(s) URL, or none. */
  function image(res: Response, raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === '') return null;
    const v = str(raw, 'image', { max: 500 });
    if (/^upl_[\w-]+$/.test(v)) {
      if (!one(db, 'SELECT 1 FROM uploads WHERE id = ? AND world_id = ?', v, ctx(res).world.id)) throw new HttpError(400, 'That picture was not uploaded to this world');
      return v;
    }
    if (/^https?:\/\/[^\s"'<>]+$/.test(v)) return v;
    throw new HttpError(400, 'image must be an uploaded picture or an http(s) link');
  }
  const sniff = (b: Buffer): string | null => {
    if (b.length > 8 && b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
    if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
  };
  const MAX_IMAGE = 2 * 1024 * 1024;
  // Raw bytes (Content-Type: image/*) or JSON {dataBase64}.
  r.post('/images', requirePlayerOrDM, express.raw({ type: 'image/*', limit: MAX_IMAGE + 1 }), (req, res) => {
    const c = ctx(res);
    let buf: Buffer;
    if (Buffer.isBuffer(req.body)) buf = req.body;
    else {
      const b64 = str(req.body?.dataBase64, 'dataBase64', { max: Math.ceil((MAX_IMAGE * 4) / 3) + 200 }).replace(/^data:[^,]*,/, '');
      buf = Buffer.from(b64, 'base64');
    }
    if (!buf.length) throw new HttpError(400, 'No picture sent');
    if (buf.length > MAX_IMAGE) throw new HttpError(413, 'Pictures can be at most 2 MB');
    const mime = sniff(buf);
    if (!mime) throw new HttpError(400, 'Send a PNG, JPEG, GIF or WebP picture');
    const uid = id('upl_');
    run(db, 'INSERT INTO uploads (id, world_id, mime, size, data, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)', uid, c.world.id, mime, buf.length, buf, me(res), now());
    audit(db, c.world.id, me(res), 'upload', `${mime} ${buf.length}`);
    res.status(201).json({ id: uid, mime, size: buf.length });
  });
  r.get('/images/:uid', (req, res) => {
    const c = ctx(res);
    const u = one<any>(db, 'SELECT * FROM uploads WHERE id = ? AND world_id = ?', String(req.params.uid), c.world.id);
    // Visible to the DM, the uploader, and anyone who can see an item that uses it.
    const ok = u && (isDM(res) || u.by_id === me(res) || one(db, `SELECT 1 FROM items WHERE world_id = ? AND image = ? AND status IN ('approved', 'pending') AND owner IN (?, 'party')`, c.world.id, u.id, me(res)));
    if (!ok) throw new HttpError(404, 'Picture not found');
    res.setHeader('Content-Type', u.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(Buffer.from(u.data));
  });

  // ---- Giving: coin and items between players and the party, no DM approval ----

  function canGive(res: Response) {
    if (!isDM(res) && !settings(res).playerTransfers) throw new HttpError(403, 'Giving coin and items is turned off in this world; ask the DM');
  }
  /** A purse or inventory a transfer may touch: 'party', 'me', or a member (players: any member as a recipient). */
  function holder(res: Response, raw: unknown, role: 'from' | 'to'): string {
    const v = String(raw ?? (role === 'from' ? 'me' : ''));
    const w = ctx(res).world.id;
    if (v === 'party') return 'party'; // the stash always exists; coin checks partyPurse
    if (v === 'me' || v === me(res)) return me(res);
    if (!memberIds(db, w).includes(v)) throw new HttpError(404, 'Player not found');
    if (role === 'from' && !isDM(res)) throw new HttpError(403, 'You can only give your own things, or take from the party');
    return v;
  }
  const logTransfer = (res: Response, t: { kind: 'coin' | 'item'; from: string; to: string; amount?: number; item?: string; qty?: number; note: string }) => {
    const c = ctx(res);
    const tid = id('trf_');
    run(db, 'INSERT INTO transfers (id, world_id, kind, from_owner, to_owner, amount_cp, item_name, qty, note, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      tid, c.world.id, t.kind, t.from, t.to, t.amount ?? null, t.item ?? null, t.qty ?? null, t.note, me(res), now());
    audit(db, c.world.id, me(res), `give.${t.kind}`, `${t.from}->${t.to} ${t.kind === 'coin' ? t.amount : `${t.item} x${t.qty}`}`);
    // A note to the DM and the people involved; nothing waits on it.
    const involved = [t.from, t.to].filter((x) => x !== 'party');
    const aud = t.from === 'party' || t.to === 'party' ? () => true : dmAnd(...involved);
    d.hub.emit(c.world.id, 'transfer', { id: tid, kind: t.kind, from: t.from, to: t.to, amount_cp: t.amount ?? null, item: t.item ?? null, qty: t.qty ?? null, by: me(res) }, aud);
    return tid;
  };
  const partyCoinOn = (res: Response, ...xs: string[]) => { if (xs.includes('party') && !settings(res).partyPurse) throw new HttpError(404, 'The party pouch is off for this world'); };

  function giveCoin(res: Response, from: string, to: string, amount: number, note: string) {
    const c = ctx(res);
    if (from === to) throw new HttpError(400, 'Pick someone else to give to');
    partyCoinOn(res, from, to);
    return tx(db, () => {
      const have = balance(db, c.world.id, from);
      if (have < amount) throw new HttpError(402, `Not enough coin: ${from === 'party' ? 'the party pouch has' : from === me(res) ? 'you have' : 'they have'} ${money(Math.max(0, have))}`);
      const tid = logTransfer(res, { kind: 'coin', from, to, amount, note });
      const nm = names(db, c.world.id);
      const label = (x: string) => (x === 'party' ? 'the party pouch' : nm[x] ?? 'someone');
      run(db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status, transfer_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?)`, id('led_'), c.world.id, from, -amount, `To ${label(to)}${note ? `: ${note}` : ''}`.slice(0, 200), me(res), now(), tid);
      run(db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status, transfer_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?)`, id('led_'), c.world.id, to, amount, `From ${label(from)}${note ? `: ${note}` : ''}`.slice(0, 200), me(res), now(), tid);
      return tid;
    });
  }
  const coinEvents = (res: Response, ...owners: string[]) => {
    const w = ctx(res).world.id;
    for (const o of owners) d.hub.emit(w, 'coin', { owner: o, balance: balance(db, w, o) }, o === 'party' ? () => true : dmAnd(o));
  };

  r.post('/coin/transfer', requirePlayerOrDM, (req, res) => {
    canGive(res);
    const b = req.body ?? {};
    const from = holder(res, b.from ?? 'me', 'from');
    const to = holder(res, b.to, 'to');
    const amount = int(b.amountCp, 'amountCp', { min: 1, max: 100_000_000 })!;
    const tid = giveCoin(res, from, to, amount, str(b.note, 'note', { max: 160, optional: true }));
    coinEvents(res, from, to);
    const w = ctx(res).world.id;
    res.status(201).json({ id: tid, from, to, amount_cp: amount, balance: balance(db, w, from === 'party' && !isDM(res) ? me(res) : from) });
  });

  r.post('/:iid/move', requirePlayerOrDM, (req, res) => {
    canGive(res);
    const c = ctx(res);
    const it = one<any>(db, `SELECT * FROM items WHERE id = ? AND world_id = ? AND status = 'approved'`, String(req.params.iid), c.world.id);
    if (!it) throw new HttpError(404, 'Item not found');
    if (!isDM(res) && it.owner !== me(res) && it.owner !== 'party') throw new HttpError(403, 'You can only give your own items, or take from the party stash');
    if (one(db, `SELECT 1 FROM item_changes WHERE item_id = ? AND status = 'pending'`, it.id)) throw new HttpError(409, 'This item has a change waiting for the DM');
    const b = req.body ?? {};
    const to = holder(res, b.to, 'to');
    if (to === it.owner) throw new HttpError(400, 'It is already there');
    const qty = int(b.qty, 'qty', { min: 1, max: 1_000_000, optional: true }) ?? it.qty;
    if (qty > it.qty) throw new HttpError(400, `There are only ${it.qty}`);
    const reason = isDM(res) && it.owner !== 'party' ? dmReason(res, b, it.owner) : '';
    // Same thing already there? Stack it.
    const same = one<any>(db, `SELECT * FROM items WHERE world_id = ? AND owner = ? AND status = 'approved' AND lower(name) = lower(?) AND IFNULL(link, '') = IFNULL(?, '') AND IFNULL(image, '') = IFNULL(?, '') AND dm_note = ? AND IFNULL(weight, -1) = IFNULL(?, -1) AND id <> ?`,
      c.world.id, to, it.name, it.link, it.image, it.dm_note, it.weight, it.id);
    let movedId = it.id;
    tx(db, () => {
      if (qty === it.qty && !same) run(db, 'UPDATE items SET owner = ?, updated_at = ?, updated_by = ? WHERE id = ?', to, now(), me(res), it.id);
      else {
        if (qty === it.qty) run(db, 'DELETE FROM items WHERE id = ?', it.id);
        else run(db, 'UPDATE items SET qty = qty - ?, updated_at = ?, updated_by = ? WHERE id = ?', qty, now(), me(res), it.id);
        if (same) { run(db, 'UPDATE items SET qty = qty + ?, updated_at = ?, updated_by = ? WHERE id = ?', qty, now(), me(res), same.id); movedId = same.id; }
        else {
          movedId = id('itm_');
          run(db, `INSERT INTO items (id, world_id, owner, name, qty, weight, note, dm_note, link, image, updated_at, updated_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`,
            movedId, c.world.id, to, it.name, qty, it.weight, it.note, it.dm_note, it.link, it.image, now(), me(res));
        }
      }
      logTransfer(res, { kind: 'item', from: it.owner, to, item: it.name, qty, note: reason || str(b.note, 'note', { max: 160, optional: true }) });
      if (isDM(res) && reason && qty === it.qty && !same) dmAlert(res, 'edit', it.id, it.owner, itemSnapshot(it), itemSnapshot({ ...it, owner: to }), reason);
    });
    const left = one<any>(db, 'SELECT * FROM items WHERE id = ?', it.id);
    if (left && left.owner === it.owner) notify(res, left, 'item');
    else d.hub.emit(c.world.id, 'item-moved', { id: it.id, from: it.owner }, it.owner === 'party' ? () => true : dmAnd(it.owner));
    const moved = one<any>(db, 'SELECT * FROM items WHERE id = ?', movedId);
    notify(res, moved, 'item');
    res.json({ moved: shape(res, moved), left: left && left.owner === it.owner ? shape(res, left) : null });
  });

  r.get('/transfers', (req, res) => {
    const c = ctx(res);
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const rows = isDM(res)
      ? all<any>(db, 'SELECT * FROM transfers WHERE world_id = ? ORDER BY at DESC LIMIT ?', c.world.id, limit)
      : all<any>(db, `SELECT * FROM transfers WHERE world_id = ? AND (from_owner IN (?, 'party') OR to_owner IN (?, 'party')) ORDER BY at DESC LIMIT ?`, c.world.id, me(res), me(res), limit);
    res.json({ transfers: rows.map((t) => ({ ...t, seen: !!t.seen })), unseen: isDM(res) ? one<any>(db, 'SELECT COUNT(*) AS n FROM transfers WHERE world_id = ? AND seen = 0', c.world.id)!.n : undefined });
  });
  r.post('/transfers/seen', (req, res) => {
    if (!isDM(res)) throw new HttpError(403, 'DM only');
    run(db, 'UPDATE transfers SET seen = 1 WHERE world_id = ?', ctx(res).world.id);
    res.json({ ok: true });
  });

  // ---- Asking for coin ----

  const reqOut = (x: any) => ({ id: x.id, from: x.from_id, to: x.to_id, amount_cp: x.amount_cp, given_cp: x.given_cp, note: x.note, offer_id: x.offer_id, status: x.status, at: x.at });
  const reqAudience = (x: any, w: string) => dmAnd(x.from_id, ...(x.to_id === 'party' ? memberIds(db, w, ['player']) : [x.to_id]));
  r.get('/coin-requests', (_req, res) => {
    const c = ctx(res);
    const rows = all<any>(db, `SELECT * FROM coin_requests WHERE world_id = ? AND (status = 'open' OR at > ?) ORDER BY at DESC LIMIT 200`, c.world.id, new Date(Date.now() - 7 * 86400_000).toISOString());
    if (isDM(res)) return res.json(rows.map(reqOut));
    const mineOut = rows.filter((x) => x.from_id === me(res));
    const incoming = rows.filter((x) => x.from_id !== me(res) && (x.to_id === me(res) || x.to_id === 'party') && !JSON.parse(x.declined_by).includes(me(res)));
    res.json({ outgoing: mineOut.map(reqOut), incoming: incoming.map(reqOut) });
  });
  r.post('/coin-requests', requirePlayerOrDM, (req, res) => {
    canGive(res);
    const c = ctx(res);
    if (isDM(res)) throw new HttpError(403, 'Players ask each other for coin');
    const b = req.body ?? {};
    const to = String(b.to ?? 'party');
    if (to !== 'party' && (to === me(res) || !memberIds(db, c.world.id, ['player']).includes(to))) throw new HttpError(400, 'Ask the party or another player');
    let offer: string | null = null;
    if (b.offerId) {
      offer = str(b.offerId, 'offerId', { max: 40 });
      if (!one(db, `SELECT 1 FROM broker_offers WHERE id = ? AND world_id = ? AND status = 'open'`, offer, c.world.id)) throw new HttpError(404, 'Offer not found');
    }
    const x = { id: id('crq_'), from_id: me(res), to_id: to, amount_cp: int(b.amountCp, 'amountCp', { min: 1, max: 100_000_000 })!, note: str(b.note, 'note', { max: 200, optional: true }) };
    run(db, `INSERT INTO coin_requests (id, world_id, from_id, to_id, amount_cp, note, offer_id, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`, x.id, c.world.id, x.from_id, x.to_id, x.amount_cp, x.note, offer, now());
    const row = one<any>(db, 'SELECT * FROM coin_requests WHERE id = ?', x.id);
    d.hub.emit(c.world.id, 'coin-request', reqOut(row), reqAudience(row, c.world.id));
    res.status(201).json(reqOut(row));
  });
  const reqFind = (res: Response, rid: string) => {
    const x = one<any>(db, 'SELECT * FROM coin_requests WHERE id = ? AND world_id = ?', rid, ctx(res).world.id);
    if (!x || (!isDM(res) && x.from_id !== me(res) && x.to_id !== me(res) && x.to_id !== 'party')) throw new HttpError(404, 'Request not found');
    return x;
  };
  r.post('/coin-requests/:rid/give', requirePlayerOrDM, (req, res) => {
    canGive(res);
    const c = ctx(res);
    const x = reqFind(res, String(req.params.rid));
    if (x.status !== 'open') throw new HttpError(409, 'This request is closed');
    if (x.from_id === me(res) || isDM(res)) throw new HttpError(400, 'Someone else has to give');
    const left = x.amount_cp - x.given_cp;
    const amount = int(req.body?.amountCp, 'amountCp', { min: 1, max: left, optional: true }) ?? left;
    giveCoin(res, me(res), x.from_id, amount, x.note || 'Asked for coin');
    run(db, `UPDATE coin_requests SET given_cp = given_cp + ?, status = CASE WHEN given_cp + ? >= amount_cp THEN 'done' ELSE status END WHERE id = ?`, amount, amount, x.id);
    coinEvents(res, me(res), x.from_id);
    const row = one<any>(db, 'SELECT * FROM coin_requests WHERE id = ?', x.id);
    d.hub.emit(c.world.id, 'coin-request', reqOut(row), reqAudience(row, c.world.id));
    res.json(reqOut(row));
  });
  r.post('/coin-requests/:rid/decline', requirePlayerOrDM, (req, res) => {
    const c = ctx(res);
    const x = reqFind(res, String(req.params.rid));
    if (x.status !== 'open' || x.from_id === me(res)) throw new HttpError(409, 'Nothing to decline');
    const declined = [...new Set([...JSON.parse(x.declined_by), me(res)])];
    const done = x.to_id !== 'party' || memberIds(db, c.world.id, ['player']).filter((a) => a !== x.from_id).every((a) => declined.includes(a));
    run(db, 'UPDATE coin_requests SET declined_by = ?, status = ? WHERE id = ?', JSON.stringify(declined), done ? 'declined' : 'open', x.id);
    const row = one<any>(db, 'SELECT * FROM coin_requests WHERE id = ?', x.id);
    d.hub.emit(c.world.id, 'coin-request', reqOut(row), reqAudience(row, c.world.id));
    res.json(reqOut(row));
  });
  r.post('/coin-requests/:rid/cancel', requirePlayerOrDM, (req, res) => {
    const c = ctx(res);
    const x = reqFind(res, String(req.params.rid));
    if (x.from_id !== me(res) || x.status !== 'open') throw new HttpError(409, 'Nothing to cancel');
    run(db, `UPDATE coin_requests SET status = 'cancelled' WHERE id = ?`, x.id);
    d.hub.emit(c.world.id, 'coin-request', { ...reqOut(x), status: 'cancelled' }, reqAudience(x, c.world.id));
    res.json({ ok: true });
  });

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
      link: str(b.link, 'link', { max: 300, optional: true }) || null, image: image(res, b.image), updated_at: now(), updated_by: me(res), status: pending ? 'pending' : 'approved',
    };
    tx(db, () => {
      run(db, 'INSERT INTO items (id, world_id, owner, name, qty, weight, note, dm_note, link, image, updated_at, updated_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        it.id, c.world.id, it.owner, it.name, it.qty, it.weight, it.note, it.dm_note, it.link, it.image, it.updated_at, it.updated_by, it.status);
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
      image: b.image !== undefined ? image(res, b.image) : it.image ?? null,
      owner: b.owner !== undefined ? owner(res, String(b.owner), true) : it.owner,
      updated_at: now(), updated_by: me(res),
    };
    if (needsApproval(res)) {
      if (it.status === 'pending') {
        // Still only a proposal: the proposer may adjust it.
        const ch = one<any>(db, `SELECT * FROM item_changes WHERE item_id = ? AND kind = 'add' AND status = 'pending'`, it.id);
        if (!ch || ch.by_id !== me(res)) throw new HttpError(409, 'This item is waiting for the DM');
        tx(db, () => {
          run(db, 'UPDATE items SET owner = ?, name = ?, qty = ?, weight = ?, note = ?, link = ?, image = ?, updated_at = ? WHERE id = ?', next.owner, next.name, next.qty, next.weight, next.note, next.link, next.image, now(), it.id);
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
      run(db, 'UPDATE items SET owner = ?, name = ?, qty = ?, weight = ?, note = ?, dm_note = ?, link = ?, image = ?, updated_at = ?, updated_by = ? WHERE id = ?',
        next.owner, next.name, next.qty, next.weight, next.note, next.dm_note, next.link, next.image, next.updated_at, next.updated_by, it.id);
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
