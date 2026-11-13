// The world clock, as a typed module other features import (the broker, the
// session log...). It reads and writes the clock_* tables directly and
// announces changes on the hub. Routes live in index.ts and use only this.
import type { DB } from '../../core/db.ts';
import { one, all, run, tx } from '../../core/db.ts';
import type { EventHub } from '../../core/events.ts';
import { dmOnly, everyone } from '../../core/events.ts';
import { HttpError, id, now, parseJson } from '../../core/util.ts';
import {
  BUILTIN_CALENDARS, MINUTES_PER_DAY, WAKE_HOUR, dateToMinutes, formatDate, formatDay, minutesToDate, nextDayAt, nextHour, normalizeCalendar, remapDate, yearLength,
  type CalendarDef, type DateInput, type DateParts,
} from './calendar.ts';

export { formatDate, formatDay, minutesToDate, dateToMinutes, normalizeCalendar, BUILTIN_CALENDARS };
export type { CalendarDef, DateInput, DateParts };

export type Preset = 'short-rest' | 'long-rest' | 'next-day';
export type LongRestMode = '8h' | 'morning';
export type Role = 'dm' | 'player' | 'guest';
export const EVENT_KINDS = ['holiday', 'deadline', 'travel', 'rest', 'session', 'custom'] as const;
export const UPCOMING_CHOICES = [3, 7, 30] as const;
const MAX_ADVANCE = 365 * 1000 * MINUTES_PER_DAY;

export interface ClockNow {
  minutes: number;
  date: DateParts;
  /** e.g. "3 Frostmoot 1492 DR · evening" */
  label: string;
}
export interface LogEntry {
  id: string; at: string; accountId: string | null; accountName: string | null;
  kind: 'advance' | 'set' | 'calendar' | 'undo'; reason: string;
  beforeMinutes: number; afterMinutes: number; beforeLabel: string; afterLabel: string;
  undone: boolean; undoes: string | null; undoable: boolean;
}
export interface WorldEvent {
  id: string; title: string; description: string; start: number; end: number | null;
  visibility: 'dm' | 'party'; repeat: 'yearly' | null; kind: string; startLabel: string; endLabel: string | null;
  startDate: DateParts; endDate: DateParts | null;
  createdBy: string | null;
}
export interface Occurrence extends WorldEvent { occursAt: number; occursEnd: number | null; occursLabel: string; daysAway: number }

function ensure(db: DB, worldId: string) {
  let row = one<any>(db, 'SELECT * FROM clock_worlds WHERE world_id = ?', worldId);
  if (!row) {
    if (!one(db, 'SELECT 1 FROM worlds WHERE id = ?', worldId)) throw new HttpError(404, 'World not found');
    const def = BUILTIN_CALENDARS.harptos;
    run(db, 'INSERT OR IGNORE INTO clock_worlds (world_id, calendar, calendar_source, minutes, updated_at) VALUES (?, ?, ?, ?, ?)',
      worldId, JSON.stringify(def), 'builtin:harptos', 8 * 60, now());
    row = one<any>(db, 'SELECT * FROM clock_worlds WHERE world_id = ?', worldId);
  }
  return row;
}

export function getCalendar(db: DB, worldId: string): { definition: CalendarDef; source: string } {
  const row = ensure(db, worldId);
  return { definition: parseJson<CalendarDef>(row.calendar, BUILTIN_CALENDARS.harptos), source: row.calendar_source };
}

function nowFrom(def: CalendarDef, minutes: number): ClockNow {
  return { minutes, date: minutesToDate(def, minutes), label: formatDate(def, minutes) };
}

export function getClock(db: DB, worldId: string): ClockNow {
  const row = ensure(db, worldId);
  return nowFrom(parseJson<CalendarDef>(row.calendar, BUILTIN_CALENDARS.harptos), row.minutes);
}

/** Everyone in the world may see the date, so this is sent to all. */
function announce(hub: EventHub | null, worldId: string, clock: ClockNow) {
  hub?.emit(worldId, 'clock', clock, everyone);
}

function entryOut(db: DB, r: any, liveLater: boolean): LogEntry {
  return {
    id: r.id, at: r.at, accountId: r.account_id, accountName: r.account_name ?? null, kind: r.kind, reason: r.reason,
    beforeMinutes: r.before_minutes, afterMinutes: r.after_minutes, beforeLabel: r.before_label, afterLabel: r.after_label,
    undone: !!r.undone, undoes: r.undoes, undoable: !r.undone && r.kind !== 'undo' && !liveLater,
  };
}

function writeLog(db: DB, worldId: string, by: string | null, kind: string, reason: string, before: number, after: number, beforeLabel: string, afterLabel: string, extra: { calendarBefore?: string | null; eventShift?: number; undoes?: string } = {}): string {
  const lid = id('clk_');
  run(db, 'INSERT INTO clock_log (id, world_id, at, account_id, kind, reason, before_minutes, after_minutes, before_label, after_label, calendar_before, event_shift, undoes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    lid, worldId, now(), by, kind, reason.slice(0, 500), before, after, beforeLabel, afterLabel, extra.calendarBefore ?? null, extra.eventShift ?? 0, extra.undoes ?? null);
  return lid;
}

export function getLogEntry(db: DB, worldId: string, logId: string): LogEntry {
  const r = one<any>(db, 'SELECT l.*, a.display_name AS account_name FROM clock_log l LEFT JOIN accounts a ON a.id = l.account_id WHERE l.id = ? AND l.world_id = ?', logId, worldId);
  if (!r) throw new HttpError(404, 'Log entry not found');
  return entryOut(db, r, hasLiveLater(db, worldId, r));
}

function hasLiveLater(db: DB, worldId: string, r: any): boolean {
  return !!one(db, "SELECT 1 FROM clock_log WHERE world_id = ? AND rowid > (SELECT rowid FROM clock_log WHERE id = ?) AND undone = 0 AND kind != 'undo'", worldId, r.id);
}

export function listLog(db: DB, worldId: string, limit = 100): LogEntry[] {
  const rows = all<any>(db, 'SELECT l.*, a.display_name AS account_name FROM clock_log l LEFT JOIN accounts a ON a.id = l.account_id WHERE l.world_id = ? ORDER BY l.rowid DESC LIMIT ?', worldId, Math.min(Math.max(limit, 1), 500));
  // Newest first: an entry is undoable only when nothing live came after it.
  let live = false;
  return rows.map((r) => {
    const e = entryOut(db, r, live);
    if (!r.undone && r.kind !== 'undo') live = true;
    return e;
  });
}

function move(db: DB, hub: EventHub | null, worldId: string, to: number, kind: 'advance' | 'set', reason: string, by: string | null): LogEntry {
  const row = ensure(db, worldId);
  const def = parseJson<CalendarDef>(row.calendar, BUILTIN_CALENDARS.harptos);
  const lid = tx(db, () => {
    run(db, 'UPDATE clock_worlds SET minutes = ?, updated_at = ? WHERE world_id = ?', to, now(), worldId);
    return writeLog(db, worldId, by, kind, reason, row.minutes, to, formatDate(def, row.minutes), formatDate(def, to));
  });
  announce(hub, worldId, nowFrom(def, to));
  return getLogEntry(db, worldId, lid);
}

/** Move the clock forward by a number of minutes. */
export function advance(db: DB, hub: EventHub | null, worldId: string, minutes: number, reason: string, byAccountId: string | null): LogEntry {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_ADVANCE) throw new HttpError(400, 'minutes must be a whole number above zero');
  const cur = ensure(db, worldId).minutes as number;
  return move(db, hub, worldId, cur + minutes, 'advance', reason, byAccountId);
}

/** Jump to a date (forward or back). Hour and minute default to the current time of day. */
export function setDate(db: DB, hub: EventHub | null, worldId: string, date: DateInput, reason: string, byAccountId: string | null): LogEntry {
  const row = ensure(db, worldId);
  const def = parseJson<CalendarDef>(row.calendar, BUILTIN_CALENDARS.harptos);
  const cur = minutesToDate(def, row.minutes);
  let to: number;
  try {
    to = dateToMinutes(def, { ...date, hour: date.hour ?? cur.hour, minute: date.minute ?? (date.hour === undefined ? cur.minute : 0) });
  } catch (e: any) {
    throw new HttpError(400, e.message);
  }
  return move(db, hub, worldId, to, 'set', reason, byAccountId);
}

/** How many minutes a rest or "next day" moves the clock from where it is now. */
export function presetMinutes(preset: Preset, minutes: number, longRestMode: LongRestMode = 'morning'): number {
  switch (preset) {
    case 'short-rest': return 60;
    case 'long-rest': return longRestMode === '8h' ? 8 * 60 : nextHour(minutes, WAKE_HOUR) - minutes;
    case 'next-day': return nextDayAt(minutes, WAKE_HOUR) - minutes;
  }
}
export const PRESET_REASON: Record<Preset, string> = { 'short-rest': 'Short rest', 'long-rest': 'Long rest', 'next-day': 'Next day' };

export function advancePreset(db: DB, hub: EventHub | null, worldId: string, preset: Preset, longRestMode: LongRestMode, reason: string, by: string | null): LogEntry {
  const cur = ensure(db, worldId).minutes as number;
  return advance(db, hub, worldId, presetMinutes(preset, cur, longRestMode), reason || PRESET_REASON[preset], by);
}

/** The game-clock minute at which a wait that starts now is over (for the broker). */
export function addMinutesForWait(db: DB, worldId: string, amount: number, unit: 'minutes' | 'hours' | 'days' = 'minutes'): number {
  const mult = unit === 'days' ? MINUTES_PER_DAY : unit === 'hours' ? 60 : 1;
  return (ensure(db, worldId).minutes as number) + Math.max(0, Math.round(amount * mult));
}

/** Replace the calendar. The current date is kept (clamped to fit) and events move with it. */
export function setCalendar(db: DB, hub: EventHub | null, worldId: string, def: CalendarDef, source: string, reason: string, by: string | null, newDate?: DateInput | null): { clock: ClockNow; entry: LogEntry } {
  const row = ensure(db, worldId);
  const old = parseJson<CalendarDef>(row.calendar, BUILTIN_CALENDARS.harptos);
  let to: number;
  try {
    to = newDate
      ? dateToMinutes(def, { hour: minutesToDate(old, row.minutes).hour, minute: minutesToDate(old, row.minutes).minute, ...newDate })
      : remapDate(old, def, row.minutes);
  } catch (e: any) {
    throw new HttpError(400, e.message);
  }
  const shift = to - row.minutes;
  const lid = tx(db, () => {
    run(db, 'UPDATE clock_worlds SET calendar = ?, calendar_source = ?, minutes = ?, updated_at = ? WHERE world_id = ?', JSON.stringify(def), source, to, now(), worldId);
    if (shift) run(db, 'UPDATE clock_events SET start_minutes = start_minutes + ?, end_minutes = CASE WHEN end_minutes IS NULL THEN NULL ELSE end_minutes + ? END WHERE world_id = ?', shift, shift, worldId);
    return writeLog(db, worldId, by, 'calendar', reason || `Calendar: ${def.name}`, row.minutes, to, formatDate(old, row.minutes), formatDate(def, to), { calendarBefore: row.calendar, eventShift: shift });
  });
  const clock = nowFrom(def, to);
  announce(hub, worldId, clock);
  hub?.emit(worldId, 'world-event', { action: 'reload' }, everyone);
  return { clock, entry: getLogEntry(db, worldId, lid) };
}

/** Undo the newest live change. Older ones must wait until the later ones are undone. */
export function undo(db: DB, hub: EventHub | null, worldId: string, logId: string, byAccountId: string | null): LogEntry {
  const r = one<any>(db, 'SELECT * FROM clock_log WHERE id = ? AND world_id = ?', logId, worldId);
  if (!r) throw new HttpError(404, 'Log entry not found');
  if (r.kind === 'undo') throw new HttpError(400, 'An undo cannot be undone; set the date instead');
  if (r.undone) throw new HttpError(409, 'Already undone');
  if (hasLiveLater(db, worldId, r)) throw new HttpError(409, 'Undo the later changes first');
  const row = ensure(db, worldId);
  const cur = parseJson<CalendarDef>(row.calendar, BUILTIN_CALENDARS.harptos);
  const back = r.calendar_before ? parseJson<CalendarDef>(r.calendar_before, cur) : cur;
  const lid = tx(db, () => {
    if (r.calendar_before) {
      run(db, "UPDATE clock_worlds SET calendar = ?, calendar_source = 'custom' WHERE world_id = ?", r.calendar_before, worldId);
      if (r.event_shift) run(db, 'UPDATE clock_events SET start_minutes = start_minutes - ?, end_minutes = CASE WHEN end_minutes IS NULL THEN NULL ELSE end_minutes - ? END WHERE world_id = ?', r.event_shift, r.event_shift, worldId);
    }
    run(db, 'UPDATE clock_worlds SET minutes = ?, updated_at = ? WHERE world_id = ?', r.before_minutes, now(), worldId);
    run(db, 'UPDATE clock_log SET undone = 1 WHERE id = ?', r.id);
    return writeLog(db, worldId, byAccountId, 'undo', `Undid: ${r.reason || r.kind}`, row.minutes, r.before_minutes, formatDate(cur, row.minutes), formatDate(back, r.before_minutes), { undoes: r.id });
  });
  announce(hub, worldId, nowFrom(back, r.before_minutes));
  if (r.calendar_before) hub?.emit(worldId, 'world-event', { action: 'reload' }, everyone);
  return getLogEntry(db, worldId, lid);
}

// ---- Events ----

const eventOut = (def: CalendarDef, r: any): WorldEvent => ({
  id: r.id, title: r.title, description: r.description, start: r.start_minutes, end: r.end_minutes, visibility: r.visibility,
  repeat: r.repeat_rule ?? null, kind: r.kind, startLabel: formatDate(def, r.start_minutes), endLabel: r.end_minutes === null ? null : formatDate(def, r.end_minutes),
  startDate: minutesToDate(def, r.start_minutes), endDate: r.end_minutes === null ? null : minutesToDate(def, r.end_minutes), createdBy: r.created_by,
});

/** What a viewer may see of an event: players only get party events. */
const canSee = (role: Role, visibility: string) => role === 'dm' || visibility === 'party';

export function getEvent(db: DB, worldId: string, eventId: string, role: Role): WorldEvent {
  const r = one<any>(db, 'SELECT * FROM clock_events WHERE id = ? AND world_id = ?', eventId, worldId);
  // A player gets "not found" for a DM-only event, the same as for one that does not exist.
  if (!r || !canSee(role, r.visibility)) throw new HttpError(404, 'Event not found');
  return eventOut(getCalendar(db, worldId).definition, r);
}

export interface EventInput {
  title?: unknown; description?: unknown; start?: unknown; end?: unknown; visibility?: unknown; repeat?: unknown; kind?: unknown;
  /** Alternative to end: minutes after start. */
  durationMinutes?: unknown;
}

function when(def: CalendarDef, v: unknown, field: string): number {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (v && typeof v === 'object') {
    try { return dateToMinutes(def, v as DateInput); } catch (e: any) { throw new HttpError(400, `${field}: ${e.message}`); }
  }
  throw new HttpError(400, `${field} must be minutes or a date like {year, month, day, hour, minute}`);
}
export const parseWhen = when;

function cleanEvent(def: CalendarDef, body: EventInput, cur: any | null) {
  const out: Record<string, any> = {};
  const has = (k: keyof EventInput) => body[k] !== undefined;
  if (has('title') || !cur) {
    const t = typeof body.title === 'string' ? body.title.trim() : '';
    if (!t) throw new HttpError(400, 'title is required');
    if (t.length > 200) throw new HttpError(400, 'title is longer than 200 characters');
    out.title = t;
  }
  if (has('description')) {
    if (typeof body.description !== 'string' || body.description.length > 5000) throw new HttpError(400, 'description must be text up to 5000 characters');
    out.description = body.description;
  }
  if (has('start') || !cur) out.start_minutes = when(def, body.start, 'start');
  const start = out.start_minutes ?? cur.start_minutes;
  if (has('end')) out.end_minutes = body.end === null ? null : when(def, body.end, 'end');
  else if (has('durationMinutes')) {
    const n = body.durationMinutes;
    if (n === null) out.end_minutes = null;
    else if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > MAX_ADVANCE) throw new HttpError(400, 'durationMinutes must be a whole number');
    else out.end_minutes = start + (n as number);
  }
  const end = 'end_minutes' in out ? out.end_minutes : cur?.end_minutes ?? null;
  if (end !== null && end < start) throw new HttpError(400, 'An event cannot end before it starts');
  if (has('visibility') || !cur) {
    const v = body.visibility ?? 'dm';
    if (v !== 'dm' && v !== 'party') throw new HttpError(400, "visibility must be 'dm' or 'party'");
    out.visibility = v;
  }
  if (has('repeat')) {
    if (body.repeat !== null && body.repeat !== 'yearly' && body.repeat !== 'none') throw new HttpError(400, "repeat must be 'yearly' or empty");
    out.repeat_rule = body.repeat === 'yearly' ? 'yearly' : null;
  }
  if (has('kind') || !cur) {
    const k = body.kind ?? 'custom';
    if (!(EVENT_KINDS as readonly unknown[]).includes(k)) throw new HttpError(400, `kind must be one of: ${EVENT_KINDS.join(', ')}`);
    out.kind = k;
  }
  return out;
}

/** Tell people about an event change; players hear only about events they may see. */
function announceEvent(hub: EventHub | null, worldId: string, action: 'created' | 'updated' | 'deleted', after: WorldEvent | null, before: WorldEvent | null) {
  if (!hub) return;
  const ev = after ?? before!;
  hub.emit(worldId, 'world-event', { action, event: ev }, dmOnly);
  const playerSees = (e: WorldEvent | null) => !!e && e.visibility === 'party';
  const was = playerSees(before), is = playerSees(after);
  const players = (v: { role: string }) => v.role !== 'dm';
  if (is && was) hub.emit(worldId, 'world-event', { action: 'updated', event: after }, players);
  else if (is) hub.emit(worldId, 'world-event', { action: 'created', event: after }, players);
  else if (was) hub.emit(worldId, 'world-event', { action: 'deleted', event: { id: before!.id } }, players);
}

export function addEvent(db: DB, hub: EventHub | null, worldId: string, body: EventInput, by: string | null): WorldEvent {
  const def = getCalendar(db, worldId).definition;
  const e = cleanEvent(def, body, null);
  const eid = id('evt_');
  run(db, 'INSERT INTO clock_events (id, world_id, title, description, start_minutes, end_minutes, visibility, repeat_rule, kind, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    eid, worldId, e.title, e.description ?? '', e.start_minutes, e.end_minutes ?? null, e.visibility, e.repeat_rule ?? null, e.kind, by, now());
  const ev = getEvent(db, worldId, eid, 'dm');
  announceEvent(hub, worldId, 'created', ev, null);
  return ev;
}

export function updateEvent(db: DB, hub: EventHub | null, worldId: string, eventId: string, body: EventInput): WorldEvent {
  const def = getCalendar(db, worldId).definition;
  const cur = one<any>(db, 'SELECT * FROM clock_events WHERE id = ? AND world_id = ?', eventId, worldId);
  if (!cur) throw new HttpError(404, 'Event not found');
  const before = eventOut(def, cur);
  const e = cleanEvent(def, body, cur);
  const sets = Object.keys(e);
  if (sets.length) run(db, `UPDATE clock_events SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...sets.map((k) => e[k]), eventId);
  const after = getEvent(db, worldId, eventId, 'dm');
  announceEvent(hub, worldId, 'updated', after, before);
  return after;
}

export function deleteEvent(db: DB, hub: EventHub | null, worldId: string, eventId: string) {
  const def = getCalendar(db, worldId).definition;
  const cur = one<any>(db, 'SELECT * FROM clock_events WHERE id = ? AND world_id = ?', eventId, worldId);
  if (!cur) throw new HttpError(404, 'Event not found');
  run(db, 'DELETE FROM clock_events WHERE id = ?', eventId);
  announceEvent(hub, worldId, 'deleted', null, eventOut(def, cur));
}

/**
 * Events (with repeats unrolled) that overlap [from, to], in time order.
 * Only the events this role may see are even read from the table.
 */
export function listEvents(db: DB, worldId: string, role: Role, from: number, to: number, limit = 500): Occurrence[] {
  const def = getCalendar(db, worldId).definition;
  const nowMin = ensure(db, worldId).minutes as number;
  const rows = all<any>(db, `SELECT * FROM clock_events WHERE world_id = ?${role === 'dm' ? '' : " AND visibility = 'party'"}`, worldId);
  const yl = yearLength(def) * MINUTES_PER_DAY;
  const out: Occurrence[] = [];
  const today = Math.floor(nowMin / MINUTES_PER_DAY);
  for (const r of rows) {
    const base = eventOut(def, r);
    const dur = r.end_minutes === null ? 0 : r.end_minutes - r.start_minutes;
    const push = (s: number) => out.push({ ...base, occursAt: s, occursEnd: r.end_minutes === null ? null : s + dur, occursLabel: formatDate(def, s), daysAway: Math.floor(s / MINUTES_PER_DAY) - today });
    if (r.repeat_rule === 'yearly') {
      const k0 = Math.max(0, Math.ceil((from - dur - r.start_minutes) / yl));
      const k1 = Math.floor((to - r.start_minutes) / yl);
      for (let k = k0; k <= k1 && k - k0 < 200; k++) push(r.start_minutes + k * yl);
    } else if (r.start_minutes <= to && (r.end_minutes ?? r.start_minutes) >= from) push(r.start_minutes);
  }
  return out.sort((a, b) => a.occursAt - b.occursAt || a.title.localeCompare(b.title)).slice(0, limit);
}

// ---- Per-person preferences ----

export function getUpcomingDays(db: DB, worldId: string, accountId: string): number {
  const r = one<{ upcoming_days: number }>(db, 'SELECT upcoming_days FROM clock_prefs WHERE world_id = ? AND account_id = ?', worldId, accountId);
  return r?.upcoming_days ?? 7;
}
export function setUpcomingDays(db: DB, worldId: string, accountId: string, days: unknown): number {
  if (!(UPCOMING_CHOICES as readonly unknown[]).includes(days)) throw new HttpError(400, `upcomingDays must be one of ${UPCOMING_CHOICES.join(', ')}`);
  run(db, 'INSERT INTO clock_prefs (world_id, account_id, upcoming_days) VALUES (?,?,?) ON CONFLICT(world_id, account_id) DO UPDATE SET upcoming_days = excluded.upcoming_days', worldId, accountId, days);
  return days as number;
}

/** Today's events and those in the next `days` world days. */
export function upcoming(db: DB, worldId: string, role: Role, days: number) {
  const clock = getClock(db, worldId);
  const dayStart = Math.floor(clock.minutes / MINUTES_PER_DAY) * MINUTES_PER_DAY;
  const todayEnd = dayStart + MINUTES_PER_DAY - 1;
  const today = listEvents(db, worldId, role, dayStart, todayEnd);
  const later = listEvents(db, worldId, role, todayEnd + 1, todayEnd + days * MINUTES_PER_DAY).filter((e) => e.occursAt > todayEnd);
  return { ...clock, days, today, upcoming: later };
}

// ---- Intake calendars (written by the intake feature; the table may not exist yet) ----

export interface SourceCalendar { sourceId: string; externalId: string; name: string; definition: CalendarDef | null; current: { year: number; month: number; day: number } | null }
export function sourceCalendars(db: DB, worldId: string): SourceCalendar[] {
  try {
    const rows = all<any>(db, 'SELECT source_id, external_id, name, definition, visibility, current FROM intake_calendars WHERE world_id = ?', worldId);
    return rows.map((r) => {
      let definition: CalendarDef | null = null;
      try { definition = normalizeCalendar(JSON.parse(r.definition)); } catch { /* unusable calendar: listed but not selectable */ }
      return { sourceId: r.source_id, externalId: r.external_id, name: r.name, definition, current: parseJson(r.current, null) };
    });
  } catch {
    return [];
  }
}
