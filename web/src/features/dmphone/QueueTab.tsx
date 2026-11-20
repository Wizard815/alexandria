// Queue: everything waiting on the DM. One tap to approve or reject; swipe a
// card right to approve, left to reject; edit or price in a sheet.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { useAction } from '../../ui/index.tsx';
import { coins } from '../../lib/format.ts';
import { Sheet, Err } from './Sheet.tsx';
import { buzz, gpToCp } from './hooks.ts';
import { ACTIONS_CHANGED, announceActions } from '../agent/Chat.tsx';

const safe = <T,>(p: Promise<T>, d: T): Promise<T> => p.catch(() => d);

type Edit = { kind: 'coin' | 'item' | 'price' | 'request'; row: any };

export default function QueueTab() {
  const { w, nameOf, info } = useWorld();
  const act = useAction();
  const [edit, setEdit] = useState<Edit | null>(null);
  const ap = useLoad<any>(() => safe(w.call('GET', '/approvals'), null), [w], ['approval', 'coin', 'item', 'item-removed']);
  const ag = useLoad<any[]>(() => safe(w.call<any>('GET', '/agent/actions').then((r) => r.actions ?? []), []), [w], ['agent']);
  const br = useLoad<any[]>(() => safe(w.call<any>('GET', '/broker').then((r) => r.requests ?? []), []), [w], ['broker']);
  const rq = useLoad<any[]>(() => safe(w.requests(), []), [w], ['request']);
  const reloadAll = () => Promise.all([ap.reload(), ag.reload(), br.reload(), rq.reload()]);
  const mode = info.settings.coins;

  // The assistant's chat shows the same actions: an approval decided in either is announced to the other at once. Reloaded even
  // when the call fails (another device may have decided it first), so a stale card does not stay.
  useEffect(() => { const h = () => void ag.reload(); window.addEventListener(ACTIONS_CHANGED, h); return () => window.removeEventListener(ACTIONS_CHANGED, h); }, [ag.reload]);
  const call = (method: string, path: string, body?: unknown) => act.run(async () => {
    buzz(15);
    try { await w.call(method, path, body); } finally { await reloadAll(); if (path.startsWith('/agent/actions/')) announceActions(); }
  });
  const decide = (id: string, action: 'approve' | 'reject' | 'revert') => call('POST', `/approvals/${id}`, { action });

  const coinRows: any[] = ap.data?.coin ?? [];
  const itemRows: any[] = ap.data?.items ?? [];
  const disputes: any[] = ap.data?.disputes ?? [];
  const actions = (ag.data ?? []).filter((a) => a.status === 'pending');
  const pricing = (br.data ?? []).filter((q) => q.status === 'pricing');
  const review = (br.data ?? []).filter((q) => q.needs_review);
  const requests = (rq.data ?? []).filter((r) => r.status === 'open');
  const total = coinRows.length + itemRows.length + disputes.length + actions.length + pricing.length + review.length + requests.length;
  const itemLine = (c: any) => { const it = c.after ?? c.before ?? {}; return `${c.kind === 'remove' ? 'Remove' : c.kind === 'add' ? 'Add' : 'Change'} ${it.qty && it.qty !== 1 ? `${it.qty} × ` : ''}${it.name ?? 'an item'}`; };

  return (
    <>
      <Err error={act.error} />
      {total === 0 && !ap.loading && <div className="c"><div className="empty"><i className="fa-solid fa-check" aria-hidden="true" /> Nothing is waiting for you.</div></div>}

      {actions.length > 0 && <Group title="The assistant wants to">{actions.map((a) => (
        <Swipe key={a.id} onYes={() => call('POST', `/agent/actions/${a.id}`, { decision: 'approve' })} onNo={() => call('POST', `/agent/actions/${a.id}`, { decision: 'reject' })}>
          <Card title={a.summary} meta={a.tool}>
            <Pair busy={act.busy} yes="Approve" no="Reject" onYes={() => void call('POST', `/agent/actions/${a.id}`, { decision: 'approve' })} onNo={() => void call('POST', `/agent/actions/${a.id}`, { decision: 'reject' })} />
          </Card>
        </Swipe>))}</Group>}

      {coinRows.length > 0 && <Group title="Coin requests">{coinRows.map((c) => (
        <Swipe key={c.id} onYes={() => decide(c.id, 'approve')} onNo={() => decide(c.id, 'reject')}>
          <Card title={`${nameOf(c.owner === 'party' ? null : c.owner) || 'The party'}: ${coins(c.amount_cp, mode)}`} meta={`${c.note || 'No note'} · from ${nameOf(c.by)}`}>
            <Pair busy={act.busy} yes="Approve" no="Reject" onYes={() => void decide(c.id, 'approve')} onNo={() => void decide(c.id, 'reject')} edit={() => setEdit({ kind: 'coin', row: c })} />
          </Card>
        </Swipe>))}</Group>}

      {itemRows.length > 0 && <Group title="Item changes">{itemRows.map((c) => (
        <Swipe key={c.id} onYes={() => decide(c.id, 'approve')} onNo={() => decide(c.id, 'reject')}>
          <Card title={itemLine(c)} meta={`${nameOf(c.owner === 'party' ? null : c.owner) || 'The party'} · by ${nameOf(c.by)}${c.reason ? ` · ${c.reason}` : ''}`}>
            <Pair busy={act.busy} yes="Approve" no="Reject" onYes={() => void decide(c.id, 'approve')} onNo={() => void decide(c.id, 'reject')} edit={() => setEdit({ kind: 'item', row: c })} />
          </Card>
        </Swipe>))}</Group>}

      {disputes.length > 0 && <Group title="Disputed by a player">{disputes.map((c) => (
        <Card key={c.id} title={itemLine(c)} meta={c.dispute_note || 'No note'}>
          <button type="button" className="b danger full" disabled={act.busy} onClick={() => void decide(c.id, 'revert')}>Revert the change</button>
        </Card>))}</Group>}

      {pricing.length > 0 && <Group title="Broker: price or answer">{pricing.map((q) => (
        <Card key={q.id} title={q.question} meta={`${q.asker_name} · ${q.tier_name}${q.classification?.verdict === 'secret' ? ' · secret' : ''}`}>
          <div className="grid g2">
            <button type="button" className="b primary" disabled={act.busy} onClick={() => setEdit({ kind: 'price', row: q })}>Price and answer</button>
            <button type="button" className="b danger" disabled={act.busy} onClick={() => void call('POST', `/broker/${q.id}/refuse`, {})}>Refuse</button>
          </div>
        </Card>))}</Group>}

      {review.length > 0 && <Group title="Broker: answer ready for review">{review.map((q) => (
        <Card key={q.id} title={q.question} meta={`${q.asker_name} · ${q.tier_name}`}>
          <div className="tx sub">{String(q.answer ?? '').slice(0, 240)}</div>
          <Pair busy={act.busy} yes="Send answer" no="Refuse" onYes={() => void call('POST', `/broker/${q.id}/deliver`, {})} onNo={() => void call('POST', `/broker/${q.id}/refuse`, {})} />
        </Card>))}</Group>}

      {requests.length > 0 && <Group title="Player requests">{requests.map((r) => (
        <Card key={r.id} title={r.title} meta={`${nameOf(r.author_id)} · ${r.kind}`}>
          <div className="tx sub">{String(r.body).slice(0, 240)}</div>
          <div className="grid g2">
            <button type="button" className="b ok" disabled={act.busy} onClick={() => setEdit({ kind: 'request', row: r })}>Reply</button>
            <button type="button" className="b danger" disabled={act.busy} onClick={() => void call('POST', `/requests/${r.id}/decide`, { decision: 'rejected' })}>Decline</button>
          </div>
        </Card>))}</Group>}

      {edit && <EditSheet edit={edit} busy={act.busy} mode={mode} onClose={() => setEdit(null)} send={async (method, path, body) => { await call(method, path, body); setEdit(null); }} />}
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className="grid" aria-label={title}><h3 className="sub" style={{ margin: '4px 2px 0', textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 12 }}>{title}</h3>{children}</section>;
}
function Card({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return <div className="c" role="group" aria-label={title}><div className="tx"><b>{title}</b>{meta && <div className="sub">{meta}</div>}</div>{children}</div>;
}
function Pair({ yes, no, onYes, onNo, edit, busy }: { yes: string; no: string; onYes: () => void; onNo: () => void; edit?: () => void; busy: boolean }) {
  return (
    <div className={`grid ${edit ? 'g3' : 'g2'}`}>
      <button type="button" className="b ok" disabled={busy} onClick={onYes}>{yes}</button>
      {edit && <button type="button" className="b" disabled={busy} onClick={edit}>Edit</button>}
      <button type="button" className="b danger" disabled={busy} onClick={onNo}>{no}</button>
    </div>
  );
}

/** Drag a card right to say yes, left to say no. Taps and the buttons still work. */
function Swipe({ onYes, onNo, children }: { onYes: () => unknown; onNo: () => unknown; children: ReactNode }) {
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const [dx, setDx] = useState(0);
  const THRESH = 100;
  return (
    <div className="swipe" style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dx ? 'none' : 'transform .15s', outline: dx > THRESH ? '2px solid var(--ok)' : dx < -THRESH ? '2px solid var(--danger)' : 'none', borderRadius: 14 }}
      onPointerDown={(e) => { if (e.pointerType === 'mouse' || (e.target as HTMLElement).closest('button')) return; start.current = { x: e.clientX, y: e.clientY, id: e.pointerId }; }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s || s.id !== e.pointerId) return;
        const x = e.clientX - s.x;
        if (Math.abs(e.clientY - s.y) > 30 && Math.abs(x) < 30) { start.current = null; setDx(0); return; }
        if (Math.abs(x) > 12) setDx(Math.max(-160, Math.min(160, x)));
      }}
      onPointerUp={() => { const d = dx; start.current = null; setDx(0); if (d > THRESH) { buzz(20); void onYes(); } else if (d < -THRESH) { buzz([20, 40, 20]); void onNo(); } }}
      onPointerCancel={() => { start.current = null; setDx(0); }}>
      {children}
    </div>
  );
}

function EditSheet({ edit, busy, mode, onClose, send }: { edit: Edit; busy: boolean; mode: 'gsc' | 'all' | 'gold'; onClose: () => void; send: (m: string, p: string, b?: unknown) => Promise<void> }) {
  const r = edit.row;
  const [gp, setGp] = useState(edit.kind === 'coin' ? String(r.amount_cp / 100) : edit.kind === 'price' ? '0' : '');
  const [text, setText] = useState(edit.kind === 'price' ? String(r.answer ?? '') : '');
  const [name, setName] = useState(String((r.after ?? r.before)?.name ?? ''));
  const [qty, setQty] = useState(String((r.after ?? r.before)?.qty ?? 1));
  const [hours, setHours] = useState('0');
  const cp = gpToCp(gp);

  if (edit.kind === 'coin') {
    return (
      <Sheet title="Edit coin request" onClose={onClose}>
        <span className="sub">Asked for {coins(r.amount_cp, mode)}. Amounts are in gold.</span>
        <label className="f">Amount (gp)<input inputMode="decimal" value={gp} onChange={(e) => setGp(e.target.value)} /></label>
        <button type="button" className="b primary big full" disabled={busy || cp === null || cp === 0} onClick={() => void send('POST', `/approvals/${r.id}`, { action: 'edit', amountCp: cp })}>Approve {cp !== null ? coins(cp, mode) : ''}</button>
      </Sheet>
    );
  }
  if (edit.kind === 'item') {
    return (
      <Sheet title="Edit item change" onClose={onClose}>
        <label className="f">Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="f">Quantity<input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} /></label>
        <button type="button" className="b primary big full" disabled={busy || !name.trim()} onClick={() => void send('POST', `/approvals/${r.id}`, { action: 'edit', item: { name: name.trim(), qty: Number(qty) || 0 } })}>Approve with these edits</button>
      </Sheet>
    );
  }
  if (edit.kind === 'price') {
    return (
      <Sheet title="Price and answer" onClose={onClose}>
        <div className="tx"><b>{r.question}</b></div>
        {r.answer && <button type="button" className="b" onClick={() => setText(String(r.answer))}>Use the drafted answer</button>}
        <label className="f">Price (gp)<input inputMode="decimal" value={gp} onChange={(e) => setGp(e.target.value)} /></label>
        <label className="f">Wait (game hours)<input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value.replace(/\D/g, ''))} /></label>
        <label className="f">Answer<textarea value={text} onChange={(e) => setText(e.target.value)} /></label>
        <button type="button" className="b primary big full" disabled={busy || cp === null || !text.trim()} onClick={() => void send('POST', `/broker/${r.id}/price`, { costCp: cp, answer: text.trim(), waitAmount: Number(hours) || 0, waitUnit: 'hours', clock: 'game' })}>Offer it to {r.asker_name}</button>
      </Sheet>
    );
  }
  return (
    <Sheet title={String(r.title)} onClose={onClose}>
      <div className="tx sub">{String(r.body).slice(0, 600)}</div>
      <label className="f">Your reply<textarea value={text} onChange={(e) => setText(e.target.value)} /></label>
      <button type="button" className="b primary big full" disabled={busy} onClick={() => void send('POST', `/requests/${r.id}/decide`, { decision: 'accepted', reply: text.trim() || undefined })}>Accept and reply</button>
    </Sheet>
  );
}
