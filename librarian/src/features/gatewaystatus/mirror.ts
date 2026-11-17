// The world mirror, as the admin sees it: each world's folder of copies on disk (vault, party, _api), how many files, when one was last
// written, and the copies that could not be written. The database is the truth; the folder is a copy for people who read it.
//
// A non-DM admin gets counts only: the paths of failed copies are page paths, and a DM-only page's path is DM-only.
import fs from 'node:fs';
import path from 'node:path';
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { now } from '../../core/util.ts';
import { adminViewer } from '../gateway/worlds.ts';

export const MIRROR_SCHEMA = `
-- Copies the mirror could not write. A copy that is written later is removed from here.
CREATE TABLE IF NOT EXISTS gwstatus_mirror_failures (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  copy TEXT NOT NULL,
  path TEXT NOT NULL,
  error TEXT NOT NULL,
  at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (world_id, copy, path)
);
`;

/** Error text with the data folder cut out of it: what failed, not where the server keeps things. */
const cleanFsError = (msg: string, dataDir: string | null) => {
  let t = String(msg).replace(/\s+/g, ' ');
  if (dataDir) t = t.split(dataDir).join('<data>');
  return t.replace(/'[^']*\/worlds\/[^']*\//g, "'<data>/worlds/…/").slice(0, 200);
};

/** Keep the failures, and forget one when the same copy is written. */
export function listenToMirror(d: Deps) {
  const failed = new Set<string>();
  try { for (const f of all<{ world_id: string; copy: string; path: string }>(d.db, 'SELECT world_id, copy, path FROM gwstatus_mirror_failures')) failed.add(`${f.world_id}\n${f.copy}\n${f.path}`); } catch { /* table not there yet */ }
  d.library.mirrorSink = (e) => {
    const key = `${e.worldId}\n${e.copy}\n${e.path}`;
    if (e.error === null) {
      if (failed.delete(key)) run(d.db, 'DELETE FROM gwstatus_mirror_failures WHERE world_id = ? AND copy = ? AND path = ?', e.worldId, e.copy, e.path);
      return;
    }
    failed.add(key);
    run(d.db, `INSERT INTO gwstatus_mirror_failures (world_id, copy, path, error, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (world_id, copy, path) DO UPDATE SET error = excluded.error, at = excluded.at, attempts = attempts + 1`, e.worldId, e.copy, e.path, cleanFsError(e.error, d.dataDir), now());
  };
}

const MAX_WALK = 100_000;
/** Files under a folder: how many, how big, the newest one's time. Symlinks are not followed. */
function walk(dir: string): { files: number; bytes: number; newest: number } {
  const out = { files: 0, bytes: 0, newest: 0 };
  const stack = [dir];
  while (stack.length && out.files < MAX_WALK) {
    const cur = stack.pop()!;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const f = path.join(cur, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(f);
      else if (e.isFile()) {
        try { const s = fs.statSync(f); out.files++; out.bytes += s.size; if (s.mtimeMs > out.newest) out.newest = s.mtimeMs; } catch { /* gone */ }
      }
    }
  }
  return out;
}

export interface MirrorWorld {
  id: string; name: string; slug: string; view: 'dm' | 'counts'; folder: string | null; exists: boolean;
  pages: number; shared: number;
  copies: Record<'vault' | 'party' | 'api', { files: number; bytes: number }>;
  lastWrittenAt: string | null; failures: number; failed: { copy: string; path: string; error: string; at: string; attempts: number }[] | null;
}

export function mirrorStatus(d: Deps, accountId: string): { enabled: boolean; worlds: MirrorWorld[]; totals: { files: number; bytes: number; failures: number } } {
  const worlds = all<{ id: string; name: string; slug: string }>(d.db, 'SELECT id, name, slug FROM worlds ORDER BY name');
  const totals = { files: 0, bytes: 0, failures: 0 };
  const out: MirrorWorld[] = worlds.map((w) => {
    const dir = d.library.mirrorDir(w.id);
    const isDm = adminViewer(d.db, w.id, accountId).role === 'dm';
    const exists = !!dir && fs.existsSync(dir);
    const copy = (sub: string) => (exists ? walk(path.join(dir!, sub)) : { files: 0, bytes: 0, newest: 0 });
    const v = copy('vault'), p = copy('party'), a = copy('_api');
    const failures = one<{ n: number }>(d.db, 'SELECT COUNT(*) AS n FROM gwstatus_mirror_failures WHERE world_id = ?', w.id)?.n ?? 0;
    const newest = Math.max(v.newest, p.newest, a.newest);
    totals.files += v.files + p.files + a.files; totals.bytes += v.bytes + p.bytes + a.bytes; totals.failures += failures;
    return {
      id: w.id, name: w.name, slug: w.slug, view: isDm ? 'dm' : 'counts',
      folder: dir ? `worlds/${w.slug}` : null, exists,
      pages: one<{ n: number }>(d.db, 'SELECT COUNT(*) AS n FROM pages WHERE world_id = ?', w.id)?.n ?? 0,
      shared: one<{ n: number }>(d.db, 'SELECT COUNT(*) AS n FROM pages WHERE world_id = ? AND player_body IS NOT NULL', w.id)?.n ?? 0,
      copies: { vault: { files: v.files, bytes: v.bytes }, party: { files: p.files, bytes: p.bytes }, api: { files: a.files, bytes: a.bytes } },
      lastWrittenAt: newest ? new Date(newest).toISOString() : null,
      failures,
      failed: isDm ? all<any>(d.db, 'SELECT copy, path, error, at, attempts FROM gwstatus_mirror_failures WHERE world_id = ? ORDER BY at DESC LIMIT 200', w.id) : null,
    };
  });
  return { enabled: !!d.dataDir, worlds: out, totals };
}

/** Write every copy again from the database. Returns what the folder holds afterwards. */
export function rewriteMirror(d: Deps, worldId: string) {
  d.library.rebuildPlayerCopies(worldId);
}
