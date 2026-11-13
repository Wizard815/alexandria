// The world clock: the in-world date and time, the calendar it runs on,
// events on that calendar, and a log of every change. See api.ts for the
// module other features import.
import { Router } from 'express';
import type { Feature } from '../types.ts';
import { requireDM } from '../../core/auth.ts';
import { featureSetting } from '../../core/policy.ts';
import { HttpError } from '../../core/util.ts';
import { ctx, isDM, me, settings } from '../../routes/_shared.ts';
import * as clock from './api.ts';
import { BUILTIN_CALENDARS, MINUTES_PER_DAY, dateToMinutes, normalizeCalendar } from './calendar.ts';

const enc = encodeURIComponent;
const S = (description: string) => ({ type: 'string', description });
const N = (description: string) => ({ type: 'integer', description });
const DATE = { type: 'object', description: 'In-world date: { year, month (1-based), day, hour?, minute? }', properties: { year: { type: 'integer' }, month: { type: 'integer' }, day: { type: 'integer' }, hour: { type: 'integer' }, minute: { type: 'integer' } }, required: ['year', 'month', 'day'] };
const role = (res: any) => ctx(res).viewer.role as clock.Role;

/** Minutes, or "year-month-day" in the world's calendar (start of that day). */
function queryWhen(v: unknown, def: ReturnType<typeof clock.getCalendar>['definition'], field: string): number | null {
  if (v === undefined || v === '') return null;
  const s = String(v);
  if (/^-?\d+$/.test(s)) return Number(s);
  const m = /^(-?\d+)-(\d+)-(\d+)$/.exec(s);
  if (m) {
    try { return dateToMinutes(def, { year: +m[1], month: +m[2], day: +m[3] }); } catch (e: any) { throw new HttpError(400, `${field}: ${e.message}`); }
  }
  throw new HttpError(400, `${field} must be minutes or year-month-day`);
}

const feature: Feature = {
  id: 'clock',
  schema: `
    CREATE TABLE IF NOT EXISTS clock_worlds (
      world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
      calendar TEXT NOT NULL,
      calendar_source TEXT NOT NULL DEFAULT 'builtin:harptos',
      minutes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clock_log (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      account_id TEXT,
      kind TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      before_minutes INTEGER NOT NULL,
      after_minutes INTEGER NOT NULL,
      before_label TEXT NOT NULL DEFAULT '',
      after_label TEXT NOT NULL DEFAULT '',
      calendar_before TEXT,
      event_shift INTEGER NOT NULL DEFAULT 0,
      undone INTEGER NOT NULL DEFAULT 0,
      undoes TEXT
    );
    CREATE INDEX IF NOT EXISTS clock_log_world ON clock_log(world_id);
    CREATE TABLE IF NOT EXISTS clock_events (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      start_minutes INTEGER NOT NULL,
      end_minutes INTEGER,
      visibility TEXT NOT NULL DEFAULT 'dm' CHECK (visibility IN ('dm', 'party')),
      repeat_rule TEXT,
      kind TEXT NOT NULL DEFAULT 'custom',
      created_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS clock_events_world ON clock_events(world_id, start_minutes);
    CREATE TABLE IF NOT EXISTS clock_prefs (
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      upcoming_days INTEGER NOT NULL DEFAULT 7,
      PRIMARY KEY (world_id, account_id)
    );
  `,
  settings: { longRestMode: { type: 'enum', values: ['8h', 'morning'], default: 'morning' } },
  worldMount: 'clock',
  worldRoutes: (d) => {
    const r = Router();
    const { db, hub } = d;
    const wid = (res: any) => ctx(res).world.id as string;
    const snapshot = (res: any) => {
      const cal = clock.getCalendar(db, wid(res));
      return { ...clock.getClock(db, wid(res)), calendar: cal.definition, calendarSource: cal.source };
    };

    r.get('/', (_req, res) => {
      const out: any = snapshot(res);
      if (isDM(res)) {
        out.longRestMode = featureSetting(settings(res), 'longRestMode');
        out.builtins = Object.entries(BUILTIN_CALENDARS).map(([key, def]) => ({ key, name: def.name }));
        out.sources = clock.sourceCalendars(db, wid(res)).map((s) => ({ sourceId: s.sourceId, externalId: s.externalId, name: s.name, usable: !!s.definition, current: s.current }));
      }
      res.json(out);
    });

    r.put('/calendar', requireDM, (req, res) => {
      const b = req.body ?? {};
      let def; let source: string; let current: { year: number; month: number; day: number } | null = null;
      try {
        if (typeof b.builtin === 'string') {
          def = BUILTIN_CALENDARS[b.builtin];
          if (!def) throw new HttpError(400, `builtin must be one of: ${Object.keys(BUILTIN_CALENDARS).join(', ')}`);
          source = `builtin:${b.builtin}`;
        } else if (b.source && typeof b.source === 'object') {
          const s = clock.sourceCalendars(db, wid(res)).find((x) => x.sourceId === b.source.sourceId && x.externalId === b.source.externalId);
          if (!s) throw new HttpError(404, 'That source calendar was not found');
          if (!s.definition) throw new HttpError(400, 'That source calendar cannot be used as it is');
          def = s.definition;
          source = `source:${s.sourceId}:${s.externalId}`;
          if (b.applyCurrent && s.current) current = s.current;
        } else {
          def = normalizeCalendar(b.definition);
          source = 'custom';
        }
      } catch (e: any) {
        if (e instanceof RangeError) throw new HttpError(400, e.message);
        throw e;
      }
      const result = clock.setCalendar(db, hub, wid(res), def, source, typeof b.reason === 'string' ? b.reason : '', me(res), current);
      res.json({ ...snapshot(res), entry: result.entry });
    });

    r.post('/advance', requireDM, (req, res) => {
      const b = req.body ?? {};
      const reason = typeof b.reason === 'string' ? b.reason : '';
      let entry;
      if (b.preset !== undefined) {
        if (!['short-rest', 'long-rest', 'next-day'].includes(b.preset)) throw new HttpError(400, 'preset must be short-rest, long-rest or next-day');
        entry = clock.advancePreset(db, hub, wid(res), b.preset, featureSetting<clock.LongRestMode>(settings(res), 'longRestMode'), reason, me(res));
      } else {
        entry = clock.advance(db, hub, wid(res), b.minutes, reason, me(res));
      }
      res.json({ ...snapshot(res), entry });
    });

    r.post('/set', requireDM, (req, res) => {
      const b = req.body ?? {};
      const date = b.date ?? b;
      const entry = clock.setDate(db, hub, wid(res), { year: date.year, month: date.month, day: date.day, hour: date.hour, minute: date.minute }, typeof b.reason === 'string' ? b.reason : '', me(res));
      res.json({ ...snapshot(res), entry });
    });

    r.get('/log', requireDM, (req, res) => res.json(clock.listLog(db, wid(res), Number(req.query.limit) || 100)));
    r.post('/log/:id/undo', requireDM, (req, res) => {
      const entry = clock.undo(db, hub, wid(res), String(req.params.id), me(res));
      res.json({ ...snapshot(res), entry });
    });

    r.get('/events', (req, res) => {
      const def = clock.getCalendar(db, wid(res)).definition;
      const nowMin = clock.getClock(db, wid(res)).minutes;
      const from = queryWhen(req.query.from, def, 'from') ?? Math.floor(nowMin / MINUTES_PER_DAY) * MINUTES_PER_DAY;
      const to = queryWhen(req.query.to, def, 'to') ?? from + 30 * MINUTES_PER_DAY;
      res.json(clock.listEvents(db, wid(res), role(res), from, to));
    });
    r.get('/events/:id', (req, res) => res.json(clock.getEvent(db, wid(res), String(req.params.id), role(res))));
    r.post('/events', requireDM, (req, res) => res.status(201).json(clock.addEvent(db, hub, wid(res), req.body ?? {}, me(res))));
    r.patch('/events/:id', requireDM, (req, res) => res.json(clock.updateEvent(db, hub, wid(res), String(req.params.id), req.body ?? {})));
    r.delete('/events/:id', requireDM, (req, res) => { clock.deleteEvent(db, hub, wid(res), String(req.params.id)); res.json({ ok: true }); });

    r.get('/prefs', (_req, res) => res.json({ upcomingDays: clock.getUpcomingDays(db, wid(res), me(res)) }));
    r.put('/prefs', (req, res) => res.json({ upcomingDays: clock.setUpcomingDays(db, wid(res), me(res), req.body?.upcomingDays) }));
    r.get('/upcoming', (req, res) => {
      const asked = req.query.days === undefined ? clock.getUpcomingDays(db, wid(res), me(res)) : Number(req.query.days);
      if (!Number.isInteger(asked) || asked < 1 || asked > 366) throw new HttpError(400, 'days must be a whole number from 1 to 366');
      res.json(clock.upcoming(db, wid(res), role(res), asked));
    });
    return r;
  },
  mcpTools: [
    { name: 'get_world_date', description: "The world's current in-world date and time, weekday, season, moon phases and the calendar in use.", props: {}, call: () => ({ method: 'GET', path: '/clock' }) },
    {
      name: 'list_world_events',
      description: 'In-world events (holidays, deadlines, travel...). Give days for "today and the next N days", or from and to (minutes since the calendar epoch, or year-month-day). Players only ever see party events.',
      props: { days: N('Today and the next N days'), from: S('Start: minutes or year-month-day'), to: S('End: minutes or year-month-day') },
      call: (a) => (a.days ? { method: 'GET', path: `/clock/upcoming?days=${enc(String(a.days))}` } : { method: 'GET', path: `/clock/events?${[a.from && `from=${enc(String(a.from))}`, a.to && `to=${enc(String(a.to))}`].filter(Boolean).join('&')}` }),
    },
    {
      name: 'advance_world_time', write: true,
      description: "Move the world clock forward: give minutes, or a preset ('short-rest' +1 hour, 'long-rest' per the world's setting, 'next-day' to 07:00). Logged with your reason and undoable by the DM.",
      props: { minutes: N('Minutes to move forward'), preset: { type: 'string', enum: ['short-rest', 'long-rest', 'next-day'] }, reason: S('Why, e.g. "Traveled to Saltmarsh"') },
      call: (a) => ({ method: 'POST', path: '/clock/advance', body: { minutes: a.minutes, preset: a.preset, reason: a.reason } }),
    },
    {
      name: 'add_world_event', write: true,
      description: 'Put an event on the world calendar. DM-only unless visibility is party.',
      props: { title: S('Title'), description: S('Details'), start: DATE, end: DATE, durationMinutes: N('Alternative to end'), visibility: { type: 'string', enum: ['dm', 'party'] }, repeat: { type: 'string', enum: ['yearly'] }, kind: { type: 'string', enum: [...clock.EVENT_KINDS] } },
      required: ['title', 'start'],
      call: (a) => ({ method: 'POST', path: '/clock/events', body: a }),
    },
  ],
};
export default feature;
