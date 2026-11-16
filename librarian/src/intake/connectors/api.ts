// Any world-building app with a JSON API, over HTTP or through an MCP tool.
// Tell it where the list of records is, how it pages, and which fields hold
// the id, title, body, parent, tags and visibility. Visibility fails closed:
// a record is shared only when its visibility field holds one of the values
// you list as shared.
//
// One list (the older way, set with the fields below) or several: a base URL
// and a list of endpoints, each with a role and its own field mapping (see
// apiEndpoints.ts; the setup in apiSetup.ts guesses them from the app's
// OpenAPI spec or a sample call). It crawls in tiers like the dedicated
// connectors: the list endpoints make the index (title, type, tags, parent,
// an excerpt when the list has one, the whole body when the list carries it),
// and an endpoint's detail path (when mapped) gives whole pages later.
// An endpoint the DM has not assigned is never called.
import type { Connector, ConnectorContext, SyncItem, Tiered } from '../connector.ts';
import { ConfigError } from '../connector.ts';
import { type Block, type Entry, indexBlocks, markdownToBlocks } from '../model.ts';
import { htmlToMarkdown } from '../html.ts';
import { jsonOf } from '../../core/mcp.ts';
import { type ApiEndpoint, ROLE_TYPE, cleanEndpoints, endpointUrl, endpointsOf, pageEndpoints, usedEndpoints } from './apiEndpoints.ts';

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

/** `{world}`, `{project}`... in the list URL and tool arguments. The values come from the source: `world` and a JSON map in `params`. */
export function placeholderValues(cfg: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (cfg.params) { try { const p = typeof cfg.params === 'string' ? JSON.parse(cfg.params) : cfg.params; if (p && typeof p === 'object') for (const [k, v] of Object.entries(p)) if (/^\w{1,40}$/.test(k)) out[k] = String(v); } catch { /* validate() reports it */ } }
  if (cfg.world !== undefined && cfg.world !== '') out.world = String(cfg.world);
  return out;
}
const PLACEHOLDER = /\{(\w{1,40})\}/g;
export const placeholdersIn = (s: unknown): string[] => [...new Set([...String(s ?? '').matchAll(PLACEHOLDER)].map((m) => m[1]))];
/** Fill the placeholders. `url`: values are URL-encoded; otherwise JSON-escaped, for tool arguments. A missing value is left as it is. */
export function fillPlaceholders(text: string, values: Record<string, string>, as: 'url' | 'json' = 'url'): string {
  return String(text).replace(PLACEHOLDER, (m, k) => (k in values ? (as === 'url' ? encodeURIComponent(values[k]) : JSON.stringify(values[k]).slice(1, -1)) : m));
}
/** The settings with placeholders filled in. */
export function resolved(cfg: any): any {
  const v = placeholderValues(cfg);
  return { ...cfg, ...(cfg.url ? { url: fillPlaceholders(cfg.url, v, 'url') } : {}), ...(cfg.baseUrl ? { baseUrl: fillPlaceholders(cfg.baseUrl, v, 'url') } : {}), ...(cfg.toolArgs ? { toolArgs: fillPlaceholders(cfg.toolArgs, v, 'json') } : {}) };
}

/** The older single list, as an endpoint. */
function legacyEndpoint(cfg: any): ApiEndpoint {
  return {
    path: String(cfg.url ?? ''), role: 'pages', use: true, key: '',
    itemsPath: cfg.itemsPath, idField: cfg.idField, titleField: cfg.titleField, bodyField: cfg.bodyField, bodyFormat: cfg.bodyFormat, parentField: cfg.parentField, tagsField: cfg.tagsField,
    typeField: cfg.typeField, updatedField: cfg.updatedField, urlField: cfg.urlField, visibilityField: cfg.visibilityField, sharedValues: cfg.sharedValues,
    paging: cfg.paging, pageParam: cfg.pageParam, nextPath: cfg.nextPath,
  };
}

/** Which endpoints this source reads: the endpoint list (the DM's review), else the one list URL or tool. */
export function activeEndpoints(cfg: any): ApiEndpoint[] {
  const eps = endpointsOf(cfg);
  if (eps.length) return usedEndpoints(eps).map((e) => ({ ...e, path: fillPlaceholders(e.path, placeholderValues(cfg), 'url') }));
  return cfg.transport === 'mcp' || cfg.url ? [legacyEndpoint(cfg)] : [];
}

/** Every page of one list. `since`: the time of the last listing, for an endpoint that can list only what changed. */
async function* listPages(cfg: any, ep: ApiEndpoint, ctx: ConnectorContext, since: string | null): AsyncIterable<any[]> {
  const pageParam = ep.pageParam || 'page';
  const paging = ep.paging ?? 'none';
  if (cfg.transport === 'mcp') {
    const mcp = ctx.mcp();
    const baseArgs = cfg.toolArgs ? JSON.parse(cfg.toolArgs) : {};
    let cursor: any = paging === 'page' ? Number(cfg.pageStart ?? 1) : undefined;
    for (let i = 0; i < 1000; i++) {
      const args = { ...baseArgs, ...(paging === 'page' || (paging === 'cursor' && cursor) ? { [pageParam]: cursor } : {}) };
      await ctx.calls?.take();
      const res = await mcp.call(cfg.tool, args);
      if (res.isError) throw new Error(`${cfg.tool}: ${res.text.slice(0, 160)}`);
      const j = jsonOf(res);
      const items = ep.itemsPath ? pick(j, ep.itemsPath) : j;
      if (!Array.isArray(items)) throw new Error('The tool did not return a list at the items path');
      yield items;
      if (paging === 'page') { if (!items.length) return; cursor += 1; }
      else if (paging === 'cursor') { cursor = pick(j, ep.nextPath); if (!cursor) return; }
      else return;
    }
    return;
  }
  const start = endpointUrl(cfg.baseUrl, ep.path);
  const origin = new URL(start).origin;
  let url: string | null = start;
  let page = Number(cfg.pageStart ?? 1);
  let offset = 0;
  const size = ep.pageSizeParam ? ep.pageSize ?? 100 : 0;
  for (let i = 0; url && i < 1000; i++) {
    const u = new URL(url);
    if (paging === 'page') u.searchParams.set(pageParam, String(page));
    if (paging === 'offset') u.searchParams.set(pageParam, String(offset));
    if (ep.pageSizeParam && size) u.searchParams.set(ep.pageSizeParam, String(size));
    if (since && ep.sinceParam) u.searchParams.set(ep.sinceParam, since);
    await ctx.calls?.take();
    // The token goes only to the host the endpoint list was made for.
    const r = await ctx.fetch(u.toString(), { headers: u.origin === origin ? headers(cfg) : { Accept: 'application/json' }, signal: ctx.signal });
    if (!r.ok) throw new Error(`${u.host} answered ${r.status}`);
    const j: any = await r.json();
    const items = ep.itemsPath ? pick(j, ep.itemsPath) : j;
    if (!Array.isArray(items)) throw new Error('No list at the items path');
    yield items;
    if (paging === 'page') { if (!items.length) return; page += 1; }
    else if (paging === 'offset') { if (!items.length || (size && items.length < size)) return; offset += items.length; }
    else if (paging === 'link') { const next = pick(j, ep.nextPath); url = next ? new URL(String(next), url).toString() : null; }
    else if (paging === 'cursor') { const c = pick(j, ep.nextPath); if (!c) return; const n = new URL(start); n.searchParams.set(pageParam, String(c)); if (ep.pageSizeParam && size) n.searchParams.set(ep.pageSizeParam, String(size)); if (since && ep.sinceParam) n.searchParams.set(ep.sinceParam, since); url = n.toString(); }
    else return;
  }
}

const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v));

/**
 * One record as an entry. Depth: the whole body when the record has one (or
 * the endpoint has nothing deeper to read), an excerpt when only a summary
 * came, otherwise the index line. Visibility fails closed.
 */
export function toEntry(cfg: any, item: any, ctx: ConnectorContext, ep: ApiEndpoint = legacyEndpoint(cfg), opts: { prefix?: string; tagNames?: Map<string, string> } = {}): Entry | null {
  const idv = pick(item, ep.idField || 'id');
  if (idv === undefined || idv === null) return null;
  const shared = String(ep.sharedValues ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const vis = ep.visibilityField ? pick(item, ep.visibilityField) : undefined;
  const isShared = !!ep.visibilityField && shared.includes(String(vis).toLowerCase());
  const tags = pick(item, ep.tagsField);
  const tagList: string[] = Array.isArray(tags) ? tags.map((t) => (typeof t === 'object' ? String(t?.name ?? '') : opts.tagNames?.get(String(t)) ?? String(t))).filter(Boolean) : typeof tags === 'string' ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
  const parent = pick(item, ep.parentField);
  const title = String(pick(item, ep.titleField || 'name') ?? idv);
  const type = ep.typeField ? String(pick(item, ep.typeField) ?? ROLE_TYPE[ep.role] ?? 'page') : ROLE_TYPE[ep.role] ?? 'page';
  const rawBody = ep.bodyField || !ep.summaryField ? pick(item, ep.bodyField || 'body') : undefined;
  const hasBody = rawBody !== undefined && rawBody !== null && String(rawBody).trim() !== '';
  const summary = ep.summaryField ? text(pick(item, ep.summaryField)) : '';
  const deeper = !!ep.detailPath;
  const depth: Entry['depth'] = hasBody || !deeper ? 'full' : summary.trim() ? 'summary' : 'index';
  const folder = ep.folderField ? String(pick(item, ep.folderField) ?? '').split('/').filter(Boolean) : cfg.folderField ? String(pick(item, cfg.folderField) ?? '').split('/').filter(Boolean) : [];
  const updated = ep.updatedField ? String(pick(item, ep.updatedField) ?? '') || null : null;
  const pre = opts.prefix ?? '';
  return {
    externalId: `${pre}${idv}`,
    parentExternalId: parent != null && typeof parent !== 'object' ? `${pre}${parent}` : null,
    folder,
    title,
    tags: tagList,
    type,
    blocks: depth === 'full' ? body(rawBody, ep.bodyFormat || 'markdown') : indexBlocks({ title, type, tags: tagList, folder, summary }),
    visibility: isShared && ctx.shareVisible ? 'party' : 'dm',
    updatedAt: updated,
    sourceUpdatedAt: updated,
    url: ep.urlField ? String(pick(item, ep.urlField) ?? '') || null : cfg.urlField ? String(pick(item, cfg.urlField) ?? '') || null : null,
    depth,
  };
}

/** Names of tags from a `tags` endpoint, for records that list tag ids. */
async function tagNameMap(cfg: any, ctx: ConnectorContext, eps: ApiEndpoint[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const ep of eps.filter((e) => e.role === 'tags')) {
    for await (const items of listPages(cfg, ep, ctx, null)) for (const it of items) { const id = pick(it, ep.idField || 'id'); const name = pick(it, ep.titleField || 'name'); if (id != null && name != null) out.set(String(id), String(name)); }
  }
  return out;
}

const keyPrefix = (eps: ApiEndpoint[], ep: ApiEndpoint) => (eps.length > 1 ? `${ep.key}:` : '');

async function* apiIndex(raw: any, ctx: ConnectorContext): AsyncIterable<SyncItem> {
  const cfg = resolved(raw);
  const all = activeEndpoints(cfg);
  const eps = endpointsOf(cfg).length ? pageEndpoints(all) : all;
  const tagNames = await tagNameMap(cfg, ctx, all);
  const tier = ctx.tier;
  const since = tier && !tier.full && tier.token ? tier.token : null;
  const startedAt = new Date().toISOString();
  let partial = false;
  for (const ep of eps) {
    const inc = since && ep.sinceParam ? since : null;
    if (inc) partial = true;
    for await (const items of listPages(cfg, ep, ctx, inc)) {
      for (const it of items) { const e = toEntry(cfg, it, ctx, ep, { prefix: keyPrefix(eps, ep), tagNames }); if (e) yield e; }
    }
  }
  if (tier) {
    // A listing of only what changed cannot say what was removed.
    tier.complete = !partial;
    tier.next = { token: eps.some((e) => e.sinceParam) ? startedAt : null, cache: { calls: 0 } };
  }
}

async function* apiDetail(raw: any, ctx: ConnectorContext, ids: string[]): AsyncIterable<SyncItem> {
  const cfg = resolved(raw);
  const all = activeEndpoints(cfg);
  const eps = pageEndpoints(all);
  if (cfg.transport === 'mcp') return;
  const tagNames = await tagNameMap(cfg, ctx, all);
  for (const ext of ids) {
    if (ctx.signal.aborted) throw new Error('Sync stopped');
    const ep = eps.length > 1 ? eps.find((e) => ext.startsWith(`${e.key}:`)) : eps[0];
    if (!ep?.detailPath) continue;
    const rawId = eps.length > 1 ? ext.slice(ep.key.length + 1) : ext;
    const url = endpointUrl(cfg.baseUrl, fillPlaceholders(ep.detailPath, { ...placeholderValues(cfg), id: rawId }, 'url'));
    await ctx.calls?.take();
    const origin = new URL(endpointUrl(cfg.baseUrl, ep.path)).origin;
    const r = await ctx.fetch(url, { headers: new URL(url).origin === origin ? headers(cfg) : { Accept: 'application/json' }, signal: ctx.signal });
    if (r.status === 404) continue;
    if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
    const j: any = await r.json();
    const item = ep.detailItemPath ? pick(j, ep.detailItemPath) : j && typeof j.data === 'object' && !Array.isArray(j.data) ? j.data : j;
    // The detail is the whole record: it counts as full even if the list had an excerpt only.
    const e = toEntry(cfg, item, ctx, { ...ep, detailPath: undefined }, { prefix: keyPrefix(eps, ep), tagNames });
    if (e) yield e;
  }
}

export const genericApi: Connector = {
  id: 'api',
  label: 'Any JSON API (REST or MCP tool)',
  description: 'Imports records from any world-building app with a JSON API. Let Alexandria find the endpoints and guess the fields, or map one list yourself; pages, tags, parents and visibility come across.',
  capabilities: ['pages', 'tags'],
  fields: [
    { key: 'transport', label: 'How to reach it', type: 'select', options: [['http', 'HTTP (REST)'], ['mcp', 'An MCP tool']], default: 'http' },
    { key: 'baseUrl', label: 'Base URL', type: 'url', showIf: { transport: 'http' }, placeholder: 'https://api.example.com/v1', help: 'With a base URL Alexandria looks for the app\'s OpenAPI spec and guesses its endpoints (Admin > Connections > Find endpoints). The list URL below is the older way, for one list.' },
    { key: 'endpoints', label: 'Endpoints (JSON)', type: 'textarea', showIf: { transport: 'http' }, help: 'Filled in by the endpoint review. Endpoints not marked used are never called.' },
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
    { key: 'idField', label: 'Id field', type: 'text', placeholder: 'id' },
    { key: 'titleField', label: 'Title field', type: 'text', placeholder: 'name' },
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
    { key: 'world', label: 'Value for {world}', type: 'text', help: 'If the list URL or the tool arguments contain {world}, this world\'s value goes there (a campaign or project id, for example).' },
    { key: 'params', label: 'Other placeholder values (JSON)', type: 'textarea', placeholder: '{"project": "42"}', help: 'Values for any other {name} in the URL or tool arguments.' },
  ],
  validate(raw) {
    if (raw.params) { try { const p = typeof raw.params === 'string' ? JSON.parse(raw.params) : raw.params; if (!p || typeof p !== 'object' || Array.isArray(p)) throw 0; } catch { throw new ConfigError('Other placeholder values must be a JSON object'); } }
    let eps: ApiEndpoint[] = [];
    if (raw.endpoints) eps = cleanEndpoints(raw.endpoints);
    const missing = [...new Set([...placeholdersIn(raw.url), ...placeholdersIn(raw.baseUrl), ...eps.filter((e) => e.use).flatMap((e) => placeholdersIn(e.path)), ...placeholdersIn(raw.toolArgs)])].filter((k) => !(k in placeholderValues(raw)));
    if (missing.length) throw new ConfigError(`Give a value for ${missing.map((k) => `{${k}}`).join(', ')}`);
    const cfg = resolved(raw);
    if ((cfg.transport ?? 'http') === 'http') {
      if (eps.length) {
        if (!/^https?:\/\/\S+$/.test(String(cfg.baseUrl ?? '')) && eps.some((e) => e.use && !/^https?:\/\//i.test(e.path))) throw new ConfigError('Base URL must start with http:// or https://');
        if (!pageEndpoints(eps).length) throw new ConfigError('No endpoint is marked as used. Mark at least one endpoint as pages, people, places, items, organisations or events.');
      } else if (!/^https?:\/\/\S+$/.test(String(cfg.url ?? ''))) throw new ConfigError('List URL must start with http:// or https://');
    } else {
      if (!/^[\w.-]{1,80}$/.test(String(cfg.tool ?? ''))) throw new ConfigError('Name the list tool');
      if (!cfg.server && !cfg.mcpUrl) throw new ConfigError('Give a local MCP server name or an MCP URL');
      if (cfg.toolArgs) try { JSON.parse(cfg.toolArgs); } catch { throw new ConfigError('Tool arguments must be JSON'); }
    }
    if (cfg.paging && !['none', 'page', 'link', 'cursor'].includes(cfg.paging)) throw new ConfigError('Unknown paging');
    if ((cfg.paging === 'link' || cfg.paging === 'cursor') && !cfg.nextPath && !eps.length) throw new ConfigError('Say where the next link or cursor is');
    if (!eps.length) { if (!cfg.idField) throw new ConfigError('Id field is required'); if (!cfg.titleField) throw new ConfigError('Title field is required'); }
  },
  async test(raw, ctx) {
    const cfg = resolved(raw);
    const ep = pageEndpoints(activeEndpoints(cfg).map((e) => ({ ...e, paging: 'none' as const })))[0] ?? activeEndpoints(cfg)[0];
    if (!ep) return { ok: false, message: 'No endpoint is marked as used' };
    for await (const items of listPages(cfg, { ...ep, paging: 'none' }, ctx, null)) {
      const sample = items.slice(0, 3).map((i) => toEntry(cfg, i, ctx, ep)).filter(Boolean).map((e) => ({ id: e!.externalId, title: e!.title, visibility: e!.visibility, blocks: e!.blocks.length, depth: e!.depth }));
      return { ok: true, message: `Got ${items.length} records on the first page.`, sample };
    }
    return { ok: false, message: 'No records' };
  },
  async *sync(raw, ctx) {
    const cfg = resolved(raw);
    const used = activeEndpoints(cfg);
    const all = endpointsOf(cfg).length ? pageEndpoints(used) : used;
    const tagNames = await tagNameMap(cfg, ctx, used);
    for (const ep of all) for await (const items of listPages(cfg, ep, ctx, null)) for (const it of items) { const e = toEntry(cfg, it, ctx, ep, { prefix: keyPrefix(all, ep), tagNames }); if (e) yield e; }
  },
  tiered: (cfg): Tiered | null => {
    const eps = activeEndpoints(resolved(cfg));
    if (!eps.length) return null;
    // Unknown limits: stay gentle.
    return { budgetPerMinute: 30, index: (c, ctx) => apiIndex(c, ctx), detail: (c, ctx, ids) => apiDetail(c, ctx, ids) };
  },
  readTools: (cfg) => (cfg.tool ? [String(cfg.tool)] : []),
  mcpConfig: (cfg) => (cfg.server ? { transport: 'stdio', server: cfg.server } : { transport: 'http', url: cfg.mcpUrl, token: cfg.mcpToken }),
};
