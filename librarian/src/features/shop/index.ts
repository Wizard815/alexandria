// The Shop: an item database per world (seeded from the SRD, imported from
// JSON, CSV or game modules, and the DM's own items), shops that stock it,
// a shop generator, and buying and selling for players. See docs/SHOPS.md.
//
// Players only ever get playerShop()/playerLine() (shops.ts): shops that are
// not hidden, open shops' visible lines, and the keeper's public card. The
// item database, DM notes, the haggle note, hidden lines and the keeper's
// secret are DM-only. Guests get nothing (403).
//
// Buying follows the broker's rules: the player picks their own coin or the
// party pouch, the server checks spendable() (coin promised to debits waiting
// for the DM is not available) and takes coin, stock and the item in one
// transaction. A party-pouch payment reads "Shop purchase (paid by X from the
// party pouch)" in the log the whole party sees. With the world setting
// shopApproval on, a purchase waits for the DM (the coin is held by a pending
// debit and the stock is reserved).
import { Router, type Response } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { type DB, all, one, run, tx } from '../../core/db.ts';
import { requireDM, requirePlayerOrDM } from '../../core/auth.ts';
import { dmAnd } from '../../core/events.ts';
import { featureSetting } from '../../core/policy.ts';
import { hasJob } from '../../core/ai.ts';
import { HttpError, id as newId, int, now, oneOf, parseJson, str } from '../../core/util.ts';
import { balance, money, spendable } from '../../core/coin.ts';
import { ctx, isDM, me, names, settings } from '../../routes/_shared.ts';
import { available, enabledIds } from '../modules/store.ts';
import { selfCall } from '../sculpt/outputs.ts';
import { firstLeak, makeCtx } from '../sculpt/ctx.ts';
import { priceText } from '../generators/tavern.ts';
import * as I from './items.ts';
import { SCHEMA as SHOP_SCHEMA, KIND_LABEL, RESTOCK_RULES, SHOP_KINDS, STATUSES, dmShop, keeperOf, playerShop, playerVisible, restock, settleRestock, stockRows, unitPrice, type Keeper, type ShopRow, type StockRow } from './shops.ts';
import { SIZES, generateKeeper, generateShop, type ShopDraft } from './gen.ts';

export { generateShop } from './gen.ts';

/** The audit log (features write it directly: importing app.ts from a feature would be an import cycle). */
const audit = (db: DB, worldId: string, accountId: string | null, action: string, detail = '') =>
  run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());

const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const N = (description: string) => ({ type: 'integer', description });
const B = (description: string) => ({ type: 'boolean', description });
const enc = encodeURIComponent;
const qs = (o: Record<string, unknown>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${enc(String(v))}`);
  return p.length ? `?${p.join('&')}` : '';
};
const guard = async <T,>(fn: () => Promise<T> | T): Promise<T> => {
  try { return await fn(); } catch (e) { if (e instanceof RangeError) throw new HttpError(400, e.message); throw e; }
};

/** The world settings this feature reads. */
const cfg = (res: Response) => {
  const s = settings(res);
  return {
    approval: featureSetting<boolean>(s, 'shopApproval') === true,
    sellBack: featureSetting<boolean>(s, 'shopSellBack') === true,
    sellPct: Number(featureSetting<number>(s, 'shopSellBackPct') ?? 50),
    partyPay: !!s.partyPurse && featureSetting<boolean>(s, 'shopPartyPay') !== false,
    partyPurse: !!s.partyPurse, coins: String(s.coins ?? 'gsc'),
  };
};

function routes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;
  const W = (res: Response) => ctx(res).world.id;
  // Guests get nothing here: shops are for the people who buy.
  r.use(requirePlayerOrDM);

  const seed = (res: Response) => I.ensureSeeded(db, W(res), enabledIds(db, W(res)));

  // ---- live events ----
  /** A shop changed. Players hear about shops they can see (or could see until now); the DM about all. */
  const shopEvent = (w: string, s: Pick<ShopRow, 'id' | 'status'>, wasVisible = false) =>
    d.hub.emit(w, 'shop', { id: s.id }, (v) => v.role === 'dm' || (v.role === 'player' && (playerVisible(s) || wasVisible)));
  const coinChanged = (w: string, owner: string, by: string, note?: string) => {
    const nm = names(db, w);
    d.hub.emit(w, 'coin', { owner, balance: balance(db, w, owner), ...(owner === 'party' && note ? { note, by: nm[by] ?? null } : {}) }, owner === 'party' ? (v) => v.role === 'dm' || v.role === 'player' : dmAnd(owner));
  };
  const itemChanged = (w: string, owner: string, it: { id: string; name: string; qty: number }) =>
    d.hub.emit(w, 'item', { id: it.id, owner, name: it.name, qty: it.qty, status: 'approved' }, owner === 'party' ? (v) => v.role === 'dm' || v.role === 'player' : dmAnd(owner));
  const orderEvent = (w: string, o: { id: string; status: string; account_id: string }) => d.hub.emit(w, 'shop-order', { id: o.id, status: o.status }, dmAnd(o.account_id));

  // ---- loading, fail closed ----
  function shopFor(res: Response, sid: string): ShopRow {
    const s = one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ? AND world_id = ?', sid, W(res));
    // A player asking for a hidden shop gets the same answer as for one that does not exist.
    if (!s || (!isDM(res) && !playerVisible(s))) throw new HttpError(404, 'Shop not found');
    if (settleRestock(db, s)) shopEvent(s.world_id, s);
    return one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ?', s.id)!;
  }
  const itemFor = (res: Response, iid: string) => {
    const it = one<I.ItemRow>(db, 'SELECT * FROM shop_items WHERE id = ? AND world_id = ?', iid, W(res));
    if (!it) throw new HttpError(404, 'Item not found');
    return it;
  };
  const viewOf = (res: Response, s: ShopRow) => (isDM(res) ? dmShop(d, db, s, ctx(res).viewer) : playerShop(d, db, s, ctx(res).viewer));

  // ---- settings players need to see ----
  r.get('/config', (_req, res) => {
    const c = cfg(res);
    res.json({ approval: c.approval, sellBack: c.sellBack, sellPct: c.sellPct, partyPay: c.partyPay, coins: c.coins, kinds: SHOP_KINDS.map((k) => ({ id: k, label: KIND_LABEL[k] })), sizes: SIZES, ...(isDM(res) ? { model: hasJob(d, 'chat'), types: I.ITEM_TYPES, rarities: I.ITEM_RARITIES } : {}) });
  });

  // ================= the item database (DM only) =================

  r.get('/items', requireDM, (req, res) => {
    seed(res);
    const q = String(req.query.q ?? '').trim().toLowerCase().slice(0, 100);
    const type = String(req.query.type ?? '').trim();
    const rarity = String(req.query.rarity ?? '').trim();
    const source = String(req.query.source ?? '').trim();
    const tag = String(req.query.tag ?? '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(500, Math.floor(Number(req.query.limit ?? 100)) || 100));
    const offset = Math.max(0, Math.floor(Number(req.query.offset ?? 0)) || 0);
    const rows = all<I.ItemRow>(db, 'SELECT * FROM shop_items WHERE world_id = ? ORDER BY name COLLATE NOCASE, id', W(res));
    const hit = rows.filter((x) => (!type || x.type === type) && (!rarity || x.rarity === rarity) && (!source || x.source === source)
      && (!tag || parseJson<string[]>(x.tags, []).includes(tag))
      && (!q || `${x.name} ${x.category} ${x.type} ${x.rarity} ${x.tags} ${x.properties}`.toLowerCase().includes(q) || I.nameKey(x.name).includes(I.nameKey(q))));
    const sources = new Map<string, { id: string; label: string; n: number }>();
    for (const x of rows) { const s = sources.get(x.source) ?? { id: x.source, label: x.source_label, n: 0 }; s.n++; sources.set(x.source, s); }
    res.json({ total: hit.length, all: rows.length, items: hit.slice(offset, offset + limit).map(I.itemOut), sources: [...sources.values()], tags: [...new Set(rows.flatMap((x) => parseJson<string[]>(x.tags, [])))].sort() });
  });

  r.get('/items/export', requireDM, (req, res) => {
    const rows = all<I.ItemRow>(db, 'SELECT * FROM shop_items WHERE world_id = ? ORDER BY name COLLATE NOCASE, id', W(res));
    const fmt = String(req.query.format ?? 'json');
    res.setHeader('Content-Disposition', `attachment; filename="items.${fmt === 'csv' ? 'csv' : 'json'}"`);
    if (fmt === 'csv') { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); return res.send(I.toCsv(rows)); }
    res.json({ format: 'alexandria-items', version: 1, items: rows.map((x) => { const o: any = I.itemOut(x); delete o.id; delete o.updatedAt; return o; }) });
  });

  r.get('/items/:iid', requireDM, (req, res) => res.json(I.itemOut(itemFor(res, String(req.params.iid)))));

  r.post('/items', requireDM, (req, res) => {
    const it = I.cleanItem({ ...req.body, source: req.body?.source ?? 'custom' });
    if (one(db, 'SELECT 1 FROM shop_items WHERE world_id = ? AND name_key = ?', W(res), I.nameKey(it.name)) && req.body?.allowDuplicate !== true) throw new HttpError(409, `An item called ${it.name} is already in the item database (duplicate it or give it another name)`);
    const iid = I.insertItem(db, W(res), it, me(res));
    audit(db, W(res), me(res), 'shop.item.add', it.name);
    d.hub.emit(W(res), 'shop-items', {}, (v) => v.role === 'dm');
    res.status(201).json(I.itemOut(itemFor(res, iid)));
  });

  r.patch('/items/:iid', requireDM, (req, res) => {
    const cur = itemFor(res, String(req.params.iid));
    const merged = { ...I.itemOut(cur), ...req.body, sourceLabel: req.body?.sourceLabel ?? cur.source_label };
    // A new price as text ("15 gp") replaces the stored copper.
    if (req.body?.costCp === undefined && (req.body?.cost !== undefined || req.body?.price !== undefined)) delete (merged as any).costCp;
    const it = I.cleanItem(merged);
    if (I.nameKey(it.name) !== cur.name_key && one(db, 'SELECT 1 FROM shop_items WHERE world_id = ? AND name_key = ? AND id <> ?', W(res), I.nameKey(it.name), cur.id)) throw new HttpError(409, `An item called ${it.name} is already in the item database`);
    I.updateItem(db, cur.id, it, me(res));
    audit(db, W(res), me(res), 'shop.item.edit', it.name);
    d.hub.emit(W(res), 'shop-items', {}, (v) => v.role === 'dm');
    // Shops that stock it show the new name and price at once.
    for (const s of all<ShopRow>(db, 'SELECT DISTINCT s.* FROM shops s JOIN shop_stock t ON t.shop_id = s.id WHERE t.item_id = ?', cur.id)) shopEvent(s.world_id, s);
    res.json(I.itemOut(itemFor(res, cur.id)));
  });

  r.post('/items/:iid/duplicate', requireDM, (req, res) => {
    const cur = itemFor(res, String(req.params.iid));
    let name = str(req.body?.name, 'name', { max: 120, optional: true }) || `${cur.name} (copy)`;
    for (let n = 2; one(db, 'SELECT 1 FROM shop_items WHERE world_id = ? AND name_key = ?', W(res), I.nameKey(name)); n++) name = `${cur.name} (copy ${n})`;
    const it = I.cleanItem({ ...I.itemOut(cur), name, source: 'custom', sourceLabel: 'Custom', sourceRef: null, attribution: cur.attribution });
    const iid = I.insertItem(db, W(res), it, me(res));
    audit(db, W(res), me(res), 'shop.item.duplicate', `${cur.name} -> ${name}`);
    d.hub.emit(W(res), 'shop-items', {}, (v) => v.role === 'dm');
    res.status(201).json(I.itemOut(itemFor(res, iid)));
  });

  r.delete('/items/:iid', requireDM, (req, res) => {
    const cur = itemFor(res, String(req.params.iid));
    const shops = all<ShopRow>(db, 'SELECT DISTINCT s.* FROM shops s JOIN shop_stock t ON t.shop_id = s.id WHERE t.item_id = ?', cur.id);
    run(db, 'DELETE FROM shop_items WHERE id = ?', cur.id);
    audit(db, W(res), me(res), 'shop.item.delete', cur.name);
    d.hub.emit(W(res), 'shop-items', {}, (v) => v.role === 'dm');
    for (const s of shops) shopEvent(s.world_id, s);
    res.json({ ok: true });
  });

  // Where items can be imported from: the game modules this world has (built-in SRD and imported), with their item counts.
  r.get('/sources', requireDM, (_req, res) => {
    const out = available(db, W(res)).map((m) => {
      let items = 0;
      try { items = I.moduleItems(db, W(res), m.id).length; } catch { /* gone */ }
      return { id: m.id, name: m.name, builtin: m.builtin, license: m.license, attribution: m.attribution, items };
    }).filter((m) => m.items > 0);
    res.json({ modules: out, seeded: !!one(db, 'SELECT 1 FROM shop_meta WHERE world_id = ? AND seeded_at IS NOT NULL', W(res)) });
  });

  /**
   * Import: { type: 'module', module } | { type: 'json', json } | { type: 'csv', csv }, with onDuplicate 'skip' (default)
   * or 'update', and preview: true to count without saving. Optional source/sourceLabel/attribution apply to file records.
   */
  r.post('/items/import', requireDM, (req, res) => {
    const b = req.body ?? {};
    const type = oneOf(b.type, 'type', ['module', 'json', 'csv'] as const);
    const onDuplicate = b.onDuplicate === 'update' ? 'update' : 'skip';
    const defaults = { source: str(b.source, 'source', { max: 60, optional: true }).toLowerCase().replace(/[^a-z0-9:._-]+/g, '-') || (type === 'module' ? '' : `import-${type}`), sourceLabel: str(b.sourceLabel, 'sourceLabel', { max: 80, optional: true }) || (type === 'csv' ? 'CSV import' : 'JSON import'), attribution: str(b.attribution, 'attribution', { max: 1000, optional: true }) };
    let records: I.NewItem[] = [];
    let errors: string[] = [];
    if (type === 'module') records = I.moduleItems(db, W(res), str(b.module, 'module', { max: 80 }));
    else if (type === 'json') {
      let j = b.json;
      if (typeof j === 'string') { if (j.length > 24_000_000) throw new HttpError(413, 'That file is too big'); try { j = JSON.parse(j); } catch { throw new HttpError(400, 'That is not valid JSON'); } }
      const list = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : null;
      if (!list) throw new HttpError(400, 'JSON must be a list of items, or { "items": [...] }');
      ({ records, errors } = I.recordsFrom(list, defaults));
    } else {
      const text = str(b.csv, 'csv', { max: 24_000_000 });
      ({ records, errors } = I.recordsFrom(I.parseCsv(text), defaults));
    }
    const out = I.importItems(db, W(res), records, { onDuplicate, preview: b.preview === true, by: me(res), errors });
    if (b.preview !== true) {
      audit(db, W(res), me(res), 'shop.items.import', `${type}${type === 'module' ? ` ${b.module}` : ''}: +${out.added} ~${out.updated} =${out.skipped}`);
      d.hub.emit(W(res), 'shop-items', {}, (v) => v.role === 'dm');
      run(db, 'INSERT INTO shop_meta (world_id, seeded_at) VALUES (?, ?) ON CONFLICT (world_id) DO UPDATE SET seeded_at = COALESCE(shop_meta.seeded_at, excluded.seeded_at)', W(res), now());
    }
    res.json({ ...out, preview: b.preview === true });
  });

  // ================= shops =================

  r.get('/shops', (_req, res) => {
    const rows = all<ShopRow>(db, 'SELECT * FROM shops WHERE world_id = ? ORDER BY name COLLATE NOCASE', W(res));
    for (const s of rows) settleRestock(db, s);
    if (isDM(res)) return res.json({ shops: rows.map((s) => { const v = dmShop(d, db, s, ctx(res).viewer); return { ...v, stockCount: v.stock.length, stock: undefined }; }), config: cfg(res) });
    res.json({ shops: rows.filter(playerVisible).map((s) => { const v = playerShop(d, db, s, ctx(res).viewer, false)!; return { ...v, stockCount: s.status === 'open' ? (one<any>(db, 'SELECT count(*) AS n FROM shop_stock WHERE shop_id = ? AND hidden = 0', s.id)!.n as number) : 0, stock: undefined }; }), config: cfg(res) });
  });

  r.get('/shops/:sid', (req, res) => {
    const s = shopFor(res, String(req.params.sid));
    const v: any = viewOf(res, s);
    const c = cfg(res);
    if (!isDM(res)) v.sellPct = c.sellBack ? (s.sell_pct ?? c.sellPct) : null;
    res.json(v);
  });

  const cleanKeeper = (k: any, cur: Keeper = {}): Keeper => {
    if (k === undefined) return cur;
    if (k === null) return {};
    const f = (key: keyof Keeper, max: number) => (k[key] === undefined ? cur[key] : str(k[key], `keeper.${String(key)}`, { max, optional: true })) as string | undefined;
    return { name: f('name', 120), race: f('race', 60), role: f('role', 80), look: f('look', 1000), voice: f('voice', 600), personality: f('personality', 600), secret: f('secret', 2000), pageId: k.pageId === undefined ? cur.pageId ?? null : k.pageId ? str(k.pageId, 'keeper.pageId', { max: 120 }) : null, seed: cur.seed ?? k.seed };
  };
  const checkPage = (res: Response, pid: unknown): string | null => {
    if (pid === undefined || pid === null || pid === '') return null;
    try { return String((d.library.get(W(res), str(pid, 'pageId', { max: 300 }), ctx(res).viewer) as any).id); } catch { throw new HttpError(400, 'Pick a library page of this world'); }
  };

  function writeShop(res: Response, b: any, cur?: ShopRow): string {
    const k = cleanKeeper(b.keeper, cur ? keeperOf(cur) : {});
    if (k.pageId) k.pageId = checkPage(res, k.pageId);
    const v = {
      name: b.name === undefined && cur ? cur.name : str(b.name, 'name', { max: 120 }),
      kind: b.kind === undefined && cur ? cur.kind : oneOf(b.kind ?? 'general', 'kind', SHOP_KINDS),
      description: b.description === undefined && cur ? cur.description : str(b.description, 'description', { max: 2000, optional: true }),
      location: b.locationPageId === undefined && cur ? cur.location_page_id : checkPage(res, b.locationPageId),
      markup: b.markupPct === undefined && cur ? cur.markup_pct : int(b.markupPct ?? 0, 'markupPct', { min: -90, max: 1000 })!,
      haggle: b.haggle === undefined && cur ? cur.haggle : str(b.haggle, 'haggle', { max: 1000, optional: true }),
      dmNotes: b.dmNotes === undefined && cur ? cur.dm_notes : str(b.dmNotes, 'dmNotes', { max: 4000, optional: true }),
      status: b.status === undefined && cur ? cur.status : oneOf(b.status ?? 'hidden', 'status', STATUSES),
      rule: b.restock?.rule === undefined && cur ? cur.restock_rule : oneOf(b.restock?.rule ?? 'manual', 'restock.rule', RESTOCK_RULES),
      days: b.restock?.days === undefined && cur ? cur.restock_days : int(b.restock?.days ?? 7, 'restock.days', { min: 1, max: 3650 })!,
      sellPct: b.sellPct === undefined ? cur?.sell_pct ?? null : b.sellPct === null || b.sellPct === '' ? null : int(b.sellPct, 'sellPct', { min: 0, max: 100 }),
    };
    const t = now();
    if (cur) {
      run(db, 'UPDATE shops SET name = ?, kind = ?, description = ?, keeper = ?, location_page_id = ?, markup_pct = ?, haggle = ?, dm_notes = ?, status = ?, restock_rule = ?, restock_days = ?, sell_pct = ?, updated_at = ? WHERE id = ?',
        v.name, v.kind, v.description, JSON.stringify(k), v.location, v.markup, v.haggle, v.dmNotes, v.status, v.rule, v.days, v.sellPct, t, cur.id);
      return cur.id;
    }
    const sid = newId('shp_');
    run(db, 'INSERT INTO shops (id, world_id, name, kind, description, keeper, location_page_id, markup_pct, haggle, dm_notes, status, restock_rule, restock_days, sell_pct, gen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      sid, W(res), v.name, v.kind, v.description, JSON.stringify(k), v.location, v.markup, v.haggle, v.dmNotes, v.status, v.rule, v.days, v.sellPct, JSON.stringify(b.gen && typeof b.gen === 'object' ? b.gen : {}), t, t);
    return sid;
  }

  const addStock = (sid: string, worldId: string, lines: any[]) => {
    const maxSort = one<any>(db, 'SELECT COALESCE(MAX(sort), 0) AS n FROM shop_stock WHERE shop_id = ?', sid)!.n as number;
    let n = maxSort;
    const added: string[] = [];
    for (const [i, l] of lines.entries()) {
      const iid = str(l?.itemId, `stock[${i}].itemId`, { max: 80 });
      if (!one(db, 'SELECT 1 FROM shop_items WHERE id = ? AND world_id = ?', iid, worldId)) throw new HttpError(400, `stock[${i}]: no such item in the item database`);
      const qty = l.qty === null || l.qty === undefined || l.qty === '' || l.unlimited === true ? null : int(l.qty, `stock[${i}].qty`, { min: 0, max: 1_000_000 });
      const price = l.priceCp === null || l.priceCp === undefined || l.priceCp === '' ? null : int(l.priceCp, `stock[${i}].priceCp`, { min: 0, max: 10_000_000_000 });
      const ex = one<StockRow>(db, 'SELECT * FROM shop_stock WHERE shop_id = ? AND item_id = ?', sid, iid);
      if (ex) {
        // Stocking an item the shop already has adds to the line.
        run(db, 'UPDATE shop_stock SET qty = CASE WHEN qty IS NULL OR ? IS NULL THEN NULL ELSE qty + ? END, base_qty = CASE WHEN base_qty IS NULL OR ? IS NULL THEN NULL ELSE base_qty + ? END, price_cp = COALESCE(?, price_cp) WHERE id = ?', qty, qty, qty, qty, price, ex.id);
        added.push(ex.id);
        continue;
      }
      const stid = newId('stk_');
      run(db, 'INSERT INTO shop_stock (id, shop_id, world_id, item_id, price_cp, qty, base_qty, hidden, dm_note, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        stid, sid, worldId, iid, price, qty, qty, l.hidden === true ? 1 : 0, str(l.dmNote, `stock[${i}].dmNote`, { max: 1000, optional: true }), ++n);
      added.push(stid);
    }
    return added;
  };

  r.post('/shops', requireDM, (req, res) => {
    const b = req.body ?? {};
    let sid = '';
    tx(db, () => {
      sid = writeShop(res, b);
      if (Array.isArray(b.stock)) addStock(sid, W(res), b.stock.slice(0, 500));
    });
    const s = one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ?', sid)!;
    audit(db, W(res), me(res), 'shop.create', `${s.name} (${s.status})`);
    shopEvent(W(res), s);
    res.status(201).json(dmShop(d, db, s, ctx(res).viewer));
  });

  r.patch('/shops/:sid', requireDM, (req, res) => {
    const cur = shopFor(res, String(req.params.sid));
    tx(db, () => writeShop(res, req.body ?? {}, cur));
    const s = one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ?', cur.id)!;
    audit(db, W(res), me(res), 'shop.edit', s.name);
    shopEvent(W(res), s, playerVisible(cur));
    res.json(dmShop(d, db, s, ctx(res).viewer));
  });

  // Open, close or hide, live.
  r.post('/shops/:sid/status', requireDM, (req, res) => {
    const cur = shopFor(res, String(req.params.sid));
    const status = oneOf(req.body?.status, 'status', STATUSES);
    run(db, 'UPDATE shops SET status = ?, updated_at = ? WHERE id = ?', status, now(), cur.id);
    audit(db, W(res), me(res), 'shop.status', `${cur.name}: ${status}`);
    const s = one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ?', cur.id)!;
    shopEvent(W(res), s, playerVisible(cur));
    res.json(dmShop(d, db, s, ctx(res).viewer));
  });

  r.delete('/shops/:sid', requireDM, (req, res) => {
    const cur = shopFor(res, String(req.params.sid));
    if (one(db, `SELECT 1 FROM shop_orders WHERE shop_id = ? AND status = 'pending'`, cur.id)) throw new HttpError(409, 'This shop has purchases waiting for you: decide them first');
    run(db, 'DELETE FROM shops WHERE id = ?', cur.id);
    audit(db, W(res), me(res), 'shop.delete', cur.name);
    shopEvent(W(res), { id: cur.id, status: 'hidden' }, playerVisible(cur));
    res.json({ ok: true });
  });

  r.post('/shops/:sid/stock', requireDM, (req, res) => {
    const s = shopFor(res, String(req.params.sid));
    const lines = Array.isArray(req.body?.items) ? req.body.items : [req.body];
    if (lines.length > 500) throw new HttpError(400, 'At most 500 lines at once');
    const added = tx(db, () => addStock(s.id, W(res), lines));
    run(db, 'UPDATE shops SET updated_at = ? WHERE id = ?', now(), s.id);
    audit(db, W(res), me(res), 'shop.stock', `${s.name}: ${added.length} line(s)`);
    shopEvent(W(res), s);
    res.status(201).json(dmShop(d, db, one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ?', s.id)!, ctx(res).viewer));
  });

  r.patch('/shops/:sid/stock/:stid', requireDM, (req, res) => {
    const s = shopFor(res, String(req.params.sid));
    const st = one<StockRow>(db, 'SELECT * FROM shop_stock WHERE id = ? AND shop_id = ?', String(req.params.stid), s.id);
    if (!st) throw new HttpError(404, 'Stock line not found');
    const b = req.body ?? {};
    const qty = b.qty === undefined ? st.qty : b.qty === null || b.qty === '' ? null : int(b.qty, 'qty', { min: 0, max: 1_000_000 });
    const base = b.baseQty === undefined ? (b.qty === undefined ? st.base_qty : qty) : b.baseQty === null || b.baseQty === '' ? null : int(b.baseQty, 'baseQty', { min: 0, max: 1_000_000 });
    const price = b.priceCp === undefined ? st.price_cp : b.priceCp === null || b.priceCp === '' ? null : int(b.priceCp, 'priceCp', { min: 0, max: 10_000_000_000 });
    const hidden = b.hidden === undefined ? st.hidden : b.hidden === true ? 1 : 0;
    const note = b.dmNote === undefined ? st.dm_note : str(b.dmNote, 'dmNote', { max: 1000, optional: true });
    run(db, 'UPDATE shop_stock SET qty = ?, base_qty = ?, price_cp = ?, hidden = ?, dm_note = ? WHERE id = ?', qty, base, price, hidden, note, st.id);
    run(db, 'UPDATE shops SET updated_at = ? WHERE id = ?', now(), s.id);
    audit(db, W(res), me(res), 'shop.stock.edit', `${s.name}: ${st.id}`);
    shopEvent(W(res), s);
    res.json(dmShop(d, db, one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ?', s.id)!, ctx(res).viewer));
  });

  r.delete('/shops/:sid/stock/:stid', requireDM, (req, res) => {
    const s = shopFor(res, String(req.params.sid));
    if (!run(db, 'DELETE FROM shop_stock WHERE id = ? AND shop_id = ?', String(req.params.stid), s.id)) throw new HttpError(404, 'Stock line not found');
    audit(db, W(res), me(res), 'shop.stock.remove', s.name);
    shopEvent(W(res), s);
    res.json(dmShop(d, db, one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ?', s.id)!, ctx(res).viewer));
  });

  r.post('/shops/:sid/restock', requireDM, (req, res) => {
    const s = shopFor(res, String(req.params.sid));
    restock(db, s.id);
    audit(db, W(res), me(res), 'shop.restock', s.name);
    shopEvent(W(res), s);
    res.json(dmShop(d, db, one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ?', s.id)!, ctx(res).viewer));
  });

  // ---- the generator ----
  const draftStock = (dr: ShopDraft) => dr.stock.map((l) => ({ itemId: l.itemId, qty: l.qty, hidden: l.hidden }));
  /** { kind, size, level, theme, seed, count, name, enrich, guide, save, status } -> a draft, or with save the new shop. */
  r.post('/generate', requireDM, async (req, res) => {
    const b = req.body ?? {};
    const guide = typeof b.guide === 'string' ? b.guide.slice(0, 8000) : undefined;
    const draft = await guard(() => generateShop(d, W(res), { kind: b.kind, size: b.size, level: b.level, theme: b.theme, seed: b.seed, count: b.count, name: b.name, enrich: b.enrich === true, flavour: b.flavour }, guide));
    if (b.save !== true) return res.json({ draft });
    let sid = '';
    tx(db, () => {
      sid = writeShop(res, { name: draft.name, kind: draft.kind, description: draft.description, keeper: draft.keeper, markupPct: draft.markupPct, haggle: draft.haggle, dmNotes: draft.dmNotes, status: b.status ?? 'hidden', locationPageId: b.locationPageId, gen: { seed: draft.seed, size: draft.size, level: draft.level, theme: draft.theme } });
      addStock(sid, W(res), draftStock(draft));
    });
    const s = one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ?', sid)!;
    audit(db, W(res), me(res), 'shop.generate', `${s.name} (${draft.kind}, ${draft.size}, level ${draft.level})`);
    shopEvent(W(res), s);
    res.status(201).json({ draft, shop: dmShop(d, db, s, ctx(res).viewer) });
  });

  // A new shopkeeper for a shop (the NPC generator), or a free-standing one with no shop: { kind, seed, race, gender, save: page? }.
  r.post('/keeper', requireDM, async (req, res) => {
    const b = req.body ?? {};
    const k = await generateKeeper(d, W(res), { kind: b.kind, seed: b.seed, race: b.race, gender: b.gender });
    if (b.shopId) {
      const s = shopFor(res, str(b.shopId, 'shopId', { max: 80 }));
      const old = keeperOf(s);
      const next = { ...k, pageId: old.pageId ?? null };
      run(db, 'UPDATE shops SET keeper = ?, updated_at = ? WHERE id = ?', JSON.stringify(next), now(), s.id);
      audit(db, W(res), me(res), 'shop.keeper', `${s.name}: ${k.name}`);
      shopEvent(W(res), s);
      const page = b.savePage === true ? keeperPage(res, s.id) : null;
      return res.status(201).json({ keeper: page ? { ...next, pageId: page.id } : next, page, shop: dmShop(d, db, one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ?', s.id)!, ctx(res).viewer) });
    }
    res.status(201).json({ keeper: k });
  });

  /** The shopkeeper as a DM-level library page (look and voice in the open, the secret in a secret callout); links it. */
  function keeperPage(res: Response, sid: string) {
    const s = one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ?', sid)!;
    const k = keeperOf(s);
    if (!k.name) throw new HttpError(400, 'This shop has no shopkeeper yet');
    const md = [`# ${k.name}`, '', `*${[k.role, k.race].filter(Boolean).join(', ')} at ${s.name}*`, '', '## Look', '', k.look ?? '', '', '## Voice and manner', '', k.voice ?? '', '', '## Personality', '', k.personality ?? '', '',
      ...(k.secret ? ['> [!secret] Secret', ...k.secret.split('\n').map((l) => `> ${l}`), ''] : [])].join('\n');
    const clean = (x: string) => x.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Shopkeeper';
    let p = `Generated/NPCs/${clean(k.name)}.md`;
    if (k.pageId) { try { p = String((d.library.get(W(res), k.pageId, ctx(res).viewer) as any).path); } catch { /* gone: a new page */ } }
    const page: any = d.library.save(W(res), { path: p, title: k.name, body: md, frontmatter: { title: k.name, kind: 'npc', tags: ['generated', 'gen-npc', 'shopkeeper'], visibility: 'dm' }, visibility: 'dm' }, me(res));
    run(db, 'UPDATE shops SET keeper = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...k, pageId: page.id }), now(), s.id);
    audit(db, W(res), me(res), 'shop.keeper.page', `${s.name}: ${page.path}`);
    return { id: String(page.id), path: String(page.path), title: String(page.title) };
  }
  r.post('/shops/:sid/keeper-page', requireDM, (req, res) => {
    const s = shopFor(res, String(req.params.sid));
    const page = keeperPage(res, s.id);
    res.status(201).json({ page, shop: dmShop(d, db, one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ?', s.id)!, ctx(res).viewer) });
  });

  // The shop's stock as a stage card (what players would see of it), staged or shown on the players' TV.
  r.post('/shops/:sid/stage', requireDM, async (req, res) => {
    const s = shopFor(res, String(req.params.sid));
    const v = playerShop(d, db, { ...s, status: 'open' }, { accountId: '', role: 'player' })!;
    const c = cfg(res);
    const lines = (v.stock as any[]).map((l) => `- **${l.name}**${l.rarity !== 'mundane' ? ` (${l.rarity})` : ''}: ${l.priceCp === null ? 'ask' : priceText(l.priceCp, c.coins)}${l.unlimited ? '' : l.qty === 0 ? ', sold out' : `, ${l.qty} left`}`);
    const text = [v.keeper ? `${v.keeper.name}, ${v.keeper.role || 'shopkeeper'}. ${v.keeper.look}` : '', v.description, '', ...lines].filter((x, i) => x || i === 2).join('\n').trim();
    const hit = firstLeak(makeCtx(d, W(res), false, {}), text);
    if (hit) throw new HttpError(409, 'Not sent: the text repeats words from DM-only notes.');
    const card = await selfCall(req, W(res), 'POST', '/stage/cards', { kind: 'text', title: `${s.name} (${KIND_LABEL[s.kind as keyof typeof KIND_LABEL] ?? s.kind})`, text: text || 'Nothing on the shelves.', show: req.body?.show === true });
    audit(db, W(res), me(res), 'shop.stage', s.name);
    res.status(201).json({ ok: true, cardId: card.id, shown: req.body?.show === true });
  });

  // ================= buying and selling =================

  r.get('/pay-options', (_req, res) => {
    const c = cfg(res);
    const w = W(res);
    res.json({
      self: { cp: balance(db, w, me(res)), available: spendable(db, w, me(res)) },
      party: { cp: c.partyPurse ? balance(db, w, 'party') : null, available: c.partyPurse ? spendable(db, w, 'party') : null, allowed: c.partyPay, reason: !c.partyPurse ? 'The party pouch is off in this world.' : !c.partyPay ? 'Your DM has turned off paying shops from the party pouch.' : null },
      default: 'self',
    });
  });

  /** Put bought things in an inventory: onto a line of the same name, else a new line. Never copies any DM note. */
  function deliver(w: string, owner: string, it: I.ItemRow, qty: number, by: string): { id: string; name: string; qty: number } {
    const ex = one<any>(db, `SELECT id, qty FROM items WHERE world_id = ? AND owner = ? AND name = ? AND status = 'approved' AND dm_note = '' AND image IS NULL LIMIT 1`, w, owner, it.name);
    if (ex) {
      run(db, 'UPDATE items SET qty = qty + ?, updated_at = ?, updated_by = ? WHERE id = ?', qty, now(), by, ex.id);
      return { id: ex.id, name: it.name, qty: ex.qty + qty };
    }
    const iid = newId('itm_');
    const note = [it.rarity !== 'mundane' ? it.rarity : '', it.type !== 'other' ? it.type : '', it.attunement ? 'requires attunement' : ''].filter(Boolean).join(', ');
    run(db, `INSERT INTO items (id, world_id, owner, name, qty, weight, note, dm_note, link, image, updated_at, updated_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, '', NULL, NULL, ?, ?, 'approved')`, iid, w, owner, it.name, qty, it.weight, note.slice(0, 500), now(), by);
    return { id: iid, name: it.name, qty };
  }

  r.post('/shops/:sid/buy', (req, res) => {
    const w = W(res);
    const s = shopFor(res, String(req.params.sid));
    if (s.status !== 'open') throw new HttpError(409, 'This shop is closed');
    const b = req.body ?? {};
    const qty = int(b.qty ?? 1, 'qty', { min: 1, max: 1000 })!;
    const to = b.to === 'party' ? 'party' : 'me';
    const c = cfg(res);
    const buyer = me(res);
    let from: 'self' | 'party';
    if (b.from === 'party') {
      if (!c.partyPurse) throw new HttpError(400, 'The party pouch is off in this world, so it cannot pay');
      if (!c.partyPay) throw new HttpError(403, 'Your DM has turned off paying shops from the party pouch. Pay from your own coin.');
      from = 'party';
    } else if (b.from === undefined || b.from === null || b.from === '' || b.from === 'self' || b.from === 'me') from = 'self';
    else throw new HttpError(400, 'from must be "self" (your own coin) or "party" (the party pouch)');
    const payer = from === 'party' ? 'party' : buyer;
    const owner = to === 'party' ? 'party' : buyer;
    const stid = str(b.stockId, 'stockId', { max: 80 });
    let out: { order: any; delivered: { id: string; name: string; qty: number } | null; total: number; ledgerId: string | null; note: string };
    // One transaction: the line, the price, the purse and the item are read and written together, so two buyers can never both get the last one.
    out = tx(db, () => {
      const st = one<StockRow>(db, 'SELECT * FROM shop_stock WHERE id = ? AND shop_id = ?', stid, s.id);
      if (!st || (st.hidden && !isDM(res))) throw new HttpError(404, 'That is not for sale here');
      const it = one<I.ItemRow>(db, 'SELECT * FROM shop_items WHERE id = ?', st.item_id)!;
      const unit = unitPrice(s, st, it);
      if (unit === null) throw new HttpError(409, `${it.name} has no price: ask the shopkeeper (the DM)`);
      if (st.qty !== null && st.qty < qty) throw new HttpError(409, st.qty === 0 ? `${it.name} is sold out` : `Only ${st.qty} ${it.name} left`);
      const total = unit * qty;
      if (total > 0) {
        const have = spendable(db, w, payer);
        if (have < total) throw new HttpError(402, `Not enough coin: this costs ${money(total)} and ${payer === 'party' ? 'the party pouch has' : 'you have'} ${money(Math.max(0, have))}${payer === 'party' ? '. Someone may have spent from it; pick again.' : ''}`);
      }
      const who = names(db, w)[buyer] ?? 'Someone';
      // The party log never names what was bought.
      const note = (from === 'party' ? `Shop purchase (paid by ${who} from the party pouch)` : `Shop: ${it.name}${qty > 1 ? ` x${qty}` : ''} at ${s.name}`).slice(0, 200);
      let ledgerId: string | null = null;
      if (total > 0) {
        ledgerId = newId('led_');
        run(db, 'INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ledgerId, w, payer, -total, note, buyer, now(), c.approval ? 'pending' : 'approved');
      }
      if (st.qty !== null && run(db, 'UPDATE shop_stock SET qty = qty - ? WHERE id = ? AND qty >= ?', qty, st.id, qty) !== 1) throw new HttpError(409, `${it.name} just sold out`);
      const oid = newId('sho_');
      const status = c.approval ? 'pending' : 'approved';
      run(db, `INSERT INTO shop_orders (id, world_id, shop_id, stock_id, item_id, kind, account_id, payer, dest, qty, unit_cp, total_cp, ledger_id, item_name, status, created_at, decided_at) VALUES (?, ?, ?, ?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        oid, w, s.id, st.id, it.id, buyer, payer, owner, qty, unit, total, ledgerId, it.name, status, now(), c.approval ? null : now());
      const delivered = c.approval ? null : deliver(w, owner, it, qty, buyer);
      if (delivered) run(db, 'UPDATE shop_orders SET inv_item_id = ? WHERE id = ?', delivered.id, oid);
      return { order: one<any>(db, 'SELECT * FROM shop_orders WHERE id = ?', oid), delivered, total, ledgerId, note };
    });
    audit(db, w, buyer, c.approval ? 'shop.buy.request' : 'shop.buy', `${s.name}: ${out.order.item_name} x${qty} for ${out.total} from ${payer === 'party' ? 'party' : 'self'}`);
    if (out.ledgerId) coinChanged(w, payer, buyer, out.note);
    if (out.delivered) itemChanged(w, owner, out.delivered);
    shopEvent(w, s);
    orderEvent(w, out.order);
    if (c.approval) d.hub.emit(w, 'approval', { id: out.order.id, kind: 'shop', status: 'pending' }, dmAnd(buyer));
    res.status(c.approval ? 202 : 201).json({ order: orderOut(res, out.order), pending: c.approval, item: out.delivered });
  });

  // Sell back: a request at the shop's (or the world's) percentage of the item's price; the DM approves.
  r.post('/shops/:sid/sell', (req, res) => {
    const w = W(res);
    const c = cfg(res);
    if (!c.sellBack) throw new HttpError(403, 'Selling to shops is off in this world');
    const s = shopFor(res, String(req.params.sid));
    if (s.status !== 'open') throw new HttpError(409, 'This shop is closed');
    const b = req.body ?? {};
    const qty = int(b.qty ?? 1, 'qty', { min: 1, max: 1_000_000 })!;
    const inv = one<any>(db, `SELECT * FROM items WHERE id = ? AND world_id = ? AND status = 'approved'`, str(b.itemId, 'itemId', { max: 80 }), w);
    if (!inv || (inv.owner !== me(res) && inv.owner !== 'party')) throw new HttpError(404, 'Item not found');
    if (inv.qty < qty) throw new HttpError(409, `You have only ${inv.qty}`);
    if (one(db, `SELECT 1 FROM shop_orders WHERE inv_item_id = ? AND kind = 'sell' AND status = 'pending'`, inv.id)) throw new HttpError(409, 'That item is already offered for sale');
    const known = one<I.ItemRow>(db, 'SELECT * FROM shop_items WHERE world_id = ? AND name_key = ?', w, I.nameKey(inv.name));
    const pct = s.sell_pct ?? c.sellPct;
    const unit = known?.cost_cp !== null && known?.cost_cp !== undefined ? Math.floor((known.cost_cp * pct) / 100) : 0;
    const oid = newId('sho_');
    run(db, `INSERT INTO shop_orders (id, world_id, shop_id, item_id, kind, account_id, payer, dest, qty, unit_cp, total_cp, inv_item_id, item_name, status, note, created_at) VALUES (?, ?, ?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      oid, w, s.id, known?.id ?? null, me(res), inv.owner, inv.owner, qty, unit, unit * qty, inv.id, inv.name, str(b.note, 'note', { max: 300, optional: true }), now());
    const o = one<any>(db, 'SELECT * FROM shop_orders WHERE id = ?', oid)!;
    audit(db, w, me(res), 'shop.sell.request', `${s.name}: ${inv.name} x${qty}`);
    orderEvent(w, o);
    d.hub.emit(w, 'approval', { id: oid, kind: 'shop', status: 'pending' }, dmAnd(me(res)));
    res.status(202).json({ order: orderOut(res, o), pending: true });
  });

  const orderOut = (res: Response, o: any) => {
    const nm = names(db, o.world_id);
    const shop = one<any>(db, 'SELECT name, status FROM shops WHERE id = ?', o.shop_id);
    return {
      id: o.id, kind: o.kind, shopId: o.shop_id, shopName: shop && (isDM(res) || playerVisible(shop)) ? shop.name : 'A shop', itemName: o.item_name, qty: o.qty, unitCp: o.unit_cp, totalCp: o.total_cp,
      from: o.kind === 'buy' ? (o.payer === 'party' ? 'party' : 'self') : null, to: o.dest === 'party' ? 'party' : 'me', status: o.status, by: o.account_id, byName: nm[o.account_id] ?? 'Someone', at: o.created_at, decidedAt: o.decided_at,
    };
  };

  r.get('/orders', (req, res) => {
    const w = W(res);
    const status = String(req.query.status ?? '');
    const rows = isDM(res)
      ? all<any>(db, `SELECT * FROM shop_orders WHERE world_id = ? ${status ? 'AND status = ?' : ''} ORDER BY created_at DESC LIMIT 200`, ...(status ? [w, status] : [w]))
      : all<any>(db, `SELECT * FROM shop_orders WHERE world_id = ? AND account_id = ? ORDER BY created_at DESC LIMIT 100`, w, me(res));
    res.json({ orders: rows.map((o) => orderOut(res, o)), pending: isDM(res) ? one<any>(db, `SELECT count(*) AS n FROM shop_orders WHERE world_id = ? AND status = 'pending'`, w)!.n : rows.filter((o) => o.status === 'pending').length });
  });

  /** Undo a pending purchase: the held coin is released and the stock comes back. */
  function release(o: any, status: 'rejected' | 'cancelled', by: string) {
    tx(db, () => {
      if (o.ledger_id) run(db, `UPDATE ledger SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'`, by, now(), o.ledger_id);
      if (o.kind === 'buy' && o.stock_id) run(db, 'UPDATE shop_stock SET qty = qty + ? WHERE id = ? AND qty IS NOT NULL', o.qty, o.stock_id);
      run(db, 'UPDATE shop_orders SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?', status, now(), by, o.id);
    });
  }

  // The DM decides a pending purchase or sale: { action: approve | reject, priceCp? (a sale's total) }.
  r.post('/orders/:oid', requireDM, (req, res) => {
    const w = W(res);
    const o = one<any>(db, `SELECT * FROM shop_orders WHERE id = ? AND world_id = ?`, String(req.params.oid), w);
    if (!o) throw new HttpError(404, 'Order not found');
    if (o.status !== 'pending') throw new HttpError(409, 'This is not waiting for you');
    const action = oneOf(req.body?.action, 'action', ['approve', 'reject'] as const);
    const shop = one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ?', o.shop_id);
    if (action === 'reject') release(o, 'rejected', me(res));
    else if (o.kind === 'buy') {
      const it = o.item_id ? one<I.ItemRow>(db, 'SELECT * FROM shop_items WHERE id = ?', o.item_id) : null;
      tx(db, () => {
        if (o.ledger_id) run(db, `UPDATE ledger SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?`, me(res), now(), o.ledger_id);
        const got = deliver(w, o.dest, it ?? ({ name: o.item_name, rarity: 'mundane', type: 'other', attunement: 0, weight: null } as any), o.qty, o.account_id);
        run(db, `UPDATE shop_orders SET status = 'approved', inv_item_id = ?, decided_at = ?, decided_by = ? WHERE id = ?`, got.id, now(), me(res), o.id);
        o.delivered = got;
      });
      itemChanged(w, o.dest, o.delivered);
    } else {
      const total = req.body?.priceCp !== undefined ? int(req.body.priceCp, 'priceCp', { min: 0, max: 10_000_000_000 })! : o.total_cp;
      tx(db, () => {
        const inv = one<any>(db, `SELECT * FROM items WHERE id = ? AND world_id = ? AND status = 'approved'`, o.inv_item_id, w);
        if (!inv || inv.qty < o.qty) throw new HttpError(409, 'The seller no longer has that item');
        if (inv.qty === o.qty) run(db, 'DELETE FROM items WHERE id = ?', inv.id);
        else run(db, 'UPDATE items SET qty = qty - ?, updated_at = ?, updated_by = ? WHERE id = ?', o.qty, now(), me(res), inv.id);
        if (total > 0) run(db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')`, newId('led_'), w, o.payer, total, (o.payer === 'party' ? 'Shop sale (to the party pouch)' : `Sold ${o.item_name}${o.qty > 1 ? ` x${o.qty}` : ''}`).slice(0, 200), o.account_id, now());
        // What the shop bought goes on its shelves, when the item database knows it.
        if (o.item_id && shop) {
          const st = one<StockRow>(db, 'SELECT * FROM shop_stock WHERE shop_id = ? AND item_id = ?', shop.id, o.item_id);
          if (st) run(db, 'UPDATE shop_stock SET qty = CASE WHEN qty IS NULL THEN NULL ELSE qty + ? END WHERE id = ?', o.qty, st.id);
          else run(db, 'INSERT INTO shop_stock (id, shop_id, world_id, item_id, price_cp, qty, base_qty, hidden, dm_note, sort) VALUES (?, ?, ?, ?, NULL, ?, 0, 0, ?, 9999)', newId('stk_'), shop.id, w, o.item_id, o.qty, 'Bought from the party');
        }
        run(db, `UPDATE shop_orders SET status = 'approved', total_cp = ?, decided_at = ?, decided_by = ? WHERE id = ?`, total, now(), me(res), o.id);
        o.total_cp = total;
      });
      if (total > 0) coinChanged(w, o.payer, o.account_id);
      d.hub.emit(w, 'item-removed', { id: o.inv_item_id }, o.payer === 'party' ? (v) => v.role === 'dm' || v.role === 'player' : dmAnd(o.payer));
    }
    if (o.kind === 'buy' && o.ledger_id) coinChanged(w, o.payer, o.account_id);
    audit(db, w, me(res), `shop.order.${action}`, `${o.kind} ${o.item_name} x${o.qty}`);
    if (shop) shopEvent(w, shop);
    const after = one<any>(db, 'SELECT * FROM shop_orders WHERE id = ?', o.id)!;
    orderEvent(w, after);
    d.hub.emit(w, 'approval', { id: o.id, kind: 'shop', status: after.status }, dmAnd(o.account_id));
    res.json(orderOut(res, after));
  });

  // A player takes back their own pending request.
  r.post('/orders/:oid/cancel', (req, res) => {
    const w = W(res);
    const o = one<any>(db, `SELECT * FROM shop_orders WHERE id = ? AND world_id = ?`, String(req.params.oid), w);
    if (!o || (!isDM(res) && o.account_id !== me(res))) throw new HttpError(404, 'Order not found');
    if (o.status !== 'pending') throw new HttpError(409, 'This is no longer waiting');
    release(o, 'cancelled', me(res));
    if (o.ledger_id) coinChanged(w, o.payer, o.account_id);
    const shop = one<ShopRow>(db, 'SELECT * FROM shops WHERE id = ?', o.shop_id);
    if (shop) shopEvent(w, shop);
    const after = one<any>(db, 'SELECT * FROM shop_orders WHERE id = ?', o.id)!;
    orderEvent(w, after);
    res.json(orderOut(res, after));
  });

  return r;
}

const feature: Feature = {
  id: 'shop',
  schema: I.SCHEMA + SHOP_SCHEMA,
  settings: {
    shopApproval: { type: 'boolean', default: false },
    shopPartyPay: { type: 'boolean', default: true },
    shopSellBack: { type: 'boolean', default: false },
    shopSellBackPct: { type: 'int', default: 50, min: 0, max: 100 },
  },
  worldMount: 'shop',
  worldRoutes: routes,
  mcpTools: [
    {
      name: 'search_items', dmOnly: true,
      description: "Search the world's item database (what shops can stock: the SRD's generic items plus the DM's own and imported ones) by words, type (weapon, armor, shield, ammunition, gear, tool, potion, scroll, ring, rod, staff, wand, wondrous item, mount, food, other) and rarity (mundane, common, uncommon, rare, very rare, legendary, artifact, varies). Each item has an id, a cost in copper and DM notes.",
      props: { q: S('Words in the name, category or properties'), type: S('Item type'), rarity: S('Rarity'), limit: N('How many (default 20)') },
      call: (a) => ({ method: 'GET', path: `/shop/items${qs({ q: a.q, type: a.type, rarity: a.rarity, limit: a.limit ?? 20 })}` }),
    },
    {
      name: 'list_shops',
      description: "List the world's shops. The DM sees every shop with its status (hidden, closed, open), keeper and markup; a player sees the shops that are not hidden.",
      props: {},
      call: () => ({ method: 'GET', path: '/shop/shops' }),
    },
    {
      name: 'read_shop',
      description: "One shop: its keeper card and its stock with prices in copper and quantities (a player sees an open shop's visible stock only).",
      props: { shop: S('Shop id (from list_shops)') }, required: ['shop'],
      call: (a) => ({ method: 'GET', path: `/shop/shops/${enc(String(a.shop ?? ''))}` }),
    },
    {
      name: 'create_item', write: true,
      description: "Add a custom item to the world's item database. cost is a price like \"15 gp\" or \"2 sp\". dm_notes stay DM-only.",
      props: { name: S('Item name'), type: S('weapon, armor, shield, ammunition, gear, tool, potion, scroll, ring, rod, staff, wand, wondrous item, mount, food or other'), rarity: S('mundane, common, uncommon, rare, very rare, legendary or artifact'), cost: S('Price, e.g. "250 gp"'), weight: { type: 'number', description: 'Weight in pounds' }, description: S('What it is and does'), properties: S('Short stats, e.g. "Damage: 1d8 slashing; Versatile"'), attunement: B('Requires attunement'), tags: { type: 'array', items: { type: 'string' } }, dm_notes: S('DM-only notes') },
      required: ['name'],
      call: (a) => ({ method: 'POST', path: '/shop/items', body: { name: a.name, type: a.type, rarity: a.rarity, cost: a.cost, weight: a.weight, description: a.description, properties: a.properties, attunement: a.attunement, tags: a.tags, dmNotes: a.dm_notes } }),
    },
    {
      name: 'edit_item', write: true,
      description: 'Change an item in the item database (only the fields given). Find its id with search_items. Shops that stock it update at once.',
      props: { item: S('Item id'), name: S('New name'), type: S('Type'), rarity: S('Rarity'), cost: S('Price, e.g. "250 gp"'), weight: { type: 'number' }, description: S('Description'), properties: S('Properties'), attunement: B('Requires attunement'), tags: { type: 'array', items: { type: 'string' } }, dm_notes: S('DM-only notes') },
      required: ['item'],
      call: (a) => ({ method: 'PATCH', path: `/shop/items/${enc(String(a.item ?? ''))}`, body: Object.fromEntries(Object.entries({ name: a.name, type: a.type, rarity: a.rarity, cost: a.cost, weight: a.weight, description: a.description, properties: a.properties, attunement: a.attunement, tags: a.tags, dmNotes: a.dm_notes }).filter(([, v]) => v !== undefined)) }),
    },
    {
      name: 'generate_shop', write: true,
      description: 'Generate a shop (no model needed) and save it, hidden from players until opened: kind general, blacksmith, alchemist, magic, tavern or fence; settlement size hamlet, village, town, city or metropolis; party level 1-20 (default: the party). Stock is drawn from the item database (rarity limited by size and level), the shopkeeper comes from the NPC generator. A theme or guide steers it ("12 items", "markup 20%", "no magic", "max rarity rare", or words like "elven", "fire").',
      props: { kind: S('Shop kind', { enum: [...SHOP_KINDS] }), size: S('Settlement size', { enum: [...SIZES] }), level: N('Party level 1-20'), theme: S('Optional theme words'), guide: S('Optional instructions that steer the shop'), name: S('Optional shop name'), seed: S('Optional seed'), open: B('Open it to players at once') },
      call: (a) => ({ method: 'POST', path: '/shop/generate', body: { kind: a.kind ?? 'general', size: a.size ?? 'town', level: a.level, theme: a.theme, guide: a.guide, name: a.name, seed: a.seed, save: true, status: a.open === true ? 'open' : 'hidden' } }),
    },
    {
      name: 'create_shopkeeper', write: true,
      description: "Make a shopkeeper with the NPC generator (name, race, look, voice, personality, and a DM-only secret). With a shop id it becomes that shop's keeper; with save_page it is also saved as a DM-only NPC page in the library.",
      props: { shop: S('Optional shop id to give the keeper to'), kind: S('Shop kind, for the keeper\'s trade'), race: S('Optional race'), gender: S('male, female or any'), seed: S('Optional seed'), save_page: B('Also save a DM-only NPC page (needs a shop)') },
      call: (a) => ({ method: 'POST', path: '/shop/keeper', body: { shopId: a.shop, kind: a.kind, race: a.race, gender: a.gender, seed: a.seed, savePage: a.save_page === true } }),
    },
    {
      name: 'stock_shop', write: true,
      description: 'Add items from the item database to a shop (an item it already has adds to that line), or restock it (every line back to its usual quantity). qty empty means unlimited; price_cp overrides the price for this shop.',
      props: { shop: S('Shop id'), items: { type: 'array', items: { type: 'object', properties: { item_id: { type: 'string' }, qty: { type: 'integer' }, price_cp: { type: 'integer' }, hidden: { type: 'boolean' } } }, description: 'Items to add' }, restock: B('Restock instead of adding') },
      required: ['shop'],
      call: (a) => (a.restock === true || !Array.isArray(a.items) || !a.items.length
        ? { method: 'POST', path: `/shop/shops/${enc(String(a.shop ?? ''))}/restock`, body: {} }
        : { method: 'POST', path: `/shop/shops/${enc(String(a.shop ?? ''))}/stock`, body: { items: a.items.map((x: any) => ({ itemId: x.item_id ?? x.itemId, qty: x.qty, priceCp: x.price_cp ?? x.priceCp, hidden: x.hidden })) } }),
    },
    {
      name: 'set_shop_status', write: true,
      description: 'Open a shop to players, close it (players see it closed, no stock) or hide it from players entirely.',
      props: { shop: S('Shop id'), status: S('open, closed or hidden', { enum: ['open', 'closed', 'hidden'] }) },
      required: ['shop', 'status'],
      call: (a) => ({ method: 'POST', path: `/shop/shops/${enc(String(a.shop ?? ''))}/status`, body: { status: a.status } }),
    },
  ],
};
export default feature;
