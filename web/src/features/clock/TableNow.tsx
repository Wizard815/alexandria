// The world clock at the top of the GM's Table: the date, the hour and its light, the moons, and one-tap time moves.
import { useState, type FormEvent } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { ErrorBox, useAction } from '../../ui/index.tsx';
import { TableCard } from '../../ui/TableCard.tsx';
import { useClock, type LogEntry } from './shared.tsx';
import { EventList, type Upcoming } from './TodayCard.tsx';

const pad = (n: number) => String(n).padStart(2, '0');
const H12_KEY = 'alx.gm.clock12';
const read12 = () => { try { return localStorage.getItem(H12_KEY) !== '0'; } catch { return true; } };
const hm = (h: number, m: number, h12: boolean) => (h12 ? `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}` : `${pad(h)}:${pad(m)}`);
const lightIcon = (h: number) => (h >= 5 && h < 8 ? 'fa-cloud-sun' : h >= 8 && h < 18 ? 'fa-sun' : h >= 18 && h < 21 ? 'fa-cloud-moon' : 'fa-moon');

const MOVES: [string, { minutes?: number; preset?: string }, string][] = [
  ['+10 min', { minutes: 10 }, 'Ten minutes pass'],
  ['+1 hour', { minutes: 60 }, 'An hour passes'],
  ['Short rest', { preset: 'short-rest' }, ''],
  ['Long rest', { preset: 'long-rest' }, ''],
  ['Next day', { preset: 'next-day' }, ''],
];

export default function TableNow() {
  const { w } = useWorld();
  const c = useClock();
  const log = useLoad<LogEntry[]>(() => w.call('GET', '/clock/log'), [w], ['clock']);
  const act = useAction();
  const d = c.data?.date;
  const last = (log.data ?? []).find((e) => !e.undone && e.undoable);
  const move = (body: { minutes?: number; preset?: string }, reason: string) => act.run(async () => {
    await w.call('POST', '/clock/advance', { ...body, reason: reason || undefined });
    await Promise.all([c.reload(), log.reload()]);
  });
  // Undo reads the log again first: another screen (the phone, a second window) may have moved the clock since this one
  // loaded, and only the newest live move can be undone. If someone else still wins the race, the block just catches up.
  const [h12, setH12] = useState(read12);
  const flip12 = () => { const v = !h12; setH12(v); try { localStorage.setItem(H12_KEY, v ? '1' : '0'); } catch { /* not kept */ } };
  const [setting, setSetting] = useState(false);
  const undo = () => act.run(async () => {
    const fresh = await w.call<LogEntry[]>('GET', '/clock/log');
    const top = fresh.find((e) => !e.undone && e.undoable);
    try {
      if (top) await w.call('POST', `/clock/log/${top.id}/undo`);
    } catch (e: any) {
      if (!/later changes|Already undone/.test(e?.message ?? '')) throw e;
    }
    await Promise.all([c.reload(), log.reload()]);
  });
  if (!d) return <TableCard id="clock" title="The world" icon="fa-moon" link={['clock', 'Clock']}><ErrorBox error={c.error} /></TableCard>;
  return (
    <TableCard id="clock" title="The world" icon={lightIcon(d.hour)} link={['clock', 'Clock']} className="tb-clock">
      <div className="tb-big">
        <b className="tb-date" data-testid="tb-world-date">{d.day} {d.monthName} {d.year}{c.data!.calendar.yearSuffix ? ` ${c.data!.calendar.yearSuffix}` : ''}</b>
        <div className="row tb-hour-row">
          <button type="button" className="tb-hour" onClick={flip12} title={h12 ? 'Show the 24-hour clock' : 'Show AM and PM'} aria-label={`${hm(d.hour, d.minute, h12)}. Switch to the ${h12 ? '24-hour clock' : '12-hour clock'}`} data-testid="tb-hour">{hm(d.hour, d.minute, h12)}</button>
          <span className="muted">{d.timeOfDay}</span>
        </div>
        <div className="small muted">{[d.weekday, d.season].filter(Boolean).join(' · ')}</div>
        {d.moons.length > 0 && <div className="tiny faint">{d.moons.map((m) => `${m.name}: ${m.phase}`).join(' · ')}</div>}
      </div>
      <div className="row tb-moves" role="group" aria-label="Move the world clock">
        {MOVES.map(([label, body, reason]) => <button key={label} type="button" className="btn small" disabled={act.busy} onClick={() => void move(body, reason)}>{label}</button>)}
        <button type="button" className={`btn small${setting ? ' on' : ''}`} aria-expanded={setting} onClick={() => setSetting(!setting)} data-testid="tb-set-time"><i className="fa-solid fa-clock" aria-hidden="true" /> Set time</button>
        {last && <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void undo()} title={`Undo: ${last.reason || last.kind} (${last.beforeLabel} → ${last.afterLabel})`}><i className="fa-solid fa-rotate-left" aria-hidden="true" /> Undo</button>}
      </div>
      {setting && <SetTime hour={d.hour} minute={d.minute} h12={h12} onSet={(hour, minute) => act.run(async () => {
        await w.call('POST', '/clock/set', { year: d.year, month: d.month, day: d.day, hour, minute, reason: `Time set to ${hm(hour, minute, h12)}` });
        setSetting(false);
        await Promise.all([c.reload(), log.reload()]);
      })} busy={act.busy} />}
      <ErrorBox error={act.error} />
    </TableCard>
  );
}

/** Set the hour and minute of today (the date stays): AM and PM on the 12-hour clock, or 0 to 23. */
function SetTime({ hour, minute, h12, onSet, busy }: { hour: number; minute: number; h12: boolean; onSet: (h: number, m: number) => void; busy: boolean }) {
  const [h, setH] = useState(String(h12 ? ((hour + 11) % 12) + 1 : hour));
  const [m, setM] = useState(pad(minute));
  const [pm, setPm] = useState(hour >= 12);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    let hh = Math.max(0, Math.min(h12 ? 12 : 23, parseInt(h || '0', 10)));
    if (h12) hh = (hh % 12) + (pm ? 12 : 0);
    onSet(hh, Math.max(0, Math.min(59, parseInt(m || '0', 10))));
  };
  return (
    <form className="row tb-settime" onSubmit={submit} aria-label="Set the time of day">
      <input aria-label="Hour" inputMode="numeric" value={h} onChange={(e) => setH(e.target.value.replace(/[^\d]/g, '').slice(0, 2))} style={{ width: 52 }} />
      <span>:</span>
      <input aria-label="Minute" inputMode="numeric" value={m} onChange={(e) => setM(e.target.value.replace(/[^\d]/g, '').slice(0, 2))} style={{ width: 52 }} />
      {h12 && (
        <span className="tb-seg" role="radiogroup" aria-label="AM or PM">
          <button type="button" role="radio" aria-checked={!pm} className={!pm ? 'on' : ''} onClick={() => setPm(false)}>AM</button>
          <button type="button" role="radio" aria-checked={pm} className={pm ? 'on' : ''} onClick={() => setPm(true)}>PM</button>
        </span>
      )}
      <button type="submit" className="btn small primary" disabled={busy} data-testid="tb-set-time-go">Set</button>
      <span className="tiny faint">Same day; it goes in the clock log and can be undone.</span>
    </form>
  );
}

/** Today's world events and the next few days', for the Table's side column (the date itself is in TableNow). */
export function TableToday() {
  const { w } = useWorld();
  const act = useAction();
  const u = useLoad<Upcoming>(() => w.call('GET', '/clock/upcoming'), [w], ['clock', 'world-event']);
  const d = u.data;
  if (!d) return null;
  const pick = (days: number) => act.run(async () => { await w.call('PUT', '/clock/prefs', { upcomingDays: days }); await u.reload(); });
  const range = (
    <span className="tb-seg" role="radiogroup" aria-label="How far ahead">
      {[3, 7, 30].map((n) => <button key={n} type="button" role="radio" aria-checked={d.days === n} className={d.days === n ? 'on' : ''} disabled={act.busy} onClick={() => void pick(n)}>{n}d</button>)}
    </span>
  );
  if (!d.today.length && !d.upcoming.length) return <TableCard id="today" title="World events" icon="fa-calendar-day" link={['clock', 'Add one']} quiet={<>Nothing in the next {d.days} days. {range}</>} />;
  return (
    <TableCard id="today" title="World events" icon="fa-calendar-day" link={['clock', 'Clock']} badge={range}>
      <ErrorBox error={u.error ?? act.error} />
      {d.today.length > 0 && <><span className="tiny faint">Today</span><EventList events={d.today} /></>}
      {d.upcoming.length > 0 && <><span className="tiny faint">Next {d.days} days</span><EventList events={d.upcoming} /></>}
    </TableCard>
  );
}
