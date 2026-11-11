// Quick events: send a recall, save, choice, vote... to players, watch the
// answers come in, then resolve. Players never see the DC or the outcome
// text until you resolve, and then only their own.
import { useEffect, useState, type FormEvent } from 'react';
import { PageHead, ErrorBox, Empty, Loading, Field, Switch, useAction } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { CHECK_KINDS, OPTION_KINDS, QUICK_KINDS, usePlayers } from './shared.tsx';

export default function DMQuickEvents() {
  const { w } = useWorld();
  const events = useLoad<any[]>(() => w.quickEvents(), [w], ['quick-event', 'quick-event-cancelled']);
  const open = (events.data ?? []).filter((e) => e.status === 'open');
  const past = (events.data ?? []).filter((e) => e.status !== 'open');
  return (
    <div className="page wide">
      <PageHead title="Quick events" lead="A prompt pops up on the chosen players' screens with a timer. Their answers show here as they arrive." />
      <ErrorBox error={events.error} />
      <div className="cols">
        <section className="col-1" style={{ maxWidth: 480 }}><Compose /></section>
        <section className="col-2 stack">
          <h2>Waiting on players</h2>
          {events.loading ? <Loading /> : open.length ? open.map((e) => <EventCard key={e.id} e={e} />) : <div className="card"><Empty>Nothing open. Send one on the left.</Empty></div>}
          {past.length > 0 && (
            <details>
              <summary className="muted">Earlier events ({past.length})</summary>
              <div className="stack" style={{ marginTop: 10 }}>{past.map((e) => <EventCard key={e.id} e={e} />)}</div>
            </details>
          )}
        </section>
      </div>
    </div>
  );
}

function Compose() {
  const { w, info } = useWorld();
  const players = usePlayers();
  const act = useAction();
  const [kind, setKind] = useState('recall');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [skill, setSkill] = useState('');
  const [dc, setDc] = useState('');
  const [success, setSuccess] = useState('');
  const [fail, setFail] = useState('');
  const [everyone, setEveryone] = useState(true);
  const [who, setWho] = useState<string[]>([]);
  const [timer, setTimer] = useState<string>(info.settings.quickEventTimer ? String(info.settings.quickEventTimer) : '');
  const [publicVotes, setPublicVotes] = useState(true);
  const isCheck = CHECK_KINDS.includes(kind);
  const hasOptions = OPTION_KINDS.includes(kind);

  const submit = (e: FormEvent) => act.run(async () => {
    e.preventDefault();
    const opts = options.map((o) => o.trim()).filter(Boolean);
    if ((kind === 'choice' || kind === 'vote') && opts.length < 2) throw new Error('Give at least two options');
    if (!everyone && !who.length) throw new Error('Pick at least one player, or send to the whole party');
    await w.sendQuickEvent({
      kind, title: title.trim(), prompt: prompt.trim(),
      ...(hasOptions && opts.length ? { options: opts } : {}),
      ...(isCheck && skill.trim() ? { skill: skill.trim() } : {}),
      ...(isCheck && dc ? { dc: parseInt(dc, 10) } : {}),
      ...(success.trim() ? { successText: success.trim() } : {}),
      ...(fail.trim() ? { failText: fail.trim() } : {}),
      ...(everyone ? {} : { audience: who }),
      timerS: timer ? parseInt(timer, 10) : null,
      ...(kind === 'vote' ? { publicVotes } : {}),
    });
    setTitle(''); setPrompt(''); setOptions(['', '']); setSuccess(''); setFail(''); setDc('');
  });

  return (
    <form className="card gold" onSubmit={(e) => void submit(e)}>
      <h2>Send a quick event</h2>
      <div className="grid small" role="radiogroup" aria-label="Kind">
        {QUICK_KINDS.map(([k, label, help]) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} title={help} className={`btn small${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>{label}</button>
        ))}
      </div>
      <span className="tiny muted">{QUICK_KINDS.find((k) => k[0] === kind)?.[2]}</span>
      <Field label="Title"><input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The grey sails" /></Field>
      <Field label="What players see"><textarea required rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Odda mentions a ship with grey sails. Where have you heard of it?" /></Field>
      {isCheck && (
        <div className="grid small">
          <Field label="Skill or save"><input value={skill} onChange={(e) => setSkill(e.target.value)} placeholder="History" /></Field>
          <Field label="DC" help="Hidden from players"><input inputMode="numeric" value={dc} onChange={(e) => setDc(e.target.value.replace(/[^\d]/g, ''))} /></Field>
        </div>
      )}
      {hasOptions && (
        <div className="stack tight">
          <span className="small muted">Options {kind === 'reaction' && '(optional: first answer wins)'}</span>
          {options.map((o, i) => (
            <div key={i} className="row">
              <label className="sr-only" htmlFor={`opt-${i}`}>Option {i + 1}</label>
              <input id={`opt-${i}`} className="input grow" value={o} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Option ${i + 1}`} />
              {options.length > 2 && <button type="button" className="btn small ghost" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}>✕</button>}
            </div>
          ))}
          {options.length < 8 && <button type="button" className="btn small" onClick={() => setOptions([...options, ''])}>＋ Option</button>}
          {kind === 'vote' && <label className="row small"><Switch checked={publicVotes} onChange={setPublicVotes} label="Show the tally to players" /> Players see the tally</label>}
        </div>
      )}
      <div className="grid small">
        <Field label="On success" help="Only that player sees it, after you resolve"><textarea rows={2} value={success} onChange={(e) => setSuccess(e.target.value)} /></Field>
        <Field label="On failure"><textarea rows={2} value={fail} onChange={(e) => setFail(e.target.value)} /></Field>
      </div>
      <div className="stack tight">
        <span className="small muted">Who gets it</span>
        <div className="row" role="radiogroup" aria-label="Who gets it">
          <button type="button" role="radio" aria-checked={everyone} className={`btn small${everyone ? ' on' : ''}`} onClick={() => setEveryone(true)}>Whole party</button>
          <button type="button" role="radio" aria-checked={!everyone} className={`btn small${!everyone ? ' on' : ''}`} onClick={() => setEveryone(false)}>Pick players</button>
        </div>
        {!everyone && (
          <div className="row">
            {players.map((p) => (
              <button key={p.id} type="button" role="checkbox" aria-checked={who.includes(p.id)} className={`btn small${who.includes(p.id) ? ' on' : ''}`} onClick={() => setWho(who.includes(p.id) ? who.filter((x) => x !== p.id) : [...who, p.id])}>{p.character_name || p.display_name}</button>
            ))}
            {!players.length && <span className="small faint">No players in this world yet.</span>}
          </div>
        )}
      </div>
      <Field label="Timer (seconds)" help="Empty for no timer"><input inputMode="numeric" value={timer} onChange={(e) => setTimer(e.target.value.replace(/[^\d]/g, ''))} /></Field>
      <ErrorBox error={act.error} />
      <button type="submit" className="btn primary" disabled={act.busy}>{act.busy && !act.offline ? 'Sending…' : 'Send now'}</button>
    </form>
  );
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function EventCard({ e }: { e: any }) {
  const { w, nameOf } = useWorld();
  const act = useAction();
  const [override, setOverride] = useState<Record<string, 'success' | 'fail'>>({});
  const open = e.status === 'open';
  const now = useNow(open && !!e.closes_at);
  const left = e.closes_at ? Math.max(0, Math.round((Date.parse(e.closes_at) - now) / 1000)) : null;
  const answered = new Set(e.responses.map((r: any) => r.account_id));
  const waiting = e.audience.filter((id: string) => !answered.has(id));
  const opt = (i: number | null) => (i === null ? '' : e.options[i] ?? `Option ${i + 1}`);
  const tally = e.options.map((_: string, i: number) => e.responses.filter((r: any) => r.choice === i).length);

  return (
    <article className="card" style={open ? { borderColor: 'var(--accent)' } : undefined}>
      <div className="card-head">
        <div className="stack tight">
          <span className="row"><span className="chip gold">{QUICK_KINDS.find((k) => k[0] === e.kind)?.[1] ?? e.kind}</span><strong>{e.title}</strong></span>
          <span className="small muted">{e.prompt}</span>
        </div>
        <span className="row small">
          {open ? (left !== null ? <span className={`chip ${left > 0 ? 'gold' : 'red'}`}>{left > 0 ? `${left}s left` : 'Time up'}</span> : <span className="chip">No timer</span>) : <span className={`chip ${e.status === 'resolved' ? 'green' : 'red'}`}>{e.status}</span>}
          <span className="faint">{when(e.created_at)}</span>
        </span>
      </div>
      {(e.skill || e.dc) && <span className="small">{e.skill}{e.dc ? ` · DC ${e.dc}` : ''}</span>}
      {e.kind === 'vote' && e.options.length > 0 && (
        <div className="row small">{e.options.map((o: string, i: number) => <span key={i} className="chip teal">{o}: {tally[i]}</span>)}</div>
      )}
      <div className="scroll-x">
        <table className="table">
          <thead><tr><th scope="col">Player</th><th scope="col">Answer</th><th scope="col">Result</th></tr></thead>
          <tbody>
            {e.responses.map((r: any, i: number) => {
              const auto = e.dc && r.total !== null ? (r.total >= e.dc ? 'success' : 'fail') : e.kind === 'reaction' ? (i === 0 ? 'success' : 'fail') : null;
              const res = r.result ?? override[r.account_id] ?? auto;
              return (
                <tr key={r.account_id}>
                  <td>{nameOf(r.account_id)}</td>
                  <td>{r.total !== null ? `${r.total} (rolled ${r.roll})` : r.choice !== null ? opt(r.choice) : 'Passed'}</td>
                  <td>
                    {open ? (
                      <div className="row" role="radiogroup" aria-label={`Result for ${nameOf(r.account_id)}`}>
                        {(['success', 'fail'] as const).map((k) => (
                          <button key={k} type="button" role="radio" aria-checked={res === k} className={`btn small${res === k ? ' on' : ''}`} onClick={() => setOverride({ ...override, [r.account_id]: k })}>{k === 'success' ? 'Success' : 'Fail'}</button>
                        ))}
                      </div>
                    ) : <span className={`chip ${r.result === 'success' ? 'green' : r.result === 'fail' ? 'red' : ''}`}>{r.result ?? '—'}</span>}
                  </td>
                </tr>
              );
            })}
            {open && waiting.map((id: string) => <tr key={id}><td>{nameOf(id)}</td><td className="faint">waiting…</td><td /></tr>)}
          </tbody>
        </table>
      </div>
      {open && (
        <>
          <ErrorBox error={act.error} />
          <div className="row end">
            <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(() => w.call('POST', `/quick-events/${e.id}/cancel`))}>Cancel</button>
            <button type="button" className="btn primary small" disabled={act.busy} onClick={() => void act.run(() => w.resolve(e.id, override))}>Resolve{waiting.length ? ` (${waiting.length} not answered)` : ''}</button>
          </div>
        </>
      )}
    </article>
  );
}
