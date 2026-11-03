// One persistent whiteboard per world, shared by the DM and players.
// Saves carry the version they were based on, so two people drawing at once
// do not silently overwrite each other. Every version is kept; a wipe needs
// {"confirm": true} and is just another version you can go back to.
import { Router } from 'express';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { one, all, run, tx } from '../core/db.ts';
import { requirePlayerOrDM } from '../core/auth.ts';
import { HttpError, int, now } from '../core/util.ts';
import { ctx, isDM, me, settings } from './_shared.ts';

const MAX_DOC = 2_000_000;

export default function whiteboardRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;
  const cur = (wid: string) => one<any>(db, 'SELECT * FROM whiteboards WHERE world_id = ?', wid) ?? { version: 0, doc: '{"shapes":[]}', updated_by: null, updated_at: null };

  function save(wid: string, base: number, doc: string, by: string) {
    return tx(db, () => {
      const c = cur(wid);
      if (base !== c.version) throw new HttpError(409, `The board changed (now version ${c.version}). Load it again and retry.`);
      const v = c.version + 1;
      const at = now();
      run(db, `INSERT INTO whiteboards (world_id, version, doc, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (world_id) DO UPDATE SET version = excluded.version, doc = excluded.doc, updated_by = excluded.updated_by, updated_at = excluded.updated_at`, wid, v, doc, by, at);
      run(db, 'INSERT INTO whiteboard_history (world_id, version, doc, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)', wid, v, doc, by, at);
      return { version: v, updated_at: at };
    });
  }

  r.get('/', (_req, res) => {
    const c = cur(ctx(res).world.id);
    res.json({ version: c.version, doc: JSON.parse(c.doc), updated_by: c.updated_by, updated_at: c.updated_at });
  });

  r.put('/', requirePlayerOrDM, (req, res) => {
    const w = ctx(res).world.id;
    const base = int(req.body?.baseVersion, 'baseVersion', { min: 0 })!;
    if (!req.body?.doc || typeof req.body.doc !== 'object') throw new HttpError(400, 'doc is required');
    const doc = JSON.stringify(req.body.doc);
    if (doc.length > MAX_DOC) throw new HttpError(413, 'The board is too big');
    const out = save(w, base, doc, me(res));
    d.hub.emit(w, 'whiteboard', { version: out.version, by: me(res) }, () => true);
    res.json(out);
  });

  r.post('/wipe', requirePlayerOrDM, (req, res) => {
    const w = ctx(res).world.id;
    if (settings(res).whiteboardWipe === 'dm' && !isDM(res)) throw new HttpError(403, 'Only the DM can wipe the board in this world');
    if (req.body?.confirm !== true) throw new HttpError(400, 'Send {"confirm": true} to wipe the board');
    const out = save(w, cur(w).version, '{"shapes":[]}', me(res));
    audit(db, w, me(res), 'whiteboard.wipe', `version ${out.version}`);
    d.hub.emit(w, 'whiteboard', { version: out.version, by: me(res), wiped: true }, () => true);
    res.json(out);
  });

  r.get('/history', (_req, res) => {
    res.json(all(db, 'SELECT version, updated_by, updated_at, length(doc) AS size FROM whiteboard_history WHERE world_id = ? ORDER BY version DESC LIMIT 200', ctx(res).world.id));
  });
  r.get('/history/:v', (req, res) => {
    const h = one<any>(db, 'SELECT * FROM whiteboard_history WHERE world_id = ? AND version = ?', ctx(res).world.id, Number(String(req.params.v)));
    if (!h) throw new HttpError(404, 'Version not found');
    res.json({ version: h.version, doc: JSON.parse(h.doc), updated_by: h.updated_by, updated_at: h.updated_at });
  });

  return r;
}
