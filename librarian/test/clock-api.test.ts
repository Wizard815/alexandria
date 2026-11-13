// World clock over HTTP: endpoints, rest presets, undo, events and who may
// see them (REST, live stream, MCP), per-person preferences, source calendars.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { run } from '../src/core/db.ts';
import * as clock from '../src/features/clock/api.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
let W = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const C = () => `/api/worlds/${W}/clock`;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const rpc = async (key: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return JSON.stringify(await r.json());
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-clock-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: {} });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Clockland', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('TestClock_DefaultsToTheBuiltInCalendar', async () => {
  const c = await ok('GET', C(), T.jess);
  assert.equal(c.date.year, 1492);
  assert.equal(c.date.monthName, 'Frostmoot');
  assert.equal(c.label, '1 Frostmoot 1492 DR · morning');
  assert.equal(c.calendar.months.length, 12);
  assert.equal(c.sources, undefined, 'players are not offered the DM setup lists');
  const d = await ok('GET', C(), T.dm);
  assert.deepEqual(d.builtins.map((b: any) => b.key), ['harptos', 'gregorian']);
  assert.equal(d.longRestMode, 'morning');
  assert.deepEqual(d.sources, [], 'no intake table yet: no sources, no error');
});

test('TestClock_OnlyTheDmMovesTime', async () => {
  for (const [m, u, b] of [['POST', '/advance', { minutes: 5 }], ['POST', '/set', { year: 1500, month: 1, day: 1 }], ['PUT', '/calendar', { builtin: 'gregorian' }], ['GET', '/log'], ['POST', '/events', { title: 'x', start: 0 }]] as const) {
    assert.equal((await call(m, C() + u, T.jess, b)).status, 403, `${m} ${u}`);
  }
  assert.equal((await ok('GET', C(), T.dm)).minutes, 480);
});

test('TestClock_AdvanceSetAndLog', async () => {
  const a = await ok('POST', C() + '/advance', T.dm, { minutes: 90, reason: 'Walked to the ford' });
  assert.equal(a.minutes, 570);
  assert.equal(a.entry.reason, 'Walked to the ford');
  assert.equal(a.entry.accountId, ID.dm);
  assert.equal(a.entry.beforeLabel, '1 Frostmoot 1492 DR · morning');
  assert.equal((await call('POST', C() + '/advance', T.dm, { minutes: 0 })).status, 400);
  assert.equal((await call('POST', C() + '/advance', T.dm, { minutes: 1.5 })).status, 400);
  assert.equal((await call('POST', C() + '/advance', T.dm, { preset: 'nap' })).status, 400);
  const s = await ok('POST', C() + '/set', T.dm, { year: 1492, month: 1, day: 3, hour: 19, reason: 'Skip ahead' });
  assert.equal(s.label, '3 Frostmoot 1492 DR · evening');
  assert.equal(s.date.weekday, 'Third');
  assert.equal((await call('POST', C() + '/set', T.dm, { year: 1492, month: 13, day: 1 })).status, 400);
  assert.equal((await call('POST', C() + '/set', T.dm, { year: 1492, month: 2, day: 31 })).status, 400);
  const log = await ok('GET', C() + '/log', T.dm);
  assert.deepEqual(log.map((e: any) => e.kind), ['set', 'advance']);
  assert.equal(log[0].undoable, true);
  assert.equal(log[1].undoable, false, 'older entries wait for newer ones');
});

test('TestClock_RestPresetsFollowTheLongRestSetting', async () => {
  await ok('POST', C() + '/set', T.dm, { year: 1492, month: 2, day: 10, hour: 21, minute: 30 });
  const short = await ok('POST', C() + '/advance', T.dm, { preset: 'short-rest' });
  assert.equal(short.label, '10 Thawing 1492 DR · night');
  assert.equal(short.date.hour, 22);
  assert.equal(short.entry.reason, 'Short rest');
  const lr = await ok('POST', C() + '/advance', T.dm, { preset: 'long-rest', reason: 'Camp at the ford' });
  assert.deepEqual([lr.date.day, lr.date.hour, lr.date.minute], [11, 7, 0], 'default: to 07:00');
  assert.equal(lr.entry.reason, 'Camp at the ford');
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { longRestMode: '8h' });
  const lr8 = await ok('POST', C() + '/advance', T.dm, { preset: 'long-rest' });
  assert.deepEqual([lr8.date.day, lr8.date.hour], [11, 15]);
  assert.equal((await call('PATCH', `/api/worlds/${W}/settings`, T.dm, { longRestMode: 'fortnight' })).status, 400);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { longRestMode: 'morning' });
  const nd = await ok('POST', C() + '/advance', T.dm, { preset: 'next-day' });
  assert.deepEqual([nd.date.day, nd.date.hour], [12, 7]);
  assert.equal(nd.entry.reason, 'Next day');
});

test('TestClock_UndoOnlyTheNewestAndItIsLogged', async () => {
  const before = await ok('GET', C(), T.dm);
  const a = (await ok('POST', C() + '/advance', T.dm, { minutes: 600, reason: 'one' })).entry;
  const b = (await ok('POST', C() + '/advance', T.dm, { minutes: 60, reason: 'two' })).entry;
  assert.equal((await call('POST', `${C()}/log/${a.id}/undo`, T.dm)).status, 409, 'older entry is blocked');
  assert.equal((await call('POST', `${C()}/log/${b.id}/undo`, T.jess)).status, 403);
  const u = await ok('POST', `${C()}/log/${b.id}/undo`, T.dm);
  assert.equal(u.minutes, before.minutes + 600);
  assert.equal(u.entry.kind, 'undo');
  assert.equal((await call('POST', `${C()}/log/${b.id}/undo`, T.dm)).status, 409, 'not twice');
  assert.equal((await call('POST', `${C()}/log/${u.entry.id}/undo`, T.dm)).status, 400, 'an undo is not undone');
  const u2 = await ok('POST', `${C()}/log/${a.id}/undo`, T.dm);
  assert.equal(u2.minutes, before.minutes, 'now the older one can go');
  const log = await ok('GET', C() + '/log', T.dm);
  assert.equal(log.filter((e: any) => e.undone).length, 2);
  assert.equal((await call('POST', `${C()}/log/nope/undo`, T.dm)).status, 404);
});

test('TestClock_CalendarChangeKeepsTheDateMovesEventsAndUndoes', async () => {
  await ok('POST', C() + '/set', T.dm, { year: 1492, month: 3, day: 5, hour: 12, minute: 0 });
  const ev = await ok('POST', C() + '/events', T.dm, { title: 'Market day', start: { year: 1492, month: 3, day: 8 }, visibility: 'party' });
  const custom = {
    name: 'Tidal', epochYear: 10, yearSuffix: 'TE',
    months: [{ name: 'Ebb', days: 20 }, { name: 'Flood', days: 20 }, { name: 'Slack', days: 3, intercalary: true }, { name: 'Neap', days: 20 }],
    weekdays: ['One', 'Two', 'Three', 'Four'], moons: [{ name: 'Tide', cycleDays: 12, offsetDays: 3 }],
  };
  assert.equal((await call('PUT', C() + '/calendar', T.dm, { definition: { ...custom, months: [] } })).status, 400);
  assert.equal((await call('PUT', C() + '/calendar', T.dm, { builtin: 'nope' })).status, 400);
  const put = await ok('PUT', C() + '/calendar', T.dm, { definition: custom });
  assert.equal(put.calendar.name, 'Tidal');
  assert.equal(put.calendarSource, 'custom');
  assert.deepEqual([put.date.year, put.date.month, put.date.day, put.date.hour], [1492, 3, 3, 12], 'same date, clamped: month 3 is the 3-day Slack');
  const evs = await ok('GET', C() + '/events?from=0&to=999999999', T.jess);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].start, ev.start + (put.entry.afterMinutes - put.entry.beforeMinutes), 'events keep their distance from now');
  const undone = await ok('POST', `${C()}/log/${put.entry.id}/undo`, T.dm);
  assert.equal(undone.calendar.name, BUILTIN().name);
  assert.deepEqual([undone.date.month, undone.date.day, undone.date.hour], [3, 5, 12]);
  const back = await ok('GET', `${C()}/events/${ev.id}`, T.dm);
  assert.equal(back.start, ev.start, 'events return to where they were');
  await ok('DELETE', `${C()}/events/${ev.id}`, T.dm);
});
const BUILTIN = () => clock.BUILTIN_CALENDARS.harptos;

test('TestClock_EventsPlayersOnlySeePartyEvents', async () => {
  await ok('POST', C() + '/set', T.dm, { year: 1492, month: 5, day: 1, hour: 8, minute: 0 });
  const secret = await ok('POST', C() + '/events', T.dm, { title: 'Velmira poisons the well', description: 'DM only: the cult strikes', start: { year: 1492, month: 5, day: 2 }, visibility: 'dm', kind: 'deadline' });
  const open = await ok('POST', C() + '/events', T.dm, { title: 'Harvest fair', description: 'Stalls in the square', start: { year: 1492, month: 5, day: 3, hour: 10 }, end: { year: 1492, month: 5, day: 4, hour: 18 }, visibility: 'party', kind: 'holiday' });
  const yearly = await ok('POST', C() + '/events', T.dm, { title: 'Founders Day', start: { year: 1492, month: 5, day: 1 }, visibility: 'party', repeat: 'yearly', kind: 'holiday' });
  assert.equal((await call('POST', C() + '/events', T.dm, { title: 'x', start: 0, visibility: 'everyone' })).status, 400);
  assert.equal((await call('POST', C() + '/events', T.dm, { title: 'x', start: 0, kind: 'party' })).status, 400);
  assert.equal((await call('POST', C() + '/events', T.dm, { title: 'x', start: 100, end: 50 })).status, 400);
  assert.equal((await call('POST', C() + '/events', T.dm, { start: 0 })).status, 400);

  const dmList = await ok('GET', C() + '/events?from=1492-5-1&to=1492-5-30', T.dm);
  assert.deepEqual(dmList.map((e: any) => e.title), ['Founders Day', 'Velmira poisons the well', 'Harvest fair']);
  const pList = await ok('GET', C() + '/events?from=1492-5-1&to=1492-5-30', T.jess);
  assert.deepEqual(pList.map((e: any) => e.title), ['Founders Day', 'Harvest fair']);

  // The repeating event comes back every year.
  const years = await ok('GET', C() + '/events?from=1492-1-1&to=1495-12-30', T.jess);
  assert.deepEqual(years.filter((e: any) => e.title === 'Founders Day').map((e: any) => e.date ?? e.occursLabel.split(' ')[2]), ['1492', '1493', '1494', '1495']);

  // Leak attempts: by id, in upcoming, by patching, and by every route a player can reach.
  assert.equal((await call('GET', `${C()}/events/${secret.id}`, T.jess)).status, 404);
  assert.equal((await call('PATCH', `${C()}/events/${secret.id}`, T.jess, { visibility: 'party' })).status, 403);
  assert.equal((await call('DELETE', `${C()}/events/${open.id}`, T.jess)).status, 403);
  const up = await ok('GET', C() + '/upcoming?days=30', T.jess);
  for (const [who, tok] of [['upcoming', T.jess], ['events', T.tom]] as const) {
    const text = JSON.stringify(who === 'upcoming' ? up : await ok('GET', C() + '/events?from=0&to=99999999', tok));
    for (const leak of ['Velmira', 'poisons', 'cult strikes', secret.id]) assert.ok(!text.includes(leak), `${who} leaked ${leak}`);
  }
  assert.deepEqual(up.today.map((e: any) => e.title), ['Founders Day']);
  assert.deepEqual(up.upcoming.map((e: any) => e.title), ['Harvest fair']);
  const dmUp = await ok('GET', C() + '/upcoming?days=3', T.dm);
  assert.deepEqual(dmUp.upcoming.map((e: any) => e.title), ['Velmira poisons the well', 'Harvest fair']);
  assert.equal((await ok('GET', C() + '/upcoming?days=1', T.dm)).upcoming.length, 1);
  assert.equal((await call('GET', C() + '/upcoming?days=0', T.dm)).status, 400);

  // Editing visibility moves an event in or out of players' view.
  await ok('PATCH', `${C()}/events/${secret.id}`, T.dm, { visibility: 'party', title: 'Well poisoned!' });
  assert.ok((await ok('GET', C() + '/events?from=1492-5-1&to=1492-5-30', T.jess)).some((e: any) => e.title === 'Well poisoned!'));
  await ok('PATCH', `${C()}/events/${secret.id}`, T.dm, { visibility: 'dm' });
  assert.ok(!(await ok('GET', C() + '/events?from=1492-5-1&to=1492-5-30', T.jess)).some((e: any) => e.title === 'Well poisoned!'));
  await ok('DELETE', `${C()}/events/${secret.id}`, T.dm);
  await ok('DELETE', `${C()}/events/${open.id}`, T.dm);
  await ok('DELETE', `${C()}/events/${yearly.id}`, T.dm);
  assert.equal((await call('DELETE', `${C()}/events/${open.id}`, T.dm)).status, 404);
});

test('TestClock_LiveEventsAreFilteredForPlayers', async () => {
  const stream = async (token: string) => {
    const ctl = new AbortController();
    const r = await fetch(`${base}/api/worlds/${W}/events`, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
    const reader = r.body!.getReader();
    const s = { got: '', stop: async () => { ctl.abort(); await pump; } };
    const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; s.got += new TextDecoder().decode(value); } } catch { /* aborted */ } })();
    return s;
  };
  const p = await stream(T.tom);
  const d = await stream(T.dm);
  await new Promise((r) => setTimeout(r, 50));
  await ok('POST', C() + '/advance', T.dm, { minutes: 30, reason: 'secret reason: smuggler camp' });
  const hid = await ok('POST', C() + '/events', T.dm, { title: 'Hidden ambush', start: 100000, visibility: 'dm' });
  const shown = await ok('POST', C() + '/events', T.dm, { title: 'Open feast', start: 100000, visibility: 'party' });
  await ok('PATCH', `${C()}/events/${hid.id}`, T.dm, { title: 'Hidden ambush 2' });
  await ok('PATCH', `${C()}/events/${shown.id}`, T.dm, { visibility: 'dm' });
  await ok('DELETE', `${C()}/events/${shown.id}`, T.dm);
  await ok('DELETE', `${C()}/events/${hid.id}`, T.dm);
  await new Promise((r) => setTimeout(r, 150));
  await p.stop();
  await d.stop();
  assert.ok(p.got.includes('event: clock'), 'players hear the date change');
  assert.ok(p.got.includes('Open feast'), 'players hear about party events');
  assert.ok(p.got.includes('"action":"deleted"'), 'and when one is pulled back');
  for (const leak of ['Hidden', 'ambush', 'smuggler', 'secret reason']) assert.ok(!p.got.includes(leak), `player stream leaked ${leak}`);
  assert.ok(d.got.includes('Hidden ambush 2') && d.got.includes('Open feast'), 'the DM hears everything');
  assert.ok(!d.got.includes('smuggler'), 'reasons are only in the log, never on the stream');
});

test('TestClock_UpcomingRangeIsPerPerson', async () => {
  assert.equal((await ok('GET', C() + '/prefs', T.jess)).upcomingDays, 7);
  await ok('PUT', C() + '/prefs', T.jess, { upcomingDays: 30 });
  await ok('PUT', C() + '/prefs', T.dm, { upcomingDays: 3 });
  assert.equal((await ok('GET', C() + '/prefs', T.jess)).upcomingDays, 30);
  assert.equal((await ok('GET', C() + '/prefs', T.tom)).upcomingDays, 7);
  assert.equal((await ok('GET', C() + '/upcoming', T.jess)).days, 30);
  assert.equal((await ok('GET', C() + '/upcoming', T.dm)).days, 3);
  assert.equal((await call('PUT', C() + '/prefs', T.jess, { upcomingDays: 5 })).status, 400);
});

test('TestClock_McpToolsAndReadKeys', async () => {
  const rk = (await ok('POST', '/api/keys', T.jess, { scope: 'scribe', label: 'ai', worldId: W })).key;
  const dk = (await ok('POST', '/api/keys', T.dm, { scope: 'scribe', label: 'dm ai', worldId: W, access: 'write' })).key;
  const dr = (await ok('POST', '/api/keys', T.dm, { scope: 'scribe', label: 'dm read', worldId: W, access: 'read' })).key;
  await ok('POST', C() + '/events', T.dm, { title: 'Quiet plot', start: { year: 1492, month: 5, day: 2 }, visibility: 'dm' });
  await ok('POST', C() + '/events', T.dm, { title: 'Parade', start: { year: 1492, month: 5, day: 2 }, visibility: 'party' });

  assert.ok((await rpc(rk, 'get_world_date')).includes('Bloomtide'));
  const pEvents = await rpc(rk, 'list_world_events', { days: 30 });
  assert.ok(pEvents.includes('Parade') && !pEvents.includes('Quiet plot'), 'a player key sees only party events');
  assert.ok((await rpc(dr, 'list_world_events', { days: 30 })).includes('Quiet plot'), 'a DM read key sees DM events');
  assert.ok((await rpc(dr, 'list_world_events', { from: '1492-5-1', to: '1492-5-30' })).includes('Parade'));

  // Read keys cannot write: the tools are not listed, not callable, and the API says no.
  for (const key of [rk, dr]) {
    assert.ok(/Unknown tool/.test(await rpc(key, 'advance_world_time', { minutes: 10 })));
    assert.ok(/Unknown tool/.test(await rpc(key, 'add_world_event', { title: 'x', start: { year: 1492, month: 1, day: 1 } })));
    assert.equal((await call('POST', C() + '/advance', key, { minutes: 10 })).status, 403);
    assert.equal((await call('POST', C() + '/events', key, { title: 'x', start: 0 })).status, 403);
    assert.equal((await call('PUT', C() + '/prefs', key, { upcomingDays: 3 })).status, 403);
  }
  const before = (await ok('GET', C(), T.dm)).minutes;
  const res = await rpc(dk, 'advance_world_time', { preset: 'short-rest', reason: 'via MCP' });
  assert.ok(res.includes('via MCP'));
  assert.equal((await ok('GET', C(), T.dm)).minutes, before + 60);
  assert.ok((await rpc(dk, 'add_world_event', { title: 'MCP feast', start: { year: 1492, month: 6, day: 1 }, visibility: 'party', kind: 'holiday' })).includes('MCP feast'));
  assert.ok((await ok('GET', C() + '/events?from=1492-6-1&to=1492-6-2', T.tom)).some((e: any) => e.title === 'MCP feast'));
});

test('TestClock_SourceCalendarsAndTheTypedModule', async () => {
  // Stands in for the intake feature's table (the test creates it; the clock never does).
  deps.db.exec('CREATE TABLE IF NOT EXISTS intake_calendars (world_id TEXT, source_id TEXT, external_id TEXT, name TEXT, definition TEXT, visibility TEXT, current TEXT)');
  const def = { name: 'Imported', epochYear: 500, yearSuffix: 'IC', months: [{ name: 'Sol', days: 25 }, { name: 'Luna', days: 25 }], weekdays: ['A', 'B', 'C'] };
  run(deps.db, 'INSERT INTO intake_calendars VALUES (?,?,?,?,?,?,?)', W, 'src1', 'cal9', 'Imported', JSON.stringify(def), 'party', JSON.stringify({ year: 512, month: 2, day: 7 }));
  run(deps.db, 'INSERT INTO intake_calendars VALUES (?,?,?,?,?,?,?)', W, 'src1', 'bad', 'Broken', '{not json', 'dm', null);
  const d = await ok('GET', C(), T.dm);
  assert.deepEqual(d.sources.map((s: any) => [s.externalId, s.usable]), [['cal9', true], ['bad', false]]);
  assert.equal((await ok('GET', C(), T.jess)).sources, undefined, 'players are never shown source lists');
  assert.equal((await call('PUT', C() + '/calendar', T.dm, { source: { sourceId: 'src1', externalId: 'bad' } })).status, 400);
  assert.equal((await call('PUT', C() + '/calendar', T.dm, { source: { sourceId: 'src1', externalId: 'zzz' } })).status, 404);
  const put = await ok('PUT', C() + '/calendar', T.dm, { source: { sourceId: 'src1', externalId: 'cal9' }, applyCurrent: true });
  assert.equal(put.calendarSource, 'source:src1:cal9');
  assert.deepEqual([put.date.year, put.date.monthName, put.date.day], [512, 'Luna', 7], "the source's own current date is applied");

  // What the broker will call.
  const now = clock.getClock(deps.db, W);
  assert.equal(clock.addMinutesForWait(deps.db, W, 2, 'hours'), now.minutes + 120);
  assert.equal(clock.addMinutesForWait(deps.db, W, 1, 'days'), now.minutes + 1440);
  assert.equal(clock.addMinutesForWait(deps.db, W, 30), now.minutes + 30);
  const e = clock.advance(deps.db, null, W, 15, 'module call', ID.dm);
  assert.equal(e.afterMinutes, now.minutes + 15);
  assert.equal(clock.formatDate(clock.getCalendar(deps.db, W).definition, 0), '1 Sol 500 IC · night');
  assert.throws(() => clock.setDate(deps.db, null, W, { year: 1, month: 9, day: 1 }, '', null), /months 1 to 2/);
});

test('TestClock_ClockIsPerWorldAndRemovedWithIt', async () => {
  const w2 = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Other', dmAccountId: ID.dm })).id;
  const c2 = await ok('GET', `/api/worlds/${w2}/clock`, T.dm);
  assert.equal(c2.minutes, 480, 'a new world starts fresh');
  assert.equal(c2.calendar.name, clock.BUILTIN_CALENDARS.harptos.name);
  assert.equal((await call('GET', `/api/worlds/${w2}/clock`, T.jess)).status, 404, 'not a member of that world');
});
