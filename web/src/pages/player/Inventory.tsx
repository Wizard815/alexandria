// My pack and the party's shared stash, plus coin. Weight only shows when
// the world tracks it (a DM setting). Adding, editing or removing items and
// coin waits for the DM when the world asks for approval; the DM's changes
// to my things show as alerts. Giving is free: coin and items move between
// players and the party stash at once (the DM sees a log). Items can have a
// picture.
import { useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { coins, parseCoins, when } from '../../lib/format.ts';
import { PageHead, Loading, ErrorBox, Empty, Tabs, Field, Modal, useAction, useToast } from '../../ui/index.tsx';
import { AlertsCard, useMine } from '../broker/shared.tsx';
import { type Item, CoinRequestsCard, GiveCoinModal, ImageField, ImageViewer, ItemImage, MoveItemModal, TransfersList, givingOn, AskCoinModal } from '../inventory/giving.tsx';
const sent = (r: any) => !!(r && r.pending);
interface Inv { owner: string; items: Item[]; trackWeight: boolean; coins: string; totalWeight?: number }

export default function PlayerInventory() {
  const { w, info, nameOf, me } = useWorld();
  const [tab, setTab] = useState<'me' | 'party'>('me');
  const inv = useLoad(() => w.inventory(tab) as Promise<Inv>, [w, tab], ['item', 'item-moved', 'item-removed', 'settings', 'approval', 'transfer']);
  const mine = useMine();
  const coin = useLoad(() => w.coin(tab === 'party' && info.settings.partyPurse ? 'party' : 'me') as Promise<{ cp: number; entries: any[] }>, [w, tab], ['coin']);
  const [edit, setEdit] = useState<Partial<Item> | null>(null);
  const [moving, setMoving] = useState<Item | null>(null);
  const [viewing, setViewing] = useState<Item | null>(null);
  const giving = givingOn(info.settings);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const weight = !!inv.data?.trackWeight;

  // Quick move to/from the party stash. Free when giving is on; otherwise a request to the DM.
  const quickMove = (it: Item) => act.run(async () => {
    if (giving && it.status !== 'pending' && !it.pendingChange) {
      await w.call('POST', `/inventory/${it.id}/move`, { to: it.owner === 'party' ? 'me' : 'party' });
      await inv.reload();
      toast(it.owner === 'party' ? `Took ${it.name}` : `Put ${it.name} in the party stash`);
      return;
    }
    const r = await w.updateItem(it.id, { owner: it.owner === 'party' ? 'me' : 'party' });
    await Promise.all([inv.reload(), mine.reload()]);
    toast(sent(r) ? 'Sent to the DM to approve' : it.owner === 'party' ? `Took ${it.name}` : `Put ${it.name} in the party stash`);
  });
  const remove = (it: Item) => act.run(async () => {
    if (!window.confirm(`Remove ${it.name}?`)) return;
    const r = await w.removeItem(it.id);
    await Promise.all([inv.reload(), mine.reload()]);
    if (sent(r)) toast('Sent to the DM to approve');
  });

  return (
    <div className="page">
      <PageHead title="Inventory and coin" lead="Your pack and the party's shared stash. The DM can see both." />
      <div className="row between">
        <Tabs label="Whose" value={tab} onChange={setTab} items={info.settings.partyPurse ? [['me', 'My pack'], ['party', 'Party stash']] : [['me', 'My pack'], ['party', 'Party stash']]} />
        <button type="button" className="btn primary small" onClick={() => setEdit({ name: '', qty: 1, note: '' })}>＋ Add item</button>
      </div>
      <ErrorBox error={inv.error ?? act.error} />
      <AlertsCard mine={mine.data} reload={async () => { await Promise.all([mine.reload(), inv.reload()]); }} />
      <div className="cols">
        <section className="col-3 card flush" aria-label="Items">
          {inv.loading && !inv.data ? <div className="empty"><Loading /></div> : inv.data?.items.length ? (
            <ul className="inv-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {inv.data.items.map((it) => {
                const locked = it.status === 'pending' || !!it.pendingChange;
                return (
                  <li key={it.id} className="list-item" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 14px', opacity: it.status === 'pending' ? 0.75 : 1 }}>
                    <ItemImage image={it.image} name={it.name} size={48} onClick={it.image ? () => setViewing(it) : undefined} />
                    <div className="stack tight grow" style={{ minWidth: 0 }}>
                      <div className="row between" style={{ gap: 8, alignItems: 'baseline' }}>
                        <span className="read" style={{ fontSize: 16, overflowWrap: 'anywhere' }}>{it.link ? <a href={it.link} target="_blank" rel="noreferrer">{it.name}</a> : it.name}</span>
                        <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>× {it.qty}{weight && it.weight != null ? <span className="tiny faint"> · {it.weight} each</span> : null}</span>
                      </div>
                      {it.note && <span className="small muted">{it.note}</span>}
                      {locked && <div><span className="chip teal" title="Your DM has not approved this yet">⏳ Waiting for the DM{it.pendingChange?.kind === 'remove' ? ': remove' : it.pendingChange?.kind === 'edit' ? ': change' : ''}</span></div>}
                      {it.pendingChange?.kind === 'edit' && it.pendingChange.to && <div className="tiny faint">→ {Object.entries(it.pendingChange.to).filter(([k, v]) => (it as any)[k] !== v && k !== 'owner' && k !== 'image').map(([k, v]) => `${k} ${v}`).join(', ')}{it.pendingChange.to.owner && it.pendingChange.to.owner !== it.owner ? (it.pendingChange.to.owner === 'party' ? ' to party stash' : ' to my pack') : ''}</div>}
                      {it.updated_by && it.updated_by !== me && <div className="tiny faint">changed by {nameOf(it.updated_by)} · {when(it.updated_at)}</div>}
                      <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                        <button type="button" className="btn small ghost" onClick={() => setEdit(it)}>Edit</button>
                        <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void quickMove(it)}>{it.owner === 'party' ? 'Take' : 'To party'}</button>
                        {giving && !locked && <button type="button" className="btn small ghost" disabled={act.offline} onClick={() => setMoving(it)}>Give / split…</button>}
                        <button type="button" className="btn small ghost" aria-label={`Remove ${it.name}`} disabled={act.busy} onClick={() => void remove(it)}>✕</button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : <Empty>{tab === 'me' ? 'Your pack is empty.' : 'The party stash is empty.'}</Empty>}
          {weight && inv.data && <div className="small muted" style={{ padding: '8px 14px' }}>Total weight: {inv.data.totalWeight ?? 0}</div>}
        </section>
        <aside className="col-1 stack loose">
          <CoinCard owner={tab === 'party' && info.settings.partyPurse ? 'party' : 'me'} data={coin.data} giving={giving} reload={async () => { await Promise.all([coin.reload(), mine.reload()]); }} error={coin.error} />
          {giving && <CoinRequestsCard onChanged={() => void coin.reload()} />}
          {giving && <TransfersList limit={10} />}
        </aside>
      </div>
      {!weight && <p className="tiny faint">Weight tracking is off for this world. Your DM can turn it on in World settings.</p>}
      {moving && <MoveItemModal item={moving} onClose={() => setMoving(null)} onDone={(m) => { setMoving(null); toast(m); void inv.reload(); }} />}
      {viewing && <ImageViewer item={viewing} onClose={() => setViewing(null)} />}
      {edit && <ItemModal item={edit} owner={tab} weight={weight} onClose={() => setEdit(null)} onSaved={async (pending) => { setEdit(null); await Promise.all([inv.reload(), mine.reload()]); toast(pending ? 'Sent to the DM to approve' : 'Saved'); }} />}
      {toastNode}
    </div>
  );
}

function CoinCard({ owner, data, giving, reload, error }: { owner: 'me' | 'party'; data: { cp: number; entries: any[]; pending?: number } | null; giving: boolean; reload: () => Promise<void>; error: string | null }) {
  const { w, info, nameOf } = useWorld();
  const [notice, setNotice] = useState<string | null>(null);
  const [give, setGive] = useState(false);
  const [ask, setAsk] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const act = useAction();
  const cp = parseCoins(amount);
  const apply = (sign: 1 | -1) => act.run(async () => {
    if (!cp) return;
    const r: any = await w.addCoin(owner, sign * Math.abs(cp), note.trim() || undefined);
    setAmount(''); setNote('');
    setNotice(r?.pending ? 'Sent to the DM. It counts once they approve.' : null);
    await reload();
  });
  return (
    <section className="card gold" aria-labelledby="coin-h">
      <h2 id="coin-h">{owner === 'party' ? 'Party pouch' : 'My coin'}</h2>
      <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent-strong)' }}>{data ? coins(data.cp, info.settings.coins) : '…'}</span>
      {!!data?.pending && <span className="small" style={{ color: 'var(--teal)' }}>⏳ {data.pending > 0 ? '+' : ''}{coins(data.pending, info.settings.coins)} waiting for the DM</span>}
      {notice && <span className="small muted" role="status">{notice}</span>}
      <ErrorBox error={error ?? act.error} />
      {giving && (info.settings as { playerChangesNeedApproval?: boolean }).playerChangesNeedApproval !== false && <span className="tiny faint">Adding or spending below needs the DM's OK; giving to another player doesn't.</span>}
      <Field label="Amount" help="e.g. 12 gp 5 sp, or 3 for 3 gp"><input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="12 gp" /></Field>
      <Field label="What for"><input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Room at the inn" /></Field>
      <div className="row">
        <button type="button" className="btn small" disabled={!cp || act.busy} onClick={() => void apply(1)}>＋ Add</button>
        <button type="button" className="btn small" disabled={!cp || act.busy} onClick={() => void apply(-1)}>− Spend</button>
      </div>
      {giving && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className="btn small primary" disabled={act.offline} onClick={() => setGive(true)}>{owner === 'party' ? 'Take or give…' : 'Give coin…'}</button>
          {owner === 'me' && <button type="button" className="btn small ghost" disabled={act.offline} onClick={() => setAsk(true)}>Ask for coin…</button>}
        </div>
      )}
      {give && <GiveCoinModal from={owner === 'party' ? 'party' : 'me'} to={owner === 'party' ? 'me' : undefined} onClose={() => setGive(false)} onDone={(m) => { setGive(false); setNotice(m); void reload(); }} />}
      {ask && <AskCoinModal onClose={() => setAsk(false)} onDone={(m) => { setAsk(false); setNotice(m); }} />}
      {data && data.entries.length > 0 && (
        <ul className="stack tight small" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {data.entries.slice(0, 8).map((e: any) => (
            <li key={e.id} className="row between" style={{ gap: 6, opacity: e.status === 'pending' ? 0.7 : 1 }}>
              <span className="grow">{e.note || (e.amount_cp > 0 ? 'Added' : 'Spent')} <span className="tiny faint">· {nameOf(e.by_id)}{e.status === 'pending' ? ' · waiting for the DM' : ''}</span></span>
              <span style={{ color: e.amount_cp >= 0 ? 'var(--ok-text)' : 'var(--danger-text)' }}>{e.amount_cp >= 0 ? '+' : ''}{coins(e.amount_cp, info.settings.coins)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ItemModal({ item, owner, weight, onClose, onSaved }: { item: Partial<Item>; owner: 'me' | 'party'; weight: boolean; onClose: () => void; onSaved: (pending: boolean) => void }) {
  const { w } = useWorld();
  const [it, setIt] = useState(item);
  const act = useAction();
  const save = () => act.run(async () => {
    const body: Record<string, unknown> = { name: (it.name ?? '').trim(), qty: Number(it.qty) || 0, note: it.note ?? '', link: it.link || '', image: it.image ?? null };
    if (weight && it.weight !== undefined) body.weight = it.weight === null ? null : Number(it.weight);
    const r = it.id ? await w.updateItem(it.id, body) : await w.addItem({ ...body, owner });
    onSaved(sent(r));
  });
  return (
    <Modal title={it.id ? 'Edit item' : owner === 'party' ? 'Add to party stash' : 'Add to my pack'} onClose={onClose}>
      <Field label="Item"><input value={it.name ?? ''} maxLength={120} onChange={(e) => setIt({ ...it, name: e.target.value })} /></Field>
      <div className="row">
        <Field label="Quantity"><input type="number" min={0} value={it.qty ?? 1} onChange={(e) => setIt({ ...it, qty: Number(e.target.value) })} /></Field>
        {weight && <Field label="Weight (each)"><input type="number" min={0} step="0.1" value={it.weight ?? ''} onChange={(e) => setIt({ ...it, weight: e.target.value === '' ? null : Number(e.target.value) })} /></Field>}
      </div>
      <Field label="Note"><input value={it.note ?? ''} maxLength={500} onChange={(e) => setIt({ ...it, note: e.target.value })} /></Field>
      <Field label="Link (optional)" help="A library or Kanka page about it"><input value={it.link ?? ''} maxLength={300} onChange={(e) => setIt({ ...it, link: e.target.value })} /></Field>
      <ImageField value={it.image} name={it.name ?? ''} onChange={(v) => setIt({ ...it, image: v })} />
      <ErrorBox error={act.error} />
      <div className="row end">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={act.busy || !(it.name ?? '').trim()} onClick={() => void save()}>Save</button>
      </div>
    </Modal>
  );
}
