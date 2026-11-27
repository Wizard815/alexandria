// Answering a quick event, shared by the quick events routes (routes/quick.ts) and an Android
// notification's buttons (features/glance, POST /glance/answer). No import of app.ts here, so
// features can use it without an import cycle.
import { randomInt } from 'node:crypto';
import type { DB } from './db.ts';
import { all, one, run } from './db.ts';
import type { Viewer } from './policy.ts';
import { HttpError, int, now, parseJson } from './util.ts';
import { memberIds } from '../routes/_shared.ts';

export const CHECKS: string[] = ['recall', 'notice', 'save', 'read', 'group', 'contest'];
type D = { db: DB; hub: { emitPer: (worldId: string, type: string, f: (v: Viewer) => unknown) => void } };

export const audienceOf = (d: D, ev: any, worldId: string): string[] => {
  const a = parseJson<string[] | 'party'>(ev.audience, []);
  return a === 'party' ? memberIds(d.db, worldId, ['player']) : a;
};

export function viewOf(d: D, ev: any, v: Viewer, worldId: string) {
  const db = d.db;
  const audienceIds = (e: any, w: string) => audienceOf(d, e, w);
  const responses = all<any>(db, 'SELECT * FROM quick_responses WHERE event_id = ? ORDER BY at', ev.id);
  const base = { id: ev.id, kind: ev.kind, title: ev.title, prompt: ev.prompt, options: parseJson(ev.options, []), skill: ev.skill, timer_s: ev.timer_s, closes_at: ev.closes_at, status: ev.status, created_at: ev.created_at };
  if (v.role === 'dm') return { ...base, audience: audienceIds(ev, worldId), dc: ev.dc, success_text: ev.success_text, fail_text: ev.fail_text, public_votes: !!ev.public_votes, responses };
  if (!audienceIds(ev, worldId).includes(v.accountId)) return null;
  const mine = responses.find((x) => x.account_id === v.accountId) ?? null;
  const out: any = { ...base, mine: mine && { choice: mine.choice, roll: mine.roll, total: mine.total, result: ev.status === 'resolved' ? mine.result : null } };
  if (ev.kind === 'vote' && ev.public_votes) out.tally = parseJson<string[]>(ev.options, []).map((_, i) => responses.filter((x) => x.choice === i).length);
  if (ev.status === 'resolved' && mine?.result) out.outcome = mine.result === 'success' ? ev.success_text : ev.fail_text;
  return out;
}

/** Is this a roll (a check) rather than a choice? */
export const isCheck = (kind: string) => CHECKS.includes(kind);

/**
 * One person answers a quick event: { choice } for choices and votes, { roll?, modifier? } for
 * checks (no roll: the librarian rolls a d20), { pass: true } to let someone else try. Used by
 * the page and by an Android notification's buttons (features/glance, POST /glance/answer).
 */
export function answerQuick(d: D, worldId: string, accountId: string, eid: string, body: any): any {
  const ev = one<any>(d.db, 'SELECT * FROM quick_events WHERE id = ? AND world_id = ?', eid, worldId);
  if (!ev || !audienceOf(d, ev, worldId).includes(accountId)) throw new HttpError(404, 'Event not found');
  if (ev.status !== 'open') throw new HttpError(409, 'This event is closed');
  // Small grace period for slow phones.
  if (ev.closes_at && Date.parse(ev.closes_at) + 2000 < Date.now()) throw new HttpError(409, 'Time ran out');
  const options = parseJson<string[]>(ev.options, []);
  let choice: number | null = null, roll: number | null = null, total: number | null = null;
  if (CHECKS.includes(ev.kind)) {
    if (body?.pass !== true) {
      roll = int(body?.roll, 'roll', { min: 1, max: 20, optional: true }) ?? randomInt(1, 21);
      total = roll + (int(body?.modifier, 'modifier', { min: -10, max: 30, optional: true }) ?? 0);
    }
  } else if (options.length) choice = int(body?.choice, 'choice', { min: 0, max: options.length - 1 });
  run(d.db, `INSERT INTO quick_responses (event_id, account_id, choice, roll, total, at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (event_id, account_id) DO UPDATE SET choice = excluded.choice, roll = excluded.roll, total = excluded.total, at = excluded.at`, ev.id, accountId, choice, roll, total, now());
  d.hub.emitPer(worldId, 'quick-event', (v) => viewOf(d, ev, v, worldId));
  return ev;
}

