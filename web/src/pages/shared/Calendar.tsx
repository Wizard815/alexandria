// Real-life game nights for this world. The DM sets days and times; everyone
// RSVPs, talks about a day, or asks to move it. Calendar apps can subscribe.
import { useMemo, useState, type FormEvent } from 'react';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { dateLong, timeShort, when } from '../../lib/format.ts';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead, useAction } from '../../ui/index.tsx';

const ANSWERS: ['yes' | 'maybe' | 'no', string][] = [['yes', 'Going'], ['maybe', 'Maybe'], ['no', "Can't"]];
const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export default function Calendar() {
  const { w, isDM, info, members } = useWorld();
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const from = new Date(month.getFullYear(), month.getMonth() - 1, 20).toISOString();
  const to = new Date(month.getFullYear(), month.getMonth() + 2, 10).toISOString();
  const cal = useLoad(() => w.calendar(from, to), [w, from, to], ['calendar', 'rsvp', 'reschedule', 'calendar-chat']);
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState<Date | null>(null);
  const [showFeed, setShowFeed] = useState(false);

  const sessions = cal.data ?? [];
  const byDay = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const s of sessions) { const k = new Date(s.starts_at).toDateString(); m.set(k, [...(m.get(k) ?? []), s]); }
    return m;
  }, [sessions]);
  const upcoming = sessions.filter((s: any) => s.status === 'scheduled' && new Date(s.ends_at) > new Date());
  const cur = sessions.find((s: any) => s.id === sel) ?? upcoming[0] ?? null;

  if (info.settings.calendar === 'off') return <div className="page"><PageHead title="Session calendar" lead="The session calendar is off for this world." /></div>;

  const first = new Date(month);
  first.setDate(1 - first.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => { const d = new Date(first); d.setDate(first.getDate() + i); return d; });
  const players = members.filter((m) => m.role !== 'guest');

  return (
    <div className="page">
      <PageHead title="Session calendar" lead="Real-life game nights. RSVP, talk about a day, or ask to move it.">
        <button type="button" className="btn" onClick={() => setShowFeed(true)}>Add to my calendar app</button>
        {isDM && <button type="button" className="btn primary" onClick={() => setAdding(new Date())}>Set a session day</button>}
      </PageHead>
      <ErrorBox error={cal.error} />
      <div className="cols">
        <div className="col-3 card">
          <div className="row between">
            <button type="button" className="btn small" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
            <h2>{month.toLocaleDateString([], { month: 'long', year: 'numeric' })}</h2>
            <button type="button" className="btn small" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
          </div>
          <div role="grid" aria-label="Month" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }}>
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <span key={d} role="columnheader" className="tiny faint" style={{ textAlign: 'center' }}>{d}</span>)}
            {cells.map((d) => {
              const list = byDay.get(d.toDateString()) ?? [];
              const inMonth = d.getMonth() === month.getMonth();
              const today = d.toDateString() === new Date().toDateString();
              const s = list[0];
              return (
                <button key={d.toISOString()} type="button" role="gridcell"
                  onClick={() => (s ? setSel(s.id) : isDM ? setAdding(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 19)) : undefined)}
                  aria-label={`${d.toDateString()}${s ? `: ${s.title} at ${timeShort(s.starts_at)}` : ''}`}
                  style={{ minHeight: 64, padding: 4, borderRadius: 6, textAlign: 'left', font: 'inherit', cursor: s || isDM ? 'pointer' : 'default', display: 'flex', flexDirection: 'column', gap: 3, color: inMonth ? 'var(--text)' : 'var(--faint)', background: 'var(--side)', border: `1px solid ${s && s.id === cur?.id ? 'var(--accent)' : today ? 'var(--teal)' : 'var(--line)'}` }}>
                  <span className="tiny">{d.getDate()}</span>
                  {list.map((x) => (
                    <span key={x.id} className="tiny" style={{ padding: '0 4px', borderRadius: 4, fontWeight: 700, color: 'var(--on-accent)', background: x.status === 'cancelled' ? 'var(--faint)' : x.reschedules.length ? 'var(--danger)' : 'var(--accent)', overflow: 'hidden', whiteSpace: 'nowrap' }}>{timeShort(x.starts_at)}</span>
                  ))}
                </button>
              );
            })}
          </div>
        </div>
        <div className="col-2">
          {cal.loading && !cal.data ? <Loading /> : cur ? <SessionDay s={cur} players={players} onChange={() => void cal.reload()} /> : <div className="card"><Empty>No sessions set yet.{isDM ? ' Pick a day to set one.' : ''}</Empty></div>}
        </div>
      </div>
      {adding && <SessionForm start={adding} onClose={() => setAdding(null)} onDone={(id) => { setAdding(null); setSel(id); void cal.reload(); }} />}
      {showFeed && (
        <Modal title="Add to your calendar app" onClose={() => setShowFeed(false)}>
          <p className="small">Subscribe in Apple Calendar, Thunderbird, DAVx⁵ or Google Calendar with this address. Sign in with your username and a key from “Connect an AI” (read-only is fine) as the password.</p>
          <p className="mono" style={{ wordBreak: 'break-all' }}>{w.icsUrl()}</p>
          <p className="small muted">The feed carries only the title, time and place. Nothing from the library goes into it.</p>
        </Modal>
      )}
    </div>
  );
}

function SessionDay({ s, players, onChange }: { s: any; players: { id: string }[]; onChange: () => void }) {
  const { w, me, isDM, nameOf } = useWorld();
  const chat = useLoad(() => w.dayChat(s.id), [w, s.id], ['calendar-chat']);
  const [text, setText] = useState('');
  const [asking, setAsking] = useState(false);
  const [editing, setEditing] = useState(false);
  const a = useAction();
  const mine = s.rsvps.find((r: any) => r.account_id === me)?.answer;
  const rsvp = (answer: 'yes' | 'maybe' | 'no') => void a.run(async () => { await w.rsvp(s.id, answer); onChange(); });
  const say = (e: FormEvent) => { e.preventDefault(); if (!text.trim()) return; void a.run(async () => { await w.sayAboutDay(s.id, text.trim()); setText(''); await chat.reload(); }); };
  const decide = (rid: string, status: 'accepted' | 'declined', moveTo?: string) => void a.run(async () => { await w.call('POST', `/calendar/${s.id}/reschedule/${rid}`, { status, moveTo }); onChange(); });
  const cancel = () => { if (confirm('Cancel this session?')) void a.run(async () => { await w.call('PATCH', `/calendar/${s.id}`, { status: s.status === 'cancelled' ? 'scheduled' : 'cancelled' }); onChange(); }); };
  return (
    <div className="card gold">
      <div className="stack tight">
        <div className="row between"><h2>{s.title}</h2>{s.status === 'cancelled' && <span className="chip red">Cancelled</span>}</div>
        <span className="muted">{dateLong(s.starts_at)} · {timeShort(s.starts_at)}–{timeShort(s.ends_at)}{s.location ? ` · ${s.location}` : ''}</span>
      </div>
      {isDM && <div className="row"><button type="button" className="btn small" onClick={() => setEditing(true)}>Change time or place</button><button type="button" className="btn small danger" onClick={cancel}>{s.status === 'cancelled' ? 'Restore' : 'Cancel session'}</button></div>}
      <div className="stack tight">
        <span className="tiny faint" style={{ textTransform: 'uppercase', letterSpacing: '0.1em' }}>RSVP · {s.rsvps.filter((r: any) => r.answer === 'yes').length} going</span>
        <div className="tabs" role="radiogroup" aria-label="Your answer">{ANSWERS.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={mine === k} className={`btn small${mine === k ? ' on' : ''}`} onClick={() => rsvp(k)}>{l}</button>)}</div>
        {players.map((p) => { const r = s.rsvps.find((x: any) => x.account_id === p.id); return <div key={p.id} className="row between small"><span>{nameOf(p.id)}</span><span className={r?.answer === 'yes' ? '' : 'muted'} style={r?.answer === 'no' ? { color: 'var(--danger-text)' } : r?.answer === 'yes' ? { color: 'var(--ok-text)' } : undefined}>{r ? ANSWERS.find(([k]) => k === r.answer)![1] : 'No answer'}</span></div>; })}
      </div>
      {s.reschedules.map((x: any) => (
        <div key={x.id} className="error-box stack tight">
          <span><strong>{nameOf(x.author_id)}</strong> asked to move it: {x.reason}</span>
          {x.proposed.length > 0 && <span className="small">Works for them: {x.proposed.map((p: string) => when(p)).join(', ')}</span>}
          {isDM && <div className="row">{x.proposed.map((p: string) => <button key={p} type="button" className="btn small primary" onClick={() => decide(x.id, 'accepted', p)}>Move to {when(p)}</button>)}<button type="button" className="btn small" onClick={() => decide(x.id, 'declined')}>Keep the day</button></div>}
        </div>
      ))}
      {!isDM && <button type="button" className="btn small" onClick={() => setAsking(true)}>Ask to reschedule</button>}
      <div className="stack tight">
        <span className="tiny faint" style={{ textTransform: 'uppercase', letterSpacing: '0.1em' }}>Talk about this day</span>
        {(chat.data ?? []).map((m: any) => <div key={m.id} className="small" style={{ padding: '4px 8px', borderRadius: 6, background: 'var(--side)' }}><strong style={{ color: 'var(--accent-strong)' }}>{nameOf(m.author_id)}</strong> <span className="tiny faint">{when(m.at)}</span><br />{m.body}</div>)}
        <form className="row" onSubmit={say}><label className="sr-only" htmlFor="daychat">Message</label><input id="daychat" className="input grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Say something about this day…" /><button className="btn" disabled={!text.trim()}>Send</button></form>
      </div>
      <ErrorBox error={a.error} />
      {asking && <Reschedule id={s.id} onClose={() => setAsking(false)} onDone={() => { setAsking(false); onChange(); }} />}
      {editing && <SessionForm session={s} start={new Date(s.starts_at)} onClose={() => setEditing(false)} onDone={() => { setEditing(false); onChange(); }} />}
    </div>
  );
}

function SessionForm({ start, session, onClose, onDone }: { start: Date; session?: any; onClose: () => void; onDone: (id: string) => void }) {
  const { w } = useWorld();
  const [title, setTitle] = useState(session?.title ?? 'Game night');
  const [s, setS] = useState(localInput(start));
  const [hours, setHours] = useState(session ? String((Date.parse(session.ends_at) - Date.parse(session.starts_at)) / 36e5) : '4');
  const [where, setWhere] = useState(session?.location ?? '');
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const st = new Date(s);
    const body = { title, startsAt: st.toISOString(), endsAt: new Date(st.getTime() + Number(hours) * 36e5).toISOString(), location: where };
    void a.run(async () => onDone(session ? ((await w.call('PATCH', `/calendar/${session.id}`, body)) as any).id : ((await w.scheduleSession(body)) as any).id));
  };
  return (
    <Modal title={session ? 'Change session' : 'Set a session day'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} required /></Field>
        <div className="row top"><Field label="Starts"><input type="datetime-local" value={s} onChange={(e) => setS(e.target.value)} required /></Field><Field label="Hours"><input type="number" min="0.5" max="24" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} /></Field></div>
        <Field label="Where"><input value={where} onChange={(e) => setWhere(e.target.value)} placeholder="Discord, the game table…" /></Field>
        {session && <p className="small muted">Moving the start clears RSVPs so everyone answers for the new time.</p>}
        <ErrorBox error={a.error} />
        <button className="btn primary" disabled={a.busy}>{session ? 'Save' : 'Set day'}</button>
      </form>
    </Modal>
  );
}

function Reschedule({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const { w } = useWorld();
  const [reason, setReason] = useState('');
  const [days, setDays] = useState<string[]>(['']);
  const a = useAction();
  return (
    <Modal title="Ask to reschedule" onClose={onClose}>
      <Field label="Why"><input value={reason} onChange={(e) => setReason(e.target.value)} required /></Field>
      {days.map((d, i) => <Field key={i} label={`A day that works for you${days.length > 1 ? ` (${i + 1})` : ''}`}><input type="datetime-local" value={d} onChange={(e) => setDays(days.map((x, j) => (j === i ? e.target.value : x)))} /></Field>)}
      {days.length < 5 && <button type="button" className="btn small" onClick={() => setDays([...days, ''])}>Add another day</button>}
      <ErrorBox error={a.error} />
      <button type="button" className="btn primary" disabled={!reason.trim() || a.busy} onClick={() => void a.run(async () => { await w.askReschedule(id, reason, days.filter(Boolean).map((d) => new Date(d).toISOString())); onDone(); })}>Send</button>
    </Modal>
  );
}
