// Trade offers between players: offer an item and/or coin for an item and/or
// coin. TradeButton opens the dialog (used from the Inventory page and the
// chat panel); TradeOffers lists offers waiting for me with Accept / Decline.
import { useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { coins, parseCoins } from '../../lib/format.ts';
import { Modal, Field, ErrorBox, useAction, useToast } from '../../ui/index.tsx';
import type { Trade } from './shared.tsx';

const describe = (side: { item: string | null; qty: number; cp: number }, mode: 'gsc' | 'all' | 'gold') =>
  [side.item && `${side.qty} × ${side.item}`, side.cp ? coins(side.cp, mode) : ''].filter(Boolean).join(' + ');

export function TradeButton() {
  const { isDM, info } = useWorld();
  const [open, setOpen] = useState(false);
  if (isDM || info.role !== 'player' || info.settings.playerTransfers === false) return null;
  return (
    <>
      <button type="button" className="btn small" onClick={() => setOpen(true)}>Trade…</button>
      {open && <TradeDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function TradeDialog({ onClose }: { onClose: () => void }) {
  const { w, members, me, nameOf, info } = useWorld();
  const mine = useLoad(() => w.inventory('me') as Promise<{ items: { id: string; name: string; qty: number; status?: string }[] }>, [w]);
  const [to, setTo] = useState('');
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('1');
  const [offerCoin, setOfferCoin] = useState('');
  const [wantItem, setWantItem] = useState('');
  const [wantQty, setWantQty] = useState('1');
  const [wantCoin, setWantCoin] = useState('');
  const [note, setNote] = useState('');
  const act = useAction();
  const { toast, toastNode } = useToast();
  const others = members.filter((m) => m.role === 'player' && m.id !== me);
  const owned = (mine.data?.items ?? []).filter((i) => i.status !== 'pending');
  const send = () => void act.run(async () => {
    await w.call('POST', '/sessionchat/trades', {
      to, offerItemId: itemId || undefined, offerQty: Number(qty) || 1, offerCp: offerCoin ? parseCoins(offerCoin) ?? 0 : 0,
      wantItem: wantItem || undefined, wantQty: Number(wantQty) || 1, wantCp: wantCoin ? parseCoins(wantCoin) ?? 0 : 0, note,
    });
    toast('Offer sent'); onClose();
  });
  return (
    <Modal title="Offer a trade" onClose={onClose}>
      <ErrorBox error={act.error} />
      <Field label="Trade with"><select value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose a player…</option>{others.map((m) => <option key={m.id} value={m.id}>{nameOf(m.id)}</option>)}</select></Field>
      <fieldset className="stack tight" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small muted">You give</legend>
        <select className="input" aria-label="Item you give" value={itemId} onChange={(e) => setItemId(e.target.value)}><option value="">No item</option>{owned.map((i) => <option key={i.id} value={i.id}>{i.name} (×{i.qty})</option>)}</select>
        {itemId && <input className="input" aria-label="How many" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />}
        <input className="input" aria-label="Coin you give" value={offerCoin} onChange={(e) => setOfferCoin(e.target.value)} placeholder="Coin, e.g. 5 gp (optional)" />
      </fieldset>
      <fieldset className="stack tight" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small muted">You want</legend>
        <input className="input" aria-label="Item you want" value={wantItem} onChange={(e) => setWantItem(e.target.value)} placeholder="Item name (optional)" />
        {wantItem && <input className="input" aria-label="How many you want" inputMode="numeric" value={wantQty} onChange={(e) => setWantQty(e.target.value)} />}
        <input className="input" aria-label="Coin you want" value={wantCoin} onChange={(e) => setWantCoin(e.target.value)} placeholder="Coin, e.g. 2 gp (optional)" />
      </fieldset>
      <Field label="Note"><input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
      <p className="tiny faint">They accept and both moves happen at once, or they decline and nothing moves. Coin is shown as {info.settings.coins}.</p>
      <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!to || act.busy} onClick={send}>Send offer</button></div>
      {toastNode}
    </Modal>
  );
}

export function TradeOffers() {
  const { w, me, nameOf, info } = useWorld();
  const trades = useLoad(() => w.call<Trade[]>('GET', '/sessionchat/trades'), [w], ['trade']);
  const act = useAction();
  if (info.role !== 'player') return null;
  const open = (trades.data ?? []).filter((t) => t.status === 'open');
  const decide = (t: Trade, verb: 'accept' | 'decline' | 'cancel') => void act.run(async () => { await w.call('POST', `/sessionchat/trades/${t.id}/${verb}`, {}); await trades.reload(); });
  return (
    <div className="stack tight">
      <ErrorBox error={act.error} />
      {open.map((t) => (
        <div key={t.id} className="sc-trade">
          <div>{t.to === me ? <><strong>{nameOf(t.from)}</strong> offers</> : <>You offered <strong>{nameOf(t.to)}</strong></>} {describe(t.offer, info.settings.coins) || 'nothing'} for {describe(t.want, info.settings.coins) || 'nothing'}{t.note && <span className="muted"> · {t.note}</span>}</div>
          <div className="row">
            {t.to === me ? <><button type="button" className="btn small primary" disabled={act.busy} onClick={() => decide(t, 'accept')}>Accept</button><button type="button" className="btn small" disabled={act.busy} onClick={() => decide(t, 'decline')}>Decline</button></>
              : <button type="button" className="btn small" disabled={act.busy} onClick={() => decide(t, 'cancel')}>Cancel offer</button>}
          </div>
        </div>
      ))}
      <div className="row"><TradeButton /></div>
    </div>
  );
}
