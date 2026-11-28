// Gateway status for the admin (/api/admin/gwstatus/*, admins only): what each connection is doing, the world mirror on disk, the files
// held from sources, and what people search for. Everything here is a number, a name or a time. Being an admin does not open a world: query
// text, page paths and file names appear only where the admin is that world's GM, and never a token or a keyed URL.
//
//   GET  /connections         per connection: calls today and this hour, last success, last (cleaned) error, health, rate-limit state
//   GET  /mirror              per world: the folder's files, when last written, failed copies
//   POST /mirror/:world/rewrite   write every copy again from the database
//   GET  /files               per world and source: files held, sizes, last fetched, disk totals (re-fetch: POST /api/admin/sources/:id/sync)
//   DELETE /files/library/:id     delete a library file (the only kind removed here)
//   GET  /searches?days=7     what people searched, what found nothing, results by source
//   POST /searches/draft      the GM of a world: GM-only draft pages for queries that found nothing
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import type { Auth } from '../../core/auth.ts';
import { one, run } from '../../core/db.ts';
import { HttpError, now, str } from '../../core/util.ts';
import { setCallSink } from '../../intake/ratelimit.ts';
import { CALLS_SCHEMA, connectionStatuses, makeSink } from './calls.ts';
import { MIRROR_SCHEMA, listenToMirror, mirrorStatus, rewriteMirror } from './mirror.ts';
import { deleteLibraryFile, sourceFiles } from './files.ts';
import { SEARCH_SCHEMA, draftMissing, prune, searchStats } from './searchlog.ts';

const me = (res: any) => (res.locals.auth as Auth).account.id;

const feature: Feature = {
  id: 'gatewaystatus',
  schema: CALLS_SCHEMA + MIRROR_SCHEMA + SEARCH_SCHEMA,
  start: (d: Deps) => {
    const t = setInterval(() => { try { prune(d.db); } catch { /* next time */ } }, 3600_000);
    t.unref?.();
    return () => clearInterval(t);
  },
  adminMount: 'gwstatus',
  adminRoutes: (d: Deps) => {
    // Listen now: the limiters of this database tell the sink about every call, and the library about every copy it writes.
    setCallSink(d.db, makeSink(d.db));
    listenToMirror(d);
    const r = Router();

    r.get('/connections', (_req, res) => res.json({ at: now(), connections: connectionStatuses(d) }));

    r.get('/mirror', (_req, res) => res.json(mirrorStatus(d, me(res))));
    r.post('/mirror/:world/rewrite', (req, res) => {
      if (!d.dataDir) throw new HttpError(409, 'This server keeps no data folder, so there is no mirror to write');
      const w = one<{ id: string; name: string }>(d.db, 'SELECT id, name FROM worlds WHERE id = ? OR slug = ?', String(req.params.world), String(req.params.world));
      if (!w) throw new HttpError(404, 'World not found');
      rewriteMirror(d, w.id);
      run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', w.id, me(res), 'mirror.rewrite', 'mirror rewritten', now());
      res.json({ ok: true, world: mirrorStatus(d, me(res)).worlds.find((x) => x.id === w.id) });
    });

    r.get('/files', (_req, res) => res.json(sourceFiles(d, me(res))));
    r.delete('/files/library/:id', (req, res) => res.json(deleteLibraryFile(d, me(res), String(req.params.id))));

    r.get('/searches', (req, res) => res.json(searchStats(d, me(res), Number(req.query.days) || 7)));
    r.post('/searches/draft', (req, res) => {
      const world = str(req.body?.world, 'world', { max: 100 });
      res.json(draftMissing(d, me(res), world, req.body?.queries));
    });
    return r;
  },
};
export default feature;
