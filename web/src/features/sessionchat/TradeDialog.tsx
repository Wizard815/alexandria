// Trade offers between players: offer an item and/or coin for an item and/or
// coin. TradeButton opens the dialog (used from the Inventory page and the
// chat panel); TradeOffers lists open trades with Accept / Decline (Inventory,
// the chat panel and the sheet's Inventory box); TradeAlert pops up anywhere
// in the app when an offer arrives or one of mine is answered.
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { coins, parseCoins } from '../../lib/format.ts';
import { Modal, Field, ErrorBox, useAction, useToast } from '../../ui/index.tsx';
import type { Trade } from './shared.tsx';

const describe = (side: { item: string | null; qty: number; cp: number }, mode: 'gsc' | 'all' | 'gold') =>
  [side.item && `${side.qty} × ${side.item}`, side.cp ? coins(side.cp, mode) : ''].filter(Boolean).join(' + ');

export function TradeButton() {
  const { isGM, info } = useWorld();
  const [open, setOpen] = useState(false);
  if (isGM || info.role !== 'player' || info.settings.playerTransfers === false) return null;
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

/** My trades (players only), live. Anyone else gets an empty list without a request. */
export function useTrades() {
  const { w, info } = useWorld();
  const player = info.role === 'player';
  return useLoad(() => (player ? w.call<Trade[]>('GET', '/sessionchat/trades') : Promise.resolve([] as Trade[])), [w, player], ['trade']);
}

/** How many offers are waiting for me to accept or decline. */
export const waitingForMe = (list: Trade[] | null | undefined, me: string) => (list ?? []).filter((t) => t.status === 'open' && t.to === me).length;

const RECENT_MS = 3 * 24 * 3600 * 1000;
const OUTCOME: Record<string, string> = { accepted: 'accepted', declined: 'declined', cancelled: 'withdrew' };

/**
 * Open trades with Accept / Decline (offers to me first) or Cancel (mine).
 * `recent` also lists trades settled in the last few days, so a player who was
 * away sees what happened to their offers. `compact` drops the Trade button
 * and renders nothing when there is nothing open (the sheet's Inventory box).
 */
export function TradeOffers({ recent = false, compact = false, heading }: { recent?: boolean; compact?: boolean; heading?: boolean }) {
  const { w, me, nameOf, info } = useWorld();
  const trades = useTrades();
  const act = useAction();
  if (info.role !== 'player') return null;
  const list = trades.data ?? [];
  const open = list.filter((t) => t.status === 'open').sort((a, b) => Number(b.to === me) - Number(a.to === me));
  const done = recent ? list.filter((t) => t.status !== 'open' && t.decidedAt && Date.now() - new Date(t.decidedAt).getTime() < RECENT_MS).slice(0, 5) : [];
  const waiting = waitingForMe(list, me);
  if (compact && !open.length) return null;
  if (heading && !open.length && !done.length) return null;
  const mode = info.settings.coins;
  const decide = (t: Trade, verb: 'accept' | 'decline' | 'cancel') => void act.run(async () => { await w.call('POST', `/sessionchat/trades/${t.id}/${verb}`, {}); await trades.reload(); });
  const body = (
    <div className="stack tight" data-testid="trade-offers">
      <ErrorBox error={act.error} />
      {open.map((t) => (
        <div key={t.id} className={`sc-trade${t.to === me ? ' incoming' : ''}`} data-testid={t.to === me ? 'trade-incoming' : 'trade-outgoing'}>
          <div>{t.to === me ? <><strong>{nameOf(t.from)}</strong> offers</> : <>You offered <strong>{nameOf(t.to)}</strong></>} {describe(t.offer, mode) || 'nothing'} for {describe(t.want, mode) || 'nothing'}{t.note && <span className="muted"> · {t.note}</span>}</div>
          <div className="row">
            {t.to === me ? <><button type="button" className="btn small primary" disabled={act.busy} onClick={() => decide(t, 'accept')}>Accept</button><button type="button" className="btn small" disabled={act.busy} onClick={() => decide(t, 'decline')}>Decline</button></>
              : <><span className="tiny muted grow">Waiting for {nameOf(t.to)}</span><button type="button" className="btn small" disabled={act.busy} onClick={() => decide(t, 'cancel')}>Cancel offer</button></>}
          </div>
        </div>
      ))}
      {done.length > 0 && (
        <ul className="sc-trade-done" aria-label="Recent trades">
          {done.map((t) => {
            const mine = t.from === me;
            const who = mine ? nameOf(t.to) : nameOf(t.from);
            const text = t.status === 'cancelled'
              ? (mine ? <>You withdrew your offer to <strong>{who}</strong></> : <><strong>{who}</strong> withdrew their offer</>)
              : mine ? <><strong>{who}</strong> {OUTCOME[t.status]} your offer</> : <>You {OUTCOME[t.status]} <strong>{who}</strong>’s offer</>;
            return <li key={t.id} className={`tiny${t.status === 'accepted' ? '' : ' muted'}`}><i className={`fa-solid ${t.status === 'accepted' ? 'fa-handshake' : 'fa-xmark'}`} aria-hidden="true" /> {text}: {describe(t.offer, mode) || 'nothing'} for {describe(t.want, mode) || 'nothing'}</li>;
          })}
        </ul>
      )}
      {!compact && <div className="row"><TradeButton /></div>}
    </div>
  );
  if (!heading) return body;
  return (
    <section className="card stack tight sc-trades-card" aria-labelledby="trades-h" style={{ borderColor: waiting ? 'var(--accent)' : undefined }}>
      <div className="row between"><h2 id="trades-h" style={{ margin: 0 }}>Trades</h2>{waiting > 0 && <span className="chip gold">{waiting} waiting for you</span>}</div>
      {body}
    </section>
  );
}

/**
 * A pop-up when a trade needs me or one of mine was settled, wherever I am in
 * the app (the person acting never gets one: the offer goes to the other side,
 * the answer back to the one who offered). Links to Inventory.
 */
export function TradeAlert() {
  const { me, nameOf, info, on } = useWorld();
  const [alert, setAlert] = useState<{ id: string; text: string } | null>(null);
  const loc = useLocation();
  useEffect(() => {
    if (info.role !== 'player') return;
    return on(['trade'], (e) => {
      const t = e.data as Trade;
      if (!t?.id) return;
      let text = '';
      if (t.status === 'open' && t.to === me) text = `${nameOf(t.from)} offers you a trade`;
      else if (t.status === 'cancelled' && t.to === me) text = `${nameOf(t.from)} withdrew their trade offer`;
      else if ((t.status === 'accepted' || t.status === 'declined') && t.from === me) text = `${nameOf(t.to)} ${t.status} your trade`;
      if (text) setAlert({ id: t.id, text });
    });
  }, [on, me, nameOf, info.role]);
  useEffect(() => {
    if (!alert) return;
    const t = setTimeout(() => setAlert(null), 8000);
    return () => clearTimeout(t);
  }, [alert]);
  if (!alert) return null;
  const inv = `/w/${info.slug}/inventory`;
  return (
    <div className="toast sc-trade-toast" role="status" data-testid="trade-alert">
      <i className="fa-solid fa-handshake" aria-hidden="true" /> <span className="grow">{alert.text}</span>
      {loc.pathname !== inv && <Link to={inv} onClick={() => setAlert(null)}>Open inventory</Link>}
      <button type="button" className="btn ghost small" aria-label="Dismiss" onClick={() => setAlert(null)}>✕</button>
    </div>
  );
}
