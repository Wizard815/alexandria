// LegendKeeper, through its MCP server (read tools only) or its REST v3 API.
// Pages keep their LegendKeeper layout: the document blocks map one to one
// onto Alexandria blocks, sidebar properties become the property bar, and
// mentions stay links. Hidden is inherited from hidden folders and documents.
import type { Connector, ConnectorContext } from '../connector.ts';
import { ConfigError } from '../connector.ts';
import type { Block, Entry, Inline, PropertyGroup } from '../model.ts';
import { jsonOf } from '../../core/mcp.ts';

interface Transport { get(path: string, query?: Record<string, unknown>): Promise<any> }

function mcpTransport(ctx: ConnectorContext, project?: string): Transport {
  const mcp = ctx.mcp();
  return {
    async get(path, query) {
      const res = await mcp.call('api_request', { method: 'GET', path, ...(query ? { query } : {}), ...(project ? { project } : {}) });
      const j = jsonOf(res);
      if (res.isError || j === null) throw new Error(`LegendKeeper ${path}: ${res.text.slice(0, 160)}`);
      return j;
    },
  };
}

function restTransport(ctx: ConnectorContext, base: string, key: string): Transport {
  const root = base.replace(/\/$/, '');
  return {
    async get(path, query) {
      const qs = query ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))).toString() : '';
      const r = await ctx.fetch(root + path + qs, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: ctx.signal });
      if (r.status === 429) throw new Error('LegendKeeper rate limit hit; try again in a minute');
      if (!r.ok) throw new Error(`LegendKeeper ${path} answered ${r.status}`);
      return r.json();
    },
  };
}

function inline(c: any[] = []): Inline[] {
  return c.map((x) => {
    if (x?.mention) return { mention: { ref: String(x.mention.resourceId ?? ''), ...(x.mention.name ? { name: String(x.mention.name) } : {}), ...(x.mention.text ? { text: String(x.mention.text) } : {}) } };
    const o: Inline = { text: String(x?.text ?? '') };
    if (x?.bold) o.bold = true;
    if (x?.italic) o.italic = true;
    if (x?.code) o.code = true;
    if (x?.strike || x?.strikethrough) o.strike = true;
    if (x?.underline) o.underline = true;
    if (typeof x?.link === 'string') o.link = x.link;
    else if (typeof x?.href === 'string') o.link = x.href;
    return o;
  }).filter((x) => x.mention || x.text);
}

export function lkGroups(rows: any[] = []): PropertyGroup[] {
  return rows.filter((g) => g?.kind === 'keyValue' || Array.isArray(g?.rows)).map((g) => ({
    title: String(g.title ?? 'Facts'),
    rows: (g.rows ?? []).map((r: any) => ({ key: String(r.key ?? ''), value: inline(r.content ?? (r.text ? [{ text: r.text }] : [])) })),
  }));
}

/** LegendKeeper document blocks to Alexandria blocks. Unknown kinds stay unknown (DM-only). */
export function lkBlocks(bs: any[] = []): Block[] {
  return bs.map((b): Block | null => {
    const kids = () => lkBlocks(b.children ?? []);
    switch (b?.kind) {
      case 'heading': return { kind: 'heading', level: Number(b.level) || 2, content: inline(b.content) };
      case 'paragraph': return { kind: 'paragraph', content: inline(b.content) };
      case 'bulletList': return { kind: 'bulletList', children: kids() };
      case 'orderedList': return { kind: 'orderedList', children: kids(), ...(b.start ? { start: Number(b.start) } : {}) };
      case 'taskList': return { kind: 'bulletList', children: kids() };
      case 'listItem':
      case 'taskItem': return { kind: 'listItem', children: kids(), ...(typeof b.checked === 'boolean' ? { checked: b.checked } : {}) };
      case 'table': return { kind: 'table', children: kids() };
      case 'tableRow': return { kind: 'tableRow', children: kids() };
      case 'tableCell':
      case 'tableHeader': return { kind: 'tableCell', header: b.kind === 'tableHeader' || !!b.header, children: kids() };
      case 'secret': return { kind: 'secret', children: kids() };
      case 'callout': {
        const variant = String(b.variant ?? b.calloutType ?? b.type ?? b.style ?? 'note').toLowerCase();
        return { kind: 'callout', variant, ...(b.title ? { title: Array.isArray(b.title) ? inline(b.title) : [{ text: String(b.title) }] } : {}), children: kids() };
      }
      case 'toggle':
      case 'details':
      case 'expand': return { kind: 'toggle', title: Array.isArray(b.title) ? inline(b.title) : [{ text: String(b.title ?? b.summary ?? 'More') }], children: kids() };
      case 'blockquote':
      case 'quote': return { kind: 'blockquote', children: kids() };
      case 'codeBlock':
      case 'code': return { kind: 'codeBlock', language: b.language ?? undefined, text: String(b.text ?? (b.content ?? []).map((x: any) => x.text ?? '').join('')) };
      case 'horizontalRule':
      case 'divider': return { kind: 'divider' };
      case 'image': {
        const url = b.url ?? b.src ?? b.asset?.url;
        return typeof url === 'string' && /^https?:/i.test(url) ? { kind: 'image', url, ...(b.alt ? { alt: String(b.alt) } : {}), ...(b.width ? { width: Number(b.width) } : {}), ...(b.caption ? { caption: inline(b.caption) } : {}) } : { kind: 'unsupported', sourceKind: 'image (no url)' };
      }
      case 'infobox': return { kind: 'infobox', layout: b.layout ?? 'wrapRight', width: Number(b.width) || 40, groups: lkGroups(b.rows) };
      case 'resourceCollection': return { kind: 'collection', title: b.isTitleHidden ? undefined : b.title, filter: b.filter };
      default: return { kind: 'unsupported', sourceKind: String(b?.kind ?? 'unknown') };
    }
  }).filter((b): b is Block => !!b && !(b.kind === 'paragraph' && !b.content.length));
}

async function* lkSync(t: Transport, ctx: ConnectorContext): AsyncIterable<Entry> {
  // 1. Every resource, by cursor.
  const all: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const j = await t.get('/resources', { limit: 100, ...(cursor ? { cursor } : {}) });
    const data = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : null;
    if (!data) throw new Error('LegendKeeper /resources returned no list');
    all.push(...data);
    if (!j.hasMore || !j.nextCursor) break;
    cursor = String(j.nextCursor);
  }
  ctx.log(`Listed ${all.length} resources`);
  const byId = new Map<string, any>(all.map((r) => [String(r.id), r]));
  const memo = new Map<string, boolean>();
  const hidden = (rid: string, depth = 0): boolean => {
    if (memo.has(rid)) return memo.get(rid)!;
    const r = byId.get(rid);
    // Not listed, or no explicit isHidden=false: fail closed.
    const h = !r || depth > 64 || r.isHidden !== false || (r.parentId ? hidden(String(r.parentId), depth + 1) : false);
    memo.set(rid, h);
    return h;
  };

  for (const r of all) {
    if (ctx.signal.aborted) throw new Error('Sync stopped');
    if (r.isTemplate === true) continue;
    const pages = (r.documents ?? []).filter((d: any) => d.type === 'page');
    if (!pages.length) continue;
    let detail: any;
    try {
      detail = await t.get(`/resources/${r.id}`);
    } catch (err: any) {
      ctx.log(`Skipped ${r.name}: ${err.message}`);
      continue;
    }
    const folder = (detail.ancestors ?? []).map((a: any) => String(a.name));
    const props = lkGroups(detail.properties);
    for (const d of pages) {
      const dd = (detail.documents ?? []).find((x: any) => x.id === d.id) ?? d;
      let doc: any;
      try {
        doc = await t.get(`/resources/${r.id}/docs/${d.id}/blocks`);
      } catch (err: any) {
        ctx.log(`Skipped ${r.name} / ${d.name}: ${err.message}`);
        continue;
      }
      const raw = Array.isArray(doc?.blocks) ? doc.blocks : Array.isArray(doc?.data) ? doc.data : Array.isArray(doc) ? doc : [];
      const multi = pages.length > 1;
      const isHidden = hidden(String(r.id)) || dd.isHidden !== false;
      yield {
        externalId: multi && d !== pages[0] ? `${r.id}#${d.id}` : String(r.id),
        parentExternalId: multi && d !== pages[0] ? String(r.id) : r.parentId ? String(r.parentId) : null,
        folder,
        title: multi && d.name && d.name !== 'Main' ? `${r.name} · ${d.name}` : String(r.name),
        aliases: (r.aliases ?? []).map(String),
        tags: (r.tags ?? []).map(String),
        type: (r.tags ?? []).find((x: string) => ['pc', 'npc', 'town', 'city', 'region', 'item', 'session', 'creature', 'kaiju', 'lore', 'group', 'heart'].includes(x)) ?? 'page',
        icon: r.iconGlyph ? { glyph: String(r.iconGlyph), color: r.iconColor ? String(r.iconColor) : undefined } : null,
        banner: typeof detail.banner?.url === 'string' ? detail.banner.url : typeof detail.bannerUrl === 'string' ? detail.bannerUrl : null,
        properties: d === pages[0] ? props : [],
        blocks: lkBlocks(raw),
        visibility: !isHidden && ctx.shareVisible ? 'party' : 'dm',
        updatedAt: dd.updatedAt ?? r.updatedAt ?? null,
      };
    }
  }
}

const lkFields = [
  { key: 'project', label: 'Project (world) name', type: 'text' as const, help: 'Only if the server has more than one project.' },
];

export const legendkeeperMcp: Connector = {
  id: 'legendkeeper-mcp',
  label: 'LegendKeeper (MCP server)',
  description: 'Reads a LegendKeeper world through the LegendKeeper MCP server. Keeps page layout, sidebar facts, links, secrets and hidden folders.',
  aliases: ['mcp:legendkeeper'],
  fields: [
    { key: 'transport', label: 'Connection', type: 'select', options: [['http', 'HTTP URL'], ['stdio', 'Local server (ALX_MCP_STDIO)']], default: 'http' },
    { key: 'url', label: 'MCP URL', type: 'url', placeholder: 'http://legendkeeper-mcp:8000/mcp', showIf: { transport: 'http' }, required: true },
    { key: 'token', label: 'MCP token', type: 'password', secret: true, showIf: { transport: 'http' } },
    { key: 'server', label: 'Local server name', type: 'text', showIf: { transport: 'stdio' } },
    ...lkFields,
  ],
  validate(cfg) {
    if (cfg.transport === 'stdio') { if (!/^[\w-]{1,40}$/.test(String(cfg.server ?? ''))) throw new ConfigError('Pick the local server name from ALX_MCP_STDIO'); }
    else if (!/^https?:\/\/\S+$/.test(String(cfg.url ?? ''))) throw new ConfigError('MCP URL must start with http:// or https://');
  },
  async test(cfg, ctx) {
    const t = mcpTransport(ctx, cfg.project);
    const j = await t.get('/resources', { limit: 5 });
    return { ok: true, message: `Connected. First resources: ${(j.data ?? []).map((r: any) => r.name).join(', ')}`, sample: (j.data ?? []).map((r: any) => r.name) };
  },
  sync: (cfg, ctx) => lkSync(mcpTransport(ctx, cfg.project), ctx),
  readTools: () => ['api_request'],
};

export const legendkeeperApi: Connector = {
  id: 'legendkeeper-api',
  label: 'LegendKeeper (API key)',
  description: 'Reads a LegendKeeper project directly with a LegendKeeper API key. Same result as the MCP connector, no MCP server needed.',
  fields: [
    { key: 'apiUrl', label: 'Project API URL', type: 'url', required: true, placeholder: 'https://…/v3/projects/<project id>', help: 'The REST v3 base for your project, from LegendKeeper’s developer settings.' },
    { key: 'apiKey', label: 'API key', type: 'password', secret: true, required: true, help: 'A read-only key if you can make one.' },
  ],
  validate(cfg) {
    if (!/^https:\/\/\S+$/.test(String(cfg.apiUrl ?? ''))) throw new ConfigError('API URL must start with https://');
    if (String(cfg.apiKey ?? '').length < 10) throw new ConfigError('API key is required');
  },
  async test(cfg, ctx) {
    const j = await restTransport(ctx, cfg.apiUrl, cfg.apiKey).get('/resources', { limit: 5 });
    return { ok: true, message: `Connected. First resources: ${(j.data ?? []).map((r: any) => r.name).join(', ')}` };
  },
  sync: (cfg, ctx) => lkSync(restTransport(ctx, cfg.apiUrl, cfg.apiKey), ctx),
};
