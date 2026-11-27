// DownTime: Wizard's downtime house rule. Characters spend downtime days on
// activities (ready-made ones from the rule file, the DM's own, and ones
// players make), each with a tier from common to legendary that sets how
// long it takes. When days pass at the table the DM presses Downtime: every
// player gets a popup to pick what to work on, skip, or make a new activity.
// The DM can add or take away time, stop a task midway and set a reward for
// the end. Every change is logged with the real time and the in-world date.
// Ties: the world clock (a round moves it), the Codex (crafting a spell is an
// activity), the sheet (a Downtime module), the assistant (tools) and the
// player helper model (rank activities, decide a new one's tier).
// Switched on as the house rule "downtime" (mods/downtime.alxmod.json).
import { Router, type Response } from 'express';
import type { Deps } from '../../app.ts';
import { requireDM, requirePlayerOrDM } from '../../core/auth.ts';
import { all, one, run } from '../../core/db.ts';
import { dmAnd, everyone } from '../../core/events.ts';
import { featureSetting } from '../../core/policy.ts';
import { HttpError, id, now, parseJson } from '../../core/util.ts';
import { ctx, isDM, me, memberIds, names, settings } from '../../routes/_shared.ts';
import * as clock from '../clock/api.ts';
import { postChat } from '../sessionchat/hooks.ts';
import type { Feature } from '../types.ts';
import { DEFAULT_TIER_DAYS, MAX_DAYS, TIERS, TIER_LABEL, checkActivity, checkPremade, checkReward, checkTierDays, hasReward, tierOf, type Activity } from './catalog.ts';
import './codex.ts';
import { linkHandlers } from './hooks.ts';
import {
  PARTY, SCHEMA, activities, activity, addWork, migrateRounds, applyPick, dayHours, daysFor, editTask, isOn, listTasks, mustTask, openRound, removeActivity, roundOut, roundRow,
  isGroup, saveActivity, setMember, setStatus, span, startTask, taskOut, taskRow, tierDays, tx, undoPick, updateActivity, worldSettings, writeLog, type ActivityRow, type DayPick,
} from './store.ts';
import { EVENTS_SCHEMA, announce, cancelPending, eventOut, eventRow, outcomeText, resolveEvent, rollForPick } from './events.ts';
import { decideTier, rankActivities } from './suggest.ts';

const enc = encodeURIComponent;
const audit = (d: Deps, worldId: string, accountId: string, action: string, detail = '') => run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());

/** A player by account id, character name or display name. */
function findPlayer(d: Deps, worldId: string, who: unknown): string {
  const s = typeof who === 'string' ? who.trim() : '';
  if (!s) throw new HttpError(400, 'Say which player');
  const rows = all<any>(d.db, "SELECT a.id, a.display_name, m.character_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.role = 'player'", worldId);
  const low = s.toLowerCase();
  const hit = rows.find((r) => r.id === s) ?? rows.find((r) => (r.character_name ?? '').toLowerCase() === low) ?? rows.find((r) => r.display_name.toLowerCase() === low)
    ?? rows.find((r) => (r.character_name ?? '').toLowerCase().split(/\s+/)[0] === low);
  if (!hit) throw new HttpError(404, `No player called ${s.slice(0, 60)} in this world`);
  return hit.id;
}

/** Whole minutes from { minutes | hours | days } (days are the task's or the world's downtime days). */
function amount(b: any, perDayMin: number): number {
  const n = (v: unknown, what: string) => { const x = Number(v); if (!Number.isFinite(x) || x === 0 || Math.abs(x) > MAX_DAYS * 24 * 60) throw new HttpError(400, `${what} must be a number, not zero`); return x; };
  if (b?.days !== undefined && b.days !== null) return Math.round(n(b.days, 'days') * perDayMin);
  if (b?.hours !== undefined && b.hours !== null) return Math.round(n(b.hours, 'hours') * 60);
  if (b?.minutes !== undefined && b.minutes !== null) return Math.round(n(b.minutes, 'minutes'));
  throw new HttpError(400, 'Give days, hours or minutes');
}

function routes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db, hub } = d;
  const W = (res: Response) => ctx(res).world.id as string;
  const S = (res: Response) => settings(res);
  const viewer = (res: Response) => ({ accountId: me(res), dm: isDM(res) });
  const players = (w: string) => memberIds(db, w, ['player']);
  /** Names by account id; a group task's owner is the party. */
  const nameMap = (w: string): Record<string, string> => ({ ...names(db, w), [PARTY]: 'The party' });
  const changed = (w: string, aid: string | null) => hub.emit(w, 'downtime', { accountId: aid }, aid && aid !== PARTY ? dmAnd(aid) : everyone);
  const roundChanged = (w: string, rid: string, status: string) => hub.emit(w, 'downtime-round', { id: rid, status }, everyone);
  const out = (res: Response, row: any) => {
    const t = taskOut(db, S(res), row, isDM(res));
    if (t.scope !== 'group') return t;
    // A group task names who joined and what each put in.
    const nm = nameMap(W(res));
    return { ...t, memberNames: t.members.map((m) => nm[m] ?? ''), contributions: t.contributions.map((c) => ({ ...c, name: nm[c.accountId] ?? '' })) };
  };
  const need = (res: Response) => { if (!isOn(S(res))) throw new HttpError(403, 'DownTime is off in this world: the DM turns it on under House rules'); };
  const guestNo = (res: Response) => { if (ctx(res).viewer.role === 'guest') throw new HttpError(403, 'Guests have no downtime'); };
  /** Whose tasks: a player always their own; the DM names one (or null for everyone). */
  const whose = (res: Response, v: unknown, dmDefault: string | null = null): string | null => (isDM(res) ? (v === undefined || v === null || v === '' ? dmDefault : findPlayer(d, W(res), v)) : me(res));

  /** Activities one character can start: the world's (players see ones that are on, plus their own proposals) and those linked features offer. */
  function offer(res: Response, aid: string | null): (ActivityRow & { daysNeeded: number })[] {
    const s = S(res);
    const dm = isDM(res);
    const list: ActivityRow[] = activities(db, W(res)).filter((a) => dm || a.status === 'ok' || (a.status === 'proposed' && a.createdBy === me(res)));
    if (aid && aid !== PARTY) for (const h of linkHandlers()) for (const a of h.activities?.(db, W(res), aid) ?? []) list.push({ ...a, source: 'premade', status: 'ok', createdBy: null, changed: false });
    return list.map((a) => ({ ...a, daysNeeded: daysFor(s, a) }));
  }
  function findActivity(res: Response, aid: string | null, ref: unknown): ActivityRow {
    const s = typeof ref === 'string' ? ref.trim() : '';
    if (!s) throw new HttpError(400, 'Say which activity');
    const list = offer(res, aid).filter((a) => isDM(res) || a.status !== 'hidden');
    const hit = list.find((a) => a.id === s) ?? list.find((a) => a.name.toLowerCase() === s.toLowerCase());
    if (!hit) throw new HttpError(404, `No activity called ${s.slice(0, 60)}`);
    return hit;
  }
  /** A task by id, or by its name among the viewer's (or the named player's) unfinished ones. */
  function findTask(res: Response, ref: string, player?: unknown): any {
    const w = W(res);
    const byId = taskRow(db, w, ref);
    if (byId) return mustTask(db, w, ref, viewer(res));
    const aid = whose(res, player);
    const rows = listTasks(db, w, { accountId: aid ?? undefined, open: true, withGroup: true }).filter((x) => x.name.toLowerCase() === ref.trim().toLowerCase());
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) throw new HttpError(409, `More than one task is called ${ref.slice(0, 60)}: use its id or name the player`);
    throw new HttpError(404, 'Task not found');
  }

  /** Start a task: from an activity (activityId), or a new activity (activity: { name, summary, tier?, days?, hoursPerDay? }). */
  async function start(res: Response, b: any): Promise<any> {
    const w = W(res);
    const s = S(res);
    const dm = isDM(res);
    // A group task: the party's, shared. The DM may start one for the whole party (no player); a player starts it and joins.
    const who = b.player ?? b.accountId;
    const wantGroup = b.group === true || b.scope === 'group';
    const aid = dm ? (wantGroup && (who === undefined || who === null || who === '' || who === PARTY) ? PARTY : findPlayer(d, w, who)) : me(res);
    let act: Activity;
    let status: 'active' | 'proposed' = 'active';
    if (b.activity && typeof b.activity === 'object') {
      const mode = featureSetting<string>(s, 'downtimePlayerNew');
      if (!dm && mode === 'off') throw new HttpError(403, 'Only the DM makes new activities in this world');
      const raw = { ...b.activity, ...(wantGroup ? { group: true } : {}) };
      if (!tierOf(raw.tier) && !dm) {
        const dec = await decideTier(d, String(raw.name ?? ''), String(raw.summary ?? ''), tierDays(s), dayHours(s));
        Object.assign(raw, { tier: dec.tier, days: raw.days ?? dec.days, hoursPerDay: raw.hoursPerDay ?? dec.hoursPerDay });
      }
      if (!dm) { delete raw.reward; status = mode === 'free' ? 'active' : 'proposed'; }
      // A DM's one-off for one character stays off the list unless they say save; a player's goes on it (as a proposal).
      if (dm && b.save !== true) act = checkActivity(raw, '');
      else act = saveActivity(db, w, raw, me(res), dm ? 'dm' : 'player', status === 'proposed' ? 'proposed' : 'ok');
    } else {
      act = findActivity(res, aid, b.activityId ?? b.activity);
      if ((act as ActivityRow).status === 'proposed') status = 'proposed';
      // A group activity the party already has going: join it rather than start a second one.
      if ((act.group || wantGroup) && !act.repeatable) {
        const have = listTasks(db, w, { accountId: PARTY, open: true }).find((x) => x.activity_id === act.id && x.status !== 'done');
        if (have) return aid === PARTY ? have : setMember(db, w, have.id, aid, true, me(res));
      }
    }
    const reward = dm && b.reward !== undefined ? checkReward(b.reward) : undefined;
    const row = startTask(db, w, { activity: act, accountId: aid, group: wantGroup || act.group, status, reward, dmNote: dm ? b.dmNote : undefined, by: me(res), note: typeof b.note === 'string' ? b.note : undefined });
    audit(d, w, me(res), 'downtime.start', `${aid} ${act.name}`);
    return row;
  }

  // ---- overview ----

  r.get('/', (req, res) => {
    const w = W(res);
    const s = S(res);
    const dm = isDM(res);
    const nm = nameMap(w);
    const base = {
      on: isOn(s), dayHours: dayHours(s), playerNew: featureSetting<string>(s, 'downtimePlayerNew'), advanceClock: featureSetting<boolean>(s, 'downtimeAdvanceClock'),
      tiers: TIERS.map((t) => ({ id: t, label: TIER_LABEL[t], days: tierDays(s)[t] })), now: clock.getClock(db, w).label,
    };
    if (ctx(res).viewer.role === 'guest') return res.json({ ...base, round: null, tasks: [] });
    const round = openRound(db, w);
    const aid = dm ? (req.query.player ? findPlayer(d, w, req.query.player) : null) : me(res);
    const tasks = listTasks(db, w, { accountId: aid ?? undefined, withGroup: true, open: req.query.all !== '1' }).map((x) => ({ ...out(res, x), player: nm[x.account_id] ?? '' }));
    res.json({
      ...base,
      round: round ? roundOut(db, w, round, viewer(res), nm, players(w)) : null,
      tasks,
      events: all<any>(db, `SELECT * FROM downtime_events WHERE world_id = ? AND status = 'pending'${aid ? ' AND account_id = ?' : ''} ORDER BY created_at`, w, ...(aid ? [aid] : [])).map((x) => ({ ...eventOut(x), player: nm[x.account_id] ?? '' })),
      ...(dm ? { waitingRewards: listTasks(db, w, { status: 'done' }).filter((x) => !x.reward_given_at && hasReward(checkReward(parseJson(x.reward, {})))).length, proposals: tasks.filter((t) => t.status === 'proposed').length } : {}),
    });
  });

  // ---- activities ----

  r.get('/activities', (req, res) => {
    if (ctx(res).viewer.role === 'guest') return res.json({ activities: [] });
    const aid = isDM(res) ? (req.query.player ? findPlayer(d, W(res), req.query.player) : null) : me(res);
    res.json({ activities: offer(res, aid).map((a) => ({ ...a, tierLabel: TIER_LABEL[a.tier], reward: isDM(res) || !a.reward.hidden ? a.reward : { hidden: true } })) });
  });
  r.post('/activities', requireDM, (req, res) => {
    const a = saveActivity(db, W(res), req.body?.activity ?? req.body, me(res), 'dm', 'ok');
    audit(d, W(res), me(res), 'downtime.activity', a.name);
    changed(W(res), null);
    res.status(201).json(a);
  });
  r.patch('/activities/:id', requireDM, (req, res) => {
    const a = updateActivity(db, W(res), String(req.params.id), req.body ?? {});
    changed(W(res), null);
    res.json(a);
  });
  r.delete('/activities/:id', requireDM, (req, res) => {
    removeActivity(db, W(res), String(req.params.id));
    changed(W(res), null);
    res.json({ ok: true });
  });

  // ---- tasks ----

  r.get('/tasks', (req, res) => {
    guestNo(res);
    const w = W(res);
    const nm = nameMap(w);
    const aid = whose(res, req.query.player);
    const st = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    const scope = req.query.scope === 'group' || req.query.scope === 'personal' ? req.query.scope : undefined;
    res.json({ tasks: listTasks(db, w, { accountId: aid ?? undefined, withGroup: true, scope, status: st, open: !st && req.query.all !== '1' }).map((x) => ({ ...out(res, x), player: nm[x.account_id] ?? '' })) });
  });

  r.post('/tasks', requirePlayerOrDM, async (req, res) => {
    need(res);
    const row = await start(res, req.body ?? {});
    changed(W(res), row.account_id);
    res.status(201).json(out(res, row));
  });

  r.patch('/tasks/:id', requirePlayerOrDM, (req, res) => {
    need(res);
    const w = W(res);
    const b = req.body ?? {};
    const t = findTask(res, String(req.params.id), b.player);
    let row: any;
    if (!isDM(res)) {
      if (isGroup(t)) throw new HttpError(403, 'A group task is the whole party\'s: leave it, or ask the DM to pause it');
      if (b.status !== 'paused' && b.status !== 'active') throw new HttpError(403, 'Players can pause or go back to their own tasks; the DM changes the rest');
      row = setStatus(d, w, t.id, b.status, me(res));
    } else {
      row = Object.keys(b).some((k) => !['status', 'player', 'note'].includes(k)) ? editTask(d, w, t.id, b, me(res)) : t;
      if (b.status === 'paused' || b.status === 'active') row = setStatus(d, w, t.id, b.status, me(res), typeof b.note === 'string' ? b.note : '');
    }
    afterFinish(w, row);
    changed(w, row.account_id);
    res.json(out(res, row));
  });

  /** The DM adds (or takes away) time: { days | hours | minutes, note }. Negative takes time away. */
  r.post('/tasks/:id/time', requireDM, (req, res) => {
    need(res);
    const w = W(res);
    const t = findTask(res, String(req.params.id), req.body?.player);
    const p = addWork(d, w, t.id, amount(req.body, t.per_day_min), { kind: 'time', by: me(res), note: typeof req.body?.note === 'string' ? req.body.note : '' });
    afterFinish(w, p.row);
    changed(w, t.account_id);
    res.json(out(res, p.row));
  });

  /** The DM (or the assistant) logs work done outside a Downtime round: { days | hours, note }. */
  r.post('/tasks/:id/work', requireDM, (req, res) => {
    need(res);
    const w = W(res);
    const t = findTask(res, String(req.params.id), req.body?.player);
    const m = amount(req.body, t.per_day_min);
    if (m < 0) throw new HttpError(400, 'Work is positive; take time away with /time');
    // On a group task, a named player is the one who did the work (and joins it); else it counts for the party.
    const worker = isGroup(t) && req.body?.worker ? findPlayer(d, w, req.body.worker) : undefined;
    if (worker) setMember(db, w, t.id, worker, true, me(res));
    const p = addWork(d, w, t.id, m, { kind: 'work', by: me(res), worker, note: typeof req.body?.note === 'string' ? req.body.note : '' });
    afterFinish(w, p.row);
    changed(w, t.account_id);
    res.json(out(res, p.row));
  });

  /** Stop a task midway: the work done stays in the log. A player stops their own. */
  r.delete('/tasks/:id', requirePlayerOrDM, (req, res) => {
    need(res);
    const t = findTask(res, String(req.params.id), req.query.player);
    if (!isDM(res) && isGroup(t)) throw new HttpError(403, 'A group task is the whole party\'s: leave it instead, and the DM can remove it');
    const row = setStatus(d, W(res), t.id, 'removed', me(res), typeof req.query.note === 'string' ? req.query.note : '');
    changed(W(res), row.account_id);
    res.json(out(res, row));
  });

  /** Join or leave a group task: a player for themselves, the DM for a named player. Work already done stays in it. */
  for (const verb of ['join', 'leave'] as const) {
    r.post(`/tasks/:id/${verb}`, requirePlayerOrDM, (req, res) => {
      need(res);
      const w = W(res);
      const t = findTask(res, String(req.params.id));
      if (!isGroup(t)) throw new HttpError(409, `${t.name} is a personal task, not a group one`);
      const aid = isDM(res) ? findPlayer(d, w, req.body?.player) : me(res);
      const row = setMember(db, w, t.id, aid, verb === 'join', me(res));
      changed(w, PARTY);
      res.json(out(res, row));
    });
  }

  /** Give a finished task's reward: coin to the purse, an item to the inventory, a line in table chat. */
  r.post('/tasks/:id/reward', requireDM, (req, res) => {
    need(res);
    const w = W(res);
    const t = findTask(res, String(req.params.id), req.body?.player);
    if (t.status !== 'done') throw new HttpError(409, `${t.name} is not finished yet`);
    if (t.reward_given_at) throw new HttpError(409, 'The reward was already given');
    const row = giveReward(w, t, me(res), typeof req.body?.note === 'string' ? req.body.note : '');
    res.json(out(res, row));
  });

  function giveReward(w: string, t: any, by: string, note: string) {
    const rw = checkReward(parseJson(t.reward, {}));
    const nm = nameMap(w)[t.account_id] ?? 'someone';
    tx(db, () => {
      if (rw.cp) run(db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')`, id('led_'), w, t.account_id, rw.cp, `Downtime: ${t.name}`.slice(0, 200), by, now());
      if (rw.item) run(db, `INSERT INTO items (id, world_id, owner, name, qty, weight, note, dm_note, link, image, updated_at, updated_by, status) VALUES (?, ?, ?, ?, ?, NULL, ?, '', NULL, NULL, ?, ?, 'approved')`, id('itm_'), w, t.account_id, rw.item, rw.qty, `From downtime: ${t.name}`.slice(0, 300), now(), by);
      run(db, 'UPDATE downtime_tasks SET reward_given_at = ?, updated_at = ? WHERE id = ?', now(), now(), t.id);
      writeLog(db, w, { accountId: t.account_id, taskId: t.id, taskName: t.name, kind: 'reward', by, note: [rw.text, rw.cp && `${rw.cp / 100} gp`, rw.item && `${rw.qty} × ${rw.item}`, note].filter(Boolean).join(' · ') });
    });
    // A group task's reward goes to the party pouch and stash (owner 'party'), which every player sees.
    const aud = t.account_id === PARTY ? everyone : dmAnd(t.account_id);
    if (rw.cp) hub.emit(w, 'coin', { owner: t.account_id }, aud);
    if (rw.item) hub.emit(w, 'item', { owner: t.account_id }, aud);
    try { postChat(d, w, 'table', by, 'dm', `🏁 ${nm} finished **${t.name}**${hasReward(rw) ? `: ${[rw.text, rw.cp && `${rw.cp / 100} gp`, rw.item && `${rw.qty > 1 ? `${rw.qty} × ` : ''}${rw.item}`].filter(Boolean).join(', ')}` : ''}`); } catch { /* no session running: the log has it */ }
    changed(w, t.account_id);
    return taskRow(db, w, t.id);
  }

  /** A task that just finished: with auto rewards on, give it now; tell the player and the DM. */
  function afterFinish(w: string, row: any) {
    if (!row || row.status !== 'done' || row.reward_given_at) return;
    const rw = checkReward(parseJson(row.reward, {}));
    if (hasReward(rw) && featureSetting<boolean>(worldSettings(db, w), 'downtimeAutoReward') === true) giveReward(w, row, row.created_by ?? me0(w), 'given at once');
    hub.emit(w, 'downtime-done', { accountId: row.account_id, taskId: row.id, name: row.name, group: isGroup(row) }, isGroup(row) ? everyone : dmAnd(row.account_id));
  }
  const me0 = (w: string) => one<any>(db, "SELECT account_id FROM members WHERE world_id = ? AND role = 'dm' LIMIT 1", w)?.account_id ?? null;

  // ---- the log ----

  r.get('/log', (req, res) => {
    guestNo(res);
    const w = W(res);
    const nm = nameMap(w);
    const aid = whose(res, req.query.player);
    const where = ['world_id = ?'];
    const args: unknown[] = [w];
    if (aid) { where.push("(account_id = ? OR task_id IN (SELECT id FROM downtime_tasks WHERE world_id = ? AND scope = 'group'))"); args.push(aid, w); }
    if (typeof req.query.task === 'string' && req.query.task) { where.push('task_id = ?'); args.push(req.query.task); }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const rows = all<any>(db, `SELECT * FROM downtime_log WHERE ${where.join(' AND ')} ORDER BY at DESC, rowid DESC LIMIT ?`, ...args, limit);
    const hpd = dayHours(S(res));
    res.json({
      log: rows.map((x) => ({
        id: x.id, at: x.at, worldDate: x.world_label, worldMinutes: x.world_minutes, accountId: x.account_id, player: nm[x.account_id] ?? '',
        taskId: x.task_id, task: x.task_name, kind: x.kind, minutes: x.minutes, time: x.minutes ? `${x.minutes < 0 ? '-' : ''}${span(Math.abs(x.minutes), hpd)}` : '',
        by: x.by_id ? (nm[x.by_id] ?? (x.by_id === x.account_id ? 'the player' : 'the DM')) : '', note: x.note, undone: !!x.undone, roundId: x.round_id,
      })),
    });
  });

  // ---- rounds: the Downtime button ----

  const roundView = (res: Response, round: any) => roundOut(db, W(res), round, viewer(res), nameMap(W(res)), players(W(res)));

  r.get('/rounds/current', (_req, res) => {
    if (ctx(res).viewer.role === 'guest') return res.json({ round: null });
    const round = openRound(db, W(res));
    res.json({ round: round ? roundView(res, round) : null });
  });
  r.get('/rounds', requireDM, (req, res) => {
    const rows = all<any>(db, 'SELECT * FROM downtime_rounds WHERE world_id = ? ORDER BY created_at DESC LIMIT ?', W(res), Math.min(Number(req.query.limit) || 20, 100));
    res.json({ rounds: rows.map((x) => roundView(res, x)) });
  });

  /** The DM presses Downtime: { days (default 1), note?, advance? (move the world clock; the world's setting by default) }. */
  r.post('/rounds', requireDM, (req, res) => {
    need(res);
    const w = W(res);
    if (openRound(db, w)) throw new HttpError(409, 'A downtime round is already open: close it first');
    const days = req.body?.days === undefined ? 1 : Number(req.body.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, 'days must be a whole number from 1 to 365');
    const advance = typeof req.body?.advance === 'boolean' ? req.body.advance : featureSetting<boolean>(S(res), 'downtimeAdvanceClock') !== false;
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
    // Travel days: on the road, only a few hours a day go to downtime (the world's downtimeTravelHours, or { hours }).
    const travel = req.body?.travel === true || req.body?.kind === 'travel';
    let dayMin: number | null = null;
    if (travel) {
      const h = req.body?.hours === undefined || req.body?.hours === null ? Number(featureSetting<number>(S(res), 'downtimeTravelHours') ?? 2) : Number(req.body.hours);
      if (!Number.isInteger(h) || h < 0 || h > dayHours(S(res))) throw new HttpError(400, `hours must be a whole number from 1 to ${dayHours(S(res))}`);
      if (h === 0) throw new HttpError(409, 'Travel days give no downtime in this world (travel hours is 0)');
      dayMin = h * 60;
    }
    const before = clock.getClock(db, w);
    let entry: string | null = null;
    if (advance) entry = clock.advance(db, hub, w, days * 1440, `${travel ? 'Travel' : 'Downtime'}: ${days} day${days === 1 ? '' : 's'}${note ? ` (${note})` : ''}`, me(res)).id;
    const rid = id('dtr_');
    run(db, "INSERT INTO downtime_rounds (id, world_id, days, status, note, world_start, world_label, clock_entry, created_by, created_at, kind, day_min) VALUES (?,?,?,'open',?,?,?,?,?,?,?,?)", rid, w, days, note, before.minutes, before.label, entry, me(res), now(), travel ? 'travel' : 'downtime', dayMin);
    audit(d, w, me(res), 'downtime.round', `${days} days`);
    roundChanged(w, rid, 'open');
    res.status(201).json({ round: roundView(res, roundRow(db, w, rid)) });
  });

  /**
   * A player's pick: { skip?: true, picks: [{ taskId | activityId | activity: { name, summary, ... }, days }], note? }.
   * The DM may pick for a player ({ player }). A new pick replaces the earlier one. Rid "current" is the open round.
   */
  r.post('/rounds/:rid/pick', requirePlayerOrDM, async (req, res) => {
    need(res);
    const w = W(res);
    const round = req.params.rid === 'current' ? openRound(db, w) : roundRow(db, w, String(req.params.rid));
    if (!round) throw new HttpError(404, 'No downtime round is open');
    if (round.status !== 'open') throw new HttpError(409, 'That downtime round is closed');
    const b = req.body ?? {};
    const aid = isDM(res) ? findPlayer(d, w, b.player ?? b.accountId) : me(res);
    const skip = b.skip === true;
    const raw: any[] = skip ? [] : Array.isArray(b.picks) ? b.picks.slice(0, 12) : [];
    if (!skip && !raw.length) throw new HttpError(400, 'Pick at least one task, or skip');
    const picks: DayPick[] = [];
    const made: any[] = [];
    for (const p of raw) {
      const days = p?.days === undefined ? round.days : Number(p.days);
      let tid = typeof p?.taskId === 'string' ? p.taskId : null;
      if (!tid) {
        const ref = { activityId: p?.activityId, activity: p?.activity, player: aid };
        if (!ref.activityId && !ref.activity) throw new HttpError(400, 'Each pick needs a taskId, an activityId or a new activity');
        // Starting an activity already on this character's list just works on it.
        const act = ref.activityId ? findActivity(res, aid, ref.activityId) : null;
        const have = act ? listTasks(db, w, { accountId: act.group ? PARTY : aid, open: true }).find((x) => x.activity_id === act.id && x.status !== 'done') : null;
        if (have) tid = have.id;
        else { const row = await start(res, isDM(res) ? ref : { activityId: ref.activityId, activity: ref.activity }); made.push(row); tid = row.id; }
      }
      picks.push({ taskId: tid!, days });
    }
    cancelPending(db, w, round.id, aid, me(res));
    let result;
    try { result = applyPick(d, w, round, aid, picks, skip, me(res), typeof b.note === 'string' ? b.note.slice(0, 300) : ''); } catch (e) {
      // A pick that does not fit leaves no new empty tasks behind.
      for (const m of made) run(db, "UPDATE downtime_tasks SET status = 'removed', updated_at = ? WHERE id = ? AND done_min = 0", now(), m.id);
      throw e;
    }
    for (const f of result.finished) afterFinish(w, f);
    // Something may happen on those days: a quick-time event for the player to roll.
    const events = skip ? [] : rollForPick(d, w, round.id, aid, picks);
    changed(w, aid);
    roundChanged(w, round.id, 'open');
    res.json({ round: roundView(res, roundRow(db, w, round.id)), finished: result.finished.map((x) => out(res, x)), events });
  });

  /** The DM closes the round. Players who did not answer are logged as missed. */
  r.post('/rounds/:rid/close', requireDM, (req, res) => {
    const w = W(res);
    const round = req.params.rid === 'current' ? openRound(db, w) : roundRow(db, w, String(req.params.rid));
    if (!round || round.status !== 'open') throw new HttpError(404, 'No open downtime round');
    tx(db, () => {
      const answered = new Set(all<any>(db, 'SELECT account_id FROM downtime_picks WHERE round_id = ?', round.id).map((x) => x.account_id));
      for (const aid of players(w)) if (!answered.has(aid)) writeLog(db, w, { accountId: aid, kind: 'missed', roundId: round.id, by: me(res), note: `No pick for ${round.days} day${round.days === 1 ? '' : 's'} of downtime` });
      run(db, "UPDATE downtime_rounds SET status = 'closed', closed_at = ? WHERE id = ?", now(), round.id);
    });
    roundChanged(w, round.id, 'closed');
    changed(w, null);
    res.json({ round: roundView(res, roundRow(db, w, round.id)) });
  });

  /** The DM takes the round back: every pick is undone and the world clock goes back (when nothing moved it since). */
  r.post('/rounds/:rid/cancel', requireDM, (req, res) => {
    const w = W(res);
    const round = req.params.rid === 'current' ? openRound(db, w) : roundRow(db, w, String(req.params.rid));
    if (!round || round.status !== 'open') throw new HttpError(404, 'No open downtime round');
    tx(db, () => {
      for (const p of all<any>(db, 'SELECT account_id FROM downtime_picks WHERE round_id = ?', round.id)) undoPick(d, w, round.id, p.account_id, me(res));
      cancelPending(db, w, round.id, null, me(res));
      run(db, "UPDATE downtime_rounds SET status = 'cancelled', closed_at = ? WHERE id = ?", now(), round.id);
    });
    let clockBack = false;
    if (round.clock_entry) { try { clock.undo(db, hub, w, round.clock_entry, me(res)); clockBack = true; } catch { /* the clock moved since */ } }
    roundChanged(w, round.id, 'cancelled');
    changed(w, null);
    res.json({ ok: true, clockBack });
  });

  // ---- random events: quick-time checks on downtime days ----

  r.get('/events', (req, res) => {
    guestNo(res);
    const w = W(res);
    const nm = nameMap(w);
    const aid = whose(res, req.query.player);
    const st = typeof req.query.status === 'string' && ['pending', 'success', 'failure', 'cancelled'].includes(req.query.status) ? req.query.status : null;
    const where = ['world_id = ?'];
    const args: unknown[] = [w];
    if (aid) { where.push('account_id = ?'); args.push(aid); }
    if (st) { where.push('status = ?'); args.push(st); }
    if (typeof req.query.round === 'string' && req.query.round) { where.push('round_id = ?'); args.push(req.query.round === 'current' ? openRound(db, w)?.id ?? '' : req.query.round); }
    const rows = all<any>(db, `SELECT * FROM downtime_events WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, ...args, Math.min(Math.max(Number(req.query.limit) || 50, 1), 200));
    res.json({ events: rows.map((x) => ({ ...eventOut(x), player: nm[x.account_id] ?? '' })) });
  });

  function settle(res: Response, eid: string, how: { bonus?: number; total?: number; result?: 'success' | 'failure' }) {
    const w = W(res);
    const r = resolveEvent(d, w, eid, how, me(res));
    announce(hub, w, r);
    const nm = nameMap(w)[r.event.accountId] ?? 'Someone';
    try { postChat(d, w, 'table', me(res), isDM(res) ? 'dm' : 'player', `🎲 ${nm}, during **${r.event.task}**: ${r.event.title}. ${r.event.note}`); } catch { /* no session running: the log has it */ }
    return { ...r.event, outcomeText: outcomeText(r.outcome) };
  }

  /** Roll a pending event: { bonus } for d20 + bonus on the server, or { total } typed from the player's own dice. */
  r.post('/events/:id/roll', requirePlayerOrDM, (req, res) => {
    need(res);
    const w = W(res);
    const e = eventRow(db, w, String(req.params.id));
    if (!e || (!isDM(res) && e.account_id !== me(res))) throw new HttpError(404, 'Event not found');
    const n = (v: unknown, what: string, lo: number, hi: number) => { const x = Number(v); if (!Number.isInteger(x) || x < lo || x > hi) throw new HttpError(400, `${what} must be a whole number from ${lo} to ${hi}`); return x; };
    const b = req.body ?? {};
    const how = b.total !== undefined && b.total !== null && b.total !== '' ? { total: n(b.total, 'total', -10, 60) } : { bonus: b.bonus === undefined || b.bonus === null || b.bonus === '' ? 0 : n(b.bonus, 'bonus', -10, 30) };
    res.json(settle(res, e.id, how));
  });

  /** The DM decides an event without a roll, or cancels it: { result: success | failure | cancel, note? }. */
  r.post('/events/:id/decide', requireDM, (req, res) => {
    need(res);
    const w = W(res);
    const e = eventRow(db, w, String(req.params.id));
    if (!e) throw new HttpError(404, 'Event not found');
    const result = req.body?.result;
    if (result === 'cancel') {
      if (e.status !== 'pending') throw new HttpError(409, 'That event is already settled');
      run(db, "UPDATE downtime_events SET status = 'cancelled', resolved_at = ?, resolved_by = ?, note = ? WHERE id = ?", now(), me(res), typeof req.body?.note === 'string' ? req.body.note.slice(0, 300) : 'Cancelled by the DM', e.id);
      writeLog(db, w, { accountId: e.account_id, taskId: e.task_id, taskName: e.task_name, kind: 'event', roundId: e.round_id, by: me(res), note: `${eventOut(e).title}: cancelled` });
      hub.emit(w, 'downtime-event', { accountId: e.account_id, ids: [e.id] }, dmAnd(e.account_id));
      return res.json(eventOut(eventRow(db, w, e.id)));
    }
    if (result !== 'success' && result !== 'failure') throw new HttpError(400, 'result must be success, failure or cancel');
    res.json(settle(res, e.id, { result }));
  });

  // ---- the helper model: rank and decide ----

  /** Rank the activities a character could start for what they want: { player? (DM), want? }. */
  r.post('/suggest', requirePlayerOrDM, async (req, res) => {
    need(res);
    const w = W(res);
    const aid = isDM(res) ? findPlayer(d, w, req.body?.player) : me(res);
    const mine = listTasks(db, w, { accountId: aid, open: true, withGroup: true });
    const busy = new Set(mine.map((x) => x.activity_id));
    const options = offer(res, aid).filter((a) => a.status === 'ok' && (a.repeatable || !busy.has(a.id)));
    const ch = one<any>(db, "SELECT m.character_name, c.class, c.level FROM members m LEFT JOIN spells_chars c ON c.world_id = m.world_id AND c.account_id = m.account_id WHERE m.world_id = ? AND m.account_id = ?", w, aid);
    const lately = all<any>(db, "SELECT DISTINCT task_name FROM downtime_log WHERE world_id = ? AND account_id = ? AND kind IN ('work','complete') ORDER BY at DESC LIMIT 5", w, aid).map((x) => x.task_name);
    const who = [ch?.character_name, ch?.class && `${ch.class}${ch.level ? ` level ${ch.level}` : ''}`, mine.length && `working on ${mine.map((x) => x.name).join(', ')}`, lately.length && `lately did ${lately.join(', ')}`].filter(Boolean).join('; ');
    const want = typeof req.body?.want === 'string' ? req.body.want.slice(0, 300) : '';
    res.json(await rankActivities(d, options, want, who, Math.min(Math.max(Number(req.body?.n) || 3, 1), 5)));
  });

  /** Decide a new activity's tier, days and hours a day: { name, summary }. */
  r.post('/decide', requirePlayerOrDM, async (req, res) => {
    need(res);
    if (!isDM(res) && featureSetting<string>(S(res), 'downtimePlayerNew') === 'off') throw new HttpError(403, 'Only the DM makes new activities in this world');
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
    if (!name) throw new HttpError(400, 'name is needed');
    res.json(await decideTier(d, name, typeof req.body?.summary === 'string' ? req.body.summary.slice(0, 600) : '', tierDays(S(res)), dayHours(S(res))));
  });

  return r;
}

const P = (description: string) => ({ type: 'string', description });

const feature: Feature = {
  id: 'downtime',
  schema: SCHEMA + EVENTS_SCHEMA,
  migrate: migrateRounds,
  settings: {
    downtimeOn: { type: 'boolean', default: false },
    downtimeDayHours: { type: 'int', default: 8, min: 1, max: 24 },
    downtimePlayerNew: { type: 'enum', values: ['approve', 'free', 'off'], default: 'approve' },
    downtimeAdvanceClock: { type: 'boolean', default: true },
    downtimeAutoReward: { type: 'boolean', default: false },
    downtimeEventChance: { type: 'int', default: 10, min: 0, max: 100 },
    downtimeTravelHours: { type: 'int', default: 2, min: 0, max: 24 },
    downtimeTierDays: { type: 'json', default: { ...DEFAULT_TIER_DAYS }, validate: checkTierDays },
    downtimePremade: { type: 'json', default: [], validate: checkPremade },
  },
  worldMount: 'downtime',
  worldRoutes: routes,
  houseRules: ['downtime'],
  mcpTools: [
    {
      name: 'downtime', description: "DownTime (downtime activities): each character's personal tasks and the party's shared group tasks (scope personal|group, members, each one's share) with progress, tier, time left and reward, and the open Downtime round with who has picked. The DM sees everyone (or one player); a player sees their own.",
      props: { player: P('DM: one player (name or id)'), all: { type: 'boolean', description: 'Include finished and removed tasks' } },
      call: (a) => ({ method: 'GET', path: `/downtime?${[a.player && `player=${enc(a.player)}`, a.all && 'all=1'].filter(Boolean).join('&')}` }),
    },
    {
      name: 'downtime_log', description: 'The downtime log: what was worked on, when (real time and in-world date), for how long, time added or lost, tasks started, stopped, finished and rewarded.',
      props: { player: P('DM: one player'), task: P('Task id'), limit: { type: 'integer' } },
      call: (a) => ({ method: 'GET', path: `/downtime/log?${[a.player && `player=${enc(a.player)}`, a.task && `task=${enc(a.task)}`, a.limit && `limit=${enc(String(a.limit))}`].filter(Boolean).join('&')}` }),
    },
    {
      name: 'downtime_activities', description: 'Downtime activities a character can start (ready-made, the DM\'s, players\', and Codex spell crafting), each with tier (common to legendary), days and hours a day.',
      props: { player: P('DM: whose options (adds their Codex crafts)') },
      call: (a) => ({ method: 'GET', path: `/downtime/activities${a.player ? `?player=${enc(a.player)}` : ''}` }),
    },
    {
      name: 'downtime_suggest', description: 'Rank downtime activities for what a character wants (e.g. "earn money", "get stronger") with the small helper model; returns the best three with a reason each.',
      props: { player: P('DM: which player'), want: P('What they want from their downtime') },
      call: (a) => ({ method: 'POST', path: '/downtime/suggest', body: { player: a.player, want: a.want } }),
    },
    {
      name: 'downtime_events', description: 'Random downtime events (quick-time checks that happened on downtime days): the event, its check and DC, what success and failure do, and the result. status pending lists the ones waiting for a roll.',
      props: { player: P('DM: one player'), status: { type: 'string', enum: ['pending', 'success', 'failure', 'cancelled'] } },
      call: (a) => ({ method: 'GET', path: `/downtime/events?${[a.player && `player=${enc(a.player)}`, a.status && `status=${enc(a.status)}`].filter(Boolean).join('&')}` }),
    },
    {
      name: 'downtime_event_roll', playerOnly: true,
      description: 'Roll your pending downtime event: bonus is your modifier for its check (the server rolls the d20), or total if you rolled your own dice.',
      props: { event: P('Event id'), bonus: { type: 'integer' }, total: { type: 'integer' } }, required: ['event'],
      call: (a) => ({ method: 'POST', path: `/downtime/events/${enc(a.event)}/roll`, body: { bonus: a.bonus, total: a.total } }),
    },
    {
      name: 'downtime_event_decide', write: true, dmOnly: true,
      description: 'Decide a pending downtime event without a roll (success or failure, applying its outcome) or cancel it.',
      props: { event: P('Event id'), result: { type: 'string', enum: ['success', 'failure', 'cancel'] }, note: P('Why') }, required: ['event', 'result'],
      call: (a) => ({ method: 'POST', path: `/downtime/events/${enc(a.event)}/decide`, body: { result: a.result, note: a.note } }),
    },
    {
      name: 'downtime_start', playerOnly: true,
      description: 'Start one of your own downtime tasks: an activity by id or name, or a new activity { name, summary } (its tier is decided for you; the DM may need to approve it).',
      props: { activityId: P('Activity id or name'), activity: { type: 'object', description: '{ name, summary } for a new activity' }, group: { type: 'boolean', description: 'A group activity the whole party shares (you join it)' } },
      call: (a) => ({ method: 'POST', path: '/downtime/tasks', body: { activityId: a.activityId, activity: a.activity, group: a.group } }),
    },
    {
      name: 'downtime_pick', playerOnly: true,
      description: 'Answer the open Downtime round for yourself: picks [{ taskId or activityId, days }] (fits in the round\'s days), or skip: true.',
      props: { picks: { type: 'array', items: { type: 'object' }, description: '[{ taskId | activityId, days }]' }, skip: { type: 'boolean' }, note: P('Optional note') },
      call: (a) => ({ method: 'POST', path: '/downtime/rounds/current/pick', body: { picks: a.picks, skip: a.skip, note: a.note } }),
    },
    {
      name: 'downtime_assign', write: true, dmOnly: true,
      description: 'Give a player (or, with group: true, the whole party) a downtime task: an activity (id or name) or a new one { name, summary, tier (common|uncommon|rare|very-rare|legendary), days?, hoursPerDay? }, with an optional reward { text, gp, item, qty, hidden } and a private DM note.',
      props: { player: P('Player name or id (leave out with group: true for the whole party)'), group: { type: 'boolean', description: 'A group task: the party shares its progress and the reward goes to the party pouch' }, activityId: P('Activity id or name'), activity: { type: 'object' }, reward: { type: 'object' }, dmNote: P('Only the DM sees it'), save: { type: 'boolean', description: 'Also add a new activity to the world\'s list' } },
      call: (a) => ({ method: 'POST', path: '/downtime/tasks', body: a }),
    },
    {
      name: 'downtime_time', write: true, dmOnly: true,
      description: 'Add or take away time on a downtime task (negative takes it away), e.g. lost two days to illness. Logged with the note.',
      props: { task: P('Task id or name'), player: P('Whose task, when naming it'), days: { type: 'number' }, hours: { type: 'number' }, note: P('Why') },
      required: ['task'],
      call: (a) => ({ method: 'POST', path: `/downtime/tasks/${enc(a.task)}/time`, body: { player: a.player, days: a.days, hours: a.hours, note: a.note } }),
    },
    {
      name: 'downtime_work', write: true, dmOnly: true,
      description: 'Log downtime work done outside a Downtime round (e.g. "Mira spent 3 days crafting"). Finishes the task when its time is done.',
      props: { task: P('Task id or name'), player: P('Whose task'), worker: P('On a group task: the player who did the work'), days: { type: 'number' }, hours: { type: 'number' }, note: P('Note') },
      required: ['task'],
      call: (a) => ({ method: 'POST', path: `/downtime/tasks/${enc(a.task)}/work`, body: { player: a.player, worker: a.worker, days: a.days, hours: a.hours, note: a.note } }),
    },
    {
      name: 'downtime_update', write: true, dmOnly: true,
      description: 'Change a downtime task: name, tier, days, hoursPerDay, reward, dmNote, status paused|active, or approve: true for a player\'s new activity.',
      props: { task: P('Task id or name'), player: P('Whose task'), name: P(''), tier: { type: 'string', enum: [...TIERS] }, days: { type: 'integer' }, hoursPerDay: { type: 'integer' }, reward: { type: 'object' }, dmNote: P(''), status: { type: 'string', enum: ['paused', 'active'] }, approve: { type: 'boolean' } },
      required: ['task'],
      call: (a) => { const { task, ...body } = a; return { method: 'PATCH', path: `/downtime/tasks/${enc(task)}`, body }; },
    },
    {
      name: 'downtime_remove', write: true, dmOnly: true,
      description: 'Stop a downtime task midway. The work done stays in the log.',
      props: { task: P('Task id or name'), player: P('Whose task'), note: P('Why') }, required: ['task'],
      call: (a) => ({ method: 'DELETE', path: `/downtime/tasks/${enc(a.task)}?${[a.player && `player=${enc(a.player)}`, a.note && `note=${enc(a.note)}`].filter(Boolean).join('&')}` }),
    },
    {
      name: 'downtime_reward', write: true, dmOnly: true,
      description: "Give a finished downtime task's reward (coin to the purse, the item to the inventory, a line in table chat).",
      props: { task: P('Task id or name'), player: P('Whose task'), note: P('') }, required: ['task'],
      call: (a) => ({ method: 'POST', path: `/downtime/tasks/${enc(a.task)}/reward`, body: { player: a.player, note: a.note } }),
    },
    {
      name: 'downtime_round', write: true, dmOnly: true,
      description: 'Press Downtime: N days pass and every player gets a popup to pick their downtime (or skip, or make a new activity). Moves the world clock unless advance is false. travel: true for days on the road, where only a few hours a day (the world\'s travel hours, or hours) go to downtime.',
      props: { days: { type: 'integer', description: 'Days of downtime (default 1)' }, travel: { type: 'boolean', description: 'Travel days: only a few hours a day' }, hours: { type: 'integer', description: 'Travel: hours a day for downtime' }, note: P('e.g. "Resting in Saltmarsh"'), advance: { type: 'boolean' } },
      call: (a) => ({ method: 'POST', path: '/downtime/rounds', body: a }),
    },
    {
      name: 'downtime_close_round', write: true, dmOnly: true,
      description: 'Close the open Downtime round (players who did not pick are logged as missed). cancel: true undoes every pick and puts the clock back.',
      props: { cancel: { type: 'boolean' } },
      call: (a) => ({ method: 'POST', path: `/downtime/rounds/current/${a.cancel ? 'cancel' : 'close'}`, body: {} }),
    },
  ],
};
export default feature;
