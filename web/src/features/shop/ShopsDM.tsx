// DM page: Shops. Every shop with its status (hidden, closed, open: changed
// live), its keeper card, its stock with prices and quantities, the shop
// generator, purchases and sales waiting for approval, and the shop settings.
// "Show on players' TV" sends the stock as a stage card. Towns set a price
// level for every shop in them; each shop has a keeper's purse, a barter
// percent, and a memory of every player (reputation, spending, haggles, deals);
// "Send to players" pops the shop up on chosen players' screens.
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { coins, parseCoins, when } from '../../lib/format.ts';
import { Empty, ErrorBox, Field, Loading, PageHead, Switch, Tabs, useAction, useToast } from '../../ui/index.tsx';
import { PagePicker } from '../itemcards/PagePicker.tsx';
import { rarityLabel, STATUS_LABEL, statusChip, type Item, type Keeper, type Line, type Memory, type Order, type Shop, type ShopConfig, type Town } from './types.ts';
import './shop.css';

type Tab = 'shops' | 'towns' | 'generate' | 'orders' | 'settings';

export default function ShopsDM() {
  const { w } = useWorld();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'shops';
  const setTab = (t: Tab, extra: Record<string, string> = {}) => setSp({ ...(t === 'shops' ? {} : { tab: t }), ...extra });
  const cfg = useLoad<ShopConfig>(() => w.call('GET', '/shop/config'), [w], ['settings']);
  const orders = useLoad<{ orders: Order[]; pending: number }>(() => w.call('GET', '/shop/orders'), [w], ['shop-order']);
  return (
    <div className="page shop-page">
      <PageHead title="Shops" lead={<>Shops players can browse and buy from. Stock comes from the <Link to="../items">item database</Link>.</>} />
      <Tabs label="Shops" value={tab} onChange={(t) => setTab(t)} items={[['shops', 'Shops'], ['towns', 'Towns'], ['generate', 'Generate'], ['orders', `Orders${orders.data?.pending ? ` (${orders.data.pending})` : ''}`], ['settings', 'Settings']]} />
      {!cfg.data ? <Loading /> : tab === 'generate' ? <Generate cfg={cfg.data} onSaved={(id) => setTab('shops', { shop: id })} /> : tab === 'towns' ? <Towns cfg={cfg.data} /> : tab === 'orders' ? <Orders list={orders.data?.orders ?? null} reload={orders.reload} /> : tab === 'settings' ? <Settings cfg={cfg.data} reload={cfg.reload} /> : <ShopList cfg={cfg.data} sel={sp.get('shop') ?? ''} pick={(id) => setSp(id ? { shop: id } : {})} />}
    </div>
  );
}

function ShopList({ cfg, sel, pick }: { cfg: ShopConfig; sel: string; pick: (id: string) => void }) {
  const { w } = useWorld();
  const list = useLoad<{ shops: Shop[] }>(() => w.call('GET', '/shop/shops'), [w], ['shop']);
  const act = useAction();
  const create = () => act.run(async () => { const s = await w.call<Shop>('POST', '/shop/shops', { name: 'New shop', kind: 'general', status: 'hidden' }); await list.reload(); pick(s.id); });
  if (!list.data) return <><ErrorBox error={list.error} />{!list.error && <Loading />}</>;
  const shops = list.data.shops;
  return (
    <div className="cols">
      <nav className="col-1 stack" aria-label="Shops">
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn" disabled={act.busy} onClick={() => void create()}>New shop</button>
          <Link className="btn ghost" to="?tab=generate">Generate…</Link>
        </div>
        <ErrorBox error={act.error} />
        {!shops.length && <Empty>No shops yet. Generate one, or start an empty one.</Empty>}
        {shops.map((s) => (
          <button key={s.id} type="button" className={`card shop-pick${s.id === sel ? ' on' : ''}`} data-testid="dm-shop" onClick={() => pick(s.id === sel ? '' : s.id)}>
            <div className="row between"><strong>{s.name}</strong><span className={statusChip(s.status)}>{STATUS_LABEL[s.status]}</span></div>
            <span className="small muted">{s.kindLabel}{s.keeper?.name ? ` · ${s.keeper.name}` : ''} · {s.stockCount ?? 0} lines</span>
          </button>
        ))}
      </nav>
      <div className="col-2 stack loose">{sel ? <ShopEditor key={sel} id={sel} cfg={cfg} onGone={() => pick('')} /> : shops.length ? <Empty>Pick a shop to edit its stock and keeper, or open it to players.</Empty> : null}</div>
    </div>
  );
}

function ShopEditor({ id, cfg, onGone }: { id: string; cfg: ShopConfig; onGone: () => void }) {
  const { w, info } = useWorld();
  const shop = useLoad<Shop>(() => w.call('GET', `/shop/shops/${encodeURIComponent(id)}`), [w, id], ['shop', 'shop-items']);
  const towns = useLoad<{ towns: Town[] }>(() => w.call('GET', '/shop/towns'), [w], ['shop-towns']);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [form, setForm] = useState<Shop | null>(null);
  const [dirty, setDirty] = useState(false);
  // Live changes refresh the form, unless the DM is in the middle of editing it.
  useEffect(() => { if (shop.data) setForm((f) => (f && f.id === shop.data!.id && dirty ? f : shop.data)); }, [shop.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!shop.data || !form) return <section className="card"><ErrorBox error={shop.error} />{!shop.error && <Loading />}</section>;
  const s = shop.data;
  const money = (cp: number | null | undefined) => (cp === null || cp === undefined ? '—' : coins(cp, info.settings.coins));
  const upd = (patch: Partial<Shop>) => { setForm({ ...form, ...patch }); setDirty(true); };
  const updK = (patch: Partial<Keeper>) => upd({ keeper: { ...(form.keeper ?? {}), ...patch } });
  const path = `/shop/shops/${encodeURIComponent(s.id)}`;
  const run = (fn: () => Promise<unknown>, msg?: string) => act.run(async () => { await fn(); await shop.reload(); if (msg) toast(msg); });
  const save = () => run(async () => {
    await w.call('PATCH', path, { name: form.name, kind: form.kind, description: form.description, markupPct: form.markupPct ?? 0, haggle: form.haggle, dmNotes: form.dmNotes, locationPageId: form.locationPageId ?? null, keeper: form.keeper ?? {}, restock: form.restock, sellPct: form.sellPct ?? null, townId: form.townId ?? null, goldCp: form.goldCp ?? null, barterPct: form.barterPct ?? 0 });
    setDirty(false);
  }, 'Saved');
  const status = (st: Shop['status']) => run(() => w.call('POST', `${path}/status`, { status: st }), st === 'open' ? 'Open: players can buy now' : st === 'closed' ? 'Closed: players see the sign, not the stock' : 'Hidden from players');
  const line = (l: Line, patch: Record<string, unknown>) => run(() => w.call('PATCH', `${path}/stock/${l.id}`, patch));

  return (
    <>
      <section className="card stack" aria-labelledby="se-h">
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <h2 id="se-h" style={{ margin: 0 }}>{s.name}</h2>
          <div className="shop-status" role="group" aria-label="Status">
            {(['hidden', 'closed', 'open'] as const).map((st) => <button key={st} type="button" data-testid={`shop-status-${st}`} className={s.status === st ? 'on' : ''} aria-pressed={s.status === st} disabled={act.busy} onClick={() => void status(st)}>{STATUS_LABEL[st]}</button>)}
          </div>
        </div>
        <span className="small muted">{s.status === 'open' ? 'Players see this shop and can buy.' : s.status === 'closed' ? 'Players see the shop is closed; no stock is shown.' : 'Players do not know this shop exists.'}</span>
        <div className="shop-grid">
          <Field label="Name"><input value={form.name} maxLength={120} onChange={(e) => upd({ name: e.target.value })} /></Field>
          <Field label="Kind"><select value={form.kind} onChange={(e) => upd({ kind: e.target.value })}>{cfg.kinds.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select></Field>
          <Field label="Markup %" help="Negative for a discount. A line's own price wins."><input type="number" min={-90} max={1000} value={form.markupPct ?? 0} onChange={(e) => upd({ markupPct: Math.round(Number(e.target.value) || 0) })} /></Field>
          <Field label="Town" help={s.town ? `Prices there: ${(s.town.pricePct ?? 0) > 0 ? '+' : ''}${s.town.pricePct ?? 0}%` : 'A town sets a price level for all its shops.'}>
            <select value={form.townId ?? ''} data-testid="shop-town-pick" onChange={(e) => upd({ townId: e.target.value || null })}><option value="">No town</option>{(towns.data?.towns ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.pricePct > 0 ? '+' : ''}{t.pricePct}%)</option>)}</select>
          </Field>
          <Field label="Keeper's purse" help="What they can pay for things players sell. Blank: never runs out."><input type="text" aria-label="Keeper's purse" defaultValue={form.goldCp === null || form.goldCp === undefined ? '' : coins(form.goldCp, 'gsc')} key={`gold-${s.goldCp}`} placeholder="∞" onBlur={(e) => { const v = e.target.value.trim(); const cp = v ? parseCoins(v) : null; if (v && cp === null) return; if (cp !== (form.goldCp ?? null)) upd({ goldCp: cp }); }} /></Field>
          <Field label="Haggles up to %" help="0: never haggles. Reputation moves it by up to 10 points."><input type="number" min={0} max={90} value={form.barterPct ?? 0} onChange={(e) => upd({ barterPct: Math.max(0, Math.min(90, Math.round(Number(e.target.value) || 0))) })} /></Field>
          <Field label="Restock">
            <select value={form.restock?.rule ?? 'manual'} onChange={(e) => upd({ restock: { ...(form.restock ?? { days: 7, at: null }), rule: e.target.value as 'manual' | 'days' } })}><option value="manual">By hand</option><option value="days">Every few game days</option></select>
          </Field>
          {form.restock?.rule === 'days' && <Field label="Every (game days)"><input type="number" min={1} max={3650} value={form.restock.days} onChange={(e) => upd({ restock: { ...form.restock!, days: Math.max(1, Math.floor(Number(e.target.value) || 1)) } })} /></Field>}
          {cfg.sellBack && <Field label="Buys back at %" help={`Blank: the world's ${cfg.sellPct}%`}><input type="number" min={0} max={100} value={form.sellPct ?? ''} onChange={(e) => upd({ sellPct: e.target.value === '' ? null : Math.max(0, Math.min(100, Math.round(Number(e.target.value)))) })} /></Field>}
        </div>
        <Field label="Description (players see it)"><textarea rows={2} maxLength={2000} value={form.description} onChange={(e) => upd({ description: e.target.value })} /></Field>
        <Field label="Location" help="A library page; players see it only if they can open that page."><PagePicker value={form.locationPageId ?? null} onChange={(v) => upd({ locationPageId: v })} /></Field>
        <Field label="Haggle note (DM only)"><input value={form.haggle ?? ''} maxLength={1000} onChange={(e) => upd({ haggle: e.target.value })} /></Field>
        <Field label="DM notes (DM only)"><textarea rows={2} maxLength={4000} value={form.dmNotes ?? ''} onChange={(e) => upd({ dmNotes: e.target.value })} /></Field>
        <h3 style={{ margin: 0 }}>Shopkeeper</h3>
        <div className="shop-grid">
          <Field label="Name"><input value={form.keeper?.name ?? ''} maxLength={120} onChange={(e) => updK({ name: e.target.value })} /></Field>
          <Field label="Race"><input value={form.keeper?.race ?? ''} maxLength={60} onChange={(e) => updK({ race: e.target.value })} /></Field>
          <Field label="Trade"><input value={form.keeper?.role ?? ''} maxLength={80} onChange={(e) => updK({ role: e.target.value })} /></Field>
        </div>
        <Field label="Look"><textarea rows={2} value={form.keeper?.look ?? ''} maxLength={1000} onChange={(e) => updK({ look: e.target.value })} /></Field>
        <div className="shop-grid">
          <Field label="Voice"><input value={form.keeper?.voice ?? ''} maxLength={600} onChange={(e) => updK({ voice: e.target.value })} /></Field>
          <Field label="Personality"><input value={form.keeper?.personality ?? ''} maxLength={600} onChange={(e) => updK({ personality: e.target.value })} /></Field>
        </div>
        <Field label="Secret (DM only)"><textarea rows={2} value={form.keeper?.secret ?? ''} maxLength={2000} onChange={(e) => updK({ secret: e.target.value })} /></Field>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn primary" disabled={act.busy || !dirty} onClick={() => void save()}>Save</button>
          <button type="button" className="btn" disabled={act.busy} onClick={() => void run(async () => { await w.call('POST', '/shop/keeper', { shopId: s.id, kind: s.kind }); setDirty(false); }, 'A new shopkeeper')}>New keeper</button>
          <button type="button" className="btn" disabled={act.busy || !s.keeper?.name} onClick={() => void run(() => w.call('POST', `${path}/keeper-page`), 'Saved as a DM-only NPC page')}>{s.keeper?.pageId ? 'Update NPC page' : 'Save keeper as NPC page'}</button>
          {s.keeper?.pageId && <Link className="btn ghost" to={`/w/${info.slug}/dm/library?page=${encodeURIComponent(s.keeper.pageId)}`}>Open NPC page</Link>}
        </div>
        <ErrorBox error={act.error} />
      </section>

      <section className="card stack" aria-labelledby="stock-h">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
          <h2 id="stock-h">Stock</h2>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn small" disabled={act.busy} onClick={() => void run(() => w.call('POST', `${path}/restock`), 'Restocked')}>Restock now</button>
            <button type="button" className="btn small" disabled={act.busy} onClick={() => void run(() => w.call('POST', `${path}/stage`, { show: false }), 'Staged: it is on the stage, not shown yet')}>Stage it</button>
            <button type="button" className="btn small primary" data-testid="shop-show-tv" disabled={act.busy} onClick={() => void run(() => w.call('POST', `${path}/stage`, { show: true }), 'Shown on the players’ TV')}>Show on players’ TV</button>
          </div>
        </div>
        {!s.stock.length ? <Empty>Nothing on the shelves. Add items below.</Empty> : (
          <div className="shop-scroll">
            <table className="shop-table">
              <thead><tr><th>Item</th><th className="wide">Cost</th><th>Price</th><th>Qty</th><th className="wide">Usual</th><th>Hidden</th><th /></tr></thead>
              <tbody>
                {s.stock.map((l) => (
                  <tr key={l.id} className={l.hidden ? 'hid' : ''} data-testid="dm-stock-line">
                    <td><strong>{l.name}</strong><div className="tiny muted">{[rarityLabel(l.rarity), l.type].filter(Boolean).join(' · ')}{l.dmNote ? ` · ${l.dmNote}` : ''}</div></td>
                    <td className="wide small">{money(l.costCp)}</td>
                    <td><input type="text" aria-label={`Price of ${l.name}`} defaultValue={l.priceOverrideCp !== null && l.priceOverrideCp !== undefined ? coins(l.priceOverrideCp, 'gsc') : ''} placeholder={money(l.priceCp)} onBlur={(e) => { const v = e.target.value.trim(); const cp = v ? parseCoins(v) : null; if (v && cp === null) return; if (cp !== (l.priceOverrideCp ?? null)) void line(l, { priceCp: cp }); }} /></td>
                    <td><input type="number" min={0} aria-label={`Quantity of ${l.name}`} defaultValue={l.qty ?? ''} placeholder="∞" onBlur={(e) => { const v = e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))); if (v !== l.qty) void line(l, { qty: v, baseQty: v }); }} /></td>
                    <td className="wide small">{l.baseQty ?? '∞'}</td>
                    <td><input type="checkbox" aria-label={`Hide ${l.name} from players`} checked={!!l.hidden} onChange={(e) => void line(l, { hidden: e.target.checked })} /></td>
                    <td><button type="button" className="btn ghost small" aria-label={`Take ${l.name} off the shelves`} onClick={() => void run(() => w.call('DELETE', `${path}/stock/${l.id}`))}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <AddStock onAdd={(itemId, qty) => run(() => w.call('POST', `${path}/stock`, { itemId, qty }), 'Added')} />
      </section>
      <SendToPlayers shop={s} onDone={(m) => { toast(m); void shop.reload(); }} />
      <KeeperMemory shop={s} />
      <section className="card row between">
        <span className="small muted">{s.restock?.at ? `Last restocked ${when(s.restock.at)}` : 'Not restocked yet'}</span>
        <button type="button" className="btn ghost small" disabled={act.busy} onClick={() => { if (confirm(`Delete ${s.name}? Its stock lines go too; the items stay in the item database.`)) void act.run(async () => { await w.call('DELETE', path); onGone(); }); }}>Delete shop</button>
      </section>
      {toastNode}
    </>
  );
}

function AddStock({ onAdd }: { onAdd: (itemId: string, qty: number | null) => Promise<unknown> }) {
  const { w, info } = useWorld();
  const [q, setQ] = useState('');
  const [qty, setQty] = useState('1');
  const [hits, setHits] = useState<Item[]>([]);
  useEffect(() => {
    if (!q.trim()) { setHits([]); return; }
    let live = true;
    const t = setTimeout(() => { w.call<{ items: Item[] }>('GET', `/shop/items?q=${encodeURIComponent(q.trim())}&limit=12`).then((r) => { if (live) setHits(r.items); }).catch(() => {}); }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [w, q]);
  return (
    <div className="stack tight">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input type="search" placeholder="Add from the item database…" aria-label="Find an item to stock" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 200px' }} />
        <input type="number" min={0} aria-label="How many to add (blank: unlimited)" placeholder="∞" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 80 }} />
      </div>
      {!!hits.length && <ul className="stack tight" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {hits.map((it) => (
          <li key={it.id} className="row between">
            <span className="small">{it.name} <span className="tiny muted">{[rarityLabel(it.rarity), it.type, it.costCp === null ? 'no price' : coins(it.costCp, info.settings.coins)].filter(Boolean).join(' · ')}</span></span>
            <button type="button" className="btn small" onClick={() => void onAdd(it.id, qty === '' ? null : Math.max(0, Math.floor(Number(qty) || 0)))}>Add</button>
          </li>
        ))}
      </ul>}
    </div>
  );
}

interface Draft { seed: string; kind: string; kindLabel: string; size: string; level: number; name: string; description: string; keeper: Keeper; markupPct: number; haggle: string; maxRarity: string; goldCp: number; barterPct: number; stock: { itemId: string; name: string; type: string; rarity: string; priceCp: number | null; qty: number | null; hidden: boolean }[]; notes: string[]; enriched: boolean }

function Generate({ cfg, onSaved }: { cfg: ShopConfig; onSaved: (id: string) => void }) {
  const { w, info } = useWorld();
  const [o, setO] = useState({ kind: 'general', size: 'town', townId: '', level: '', theme: '', guide: '', enrich: false, open: false });
  const towns = useLoad<{ towns: Town[] }>(() => w.call('GET', '/shop/towns'), [w], ['shop-towns']);
  const [draft, setDraft] = useState<Draft | null>(null);
  const act = useAction();
  const body = (seed?: string) => ({ kind: o.kind, size: o.townId ? undefined : o.size, townId: o.townId || undefined, level: o.level === '' ? undefined : Number(o.level), theme: o.theme || undefined, guide: o.guide || undefined, enrich: o.enrich, seed });
  const gen = (seed?: string) => act.run(async () => { const r = await w.call<{ draft: Draft }>('POST', '/shop/generate', body(seed)); setDraft(r.draft); });
  const save = () => act.run(async () => {
    if (!draft) return;
    // Saving regenerates from the same seed, so the shop matches the draft; the model's wording (if any) is kept as edits.
    const r = await w.call<{ shop: Shop }>('POST', '/shop/generate', { ...body(draft.seed), enrich: false, save: true, status: o.open ? 'open' : 'hidden' });
    if (draft.enriched) await w.call('PATCH', `/shop/shops/${r.shop.id}`, { description: draft.description, keeper: draft.keeper });
    onSaved(r.shop.id);
  });
  return (
    <div className="stack loose">
      <section className="card stack">
        <div className="shop-grid">
          <Field label="Kind"><select value={o.kind} data-testid="gen-kind" onChange={(e) => setO({ ...o, kind: e.target.value })}>{cfg.kinds.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select></Field>
          <Field label="Town" help="Optional: the shop joins it and takes its size."><select value={o.townId} onChange={(e) => setO({ ...o, townId: e.target.value })}><option value="">No town</option>{(towns.data?.towns ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          {!o.townId && <Field label="Settlement"><select value={o.size} data-testid="gen-size" onChange={(e) => setO({ ...o, size: e.target.value })}>{cfg.sizes.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</select></Field>}
          <Field label="Party level" help="Blank: the party's level"><input type="number" min={1} max={20} value={o.level} onChange={(e) => setO({ ...o, level: e.target.value })} /></Field>
          <Field label="Theme (optional)"><input value={o.theme} maxLength={200} placeholder="elven, fire, sailors…" onChange={(e) => setO({ ...o, theme: e.target.value })} /></Field>
        </div>
        <Field label="Guide (optional)" help={'Instructions that steer it: "12 items", "markup 20%", "no magic", "max rarity rare", or a template.'}><textarea rows={2} maxLength={8000} value={o.guide} onChange={(e) => setO({ ...o, guide: e.target.value })} /></Field>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          {cfg.model && <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={o.enrich} onChange={(e) => setO({ ...o, enrich: e.target.checked })} /> Let the chat model improve the wording</label>}
          <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={o.open} onChange={(e) => setO({ ...o, open: e.target.checked })} /> Open it to players when saved</label>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn primary" data-testid="gen-go" disabled={act.busy} onClick={() => void gen(draft?.seed)}>Generate</button>
          {draft && <button type="button" className="btn" disabled={act.busy} onClick={() => void gen(Math.random().toString(36).slice(2, 8))}>Reroll</button>}
        </div>
        <ErrorBox error={act.error} />
      </section>
      {draft && (
        <section className="card stack" data-testid="gen-draft">
          <div className="row between"><h2 style={{ margin: 0 }}>{draft.name}</h2><span className="chip">seed {draft.seed}</span></div>
          <span className="small muted">{draft.kindLabel} in a {draft.size}, party level {draft.level}, up to {draft.maxRarity} · markup {draft.markupPct}% · purse {coins(draft.goldCp, info.settings.coins)} · haggles up to {draft.barterPct}%{draft.enriched ? ' · wording by the model' : ''}</span>
          <p className="read" style={{ margin: 0 }}>{draft.description}</p>
          <div className="shop-keeper stack tight">
            <strong>{draft.keeper.name}, {draft.keeper.role}, {draft.keeper.race}</strong>
            <span className="small">{draft.keeper.look}</span>
            <span className="small muted">{draft.keeper.voice} {draft.keeper.personality}</span>
            <span className="tiny" style={{ color: 'var(--danger-text)' }}>Secret (DM only): {draft.keeper.secret}</span>
          </div>
          <span className="small">Haggle (DM only): {draft.haggle}</span>
          {draft.notes.map((n) => <span key={n} className="small" style={{ color: 'var(--danger-text)' }}>{n}</span>)}
          <div className="shop-scroll"><table className="shop-table"><thead><tr><th>Item</th><th>Price</th><th>Qty</th></tr></thead><tbody>
            {draft.stock.map((l) => <tr key={l.itemId} className={l.hidden ? 'hid' : ''}><td>{l.name}<div className="tiny muted">{[rarityLabel(l.rarity), l.type, l.hidden ? 'under the counter (hidden)' : ''].filter(Boolean).join(' · ')}</div></td><td>{l.priceCp === null ? '—' : coins(l.priceCp, info.settings.coins)}</td><td>{l.qty ?? '∞'}</td></tr>)}
          </tbody></table></div>
          <div className="row" style={{ gap: 8 }}><button type="button" className="btn primary" data-testid="gen-save" disabled={act.busy} onClick={() => void save()}>Save shop</button></div>
        </section>
      )}
    </div>
  );
}

function Orders({ list, reload }: { list: Order[] | null; reload: () => Promise<void> }) {
  const { w, info } = useWorld();
  const act = useAction();
  const [price, setPrice] = useState<Record<string, string>>({});
  if (!list) return <Loading />;
  const pending = list.filter((o) => o.status === 'pending');
  const done = list.filter((o) => o.status !== 'pending');
  const decide = (o: Order, action: 'approve' | 'reject') => act.run(async () => {
    const p = price[o.id];
    await w.call('POST', `/shop/orders/${o.id}`, { action, ...(o.kind === 'sell' && p !== undefined && p !== '' ? { priceCp: parseCoins(p) ?? o.totalCp } : {}) });
    await reload();
  });
  return (
    <div className="stack loose">
      <ErrorBox error={act.error} />
      <section className="card stack">
        <h2>Waiting for you</h2>
        {!pending.length ? <Empty>Nothing waiting. Turn on "DM approves shop purchases" in Settings to check purchases first.</Empty> : pending.map((o) => (
          <div key={o.id} className="row between" style={{ flexWrap: 'wrap', gap: 8 }} data-testid="shop-order">
            <span className="small"><strong>{o.byName}</strong> {o.kind === 'buy' ? 'buys' : 'sells'} {o.itemName}{o.qty > 1 ? ` ×${o.qty}` : ''} {o.kind === 'buy' ? 'from' : 'to'} {o.shopName} for {coins(o.totalCp, info.settings.coins)}{o.kind === 'buy' ? ` (${o.from === 'party' ? 'party pouch' : 'own coin'}, to ${o.to === 'party' ? 'the party stash' : 'their pack'})` : ''}</span>
            <span className="row" style={{ gap: 6 }}>
              {o.kind === 'sell' && <input type="text" aria-label="Price paid" placeholder={coins(o.totalCp, 'gsc')} value={price[o.id] ?? ''} onChange={(e) => setPrice({ ...price, [o.id]: e.target.value })} style={{ width: 100 }} />}
              <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void decide(o, 'approve')}>Approve</button>
              <button type="button" className="btn small" disabled={act.busy} onClick={() => void decide(o, 'reject')}>Reject</button>
            </span>
          </div>
        ))}
      </section>
      <section className="card stack">
        <h2>Recent</h2>
        {!done.length ? <Empty>No purchases yet.</Empty> : <ul className="stack tight" style={{ listStyle: 'none', padding: 0, margin: 0 }}>{done.slice(0, 60).map((o) => <li key={o.id} className="small">{when(o.decidedAt ?? o.at)}: {o.byName} {o.kind === 'buy' ? 'bought' : 'sold'} {o.itemName}{o.qty > 1 ? ` ×${o.qty}` : ''} at {o.shopName} for {coins(o.totalCp, info.settings.coins)}{o.from === 'party' ? ' (party pouch)' : ''}{o.status !== 'approved' ? ` · ${o.status}` : ''}</li>)}</ul>}
      </section>
    </div>
  );
}

function Settings({ cfg, reload }: { cfg: ShopConfig; reload: () => Promise<void> }) {
  const { w, reloadInfo } = useWorld();
  const act = useAction();
  const [pct, setPct] = useState(String(cfg.sellPct));
  const [rep, setRep] = useState(String(cfg.repEffect ?? 10));
  const set = (patch: Record<string, unknown>) => act.run(async () => { await w.updateSettings(patch); await reloadInfo(); await reload(); });
  return (
    <section className="card stack">
      <ErrorBox error={act.error} />
      <div className="row between"><span><strong>DM approves shop purchases</strong><br /><span className="small muted">A purchase waits for you; the coin is held and the stock kept aside.</span></span><Switch checked={cfg.approval} label="DM approves shop purchases" onChange={(v) => void set({ shopApproval: v })} /></div>
      <div className="row between"><span><strong>The party pouch can pay shops</strong><br /><span className="small muted">Needs the party pouch on. The log shows only "Shop purchase (paid by …)".</span></span><Switch checked={cfg.partyPay} label="The party pouch can pay shops" onChange={(v) => void set({ shopPartyPay: v })} /></div>
      <div className="row between"><span><strong>Players can sell to shops</strong><br /><span className="small muted">A sale is a request you approve (and may re-price).</span></span><Switch checked={cfg.sellBack} label="Players can sell to shops" onChange={(v) => void set({ shopSellBack: v })} /></div>
      <div className="row between"><span><strong>Players can haggle</strong><br /><span className="small muted">A player asks a keeper for a percentage off one thing; the keeper's haggle percent and the player's reputation decide it.</span></span><Switch checked={cfg.haggle !== false} label="Players can haggle" onChange={(v) => void set({ shopHaggle: v })} /></div>
      <Field label="Reputation moves prices by up to (%)" help="At the best reputation a player pays this much less; at the worst, this much more. 0 turns it off."><div className="row" style={{ gap: 8 }}><input type="number" min={0} max={50} value={rep} onChange={(e) => setRep(e.target.value)} style={{ width: 90 }} /><button type="button" className="btn small" disabled={act.busy} onClick={() => void set({ shopRepEffect: Math.max(0, Math.min(50, Math.round(Number(rep) || 0))) })}>Save</button></div></Field>
      {cfg.sellBack && <Field label="Shops buy at (% of their price)"><div className="row" style={{ gap: 8 }}><input type="number" min={0} max={100} value={pct} onChange={(e) => setPct(e.target.value)} style={{ width: 90 }} /><button type="button" className="btn small" disabled={act.busy} onClick={() => void set({ shopSellBackPct: Math.max(0, Math.min(100, Math.round(Number(pct) || 0))) })}>Save</button></div></Field>}
    </section>
  );
}

/** "Send to players": the shop pops up on chosen players' screens, as if its keeper walked up to them. */
function SendToPlayers({ shop, onDone }: { shop: Shop; onDone: (msg: string) => void }) {
  const { w, members } = useWorld();
  const players = members.filter((m) => m.role === 'player');
  const [to, setTo] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const act = useAction();
  const send = () => act.run(async () => {
    const r = await w.call<{ sentTo: string[]; opened: boolean }>('POST', `/shop/shops/${encodeURIComponent(shop.id)}/present`, { to: to.length ? to : 'all', message: msg || undefined, open: shop.status !== 'open' });
    onDone(`Sent to ${r.sentTo.length} player${r.sentTo.length === 1 ? '' : 's'}${r.opened ? ' (the shop is open now)' : ''}`);
    setMsg('');
  });
  return (
    <section className="card stack" aria-labelledby="send-h">
      <h2 id="send-h">Send to players</h2>
      <span className="small muted">The keeper walks up: the shop pops up on their screens with a button to browse.{shop.status !== 'open' ? ' Sending opens the shop.' : ''}</span>
      {!players.length ? <Empty>No players in this world yet.</Empty> : (
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          {players.map((p) => (
            <label key={p.id} className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={to.includes(p.id)} onChange={(e) => setTo(e.target.checked ? [...to, p.id] : to.filter((x) => x !== p.id))} />
              {p.character_name || p.display_name}
            </label>
          ))}
          <span className="tiny faint">{to.length ? '' : 'None ticked: everyone.'}</span>
        </div>
      )}
      <Field label="What the keeper says (optional)"><input value={msg} maxLength={300} placeholder="Fine wares, friend! Have a look." onChange={(e) => setMsg(e.target.value)} /></Field>
      <ErrorBox error={act.error} />
      <div className="row"><button type="button" className="btn primary" data-testid="shop-send" disabled={act.busy || !players.length} onClick={() => void send()}>Send</button></div>
    </section>
  );
}

/** What the keeper remembers about each player: reputation (editable), coin spent and sold, haggles, and deals (give or cancel one). */
function KeeperMemory({ shop }: { shop: Shop }) {
  const { w, info } = useWorld();
  const path = `/shop/shops/${encodeURIComponent(shop.id)}`;
  const mem = useLoad<Memory>(() => w.call('GET', `${path}/memory`), [w, shop.id], ['shop', 'shop-order', 'shop-haggle']);
  const act = useAction();
  const [deal, setDeal] = useState({ accountId: '', stockId: '', pct: '10', days: '' });
  if (!mem.data) return <section className="card"><ErrorBox error={mem.error} />{!mem.error && <Loading />}</section>;
  const m = mem.data;
  const money = (cp: number) => coins(cp, info.settings.coins);
  const setRep = (aid: string, patch: { rep?: number; note?: string }) => act.run(async () => { await w.call('PUT', `${path}/memory/${encodeURIComponent(aid)}`, patch); await mem.reload(); });
  const give = () => act.run(async () => {
    await w.call('POST', `${path}/deals`, { accountId: deal.accountId, stockId: deal.stockId || null, pct: Number(deal.pct), days: deal.days === '' ? null : Number(deal.days) });
    setDeal({ ...deal, stockId: '', days: '' });
    await mem.reload();
  });
  const active = m.deals.filter((x) => x.status === 'active');
  const past = m.deals.filter((x) => x.status !== 'active').slice(0, 20);
  return (
    <section className="card stack shop-memory" aria-labelledby="mem-h">
      <h2 id="mem-h">{shop.keeper?.name ? `What ${shop.keeper.name} remembers` : "The keeper's memory"}</h2>
      <span className="small muted">Reputation runs from -100 to 100 and moves prices by up to {m.repEffect}% each way. Buying raises it; failed haggles lower it.</span>
      <div className="shop-scroll">
        <table className="shop-table">
          <thead><tr><th>Player</th><th>Reputation</th><th className="wide">Spent</th><th className="wide">Sold</th><th className="wide">Haggles</th><th>DM note</th></tr></thead>
          <tbody>
            {m.players.map((p) => (
              <tr key={p.accountId} data-testid="memory-row">
                <td><strong>{p.name}</strong><div className="tiny muted">{p.standing}{p.repPct ? ` · ${p.repPct > 0 ? `${p.repPct}% off` : `${-p.repPct}% more`}` : ''}</div></td>
                <td><input type="number" min={-100} max={100} aria-label={`Reputation of ${p.name}`} defaultValue={p.rep} key={`r-${p.accountId}-${p.rep}`} onBlur={(e) => { const v = Math.max(-100, Math.min(100, Math.round(Number(e.target.value) || 0))); if (v !== p.rep) void setRep(p.accountId, { rep: v }); }} /></td>
                <td className="wide small">{money(p.spentCp)}{p.purchases ? ` (${p.purchases})` : ''}</td>
                <td className="wide small">{money(p.soldCp)}</td>
                <td className="wide small">{p.hagglesWon} won, {p.hagglesLost} lost</td>
                <td><input type="text" maxLength={1000} aria-label={`DM note on ${p.name}`} defaultValue={p.note} key={`n-${p.accountId}-${p.note}`} onBlur={(e) => { if (e.target.value !== p.note) void setRep(p.accountId, { note: e.target.value }); }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 style={{ margin: 0 }}>Deals</h3>
      {!active.length ? <span className="small muted">No deal waiting to be used.</span> : <ul className="stack tight" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {active.map((x) => (
          <li key={x.id} className="row between">
            <span className="small"><strong>{x.name}</strong>: {x.pct}% off {x.line ?? 'everything'} <span className="tiny muted">({x.source === 'dm' ? 'from you' : x.source === 'counter' ? `counter-offer, asked ${x.askedPct}%` : `haggled, asked ${x.askedPct}%`}{x.expiresMin === null ? ', until used' : ''})</span></span>
            <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('DELETE', `${path}/deals/${x.id}`); await mem.reload(); })}>Cancel</button>
          </li>
        ))}
      </ul>}
      <div className="shop-grid">
        <Field label="Give a deal to"><select value={deal.accountId} onChange={(e) => setDeal({ ...deal, accountId: e.target.value })}><option value="">Pick a player…</option>{m.players.map((p) => <option key={p.accountId} value={p.accountId}>{p.name}</option>)}</select></Field>
        <Field label="On"><select value={deal.stockId} onChange={(e) => setDeal({ ...deal, stockId: e.target.value })}><option value="">Everything</option>{shop.stock.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <Field label="% off"><input type="number" min={1} max={90} value={deal.pct} onChange={(e) => setDeal({ ...deal, pct: e.target.value })} /></Field>
        <Field label="For (game days)" help="Blank: until used"><input type="number" min={1} value={deal.days} onChange={(e) => setDeal({ ...deal, days: e.target.value })} /></Field>
      </div>
      <div className="row"><button type="button" className="btn" disabled={act.busy || !deal.accountId || !(Number(deal.pct) >= 1)} onClick={() => void give()}>Give deal</button></div>
      {!!past.length && <details><summary className="small">Past haggles and deals</summary><ul className="stack tight" style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
        {past.map((x) => <li key={x.id} className="tiny muted">{when(x.at)}: {x.name} {x.source === 'refused' ? `asked ${x.askedPct}% off ${x.line ?? 'everything'} and was refused` : `${x.pct}% off ${x.line ?? 'everything'} (${x.source}, ${x.status})`}</li>)}
      </ul></details>}
      <ErrorBox error={act.error} />
    </section>
  );
}

/** Towns: a price level for every shop in them (a siege makes everything dear; a market town is cheap). */
function Towns({ cfg }: { cfg: ShopConfig }) {
  const { w } = useWorld();
  const list = useLoad<{ towns: Town[] }>(() => w.call('GET', '/shop/towns'), [w], ['shop-towns', 'shop']);
  const act = useAction();
  const [name, setName] = useState('');
  if (!list.data) return <><ErrorBox error={list.error} />{!list.error && <Loading />}</>;
  const patch = (t: Town, p: Record<string, unknown>) => act.run(async () => { await w.call('PATCH', `/shop/towns/${t.id}`, p); await list.reload(); });
  return (
    <div className="stack loose">
      <section className="card stack">
        <span className="small muted">A town's price level raises or lowers every shop in it, on top of each shop's markup. Players see the town's name and whether prices there are cheap, fair or dear, never the number or your notes.</span>
        <div className="row" style={{ gap: 8 }}>
          <input value={name} maxLength={120} placeholder="New town name" aria-label="New town name" onChange={(e) => setName(e.target.value)} style={{ flex: '1 1 200px' }} />
          <button type="button" className="btn primary" disabled={act.busy || !name.trim()} onClick={() => void act.run(async () => { await w.call('POST', '/shop/towns', { name: name.trim() }); setName(''); await list.reload(); })}>Add town</button>
        </div>
        <ErrorBox error={act.error} />
      </section>
      {!list.data.towns.length ? <Empty>No towns yet.</Empty> : list.data.towns.map((t) => (
        <section key={t.id} className="card stack" data-testid="town-card">
          <div className="row between"><strong>{t.name}</strong><span className="chip">prices {t.prices}</span></div>
          <div className="shop-grid">
            <Field label="Name"><input defaultValue={t.name} key={`n${t.name}`} maxLength={120} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== t.name) void patch(t, { name: e.target.value.trim() }); }} /></Field>
            <Field label="Size"><select value={t.size} onChange={(e) => void patch(t, { size: e.target.value })}>{cfg.sizes.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</select></Field>
            <Field label="Price level %" help="+25 inflated, -10 cheap"><input type="number" min={-90} max={500} defaultValue={t.pricePct} key={`p${t.pricePct}`} onBlur={(e) => { const v = Math.round(Number(e.target.value) || 0); if (v !== t.pricePct) void patch(t, { pricePct: v }); }} /></Field>
          </div>
          <Field label="What players read about its market"><input defaultValue={t.description} key={`d${t.description}`} maxLength={2000} onBlur={(e) => { if (e.target.value !== t.description) void patch(t, { description: e.target.value }); }} /></Field>
          <Field label="DM notes (DM only)"><input defaultValue={t.dmNotes} key={`m${t.dmNotes}`} maxLength={4000} onBlur={(e) => { if (e.target.value !== t.dmNotes) void patch(t, { dmNotes: e.target.value }); }} /></Field>
          <span className="small muted">{t.shops.length ? `Shops: ${t.shops.map((x) => x.name).join(', ')}` : 'No shops yet: pick this town on a shop, or generate one here.'}</span>
          <div className="row"><button type="button" className="btn ghost small" disabled={act.busy} onClick={() => { if (confirm(`Delete ${t.name}? Its shops stay, at their own prices.`)) void act.run(async () => { await w.call('DELETE', `/shop/towns/${t.id}`); await list.reload(); }); }}>Delete town</button></div>
        </section>
      ))}
    </div>
  );
}
