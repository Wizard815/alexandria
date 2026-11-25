// The picture downloader: fetches the pictures a sync queued (portraits,
// banners and the pictures in a page's text, see entryPictures) and stores
// them with the page, so the apps show them from this server, also when the
// source (or the internet) is out of reach.
//
// A queued picture is a row of intake_images whose `want_marker` differs from
// its `marker`. Pictures come from the source's file servers (Kanka's and
// LegendKeeper's image hosts), not its API, so they do not spend the API's
// call budget; they are fetched one at a time, never with the source's token,
// never from a private address, and only PNG, JPEG, GIF and WebP (checked by
// their own first bytes). A picture that keeps failing is tried MAX_TRIES
// times, then left alone until its address changes.
//
// Who drains the queue: every sync (a few, ALX_IMAGES_PER_RUN), the background
// reader (a few every tick) and the "Refresh world" job (everything).
import type { DB } from '../core/db.ts';
import { all, one, run } from '../core/db.ts';
import { now } from '../core/util.ts';
import type { ConnectorContext } from './connector.ts';
import { downloadImage } from './images.ts';
import { MAX_STORED_IMAGE, MAX_TRIES, initRecords } from './records.ts';

export interface QueueDeps { db: DB; fetch: typeof fetch; env: Record<string, string | undefined> }
export interface DrainResult { downloaded: number; failed: number; waiting: number; stoppedAt?: string }

const busy = new Set<string>();
const num = (v: string | undefined, dflt: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : dflt);
/** The size cap and how many pictures a source may hold (ALX_IMAGE_MAX_BYTES, ALX_IMAGES_MAX). */
export const queueLimits = (env: Record<string, string | undefined>) => ({ maxBytes: Math.min(num(env.ALX_IMAGE_MAX_BYTES, 20 * 1024 * 1024), MAX_STORED_IMAGE), maxHeld: num(env.ALX_IMAGES_MAX, 2000) });

/** Pictures of this source (or of a whole world) waiting to be downloaded. */
export function waitingPictures(db: DB, where: { sourceId?: string; worldId?: string }): number {
  initRecords(db);
  const [col, val] = where.sourceId ? ['source_id', where.sourceId] : ['world_id', where.worldId];
  return Number(one<any>(db, `SELECT COUNT(*) AS n FROM intake_images WHERE ${col} = ? AND want_marker IS NOT NULL AND want_marker <> marker AND tries < ?`, val, MAX_TRIES)?.n ?? 0);
}

/**
 * Download up to `max` queued pictures of one source (portraits and banners first, then the pictures in page text). One drain per source at
 * a time: a second caller gets nothing done and the first one's queue. `onEach` is told after every picture.
 */
export async function drainPictures(d: QueueDeps, sourceId: string, opts: { max?: number; signal?: AbortSignal; onEach?: (r: DrainResult) => void; log?: (m: string) => void } = {}): Promise<DrainResult> {
  initRecords(d.db);
  const out: DrainResult = { downloaded: 0, failed: 0, waiting: waitingPictures(d.db, { sourceId }) };
  if (busy.has(sourceId) || !out.waiting) return out;
  busy.add(sourceId);
  const lim = queueLimits(d.env);
  const signal = opts.signal ?? new AbortController().signal;
  const log = opts.log ?? (() => {});
  // The picture hosts are not the API: no rate limiter and no token. downloadImage still refuses private addresses and redirects to other hosts.
  const ctx = { fetch: d.fetch, signal, log } as unknown as ConnectorContext;
  const max = opts.max ?? Infinity;
  try {
    let tried = 0;
    // A picture is tried once a drain: one that fails waits for the next.
    const done = new Set<string>();
    while (tried < max && !signal.aborted) {
      const held = Number(one<any>(d.db, 'SELECT COUNT(*) AS n FROM intake_images WHERE source_id = ? AND size > 0', sourceId)?.n ?? 0);
      const batch = all<any>(d.db, `SELECT id, name, url, want_marker, size FROM intake_images WHERE source_id = ? AND want_marker IS NOT NULL AND want_marker <> marker AND tries < ?
        ORDER BY kind = 'inline', tries, at LIMIT ?`, sourceId, MAX_TRIES, Math.min(25, max - tried) + done.size).filter((r) => !done.has(r.id)).slice(0, 25);
      if (!batch.length) break;
      for (const row of batch) {
        if (signal.aborted || tried >= max) break;
        tried++;
        done.add(row.id);
        // A new picture past the cap waits (one already held may still be replaced by its new version).
        if (!row.size && held + out.downloaded >= lim.maxHeld) { out.stoppedAt = `the limit of ${lim.maxHeld} pictures for this source (ALX_IMAGES_MAX)`; return out; }
        let got: { data: Uint8Array; mime: string } | null = null;
        let error: string | null = null;
        try { got = row.url ? await downloadImage(row.url, '', {}, ctx, lim.maxBytes) : null; } catch (err: any) {
          if (signal.aborted) break;
          error = String(err?.message ?? err).slice(0, 200);
        }
        if (got) {
          run(d.db, 'UPDATE intake_images SET data = ?, size = ?, mime = ?, marker = want_marker, want_marker = NULL, tries = 0, error = NULL, at = ? WHERE id = ?', Buffer.from(got.data), got.data.length, got.mime, now(), row.id);
          out.downloaded++;
        } else {
          error ??= 'not a PNG, JPEG, GIF or WebP, too big, or not reachable';
          run(d.db, 'UPDATE intake_images SET tries = tries + 1, error = ? WHERE id = ?', error, row.id);
          out.failed++;
          log(`Picture ${row.name || row.url} not downloaded: ${error}`);
        }
        out.waiting = waitingPictures(d.db, { sourceId });
        opts.onEach?.(out);
      }
    }
  } finally { busy.delete(sourceId); }
  out.waiting = waitingPictures(d.db, { sourceId });
  return out;
}

/** Give every picture that was given up on another chance (a refresh someone asked for). */
export function retryFailedPictures(db: DB, worldId: string): number {
  initRecords(db);
  return run(db, 'UPDATE intake_images SET tries = 0 WHERE world_id = ? AND want_marker IS NOT NULL AND want_marker <> marker AND tries >= ?', worldId, MAX_TRIES);
}
