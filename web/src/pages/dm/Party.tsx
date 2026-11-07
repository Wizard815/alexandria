// Party & inventory: each player's pack and coin, the party's shared
// pack and purse, and who is at the table. DM notes on items stay DM-only.
import { useState, type FormEvent } from 'react';
import { PageHead, ErrorBox, Empty, Loading, Field, useAction } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { coins, parseCoins, when } from '../../lib/format.ts';
import { usePlayers } from './shared.tsx';

export default function DMParty() {
  const { w, info, nameOf } = useWorld();
  const players = usePlayers();
  const [owner, setOwner] = useState<string>('party');
  const live = useLoad<any>(() => w.live(), [w], ['presence', 'coin']);
  const here = new Map<string, any>((live.data?.here ?? []).map((h: any) => [h.account_id, h]));
  const ownerName = owner === 'party' ? 'The party' : nameOf(owner);

  return (
    <div className="page wide">
      <PageHead title="Party & inventory" lead={`Packs and coin for everyone in ${info.name}. ${info.settings.dmEditsInventory ? 'Your changes are logged and the player sees them.' : 'DM edits to player packs are off in World settings.'}`} />
      <div className="cols">
        <aside className="col-1 card flush" style={{ maxWidth: 320 }}>
          <div className="list" role="tablist" aria-label="Whose inventory">
            <button type="button" role="tab" aria-selected={owner === 'party'} className={`list-item${owner === 'party' ? ' active' : ''}`} onClick={() => setOwner('party')}>
              <span className="grow"><strong>The party</strong><br /><span className="tiny muted">Shared pack{info.settings.partyPurse ? ' and purse' : ''}</span></span>
            </button>
            {players.map((p) => (
              <button key={p.id} type="button" role="tab" aria-selected={owner === p.id} className={`list-item${owner === p.id ? ' active' : ''}`} onClick={() => setOwner(p.id)}>
                <span className="grow"><strong>{p.character_name || p.display_name}</strong><br /><span className="tiny muted">{p.display_name}</span></span>
                {here.has(p.id) ? <span className="chip green" title={here.get(p.id).location}>here</span> : <span className="chip">away</span>}
              </button>
            ))}
            {!players.length && <Empty>No players yet. Invite some in World settings.</Empty>}
          </div>
        </aside>
        <section className="col-3 stack">
          <h2>{ownerName}</h2>
          <div className="cols">
            <div className="col-2"><Items owner={owner} /></div>
            <div className="col-1">{owner === 'party' && !info.settings.partyPurse ? <div className="card"><Empty>The party purse is off in World settings.</Empty></div> : <Coin key={owner} owner={owner} />}</div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Items({ owner }: { owner: string }) {
  const { w, info, nameOf } = useWorld();
  const players = usePlayers();
  const inv = useLoad<any>(() => w.inventory(owner), [w, owner], ['item', 'item-moved', 'item-removed']);
  const act = useAction();
  const [name, setName] = useState('');
  const [qty, setQty] = useState('1');
  const [weight, setWeight] = useState('');
  const [note, setNote] = useState('');
  const [dmNote, setDmNote] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const weightOn = info.settings.trackWeight;
  const readOnly = owner !== 'party' && !info.settings.dmEditsInventory;

  const add = (e: FormEvent) => act.run(async () => {
    e.preventDefault();
    await w.addItem({ owner, name: name.trim(), qty: parseInt(qty, 10) || 1, ...(weightOn && weight ? { weight: Number(weight) } : {}), note, dmNote });
    setName(''); setQty('1'); setWeight(''); setNote(''); setDmNote('');
    void inv.reload();
  });

  if (inv.error) return <ErrorBox error={inv.error} />;
  if (!inv.data) return <Loading what="inventory" />;
  const items: any[] = inv.data.items;

  return (
    <div className="card">
      <div className="card-head"><h3>Pack</h3>{weightOn && <span className="chip">{inv.data.totalWeight ?? 0} lb carried</span>}</div>
      {items.length ? (
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th scope="col">Item</th><th scope="col">Qty</th>{weightOn && <th scope="col">Wt</th>}<th scope="col">Notes</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {items.map((it) => editing === it.id
                ? <EditRow key={it.id} it={it} weightOn={weightOn} players={players} onDone={() => { setEditing(null); void inv.reload(); }} />
                : (
                  <tr key={it.id}>
                    <td><strong className="read" style={{ fontSize: 16 }}>{it.name}</strong>{it.link && <><br /><a className="tiny" href={it.link} target="_blank" rel="noreferrer">link</a></>}</td>
                    <td>{it.qty}</td>
                    {weightOn && <td>{it.weight ?? '—'}</td>}
                    <td className="small"><span>{it.note}</span>{it.dm_note && <><br /><span style={{ color: 'var(--danger-text)' }}>DM: {it.dm_note}</span></>}<br /><span className="tiny faint">{nameOf(it.updated_by)} · {when(it.updated_at)}</span></td>
                    <td>{!readOnly && <button type="button" className="btn small" onClick={() => setEditing(it.id)}>Edit</button>}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>Nothing carried.</Empty>}
      {!readOnly && (
        <form className="stack" onSubmit={(e) => void add(e)} style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <div className="row top">
            <Field label="Item"><input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Potion of healing" /></Field>
            <Field label="Qty"><input inputMode="numeric" style={{ width: 70 }} value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ''))} /></Field>
            {weightOn && <Field label="Weight (lb)"><input inputMode="decimal" style={{ width: 90 }} value={weight} onChange={(e) => setWeight(e.target.value.replace(/[^\d.]/g, ''))} /></Field>}
          </div>
          <div className="grid">
            <Field label="Note" help={owner === 'party' ? 'The party sees this' : 'The player sees this'}><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            <Field label="DM note" help="Only you see this (e.g. it's cursed)"><input value={dmNote} onChange={(e) => setDmNote(e.target.value)} /></Field>
          </div>
          <ErrorBox error={act.error} />
          <div className="row end"><button type="submit" className="btn primary small" disabled={act.busy || !name.trim()}>Add item</button></div>
        </form>
      )}
    </div>
  );
}

function EditRow({ it, weightOn, players, onDone }: { it: any; weightOn: boolean; players: any[]; onDone: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [name, setName] = useState(it.name);
  const [qty, setQty] = useState(String(it.qty));
  const [weight, setWeight] = useState(it.weight ?? '');
  const [note, setNote] = useState(it.note);
  const [dmNote, setDmNote] = useState(it.dm_note ?? '');
  const [owner, setOwner] = useState(it.owner);
  const save = () => act.run(async () => {
    await w.updateItem(it.id, { name, qty: parseInt(qty, 10) || 0, note, dmNote, owner, ...(weightOn ? { weight: weight === '' ? null : Number(weight) } : {}) });
    onDone();
  });
  return (
    <tr>
      <td colSpan={weightOn ? 5 : 4}>
        <div className="stack">
          <div className="row top">
            <Field label="Item"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Qty"><input inputMode="numeric" style={{ width: 70 }} value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ''))} /></Field>
            {weightOn && <Field label="Weight"><input inputMode="decimal" style={{ width: 80 }} value={weight} onChange={(e) => setWeight(e.target.value.replace(/[^\d.]/g, ''))} /></Field>}
            <Field label="Belongs to">
              <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="party">The party</option>
                {players.map((p) => <option key={p.id} value={p.id}>{p.character_name || p.display_name}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid">
            <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            <Field label="DM note"><input value={dmNote} onChange={(e) => setDmNote(e.target.value)} /></Field>
          </div>
          <ErrorBox error={act.error} />
          <div className="row end">
            <button type="button" className="btn small danger" disabled={act.busy} onClick={() => { if (confirm(`Remove ${it.name}?`)) void act.run(async () => { await w.removeItem(it.id); onDone(); }); }}>Remove</button>
            <button type="button" className="btn small" onClick={onDone}>Cancel</button>
            <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void save()}>Save</button>
          </div>
        </div>
      </td>
    </tr>
  );
}

function Coin({ owner }: { owner: string }) {
  const { w, info, nameOf } = useWorld();
  const ledger = useLoad<any>(() => w.coin(owner), [w, owner], ['coin']);
  const act = useAction();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [session, setSession] = useState('');
  const mode = info.settings.coins;
  const parsed = parseCoins(amount);

  const add = (sign: 1 | -1) => act.run(async () => {
    if (!parsed) throw new Error('Enter an amount like “12 gp 5 sp” or “40”');
    await w.addCoin(owner, sign * Math.abs(parsed), note.trim() || undefined, session.trim() || undefined);
    setAmount(''); setNote('');
    void ledger.reload();
  });

  return (
    <div className="card gold">
      <h3>{owner === 'party' ? 'Party purse' : 'Coin'}</h3>
      <ErrorBox error={ledger.error} />
      {ledger.data && <b style={{ fontSize: 24, color: 'var(--accent-strong)' }}>{coins(ledger.data.cp, mode)}</b>}
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void add(1); }}>
        <Field label="Amount" help={parsed ? `= ${coins(Math.abs(parsed), mode)}` : 'e.g. 12 gp 5 sp, or 40 for 40 gp'}><input value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="What for"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Smuggler's purse" /></Field>
        <Field label="Session label" help="Optional, e.g. S14, to group a night's gains"><input value={session} onChange={(e) => setSession(e.target.value)} /></Field>
        <ErrorBox error={act.error} />
        <div className="row">
          <button type="submit" className="btn primary small" disabled={act.busy}>＋ Add</button>
          <button type="button" className="btn small danger" disabled={act.busy} onClick={() => void add(-1)}>− Spend</button>
        </div>
      </form>
      <div className="stack tight small" style={{ maxHeight: 260, overflowY: 'auto' }}>
        {(ledger.data?.entries ?? []).map((e: any) => (
          <div key={e.id} className="row between">
            <span className="grow"><span>{e.note || 'Coin'}</span><br /><span className="tiny faint">{nameOf(e.by_id)} · {when(e.at)}{e.session_label ? ` · ${e.session_label}` : ''}</span></span>
            <span style={{ color: e.amount_cp < 0 ? 'var(--danger-text)' : 'var(--ok-text)' }}>{e.amount_cp > 0 ? '+' : ''}{coins(e.amount_cp, mode)}</span>
          </div>
        ))}
        {ledger.data && !ledger.data.entries.length && <span className="faint">No coin moved yet.</span>}
      </div>
    </div>
  );
}
