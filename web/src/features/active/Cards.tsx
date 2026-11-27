// Confirm cards (an "ask" action waiting for a tap) and the undo toast for what
// ran by itself. Used on the desktop (an overlay) and the GM phone.
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useWorld } from '../../lib/world.tsx';
import { useAction } from '../../ui/index.tsx';
import { seesText, useActive, useActiveLog, type LogRow } from './shared.tsx';
import ThoughtsIsland, { useThoughtPrefs } from './Thoughts.tsx';
import './active.css';

export function ConfirmCards({ phone = false }: { phone?: boolean }) {
  const { w } = useWorld();
  const st = useActive();
  const act = useAction();
  const cards = st.data?.cards ?? [];
  if (!cards.length) return null;
  const decide = (c: LogRow, verb: 'approve' | 'dismiss' | 'reject') => act.run(async () => { await w.call('POST', `/active/log/${c.id}/${verb}`, {}); await st.reload(); });
  return (
    <div className={`act-cards${phone ? ' phone' : ''}`} data-testid="active-cards" role="region" aria-label="Waiting for your tap">
      {cards.slice(0, 3).map((c) => (
        <div key={c.id} className="act-card" data-testid="active-card">
          <div className="act-card-head"><span className="chip gold">Active</span><span className="tiny muted">{seesText(c.visible)}</span></div>
          <div className="act-card-sum">{c.summary}</div>
          {c.cue && <div className="tiny muted">{c.trigger === 'line' ? `${c.speaker || 'Table'} said: ` : ''}“{c.cue.slice(0, 110)}”</div>}
          <div className="row">
            <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void decide(c, 'approve')}>Do it</button>
            <button type="button" className="btn small" disabled={act.busy} onClick={() => void decide(c, 'dismiss')}>Dismiss</button>
            <button type="button" className="btn small ghost" disabled={act.busy} title="Dismiss and never do this for that cue again" onClick={() => void decide(c, 'reject')}>Not this</button>
          </div>
        </div>
      ))}
      {cards.length > 3 && <div className="tiny muted">{cards.length - 3} more waiting on the Active page</div>}
    </div>
  );
}

/** A toast with Undo for each thing Minerva did by herself while you watched. */
export function UndoToasts({ phone = false }: { phone?: boolean }) {
  const { w } = useWorld();
  const log = useActiveLog(20);
  const [shown, setShown] = useState<LogRow | null>(null);
  const seen = useRef<string | null>(null);
  const first = useRef(true);
  useEffect(() => {
    const rows = log.data?.log ?? [];
    const newest = rows.find((r) => r.status === 'done' && (r.trigger === 'line' || r.trigger === 'wake'));
    if (first.current) { first.current = false; seen.current = newest?.id ?? null; return; }
    if (newest && newest.id !== seen.current) { seen.current = newest.id; setShown(newest); const t = setTimeout(() => setShown((x) => (x?.id === newest.id ? null : x)), 9000); return () => clearTimeout(t); }
  }, [log.data]);
  if (!shown) return null;
  return (
    <div className={`act-toast${phone ? ' phone' : ''}`} role="status" data-testid="active-toast">
      <span className="grow">{shown.summary}</span>
      {shown.reversible
        ? <button type="button" className="btn small" onClick={() => { void w.call('POST', `/active/log/${shown.id}/undo`, {}).then(() => log.reload()); setShown(null); }}>Undo</button>
        : <span className="tiny muted">cannot be undone</span>}
      <button type="button" className="btn small ghost" aria-label="Close" onClick={() => setShown(null)}>×</button>
    </div>
  );
}

export default function ActiveOverlay() {
  const { info } = useWorld();
  const loc = useLocation();
  const th = useThoughtPrefs();
  if (info?.role !== 'dm' || /\/gm\/phone\/?$/.test(loc.pathname)) return null;
  // With Minerva's thoughts open, the cards and what she did are in that window: not twice on screen.
  return <><ThoughtsIsland />{!th.open && <><ConfirmCards /><UndoToasts /></>}</>;
}
