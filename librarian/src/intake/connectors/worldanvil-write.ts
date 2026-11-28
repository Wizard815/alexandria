// Write-back for World Anvil, used only by the WorldLore workspace
// (features/worldlore). The workspace root is one World Anvil category (the
// "WorldLore home"); the agent's pages are articles in it, nested under each
// other with articleParent. Calls (API v2, Boromir):
//   PUT    /article           create (title, templateType, world, category, articleParent, content, state, tags)
//   PATCH  /article?id=       update or move
//   DELETE /article?id=       delete (World Anvil keeps no trash)
// Before every write the target and its parents are read FRESH from World
// Anvil and the root must be among them (or the target is a new child of a
// page inside it). Only articles are written: the root category itself, other
// categories, maps, secrets and timelines are never changed.
import type { ConnectorContext, ConnectorWrite, WriteLevel } from '../connector.ts';
import { WriteRefused } from '../connector.ts';
import type { Entry } from '../model.ts';
import type { Level } from '../../core/levels.ts';
import { levelPlan } from './kanka-write.ts';
import { playerGroups, waArticleEntry, waHttp, type WaLookups } from './worldanvil.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DEPTH = 64;
const MAX_TITLE = 190;

/** A World Anvil id from `wa:<uuid>` or `<uuid>`. */
export function waId(v: unknown, what = 'id'): string {
  const s = String(v ?? '').trim().replace(/^wa:/, '').toLowerCase();
  if (!UUID.test(s)) throw new WriteRefused(`Bad ${what}`, 400);
  return s;
}
const ext = (id: string) => `wa:${id}`;

// ---- Markdown to BBCode -----------------------------------------------------------------

/** Inline Markdown to BBCode. Alexandria's [[@wa:<id>|label]] mentions become World Anvil mentions; BBCode typed in the text is neutralised. */
function inlineBb(text: string): string {
  const keep: string[] = [];
  const hold = (h: string) => `\u0000${keep.push(h) - 1}\u0000`;
  let s = text.replace(/\[\[@wa:([0-9a-f-]{36})(?:\|([^\]]*))?\]\]/gi, (_m, id, label) => hold(`@[${String(label || 'link').replace(/[[\]]/g, '')}](article:${id.toLowerCase()})`));
  s = s.replace(/`([^`]+)`/g, (_m, c) => hold(`[code]${c.replace(/\[/g, '(').replace(/\]/g, ')')}[/code]`));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s\]]+)\)/g, (_m, t, u) => hold(`[url:${u}]${t.replace(/[[\]]/g, '')}[/url]`));
  // Anything that would be read as a tag ([secret:...], [subcontainer] ...) is turned into plain brackets.
  s = s.replace(/\[/g, '(').replace(/\]/g, ')');
  s = s.replace(/\*\*([^*]+)\*\*/g, '[b]$1[/b]').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1[i]$2[/i]').replace(/~~([^~]+)~~/g, '[s]$1[/s]');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => keep[Number(i)]);
}

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;

/** Markdown to the BBCode World Anvil stores in `content`: headings, paragraphs, lists, quotes, code and rules. */
export function mdToBbcode(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m: RegExpExecArray | null;
    if (!l.trim()) { i++; continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { const n = Math.min(m[1].length, 4); out.push(`[h${n}]${inlineBb(m[2].trim())}[/h${n}]`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push('[hr]'); i++; continue; }
    if (/^```/.test(l)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(`[code]${body.join('\n').replace(/\[/g, '(').replace(/\]/g, ')')}[/code]`);
      continue;
    }
    if (/^\s*>/.test(l)) {
      const q: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ''));
      // A > [!secret] callout's own marker line is dropped (the page is made private instead: see levelPlan).
      const body = q.filter((x) => x.trim() && !/^\s*\[![\w -]+\]\s*$/.test(x)).map((x) => inlineBb(x.replace(/^\s*\[![\w -]+\]\s*/, ''))).join('\n');
      out.push(`[quote]${body}[/quote]`);
      continue;
    }
    if (LIST_ITEM.test(l)) {
      const ordered = /^\s*\d+[.)]\s+/.test(l);
      const items: string[] = [];
      for (; i < lines.length && LIST_ITEM.test(lines[i]); i++) items.push(`[li]${inlineBb(lines[i].replace(LIST_ITEM, ''))}[/li]`);
      out.push(`[${ordered ? 'ol' : 'ul'}]${items.join('')}[/${ordered ? 'ol' : 'ul'}]`);
      continue;
    }
    const buf: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>)/.test(lines[i]) && !LIST_ITEM.test(lines[i]); i++) buf.push(lines[i].trim());
    out.push(inlineBb(buf.join(' ')));
  }
  return out.join('\n\n');
}

/** Tags with the level tag swapped for the one `level` names (broker or classified; other levels have none). */
export function levelTags(current: string[], level: Level): string[] {
  const keep = current.filter((t) => !/^(broker|classified)$/i.test(t.trim()));
  return level === 'broker' || level === 'classified' ? [...keep, level] : keep;
}

// ---- what the write code needs from World Anvil ---------------------------------------------

interface Node {
  id: string;
  kind: 'article' | 'category';
  title: string;
  /** The next one up (article parent, else category, else category parent), or null at the top of the world. */
  up: string | null;
  /** The category an article sits in. */
  category: string | null;
  tags: string[];
  raw: any;
}

const idIn = (v: any): string | null => (v && typeof v === 'object' && UUID.test(String(v.id ?? '')) ? String(v.id).toLowerCase() : null);
const tagList = (v: unknown) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((t) => String(t ?? '').trim()).filter(Boolean);

function backend(cfg: Record<string, any>, ctx: ConnectorContext) {
  const call = async (method: string, path: string, a: { query?: Record<string, string>; body?: unknown } = {}) => {
    const r = await waHttp(ctx, cfg, method, path, a);
    if (r.status === 401 || r.status === 403) throw new WriteRefused(`World Anvil refused the request (${r.status}): this token cannot ${method === 'GET' ? 'read' : 'write'} that. Use the world owner's or a co-author's token.`, 403);
    return r;
  };
  const ok = (r: { status: number; body: any }, what: string) => {
    if (r.status >= 200 && r.status < 300 && r.body?.success !== false) return r.body;
    if (r.status === 404) throw new WriteRefused(`${what} was not found in World Anvil`, 404);
    if (r.status === 400 || r.status === 422) throw new WriteRefused(`World Anvil rejected ${what}: ${JSON.stringify(r.body?.error ?? r.body?.message ?? '').slice(0, 160)}`, 400);
    throw new Error(`World Anvil answered ${r.status} for ${what}`);
  };
  /** An article, else a category, as World Anvil says right now. */
  const node = async (id: string): Promise<Node> => {
    let r = await call('GET', '/article', { query: { id, granularity: '3' } });
    if (r.status === 400 || r.status === 422 || r.status === 500) r = await call('GET', '/article', { query: { id, granularity: '2' } });
    if (r.status === 200 && r.body && r.body.success !== false && String(r.body.id ?? '').toLowerCase() === id) {
      const a = r.body;
      const parent = idIn(a.articleParent) ?? (a.ancestry?.firstUp && String(a.ancestry.firstUp.entityClass ?? '') !== 'World' && String(a.ancestry.firstUp.entityClass ?? '') !== 'Category' ? idIn(a.ancestry.firstUp) : null);
      const category = idIn(a.category);
      return { id, kind: 'article', title: String(a.title ?? ''), up: parent ?? category, category, tags: tagList(a.tags), raw: a };
    }
    if (r.status !== 404 && r.status !== 200) throw new WriteRefused(`Could not check ${id} in World Anvil (${r.status})`, 403);
    const c = await call('GET', '/category', { query: { id, granularity: '2' } });
    if (c.status === 200 && c.body && c.body.success !== false && String(c.body.id ?? '').toLowerCase() === id) {
      return { id, kind: 'category', title: String(c.body.title ?? ''), up: idIn(c.body.parent), category: id, tags: tagList(c.body.tags), raw: c.body };
    }
    throw new WriteRefused('World Anvil did not confirm that page', 403);
  };
  return { call, ok, node };
}
type Be = ReturnType<typeof backend>;

/** Every id above `n`, nearest first, as World Anvil says right now. */
async function chain(be: Be, n: Node): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set([n.id]);
  let cur = n;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (!cur.up) return out;
    if (seen.has(cur.up)) throw new WriteRefused('The page tree loops; refusing', 403);
    seen.add(cur.up);
    out.push(cur.up);
    cur = await be.node(cur.up);
  }
  throw new WriteRefused('That page is nested too deep to check', 403);
}

/**
 * The guard. The root must be a category as World Anvil says right now; the target must be the root or an article below it (an article
 * whose parents lead to the root). `strict` refuses the root itself.
 */
async function inside(be: Be, rootArg: string, idArg: string, strict: boolean): Promise<{ root: Node; target: Node; ancestors: string[] }> {
  const rootId = waId(rootArg, 'root');
  const id = waId(idArg);
  const root = await be.node(rootId);
  if (root.kind !== 'category') throw new WriteRefused('The WorldLore home in World Anvil must be a category', 403);
  if (id === rootId) {
    if (strict) throw new WriteRefused('The workspace root itself cannot be changed here', 403);
    return { root, target: root, ancestors: [] };
  }
  const target = await be.node(id);
  if (target.kind !== 'article') throw new WriteRefused('WorldLore only writes articles in World Anvil, not categories', 403);
  const ancestors = await chain(be, target);
  if (!ancestors.includes(rootId)) throw new WriteRefused('That page is outside the WorldLore workspace', 403);
  return { root, target, ancestors };
}

/** Where a new or moved article goes: under the root category itself, or under an article inside it (in that article's category). */
function placement(dest: Node): { category: { id: string }; articleParent: { id: string } | null } {
  return dest.kind === 'category' ? { category: { id: dest.id }, articleParent: null } : { category: { id: dest.category ?? dest.id }, articleParent: { id: dest.id } };
}

/** What the page's level sets: party is public, anything else private; broker and classified are also tags. */
function access(level: WriteLevel | undefined, markdown: string | undefined) {
  const plan = levelPlan(level, markdown);
  return { plan, state: plan.isPrivate === undefined ? undefined : plan.isPrivate ? 'private' : 'public' };
}

function lookups(ctx: ConnectorContext, cfg: Record<string, any>): WaLookups {
  return { groups: playerGroups(cfg), image: () => undefined, title: () => undefined, known: () => true, shareVisible: ctx.shareVisible };
}

export const waWrite: ConnectorWrite = {
  async createPage(cfg, ctx, a) {
    const be = backend(cfg, ctx);
    const parent = a.parent ? waId(a.parent, 'parent') : waId(a.root, 'root');
    const { root, target } = await inside(be, a.root, parent, false);
    const title = String(a.title ?? '').trim().slice(0, MAX_TITLE);
    if (!title) throw new WriteRefused('Give a title', 400);
    const { plan, state } = access(a.level, a.markdown);
    const world = idIn(root.raw?.world) ?? (UUID.test(String(cfg.worldId ?? '')) ? String(cfg.worldId).toLowerCase() : null);
    if (!world) throw new WriteRefused('World Anvil did not say which world the WorldLore home is in', 403);
    const place = placement(target);
    const body: Record<string, unknown> = {
      title, templateType: 'article', world: { id: world }, category: place.category, ...(place.articleParent ? { articleParent: place.articleParent } : {}),
      content: mdToBbcode(a.markdown), state: state ?? 'private', isDraft: false,
      ...(plan.level === 'broker' || plan.level === 'classified' ? { tags: plan.level } : {}),
    };
    const made = be.ok(await be.call('PUT', '/article', { body }), 'the new article');
    const id = idIn(made);
    if (!id) throw new Error('World Anvil did not return the new article');
    return { externalId: ext(id) };
  },
  async updatePage(cfg, ctx, a) {
    const be = backend(cfg, ctx);
    const { target } = await inside(be, a.root, a.id, true);
    const title = a.title === undefined ? undefined : String(a.title).trim().slice(0, MAX_TITLE);
    if (title === '') throw new WriteRefused('Give a title', 400);
    const { plan, state } = access(a.level, a.markdown);
    const body: Record<string, unknown> = {};
    if (title !== undefined) body.title = title;
    if (a.markdown !== undefined) body.content = mdToBbcode(a.markdown);
    if (state !== undefined) body.state = state;
    if (plan.level !== undefined) body.tags = levelTags(target.tags, plan.level).join(',');
    if (Object.keys(body).length) be.ok(await be.call('PATCH', '/article', { query: { id: target.id }, body }), `article ${target.title}`);
    return { externalId: ext(target.id) };
  },
  async movePage(cfg, ctx, a) {
    const be = backend(cfg, ctx);
    const { target } = await inside(be, a.root, a.id, true);
    const to = a.to ? waId(a.to, 'destination') : waId(a.root, 'root');
    const dest = await inside(be, a.root, to, false);
    if (to === target.id || dest.ancestors.includes(target.id)) throw new WriteRefused('A page cannot move into itself or its own child', 400);
    const place = placement(dest.target);
    // articleParent null: the article sits straight in the category, not under another article.
    be.ok(await be.call('PATCH', '/article', { query: { id: target.id }, body: { category: place.category, articleParent: place.articleParent } }), `article ${target.title}`);
    return { externalId: ext(target.id) };
  },
  async deletePage(cfg, ctx, a) {
    const be = backend(cfg, ctx);
    const { target } = await inside(be, a.root, a.id, true);
    be.ok(await be.call('DELETE', '/article', { query: { id: target.id } }), `article ${target.title}`);
  },
  async readPage(cfg, ctx, a): Promise<Entry | null> {
    const be = backend(cfg, ctx);
    const { target, root } = await inside(be, a.root, a.id, false);
    if (target.kind !== 'article') return null;
    const world = idIn(root.raw?.world) ?? '';
    return waArticleEntry(target.raw, world, lookups(ctx, cfg), new Map());
  },
  /** Every category of the world: the GM picks one as the WorldLore home. */
  async roots(cfg, ctx) {
    const be = backend(cfg, ctx);
    const world = await worldOf(be, cfg);
    const out: { id: string; title: string; folder: boolean; kind: string }[] = [];
    for (let page = 0; page < 40; page++) {
      const j = be.ok(await be.call('POST', '/world/categories', { query: { id: world }, body: { limit: '50', offset: String(page * 50) } }), 'the category list');
      const list: any[] = Array.isArray(j?.entities) ? j.entities : [];
      for (const c of list) if (UUID.test(String(c?.id ?? ''))) out.push({ id: ext(String(c.id).toLowerCase()), title: String(c.title ?? ''), folder: true, kind: 'category' });
      if (list.length < 50) break;
    }
    return out.sort((x, y) => x.title.localeCompare(y.title));
  },
  async search(cfg, ctx, q) {
    const text = q.trim().toLowerCase().slice(0, 100);
    if (!text) return [];
    return (await waWrite.roots!(cfg, ctx)).filter((r) => r.title.toLowerCase().includes(text)).slice(0, 50);
  },
};

/** The world id: the source's, or found by name or address among the token's worlds. */
async function worldOf(be: Be, cfg: Record<string, any>): Promise<string> {
  const want = String(cfg.worldId ?? '').trim();
  if (UUID.test(want)) return want.toLowerCase();
  const me = be.ok(await be.call('GET', '/identity'), 'the token user');
  const j = be.ok(await be.call('POST', '/user/worlds', { query: { id: String(me?.id ?? '') }, body: { limit: '50', offset: '0' } }), 'your worlds');
  const slug = (/\/w\/([^/?#]+)/.exec(want)?.[1] ?? want).toLowerCase();
  const w = (Array.isArray(j?.entities) ? j.entities : []).find((x: any) => [x.slug, x.title, x.name].map((v) => String(v ?? '').toLowerCase()).includes(slug) || String(x.url ?? '').toLowerCase().includes(`/w/${slug}`));
  if (!w?.id) throw new WriteRefused(`No world called "${want}" among this token's worlds`, 404);
  return String(w.id).toLowerCase();
}
