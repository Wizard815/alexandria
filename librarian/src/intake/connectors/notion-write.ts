// Write-back for Notion, used only by the WorldLore workspace (features/worldlore). The workspace root is one Notion page or database
// (the "WorldLore home"); the agent's pages are pages under it. Calls (API 2022-06-28):
//   POST   /pages                       create (parent page or database, title, first 100 blocks)
//   PATCH  /blocks/{id}/children        append the rest of the blocks, 100 at a time
//   PATCH  /pages/{id}                  rename, set the Visibility property, or archive (Notion's trash, which the GM can restore)
//   DELETE /blocks/{id}                 clear the old blocks before new text is written
// Before every write the target and its parents are read FRESH from Notion and the root must be among them. Notion's API cannot move a
// page, so a move is refused with a clear message.
//
// Levels: under a database that has a Visibility select property, the page's level is written there and read back on sync. Under a plain
// page Notion has no field for it: the page stays the GM's in Notion (not published), and the library keeps the level the agent gave.
import type { ConnectorContext, ConnectorWrite } from '../connector.ts';
import { WriteRefused } from '../connector.ts';
import type { Entry } from '../model.ts';
import { levelPlan } from './kanka-write.ts';
import { notionHttp, notionId, notionTitle, readNotion } from './notion.ts';

const MAX_DEPTH = 64;
const MAX_TEXT = 2000; // Notion's limit for one text run

// ---- Markdown to Notion blocks ---------------------------------------------------------------------------

type Rich = { type: 'text'; text: { content: string; link?: { url: string } | null }; annotations?: Record<string, boolean> } | { type: 'mention'; mention: { page: { id: string } } };

/** Inline Markdown to Notion rich text: bold, italic, strike, code, links and [[@notion:<id>|label]] mentions. */
export function mdRich(text: string): Rich[] {
  const out: Rich[] = [];
  const re = /\[\[@notion:([0-9a-f-]{32,36})(?:\|[^\]]*)?\]\]|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|~~([^~]+)~~|(?<![*\w])\*([^*\s][^*]*)\*/g;
  let last = 0;
  const push = (content: string, annotations?: Record<string, boolean>, link?: string) => {
    for (let i = 0; i < content.length; i += MAX_TEXT) out.push({ type: 'text', text: { content: content.slice(i, i + MAX_TEXT), ...(link ? { link: { url: link } } : {}) }, ...(annotations ? { annotations } : {}) });
  };
  for (const m of text.matchAll(re)) {
    if (m.index! > last) push(text.slice(last, m.index));
    if (m[1]) { const id = notionId(m[1]); if (id) out.push({ type: 'mention', mention: { page: { id } } }); }
    else if (m[2]) push(m[2], undefined, m[3]);
    else if (m[4]) push(m[4], { code: true });
    else if (m[5]) push(m[5], { bold: true });
    else if (m[6]) push(m[6], { strikethrough: true });
    else if (m[7]) push(m[7], { italic: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) push(text.slice(last));
  return out.slice(0, 100);
}

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/;
const para = (t: string) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: mdRich(t) } });

/** Markdown to Notion blocks. A > [!secret] (or [!gm], [!broker]...) callout becomes a toggle titled "Secret", which Alexandria reads back as a secret. */
export function mdToNotion(md: string): any[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: any[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m: RegExpExecArray | null;
    if (!l.trim()) { i++; continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { const t = `heading_${Math.min(m[1].length, 3)}`; out.push({ object: 'block', type: t, [t]: { rich_text: mdRich(m[2].trim()) } }); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push({ object: 'block', type: 'divider', divider: {} }); i++; continue; }
    if ((m = /^```(\w*)/.exec(l))) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push({ object: 'block', type: 'code', code: { language: m[1] || 'plain text', rich_text: [{ type: 'text', text: { content: body.join('\n').slice(0, MAX_TEXT) } }] } });
      continue;
    }
    if (/^\s*>/.test(l)) {
      const q: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ''));
      const head = /^\s*\[!([\w -]+)\]\s*(.*)$/.exec(q[0] ?? '');
      if (head) {
        const kids = q.slice(1).filter((x) => x.trim()).map(para).slice(0, 100);
        const secret = !/^(note|info|tip|quote|example|summary|abstract)$/i.test(head[1].trim());
        const title = secret ? `Secret${/^(broker|classified)$/i.test(head[1].trim()) ? ` (${head[1].trim().toLowerCase()})` : ''}${head[2] ? `: ${head[2]}` : ''}` : head[2] || head[1];
        out.push(secret ? { object: 'block', type: 'toggle', toggle: { rich_text: mdRich(title), children: kids } } : { object: 'block', type: 'callout', callout: { rich_text: mdRich(title), children: kids } });
      } else out.push({ object: 'block', type: 'quote', quote: { rich_text: mdRich(q.join('\n')) } });
      continue;
    }
    if ((m = LIST_ITEM.exec(l))) {
      const ordered = /^\s*\d/.test(m[1]);
      if (m[2]) out.push({ object: 'block', type: 'to_do', to_do: { rich_text: mdRich(l.replace(LIST_ITEM, '')), checked: /x/i.test(m[2]) } });
      else { const t = ordered ? 'numbered_list_item' : 'bulleted_list_item'; out.push({ object: 'block', type: t, [t]: { rich_text: mdRich(l.replace(LIST_ITEM, '')) } }); }
      i++;
      continue;
    }
    const buf: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>)/.test(lines[i]) && !LIST_ITEM.test(lines[i]); i++) buf.push(lines[i].trim());
    out.push(para(buf.join(' ')));
  }
  return out;
}

// ---- what the write code needs from Notion ---------------------------------------------------------------

interface Node { id: string; kind: 'page' | 'database'; up: string | null; raw: any }

function backend(cfg: Record<string, any>, ctx: ConnectorContext) {
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await notionHttp(ctx, cfg, method, path, body);
    if (r.status === 401 || r.status === 403) throw new WriteRefused(`Notion refused the request (${r.status}): give the integration "Insert" and "Update content" in notion.so/my-integrations`, 403);
    return r;
  };
  const ok = (r: { status: number; body: any }, what: string) => {
    if (r.status >= 200 && r.status < 300) return r.body;
    if (r.status === 404) throw new WriteRefused(`${what} was not found in Notion (or is not shared with the integration)`, 404);
    if (r.status === 400 || r.status === 409) throw new WriteRefused(`Notion rejected ${what}: ${String(r.body?.message ?? '').slice(0, 160)}`, 400);
    throw new Error(`Notion answered ${r.status} for ${what}`);
  };
  /** The parent id above a page, database or block (a block's own parent is followed to its page). */
  const upOf = async (x: any): Promise<string | null> => {
    let p = x?.parent ?? {};
    for (let i = 0; i < 16; i++) {
      if (p.type === 'page_id') return notionId(p.page_id);
      if (p.type === 'database_id') return notionId(p.database_id);
      if (p.type !== 'block_id') return null; // the workspace
      const b = await call('GET', `/blocks/${notionId(p.block_id)}`);
      if (b.status !== 200) throw new WriteRefused('Notion did not confirm where that page sits', 403);
      p = b.body?.parent ?? {};
    }
    throw new WriteRefused('That page is nested too deep to check', 403);
  };
  const node = async (id: string): Promise<Node> => {
    const r = await call('GET', `/pages/${id}`);
    if (r.status === 200 && notionId(r.body?.id) === id) {
      if (r.body.archived || r.body.in_trash) throw new WriteRefused('That page is in Notion’s trash', 404);
      return { id, kind: 'page', up: await upOf(r.body), raw: r.body };
    }
    const d = await call('GET', `/databases/${id}`);
    if (d.status === 200 && notionId(d.body?.id) === id) return { id, kind: 'database', up: await upOf(d.body), raw: d.body };
    if (r.status === 404 && d.status === 404) throw new WriteRefused('That page was not found in Notion (or is not shared with the integration)', 404);
    throw new WriteRefused('Notion did not confirm that page', 403);
  };
  return { call, ok, node };
}
type Be = ReturnType<typeof backend>;

const nid = (v: unknown, what: string) => { const id = notionId(v); if (!id) throw new WriteRefused(`Bad ${what}`, 400); return id; };

/** The guard: the target is the root, or a page whose parents (as Notion says right now) lead to the root. `strict` (a change to the target itself) refuses the root and databases. */
async function inside(be: Be, rootArg: string, idArg: string, strict: boolean): Promise<{ root: Node; target: Node; ancestors: string[] }> {
  const rootId = nid(rootArg, 'root');
  const id = nid(idArg, 'id');
  const root = await be.node(rootId);
  if (id === rootId) {
    if (strict) throw new WriteRefused('The workspace root itself cannot be changed here', 403);
    return { root, target: root, ancestors: [] };
  }
  const target = await be.node(id);
  // A database inside the root may hold new pages, but is never changed itself.
  if (target.kind !== 'page' && strict) throw new WriteRefused('WorldLore only writes pages in Notion, not databases', 403);
  const ancestors: string[] = [];
  const seen = new Set([id]);
  for (let cur = target, i = 0; cur.up; i++) {
    if (i >= MAX_DEPTH) throw new WriteRefused('That page is nested too deep to check', 403);
    if (seen.has(cur.up)) throw new WriteRefused('The page tree loops; refusing', 403);
    seen.add(cur.up);
    ancestors.push(cur.up);
    if (cur.up === rootId) return { root, target, ancestors };
    cur = await be.node(cur.up);
  }
  throw new WriteRefused('That page is outside the WorldLore workspace', 403);
}

/** The key of a page's title property (it is "title" on plain pages, and whatever the database calls it on rows). */
const titleKey = (raw: any) => Object.entries<any>(raw?.properties ?? {}).find(([, p]) => p?.type === 'title')?.[0] ?? 'title';
/** A database's Visibility select property, when it has one. */
const visKey = (db: any) => Object.entries<any>(db?.properties ?? {}).find(([k, p]) => /^visibility$/i.test(k.trim()) && (p?.type === 'select' || p?.type === 'status'))?.[0] ?? null;

/** The level a write gives the page: what the agent asked, raised by any secret text in the Markdown. */
function levelOf(level: any, markdown: string | undefined): string | undefined {
  const plan = levelPlan(level, markdown);
  return plan.level ?? (plan.isPrivate ? 'gm' : undefined);
}

async function appendBlocks(be: Be, id: string, blocks: any[]) {
  for (let i = 0; i < blocks.length; i += 100) be.ok(await be.call('PATCH', `/blocks/${id}/children`, { children: blocks.slice(i, i + 100) }), 'the page text');
}

async function clearBlocks(be: Be, id: string) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const j = be.ok(await be.call('GET', `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`), 'the page text');
    for (const b of Array.isArray(j?.results) ? j.results : []) if (notionId(b?.id) && b.type !== 'child_page' && b.type !== 'child_database') ids.push(notionId(b.id)!);
    if (!j?.has_more || !j.next_cursor) break;
    cursor = String(j.next_cursor);
  }
  // Child pages stay: they are pages of their own (the agent deletes those itself).
  for (const b of ids) { const r = await be.call('DELETE', `/blocks/${b}`); if (r.status !== 404) be.ok(r, 'an old block'); }
}

export const notionWrite: ConnectorWrite = {
  async createPage(cfg, ctx, a) {
    const be = backend(cfg, ctx);
    const parentId = a.parent ? nid(a.parent, 'parent') : nid(a.root, 'root');
    const { target } = await inside(be, a.root, parentId, false);
    const title = String(a.title ?? '').trim().slice(0, MAX_TEXT);
    if (!title) throw new WriteRefused('Give a title', 400);
    const blocks = mdToNotion(a.markdown ?? '');
    const lv = levelOf(a.level, a.markdown);
    let body: Record<string, any>;
    if (target.kind === 'database') {
      const vk = visKey(target.raw);
      body = { parent: { database_id: target.id }, properties: { [titleKey({ properties: target.raw.properties })]: { title: mdRich(title) }, ...(vk && lv ? { [vk]: { [target.raw.properties[vk].type]: { name: lv } } } : {}) } };
    } else body = { parent: { page_id: target.id }, properties: { title: { title: mdRich(title) } } };
    const made = be.ok(await be.call('POST', '/pages', { ...body, children: blocks.slice(0, 100) }), 'the new page');
    const id = notionId(made?.id);
    if (!id) throw new Error('Notion did not return the new page');
    await appendBlocks(be, id, blocks.slice(100));
    return { externalId: `notion:${id}` };
  },
  async updatePage(cfg, ctx, a) {
    const be = backend(cfg, ctx);
    const { target, ancestors } = await inside(be, a.root, a.id, true);
    const props: Record<string, any> = {};
    if (a.title !== undefined) {
      const title = String(a.title).trim().slice(0, MAX_TEXT);
      if (!title) throw new WriteRefused('Give a title', 400);
      props[titleKey(target.raw)] = { title: mdRich(title) };
    }
    const lv = a.level !== undefined || a.markdown !== undefined ? levelOf(a.level, a.markdown) : undefined;
    if (lv && target.raw?.parent?.type === 'database_id' && notionId(target.raw.parent.database_id) === ancestors[0]) {
      const db = be.ok(await be.call('GET', `/databases/${ancestors[0]}`), 'the database');
      const vk = visKey(db);
      if (vk) props[vk] = { [db.properties[vk].type]: { name: lv } };
    }
    if (Object.keys(props).length) be.ok(await be.call('PATCH', `/pages/${target.id}`, { properties: props }), 'the page');
    if (a.markdown !== undefined) { await clearBlocks(be, target.id); await appendBlocks(be, target.id, mdToNotion(a.markdown)); }
    return { externalId: `notion:${target.id}` };
  },
  async movePage(cfg, ctx, a) {
    const be = backend(cfg, ctx);
    await inside(be, a.root, a.id, true);
    throw new WriteRefused('Notion’s API cannot move pages. Move it in Notion (drag it, or ••• → Move to) and refresh the source.', 400);
  },
  async deletePage(cfg, ctx, a) {
    const be = backend(cfg, ctx);
    const { target } = await inside(be, a.root, a.id, true);
    // Archived pages go to Notion's trash, where the GM can restore them for 30 days.
    be.ok(await be.call('PATCH', `/pages/${target.id}`, { archived: true }), `page ${notionTitle(target.raw)}`);
  },
  async readPage(cfg, ctx, a): Promise<Entry | null> {
    const be = backend(cfg, ctx);
    const { target } = await inside(be, a.root, a.id, false);
    return readNotion(cfg, ctx, target.id, target.kind === 'database' ? { [target.id]: 'd' } : {});
  },
  /** Pages and databases at the top of what the integration sees: the GM picks one as the WorldLore home. */
  async roots(cfg, ctx) {
    return (await find(cfg, ctx, '')).slice(0, 200);
  },
  async search(cfg, ctx, q) {
    const text = q.trim().slice(0, 100);
    return text ? (await find(cfg, ctx, text)).slice(0, 50) : [];
  },
};

async function find(cfg: Record<string, any>, ctx: ConnectorContext, query: string) {
  const be = backend(cfg, ctx);
  const out: { id: string; title: string; folder: boolean; kind: string }[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const j = be.ok(await be.call('POST', '/search', { ...(query ? { query } : {}), page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }), 'the page list');
    for (const x of Array.isArray(j?.results) ? j.results : []) {
      const id = notionId(x?.id);
      if (!id || x.archived || x.in_trash) continue;
      if (!query && x.parent?.type !== 'workspace' && x.parent?.type !== 'page_id') continue;
      out.push({ id: `notion:${id}`, title: notionTitle(x), folder: true, kind: x.object === 'database' ? 'database' : 'page' });
    }
    if (!j?.has_more || !j.next_cursor) break;
    cursor = String(j.next_cursor);
  }
  return out.sort((x, y) => x.title.localeCompare(y.title));
}
