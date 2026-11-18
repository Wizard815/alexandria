// The tiered crawl's state and rules, shared by the sync (tier 1: the index)
// and the detail fetcher (tier 3). No network here.
//
// Every page of a tiered source has a depth:
//   index    what a list call gave (title, type, tags, parent, updated time); DM-only until its details are read
//   summary  the list also gave an opening excerpt
//   full     the whole page
// plus `fetched_at`, `source_updated_at` (what the list last said) and
// `held_updated_at` (the source time of the content we hold). A page whose
// source_updated_at is newer than the one it was read at is stale and is read
// again. An index entry never replaces a page already read deeper: it only
// notes the new time, and makes the page DM-only at once if the list says the
// page is hidden (the leak guard does not wait for the details).
import type { DB } from '../core/db.ts';
import { all, one, run } from '../core/db.ts';
import type { Library } from '../core/library.ts';
import { now } from '../core/util.ts';
import type { Entry } from './model.ts';
import type { Connector, Tiered } from './connector.ts';
import { connectorFor } from './registry.ts';
import { BACKGROUND_SHARE, limitsOf, resetLimiters } from './ratelimit.ts';

export type Depth = 'index' | 'summary' | 'full';

const ready = new WeakSet<DB>();
const inboundCache = new Map<string, { at: number; tally: Map<string, number> }>();

/** The depth columns on pages and the per-source state table. Safe to run again. */
export function ensureTierSchema(db: DB) {
  if (ready.has(db)) return;
  const cols = (db.prepare('PRAGMA table_info(pages)').all() as { name: string }[]).map((c) => c.name);
  const add = (c: string, def: string) => { if (!cols.includes(c)) db.exec(`ALTER TABLE pages ADD COLUMN ${c} ${def}`); };
  add('depth', "TEXT NOT NULL DEFAULT 'full'");
  add('fetched_at', 'TEXT');
  add('source_updated_at', 'TEXT');
  add('held_updated_at', 'TEXT');
  add('wanted', 'INTEGER NOT NULL DEFAULT 0');
  const hadShared = cols.includes('source_shared');
  add('source_shared', 'INTEGER');
  // Pages already read and shared were shared by the source itself.
  if (!hadShared) db.exec("UPDATE pages SET source_shared = 1 WHERE source_id IS NOT NULL AND depth <> 'index' AND visibility = 'party'");
  db.exec(TIER_SCHEMA);
  const sc = (db.prepare('PRAGMA table_info(connections_source_state)').all() as { name: string }[]).map((c) => c.name);
  if (!sc.includes('spread_minutes')) db.exec('ALTER TABLE connections_source_state ADD COLUMN spread_minutes INTEGER');
  if (!sc.includes('last_index_calls')) db.exec('ALTER TABLE connections_source_state ADD COLUMN last_index_calls INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS pages_source_depth ON pages (source_id, depth)');
  ready.add(db);
}

export const TIER_SCHEMA = `
CREATE TABLE IF NOT EXISTS connections_source_state (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  budget INTEGER,
  paused INTEGER NOT NULL DEFAULT 0,
  fetch_all INTEGER NOT NULL DEFAULT 0,
  token TEXT,
  cache TEXT,
  runs_since_full INTEGER NOT NULL DEFAULT 0,
  last_full_at TEXT,
  index_calls INTEGER NOT NULL DEFAULT 0,
  index_at TEXT,
  detail_calls INTEGER NOT NULL DEFAULT 0,
  last_detail_at TEXT,
  spread_minutes INTEGER,
  last_index_calls INTEGER NOT NULL DEFAULT 0
);
`;

export interface SourceState {
  source_id: string;
  budget: number | null;
  paused: boolean;
  fetchAll: boolean;
  token: string | null;
  cache: Record<string, any> | null;
  runsSinceFull: number;
  lastFullAt: string | null;
  indexCalls: number;
  indexAt: string | null;
  detailCalls: number;
  lastDetailAt: string | null;
  /** "Spread the first scan over N minutes": this source's own setting, or null (the connection's). */
  spread: number | null;
  /** Calls the last complete listing made: the scan is paced over its window by this many. */
  lastIndexCalls: number;
}

export function getState(db: DB, sourceId: string): SourceState {
  ensureTierSchema(db);
  const r = one<any>(db, 'SELECT * FROM connections_source_state WHERE source_id = ?', sourceId);
  let cache: Record<string, any> | null = null;
  try { cache = r?.cache ? JSON.parse(r.cache) : null; } catch { cache = null; }
  return {
    source_id: sourceId, budget: r?.budget ?? null, paused: !!r?.paused, fetchAll: !!r?.fetch_all, token: r?.token ?? null, cache,
    runsSinceFull: r?.runs_since_full ?? 0, lastFullAt: r?.last_full_at ?? null, indexCalls: r?.index_calls ?? 0, indexAt: r?.index_at ?? null,
    detailCalls: r?.detail_calls ?? 0, lastDetailAt: r?.last_detail_at ?? null, spread: r?.spread_minutes ?? null, lastIndexCalls: r?.last_index_calls ?? 0,
  };
}

const touch = (db: DB, sourceId: string) => run(db, 'INSERT OR IGNORE INTO connections_source_state (source_id) VALUES (?)', sourceId);

export function setSettings(db: DB, sourceId: string, s: { budget?: number | null; paused?: boolean; fetchAll?: boolean; spread?: number | null }) {
  ensureTierSchema(db);
  touch(db, sourceId);
  if (s.budget !== undefined) run(db, 'UPDATE connections_source_state SET budget = ? WHERE source_id = ?', s.budget, sourceId);
  if (s.paused !== undefined) run(db, 'UPDATE connections_source_state SET paused = ? WHERE source_id = ?', s.paused ? 1 : 0, sourceId);
  if (s.fetchAll !== undefined) run(db, 'UPDATE connections_source_state SET fetch_all = ? WHERE source_id = ?', s.fetchAll ? 1 : 0, sourceId);
  if (s.spread !== undefined) run(db, 'UPDATE connections_source_state SET spread_minutes = ? WHERE source_id = ?', s.spread, sourceId);
}

/** After a listing: keep the token and cache the connector left, and count the calls. */
export function saveIndexState(db: DB, sourceId: string, a: { token: string | null; cache: Record<string, any> | null; complete: boolean; calls: number }) {
  ensureTierSchema(db);
  touch(db, sourceId);
  run(db, `UPDATE connections_source_state SET token = ?, cache = ?, index_calls = index_calls + ?, index_at = ?, last_index_calls = CASE WHEN ? AND ? > 0 THEN ? ELSE last_index_calls END,
    runs_since_full = CASE WHEN ? THEN 0 ELSE runs_since_full + 1 END, last_full_at = CASE WHEN ? THEN ? ELSE last_full_at END WHERE source_id = ?`,
  a.token, a.cache ? JSON.stringify(a.cache) : null, a.calls, now(), a.complete ? 1 : 0, a.calls, a.calls, a.complete ? 1 : 0, a.complete ? 1 : 0, now(), sourceId);
}

export function addDetailCalls(db: DB, sourceId: string, calls: number) {
  if (!calls) return;
  ensureTierSchema(db);
  touch(db, sourceId);
  run(db, 'UPDATE connections_source_state SET detail_calls = detail_calls + ?, last_detail_at = ? WHERE source_id = ?', calls, now(), sourceId);
}

/** A complete listing is needed the first time, now and then (it alone may remove pages and refresh records), and when asked. */
export const FULL_EVERY_RUNS = 6;
export const FULL_EVERY_MS = 24 * 3600_000;
export function needsFullListing(st: SourceState, force = false) {
  if (force || !st.cache || !st.lastFullAt) return true;
  return st.runsSinceFull >= FULL_EVERY_RUNS || Date.now() - Date.parse(st.lastFullAt) > FULL_EVERY_MS;
}

/** The tier a source's connector offers with these settings, or null (the source is read whole by `sync`). */
export function tieredFor(c: Connector | null, cfg: Record<string, any>): Tiered | null {
  try {
    const t = c?.tiered?.(cfg) ?? null;
    // The background may use a share of the connection's calls-a-minute limit (a fifth is kept for pages opened and other users of the same key),
    // and of its hourly cap when it has one.
    if (!t || !c) return null;
    const lim = limitsOf(c.id, cfg);
    const hourly = lim.perHour > 0 ? Math.floor((lim.perHour * BACKGROUND_SHARE) / 60) : Infinity;
    const budgetPerMinute = Math.max(1, Math.min(Math.floor(lim.perMinute * BACKGROUND_SHARE), hourly));
    return { ...t, budgetPerMinute };
  } catch { return null; }
}
export const tieredOf = (kind: string, cfg: Record<string, any>) => tieredFor(connectorFor(kind, cfg), cfg);

/** The detail calls a minute a source gets when nobody sets one: 40 (LegendKeeper), else half of what its connector can take; never above the cap. */
export const DEFAULT_BUDGET = 40;
export const budgetDefaultOf = (t: Tiered): number => Math.max(1, Math.min(t.budgetPerMinute, t.budgetDefault ?? Math.floor(t.budgetPerMinute / 2)));

/** The detail calls a minute a source may use in the background: the setting, else the default. */
export function budgetOf(st: SourceState, t: Tiered): number {
  if (st.budget !== null && st.budget >= 0) return Math.min(st.budget, 600);
  return budgetDefaultOf(t);
}

// ---- rate limits -------------------------------------------------------------------

/** A token bucket. `perMin` 0 or less: no limit. Tokens can go negative: what was spent is paid back before the next call. */
export class Bucket {
  tokens: number;
  last: number;
  perMin: number;
  burst: number;
  constructor(perMin: number, burst: number, at: number) { this.perMin = perMin; this.burst = Math.max(1, burst); this.tokens = this.burst; this.last = at; }
  refill(at: number) {
    if (at > this.last) this.tokens = Math.min(this.burst, this.tokens + ((at - this.last) / 60_000) * this.perMin);
    this.last = Math.max(this.last, at);
  }
  /** Milliseconds until one call may go (0: now). */
  waitMs(at: number): number {
    if (this.perMin <= 0) return 0;
    this.refill(at);
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.perMin) * 60_000);
  }
  spend(n: number, at: number) { if (this.perMin > 0) { this.refill(at); this.tokens -= n; } }
}

const budgetBuckets = new Map<string, Bucket>();

/** The background budget bucket of a source (calls a minute). `at` is the clock, so tests can move it. */
export function budgetBucket(sourceId: string, perMin: number, at: number): Bucket {
  let b = budgetBuckets.get(sourceId);
  if (!b || b.perMin !== perMin) { b = new Bucket(perMin, Math.max(1, Math.min(perMin, 10)), at); budgetBuckets.set(sourceId, b); }
  return b;
}
export const resetBuckets = () => { budgetBuckets.clear(); resetLimiters(); };

// ---- storing -------------------------------------------------------------------------

/** What is recorded about how much of a page we hold. */
export function markDepth(db: DB, pageId: string, e: Entry) {
  const depth: Depth = e.depth === 'index' || e.depth === 'summary' ? e.depth : 'full';
  const su = e.sourceUpdatedAt ?? e.updatedAt ?? null;
  run(db, 'UPDATE pages SET depth = ?, fetched_at = ?, source_updated_at = ?, held_updated_at = ?, source_shared = ? WHERE id = ?', depth, depth === 'index' ? null : now(), su, depth === 'index' ? null : su, depth !== 'index' && typeof e.sourceShared === 'boolean' ? (e.sourceShared ? 1 : 0) : e.restricted ? 0 : null, pageId);
}

export type Stored = 'saved' | 'kept' | 'demote';

/**
 * Save one entry the sync or the detail fetcher produced. An entry at index
 * depth never replaces a page held deeper: that page only learns the source's
 * new time (so it counts as stale), and is flagged for demotion when the list
 * says it is hidden. Everything else is saved and its depth recorded.
 */
export function storeEntry(d: { db: DB; library: Library }, worldId: string, sourceId: string, prefix: string | null, e: Entry, by: string | null): { how: Stored; id?: string } {
  ensureTierSchema(d.db);
  if (e.depth === 'index') {
    const ex = one<any>(d.db, 'SELECT id, depth, source_updated_at, source_level, visibility FROM pages WHERE world_id = ? AND source_id = ? AND external_id = ?', worldId, sourceId, e.externalId);
    if (ex && ex.depth !== 'index') {
      const su = e.sourceUpdatedAt ?? e.updatedAt ?? null;
      if (su && su !== ex.source_updated_at) run(d.db, 'UPDATE pages SET source_updated_at = ? WHERE id = ?', su, ex.id);
      if (e.restricted) run(d.db, 'UPDATE pages SET source_shared = 0 WHERE id = ?', ex.id);
      if (e.restricted && ex.source_level !== 'dm') { run(d.db, "UPDATE pages SET source_level = 'dm' WHERE id = ?", ex.id); return { how: 'demote', id: ex.id }; }
      return { how: 'kept', id: ex.id };
    }
  }
  const r = d.library.saveEntry(worldId, sourceId, prefix, e, by);
  markDepth(d.db, r.id, e);
  // A page read in full may link to pages that are now worth reading.
  if (e.depth !== 'index') inboundCache.delete(sourceId);
  return { how: 'saved', id: r.id };
}

/** Counts of a source's pages by depth, and how many of the read ones have changed at the source since. */
export function depthCounts(db: DB, sourceId: string) {
  ensureTierSchema(db);
  const out = { total: 0, index: 0, summary: 0, full: 0, stale: 0 };
  for (const r of all<any>(db, 'SELECT depth, COUNT(*) AS n FROM pages WHERE source_id = ? GROUP BY depth', sourceId)) { const k = r.depth as Depth; if (k in out) out[k] += r.n; out.total += r.n; }
  out.stale = one<any>(db, `SELECT COUNT(*) AS n FROM pages WHERE source_id = ? AND depth <> 'index' AND source_updated_at IS NOT NULL AND source_updated_at <> COALESCE(held_updated_at, '')`, sourceId)!.n;
  return out;
}

/** Page ids of a world and what is not full about them, for the DM's depth badges. Only pages not held in full are listed. */
export function depthsOf(db: DB, worldId: string): Record<string, Depth | 'stale'> {
  ensureTierSchema(db);
  const out: Record<string, Depth | 'stale'> = {};
  for (const r of all<any>(db, `SELECT id, depth, (depth <> 'index' AND source_updated_at IS NOT NULL AND source_updated_at <> COALESCE(held_updated_at, '')) AS stale FROM pages
    WHERE world_id = ? AND source_id IS NOT NULL AND (depth <> 'full' OR (source_updated_at IS NOT NULL AND source_updated_at <> COALESCE(held_updated_at, '')))`, worldId)) {
    out[r.id] = r.depth === 'index' ? 'index' : r.stale ? 'stale' : r.depth;
  }
  return out;
}

/** Somebody opened, searched for or asked about these pages: they go first in the background. */
export function markWanted(db: DB, pageIds: string[], by = 1) {
  ensureTierSchema(db);
  for (const id of pageIds) run(db, 'UPDATE pages SET wanted = MIN(wanted + ?, 1000) WHERE id = ? AND source_id IS NOT NULL', by, id);
}

/** How many pages held in full mention each page of the source (by the source's own id): what is linked to is read first. Cached for two minutes. */
export function inboundLinks(db: DB, sourceId: string, at = Date.now()): Map<string, number> {
  const hit = inboundCache.get(sourceId);
  if (hit && at - hit.at < 120_000) return hit.tally;
  const tally = new Map<string, number>();
  for (const r of db.prepare(`SELECT blocks, properties FROM pages WHERE source_id = ? AND depth <> 'index'`).iterate(sourceId) as Iterable<{ blocks: string; properties: string }>) {
    const seen = new Set<string>();
    for (const m of `${r.blocks}${r.properties}`.matchAll(/"ref":"([^"]+)"/g)) seen.add(m[1].split('#')[0]);
    for (const k of seen) tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  inboundCache.set(sourceId, { at, tally });
  return tally;
}

export interface QueueItem { id: string; external_id: string; score: number; depth: Depth; stale: boolean; wanted: number }

/**
 * The pages still to read in full, best first: opened, searched or asked about
 * (`wanted`), then linked to by pages already read, then the ones that changed
 * at the source, then tree order. Without `all`, only pages that have a
 * reason to be read are listed; with it (fetch everything) every page is.
 */
export function detailQueue(db: DB, sourceId: string, opts: { all: boolean; limit: number; at?: number }): QueueItem[] {
  ensureTierSchema(db);
  const rows = all<any>(db, `SELECT id, external_id, depth, wanted, position,
      (depth <> 'index' AND source_updated_at IS NOT NULL AND source_updated_at <> COALESCE(held_updated_at, '')) AS stale
    FROM pages WHERE source_id = ? AND external_id IS NOT NULL AND (depth <> 'full' OR (source_updated_at IS NOT NULL AND source_updated_at <> COALESCE(held_updated_at, '')))`, sourceId);
  if (!rows.length) return [];
  const inbound = inboundLinks(db, sourceId, opts.at);
  const items = rows.map((r): QueueItem & { pos: number } => {
    const links = inbound.get(String(r.external_id).split('#')[0]) ?? 0;
    return { id: r.id, external_id: r.external_id, depth: r.depth, stale: !!r.stale, wanted: r.wanted, score: r.wanted * 10 + Math.min(links, 50) + (r.stale ? 5 : 0), pos: r.position ?? 1e9 };
  });
  return items.filter((x) => opts.all || x.score > 0).sort((a, b) => b.score - a.score || a.pos - b.pos || (a.external_id < b.external_id ? -1 : 1)).slice(0, opts.limit);
}

/** How many pages wait for their details (with a reason, or all of them). */
export function queueLength(db: DB, sourceId: string, all_: boolean) {
  return detailQueue(db, sourceId, { all: all_, limit: 1_000_000 }).length;
}
