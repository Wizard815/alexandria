// What each connection has been doing: calls an hour (kept), the last success and error (cleaned of tokens), and the rate-limit
// state the site last reported. The limiter of a connection (intake/ratelimit.ts) tells a listener about every call it lets through,
// every answer and how a sync ended; this file is the listener and the reader.
import type { Deps } from '../../app.ts';
import type { DB } from '../../core/db.ts';
import { all, one, run } from '../../core/db.ts';
import { cleanErrorText, limitKeyOf, limiterSnapshot, limitsOf, type CallSink } from '../../intake/ratelimit.ts';
import { connectorFor } from '../../intake/registry.ts';
import { parseJson } from '../../core/util.ts';

export const CALLS_SCHEMA = `
-- Calls made with a connection (or a source that has none), by clock hour (UTC, 'YYYY-MM-DDTHH').
CREATE TABLE IF NOT EXISTS gwstatus_hourly (
  conn TEXT NOT NULL,
  hour TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  throttled INTEGER NOT NULL DEFAULT 0,
  ms_total INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conn, hour)
);
-- The latest of everything else, one row per connection. last_error holds cleaned text only.
CREATE TABLE IF NOT EXISTS gwstatus_conn (
  conn TEXT PRIMARY KEY,
  last_call_at TEXT,
  last_ok_at TEXT,
  last_error_at TEXT,
  last_error TEXT,
  last_status INTEGER,
  last_ms INTEGER,
  last_throttled_at TEXT,
  retry_after_sec INTEGER,
  remaining INTEGER,
  rate_limit INTEGER
);
`;

const iso = (ms: number) => new Date(ms).toISOString();
const hourOf = (ms: number) => iso(ms).slice(0, 13);

/** Listens to the limiters of one database and keeps their numbers. Cheap: one or two small upserts a call. */
export function makeSink(db: DB): CallSink {
  let pruned = 0;
  const bump = (conn: string, at: number, col: 'calls' | 'ok' | 'errors' | 'throttled', ms = 0) => {
    run(db, `INSERT INTO gwstatus_hourly (conn, hour, ${col}, ms_total) VALUES (?, ?, 1, ?) ON CONFLICT (conn, hour) DO UPDATE SET ${col} = ${col} + 1, ms_total = ms_total + ?`, conn, hourOf(at), ms, ms);
  };
  const state = (conn: string, patch: Record<string, unknown>) => {
    const cols = Object.keys(patch);
    run(db, `INSERT INTO gwstatus_conn (conn, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')}) ON CONFLICT (conn) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`, conn, ...cols.map((c) => patch[c]));
  };
  return {
    call(conn, at) {
      bump(conn, at, 'calls');
      state(conn, { last_call_at: iso(at) });
      // A week of hours is plenty for the bars; trim once an hour.
      if (at - pruned > 3600_000) { pruned = at; run(db, 'DELETE FROM gwstatus_hourly WHERE hour < ?', hourOf(at - 8 * 864e5)); }
    },
    result(conn, r) {
      const bad = r.status === 0 || r.status >= 400;
      bump(conn, r.at, bad ? 'errors' : 'ok', Math.max(0, Math.round(r.ms)));
      if (r.status === 429 || (r.status === 503 && r.retryAfterSec !== null)) bump(conn, r.at, 'throttled');
      state(conn, {
        ...(bad ? { last_error_at: iso(r.at), last_error: r.message ? cleanErrorText(r.message) : `The site answered ${r.status}` } : { last_ok_at: iso(r.at) }),
        last_status: r.status, last_ms: Math.round(r.ms), retry_after_sec: r.retryAfterSec, remaining: r.remaining, rate_limit: r.limit,
        ...(r.status === 429 ? { last_throttled_at: iso(r.at) } : {}),
      });
    },
    outcome(conn, at, ok, message) {
      state(conn, ok ? { last_ok_at: iso(at) } : { last_error_at: iso(at), last_error: cleanErrorText(message) });
    },
  };
}

export type Health = 'ok' | 'slow' | 'failing' | 'throttled' | 'idle';

interface HourRow { hour: string; calls: number; ok: number; errors: number; throttled: number; ms_total: number }
interface StateRow { conn: string; last_call_at: string | null; last_ok_at: string | null; last_error_at: string | null; last_error: string | null; last_status: number | null; last_ms: number | null; last_throttled_at: string | null; retry_after_sec: number | null; remaining: number | null; rate_limit: number | null }

const SLOW_MS = 3000;

/** Hours of the last 24, oldest first, with zeros for quiet ones. */
function series(rows: HourRow[], now: number) {
  const by = new Map(rows.map((r) => [r.hour, r]));
  const out: { hour: string; calls: number; errors: number }[] = [];
  for (let i = 23; i >= 0; i--) { const h = hourOf(now - i * 3600_000); const r = by.get(h); out.push({ hour: h, calls: r?.calls ?? 0, errors: r?.errors ?? 0 }); }
  return out;
}

/** One connection's status: the persisted counts and the live limiter. Never holds a secret. */
function statusOf(d: Deps, conn: string, limiterKey: string, fallbackLimits: { perMinute: number; perSecond: number }, now: number) {
  const since = hourOf(now - 24 * 3600_000);
  const hours = all<HourRow>(d.db, 'SELECT hour, calls, ok, errors, throttled, ms_total FROM gwstatus_hourly WHERE conn = ? AND hour >= ? ORDER BY hour', conn, since);
  const st = one<StateRow>(d.db, 'SELECT * FROM gwstatus_conn WHERE conn = ?', conn);
  const today = iso(now).slice(0, 10);
  const thisHour = hours.find((h) => h.hour === hourOf(now));
  const prevHour = hours.find((h) => h.hour === hourOf(now - 3600_000));
  const live = limiterSnapshot(limiterKey);
  // The last hour is the clock hour so far plus the part of the one before that still inside 60 minutes.
  const frac = (now % 3600_000) / 3600_000;
  const lastHour = Math.round((thisHour?.calls ?? 0) + (prevHour?.calls ?? 0) * (1 - frac));
  const recent = [thisHour, prevHour].filter(Boolean) as HourRow[];
  const answered = recent.reduce((n, h) => n + h.ok + h.errors, 0);
  const errorsRecent = recent.reduce((n, h) => n + h.errors, 0);
  const avgMs = answered ? Math.round(recent.reduce((n, h) => n + h.ms_total, 0) / answered) : null;
  const lastOk = st?.last_ok_at ?? null;
  const lastErr = st?.last_error_at ?? null;
  const errorIsLatest = !!lastErr && (!lastOk || lastErr > lastOk);
  const throttleNow = live?.throttle ?? null;
  const justThrottled = !!st?.last_throttled_at && now - Date.parse(st.last_throttled_at) < 10 * 60_000 && errorIsLatest;
  let health: Health;
  if (throttleNow && throttleNow.reason === 'asked') health = 'throttled';
  else if (justThrottled) health = 'throttled';
  else if (errorIsLatest && now - Date.parse(lastErr!) < 24 * 3600_000 && (answered === 0 || errorsRecent > 0 || now - Date.parse(lastErr!) < 3600_000)) health = 'failing';
  else if (avgMs !== null && avgMs > SLOW_MS) health = 'slow';
  else if (!st?.last_call_at && !lastOk && !lastErr) health = 'idle';
  else health = 'ok';
  const limits = live ?? { perMinute: fallbackLimits.perMinute, perMinuteInEffect: fallbackLimits.perMinute, perSecond: fallbackLimits.perSecond, usedLastMinute: 0, throttle: null, lastRetryAfterSec: null, lastRemaining: null, lastLimit: null };
  return {
    health,
    callsToday: hours.filter((h) => h.hour.slice(0, 10) === today).reduce((n, h) => n + h.calls, 0),
    callsThisHour: thisHour?.calls ?? 0,
    callsLastHour: lastHour,
    errorsToday: hours.filter((h) => h.hour.slice(0, 10) === today).reduce((n, h) => n + h.errors, 0),
    avgMs,
    series: series(hours, now),
    lastCallAt: st?.last_call_at ?? null,
    lastSuccessAt: lastOk,
    lastError: lastErr ? { at: lastErr, message: cleanErrorText(st?.last_error ?? '') } : null,
    rate: {
      perMinute: limits.perMinute, perMinuteInEffect: limits.perMinuteInEffect, perSecond: limits.perSecond, usedLastMinute: limits.usedLastMinute,
      waiting: throttleNow ? { ms: throttleNow.waitMs, until: iso(now + throttleNow.waitMs), reason: throttleNow.reason } : null,
      // What the site last said, from the live limiter when there is one, else from what was kept.
      lastRetryAfterSec: limits.lastRetryAfterSec ?? st?.retry_after_sec ?? null,
      remaining: limits.lastRemaining ?? st?.remaining ?? null,
      siteLimit: limits.lastLimit ?? st?.rate_limit ?? null,
    },
  };
}

/** Every connection (and every source that has none) with its status. Names and counts only. */
export function connectionStatuses(d: Deps, now = Date.now()) {
  const out: any[] = [];
  const conns = all<any>(d.db, 'SELECT id, name, kind, config FROM connections ORDER BY name');
  for (const c of conns) {
    const connector = connectorFor(c.kind);
    const cfg = parseJson<Record<string, any>>(c.config, {});
    const lim = limitsOf(connector?.id ?? c.kind, cfg, d.env);
    const uses = all<{ n: number; w: number }>(d.db, 'SELECT COUNT(*) AS n, COUNT(DISTINCT world_id) AS w FROM sources WHERE connection_id = ?', c.id)[0];
    out.push({
      id: `con:${c.id}`, connectionId: c.id, sourceId: null, name: c.name, kind: connector?.id ?? c.kind, connector: connector?.label ?? c.kind,
      sources: uses?.n ?? 0, worlds: uses?.w ?? 0,
      ...statusOf(d, `con:${c.id}`, limitKeyOf({ id: 'x', connection_id: c.id }, d.db), lim, now),
    });
  }
  // A source from before connections has its own limiter; list it by its own name (push and folder sources make no calls and are left out).
  for (const s of all<any>(d.db, `SELECT id, name, kind, config FROM sources WHERE connection_id IS NULL AND enabled = 1 AND kind NOT IN ('push', 'markdown-folder', 'vault', 'git')`)) {
    const connector = connectorFor(s.kind);
    if (!connector) continue;
    const has = one(d.db, 'SELECT 1 FROM gwstatus_conn WHERE conn = ?', `src:${s.id}`);
    if (!has) continue;
    const lim = limitsOf(connector.id, parseJson<Record<string, any>>(s.config, {}), d.env);
    out.push({
      id: `src:${s.id}`, connectionId: null, sourceId: s.id, name: s.name, kind: connector.id, connector: connector.label, sources: 1, worlds: 1,
      ...statusOf(d, `src:${s.id}`, limitKeyOf({ id: s.id }, d.db), lim, now),
    });
  }
  return out;
}
