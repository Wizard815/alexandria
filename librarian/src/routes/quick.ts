// Quick events (recall, notice, saving throw, timed choice, party vote,
// reaction...). The DM sends one, the chosen players get a prompt with a
// timer, answer, and the DM resolves it. Players never see the DC or the
// success/fail text until it is resolved, and then only their own outcome.
import { Router } from 'express';
import { randomInt } from 'node:crypto';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { one, all, run } from '../core/db.ts';
import { requireDM, requirePlayerOrDM } from '../core/auth.ts';
import { dmAnd } from '../core/events.ts';
import type { Viewer } from '../core/policy.ts';
import { HttpError, id, int, now, oneOf, parseJson, str } from '../core/util.ts';
import { ctx, isDM, me, memberIds, settings } from './_shared.ts';

const KINDS = ['recall', 'notice', 'save', 'read', 'group', 'contest', 'choice', 'vote', 'reaction', 'twist'] as const;
const CHECKS: string[] = ['recall', 'notice', 'save', 'read', 'group', 'contest'];

export default function quickRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;

  const audienceIds = (ev: any, worldId: string): string[] => {
    const a = parseJson<string[] | 'party'>(ev.audience, []);
    return a === 'party' ? memberIds(db, worldId, ['player']) : a;
  };

  function view(ev: any, v: Viewer, worldId: string) {
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

  const push = (ev: any, worldId: string) => d.hub.emitPer(worldId, 'quick-event', (v) => view(ev, v, worldId));
  const load = (res: any, eid: string) => {
    const ev = one<any>(db, 'SELECT * FROM quick_events WHERE id = ? AND world_id = ?', eid, ctx(res).world.id);
    if (!ev) throw new HttpError(404, 'Event not found');
    return ev;
  };

  r.get('/', (_req, res) => {
    const c = ctx(res);
    const rows = all<any>(db, 'SELECT * FROM quick_events WHERE world_id = ? ORDER BY created_at DESC LIMIT 50', c.world.id);
    res.json(rows.map((ev) => view(ev, c.viewer, c.world.id)).filter(Boolean));
  });

  r.post('/', requireDM, (req, res) => {
    const c = ctx(res);
    const b = req.body ?? {};
    const kind = oneOf(b.kind, 'kind', KINDS);
    let audience: string[] | 'party' = 'party';
    if (Array.isArray(b.audience)) {
      const players = new Set(memberIds(db, c.world.id, ['player']));
      if (!b.audience.length || b.audience.some((x: unknown) => typeof x !== 'string' || !players.has(x))) throw new HttpError(400, 'audience must be players in this world');
      audience = b.audience;
    }
    const options = Array.isArray(b.options) ? b.options.slice(0, 8).map((o: unknown, i: number) => str(o, `options[${i}]`, { max: 120 })) : [];
    if ((kind === 'choice' || kind === 'vote') && options.length < 2) throw new HttpError(400, 'Choices and votes need at least two options');
    const timer = b.timerS === null ? null : int(b.timerS, 'timerS', { min: 3, max: 600, optional: true }) ?? settings(res).quickEventTimer;
    const ev = {
      id: id('qe_'), world_id: c.world.id, kind, title: str(b.title, 'title', { max: 120 }), prompt: str(b.prompt, 'prompt', { max: 2000 }),
      audience: JSON.stringify(audience), options: JSON.stringify(options), skill: str(b.skill, 'skill', { max: 40, optional: true }) || null,
      dc: int(b.dc, 'dc', { min: 1, max: 40, optional: true }), success_text: str(b.successText, 'successText', { max: 4000, optional: true }) || null,
      fail_text: str(b.failText, 'failText', { max: 4000, optional: true }) || null, public_votes: b.publicVotes ? 1 : 0, timer_s: timer,
      status: 'open', created_at: now(), closes_at: timer ? new Date(Date.now() + timer * 1000).toISOString() : null,
    };
    run(db, `INSERT INTO quick_events (id, world_id, kind, title, prompt, audience, options, skill, dc, success_text, fail_text, public_votes, timer_s, status, created_at, closes_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ev.id, ev.world_id, ev.kind, ev.title, ev.prompt, ev.audience, ev.options, ev.skill, ev.dc, ev.success_text, ev.fail_text, ev.public_votes, ev.timer_s, ev.status, ev.created_at, ev.closes_at);
    audit(db, c.world.id, me(res), 'quick.create', `${kind} ${ev.title}`);
    push(ev, c.world.id);
    res.status(201).json(view(ev, c.viewer, c.world.id));
  });

  // A player answers. { choice } for choices/votes/reactions, { roll?, modifier? }
  // for checks: send the roll from real dice, or leave it out and the
  // librarian rolls a d20.
  r.post('/:eid/respond', requirePlayerOrDM, (req, res) => {
    const c = ctx(res);
    const ev = load(res, String(req.params.eid));
    if (!audienceIds(ev, c.world.id).includes(me(res))) throw new HttpError(404, 'Event not found');
    if (ev.status !== 'open') throw new HttpError(409, 'This event is closed');
    // Small grace period for slow phones.
    if (ev.closes_at && Date.parse(ev.closes_at) + 2000 < Date.now()) throw new HttpError(409, 'Time ran out');
    const options = parseJson<string[]>(ev.options, []);
    let choice: number | null = null, roll: number | null = null, total: number | null = null;
    if (CHECKS.includes(ev.kind)) {
      // { pass: true } lets someone else try; otherwise it is a roll.
      if (req.body?.pass !== true) {
        roll = int(req.body?.roll, 'roll', { min: 1, max: 20, optional: true }) ?? randomInt(1, 21);
        total = roll + (int(req.body?.modifier, 'modifier', { min: -10, max: 30, optional: true }) ?? 0);
      }
    } else if (options.length) choice = int(req.body?.choice, 'choice', { min: 0, max: options.length - 1 });
    run(db, `INSERT INTO quick_responses (event_id, account_id, choice, roll, total, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (event_id, account_id) DO UPDATE SET choice = excluded.choice, roll = excluded.roll, total = excluded.total, at = excluded.at`, ev.id, me(res), choice, roll, total, now());
    push(ev, c.world.id);
    res.json(view(ev, c.viewer, c.world.id));
  });

  // DM resolves. Results default to total >= DC for checks, first answer for
  // reactions, and the top option for votes. { results: { accountId: 'success'|'fail' } } overrides.
  r.post('/:eid/resolve', requireDM, (req, res) => {
    const c = ctx(res);
    const ev = load(res, String(req.params.eid));
    if (ev.status !== 'open') throw new HttpError(409, 'Already closed');
    const responses = all<any>(db, 'SELECT * FROM quick_responses WHERE event_id = ? ORDER BY at', ev.id);
    const over = req.body?.results && typeof req.body.results === 'object' ? req.body.results : {};
    responses.forEach((x, i) => {
      let result: string | null = null;
      if (over[x.account_id] === 'success' || over[x.account_id] === 'fail') result = over[x.account_id];
      else if (ev.dc && x.total !== null) result = x.total >= ev.dc ? 'success' : 'fail';
      else if (ev.kind === 'reaction') result = i === 0 && (x.choice === null || x.choice === 0) ? 'success' : 'fail';
      else if (x.choice !== null) result = 'success';
      run(db, 'UPDATE quick_responses SET result = ? WHERE event_id = ? AND account_id = ?', result, ev.id, x.account_id);
    });
    run(db, `UPDATE quick_events SET status = 'resolved' WHERE id = ?`, ev.id);
    const done = { ...ev, status: 'resolved' };
    audit(db, c.world.id, me(res), 'quick.resolve', ev.id);
    push(done, c.world.id);
    res.json(view(done, c.viewer, c.world.id));
  });

  r.post('/:eid/cancel', requireDM, (req, res) => {
    const c = ctx(res);
    const ev = load(res, String(req.params.eid));
    run(db, `UPDATE quick_events SET status = 'cancelled' WHERE id = ?`, ev.id);
    d.hub.emit(c.world.id, 'quick-event-cancelled', { id: ev.id }, dmAnd(...audienceIds(ev, c.world.id)));
    res.json({ ok: true, dm: isDM(res) });
  });

  return r;
}
