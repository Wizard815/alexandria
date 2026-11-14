// The live session board ("the stage"): what the DM puts in front of the
// table. Cards (an image, the combat tracker, a person, a shop, a place, an
// event, text, the drawing board) wait in the DM's staging area until shown,
// to everyone or to chosen players. Players only ever receive the cards shown
// to them, built from player copies at the moment they are read.
//
// Live event `stage`: the whole board as that viewer may see it
// ({ version, layout, spotlightId, cards }), sent per viewer on every change.
// The combat card follows the `combat` event (the app refetches on it).
import express, { Router, type Response } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { one, all, run, tx } from '../../core/db.ts';
import { requireDM, requirePlayerOrDM } from '../../core/auth.ts';
import { dmAnd } from '../../core/events.ts';
import { balance, money } from '../../core/coin.ts';
import type { Viewer } from '../../core/policy.ts';
import { HttpError, id as newId, int, now, oneOf, parseJson, str } from '../../core/util.ts';
import { ctx, isDM, me, memberIds, settings } from '../../routes/_shared.ts';
import { readTicket } from '../sound/ticket.ts';
import { KINDS, PLAYER, canHave, dataFor, project, stockOf, worldSettings, type CardRow, type Kind } from './cards.ts';

const schema = `
CREATE TABLE IF NOT EXISTS stage_cards (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref TEXT,
  label TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0, w REAL NOT NULL DEFAULT 1, h REAL NOT NULL DEFAULT 1,
  z INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'dm' CHECK (visibility IN ('all', 'players', 'dm')),
  audience TEXT NOT NULL DEFAULT '[]',
  options TEXT NOT NULL DEFAULT '{}',
  shown_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stage_cards_world ON stage_cards (world_id);
CREATE TABLE IF NOT EXISTS stage_state (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  layout TEXT NOT NULL DEFAULT 'grid',
  spotlight_id TEXT,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stage_images (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL,
  by_id TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  at TEXT NOT NULL, by_id TEXT NOT NULL,
  action TEXT NOT NULL, card_id TEXT, kind TEXT, label TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS stage_history_world ON stage_history (world_id, id);
`;

const LAYOUTS = ['spotlight', 'grid', 'free'] as const;
const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_IMAGES = 200;
const MAX_CARDS = 120;

const sniff = (b: Buffer): string | null => {
  if (b.length > 8 && b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
};

const num = (v: unknown, field: string, min: number, max: number, dflt: number) => {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${field} must be from ${min} to ${max}`);
  return n;
};

/** Who may fetch an uploaded picture: the DM, or a player/guest when a card shown to them uses it. */
function mayFetchImage(d: Deps, worldId: string, imageId: string, accountId: string, role: string): boolean {
  if (role === 'dm') return true;
  const v: Viewer = { accountId, role: role as Viewer['role'] };
  return all<CardRow>(d.db, `SELECT * FROM stage_cards WHERE world_id = ? AND ref = ? AND kind IN ('image', 'event') AND visibility <> 'dm'`, worldId, imageId).some((c) => canHave(c, v));
}

function sendImage(res: Response, u: any) {
  res.setHeader('Content-Type', u.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(Buffer.from(u.data));
}

const feature: Feature = {
  id: 'stage',
  schema,
  dataDirs: [],
  worldMount: 'stage',
  appRoutes: (app, d) => {
    // <img> cannot send the sign-in header: a signed ticket names one picture and one account,
    // and the permission is checked again on every request (hiding the card takes the picture away).
    app.get('/api/media/stage/:ticket', (req, res) => {
      const t = readTicket(String(req.params.ticket));
      const m = t && t.k === 'stage' && one<{ role: string }>(d.db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', t.w, t.a);
      const u = t && m && one<any>(d.db, 'SELECT * FROM stage_images WHERE id = ? AND world_id = ?', t.f, t.w);
      if (!t || !m || !u || !mayFetchImage(d, t.w, t.f, t.a, m.role)) throw new HttpError(404, 'Picture not found');
      sendImage(res, u);
    });
  },
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    const { db } = d;
    const W = (res: Response) => ctx(res).world.id;
    const audit = (worldId: string, by: string, action: string, detail: string) =>
      run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, by, action, detail.slice(0, 500), now());
    const state = (wid: string) => one<any>(db, 'SELECT * FROM stage_state WHERE world_id = ?', wid) ?? { layout: 'grid', spotlight_id: null, version: 0 };
    const cards = (wid: string) => all<CardRow>(db, 'SELECT * FROM stage_cards WHERE world_id = ? ORDER BY z, created_at', wid);
    const card = (wid: string, cid: string) => {
      const c = one<CardRow>(db, 'SELECT * FROM stage_cards WHERE id = ? AND world_id = ?', cid, wid);
      if (!c) throw new HttpError(404, 'Card not found');
      return c;
    };
    const touch = (wid: string, patch: { layout?: string; spotlight?: string | null } = {}) => {
      const s = state(wid);
      run(db, `INSERT INTO stage_state (world_id, layout, spotlight_id, version) VALUES (?, ?, ?, ?)
        ON CONFLICT (world_id) DO UPDATE SET layout = excluded.layout, spotlight_id = excluded.spotlight_id, version = excluded.version`,
        wid, patch.layout ?? s.layout, patch.spotlight === undefined ? s.spotlight_id : patch.spotlight, s.version + 1);
    };
    const log = (wid: string, by: string, action: string, c: CardRow | null, detail = '') =>
      run(db, 'INSERT INTO stage_history (world_id, at, by_id, action, card_id, kind, label, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', wid, now(), by, action, c?.id ?? null, c?.kind ?? null, (c?.label || c?.caption || '').slice(0, 120), detail.slice(0, 300));

    /** The whole board as one viewer may see it. */
    function view(wid: string, v: Viewer) {
      const st = state(wid);
      const s = worldSettings(db, wid);
      const list = cards(wid).map((c) => project(d, c, v, s)).filter(Boolean) as any[];
      const spot = list.some((c) => c.id === st.spotlight_id) ? st.spotlight_id : null;
      return { version: st.version, layout: st.layout, spotlightId: spot, cards: v.role === 'dm' ? list : list.filter((c) => c.shownAt) };
    }
    const broadcast = (wid: string) => d.hub.emitPer(wid, 'stage', (v) => view(wid, v));

    // ---- reading ----
    r.get('/', (_req, res) => {
      const c = ctx(res);
      res.json(view(c.world.id, c.viewer));
    });
    r.get('/history', requireDM, (req, res) => {
      const since = Number(req.query.since) || 0;
      res.json(all(db, 'SELECT id, at, by_id AS byId, action, card_id AS cardId, kind, label, detail FROM stage_history WHERE world_id = ? AND id > ? ORDER BY id DESC LIMIT 500', W(res), since));
    });

    // ---- pickers (DM) ----
    r.get('/pickers', requireDM, (req, res) => {
      const w = W(res);
      const q = String(req.query.q ?? '').trim().toLowerCase().slice(0, 100);
      const pages = (d.library.list(w, ctx(res).viewer) as any[])
        .filter((p) => !q || p.title.toLowerCase().includes(q) || String(p.path).toLowerCase().includes(q))
        .slice(0, 30).map((p) => ({ id: p.id, title: p.title, kind: p.kind, path: p.path, visibility: p.visibility }));
      const people = all<any>(db, 'SELECT id, name, role, visibility FROM people WHERE world_id = ? ORDER BY name', w).filter((p) => !q || p.name.toLowerCase().includes(q));
      res.json({ pages, people, players: memberIds(db, w, ['player']).map((a) => ({ id: a, name: one<any>(db, 'SELECT COALESCE(NULLIF(m.character_name, \'\'), a.display_name) AS n FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.account_id = ?', w, a)?.n ?? a })) });
    });

    // ---- pictures ----
    r.post('/images', requireDM, express.raw({ type: 'image/*', limit: MAX_IMAGE + 1 }), (req, res) => {
      const w = W(res);
      let buf: Buffer;
      if (Buffer.isBuffer(req.body)) buf = req.body;
      else {
        const b64 = str(req.body?.dataBase64, 'dataBase64', { max: Math.ceil((MAX_IMAGE * 4) / 3) + 200 }).replace(/^data:[^,]*,/, '');
        buf = Buffer.from(b64, 'base64');
      }
      if (!buf.length) throw new HttpError(400, 'No picture sent');
      if (buf.length > MAX_IMAGE) throw new HttpError(413, 'Pictures can be at most 4 MB');
      const mime = sniff(buf);
      if (!mime) throw new HttpError(400, 'Send a PNG, JPEG, GIF or WebP picture');
      if (one<any>(db, 'SELECT COUNT(*) AS n FROM stage_images WHERE world_id = ?', w)!.n >= MAX_IMAGES) throw new HttpError(409, 'This world has too many stage pictures; delete some cards first');
      const uid = newId('stg_');
      run(db, 'INSERT INTO stage_images (id, world_id, mime, size, data, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)', uid, w, mime, buf.length, buf, me(res), now());
      audit(w, me(res), 'stage.upload', `${mime} ${buf.length}`);
      res.status(201).json({ id: uid, mime, size: buf.length });
    });
    r.get('/images/:uid', (req, res) => {
      const c = ctx(res);
      const u = one<any>(db, 'SELECT * FROM stage_images WHERE id = ? AND world_id = ?', String(req.params.uid), c.world.id);
      if (!u || !mayFetchImage(d, c.world.id, u.id, me(res), c.viewer.role)) throw new HttpError(404, 'Picture not found');
      sendImage(res, u);
    });

    // ---- cards (DM) ----
    const refFor = (w: string, kind: Kind, raw: unknown): string | null => {
      const v = raw === undefined || raw === null || raw === '' ? '' : str(raw, 'ref', { max: 500 });
      switch (kind) {
        case 'image':
        case 'event': {
          if (!v) { if (kind === 'image') throw new HttpError(400, 'ref is required: an uploaded picture id or an https link'); return null; }
          if (/^stg_[\w-]+$/.test(v)) {
            if (!one(db, 'SELECT 1 FROM stage_images WHERE id = ? AND world_id = ?', v, w)) throw new HttpError(400, 'That picture was not uploaded to this world');
            return v;
          }
          if (/^https:\/\/[^\s"'<>@]+$/.test(v)) return v;
          throw new HttpError(400, 'The picture must be an uploaded stage picture or an https link');
        }
        case 'person':
          if (!one(db, 'SELECT 1 FROM people WHERE id = ? AND world_id = ?', v, w)) throw new HttpError(400, 'Person not found');
          return v;
        case 'shop':
        case 'place': {
          const p = one<any>(db, 'SELECT id FROM pages WHERE world_id = ? AND (id = ? OR path = ?)', w, v, v);
          if (!p) throw new HttpError(400, 'Page not found');
          return p.id;
        }
        default: return null;
      }
    };
    const optionsFrom = (b: any, cur: Record<string, any> = {}) => {
      const o = { ...cur };
      if (b.buy !== undefined) o.buy = !!b.buy;
      if (b.countdownSec !== undefined) {
        const n = b.countdownSec === null ? null : int(b.countdownSec, 'countdownSec', { min: 1, max: 86_400 });
        if (n === null) { delete o.countdownSec; delete o.endsAt; } else o.countdownSec = n;
      }
      return o;
    };
    const audienceFrom = (w: string, raw: unknown): string[] => {
      if (!Array.isArray(raw) || !raw.length || raw.length > 40 || raw.some((x) => typeof x !== 'string')) throw new HttpError(400, 'to must be "all" or a list of players');
      const ok = memberIds(db, w, ['player']);
      for (const a of raw as string[]) if (!ok.includes(a)) throw new HttpError(400, 'Player not found');
      return [...new Set(raw as string[])];
    };

    /** Put a card in front of everyone or chosen players. Re-checks, now, that players may be shown it. */
    function show(res: Response, c: CardRow, to: unknown, spotlight: boolean) {
      const w = c.world_id;
      const vis = to === undefined || to === null || to === 'all' ? 'all' : 'players';
      const aud = vis === 'all' ? [] : audienceFrom(w, to);
      const s = worldSettings(db, w);
      const probe: CardRow = { ...c, visibility: vis, audience: JSON.stringify(aud), shown_at: now() };
      for (const v of vis === 'all' ? [PLAYER] : aud.map((a) => ({ accountId: a, role: 'player' as const }))) {
        if (dataFor(d, probe, v, s) === null) {
          throw new HttpError(409, c.kind === 'person' ? 'That person is not shared with the party yet (set them to party in People first).' : 'Players cannot open that page. Share it with the party first.');
        }
      }
      const o = parseJson<Record<string, any>>(c.options, {});
      if (o.countdownSec) o.endsAt = new Date(Date.now() + o.countdownSec * 1000).toISOString();
      run(db, 'UPDATE stage_cards SET visibility = ?, audience = ?, shown_at = ?, options = ?, z = ? WHERE id = ?', vis, JSON.stringify(aud), probe.shown_at, JSON.stringify(o), nextZ(w), c.id);
      log(w, me(res), 'show', c, vis === 'all' ? 'everyone' : `${aud.length} player(s)`);
      audit(w, me(res), 'stage.show', `${c.kind} ${c.label || c.ref || ''}`);
      touch(w, spotlight ? { layout: 'spotlight', spotlight: c.id } : {});
    }
    const nextZ = (w: string) => one<any>(db, 'SELECT COALESCE(MAX(z), 0) + 1 AS z FROM stage_cards WHERE world_id = ?', w)!.z as number;

    const body = (b: any, kind: Kind) => {
      const label = str(b.title ?? b.label, 'title', { max: 160, optional: true });
      const text = str(b.text, 'text', { max: 20_000, optional: true });
      if (kind === 'event' && !label.trim()) throw new HttpError(400, 'An event needs a title');
      if (kind === 'text' && !text.trim()) throw new HttpError(400, 'A text card needs text');
      return { label, text, caption: str(b.caption, 'caption', { max: 300, optional: true }) };
    };

    r.post('/cards', requireDM, (req, res) => {
      const w = W(res);
      const b = req.body ?? {};
      const kind = oneOf(b.kind, 'kind', KINDS);
      if (one<any>(db, 'SELECT COUNT(*) AS n FROM stage_cards WHERE world_id = ?', w)!.n >= MAX_CARDS) throw new HttpError(409, 'The stage has too many cards; delete some first');
      const ref = refFor(w, kind, b.ref);
      const f = body(b, kind);
      const cid = newId('stc_');
      const n = one<any>(db, 'SELECT COUNT(*) AS n FROM stage_cards WHERE world_id = ?', w)!.n;
      tx(db, () => {
        run(db, `INSERT INTO stage_cards (id, world_id, kind, ref, label, text, caption, x, y, w, h, z, visibility, audience, options, created_at, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dm', '[]', ?, ?, ?)`, cid, w, kind, ref, f.label, f.text, f.caption,
          num(b.x, 'x', 0, 100, (n % 3) * 33), num(b.y, 'y', 0, 100, Math.floor(n / 3) * 30), num(b.w, 'w', 1, 100, 1), num(b.h, 'h', 1, 100, 1), nextZ(w), JSON.stringify(optionsFrom(b)), now(), me(res));
        const c = card(w, cid);
        log(w, me(res), 'add', c);
        if (b.show === true || b.show === 'all' || Array.isArray(b.to)) show(res, c, Array.isArray(b.to) ? b.to : 'all', b.spotlight === true);
        else touch(w);
      });
      broadcast(w);
      res.status(201).json(project(d, card(w, cid), ctx(res).viewer, worldSettings(db, w)));
    });

    r.patch('/cards/:cid', requireDM, (req, res) => {
      const w = W(res);
      const c = card(w, String(req.params.cid));
      const b = req.body ?? {};
      const f = body({ title: b.title ?? b.label ?? c.label, text: b.text ?? c.text, caption: b.caption ?? c.caption }, c.kind);
      const o = optionsFrom(b, parseJson<Record<string, any>>(c.options, {}));
      if (c.shown_at && o.countdownSec && b.countdownSec !== undefined) o.endsAt = new Date(Date.now() + o.countdownSec * 1000).toISOString();
      run(db, 'UPDATE stage_cards SET label = ?, text = ?, caption = ?, x = ?, y = ?, w = ?, h = ?, z = ?, options = ? WHERE id = ?', f.label, f.text, f.caption,
        num(b.x, 'x', 0, 100, c.x), num(b.y, 'y', 0, 100, c.y), num(b.w, 'w', 1, 100, c.w), num(b.h, 'h', 1, 100, c.h),
        b.raise === true ? nextZ(w) : b.z !== undefined ? int(b.z, 'z', { min: -1000, max: 100000 })! : c.z, JSON.stringify(o), c.id);
      log(w, me(res), 'update', c);
      touch(w);
      broadcast(w);
      res.json(project(d, card(w, c.id), ctx(res).viewer, worldSettings(db, w)));
    });

    r.delete('/cards/:cid', requireDM, (req, res) => {
      const w = W(res);
      const c = card(w, String(req.params.cid));
      run(db, 'DELETE FROM stage_cards WHERE id = ?', c.id);
      // An uploaded picture nothing uses any more goes away with it.
      if (c.ref?.startsWith('stg_') && !one(db, 'SELECT 1 FROM stage_cards WHERE world_id = ? AND ref = ?', w, c.ref)) run(db, 'DELETE FROM stage_images WHERE id = ? AND world_id = ?', c.ref, w);
      log(w, me(res), 'delete', c);
      touch(w, state(w).spotlight_id === c.id ? { spotlight: null } : {});
      broadcast(w);
      res.json({ ok: true });
    });

    r.post('/cards/:cid/show', requireDM, (req, res) => {
      const w = W(res);
      const c = card(w, String(req.params.cid));
      tx(db, () => show(res, c, req.body?.to, req.body?.spotlight === true));
      broadcast(w);
      res.json(project(d, card(w, c.id), ctx(res).viewer, worldSettings(db, w)));
    });
    r.post('/cards/:cid/hide', requireDM, (req, res) => {
      const w = W(res);
      const c = card(w, String(req.params.cid));
      const o = parseJson<Record<string, any>>(c.options, {});
      delete o.endsAt;
      run(db, `UPDATE stage_cards SET visibility = 'dm', audience = '[]', shown_at = NULL, options = ? WHERE id = ?`, JSON.stringify(o), c.id);
      log(w, me(res), 'hide', c);
      audit(w, me(res), 'stage.hide', `${c.kind} ${c.label || c.ref || ''}`);
      touch(w);
      broadcast(w);
      res.json(project(d, card(w, c.id), ctx(res).viewer, worldSettings(db, w)));
    });

    r.put('/layout', requireDM, (req, res) => {
      const w = W(res);
      const b = req.body ?? {};
      const layout = b.layout === undefined ? state(w).layout : oneOf(b.layout, 'layout', LAYOUTS);
      let spot: string | null | undefined;
      if (b.spotlightId !== undefined) {
        spot = b.spotlightId === null ? null : card(w, str(b.spotlightId, 'spotlightId', { max: 60 })).id;
      }
      touch(w, { layout, spotlight: spot });
      run(db, 'INSERT INTO stage_history (world_id, at, by_id, action, kind, label, detail) VALUES (?, ?, ?, ?, ?, ?, ?)', w, now(), me(res), 'layout', null, '', layout);
      broadcast(w);
      res.json(view(w, ctx(res).viewer));
    });

    // ---- buying from a shop card ----
    // The price comes from the shop page's player copy, never from the request. Coin and item go
    // through the same approval rules as anything else a player does (World settings: playerChangesNeedApproval).
    r.post('/cards/:cid/buy', requirePlayerOrDM, (req, res) => {
      const c0 = ctx(res);
      const w = c0.world.id;
      if (isDM(res)) throw new HttpError(403, 'Players buy from a shop; the DM edits coin and items directly');
      const c = card(w, String(req.params.cid));
      if (c.kind !== 'shop' || !canHave(c, c0.viewer) || !c.shown_at) throw new HttpError(404, 'Card not found');
      const data: any = dataFor(d, c, c0.viewer, worldSettings(db, w));
      if (!data) throw new HttpError(404, 'Card not found');
      if (!data.canBuy) throw new HttpError(403, 'Buying is off for this shop');
      const b = req.body ?? {};
      const items = data.items as ReturnType<typeof stockOf>;
      const want = typeof b.index === 'number' ? items[b.index] : items.find((i) => i.name.toLowerCase() === String(b.item ?? '').toLowerCase());
      if (!want) throw new HttpError(404, 'That item is not in the shop');
      if (!want.priceCp) throw new HttpError(400, 'That item has no price; ask the shopkeeper');
      const qty = int(b.qty, 'qty', { min: 1, max: 99, optional: true }) ?? 1;
      const total = want.priceCp * qty;
      const mine = me(res);
      // Coin already promised to other waiting purchases is not available again.
      const waiting = one<any>(db, `SELECT COALESCE(SUM(amount_cp), 0) AS cp FROM ledger WHERE world_id = ? AND owner = ? AND status = 'pending' AND amount_cp < 0`, w, mine)!.cp as number;
      const have = balance(db, w, mine) + waiting;
      if (have < total) throw new HttpError(402, `Not enough coin: ${total > 0 ? money(total) : ''} needed, you have ${money(Math.max(0, have))}`);
      const pending = settings(res).playerChangesNeedApproval;
      const shopName = String((data.page as any).title ?? 'the shop');
      const lid = newId('led_'), iid = newId('itm_'), chg = newId('chg_');
      const itemName = want.name.slice(0, 120);
      tx(db, () => {
        run(db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, lid, w, mine, -total, `Bought ${itemName} x${qty} at ${shopName}`.slice(0, 200), mine, now(), pending ? 'pending' : 'approved');
        run(db, `INSERT INTO items (id, world_id, owner, name, qty, weight, note, dm_note, link, image, updated_at, updated_by, status) VALUES (?, ?, ?, ?, ?, NULL, ?, '', NULL, NULL, ?, ?, ?)`, iid, w, mine, itemName, qty, `Bought at ${shopName}`.slice(0, 500), now(), mine, pending ? 'pending' : 'approved');
        if (pending) {
          const snap = { owner: mine, name: itemName, qty, weight: null, note: `Bought at ${shopName}`.slice(0, 500), dm_note: '', link: null, image: null };
          run(db, `INSERT INTO item_changes (id, world_id, item_id, owner, kind, after_json, reason, by_id, at, status) VALUES (?, ?, ?, ?, 'add', ?, ?, ?, ?, 'pending')`, chg, w, iid, mine, JSON.stringify(snap), `Bought from the stage: ${shopName}`, mine, now());
        }
      });
      audit(w, mine, pending ? 'stage.buy.request' : 'stage.buy', `${itemName} x${qty} ${total}cp at ${shopName}`);
      if (pending) {
        d.hub.emit(w, 'approval', { kind: 'coin', id: lid }, dmAnd(mine));
        d.hub.emit(w, 'approval', { id: chg, kind: 'add', status: 'pending' }, dmAnd(mine));
      } else {
        d.hub.emit(w, 'coin', { owner: mine, balance: balance(db, w, mine) }, dmAnd(mine));
        d.hub.emit(w, 'item', { id: iid, owner: mine, name: itemName, qty, status: 'approved' }, dmAnd(mine));
      }
      res.status(pending ? 202 : 201).json({ pending, item: itemName, qty, totalCp: total, coinEntryId: lid, itemId: iid, changeId: pending ? chg : null });
    });

    return r;
  },
  mcpTools: [
    {
      name: 'get_stage',
      description: "The live session board: the cards on it, the layout and which card is in the spotlight. A DM sees the staging area and everything shown; a player only the cards shown to them. Page, shop and person cards show player copies only.",
      props: {},
      call: () => ({ method: 'GET', path: '/stage' }),
    },
    {
      name: 'show_on_stage',
      description: "DM: put something on the live session board so the table sees it now. kind: image (ref = an https link or an uploaded stage picture id), combat (the live initiative card, no ref), person (ref = a People id), shop or place (ref = a library page id; players see the player copy only), event (title, text, optional ref image, optional countdownSec), text (Markdown text), drawing (the shared whiteboard). Use to: ['<player id>'] to show it to some players only; leave it out for everyone. Set spotlight true to make it the one big card.",
      write: true,
      props: {
        kind: { type: 'string', enum: [...KINDS] },
        ref: { type: 'string', description: 'Picture id or https link, person id, or library page id, by kind' },
        title: { type: 'string', description: 'Heading for an event or text card' },
        text: { type: 'string', description: 'Markdown body for an event or text card' },
        caption: { type: 'string', description: 'Caption under an image' },
        countdownSec: { type: 'integer', description: 'Event card: seconds on the countdown' },
        to: { type: 'array', items: { type: 'string' }, description: 'Player account ids; omit for everyone' },
        spotlight: { type: 'boolean', description: 'Make it the spotlight card' },
      },
      required: ['kind'],
      call: (a) => ({ method: 'POST', path: '/stage/cards', body: { kind: a.kind, ref: a.ref, title: a.title, text: a.text, caption: a.caption, countdownSec: a.countdownSec, to: Array.isArray(a.to) && a.to.length ? a.to : undefined, show: true, spotlight: a.spotlight === true } }),
    },
    {
      name: 'hide_stage_card',
      description: 'DM: take a card off the live session board (back to the staging area).',
      write: true,
      props: { cardId: { type: 'string' } },
      required: ['cardId'],
      call: (a) => ({ method: 'POST', path: `/stage/cards/${encodeURIComponent(String(a.cardId))}/hide`, body: {} }),
    },
  ],
};
export default feature;
