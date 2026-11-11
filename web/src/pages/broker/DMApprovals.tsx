// What players asked to change (coin and items), what they disputed, and
// the DM's own changes still waiting for the owner to confirm.
import { useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { coins, parseCoins, when } from '../../lib/format.ts';
import { PageHead, Loading, ErrorBox, Empty, Field, Modal, useAction, useToast } from '../../ui/index.tsx';
import { type Change, type CoinReq, StatusChip, changeText } from './shared.tsx';

interface Queue { coin: CoinReq[]; items: Change[]; disputes: Change[]; alerts: Change[]; recent: Change[]; counts: { coin: number; items: number; disputes: number } }

export default function DMApprovals() {
  const { w, info, nameOf } = useWorld();
  const q = useLoad(() => w.call<Queue>('GET', '/approvals'), [w], ['approval', 'item', 'coin']);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [editCoin, setEditCoin] = useState<CoinReq | null>(null);
  const [editItem, setEditItem] = useState<Change | null>(null);
  const decide = (id: string, action: string, label: string, body: Record<string, unknown> = {}) => act.run(async () => {
    await w.call('POST', `/approvals/${id}`, { action, ...body });
    await q.reload();
    toast(label);
  });
  const owner = (o: string) => (o === 'party' ? 'Party' : nameOf(o));
  const d = q.data;
  const total = d ? d.coin.length + d.items.length + d.disputes.length : 0;

  return (
    <div className="page">
      <PageHead title="Approvals" lead="Players' coin and item changes wait here for you. Your own changes to their things go through at once, and they can confirm or dispute them." />
      <ErrorBox error={q.error ?? act.error} />
      {!d ? <Loading /> : (
        <>
          <div className="grid small">
            <div className="stat"><span className="small muted">Coin</span><b>{d.counts.coin}</b></div>
            <div className="stat"><span className="small muted">Items</span><b>{d.counts.items}</b></div>
            <div className="stat"><span className="small muted">Disputes</span><b>{d.counts.disputes}</b></div>
            <div className="stat"><span className="small muted">Unconfirmed</span><b>{d.alerts.length}</b></div>
          </div>
          {!total && <div className="ok-box">Nothing waiting on you.</div>}

          {!!d.disputes.length && (
            <section className="card" aria-labelledby="disp-h">
              <h2 id="disp-h">Disputed</h2>
              {d.disputes.map((c) => (
                <div key={c.id} className="list-item" style={{ display: 'block' }}>
                  <div className="row between"><span>{changeText(c, nameOf)}</span><StatusChip s="disputed" /></div>
                  <div className="small muted">You changed {owner(c.owner)}'s item {when(c.at)}{c.reason ? `: “${c.reason}”` : ''}</div>
                  <div className="small">They say: “{c.dispute_note}”</div>
                  <div className="row" style={{ marginTop: 6 }}>
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => void decide(c.id, 'revert', 'Undone')}>Undo my change</button>
                  </div>
                </div>
              ))}
            </section>
          )}

          <section className="card" aria-labelledby="coin-h">
            <h2 id="coin-h">Coin requests</h2>
            {!d.coin.length ? <Empty>No coin waiting.</Empty> : d.coin.map((c) => (
              <div key={c.id} className="list-item row between" style={{ flexWrap: 'wrap', gap: 8 }}>
                <div className="stack tight grow">
                  <span><strong style={{ color: c.amount_cp >= 0 ? 'var(--ok-text)' : 'var(--danger-text)' }}>{c.amount_cp > 0 ? '+' : ''}{coins(c.amount_cp, info.settings.coins)}</strong> {c.owner === 'party' ? 'to the party purse' : `for ${owner(c.owner)}`}</span>
                  <span className="small muted">{c.note || 'No note'} · {nameOf(c.by)} · {when(c.at)}</span>
                </div>
                <span className="row" style={{ gap: 4 }}>
                  <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void decide(c.id, 'approve', 'Approved')}>Approve</button>
                  <button type="button" className="btn small" onClick={() => setEditCoin(c)}>Edit</button>
                  <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void decide(c.id, 'reject', 'Rejected')}>Reject</button>
                </span>
              </div>
            ))}
          </section>

          <section className="card" aria-labelledby="items-h">
            <h2 id="items-h">Item changes</h2>
            {!d.items.length ? <Empty>No item changes waiting.</Empty> : d.items.map((c) => (
              <div key={c.id} className="list-item row between" style={{ flexWrap: 'wrap', gap: 8 }}>
                <div className="stack tight grow">
                  <span>{changeText(c, nameOf)}</span>
                  <span className="small muted">{nameOf(c.by)} · {owner(c.owner)} · {when(c.at)}</span>
                </div>
                <span className="row" style={{ gap: 4 }}>
                  <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void decide(c.id, 'approve', 'Approved')}>Approve</button>
                  {c.kind !== 'remove' && <button type="button" className="btn small" onClick={() => setEditItem(c)}>Edit</button>}
                  <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void decide(c.id, 'reject', 'Rejected')}>Reject</button>
                </span>
              </div>
            ))}
          </section>

          {!!d.alerts.length && (
            <section className="card" aria-labelledby="al-h">
              <h2 id="al-h">Your changes, not yet confirmed</h2>
              {d.alerts.map((c) => (
                <div key={c.id} className="list-item row between" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <div className="stack tight grow">
                    <span className="small">{changeText(c, nameOf)}</span>
                    <span className="tiny faint">{owner(c.owner)} · {when(c.at)}{c.reason ? ` · “${c.reason}”` : ''}</span>
                  </div>
                  <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => { if (window.confirm('Undo this change?')) void decide(c.id, 'revert', 'Undone'); }}>Undo</button>
                </div>
              ))}
            </section>
          )}

          {!!d.recent.length && (
            <details className="card">
              <summary>Recently decided</summary>
              {d.recent.map((c) => (
                <div key={c.id} className="list-item row between"><span className="small">{changeText(c, nameOf)} <span className="tiny faint">· {owner(c.owner)}</span></span><StatusChip s={c.status} /></div>
              ))}
            </details>
          )}
        </>
      )}
      {editCoin && <CoinModal c={editCoin} onClose={() => setEditCoin(null)} onSave={async (amountCp, note) => { await decide(editCoin.id, 'edit', 'Approved with changes', { amountCp, note }); setEditCoin(null); }} />}
      {editItem && <ItemModal c={editItem} onClose={() => setEditItem(null)} onSave={async (item) => { await decide(editItem.id, 'edit', 'Approved with changes', { item }); setEditItem(null); }} />}
      {toastNode}
    </div>
  );
}

function CoinModal({ c, onClose, onSave }: { c: CoinReq; onClose: () => void; onSave: (amountCp: number, note: string) => Promise<void> }) {
  const [amount, setAmount] = useState(coins(Math.abs(c.amount_cp), 'gsc'));
  const [sign, setSign] = useState(c.amount_cp < 0 ? -1 : 1);
  const [note, setNote] = useState(c.note ?? '');
  const cp = parseCoins(amount);
  return (
    <Modal title="Edit and approve" onClose={onClose}>
      <div className="row">
        <Field label="Direction"><select value={sign} onChange={(e) => setSign(Number(e.target.value))}><option value={1}>Add</option><option value={-1}>Spend</option></select></Field>
        <Field label="Amount"><input value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      </div>
      <Field label="Note"><input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="row end">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!cp} onClick={() => void onSave(sign * Math.abs(cp!), note)}>Approve</button>
      </div>
    </Modal>
  );
}

function ItemModal({ c, onClose, onSave }: { c: Change; onClose: () => void; onSave: (item: Record<string, unknown>) => Promise<void> }) {
  const a = { ...(c.before ?? {}), ...(c.after ?? {}) };
  const [name, setName] = useState(String(a.name ?? ''));
  const [qty, setQty] = useState(Number(a.qty ?? 1));
  const [note, setNote] = useState(String(a.note ?? ''));
  const [dmNote, setDmNote] = useState(String(a.dm_note ?? ''));
  return (
    <Modal title="Edit and approve" onClose={onClose}>
      <Field label="Item"><input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Quantity"><input type="number" min={0} value={qty} onChange={(e) => setQty(Math.max(0, Number(e.target.value) || 0))} /></Field>
      <Field label="Note the owner sees"><input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
      <Field label="DM note (only you)"><input value={dmNote} maxLength={500} onChange={(e) => setDmNote(e.target.value)} /></Field>
      <div className="row end">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!name.trim()} onClick={() => void onSave({ name: name.trim(), qty, note, dmNote })}>Approve</button>
      </div>
    </Modal>
  );
}
