// Random events on downtime days: while a character spends days on an activity, something may happen
// ("Rats in the cellar!"). The player gets a quick-time card: roll the check (Athletics, DC 12), or type
// the total from their own dice. Success gives the event's bonus (coin, an item, days of progress, healing);
// failure its cost (coin, lost days, damage, exhaustion). Every event, roll and result is logged and posted
// to table chat. The DM sees each one and can cancel it or decide it before the roll.
//
// Where they come from: an activity's own `events` list (ready-made ones in the rule file, the DM's in the
// activity editor). How often: the activity's `eventChance` (percent per downtime day), else the world's
// `downtimeEventChance`. At most one event per task per pick.
import { randomInt } from 'node:crypto';
import type { DB } from '../../core/db.ts';
import { all, one, run } from '../../core/db.ts';
import type { EventHub } from '../../core/events.ts';
import { dmAnd, everyone } from '../../core/events.ts';
import { featureSetting } from '../../core/policy.ts';
import { HttpError, id, now, parseJson } from '../../core/util.ts';
import { changeVitals, vitalsOf } from '../sheet/vitals.ts';
import { NO_REWARD, checkOutcome, hasOutcome, type EventDef, type Outcome } from './catalog.ts';
import { PARTY, activities, addWork, taskRow, tx, worldSettings, writeLog, type DayPick } from './store.ts';

export const EVENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS downtime_events (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    round_id TEXT,
    task_id TEXT NOT NULL,
    task_name TEXT NOT NULL DEFAULT '',
    account_id TEXT NOT NULL,        -- the character it happened to
    event TEXT NOT NULL,             -- the EventDef as it was when it happened
    status TEXT NOT NULL,            -- pending | success | failure | cancelled
    roll INTEGER,                    -- the d20 (null when the player typed a total or the DM decided)
    total INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT
  );
  CREATE INDEX IF NOT EXISTS downtime_events_world ON downtime_events(world_id, account_id, status);
`;

export interface DtEvent {
  id: string; roundId: string | null; taskId: string; task: string; accountId: string;
  title: string; text: string; check: string; dc: number; success: Outcome; failure: Outcome;
  status: 'pending' | 'success' | 'failure' | 'cancelled'; roll: number | null; total: number | null; note: string;
  createdAt: string; resolvedAt: string | null;
}

export function eventOut(r: any): DtEvent {
  const e = parseJson<EventDef>(r.event, {} as EventDef);
  return {
    id: r.id, roundId: r.round_id, taskId: r.task_id, task: r.task_name, accountId: r.account_id,
    title: e.title, text: e.text, check: e.check, dc: e.dc, success: e.success, failure: e.failure,
    status: r.status, roll: r.roll ?? null, total: r.total ?? null, note: r.note, createdAt: r.created_at, resolvedAt: r.resolved_at ?? null,
  };
}
export const eventRow = (db: DB, w: string, eid: string) => one<any>(db, 'SELECT * FROM downtime_events WHERE world_id = ? AND id = ?', w, eid);

/** The world's chance of an event per downtime day, in percent (0 turns them off). */
export const worldChance = (db: DB, w: string): number => {
  const v = Number(featureSetting<number>(worldSettings(db, w), 'downtimeEventChance'));
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 10;
};

type Rng = (lo: number, hi: number) => number;
const rand: Rng = (lo, hi) => randomInt(lo, hi + 1);

/** After a pick: roll for an event on each task, day by day. Returns the events that happened. */
export function rollForPick(d: { db: DB; hub: EventHub }, w: string, roundId: string | null, aid: string, picks: DayPick[], rng: Rng = rand): DtEvent[] {
  const { db } = d;
  const base = worldChance(db, w);
  const acts = new Map(activities(db, w).map((a) => [a.id, a]));
  const made: DtEvent[] = [];
  for (const p of picks) {
    const t = taskRow(db, w, p.taskId);
    const a = t?.activity_id ? acts.get(t.activity_id) : undefined;
    if (!t || !a || !a.events.length) continue;
    const chance = a.eventChance ?? base;
    if (chance <= 0) continue;
    let hit = false;
    for (let day = 0; day < p.days && !hit; day++) hit = rng(1, 100) <= chance;
    if (!hit) continue;
    const total = a.events.reduce((n, e) => n + e.weight, 0);
    let pickN = rng(1, total);
    const ev = a.events.find((e) => (pickN -= e.weight) <= 0) ?? a.events[0];
    const eid = id('dte_');
    run(db, "INSERT INTO downtime_events (id, world_id, round_id, task_id, task_name, account_id, event, status, created_at) VALUES (?,?,?,?,?,?,?,'pending',?)", eid, w, roundId, t.id, t.name, aid, JSON.stringify(ev), now());
    writeLog(db, w, { accountId: aid, taskId: t.id, taskName: t.name, kind: 'event', roundId, by: null, note: `${ev.title}${ev.check ? ` (${ev.check}, DC ${ev.dc})` : ''}` });
    made.push(eventOut(eventRow(db, w, eid)));
  }
  if (made.length) d.hub.emit(w, 'downtime-event', { accountId: aid, ids: made.map((e) => e.id) }, dmAnd(aid));
  return made;
}

/** A new pick (or the round taken back) cancels the events the earlier pick raised that nobody rolled yet. */
export function cancelPending(db: DB, w: string, roundId: string, aid: string | null, by: string | null) {
  const rows = all<any>(db, `SELECT * FROM downtime_events WHERE world_id = ? AND round_id = ? AND status = 'pending'${aid ? ' AND account_id = ?' : ''}`, w, roundId, ...(aid ? [aid] : []));
  for (const r of rows) {
    run(db, "UPDATE downtime_events SET status = 'cancelled', resolved_at = ?, resolved_by = ?, note = 'The pick changed' WHERE id = ?", now(), by, r.id);
    run(db, "UPDATE downtime_log SET undone = 1 WHERE world_id = ? AND round_id = ? AND account_id = ? AND kind = 'event' AND task_id = ?", w, roundId, r.account_id, r.task_id);
  }
}

export const outcomeText = (o: Outcome): string => [
  o.text.replace(/[.!]+$/, ''), o.cp ? `${o.cp > 0 ? '+' : '−'}${Math.abs(o.cp) / 100} gp` : '', o.item ? `${o.qty > 1 ? `${o.qty} × ` : ''}${o.item}` : '',
  o.days ? `${o.days > 0 ? '+' : '−'}${Math.abs(o.days)} day${Math.abs(o.days) === 1 ? '' : 's'} of progress` : '',
  o.damage ? `${o.damage} damage` : '', o.heal ? `${o.heal} HP back` : '', o.exhaustion ? `${o.exhaustion > 0 ? '+' : '−'}${Math.abs(o.exhaustion)} exhaustion` : '', o.noReward ? 'the job fails, no reward' : '',
].filter(Boolean).join(', ');

/** Exhaustion lives on the sheet as the condition "Exhaustion N" (1 to 6). */
function exhaust(conditions: string[], by: number): string[] {
  const cur = conditions.reduce((n, c) => { const m = /^exhaustion\s*(\d)$/i.exec(c.trim()); return m ? Math.max(n, Number(m[1])) : n; }, 0);
  const next = Math.max(0, Math.min(6, cur + by));
  const rest = conditions.filter((c) => !/^exhaustion\s*\d$/i.test(c.trim()));
  return next ? [...rest, `Exhaustion ${next}`] : rest;
}

export interface Resolved { event: DtEvent; outcome: Outcome; changed: { coin: boolean; item: boolean; sheet: boolean; task: boolean } }

/**
 * Settle an event: by a roll (d20 + bonus), a total the player typed, or the DM's say-so ('success' | 'failure').
 * Applies the outcome to the character who had the event: coin to their purse, the item to their inventory,
 * days on the task, damage, healing or exhaustion on their sheet.
 */
export function resolveEvent(d: { db: DB; hub: EventHub }, w: string, eid: string, how: { bonus?: number; total?: number; result?: 'success' | 'failure' }, by: string, rng: Rng = rand): Resolved {
  const { db } = d;
  return tx(db, () => {
    const r = eventRow(db, w, eid);
    if (!r) throw new HttpError(404, 'Event not found');
    if (r.status !== 'pending') throw new HttpError(409, `That event is already ${r.status === 'cancelled' ? 'cancelled' : 'settled'}`);
    const ev = parseJson<EventDef>(r.event, {} as EventDef);
    let roll: number | null = null;
    let total: number | null = null;
    let ok: boolean;
    if (how.result) ok = how.result === 'success';
    else if (!ev.check) ok = true;
    else {
      if (how.total !== undefined) total = how.total;
      else { roll = rng(1, 20); total = roll + (how.bonus ?? 0); }
      // An ability check: the total against the DC (a natural 20 or 1 is not automatic, as in the rules).
      ok = total >= ev.dc;
    }
    const outcome = checkOutcome(ok ? ev.success : ev.failure, 'outcome');
    const changed = { coin: false, item: false, sheet: false, task: false };
    const who = r.account_id;
    const label = `${ev.title}`.slice(0, 120);
    if (outcome.cp) {
      run(db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')`, id('led_'), w, who, outcome.cp, `Downtime event: ${label}`.slice(0, 200), by, now());
      changed.coin = true;
    }
    if (outcome.item) {
      run(db, `INSERT INTO items (id, world_id, owner, name, qty, weight, note, dm_note, link, image, updated_at, updated_by, status) VALUES (?, ?, ?, ?, ?, NULL, ?, '', NULL, NULL, ?, ?, 'approved')`, id('itm_'), w, who, outcome.item, outcome.qty, `From a downtime event: ${label}`.slice(0, 300), now(), by);
      changed.item = true;
    }
    if (outcome.days) {
      const t = taskRow(db, w, r.task_id);
      if (t && t.status !== 'removed' && !(outcome.days > 0 && t.status === 'done')) {
        addWork(d, w, t.id, outcome.days * t.per_day_min, { kind: 'time', by, worker: t.account_id === PARTY ? who : undefined, note: label });
        changed.task = true;
      }
    }
    if (outcome.noReward) {
      // The job fails: the task's reward is lost (unless it was already handed out).
      const t = taskRow(db, w, r.task_id);
      if (t && !t.reward_given_at) { run(db, 'UPDATE downtime_tasks SET reward = ?, updated_at = ? WHERE id = ?', JSON.stringify(NO_REWARD), now(), t.id); changed.task = true; }
    }
    if (outcome.damage || outcome.heal || outcome.exhaustion) {
      const ch: any = {};
      if (outcome.damage) ch.damage = outcome.damage;
      if (outcome.heal) ch.heal = outcome.heal;
      if (outcome.exhaustion) ch.conditions = exhaust(vitalsOf(db, w, who).conditions, outcome.exhaustion);
      changeVitals(db, w, who, ch, 'dm', by, `Downtime event: ${label}`);
      changed.sheet = true;
    }
    const res = ok ? 'success' : 'failure';
    const said = ev.check ? (total !== null ? `${ev.check} ${total}${roll !== null ? ` (rolled ${roll})` : ''} vs DC ${ev.dc}` : 'the DM decided') : '';
    const note = [said, `${ok ? 'success' : 'failure'}${hasOutcome(outcome) ? `: ${outcomeText(outcome)}` : ''}`].filter(Boolean).join(', ');
    run(db, 'UPDATE downtime_events SET status = ?, roll = ?, total = ?, note = ?, resolved_at = ?, resolved_by = ? WHERE id = ?', res, roll, total, note.slice(0, 400), now(), by, eid);
    writeLog(db, w, { accountId: who, taskId: r.task_id, taskName: r.task_name, kind: 'event', roundId: r.round_id, by, note: `${label}: ${note}` });
    return { event: eventOut(eventRow(db, w, eid)), outcome, changed };
  });
}

/** Tell the right people after an event was settled. */
export function announce(hub: EventHub, w: string, r: Resolved) {
  const who = r.event.accountId;
  if (r.changed.coin) hub.emit(w, 'coin', { owner: who }, dmAnd(who));
  if (r.changed.item) hub.emit(w, 'item', { owner: who }, dmAnd(who));
  if (r.changed.sheet) hub.emit(w, 'sheet', { accountId: who }, dmAnd(who));
  hub.emit(w, 'downtime-event', { accountId: who, ids: [r.event.id] }, dmAnd(who));
  hub.emit(w, 'downtime', { accountId: who }, r.changed.task ? everyone : dmAnd(who));
}
