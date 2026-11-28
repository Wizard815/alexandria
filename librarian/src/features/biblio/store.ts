// Biblio: the world library Alexandria hosts itself. The articles live here
// (biblio_articles, with every earlier version in biblio_revisions), and each
// save publishes the article into the library as a page of the world's own
// "Biblio" source. So the leak guard, the player, broker and AI copies, search,
// embeddings, the story bible, the Relations page and every agent tool see a
// Biblio article exactly like a page imported from LegendKeeper or Kanka,
// with nothing to sync.
//
// Players never read biblio_articles: everything they get comes from their
// library copy of the page. The GM (a person, not a model) reads and edits the
// article itself. A model working for the GM gets the AI copy and may not
// touch a classified article or one with classified parts (it never saw them).
import type { Deps } from '../../app.ts';
import { all, one, run, tx } from '../../core/db.ts';
import { HttpError, id, now, parseJson } from '../../core/util.ts';
import { audienceOf, type Viewer } from '../../core/policy.ts';
import { type Level, canSeeLevel, isLevel, normLevel } from '../../core/levels.ts';
import type { Entry, Inline, PropertyGroup, PropertyRow } from '../../intake/model.ts';
import { blocksToMarkdown, inlineText, markdownToBlocks } from '../../intake/model.ts';
import { BUILTIN_TEMPLATES, REL_FIELDS, cleanTemplate, type Template, type TemplateField } from './templates.ts';

export const SOURCE_KIND = 'biblio';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS biblio_articles (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  parent_id TEXT,
  position REAL,
  title TEXT NOT NULL,
  template TEXT NOT NULL DEFAULT 'page',
  icon TEXT,
  cover TEXT,
  summary TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  aliases TEXT NOT NULL DEFAULT '[]',
  fields TEXT NOT NULL DEFAULT '{}',
  level TEXT NOT NULL DEFAULT 'gm',
  knowledge TEXT,
  body TEXT NOT NULL DEFAULT '',
  page_id TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  deleted_at TEXT,
  imported_from TEXT
);
CREATE INDEX IF NOT EXISTS biblio_articles_world ON biblio_articles (world_id, parent_id);
CREATE TABLE IF NOT EXISTS biblio_revisions (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES biblio_articles(id) ON DELETE CASCADE,
  world_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  by_id TEXT,
  by_kind TEXT NOT NULL DEFAULT 'gm',
  at TEXT NOT NULL,
  UNIQUE (article_id, rev)
);
CREATE TABLE IF NOT EXISTS biblio_templates (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (world_id, id)
);
`;

/** How many versions of an article are kept (the oldest go first). */
export const MAX_REVISIONS = 200;
const MAX_BODY = 1_000_000;

export interface Article {
  id: string; parentId: string | null; position: number | null; title: string; template: string; icon: string | null; cover: string | null;
  summary: string; tags: string[]; aliases: string[]; fields: Record<string, string>; level: Level; knowledge: 'common' | 'local' | 'deep' | null;
  body: string; pageId: string | null; rev: number; createdAt: string; createdBy: string | null; updatedAt: string; updatedBy: string | null;
  deletedAt: string | null; importedFrom: string | null;
}

const shape = (r: any): Article => ({
  id: r.id, parentId: r.parent_id ?? null, position: r.position ?? null, title: r.title, template: r.template, icon: r.icon ?? null, cover: r.cover ?? null,
  summary: r.summary ?? '', tags: parseJson(r.tags, []), aliases: parseJson(r.aliases, []), fields: parseJson(r.fields, {}), level: normLevel(r.level),
  knowledge: r.knowledge ?? null, body: r.body ?? '', pageId: r.page_id ?? null, rev: r.rev, createdAt: r.created_at, createdBy: r.created_by ?? null,
  updatedAt: r.updated_at, updatedBy: r.updated_by ?? null, deletedAt: r.deleted_at ?? null, importedFrom: r.imported_from ?? null,
});

// ---- the world's Biblio source ------------------------------------------------

/** The world's Biblio source row (made the first time). Its pages are published by Biblio only: it has no connector, so nothing syncs it. */
export function sourceId(d: Deps, worldId: string): string {
  const s = one<{ id: string }>(d.db, 'SELECT id FROM sources WHERE world_id = ? AND kind = ?', worldId, SOURCE_KIND);
  if (s) return s.id;
  const sid = id('src_');
  run(d.db, `INSERT INTO sources (id, world_id, kind, name, config, default_visibility, audience) VALUES (?, ?, ?, 'Biblio', '{}', 'gm', 'auto')`, sid, worldId, SOURCE_KIND);
  return sid;
}

export const existingSource = (d: Deps, worldId: string): string | null =>
  one<{ id: string }>(d.db, 'SELECT id FROM sources WHERE world_id = ? AND kind = ?', worldId, SOURCE_KIND)?.id ?? null;

// ---- templates -----------------------------------------------------------------

export function templates(d: Deps, worldId: string): Template[] {
  const own = all<{ data: string }>(d.db, 'SELECT data FROM biblio_templates WHERE world_id = ? ORDER BY id', worldId).map((r) => parseJson<Template | null>(r.data, null)).filter((t): t is Template => !!t);
  return [...BUILTIN_TEMPLATES.map((t) => ({ ...t, builtin: true })), ...own];
}

export function templateOf(d: Deps, worldId: string, tid: string): Template {
  return templates(d, worldId).find((t) => t.id === tid) ?? BUILTIN_TEMPLATES[0];
}

export function saveTemplate(d: Deps, worldId: string, raw: any, replace: string | null): Template {
  const taken = new Set(all<{ id: string }>(d.db, 'SELECT id FROM biblio_templates WHERE world_id = ?', worldId).map((r) => r.id));
  if (replace) taken.delete(replace);
  const t = cleanTemplate(replace ? { ...raw, id: replace } : raw, taken);
  if (replace && !one(d.db, 'SELECT 1 FROM biblio_templates WHERE world_id = ? AND id = ?', worldId, replace)) throw new HttpError(404, 'No such template of yours');
  run(d.db, `INSERT INTO biblio_templates (world_id, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (world_id, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, worldId, t.id, JSON.stringify(t), now());
  return t;
}

export function deleteTemplate(d: Deps, worldId: string, tid: string) {
  if (BUILTIN_TEMPLATES.some((t) => t.id === tid)) throw new HttpError(409, 'Built-in templates cannot be deleted');
  if (!run(d.db, 'DELETE FROM biblio_templates WHERE world_id = ? AND id = ?', worldId, tid)) throw new HttpError(404, 'No such template of yours');
}

// ---- reading -------------------------------------------------------------------

export function getArticle(d: Deps, worldId: string, aid: string, opts: { trash?: boolean } = {}): Article {
  const r = one<any>(d.db, 'SELECT * FROM biblio_articles WHERE world_id = ? AND (id = ? OR page_id = ?)', worldId, aid, aid);
  if (!r || (r.deleted_at && !opts.trash)) throw new HttpError(404, 'Article not found');
  return shape(r);
}

export function listArticles(d: Deps, worldId: string, opts: { trash?: boolean } = {}): Article[] {
  return all<any>(d.db, `SELECT * FROM biblio_articles WHERE world_id = ? AND deleted_at IS ${opts.trash ? 'NOT NULL' : 'NULL'} ORDER BY position IS NULL, position, title COLLATE NOCASE`, worldId).map(shape);
}

/** Does the article hold anything no model may see (a classified level, a classified callout or marker)? */
export function holdsClassified(a: Pick<Article, 'level' | 'body' | 'tags'>): boolean {
  if (a.level === 'classified') return true;
  if (a.tags.some((t) => /^classified$/i.test(t))) return true;
  return /\[!classified\]|<!--\s*classified\s*-->|(^|\s)#classified\b|^#{1,6}\s+classified\b/im.test(a.body);
}

/** Who is asking: the GM in person, a model working for the GM, or anyone else (players, guests, the broker). */
export type Reader = 'gm' | 'ai' | 'other';
export const readerOf = (v: Viewer): Reader => (v.role !== 'gm' ? 'other' : audienceOf(v) === 'gm' ? 'gm' : audienceOf(v) === 'ai' ? 'ai' : 'other');

// ---- writing -------------------------------------------------------------------

export interface ArticleInput {
  title?: string; parentId?: string | null; position?: number | null; template?: string; icon?: string | null; cover?: string | null; summary?: string;
  tags?: string[]; aliases?: string[]; fields?: Record<string, unknown>; level?: string; knowledge?: string | null; body?: string;
  /** Add this Markdown to the end of the body instead of replacing it. */
  append?: string;
  /** The rev the writer last read: a newer one on the server is a 409 (someone else saved in between). */
  rev?: number;
  note?: string;
}

const cleanList = (v: unknown, max: number): string[] => {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return [...new Set(raw.map((x) => String(x ?? '').trim().replace(/^#/, '')).filter(Boolean).map((x) => x.slice(0, 80)))].slice(0, max);
};

const safeCover = (v: unknown): string | null => {
  const t = String(v ?? '').trim();
  if (!t) return null;
  if (/^https?:\/\/\S+$/i.test(t) && t.length <= 2048) return t;
  if (/^\/api\/[\w\-./%?=&]+$/.test(t) && t.length <= 2048) return t;
  throw new HttpError(400, 'cover must be an https address or a picture held by Alexandria');
};

function cleanFields(raw: unknown, tpl: Template, prev: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...prev };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const keys = new Map(tpl.fields.map((f) => [f.key, f]));
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // A field the template does not have is kept too (a template can change later), as long as its name is sane.
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) continue;
    const f = keys.get(k);
    if (v === null || v === undefined || String(v).trim() === '') { delete out[k]; continue; }
    let s = Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
    s = s.slice(0, f?.type === 'long' ? 8000 : 1000);
    if (f?.type === 'yesno') s = /^(y|yes|true|1|on)$/i.test(s.trim()) ? 'yes' : 'no';
    out[k] = s;
  }
  return out;
}

/** The parent must be an article of this world, not the article itself or one under it. */
function checkParent(d: Deps, worldId: string, aid: string | null, parentId: string | null) {
  if (!parentId) return;
  let p: string | null = parentId;
  for (let i = 0; p && i < 64; i++) {
    if (p === aid) throw new HttpError(400, 'An article cannot sit inside itself');
    const row: { parent_id: string | null; deleted_at: string | null } | undefined = one<any>(d.db, 'SELECT parent_id, deleted_at FROM biblio_articles WHERE world_id = ? AND id = ?', worldId, p);
    if (!row) throw new HttpError(400, 'The parent article does not exist');
    if (row.deleted_at) throw new HttpError(400, 'The parent article is in the trash');
    p = row.parent_id;
  }
}

export interface SaveCtx { by: string | null; reader: Reader }

/** Create (no id) or change an article, keep the old version, and publish it to the library. */
export function saveArticle(d: Deps, worldId: string, aid: string | null, input: ArticleInput, c: SaveCtx, opts: { batch?: boolean } = {}): Article {
  const prev = aid ? getArticle(d, worldId, aid) : null;
  if (prev && input.rev !== undefined && input.rev !== null && Number(input.rev) !== prev.rev) {
    throw new HttpError(409, `This article changed since you opened it (now version ${prev.rev}). Reload it and make your change again.`);
  }
  if (c.reader === 'ai' && prev && holdsClassified(prev)) throw new HttpError(409, 'This article holds classified parts no AI can see. Edit it in the app.');
  const template = input.template !== undefined ? String(input.template) : prev?.template ?? 'page';
  const tpl = templates(d, worldId).find((t) => t.id === template);
  if (!tpl) throw new HttpError(400, `No template "${template}". See GET /biblio/templates.`);
  const title = (input.title !== undefined ? String(input.title) : prev?.title ?? '').trim().replace(/[\x00-\x1f]+/g, ' ').slice(0, 200);
  if (!title) throw new HttpError(400, 'An article needs a title');
  let body = input.body !== undefined ? String(input.body ?? '') : prev?.body ?? '';
  if (input.append) body = body.trimEnd() + (body.trim() ? '\n\n' : '') + String(input.append);
  if (body.length > MAX_BODY) throw new HttpError(413, 'Article too long');
  const levelRaw = input.level !== undefined ? String(input.level).toLowerCase() : prev?.level ?? 'gm';
  const level: Level = isLevel(levelRaw) ? levelRaw : levelRaw === 'dm' ? 'gm' : (() => { throw new HttpError(400, 'level must be party, broker, gm or classified'); })();
  const knowledge = input.knowledge !== undefined ? (['common', 'local', 'deep'].includes(String(input.knowledge)) ? input.knowledge as Article['knowledge'] : null) : prev?.knowledge ?? null;
  const parentId = input.parentId !== undefined ? (input.parentId ? String(input.parentId) : null) : prev?.parentId ?? null;
  checkParent(d, worldId, prev?.id ?? null, parentId);
  const next = {
    title, template, parentId, body, level, knowledge,
    position: input.position !== undefined ? (Number.isFinite(Number(input.position)) && input.position !== null ? Number(input.position) : null) : prev?.position ?? null,
    icon: input.icon !== undefined ? (/^fa-[a-z0-9-]{1,40}$/.test(String(input.icon ?? '')) ? String(input.icon) : null) : prev?.icon ?? null,
    cover: input.cover !== undefined ? safeCover(input.cover) : prev?.cover ?? null,
    summary: (input.summary !== undefined ? String(input.summary ?? '') : prev?.summary ?? '').slice(0, 500),
    tags: input.tags !== undefined ? cleanList(input.tags, 50) : prev?.tags ?? [],
    aliases: input.aliases !== undefined ? cleanList(input.aliases, 30) : prev?.aliases ?? [],
    fields: cleanFields(input.fields, tpl, prev?.fields ?? {}),
  };
  // What a model writes must not make an article classified either: it could not read it back.
  if (c.reader === 'ai' && holdsClassified(next)) throw new HttpError(400, 'An AI cannot write classified articles or classified parts');
  const at = now();
  const aid2 = prev?.id ?? id('ba_');
  const rev = (prev?.rev ?? 0) + 1;
  tx(d.db, () => {
    const cols = [next.parentId, next.position, next.title, next.template, next.icon, next.cover, next.summary, JSON.stringify(next.tags), JSON.stringify(next.aliases),
      JSON.stringify(next.fields), next.level, next.knowledge, next.body, rev, at, c.by];
    if (prev) {
      run(d.db, `UPDATE biblio_articles SET parent_id = ?, position = ?, title = ?, template = ?, icon = ?, cover = ?, summary = ?, tags = ?, aliases = ?, fields = ?, level = ?, knowledge = ?, body = ?,
        rev = ?, updated_at = ?, updated_by = ? WHERE id = ?`, ...cols, aid2);
    } else {
      run(d.db, `INSERT INTO biblio_articles (parent_id, position, title, template, icon, cover, summary, tags, aliases, fields, level, knowledge, body, rev, updated_at, updated_by, id, world_id, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...cols, aid2, worldId, at, c.by);
    }
    keepRevision(d, worldId, aid2, rev, c, String(input.note ?? (prev ? '' : 'Created')).slice(0, 200));
  });
  const saved = getArticle(d, worldId, aid2);
  publish(d, worldId, saved, { batch: opts.batch, linksChanged: !prev || prev.title !== saved.title || prev.level !== saved.level || prev.aliases.join('|') !== saved.aliases.join('|') });
  return getArticle(d, worldId, aid2);
}

function keepRevision(d: Deps, worldId: string, aid: string, rev: number, c: SaveCtx, note: string) {
  const r = one<any>(d.db, 'SELECT * FROM biblio_articles WHERE id = ?', aid);
  const a = shape(r);
  const snap = { title: a.title, parentId: a.parentId, position: a.position, template: a.template, icon: a.icon, cover: a.cover, summary: a.summary, tags: a.tags, aliases: a.aliases, fields: a.fields, level: a.level, knowledge: a.knowledge, body: a.body };
  run(d.db, 'INSERT INTO biblio_revisions (id, article_id, world_id, rev, snapshot, note, by_id, by_kind, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id('brv_'), aid, worldId, rev, JSON.stringify(snap), note, c.by, c.reader === 'ai' ? 'ai' : 'gm', now());
  run(d.db, `DELETE FROM biblio_revisions WHERE article_id = ? AND rev <= (SELECT MAX(rev) FROM biblio_revisions WHERE article_id = ?) - ?`, aid, aid, MAX_REVISIONS);
}

export function revisions(d: Deps, worldId: string, aid: string) {
  const a = getArticle(d, worldId, aid, { trash: true });
  return all<any>(d.db, 'SELECT rev, note, by_id, by_kind, at, length(snapshot) AS size FROM biblio_revisions WHERE article_id = ? ORDER BY rev DESC', a.id)
    .map((r) => ({ rev: r.rev, note: r.note, by: r.by_id ?? null, byKind: r.by_kind, at: r.at, size: r.size }));
}

export function revision(d: Deps, worldId: string, aid: string, rev: number) {
  const a = getArticle(d, worldId, aid, { trash: true });
  const r = one<any>(d.db, 'SELECT * FROM biblio_revisions WHERE article_id = ? AND rev = ?', a.id, rev);
  if (!r) throw new HttpError(404, 'No such version');
  return { rev: r.rev, note: r.note, by: r.by_id ?? null, byKind: r.by_kind, at: r.at, article: JSON.parse(r.snapshot) };
}

/** Make an old version the newest one (the versions after it are kept). */
export function restoreRevision(d: Deps, worldId: string, aid: string, rev: number, c: SaveCtx): Article {
  const old = revision(d, worldId, aid, rev).article;
  const parentOk = !old.parentId || !!one(d.db, 'SELECT 1 FROM biblio_articles WHERE world_id = ? AND id = ? AND deleted_at IS NULL', worldId, old.parentId);
  return saveArticle(d, worldId, aid, { ...old, parentId: parentOk ? old.parentId : null, note: `Restored version ${rev}` }, c);
}

// ---- trash ---------------------------------------------------------------------

/** Into the trash, with everything under it. Their library pages go; the articles and their versions stay until emptied. */
export function trashArticle(d: Deps, worldId: string, aid: string): string[] {
  const root = getArticle(d, worldId, aid);
  const ids = [root.id, ...descendants(d, worldId, root.id)];
  const at = now();
  for (const x of ids) {
    const a = getArticle(d, worldId, x, { trash: true });
    if (a.deletedAt) continue;
    run(d.db, 'UPDATE biblio_articles SET deleted_at = ? WHERE id = ?', at, x);
    if (a.pageId && one(d.db, 'SELECT 1 FROM pages WHERE id = ?', a.pageId)) d.library.remove(worldId, a.pageId);
    run(d.db, 'UPDATE biblio_articles SET page_id = NULL WHERE id = ?', x);
  }
  return ids;
}

/** Out of the trash: the article (and what was trashed with it) is published again. */
export function restoreArticle(d: Deps, worldId: string, aid: string): Article {
  const a = getArticle(d, worldId, aid, { trash: true });
  if (!a.deletedAt) return a;
  const parentGone = a.parentId && !one(d.db, 'SELECT 1 FROM biblio_articles WHERE world_id = ? AND id = ? AND deleted_at IS NULL', worldId, a.parentId);
  const batch = all<{ id: string }>(d.db, 'SELECT id FROM biblio_articles WHERE world_id = ? AND deleted_at = ?', worldId, a.deletedAt).map((r) => r.id);
  for (const x of batch) run(d.db, 'UPDATE biblio_articles SET deleted_at = NULL WHERE id = ?', x);
  if (parentGone) run(d.db, 'UPDATE biblio_articles SET parent_id = NULL WHERE id = ?', a.id);
  // Parents first, so each child's library page finds its parent.
  for (const x of topoOrder(d, worldId, batch)) publish(d, worldId, getArticle(d, worldId, x), { linksChanged: true, batch: true });
  d.library.rebuildPlayerCopies(worldId);
  return getArticle(d, worldId, a.id);
}

/** For good: the article and its versions. Only from the trash. */
export function purgeArticle(d: Deps, worldId: string, aid: string) {
  const a = getArticle(d, worldId, aid, { trash: true });
  if (!a.deletedAt) throw new HttpError(409, 'Move it to the trash first');
  run(d.db, 'DELETE FROM biblio_articles WHERE id = ?', a.id);
  // Children trashed with it lose their parent; they stay in the trash on their own.
  run(d.db, 'UPDATE biblio_articles SET parent_id = NULL WHERE world_id = ? AND parent_id = ?', worldId, a.id);
}

function descendants(d: Deps, worldId: string, aid: string): string[] {
  const out: string[] = [];
  let frontier = [aid];
  for (let depth = 0; frontier.length && depth < 64; depth++) {
    const next = all<{ id: string }>(d.db, `SELECT id FROM biblio_articles WHERE world_id = ? AND deleted_at IS NULL AND parent_id IN (${frontier.map(() => '?').join(',')})`, worldId, ...frontier).map((r) => r.id);
    out.push(...next);
    frontier = next;
  }
  return out;
}

function topoOrder(d: Deps, worldId: string, ids: string[]): string[] {
  const set = new Set(ids);
  const depth = (x: string) => { let n = 0; let p = one<any>(d.db, 'SELECT parent_id FROM biblio_articles WHERE id = ?', x)?.parent_id; while (p && set.has(p) && n < 64) { n++; p = one<any>(d.db, 'SELECT parent_id FROM biblio_articles WHERE id = ?', p)?.parent_id; } return n; };
  return [...ids].sort((a, b) => depth(a) - depth(b));
}

// ---- publishing into the library -----------------------------------------------

/** An infobox value as inline text: [[links]] become mentions the library resolves (and hides, when the target is hidden). */
function valueInline(v: string): Inline[] {
  const blocks = markdownToBlocks(v);
  const parts: Inline[] = [];
  for (const b of blocks) {
    if (b.kind !== 'paragraph') { const t = blocksToMarkdown([b]); if (t.trim()) parts.push({ text: (parts.length ? ' ' : '') + t }); continue; }
    if (parts.length) parts.push({ text: ' ' });
    parts.push(...b.content);
  }
  return parts.length ? parts : [{ text: v }];
}

/** [[Name]] for each name in a link field ("Odda, [[Brother Tamsin]]" -> two links). */
export function linkNames(v: string): string[] {
  const wiki = [...v.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1].trim());
  return wiki.length ? wiki : v.split(/\s*[,;]\s*/).map((x) => x.trim()).filter(Boolean);
}

function fieldValue(f: TemplateField | undefined, v: string): string {
  if (f && (f.type === 'link' || f.type === 'links')) return linkNames(v).map((n) => `[[${n}]]`).join(', ');
  if (f?.type === 'yesno') return v === 'yes' ? 'Yes' : 'No';
  return v;
}

/** The infobox: shared fields, then GM-only fields in a group players never get. Fields the template no longer has come last. */
export function infobox(tpl: Template, fields: Record<string, string>): PropertyGroup[] {
  const shared: PropertyRow[] = [];
  const secret: PropertyRow[] = [];
  const known = new Set(tpl.fields.map((f) => f.key));
  for (const f of tpl.fields) {
    const v = fields[f.key];
    if (v === undefined || v === '') continue;
    (f.gm ? secret : shared).push({ key: f.label, value: valueInline(fieldValue(f, v)) });
  }
  // Fields from an earlier template stay GM only: nobody chose to share them under this one.
  for (const [k, v] of Object.entries(fields)) if (!known.has(k) && v) secret.push({ key: k.replace(/_/g, ' '), value: valueInline(v) });
  return [...(shared.length ? [{ title: tpl.name, rows: shared }] : []), ...(secret.length ? [{ title: 'GM only', gm: true, rows: secret }] : [])];
}

/** Frontmatter for the library: tags, aliases, and relations from link fields (GM-only fields under secret:, which never reaches players). */
function frontmatterOf(a: Article, tpl: Template): Record<string, any> {
  const fm: Record<string, any> = { title: a.title };
  if (a.tags.length) fm.tags = a.tags;
  if (a.aliases.length) fm.aliases = a.aliases;
  if (a.summary) fm.summary = a.summary;
  const secret: Record<string, string[]> = {};
  for (const f of tpl.fields) {
    const v = a.fields[f.key];
    const rel = f.rel && REL_FIELDS.has(f.rel) ? f.rel : null;
    if (!rel || !v) continue;
    const links = linkNames(v).map((n) => `[[${n}]]`);
    if (f.gm) secret[rel] = [...(secret[rel] ?? []), ...links];
    else fm[rel] = [...(fm[rel] ?? []), ...links];
  }
  if (Object.keys(secret).length) fm.secret = secret;
  return fm;
}

function folderOf(d: Deps, worldId: string, a: Article): string[] {
  const out: string[] = [];
  let p = a.parentId;
  for (let i = 0; p && i < 64; i++) {
    const r = one<any>(d.db, 'SELECT title, parent_id FROM biblio_articles WHERE world_id = ? AND id = ?', worldId, p);
    if (!r) break;
    out.unshift(String(r.title));
    p = r.parent_id;
  }
  return out;
}

/** The article as the entry a connector would give, so the library treats it like any other source's page. */
export function entryOf(d: Deps, worldId: string, a: Article): Entry {
  const tpl = templateOf(d, worldId, a.template);
  const summary = a.summary ? `${a.summary}\n\n` : '';
  return {
    externalId: a.id, parentExternalId: a.parentId, folder: folderOf(d, worldId, a), title: a.title, aliases: a.aliases, tags: a.tags,
    type: tpl.id, icon: { glyph: a.icon ?? tpl.icon }, banner: a.cover, properties: infobox(tpl, a.fields),
    blocks: [], markdown: summary + a.body, frontmatter: frontmatterOf(a, tpl),
    visibility: a.level, level: a.level, knowledge: a.knowledge, position: a.position, updatedAt: a.updatedAt, sourceShared: a.level === 'party',
  };
}

/** Write the article's library page (and rebuild what it changes). `batch`: the caller rebuilds the copies once at the end. */
export function publish(d: Deps, worldId: string, a: Article, opts: { linksChanged?: boolean; batch?: boolean } = {}) {
  const sid = sourceId(d, worldId);
  const out = d.library.saveEntry(worldId, sid, null, entryOf(d, worldId, a), a.updatedBy);
  if (out.id !== a.pageId) run(d.db, 'UPDATE biblio_articles SET page_id = ? WHERE id = ?', out.id, a.id);
  // A child's folder carries its parents' titles: a renamed or moved article moves its children's folders too.
  if (opts.linksChanged) for (const kid of descendants(d, worldId, a.id)) {
    const k = getArticle(d, worldId, kid);
    const o = d.library.saveEntry(worldId, sid, null, entryOf(d, worldId, k), k.updatedBy);
    if (o.id !== k.pageId) run(d.db, 'UPDATE biblio_articles SET page_id = ? WHERE id = ?', o.id, k.id);
  }
  run(d.db, 'UPDATE sources SET last_sync_at = ?, last_status = ? WHERE id = ?', now(), 'Biblio: saved in Alexandria', sid);
  if (!opts.batch) d.library.rebuildPlayerCopies(worldId, opts.linksChanged ? undefined : [out.id]);
  d.hub.emit(worldId, 'page', { id: out.id, title: a.title, source: sid }, (v) => v.role === 'gm' || a.level === 'party');
  return out.id;
}

/** Publish every article again (the source was deleted, or a template changed). */
export function republishAll(d: Deps, worldId: string, only?: (a: Article) => boolean): number {
  const list = listArticles(d, worldId).filter((a) => !only || only(a));
  for (const x of topoOrder(d, worldId, list.map((a) => a.id))) publish(d, worldId, getArticle(d, worldId, x), { batch: true });
  if (list.length) d.library.rebuildPlayerCopies(worldId);
  return list.length;
}

// ---- links, backlinks, timeline ---------------------------------------------------

/** Pages (any source) whose copy for this viewer links to the article by its title or an alias. Only pages the viewer may open. */
export function backlinks(d: Deps, worldId: string, a: Article, viewer: Viewer): { id: string; title: string; articleId: string | null }[] {
  const aud = audienceOf(viewer);
  const col = aud === 'gm' ? 'p.body' : aud === 'ai' ? 'p.ai_body' : aud === 'broker' ? 'p.broker_body' : 'p.player_body';
  const names = [a.title, ...a.aliases].map((n) => n.toLowerCase());
  const like = names.map(() => `lower(${col}) LIKE ?`).join(' OR ');
  const rows = all<any>(d.db, `SELECT p.id, p.title, p.visibility, ${col} AS text, b.id AS article_id FROM pages p LEFT JOIN biblio_articles b ON b.page_id = p.id
    WHERE p.world_id = ? AND ${col} IS NOT NULL AND p.id IS NOT ? AND (${like}) ORDER BY p.title COLLATE NOCASE LIMIT 200`, worldId, a.pageId, ...names.map((n) => `%[[${n}%`));
  const re = new RegExp(`\\[\\[\\s*(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*(\\||#|\\]\\])`, 'i');
  return rows.filter((r) => canSeeLevel(normLevel(r.visibility), aud) && re.test(String(r.text))).map((r) => ({ id: r.id, title: r.title, articleId: r.article_id ?? null }));
}

/** The first whole number in an in-world date sorts it ("3 Frostfall 1042 AR" -> 1042, "-300" -> -300). Null: no number, kept last. */
export function dateSort(s: string): number | null {
  const years = [...s.matchAll(/(^|[^\d-])(-?\d{1,7})(?!\d)/g)].map((m) => Number(m[2]));
  if (!years.length) return null;
  // The largest number is the year more often than not ("3 Frostfall 1042" -> 1042); negative years stay negative.
  const neg = years.find((y) => y < 0);
  const year = neg ?? Math.max(...years);
  // "212 BC", "212 BCE", "212 BR" (before the reckoning): before year 0.
  return year > 0 && /\b(BC|BCE|B\.C\.|BR)\b/i.test(s) ? -year : year;
}

export interface TimelineEntry { articleId: string; pageId: string | null; title: string; template: string; label: string; when: string; sort: number | null }

/**
 * Every date in the articles this viewer may read, oldest first. The GM reads the articles; anyone else reads the dates
 * from their own copy's infobox, so a GM-only date (or a link to a hidden page inside one) never shows.
 */
export function timeline(d: Deps, worldId: string, viewer: Viewer): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const reader = readerOf(viewer);
  const arts = listArticles(d, worldId);
  const tpls = new Map(templates(d, worldId).map((t) => [t.id, t]));
  if (reader === 'gm') {
    for (const a of arts) for (const f of tpls.get(a.template)?.fields ?? []) {
      const v = a.fields[f.key];
      if (f.type === 'date' && v) out.push({ articleId: a.id, pageId: a.pageId, title: a.title, template: a.template, label: f.label, when: v, sort: dateSort(v) });
    }
  } else {
    const byPage = new Map(arts.filter((a) => a.pageId).map((a) => [a.pageId!, a]));
    const pages = d.library.getMany(worldId, [...byPage.keys()], viewer) as any[];
    for (const pg of pages) {
      const a = byPage.get(pg.id)!;
      const dateLabels = new Set((tpls.get(a.template)?.fields ?? []).filter((f) => f.type === 'date' && !f.gm).map((f) => f.label));
      for (const g of (pg.properties ?? []) as PropertyGroup[]) for (const r of g.rows) {
        if (!dateLabels.has(r.key)) continue;
        const v = inlineText(r.value).trim();
        if (v) out.push({ articleId: a.id, pageId: pg.id, title: pg.title, template: a.template, label: r.key, when: v, sort: dateSort(v) });
      }
    }
  }
  return out.sort((x, y) => (x.sort ?? Infinity) - (y.sort ?? Infinity) || x.title.localeCompare(y.title));
}

// ---- copying pages in from other sources ----------------------------------------------

/**
 * Copy library pages (from LegendKeeper, Kanka, World Anvil, Markdown or anywhere) into Biblio, so the world can leave that app.
 * The GM's full copy is used: secret blocks stay secret callouts, GM-only infobox groups go to the GM-only part. Pages copied
 * together keep their parent and child places. The originals are left alone.
 */
export function importPages(d: Deps, worldId: string, pageIds: string[], c: SaveCtx & { parentId?: string | null }): { imported: { pageId: string; articleId: string; title: string }[]; skipped: { pageId: string; why: string }[] } {
  if (c.reader !== 'gm') throw new HttpError(403, 'Only the GM, in the app, can copy pages into Biblio');
  const bib = existingSource(d, worldId);
  const rows = pageIds.map((pid) => one<any>(d.db, 'SELECT * FROM pages WHERE world_id = ? AND id = ?', worldId, pid));
  const skipped: { pageId: string; why: string }[] = [];
  const done = new Map<string, string>(); // `${source_id}|${external_id}` -> article id
  const imported: { pageId: string; articleId: string; title: string }[] = [];
  const R = d.library.resolver(worldId);
  const tplIds = new Set(templates(d, worldId).map((t) => t.id));
  // Parents before children (a page whose parent is in the batch waits for it).
  const pending = rows.map((r, i) => r ?? { missing: pageIds[i] });
  const inBatch = new Set(rows.filter(Boolean).map((r: any) => `${r.source_id}|${r.external_id}`));
  const order: any[] = [];
  const placed = new Set<string>();
  for (let guard = 0; order.length < pending.length && guard < pending.length + 2; guard++) {
    for (const r of pending) {
      if (order.includes(r)) continue;
      const parentKey = r.parent_external ? `${r.source_id}|${r.parent_external}` : null;
      if (!r.missing && parentKey && inBatch.has(parentKey) && !placed.has(parentKey)) continue;
      order.push(r);
      if (!r.missing) placed.add(`${r.source_id}|${r.external_id}`);
    }
  }
  for (const r of order) {
    if (r.missing) { skipped.push({ pageId: r.missing, why: 'No such page' }); continue; }
    if (bib && r.source_id === bib) { skipped.push({ pageId: r.id, why: 'Already in Biblio' }); continue; }
    const already = one<any>(d.db, 'SELECT id FROM biblio_articles WHERE world_id = ? AND imported_from = ? AND deleted_at IS NULL', worldId, r.id);
    if (already) { skipped.push({ pageId: r.id, why: 'Copied before' }); done.set(`${r.source_id}|${r.external_id}`, already.id); continue; }
    const titleOf = (m: any) => R.find(m, r.source_id)?.title ?? m.name ?? null;
    const blocks = parseJson<any[]>(r.blocks, []);
    let body = r.origin === 'markdown' || !blocks.length ? String(r.body ?? '') : blocksToMarkdown(blocks, titleOf);
    const props = parseJson<PropertyGroup[]>(r.properties, []);
    const template = tplIds.has(String(r.kind)) ? String(r.kind) : 'page';
    const tpl = templateOf(d, worldId, template);
    const fields: Record<string, string> = {};
    const leftShared: string[] = [];
    const leftSecret: string[] = [];
    for (const g of props) {
      const secretGroup = g.gm === true || (g.level && g.level !== 'party');
      for (const row of g.rows ?? []) {
        const text = inlineToMd(row.value, titleOf);
        const f = tpl.fields.find((x) => x.label.toLowerCase() === String(row.key).toLowerCase() || x.key === String(row.key).toLowerCase());
        if (f && !fields[f.key] && (!!f.gm === !!secretGroup || (secretGroup && f.gm))) { fields[f.key] = text; continue; }
        (secretGroup ? leftSecret : leftShared).push(`- **${row.key}:** ${text}`);
      }
    }
    if (leftShared.length) body = `${body.trimEnd()}\n\n## Facts\n\n${leftShared.join('\n')}`;
    if (leftSecret.length) body = `${body.trimEnd()}\n\n> [!secret] GM-only facts\n${leftSecret.map((l) => `> ${l}`).join('\n')}`;
    const parentKey = r.parent_external ? `${r.source_id}|${r.parent_external}` : null;
    const parentId = parentKey && done.has(parentKey) ? done.get(parentKey)! : c.parentId ?? null;
    const a = saveArticle(d, worldId, null, {
      title: r.title, template, parentId, body: body.trim(), level: normLevel(r.visibility), tags: parseJson(r.tags, []), aliases: parseJson(r.aliases, []),
      fields, knowledge: r.knowledge ?? null, position: r.position ?? null, note: `Copied from ${r.source_id ? 'a source' : 'the library'}`,
    }, c, { batch: true });
    run(d.db, 'UPDATE biblio_articles SET imported_from = ? WHERE id = ?', r.id, a.id);
    done.set(`${r.source_id}|${r.external_id}`, a.id);
    imported.push({ pageId: r.id, articleId: a.id, title: a.title });
  }
  if (imported.length) d.library.rebuildPlayerCopies(worldId);
  return { imported, skipped };
}

function inlineToMd(value: Inline[], titleOf: (m: any) => string | null): string {
  return (value ?? []).map((x) => (x.mention ? `[[${titleOf(x.mention) ?? x.mention.text ?? x.mention.name ?? 'hidden'}]]` : x.text ?? '')).join('').trim();
}

/** Everything, for a backup or to take the world elsewhere: articles, their own templates. Versions are not included. */
export function exportAll(d: Deps, worldId: string) {
  return {
    format: 'alexandria-biblio', version: 1, exportedAt: now(),
    templates: templates(d, worldId).filter((t) => !t.builtin),
    articles: listArticles(d, worldId).map(({ pageId: _p, ...a }) => a),
  };
}

/** Put back an export (new ids; parent places kept). */
export function importExport(d: Deps, worldId: string, data: any, c: SaveCtx): { articles: number; templates: number } {
  if (c.reader !== 'gm') throw new HttpError(403, 'Only the GM, in the app, can load a Biblio export');
  if (data?.format !== 'alexandria-biblio' || !Array.isArray(data.articles)) throw new HttpError(400, 'Not a Biblio export');
  if (data.articles.length > 20_000) throw new HttpError(413, 'At most 20,000 articles at once');
  let nt = 0;
  for (const t of Array.isArray(data.templates) ? data.templates : []) {
    try { saveTemplate(d, worldId, t, one(d.db, 'SELECT 1 FROM biblio_templates WHERE world_id = ? AND id = ?', worldId, String(t?.id ?? '')) ? String(t.id) : null); nt++; } catch { /* a bad template is skipped */ }
  }
  const map = new Map<string, string>();
  const list: any[] = data.articles;
  const ids = new Set(list.map((a) => a.id));
  const left = [...list];
  for (let guard = 0; left.length && guard < list.length + 2; guard++) {
    for (let i = 0; i < left.length; i++) {
      const a = left[i];
      if (a.parentId && ids.has(a.parentId) && !map.has(a.parentId)) continue;
      const saved = saveArticle(d, worldId, null, { ...a, rev: undefined, parentId: a.parentId ? map.get(a.parentId) ?? null : null, note: 'Loaded from an export' }, c, { batch: true });
      map.set(a.id, saved.id);
      left.splice(i--, 1);
    }
  }
  if (map.size) d.library.rebuildPlayerCopies(worldId);
  return { articles: map.size, templates: nt };
}
