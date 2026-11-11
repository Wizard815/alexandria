// Any world-building app with a JSON API, over HTTP or through an MCP tool.
// Tell it where the list of records is, how it pages, and which fields hold
// the id, title, body, parent, tags and visibility. Visibility fails closed:
// a record is shared only when its visibility field holds one of the values
// you list as shared.
import type { Connector, ConnectorContext } from '../connector.ts';
import { ConfigError } from '../connector.ts';
import { type Block, type Entry, markdownToBlocks } from '../model.ts';
import { htmlToMarkdown } from '../html.ts';
import { jsonOf } from '../../core/mcp.ts';

/** Read a dotted path like "data.items" or "attributes.name" from an object. */
export function pick(obj: any, p: string | undefined): any {
  if (!p) return undefined;
  return p.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : Array.isArray(o) && /^\d+$/.test(k) ? o[Number(k)] : o[k]), obj);
}

function body(v: any, fmt: string): Block[] {
  if (v === null || v === undefined) return [];
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  if (fmt === 'html') return markdownToBlocks(htmlToMarkdown(s));
  if (fmt === 'text') return s.split(/\n{2,}/).filter(Boolean).map((t) => ({ kind: 'paragraph', content: [{ text: t }] }));
  return markdownToBlocks(s);
}

function headers(cfg: any): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (cfg.token) h[cfg.authHeader || 'Authorization'] = (cfg.authHeader && cfg.authHeader !== 'Authorization' ? '' : 'Bearer ') + cfg.token;
  return h;
}

async function* pages(cfg: any, ctx: ConnectorContext): AsyncIterable<any[]> {
  const pageParam = cfg.pageParam || 'page';
  if (cfg.transport === 'mcp') {
    const mcp = ctx.mcp();
    const baseArgs = cfg.toolArgs ? JSON.parse(cfg.toolArgs) : {};
    let cursor: any = cfg.paging === 'page' ? Number(cfg.pageStart ?? 1) : undefined;
    for (let i = 0; i < 1000; i++) {
      const args = { ...baseArgs, ...(cfg.paging === 'page' || (cfg.paging === 'cursor' && cursor) ? { [pageParam]: cursor } : {}) };
      const res = await mcp.call(cfg.tool, args);
      if (res.isError) throw new Error(`${cfg.tool}: ${res.text.slice(0, 160)}`);
      const j = jsonOf(res);
      const items = cfg.itemsPath ? pick(j, cfg.itemsPath) : j;
      if (!Array.isArray(items)) throw new Error('The tool did not return a list at the items path');
      yield items;
      if (cfg.paging === 'page') { if (!items.length) return; cursor += 1; }
      else if (cfg.paging === 'cursor') { cursor = pick(j, cfg.nextPath); if (!cursor) return; }
      else return;
    }
    return;
  }
  let url: string | null = cfg.url;
  let page = Number(cfg.pageStart ?? 1);
  for (let i = 0; url && i < 1000; i++) {
    const u = new URL(url);
    if (cfg.paging === 'page') u.searchParams.set(pageParam, String(page));
    const r = await ctx.fetch(u.toString(), { headers: headers(cfg), signal: ctx.signal });
    if (!r.ok) throw new Error(`${u.host} answered ${r.status}`);
    const j: any = await r.json();
    const items = cfg.itemsPath ? pick(j, cfg.itemsPath) : j;
    if (!Array.isArray(items)) throw new Error('No list at the items path');
    yield items;
    if (cfg.paging === 'page') { if (!items.length) return; page += 1; }
    else if (cfg.paging === 'link') { const next = pick(j, cfg.nextPath); url = next ? new URL(String(next), url).toString() : null; }
    else if (cfg.paging === 'cursor') { const c = pick(j, cfg.nextPath); if (!c) return; const n = new URL(cfg.url); n.searchParams.set(pageParam, String(c)); url = n.toString(); }
    else return;
  }
}

function toEntry(cfg: any, item: any, ctx: ConnectorContext): Entry | null {
  const idv = pick(item, cfg.idField || 'id');
  if (idv === undefined || idv === null) return null;
  const shared = String(cfg.sharedValues ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const vis = cfg.visibilityField ? pick(item, cfg.visibilityField) : undefined;
  const isShared = !!cfg.visibilityField && shared.includes(String(vis).toLowerCase());
  const tags = pick(item, cfg.tagsField);
  return {
    externalId: String(idv),
    parentExternalId: pick(item, cfg.parentField) != null ? String(pick(item, cfg.parentField)) : null,
    folder: cfg.folderField ? String(pick(item, cfg.folderField) ?? '').split('/').filter(Boolean) : [],
    title: String(pick(item, cfg.titleField || 'name') ?? idv),
    tags: Array.isArray(tags) ? tags.map((t) => String(typeof t === 'object' ? t?.name ?? '' : t)).filter(Boolean) : typeof tags === 'string' ? tags.split(',').map((t) => t.trim()) : [],
    type: cfg.typeField ? String(pick(item, cfg.typeField) ?? 'page') : 'page',
    blocks: body(pick(item, cfg.bodyField || 'body'), cfg.bodyFormat || 'markdown'),
    visibility: isShared && ctx.shareVisible ? 'party' : 'dm',
    updatedAt: cfg.updatedField ? String(pick(item, cfg.updatedField) ?? '') || null : null,
    url: cfg.urlField ? String(pick(item, cfg.urlField) ?? '') || null : null,
  };
}

export const genericApi: Connector = {
  id: 'api',
  label: 'Any JSON API (REST or MCP tool)',
  description: 'Imports records from any world-building app with a JSON API. Map the fields once; pages, tags, parents and visibility come across.',
  fields: [
    { key: 'transport', label: 'How to reach it', type: 'select', options: [['http', 'HTTP (REST)'], ['mcp', 'An MCP tool']], default: 'http' },
    { key: 'url', label: 'List URL', type: 'url', showIf: { transport: 'http' }, placeholder: 'https://api.example.com/v1/worlds/42/articles' },
    { key: 'token', label: 'API token', type: 'password', secret: true, showIf: { transport: 'http' } },
    { key: 'authHeader', label: 'Token header', type: 'text', showIf: { transport: 'http' }, placeholder: 'Authorization (Bearer)' },
    { key: 'server', label: 'Local MCP server name', type: 'text', showIf: { transport: 'mcp' }, help: 'From ALX_MCP_STDIO. Or set an MCP URL below.' },
    { key: 'mcpUrl', label: 'MCP URL', type: 'url', showIf: { transport: 'mcp' } },
    { key: 'mcpToken', label: 'MCP token', type: 'password', secret: true, showIf: { transport: 'mcp' } },
    { key: 'tool', label: 'List tool', type: 'text', showIf: { transport: 'mcp' }, help: 'A tool that returns records as JSON.' },
    { key: 'toolArgs', label: 'Tool arguments (JSON)', type: 'textarea', showIf: { transport: 'mcp' }, placeholder: '{"type": "article"}' },
    { key: 'paging', label: 'Paging', type: 'select', options: [['none', 'One response has everything'], ['page', 'Page numbers'], ['link', 'Next-page link in the response'], ['cursor', 'Cursor in the response']], default: 'none' },
    { key: 'pageParam', label: 'Page or cursor parameter', type: 'text', placeholder: 'page' },
    { key: 'nextPath', label: 'Where the next link or cursor is', type: 'text', placeholder: 'links.next' },
    { key: 'itemsPath', label: 'Where the list is', type: 'text', placeholder: 'data' },
    { key: 'idField', label: 'Id field', type: 'text', placeholder: 'id', required: true },
    { key: 'titleField', label: 'Title field', type: 'text', placeholder: 'name', required: true },
    { key: 'bodyField', label: 'Body field', type: 'text', placeholder: 'content' },
    { key: 'bodyFormat', label: 'Body format', type: 'select', options: [['markdown', 'Markdown'], ['html', 'HTML'], ['text', 'Plain text']], default: 'markdown' },
    { key: 'parentField', label: 'Parent id field', type: 'text' },
    { key: 'folderField', label: 'Folder path field', type: 'text', help: 'e.g. "Places/Towns"' },
    { key: 'tagsField', label: 'Tags field', type: 'text' },
    { key: 'typeField', label: 'Type field', type: 'text' },
    { key: 'updatedField', label: 'Updated-at field', type: 'text' },
    { key: 'urlField', label: 'Link-back field', type: 'text' },
    { key: 'visibilityField', label: 'Visibility field', type: 'text', placeholder: 'is_private', help: 'Records are DM-only unless this field holds a shared value.' },
    { key: 'sharedValues', label: 'Values that mean shared', type: 'text', placeholder: 'false, public, players' },
  ],
  validate(cfg) {
    if ((cfg.transport ?? 'http') === 'http') { if (!/^https?:\/\/\S+$/.test(String(cfg.url ?? ''))) throw new ConfigError('List URL must start with http:// or https://'); }
    else {
      if (!/^[\w.-]{1,80}$/.test(String(cfg.tool ?? ''))) throw new ConfigError('Name the list tool');
      if (!cfg.server && !cfg.mcpUrl) throw new ConfigError('Give a local MCP server name or an MCP URL');
      if (cfg.toolArgs) try { JSON.parse(cfg.toolArgs); } catch { throw new ConfigError('Tool arguments must be JSON'); }
    }
    if (cfg.paging && !['none', 'page', 'link', 'cursor'].includes(cfg.paging)) throw new ConfigError('Unknown paging');
    if ((cfg.paging === 'link' || cfg.paging === 'cursor') && !cfg.nextPath) throw new ConfigError('Say where the next link or cursor is');
  },
  async test(cfg, ctx) {
    for await (const items of pages({ ...cfg, paging: 'none' }, ctx)) {
      const sample = items.slice(0, 3).map((i) => toEntry(cfg, i, ctx)).filter(Boolean).map((e) => ({ id: e!.externalId, title: e!.title, visibility: e!.visibility, blocks: e!.blocks.length }));
      return { ok: true, message: `Got ${items.length} records on the first page.`, sample };
    }
    return { ok: false, message: 'No records' };
  },
  async *sync(cfg, ctx) {
    for await (const items of pages(cfg, ctx)) for (const it of items) { const e = toEntry(cfg, it, ctx); if (e) yield e; }
  },
  readTools: (cfg) => (cfg.tool ? [String(cfg.tool)] : []),
  mcpConfig: (cfg) => (cfg.server ? { transport: 'stdio', server: cfg.server } : { transport: 'http', url: cfg.mcpUrl, token: cfg.mcpToken }),
};
