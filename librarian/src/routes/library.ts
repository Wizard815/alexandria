// The library (mirror) for one world. DMs read and write everything;
// players and guests only get the player copy of shared pages ("Lore").
import { Router } from 'express';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { requireDM } from '../core/auth.ts';
import { splitFrontmatter } from '../core/frontmatter.ts';
import { HttpError, str } from '../core/util.ts';
import { safePagePath } from '../core/library.ts';
import { joinFrontmatter } from '../core/frontmatter.ts';
import { ctx, me } from './_shared.ts';
import { hybridPages } from '../features/search/embeddings.ts';
import { scopeFor } from '../features/search/global.ts';

export default function libraryRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const L = d.library;

  r.get('/pages', (_req, res) => res.json(L.list(ctx(res).world.id, ctx(res).viewer)));
  r.get('/pages/:id', (req, res) => res.json(L.get(ctx(res).world.id, String(req.params.id), ctx(res).viewer)));
  // The viewer's own copy as a Markdown file (players: the player copy only).
  r.get('/pages/:id/markdown', (req, res) => {
    const pg: any = L.get(ctx(res).world.id, String(req.params.id), ctx(res).viewer);
    const fm: Record<string, any> = { title: pg.title };
    if (pg.tags?.length) fm.tags = pg.tags;
    if (pg.aliases?.length) fm.aliases = pg.aliases;
    if (pg.source) fm.source = pg.source;
    if (ctx(res).viewer.role === 'dm') fm.visibility = pg.visibility;
    fm.downloaded = new Date().toISOString().slice(0, 10);
    const name = String(pg.title).replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 80) || 'page';
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}.md"; filename*=UTF-8''${encodeURIComponent(name)}.md`);
    res.send(joinFrontmatter(fm, pg.body ?? ''));
  });

  // Several pages at once, for saving a folder offline. Pages the viewer
  // may not open are left out, not reported.
  r.post('/pages/bulk', (req, res) => {
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || ids.length > 500 || ids.some((x) => typeof x !== 'string')) throw new HttpError(400, 'ids must be a list of up to 500 page ids');
    const out: any[] = [];
    for (const pid of ids as string[]) {
      try { out.push(L.get(ctx(res).world.id, pid, ctx(res).viewer)); } catch { /* not visible or gone */ }
    }
    res.json(out);
  });
  // Ranked page search with <mark> snippets. ?semantic=1 also merges nearest-meaning matches when an embeddings model is set.
  r.get('/search', async (req, res) => {
    const c = ctx(res);
    const q = str(req.query.q, 'q', { max: 200 });
    if (req.query.semantic === '1') return void res.json(await hybridPages(d, c.world.id, q, scopeFor(c.viewer), 20));
    res.json(L.search(c.world.id, q, c.viewer));
  });
  // DM: shared pages that look like they contain DM notes written as prose.
  r.get('/lint', requireDM, (_req, res) => res.json(L.lint(ctx(res).world.id)));
  r.get('/relations', (_req, res) => res.json(L.relations(ctx(res).world.id, ctx(res).viewer)));

  // Write a page: either { markdown } with frontmatter in it, or
  // { body, frontmatter, title, visibility }.
  r.put('/pages', requireDM, (req, res) => {
    const c = ctx(res);
    const b = req.body ?? {};
    let fm = b.frontmatter && typeof b.frontmatter === 'object' ? b.frontmatter : {};
    let body = typeof b.body === 'string' ? b.body : '';
    if (typeof b.markdown === 'string') ({ fm, body } = splitFrontmatter(b.markdown));
    // A model never saw classified text, so what it writes must not replace a page that holds some.
    const target = typeof b.path === 'string' ? safePagePath(b.path) : '';
    if (c.viewer.audience === 'ai' && target && L.hasClassified(c.world.id, target)) throw new HttpError(409, 'This page holds classified content that no AI can see. Edit it in the app.');
    const saved = L.save(c.world.id, { path: str(b.path, 'path', { max: 300 }), title: b.title, body, frontmatter: fm, visibility: b.visibility ?? fm.visibility }, me(res));
    audit(d.db, c.world.id, me(res), 'page.save', `${saved.path} ${saved.visibility}`);
    d.hub.emit(c.world.id, 'page', { id: saved.id, path: saved.path, title: saved.title }, (v) => v.role === 'dm' || saved.visibility === 'party');
    res.json(saved);
  });

  // Set a page's level: party, broker, dm or classified (Alexandria's own pages).
  r.put('/pages/:id/level', requireDM, (req, res) => {
    const c = ctx(res);
    if (c.viewer.audience === 'ai') throw new HttpError(403, 'Levels are set in the app');
    const saved = L.setLevel(c.world.id, String(req.params.id), req.body?.level, me(res));
    audit(d.db, c.world.id, me(res), 'page.level', `${saved.path} ${saved.visibility}`);
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
