// World clock: pure date math (month rollover, intercalary days, weekdays,
// moons, seasons, rest presets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_CALENDARS, dateToMinutes, formatDate, minutesToDate, normalizeCalendar, remapDate, yearLength, type CalendarDef } from '../src/features/clock/calendar.ts';
import { presetMinutes } from '../src/features/clock/api.ts';

const H = BUILTIN_CALENDARS.harptos;
const G = BUILTIN_CALENDARS.gregorian;

// Three regular months, an intercalary festival between months 1 and 2, a five-day week.
const ODD: CalendarDef = {
  name: 'Odd', epochYear: 100, yearSuffix: 'AE',
  months: [{ name: 'Alpha', days: 4 }, { name: 'Feast', days: 2, intercalary: true }, { name: 'Beta', days: 3 }],
  weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  moons: [{ name: 'Lune', cycleDays: 28, offsetDays: 0 }],
  seasons: [{ name: 'Cold', month: 3, day: 2 }, { name: 'Warm', month: 1, day: 2 }],
};

test('TestClockMath_EpochIsDayOneMonthOne', () => {
  const p = minutesToDate(H, 0);
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute, p.monthName, p.weekday], [1492, 1, 1, 0, 0, 'Frostmoot', 'First']);
  assert.equal(formatDate(H, 19 * 60 + 5 + 2 * 1440), '3 Frostmoot 1492 DR · evening');
});

test('TestClockMath_MonthAndYearRollover', () => {
  assert.equal(minutesToDate(H, dateToMinutes(H, { year: 1492, month: 1, day: 30 }) + 1440).monthName, 'Thawing');
  const last = dateToMinutes(H, { year: 1492, month: 12, day: 30, hour: 23, minute: 59 });
  assert.equal(last, yearLength(H) * 1440 - 1);
  const next = minutesToDate(H, last + 1);
  assert.deepEqual([next.year, next.month, next.day, next.hour], [1493, 1, 1, 0]);
  // Back before the epoch.
  const before = minutesToDate(H, -1);
  assert.deepEqual([before.year, before.month, before.day, before.hour, before.minute], [1491, 12, 30, 23, 59]);
  // Round trip across many days.
  for (let m = -500_000; m < 900_000; m += 7919) {
    const p = minutesToDate(H, m);
    assert.equal(dateToMinutes(H, p), m);
  }
});

test('TestClockMath_GregorianMonthLengthsAndWeekdays', () => {
  assert.equal(yearLength(G), 365);
  assert.equal(minutesToDate(G, dateToMinutes(G, { year: 2000, month: 2, day: 28 }) + 1440).monthName, 'March');
  assert.equal(minutesToDate(G, 0).weekday, 'Saturday');
  assert.equal(minutesToDate(G, 1440).weekday, 'Sunday');
  assert.equal(minutesToDate(G, 7 * 1440).weekday, 'Saturday');
  // 365 days is one more than 52 weeks: the weekday moves on by one each year.
  assert.equal(minutesToDate(G, dateToMinutes(G, { year: 2001, month: 1, day: 1 })).weekday, 'Sunday');
});

test('TestClockMath_IntercalaryDaysHaveNoWeekdayAndDoNotMoveTheWeek', () => {
  const at = (month: number, day: number, year = 100) => minutesToDate(ODD, dateToMinutes(ODD, { year, month, day }));
  assert.equal(at(1, 1).weekday, 'Mon');
  assert.equal(at(1, 4).weekday, 'Thu');
  const feast = at(2, 1);
  assert.deepEqual([feast.intercalary, feast.weekday, feast.monthName], [true, null, 'Feast']);
  assert.equal(at(2, 2).weekday, null);
  assert.equal(at(3, 1).weekday, 'Fri', 'the day after the feast continues the week');
  assert.equal(at(3, 2).weekday, 'Mon');
  // 7 week days per year, 5 per week: year 101 starts two days on.
  assert.equal(at(1, 1, 101).weekday, 'Wed');
  assert.equal(dateToMinutes(ODD, { year: 101, month: 1, day: 1 }), 9 * 1440);
  assert.throws(() => dateToMinutes(ODD, { year: 100, month: 2, day: 3 }), /Feast has days 1 to 2/);
  assert.throws(() => dateToMinutes(ODD, { year: 100, month: 4, day: 1 }), /months 1 to 3/);
});

test('TestClockMath_MoonPhases', () => {
  const phase = (day: number) => minutesToDate(ODD, day * 1440).moons[0];
  assert.equal(phase(0).phase, 'new moon');
  assert.equal(phase(7).phase, 'first quarter');
  assert.equal(phase(14).phase, 'full moon');
  assert.equal(phase(21).phase, 'last quarter');
  assert.equal(phase(28).phase, 'new moon');
  assert.equal(phase(-14).phase, 'full moon', 'before the epoch too');
  assert.equal(phase(3).phase, 'waxing crescent');
  const offset = minutesToDate({ ...ODD, moons: [{ name: 'Late', cycleDays: 28, offsetDays: 14 }] }, 0).moons[0];
  assert.equal(offset.phase, 'full moon');
  assert.equal(minutesToDate(H, 0).moons[0].name, 'Selune');
});

test('TestClockMath_Seasons', () => {
  const s = (month: number, day: number) => minutesToDate(ODD, dateToMinutes(ODD, { year: 100, month, day })).season;
  assert.equal(s(1, 1), 'Cold', 'before the first start of the year wraps to the last season');
  assert.equal(s(1, 2), 'Warm');
  assert.equal(s(2, 1), 'Warm');
  assert.equal(s(3, 2), 'Cold');
  assert.equal(minutesToDate(H, dateToMinutes(H, { year: 1492, month: 4, day: 10 })).season, 'Spring');
  assert.equal(minutesToDate({ ...ODD, seasons: undefined }, 0).season, null);
});

test('TestClockMath_TimeOfDayAndRemap', () => {
  assert.equal(minutesToDate(H, 8 * 60).timeOfDay, 'morning');
  assert.equal(minutesToDate(H, 22 * 60).timeOfDay, 'night');
  const m = dateToMinutes(H, { year: 1492, month: 12, day: 30, hour: 9, minute: 30 });
  const p = minutesToDate(ODD, remapDate(H, ODD, m));
  assert.deepEqual([p.year, p.monthName, p.day, p.hour, p.minute], [1492, 'Beta', 3, 9, 30], 'month and day are clamped to fit');
});

test('TestClockMath_NormalizeRejectsBadCalendars', () => {
  const ok = { name: 'x', epochYear: 1, months: [{ name: 'M', days: 10 }], weekdays: ['a'] };
  assert.equal(normalizeCalendar(ok).months.length, 1);
  for (const bad of [
    null, { ...ok, name: '' }, { ...ok, epochYear: 1.5 }, { ...ok, months: [] }, { ...ok, months: [{ name: 'M', days: 0 }] },
    { ...ok, months: [{ name: 'M', days: 5, intercalary: true }] }, { ...ok, weekdays: [] },
    { ...ok, moons: [{ name: 'm', cycleDays: 0, offsetDays: 0 }] }, { ...ok, seasons: [{ name: 's', month: 2, day: 1 }] },
    { ...ok, seasons: [{ name: 's', month: 1, day: 11 }] },
  ]) assert.throws(() => normalizeCalendar(bad), RangeError);
  for (const [k, def] of Object.entries(BUILTIN_CALENDARS)) assert.deepEqual(normalizeCalendar(def), def, `${k} is valid`);
});

test('TestClockPresets_ShortLongNextDay', () => {
  const at = (h: number, m = 0) => 3 * 1440 + h * 60 + m;
  assert.equal(presetMinutes('short-rest', at(12)), 60);
  assert.equal(presetMinutes('long-rest', at(12), '8h'), 480);
  assert.equal(presetMinutes('long-rest', at(22), 'morning'), 9 * 60, 'to 07:00 tomorrow');
  assert.equal(presetMinutes('long-rest', at(3), 'morning'), 4 * 60, 'to 07:00 today when it is still night');
  assert.equal(presetMinutes('long-rest', at(7), 'morning'), 1440, 'at 07:00 sharp the next 07:00 is tomorrow');
  assert.equal(presetMinutes('next-day', at(22)), 9 * 60);
  assert.equal(presetMinutes('next-day', at(3)), 28 * 60, 'next day is always the following calendar day');
});
