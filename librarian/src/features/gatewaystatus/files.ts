// Files that came from sources or were added to the library, per world: what is held, how big, when it was fetched, how much disk it
// takes. Names are shown only for files the admin may see: an admin who is not a world's GM sees the files its players may see by name,
// and the rest only as counts and sizes ("a GM-only file").
import fs from 'node:fs';
import path from 'node:path';
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { HttpError, now } from '../../core/util.ts';
import { cleanErrorText } from '../../intake/ratelimit.ts';
import { connectorFor } from '../../intake/registry.ts';
import { imageVisibleTo, initRecords } from '../../intake/records.ts';
import { mayRead } from '../libfiles/index.ts';
import { adminViewer } from '../gateway/worlds.ts';

const LIST_CAP = 200;

const dirBytes = (dir: string): number => {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const f = path.join(cur, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(f);
      else if (e.isFile()) { try { n += fs.statSync(f).size; } catch { /* gone */ } }
    }
  }
  return n;
};

interface FileRow { id: string; name: string | null; kind: string; size: number; at: string; level: string; hidden: boolean }

export function sourceFiles(d: Deps, accountId: string) {
  initRecords(d.db);
  const worlds = all<{ id: string; name: string }>(d.db, 'SELECT id, name FROM worlds ORDER BY name');
  let imageBytes = 0, imageCount = 0, libBytes = 0, libCount = 0;
  const out = worlds.map((w) => {
    const isGm = adminViewer(d.db, w.id, accountId).role === 'gm';
    const sources = all<any>(d.db, 'SELECT id, name, kind, connection_id, last_sync_at, last_status, enabled FROM sources WHERE world_id = ? ORDER BY name', w.id).map((s) => {
      const imgs = all<any>(d.db, `SELECT id, name, kind, size, at, visibility, page_external, world_id, source_id FROM intake_images WHERE world_id = ? AND source_id = ? ORDER BY at DESC`, w.id, s.id);
      const files: FileRow[] = imgs.slice(0, LIST_CAP).map((i) => {
        const may = isGm || imageVisibleTo(d.db, i, 'player');
        return { id: i.id, name: may ? i.name || 'Unnamed' : null, kind: i.kind, size: i.size, at: i.at, level: i.visibility === 'party' ? 'party' : 'gm', hidden: !may };
      });
      const bytes = imgs.reduce((n, i) => n + i.size, 0);
      imageBytes += bytes; imageCount += imgs.length;
      const connector = connectorFor(s.kind);
      const last = imgs.reduce((m: string | null, i) => (!m || i.at > m ? i.at : m), null);
      return {
        id: s.id, name: s.name, kind: s.kind, connector: connector?.label ?? s.kind, enabled: !!s.enabled,
        lastSyncAt: s.last_sync_at, lastStatus: s.last_status ? cleanErrorText(s.last_status) : null, lastFetchedAt: last,
        // Only a source that makes calls can be read again; a push source or a folder has nothing to fetch.
        canSync: !!connector && !connector.push && !['markdown-folder', 'vault', 'git'].includes(s.kind),
        count: imgs.length, bytes, byKind: Object.entries(imgs.reduce((m: Record<string, number>, i) => ({ ...m, [i.kind]: (m[i.kind] ?? 0) + 1 }), {})).map(([kind, n]) => ({ kind, count: n })),
        hiddenCount: files.filter((f) => f.hidden).length,
        files, truncated: imgs.length > LIST_CAP,
      };
    });
    const libs = all<any>(d.db, 'SELECT id, page_id, name, kind, level, size, at, world_id FROM libfiles_files WHERE world_id = ? ORDER BY at DESC', w.id);
    const libFiles: FileRow[] = libs.slice(0, LIST_CAP).map((f) => {
      const may = isGm || mayRead(d, f, { accountId, role: 'player' });
      return { id: f.id, name: may ? f.name : null, kind: f.kind, size: f.size, at: f.at, level: f.level, hidden: !may };
    });
    const lb = libs.reduce((n, f) => n + f.size, 0);
    libBytes += lb; libCount += libs.length;
    return {
      id: w.id, name: w.name, view: isGm ? 'gm' : 'counts', sources,
      library: { count: libs.length, bytes: lb, files: libFiles, truncated: libs.length > LIST_CAP, hiddenCount: libFiles.filter((f) => f.hidden).length },
    };
  });
  const onDisk = d.dataDir ? dirBytes(path.join(d.dataDir, 'libfiles')) : 0;
  return {
    totals: { pictures: { count: imageCount, bytes: imageBytes }, libraryFiles: { count: libCount, bytes: libBytes, onDiskBytes: onDisk }, bytes: imageBytes + libBytes },
    worlds: out,
  };
}

/** Delete a library file (the only kind an admin may delete here; a source's pictures come back with its next sync). Only one the admin may see. */
export function deleteLibraryFile(d: Deps, accountId: string, fileId: string): { ok: true; name: string } {
  const f = one<any>(d.db, 'SELECT * FROM libfiles_files WHERE id = ?', fileId);
  if (!f) return notFound();
  const isGm = adminViewer(d.db, f.world_id, accountId).role === 'gm';
  if (!isGm && !mayRead(d, f, { accountId, role: 'player' })) return notFound();
  run(d.db, 'DELETE FROM libfiles_files WHERE id = ?', f.id);
  if (d.dataDir) fs.rmSync(path.join(d.dataDir, 'libfiles', f.world_id, f.id), { force: true });
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', f.world_id, accountId, 'libfile.delete', `admin removed ${isGm ? f.name : 'a shared file'}`.slice(0, 500), now());
  d.hub.emit(f.world_id, 'libfile', { pageId: f.page_id }, () => true);
  return { ok: true, name: isGm ? f.name : 'File' };
}

function notFound(): never { throw new HttpError(404, 'File not found'); }
