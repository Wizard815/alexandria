// Respecting a source's rate limits. Sites allow a number of calls a minute (Kanka: 30, or 90 for subscribers) and
// some a number a second. One limiter per connection is shared by everything that calls the source with it: every
// world and every source key that uses the connection, the index, the details read in the background, a page
// opened on demand, picture downloads and the connection test.
//
//   - a window of recent calls caps calls a minute (never more than `perMinute` in any 60 seconds) and a second (never more than `perSecond` in any 1000 ms)
//   - the site's own answers slow us further: `Retry-After`, `X-RateLimit-*` and `RateLimit-*` headers
//   - a 429 waits (Retry-After, or exponential back-off with jitter) and asks again a few times, never hammering
//   - a scan can be paced: the index tier's calls are spread across a window the DM chooses
//
// Time is injected (`setClock`) so tests can run minutes in milliseconds.
import type { ConfigField } from './connector.ts';

export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Sync stopped'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(t); reject(new Error('Sync stopped')); };
    signal?.addEventListener('abort', stop, { once: true });
  }),
};
let clock: Clock = realClock;
/** Tests only: replace the clock (null: the real one). */
export function setClock(c: Clock | null) { clock = c ?? realClock; }

export interface Limits { perMinute: number; perSecond: number; spreadMinutes: number; /** Calls an hour per connection (0: no hourly cap). */ perHour: number }

/** Share of the per-minute and per-hour budget background reads may use: the rest is kept for pages somebody opens. */
export const BACKGROUND_SHARE = 0.8

/**
 * What each connector may be called at when the connection says nothing: the site's published limit, or something gentle.
 *   Kanka (https://app.kanka.io/api-docs/1.0/setup, "Rate limits"): 30 requests a minute per user, 90 for subscribers,
 *     shared by every token of the user; /profile returns `rate_limit`. Subscribers raise "Max calls per minute" themselves.
 *   World Anvil (https://www.worldanvil.com/api/external/boromir/documentation) publishes no limit: 60 a minute, 2 a second.
 *   Notion (https://developers.notion.com/reference/request-limits): an average of three requests a second per integration.
 *   LegendKeeper (https://www.legendkeeper.com/api/v3/openapi.json, "Rate limits"): per key 300 a minute, 6,000 an hour and
 *     60,000 a day; writes 120 a minute and 3,000 an hour; 12,000 an hour per project. 60 a minute (3,600 an hour) stays well
 *     inside every tier, and 2 a second matches the docs' "writes at least half a second apart".
 */
const LK_PER_HOUR = 6000;
export const DEFAULT_LIMITS: Record<string, { perMinute: number; perSecond: number; perHour: number }> = {
  'kanka-api': { perMinute: 30, perSecond: 0, perHour: 0 },
  'kanka-mcp': { perMinute: 30, perSecond: 0, perHour: 0 },
  'legendkeeper-api': { perMinute: 200, perSecond: 2, perHour: LK_PER_HOUR },
  'legendkeeper-mcp': { perMinute: 200, perSecond: 2, perHour: LK_PER_HOUR },
  'worldanvil-api': { perMinute: 60, perSecond: 2, perHour: 0 },
  'notion-api': { perMinute: 150, perSecond: 3, perHour: 0 },
  'obsidian-rest': { perMinute: 600, perSecond: 20, perHour: 0 },
  'obsidian-publish': { perMinute: 60, perSecond: 2, perHour: 0 },
  api: { perMinute: 60, perSecond: 0, perHour: 0 },
};
const FALLBACK = { perMinute: 60, perSecond: 0, perHour: 0 };

/**
 * LegendKeeper also caps a whole project at 12,000 calls an hour, shared by every key that reads it (the DM's and each player's).
 * `projectOf` names the project a connection's settings point at, or null (other connectors have no such cap).
 */
export const LK_PROJECT_PER_HOUR = 12_000;
export function projectOf(connectorId: string, cfg: Record<string, any>): { id: string; perHour: number } | null {
  if (!connectorId.startsWith('legendkeeper')) return null;
  const id = String(cfg.projectId || /\/projects\/([^/?#]+)/.exec(String(cfg.apiUrl ?? ''))?.[1] || cfg.project || '').trim();
  return id ? { id: id.toLowerCase(), perHour: LK_PROJECT_PER_HOUR } : null;
}

const posInt = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};

/**
 * The limits a connection runs with. `maxPerMinute` below 1 or missing: the connector's default. `maxPerSecond` 0: no per-second cap.
 * `spreadMinutes` 0: the first scan runs as fast as the limits allow. `ALX_CRAWL_RATE` (calls a minute; 0 = no limit at all) overrides, for tests.
 */
export function limitsOf(connectorId: string, cfg: Record<string, any>, env: Record<string, string | undefined> = {}, spreadOverride?: number | null): Limits {
  const d = DEFAULT_LIMITS[connectorId] ?? FALLBACK;
  const pm = posInt(cfg.maxPerMinute);
  const ps = posInt(cfg.maxPerSecond);
  const ph = posInt(cfg.maxPerHour);
  const spread = spreadOverride ?? posInt(cfg.spreadMinutes) ?? 1;
  let out: Limits = { perMinute: pm && pm >= 1 ? Math.min(pm, 6000) : d.perMinute, perSecond: ps !== null ? Math.min(ps, 100) : d.perSecond, spreadMinutes: Math.min(spread, 24 * 60), perHour: ph !== null ? Math.min(ph, 100_000) : d.perHour };
  const o = env.ALX_CRAWL_RATE;
  if (o !== undefined && o !== '' && Number.isFinite(Number(o))) out = { perMinute: Number(o), perSecond: env.ALX_CRAWL_RATE_PER_SEC ? Number(env.ALX_CRAWL_RATE_PER_SEC) : 0, spreadMinutes: env.ALX_CRAWL_SPREAD !== undefined ? Number(env.ALX_CRAWL_SPREAD) : 0, perHour: env.ALX_CRAWL_RATE_PER_HOUR ? Number(env.ALX_CRAWL_RATE_PER_HOUR) : 0 };
  return out;
}

/** The three settings of a connection, as form fields (a connector lists them with its others). */
export function rateFields(connectorId: string): ConfigField[] {
  const d = DEFAULT_LIMITS[connectorId] ?? FALLBACK;
  return [
    { key: 'maxPerMinute', label: 'Max calls per minute', type: 'number', scope: 'connection', default: d.perMinute, help: `How many calls a minute Alexandria may make with this connection, across every world that uses it. Keep it at or under what the site allows (suggested ${d.perMinute}). If the site reports a lower limit, that one is used. About a fifth is kept for pages somebody opens, so the background reader never takes all of it.` },
    { key: 'maxPerSecond', label: 'Max calls per second', type: 'number', scope: 'connection', default: d.perSecond, help: 'A cap on bursts. 0 means no per-second cap.' },
    { key: 'maxPerHour', label: 'Max calls per hour', type: 'number', scope: 'connection', default: d.perHour, help: d.perHour ? `A cap on calls in any hour for this connection (the site allows ${d.perHour}; a LegendKeeper project also has a shared 12,000 an hour across every key). About a fifth is kept for pages somebody opens. 0 means no hourly cap.` : 'A cap on calls in any hour. 0 means no hourly cap (this site documents none).' },
    { key: 'spreadMinutes', label: 'Spread the first scan over (minutes)', type: 'number', scope: 'connection', default: 1, help: 'The first scan of a world lists calls evenly across this many minutes instead of all at once. 0 means as fast as the limits allow. A world can override it.' },
  ];
}

export interface Throttle { waitMs: number; reason: 'asked' | 'limit' | 'pace' }

/**
 * Where the numbers go: a listener (the gateway status page) hears of every call a connection's limiter lets through, of what the site
 * answered, and of how a whole sync ended. One per database, so two databases in one process (tests) never mix. Texts are cleaned first
 * (`cleanErrorText`): no token, no keyed URL.
 */
export interface CallSink {
  call(id: string, at: number): void;
  result(id: string, r: { at: number; status: number; ms: number; message: string | null; retryAfterSec: number | null; limit: number | null; remaining: number | null }): void;
  outcome(id: string, at: number, ok: boolean, message: string | null): void;
}
const sinks = new WeakMap<object, CallSink>();
/** The status feature listens to the calls of every limiter that belongs to this database (null: stop). */
export function setCallSink(db: object, s: CallSink | null) { if (s) sinks.set(db, s); else sinks.delete(db); }
export const callSinkOf = (db: object): CallSink | null => sinks.get(db) ?? null;

/** Error text safe to keep and show: URLs lose their path and query, bearer tokens, `key=value` secrets, the connection's own secret values and long opaque runs are cut. */
export function cleanErrorText(msg: unknown, secrets: string[] = []): string {
  let t = String(msg ?? '').replace(/\s+/g, ' ').trim();
  for (const s of secrets) if (s.length >= 4) t = t.split(s).join('•••');
  t = t.replace(/\b(https?|wss?):\/\/([^\s/?#"'<>)]+)[^\s"'<>)]*/gi, (_m, scheme, host) => `${scheme}://${String(host).replace(/^[^@]*@/, '')}/…`);
  t = t.replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 •••');
  t = t.replace(/\b(api[_-]?key|access[_-]?token|token|secret|password|passwd|authorization|auth|key|sig|signature)(["']?\s*[:=]\s*["']?)[^\s&"',;]+/gi, '$1$2•••');
  t = t.replace(/[A-Za-z0-9_\-.~+/]{28,}={0,2}/g, '•••');
  return t.slice(0, 240);
}

const MAX_WAIT_MS = 15 * 60_000;
const RETRIES_ON_429 = 4;

/** Seconds a header value means: a number of seconds, an HTTP date, or (a big number) an epoch time in seconds. */
function secondsFrom(v: string | null | undefined, at: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  const t = v.trim();
  if (/^\d+(\.\d+)?$/.test(t)) { const n = Number(t); return n > 1e9 ? Math.max(0, n - at / 1000) : n; }
  const d = Date.parse(t);
  return Number.isNaN(d) ? null : Math.max(0, (d - at) / 1000);
}

/** Calls in the last hour for a LegendKeeper project, shared by every limiter (every connection and key) that reads it. */
export interface ProjectWindow { log: number[]; cap: number }
const projects = new Map<string, ProjectWindow>();
/** The shared window of a project (the database is part of the key). */
export function projectWindow(db: object, id: string, cap: number): ProjectWindow {
  let n = dbIds.get(db);
  if (n === undefined) { n = nextDb++; dbIds.set(db, n); }
  const k = `${n}:${id}`;
  let w = projects.get(k);
  if (!w) { w = { log: [], cap }; projects.set(k, w); }
  w.cap = cap;
  return w;
}
const HOUR = 3_600_000;
/** What background reads may use of a cap: the reserve is kept for pages somebody opens. */
const bgCap = (n: number) => (n <= 1 ? n : Math.max(1, Math.floor(n * BACKGROUND_SHARE)));

export class Limiter {
  key: string;
  limits: Limits;
  private log: number[] = [];
  private secLog: number[] = [];
  private hourLog: number[] = [];
  /** The project this limiter's calls also count against (LegendKeeper: 12,000 an hour across keys). */
  project: ProjectWindow | null = null;
  private blockedUntil = 0;
  private cap: number | null = null;
  private lastPaced = 0;
  private waiting: Throttle | null = null;
  private waitingUntil = 0;
  /** What to call this limiter in the status page (`con:<id>` or `src:<id>`), the listener, and secret values to cut from texts. Set by connectorContext. */
  logical: string | null = null;
  sink: CallSink | null = null;
  secrets: string[] = [];
  /** The last thing the site said about its limits (kept in memory; the listener keeps it on disk). */
  lastRetryAfterSec: number | null = null;
  lastRemaining: number | null = null;
  lastLimit: number | null = null;
  constructor(key: string, limits: Limits) { this.key = key; this.limits = limits; this.configure(limits); }

  configure(l: Limits) {
    this.limits = l;
  }
  /** Calls a minute really allowed: ours, or lower when the site said so. */
  get perMinute() { return this.cap ? Math.min(this.cap, this.limits.perMinute) : this.limits.perMinute; }

  private waitFor(at: number, gapMs: number, background: boolean): { ms: number; why: Throttle['reason'] } {
    let ms = 0; let why: Throttle['reason'] = 'limit';
    if (this.blockedUntil > at) { ms = this.blockedUntil - at; why = 'asked'; }
    const pm = this.perMinute;
    if (pm > 0) {
      while (this.log.length && this.log[0] <= at - 60_000) this.log.shift();
      const cap = background ? bgCap(pm) : pm;
      if (this.log.length >= cap) { const w = this.log[this.log.length - cap] + 60_000 - at; if (w > ms) { ms = w; why = this.cap && this.cap < this.limits.perMinute ? 'asked' : 'limit'; } }
    }
    const ps = this.limits.perSecond;
    if (ps > 0) {
      while (this.secLog.length && this.secLog[0] <= at - 1000) this.secLog.shift();
      if (this.secLog.length >= ps) { const w = this.secLog[this.secLog.length - ps] + 1000 - at; if (w > ms) { ms = w; why = 'limit'; } }
    }
    const hourly: [number[], number][] = [];
    if (this.limits.perHour > 0) hourly.push([this.hourLog, this.limits.perHour]);
    if (this.project && this.project.cap > 0) hourly.push([this.project.log, this.project.cap]);
    for (const [log, total] of hourly) {
      while (log.length && log[0] <= at - HOUR) log.shift();
      const cap = background ? bgCap(total) : total;
      if (log.length >= cap) { const w = log[log.length - cap] + HOUR - at; if (w > ms) { ms = w; why = 'limit'; } }
    }
    if (gapMs > 0 && this.lastPaced) { const w = this.lastPaced + gapMs - at; if (w > ms) { ms = w; why = 'pace'; } }
    return { ms: Math.ceil(ms), why };
  }

  /** Wait until one more call may go, then count it. `gapMs`: the least time since the previous paced call (scan pacing). */
  async acquire(signal?: AbortSignal, gapMs = 0, background = false): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new Error('Sync stopped');
      const at = clock.now();
      const { ms, why } = this.waitFor(at, gapMs, background);
      if (ms <= 0) {
        if (this.perMinute > 0) this.log.push(at);
        if (this.limits.perSecond > 0) this.secLog.push(at);
        if (this.limits.perHour > 0) this.hourLog.push(at);
        if (this.project && this.project.cap > 0) this.project.log.push(at);
        if (gapMs > 0) this.lastPaced = at;
        this.waiting = null;
        if (this.sink && this.logical) { try { this.sink.call(this.logical, at); } catch { /* the status page never stops a call */ } }
        return;
      }
      // A wait only the reserve causes (background reads giving way) is not shown: a page somebody opens would not wait.
      if (!background || why === 'asked' || why === 'pace') { this.waiting = { waitMs: ms, reason: why }; this.waitingUntil = at + ms; }
      await clock.sleep(Math.min(ms, 5000), signal);
    }
  }

  /** Read what the site said about its limits in a response, and slow down to match. */
  observe(h: Headers, status: number) {
    const at = clock.now();
    const get = (...names: string[]) => { for (const n of names) { const v = h.get(n); if (v !== null && v !== '') return v; } return null; };
    const ra = get('retry-after');
    const wait = ra !== null ? secondsFrom(ra, at) : null;
    const limit = Number(get('x-ratelimit-limit', 'ratelimit-limit'));
    const remainingRaw = get('x-ratelimit-remaining', 'ratelimit-remaining');
    const remaining = remainingRaw === null ? NaN : Number(remainingRaw);
    const reset = secondsFrom(get('x-ratelimit-reset', 'ratelimit-reset'), at);
    // A published limit lower than ours over about a minute: stay under it.
    if (Number.isFinite(limit) && limit > 0 && (reset === null || reset <= 90) && limit < this.limits.perMinute && this.limits.perMinute > 0) this.cap = Math.max(1, Math.floor(limit * 0.9));
    let until = 0;
    if (wait !== null && (status === 429 || status === 503 || wait > 0)) until = Math.max(until, at + wait * 1000);
    if (Number.isFinite(remaining) && remaining <= 0 && reset !== null) until = Math.max(until, at + reset * 1000);
    if (until > this.blockedUntil) this.blockedUntil = Math.min(until, at + MAX_WAIT_MS);
    this.lastRetryAfterSec = wait !== null ? Math.round(wait) : null;
    this.lastLimit = Number.isFinite(limit) && limit > 0 ? limit : null;
    this.lastRemaining = Number.isFinite(remaining) ? remaining : null;
  }

  /** Tell the listener what a call came to (`status` 0: the call itself failed). */
  report(status: number, ms: number, error?: unknown) {
    if (!this.sink || !this.logical) return;
    const message = status === 0 ? cleanErrorText(error, this.secrets) || 'The call failed' : status >= 400 ? `The site answered ${status}` : null;
    try { this.sink.result(this.logical, { at: clock.now(), status, ms, message, retryAfterSec: this.lastRetryAfterSec, limit: this.lastLimit, remaining: this.lastRemaining }); } catch { /* never stops a call */ }
  }

  /** How a whole sync (or a read of pages) ended: the text is cleaned before it is kept. */
  outcome(ok: boolean, error?: unknown) {
    if (!this.sink || !this.logical) return;
    try { this.sink.outcome(this.logical, clock.now(), ok, ok ? null : cleanErrorText(error, this.secrets) || 'It failed'); } catch { /* never stops a sync */ }
  }

  /** A read-only view of the numbers, for the status page. */
  snapshot() {
    const at = clock.now();
    const used = this.log.filter((t) => t > at - 60_000).length;
    return {
      usedLastHour: this.hourLog.filter((t) => t > at - HOUR).length, perHour: this.limits.perHour,
      perMinute: this.limits.perMinute, perMinuteInEffect: this.perMinute, perSecond: this.limits.perSecond, usedLastMinute: used,
      throttle: this.throttle(), lastRetryAfterSec: this.lastRetryAfterSec, lastRemaining: this.lastRemaining, lastLimit: this.lastLimit,
    };
  }

  /** How long a 429 should wait: Retry-After when given, else exponential back-off with jitter. */
  backoffMs(h: Headers, attempt: number): number {
    const ra = h.get('retry-after');
    const s = ra !== null ? secondsFrom(ra, clock.now()) : null;
    if (s !== null) return Math.min(Math.ceil(s * 1000), MAX_WAIT_MS);
    return Math.min(60_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
  }

  /** Set while a caller is held back, and for how long. */
  throttle(): Throttle | null {
    const at = clock.now();
    if (this.blockedUntil > at) return { waitMs: this.blockedUntil - at, reason: 'asked' };
    if (this.waiting && this.waitingUntil > at) return { waitMs: this.waitingUntil - at, reason: this.waiting.reason };
    return null;
  }
}

const dbIds = new WeakMap<object, number>();
let nextDb = 1;
/** One limiter per connection; a source with no connection has its own. The database is part of the key, so two databases in one process (tests) never share one. */
export function limitKeyOf(src: { id: string; connection_id?: string | null }, db: object): string {
  let n = dbIds.get(db);
  if (n === undefined) { n = nextDb++; dbIds.set(db, n); }
  return `${n}:${src.connection_id ? `con:${src.connection_id}` : `src:${src.id}`}`;
}

const limiters = new Map<string, Limiter>();

/** The shared limiter of a connection (or of a source that has none). Settings are refreshed on every call. */
export function limiterFor(key: string, limits: Limits): Limiter {
  let l = limiters.get(key);
  if (!l) { l = new Limiter(key, limits); limiters.set(key, l); }
  else if (l.limits.perMinute !== limits.perMinute || l.limits.perSecond !== limits.perSecond || l.limits.perHour !== limits.perHour) l.configure(limits);
  else l.limits = limits;
  return l;
}
export const limiterState = (key: string): Throttle | null => limiters.get(key)?.throttle() ?? null;
export const limiterSnapshot = (key: string) => limiters.get(key)?.snapshot() ?? null;
export const resetLimiters = () => { limiters.clear(); projects.clear(); };

/**
 * A fetch that waits for the limiter, reads the site's rate-limit headers and, on a 429 (or a 503 that says Retry-After),
 * waits and asks again a few times. Anything else is returned as it is.
 */
export function limitedFetch(inner: typeof fetch, lim: Limiter, signal: AbortSignal, calls: { credit: number }, background = false): typeof fetch {
  return (async (input: any, init?: any) => {
    for (let attempt = 0; ; attempt++) {
      // A call `take()` already paid for is not paid twice; a retry, or a fetch nobody counted, waits its turn here.
      if (attempt === 0 && calls.credit > 0) calls.credit--; else await lim.acquire(signal, 0, background);
      const t0 = clock.now();
      let r: Response;
      try { r = await inner(input, init); } catch (e) { lim.report(0, clock.now() - t0, e); throw e; }
      lim.observe(r.headers, r.status);
      lim.report(r.status, clock.now() - t0);
      const retry = r.status === 429 || (r.status === 503 && r.headers.get('retry-after') !== null);
      if (!retry || attempt >= RETRIES_ON_429) return r;
      r.body?.cancel().catch(() => {});
      await clock.sleep(lim.backoffMs(r.headers, attempt), signal);
    }
  }) as typeof fetch;
}
