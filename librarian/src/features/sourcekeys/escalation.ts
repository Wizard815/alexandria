// Escalation instead of leaks (PLAN §17.3). When a player's question needs
// content their own view does not have (DM-only, broker or classified text, or
// anything that came through a blanket or unsure key), it is not answered. It
// becomes, by the world setting `escalation`:
//
//   dm-question  a DM-only question in the DM queue; the DM answers or refuses.
//   broker-deal  a high-level broker request the DM prices (the wait is a
//                number of sessions, `escalationSessions`); delivered only
//                after the DM approves it and the player pays.
//
// The player only ever sees "The broker will look into it", and later the
// DM's own answer. What the hidden source said (`hidden`) is for the DM alone
// and is never sent to the player or to any model.
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { dmAnd, dmOnly } from '../../core/events.ts';
import { DEFAULT_SETTINGS, featureSetting, type WorldSettings } from '../../core/policy.ts';
import { HttpError, id, now, parseJson } from '../../core/util.ts';
import { routeQuestion, LOW_CONFIDENCE, type Labels } from '../broker2/routing.ts';
import { visibleItems } from '../broker2/other.ts';
import { searchLive, type SourceRow } from './live.ts';
import { auditKey, auditUse, usesOf, worldKeys } from './store.ts';

export const LOOKING = 'The broker will look into it.';
export type Mode = 'dm-question' | 'broker-deal';

export interface HiddenItem { title: string; source: string; text: string }
/** For the DM only. */
export interface Hidden { reason: string; via?: string; items?: HiddenItem[]; routing?: Labels | null }

export const worldSettings = (d: Deps, worldId: string): WorldSettings => ({ ...DEFAULT_SETTINGS, ...parseJson(one<any>(d.db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings, {}) });

/** The mode this world uses. A world with the broker closed has no deals to make: it asks the DM. */
export function modeFor(s: WorldSettings): Mode {
  const m = featureSetting<string>(s, 'escalation') === 'dm-question' ? 'dm-question' : 'broker-deal';
  return m === 'broker-deal' && !s.brokerEnabled ? 'dm-question' : m;
}

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export interface EscRow {
  id: string; world_id: string; account_id: string; question: string; origin: string; mode: string; status: string; hidden: string;
  broker_request_id: string | null; answer: string | null; cost_cp: number | null; sessions: number | null; note: string | null;
  created_at: string; resolved_at: string | null; resolved_by: string | null;
}

/**
 * Put a question in the DM's hands. The same question from the same person,
 * while one is still open, is the same escalation. Returns the row, and the
 * broker request made for it in broker-deal mode.
 */
export function escalate(d: Deps, a: { worldId: string; accountId: string; question: string; origin: 'agent' | 'broker' | 'direct'; hidden: Hidden; brokerRequestId?: string | null }): EscRow {
  const q = a.question.trim().slice(0, 500);
  const open = all<EscRow>(d.db, `SELECT * FROM sourcekeys_escalations WHERE world_id = ? AND account_id = ? AND status = 'open'`, a.worldId, a.accountId).find((e) => norm(e.question) === norm(q));
  if (open) return open;
  const mode = modeFor(worldSettings(d, a.worldId));
  let brokerId: string | null = a.brokerRequestId ?? null;
  if (!brokerId && mode === 'broker-deal') {
    brokerId = id('brk_');
    const cls = { type: 'other', verdict: null, reason: 'Escalated: the answer needs content beyond the asker\'s own view. The hidden context is in the DM queue.', entities: [], knowledge: 'secret', multiplier: 1, player: null, dmEvidence: [], routing: a.hidden.routing ?? null };
    run(d.db, `INSERT INTO broker_requests (id, world_id, account_id, question, length, tier, status, created_at, classification) VALUES (?, ?, ?, ?, 'short', 'secret', 'pricing', ?, ?)`, brokerId, a.worldId, a.accountId, q, now(), JSON.stringify(cls));
    d.hub.emit(a.worldId, 'broker', { id: brokerId, status: 'pricing' }, dmAnd(a.accountId));
  }
  const eid = id('esc_');
  run(d.db, `INSERT INTO sourcekeys_escalations (id, world_id, account_id, question, origin, mode, status, hidden, broker_request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    eid, a.worldId, a.accountId, q, a.origin, mode, JSON.stringify(a.hidden), brokerId, now());
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', a.worldId, a.accountId, 'sourcekeys.escalate', `${eid} ${a.origin} ${mode}`, now());
  // The event names no text: the DM's screen reloads its queue.
  d.hub.emit(a.worldId, 'sourcekeys', { kind: 'escalation', id: eid }, dmOnly);
  return one<EscRow>(d.db, 'SELECT * FROM sourcekeys_escalations WHERE id = ?', eid)!;
}

/** Add what a hidden lookup found to an escalation's DM-only context. */
export function addHidden(d: Deps, eid: string, more: HiddenItem[], via?: string) {
  const e = one<EscRow>(d.db, 'SELECT * FROM sourcekeys_escalations WHERE id = ?', eid);
  if (!e) return;
  const h = parseJson<Hidden>(e.hidden, { reason: '' });
  h.items = [...(h.items ?? []), ...more].slice(0, 12);
  if (via) h.via = via;
  run(d.db, 'UPDATE sourcekeys_escalations SET hidden = ? WHERE id = ?', JSON.stringify(h), eid);
}

/**
 * What the world's keys the DM allowed for the broker find for this question:
 * titles and a short DM-side excerpt, for the DM queue. Best effort and DM
 * only; classified pages show their title and not their text.
 */
export async function gatherContext(d: Deps, worldId: string, accountId: string, question: string): Promise<HiddenItem[]> {
  const out: HiddenItem[] = [];
  for (const k of worldKeys(d.db, worldId)) {
    // Only keys the DM owns, with the broker use. A player's own key is never used to answer for someone else.
    if (k.revoked || !k.verified || !usesOf(k).includes('broker') || !one(d.db, `SELECT 1 FROM members WHERE world_id = ? AND account_id = ? AND role = 'dm'`, worldId, k.owner_id)) continue;
    const src = one<SourceRow>(d.db, 'SELECT * FROM sources WHERE id = ?', k.source_id);
    if (!src) continue;
    try {
      auditUse(d.db, k, accountId, 'broker', `question by ${accountId}`);
      for (const hit of await searchLive(d, src, k.secret, question, 5)) out.push(excerpt(d, worldId, src, hit.externalId, hit.title));
    } catch { /* the source is down: the DM sees nothing from it */ }
  }
  return out.slice(0, 12);
}

/** A DM-side excerpt of a stored page (never classified text). */
export function excerpt(d: Deps, worldId: string, src: { id: string; name: string }, externalId: string, title: string): HiddenItem {
  const pg = one<any>(d.db, 'SELECT title, visibility, body FROM pages WHERE world_id = ? AND source_id = ? AND external_id = ?', worldId, src.id, externalId);
  const text = !pg ? '(not in the library yet: sync the source)' : pg.visibility === 'classified' ? '(classified: open the page to read it)' : String(pg.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  return { title: pg?.title ?? title, source: src.name, text };
}

// ---- views ---------------------------------------------------------------------------

interface Broker { status: string; answer: string | null; cost_cp: number | null }
const brokerOf = (d: Deps, e: EscRow): Broker | undefined => (e.broker_request_id ? one<Broker>(d.db, 'SELECT status, answer, cost_cp FROM broker_requests WHERE id = ?', e.broker_request_id) : undefined);

/** Where the escalation stands now: the broker's own row decides while there is one (the DM may use the Broker page too). */
export function effectiveStatus(d: Deps, e: EscRow): 'open' | 'offered' | 'waiting' | 'answered' | 'refused' | 'declined' {
  const b = brokerOf(d, e);
  if (b && ['open'].includes(e.status)) {
    if (b.status === 'pricing') return 'open';
    if (b.status === 'offered') return 'offered';
    if (b.status === 'waiting') return 'waiting';
    if (b.status === 'answered') return 'answered';
    if (b.status === 'declined') return 'declined';
    return 'refused';
  }
  return e.status === 'answered' ? 'answered' : e.status === 'refused' ? 'refused' : e.status === 'declined' ? 'declined' : 'open';
}

/** What the asker sees: the question, a status, a plain line, and the answer only once the DM has given it. Never the hidden context. */
export function playerView(d: Deps, e: EscRow) {
  const status = effectiveStatus(d, e);
  const b = brokerOf(d, e);
  const line = status === 'open' ? LOOKING : status === 'offered' ? 'The broker has a price for this. Open the Broker page to accept or decline.' : status === 'waiting' ? 'Paid. The broker is working on it.' : status === 'declined' ? 'You turned the offer down.' : status === 'refused' ? 'The broker has nothing for you on that.' : '';
  return {
    id: e.id, question: e.question, status, message: line, createdAt: e.created_at, mode: e.mode,
    answer: status === 'answered' ? e.answer ?? b?.answer ?? '' : null,
    costCp: status === 'offered' ? b?.cost_cp ?? e.cost_cp : null, brokerRequestId: e.broker_request_id,
  };
}

export function dmView(d: Deps, e: EscRow, names: Record<string, string>) {
  return { ...playerView(d, e), askerId: e.account_id, askerName: names[e.account_id] ?? 'Someone', origin: e.origin, hidden: parseJson<Hidden>(e.hidden, { reason: '' }), sessions: e.sessions, resolvedAt: e.resolved_at };
}

// ---- what the DM does ----------------------------------------------------------------

const open = (d: Deps, worldId: string, eid: string): EscRow => {
  const e = one<EscRow>(d.db, 'SELECT * FROM sourcekeys_escalations WHERE id = ? AND world_id = ?', eid, worldId);
  if (!e) throw new HttpError(404, 'Question not found');
  if (e.status !== 'open' || effectiveStatus(d, e) !== 'open') throw new HttpError(409, 'This question is not waiting for you any more');
  return e;
};

/** The DM's own answer, free. It is the DM's words: what they typed is what the player gets. */
export function answer(d: Deps, worldId: string, eid: string, text: string, by: string): EscRow {
  const e = open(d, worldId, eid);
  run(d.db, `UPDATE sourcekeys_escalations SET status = 'answered', answer = ?, resolved_at = ?, resolved_by = ? WHERE id = ?`, text, now(), by, e.id);
  if (e.broker_request_id) run(d.db, `UPDATE broker_requests SET status = 'answered', dm_written = 1, cost_cp = 0, answer = ?, sources = '[]', delivered_at = ? WHERE id = ? AND status = 'pricing'`, text, now(), e.broker_request_id);
  auditKey(d.db, worldId, by, 'answer', e.id);
  tell(d, e);
  return one<EscRow>(d.db, 'SELECT * FROM sourcekeys_escalations WHERE id = ?', e.id)!;
}

/** Minutes until the end of the Nth scheduled game session from now, or null when fewer are scheduled. */
export function minutesForSessions(d: Deps, worldId: string, sessions: number): number | null {
  if (sessions < 1) return 0;
  try {
    const s = one<any>(d.db, `SELECT ends_at FROM cal_sessions WHERE world_id = ? AND status = 'scheduled' AND ends_at > ? ORDER BY starts_at LIMIT 1 OFFSET ?`, worldId, now(), sessions - 1);
    return s ? Math.max(1, Math.ceil((Date.parse(s.ends_at) - Date.now()) / 60_000)) : null;
  } catch { return null; }
}

/** The DM prices a deal: a cost, the sessions to wait, and the answer that is delivered when it is paid and the wait is over. */
export function price(d: Deps, worldId: string, eid: string, a: { costCp: number; sessions: number; answer: string; note?: string }, by: string): EscRow {
  const e = open(d, worldId, eid);
  if (!e.broker_request_id) throw new HttpError(409, 'This question was not made a broker deal in this world. Answer it instead.');
  const mins = minutesForSessions(d, worldId, a.sessions);
  // Fewer sessions are scheduled than the wait: a week of real time for each one.
  const wait = mins !== null ? { amount: mins, unit: 'minutes', clock: 'real' } : { amount: a.sessions * 7, unit: 'days', clock: 'real' };
  run(d.db, `UPDATE broker_requests SET status = 'offered', dm_written = 1, cost_cp = ?, wait_clock = ?, ready_at = ?, answer = ?, dm_note = ? WHERE id = ? AND status = 'pricing'`, a.costCp, wait.clock, JSON.stringify(wait), a.answer, a.note || null, e.broker_request_id);
  run(d.db, 'UPDATE sourcekeys_escalations SET cost_cp = ?, sessions = ?, answer = ?, note = ? WHERE id = ?', a.costCp, a.sessions, a.answer, a.note || null, e.id);
  auditKey(d.db, worldId, by, 'price', `${e.id} ${a.costCp}cp ${a.sessions} sessions`);
  d.hub.emit(worldId, 'broker', { id: e.broker_request_id, status: 'offered' }, dmAnd(e.account_id));
  tell(d, e);
  return one<EscRow>(d.db, 'SELECT * FROM sourcekeys_escalations WHERE id = ?', e.id)!;
}

export function refuse(d: Deps, worldId: string, eid: string, note: string, by: string): EscRow {
  const e = open(d, worldId, eid);
  run(d.db, `UPDATE sourcekeys_escalations SET status = 'refused', note = ?, resolved_at = ?, resolved_by = ? WHERE id = ?`, note || null, now(), by, e.id);
  if (e.broker_request_id) run(d.db, `UPDATE broker_requests SET status = 'refused', dm_note = ? WHERE id = ? AND status = 'pricing'`, note || null, e.broker_request_id);
  auditKey(d.db, worldId, by, 'refuse', e.id);
  tell(d, e);
  return one<EscRow>(d.db, 'SELECT * FROM sourcekeys_escalations WHERE id = ?', e.id)!;
}

function tell(d: Deps, e: EscRow) {
  d.hub.emit(e.world_id, 'sourcekeys', { kind: 'escalation', id: e.id }, dmAnd(e.account_id));
  if (e.broker_request_id) d.hub.emit(e.world_id, 'broker', { id: e.broker_request_id }, dmAnd(e.account_id));
}

// ---- the audit model decides: answerable from the asker's view, or escalate -----------------

export interface Verdict { escalate: boolean; refuse: boolean; message: string; labels: Labels }

/**
 * Reuses the broker's routing. Off topic is turned away free; a rules or item
 * question is answerable without anyone's secrets, so it is not escalated; every
 * other question, and any the audit model is unsure about, is escalated.
 */
export async function judge(d: Deps, worldId: string, accountId: string, question: string): Promise<Verdict> {
  const s = worldSettings(d, worldId);
  const topics = (() => { const v = featureSetting<unknown>(s, 'brokerTopics'); return Array.isArray(v) ? v.map(String).filter(Boolean) : []; })();
  const labels = await routeQuestion(d, worldId, question, topics, visibleItems(d, worldId, accountId).map((i) => i.name));
  const confident = labels.confidence >= LOW_CONFIDENCE;
  if (labels.scope === 'off-topic' && confident) return { escalate: false, refuse: true, message: 'That is not something the broker deals in.', labels };
  if (confident && labels.intent === 'fact' && (labels.scope === 'rules' || labels.scope === 'item')) return { escalate: false, refuse: false, message: 'You can get that answer free without anyone\'s secrets. Ask the assistant or the broker.', labels };
  return { escalate: true, refuse: false, message: LOOKING, labels };
}

