// "Share…" on a library page: with everyone (the party) or chosen players. The recipient gets the same player copy you see.
import { useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { ErrorBox, Modal, useAction } from '../../ui/index.tsx';

interface Share { from?: string; to: string; toName: string; fromName: string; kind: string; mine?: boolean }

export function ShareButton({ pageId }: { pageId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn small" onClick={() => setOpen(true)}><i className="fa-solid fa-share-nodes" aria-hidden="true" /> Share…</button>
      {open && <ShareDialog pageId={pageId} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareDialog({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const { w, members, me, isDM } = useWorld();
  const base = `/library/pages/${encodeURIComponent(pageId)}/share`;
  const list = useLoad<{ shares: Share[] }>(() => w.call('GET', base), [w, pageId]);
  const act = useAction();
  const [picked, setPicked] = useState<string[]>([]);
  const players = members.filter((m) => m.role === 'player' && m.id !== me);
  const share = (to: 'party' | string[]) => act.run(async () => { await w.call('POST', base, { to }); setPicked([]); await list.reload(); });
  const stop = (to: string) => act.run(async () => { await w.call('DELETE', `${base}?to=${encodeURIComponent(to)}`); await list.reload(); });
  return (
    <Modal title="Share this page" onClose={onClose}>
      <ErrorBox error={act.error ?? list.error} />
      <p className="small muted">They see the same copy you do. Secret parts and anything above the player level stay hidden.</p>
      <div className="stack">
        <button type="button" className="btn" disabled={act.busy} onClick={() => void share('party')}>Everyone</button>
        <div className="stack tight">
          {players.map((m) => <label key={m.id} className="row" style={{ gap: 6 }}><input type="checkbox" checked={picked.includes(m.id)} onChange={() => setPicked(picked.includes(m.id) ? picked.filter((x) => x !== m.id) : [...picked, m.id])} /> {m.character_name || m.display_name}</label>)}
          <div className="row"><button type="button" className="btn primary" disabled={act.busy || !picked.length} onClick={() => void share(picked)}>Share with the chosen</button></div>
        </div>
        <h3 style={{ margin: '8px 0 0' }}>Shared with</h3>
        {!list.data?.shares.length && <p className="small muted">Nobody yet.</p>}
        {list.data?.shares.map((s) => <div key={`${s.from ?? s.fromName}-${s.to}`} className="row between"><span>{s.toName} <span className="tiny muted">from {s.fromName}</span></span>{isDM || s.mine ? <button type="button" className="btn small danger" disabled={act.busy} onClick={() => void stop(s.to)}>Stop sharing</button> : <span className="tiny muted">only {s.fromName} can stop this</span>}</div>)}
      </div>
    </Modal>
  );
}
