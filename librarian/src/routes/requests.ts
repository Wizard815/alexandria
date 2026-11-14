// Change requests: players suggest edits, new pages or ask questions; the DM
// accepts (optionally applying the change to the library) or turns them down.
import { Router } from 'express';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { one, all, run } from '../core/db.ts';
import { requireDM, requirePlayerOrDM } from '../core/auth.ts';
import { dmAnd } from '../core/events.ts';
import { HttpError, id, now, oneOf, str } from '../core/util.ts';
import { ctx, isDM, me, settings } from './_shared.ts';

export default function requestRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;
  const audienceFor = (row: any) => (row.visibility === 'party' ? () => true : dmAnd(row.author_id));

  r.get('/', (_req, res) => {
    const c = ctx(res);
    const rows = isDM(res)
      ? all(db, 'SELECT * FROM requests WHERE world_id = ? ORDER BY created_at DESC', c.world.id)
      : all(db, `SELECT * FROM requests WHERE world_id = ? AND (author_id = ? OR visibility = 'party') ORDER BY created_at DESC`, c.world.id, me(res));
    res.json(rows);
  });

  r.post('/', requirePlayerOrDM, (req, res) => {
    const c = ctx(res);
    const b = req.body ?? {};
    const kind = oneOf(b.kind, 'kind', ['edit', 'new', 'question'] as const);
    let pageId: string | null = null;
    if (kind === 'edit') {
      pageId = str(b.pageId, 'pageId', { max: 60 });
      // Players can only point at pages they can see.
      d.library.get(c.world.id, pageId, c.viewer);
    }
    const row = {
      id: id('req_'), world_id: c.world.id, author_id: me(res), kind, page_id: pageId,
      title: str(b.title, 'title', { max: 200 }), body: str(b.body, 'body', { max: 50_000 }),
      visibility: oneOf(b.visibility, 'visibility', ['dm', 'party'] as const, settings(res).requestDefault), created_at: now(),
    };
    run(db, 'INSERT INTO requests (id, world_id, author_id, kind, page_id, title, body, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.world_id, row.author_id, row.kind, row.page_id, row.title, row.body, row.visibility, row.created_at);
    d.hub.emit(c.world.id, 'request', row, audienceFor(row));
    res.status(201).json(row);
  });

  // DM decides. body: { decision: 'accepted'|'rejected', reply?, apply?: { mode: 'append'|'replace'|'create', path?, visibility? } }
  r.post('/:id/decide', requireDM, (req, res) => {
    const c = ctx(res);
    const row = one<any>(db, 'SELECT * FROM requests WHERE id = ? AND world_id = ?', String(req.params.id), c.world.id);
    if (!row) throw new HttpError(404, 'Request not found');
    if (row.status !== 'open') throw new HttpError(409, 'Already decided');
    const decision = oneOf(req.body?.decision, 'decision', ['accepted', 'rejected'] as const);
    const reply = str(req.body?.reply, 'reply', { max: 5000, optional: true }) || null;
    let applied: any = null;
    const apply = req.body?.apply;
    if (decision === 'accepted' && apply) {
      const mode = oneOf(apply.mode, 'apply.mode', ['append', 'replace', 'create'] as const);
      const text = typeof apply.body === 'string' ? apply.body : row.body;
      if (mode === 'create') {
        applied = d.library.save(c.world.id, { path: str(apply.path, 'apply.path', { max: 300 }), title: row.title, body: text, visibility: oneOf(apply.visibility, 'apply.visibility', ['dm', 'party'] as const, 'dm') }, me(res));
      } else {
        if (!row.page_id) throw new HttpError(400, 'This request is not about a page');
        const pg = d.library.get(c.world.id, row.page_id, { accountId: c.viewer.accountId, role: c.viewer.role }) as any;
        applied = d.library.save(c.world.id, { path: pg.path, title: pg.title, frontmatter: pg.frontmatter, visibility: pg.visibility, body: mode === 'append' ? `${pg.body.trimEnd()}\n\n${text}\n` : text }, me(res));
      }
    }
    run(db, 'UPDATE requests SET status = ?, reply = ?, decided_at = ?, decided_by = ? WHERE id = ?', decision, reply, now(), me(res), row.id);
    audit(db, c.world.id, me(res), 'request.decide', `${row.id} ${decision}${applied ? ' applied ' + applied.path : ''}`);
    const out = { ...row, status: decision, reply };
    d.hub.emit(c.world.id, 'request', out, audienceFor(row));
    res.json({ request: out, applied });
  });

  return r;
}
