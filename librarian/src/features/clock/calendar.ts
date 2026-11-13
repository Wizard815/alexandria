// Pure calendar math for the world clock: no database, no clock. The time is
// a whole number of minutes since 00:00 on day 1 of month 1 of epochYear;
// days are always 24 hours of 60 minutes.
//
// Weeks: intercalary days (festival days outside the months) sit outside the
// week, so they have no weekday and do not move the weekday cycle.

export interface Month { name: string; days: number; intercalary?: boolean }
export interface Moon { name: string; cycleDays: number; offsetDays: number }
export interface Season { name: string; month: number; day: number }
export interface CalendarDef {
  name: string;
  epochYear: number;
  yearSuffix?: string;
  months: Month[];
  weekdays: string[];
  moons?: Moon[];
  seasons?: Season[];
}

export interface MoonPhase { name: string; phase: string; fraction: number }
export interface DateParts {
  year: number; month: number; day: number; hour: number; minute: number;
  /** null on an intercalary day. */
  weekday: string | null;
  monthName: string;
  intercalary: boolean;
  dayOfYear: number;
  season: string | null;
  timeOfDay: string;
  moons: MoonPhase[];
}
export interface DateInput { year: number; month: number; day: number; hour?: number; minute?: number }

export const MINUTES_PER_DAY = 1440;
export const floorDiv = (a: number, b: number) => Math.floor(a / b);
export const mod = (a: number, b: number) => ((a % b) + b) % b;

export const yearLength = (def: CalendarDef) => def.months.reduce((n, m) => n + m.days, 0);
const weekDaysPerYear = (def: CalendarDef) => def.months.reduce((n, m) => n + (m.intercalary ? 0 : m.days), 0);

/** Check and tidy a calendar definition; throws RangeError with a plain message. */
export function normalizeCalendar(raw: any): CalendarDef {
  const bad = (m: string): never => { throw new RangeError(m); };
  if (!raw || typeof raw !== 'object') bad('The calendar must be an object');
  const name = String(raw.name ?? '').trim();
  if (!name || name.length > 80) bad('The calendar needs a name (up to 80 characters)');
  if (!Number.isInteger(raw.epochYear) || Math.abs(raw.epochYear) > 1_000_000) bad('epochYear must be a whole number');
  const yearSuffix = raw.yearSuffix === undefined || raw.yearSuffix === null ? undefined : String(raw.yearSuffix).trim().slice(0, 20) || undefined;
  if (!Array.isArray(raw.months) || raw.months.length < 1 || raw.months.length > 60) bad('A calendar needs 1 to 60 months');
  const months: Month[] = raw.months.map((m: any, i: number) => {
    const n = String(m?.name ?? '').trim();
    if (!n || n.length > 60) bad(`Month ${i + 1} needs a name`);
    if (!Number.isInteger(m.days) || m.days < 1 || m.days > 400) bad(`${n} needs 1 to 400 days`);
    return m.intercalary ? { name: n, days: m.days, intercalary: true } : { name: n, days: m.days };
  });
  if (!months.some((m) => !m.intercalary)) bad('At least one month must be a regular month');
  if (!Array.isArray(raw.weekdays) || raw.weekdays.length < 1 || raw.weekdays.length > 30) bad('A calendar needs 1 to 30 weekday names');
  const weekdays = raw.weekdays.map((w: any, i: number) => {
    const n = String(w ?? '').trim();
    if (!n || n.length > 40) bad(`Weekday ${i + 1} needs a name`);
    return n;
  });
  const out: CalendarDef = { name, epochYear: raw.epochYear, months, weekdays };
  if (yearSuffix) out.yearSuffix = yearSuffix;
  if (raw.moons !== undefined && raw.moons !== null) {
    if (!Array.isArray(raw.moons) || raw.moons.length > 12) bad('Up to 12 moons');
    out.moons = raw.moons.map((m: any, i: number) => {
      const n = String(m?.name ?? '').trim();
      if (!n || n.length > 60) bad(`Moon ${i + 1} needs a name`);
      if (typeof m.cycleDays !== 'number' || !(m.cycleDays > 0) || m.cycleDays > 100_000) bad(`${n} needs a cycle length above zero`);
      const off = m.offsetDays === undefined ? 0 : m.offsetDays;
      if (typeof off !== 'number' || !Number.isFinite(off)) bad(`${n} has a bad offset`);
      return { name: n, cycleDays: m.cycleDays, offsetDays: off };
    });
  }
  if (raw.seasons !== undefined && raw.seasons !== null) {
    if (!Array.isArray(raw.seasons) || raw.seasons.length > 12) bad('Up to 12 seasons');
    out.seasons = raw.seasons.map((s: any, i: number) => {
      const n = String(s?.name ?? '').trim();
      if (!n || n.length > 60) bad(`Season ${i + 1} needs a name`);
      const mo = months[s.month - 1];
      if (!Number.isInteger(s.month) || !mo) bad(`${n} starts in a month that does not exist`);
      if (!Number.isInteger(s.day) || s.day < 1 || s.day > mo.days) bad(`${n} starts on a day that does not exist`);
      return { name: n, month: s.month, day: s.day };
    });
  }
  return out;
}

/** Day of the year (0-based) for a month (1-based) and day (1-based). */
function doy(def: CalendarDef, month: number, day: number): number {
  let n = 0;
  for (let i = 0; i < month - 1; i++) n += def.months[i].days;
  return n + day - 1;
}

export function timeOfDay(hour: number): string {
  if (hour < 5) return 'night';
  if (hour < 8) return 'dawn';
  if (hour < 12) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 18) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

const PHASES = ['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full moon', 'waning gibbous', 'last quarter', 'waning crescent'];
export function moonPhase(moon: Moon, minutes: number): MoonPhase {
  const days = minutes / MINUTES_PER_DAY + moon.offsetDays;
  const fraction = mod(days, moon.cycleDays) / moon.cycleDays;
  return { name: moon.name, phase: PHASES[Math.floor(fraction * 8 + 0.5) % 8], fraction: Math.round(fraction * 1000) / 1000 };
}

export function minutesToDate(def: CalendarDef, minutes: number): DateParts {
  const total = Math.floor(minutes);
  const dayNo = floorDiv(total, MINUTES_PER_DAY);
  const inDay = mod(total, MINUTES_PER_DAY);
  const yl = yearLength(def);
  const yearNo = floorDiv(dayNo, yl);
  const dayOfYear = mod(dayNo, yl);
  let left = dayOfYear;
  let mi = 0;
  while (left >= def.months[mi].days) { left -= def.months[mi].days; mi++; }
  const m = def.months[mi];
  let weekday: string | null = null;
  if (!m.intercalary) {
    let before = 0;
    for (let i = 0; i < mi; i++) if (!def.months[i].intercalary) before += def.months[i].days;
    weekday = def.weekdays[mod(yearNo * weekDaysPerYear(def) + before + left, def.weekdays.length)];
  }
  let season: string | null = null;
  if (def.seasons?.length) {
    const sorted = def.seasons.map((s) => ({ s, at: doy(def, s.month, s.day) })).sort((a, b) => a.at - b.at);
    season = (sorted.filter((x) => x.at <= dayOfYear).pop() ?? sorted[sorted.length - 1]).s.name;
  }
  const hour = Math.floor(inDay / 60);
  return {
    year: def.epochYear + yearNo, month: mi + 1, day: left + 1, hour, minute: inDay % 60,
    weekday, monthName: m.name, intercalary: !!m.intercalary, dayOfYear: dayOfYear + 1, season,
    timeOfDay: timeOfDay(hour), moons: (def.moons ?? []).map((mo) => moonPhase(mo, total)),
  };
}

/** The minutes for a date in this calendar; throws RangeError if the date does not exist. */
export function dateToMinutes(def: CalendarDef, d: DateInput): number {
  const { year, month, day, hour = 0, minute = 0 } = d;
  if (![year, month, day, hour, minute].every(Number.isInteger)) throw new RangeError('A date needs whole numbers for year, month and day');
  const m = def.months[month - 1];
  if (!m) throw new RangeError(`This calendar has months 1 to ${def.months.length}`);
  if (day < 1 || day > m.days) throw new RangeError(`${m.name} has days 1 to ${m.days}`);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new RangeError('Time must be 00:00 to 23:59');
  const days = (year - def.epochYear) * yearLength(def) + doy(def, month, day);
  return days * MINUTES_PER_DAY + hour * 60 + minute;
}

/** Same date in another calendar where possible; month and day are clamped to fit. */
export function remapDate(from: CalendarDef, to: CalendarDef, minutes: number): number {
  const p = minutesToDate(from, minutes);
  const month = Math.min(p.month, to.months.length);
  const day = Math.min(p.day, to.months[month - 1].days);
  return dateToMinutes(to, { year: p.year, month, day, hour: p.hour, minute: p.minute });
}

export function formatYear(def: CalendarDef, year: number) {
  return def.yearSuffix ? `${year} ${def.yearSuffix}` : String(year);
}

/** "3 Frostmoot 1492 DR · evening" */
export function formatDate(def: CalendarDef, minutes: number): string {
  const p = minutesToDate(def, minutes);
  return `${p.day} ${p.monthName} ${formatYear(def, p.year)} · ${p.timeOfDay}`;
}

/** Just the day part, e.g. "3 Frostmoot 1492 DR". */
export function formatDay(def: CalendarDef, minutes: number): string {
  const p = minutesToDate(def, minutes);
  return `${p.day} ${p.monthName} ${formatYear(def, p.year)}`;
}

/** The next time it is `hour`:00 strictly after `minutes`. */
export function nextHour(minutes: number, hour = 7): number {
  const target = floorDiv(minutes, MINUTES_PER_DAY) * MINUTES_PER_DAY + hour * 60;
  return target > minutes ? target : target + MINUTES_PER_DAY;
}
/** `hour`:00 on the following calendar day. */
export function nextDayAt(minutes: number, hour = 7): number {
  return (floorDiv(minutes, MINUTES_PER_DAY) + 1) * MINUTES_PER_DAY + hour * 60;
}

export const WAKE_HOUR = 7;

export const BUILTIN_CALENDARS: Record<string, CalendarDef> = {
  // Twelve 30-day months and a ten-day week.
  harptos: {
    name: 'Twelve months of 30 days', epochYear: 1492, yearSuffix: 'DR',
    months: [
      { name: 'Frostmoot', days: 30 }, { name: 'Thawing', days: 30 }, { name: 'Seedfall', days: 30 }, { name: 'Rainwake', days: 30 },
      { name: 'Bloomtide', days: 30 }, { name: 'Highsun', days: 30 }, { name: 'Emberfall', days: 30 }, { name: 'Harvest', days: 30 },
      { name: 'Mistwane', days: 30 }, { name: 'Leaffall', days: 30 }, { name: 'Duskmoot', days: 30 }, { name: 'Deepwinter', days: 30 },
    ],
    weekdays: ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'],
    moons: [{ name: 'Selune', cycleDays: 30, offsetDays: 0 }],
    seasons: [{ name: 'Winter', month: 12, day: 1 }, { name: 'Spring', month: 3, day: 1 }, { name: 'Summer', month: 6, day: 1 }, { name: 'Autumn', month: 9, day: 1 }],
  },
  gregorian: {
    name: 'Gregorian (no leap years)', epochYear: 2000,
    months: [
      { name: 'January', days: 31 }, { name: 'February', days: 28 }, { name: 'March', days: 31 }, { name: 'April', days: 30 },
      { name: 'May', days: 31 }, { name: 'June', days: 30 }, { name: 'July', days: 31 }, { name: 'August', days: 31 },
      { name: 'September', days: 30 }, { name: 'October', days: 31 }, { name: 'November', days: 30 }, { name: 'December', days: 31 },
    ],
    // 1 January 2000 was a Saturday.
    weekdays: ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    moons: [{ name: 'Moon', cycleDays: 29.53, offsetDays: 0 }],
    seasons: [{ name: 'Winter', month: 12, day: 21 }, { name: 'Spring', month: 3, day: 20 }, { name: 'Summer', month: 6, day: 21 }, { name: 'Autumn', month: 9, day: 22 }],
  },
};
