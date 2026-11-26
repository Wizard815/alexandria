// "At a glance": one small read for a home-screen widget (the Android app)
// and the phone home page. The player's own HP and conditions in a fight,
// their mana, the world date, whether a session is running, the next game
// night, open quick events meant for them and what waits for them. The DM
// gets the turn, the session and the queues instead.
//
// GET  /api/worlds/:world/glance        (any member; also a widget key, see below)
// POST /api/worlds/:world/glance/link   (a player or the DM, signed in) makes a widget key
//
// A widget key (alx_wdg_...) is a read key that only ever opens GET .../glance
// for its one world (core/auth.ts refuses it everywhere else), so a phone's home
// screen never holds a key that can read the library.
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { createKey, requirePlayerOrDM, WIDGET_PREFIX, type Auth } from '../../core/auth.ts';
import { combatViewFor } from '../../core/combatView.ts';
import { featureSetting } from '../../core/policy.ts';
import { HttpError, now, parseJson } from '../../core/util.ts';
import { ctx, isDM, me, memberIds, settings } from '../../routes/_shared.ts';
import { getClock } from '../clock/api.ts';
import { character } from '../spells/store.ts';
import { DEFAULT_POOL, poolMax, poolNow } from '../spells/mana.ts';
import { kindsFor } from '../notify/store.ts';

export const WIDGET_LABEL = 'Home-screen widget';
/** Widget keys kept per account and world; making another revokes the oldest. */
export const WIDGET_KEYS_KEPT = 4;


const safe = <T>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };
const count = (d: Deps, sql: string, ...args: unknown[]): number => safe(() => one<{ n: number }>(d.db, sql, ...args)?.n ?? 0, 0);

/** Something worth a notification: shown once per id, opens path when tapped. */
export interface Alert { id: string; kind: 'turn' | 'quick' | 'night' | 'reply' | 'request'; title: string; body: string; path: string }

interface QuickRow { id: string; kind: string; title: string; audience: string; closes_at: string | null; created_at: string }

export function glance(d: Deps, res: any) {
  const c = ctx(res);
  const w = c.world.id;
  const s = settings(res);
  const dm = isDM(res);
  const self = me(res);
  const member = one<any>(d.db, 'SELECT m.character_name, a.display_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.account_id = ?', w, self);
  const clock = safe(() => getClock(d.db, w), null);

  // ---- the fight ----
  const cv: any = combatViewFor(d.db, w, c.viewer, s);
  const st = one<any>(d.db, 'SELECT active, round, turn FROM combat WHERE world_id = ?', w) ?? { active: 0, round: 1, turn: 0 };
  const order = all<any>(d.db, 'SELECT id, name, account_id, hidden, hp, max_hp, temp_hp, effects FROM combatants WHERE world_id = ? ORDER BY initiative DESC, name', w);
  const cur = st.active && order.length ? order[st.turn % order.length] : null;
  const mine = order.find((x) => x.account_id === self) ?? null;
  const combat = {
    active: !!st.active,
    round: st.active ? st.round : null,
    myTurn: !!cur && cur.account_id === self,
    // Whose turn: the DM always; players only when the turn order is shown and it is not a hidden foe.
    turnName: cur && (dm || (s.initiativeVisible && !cur.hidden)) ? cur.name : null,
    // Your own character in the fight: your own numbers are yours to see.
    me: mine ? {
      name: mine.name, hp: mine.hp ?? null, maxHp: mine.max_hp ?? null, tempHp: mine.temp_hp ?? 0,
      conditions: parseJson<any[]>(mine.effects, []).map((e) => (typeof e === 'string' ? e : String(e?.name ?? ''))).filter(Boolean).slice(0, 6),
    } : null,
    ...(dm ? { total: cv.combatants?.length ?? order.length } : {}),
  };

  // ---- mana (only when the world uses it) ----
  let mana: { now: number | null; max: number | null } | null = null;
  if (!dm && featureSetting<boolean>(s, 'spellMana') === true) {
    mana = safe(() => {
      const ch = character(d.db, w, self);
      const rules: any = { on: true, pool: (featureSetting<any>(s, 'spellManaPool') ?? DEFAULT_POOL) };
      const max = poolMax(ch, rules);
      return { now: poolNow(ch, max), max };
    }, null);
  }

  // ---- the session: running now, or the next game night ----
  const rec = safe(() => one<any>(d.db, 'SELECT name, started_at FROM audio_sessions WHERE world_id = ? AND stopped_at IS NULL ORDER BY started_at DESC', w), null);
  const chat = safe(() => one<any>(d.db, 'SELECT title, started_at FROM sessionchat_sessions WHERE world_id = ? AND ended_at IS NULL ORDER BY started_at DESC', w), null);
  const nextRow = s.calendar === 'off' ? null : one<any>(d.db, `SELECT id, title, starts_at, ends_at, location FROM cal_sessions WHERE world_id = ? AND status = 'scheduled' AND ends_at > ? ORDER BY starts_at LIMIT 1`, w, now());
  const nowIso = now();
  const next = nextRow ? {
    title: nextRow.title, startsAt: nextRow.starts_at, endsAt: nextRow.ends_at, location: nextRow.location,
    happening: nextRow.starts_at <= nowIso && nextRow.ends_at > nowIso,
    rsvp: one<any>(d.db, 'SELECT answer FROM cal_rsvps WHERE session_id = ? AND account_id = ?', nextRow.id, self)?.answer ?? null,
    going: count(d, `SELECT COUNT(*) AS n FROM cal_rsvps WHERE session_id = ? AND answer = 'yes'`, nextRow.id),
  } : null;
  const here = count(d, 'SELECT COUNT(*) AS n FROM presence WHERE world_id = ?', w);
  const session = {
    live: !!rec || !!chat || !!next?.happening || combat.active,
    title: chat?.title ?? rec?.name ?? (next?.happening ? next.title : null),
    since: chat?.started_at ?? rec?.started_at ?? null,
    recording: !!rec,
    here,
  };

  // ---- quick events: open ones for me (the DM sees every open one and how many answered) ----
  const players = memberIds(d.db, w, ['player']);
  const open = all<QuickRow>(d.db, `SELECT id, kind, title, audience, closes_at, created_at FROM quick_events WHERE world_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 20`, w);
  const quick = open.map((ev) => {
    const aud = parseJson<string[] | 'party'>(ev.audience, []);
    const ids = aud === 'party' ? players : aud;
    const answered = all<{ account_id: string }>(d.db, 'SELECT account_id FROM quick_responses WHERE event_id = ?', ev.id).map((r) => r.account_id);
    if (dm) return { id: ev.id, kind: ev.kind, title: ev.title, closesAt: ev.closes_at, answers: answered.filter((a) => ids.includes(a)).length, of: ids.length };
    if (!ids.includes(self)) return null;
    return { id: ev.id, kind: ev.kind, title: ev.title, closesAt: ev.closes_at, answered: answered.includes(self) };
  }).filter(Boolean).slice(0, 5);

  // ---- what waits for me ----
  const waiting: Record<string, number> = dm ? {
    requests: count(d, `SELECT COUNT(*) AS n FROM requests WHERE world_id = ? AND status = 'open'`, w),
    approvals: count(d, `SELECT COUNT(*) AS n FROM ledger WHERE world_id = ? AND status = 'pending' AND id NOT IN (SELECT ledger_id FROM shop_orders WHERE ledger_id IS NOT NULL)`, w)
      + count(d, `SELECT COUNT(*) AS n FROM item_changes WHERE world_id = ? AND status IN ('pending', 'disputed')`, w)
      + count(d, `SELECT COUNT(*) AS n FROM agent_actions WHERE world_id = ? AND status = 'pending'`, w),
    broker: count(d, `SELECT COUNT(*) AS n FROM broker_requests WHERE world_id = ? AND (status = 'pricing' OR (status = 'waiting' AND needs_review = 1))`, w),
  } : {
    offers: s.brokerEnabled === false ? 0 : safe(() => all<any>(d.db, `SELECT targets, declined_by FROM broker_offers WHERE world_id = ? AND status = 'open'`, w)
      .filter((o) => { const t = parseJson<string[]>(o.targets, []); return (t.includes(self) || (t.includes('party') && players.includes(self))) && !parseJson<string[]>(o.declined_by, []).includes(self); }).length, 0),
    replies: count(d, `SELECT COUNT(*) AS n FROM requests WHERE world_id = ? AND author_id = ? AND status <> 'open' AND decided_at > ?`, w, self, new Date(Date.now() - 3 * 864e5).toISOString()),
  };

  // ---- alerts: what is worth a notification right now. Each has a stable id, so an app shows
  // it once however often it asks (the Android background check, the page, web push). ----
  const base = `/w/${c.world.slug}${dm ? '/dm' : ''}`;
  const alerts: Alert[] = [];
  if (combat.myTurn && cur) alerts.push({ id: `turn:${w}:${st.round}:${cur.id}`, kind: 'turn', title: 'Your turn', body: `Round ${st.round} in ${c.world.name}${mine ? `: ${mine.name}` : ''}`, path: `${base}/${dm ? 'combat' : 'live'}` });
  for (const q of quick as any[]) {
    if (!dm && !q.answered) alerts.push({ id: `quick:${q.id}`, kind: 'quick', title: q.title || 'Quick event', body: `${c.world.name}: your DM is asking you`, path: `/w/${c.world.slug}/` });
  }
  if (next && !next.happening) {
    const mins = (Date.parse(next.startsAt) - Date.now()) / 60000;
    if (mins > 0 && mins <= 60) alerts.push({ id: `night:${nextRow.id}`, kind: 'night', title: `${next.title} starts soon`, body: `${c.world.name}, in ${Math.max(1, Math.round(mins))} minutes${next.location ? ` at ${next.location}` : ''}`, path: `${base}/calendar` });
  }
  const since = new Date(Date.now() - 864e5).toISOString();
  if (dm) {
    for (const r of safe(() => all<any>(d.db, `SELECT id, title FROM requests WHERE world_id = ? AND status = 'open' AND created_at > ? ORDER BY created_at DESC LIMIT 5`, w, since), [])) {
      alerts.push({ id: `request:${r.id}`, kind: 'request', title: 'New request', body: `${c.world.name}: ${r.title}`, path: `${base}/inbox?tab=requests` });
    }
  } else {
    for (const r of safe(() => all<any>(d.db, `SELECT id, title, status FROM requests WHERE world_id = ? AND author_id = ? AND status <> 'open' AND decided_at > ? ORDER BY decided_at DESC LIMIT 5`, w, self, since), [])) {
      alerts.push({ id: `reply:${r.id}`, kind: 'reply', title: r.status === 'accepted' ? 'Request accepted' : 'Request answered', body: `${c.world.name}: ${r.title}`, path: `/w/${c.world.slug}/` });
    }
  }

  return {
    world: { slug: c.world.slug, name: c.world.name },
    role: c.viewer.role,
    name: member?.character_name || member?.display_name || '',
    date: clock ? clock.label : null,
    combat,
    mana,
    session,
    next,
    quick,
    waiting,
    // Only the kinds this person asked for (Notifications on This device).
    alerts: ((k) => alerts.filter((a) => k[a.kind]).slice(0, 8))(kindsFor(d.db, self)),
    at: nowIso,
  };
}

const feature: Feature = {
  id: 'glance',
  worldMount: 'glance',
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    r.get('/', (_req, res) => { res.json(glance(d, res)); });

    // Made from the app (More, Home-screen widget): a widget key for this world, shown once.
    r.post('/link', requirePlayerOrDM, (_req, res) => {
      const auth = res.locals.auth as Auth;
      if (auth.via !== 'session') throw new HttpError(403, 'Link the widget from a signed-in session, not with a key');
      const c = ctx(res);
      const k = createKey(d.db, auth.account.id, 'scribe', WIDGET_LABEL, c.world.id, 'read', WIDGET_PREFIX);
      // Keep the newest few (a phone and a tablet); older widget keys stop working.
      const old = all<{ id: string }>(d.db, `SELECT id FROM api_keys WHERE account_id = ? AND world_id = ? AND prefix LIKE ? AND revoked = 0 ORDER BY created_at DESC, rowid DESC`, auth.account.id, c.world.id, `${WIDGET_PREFIX}%`).slice(WIDGET_KEYS_KEPT);
      for (const o of old) run(d.db, 'UPDATE api_keys SET revoked = 1 WHERE id = ?', o.id);
      run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', c.world.id, auth.account.id, 'key.create', `widget read ${WIDGET_LABEL}`, now());
      res.status(201).json({ key: k.key, world: c.world.slug, name: c.world.name });
    });
    return r;
  },
};
export default feature;
