// DownTime: the house rule switches it on, players start activities and pick
// in a Downtime round, tiers set the length, the DM adds and takes time,
// stops tasks midway and gives rewards, everything is logged with the world
// date, the Codex link files a learn request, and DM-only parts stay hidden.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { tierByWords } from '../src/features/downtime/suggest.ts';
import { premadeFrom } from '../src/features/downtime/catalog.ts';
import { rollForPick, resolveEvent } from '../src/features/downtime/events.ts';
import { generalEvents, libraryEvents, eventLibrary } from '../src/features/downtime/library.ts';

let base = '';
let server: any;
let deps: any;
let tmp = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const D = () => `/api/worlds/${W}/downtime`;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
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
const task = async (who: string, name: string) => (await ok('GET', `${D()}/tasks?all=1`, T[who])).tasks.find((t: any) => t.name === name);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-downtime-'));
  // No model at all: the helper falls back to its word rules.
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Restwell', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name === 'jess' ? 'Jessamine' : 'Tomas' });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
});

after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('TestDowntime_OffUntilTheHouseRuleIsOn', async () => {
  const r = await call('POST', `${D()}/tasks`, T.jess, { activityId: 'pre-work' });
  assert.equal(r.status, 403);
  const mods = await ok('GET', `/api/worlds/${W}/mods`, T.dm);
  const dt = mods.mods.find((m: any) => m.id === 'downtime');
  assert.ok(dt, 'the rule ships from mods/downtime.alxmod.json');
  assert.equal(dt.feature, 'downtime');
  await ok('PUT', `/api/worlds/${W}/mods/downtime/enabled`, T.dm, { on: true });
  const o = await ok('GET', D(), T.jess);
  assert.equal(o.on, true);
  assert.equal(o.dayHours, 8);
  assert.deepEqual(o.tiers.map((t: any) => `${t.id}:${t.days}`), ['common:1', 'uncommon:3', 'rare:7', 'very-rare:30', 'legendary:90']);
  const acts = (await ok('GET', `${D()}/activities`, T.jess)).activities;
  assert.ok(acts.length >= 15, 'the ready-made activities come from the rule file');
  const vigil = acts.find((a: any) => a.id === 'pre-vigil');
  assert.equal(vigil.tier, 'legendary');
  assert.equal(vigil.hoursPerDay, 1);
  assert.equal(vigil.daysNeeded, 7);
});

test('TestDowntime_RoundPickProgressAndLog', async () => {
  const clockBefore = (await ok('GET', `/api/worlds/${W}/clock`, T.dm)).minutes;
  // Jess starts research (uncommon: 3 days) herself.
  const research = await ok('POST', `${D()}/tasks`, T.jess, { activityId: 'Research lore' });
  assert.equal(research.tier, 'uncommon');
  assert.equal(research.needMin, 3 * 8 * 60);
  // A player cannot start a round; the DM presses Downtime for 2 days.
  assert.equal((await call('POST', `${D()}/rounds`, T.jess, { days: 2 })).status, 403);
  const { round } = await ok('POST', `${D()}/rounds`, T.dm, { days: 2, note: 'Resting in Saltmarsh' });
  assert.equal(round.days, 2);
  assert.equal(round.answers.length, 2);
  assert.ok(round.answers.every((a: any) => a.waiting));
  assert.equal((await ok('GET', `/api/worlds/${W}/clock`, T.dm)).minutes, clockBefore + 2 * 1440, 'the clock moved two days');
  assert.equal((await call('POST', `${D()}/rounds`, T.dm, { days: 1 })).status, 409, 'one round at a time');
  // Too much work for two days is refused.
  assert.equal((await call('POST', `${D()}/rounds/current/pick`, T.jess, { picks: [{ taskId: research.id, days: 3 }] })).status, 400);
  // Jess: 2 days of research plus a 1-hour daily vigil does not fit (16h + 2h > 16h)...
  assert.equal((await call('POST', `${D()}/rounds/current/pick`, T.jess, { picks: [{ taskId: research.id, days: 2 }, { activityId: 'pre-vigil', days: 2 }] })).status, 400);
  assert.equal((await task('jess', 'Legendary vigil'))?.status ?? 'removed', 'removed', 'a refused pick leaves no new task behind');
  // ...but 1 day of research and the vigil does.
  const p = await ok('POST', `${D()}/rounds/current/pick`, T.jess, { picks: [{ taskId: research.id, days: 1 }, { activityId: 'pre-vigil', days: 2 }] });
  assert.equal(p.round.mine.picks.length, 2);
  // She changes her mind: both days on research. The earlier pick is undone.
  await ok('POST', `${D()}/rounds/current/pick`, T.jess, { picks: [{ taskId: research.id, days: 2 }] });
  const r1 = await task('jess', 'Research lore');
  assert.equal(r1.doneMin, 2 * 8 * 60);
  assert.equal(r1.daysLeft, 1);
  assert.equal((await task('jess', 'Legendary vigil')).doneMin, 0);
  // Tom skips.
  await ok('POST', `${D()}/rounds/current/pick`, T.tom, { skip: true });
  const dmView = (await ok('GET', `${D()}/rounds/current`, T.dm)).round;
  assert.equal(dmView.answers.find((a: any) => a.accountId === ID.tom).skipped, true);
  // A player sees only their own answer.
  const jv = (await ok('GET', `${D()}/rounds/current`, T.jess)).round;
  assert.equal(jv.answers, undefined);
  assert.ok(jv.mine);
  await ok('POST', `${D()}/rounds/current/close`, T.dm);
  // The log: when (real and in-world) and how long.
  const log = (await ok('GET', `${D()}/log`, T.jess)).log;
  const work = log.find((l: any) => l.kind === 'work' && !l.undone);
  assert.equal(work.task, 'Research lore');
  assert.equal(work.time, '2 days');
  assert.ok(work.worldDate);
  assert.ok(log.some((l: any) => l.kind === 'work' && l.undone), 'the replaced pick stays in the log, marked undone');
  assert.ok(log.every((l: any) => l.accountId === ID.jess), 'a player reads only their own log');
});

test('TestDowntime_TimeAddedLostRemovedAndRewards', async () => {
  const r1 = await task('jess', 'Research lore');
  // The DM sets a hidden reward and a private note.
  await ok('PATCH', `${D()}/tasks/${r1.id}`, T.dm, { reward: { text: 'The map to the vault', gp: 5, item: 'Old map', hidden: true }, dmNote: 'SECRET-DOWNTIME-NOTE' });
  const seen = await task('jess', 'Research lore');
  assert.deepEqual(seen.reward, { hidden: true });
  assert.equal(seen.dmNote, undefined);
  assert.ok(!JSON.stringify(await ok('GET', D(), T.jess)).includes('SECRET-DOWNTIME-NOTE'));
  assert.ok(!JSON.stringify(await ok('GET', D(), T.jess)).includes('vault'));
  // Time lost, then added: finishing it.
  await ok('POST', `${D()}/tasks/${r1.id}/time`, T.dm, { days: -1, note: 'Fever' });
  assert.equal((await task('jess', 'Research lore')).doneMin, 8 * 60);
  assert.equal((await call('POST', `${D()}/tasks/${r1.id}/time`, T.jess, { days: 1 })).status, 403);
  await ok('POST', `${D()}/tasks/Research lore/time`, T.dm, { player: 'Jessamine', days: 2, note: 'A sage helped' });
  const done = await task('jess', 'Research lore');
  assert.equal(done.status, 'done');
  assert.equal(done.rewardWaiting, true);
  // The DM gives the reward: coin and the item.
  await ok('POST', `${D()}/tasks/${r1.id}/reward`, T.dm, {});
  const after = await task('jess', 'Research lore');
  assert.ok(after.rewardGivenAt);
  assert.equal(after.reward.text, 'The map to the vault', 'revealed once given');
  const inv = await ok('GET', `/api/worlds/${W}/inventory`, T.jess);
  assert.ok(JSON.stringify(inv).includes('Old map'));
  assert.equal((await call('POST', `${D()}/tasks/${r1.id}/reward`, T.dm, {})).status, 409);
  // Tom's legendary craft (180 days) is stopped midway; the work stays in the log.
  const sh = await ok('POST', `${D()}/tasks`, T.dm, { player: 'Tomas', activityId: 'pre-craft-legendary' });
  assert.equal(sh.needMin, 180 * 8 * 60);
  assert.equal(sh.scope, 'personal');
  await ok('POST', `${D()}/tasks/${sh.id}/work`, T.dm, { days: 10, note: 'Foundations' });
  await ok('DELETE', `${D()}/tasks/${sh.id}?note=${encodeURIComponent('Ran out of gold')}`, T.dm);
  const log = (await ok('GET', `${D()}/log?player=Tomas`, T.dm)).log;
  assert.deepEqual(log.slice(0, 3).map((l: any) => l.kind), ['remove', 'work', 'start']);
  assert.equal(log[1].time, '10 days');
  // Jess cannot touch Tom's task.
  assert.equal((await call('DELETE', `${D()}/tasks/${sh.id}`, T.jess)).status, 404);
});

test('TestDowntime_PlayerMadeActivityNeedsTheDm', async () => {
  const { round } = await ok('POST', `${D()}/rounds`, T.dm, { days: 1, advance: false });
  const p = await ok('POST', `${D()}/rounds/current/pick`, T.tom, { picks: [{ activity: { name: 'Forge a dragon-bone blade', summary: 'From the bones we found' } }] });
  const t = await task('tom', 'Forge a dragon-bone blade');
  assert.equal(t.status, 'proposed');
  assert.equal(t.tier, 'legendary', 'word rule: dragon');
  assert.equal(t.doneMin, 8 * 60, 'the day counts while the DM decides');
  assert.ok(p.round.mine);
  assert.equal((await call('PATCH', `${D()}/tasks/${t.id}`, T.tom, { status: 'active' })).status, 409);
  // The DM approves it as rare, 2 days, with a reward.
  const a = await ok('PATCH', `${D()}/tasks/${t.id}`, T.dm, { approve: true, tier: 'rare', days: 2, reward: { item: 'Dragon-bone blade' } });
  assert.equal(a.status, 'active');
  assert.equal(a.needMin, 2 * 8 * 60);
  const acts = (await ok('GET', `${D()}/activities`, T.jess)).activities;
  assert.ok(acts.some((x: any) => x.name === 'Forge a dragon-bone blade' && x.tier === 'rare'), 'approved: on the world\'s list for everyone');
  // Cancelling the round undoes the day.
  await ok('POST', `${D()}/rounds/${round.id}/cancel`, T.dm);
  assert.equal((await task('tom', 'Forge a dragon-bone blade')).doneMin, 0);
  // playerNew off: players cannot make new ones.
  await ok('PUT', `/api/worlds/${W}/mods/downtime/options`, T.dm, { options: { playerNew: 'off' } });
  assert.equal((await call('POST', `${D()}/tasks`, T.jess, { activity: { name: 'Paint a mural' } })).status, 403);
  await ok('PUT', `/api/worlds/${W}/mods/downtime/options`, T.dm, { options: { playerNew: 'approve' } });
});

test('TestDowntime_SuggestAndDecideWithoutAModel', async () => {
  const s = await ok('POST', `${D()}/suggest`, T.jess, { want: 'earn some money' });
  assert.equal(s.picks.length, 3);
  assert.equal(s.by, 'words');
  assert.ok(['Work a job', 'Pit fighting', 'Build a stronghold'].includes(s.picks[0].name), JSON.stringify(s.picks));
  const dec = await ok('POST', `${D()}/decide`, T.jess, { name: 'Pray every morning at the shrine for a month', summary: '' });
  assert.equal(dec.by, 'words');
  assert.equal(dec.hoursPerDay, 1);
  assert.equal(tierByWords('Build a castle'), 'legendary');
  assert.equal(tierByWords('Gather firewood'), 'common');
});

test('TestDowntime_PremadeListIsCheckedData', () => {
  const list = premadeFrom([{ id: 'pre-x', name: 'X', tier: 'rare' }, { id: 'bad', name: 'Y' }, { id: 'pre-z', name: 'Z', tier: 'mythic' }, { id: 'pre-x', name: 'dup' }]);
  assert.deepEqual(list.map((a) => a.id), ['pre-x']);
});

test('TestDowntime_GroupTasksAreSharedApartFromPersonal', async () => {
  const acts = (await ok('GET', `${D()}/activities`, T.jess)).activities;
  assert.ok(acts.find((a: any) => a.id === 'pre-group-drill')?.group, 'group activities come with the rule');
  assert.equal(acts.find((a: any) => a.id === 'pre-work')?.group, false);
  // Jess starts the drill: it belongs to the party, she joins it. Tom starting it joins the same task.
  const g = await ok('POST', `${D()}/tasks`, T.jess, { activityId: 'pre-group-drill' });
  assert.equal(g.scope, 'group');
  assert.equal(g.accountId, 'party');
  assert.deepEqual(g.members, [ID.jess]);
  const again = await ok('POST', `${D()}/tasks`, T.tom, { activityId: 'pre-group-drill' });
  assert.equal(again.id, g.id, 'one shared task, not a second one');
  assert.deepEqual(again.members.sort(), [ID.jess, ID.tom].sort());
  // Both see it on their list, beside their personal tasks; scope filters.
  const tomList = (await ok('GET', `${D()}/tasks`, T.tom)).tasks;
  assert.ok(tomList.some((t: any) => t.id === g.id && t.player === 'The party'));
  assert.ok((await ok('GET', `${D()}/tasks?scope=group`, T.tom)).tasks.every((t: any) => t.scope === 'group'));
  assert.ok((await ok('GET', `${D()}/tasks?scope=personal`, T.jess)).tasks.every((t: any) => t.scope === 'personal' && t.accountId === ID.jess));
  // Rewarded to the party; both put days in during a round, progress is pooled (uncommon: 3 days).
  await ok('PATCH', `${D()}/tasks/${g.id}`, T.dm, { reward: { gp: 30, text: 'Drilled as one' } });
  await ok('POST', `${D()}/rounds`, T.dm, { days: 2, advance: false });
  await ok('POST', `${D()}/rounds/current/pick`, T.jess, { picks: [{ taskId: g.id, days: 2 }] });
  const p = await ok('POST', `${D()}/rounds/current/pick`, T.tom, { picks: [{ activityId: 'pre-group-drill', days: 1 }] });
  assert.equal(p.finished.length, 1, 'two days + one day finish a three-day task');
  await ok('POST', `${D()}/rounds/current/close`, T.dm);
  const done = await task('tom', 'Party training regimen');
  assert.equal(done.status, 'done');
  assert.deepEqual(done.contributions.map((c: any) => [c.accountId, c.minutes]), [[ID.jess, 2 * 8 * 60], [ID.tom, 8 * 60]]);
  // The log shows each one's work to every member.
  const log = (await ok('GET', `${D()}/log?task=${g.id}`, T.tom)).log;
  assert.ok(log.some((l: any) => l.kind === 'work' && l.accountId === ID.jess), 'Tom sees Jess\'s work on the shared task');
  // The reward goes to the party pouch.
  await ok('POST', `${D()}/tasks/${g.id}/reward`, T.dm);
  const led = await ok('GET', `/api/worlds/${W}/live/ledger?owner=party`, T.tom);
  assert.ok(led.entries.some((e: any) => e.note === 'Downtime: Party training regimen' && e.amount_cp === 3000), 'the party pouch gets the coin');
  // Players leave a group task; only the DM pauses or removes it.
  const fest = await ok('POST', `${D()}/tasks`, T.jess, { activityId: 'pre-group-festival' });
  assert.equal((await call('DELETE', `${D()}/tasks/${fest.id}`, T.jess)).status, 403);
  assert.equal((await call('PATCH', `${D()}/tasks/${fest.id}`, T.jess, { status: 'paused' })).status, 403);
  assert.deepEqual((await ok('POST', `${D()}/tasks/${fest.id}/leave`, T.jess)).members, []);
  assert.deepEqual((await ok('POST', `${D()}/tasks/${fest.id}/join`, T.tom)).members, [ID.tom]);
  // The DM gives the whole party a new group task (no player), and a personal one stays personal.
  const camp = await ok('POST', `${D()}/tasks`, T.dm, { group: true, activity: { name: 'Fortify the camp', tier: 'common' } });
  assert.equal(camp.accountId, 'party');
  assert.deepEqual(camp.members, []);
  assert.equal((await call('POST', `${D()}/tasks/${(await task('jess', 'Research lore')).id}/join`, T.jess)).status, 409, 'personal tasks have no members');
  await ok('DELETE', `${D()}/tasks/${fest.id}`, T.dm);
});

test('TestDowntime_RandomEventsAreQuickTimeChecks', async () => {
  const acts = (await ok('GET', `${D()}/activities`, T.tom)).activities;
  const cellar = acts.find((a: any) => a.id === 'pre-cellar');
  assert.ok(cellar.events.some((e: any) => e.title === 'Rats in the cellar!' && e.check === 'Athletics' && e.dc === 12));
  // The DM gives the cellar one event only, and every downtime day has one.
  await ok('PATCH', `${D()}/activities/pre-cellar`, T.dm, { events: [{ title: 'Rats in the cellar!', text: 'A swarm of rats.', check: 'Athletics', dc: 12, success: { text: 'Cleared out', gp: 5 }, failure: { text: 'Bitten', damage: 3, exhaustion: 1, noReward: true } }] });
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { downtimeEventChance: 100 });
  await ok('POST', `${D()}/rounds`, T.dm, { days: 1, advance: false });
  const p = await ok('POST', `${D()}/rounds/current/pick`, T.tom, { picks: [{ activityId: 'pre-cellar', days: 1 }] });
  assert.equal(p.events.length, 1);
  const ev = p.events[0];
  assert.equal(ev.status, 'pending');
  assert.equal(ev.accountId, ID.tom);
  // A new pick replaces the old one, and the event that was not rolled yet goes with it.
  const p2 = await ok('POST', `${D()}/rounds/current/pick`, T.tom, { picks: [{ activityId: 'pre-cellar', days: 1 }] });
  assert.equal((await ok('GET', `${D()}/events?status=cancelled`, T.tom)).events.some((e: any) => e.id === ev.id), true);
  const ev2 = p2.events[0];
  // Jess cannot roll Tom's event; Tom sees it on his overview.
  assert.equal((await call('POST', `${D()}/events/${ev2.id}/roll`, T.jess, { bonus: 2 })).status, 404);
  assert.ok((await ok('GET', D(), T.tom)).events.some((e: any) => e.id === ev2.id));
  // Tom rolls with his own dice: 15 beats DC 12. The bonus coin goes to his purse.
  const before = (await ok('GET', `/api/worlds/${W}/live/ledger`, T.tom)).cp;
  const r = await ok('POST', `${D()}/events/${ev2.id}/roll`, T.tom, { total: 15 });
  assert.equal(r.status, 'success');
  assert.equal((await ok('GET', `/api/worlds/${W}/live/ledger`, T.tom)).cp, before + 500);
  assert.equal((await call('POST', `${D()}/events/${ev2.id}/roll`, T.tom, { total: 15 })).status, 409, 'settled once');
  // A failure: damage and a level of exhaustion on his sheet.
  await ok('POST', `/api/worlds/${W}/sheet/${ID.tom}/vitals`, T.dm, { hp: 20, maxHp: 20 });
  await ok('POST', `${D()}/rounds/current/close`, T.dm);
  await ok('POST', `${D()}/rounds`, T.dm, { days: 1, advance: false });
  const p3 = await ok('POST', `${D()}/rounds/current/pick`, T.tom, { picks: [{ activityId: 'pre-cellar', days: 1 }] });
  const f = await ok('POST', `${D()}/events/${p3.events[0].id}/roll`, T.tom, { total: 4 });
  assert.equal(f.status, 'failure');
  assert.match(f.note, /Athletics 4 vs DC 12, failure: Bitten, 3 damage, \+1 exhaustion, the job fails, no reward/);
  const job = (await ok('GET', `${D()}/tasks?all=1`, T.dm)).tasks.find((x: any) => x.id === p3.events[0].taskId);
  assert.equal(job.rewardWaiting, false, 'a failed job pays nothing');
  const sheet = await ok('GET', `/api/worlds/${W}/sheet/${ID.tom}`, T.tom);
  const v = sheet.vitals ?? sheet;
  assert.equal(v.hp, 17);
  assert.ok(v.conditions.includes('Exhaustion 1'), JSON.stringify(v.conditions));
  // The DM decides or cancels the next one instead of a roll; the log has every event.
  await ok('POST', `${D()}/rounds/current/close`, T.dm);
  await ok('POST', `${D()}/rounds`, T.dm, { days: 1, advance: false });
  const p4 = await ok('POST', `${D()}/rounds/current/pick`, T.tom, { picks: [{ activityId: 'pre-cellar', days: 1 }] });
  assert.equal((await call('POST', `${D()}/events/${p4.events[0].id}/decide`, T.tom, { result: 'success' })).status, 403);
  assert.equal((await ok('POST', `${D()}/events/${p4.events[0].id}/decide`, T.dm, { result: 'cancel' })).status, 'cancelled');
  const log = (await ok('GET', `${D()}/log?player=Tomas`, T.dm)).log.filter((l: any) => l.kind === 'event');
  assert.ok(log.some((l: any) => /success/.test(l.note)) && log.some((l: any) => /failure/.test(l.note)) && log.some((l: any) => /cancelled/.test(l.note)));
  // Taking a round back cancels its unrolled events; chance 0 turns events off.
  await ok('POST', `${D()}/rounds/current/cancel`, T.dm);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { downtimeEventChance: 0 });
  await ok('POST', `${D()}/rounds`, T.dm, { days: 3, advance: false });
  assert.equal((await ok('POST', `${D()}/rounds/current/pick`, T.tom, { picks: [{ activityId: 'pre-cellar', days: 1 }] })).events.length, 0);
  await ok('POST', `${D()}/rounds/current/cancel`, T.dm);
});

test('TestDowntime_FiveDaysAtOnceAndTravelDays', async () => {
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { downtimeEventChance: 0 });
  const t = await ok('POST', `${D()}/tasks`, T.dm, { player: 'Tomas', activity: { name: 'Learn to sail', tier: 'very-rare', days: 20 } });
  // Five downtime days at once: 40 hours to spread over tasks; the clock moves five days.
  const c0 = (await ok('GET', D(), T.dm)).now;
  const { round } = await ok('POST', `${D()}/rounds`, T.dm, { days: 5 });
  assert.equal(round.hours, 40);
  assert.notEqual((await ok('GET', D(), T.dm)).now, c0, 'the world clock moved');
  await ok('POST', `${D()}/rounds/current/pick`, T.tom, { picks: [{ taskId: t.id, days: 5 }] });
  assert.equal((await task('tom', 'Learn to sail')).doneMin, 5 * 8 * 60);
  await ok('POST', `${D()}/rounds/current/close`, T.dm);
  // Travel days: 2 hours a day go to downtime, so 3 days on the road are 6 hours on the task.
  const tr = (await ok('POST', `${D()}/rounds`, T.dm, { days: 3, travel: true, advance: false, note: 'On the road to Saltmarsh' })).round;
  assert.equal(tr.kind, 'travel');
  assert.equal(tr.hoursPerDay, 2);
  assert.equal(tr.hours, 6);
  await ok('POST', `${D()}/rounds/current/pick`, T.tom, { picks: [{ taskId: t.id, days: 3 }] });
  assert.equal((await task('tom', 'Learn to sail')).doneMin, 5 * 8 * 60 + 3 * 2 * 60);
  assert.equal((await call('POST', `${D()}/rounds/current/pick`, T.tom, { picks: [{ taskId: t.id, days: 3 }, { activityId: 'pre-pray', days: 1 }] })).status, 400, 'no time left beyond 6 hours');
  await ok('POST', `${D()}/rounds/current/cancel`, T.dm);
  // A world with no downtime on the road.
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { downtimeTravelHours: 0 });
  assert.equal((await call('POST', `${D()}/rounds`, T.dm, { days: 2, travel: true })).status, 409);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { downtimeTravelHours: 2 });
});

test('TestDowntime_EventLogicHolds', async () => {
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { downtimeEventChance: 100, downtimeAutoReward: true });
  await ok('PATCH', `${D()}/activities/pre-cellar`, T.dm, { events: [{ title: 'Rats', check: 'Athletics', dc: 12, success: { gp: 5 }, failure: { text: 'Bitten', noReward: true } }] });
  // 1. Changing the pick does not dodge or re-roll an event on the same task.
  await ok('POST', `${D()}/rounds`, T.dm, { days: 2, advance: false });
  const a1 = await ok('POST', `${D()}/rounds/current/pick`, T.tom, { picks: [{ activityId: 'pre-cellar', days: 1 }] });
  assert.equal(a1.events.length, 1);
  const cellarTask = a1.events[0].taskId;
  // 2. Auto rewards wait for a waiting event: the cellar is done but not paid yet.
  let ct = (await ok('GET', `${D()}/tasks?all=1`, T.dm)).tasks.find((x: any) => x.id === cellarTask);
  assert.equal(ct.status, 'done');
  assert.equal(ct.rewardGivenAt, null, 'held for the event');
  const long = await ok('POST', `${D()}/tasks`, T.dm, { player: 'Tomas', activity: { name: 'Long study', tier: 'legendary' } });
  const b1 = await ok('POST', `${D()}/rounds/current/pick`, T.tom, { picks: [{ taskId: long.id, days: 1 }] });
  assert.equal(b1.events.length, 1, 'the general events cover a one-off task');
  const b2 = await ok('POST', `${D()}/rounds/current/pick`, T.tom, { picks: [{ taskId: long.id, days: 2 }] });
  assert.equal(b2.events.length, 0, 'the same task in a new pick: no new roll');
  const pend = (await ok('GET', `${D()}/events?status=pending`, T.tom)).events;
  assert.equal(pend.filter((e: any) => e.taskId === long.id).length, 1, 'its event still waits');
  assert.equal(pend.filter((e: any) => e.taskId === cellarTask).length, 0, 'the cellar left the pick, so its event went with it');
  const purse0 = (await ok('GET', `/api/worlds/${W}/live/ledger`, T.tom)).cp;
  void purse0;
  await ok('POST', `${D()}/rounds/current/close`, T.dm);
  // A failed job pays nothing, even with auto rewards on.
  await ok('POST', `${D()}/rounds`, T.dm, { days: 1, advance: false });
  const f1 = await ok('POST', `${D()}/rounds/current/pick`, T.tom, { picks: [{ activityId: 'pre-cellar', days: 1 }] });
  const purseF = (await ok('GET', `/api/worlds/${W}/live/ledger`, T.tom)).cp;
  await ok('POST', `${D()}/events/${f1.events[0].id}/roll`, T.tom, { total: 2 });
  ct = (await ok('GET', `${D()}/tasks?all=1`, T.dm)).tasks.find((x: any) => x.id === f1.events[0].taskId);
  assert.equal(ct.rewardWaiting, false);
  assert.equal(ct.rewardGivenAt, null);
  assert.equal((await ok('GET', `/api/worlds/${W}/live/ledger`, T.tom)).cp, purseF, 'no pay');
  await ok('POST', `${D()}/rounds/current/close`, T.dm);
  // 3. A success: the held reward is paid the moment the event is settled, with the event's bonus.
  await ok('POST', `${D()}/rounds`, T.dm, { days: 1, advance: false });
  const a2 = await ok('POST', `${D()}/rounds/current/pick`, T.tom, { picks: [{ activityId: 'pre-cellar', days: 1 }] });
  const purse1 = (await ok('GET', `/api/worlds/${W}/live/ledger`, T.tom)).cp;
  await ok('POST', `${D()}/events/${a2.events[0].id}/roll`, T.tom, { total: 20 });
  assert.equal((await ok('GET', `/api/worlds/${W}/live/ledger`, T.tom)).cp, purse1 + 500 + 100, '5 gp bonus and the 1 gp job');
  // 4. Taking the round back undoes the event's coin too.
  const back = await ok('POST', `${D()}/rounds/current/cancel`, T.dm);
  assert.equal(back.eventsUndone, 1);
  assert.equal((await ok('GET', `/api/worlds/${W}/live/ledger`, T.tom)).cp, purse1 + 100, 'the bonus is gone; the reward paid stays the DM\'s call');
  // 5. A loss never takes more than the purse holds.
  await ok('PATCH', `${D()}/activities/pre-cellar`, T.dm, { events: [{ title: 'Fined', success: { gp: -100000 } }] });
  await ok('POST', `${D()}/rounds`, T.dm, { days: 1, advance: false });
  const a3 = await ok('POST', `${D()}/rounds/current/pick`, T.tom, { picks: [{ activityId: 'pre-cellar', days: 1 }] });
  await ok('POST', `${D()}/events/${a3.events[0].id}/roll`, T.tom, {});
  assert.equal((await ok('GET', `/api/worlds/${W}/live/ledger`, T.tom)).cp, 0);
  await ok('POST', `${D()}/rounds/current/close`, T.dm);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { downtimeEventChance: 10, downtimeAutoReward: false });
});

test('TestDowntime_EventChanceIsPerDayAndTravelIsAShare', () => {
  // The engine on its own with a fixed roll: a travel day of 2 of 8 hours has a quarter of the chance.
  const db = deps.db;
  const t = db.prepare("SELECT * FROM downtime_tasks WHERE world_id = ? AND activity_id = 'pre-cellar' LIMIT 1").get(W);
  db.prepare("UPDATE worlds SET settings = json_set(COALESCE(settings, '{}'), '$.downtimeEventChance', 40) WHERE id = ?").run(W);
  const d = { db, hub: { emit() {} } };
  const at = (n: number) => (lo: number, hi: number) => (hi === 1000 ? n : lo);
  const full = { id: 'sim-full', day_min: null };
  const travel = { id: 'sim-travel', day_min: 120 };
  assert.equal(rollForPick(d as any, W, full, ID.tom, [{ taskId: t.id, days: 1 }], at(400)).length, 1, '40% full day: a 400 in 1000 hits');
  assert.equal(rollForPick(d as any, W, travel, ID.tom, [{ taskId: t.id, days: 1 }], at(101)).length, 0, 'travel: 10% of 1000 is the line');
  assert.equal(rollForPick(d as any, W, { id: 'sim-travel-2', day_min: 120 }, ID.tom, [{ taskId: t.id, days: 1 }], at(100)).length, 1);
});

test('TestDowntime_EventLibraryCoversEveryActivity', async () => {
  // About 500 ready-made events: every ready-made activity has its own list, and a one-off task uses the general one.
  const lib = eventLibrary();
  const acts = (await ok('GET', `${D()}/activities`, T.dm)).activities.filter((a: any) => a.source === 'premade');
  assert.ok(acts.length >= 23);
  for (const a of acts) assert.ok(libraryEvents(a.id).length >= 20, `${a.id} has ${libraryEvents(a.id).length} events`);
  assert.ok(generalEvents().length >= 20);
  const total = [...lib.values()].reduce((n, l) => n + l.length, 0);
  assert.ok(total >= 500, `${total} events`);
  for (const [k, l] of lib) {
    assert.ok(k === '_general' || acts.some((a: any) => a.id === k), `${k} is a real activity`);
    for (const e of l) {
      assert.ok(e.text && e.title, `${k}/${e.id} has a title and text`);
      if (e.check) assert.ok(e.dc >= 8 && e.dc <= 20, `${k}/${e.id} DC ${e.dc}`);
      else assert.ok(!e.failure.text && !e.failure.cp && !e.failure.days, `${k}/${e.id}: no check, so no failure`);
    }
  }
});

test('TestDowntime_EveryLibraryEventSettlesBothWays', async () => {
  // Fire every event in the library, then settle it as a success and again as a failure: none throws, each applies.
  const db = deps.db;
  const d = { db, hub: { emit() {} } };
  const t = await ok('POST', `${D()}/tasks`, T.dm, { player: 'Tomas', activity: { name: 'Event soak', tier: 'legendary', days: 3650 } });
  await ok('POST', `/api/worlds/${W}/sheet/${ID.tom}/vitals`, T.dm, { hp: 500, maxHp: 500 });
  db.prepare("INSERT INTO ledger (id, world_id, owner, amount_cp, status, note, by_id, at) VALUES ('soak-seed', ?, ?, 100000000, 'approved', 'soak', ?, ?)").run(W, ID.tom, ID.dm, new Date().toISOString());
  let n = 0;
  for (const [k, list] of eventLibrary()) {
    for (const ev of list) {
      for (const result of ['success', 'failure'] as const) {
        const eid = `soak-${n++}`;
        db.prepare("INSERT INTO downtime_events (id, world_id, round_id, task_id, task_name, account_id, event, status, created_at) VALUES (?,?,NULL,?,?,?,?,'pending',?)").run(eid, W, t.id, 'Event soak', ID.tom, JSON.stringify(ev), new Date().toISOString());
        const r = resolveEvent(d as any, W, eid, { result }, ID.dm);
        assert.equal(r.event.status, result, `${k}/${ev.id}`);
        assert.ok(r.event.note, `${k}/${ev.id} has a result line`);
      }
    }
  }
  assert.ok(n >= 1000);
  db.prepare("DELETE FROM ledger WHERE world_id = ? AND owner = ?").run(W, ID.tom);
  await ok('POST', `/api/worlds/${W}/sheet/${ID.tom}/vitals`, T.dm, { hp: 20, maxHp: 20, conditions: [] });
});
