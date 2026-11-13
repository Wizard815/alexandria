// "Today in the world": today's events and the next few days'. Each person
// picks 3, 7 or 30 days; the choice is kept on the server.
import { useWorld, useLoad } from '../../lib/world.tsx';
import { ErrorBox, Loading, useAction } from '../../ui/index.tsx';
import { dayWord, type ClockState, type WEvent } from './shared.tsx';

interface Upcoming extends ClockState { days: number; today: WEvent[]; upcoming: WEvent[] }

export default function TodayCard() {
  const { w } = useWorld();
  const act = useAction();
  const u = useLoad<Upcoming>(() => w.call('GET', '/clock/upcoming'), [w], ['clock', 'world-event']);
  const pick = (days: number) => act.run(async () => {
    await w.call('PUT', '/clock/prefs', { upcomingDays: days });
    await u.reload();
  });
  const d = u.data;
  return (
    <section className="card" aria-labelledby="today-world">
      <div className="card-head">
        <h2 id="today-world">Today in the world</h2>
        <div className="tabs" role="radiogroup" aria-label="How far ahead">
          {[3, 7, 30].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={d?.days === n} className={`btn small${d?.days === n ? ' on' : ''}`} disabled={act.busy} onClick={() => void pick(n)}>{n} days</button>
          ))}
        </div>
      </div>
      <ErrorBox error={u.error ?? act.error} />
      {!d ? <Loading /> : (
        <>
          <div>
            <strong>{d.label}</strong>
            <div className="small muted">{[d.date.weekday, d.date.season, ...d.date.moons.map((m) => `${m.name}: ${m.phase}`)].filter(Boolean).join(' · ')}</div>
          </div>
          {d.today.length ? <EventList events={d.today} /> : <p className="small muted">Nothing planned today.</p>}
          <h3 style={{ margin: '4px 0 0', fontSize: 14 }}>Coming up</h3>
          {d.upcoming.length ? <EventList events={d.upcoming} /> : <p className="small muted">Nothing in the next {d.days} days.</p>}
        </>
      )}
    </section>
  );
}

function EventList({ events }: { events: WEvent[] }) {
  return (
    <ul className="stack tight" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {events.map((e, i) => (
        <li key={`${e.id}-${e.occursAt}-${i}`}>
          <strong style={{ fontWeight: 500 }}>{e.title}</strong>{' '}
          <span className="tiny muted">{dayWord(e.daysAway)} · {e.occursLabel}{e.visibility === 'dm' ? ' · DM only' : ''}</span>
          {e.description && <div className="small muted">{e.description}</div>}
        </li>
      ))}
    </ul>
  );
}
