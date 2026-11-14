// Write-back for the Kanka connectors, used only by the WorldLore workspace
// (features/worldlore). The workspace root is one note or journal (the
// "WorldLore home"); the agent's pages are child entities of the same type,
// nested any depth. Two ways in, one set of rules:
//   REST (token): POST / PATCH / DELETE /campaigns/{id}/notes|journals/{id},
//                 with `parent_id` (the parent's entity id, Kanka 3.10+).
//   MCP:          only create_entities, update_entities and delete_entities
//                 through the client registry.workspaceMcpFactory builds.
// Before every write the target's parent chain is fetched FRESH from Kanka
// and must contain the root (or the target is a new child of a page inside
// it). The root can't be moved or deleted, and nothing leaves the root or
// changes entity type. Names are never trusted: entity ids only.
import type { ConnectorContext, ConnectorWrite, WriteLevel } from '../connector.ts';
import { WriteRefused } from '../connector.ts';
import type { Entry, PropertyGroup } from '../model.ts';
import { jsonOf } from '../../core/mcp.ts';
import { calloutVariantLevel, headingNamedLevel, maxLevel, tagLevel, type Level } from '../../core/levels.ts';
import { esc, kankaBase, kankaBlocks, kankaHttp, kankaProperties, postBlocks, postLevel, postShared } from './kanka.ts';

const KINDS = { note: 'notes', journal: 'journals' } as const;
type Kind = keyof typeof KINDS;
const isKind = (x: unknown): x is Kind => x === 'note' || x === 'journal';
const MAX_DEPTH = 64;

const EID = /^\d{1,12}$/;
/** A Kanka entity id from `kanka:123` or `123`. */
export function kankaEid(v: unknown, what = 'id'): string {
  const s = String(v ?? '').trim().replace(/^kanka:/, '');
  if (!EID.test(s)) throw new WriteRefused(`Bad ${what}`, 400);
  return s;
}
const ext = (eid: string) => `kanka:${eid}`;
const idOf = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : EID.test(String(v)) ? String(v) : null);

// ---- Markdown to Kanka ----------------------------------------------------------------

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline Markdown to HTML. Mentions ([entity:ID], [entity:ID|label], and Alexandria's [[@kanka:ID|label]]) stay as Kanka's own text form. */
function inlineHtml(text: string): string {
  const keep: string[] = [];
  const hold = (h: string) => `\u0000${keep.push(h) - 1}\u0000`;
  let s = text.replace(/\[\[@kanka:(\d+)(?:\|([^\]]*))?\]\]/g, (_m, id, label) => hold(`[entity:${id}${label ? '|' + escHtml(label) : ''}]`));
  s = s.replace(/\[(?:entity|character|location|family|organisation|organization|item|note|journal|quest|race|creature|event|ability|timeline|map|calendar|tag):(\d+)(?:\|([^\]]*))?\]/g, (m) => hold(escHtml(m)));
  s = s.replace(/`([^`]+)`/g, (_m, c) => hold(`<code>${escHtml(c)}</code>`));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t, u) => hold(`<a href="${escHtml(u)}">${escHtml(t)}</a>`));
  s = escHtml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>').replace(/~~([^~]+)~~/g, '<s>$1</s>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => keep[Number(i)]);
}

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;

/** Markdown to the HTML Kanka stores in `entry`: headings, paragraphs, lists, quotes, code and rules. HTML in the text is escaped. */
export function mdToKankaHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m: RegExpExecArray | null;
    if (!l.trim()) { i++; continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { out.push(`<h${m[1].length}>${inlineHtml(m[2].trim())}</h${m[1].length}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^```/.test(l)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre><code>${escHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*>/.test(l)) {
      const q: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${q.filter((x) => x.trim()).map((x) => `<p>${inlineHtml(x)}</p>`).join('')}</blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(l)) {
      const ordered = /^\s*\d+[.)]\s+/.test(l);
      const items: string[] = [];
      for (; i < lines.length && LIST_ITEM.test(lines[i]); i++) items.push(`<li>${inlineHtml(lines[i].replace(LIST_ITEM, ''))}</li>`);
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const buf: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>)/.test(lines[i]) && !LIST_ITEM.test(lines[i]); i++) buf.push(lines[i].trim());
    out.push(`<p>${inlineHtml(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

/** The most secret level the Markdown itself names: a `> [!secret]` or `> [!broker]` callout, or a heading like "Broker notes". */
export function markdownLevel(md: string): Level {
  let lv: Level = 'party';
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    let m: RegExpExecArray | null;
    if ((m = /^\s*>\s*\[!([\w -]+)\]/.exec(line))) lv = maxLevel(lv, calloutVariantLevel(m[1]));
    else if ((m = /^#{1,6}\s+(.*)$/.exec(line))) lv = maxLevel(lv, headingNamedLevel(m[1]));
  }
  return lv;
}

/**
 * What a write sets. `level` given: Kanka's private flag and the broker or
 * classified tag follow the level, raised by any secret text in the Markdown
 * (party only when nothing is secret). No level: only the private flag, and
 * only to protect secret text; tags stay as they are.
 */
export function levelPlan(level: WriteLevel | undefined, markdown: string | undefined): { level?: Level; isPrivate?: boolean } {
  const content = markdown === undefined ? 'party' : markdownLevel(markdown);
  if (level === undefined) return content === 'party' ? {} : { isPrivate: true };
  const eff = maxLevel(level, content);
  return { level: eff, isPrivate: eff !== 'party' };
}

const isLevelTag = (name: string) => tagLevel([name]) !== 'party';

// ---- what the write code needs from Kanka ----------------------------------------------

interface Ent {
  eid: string;
  /** The entity type code Kanka reports (`note`, `journal`, ...). */
  kind: string | null;
  /** The module row id (notes/{id}). */
  childId: string | null;
  /** The parent's entity id; null: none. */
  parent: string | null;
  /** False when Kanka's answer didn't say (never guessed). */
  parentKnown: boolean;
  /** Every ancestor's entity id when Kanka lists them, nearest first. */
  ancestors: string[] | null;
  name: string;
}

interface Rec {
  ent: Ent;
  entry: unknown;
  posts: any[];
  /** Every tag's name, and the ones players may see. */
  tags: string[];
  publicTags: string[];
  isPrivate: boolean | null;
  updatedAt: string | null;
  url: string | null;
  image: string | null;
  properties: PropertyGroup[];
  trustPosts: boolean;
  tagName: (t: unknown) => string | undefined;
}

interface Listed { eid: string; title: string; parent: string | null | undefined; kind: Kind }

interface KkBackend {
  entity(eid: string): Promise<Ent>;
  create(a: { kind: Kind; name: string; parent: string; markdown: string; plan: { level?: Level; isPrivate?: boolean } }): Promise<string>;
  update(e: Ent, a: { name?: string; markdown?: string; plan: { level?: Level; isPrivate?: boolean } }): Promise<void>;
  move(e: Ent, parent: string): Promise<void>;
  remove(e: Ent): Promise<void>;
  record(eid: string): Promise<Rec>;
  list(kind: Kind, q: string | null, maxPages: number): Promise<Listed[]>;
}

// ---- REST backend -------------------------------------------------------------------------

function restBackend(cfg: Record<string, any>, ctx: ConnectorContext): KkBackend {
  const camp = `${kankaBase(cfg)}/campaigns/${encodeURIComponent(String(cfg.campaignId))}`;
  const send = async (method: string, path: string, body?: unknown) => {
    const r = await kankaHttp(ctx, cfg, method, camp + path, body);
    if (r.status === 401 || r.status === 403) throw new WriteRefused(`Kanka refused the request (${r.status}): this token cannot ${method === 'GET' ? 'read' : 'write'} that. Use the token of a campaign admin.`, 403);
    return r;
  };
  const okBody = (r: { status: number; body: any }, what: string) => {
    if (r.status >= 200 && r.status < 300) return r.body;
    if (r.status === 404) throw new WriteRefused(`${what} was not found in Kanka`, 404);
    if (r.status === 422) throw new WriteRefused(`Kanka rejected ${what}: ${JSON.stringify(r.body?.errors ?? r.body?.message ?? '').slice(0, 160)}`, 400);
    throw new Error(`Kanka answered ${r.status} for ${what}`);
  };
  const get = async (path: string, what: string) => okBody(await send('GET', path), what);

  const entOf = (d: any, eid: string): Ent => {
    const kind = typeof d?.entity_type === 'string' ? d.entity_type : typeof d?.entity_type_code === 'string' ? d.entity_type_code : null;
    const rawParents: unknown[] = Array.isArray(d?.parents) ? d.parents : [];
    const parents = rawParents.map((p) => idOf(typeof p === 'object' && p ? (p as any).entity_id ?? (p as any).id : p)).filter((x): x is string => !!x);
    let parent: string | null = null;
    let known = false;
    if ('parent_id' in (d ?? {})) { parent = idOf(d.parent_id); known = true; }
    else if (d?.parent && typeof d.parent === 'object') { parent = idOf(d.parent.entity_id ?? d.parent.id); known = true; }
    return { eid, kind, childId: idOf(d?.child_id), parent, parentKnown: known, ancestors: parents.length ? parents : null, name: esc(d?.name) };
  };

  const entity = async (eid: string): Promise<Ent> => {
    let d: any;
    try { d = (await get(`/entities/${eid}?related=1`, `entity ${eid}`))?.data; } catch (err: any) {
      if (err instanceof WriteRefused && err.status === 403) throw err;
      throw new WriteRefused(`Could not check ${eid} in Kanka: ${String(err.message).slice(0, 100)}`, 403);
    }
    if (!d || String(d.id ?? d.entity_id) !== eid) throw new WriteRefused('Kanka did not confirm that page', 403);
    const e = entOf(d, eid);
    if (!e.parentKnown && isKind(e.kind) && e.childId) {
      // The entity row left the parent out: ask the module row, which carries parent_id since Kanka 3.10.
      const m = (await get(`/${KINDS[e.kind]}/${e.childId}`, `${e.kind} ${e.childId}`))?.data;
      if (m && 'parent_id' in m) { e.parent = idOf(m.parent_id); e.parentKnown = true; }
    }
    return e;
  };

  /** Every tag in the campaign: id -> name and name -> id. */
  const tagIndex = async () => {
    const byId = new Map<string, string>();
    for (let page = 1; page <= 50; page++) {
      const j = await get(`/tags?page=${page}`, 'tags');
      for (const t of Array.isArray(j?.data) ? j.data : []) byId.set(String(t.id), esc(t.name));
      const last = Number(j?.meta?.last_page);
      if (!j?.links?.next || (Number.isFinite(last) && last > 0 && page >= last)) break;
    }
    return byId;
  };
  const levelTagId = async (byId: Map<string, string>, level: 'broker' | 'classified'): Promise<string> => {
    for (const [id, name] of byId) if (tagLevel([name]) === level) return id;
    const made = okBody(await send('POST', '/tags', { name: level, is_private: true }), `the ${level} tag`)?.data;
    if (!made?.id) throw new Error('Kanka did not return the new tag');
    byId.set(String(made.id), level);
    return String(made.id);
  };
  /** The entity's tag ids with its level tags swapped for the one `level` names. */
  const tagsFor = async (module: string, childId: string | null, level: Level): Promise<number[]> => {
    const byId = await tagIndex();
    let current: string[] = [];
    if (childId) {
      const m = (await get(`/${module}/${childId}`, `${module} ${childId}`))?.data;
      current = (Array.isArray(m?.tags) ? m.tags : []).map((t: any) => String(typeof t === 'object' && t ? t.id ?? t.tag_id : t));
    }
    const keep = current.filter((id) => !isLevelTag(byId.get(id) ?? ''));
    if (level === 'broker' || level === 'classified') keep.push(await levelTagId(byId, level));
    return keep.map(Number).filter(Number.isFinite);
  };

  return {
    entity,
    async create(a) {
      const body: Record<string, unknown> = { name: a.name.slice(0, 190), entry: mdToKankaHtml(a.markdown), parent_id: Number(a.parent), is_private: a.plan.isPrivate ?? true };
      const lv = a.plan.level;
      if (lv === 'broker' || lv === 'classified') body.tags = await tagsFor(KINDS[a.kind], null, lv);
      const d = okBody(await send('POST', `/${KINDS[a.kind]}`, body), `the new ${a.kind}`)?.data;
      const id = idOf(d?.entity_id);
      if (!id) throw new Error('Kanka did not return the new page');
      return id;
    },
    async update(e, a) {
      const mod = KINDS[e.kind as Kind];
      const body: Record<string, unknown> = { name: (a.name ?? e.name).slice(0, 190) };
      if (a.markdown !== undefined) body.entry = mdToKankaHtml(a.markdown);
      if (a.plan.isPrivate !== undefined) body.is_private = a.plan.isPrivate;
      if (a.plan.level !== undefined) body.tags = await tagsFor(mod, e.childId, a.plan.level);
      okBody(await send('PATCH', `/${mod}/${e.childId}`, body), `${e.kind} ${e.eid}`);
    },
    async move(e, parent) {
      okBody(await send('PATCH', `/${KINDS[e.kind as Kind]}/${e.childId}`, { name: e.name, parent_id: Number(parent) }), `${e.kind} ${e.eid}`);
    },
    async remove(e) {
      okBody(await send('DELETE', `/${KINDS[e.kind as Kind]}/${e.childId}`), `${e.kind} ${e.eid}`);
    },
    async record(eid) {
      const ent = await entity(eid);
      if (!isKind(ent.kind) || !ent.childId) throw new WriteRefused('That page is not a note or journal', 403);
      const d = (await get(`/${KINDS[ent.kind]}/${ent.childId}?related=1`, `${ent.kind} ${ent.childId}`))?.data ?? {};
      const byId = await tagIndex();
      const tagName = (t: unknown): string | undefined => (typeof t === 'object' && t ? ((t as any).name ? esc((t as any).name) : byId.get(String((t as any).id ?? (t as any).tag_id))) : byId.get(String(t)));
      const names: string[] = [];
      const publicTags: string[] = [];
      for (const t of Array.isArray(d.tags) ? d.tags : []) {
        const n = tagName(t);
        if (!n) continue;
        names.push(n);
        if (typeof t === 'object' && t && (t as any).is_private === false && (t as any).is_hidden !== true) publicTags.push(n);
      }
      return {
        ent: { ...ent, name: esc(d.name ?? ent.name) },
        entry: d.entry ?? d.entry_parsed, posts: Array.isArray(d.posts) ? d.posts : [], tags: names,
        publicTags,
        isPrivate: typeof d.is_private === 'boolean' ? d.is_private : null,
        updatedAt: d.updated_at ?? null,
        url: d.urls?.view ?? null,
        image: typeof d.image_full === 'string' && /^https?:/.test(d.image_full) && d.has_custom_image !== false && !/default/.test(d.image_full) ? d.image_full : null,
        properties: kankaProperties(d, ent.kind, () => undefined),
        trustPosts: false, tagName,
      };
    },
    async list(kind, q, maxPages) {
      const out: Listed[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const j = await get(`/${KINDS[kind]}?page=${page}${q ? `&name=${encodeURIComponent(q)}` : ''}`, `the ${kind} list`);
        for (const e of Array.isArray(j?.data) ? j.data : []) {
          if (!e?.entity_id || e.is_template === true) continue;
          out.push({ eid: String(e.entity_id), title: esc(e.name), kind, parent: 'parent_id' in e ? idOf(e.parent_id) : undefined });
        }
        const last = Number(j?.meta?.last_page);
        if (!j?.links?.next || (Number.isFinite(last) && last > 0 && page >= last)) break;
      }
      return out;
    },
  };
}

// ---- MCP backend --------------------------------------------------------------------------

/** The mcp-kanka server through the workspace client (registry.workspaceMcpFactory): only create_entities, update_entities and delete_entities. */
function mcpBackend(cfg: Record<string, any>, ctx: ConnectorContext): KkBackend {
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await ctx.mcp().call(name, args);
    if (res.isError) throw new Error(`Kanka ${name}: ${res.text.slice(0, 160)}`);
    return res;
  };
  const rows = (j: any): any[] => (Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : Array.isArray(j?.entities) ? j.entities : []);
  const tagNames = (v: unknown): string[] => (Array.isArray(v) ? v : []).map((t) => esc(typeof t === 'object' && t ? (t as any).name : t)).filter(Boolean);
  const first = (res: Parameters<typeof jsonOf>[0], what: string) => {
    const r = rows(jsonOf(res))[0];
    if (!r || r.success === false) throw new Error(`Kanka ${what}: ${String(r?.error ?? 'no answer').slice(0, 160)}`);
    return r;
  };
  const raw = async (eid: string, posts = false) => {
    let r: any;
    try { r = rows(jsonOf(await tool('get_entities', { entity_ids: [Number(eid)], include_posts: posts }))).find((x) => String(x?.entity_id) === eid && x.success !== false); } catch (err: any) {
      throw new WriteRefused(`Could not check ${eid} in Kanka: ${String(err.message).slice(0, 100)}`, 403);
    }
    if (!r) throw new WriteRefused('Kanka did not confirm that page', 403);
    return r;
  };
  const entOf = (r: any, eid: string): Ent => ({
    eid, kind: typeof r.entity_type === 'string' ? r.entity_type : null, childId: idOf(r.id), parent: idOf(r.parent_id), parentKnown: 'parent_id' in r, ancestors: null, name: esc(r.name),
  });
  const tagsFor = (current: unknown, level: Level): string[] => {
    const keep = tagNames(current).filter((n) => !isLevelTag(n));
    return level === 'broker' || level === 'classified' ? [...keep, level] : keep;
  };

  return {
    entity: async (eid) => entOf(await raw(eid), eid),
    async create(a) {
      const item: Record<string, unknown> = { entity_type: a.kind, name: a.name.slice(0, 190), entry: a.markdown, parent_id: Number(a.parent), is_hidden: a.plan.isPrivate ?? true };
      if (a.plan.level === 'broker' || a.plan.level === 'classified') item.tags = [a.plan.level];
      const r = first(await tool('create_entities', { entities: [item] }), 'create_entities');
      const id = idOf(r.entity_id);
      if (!id) throw new Error('Kanka did not return the new page');
      return id;
    },
    async update(e, a) {
      const u: Record<string, unknown> = { entity_id: Number(e.eid) };
      if (a.name !== undefined) u.name = a.name.slice(0, 190);
      if (a.markdown !== undefined) u.entry = a.markdown;
      if (a.plan.isPrivate !== undefined) u.is_hidden = a.plan.isPrivate;
      if (a.plan.level !== undefined) u.tags = tagsFor((await raw(e.eid)).tags, a.plan.level);
      first(await tool('update_entities', { updates: [u] }), 'update_entities');
    },
    async move(e, parent) { first(await tool('update_entities', { updates: [{ entity_id: Number(e.eid), parent_id: Number(parent) }] }), 'update_entities'); },
    async remove(e) { first(await tool('delete_entities', { entity_ids: [Number(e.eid)] }), 'delete_entities'); },
    async record(eid) {
      const r = await raw(eid, true);
      const ent = entOf(r, eid);
      if (!isKind(ent.kind)) throw new WriteRefused('That page is not a note or journal', 403);
      const names = tagNames(r.tags);
      return {
        ent, entry: r.entry, posts: Array.isArray(r.posts) ? r.posts : [], tags: names, publicTags: [], isPrivate: typeof r.is_hidden === 'boolean' ? r.is_hidden : null,
        updatedAt: r.updated_at ?? null, url: null, image: typeof r.image_full === 'string' && /^https?:/.test(r.image_full) ? r.image_full : null,
        properties: r.type ? [{ title: 'Facts', rows: [{ key: 'Type', value: [{ text: esc(r.type) }] }] }] : [],
        trustPosts: false, tagName: (t) => (typeof t === 'object' && t ? esc((t as any).name) : typeof t === 'string' ? esc(t) : undefined),
      };
    },
    async list(kind, q, maxPages) {
      const out: Listed[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const j = jsonOf(await tool('find_entities', { entity_type: kind, include_full: false, last_synced: '2000-01-01T00:00:00Z', limit: 100, page, ...(q ? { name: q } : {}) }));
        const list = rows(j);
        for (const e of list) if (e?.entity_id) out.push({ eid: String(e.entity_id), title: esc(e.name), kind, parent: 'parent_id' in e ? idOf(e.parent_id) : undefined });
        const last = Number(j?.sync_info?.last_page ?? 0);
        if (!list.length || (last ? page >= last : list.length < 100)) break;
      }
      return out;
    },
  };
}

// ---- the guard and the connector ------------------------------------------------------------

/** Every ancestor of `e`, nearest first, as Kanka says right now (walks the parents when Kanka doesn't list them all). */
async function chain(be: KkBackend, e: Ent): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set([e.eid]);
  let cur = e;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (cur.parent === null) {
      if (!cur.parentKnown) throw new WriteRefused('Kanka did not say where that page sits, so it is not changed', 403);
      return out;
    }
    if (seen.has(cur.parent)) throw new WriteRefused('The page tree loops; refusing', 403);
    seen.add(cur.parent);
    out.push(cur.parent);
    if (cur.ancestors && cur.ancestors[0] === cur.parent) {
      for (const a of cur.ancestors.slice(1)) if (!seen.has(a)) { seen.add(a); out.push(a); }
      return out;
    }
    cur = await be.entity(cur.parent);
  }
  throw new WriteRefused('That page is nested too deep to check', 403);
}

/**
 * The guard. The root must be a note or journal as Kanka says right now; the
 * target must be the root or (strict: below it), of the same type, with the
 * root among its ancestors. `strict` refuses the root itself (delete, move,
 * rename). Returns the root and the target.
 */
async function inside(be: KkBackend, rootArg: string, idArg: string, strict: boolean): Promise<{ root: Ent; target: Ent; ancestors: string[] }> {
  const rootId = kankaEid(rootArg, 'root');
  const eid = kankaEid(idArg);
  const root = await be.entity(rootId);
  if (!isKind(root.kind)) throw new WriteRefused('The WorldLore home must be a note or a journal', 403);
  if (eid === rootId) {
    if (strict) throw new WriteRefused('The workspace root itself cannot be changed here', 403);
    return { root, target: root, ancestors: [] };
  }
  const target = await be.entity(eid);
  if (target.kind !== root.kind) throw new WriteRefused(`That page is not a ${root.kind}; WorldLore only holds ${root.kind}s here`, 403);
  const ancestors = await chain(be, target);
  if (!ancestors.includes(rootId)) throw new WriteRefused('That page is outside the WorldLore workspace', 403);
  return { root, target, ancestors };
}

function entryOf(r: Rec, ctx: ConnectorContext): Entry {
  const kind = r.ent.kind as Kind;
  const levelTags = r.tags.filter(isLevelTag);
  return {
    externalId: ext(r.ent.eid),
    parentExternalId: r.ent.parent ? ext(r.ent.parent) : null,
    folder: [kind[0].toUpperCase() + kind.slice(1) + 's'],
    title: r.ent.name,
    tags: [...r.publicTags, ...levelTags.filter((t) => !r.publicTags.includes(t))],
    type: kind,
    icon: null,
    banner: r.image,
    properties: r.properties,
    blocks: [...kankaBlocks(r.entry), ...postBlocks(r.posts, r.trustPosts ? (p: any) => p.is_hidden === false : postShared, (p) => postLevel(p, r.tagName))],
    // Kanka's own private flag always wins; the workspace then applies the page's level.
    visibility: r.isPrivate === false && ctx.shareVisible ? 'party' : 'dm',
    url: r.url,
    updatedAt: r.updatedAt,
  } as Entry;
}

const MAX_TITLE = 190;

function kkWrite(backend: (cfg: Record<string, any>, ctx: ConnectorContext) => KkBackend): ConnectorWrite {
  return {
    async createPage(cfg, ctx, a) {
      const be = backend(cfg, ctx);
      const parent = a.parent ? kankaEid(a.parent, 'parent') : kankaEid(a.root, 'root');
      const { root } = await inside(be, a.root, parent, false);
      const name = String(a.title ?? '').trim().slice(0, MAX_TITLE);
      if (!name) throw new WriteRefused('Give a title', 400);
      return { externalId: ext(await be.create({ kind: root.kind as Kind, name, parent, markdown: a.markdown, plan: levelPlan(a.level, a.markdown) })) };
    },
    async updatePage(cfg, ctx, a) {
      const be = backend(cfg, ctx);
      const { target } = await inside(be, a.root, a.id, true);
      const name = a.title === undefined ? undefined : String(a.title).trim().slice(0, MAX_TITLE);
      if (name === '') throw new WriteRefused('Give a title', 400);
      await be.update(target, { name, markdown: a.markdown, plan: levelPlan(a.level, a.markdown) });
      return { externalId: ext(target.eid) };
    },
    async movePage(cfg, ctx, a) {
      const be = backend(cfg, ctx);
      const { target } = await inside(be, a.root, a.id, true);
      const to = a.to ? kankaEid(a.to, 'destination') : kankaEid(a.root, 'root');
      const dest = await inside(be, a.root, to, false);
      if (to === target.eid || dest.ancestors.includes(target.eid)) throw new WriteRefused('A page cannot move into itself or its own child', 400);
      await be.move(target, to);
      return { externalId: ext(target.eid) };
    },
    async deletePage(cfg, ctx, a) {
      const be = backend(cfg, ctx);
      const { target } = await inside(be, a.root, a.id, true);
      await be.remove(target);
    },
    async readPage(cfg, ctx, a) {
      const be = backend(cfg, ctx);
      await inside(be, a.root, a.id, false);
      return entryOf(await be.record(kankaEid(a.id)), ctx);
    },
    /** The top-level notes and journals (those with no parent) a DM may pick as the WorldLore home. */
    async roots(cfg, ctx) {
      const be = backend(cfg, ctx);
      const all = [...await be.list('note', null, 10), ...await be.list('journal', null, 10)];
      return all.filter((x) => x.parent === null || x.parent === undefined).map((x) => ({ id: ext(x.eid), title: x.title, kind: x.kind })).sort((x, y) => x.title.localeCompare(y.title));
    },
    /** Notes and journals at any depth whose name has `q`. */
    async search(cfg, ctx, q) {
      const be = backend(cfg, ctx);
      const text = q.trim().slice(0, 100);
      if (!text) return [];
      const all = [...await be.list('note', text, 2), ...await be.list('journal', text, 2)];
      return all.map((x) => ({ id: ext(x.eid), title: x.title, kind: x.kind })).sort((x, y) => x.title.localeCompare(y.title)).slice(0, 50);
    },
  };
}

export const kankaRestWrite = kkWrite(restBackend);
export const kankaMcpWrite = kkWrite(mcpBackend);
