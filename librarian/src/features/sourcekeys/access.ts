// The per-account view (PLAN §17.2): what a player's own per-user key can see,
// kept as page_access(world, page, account), ids only. Core/library.ts reads it
// (liftedPages) to let that one account open the player copy of a page the
// source marks private. Only `per-user` keys with the `library` use are ever
// refreshed, and a blanket or unsure key never feeds anyone's view.
import type { Deps } from '../../app.ts';
import { all, one, run, tx } from '../../core/db.ts';
import { now } from '../../core/util.ts';
import { listVisible, type SourceRow } from './live.ts';
import { auditUse, isPerUser, usesOf, usersOf, type KeyRow } from './store.ts';

/** Least time between two refreshes of one key (it reads the whole source as that person). */
export const REFRESH_EVERY_MS = 5 * 60_000;
const inflight = new Set<string>();

export const canFeedLibrary = (k: KeyRow) => !k.revoked && !!k.verified && isPerUser(k) && usesOf(k).includes('library');

export interface RefreshResult { ok: boolean; pages: number; note: string; status: number }

/** How long until this key may be refreshed again, in ms (0 when it may be now). */
export function waitMs(k: KeyRow, at = Date.now()): number {
  const last = k.refreshed_at ? Date.parse(k.refreshed_at) : 0;
  return Math.max(0, last + REFRESH_EVERY_MS - at);
}

/**
 * Read what the key can see and store it for each account that may use the
 * key for its library view. `force` skips the rate limit (the GM, the first read).
 */
export async function refreshAccess(d: Deps, k: KeyRow, by: string, opts: { force?: boolean } = {}): Promise<RefreshResult> {
  if (!canFeedLibrary(k)) return { ok: false, pages: 0, status: 409, note: 'Only a verified per-user key with the library use feeds a library view.' };
  if (!opts.force && waitMs(k) > 0) return { ok: false, pages: 0, status: 429, note: `Refreshed a moment ago. Try again in ${Math.ceil(waitMs(k) / 60_000)} min.` };
  if (inflight.has(k.id)) return { ok: false, pages: 0, status: 409, note: 'A refresh of this key is already running.' };
  const src = one<SourceRow>(d.db, 'SELECT * FROM sources WHERE id = ? AND world_id = ?', k.source_id, k.world_id);
  if (!src) return { ok: false, pages: 0, status: 404, note: 'The source is gone.' };
  inflight.add(k.id);
  try {
    run(d.db, 'UPDATE sourcekeys_keys SET refreshed_at = ? WHERE id = ?', now(), k.id);
    auditUse(d.db, k, by, 'library', 'refresh');
    const ids = await listVisible(d, src, k.secret);
    // The key may have been revoked or changed while the source was read: read it again before storing anything.
    const live = one<KeyRow>(d.db, 'SELECT * FROM sourcekeys_keys WHERE id = ?', k.id);
    if (!live || !canFeedLibrary(live)) return { ok: false, pages: 0, status: 409, note: 'The key was changed while it was being read. Nothing was stored.' };
    const pages = all<{ id: string; external_id: string }>(d.db, 'SELECT id, external_id FROM pages WHERE world_id = ? AND source_id = ? AND external_id IS NOT NULL', k.world_id, k.source_id).filter((p) => ids.has(p.external_id));
    const accounts = usersOf(live);
    tx(d.db, () => {
      run(d.db, 'DELETE FROM sourcekeys_access WHERE key_id = ?', k.id);
      for (const acc of accounts) for (const p of pages) run(d.db, 'INSERT OR IGNORE INTO sourcekeys_access (world_id, page_id, account_id, key_id) VALUES (?, ?, ?, ?)', k.world_id, p.id, acc, k.id);
      run(d.db, 'UPDATE sourcekeys_keys SET refresh_note = ? WHERE id = ?', `${pages.length} pages seen of ${ids.size} the key lists`, k.id);
    });
    d.library.changed(k.world_id);
    return { ok: true, pages: pages.length, status: 200, note: `Your key sees ${pages.length} pages that are in this library.` };
  } catch (e: any) {
    const note = `Could not read the source with this key: ${String(e?.message ?? e).slice(0, 160)}`;
    run(d.db, 'UPDATE sourcekeys_keys SET refresh_note = ? WHERE id = ?', note, k.id);
    return { ok: false, pages: 0, status: 502, note };
  } finally {
    inflight.delete(k.id);
  }
}

/** Forget what a key could see (it was revoked, or its trust, users or uses changed). */
export function dropAccess(d: Deps, keyId: string) {
  const w = one<{ world_id: string }>(d.db, 'SELECT world_id FROM sourcekeys_keys WHERE id = ?', keyId)?.world_id;
  run(d.db, 'DELETE FROM sourcekeys_access WHERE key_id = ?', keyId);
  if (w) d.library.changed(w);
}
