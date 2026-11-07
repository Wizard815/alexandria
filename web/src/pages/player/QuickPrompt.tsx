// Pops up over any player screen when the DM sends a quick event that is
// for me. Flow: answer (choice or roll) -> "sent, waiting" -> outcome.
// Players only ever see their own outcome; the DC and the other result text
// never reach the browser (the librarian filters them).
import { useEffect, useMemo, useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { useAction, ErrorBox } from '../../ui/index.tsx';

const CHECKS = ['recall', 'notice', 'save', 'read', 'group', 'contest'];
const KIND_LABEL: Record<string, string> = {
  recall: 'Recall', notice: 'Notice', save: 'Saving throw', read: 'Read a person', group: 'Group check', contest: 'Contest',
  choice: 'Timed choice', vote: 'Party vote', reaction: 'Reaction', twist: 'Twist of fate',
};

interface QE {
  id: string; kind: string; title: string; prompt: string; options: string[]; skill: string | null;
  timer_s: number | null; closes_at: string | null; status: string; created_at: string;
  mine: { choice: number | null; roll: number | null; total: number | null; result: string | null } | null;
  tally?: number[]; outcome?: string | null;
}

const DISMISSED = 'alx.qe.dismissed';
// Outcomes pop up again only for events from the last 12 hours.
const OUTCOME_MS = 12 * 3600 * 1000;
function loadDismissed(): string[] {
  try { return JSON.parse(localStorage.getItem(DISMISSED) || '[]'); } catch { return []; }
}

export default function QuickPrompt() {
  const { w } = useWorld();
  const list = useLoad(() => w.quickEvents() as Promise<QE[]>, [w], ['quick-event', 'quick-event-cancelled']);
  const [dismissed, setDismissed] = useState<string[]>(loadDismissed);

  // Show the newest event that still needs me, or whose outcome I haven't seen.
  const ev = useMemo(() => (list.data ?? []).find((e) => !dismissed.includes(e.id) && (
    (e.status === 'open') || (e.status === 'resolved' && e.mine && e.mine.result && Date.now() - Date.parse(e.created_at) < OUTCOME_MS)
  )), [list.data, dismissed]);

  if (!ev) return null;
  const close = () => {
    const next = [...dismissed, ev.id].slice(-200);
    setDismissed(next);
    try { localStorage.setItem(DISMISSED, JSON.stringify(next)); } catch { /* ignore */ }
  };
  return <Prompt key={ev.id} ev={ev} onClose={close} onAnswered={() => void list.reload()} />;
}

function useCountdown(closes: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!closes) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [closes]);
  if (!closes) return null;
  return Math.max(0, Math.ceil((Date.parse(closes) - now) / 1000));
}

function Prompt({ ev, onClose, onAnswered }: { ev: QE; onClose: () => void; onAnswered: () => void }) {
  const { w } = useWorld();
  const left = useCountdown(ev.status === 'open' ? ev.closes_at : null);
  const act = useAction();
  const [roll, setRoll] = useState('');
  const [mod, setMod] = useState('0');
  const isCheck = CHECKS.includes(ev.kind);
  const answered = !!ev.mine;
  const resolved = ev.status === 'resolved';
  const timeUp = left === 0 && !answered && ev.status === 'open';

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && (answered || resolved || timeUp)) onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [answered, resolved, timeUp, onClose]);

  const send = (body: Record<string, unknown>) => act.run(async () => {
    await w.respond(ev.id, body as any);
    onAnswered();
  });

  const pct = ev.timer_s && left !== null ? Math.round((left / ev.timer_s) * 100) : null;
  const titleId = `qe-${ev.id}`;
  return (
    <div className="modal-back">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ borderColor: 'var(--accent)', borderWidth: 2 }}>
        <div className="row between">
          <span className="tiny" style={{ letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--accent)' }}>
            {KIND_LABEL[ev.kind] ?? ev.kind}{ev.skill ? ` · ${ev.skill}` : ''}
          </span>
          {left !== null && !answered && (
            <span role="timer" aria-live="off" aria-label={`${left} seconds left`} className="chip gold" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
              {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
            </span>
          )}
        </div>
        {pct !== null && !answered && (
          <div role="progressbar" aria-label="Time left" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} style={{ height: 4, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', transition: 'width 0.25s linear' }} />
          </div>
        )}
        <h2 id={titleId} style={{ fontSize: 23 }}>{ev.title}</h2>
        <p className="read">{ev.prompt}</p>

        {!answered && !resolved && !timeUp && (
          isCheck ? (
            <div className="stack">
              <div className="row">
                <label className="field" style={{ width: 130 }}><span className="label">Your d20 roll</span>
                  <input inputMode="numeric" value={roll} onChange={(e) => setRoll(e.target.value.replace(/\D/g, '').slice(0, 2))} placeholder="1–20" />
                </label>
                <label className="field" style={{ width: 110 }}><span className="label">Modifier</span>
                  <input inputMode="numeric" value={mod} onChange={(e) => setMod(e.target.value.replace(/[^\d-]/g, '').slice(0, 3))} />
                </label>
              </div>
              <div className="row">
                <button type="button" className="btn primary" disabled={act.busy || !roll || Number(roll) < 1 || Number(roll) > 20}
                  onClick={() => void send({ roll: Number(roll), modifier: Number(mod) || 0 })}>Send my roll</button>
                <button type="button" className="btn" disabled={act.busy} onClick={() => void send({ modifier: Number(mod) || 0 })}>Roll for me</button>
                <button type="button" className="btn ghost" disabled={act.busy} onClick={() => void send({ pass: true })}>Pass</button>
              </div>
              <span className="tiny faint">Your total goes to the DM. You only learn the result if the DM shares it.</span>
            </div>
          ) : (
            <div className="stack">
              {(ev.options.length ? ev.options : ['Go!']).map((o, i) => (
                <button key={i} type="button" className={`btn${i === 0 ? ' primary' : ''}`} style={{ minHeight: 48, justifyContent: 'space-between', fontSize: 17 }}
                  disabled={act.busy} onClick={() => void send({ choice: i })}>
                  <span>{o}</span>
                  {ev.tally && <span className="tiny">{ev.tally[i] ?? 0} vote{ev.tally[i] === 1 ? '' : 's'}</span>}
                </button>
              ))}
              {ev.kind === 'reaction' && <span className="tiny faint">Fastest answer wins.</span>}
              {ev.kind === 'vote' && <span className="tiny faint">{ev.tally ? 'Votes are shown to everyone.' : 'The DM sees the votes.'}</span>}
            </div>
          )
        )}

        {timeUp && <div className="note" role="status">Time ran out.</div>}

        {answered && !resolved && (
          <div className="card" role="status" style={{ background: 'var(--bg)' }}>
            <strong style={{ color: 'var(--accent-strong)' }}>
              {ev.mine!.total !== null ? `You rolled ${ev.mine!.total}${ev.mine!.roll !== null && ev.mine!.roll !== ev.mine!.total ? ` (${ev.mine!.roll} on the die)` : ''}`
                : ev.mine!.choice !== null ? `You chose: ${ev.options[ev.mine!.choice] ?? 'your answer'}` : 'You passed'}
            </strong>
            <span className="muted">Sent. Waiting for the DM…</span>
          </div>
        )}

        {resolved && (
          <div className={ev.mine?.result === 'success' ? 'ok-box' : 'note'} role="status">
            <strong>{!isCheck && ev.kind !== 'reaction' ? 'The DM has decided' : ev.mine?.result === 'success' ? (ev.kind === 'reaction' ? 'You were first' : 'It works') : ev.mine?.result === 'fail' ? 'Not this time' : 'Resolved'}</strong>
            {ev.outcome && <p className="read" style={{ marginTop: 6 }}>{ev.outcome}</p>}
          </div>
        )}

        <ErrorBox error={act.error} />
        {(answered || resolved || timeUp) && (
          <div className="row end"><button type="button" className="btn" onClick={onClose}>Close</button></div>
        )}
      </div>
    </div>
  );
}
