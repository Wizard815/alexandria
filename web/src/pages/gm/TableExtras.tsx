// More blocks for the GM's Table (pages/gm/Table.tsx): quick events, dice, notes, quick links, the last recap, people,
// sound, the stage, NPC names and what is coming up. Each one is small; the GM arranges, hides or brings them back.
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, useAction } from '../../ui/index.tsx';
import { TableCard } from '../../ui/TableCard.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { useAuth } from '../../lib/auth.tsx';
import { dateLong, timeShort, when } from '../../lib/format.ts';
import { GM_NAMES, gmLabel } from '../../lib/gmnames.ts';
import { CHECK_KINDS, lsGet, lsSet, OPTION_KINDS, QUICK_KINDS } from './shared.tsx';

// ---- Quick events: send one from the Table, watch the answers ----

const QUICK_PICK = ['recall', 'notice', 'save', 'vote', 'choice', 'twist'];
const TIMERS: [string, string][] = [['', 'No timer'], ['30', '30 s'], ['60', '1 min'], ['120', '2 min'], ['300', '5 min']];

export function QuickEventsBlock() {
  const { w, info } = useWorld();
  const act = useAction();
  const events = useLoad<any[]>(() => w.quickEvents(), [w], ['quick-event', 'quick-event-cancelled']);
  const [kind, setKind] = useState('recall');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [options, setOptions] = useState('');
  const [skill, setSkill] = useState('');
  const [dc, setDc] = useState('');
  const [timer, setTimer] = useState(info.settings.quickEventTimer ? String(info.settings.quickEventTimer) : '');
  const [sent, setSent] = useState('');
  const open = (events.data ?? []).filter((e) => e.status === 'open');
  const isCheck = CHECK_KINDS.includes(kind);
  const hasOptions = OPTION_KINDS.includes(kind);
  const send = (e: FormEvent) => act.run(async () => {
    e.preventDefault();
    const opts = options.split(/[,\n]/).map((o) => o.trim()).filter(Boolean);
    if ((kind === 'choice' || kind === 'vote') && opts.length < 2) throw new Error('Give at least two options, separated by commas');
    await w.sendQuickEvent({
      kind, title: title.trim(), prompt: (prompt.trim() || title.trim()),
      ...(hasOptions && opts.length ? { options: opts } : {}),
      ...(isCheck && skill.trim() ? { skill: skill.trim() } : {}),
      ...(isCheck && dc ? { dc: parseInt(dc, 10) } : {}),
      timerS: timer ? parseInt(timer, 10) : null,
    });
    setSent(title.trim()); setTitle(''); setPrompt(''); setOptions(''); setDc('');
    await events.reload();
  });
  return (
    <TableCard id="quick" title="Quick events" icon="fa-bolt" link={['quick', 'All options']} badge={open.length ? `${open.length} open` : undefined}>
      {open.length > 0 && (
        <ul className="tb-list" data-testid="tb-quick-open">
          {open.slice(0, 4).map((e) => (
            <li key={e.id}>
              <div className="row between"><Link to={`/w/${info.slug}/gm/quick`} className="tb-ellipsis"><span className="chip gold">{QUICK_KINDS.find((k) => k[0] === e.kind)?.[1] ?? e.kind}</span> {e.title}</Link><span className="tiny muted">{e.responses.length}/{e.audience.length} answered</span></div>
              <span className="tb-hp wide"><span style={{ width: `${e.audience.length ? Math.round((e.responses.length / e.audience.length) * 100) : 0}%` }} /></span>
            </li>
          ))}
        </ul>
      )}
      <form className="tb-quick" onSubmit={(e) => void send(e)} aria-label="Send a quick event">
        <div className="tb-seg wrap" role="radiogroup" aria-label="Kind">
          {QUICK_PICK.map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)} title={QUICK_KINDS.find((q) => q[0] === k)?.[2]}>{QUICK_KINDS.find((q) => q[0] === k)?.[1]}</button>)}
        </div>
        <input required aria-label="Title" placeholder="Title: The grey sails" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea rows={2} aria-label="What players see" placeholder="What players see (optional)" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        {hasOptions && <input aria-label="Options" placeholder="Options, separated by commas" value={options} onChange={(e) => setOptions(e.target.value)} />}
        {isCheck && (
          <div className="row">
            <input className="grow" aria-label="Skill or save" placeholder="Skill or save" value={skill} onChange={(e) => setSkill(e.target.value)} />
            <input style={{ width: 70 }} aria-label="DC, hidden from players" placeholder="DC" inputMode="numeric" value={dc} onChange={(e) => setDc(e.target.value.replace(/[^\d]/g, ''))} />
          </div>
        )}
        <div className="row">
          <select aria-label="Timer" value={timer} onChange={(e) => setTimer(e.target.value)}>{TIMERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <span className="grow small faint">To the whole party</span>
          <button type="submit" className="btn primary small" disabled={act.busy} data-testid="tb-quick-send"><i className="fa-solid fa-paper-plane" aria-hidden="true" /> Send</button>
        </div>
        {sent && !act.error && <span className="small tb-ok">Sent “{sent}”.</span>}
        <ErrorBox error={act.error} />
      </form>
    </TableCard>
  );
}

// ---- Dice: the GM's own rolls, never shown to players ----

const DICE = [4, 6, 8, 10, 12, 20, 100];
interface Roll { expr: string; rolls: number[]; mod: number; total: number; at: number }

function rollExpr(expr: string): Roll | null {
  const m = expr.replace(/\s+/g, '').toLowerCase().match(/^(\d{0,2})d(\d{1,3})([+-]\d{1,3})?$/);
  if (!m) return null;
  const n = Math.min(Math.max(parseInt(m[1] || '1', 10), 1), 50), sides = Math.max(parseInt(m[2], 10), 2), mod = m[3] ? parseInt(m[3], 10) : 0;
  const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
  return { expr: `${n}d${sides}${mod ? (mod > 0 ? `+${mod}` : mod) : ''}`, rolls, mod, total: rolls.reduce((a, b) => a + b, 0) + mod, at: Date.now() };
}

export function DiceBlock() {
  const [log, setLog] = useState<Roll[]>([]);
  const [expr, setExpr] = useState('');
  const [bad, setBad] = useState(false);
  const roll = (e: string) => { const r = rollExpr(e); setBad(!r); if (r) setLog((l) => [r, ...l].slice(0, 6)); };
  const last = log[0];
  return (
    <TableCard id="dice" title="Dice" icon="fa-dice" badge="only you">
      <div className="tb-dice">
        {DICE.map((d) => <button key={d} type="button" className="btn small" onClick={() => roll(`d${d}`)}>d{d}</button>)}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); roll(expr); }}>
        <input className="grow" aria-label="Dice to roll" placeholder="2d6+3" value={expr} onChange={(e) => setExpr(e.target.value)} aria-invalid={bad || undefined} />
        <button type="submit" className="btn small">Roll</button>
      </form>
      {bad && <span className="small tb-danger">Write it like 2d6+3.</span>}
      {last && (
        <div className="tb-roll" data-testid="tb-roll" aria-live="polite">
          <b className={last.expr.endsWith('d20') && last.rolls[0] === 20 ? 'tb-ok' : last.expr.endsWith('d20') && last.rolls[0] === 1 ? 'tb-danger' : ''}>{last.total}</b>
          <span className="small muted">{last.expr}{last.rolls.length > 1 || last.mod ? ` · ${last.rolls.join(' + ')}${last.mod ? ` ${last.mod > 0 ? '+' : '−'} ${Math.abs(last.mod)}` : ''}` : ''}</span>
        </div>
      )}
      {log.length > 1 && <span className="tiny faint">Before: {log.slice(1).map((r) => `${r.expr} ${r.total}`).join(' · ')}</span>}
    </TableCard>
  );
}

// ---- Notes: a scratchpad for this session, kept on this device ----

export function NotesBlock() {
  const { info } = useWorld();
  const key = `alx.gm.table.notes.${info.id}`;
  const [text, setText] = useState(() => lsGet<string>(key, ''));
  return (
    <TableCard id="notes" title="Notes" icon="fa-note-sticky" badge="this device">
      <textarea className="tb-notes" aria-label="Session notes" rows={6} placeholder="Names you made up, what they promised, who owes whom…" value={text} onChange={(e) => { setText(e.target.value); lsSet(key, e.target.value); }} />
    </TableCard>
  );
}

// ---- Quick links: any GM page, picked by the GM ----

const DEFAULT_LINKS = ['templates', 'generators', 'people', 'rules', 'sound', 'stage', 'sessionlog', 'minerva'];

export function LinksBlock() {
  const { info } = useWorld();
  const { me } = useAuth();
  const key = `alx.gm.table.links.${info.id}`;
  const [links, setLinks] = useState<string[]>(() => lsGet<string[]>(key, DEFAULT_LINKS));
  const [edit, setEdit] = useState(false);
  const save = (l: string[]) => { setLinks(l); lsSet(key, l); };
  const all = Object.keys(GM_NAMES).filter((k) => k);
  return (
    <TableCard id="links" title="Quick links" icon="fa-link" badge={<button type="button" className="tb-linkbtn" onClick={() => setEdit(!edit)} aria-expanded={edit}>{edit ? 'Done' : 'Edit'}</button>}>
      <div className="tb-links">
        {links.filter((k) => GM_NAMES[k]).map((k) => (
          <Link key={k} to={`/w/${info.slug}/gm/${k}`} className="tb-link" title={GM_NAMES[k].desc}><i className={`fa-solid ${GM_NAMES[k].icon}`} aria-hidden="true" /> {gmLabel(k)}</Link>
        ))}
        {me?.account.is_admin && <Link to="/admin/models" className="tb-link" title="Which local models run chat, audit, speech and embeddings"><i className="fa-solid fa-microchip" aria-hidden="true" /> Model settings</Link>}
      </div>
      {edit && (
        <div className="tb-links edit" role="group" aria-label="Pick quick links">
          {all.map((k) => <button key={k} type="button" role="checkbox" aria-checked={links.includes(k)} className={`btn small${links.includes(k) ? ' on' : ''}`} onClick={() => save(links.includes(k) ? links.filter((x) => x !== k) : [...links, k])}>{gmLabel(k)}</button>)}
        </div>
      )}
    </TableCard>
  );
}

// ---- The last recap ----

export function RecapBlock() {
  const { w } = useWorld();
  const log = useLoad<any[]>(() => w.call('GET', '/sessionlog'), [w], ['sessionlog']);
  if (!log.data) return null;
  const last = log.data.find((e) => e.published) ?? log.data[0];
  if (!last) return <TableCard id="recap" title="Last time" icon="fa-clock-rotate-left" link={['sessionlog', 'Recaps']} quiet="No recap yet." />;
  return (
    <TableCard id="recap" title="Last time" icon="fa-clock-rotate-left" link={['sessionlog', 'Recaps']} badge={!last.published ? 'draft' : undefined}>
      <strong>{last.title}</strong>
      {(last.worldFrom || last.worldTo) && <span className="tiny faint">{last.worldFrom}{last.worldTo && last.worldTo !== last.worldFrom ? ` → ${last.worldTo}` : ''}</span>}
      <p className="small muted tb-clamp">{String(last.summary ?? '').replace(/[#*_>`]/g, '').trim() || 'No summary.'}</p>
    </TableCard>
  );
}

// ---- People the party knows ----

export function PeopleBlock() {
  const { w, info } = useWorld();
  const people = useLoad<any[]>(() => w.people() as Promise<any[]>, [w], ['person']);
  if (!people.data) return null;
  if (!people.data.length) return <TableCard id="people" title="People" icon="fa-user-group" link={['people', 'People']} quiet="The party has met nobody yet." />;
  // Newest first: seq is the order they were added in.
  const list = [...people.data].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0)).slice(0, 6);
  return (
    <TableCard id="people" title="People" icon="fa-user-group" link={['people', 'People']} badge={people.data.length}>
      <ul className="tb-list">
        {list.map((p) => (
          <li key={p.id} className="row between">
            <span className="tb-ellipsis grow">{p.page_id ? <Link to={`/w/${info.slug}/gm/library?page=${encodeURIComponent(p.page_id)}`}><b>{p.name}</b></Link> : <b>{p.name}</b>}{p.role ? <span className="muted"> · {p.role}</span> : null}</span>
            {p.attitude && <span className={`chip ${p.kind === 'ally' ? 'green' : p.kind === 'rival' || p.kind === 'enemy' ? 'red' : ''}`}>{p.attitude}</span>}
          </li>
        ))}
      </ul>
    </TableCard>
  );
}

// ---- Sound: what is playing, stop it, play a sound scene ----

export function SoundBlock() {
  const { w } = useWorld();
  const act = useAction();
  const now = useLoad<any>(() => w.call('GET', '/sound/now'), [w], ['sound']);
  const scenes = useLoad<any[]>(() => w.call<any[]>('GET', '/sound/scenes').catch(() => []), [w]);
  if (!now.data) return null;
  const music = now.data.music, amb = now.data.ambience;
  const playing = !!(music || amb);
  const stop = () => act.run(async () => { await Promise.all([w.call('POST', '/sound/music/stop', {}), w.call('POST', '/sound/ambience/stop', {})]); await now.reload(); });
  return (
    <TableCard id="sound" title="Sound" icon="fa-music" link={['sound', 'Sound']} tone={playing ? 'teal' : undefined}>
      {playing ? (
        <div className="stack tight small">
          {music && <span><i className="fa-solid fa-compact-disc" aria-hidden="true" /> <b>{music.title ?? 'Music'}</b> <span className="faint">· music</span></span>}
          {amb && <span><i className="fa-solid fa-wind" aria-hidden="true" /> <b>{amb.title ?? (Array.isArray(amb.layers) ? amb.layers.map((l: any) => l.kind).join(', ') : 'Ambience')}</b> <span className="faint">· ambience</span></span>}
        </div>
      ) : <span className="small muted">Nothing playing.</span>}
      <div className="row">
        {(scenes.data ?? []).slice(0, 4).map((s) => <button key={s.id} type="button" className="btn small" disabled={act.busy} onClick={() => act.run(async () => { await w.call('POST', `/sound/scenes/${s.id}/play`, {}); await now.reload(); })}>{s.name}</button>)}
        {playing && <button type="button" className="btn small ghost tb-danger" disabled={act.busy} onClick={() => void stop()}><i className="fa-solid fa-stop" aria-hidden="true" /> Stop all</button>}
      </div>
      <ErrorBox error={act.error} />
    </TableCard>
  );
}

// ---- The stage: what the players see, show or hide a card ----

export function StageBlock() {
  const { w } = useWorld();
  const act = useAction();
  const stage = useLoad<any>(() => w.call('GET', '/stage'), [w], ['stage']);
  if (!stage.data) return null;
  const cards: any[] = stage.data.cards ?? [];
  if (!cards.length) return <TableCard id="stage" title="Stage" icon="fa-image" link={['stage', 'Make a card']} quiet="No cards prepared." />;
  const shown = cards.filter((c) => c.shownAt);
  const label = (c: any) => c.label || c.data?.title || c.kind;
  const flip = (c: any) => act.run(async () => { await w.call('POST', `/stage/cards/${c.id}/${c.shownAt ? 'hide' : 'show'}`, c.shownAt ? {} : { to: 'all' }); await stage.reload(); });
  return (
    <TableCard id="stage" title="Stage" icon="fa-image" link={['stage', 'Stage']} badge={`${shown.length} shown`}>
      <ul className="tb-list">
        {cards.slice(0, 6).map((c) => (
          <li key={c.id} className="row between">
            <span className="tb-ellipsis grow">{label(c)}</span>
            <button type="button" className={`btn small${c.shownAt ? ' on' : ''}`} aria-pressed={!!c.shownAt} disabled={act.busy} onClick={() => void flip(c)}>{c.shownAt ? 'Shown' : 'Show'}</button>
          </li>
        ))}
      </ul>
      <ErrorBox error={act.error} />
    </TableCard>
  );
}

// ---- NPC names on demand ----

export function NamesBlock() {
  const { w } = useWorld();
  const act = useAction();
  const [names, setNames] = useState<{ name: string; race: string }[]>([]);
  const more = () => act.run(async () => setNames(((await w.call<any>('GET', '/quickgen/names?count=6')).names ?? []).map((n: any) => ({ name: n.name, race: n.race }))));
  return (
    <TableCard id="names" title="NPC names" icon="fa-signature" link={['generators', 'Generators']}>
      {names.length ? <ul className="tb-names">{names.map((n, i) => <li key={i}><b>{n.name}</b> <span className="tiny faint">{n.race}</span></li>)}</ul> : <span className="small muted">A name when a player asks “what's your name?”.</span>}
      <button type="button" className="btn small" disabled={act.busy} onClick={() => void more()}><i className="fa-solid fa-shuffle" aria-hidden="true" /> {names.length ? 'More names' : 'Give me names'}</button>
      <ErrorBox error={act.error} />
    </TableCard>
  );
}

// ---- Coming up: world events and game nights, further ahead ----

const AHEAD = [7, 30, 90, 365];

type Unit = 'days' | 'weeks' | 'months' | 'none';
const UNITS: [Unit, string][] = [['days', 'Days'], ['weeks', 'Weeks'], ['months', 'Months'], ['none', 'No date']];
type Ymd = { year: number; month: number; day: number };
type Cal = { months: { name: string; days: number }[] };

/** The in-world date n months after this one, in the world's calendar (the day is kept, or the month's last day). */
function addMonths(cal: Cal, d: Ymd, n: number): Ymd {
  const len = cal.months.length;
  const idx = d.month - 1 + n;
  const year = d.year + Math.floor(idx / len);
  const month = (((idx % len) + len) % len) + 1;
  return { year, month, day: Math.min(d.day, cal.months[month - 1].days) };
}
/** The in-world date n days after this one. */
function addDays(cal: Cal, d: Ymd, n: number): Ymd {
  let { year, month, day } = d;
  day += n;
  while (day > cal.months[month - 1].days) { day -= cal.months[month - 1].days; month++; if (month > cal.months.length) { month = 1; year++; } }
  return { year, month, day };
}

/** A month of the world's calendar to pick a day from. */
function MiniMonth({ cal, value, today, onPick }: { cal: Cal; value: Ymd; today: Ymd; onPick: (d: Ymd) => void }) {
  const [view, setView] = useState({ year: value.year, month: value.month });
  const m = cal.months[view.month - 1];
  const step = (by: number) => { const x = addMonths(cal, { ...view, day: 1 }, by); setView({ year: x.year, month: x.month }); };
  const same = (a: Ymd, d: number) => a.year === view.year && a.month === view.month && a.day === d;
  const past = (d: number) => view.year < today.year || (view.year === today.year && (view.month < today.month || (view.month === today.month && d < today.day)));
  return (
    <div className="tb-mini" data-testid="tb-mini-month">
      <div className="row between">
        <button type="button" className="icon-btn" aria-label="Month before" onClick={() => step(-1)}><i className="fa-solid fa-chevron-left" aria-hidden="true" /></button>
        <b className="small">{m.name} {view.year}</b>
        <button type="button" className="icon-btn" aria-label="Month after" onClick={() => step(1)}><i className="fa-solid fa-chevron-right" aria-hidden="true" /></button>
      </div>
      <div className="tb-mini-days">
        {Array.from({ length: m.days }, (_, i) => i + 1).map((d) => (
          <button key={d} type="button" disabled={past(d)} aria-label={`${d} ${m.name} ${view.year}`} aria-pressed={same(value, d)}
            className={`${same(value, d) ? 'on' : ''}${same(today, d) ? ' today' : ''}`} onClick={() => onPick({ ...view, day: d })}>{d}</button>
        ))}
      </div>
    </div>
  );
}

export function ComingUpBlock() {
  const { w, info } = useWorld();
  const key = `alx.gm.table.ahead.${info.id}`;
  const [days, setDays] = useState<number>(() => lsGet<number>(key, 30));
  const up = useLoad<any>(() => w.call('GET', `/clock/upcoming?days=${days}`), [w, days], ['clock', 'world-event']);
  const someday = useLoad<any[]>(() => w.call<any[]>('GET', '/clock/someday').catch(() => []), [w], ['clock-someday']);
  const cal = useLoad(() => w.calendar(), [w], ['calendar', 'rsvp', 'reschedule']);
  const clk = useLoad<any>(() => w.call('GET', '/clock'), [w], ['clock']);
  const act = useAction();
  const [title, setTitle] = useState('');
  const [unit, setUnit] = useState<Unit>('days');
  const [n, setN] = useState('1');
  const [picked, setPicked] = useState<Ymd | null>(null);
  const [picking, setPicking] = useState(false);
  const [dating, setDating] = useState<string | null>(null);
  const nights = (cal.data ?? []).filter((s: any) => s.status === 'scheduled' && s.ends_at >= new Date().toISOString()).slice(0, 3);
  const events: any[] = [...(up.data?.today ?? []), ...(up.data?.upcoming ?? [])];
  const calDef: Cal | null = clk.data?.calendar ?? null;
  const today: Ymd | null = clk.data?.date ? { year: clk.data.date.year, month: clk.data.date.month, day: clk.data.date.day } : null;
  const k = Math.max(0, parseInt(n || '0', 10));
  const target: Ymd | null = picked ?? (calDef && today && unit !== 'none'
    ? unit === 'months' ? addMonths(calDef, today, k) : addDays(calDef, today, unit === 'weeks' ? k * 7 : k) : null);
  const label = (d: Ymd) => `${d.day} ${calDef?.months[d.month - 1]?.name ?? ''} ${d.year}`;
  const add = (e: FormEvent) => act.run(async () => {
    e.preventDefault();
    const t = title.trim();
    if (unit === 'none' && !picked) await w.call('POST', '/clock/someday', { title: t });
    else {
      const body = picked ? { start: { ...picked, hour: clk.data.date.hour, minute: clk.data.date.minute } } : { after: { amount: k, unit } };
      await w.call('POST', '/clock/events', { title: t, ...body, visibility: 'gm', kind: 'custom' });
      if (dating) { await w.call('DELETE', `/clock/someday/${dating}`).catch(() => {}); setDating(null); }
    }
    setTitle(''); setPicked(null); setPicking(false); await Promise.all([up.reload(), someday.reload()]);
  });
  const drop = (id: string) => act.run(async () => { await w.call('DELETE', `/clock/someday/${id}`); await someday.reload(); });
  const dateIt = (s: any) => { setTitle(s.title); setDating(s.id); if (unit === 'none') setUnit('days'); setPicking(true); };
  const range = (
    <span className="tb-seg" role="radiogroup" aria-label="How far ahead">
      {AHEAD.map((x) => <button key={x} type="button" role="radio" aria-checked={days === x} className={days === x ? 'on' : ''} onClick={() => { setDays(x); lsSet(key, x); }}>{x === 365 ? '1y' : `${x}d`}</button>)}
    </span>
  );
  const ahead = (e: any) => e.daysAway < 0 ? 'going on now' : e.daysAway === 0 ? 'today' : e.daysAway === 1 ? 'tomorrow' : e.daysAway < 60 ? `in ${e.daysAway} days` : `in ${Math.round(e.daysAway / 30)} months`;
  return (
    <TableCard id="coming" title="Coming up" icon="fa-calendar-days" link={['clock', 'Clock']} badge={range}>
      <ErrorBox error={up.error ?? act.error} />
      {events.length ? (
        <ul className="tb-list">
          {events.slice(0, 8).map((e, i) => (
            <li key={`${e.id}-${i}`}>
              <b>{e.title}</b> <span className="tiny muted">{ahead(e)} · {e.occursLabel ?? e.startLabel}{e.visibility === 'gm' ? ' · GM only' : ''}</span>
            </li>
          ))}
        </ul>
      ) : up.data && <span className="small muted">Nothing in the world's calendar for the next {days === 365 ? 'year' : `${days} days`}.</span>}
      {(someday.data ?? []).length > 0 && (
        <>
          <span className="tiny faint">No date yet</span>
          <ul className="tb-list" data-testid="tb-someday">
            {(someday.data ?? []).map((s: any) => (
              <li key={s.id} className="tb-someday-row">
                <span className="tb-ellipsis" title={s.title}>{s.title}</span>
                <button type="button" className="icon-btn" onClick={() => dateIt(s)} aria-label={`Give ${s.title} a date`} title="Give it a date"><i className="fa-solid fa-calendar-plus" aria-hidden="true" /></button>
                <button type="button" className="icon-btn" onClick={() => void drop(s.id)} aria-label={`Remove ${s.title}`} title="Remove"><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        </>
      )}
      {nights.length > 0 && (
        <>
          <span className="tiny faint">Game nights</span>
          <ul className="tb-list">{nights.map((s: any) => <li key={s.id} className="small"><b>{s.title}</b> <span className="muted">· {dateLong(s.starts_at)} {timeShort(s.starts_at)} · {when(s.starts_at)}</span></li>)}</ul>
        </>
      )}
      <form className="tb-add-event" onSubmit={(e) => void add(e)} aria-label="Add a world event">
        <input required aria-label="New world event" placeholder="Add an event" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="row">
          <span className="tb-seg" role="radiogroup" aria-label="When">
            {UNITS.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={unit === v && !picked} className={unit === v && !picked ? 'on' : ''} onClick={() => { setUnit(v); setPicked(null); if (v === 'none') setPicking(false); }}>{l}</button>)}
          </span>
          {unit !== 'none' && !picked && <input className="tb-n" aria-label="How many" inputMode="numeric" value={n} onChange={(e) => setN(e.target.value.replace(/[^\d]/g, ''))} />}
        </div>
        <div className="row">
          {target ? (
            <button type="button" className="btn small ghost" aria-expanded={picking} onClick={() => setPicking(!picking)} data-testid="tb-event-date">
              <i className="fa-solid fa-calendar" aria-hidden="true" /> {label(target)}
            </button>
          ) : <span className="tiny muted">Kept for later, with no date</span>}
          <button type="submit" className="btn small primary" disabled={act.busy}>{unit === 'none' && !picked ? 'Keep' : 'Add'}</button>
        </div>
        {picking && target && calDef && today && <MiniMonth key={`${target.year}-${target.month}`} cal={calDef} value={target} today={today} onPick={(d) => { setPicked(d); setPicking(false); }} />}
      </form>
    </TableCard>
  );
}
