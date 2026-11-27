// The Players page, main view: one card per player (their character, gold and pack with quick
// give and take), then the party's pouch and pack. Everything else the old Party page did
// (editing items, approvals, the coin ledger) is in the Details tab beside it.
import { useState, type FormEvent } from 'react';
import { ErrorBox, Empty, Loading, Field, useAction } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { coins, parseCoins } from '../../lib/format.ts';
import { ItemImage, QuietToggle } from '../inventory/giving.tsx';

interface Line { id: string; name: string; qty: number; note: string; image: string | null; status: string; dm_note?: string; weight?: number | null }
interface Card { id?: string; character?: string; player?: string; cp: number | null; items: Line[]; waiting: number; purse?: boolean }
interface Overview { coins: 'gsc' | 'all' | 'gold'; trackWeight: boolean; dmEdits: boolean; partyPurse: boolean; dmChangeReason: boolean; players: (Card & { id: string; character: string; player: string })[]; party: Card }

const QUICK = [-100, 100, 1000];


export function PlayersCards() {
  const { w, nameOf } = useWorld();
  const data = useLoad<Overview>(() => w.call('GET', '/inventory/overview'), [w], ['item', 'item-moved', 'item-removed', 'coin', 'approval', 'transfer', 'inventory', 'presence']);
  const live = useLoad<any>(() => w.live(), [w], ['presence']);
  const here = new Set<string>((live.data?.here ?? []).map((h: any) => h.account_id));
  void nameOf;
  if (data.error && !data.data) return <ErrorBox error={data.error} />;
  if (!data.data) return <Loading what="the players" />;
  const o = data.data;
  return (
    <div className="stack loose">
      {!o.players.length && <Empty>No players yet. Invite some in Settings.</Empty>}
      <div className="pl-grid">
        {o.players.map((p) => <OwnerCard key={p.id} o={o} owner={p.id} card={p} title={p.character} sub={p.player} presence={here.has(p.id)} reload={data.reload} />)}
      </div>
      <h2 className="pl-party-h">The party</h2>
      <div className="pl-grid pl-party"><OwnerCard o={o} owner="party" card={o.party} title="Party" sub={o.partyPurse ? 'Shared pouch and pack' : 'Shared pack (the pouch is off in Settings)'} reload={data.reload} /></div>
      <style>{CSS}</style>
    </div>
  );
}

function OwnerCard({ o, owner, card, title, sub, presence, reload }: { o: Overview; owner: string; card: Card; title: string; sub: string; presence?: boolean; reload: () => Promise<void> }) {
  const { w } = useWorld();
  const act = useAction();
  const [amount, setAmount] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [qty, setQty] = useState('1');
  const [why, setWhy] = useState('');
  // Quiet: the GM's item changes here don't alert the owner (a secret for the story). Off by default.
  const [quiet, setQuiet] = useState(false);
  const isParty = owner === 'party';
  const locked = !isParty && !o.dmEdits;
  const showCoin = !isParty || o.partyPurse;
  const parsed = parseCoins(amount);
  const reason = (what: string): string | null => {
    if (quiet || isParty || !o.dmChangeReason) return '';
    const r = window.prompt(`Why? The owner sees this. (${what})`);
    if (r === null) return null;
    if (!r.trim()) { window.alert('A reason is needed. Change Settings to turn this off.'); return null; }
    return r.trim();
  };
  const q = quiet ? { quiet: true } : {};
  const coin = (cp: number, note?: string) => act.run(async () => { await w.addCoin(owner, cp, note); setAmount(''); await reload(); });
  const take = (it: Line) => act.run(async () => {
    const r = reason(`take ${it.name}`);
    if (r === null) return;
    if (it.qty > 1) await w.updateItem(it.id, { qty: it.qty - 1, reason: r, ...q });
    else await w.call('DELETE', `/inventory/${it.id}`, undefined, { ...(r ? { reason: r } : {}), ...(quiet ? { quiet: '1' } : {}) });
    await reload();
  });
  const more = (it: Line) => act.run(async () => {
    const r = reason(`one more ${it.name}`);
    if (r === null) return;
    await w.updateItem(it.id, { qty: it.qty + 1, reason: r, ...q });
    await reload();
  });
  const give = (e: FormEvent) => { e.preventDefault(); void act.run(async () => {
    const r = reason(`give ${name}`);
    if (r === null) return;
    await w.addItem({ owner, name: name.trim(), qty: parseInt(qty, 10) || 1, reason: r || why.trim(), ...q });
    setName(''); setQty('1'); setWhy(''); setAdding(false);
    await reload();
  }); };

  return (
    <section className={`card pl-card${isParty ? ' gold' : ''}`} aria-label={`${title}'s gold and pack`} data-owner={owner}>
      <header className="pl-head">
        <div className="stack tight grow" style={{ minWidth: 0 }}>
          <h3 className="pl-name">{title}</h3>
          <span className="tiny muted">{sub}</span>
        </div>
        {!isParty && <span className={`chip ${presence ? 'green' : ''}`}>{presence ? 'here' : 'away'}</span>}
        {card.waiting > 0 && <span className="chip teal" title="Waiting for your approval">{card.waiting} waiting</span>}
      </header>
      {showCoin && (
        <div className="pl-coin">
          <b className="pl-gold" aria-label="Gold">{coins(card.cp ?? 0, o.coins)}</b>
          <div className="row pl-quick" role="group" aria-label="Quick gold">
            {QUICK.map((q) => <button key={q} type="button" className="btn small" disabled={act.busy} onClick={() => void coin(q)} aria-label={`${q > 0 ? 'Give' : 'Take'} ${coins(Math.abs(q), o.coins)}`}>{q > 0 ? '+' : '−'}{Math.abs(q) / 100} gp</button>)}
          </div>
          <form className="row pl-amt" onSubmit={(e) => { e.preventDefault(); if (parsed) void coin(Math.abs(parsed)); }}>
            <input aria-label="Amount of gold" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="12 gp 5 sp" />
            <button type="submit" className="btn small primary" disabled={act.busy || !parsed}>Give</button>
            <button type="button" className="btn small danger" disabled={act.busy || !parsed} onClick={() => void coin(-Math.abs(parsed ?? 0))}>Take</button>
          </form>
        </div>
      )}
      <ErrorBox error={act.error} />
      <ul className="pl-items" aria-label="Pack">
        {card.items.map((it) => (
          <li key={it.id} className={it.status === 'pending' ? 'pending' : ''}>
            <ItemImage image={it.image} name={it.name} size={28} />
            <span className="grow pl-item-name" title={it.note || undefined}>{it.name}{it.status === 'pending' && <span className="tiny faint"> (waiting)</span>}{it.dm_note && <span className="tiny" style={{ color: 'var(--danger-text)' }}> · GM: {it.dm_note}</span>}</span>
            <span className="pl-qty">× {it.qty}</span>
            {!locked && it.status !== 'pending' && <span className="row pl-itbtn">
              <button type="button" className="btn small ghost" aria-label={`One less ${it.name}`} disabled={act.busy} onClick={() => void take(it)}>−</button>
              <button type="button" className="btn small ghost" aria-label={`One more ${it.name}`} disabled={act.busy} onClick={() => void more(it)}>+</button>
            </span>}
          </li>
        ))}
        {!card.items.length && <li className="faint small">Nothing carried.</li>}
      </ul>
      {!locked && (adding ? (
        <form className="stack tight" onSubmit={give}>
          <div className="row top">
            <Field label="Give item"><input required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Potion of healing" /></Field>
            <Field label="Qty"><input inputMode="numeric" style={{ width: 64 }} value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ''))} /></Field>
          </div>
          {!isParty && o.dmChangeReason && !quiet && <span className="tiny muted">You will be asked why, as Settings require.</span>}
          <div className="row end"><button type="button" className="btn small" onClick={() => setAdding(false)}>Cancel</button><button type="submit" className="btn small primary" disabled={act.busy || !name.trim()}>Give</button></div>
        </form>
      ) : <div className="row"><button type="button" className="btn small" onClick={() => setAdding(true)}>＋ Give item</button></div>)}
      {!locked && <QuietToggle on={quiet} set={setQuiet} party={isParty} />}
      {locked && <span className="tiny faint">GM edits to packs are off in Settings.</span>}
    </section>
  );
}

const CSS = `
.pl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; align-items: start; }
.pl-party { grid-template-columns: minmax(300px, 520px); }
.pl-party-h { margin: 6px 0 0; }
.pl-card { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.pl-head { display: flex; gap: 8px; align-items: flex-start; }
.pl-name { margin: 0; font-size: 20px; overflow-wrap: anywhere; }
.pl-coin { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; border-radius: 8px; background: var(--panel-2); }
.pl-gold { font-size: 24px; color: var(--accent-strong); font-variant-numeric: tabular-nums; }
.pl-quick, .pl-amt { gap: 6px; flex-wrap: wrap; }
.pl-amt input { flex: 1 1 110px; min-width: 0; }
.pl-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto; }
.pl-items li { display: flex; align-items: center; gap: 8px; padding: 4px 2px; border-bottom: 1px solid var(--line); min-height: 36px; }
.pl-items li.pending { opacity: 0.7; }
.pl-item-name { min-width: 0; overflow-wrap: anywhere; }
.pl-qty { font-variant-numeric: tabular-nums; white-space: nowrap; }
.pl-itbtn { gap: 2px; flex-wrap: nowrap; }
@media (max-width: 760px) {
  .pl-grid, .pl-party { grid-template-columns: minmax(0, 1fr); }
  .pl-quick .btn, .pl-amt .btn, .pl-itbtn .btn { min-height: 40px; min-width: 44px; }
  .pl-amt input { min-height: 40px; }
}
`;
