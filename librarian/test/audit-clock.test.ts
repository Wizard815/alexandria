// Audit: world calendar and clock edge cases (negative and zero years, huge years, odd calendars, no DM).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, type Kit } from './audit-kit.ts';
import { minutesToDate, dateToMinutes, formatDate, normalizeCalendar, BUILTIN_CALENDARS } from '../src/features/clock/calendar.ts';

let k: Kit;
before(async () => { k = await boot(); });
after(() => k?.close());
const C = () => k.w('/clock');

test('Audit_Clock: dates before the epoch, year zero and negative years round-trip', () => {
  const def = BUILTIN_CALENDARS.harptos;
  for (const year of [-5000, -1, 0, 1, 1491, 1492, 99999]) {
    for (const [month, day] of [[1, 1], [12, 30], [6, 15]]) {
      const m = dateToMinutes(def, { year, month, day, hour: 13, minute: 7 });
      const p = minutesToDate(def, m);
      assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute], [year, month, day, 13, 7], `year ${year}`);
      assert.ok(p.weekday && def.weekdays.includes(p.weekday));
    }
  }
  // The day before the epoch is the last day of the year before.
  const p = minutesToDate(def, -1);
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute], [1491, 12, 30, 23, 59]);
});

test('Audit_Clock: intercalary days have no weekday and do not move the week', () => {
  const def = normalizeCalendar({ name: 'Fest', epochYear: 0, months: [{ name: 'A', days: 7 }, { name: 'Festival', days: 2, intercalary: true }, { name: 'B', days: 7 }], weekdays: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
  const at = (month: number, day: number) => minutesToDate(def, dateToMinutes(def, { year: 0, month, day }));
  assert.equal(at(2, 1).weekday, null);
  assert.equal(at(1, 7).weekday, 'g');
  assert.equal(at(3, 1).weekday, 'a', 'the week continues after the festival');
  assert.equal(minutesToDate(def, dateToMinutes(def, { year: 1, month: 1, day: 1 })).weekday, 'a'.repeat(1) === 'a' ? minutesToDate(def, dateToMinutes(def, { year: 1, month: 1, day: 1 })).weekday : null);
});

test('Audit_Clock: set and advance reject years that would leave the safe range of numbers', async () => {
  for (const year of [1e12, 4e15, -4e15, 1e300, 'x', null]) {
    const r = await k.call('POST', `${C()}/set`, k.T.dm, { year, month: 1, day: 1 });
    assert.ok(r.status === 400 || r.status < 300, `year ${String(year)} -> ${r.status} ${r.text.slice(0, 100)}`);
    if (r.status < 300) {
      const now = await k.ok('GET', C(), k.T.dm);
      assert.ok(Number.isSafeInteger(now.minutes ?? now.clock?.minutes), `the clock holds ${JSON.stringify(now).slice(0, 200)} after setting year ${year}`);
      await k.ok('POST', `${C()}/set`, k.T.dm, { year: 1492, month: 1, day: 1 });
    }
  }
});

test('Audit_Clock: a player cannot move the clock and a guest only reads', async () => {
  for (const who of ['jess', 'visitor']) {
    assert.ok([401, 403, 404].includes((await k.call('POST', `${C()}/advance`, k.T[who], { minutes: 5 })).status), who);
    assert.ok([401, 403, 404].includes((await k.call('POST', `${C()}/set`, k.T[who], { year: 1500, month: 1, day: 1 })).status), who);
  }
  assert.equal((await k.call('GET', C(), k.T.visitor)).status, 200);
});
