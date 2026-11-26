// The quick helper: one-tap answers from a small second model (rules, my turn, my sheet, what next). It keeps no
// chat; every tap starts fresh from the player's sheet, recent events and a few rules and library passages. When a
// question needs more, it hands off: the text goes into the table helper's box, or to the broker. A question the
// player's character does not know the answer to can go to the broker in the background: it is priced like any
// broker question, the player pays (or not), and the answer arrives on the Broker page as usual.
import { useEffect, useState } from 'react';
import { Markdown } from '../../ui/index.tsx';
import { useWorld } from '../../lib/world.tsx';
import { coins } from '../../lib/format.ts';

export type QuickTask = 'ask' | 'rules' | 'turn' | 'sheet' | 'suggest' | 'recap';
export interface QuickHandoff { to: 'broker' | 'helper'; reason: string; question: string }
interface Answer { task: QuickTask; answer: string; handoff: QuickHandoff | null; model: string | null; ms: number; brief: { chars: number; sections: string[] } }

const BUTTONS: { task: QuickTask; label: string; icon: string }[] = [
  { task: 'turn', label: 'My turn', icon: 'fa-dice-d20' },
  { task: 'sheet', label: 'Sum up my sheet', icon: 'fa-id-card' },
  { task: 'suggest', label: 'What next?', icon: 'fa-lightbulb' },
  { task: 'recap', label: 'Story so far', icon: 'fa-book-open' },
];

interface Quote { quoteId: string; cost_cp: number | null; wait_text: string; secret: boolean; refused?: boolean; line: string; kind: 'priced' | 'secret' | 'other' | 'offtopic'; answer?: string }

/** Ask the broker without leaving the card: get the price, then pay and ask. The answer comes on the Broker page. */
function BrokerInBackground({ question, onChat }: { question: string; onChat: (q: string) => void }) {
  const { w } = useWorld();
  const [text, setText] = useState(question);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e: any) { setError(e?.message ?? String(e)); } finally { setBusy(false); } };
  const price = () => go(async () => {
    const qt = await w.call<Quote>('POST', '/broker/quote', { question: text.trim(), length: 'short' });
    if (qt.kind === 'other') { await w.call('POST', '/broker/ask', { quoteId: qt.quoteId }); setDone(qt.answer || qt.line); return; }
    if (qt.refused || qt.kind === 'offtopic') { setDone(qt.line); return; }
    setQuote(qt);
  });
  const pay = () => go(async () => {
    if (!quote) return;
    const r = await w.call<any>('POST', '/broker/ask', { quoteId: quote.quoteId });
    setQuote(null);
    setDone(r.status === 'pricing' ? 'Sent. The DM sets the price; you will see it on the Broker page.' : r.status === 'noted' ? 'The broker has nothing for you on that.' : 'Sent. The broker is asking around; the answer will show up on the Broker page.');
  });
  if (done) return <p className="small" data-testid="quick-broker-done" style={{ margin: '4px 0' }}>{done}</p>;
  return (
    <div data-testid="quick-broker">
      <div className="row" style={{ gap: 6 }}>
        <input className="input grow" value={text} onChange={(e) => { setText(e.target.value); setQuote(null); }} maxLength={500} placeholder="What should the broker find out?" aria-label="Question for the broker" />
        {!quote && <button type="button" className="btn small primary" disabled={busy || !text.trim()} onClick={() => void price()}>{busy ? <i className="fa-solid fa-spinner fa-spin" aria-hidden /> : 'Ask the broker'}</button>}
      </div>
      {quote && (
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          <span className="small grow">{quote.line} {quote.cost_cp !== null ? <strong>{coins(quote.cost_cp)}</strong> : <strong>the DM sets the price</strong>}{quote.wait_text ? `, ${quote.wait_text}` : ''}.</span>
          <button type="button" className="btn small primary" disabled={busy} onClick={() => void pay()} data-testid="quick-broker-pay">{quote.cost_cp ? 'Pay and ask' : 'Ask'}</button>
          <button type="button" className="btn small ghost" disabled={busy} onClick={() => setQuote(null)}>Not now</button>
        </div>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
      <button type="button" className="btn small ghost quick-link" onClick={() => onChat(text)}>Talk to the broker instead</button>
    </div>
  );
}

export default function QuickHelp({ onHandoff }: { onHandoff: (h: QuickHandoff) => void }) {
  const { w, info } = useWorld();
  const [status, setStatus] = useState<{ on: boolean; available: boolean; model: string | null } | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<QuickTask | null>(null);
  const [res, setRes] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const brokerOn = (info?.settings as any)?.brokerEnabled !== false;
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
    void run(/\b(rule|rules|how does|how do|can i|what does .* do|condition|spell|action)\b/i.test(t.replace(/\bwho\s+rules\b/gi, '')) ? 'rules' : 'ask', t);
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
          {res.handoff.to === 'broker' && brokerOn
            ? <BrokerInBackground key={res.ms} question={res.handoff.question} onChat={(question) => onHandoff({ ...res.handoff!, question })} />
            : (
              <button type="button" className="btn small primary" onClick={() => onHandoff({ ...res.handoff!, to: 'helper' })}>
                Ask the table helper
              </button>
            )}
        </div>
      )}
    </section>
  );
}
