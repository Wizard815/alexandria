// The world clock at the top of the DM's Table: the date, the hour and its light, the moons, and one-tap time moves.
import { useWorld, useLoad } from '../../lib/world.tsx';
import { ErrorBox, useAction } from '../../ui/index.tsx';
import { TableCard } from '../../ui/TableCard.tsx';
import { useClock, type LogEntry } from './shared.tsx';
import { EventList, type Upcoming } from './TodayCard.tsx';

const pad = (n: number) => String(n).padStart(2, '0');
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
  const undo = () => last && act.run(async () => { await w.call('POST', `/clock/log/${last.id}/undo`); await Promise.all([c.reload(), log.reload()]); });
  if (!d) return <TableCard id="clock" title="The world" icon="fa-moon" link={['clock', 'Clock']}><ErrorBox error={c.error} /></TableCard>;
  return (
    <TableCard id="clock" title="The world" icon={lightIcon(d.hour)} link={['clock', 'Clock']} className="tb-clock">
      <div className="tb-big">
        <b className="tb-date" data-testid="tb-world-date">{d.day} {d.monthName} {d.year}{c.data!.calendar.yearSuffix ? ` ${c.data!.calendar.yearSuffix}` : ''}</b>
        <div><span className="tb-hour">{pad(d.hour)}:{pad(d.minute)}</span> <span className="muted">{d.timeOfDay}</span></div>
        <div className="small muted">{[d.weekday, d.season].filter(Boolean).join(' · ')}</div>
        {d.moons.length > 0 && <div className="tiny faint">{d.moons.map((m) => `${m.name}: ${m.phase}`).join(' · ')}</div>}
      </div>
      <div className="row tb-moves" role="group" aria-label="Move the world clock">
        {MOVES.map(([label, body, reason]) => <button key={label} type="button" className="btn small" disabled={act.busy} onClick={() => void move(body, reason)}>{label}</button>)}
        {last && <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void undo()} title={`Undo: ${last.reason || last.kind} (${last.beforeLabel} → ${last.afterLabel})`}><i className="fa-solid fa-rotate-left" aria-hidden="true" /> Undo</button>}
      </div>
      <ErrorBox error={act.error} />
    </TableCard>
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
