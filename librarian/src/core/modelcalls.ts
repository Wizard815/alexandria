// A log of every call to a model, and who may use the /v1 model gateway.
//
// model_calls: one row per request that left for a model server, with the feature and function that asked (read from the stack, so no
// feature needs to say who it is), the model, how long it took and, when the server told, the tokens. The admin page "Model activity"
// reads it (GET /api/admin/models/activity): who has been calling, and how often in the last hour.
//
// model_access: accounts and keys that may use /v1 besides the GM and the admin, with optional daily limits of their own.
import type { DB } from './db.ts';
import { all, one, run } from './db.ts';
import { now } from './util.ts';

export const MODEL_SCHEMA = `
CREATE TABLE IF NOT EXISTS model_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  job TEXT NOT NULL,
  model TEXT,
  feature TEXT NOT NULL,
  reason TEXT,
  via TEXT NOT NULL DEFAULT 'internal',
  account_id TEXT,
  status INTEGER,
  ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER
);
CREATE INDEX IF NOT EXISTS model_calls_at ON model_calls (at);
CREATE INDEX IF NOT EXISTS model_calls_account ON model_calls (via, account_id, at);
CREATE TABLE IF NOT EXISTS model_access (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('account', 'key')),
  subject_id TEXT NOT NULL,
  daily_requests INTEGER,
  daily_tokens INTEGER,
  note TEXT NOT NULL DEFAULT '',
  added_by TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (subject_kind, subject_id)
);
`;

export function ensureModelSchema(db: DB) {
  db.exec(MODEL_SCHEMA);
  // outcome: '' for a call that left for a model; 'refused' (not allowed) or 'limited' (rate or daily cap) for a /v1 call the gate stopped.
  const cols = (db.prepare('PRAGMA table_info(model_calls)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('outcome')) db.exec(`ALTER TABLE model_calls ADD COLUMN outcome TEXT NOT NULL DEFAULT ''`);
}

/** The feature and function that asked, from the stack: src/features/<feature>/..., else the route or core file. */
export function callerOf(): { feature: string; reason: string } {
  const holder: { stack?: string } = {};
  const keep = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  Error.captureStackTrace(holder, callerOf);
  Error.stackTraceLimit = keep;
  for (const line of String(holder.stack ?? '').split('\n').slice(1)) {
    const m = /src\/(?:features|routes|core|intake)\/([A-Za-z0-9_-]+)(?:\.ts|\/)/.exec(line);
    if (!m || /\/core\/(ai|modelcalls)\.ts/.test(line)) continue;
    const fn = /at (?:async )?(?:Object\.)?([A-Za-z_$][\w$]*)/.exec(line)?.[1] ?? '';
    return { feature: m[1], reason: fn.replace(/^async$/, '') };
  }
  return { feature: 'unknown', reason: '' };
}

export interface CallRow { job: string; model?: string | null; feature?: string; reason?: string; via?: 'internal' | 'gateway'; accountId?: string | null; status?: number; ms?: number; tokensIn?: number | null; tokensOut?: number | null; outcome?: '' | 'refused' | 'limited' }

export function recordCall(db: DB, c: CallRow) {
  try {
    const who = c.feature ? { feature: c.feature, reason: c.reason ?? '' } : callerOf();
    run(db, 'INSERT INTO model_calls (at, job, model, feature, reason, via, account_id, status, ms, tokens_in, tokens_out, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      now(), c.job, c.model ?? null, who.feature, who.reason, c.via ?? 'internal', c.accountId ?? null, c.status ?? null, c.ms === undefined ? null : Math.round(c.ms), c.tokensIn ?? null, c.tokensOut ?? null, c.outcome ?? '');
  } catch { /* a database without the log (a test stub) */ }
}

/** Tokens a server reported (OpenAI shape: usage.prompt_tokens / completion_tokens, or input_tokens / output_tokens). */
export function tokensOf(usage: any): { tokensIn: number | null; tokensOut: number | null } {
  const n = (v: unknown) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : null);
  return { tokensIn: n(usage?.prompt_tokens ?? usage?.input_tokens), tokensOut: n(usage?.completion_tokens ?? usage?.output_tokens) };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Per job and feature: the last call, and how many in the last hour and day. Newest first. */
export function activity(db: DB, opts: { limit?: number } = {}) {
  const hour = iso(Date.now() - 3_600_000);
  const day = iso(Date.now() - 86_400_000);
  const groups = all<any>(db, `SELECT job, feature, reason, via, max(at) AS last_at,
      sum(CASE WHEN at >= ? THEN 1 ELSE 0 END) AS last_hour, count(*) AS last_day, sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)) AS tokens_day,
      sum(CASE WHEN status >= 400 OR status = 0 THEN 1 ELSE 0 END) AS errors_day
    FROM model_calls WHERE at >= ? GROUP BY job, feature, reason, via ORDER BY last_at DESC LIMIT 200`, hour, day);
  const recent = all<any>(db, 'SELECT at, job, model, feature, reason, via, account_id, status, ms, tokens_in, tokens_out FROM model_calls ORDER BY id DESC LIMIT ?', Math.min(200, opts.limit ?? 50));
  const perJob = new Map<string, { job: string; lastAt: string; lastHour: number; lastDay: number; features: string[] }>();
  for (const g of groups) {
    const j: { job: string; lastAt: string; lastHour: number; lastDay: number; features: string[] } = perJob.get(g.job) ?? { job: g.job, lastAt: g.last_at, lastHour: 0, lastDay: 0, features: [] as string[] };
    j.lastHour += Number(g.last_hour);
    j.lastDay += Number(g.last_day);
    if (g.last_at > j.lastAt) j.lastAt = g.last_at;
    const f = `${g.via === 'gateway' ? 'gateway' : g.feature}${g.reason && g.via !== 'gateway' ? `.${g.reason}` : ''}`;
    if (!j.features.includes(f)) j.features.push(f);
    perJob.set(g.job, j);
  }
  return {
    jobs: [...perJob.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)),
    callers: groups.map((g) => ({ job: g.job, feature: g.feature, reason: g.reason, via: g.via, lastAt: g.last_at, lastHour: Number(g.last_hour), lastDay: Number(g.last_day), tokensDay: Number(g.tokens_day), errorsDay: Number(g.errors_day) })),
    recent: recent.map((r) => ({ at: r.at, job: r.job, model: r.model, feature: r.feature, reason: r.reason, via: r.via, accountId: r.account_id, status: r.status, ms: r.ms, tokensIn: r.tokens_in, tokensOut: r.tokens_out })),
  };
}

/** Forget calls older than two weeks. */
export function pruneCalls(db: DB) {
  try { run(db, 'DELETE FROM model_calls WHERE at < ?', iso(Date.now() - 14 * 86_400_000)); } catch { /* none */ }
}

// ---- who may use the gateway -------------------------------------------------------------------

export interface Subject { accountId: string; keyId: string | null; isAdmin: boolean; isDm: boolean; viaSession: boolean; viaScribeKey: boolean }

export interface Allowance { allowed: boolean; why: string; dailyRequests: number; dailyTokens: number; ratePerMinute: number }

const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

/** Is this caller allowed through /v1, and with which limits? The admin and a GM (signed in, not by a scribe key) by default; anyone else only when listed. */
export function allowanceOf(db: DB, s: Subject, env: Record<string, string | undefined>): Allowance {
  const staffLimits = { dailyRequests: num(env.ALX_V1_DAILY_REQUESTS_DM, 5000), dailyTokens: num(env.ALX_V1_DAILY_TOKENS_DM, 2_000_000), ratePerMinute: num(env.ALX_V1_RATE_PER_MIN_DM, 120) };
  const guestLimits = { dailyRequests: num(env.ALX_V1_DAILY_REQUESTS, 200), dailyTokens: num(env.ALX_V1_DAILY_TOKENS, 100_000), ratePerMinute: num(env.ALX_V1_RATE_PER_MIN, 20) };
  const listed = (kind: 'account' | 'key', id: string | null) => (id ? one<any>(db, 'SELECT daily_requests, daily_tokens FROM model_access WHERE subject_kind = ? AND subject_id = ?', kind, id) : undefined);
  const key = listed('key', s.keyId);
  const acct = listed('account', s.accountId);
  const row = key ?? acct;
  const withRow = (base: typeof guestLimits) => ({ dailyRequests: row?.daily_requests ?? base.dailyRequests, dailyTokens: row?.daily_tokens ?? base.dailyTokens, ratePerMinute: base.ratePerMinute });
  // A key that is not the admin's own session is listed by itself: a leaked scribe key must not be able to spend the model credit just because its owner is the GM.
  if (s.viaScribeKey) return key ? { allowed: true, why: 'key listed', ...withRow(guestLimits) } : { allowed: false, why: 'scribe keys do not reach the model gateway unless listed', ...guestLimits };
  if (s.isAdmin || s.isDm) return { allowed: true, why: s.isAdmin ? 'admin' : 'dm', ...withRow(staffLimits) };
  if (row) return { allowed: true, why: 'listed', ...withRow(guestLimits) };
  return { allowed: false, why: 'only the GM and the admin use the model gateway', ...guestLimits };
}

const startOfDayUtc = () => { const s = new Date(); s.setUTCHours(0, 0, 0, 0); return s; };

/** Requests and tokens an account has used through the gateway since 00:00 UTC. A call the gate stopped does not count. */
export function usedToday(db: DB, accountId: string) {
  const start = startOfDayUtc();
  const r = one<any>(db, `SELECT count(*) AS n, coalesce(sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)), 0) AS t FROM model_calls WHERE via = 'gateway' AND outcome = '' AND account_id = ? AND at >= ?`, accountId, start.toISOString());
  return { requests: Number(r?.n ?? 0), tokens: Number(r?.t ?? 0) };
}

export const secondsToMidnightUtc = () => { const n = new Date(); const m = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1)); return Math.max(1, Math.ceil((m.getTime() - n.getTime()) / 1000)); };

/**
 * The /v1 call log for the admin: recent gateway calls (who, when, model, tokens, status, refused or limited) and, per account that
 * called today or is listed, today's totals against its caps. Never the prompt or the answer: the log does not hold them.
 */
export function gatewayLog(db: DB, env: Record<string, string | undefined>, opts: { limit?: number } = {}) {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const start = startOfDayUtc().toISOString();
  const calls = all<any>(db, `SELECT c.id, c.at, c.job, c.model, c.reason, c.account_id, a.username, c.status, c.ms, c.tokens_in, c.tokens_out, c.outcome
    FROM model_calls c LEFT JOIN accounts a ON a.id = c.account_id WHERE c.via = 'gateway' ORDER BY c.id DESC LIMIT ?`, limit);
  const today = all<any>(db, `SELECT account_id, sum(CASE WHEN outcome = '' THEN 1 ELSE 0 END) AS n,
      coalesce(sum(CASE WHEN outcome = '' THEN coalesce(tokens_in, 0) + coalesce(tokens_out, 0) ELSE 0 END), 0) AS t,
      sum(CASE WHEN outcome = 'refused' THEN 1 ELSE 0 END) AS refused, sum(CASE WHEN outcome = 'limited' THEN 1 ELSE 0 END) AS limited,
      sum(CASE WHEN outcome = '' AND (status >= 400 OR status = 0) THEN 1 ELSE 0 END) AS errors, max(at) AS last_at
    FROM model_calls WHERE via = 'gateway' AND at >= ? AND account_id IS NOT NULL GROUP BY account_id`, start);
  const ids = new Set<string>(today.map((t) => t.account_id));
  for (const r of all<any>(db, `SELECT subject_id FROM model_access WHERE subject_kind = 'account'`)) ids.add(r.subject_id);
  const users = [...ids].map((id) => {
    const acct = one<any>(db, 'SELECT id, username, is_admin FROM accounts WHERE id = ?', id);
    const isDm = !!one(db, `SELECT 1 FROM members WHERE account_id = ? AND role = 'dm'`, id);
    const a = allowanceOf(db, { accountId: id, keyId: null, isAdmin: !!acct?.is_admin, isDm, viaSession: true, viaScribeKey: false }, env);
    const t = today.find((x) => x.account_id === id);
    return {
      accountId: id, username: acct?.username ?? null, role: acct?.is_admin ? 'admin' : isDm ? 'dm' : a.allowed ? 'listed' : 'not allowed', allowed: a.allowed,
      requests: Number(t?.n ?? 0), tokens: Number(t?.t ?? 0), refused: Number(t?.refused ?? 0), limited: Number(t?.limited ?? 0), errors: Number(t?.errors ?? 0), lastAt: t?.last_at ?? null,
      caps: { dailyRequests: a.dailyRequests, dailyTokens: a.dailyTokens, ratePerMinute: a.ratePerMinute },
    };
  }).sort((x, y) => (y.lastAt ?? '').localeCompare(x.lastAt ?? '') || (x.username ?? '').localeCompare(y.username ?? ''));
  return {
    since: start,
    calls: calls.map((r) => ({ id: r.id, at: r.at, job: r.job, model: r.model, path: r.reason, accountId: r.account_id, username: r.username ?? null, status: r.status, ms: r.ms, tokensIn: r.tokens_in, tokensOut: r.tokens_out, outcome: r.outcome || 'passed' })),
    users,
  };
}
