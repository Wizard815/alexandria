// The information broker, as the player meets them: a persona, a price list
// the DM set, your coin, and the questions you've paid for.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { coins, when } from '../../lib/format.ts';
import { PageHead, Loading, ErrorBox, Empty, Field, Tabs, useAction, useToast } from '../../ui/index.tsx';
import { type BrokerConfig, type BrokerRequest, type Quote, ReadyLabel, StatusChip, extra, waitLabel } from './shared.tsx';

export default function PlayerBroker() {
  const { w, info } = useWorld();
  const enabled = extra(info.settings).brokerEnabled;
  const cfg = useLoad(() => (enabled ? w.call<BrokerConfig>('GET', '/broker/config') : Promise.resolve(null)), [w, enabled], ['broker-config', 'broker-clock', 'settings']);
  const list = useLoad(() => (enabled ? w.call<{ requests: BrokerRequest[]; clock: { label: string } }>('GET', '/broker') : Promise.resolve(null)), [w, enabled], ['broker', 'broker-clock']);
  const payer = cfg.data?.payer === 'party' && info.settings.partyPurse ? 'party' : 'me';
  const coin = useLoad(() => w.coin(payer) as Promise<{ cp: number }>, [w, payer], ['coin']);

  if (!enabled) return <div className="page"><PageHead title="Information broker" /><Empty>The broker's door is shut. Your DM has not opened the information broker in this world.</Empty></div>;
  if (!cfg.data) return <div className="page"><ErrorBox error={cfg.error} />{!cfg.error && <Loading />}</div>;
  const c = cfg.data;
  const p = c.persona;

  return (
    <div className="page">
      <PageHead title="Information broker" lead={<>What your character could find out, for a price. <span className="faint">Game time: {c.clock.label}</span></>} />
      <div className="cols">
        <div className="col-2 stack loose">
          <section className="card gold" aria-labelledby="persona-h">
            <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
              {p.portrait ? <img src={p.portrait} alt="" width={72} height={72} style={{ borderRadius: 12, objectFit: 'cover', flex: 'none' }} />
                : <div aria-hidden="true" style={{ width: 72, height: 72, borderRadius: 12, background: 'var(--panel-2)', display: 'grid', placeItems: 'center', fontSize: 34, flex: 'none' }}>⚖</div>}
              <div className="stack tight grow">
                <h2 id="persona-h" style={{ margin: 0 }}>{p.name}</h2>
                {p.title && <span className="small muted">{p.title}</span>}
                {p.description && <p className="small" style={{ margin: 0 }}>{p.description}</p>}
              </div>
            </div>
            {p.greeting && <blockquote className="read" style={{ margin: '10px 0 0', fontStyle: 'italic' }}>“{p.greeting}”</blockquote>}
          </section>
          <AskCard cfg={c} balance={coin.data?.cp ?? null} payer={payer} onAsked={async () => { await list.reload(); await coin.reload(); }} />
          <History list={list.data?.requests ?? null} error={list.error} reload={async () => { await list.reload(); await coin.reload(); }} />
        </div>
        <aside className="col-1 stack loose">
          <section className="card" aria-labelledby="coin-h">
            <h2 id="coin-h">{payer === 'party' ? 'Party purse' : 'Your coin'}</h2>
            <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent-strong)' }}>{coin.data ? coins(coin.data.cp, info.settings.coins) : '…'}</span>
            <span className="tiny faint">{payer === 'party' ? 'The broker is paid from the party purse.' : 'You pay the broker from your own coin.'}</span>
          </section>
          <section className="card" aria-labelledby="prices-h">
            <div className="card-head"><h2 id="prices-h">Prices</h2><span className="chip">Set by your DM</span></div>
            <ul className="stack tight" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {c.tiers.map((t) => (
                <li key={t.id} className="stack tight" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
                  <div className="row between"><strong>{t.name}</strong><span>{t.costCp === null ? 'Ask' : t.costCp === 0 ? 'Free' : coins(t.costCp, info.settings.coins)}</span></div>
                  <span className="tiny muted">{t.description}</span>
                  <span className="tiny faint">{t.wait ? waitLabel(t.wait) : 'The DM decides the wait'}</span>
                </li>
              ))}
            </ul>
            <p className="tiny faint" style={{ margin: 0 }}>{c.lengths.map((l) => `${l.name} ×${l.multiplier}`).join(' · ')}</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function AskCard({ cfg, balance, payer, onAsked }: { cfg: BrokerConfig; balance: number | null; payer: string; onAsked: () => Promise<void> }) {
  const { w, info } = useWorld();
  const [question, setQuestion] = useState('');
  const [length, setLength] = useState(cfg.lengths[0]?.id ?? 'short');
  const [quote, setQuote] = useState<Quote | null>(null);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const short = quote && quote.cost_cp !== null && balance !== null && balance < quote.cost_cp;

  const getQuote = () => act.run(async () => setQuote(await w.call<Quote>('POST', '/broker/quote', { question: question.trim(), length })));
  const pay = () => act.run(async () => {
    if (!quote) return;
    const r = await w.call<BrokerRequest>('POST', '/broker/ask', { quoteId: quote.quoteId });
    setQuote(null); setQuestion('');
    toast(r.status === 'pricing' ? 'The broker will ask around. Your DM sets the price.' : r.status === 'answered' ? 'The broker answers.' : 'Paid. The broker will have your answer soon.');
    await onAsked();
  });

  return (
    <section className="card" aria-labelledby="ask-h">
      <h2 id="ask-h">Ask a question</h2>
      <Field label="What do you want to know?"><textarea rows={3} maxLength={500} value={question} onChange={(e) => { setQuestion(e.target.value); setQuote(null); }} placeholder="Who really runs the harbour?" /></Field>
      <div className="row between">
        <Tabs label="Answer length" value={length} onChange={(v) => { setLength(v); setQuote(null); }} items={cfg.lengths.map((l) => [l.id, `${l.name}${l.multiplier !== 1 ? ` ×${l.multiplier}` : ''}`] as [string, string])} />
        <button type="button" className="btn" disabled={!question.trim() || act.busy} onClick={() => void getQuote()}>Name your price</button>
      </div>
      <ErrorBox error={act.error} />
      {quote && (
        <div className="stack tight" style={{ padding: 12, borderRadius: 8, background: 'var(--panel-2)' }} aria-live="polite">
          <p className="read" style={{ margin: 0, fontStyle: 'italic' }}>{quote.line}</p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="chip gold">{quote.tier_name}</span>
            <span className="chip">{quote.cost_cp === null ? 'Price: the DM decides' : quote.cost_cp === 0 ? 'Free' : coins(quote.cost_cp, info.settings.coins)}</span>
            <span className="chip">{quote.secret ? 'Wait: the DM decides' : `Wait: ${quote.wait_text}`}</span>
          </div>
          {short && <p className="small" style={{ color: 'var(--danger-text)', margin: 0 }}>{payer === 'party' ? 'The party purse' : 'You'} can't cover that.</p>}
          <div className="row end">
            <button type="button" className="btn small ghost" onClick={() => setQuote(null)}>Never mind</button>
            <button type="button" className="btn small primary" disabled={act.busy || !!short} onClick={() => void pay()}>
              {quote.secret ? 'Ask them to look into it' : quote.cost_cp ? `Pay ${coins(quote.cost_cp, info.settings.coins)}` : 'Ask'}
            </button>
          </div>
          <span className="tiny faint">This price holds for two minutes.</span>
        </div>
      )}
      {toastNode}
    </section>
  );
}

function History({ list, error, reload }: { list: BrokerRequest[] | null; error: string | null; reload: () => Promise<void> }) {
  const { w, info } = useWorld();
  const act = useAction();
  if (!list) return <section className="card"><ErrorBox error={error} />{!error && <Loading />}</section>;
  return (
    <section className="card" aria-labelledby="hist-h">
      <h2 id="hist-h">Your questions</h2>
      <ErrorBox error={act.error} />
      {!list.length ? <Empty>You haven't asked the broker anything yet.</Empty> : list.map((q) => (
        <article key={q.id} className="list-item" style={{ display: 'block' }}>
          <div className="row between" style={{ alignItems: 'flex-start' }}>
            <strong className="grow">{q.question}</strong>
            <StatusChip s={q.status} />
          </div>
          <div className="tiny faint">{q.tier_name} · {q.cost_cp ? coins(q.cost_cp, info.settings.coins) : q.cost_cp === 0 ? 'free' : 'unpriced'} · {when(q.created_at)}</div>
          {q.status === 'waiting' && <div className="small muted"><ReadyLabel q={q} /></div>}
          {q.status === 'pricing' && <div className="small muted">The broker is asking around. Your DM will name a price.</div>}
          {q.status === 'offered' && (
            <div className="stack tight" style={{ marginTop: 6 }}>
              <span className="small">The broker can find out, for {coins(q.cost_cp ?? 0, info.settings.coins)}.{q.reply ? ` “${q.reply}”` : ''}</span>
              <div className="row">
                <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('POST', `/broker/${q.id}/accept`); await reload(); })}>Pay {coins(q.cost_cp ?? 0, info.settings.coins)}</button>
                <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('POST', `/broker/${q.id}/decline`); await reload(); })}>No thanks</button>
              </div>
            </div>
          )}
          {(q.status === 'refused' || q.status === 'refunded') && <div className="small muted">{q.status === 'refunded' ? 'Your coin was returned.' : 'The broker would not take this one.'}{q.reply ? ` “${q.reply}”` : ''}</div>}
          {q.status === 'answered' && q.answer && (
            <div className="stack tight" style={{ marginTop: 6, padding: 10, borderLeft: '3px solid var(--accent)', background: 'var(--panel-2)', borderRadius: 6 }}>
              {q.voice && <span className="tiny faint" style={{ fontStyle: 'italic' }}>{q.voice}…</span>}
              <div className="read" style={{ whiteSpace: 'pre-wrap' }}>“{q.answer}”</div>
              {!!q.sources?.length && <div className="tiny">From: {q.sources.map((s, i) => <span key={s.id}>{i ? ', ' : ''}<Link to={`/w/${info.slug}/library?page=${encodeURIComponent(s.id)}`}>{s.title}</Link></span>)}</div>}
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
