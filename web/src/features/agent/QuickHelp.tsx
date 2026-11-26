// The quick helper: one-tap answers from a small second model (rules, my turn, my sheet, what next). It keeps no
// chat; every tap starts fresh from the player's sheet, recent events and a few rules and library passages. When a
// question needs more, it hands off: the text goes into the table helper's box, or the broker's.
import { useEffect, useState } from 'react';
import { Markdown } from '../../ui/index.tsx';
import { useWorld } from '../../lib/world.tsx';

export type QuickTask = 'ask' | 'rules' | 'turn' | 'sheet' | 'suggest';
export interface QuickHandoff { to: 'broker' | 'helper'; reason: string; question: string }
interface Answer { task: QuickTask; answer: string; handoff: QuickHandoff | null; model: string | null; ms: number; brief: { chars: number; sections: string[] } }

const BUTTONS: { task: QuickTask; label: string; icon: string }[] = [
  { task: 'turn', label: 'My turn', icon: 'fa-dice-d20' },
  { task: 'sheet', label: 'Sum up my sheet', icon: 'fa-id-card' },
  { task: 'suggest', label: 'What next?', icon: 'fa-lightbulb' },
];

export default function QuickHelp({ onHandoff }: { onHandoff: (h: QuickHandoff) => void }) {
  const { w, info } = useWorld();
  const [status, setStatus] = useState<{ on: boolean; available: boolean; model: string | null } | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<QuickTask | null>(null);
  const [res, setRes] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const settingOn = (info?.settings as any)?.quickHelper !== false;

  useEffect(() => { w.call<any>('GET', '/helper/quick').then(setStatus).catch(() => setStatus(null)); }, [w, settingOn]);
  if (!settingOn || !status?.on || !status.available) return null;

  const run = async (task: QuickTask, question = '') => {
    setBusy(task); setError(''); setRes(null);
    try { setRes(await w.call<Answer>('POST', '/helper/quick', { task, question })); }
    catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(null); }
  };
  const ask = (e: React.FormEvent) => {
    e.preventDefault();
    const t = q.trim();
    if (!t) return;
    void run(/\b(rule|rules|how does|how do|can i|what does .* do|condition|spell|action)\b/i.test(t) ? 'rules' : 'ask', t);
  };

  return (
    <section className="card quick-help" aria-label="Quick help" data-testid="quick-help">
      <div className="row between">
        <strong><i className="fa-solid fa-bolt" aria-hidden /> Quick help</strong>
        {status.model && <span className="muted small" title="The small model that answers">{status.model}</span>}
      </div>
      <div className="row" style={{ gap: 6, margin: '6px 0' }}>
        {BUTTONS.map((b) => (
          <button key={b.task} type="button" className="btn small" disabled={!!busy} onClick={() => void run(b.task)} data-testid={`quick-${b.task}`}>
            <i className={`fa-solid ${busy === b.task ? 'fa-spinner fa-spin' : b.icon}`} aria-hidden /> {b.label}
          </button>
        ))}
      </div>
      <form className="row" onSubmit={ask} style={{ gap: 6 }}>
        <input className="input grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="A rules question, or anything quick" maxLength={400} aria-label="Quick question" />
        <button type="submit" className="btn small" disabled={!!busy || !q.trim()}>{busy === 'ask' || busy === 'rules' ? <i className="fa-solid fa-spinner fa-spin" aria-hidden /> : 'Ask'}</button>
      </form>
      {error && <p className="error small" role="alert">{error}</p>}
      {res && res.answer && (
        <div className="quick-answer" data-testid="quick-answer">
          <Markdown text={res.answer} />
          <p className="muted small" style={{ margin: 0 }}>
            {(res.ms / 1000).toFixed(1)} s · from {res.brief.sections.join(', ').toLowerCase() || 'nothing yet'}
            {' · '}<button type="button" className="btn small ghost quick-link" onClick={() => onHandoff({ to: 'helper', reason: '', question: res.task === 'ask' || res.task === 'rules' ? q : '' })}>Ask the table helper instead</button>
          </p>
        </div>
      )}
      {res?.handoff && (
        <div className="quick-handoff" data-testid="quick-handoff">
          <p className="small" style={{ margin: '4px 0' }}>{res.handoff.reason}</p>
          <button type="button" className="btn small primary" onClick={() => onHandoff(res.handoff!)}>
            {res.handoff.to === 'broker' ? 'Ask the broker' : 'Ask the table helper'}
          </button>
        </div>
      )}
    </section>
  );
}
