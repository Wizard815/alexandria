// Biblio: the world library Alexandria hosts itself, for worlds that do not
// keep their lore in LegendKeeper, Kanka, World Anvil, Notion or Obsidian
// (or that want to leave them). See store.ts for how an article becomes a
// library page, and docs/BIBLIO.md for the API.
//
//   GET    /biblio                      the article tree this viewer may read, templates
//   GET    /biblio/articles/:id         one article (GM: the article itself; others: their copy)
//   POST   /biblio/articles             new article (GM)
//   PATCH  /biblio/articles/:id         change it (GM); { rev } refuses a stale edit
//   POST   /biblio/articles/:id/move    { parentId, position } (GM)
//   DELETE /biblio/articles/:id         to the trash, with what is under it (GM)
//   POST   /biblio/articles/:id/restore out of the trash (GM)
//   GET    /biblio/articles/:id/revisions[/:rev], POST .../:rev/restore
//   GET    /biblio/search?q=  /biblio/timeline  /biblio/templates
//   GET    /biblio/suggestions, POST /biblio/suggestions (players suggest, the GM accepts)
//   POST   /biblio/import { pageIds | sourceId } copy pages in from another source (GM)
//   GET    /biblio/export, POST /biblio/export  everything as JSON (GM)
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { HttpError, id, int, now, oneOf, str } from '../../core/util.ts';
import { dmAnd } from '../../core/events.ts';
import { ctx, isDM, me } from '../../routes/_shared.ts';
import {
  SCHEMA, SOURCE_KIND, backlinks, deleteTemplate, existingSource, exportAll, getArticle, importExport, importPages, listArticles, publish, purgeArticle,
  readerOf, republishAll, restoreArticle, restoreRevision, revision, revisions, saveArticle, saveTemplate, sourceId, templateOf, templates, timeline, trashArticle,
  type Article, type Reader,
} from './store.ts';

// Not imported from app.ts: a feature that imports app.ts at load time waits on itself (the registry loads features while app.ts loads).
const audit = (db: any, worldId: string, accountId: string | null, action: string, detail = '') => run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());
const enc = encodeURIComponent;
const S = (description: string) => ({ type: 'string', description });

const needGM = (res: any) => { if (!isDM(res)) throw new HttpError(403, 'Only the GM can change Biblio'); };
/** The GM in person: not a model working for them (it never sees classified parts) and not the broker. */
const needPerson = (res: any) => { needGM(res); if (readerOf(ctx(res).viewer) !== 'gm') throw new HttpError(403, 'Do this in the app'); };

/** What any reader may see of an article in a list. */
const brief = (a: Article) => ({ id: a.id, pageId: a.pageId, parentId: a.parentId, position: a.position, title: a.title, template: a.template, icon: a.icon, level: a.level, tags: a.tags, summary: a.summary, rev: a.rev, updatedAt: a.updatedAt });

function tree(d: Deps, worldId: string, reader: Reader, viewer: any) {
  const arts = listArticles(d, worldId);
  if (reader === 'gm') { const icons = new Map(templates(d, worldId).map((t) => [t.id, t.icon])); return arts.map((a) => ({ ...brief(a), icon: a.icon ?? icons.get(a.template) ?? null })); }
  // Everyone else: only the articles whose library page they have a copy of, and only what that copy says.
  const byPage = new Map(arts.filter((a) => a.pageId).map((a) => [a.pageId!, a]));
  const visible = (d.library.list(worldId, viewer) as any[]).filter((p) => byPage.has(p.id));
  const shown = new Set(visible.map((p) => p.id));
  return visible.map((p) => {
    const a = byPage.get(p.id)!;
    const parent = a.parentId ? arts.find((x) => x.id === a.parentId) : null;
    return {
      id: a.id, pageId: p.id, title: p.title, template: p.kind, icon: p.icon?.glyph ?? null, tags: p.tags, position: a.position, updatedAt: p.updated_at,
      // A parent this reader may not open is not named: the article shows at the top instead.
      parentId: parent?.pageId && shown.has(parent.pageId) ? parent.id : null,
      ...(reader === 'ai' ? { level: a.level } : {}),
    };
  });
}

function articleView(d: Deps, worldId: string, aid: string, viewer: any) {
  const reader = readerOf(viewer);
  const a = getArticle(d, worldId, aid);
  if (!a.pageId) throw new HttpError(404, 'Article not found');
  // The rendered copy, for every reader: the library builds it (the GM's has everything; a model's never has classified parts).
  const page = d.library.get(worldId, a.pageId, viewer) as any;
  const tpl = templateOf(d, worldId, a.template);
  const kids = listArticles(d, worldId).filter((x) => x.parentId === a.id);
  const visibleKids = reader === 'gm' ? kids : (d.library.getMany(worldId, kids.map((k) => k.pageId!).filter(Boolean), viewer) as any[]).map((p) => kids.find((k) => k.pageId === p.id)!);
  const parent = a.parentId ? (() => { try { const p = getArticle(d, worldId, a.parentId!); if (!p.pageId) return null; d.library.get(worldId, p.pageId, viewer); return { id: p.id, title: p.title }; } catch { return null; } })() : null;
  const out: any = {
    id: a.id, pageId: a.pageId, title: page.title, template: { id: tpl.id, name: tpl.name, icon: tpl.icon }, page,
    parent, children: visibleKids.map((k) => ({ id: k.id, title: k.title, icon: k.icon ?? templateOf(d, worldId, k.template).icon, template: k.template })),
    backlinks: backlinks(d, worldId, a, viewer), updatedAt: a.updatedAt,
  };
  // The GM in person gets the article as stored (for the editor); a model gets its fields from its copy only.
  if (reader === 'gm') out.article = a;
  if (reader === 'ai') { out.rev = a.rev; out.level = a.level; out.classifiedParts = a.level !== 'classified' && /\[!classified\]/i.test(a.body); }
  return out;
}

function body(req: any) {
  const b = req.body ?? {};
  return {
    title: b.title, parentId: b.parentId, position: b.position, template: b.template, icon: b.icon, cover: b.cover, summary: b.summary, tags: b.tags, aliases: b.aliases,
    fields: b.fields, level: b.level, knowledge: b.knowledge, body: b.body ?? b.markdown, append: typeof b.append === 'string' ? b.append : undefined,
    rev: b.rev === undefined || b.rev === null ? undefined : Number(b.rev), note: b.note,
  };
}

function routes(d: Deps) {
  const r = Router({ mergeParams: true });
  const W = (res: any) => ctx(res).world.id as string;
  const who = (res: any) => ({ by: me(res), reader: readerOf(ctx(res).viewer) });
  const emitTree = (worldId: string, a: Article) => d.hub.emit(worldId, 'biblio', { id: a.id }, (v) => v.role === 'dm' || a.level === 'party');

  r.get('/', (_req, res) => {
    const c = ctx(res);
    const reader = readerOf(c.viewer);
    res.json({
      articles: tree(d, W(res), reader, c.viewer), templates: templates(d, W(res)),
      canEdit: isDM(res), gm: reader === 'gm', sourceId: existingSource(d, W(res)),
      ...(reader === 'gm' ? { trash: listArticles(d, W(res), { trash: true }).length } : {}),
    });
  });
  r.get('/templates', (_req, res) => res.json(templates(d, W(res))));
  r.post('/templates', (req, res) => { needGM(res); const t = saveTemplate(d, W(res), req.body ?? {}, null); audit(d.db, W(res), me(res), 'biblio.template', `+${t.id}`); res.status(201).json(t); });
  r.put('/templates/:tid', (req, res) => {
    needGM(res);
    const t = saveTemplate(d, W(res), req.body ?? {}, String(req.params.tid));
    // The infobox of every article of this template is built from it: publish them again.
    republishAll(d, W(res), (a) => a.template === t.id);
    audit(d.db, W(res), me(res), 'biblio.template', `~${t.id}`);
    res.json(t);
  });
  r.delete('/templates/:tid', (req, res) => {
    needGM(res);
    const tid = String(req.params.tid);
    if (one(d.db, 'SELECT 1 FROM biblio_articles WHERE world_id = ? AND template = ? AND deleted_at IS NULL', W(res), tid)) throw new HttpError(409, 'Articles still use this template: change them first');
    deleteTemplate(d, W(res), tid);
    audit(d.db, W(res), me(res), 'biblio.template', `-${tid}`);
    res.json({ ok: true });
  });

  r.get('/articles/:id', (req, res) => res.json(articleView(d, W(res), String(req.params.id), ctx(res).viewer)));
  r.post('/articles', (req, res) => {
    needGM(res);
    const a = saveArticle(d, W(res), null, body(req), who(res));
    audit(d.db, W(res), me(res), 'biblio.create', `${a.id} ${a.level} ${a.title}`.slice(0, 300));
    emitTree(W(res), a);
    res.status(201).json(articleView(d, W(res), a.id, ctx(res).viewer));
  });
  r.patch('/articles/:id', (req, res) => {
    needGM(res);
    const a = saveArticle(d, W(res), String(req.params.id), body(req), who(res));
    audit(d.db, W(res), me(res), 'biblio.save', `${a.id} r${a.rev} ${a.level}`);
    emitTree(W(res), a);
    res.json(articleView(d, W(res), a.id, ctx(res).viewer));
  });
  r.post('/articles/:id/move', (req, res) => {
    needGM(res);
    const b = req.body ?? {};
    const a = saveArticle(d, W(res), String(req.params.id), { parentId: b.parentId ?? null, ...(b.position !== undefined ? { position: b.position } : {}), note: 'Moved' }, who(res));
    audit(d.db, W(res), me(res), 'biblio.move', `${a.id} -> ${a.parentId ?? 'top'}`);
    emitTree(W(res), a);
    res.json(brief(a));
  });
  r.delete('/articles/:id', (req, res) => {
    needGM(res);
    const a = getArticle(d, W(res), String(req.params.id));
    if (readerOf(ctx(res).viewer) === 'ai' && a.level === 'classified') throw new HttpError(404, 'Article not found');
    const ids = trashArticle(d, W(res), a.id);
    audit(d.db, W(res), me(res), 'biblio.trash', `${a.id} (${ids.length})`);
    emitTree(W(res), a);
    res.json({ ok: true, trashed: ids });
  });
  r.get('/trash', (_req, res) => { needPerson(res); res.json(listArticles(d, W(res), { trash: true }).map((a) => ({ ...brief(a), deletedAt: a.deletedAt }))); });
  r.post('/articles/:id/restore', (req, res) => {
    needGM(res);
    const a = restoreArticle(d, W(res), String(req.params.id));
    audit(d.db, W(res), me(res), 'biblio.restore', a.id);
    emitTree(W(res), a);
    res.json(brief(a));
  });
  r.delete('/trash/:id', (req, res) => { needPerson(res); purgeArticle(d, W(res), String(req.params.id)); audit(d.db, W(res), me(res), 'biblio.purge', String(req.params.id)); res.json({ ok: true }); });

  r.get('/articles/:id/revisions', (req, res) => { needGM(res); res.json(revisions(d, W(res), String(req.params.id))); });
  // An old version holds the whole article, classified parts too: the GM in person only.
  r.get('/articles/:id/revisions/:rev', (req, res) => { needPerson(res); res.json(revision(d, W(res), String(req.params.id), int(req.params.rev, 'rev', { min: 1 })!)); });
  r.post('/articles/:id/revisions/:rev/restore', (req, res) => {
    needGM(res);
    const a = restoreRevision(d, W(res), String(req.params.id), int(req.params.rev, 'rev', { min: 1 })!, who(res));
    audit(d.db, W(res), me(res), 'biblio.revert', `${a.id} r${req.params.rev} -> r${a.rev}`);
    emitTree(W(res), a);
    res.json(articleView(d, W(res), a.id, ctx(res).viewer));
  });

  r.get('/search', (req, res) => {
    const c = ctx(res);
    const q = str(req.query.q, 'q', { max: 200 });
    const sid = existingSource(d, W(res));
    if (!sid) return void res.json([]);
    const byPage = new Map(all<any>(d.db, 'SELECT id, page_id FROM biblio_articles WHERE world_id = ? AND deleted_at IS NULL AND page_id IS NOT NULL', W(res)).map((x) => [x.page_id, x.id]));
    const hits = (d.library.search(W(res), q, c.viewer, 50) as any[]).filter((h) => byPage.has(h.id)).map((h) => ({ ...h, articleId: byPage.get(h.id) }));
    res.json(hits);
  });
  r.get('/timeline', (_req, res) => res.json(timeline(d, W(res), ctx(res).viewer)));

  // ---- suggestions: a player (or a player's helper) proposes, the GM accepts ----
  const suggestionRows = (worldId: string, onlyFor: string | null) => all<any>(d.db, `SELECT r.*, b.id AS article_id, b.title AS article_title FROM requests r
    LEFT JOIN biblio_articles b ON b.page_id = r.page_id WHERE r.world_id = ? AND r.kind IN ('edit', 'new') AND (b.id IS NOT NULL OR r.title LIKE 'Biblio: %')
    ${onlyFor ? 'AND r.author_id = ?' : ''} ORDER BY r.created_at DESC LIMIT 200`, worldId, ...(onlyFor ? [onlyFor] : []))
    .map((x) => ({ id: x.id, kind: x.kind, articleId: x.article_id ?? null, articleTitle: x.article_title ?? null, title: String(x.title).replace(/^Biblio: /, ''), body: x.body, status: x.status, reply: x.reply, author: x.author_id, at: x.created_at }));
  r.get('/suggestions', (_req, res) => res.json(suggestionRows(W(res), isDM(res) ? null : me(res))));
  r.post('/suggestions', (req, res) => {
    const c = ctx(res);
    if (c.viewer.role !== 'player' && c.viewer.role !== 'dm') throw new HttpError(403, 'Guests cannot suggest changes');
    const b = req.body ?? {};
    const kind = oneOf(b.kind ?? (b.articleId ? 'edit' : 'new'), 'kind', ['edit', 'new'] as const);
    let pageId: string | null = null;
    let title = str(b.title, 'title', { max: 200, optional: true });
    if (kind === 'edit') {
      const a = getArticle(d, W(res), str(b.articleId, 'articleId', { max: 60 }));
      if (!a.pageId) throw new HttpError(404, 'Article not found');
      d.library.get(W(res), a.pageId, c.viewer); // only an article this reader may open
      pageId = a.pageId;
      title = title || a.title;
    } else if (!title) throw new HttpError(400, 'A new article needs a title');
    const row = { id: id('req_'), world_id: W(res), author_id: me(res), kind, page_id: pageId, title: `Biblio: ${title}`, body: str(b.body, 'body', { max: 20_000 }), visibility: 'dm', created_at: now() };
    run(d.db, 'INSERT INTO requests (id, world_id, author_id, kind, page_id, title, body, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.world_id, row.author_id, row.kind, row.page_id, row.title, row.body, row.visibility, row.created_at);
    d.hub.emit(W(res), 'request', row, dmAnd(row.author_id));
    res.status(201).json({ id: row.id, kind, title, status: 'open' });
  });
  // Accept: an edit adds the suggestion to the article (under the suggester's name) unless `body` gives the GM's own wording; a new one makes the article.
  r.post('/suggestions/:id/accept', (req, res) => {
    needPerson(res);
    const row = one<any>(d.db, 'SELECT * FROM requests WHERE id = ? AND world_id = ?', String(req.params.id), W(res));
    if (!row) throw new HttpError(404, 'Suggestion not found');
    if (row.status !== 'open') throw new HttpError(409, 'Already decided');
    const b = req.body ?? {};
    const text = typeof b.body === 'string' ? b.body : row.body;
    const author = one<any>(d.db, 'SELECT a.display_name, m.character_name FROM accounts a LEFT JOIN members m ON m.account_id = a.id AND m.world_id = ? WHERE a.id = ?', W(res), row.author_id);
    const name = author?.character_name || author?.display_name || 'a player';
    let a: Article;
    if (row.kind === 'edit') {
      const target = one<any>(d.db, 'SELECT id FROM biblio_articles WHERE world_id = ? AND page_id = ?', W(res), row.page_id);
      if (!target) throw new HttpError(409, 'The article is gone');
      a = saveArticle(d, W(res), target.id, b.replace === true ? { body: text, note: `Suggestion from ${name}` } : { append: `> [!note] From ${name}\n${String(text).split('\n').map((l) => `> ${l}`).join('\n')}`, note: `Suggestion from ${name}` }, who(res));
    } else {
      a = saveArticle(d, W(res), null, { title: String(row.title).replace(/^Biblio: /, ''), body: text, template: b.template ?? 'page', parentId: b.parentId ?? null, level: b.level ?? 'dm', note: `Suggested by ${name}` }, who(res));
    }
    run(d.db, 'UPDATE requests SET status = ?, reply = ?, decided_at = ?, decided_by = ? WHERE id = ?', 'accepted', str(b.reply, 'reply', { max: 2000, optional: true }) || null, now(), me(res), row.id);
    d.hub.emit(W(res), 'request', { ...row, status: 'accepted' }, dmAnd(row.author_id));
    audit(d.db, W(res), me(res), 'biblio.suggestion', `${row.id} accepted -> ${a.id}`);
    emitTree(W(res), a);
    res.json({ ok: true, article: brief(a) });
  });
  r.post('/suggestions/:id/reject', (req, res) => {
    needGM(res);
    const row = one<any>(d.db, 'SELECT * FROM requests WHERE id = ? AND world_id = ?', String(req.params.id), W(res));
    if (!row) throw new HttpError(404, 'Suggestion not found');
    if (row.status !== 'open') throw new HttpError(409, 'Already decided');
    run(d.db, 'UPDATE requests SET status = ?, reply = ?, decided_at = ?, decided_by = ? WHERE id = ?', 'rejected', str(req.body?.reply, 'reply', { max: 2000, optional: true }) || null, now(), me(res), row.id);
    d.hub.emit(W(res), 'request', { ...row, status: 'rejected' }, dmAnd(row.author_id));
    res.json({ ok: true });
  });

  // ---- moving in and out ----
  r.post('/import', (req, res) => {
    needPerson(res);
    const b = req.body ?? {};
    let ids: string[] = Array.isArray(b.pageIds) ? b.pageIds.map(String) : [];
    if (b.sourceId) {
      const s = one<any>(d.db, 'SELECT id, kind FROM sources WHERE world_id = ? AND id = ?', W(res), String(b.sourceId));
      if (!s) throw new HttpError(404, 'Source not found');
      if (s.kind === SOURCE_KIND) throw new HttpError(400, 'That is Biblio itself');
      ids = all<{ id: string }>(d.db, 'SELECT id FROM pages WHERE world_id = ? AND source_id = ? ORDER BY path', W(res), s.id).map((x) => x.id);
    }
    if (!ids.length) throw new HttpError(400, 'Send pageIds (a list) or a sourceId');
    if (ids.length > 5000) throw new HttpError(413, 'At most 5,000 pages at once');
    const out = importPages(d, W(res), ids, { ...who(res), parentId: b.parentId ?? null });
    audit(d.db, W(res), me(res), 'biblio.import', `${out.imported.length} copied, ${out.skipped.length} skipped`);
    if (out.imported.length) d.hub.emit(W(res), 'biblio', { imported: out.imported.length }, (v) => v.role === 'dm');
    res.json(out);
  });
  r.get('/export', (_req, res) => {
    needPerson(res);
    res.setHeader('Content-Disposition', `attachment; filename="biblio-${ctx(res).world.slug ?? 'world'}.json"`);
    res.json(exportAll(d, W(res)));
  });
  r.post('/export', (req, res) => {
    needPerson(res);
    const out = importExport(d, W(res), req.body, who(res));
    audit(d.db, W(res), me(res), 'biblio.load', `${out.articles} articles, ${out.templates} templates`);
    d.hub.emit(W(res), 'biblio', { loaded: out.articles }, (v) => v.role === 'dm');
    res.json(out);
  });
  // Publish every article to the library again (after the Biblio source was removed, or to repair).
  r.post('/republish', (_req, res) => { needPerson(res); sourceId(d, W(res)); res.json({ published: republishAll(d, W(res)) }); });
  return r;
}

const LEVEL = { type: 'string', enum: ['party', 'broker', 'gm', 'classified'], description: 'Who may read it. party: the players. broker: GM only, but the information broker may sell it. gm: the GM only (default). An AI cannot use classified.' };
const FIELDS = { type: 'object', description: 'Infobox fields by key (see biblio_templates), e.g. {"home": "[[Old Kesh]]", "member_of": "[[The Gilded Hand]]"}. Only the keys given change; an empty string clears one.', additionalProperties: { type: 'string' } };

const feature: Feature = {
  id: 'biblio',
  schema: SCHEMA,
  worldMount: 'biblio',
  worldRoutes: routes,
  // A world whose Biblio source was deleted by hand gets its pages back on the next start.
  start: (d) => {
    for (const w of all<{ world_id: string }>(d.db, `SELECT DISTINCT world_id FROM biblio_articles WHERE deleted_at IS NULL AND (page_id IS NULL OR page_id NOT IN (SELECT id FROM pages))`)) {
      try { sourceId(d, w.world_id); republishAll(d, w.world_id); } catch { /* tried again next start */ }
    }
  },
  mcpTools: [
    {
      name: 'biblio_list',
      description: "Biblio, this world's own library (articles written in Alexandria): every article you can read, as a tree (id, title, template, parentId, tags). Use biblio_read for one.",
      props: {},
      call: () => ({ method: 'GET', path: '/biblio' }),
    },
    {
      name: 'biblio_read',
      description: 'Read one Biblio article by id (from biblio_list or biblio_find): its text, infobox, parent, children and the pages that link to it.',
      props: { id: S('Article id') }, required: ['id'],
      call: (a) => ({ method: 'GET', path: `/biblio/articles/${enc(a.id)}` }),
    },
    {
      name: 'biblio_find',
      description: 'Search Biblio articles you can read by words in their title or text.',
      props: { query: S('Words to search for') }, required: ['query'],
      call: (a) => ({ method: 'GET', path: `/biblio/search?q=${enc(a.query)}` }),
    },
    {
      name: 'biblio_timeline',
      description: 'Dated Biblio articles (events, births, foundings) in world order, oldest first.',
      props: {},
      call: () => ({ method: 'GET', path: '/biblio/timeline' }),
    },
    {
      name: 'biblio_templates', dmOnly: true,
      description: 'The Biblio article templates (character, location, organisation, item, creature, people, deity, event, quest, lore, session notes, and the GM\'s own) and the infobox fields each has. GM-only fields are marked gm.',
      props: {},
      call: () => ({ method: 'GET', path: '/biblio/templates' }),
    },
    {
      name: 'biblio_write', write: true,
      description: 'Create a Biblio article (no id) or change one (id). Only the fields given change; `append` adds text to the end without replacing the rest. Write [[Article name]] to link. A > [!secret] callout is hidden from players. New articles are GM only unless level is party.',
      props: {
        id: S('Article id to change (omit to create)'), title: S('Title'), template: S('Template id, e.g. character, location, organisation, item, event (default page)'),
        parentId: S('Article id to put it under (omit for the top)'), summary: S('One line on what it is'), body: S('The whole text in Markdown (replaces the old text)'),
        append: S('Markdown to add at the end instead of replacing the text'), fields: FIELDS, tags: { type: 'array', items: { type: 'string' } }, aliases: { type: 'array', items: { type: 'string' } }, level: LEVEL,
      },
      call: (a) => {
        const { id: aid, ...rest } = a ?? {};
        return aid ? { method: 'PATCH', path: `/biblio/articles/${enc(aid)}`, body: rest } : { method: 'POST', path: '/biblio/articles', body: rest };
      },
    },
    {
      name: 'biblio_move', write: true,
      description: 'Move a Biblio article under another article (parentId), or to the top (parentId empty).',
      props: { id: S('Article id'), parentId: S('New parent article id, or empty for the top') }, required: ['id'],
      call: (a) => ({ method: 'POST', path: `/biblio/articles/${enc(a.id)}/move`, body: { parentId: a.parentId || null } }),
    },
    {
      name: 'biblio_trash', write: true,
      description: 'Move a Biblio article (and everything under it) to the trash. The GM can restore it.',
      props: { id: S('Article id') }, required: ['id'],
      call: (a) => ({ method: 'DELETE', path: `/biblio/articles/${enc(a.id)}` }),
    },
    {
      name: 'biblio_suggest', playerOnly: true,
      description: "Suggest a change to a Biblio article (articleId) or a new article (title) to the GM. It only waits for the GM's review; nothing changes until they accept it.",
      props: { articleId: S('The article to change (omit for a new article)'), title: S('Title of a new article'), body: S('What to add or change, in your own words') }, required: ['body'],
      call: (a) => ({ method: 'POST', path: '/biblio/suggestions', body: { articleId: a.articleId, title: a.title, body: a.body } }),
    },
  ],
};

void publish;
export default feature;
