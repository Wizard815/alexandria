// Write-back for the LegendKeeper connectors, used only by the WorldLore
// workspace (features/worldlore). Two ways in, one set of rules:
//   REST (API key): the v3 API from the OpenAPI spec (create resource, replace
//                   document blocks, PATCH, move, DELETE).
//   MCP:            only create_resource, write_page, update_resource,
//                   move_resource and delete_resource (confirm=true), through
//                   the client registry.workspaceMcpFactory builds.
// Every call first checks, against the source itself, that the page is inside
// the workspace root. Names are never trusted: ids only.
import type { ConnectorContext, ConnectorWrite, WriteLevel } from '../connector.ts';
import { WriteRefused } from '../connector.ts';
import type { Entry } from '../model.ts';
import { jsonOf } from '../../core/mcp.ts';
import { lkBlocks, lkGroups, mcpTransport, pause, restTransport, retryAfterMs } from './legendkeeper.ts';

const LK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const lkId = (v: unknown, what = 'id') => {
  const x = String(v ?? '');
  if (!LK_ID.test(x)) throw new WriteRefused(`Bad ${what}`, 400);
  return x;
};

/** Markdown to LegendKeeper runs: bold, italic, code and links; [[wiki links]] stay plain text. */
export function lkRuns(text: string): any[] {
  const out: any[] = [];
  for (const part of text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\[\[[^\]]+\]\])/)) {
    if (!part) continue;
    let m: RegExpExecArray | null;
    if ((m = /^\*\*(.+)\*\*$/.exec(part))) out.push({ text: m[1], bold: true });
    else if ((m = /^\*(.+)\*$/.exec(part))) out.push({ text: m[1], italic: true });
    else if ((m = /^`(.+)`$/.exec(part))) out.push({ text: m[1], code: true });
    else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part))) out.push(/^https?:/i.test(m[2]) ? { text: m[1], link: m[2] } : { text: m[1] });
    else if ((m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(part))) out.push({ text: m[2] ?? m[1] });
    else out.push({ text: part });
  }
  return out;
}

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;

/** Markdown to LegendKeeper blocks: headings, paragraphs, lists, quotes, > [!secret] callouts, code and rules. */
export function mdToLkBlocks(md: string): any[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: any[] = [];
  const para = (t: string) => ({ kind: 'paragraph', content: lkRuns(t) });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m: RegExpExecArray | null;
    if (!l.trim()) { i++; continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { blocks.push({ kind: 'heading', level: m[1].length, content: lkRuns(m[2].trim()) }); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { blocks.push({ kind: 'rule' }); i++; continue; }
    if (/^```/.test(l)) {
      const lang = l.slice(3).trim();
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      blocks.push({ kind: 'code', ...(lang ? { language: lang } : {}), text: body.join('\n') });
      continue;
    }
    if (/^\s*>/.test(l)) {
      const q: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ''));
      const head = /^\[!(\w+)\][+-]?\s*(.*)$/.exec(q[0] ?? '');
      const rest = head ? [...(head[2] ? [head[2]] : []), ...q.slice(1)] : q;
      const kids = rest.filter((x) => x.trim()).map(para);
      blocks.push(head && /^(secret|gm|dm)$/i.test(head[1]) ? { kind: 'secret', children: kids } : { kind: 'quote', children: kids.length ? kids : [para('')] });
      continue;
    }
    if (LIST_ITEM.test(l)) {
      const ordered = /^\s*\d+[.)]\s+/.test(l);
      const items: any[] = [];
      for (; i < lines.length && LIST_ITEM.test(lines[i]); i++) items.push({ kind: 'listItem', children: [para(lines[i].replace(LIST_ITEM, ''))] });
      blocks.push({ kind: ordered ? 'orderedList' : 'bulletList', children: items });
      continue;
    }
    const buf: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>)/.test(lines[i]) && !LIST_ITEM.test(lines[i]); i++) buf.push(lines[i].trim());
    blocks.push(para(buf.join(' ')));
  }
  return blocks;
}

/** What the write code needs from LegendKeeper, whether it is reached over REST or the MCP server. */
interface LkBackend {
  get(path: string, query?: Record<string, unknown>): Promise<any>;
  create(a: { name: string; parent: string; markdown: string; hidden: boolean }): Promise<string>;
  setContent(id: string, markdown: string): Promise<void>;
  patch(id: string, a: { name?: string; hidden?: boolean }): Promise<void>;
  move(id: string, parent: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** A REST call that changes something, with the same rate-limit handling as reads. */
async function restSend(ctx: ConnectorContext, base: string, key: string, method: string, path: string, body?: unknown): Promise<any> {
  const root = base.replace(/\/$/, '');
  for (let attempt = 0; ; attempt++) {
    const r = await ctx.fetch(root + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctx.signal,
    });
    if (r.status === 429 || r.status === 503) {
      const wait = retryAfterMs(r.headers.get('retry-after')) ?? 2000 * 2 ** attempt;
      if (attempt >= 3 || wait > 60_000) throw new Error('LegendKeeper rate limit hit; try again later');
      await pause(wait, ctx.signal);
      continue;
    }
    if (r.status === 402) throw new Error('LegendKeeper API keys need the project owner on a paid plan');
    if (r.status === 401 || r.status === 403) throw new WriteRefused(`LegendKeeper refused the write (${r.status}): this key cannot write. Use an Admin key.`, 403);
    if (!r.ok) throw new Error(`LegendKeeper ${method} ${path} answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
    if (r.status === 204) return null;
    return r.json().catch(() => null);
  }
}

function restBackend(cfg: Record<string, any>, ctx: ConnectorContext): LkBackend {
  const t = restTransport(ctx, cfg.apiUrl, cfg.apiKey);
  const send = (m: string, p: string, b?: unknown) => restSend(ctx, cfg.apiUrl, cfg.apiKey, m, p, b);
  return {
    get: (p, q) => t.get(p, q),
    async create(a) {
      const r = await send('POST', '/resources', { name: a.name.slice(0, 500), parentId: a.parent, isHidden: a.hidden, documents: [{ type: 'page', name: 'Main', blocks: mdToLkBlocks(a.markdown) }] });
      if (!r?.id) throw new Error('LegendKeeper did not return the new resource');
      return String(r.id);
    },
    async setContent(id, markdown) {
      const detail = await t.get(`/resources/${id}`);
      const docs: any[] = detail.documents ?? [];
      const doc = docs.find((d) => d.type === 'page') ?? docs.find((d) => d.type === 'blank');
      if (!doc) throw new WriteRefused('This resource has no page to write to', 409);
      await send('PUT', `/resources/${id}/docs/${doc.id}/blocks`, { blocks: mdToLkBlocks(markdown) });
    },
    async patch(id, a) { await send('PATCH', `/resources/${id}`, { ...(a.name !== undefined ? { name: a.name.slice(0, 500) } : {}), ...(a.hidden !== undefined ? { isHidden: a.hidden } : {}) }); },
    async move(id, parent) { await send('POST', `/resources/${id}/move`, { parentId: parent }); },
    async remove(id) { await send('DELETE', `/resources/${id}`); },
  };
}

/** The LegendKeeper MCP through the workspace client (registry.workspaceMcpFactory): only its five write tools. */
function mcpBackend(cfg: Record<string, any>, ctx: ConnectorContext): LkBackend {
  const t = mcpTransport(ctx, cfg.project);
  const proj = cfg.project ? { project: cfg.project } : {};
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await ctx.mcp().call(name, { ...args, ...proj });
    if (res.isError) throw new Error(`LegendKeeper ${name}: ${res.text.slice(0, 160)}`);
    return res;
  };
  return {
    get: (p, q) => t.get(p, q),
    async create(a) {
      const res = await tool('create_resource', { name: a.name.slice(0, 500), parent: a.parent, content: a.markdown, is_hidden: a.hidden });
      const j = jsonOf(res);
      const rid = j?.id ?? j?.resource?.id ?? /\bid\b["'\s:=]+([A-Za-z0-9_-]{6,64})/i.exec(res.text)?.[1];
      if (!rid) throw new Error('LegendKeeper did not return the new resource id');
      return String(rid);
    },
    async setContent(id, markdown) { await tool('write_page', { resource: id, markdown, mode: 'replace' }); },
    async patch(id, a) { await tool('update_resource', { resource: id, ...(a.name !== undefined ? { name: a.name.slice(0, 500) } : {}), ...(a.hidden !== undefined ? { is_hidden: a.hidden } : {}) }); },
    async move(id, parent) { await tool('move_resource', { resource: id, new_parent: parent }); },
    async remove(id) { await tool('delete_resource', { resource: id, confirm: true, cascade: false }); },
  };
}

/** The resource as the source has it now. Anything unreadable is refused. */
async function lkDetail(be: LkBackend, id: string): Promise<any> {
  let d: any;
  try { d = await be.get(`/resources/${id}`); } catch (err: any) { throw new WriteRefused(`Could not check ${id} in the source: ${String(err.message).slice(0, 100)}`, 403); }
  if (!d || String(d.id) !== id) throw new WriteRefused('The source did not confirm that page', 403);
  return d;
}

/**
 * The guard: the resource is the root or has the root among its ancestors,
 * as the source says right now (never a cache). `strict` also refuses the
 * root itself (delete, move, rename).
 */
async function lkInside(be: LkBackend, root: string, id: string, strict: boolean): Promise<any> {
  const d = await lkDetail(be, id);
  if (id === root) {
    if (strict) throw new WriteRefused('The workspace root itself cannot be changed here', 403);
    return d;
  }
  if (!(d.ancestors ?? []).some((a: any) => String(a?.id) === root)) throw new WriteRefused('That page is outside the WorldLore workspace', 403);
  return d;
}

const hiddenFor = (level: WriteLevel) => level !== 'party';

function lkWrite(backend: (cfg: Record<string, any>, ctx: ConnectorContext) => LkBackend): ConnectorWrite {
  return {
    async createPage(cfg, ctx, a) {
      const be = backend(cfg, ctx);
      const root = lkId(a.root, 'root');
      const parent = a.parent ? lkId(a.parent, 'parent') : root;
      await lkInside(be, root, parent, false);
      return { externalId: await be.create({ name: a.title, parent, markdown: a.markdown, hidden: hiddenFor(a.level) }) };
    },
    async updatePage(cfg, ctx, a) {
      const be = backend(cfg, ctx);
      const root = lkId(a.root, 'root');
      const id = lkId(a.id);
      await lkInside(be, root, id, true);
      if (a.markdown !== undefined) await be.setContent(id, a.markdown);
      if (a.title !== undefined || a.level !== undefined) await be.patch(id, { name: a.title, hidden: a.level !== undefined ? hiddenFor(a.level) : undefined });
      return { externalId: id };
    },
    async movePage(cfg, ctx, a) {
      const be = backend(cfg, ctx);
      const root = lkId(a.root, 'root');
      const id = lkId(a.id);
      const to = a.to ? lkId(a.to, 'destination') : root;
      await lkInside(be, root, id, true);
      const dest = await lkInside(be, root, to, false);
      if (to === id || (dest.ancestors ?? []).some((x: any) => String(x?.id) === id)) throw new WriteRefused('A page cannot move into itself or its own child', 400);
      await be.move(id, to);
      return { externalId: id };
    },
    async deletePage(cfg, ctx, a) {
      const be = backend(cfg, ctx);
      const root = lkId(a.root, 'root');
      const id = lkId(a.id);
      await lkInside(be, root, id, true);
      await be.remove(id);
    },
    async readPage(cfg, ctx, a) {
      const be = backend(cfg, ctx);
      const root = lkId(a.root, 'root');
      const id = lkId(a.id);
      const r = await lkInside(be, root, id, false);
      const doc = (r.documents ?? []).find((d: any) => d.type === 'page');
      if (!doc) return null;
      const j = await be.get(`/resources/${id}/docs/${doc.id}/blocks`);
      const blocks = lkBlocks(Array.isArray(j?.blocks) ? j.blocks : Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : []);
      return {
        externalId: id,
        parentExternalId: r.parentId ? String(r.parentId) : null,
        folder: (r.ancestors ?? []).map((x: any) => String(x.name)),
        title: String(r.name),
        aliases: (r.aliases ?? []).map(String),
        tags: (r.tags ?? []).map(String),
        type: 'page',
        icon: r.iconGlyph ? { glyph: String(r.iconGlyph), color: r.iconColor ? String(r.iconColor) : undefined } : null,
        banner: null,
        properties: lkGroups(r.properties),
        blocks,
        // The workspace applies the page's level itself; until then it is DM-only.
        visibility: 'dm',
        updatedAt: doc.updatedAt ?? r.updatedAt ?? null,
      } as Entry;
    },
    async roots(cfg, ctx) {
      const be = backend(cfg, ctx);
      const out: { id: string; title: string; folder?: boolean }[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 50; i++) {
        const j = await be.get('/resources', { limit: 100, ...(cursor ? { cursor } : {}) });
        const data = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
        for (const r of data) if (!r.parentId && r.isTemplate !== true) out.push({ id: String(r.id), title: String(r.name), folder: !(r.documents ?? []).length });
        if (!j?.hasMore || !j?.nextCursor) break;
        cursor = String(j.nextCursor);
      }
      return out.sort((x, y) => x.title.localeCompare(y.title));
    },
  };
}

export const lkMcpWrite = lkWrite(mcpBackend);
export const lkRestWrite = lkWrite(restBackend);
