// Downtime's data: the world's activities (the shipped ones merged with the
// world's own), each character's tasks with their progress, downtime rounds
// (the GM's Downtime button) with each player's pick, and a log of every
// change with the real time and the in-world date it happened.
import type { DB } from '../../core/db.ts';
import { all, one, run, tx as begin } from '../../core/db.ts';
import type { EventHub } from '../../core/events.ts';
import { dmAnd } from '../../core/events.ts';
import { DEFAULT_SETTINGS, featureSetting, type WorldSettings } from '../../core/policy.ts';
import { HttpError, id, now, parseJson } from '../../core/util.ts';
import { getClock } from '../clock/api.ts';
import {
  DEFAULT_TIER_DAYS, MAX_DAYS, TIERS, premadeFrom, TIER_LABEL, checkActivity, checkReward, hasReward, tierOf,
  type Activity, type Link, type Reward, type Tier,
} from './catalog.ts';
import { linkFor } from './hooks.ts';

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS downtime_activities (
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    json TEXT NOT NULL,
    source TEXT NOT NULL,            -- premade (a changed copy of a shipped one) | dm | player
    status TEXT NOT NULL DEFAULT 'ok', -- ok | proposed (a player's, waiting for the GM) | hidden
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (world_id, id)
  );
  CREATE TABLE IF NOT EXISTS downtime_tasks (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,          -- the character, or 'party' for a group task
    scope TEXT NOT NULL DEFAULT 'personal', -- personal | group
    members TEXT NOT NULL DEFAULT '[]', -- a group task: the characters who joined it
    activity_id TEXT,
    name TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    tier TEXT NOT NULL,
    need_min INTEGER NOT NULL,
    done_min INTEGER NOT NULL DEFAULT 0,
    per_day_min INTEGER NOT NULL,
    status TEXT NOT NULL,            -- active | paused | proposed | done | removed
    reward TEXT NOT NULL DEFAULT '{}',
    reward_given_at TEXT,
    link TEXT,
    dm_note TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_world INTEGER,
    finished_world INTEGER,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS downtime_tasks_world ON downtime_tasks(world_id, account_id, status);
  CREATE TABLE IF NOT EXISTS downtime_rounds (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    days INTEGER NOT NULL,
    status TEXT NOT NULL,            -- open | closed | cancelled
    note TEXT NOT NULL DEFAULT '',
    world_start INTEGER,
    world_label TEXT NOT NULL DEFAULT '',
    clock_entry TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS downtime_rounds_world ON downtime_rounds(world_id, status);
  CREATE TABLE IF NOT EXISTS downtime_picks (
    round_id TEXT NOT NULL REFERENCES downtime_rounds(id) ON DELETE CASCADE,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    picks TEXT NOT NULL DEFAULT '[]',
    skipped INTEGER NOT NULL DEFAULT 0,
    by_id TEXT,
    at TEXT NOT NULL,
    PRIMARY KEY (round_id, account_id)
  );
  CREATE TABLE IF NOT EXISTS downtime_log (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    task_id TEXT,
    task_name TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,              -- start | work | time | skip | missed | pause | resume | remove | edit | approve | complete | reward | join | leave
    minutes INTEGER NOT NULL DEFAULT 0,
    round_id TEXT,
    world_minutes INTEGER,
    world_label TEXT NOT NULL DEFAULT '',
    by_id TEXT,
    note TEXT NOT NULL DEFAULT '',
    undone INTEGER NOT NULL DEFAULT 0,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS downtime_log_world ON downtime_log(world_id, account_id, at);
`;

/** A transaction that joins the caller's when there is one (downtime steps call each other). */
const depth = new WeakMap<DB, number>();
export function tx<T>(db: DB, fn: () => T): T {
  const n = depth.get(db) ?? 0;
  depth.set(db, n + 1);
  try { return n ? fn() : begin(db, fn); } finally { depth.set(db, n); }
}

export type Status = 'active' | 'paused' | 'proposed' | 'done' | 'removed';
const OPEN: Status[] = ['active', 'paused', 'proposed'];

export const worldSettings = (db: DB, worldId: string): WorldSettings => ({ ...DEFAULT_SETTINGS, ...parseJson(one<any>(db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings, {}) });
export const isOn = (s: WorldSettings) => featureSetting<boolean>(s, 'downtimeOn') === true;
export const dayHours = (s: WorldSettings) => featureSetting<number>(s, 'downtimeDayHours') || 8;
export const tierDays = (s: WorldSettings): Record<Tier, number> => ({ ...DEFAULT_TIER_DAYS, ...(featureSetting<Record<string, number>>(s, 'downtimeTierDays') ?? {}) });
/** Work days an activity takes in this world. */
export const daysFor = (s: WorldSettings, a: Pick<Activity, 'days' | 'tier'>) => a.days ?? tierDays(s)[a.tier];

/** "3 days", "1 day 4 hours", "6 hours" (a day is the world's downtime day length). */
export function span(minutes: number, hoursPerDay: number): string {
  const m = Math.max(0, Math.round(minutes));
  const day = hoursPerDay * 60;
  const d = Math.floor(m / day);
  const h = Math.round((m - d * day) / 60);
  const parts = [d && `${d} day${d === 1 ? '' : 's'}`, h && `${h} hour${h === 1 ? '' : 's'}`].filter(Boolean);
  return parts.join(' ') || '0 hours';
}

// ---- activities --------------------------------------------------------------------------------------------------------

export interface ActivityRow extends Activity { source: 'premade' | 'dm' | 'player'; status: 'ok' | 'proposed' | 'hidden'; createdBy: string | null; changed: boolean }

/** Every activity of the world: shipped ones (or the world's changed copy), then the world's own. */
export function activities(db: DB, worldId: string): ActivityRow[] {
  const rows = all<any>(db, 'SELECT * FROM downtime_activities WHERE world_id = ? ORDER BY created_at, id', worldId);
  const by = new Map(rows.map((r) => [r.id, r]));
  const out: ActivityRow[] = premadeFrom(featureSetting(worldSettings(db, worldId), 'downtimePremade')).map((p) => {
    const r = by.get(p.id);
    if (!r) return { ...p, source: 'premade', status: 'ok', createdBy: null, changed: false };
    return { ...checkActivity(parseJson(r.json, {}), p.id), source: 'premade', status: r.status, createdBy: null, changed: true };
  });
  for (const r of rows) {
    if (r.id.startsWith('pre-') && out.some((x) => x.id === r.id)) continue;
    try { out.push({ ...checkActivity(parseJson(r.json, {}), r.id), source: r.source, status: r.status, createdBy: r.created_by, changed: r.source === 'premade' }); } catch { /* a row from an older format */ }
  }
  return out;
}
export function activity(db: DB, worldId: string, aid: string): ActivityRow {
  const a = activities(db, worldId).find((x) => x.id === aid);
  if (!a) throw new HttpError(404, 'Activity not found');
  return a;
}

export function saveActivity(db: DB, worldId: string, raw: any, by: string, source: 'dm' | 'player', status: 'ok' | 'proposed'): ActivityRow {
  const aid = id('dta_');
  const a = checkActivity(raw, aid);
  if (one<any>(db, "SELECT COUNT(*) AS n FROM downtime_activities WHERE world_id = ?", worldId)!.n >= 500) throw new HttpError(409, 'This world has 500 activities; remove some first');
  run(db, 'INSERT INTO downtime_activities (world_id, id, json, source, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', worldId, aid, JSON.stringify(a), source, status, by, now(), now());
  return activity(db, worldId, aid);
}

/** The GM changes an activity. A shipped one gets a world copy (its id stays). */
export function updateActivity(db: DB, worldId: string, aid: string, patch: any): ActivityRow {
  const cur = activity(db, worldId, aid);
  const { source, status, createdBy, changed, ...base } = cur;
  const next = checkActivity({ ...base, ...patch, reward: patch?.reward === undefined ? base.reward : patch.reward }, aid);
  const st = patch?.status === 'hidden' || patch?.status === 'ok' ? patch.status : status === 'proposed' ? 'ok' : status;
  if (one(db, 'SELECT 1 FROM downtime_activities WHERE world_id = ? AND id = ?', worldId, aid)) run(db, 'UPDATE downtime_activities SET json = ?, status = ?, updated_at = ? WHERE world_id = ? AND id = ?', JSON.stringify(next), st, now(), worldId, aid);
  else run(db, "INSERT INTO downtime_activities (world_id, id, json, source, status, created_by, created_at, updated_at) VALUES (?,?,?,'premade',?,NULL,?,?)", worldId, aid, JSON.stringify(next), st, now(), now());
  return activity(db, worldId, aid);
}

/** Remove the world's own activity, or hide a shipped one. Tasks already started keep going. */
export function removeActivity(db: DB, worldId: string, aid: string) {
  const a = activity(db, worldId, aid);
  if (a.id.startsWith('pre-')) updateActivity(db, worldId, aid, { status: 'hidden' });
  else run(db, 'DELETE FROM downtime_activities WHERE world_id = ? AND id = ?', worldId, aid);
}

// ---- tasks -------------------------------------------------------------------------------------------------------------

export interface Task {
  id: string; accountId: string; activityId: string | null; name: string; summary: string; tier: Tier; tierLabel: string;
  needMin: number; doneMin: number; perDayMin: number; status: Status; percent: number;
  needLabel: string; doneLabel: string; leftLabel: string; daysLeft: number;
  reward: Reward | { hidden: true }; rewardGivenAt: string | null; rewardWaiting: boolean;
  link: Link | null; createdBy: string | null; createdAt: string; updatedAt: string;
  startedWorld: number | null; finishedWorld: number | null; finishedAt: string | null;
  dmNote?: string;
  scope: 'personal' | 'group';
  /** A group task: who joined, and how much each has put in. */
  members: string[];
  contributions: { accountId: string; minutes: number; label: string }[];
}

export const PARTY = 'party';
export const isGroup = (r: any) => r?.scope === 'group';
export const membersOf = (r: any): string[] => parseJson<string[]>(r?.members, []);

export function taskOut(db: DB, s: WorldSettings, r: any, dm: boolean): Task {
  const reward = checkReward(parseJson(r.reward, {}));
  const left = Math.max(0, r.need_min - r.done_min);
  return {
    id: r.id, accountId: r.account_id, activityId: r.activity_id, name: r.name, summary: r.summary, tier: r.tier, tierLabel: TIER_LABEL[r.tier as Tier] ?? r.tier,
    needMin: r.need_min, doneMin: r.done_min, perDayMin: r.per_day_min, status: r.status,
    percent: r.need_min ? Math.min(100, Math.round((r.done_min / r.need_min) * 100)) : 100,
    needLabel: span(r.need_min, r.per_day_min / 60), doneLabel: span(r.done_min, r.per_day_min / 60), leftLabel: span(left, r.per_day_min / 60),
    daysLeft: Math.ceil(left / r.per_day_min),
    reward: dm || !reward.hidden || r.reward_given_at ? reward : { hidden: true },
    rewardGivenAt: r.reward_given_at ?? null, rewardWaiting: r.status === 'done' && !r.reward_given_at && hasReward(reward),
    link: parseJson<Link | null>(r.link, null), createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
    startedWorld: r.started_world ?? null, finishedWorld: r.finished_world ?? null, finishedAt: r.finished_at ?? null,
    ...(dm ? { dmNote: r.dm_note } : {}),
    scope: isGroup(r) ? 'group' : 'personal',
    members: membersOf(r),
    contributions: isGroup(r) ? all<any>(db, "SELECT account_id, SUM(minutes) AS m FROM downtime_log WHERE world_id = ? AND task_id = ? AND kind = 'work' AND undone = 0 AND account_id != 'party' GROUP BY account_id ORDER BY m DESC", r.world_id, r.id)
      .filter((x) => x.m > 0).map((x) => ({ accountId: x.account_id, minutes: x.m, label: span(x.m, r.per_day_min / 60) })) : [],
  };
}

export const taskRow = (db: DB, worldId: string, tid: string) => one<any>(db, 'SELECT * FROM downtime_tasks WHERE world_id = ? AND id = ?', worldId, tid);
export function mustTask(db: DB, worldId: string, tid: string, viewer: { accountId: string; dm: boolean }) {
  const r = taskRow(db, worldId, tid);
  if (!r || (!viewer.dm && r.account_id !== viewer.accountId && !isGroup(r))) throw new HttpError(404, 'Task not found');
  return r;
}

/** Tasks: one character's (with withGroup, the party's group tasks too), or everyone's. scope filters personal or group. */
export function listTasks(db: DB, worldId: string, opts: { accountId?: string; status?: string; open?: boolean; withGroup?: boolean; scope?: 'personal' | 'group' } = {}): any[] {
  const where = ['world_id = ?'];
  const args: unknown[] = [worldId];
  if (opts.accountId) { where.push(opts.withGroup ? "(account_id = ? OR scope = 'group')" : 'account_id = ?'); args.push(opts.accountId); }
  if (opts.scope) { where.push('scope = ?'); args.push(opts.scope); }
  if (opts.status) { where.push('status = ?'); args.push(opts.status); } else if (opts.open) where.push(`(status IN (${OPEN.map(() => '?').join(',')}) OR (status = 'done' AND reward_given_at IS NULL AND (COALESCE(json_extract(reward, '$.text'), '') != '' OR COALESCE(json_extract(reward, '$.cp'), 0) > 0 OR COALESCE(json_extract(reward, '$.item'), '') != '')))`), args.push(...OPEN);
  return all<any>(db, `SELECT * FROM downtime_tasks WHERE ${where.join(' AND ')} ORDER BY (status = 'done'), (status = 'removed'), updated_at DESC LIMIT 500`, ...args);
}

interface LogIn { accountId: string; taskId?: string | null; taskName?: string; kind: string; minutes?: number; roundId?: string | null; by: string | null; note?: string }
export function writeLog(db: DB, worldId: string, e: LogIn): string {
  const c = getClock(db, worldId);
  const lid = id('dtl_');
  run(db, 'INSERT INTO downtime_log (id, world_id, account_id, task_id, task_name, kind, minutes, round_id, world_minutes, world_label, by_id, note, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    lid, worldId, e.accountId, e.taskId ?? null, (e.taskName ?? '').slice(0, 120), e.kind, Math.round(e.minutes ?? 0), e.roundId ?? null, c.minutes, c.label, e.by, (e.note ?? '').slice(0, 400), now());
  return lid;
}

export interface NewTask { activity: Activity; accountId: string; group?: boolean; status?: Status; reward?: Reward; dmNote?: string; by: string; note?: string }
export function startTask(db: DB, worldId: string, t: NewTask): any {
  const s = worldSettings(db, worldId);
  const perDay = Math.min(t.activity.hoursPerDay, dayHours(s)) * 60;
  const need = daysFor(s, t.activity) * perDay;
  // A group task belongs to the party; the character who starts it joins it.
  const group = t.group ?? t.activity.group;
  const owner = group ? PARTY : t.accountId;
  const members = group && t.accountId !== PARTY ? [t.accountId] : [];
  const open = one<any>(db, `SELECT COUNT(*) AS n FROM downtime_tasks WHERE world_id = ? AND account_id = ? AND status IN ('active','paused','proposed')`, worldId, owner)!.n;
  if (open >= 30) throw new HttpError(409, `${group ? 'The party has' : 'This character has'} 30 unfinished tasks; finish or remove some first`);
  if (t.activity.id && !t.activity.repeatable && one(db, `SELECT 1 FROM downtime_tasks WHERE world_id = ? AND account_id = ? AND activity_id = ? AND status IN ('active','paused','proposed')`, worldId, owner, t.activity.id)) {
    throw new HttpError(409, `${t.activity.name} is already on ${group ? "the party's" : "this character's"} list`);
  }
  const tid = id('dtt_');
  const c = getClock(db, worldId);
  run(db, `INSERT INTO downtime_tasks (id, world_id, account_id, scope, members, activity_id, name, summary, tier, need_min, done_min, per_day_min, status, reward, link, dm_note, created_by, created_at, updated_at, started_world)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?)`,
    tid, worldId, owner, group ? 'group' : 'personal', JSON.stringify(members), t.activity.id || null, t.activity.name, t.activity.summary, t.activity.tier, need, perDay, t.status ?? 'active',
    JSON.stringify(t.reward ?? t.activity.reward), t.activity.link ? JSON.stringify(t.activity.link) : null, (t.dmNote ?? '').slice(0, 1000), t.by, now(), now(), c.minutes);
  writeLog(db, worldId, { accountId: owner, taskId: tid, taskName: t.activity.name, kind: 'start', by: t.by, note: t.note ?? `${group ? 'Group, ' : ''}${TIER_LABEL[t.activity.tier]}, ${span(need, perDay / 60)}` });
  return taskRow(db, worldId, tid);
}

/** A character joins (or leaves) a group task. Their work stays in it either way. */
export function setMember(db: DB, worldId: string, tid: string, aid: string, join: boolean, by: string): any {
  return tx(db, () => {
    const r = taskRow(db, worldId, tid);
    if (!r || !isGroup(r)) throw new HttpError(404, 'Group task not found');
    if (r.status === 'removed' || (r.status === 'done' && join)) throw new HttpError(409, `${r.name} is ${r.status === 'done' ? 'finished' : 'removed'}`);
    const m = membersOf(r);
    if (join === m.includes(aid)) return r;
    const next = join ? [...m, aid] : m.filter((x) => x !== aid);
    run(db, 'UPDATE downtime_tasks SET members = ?, updated_at = ? WHERE id = ?', JSON.stringify(next), now(), tid);
    writeLog(db, worldId, { accountId: aid, taskId: tid, taskName: r.name, kind: join ? 'join' : 'leave', by });
    return taskRow(db, worldId, tid);
  });
}

/** What happened to a task, for the caller to announce: finished now (a reward may wait), or nothing. */
export interface Progress { row: any; finished: boolean; logId: string }

/**
 * Add (or take away, minutes < 0) work on a task. Logged; a task that reaches its time is done (unless it is still a
 * proposal waiting for the GM), and its link's onComplete runs.
 */
export function addWork(d: { db: DB; hub: EventHub }, worldId: string, tid: string, minutes: number, e: { kind: 'work' | 'time'; by: string | null; roundId?: string | null; note?: string; worker?: string }): Progress {
  const { db } = d;
  return tx(db, () => {
    const r = taskRow(db, worldId, tid);
    if (!r) throw new HttpError(404, 'Task not found');
    if (r.status === 'removed') throw new HttpError(409, 'That task was removed');
    if (e.kind === 'work' && r.status === 'done') throw new HttpError(409, `${r.name} is already finished`);
    const done = Math.max(0, r.done_min + Math.round(minutes));
    const delta = done - r.done_min;
    run(db, 'UPDATE downtime_tasks SET done_min = ?, updated_at = ? WHERE id = ?', done, now(), tid);
    // On a group task the log row names the character who did the work (the party when the GM changes the time).
    const who = e.worker ?? r.account_id;
    const logId = writeLog(db, worldId, { accountId: who, taskId: tid, taskName: r.name, kind: e.kind, minutes: delta, roundId: e.roundId, by: e.by, note: e.note });
    let finished = false;
    if (r.status === 'done' && done < r.need_min) {
      // Time taken away from a finished task opens it again.
      run(db, "UPDATE downtime_tasks SET status = 'active', finished_world = NULL, finished_at = NULL WHERE id = ?", tid);
      writeLog(db, worldId, { accountId: r.account_id, taskId: tid, taskName: r.name, kind: 'resume', by: e.by, note: 'Not finished after all' });
    }
    finished = maybeFinish(d, worldId, tid, e.by);
    if (delta > 0) d.hub.emit(worldId, 'downtime-day', { accountId: who, taskId: tid, minutes: delta, link: parseJson(r.link, null), activityId: r.activity_id, group: isGroup(r) }, dmAnd(who));
    return { row: taskRow(db, worldId, tid), finished, logId };
  });
}

/** Finish a task whose time is done. Runs inside the caller's transaction. */
export function maybeFinish(d: { db: DB; hub: EventHub }, worldId: string, tid: string, by: string | null): boolean {
  const { db } = d;
  const r = taskRow(db, worldId, tid);
  if (!r || r.status !== 'active' || r.done_min < r.need_min) return false;
  const c = getClock(db, worldId);
  run(db, "UPDATE downtime_tasks SET status = 'done', finished_world = ?, finished_at = ?, updated_at = ? WHERE id = ?", c.minutes, now(), now(), tid);
  const started = r.started_world ?? c.minutes;
  writeLog(db, worldId, { accountId: r.account_id, taskId: tid, taskName: r.name, kind: 'complete', by, note: `Finished after ${span(r.done_min, r.per_day_min / 60)} of work over ${Math.max(1, Math.round((c.minutes - started) / 1440))} in-world day(s)` });
  const link = parseJson<Link | null>(r.link, null);
  const h = link ? linkFor(link.kind) : null;
  if (h?.onComplete) {
    try { const note = h.onComplete(d, worldId, { ...r, status: 'done' }, link!); if (note) writeLog(db, worldId, { accountId: r.account_id, taskId: tid, taskName: r.name, kind: 'edit', by, note }); } catch (err: any) {
      writeLog(db, worldId, { accountId: r.account_id, taskId: tid, taskName: r.name, kind: 'edit', by, note: `Could not finish the link: ${String(err?.message ?? err).slice(0, 200)}` });
    }
  }
  return true;
}

export function setStatus(d: { db: DB; hub: EventHub }, worldId: string, tid: string, status: 'active' | 'paused' | 'removed', by: string, note = ''): any {
  const { db } = d;
  return tx(db, () => {
    const r = taskRow(db, worldId, tid);
    if (!r) throw new HttpError(404, 'Task not found');
    if (r.status === status) return r;
    if (r.status === 'removed') throw new HttpError(409, 'That task was removed');
    if (r.status === 'done' && status !== 'removed') throw new HttpError(409, `${r.name} is already finished`);
    if (r.status === 'proposed' && status === 'active') throw new HttpError(409, 'The GM has not approved this activity yet');
    run(db, 'UPDATE downtime_tasks SET status = ?, updated_at = ? WHERE id = ?', status, now(), tid);
    const kind = status === 'removed' ? 'remove' : status === 'paused' ? 'pause' : 'resume';
    writeLog(db, worldId, { accountId: r.account_id, taskId: tid, taskName: r.name, kind, by, note: note || (status === 'removed' ? `Stopped with ${span(r.done_min, r.per_day_min / 60)} done` : '') });
    if (status === 'active') maybeFinish(d, worldId, tid, by);
    return taskRow(db, worldId, tid);
  });
}

/** The GM edits a task: name, tier, length (in days), hours a day, reward, private note. Approves a proposal. */
export function editTask(d: { db: DB; hub: EventHub }, worldId: string, tid: string, b: any, by: string): any {
  const { db } = d;
  return tx(db, () => {
    const r = taskRow(db, worldId, tid);
    if (!r) throw new HttpError(404, 'Task not found');
    if (r.status === 'removed') throw new HttpError(409, 'That task was removed');
    const s = worldSettings(db, worldId);
    const tier = b.tier === undefined ? r.tier : tierOf(b.tier);
    if (!tier) throw new HttpError(400, `tier must be one of: ${TIERS.join(', ')}`);
    const name = b.name === undefined ? r.name : String(b.name).trim().slice(0, 80) || r.name;
    const summary = b.summary === undefined ? r.summary : String(b.summary).slice(0, 600);
    const hpd = b.hoursPerDay === undefined ? r.per_day_min / 60 : Number(b.hoursPerDay);
    if (!Number.isInteger(hpd) || hpd < 1 || hpd > 24) throw new HttpError(400, 'hoursPerDay must be a whole number from 1 to 24');
    const perDay = Math.min(hpd, dayHours(s)) * 60;
    let days: number;
    if (b.days !== undefined && b.days !== null) {
      days = Number(b.days);
      if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new HttpError(400, `days must be a whole number from 1 to ${MAX_DAYS}`);
    } else if (b.tier !== undefined && tier !== r.tier) days = tierDays(s)[tier as Tier];
    else days = Math.max(1, Math.round(r.need_min / r.per_day_min));
    const need = days * perDay;
    const reward = b.reward === undefined ? parseJson(r.reward, {}) : checkReward(b.reward);
    const dmNote = b.dmNote === undefined ? r.dm_note : String(b.dmNote).slice(0, 1000);
    const approve = r.status === 'proposed' && b.approve === true;
    run(db, 'UPDATE downtime_tasks SET name = ?, summary = ?, tier = ?, per_day_min = ?, need_min = ?, reward = ?, dm_note = ?, status = ?, updated_at = ? WHERE id = ?',
      name, summary, tier, perDay, need, JSON.stringify(reward), dmNote, approve ? 'active' : r.status, now(), tid);
    const changes = [name !== r.name && `name ${name}`, tier !== r.tier && `tier ${TIER_LABEL[tier as Tier]}`, need !== r.need_min && `length ${span(need, perDay / 60)}`, perDay !== r.per_day_min && `${hpd} hours a day`, b.reward !== undefined && 'reward'].filter(Boolean);
    if (changes.length || approve) writeLog(db, worldId, { accountId: r.account_id, taskId: tid, taskName: name, kind: approve ? 'approve' : 'edit', by, note: changes.join(', ') });
    if (approve && r.activity_id) run(db, "UPDATE downtime_activities SET status = 'ok', json = json_set(json, '$.tier', ?, '$.days', ?, '$.hoursPerDay', ?), updated_at = ? WHERE world_id = ? AND id = ? AND status = 'proposed'", tier, days, hpd, now(), worldId, r.activity_id);
    maybeFinish(d, worldId, tid, by);
    return taskRow(db, worldId, tid);
  });
}

// ---- rounds: the GM's Downtime button ----------------------------------------------------------------------------------

export interface DayPick { taskId: string; days: number }
export const openRound = (db: DB, worldId: string) => one<any>(db, "SELECT * FROM downtime_rounds WHERE world_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1", worldId);
export const roundRow = (db: DB, worldId: string, rid: string) => one<any>(db, 'SELECT * FROM downtime_rounds WHERE world_id = ? AND id = ?', worldId, rid);
export const pickRow = (db: DB, rid: string, aid: string) => one<any>(db, 'SELECT * FROM downtime_picks WHERE round_id = ? AND account_id = ?', rid, aid);

/** Undo what a player's earlier pick in this round did (the work comes off the tasks, the log rows are marked undone). */
export function undoPick(d: { db: DB; hub: EventHub }, worldId: string, rid: string, aid: string, by: string | null) {
  const { db } = d;
  const rows = all<any>(db, "SELECT * FROM downtime_log WHERE world_id = ? AND round_id = ? AND account_id = ? AND undone = 0 AND kind IN ('work','skip')", worldId, rid, aid);
  for (const l of rows) {
    if (l.kind === 'work' && l.task_id && l.minutes) {
      const t = taskRow(db, worldId, l.task_id);
      if (t && t.status !== 'removed') {
        const done = Math.max(0, t.done_min - l.minutes);
        run(db, 'UPDATE downtime_tasks SET done_min = ?, updated_at = ? WHERE id = ?', done, now(), t.id);
        if (t.status === 'done' && done < t.need_min) {
          run(db, "UPDATE downtime_tasks SET status = 'active', finished_world = NULL, finished_at = NULL WHERE id = ?", t.id);
          run(db, "UPDATE downtime_log SET undone = 1 WHERE world_id = ? AND task_id = ? AND kind = 'complete' AND undone = 0", worldId, t.id);
        }
      }
    }
    run(db, 'UPDATE downtime_log SET undone = 1 WHERE id = ?', l.id);
  }
  run(db, 'DELETE FROM downtime_picks WHERE round_id = ? AND account_id = ?', rid, aid);
  void by;
}

/**
 * A player's pick for a round: work days on their tasks (Σ days × hours a day must fit in the round's days × the
 * world's day length), or skip. A new pick replaces the earlier one. Returns tasks that finished.
 */
export function applyPick(d: { db: DB; hub: EventHub }, worldId: string, round: any, aid: string, picks: DayPick[], skip: boolean, by: string, note = ''): { finished: any[] } {
  const { db } = d;
  return tx(db, () => {
    const s = worldSettings(db, worldId);
    const budget = round.days * dayHours(s) * 60;
    const seen = new Set<string>();
    let used = 0;
    const rows = picks.map((p) => {
      if (seen.has(p.taskId)) throw new HttpError(400, 'Each task once per pick');
      seen.add(p.taskId);
      const r = taskRow(db, worldId, p.taskId);
      if (!r || (r.account_id !== aid && !isGroup(r))) throw new HttpError(404, 'Task not found');
      if (isGroup(r) && r.status === 'paused') throw new HttpError(409, `The GM paused ${r.name}`);
      if (!['active', 'proposed', 'paused'].includes(r.status)) throw new HttpError(409, `${r.name} is ${r.status}`);
      if (!Number.isInteger(p.days) || p.days < 1 || p.days > round.days) throw new HttpError(400, `days must be from 1 to ${round.days}`);
      used += p.days * r.per_day_min;
      return { r, days: p.days };
    });
    if (used > budget) throw new HttpError(400, `That is ${span(used, dayHours(s))} of work; this downtime has ${span(budget, dayHours(s))}`);
    undoPick(d, worldId, round.id, aid, by);
    run(db, 'INSERT INTO downtime_picks (round_id, world_id, account_id, picks, skipped, by_id, at) VALUES (?,?,?,?,?,?,?)', round.id, worldId, aid, JSON.stringify(picks), skip || !picks.length ? 1 : 0, by, now());
    const finished: any[] = [];
    if (skip || !picks.length) {
      writeLog(db, worldId, { accountId: aid, kind: 'skip', roundId: round.id, by, note: note || `Skipped ${round.days} day${round.days === 1 ? '' : 's'} of downtime` });
      return { finished };
    }
    for (const { r, days } of rows) {
      if (r.status === 'paused') { run(db, "UPDATE downtime_tasks SET status = 'active' WHERE id = ?", r.id); writeLog(db, worldId, { accountId: aid, taskId: r.id, taskName: r.name, kind: 'resume', roundId: round.id, by }); }
      // Working on a group task joins it.
      if (isGroup(r) && !membersOf(r).includes(aid)) setMember(db, worldId, r.id, aid, true, by);
      const out = addWork(d, worldId, r.id, days * r.per_day_min, { kind: 'work', by, roundId: round.id, worker: aid, note: note || `${days} downtime day${days === 1 ? '' : 's'}` });
      if (out.finished) finished.push(out.row);
    }
    return { finished };
  });
}

export function roundOut(db: DB, worldId: string, round: any, viewer: { accountId: string; dm: boolean }, names: Record<string, string>, players: string[]) {
  const picks = all<any>(db, 'SELECT * FROM downtime_picks WHERE round_id = ?', round.id);
  const s = worldSettings(db, worldId);
  const base = { id: round.id, days: round.days, status: round.status, note: round.note, worldLabel: round.world_label, createdAt: round.created_at, closedAt: round.closed_at, hours: round.days * dayHours(s) };
  const view = (p: any) => {
    const list = parseJson<DayPick[]>(p.picks, []).map((x) => { const t = taskRow(db, worldId, x.taskId); return { ...x, name: t?.name ?? 'removed task' }; });
    return { accountId: p.account_id, name: names[p.account_id] ?? '', skipped: !!p.skipped, picks: list, at: p.at };
  };
  if (viewer.dm) {
    const by = new Map(picks.map((p) => [p.account_id, p]));
    return { ...base, answers: players.map((aid) => (by.has(aid) ? view(by.get(aid)) : { accountId: aid, name: names[aid] ?? '', waiting: true })) };
  }
  const mine = picks.find((p) => p.account_id === viewer.accountId);
  return { ...base, mine: mine ? view(mine) : null };
}
