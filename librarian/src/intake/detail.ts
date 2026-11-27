// Tier 3 of the crawl: reading whole pages after the index exists.
//
//   ensureFull   a page was opened, found by a search or asked about: read it now, then serve it
//   detailTick   the background: a few calls a minute (the source's budget), the pages people
//                opened or link to first; every page only when "fetch everything" is on
//
// The index (intake/sync.ts) already put every page in the library, GM-only.
// Whatever arrives here goes through the same save as a sync: levels, markers
// and audience are applied as the content arrives, and the player copy is
// rebuilt before anyone is served it.
import { all, one } from '../core/db.ts';
import { effectiveConfig, normAudience } from './connections.ts';
import type { SyncRecord, TierState } from './connector.ts';
import { connectorFor } from './registry.ts';
import { connectorContext, isRunning, prefixFor, prepareImages, type SyncDeps } from './sync.ts';
import { saveRecords } from './records.ts';
import { entryPictures, withoutDuplicatePictures } from './images.ts';
import { drainPictures, waitingPictures } from './imagequeue.ts';
import { Bucket, addDetailCalls, budgetBucket, budgetDefaultOf, budgetOf, depthCounts, detailQueue, ensureTierSchema, getState, markWanted, queueLength, setSettings, storeEntry, tieredOf } from './tiers.ts';
import { limitKeyOf, limiterState, limitsOf } from './ratelimit.ts';

const busy = new Set<string>();
const inflight = new Map<string, Promise<ReadOutcome>>();
// One read of a page at a time, whoever asks (the background reader, a page opened, a search hit): the second caller waits for the first
// and uses what it saved. Keyed by page id; held from the moment a read starts until it has stored (or failed).
const pageFlights = new Map<string, Promise<void>>();
const onDemand = new Map<string, Bucket>();
// A page that failed to read waits before the background tries it again (5 minutes, doubling, at most 6 hours), so one bad page never
// holds the head of the queue. A refused key (401) pauses the whole source's background reads for 10 minutes.
const failures = new Map<string, { n: number; until: number }>();
const sourceBlocked = new Map<string, number>();
const noteFailure = (id: string, at: number) => { const n = (failures.get(id)?.n ?? 0) + 1; failures.set(id, { n, until: at + Math.min(6 * 3600_000, 300_000 * 2 ** (n - 1)) }); };
/** Tests only: forget every failure and block. */
export function resetFailures() { failures.clear(); sourceBlocked.clear(); refused.clear(); }

// A key the site refuses for page content while it lists pages: said on the source's status until a read works again.
const refused = new Map<string, string>();
const refusalText = (kind: string) => kind.startsWith('legendkeeper')
  ? "This key can list pages but can't read their content. Check its role: LegendKeeper keys need Admin to read page text and hidden pages."
  : "This key can list pages but can't read their content. Check its role and permissions at the source.";
/** Why this source's pages are not being read (a key the site refuses for content), or null. */
export const refusalOf = (sourceId: string): string | null => refused.get(sourceId) ?? null;

export interface ReadOutcome { read: number; calls: number; failed: number; error?: string }

/** Read these pages of one source in full and save them. `maxCalls` stops between pages once that many calls were made. */
export async function readPages(d: SyncDeps, src: any, pages: { id: string; external_id: string }[], opts: { signal?: AbortSignal; maxCalls?: number; background?: boolean } = {}): Promise<ReadOutcome> {
  ensureTierSchema(d.db);
  const cfg = effectiveConfig(d.db, src);
  const tier = tieredOf(src.kind, cfg);
  const out: ReadOutcome = { read: 0, calls: 0, failed: 0 };
  if (!tier || !pages.length) return out;
  const ctl = new AbortController();
  opts.signal?.addEventListener('abort', () => ctl.abort(), { once: true });
  const made = connectorContext(d, src, cfg, ctl.signal, () => {}, { background: !!opts.background });
  const state = getState(d.db, src.id);
  const counter = made.ctx.calls!;
  counter.phase = 'detail';
  prepareImages(d, made.ctx, made.c, src);
  const ts: TierState = { token: state.token, cache: state.cache, full: false, complete: false, next: { token: state.token, cache: state.cache } };
  made.ctx.tier = ts;
  const prefix = prefixFor(made.c.id, src.name);
  const levelBefore = new Map<string, string>();
  const readIds: string[] = [];
  const pictures: SyncRecord[] = [];
  const withPictures = made.c.capabilities.includes('images');
  const pictureOwners = new Set<string>();
  try {
    for (const p of pages) {
      if (ctl.signal.aborted || (opts.maxCalls !== undefined && counter.detail >= opts.maxCalls)) break;
      // Somebody is already reading this page: wait for that read and use its result instead of making the calls twice.
      const flying = pageFlights.get(p.id);
      if (flying) { await flying.catch(() => {}); continue; }
      let landed!: () => void;
      pageFlights.set(p.id, new Promise<void>((r) => { landed = r; }));
      try {
      // Already read in full by an earlier page of the same resource (LegendKeeper tabs): nothing to fetch.
      const now = one<any>(d.db, `SELECT depth, visibility, (depth <> 'index' AND source_updated_at IS NOT NULL AND source_updated_at <> COALESCE(held_updated_at, '')) AS stale FROM pages WHERE id = ?`, p.id);
      if (!now || (now.depth === 'full' && !now.stale)) continue;
      let gotIt = false;
      try {
        for await (const e of tier.detail(cfg, made.ctx, [p.external_id])) {
          // Records come with the listing, except the pictures of a page (a map's image): they are saved with the page.
          if ((e as any).kind) { if ((e as any).kind === 'image') pictures.push(e as SyncRecord); continue; }
          const before = one<any>(d.db, 'SELECT id, visibility FROM pages WHERE world_id = ? AND source_id = ? AND external_id = ?', src.world_id, src.id, (e as any).externalId);
          if (before) levelBefore.set(before.id, before.visibility);
          const r = storeEntry({ db: d.db, library: d.library }, src.world_id, src.id, prefix, e as any, null);
          // Its portrait and the pictures in its text, queued; together they are every picture the page has (the rest are removed below).
          if (withPictures && (e as any).externalId) { pictures.push(...entryPictures(e as any)); pictureOwners.add((e as any).externalId); }
          if (r.id) { if (r.changed !== false) readIds.push(r.id); out.read++; if (r.id === p.id) gotIt = true; }
        }
        // This page did not come back (gone at the source, or its document could not be read), even if other tabs of its resource did:
        // leave it alone for a while. Counting the other tabs as a success asked for it again every few seconds, for ever.
        if (gotIt) failures.delete(p.id); else if (!ctl.signal.aborted) noteFailure(p.id, Date.now());
      } catch (err: any) {
        if (ctl.signal.aborted) break;
        out.failed++;
        out.error = String(err?.message ?? err).slice(0, 200);
        made.limiter.outcome(false, err?.message ?? err);
        noteFailure(p.id, Date.now());
        if (/\(401\)|answered 401\b/.test(out.error)) { sourceBlocked.set(src.id, Date.now() + 600_000); refused.set(src.id, refusalText(src.kind)); break; }
        // A rate limit that did not clear: stop for now, the next tick tries again.
        if (/rate limit|rate-limit/i.test(out.error)) break;
      }
      } finally { pageFlights.delete(p.id); landed(); }
    }
  } finally {
    out.calls = counter.detail;
    if (out.read > 0 && !out.failed) { made.limiter.outcome(true); refused.delete(src.id); }
    made.close();
    addDetailCalls(d.db, src.id, counter.detail);
  }
  if (pictures.length || pictureOwners.size) {
    // Only these pictures are saved, and only the pages read here lose the pictures they no longer have: every other kind of record (and every
    // other page's pictures) is left as it is.
    const audience = normAudience(src.audience);
    if (audience !== 'auto') for (const r of pictures as any[]) r.visibility = audience;
    try { saveRecords(d.db, src.world_id, src.id, withoutDuplicatePictures(pictures), new Set(['relation', 'timeline', 'calendar', 'mapMarker', 'image']), { relationOwners: new Set(), mapRefs: new Set(), pictureOwners }); } catch { /* the pictures come back with the next run */ }
  }
  if (readIds.length) {
    // A page whose level changed changes what other pages may say about it: rebuild the world. Otherwise only the pages that were read.
    const rank: Record<string, number> = { party: 0, broker: 1, dm: 2, classified: 3 };
    const levels = readIds.map((id) => ({ id, was: levelBefore.get(id) ?? '', is: one<any>(d.db, 'SELECT visibility FROM pages WHERE id = ?', id)?.visibility ?? '' }));
    const moved = levels.filter((l) => l.was !== l.is);
    // Only ever more shared (a listed page read for the first time): the pages that name it. Anything that became more secret: the whole world.
    if (moved.length && moved.every((l) => l.was in rank && l.is in rank && rank[l.is] < rank[l.was])) await d.library.rebuildAround(src.world_id, moved.map((l) => l.id), readIds);
    else await d.library.rebuildPlayerCopiesAsync(src.world_id, { only: moved.length ? undefined : readIds });
  }
  return out;
}

export type EnsureResult = 'ready' | 'fetched' | 'unavailable';

/**
 * A page is being opened (by a GM or a player), read by the agent or found by
 * a search: if it is only held at index depth (or changed at the source),
 * read it now. Safe to call for any page: one that is not from a tiered
 * source, or is already read, answers `ready` at once. The page is served
 * only after this returns, so levels and markers are already applied.
 */
export async function ensureFull(d: SyncDeps, worldId: string, pageRef: string, opts: { timeoutMs?: number; wanted?: boolean } = {}): Promise<EnsureResult> {
  ensureTierSchema(d.db);
  const row = one<any>(d.db, `SELECT id, external_id, source_id, depth, (depth <> 'index' AND source_updated_at IS NOT NULL AND source_updated_at <> COALESCE(held_updated_at, '')) AS stale FROM pages WHERE world_id = ? AND (id = ? OR path = ?)`, worldId, pageRef, pageRef);
  if (!row?.source_id || !row.external_id) return 'ready';
  if (opts.wanted !== false) markWanted(d.db, [row.id]);
  if (row.depth === 'full' && !row.stale) return 'ready';
  const src = one<any>(d.db, 'SELECT * FROM sources WHERE id = ?', row.source_id);
  if (!src?.enabled || !tieredOf(src.kind, effectiveConfig(d.db, src))) return 'ready';
  // The background reader (or another open) is already on this page: wait for that read, no new calls and no on-demand allowance spent.
  let pending = inflight.get(row.id);
  const flying = pageFlights.get(row.id);
  if (!pending && flying) { await flying.catch(() => {}); return heldInFull(d, row.id) ? 'fetched' : 'unavailable'; }
  if (!pending) {
    // A page nobody has a reason to open is not worth a call: opening pages is limited to 30 a minute for each source.
    const b = onDemand.get(src.id) ?? onDemand.set(src.id, new Bucket(30, 10, Date.now())).get(src.id)!;
    if (b.waitMs(Date.now()) > 0) return 'unavailable';
    b.spend(1, Date.now());
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
    pending = readPages(d, src, [{ id: row.id, external_id: row.external_id }], { signal: ctl.signal }).finally(() => { clearTimeout(timer); inflight.delete(row.id); });
    inflight.set(row.id, pending);
  }
  const r = await pending;
  return r.read || heldInFull(d, row.id) ? 'fetched' : 'unavailable';
}

/** A page read in full a moment ago by someone else (a read in flight is shared, not repeated). */
const heldInFull = (d: SyncDeps, pageId: string) => !!one<any>(d.db, `SELECT 1 AS x FROM pages WHERE id = ? AND depth = 'full' AND NOT (source_updated_at IS NOT NULL AND source_updated_at <> COALESCE(held_updated_at, ''))`, pageId);

/** The first few pages of a search, or a page the agent was handed, read now (at most `max`). */
export async function ensureMany(d: SyncDeps, worldId: string, ids: string[], max = 3, opts: { timeoutMs?: number } = {}): Promise<number> {
  let n = 0;
  for (const id of ids.slice(0, max)) if ((await ensureFull(d, worldId, id, opts).catch(() => 'unavailable')) === 'fetched') n++;
  return n;
}

export interface TickResult { sourceId: string; calls: number; read: number; waiting: number }

/**
 * One turn of the background reader. Each source that is tiered, not paused
 * and not syncing may spend its budget (calls a minute, as a token bucket) on
 * the pages most worth reading. `at` is the clock (tests move it).
 */
export async function detailTick(d: SyncDeps, opts: { at?: number; pictures?: boolean } = {}): Promise<TickResult[]> {
  ensureTierSchema(d.db);
  const at = opts.at ?? Date.now();
  const out: TickResult[] = [];
  for (const src of all<any>(d.db, `SELECT * FROM sources WHERE enabled = 1 AND kind <> 'push'`)) {
    if (busy.has(src.id) || isRunning(src.id)) continue;
    // A few queued pictures each turn (from the picture hosts, not the API: no call budget is spent).
    if (opts.pictures !== false && waitingPictures(d.db, { sourceId: src.id })) await drainPictures(d, src.id, { max: 5 }).catch(() => {});
    const cfg = effectiveConfig(d.db, src);
    const tier = tieredOf(src.kind, cfg);
    if (!tier) continue;
    const st = getState(d.db, src.id);
    if (st.paused || (sourceBlocked.get(src.id) ?? 0) > at) continue;
    const bucket = budgetBucket(src.id, budgetOf(st, tier), at);
    bucket.refill(at);
    const allowed = Math.floor(bucket.tokens);
    if (allowed < 1) continue;
    const raw = detailQueue(d.db, src.id, { all: st.fetchAll, limit: allowed * 3 + failures.size, at });
    if (!raw.length) {
      // "Fetch everything" is done when nothing is left to read.
      if (st.fetchAll) setSettings(d.db, src.id, { fetchAll: false });
      continue;
    }
    const queue = raw.filter((q) => (failures.get(q.id)?.until ?? 0) <= at).slice(0, allowed * 3);
    if (!queue.length) continue;
    busy.add(src.id);
    try {
      const r = await readPages(d, src, queue.map((q) => ({ id: q.id, external_id: q.external_id })), { maxCalls: allowed, background: true });
      bucket.spend(Math.max(r.calls, r.read ? 0 : 1), at);
      out.push({ sourceId: src.id, calls: r.calls, read: r.read, waiting: queueLength(d.db, src.id, st.fetchAll) });
    } finally { busy.delete(src.id); }
  }
  return out;
}

/** Runs detailTick every few seconds. Not started in tests. Returns the stop function. */
export function startDetailWorker(d: SyncDeps, onTick?: (r: TickResult[]) => void) {
  let running = false;
  const t = setInterval(() => {
    if (running) return;
    running = true;
    detailTick(d).then((r) => { if (r.length) onTick?.(r); }).catch(() => {}).finally(() => { running = false; });
  }, 5000);
  t.unref();
  return () => clearInterval(t);
}

/** What the world page shows about one source's tiers. */
export function tierSummary(d: Pick<SyncDeps, 'db'>, src: any) {
  ensureTierSchema(d.db);
  const cfg = effectiveConfig(d.db, src);
  const c = connectorFor(src.kind, cfg);
  const tier = tieredOf(src.kind, cfg);
  if (!tier) return { tiered: false };
  const st = getState(d.db, src.id);
  const lim = limitsOf(c?.id ?? src.kind, cfg, {}, st.spread);
  const counts = depthCounts(d.db, src.id);
  const last = one<any>(d.db, 'SELECT stats FROM sync_runs WHERE source_id = ? ORDER BY started_at DESC LIMIT 1', src.id);
  let lastStats: any = {};
  try { lastStats = JSON.parse(last?.stats || '{}'); } catch { /* none */ }
  return {
    tiered: true, connector: c?.label ?? src.kind,
    pages: counts.total, depth: { index: counts.index, summary: counts.summary, full: counts.full, stale: counts.stale },
    read: counts.full,
    calls: { index: lastStats.indexCalls ?? 0, indexTotal: st.indexCalls, detailTotal: st.detailCalls },
    budget: budgetOf(st, tier), budgetDefault: budgetDefaultOf(tier), rateLimit: tier.budgetPerMinute,
    paused: st.paused, fetchAll: st.fetchAll, waiting: queueLength(d.db, src.id, st.fetchAll), waitingAll: queueLength(d.db, src.id, true),
    limits: { perMinute: lim.perMinute, perSecond: lim.perSecond, perHour: lim.perHour, spreadMinutes: lim.spreadMinutes, spreadOwn: st.spread !== null },
    // Set while the site (or its limit) is holding calls back: the live state the world page shows.
    throttle: limiterState(limitKeyOf(src, d.db)),
    refused: refusalOf(src.id),
    indexAt: st.indexAt, lastDetailAt: st.lastDetailAt, running: busy.has(src.id),
  };
}
