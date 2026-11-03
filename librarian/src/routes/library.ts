// The library (mirror) for one world. DMs read and write everything;
// players and guests only get the player copy of shared pages ("Lore").
import { Router } from 'express';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { requireDM } from '../core/auth.ts';
import { splitFrontmatter } from '../core/frontmatter.ts';
import { str } from '../core/util.ts';
import { ctx, me } from './_shared.ts';

export default function libraryRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const L = d.library;

  r.get('/pages', (_req, res) => res.json(L.list(ctx(res).world.id, ctx(res).viewer)));
  r.get('/pages/:id', (req, res) => res.json(L.get(ctx(res).world.id, String(req.params.id), ctx(res).viewer)));
  r.get('/search', (req, res) => res.json(L.search(ctx(res).world.id, str(req.query.q, 'q', { max: 200 }), ctx(res).viewer)));
  r.get('/relations', (_req, res) => res.json(L.relations(ctx(res).world.id, ctx(res).viewer)));

  // Write a page: either { markdown } with frontmatter in it, or
  // { body, frontmatter, title, visibility }.
  r.put('/pages', requireDM, (req, res) => {
    const c = ctx(res);
    const b = req.body ?? {};
    let fm = b.frontmatter && typeof b.frontmatter === 'object' ? b.frontmatter : {};
    let body = typeof b.body === 'string' ? b.body : '';
    if (typeof b.markdown === 'string') ({ fm, body } = splitFrontmatter(b.markdown));
    const saved = L.save(c.world.id, { path: str(b.path, 'path', { max: 300 }), title: b.title, body, frontmatter: fm, visibility: b.visibility ?? fm.visibility }, me(res));
    audit(d.db, c.world.id, me(res), 'page.save', `${saved.path} ${saved.visibility}`);
    d.hub.emit(c.world.id, 'page', { id: saved.id, path: saved.path, title: saved.title }, (v) => v.role === 'dm' || saved.visibility === 'party');
    res.json(saved);
  });

  r.delete('/pages/:id', requireDM, (req, res) => {
    const c = ctx(res);
    L.remove(c.world.id, String(req.params.id));
    audit(d.db, c.world.id, me(res), 'page.delete', String(req.params.id));
    res.json({ ok: true });
  });

  return r;
}
