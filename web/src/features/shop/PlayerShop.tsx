// Player page: the shops the DM has put up (open or closed; hidden ones never
// arrive), one shop's keeper and stock, buying with your own coin or the party
// pouch, your requests waiting for the DM, and selling back when the DM allows.
// Prices, stock and the shop list follow the DM live.
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { coins, when } from '../../lib/format.ts';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead, useAction, useToast } from '../../ui/index.tsx';
import { PayChoice, pickPayFrom, type PayFrom, type PayOptions } from '../../pages/broker/shared.tsx';
import { rarityLabel, STATUS_LABEL, statusChip, type Line, type Order, type Shop, type ShopConfig } from './types.ts';
import './shop.css';

export default function PlayerShop() {
  const { w, info, isDM } = useWorld();
  const [sp, setSp] = useSearchParams();
  const list = useLoad<{ shops: Shop[]; config: ShopConfig }>(() => w.call('GET', '/shop/shops'), [w], ['shop', 'settings']);
  const sid = sp.get('shop') ?? '';
  const shops = list.data?.shops ?? [];
  const pick = sid && shops.some((s) => s.id === sid) ? sid : shops.length === 1 ? shops[0].id : '';

  if (info.role === 'guest') return <div className="page"><PageHead title="Shop" /><Empty>Shops are for the players at the table.</Empty></div>;
  if (!list.data) return <div className="page"><PageHead title="Shop" /><ErrorBox error={list.error} />{!list.error && <Loading />}</div>;

  return (
    <div className="page shop-page">
      <PageHead title="Shop" lead={isDM ? 'What players see: open and closed shops, never hidden ones.' : 'Browse what is for sale and buy with your own coin or the party pouch.'} />
      {!shops.length ? <Empty>No shop is open to you right now. Your DM opens shops when you reach one.</Empty> : (
        <div className="cols">
          <nav className="col-1 stack" aria-label="Shops">
            {shops.map((s) => (
              <button key={s.id} type="button" data-testid="shop-card" className={`card shop-pick${s.id === pick ? ' on' : ''}`} onClick={() => setSp(s.id === pick ? {} : { shop: s.id })} aria-pressed={s.id === pick}>
                <div className="row between"><strong>{s.name}</strong><span className={statusChip(s.status)}>{STATUS_LABEL[s.status]}</span></div>
                <span className="small muted">{s.kindLabel}{s.keeper?.name ? ` · ${s.keeper.name}` : ''}</span>
                {s.status === 'open' && <span className="tiny faint">{s.stockCount ?? 0} thing{s.stockCount === 1 ? '' : 's'} for sale</span>}
              </button>
            ))}
          </nav>
          <div className="col-2 stack loose">
            {pick ? <ShopView key={pick} id={pick} config={list.data.config} /> : <Empty>Pick a shop.</Empty>}
            <MyOrders />
          </div>
        </div>
      )}
    </div>
  );
}

function ShopView({ id, config }: { id: string; config: ShopConfig }) {
  const { w, info } = useWorld();
  const shop = useLoad<Shop>(() => w.call('GET', `/shop/shops/${encodeURIComponent(id)}`), [w, id], ['shop', 'settings']);
  const opts = useLoad<PayOptions>(() => w.call('GET', '/shop/pay-options'), [w], ['coin', 'settings']);
  const [buying, setBuying] = useState<Line | null>(null);
  const [selling, setSelling] = useState(false);
  const { toast, toastNode } = useToast();
  if (!shop.data) return <section className="card"><ErrorBox error={shop.error} />{!shop.error && <Loading />}</section>;
  const s = shop.data;
  const money = (cp: number) => coins(cp, info.settings.coins);
  return (
    <>
      <section className="card stack" aria-labelledby="shop-h" data-testid="shop-view">
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div className="stack tight">
            <h2 id="shop-h" style={{ margin: 0 }}>{s.name}</h2>
            <span className="small muted">{s.kindLabel}{s.location ? <> · <Link to={`/w/${info.slug}/library?page=${encodeURIComponent(s.location.id)}`}>{s.location.title}</Link></> : null}</span>
          </div>
          <span className={statusChip(s.status)}>{STATUS_LABEL[s.status]}</span>
        </div>
        {s.description && <p className="read" style={{ margin: 0 }}>{s.description}</p>}
        {s.keeper && (
          <div className="shop-keeper stack tight">
            <strong>{s.keeper.name}<span className="small muted">{[s.keeper.role, s.keeper.race].filter(Boolean).length ? `, ${[s.keeper.role, s.keeper.race].filter(Boolean).join(', ')}` : ''}</span></strong>
            {s.keeper.look && <span className="small">{s.keeper.look}</span>}
            {s.keeper.voice && <span className="small muted">{s.keeper.voice}</span>}
            {s.keeper.personality && <span className="small muted">{s.keeper.personality}</span>}
          </div>
        )}
        {opts.data && <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}><span className="small">My coin: <strong>{money(opts.data.self.cp)}</strong></span>{opts.data.party.cp !== null && <span className="small">Party pouch: <strong>{money(opts.data.party.cp)}</strong></span>}</div>}
      </section>
      {s.status !== 'open' ? <Empty>The shutters are down: this shop is closed for now.</Empty> : (
        <section className="card stack" aria-labelledby="stock-h">
          <div className="card-head"><h2 id="stock-h">For sale</h2>{config.approval && <span className="chip">Your DM approves purchases</span>}</div>
          {!s.stock.length ? <Empty>The shelves are bare.</Empty> : (
            <ul className="shop-lines">
              {s.stock.map((l) => (
                <li key={l.id} className="shop-line" data-testid="shop-line">
                  <details>
                    <summary>
                      <span className="stack tight grow">
                        <strong>{l.name}</strong>
                        <span className="tiny muted">{[rarityLabel(l.rarity), l.type, l.attunement ? 'requires attunement' : ''].filter(Boolean).join(' · ')}</span>
                      </span>
                      <span className="stack tight" style={{ alignItems: 'flex-end' }}>
                        <strong data-testid="shop-price">{l.priceCp === null ? 'Ask' : money(l.priceCp)}</strong>
                        <span className="tiny faint" data-testid="shop-qty">{l.unlimited ? 'plenty' : l.qty === 0 ? 'sold out' : `${l.qty} left`}</span>
                      </span>
                    </summary>
                    <div className="stack tight shop-desc">
                      {l.properties && <span className="small">{l.properties}</span>}
                      {l.weight !== null && <span className="tiny muted">{l.weight} lb.</span>}
                      {l.description && <p className="small read" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{l.description}</p>}
                      {l.attribution && <span className="tiny faint">{l.source}: {l.attribution}</span>}
                    </div>
                  </details>
                  <button type="button" className="btn small primary" data-testid="buy-btn" disabled={l.priceCp === null || l.qty === 0} onClick={() => setBuying(l)}>Buy</button>
                </li>
              ))}
            </ul>
          )}
          {s.sellPct !== null && s.sellPct !== undefined && <div className="row between"><span className="small muted">This shop buys things at {s.sellPct}% of their price.</span><button type="button" className="btn small" onClick={() => setSelling(true)}>Sell something…</button></div>}
        </section>
      )}
      {buying && <BuyModal shop={s} line={buying} opts={opts.data} config={config} onClose={() => setBuying(null)} onDone={(m) => { setBuying(null); toast(m); void shop.reload(); void opts.reload(); }} />}
      {selling && <SellModal shop={s} onClose={() => setSelling(false)} onDone={(m) => { setSelling(false); toast(m); }} />}
      {toastNode}
    </>
  );
}

function BuyModal({ shop, line, opts, config, onClose, onDone }: { shop: Shop; line: Line; opts: PayOptions | null; config: ShopConfig; onClose: () => void; onDone: (msg: string) => void }) {
  const { w, info } = useWorld();
  const [qty, setQty] = useState(1);
  const [to, setTo] = useState<'me' | 'party'>('me');
  const total = (line.priceCp ?? 0) * qty;
  const [from, setFrom] = useState<PayFrom>(pickPayFrom(opts, total));
  const act = useAction();
  const max = line.unlimited ? 99 : Math.max(1, line.qty ?? 1);
  const buy = () => act.run(async () => {
    const r = await w.call<{ pending: boolean }>('POST', `/shop/shops/${encodeURIComponent(shop.id)}/buy`, { stockId: line.id, qty, from, to });
    onDone(r.pending ? 'Asked: your DM approves the purchase. The coin is held until then.' : `Bought ${qty > 1 ? `${qty} × ` : ''}${line.name}.`);
  });
  return (
    <Modal title={`Buy ${line.name}`} onClose={onClose}>
      <div className="stack">
        <Field label="How many"><input type="number" min={1} max={max} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(max, Math.floor(Number(e.target.value) || 1))))} aria-label="How many" /></Field>
        <Field label="Put it in">
          <select value={to} onChange={(e) => setTo(e.target.value as 'me' | 'party')} aria-label="Put it in"><option value="me">My pack</option><option value="party">The party stash</option></select>
        </Field>
        {total > 0 && <PayChoice cost={total} value={from} onChange={setFrom} opts={opts} />}
        <div className="row between"><span>Total</span><strong data-testid="buy-total">{coins(total, info.settings.coins)}</strong></div>
        {config.approval && <span className="tiny faint">Your DM approves shop purchases: the coin is held until they do.</span>}
        <ErrorBox error={act.error} />
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" data-testid="buy-confirm" disabled={act.busy} onClick={() => void buy()}>Pay {coins(total, info.settings.coins)}</button>
        </div>
      </div>
    </Modal>
  );
}

function SellModal({ shop, onClose, onDone }: { shop: Shop; onClose: () => void; onDone: (msg: string) => void }) {
  const { w } = useWorld();
  const mine = useLoad<{ items: any[] }>(() => w.inventory('me') as Promise<any>, [w], ['item']);
  const party = useLoad<{ items: any[] }>(() => w.inventory('party') as Promise<any>, [w], ['item']);
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState(1);
  const act = useAction();
  const items = [...(mine.data?.items ?? []).map((i) => ({ ...i, where: 'My pack' })), ...(party.data?.items ?? []).map((i) => ({ ...i, where: 'Party stash' }))].filter((i) => i.status === 'approved');
  const cur = items.find((i) => i.id === itemId);
  const sell = () => act.run(async () => {
    await w.call('POST', `/shop/shops/${encodeURIComponent(shop.id)}/sell`, { itemId, qty });
    onDone('Offered: your DM decides, and the coin comes when they agree.');
  });
  return (
    <Modal title={`Sell to ${shop.name}`} onClose={onClose}>
      <div className="stack">
        {!mine.data ? <Loading /> : !items.length ? <Empty>You have nothing to sell.</Empty> : (
          <>
            <Field label="What"><select value={itemId} onChange={(e) => { setItemId(e.target.value); setQty(1); }} aria-label="What to sell"><option value="">Pick something…</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name} ×{i.qty} ({i.where})</option>)}</select></Field>
            {cur && cur.qty > 1 && <Field label="How many"><input type="number" min={1} max={cur.qty} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(cur.qty, Math.floor(Number(e.target.value) || 1))))} /></Field>}
            <span className="tiny faint">The shop offers {shop.sellPct}% of what it would charge. Your DM approves the sale.</span>
          </>
        )}
        <ErrorBox error={act.error} />
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!itemId || act.busy} onClick={() => void sell()}>Offer to sell</button>
        </div>
      </div>
    </Modal>
  );
}

function MyOrders() {
  const { w, info } = useWorld();
  const list = useLoad<{ orders: Order[] }>(() => w.call('GET', '/shop/orders'), [w], ['shop-order']);
  const act = useAction();
  const orders = list.data?.orders ?? [];
  if (!orders.length) return null;
  const pending = orders.filter((o) => o.status === 'pending');
  const recent = orders.filter((o) => o.status !== 'pending').slice(0, 8);
  return (
    <section className="card stack" aria-labelledby="orders-h">
      <h2 id="orders-h">My shopping</h2>
      <ErrorBox error={act.error} />
      {!!pending.length && <ul className="stack tight" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {pending.map((o) => (
          <li key={o.id} className="row between">
            <span className="small">{o.kind === 'buy' ? 'Buying' : 'Selling'} {o.itemName}{o.qty > 1 ? ` ×${o.qty}` : ''} · {coins(o.totalCp, info.settings.coins)} <span className="chip">Waiting for the DM</span></span>
            <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('POST', `/shop/orders/${o.id}/cancel`); await list.reload(); })}>Take back</button>
          </li>
        ))}
      </ul>}
      {!!recent.length && <ul className="stack tight" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {recent.map((o) => <li key={o.id} className="tiny muted">{when(o.decidedAt ?? o.at)}: {o.kind === 'buy' ? 'bought' : 'sold'} {o.itemName}{o.qty > 1 ? ` ×${o.qty}` : ''} at {o.shopName} for {coins(o.totalCp, info.settings.coins)}{o.status !== 'approved' ? ` (${o.status})` : ''}</li>)}
      </ul>}
    </section>
  );
}
