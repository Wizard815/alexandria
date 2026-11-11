// The DM's side of the information broker: every question with how it was
// judged (library, DM secret or unknown) and what it sold for; special
// offers to send; notes the broker may sell; per-page price rules and a
// "try a question" box for tuning; the game clock, the persona and prices.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { coins, parseCoins, when } from '../../lib/format.ts';
import { PageHead, Loading, ErrorBox, Empty, Field, Tabs, Modal, useAction, useToast } from '../../ui/index.tsx';
import { type BrokerConfig, type BrokerNote, type BrokerRequest, type Classification, type Offer, type PageRule, type Tier, ReadyLabel, StatusChip, extra, offerExpiry } from './shared.tsx';

export default function DMBroker() {
  const { w, info } = useWorld();
  const [tab, setTab] = useState<'queue' | 'offers' | 'notes' | 'tune' | 'setup'>('queue');
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
        <Tabs label="Broker" value={tab} onChange={setTab} items={[['queue', `Questions${open.length ? ` (${open.length})` : ''}`], ['offers', 'Special offers'], ['notes', 'Broker notes'], ['tune', 'Fine-tune'], ['setup', 'Persona and prices']]} />
        {cfg.data && <Clock clock={cfg.data.clock} onChanged={cfg.reload} />}
      </div>
      {!cfg.data ? <Loading /> : tab === 'queue' ? <Queue list={list.data?.requests ?? null} reload={list.reload} />
        : tab === 'offers' ? <Offers /> : tab === 'notes' ? <Notes /> : tab === 'tune' ? <Tune cfg={cfg.data} /> : <Setup cfg={cfg.data} onSaved={cfg.reload} />}
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
  const [filter, setFilter] = useState<'open' | 'secret' | 'all'>('open');
  if (!list) return <Loading />;
  const rows = filter === 'open' ? list.filter((q) => ['pricing', 'offered', 'waiting'].includes(q.status))
    : filter === 'secret' ? list.filter((q) => q.classification?.verdict === 'secret') : list;
  const sold = list.filter((q) => q.cost_cp && ['waiting', 'answered'].includes(q.status)).reduce((n, q) => n + (q.cost_cp ?? 0), 0);
  const post = (q: BrokerRequest, action: string, label: string, body?: unknown) => act.run(async () => { await w.call('POST', `/broker/${q.id}/${action}`, body); await reload(); toast(label); });
  return (
    <section className="card flush" aria-label="Broker queue">
      <div className="row between" style={{ padding: '10px 14px' }}>
        <Tabs label="Show" value={filter} onChange={setFilter} items={[['open', 'Open'], ['secret', 'Touch secrets'], ['all', 'All']]} />
        <span className="tiny faint">{list.length} asked · {coins(sold, info.settings.coins)} earned</span>
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
          {q.classification && <Judged c={q.classification} />}
          {q.answer && <div className="small read" style={{ whiteSpace: 'pre-wrap', margin: '6px 0', padding: 8, background: 'var(--panel-2)', borderRadius: 6, maxHeight: 160, overflow: 'auto' }}>{q.answer}</div>}
          {!!q.sources?.length && <div className="tiny faint">Sold from: {q.sources.map((s) => s.title).join(', ')}</div>}
          {q.reply && <div className="tiny faint">Note: {q.reply}</div>}
          <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {q.status === 'pricing' && <button type="button" className="btn small primary" onClick={() => setEditing(q)}>Price and answer</button>}
            {(q.status === 'waiting' || q.status === 'answered' || q.status === 'offered') && <button type="button" className="btn small" onClick={() => setEditing(q)}>Edit answer</button>}
            {q.status === 'waiting' && <button type="button" className="btn small" disabled={act.busy} onClick={() => void post(q, 'deliver', 'Delivered')}>Deliver now</button>}
            {['pricing', 'offered', 'waiting'].includes(q.status) && <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => { const note = window.prompt('Refuse this question. A note for the player (optional):') ?? null; if (note !== null) void post(q, 'refuse', q.cost_cp && q.status === 'waiting' ? 'Refused and refunded' : 'Refused', { note }); }}>{q.status === 'waiting' && q.cost_cp ? 'Refuse and refund' : 'Refuse'}</button>}
            {q.answer && ['waiting', 'answered', 'offered'].includes(q.status) && <button type="button" className="btn small ghost" disabled={act.busy} title="Future questions on this topic can be sold from it" onClick={() => void act.run(async () => { await w.call('POST', `/broker/${q.id}/note`, {}); toast('Saved as a broker note'); })}>Save as broker note</button>}
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
    await w.call('PUT', '/broker/config', { persona: c.persona, tiers, lengths: c.lengths, unknown: c.unknown ?? 'dm' });
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
        <Field label="Questions the broker can't answer" help="Includes questions that touch your secrets. Players can't tell the two apart either way.">
          <select value={c.unknown ?? 'dm'} onChange={(e) => setC({ ...c, unknown: e.target.value as 'dm' | 'refuse' })}>
            <option value="dm">Come to me to price or refuse</option>
            <option value="refuse">Turned away ("never heard of it"); I still see what was asked</option>
          </select>
        </Field>
        <p className="tiny faint">Payer: {c.payer === 'party' && info.settings.partyPurse ? 'the party purse' : "each player's own coin"} (World settings).</p>
        <ErrorBox error={act.error} />
        <div className="row end"><button type="button" className="btn primary" disabled={act.busy} onClick={() => void save()}>Save prices and persona</button></div>
      </section>
      {toastNode}
    </div>
  );
}

const VERDICT: Record<string, string> = { shared: 'Library: sold from what players can read', secret: 'DM secret: never sold on its own', unknown: 'Unknown: nothing matches' };

/** How a question was judged, with the DM-only lines that matched (DM only). */
function Judged({ c }: { c: Classification }) {
  const { info } = useWorld();
  return (
    <div className="stack tight" style={{ margin: '6px 0' }}>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {c.verdict && <span title={VERDICT[c.verdict]}><StatusChip s={c.verdict} /></span>}
        <span className="chip">{c.type}</span>
        {c.knowledge && c.verdict === 'shared' && <span className="chip">{c.knowledge}{c.multiplier !== 1 ? ` ×${c.multiplier}` : ''}</span>}
        {c.entities.map((e) => <Link key={e.id} className="chip" to={e.id.startsWith('person:') ? `/w/${info.slug}/dm/people` : `/w/${info.slug}/dm/library?page=${encodeURIComponent(e.id)}`} title={e.shared ? 'Players can see this' : 'DM only'}>{e.shared ? '' : '🔒 '}{e.title}</Link>)}
      </div>
      <span className="tiny muted">{c.reason}</span>
      {!!c.dmEvidence.length && (
        <details className="tiny">
          <summary style={{ color: 'var(--danger-text)' }}>DM-only lines that matched ({c.dmEvidence.length})</summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{c.dmEvidence.map((e, i) => <li key={i}><strong>{e.title}:</strong> {e.text}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

interface PageLite { id: string; title: string; path: string; visibility?: string }
const usePages = () => {
  const { w } = useWorld();
  return useLoad(() => w.call<PageLite[]>('GET', '/library/pages'), [w], ['page']);
};
function PagePicker({ value, onChange, label, help }: { value: string; onChange: (v: string) => void; label: string; help?: string }) {
  const pages = usePages();
  return (
    <Field label={label} help={help}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— none —</option>
        {(pages.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.visibility && p.visibility !== 'party' ? '🔒 ' : ''}{p.title}</option>)}
      </select>
    </Field>
  );
}

/** Special offers: the DM sells something directly, to one player or the party. */
function Offers() {
  const { w, info, members } = useWorld();
  const list = useLoad(() => w.call<Offer[]>('GET', '/broker/offers'), [w], ['broker-offer']);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const players = members.filter((m) => m.role === 'player');
  const blank = { title: '', teaser: '', info: '', price: '', targets: ['party'] as string[], pageId: '', sessions: 1, hours: 72, by: 'session' as 'session' | 'time' };
  const [f, setF] = useState(blank);
  const pages = usePages();
  const cp = f.price.trim() === '0' ? 0 : parseCoins(f.price);
  const fill = (pid: string) => act.run(async () => {
    setF((x) => ({ ...x, pageId: pid }));
    if (!pid) return;
    const pg = await w.call<{ title: string; body: string }>('GET', `/library/pages/${encodeURIComponent(pid)}`);
    setF((x) => ({ ...x, pageId: pid, title: x.title || pg.title, info: x.info || pg.body.replace(/^---[\s\S]*?---\n/, '').slice(0, 4000) }));
  });
  const send = () => act.run(async () => {
    await w.call('POST', '/broker/offers', {
      title: f.title.trim(), teaser: f.teaser.trim() || undefined, info: f.info.trim(), priceCp: cp, targets: f.targets, pageId: f.pageId || undefined,
      expiresSessions: f.by === 'session' ? f.sessions : undefined, fallbackHours: f.hours,
    });
    setF(blank);
    await list.reload();
    toast('Offer sent. It waits on their broker page.');
  });
  const toggle = (id: string) => setF((x) => {
    if (id === 'party') return { ...x, targets: ['party'] };
    const t = x.targets.filter((y) => y !== 'party');
    const next = t.includes(id) ? t.filter((y) => y !== id) : [...t, id];
    return { ...x, targets: next.length ? next : ['party'] };
  });
  return (
    <div className="cols">
      <section className="col-1 card" aria-labelledby="newoffer-h">
        <h2 id="newoffer-h">Send an offer</h2>
        <p className="small muted">“A hooded figure offers you knowledge of…” It shows on their broker page (not a pop-up) until they pay, decline, or time runs out.</p>
        <Field label="What it's about"><input value={f.title} maxLength={120} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="The lighthouse keeper" /></Field>
        <Field label="What the broker says (optional)"><input value={f.teaser} maxLength={400} onChange={(e) => setF({ ...f, teaser: e.target.value })} placeholder="I know who pays the keeper. Interested?" /></Field>
        <PagePicker label="Start from a page (optional)" help="Copies the page text below for you to trim. Linked only if players can open it." value={f.pageId} onChange={(v) => void fill(v)} />
        <Field label="What they learn when they pay"><textarea rows={5} maxLength={10000} value={f.info} onChange={(e) => setF({ ...f, info: e.target.value })} /></Field>
        <Field label="Price" help="e.g. 50 gp"><input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} placeholder="50 gp" /></Field>
        <fieldset className="stack tight" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small">Offer to</legend>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.targets.includes('party')} onChange={() => toggle('party')} /> The whole party</label>
          {players.map((p) => <label key={p.id} className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.targets.includes(p.id)} onChange={() => toggle(p.id)} /> {p.character_name || p.display_name}</label>)}
        </fieldset>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Field label="Runs out"><select value={f.by} onChange={(e) => setF({ ...f, by: e.target.value as 'session' | 'time' })}><option value="session">At the end of a session</option><option value="time">After a set time</option></select></Field>
          {f.by === 'session'
            ? <Field label="Sessions" help="1 = the next (or current) game night on the calendar"><input type="number" min={1} max={20} value={f.sessions} onChange={(e) => setF({ ...f, sessions: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} /></Field>
            : null}
          <Field label={f.by === 'session' ? 'Or after (hours) if none is scheduled' : 'Hours'}><input type="number" min={1} value={f.hours} onChange={(e) => setF({ ...f, hours: Math.max(1, Number(e.target.value) || 1) })} /></Field>
        </div>
        <ErrorBox error={act.error ?? pages.error} />
        <div className="row end"><button type="button" className="btn primary" disabled={act.busy || !f.title.trim() || !f.info.trim() || cp === null} onClick={() => void send()}>Send offer</button></div>
      </section>
      <section className="col-2 card flush" aria-label="Offers">
        <ErrorBox error={list.error} />
        {!list.data ? <Loading /> : !list.data.length ? <Empty>No offers yet.</Empty> : list.data.map((o) => (
          <article key={o.id} className="list-item" style={{ display: 'block', padding: '12px 14px' }}>
            <div className="row between" style={{ alignItems: 'flex-start' }}>
              <div className="stack tight grow">
                <strong>{o.title} · {coins(o.price_cp, info.settings.coins)}</strong>
                <span className="tiny faint">To {o.target_names?.join(', ')} · {o.status === 'open' ? offerExpiry(o) : when(o.paid_at ?? o.created_at)}{o.paid_by_name ? ` · paid by ${o.paid_by_name}${o.paid_from === 'party' ? ' (party purse)' : ''}` : ''}{o.declined_by?.length ? ` · ${o.declined_by.length} declined` : ''}</span>
              </div>
              <StatusChip s={o.status} />
            </div>
            {o.teaser && <div className="small muted" style={{ fontStyle: 'italic' }}>“{o.teaser}”</div>}
            <details className="small"><summary>What they learn</summary><div style={{ whiteSpace: 'pre-wrap' }}>{o.info}</div></details>
            {o.status === 'open' && <div className="row" style={{ marginTop: 6 }}><button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('POST', `/broker/offers/${o.id}/withdraw`); await list.reload(); })}>Withdraw</button></div>}
          </article>
        ))}
      </section>
      {toastNode}
    </div>
  );
}

/** Notes: facts the DM gives the broker to sell. The broker never invents anything else. */
function Notes() {
  const { w } = useWorld();
  const list = useLoad(() => w.call<BrokerNote[]>('GET', '/broker/notes'), [w], []);
  const act = useAction();
  const blank = { id: '', topic: '', text: '', knowledge: 'local' as BrokerNote['knowledge'], pageId: '' };
  const [f, setF] = useState(blank);
  const save = () => act.run(async () => {
    const body = { topic: f.topic.trim(), text: f.text.trim(), knowledge: f.knowledge, pageId: f.pageId || null };
    if (f.id) await w.call('PATCH', `/broker/notes/${f.id}`, body); else await w.call('POST', '/broker/notes', body);
    setF(blank);
    await list.reload();
  });
  return (
    <div className="cols">
      <section className="col-1 card" aria-labelledby="note-h">
        <h2 id="note-h">{f.id ? 'Edit note' : 'Add a note'}</h2>
        <p className="small muted">The broker only sells what players can already read in the library, plus these notes. Add one to fill a gap or correct an answer. Players see a note only when they buy it.</p>
        <Field label="Topic" help="Words people would ask with"><input value={f.topic} maxLength={200} onChange={(e) => setF({ ...f, topic: e.target.value })} placeholder="Greywater ford ferry toll" /></Field>
        <Field label="What the broker can tell"><textarea rows={4} maxLength={5000} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></Field>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Field label="Price tier"><select value={f.knowledge} onChange={(e) => setF({ ...f, knowledge: e.target.value as BrokerNote['knowledge'] })}><option value="common">Common</option><option value="local">Local</option><option value="deep">Deep</option></select></Field>
        </div>
        <PagePicker label="About a page (optional)" help="Cited by name only if players can see that page." value={f.pageId} onChange={(v) => setF({ ...f, pageId: v })} />
        <ErrorBox error={act.error} />
        <div className="row end">
          {f.id && <button type="button" className="btn" onClick={() => setF(blank)}>Cancel</button>}
          <button type="button" className="btn primary" disabled={act.busy || !f.topic.trim() || !f.text.trim()} onClick={() => void save()}>{f.id ? 'Save' : 'Add note'}</button>
        </div>
      </section>
      <section className="col-2 card flush" aria-label="Notes">
        <ErrorBox error={list.error} />
        {!list.data ? <Loading /> : !list.data.length ? <Empty>No notes yet. Save a good DM answer as a note from the Questions tab, or add one here.</Empty> : list.data.map((n) => (
          <article key={n.id} className="list-item" style={{ display: 'block', padding: '10px 14px', opacity: n.active ? 1 : 0.6 }}>
            <div className="row between"><strong>{n.topic}</strong><span className="chip">{n.knowledge}</span></div>
            <div className="small read" style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div>
            <div className="tiny faint">{n.page_title ? `About ${n.page_title} · ` : ''}{n.from_request ? 'From an answer · ' : ''}{when(n.at)}</div>
            <div className="row" style={{ gap: 6, marginTop: 4 }}>
              <button type="button" className="btn small ghost" onClick={() => setF({ id: n.id, topic: n.topic, text: n.text, knowledge: n.knowledge, pageId: n.page_id ?? '' })}>Edit</button>
              <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('PATCH', `/broker/notes/${n.id}`, { active: !n.active }); await list.reload(); })}>{n.active ? 'Stop selling' : 'Sell again'}</button>
              <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => { if (window.confirm('Delete this note?')) void act.run(async () => { await w.call('DELETE', `/broker/notes/${n.id}`); await list.reload(); }); }}>Delete</button>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}

/** Try a question as a player would ask it, and set per-page price rules. */
function Tune({ cfg }: { cfg: BrokerConfig }) {
  const { w, info } = useWorld();
  const act = useAction();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<(Classification & { player: { answer: string; sources: { id: string | null; title: string }[] } | null; tier_name: string | null; cost_cp: number | null }) | null>(null);
  const rules = useLoad(() => w.call<PageRule[]>('GET', '/broker/rules'), [w], []);
  const [r, setR] = useState({ pageId: '', knowledge: '', multiplier: 1, neverSell: false });
  const saveRule = () => act.run(async () => {
    await w.call('PUT', `/broker/rules/${encodeURIComponent(r.pageId)}`, { knowledge: r.knowledge || null, multiplier: r.multiplier, neverSell: r.neverSell });
    setR({ pageId: '', knowledge: '', multiplier: 1, neverSell: false });
    await rules.reload();
  });
  return (
    <div className="cols">
      <section className="col-2 card" aria-labelledby="try-h">
        <h2 id="try-h">Try a question</h2>
        <p className="small muted">See how the broker would judge it, what it would sell and for how much. Nobody is charged.</p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="grow"><Field label="Question"><input value={q} maxLength={500} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) void act.run(async () => setRes(await w.call('POST', '/broker/classify', { question: q.trim() }))); }} placeholder="Who really runs the harbour?" /></Field></div>
          <button type="button" className="btn" disabled={act.busy || !q.trim()} onClick={() => void act.run(async () => setRes(await w.call('POST', '/broker/classify', { question: q.trim() })))}>Judge it</button>
        </div>
        <ErrorBox error={act.error} />
        {res && (
          <div className="stack tight" style={{ padding: 10, background: 'var(--panel-2)', borderRadius: 8 }}>
            <Judged c={res} />
            <span className="small">{res.verdict === 'shared' ? <>Would sell as <strong>{res.tier_name}</strong> for {res.cost_cp === null ? 'a price you set' : coins(res.cost_cp, info.settings.coins)}.</> : cfg.unknown === 'refuse' ? 'Would be turned away.' : 'Would come to you to price or refuse.'}</span>
            {res.player && <div className="small read" style={{ whiteSpace: 'pre-wrap', borderLeft: '3px solid var(--accent)', paddingLeft: 8 }}>{res.player.answer}<div className="tiny faint">From: {res.player.sources.map((s) => s.title).join(', ')}</div></div>}
          </div>
        )}
      </section>
      <section className="col-1 card" aria-labelledby="rules-h">
        <h2 id="rules-h">Page rules</h2>
        <p className="small muted">Change what one page sells for, or never sell it.</p>
        <PagePicker label="Page" value={r.pageId} onChange={(v) => setR({ ...r, pageId: v })} />
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Field label="Tier"><select value={r.knowledge} onChange={(e) => setR({ ...r, knowledge: e.target.value })}><option value="">As the page says</option><option value="common">Common</option><option value="local">Local</option><option value="deep">Deep</option></select></Field>
          <Field label="Price ×"><input type="number" min={0} step="0.25" value={r.multiplier} onChange={(e) => setR({ ...r, multiplier: Math.max(0, Number(e.target.value) || 0) })} /></Field>
        </div>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={r.neverSell} onChange={(e) => setR({ ...r, neverSell: e.target.checked })} /> Never sell (questions about it come to you)</label>
        <div className="row end"><button type="button" className="btn primary small" disabled={act.busy || !r.pageId} onClick={() => void saveRule()}>Save rule</button></div>
        <ErrorBox error={rules.error} />
        {(rules.data ?? []).map((x) => (
          <div key={x.page_id} className="list-item row between" style={{ gap: 6 }}>
            <span className="small grow"><strong>{x.title ?? 'Deleted page'}</strong><br /><span className="tiny faint">{x.never_sell ? 'Never sold' : `${x.knowledge ?? x.page_knowledge ?? 'local'} ×${x.multiplier}`}</span></span>
            <button type="button" className="btn small ghost" onClick={() => setR({ pageId: x.page_id, knowledge: x.knowledge ?? '', multiplier: x.multiplier, neverSell: x.never_sell })}>Edit</button>
            <button type="button" className="btn small ghost" aria-label={`Remove rule for ${x.title}`} disabled={act.busy} onClick={() => void act.run(async () => { await w.call('DELETE', `/broker/rules/${encodeURIComponent(x.page_id)}`); await rules.reload(); })}>✕</button>
          </div>
        ))}
      </section>
    </div>
  );
}
