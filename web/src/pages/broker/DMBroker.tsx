// The DM's side of the information broker: the queue (price secrets, edit or
// deliver answers, refuse, refund), the game clock, the persona and prices.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { coins, parseCoins, when } from '../../lib/format.ts';
import { PageHead, Loading, ErrorBox, Empty, Field, Tabs, Modal, useAction, useToast } from '../../ui/index.tsx';
import { type BrokerConfig, type BrokerRequest, type Tier, ReadyLabel, StatusChip, extra } from './shared.tsx';

export default function DMBroker() {
  const { w, info } = useWorld();
  const [tab, setTab] = useState<'queue' | 'setup'>('queue');
  const enabled = extra(info.settings).brokerEnabled;
  const cfg = useLoad(() => (enabled ? w.call<BrokerConfig>('GET', '/broker/config') : Promise.resolve(null)), [w, enabled], ['broker-config', 'broker-clock', 'settings']);
  const list = useLoad(() => (enabled ? w.call<{ requests: BrokerRequest[] }>('GET', '/broker') : Promise.resolve(null)), [w, enabled], ['broker', 'broker-clock']);

  if (!enabled) return (
    <div className="page"><PageHead title="Information broker" />
      <Empty>The broker is turned off. Turn it on in <Link to={`/w/${info.slug}/dm/settings`}>World settings</Link>.</Empty></div>
  );
  const open = (list.data?.requests ?? []).filter((q) => ['pricing', 'offered', 'waiting'].includes(q.status));
  return (
    <div className="page">
      <PageHead title="Information broker" lead="Players buy what their characters could learn. Prices come from your tiers; answers come only from pages the party can see, unless you write them." />
      <ErrorBox error={cfg.error ?? list.error} />
      <div className="row between">
        <Tabs label="Broker" value={tab} onChange={setTab} items={[['queue', `Queue${open.length ? ` (${open.length})` : ''}`], ['setup', 'Persona and prices']]} />
        {cfg.data && <Clock clock={cfg.data.clock} onChanged={cfg.reload} />}
      </div>
      {!cfg.data ? <Loading /> : tab === 'queue' ? <Queue list={list.data?.requests ?? null} reload={list.reload} /> : <Setup cfg={cfg.data} onSaved={cfg.reload} />}
    </div>
  );
}

function Clock({ clock, onChanged }: { clock: BrokerConfig['clock']; onChanged: () => Promise<void> }) {
  const { w } = useWorld();
  const act = useAction();
  const [setting, setSetting] = useState(false);
  const [day, setDay] = useState(1);
  const [time, setTime] = useState('08:00');
  const move = (body: Record<string, number>) => act.run(async () => { await w.call('POST', '/broker/clock', body); await onChanged(); });
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} aria-label="Game clock">
      <span className="chip gold" title="Game time">Game time: {clock.label}</span>
      <button type="button" className="btn small" disabled={act.busy} onClick={() => void move({ addMinutes: 60 })}>+1 hour</button>
      <button type="button" className="btn small" disabled={act.busy} onClick={() => void move({ addMinutes: 1440 })}>+1 day</button>
      <button type="button" className="btn small ghost" onClick={() => { setDay(Math.floor(clock.minutes / 1440) + 1); setTime(`${String(Math.floor((clock.minutes % 1440) / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`); setSetting(true); }}>Set…</button>
      <ErrorBox error={act.error} />
      {setting && (
        <Modal title="Set the game clock" onClose={() => setSetting(false)}>
          <p className="small muted">Answers waiting on game time arrive when the clock passes their time.</p>
          <div className="row">
            <Field label="Day"><input type="number" min={1} value={day} onChange={(e) => setDay(Math.max(1, Number(e.target.value) || 1))} /></Field>
            <Field label="Time"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
          </div>
          <div className="row end">
            <button type="button" className="btn" onClick={() => setSetting(false)}>Cancel</button>
            <button type="button" className="btn primary" disabled={act.busy} onClick={() => { const [h, m] = time.split(':').map(Number); void move({ setMinutes: (day - 1) * 1440 + (h || 0) * 60 + (m || 0) }).then(() => setSetting(false)); }}>Set</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Queue({ list, reload }: { list: BrokerRequest[] | null; reload: () => Promise<void> }) {
  const { w, info } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [editing, setEditing] = useState<BrokerRequest | null>(null);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  if (!list) return <Loading />;
  const rows = filter === 'open' ? list.filter((q) => ['pricing', 'offered', 'waiting'].includes(q.status)) : list;
  const post = (q: BrokerRequest, action: string, label: string, body?: unknown) => act.run(async () => { await w.call('POST', `/broker/${q.id}/${action}`, body); await reload(); toast(label); });
  return (
    <section className="card flush" aria-label="Broker queue">
      <div className="row between" style={{ padding: '10px 14px' }}>
        <Tabs label="Show" value={filter} onChange={setFilter} items={[['open', 'Open'], ['all', 'All']]} />
        <ErrorBox error={act.error} />
      </div>
      {!rows.length ? <Empty>{filter === 'open' ? 'Nothing waiting on you.' : 'No one has asked the broker anything yet.'}</Empty> : rows.map((q) => (
        <article key={q.id} className="list-item" style={{ display: 'block', padding: '12px 14px' }}>
          <div className="row between" style={{ alignItems: 'flex-start' }}>
            <div className="stack tight grow">
              <strong>{q.question}</strong>
              <span className="tiny faint">{q.asker_name} · {q.tier_name} · {q.cost_cp === null ? 'unpriced' : q.cost_cp === 0 ? 'free' : coins(q.cost_cp, info.settings.coins)}{q.payer === 'party' ? ' (party purse)' : ''} · {when(q.created_at)}</span>
              {q.status === 'waiting' && <span className="small muted"><ReadyLabel q={q} /></span>}
            </div>
            <StatusChip s={q.status} />
          </div>
          {q.answer && <div className="small read" style={{ whiteSpace: 'pre-wrap', margin: '6px 0', padding: 8, background: 'var(--panel-2)', borderRadius: 6, maxHeight: 160, overflow: 'auto' }}>{q.answer}</div>}
          {!!q.sources?.length && <div className="tiny faint">From: {q.sources.map((s) => s.title).join(', ')}</div>}
          {q.reply && <div className="tiny faint">Note: {q.reply}</div>}
          <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {q.status === 'pricing' && <button type="button" className="btn small primary" onClick={() => setEditing(q)}>Price and answer</button>}
            {(q.status === 'waiting' || q.status === 'answered' || q.status === 'offered') && <button type="button" className="btn small" onClick={() => setEditing(q)}>Edit answer</button>}
            {q.status === 'waiting' && <button type="button" className="btn small" disabled={act.busy} onClick={() => void post(q, 'deliver', 'Delivered')}>Deliver now</button>}
            {['pricing', 'offered', 'waiting'].includes(q.status) && <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => { const note = window.prompt('Refuse this question. A note for the player (optional):') ?? null; if (note !== null) void post(q, 'refuse', q.cost_cp && q.status === 'waiting' ? 'Refused and refunded' : 'Refused', { note }); }}>{q.status === 'waiting' && q.cost_cp ? 'Refuse and refund' : 'Refuse'}</button>}
            {q.status === 'answered' && !!q.cost_cp && <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => { if (window.confirm(`Refund ${coins(q.cost_cp ?? 0, info.settings.coins)}?`)) void post(q, 'refund', 'Refunded'); }}>Refund</button>}
          </div>
        </article>
      ))}
      {editing && <AnswerModal q={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); toast('Saved'); }} />}
      {toastNode}
    </section>
  );
}

function AnswerModal({ q, onClose, onSaved }: { q: BrokerRequest; onClose: () => void; onSaved: () => Promise<void> }) {
  const { w } = useWorld();
  const act = useAction();
  const pricing = q.status === 'pricing';
  const [answer, setAnswer] = useState(q.answer ?? '');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState(1);
  const [unit, setUnit] = useState<'minutes' | 'hours' | 'days'>('days');
  const [clock, setClock] = useState<'real' | 'game'>('game');
  const [note, setNote] = useState(q.reply ?? '');
  const cp = price.trim() === '0' ? 0 : parseCoins(price);
  const save = () => act.run(async () => {
    if (pricing) await w.call('POST', `/broker/${q.id}/price`, { costCp: cp ?? 0, waitAmount: amount, waitUnit: unit, clock, answer: answer.trim(), note: note.trim() || undefined });
    else await w.call('PATCH', `/broker/${q.id}`, { answer: answer.trim(), note: note.trim() });
    await onSaved();
  });
  return (
    <Modal title={pricing ? 'Price a guarded secret' : 'Edit the answer'} onClose={onClose}>
      <p className="small"><strong>{q.asker_name}</strong> asks: “{q.question}”</p>
      {pricing && (
        <>
          <p className="small muted">Your library had nothing the party can see on this. Name a price and write the answer. The player sees the price first and decides.</p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Field label="Price" help="e.g. 5 gp, or 0 for free"><input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="5 gp" /></Field>
            <Field label="Wait"><input type="number" min={0} value={amount} onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))} /></Field>
            <Field label="Unit"><select value={unit} onChange={(e) => setUnit(e.target.value as any)}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></select></Field>
            <Field label="Clock"><select value={clock} onChange={(e) => setClock(e.target.value as any)}><option value="game">game time</option><option value="real">real time</option></select></Field>
          </div>
        </>
      )}
      <Field label="Answer, in the broker's words" help={pricing ? 'Only revealed once paid and the wait is over.' : 'Players see it when it is ready.'}><textarea rows={6} maxLength={10000} value={answer} onChange={(e) => setAnswer(e.target.value)} /></Field>
      <Field label="Note to the player (optional)"><input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="This one cost the broker a favor." /></Field>
      <ErrorBox error={act.error} />
      <div className="row end">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={act.busy || !answer.trim() || (pricing && cp === null)} onClick={() => void save()}>{pricing ? 'Offer it' : 'Save'}</button>
      </div>
    </Modal>
  );
}

const KNOW: Record<string, string> = { common: 'Pages marked common', local: 'Pages marked local (and unmarked pages)', deep: 'Pages marked deep', secret: 'Nothing in the party library: you price it' };

function Setup({ cfg, onSaved }: { cfg: BrokerConfig; onSaved: () => Promise<void> }) {
  const { w, info } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [c, setC] = useState(cfg);
  useEffect(() => setC(cfg), [cfg]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const priceText = (t: Tier) => prices[t.id] ?? (t.costCp === null ? '' : coins(t.costCp, 'gsc'));
  const setTier = (i: number, t: Partial<Tier>) => setC({ ...c, tiers: c.tiers.map((x, j) => (j === i ? { ...x, ...t } : x)) });
  const persona = (k: keyof BrokerConfig['persona'], v: string) => setC({ ...c, persona: { ...c.persona, [k]: v } });
  const save = () => act.run(async () => {
    const tiers = c.tiers.map((t) => {
      const txt = prices[t.id];
      if (txt === undefined) return t;
      if (t.knowledge === 'secret' && !txt.trim()) return { ...t, costCp: null };
      const cp = txt.trim() === '0' ? 0 : parseCoins(txt);
      if (cp === null) throw new Error(`${t.name}: price not understood`);
      return { ...t, costCp: cp };
    });
    await w.call('PUT', '/broker/config', { persona: c.persona, tiers, lengths: c.lengths });
    setPrices({});
    await onSaved();
    toast('Saved');
  });
  return (
    <div className="cols">
      <section className="col-1 card" aria-labelledby="pers-h">
        <h2 id="pers-h">Persona</h2>
        <Field label="Name"><input value={c.persona.name} maxLength={80} onChange={(e) => persona('name', e.target.value)} /></Field>
        <Field label="Title"><input value={c.persona.title} maxLength={120} onChange={(e) => persona('title', e.target.value)} /></Field>
        <Field label="Description"><textarea rows={3} maxLength={600} value={c.persona.description} onChange={(e) => persona('description', e.target.value)} /></Field>
        <Field label="Greeting"><input value={c.persona.greeting} maxLength={300} onChange={(e) => persona('greeting', e.target.value)} /></Field>
        <Field label="How they answer" help="Shown before each answer, after the name"><input value={c.persona.voice} maxLength={120} onChange={(e) => persona('voice', e.target.value)} placeholder="leans in and lowers their voice" /></Field>
        <Field label="Portrait URL (optional)"><input value={c.persona.portrait} maxLength={500} onChange={(e) => persona('portrait', e.target.value)} placeholder="https://…" /></Field>
      </section>
      <section className="col-2 card" aria-labelledby="tiers-h">
        <h2 id="tiers-h">Prices and waits</h2>
        <p className="small muted">The tier comes from the best-matching shared page's knowledge level. Players see this list as "Set by your DM".</p>
        {c.tiers.map((t, i) => (
          <fieldset key={t.id} className="stack tight" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
            <legend className="small muted">{KNOW[t.knowledge]}</legend>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <Field label="Name"><input value={t.name} maxLength={60} onChange={(e) => setTier(i, { name: e.target.value })} /></Field>
              <Field label="Price" help={t.knowledge === 'secret' ? 'Empty: you price each one' : '0 for free'}><input value={priceText(t)} onChange={(e) => setPrices({ ...prices, [t.id]: e.target.value })} placeholder={t.knowledge === 'secret' ? 'You decide' : '5 sp'} /></Field>
            </div>
            <Field label="Description"><input value={t.description} maxLength={300} onChange={(e) => setTier(i, { description: e.target.value })} /></Field>
            {t.knowledge !== 'secret' && t.wait && (
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <Field label="Wait"><input type="number" min={0} value={t.wait.amount} onChange={(e) => setTier(i, { wait: { ...t.wait!, amount: Math.max(0, Number(e.target.value) || 0) } })} /></Field>
                <Field label="Unit"><select value={t.wait.unit} onChange={(e) => setTier(i, { wait: { ...t.wait!, unit: e.target.value as any } })}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></select></Field>
                <Field label="Clock"><select value={t.wait.clock} onChange={(e) => setTier(i, { wait: { ...t.wait!, clock: e.target.value as any } })}><option value="game">game time</option><option value="real">real time</option></select></Field>
              </div>
            )}
          </fieldset>
        ))}
        <h3>Answer lengths</h3>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {c.lengths.map((l, i) => (
            <Field key={l.id} label={`${l.name} costs ×`}><input type="number" min={0} step="0.5" value={l.multiplier} onChange={(e) => setC({ ...c, lengths: c.lengths.map((x, j) => (j === i ? { ...x, multiplier: Number(e.target.value) || 0 } : x)) })} /></Field>
          ))}
        </div>
        <p className="tiny faint">Payer: {c.payer === 'party' && info.settings.partyPurse ? 'the party purse' : "each player's own coin"} (World settings).</p>
        <ErrorBox error={act.error} />
        <div className="row end"><button type="button" className="btn primary" disabled={act.busy} onClick={() => void save()}>Save prices and persona</button></div>
      </section>
      {toastNode}
    </div>
  );
}
