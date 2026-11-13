// DM page: move the world clock, see and undo changes, manage events and edit the calendar.
import { useEffect, useState, type FormEvent } from 'react';
import { PageHead, ErrorBox, Empty, Loading, Field, Tabs, VisibilityPicker, useAction } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { KINDS, useClock, type Calendar, type ClockState, type LogEntry, type WEvent } from './shared.tsx';

export default function ClockPage() {
  const clock = useClock();
  const [tab, setTab] = useState<'now' | 'events' | 'calendar'>('now');
  return (
    <div className="page wide">
      <PageHead title="World clock" lead={clock.data ? `${clock.data.label} · ${clock.data.calendar.name}` : 'The in-world date and time.'} />
      <ErrorBox error={clock.error} />
      <Tabs label="World clock section" value={tab} onChange={setTab} items={[['now', 'Date and log'], ['events', 'Events'], ['calendar', 'Calendar']]} />
      {!clock.data ? <Loading /> : tab === 'now' ? <Now c={clock.data} reload={clock.reload} /> : tab === 'events' ? <Events c={clock.data} /> : <CalendarEditor c={clock.data} reload={clock.reload} />}
    </div>
  );
}

// ---- Date and log ----

function Now({ c, reload }: { c: ClockState; reload: () => Promise<void> }) {
  const { w } = useWorld();
  const act = useAction();
  const log = useLoad<LogEntry[]>(() => w.call('GET', '/clock/log'), [w], ['clock']);
  const [reason, setReason] = useState('');
  const [d, setD] = useState({ year: c.date.year, month: c.date.month, day: c.date.day, hour: c.date.hour, minute: c.date.minute });
  useEffect(() => setD({ year: c.date.year, month: c.date.month, day: c.date.day, hour: c.date.hour, minute: c.date.minute }), [c.minutes]); // eslint-disable-line react-hooks/exhaustive-deps
  const preset = (p: string) => act.run(async () => { await w.call('POST', '/clock/advance', { preset: p, reason: reason || undefined }); setReason(''); await reload(); });
  const num = (k: keyof typeof d) => (e: { target: { value: string } }) => setD({ ...d, [k]: Number(e.target.value) });
  const set = (e: FormEvent) => act.run(async () => { e.preventDefault(); await w.call('POST', '/clock/set', { ...d, reason: reason || 'Date set' }); setReason(''); await reload(); });
  const undo = (id: string) => act.run(async () => { await w.call('POST', `/clock/log/${id}/undo`); await reload(); });
  return (
    <div className="cols">
      <section className="col-1 stack" style={{ maxWidth: 480 }}>
        <div className="card">
          <h2 style={{ margin: 0 }}>{c.label}</h2>
          <div className="small muted">{[c.date.weekday, c.date.season, ...c.date.moons.map((m) => `${m.name}: ${m.phase}`)].filter(Boolean).join(' · ')}</div>
          <Field label="Why (optional, goes in the log)"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Camped at the ford" maxLength={200} /></Field>
          <div className="row">
            <button className="btn" disabled={act.busy} onClick={() => void preset('short-rest')}>Short rest</button>
            <button className="btn" disabled={act.busy} onClick={() => void preset('long-rest')}>Long rest</button>
            <button className="btn" disabled={act.busy} onClick={() => void preset('next-day')}>Next day</button>
          </div>
          <p className="tiny muted">Short rest: +1 hour. Long rest: {c.longRestMode === '8h' ? '+8 hours' : 'to 07:00'}. Next day: to 07:00 tomorrow.</p>
        </div>
        <form className="card" onSubmit={set}>
          <h3 style={{ margin: 0 }}>Set date</h3>
          <div className="row">
            <Field label="Year"><input type="number" value={d.year} onChange={num('year')} style={{ width: 90 }} /></Field>
            <Field label="Month">
              <select value={d.month} onChange={num('month')}>{c.calendar.months.map((m, i) => <option key={i} value={i + 1}>{m.name}</option>)}</select>
            </Field>
            <Field label="Day"><input type="number" min={1} max={c.calendar.months[d.month - 1]?.days ?? 31} value={d.day} onChange={num('day')} style={{ width: 70 }} /></Field>
            <Field label="Hour"><input type="number" min={0} max={23} value={d.hour} onChange={num('hour')} style={{ width: 70 }} /></Field>
            <Field label="Min"><input type="number" min={0} max={59} value={d.minute} onChange={num('minute')} style={{ width: 70 }} /></Field>
          </div>
          <button className="btn primary" type="submit" disabled={act.busy}>Set date</button>
        </form>
        <ErrorBox error={act.error} />
      </section>
      <section className="col-2 stack">
        <h2>Log</h2>
        <ErrorBox error={log.error} />
        {log.loading ? <Loading /> : log.data?.length ? (
          <div className="card flush">
            {log.data.map((e) => (
              <div key={e.id} className="row between" style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)', opacity: e.undone ? 0.55 : 1 }}>
                <div style={{ flex: '1 1 240px' }}>
                  <div><strong style={{ fontWeight: 500, textDecoration: e.undone ? 'line-through' : undefined }}>{e.reason || e.kind}</strong></div>
                  <div className="tiny muted">{e.beforeLabel} → {e.afterLabel}</div>
                  <div className="tiny faint">{e.accountName ?? 'Someone'} · {new Date(e.at).toLocaleString()}</div>
                </div>
                {e.undoable && <button className="btn small" disabled={act.busy} onClick={() => void undo(e.id)}>Undo</button>}
              </div>
            ))}
          </div>
        ) : <div className="card"><Empty>No changes yet.</Empty></div>}
      </section>
    </div>
  );
}

// ---- Events ----

interface Draft {
  id?: string; title: string; description: string; year: number; month: number; day: number; hour: number; minute: number;
  lasts: string; unit: 'hours' | 'days'; visibility: 'dm' | 'party'; repeat: boolean; kind: string;
}

function draftFrom(c: ClockState, e?: WEvent): Draft {
  const s = e?.startDate ?? c.date;
  const dur = e?.end != null ? e.end - e.start : 0;
  const days = dur > 0 && dur % 1440 === 0;
  return {
    id: e?.id, title: e?.title ?? '', description: e?.description ?? '', year: s.year, month: s.month, day: s.day, hour: e ? s.hour : 0, minute: e ? s.minute : 0,
    lasts: dur > 0 ? String(days ? dur / 1440 : dur / 60) : '', unit: days || dur === 0 ? 'days' : 'hours',
    visibility: e?.visibility ?? 'dm', repeat: e?.repeat === 'yearly', kind: e?.kind ?? 'custom',
  };
}

function Events({ c }: { c: ClockState }) {
  const { w } = useWorld();
  const act = useAction();
  const list = useLoad<WEvent[]>(() => w.call('GET', '/clock/events', undefined, { from: String(c.minutes - 365 * 1440), to: String(c.minutes + 5 * 365 * 1440) }), [w, c.minutes], ['world-event']);
  const [draft, setDraft] = useState<Draft | null>(null);
  const save = (e: FormEvent) => act.run(async () => {
    e.preventDefault();
    if (!draft) return;
    const mult = draft.unit === 'days' ? 1440 : 60;
    const body: Record<string, unknown> = {
      title: draft.title, description: draft.description, start: { year: draft.year, month: draft.month, day: draft.day, hour: draft.hour, minute: draft.minute },
      visibility: draft.visibility, repeat: draft.repeat ? 'yearly' : null, kind: draft.kind,
      durationMinutes: draft.lasts.trim() ? Math.round(Number(draft.lasts) * mult) : null,
    };
    if (draft.id) await w.call('PATCH', `/clock/events/${draft.id}`, body);
    else await w.call('POST', '/clock/events', body);
    setDraft(null);
    await list.reload();
  });
  const remove = (id: string) => act.run(async () => { await w.call('DELETE', `/clock/events/${id}`); if (draft?.id === id) setDraft(null); await list.reload(); });
  const seen = new Set<string>();
  const events = (list.data ?? []).filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  return (
    <div className="cols">
      <section className="col-1 stack" style={{ maxWidth: 480 }}>
        {draft ? (
          <form className="card" onSubmit={save} aria-label="Event">
            <h3 style={{ margin: 0 }}>{draft.id ? 'Edit event' : 'New event'}</h3>
            <Field label="Title"><input value={draft.title} onChange={(e) => set('title', e.target.value)} maxLength={200} required /></Field>
            <Field label="Details"><textarea value={draft.description} onChange={(e) => set('description', e.target.value)} rows={3} /></Field>
            <div className="row">
              <Field label="Year"><input type="number" value={draft.year} onChange={(e) => set('year', Number(e.target.value))} style={{ width: 90 }} /></Field>
              <Field label="Month"><select value={draft.month} onChange={(e) => set('month', Number(e.target.value))}>{c.calendar.months.map((m, i) => <option key={i} value={i + 1}>{m.name}</option>)}</select></Field>
              <Field label="Day"><input type="number" min={1} value={draft.day} onChange={(e) => set('day', Number(e.target.value))} style={{ width: 70 }} /></Field>
              <Field label="Hour"><input type="number" min={0} max={23} value={draft.hour} onChange={(e) => set('hour', Number(e.target.value))} style={{ width: 70 }} /></Field>
            </div>
            <div className="row">
              <Field label="Lasts (blank: a moment)"><input type="number" min={0} step="any" value={draft.lasts} onChange={(e) => set('lasts', e.target.value)} style={{ width: 110 }} /></Field>
              <Field label="Unit"><select value={draft.unit} onChange={(e) => set('unit', e.target.value as 'hours' | 'days')}><option value="hours">hours</option><option value="days">days</option></select></Field>
              <Field label="Kind"><select value={draft.kind} onChange={(e) => set('kind', e.target.value)}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></Field>
            </div>
            <label className="row"><input type="checkbox" checked={draft.repeat} onChange={(e) => set('repeat', e.target.checked)} /> Repeats every year</label>
            <Field label="Who sees it"><VisibilityPicker value={draft.visibility} onChange={(v) => set('visibility', v)} labels={{ dm: 'Only me', party: 'The party' }} /></Field>
            <div className="row"><button className="btn primary" type="submit" disabled={act.busy}>Save</button><button className="btn" type="button" onClick={() => setDraft(null)}>Cancel</button></div>
          </form>
        ) : <button className="btn primary" onClick={() => setDraft(draftFrom(c))}>Add an event</button>}
        <ErrorBox error={act.error} />
      </section>
      <section className="col-2 stack">
        <h2>Events</h2>
        <ErrorBox error={list.error} />
        {list.loading ? <Loading /> : events.length ? (
          <div className="card flush">
            {events.map((e) => (
              <div key={e.id} className="row between" style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
                <div style={{ flex: '1 1 240px' }}>
                  <strong style={{ fontWeight: 500 }}>{e.title}</strong> <span className="chip">{e.kind}</span> <span className="chip">{e.visibility === 'party' ? 'party' : 'DM only'}</span>{e.repeat && <span className="chip">yearly</span>}
                  <div className="tiny muted">{e.startLabel}</div>
                  {e.description && <div className="small muted">{e.description}</div>}
                </div>
                <div className="row"><button className="btn small" onClick={() => setDraft(draftFrom(c, e))}>Edit</button><button className="btn small danger" disabled={act.busy} onClick={() => void remove(e.id)}>Delete</button></div>
              </div>
            ))}
          </div>
        ) : <div className="card"><Empty>No events yet.</Empty></div>}
      </section>
    </div>
  );
}

// ---- Calendar ----

function CalendarEditor({ c, reload }: { c: ClockState; reload: () => Promise<void> }) {
  const { w } = useWorld();
  const act = useAction();
  const [cal, setCal] = useState<Calendar>(c.calendar);
  const [weekdays, setWeekdays] = useState(c.calendar.weekdays.join(', '));
  useEffect(() => { setCal(c.calendar); setWeekdays(c.calendar.weekdays.join(', ')); }, [c.calendar]);
  const put = (body: unknown) => act.run(async () => { await w.call('PUT', '/clock/calendar', body); await reload(); });
  const months = (fn: (m: Calendar['months']) => Calendar['months']) => setCal({ ...cal, months: fn([...cal.months]) });
  const moons = cal.moons ?? [];
  const save = (e: FormEvent) => { e.preventDefault(); void put({ definition: { ...cal, weekdays: weekdays.split(',').map((s) => s.trim()).filter(Boolean) } }); };
  return (
    <div className="stack">
      <section className="card">
        <h3 style={{ margin: 0 }}>Start from</h3>
        <p className="small muted">Changing the calendar keeps today's date where it fits, and moves events with it. The change is in the log and can be undone.</p>
        <div className="row">
          {(c.builtins ?? []).map((b) => <button key={b.key} className="btn" disabled={act.busy} onClick={() => void put({ builtin: b.key })}>{b.name}</button>)}
        </div>
        {(c.sources ?? []).length > 0 && (
          <>
            <h4 style={{ margin: '8px 0 0' }}>A calendar from a source</h4>
            <div className="stack tight">
              {c.sources!.map((s) => (
                <div key={s.sourceId + s.externalId} className="row">
                  <span>{s.name}</span>
                  <button className="btn small" disabled={act.busy || !s.usable} onClick={() => void put({ source: { sourceId: s.sourceId, externalId: s.externalId } })}>Use it</button>
                  {s.current && <button className="btn small" disabled={act.busy || !s.usable} onClick={() => void put({ source: { sourceId: s.sourceId, externalId: s.externalId }, applyCurrent: true })}>Use it and its date</button>}
                </div>
              ))}
            </div>
          </>
        )}
      </section>
      <form className="card" onSubmit={save}>
        <h3 style={{ margin: 0 }}>Edit this calendar</h3>
        <div className="row">
          <Field label="Name"><input value={cal.name} onChange={(e) => setCal({ ...cal, name: e.target.value })} /></Field>
          <Field label="Year of the epoch" help="The year that minute 0 falls in."><input type="number" value={cal.epochYear} onChange={(e) => setCal({ ...cal, epochYear: Number(e.target.value) })} style={{ width: 110 }} /></Field>
          <Field label="Year suffix"><input value={cal.yearSuffix ?? ''} onChange={(e) => setCal({ ...cal, yearSuffix: e.target.value })} style={{ width: 90 }} /></Field>
        </div>
        <h4 style={{ margin: 0 }}>Months</h4>
        {cal.months.map((m, i) => (
          <div key={i} className="row">
            <input aria-label={`Month ${i + 1} name`} value={m.name} onChange={(e) => months((a) => { a[i] = { ...m, name: e.target.value }; return a; })} style={{ width: 160 }} />
            <input aria-label={`Month ${i + 1} days`} type="number" min={1} value={m.days} onChange={(e) => months((a) => { a[i] = { ...m, days: Number(e.target.value) }; return a; })} style={{ width: 80 }} />
            <label className="row tiny"><input type="checkbox" checked={!!m.intercalary} onChange={(e) => months((a) => { a[i] = { name: m.name, days: m.days, ...(e.target.checked ? { intercalary: true } : {}) }; return a; })} /> festival days (no weekday)</label>
            <button type="button" className="btn small" aria-label={`Move month ${i + 1} up`} disabled={i === 0} onClick={() => months((a) => { [a[i - 1], a[i]] = [a[i], a[i - 1]]; return a; })}>↑</button>
            <button type="button" className="btn small danger" aria-label={`Remove month ${i + 1}`} disabled={cal.months.length < 2} onClick={() => months((a) => a.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <div><button type="button" className="btn small" onClick={() => months((a) => [...a, { name: `Month ${a.length + 1}`, days: 30 }])}>Add a month</button></div>
        <Field label="Weekdays" help="Separate with commas, in order."><input value={weekdays} onChange={(e) => setWeekdays(e.target.value)} /></Field>
        <h4 style={{ margin: 0 }}>Moons</h4>
        {moons.map((m, i) => (
          <div key={i} className="row">
            <input aria-label={`Moon ${i + 1} name`} value={m.name} onChange={(e) => setCal({ ...cal, moons: moons.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} style={{ width: 160 }} />
            <label className="row tiny">cycle (days) <input type="number" min={1} step="any" value={m.cycleDays} onChange={(e) => setCal({ ...cal, moons: moons.map((x, j) => (j === i ? { ...x, cycleDays: Number(e.target.value) } : x)) })} style={{ width: 80 }} /></label>
            <label className="row tiny">offset (days) <input type="number" step="any" value={m.offsetDays} onChange={(e) => setCal({ ...cal, moons: moons.map((x, j) => (j === i ? { ...x, offsetDays: Number(e.target.value) } : x)) })} style={{ width: 80 }} /></label>
            <button type="button" className="btn small danger" onClick={() => setCal({ ...cal, moons: moons.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        ))}
        <div><button type="button" className="btn small" onClick={() => setCal({ ...cal, moons: [...moons, { name: 'Moon', cycleDays: 28, offsetDays: 0 }] })}>Add a moon</button></div>
        <ErrorBox error={act.error} />
        <div><button className="btn primary" type="submit" disabled={act.busy}>Save calendar</button></div>
      </form>
    </div>
  );
}
