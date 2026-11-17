// LegendKeeper, through its MCP server (read tools only) or its REST v3 API.
// Pages keep their LegendKeeper layout: the document blocks map one to one
// onto Alexandria blocks, sidebar properties become the property bar, and
// mentions stay links. Hidden is inherited from hidden folders and documents.
import type { CalendarDefinition, Connector, ConnectorContext, SyncItem, SyncRecord, Tiered, TimelineGroup } from '../connector.ts';
import { ConfigError, isRecord } from '../connector.ts';
import { type Block, type Entry, type Inline, type PropertyGroup, indexBlocks } from '../model.ts';
import { jsonOf } from '../../core/mcp.ts';
import { pictureRecord } from '../images.ts';
import { levelOfWord } from '../../core/levels.ts';

/** Where LegendKeeper's own files live: a map picture from here is fetched like any other site (never from a private address). */
const LK_ORIGIN = 'https://www.legendkeeper.com';

export interface Transport { get(path: string, query?: Record<string, unknown>): Promise<any> }

export function mcpTransport(ctx: ConnectorContext, project?: string): Transport {
  const mcp = ctx.mcp();
  return {
    async get(path, query) {
      await ctx.calls?.take();
      const res = await mcp.call('api_request', { method: 'GET', path, ...(query ? { query } : {}), ...(project ? { project } : {}) });
      const j = jsonOf(res);
      if (res.isError || j === null) throw new Error(`LegendKeeper ${path}: ${res.text.slice(0, 160)}`);
      return j;
    },
  };
}

/** Waits, but stops early when the sync is stopped. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Sync stopped'));
    const t = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(t); reject(new Error('Sync stopped')); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

/** Seconds from a Retry-After header (seconds or an HTTP date), or null. */
export function retryAfterMs(h: string | null | undefined): number | null {
  if (!h) return null;
  if (/^\d+(\.\d+)?$/.test(h.trim())) return Math.round(Number(h) * 1000);
  const at = Date.parse(h);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

// REST v3: https://www.legendkeeper.com/api/v3/projects/<projectId>, Bearer key.
// 429 RATE_LIMITED carries Retry-After; waits up to a minute, three times.
export function restTransport(ctx: ConnectorContext, base: string, key: string): Transport {
  const root = base.replace(/\/$/, '');
  return {
    async get(path, query) {
      const qs = query ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))).toString() : '';
      for (let attempt = 0; ; attempt++) {
        await ctx.calls?.take();
        const r = await ctx.fetch(root + path + qs, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: ctx.signal });
        if (r.status === 429 || r.status === 503) {
          const wait = retryAfterMs(r.headers.get('retry-after')) ?? 2000 * 2 ** attempt;
          if (attempt >= 3 || wait > 60_000) throw new Error('LegendKeeper rate limit hit; try again later');
          await pause(wait, ctx.signal);
          continue;
        }
        if (r.status === 402) throw new Error('LegendKeeper API keys need the project owner on a paid plan');
        if (!r.ok) throw new Error(`LegendKeeper ${path} answered ${r.status}`);
        return r.json();
      }
    },
  };
}

/** A mention's ref: the resource id, plus the document id when the mention names one (the library falls back to the resource's first page). */
const mentionRef = (resourceId: unknown, documentId?: unknown) => (documentId ? `${resourceId}#${documentId}` : String(resourceId ?? ''));

function inline(c: any[] = []): Inline[] {
  return (Array.isArray(c) ? c : []).map((x): Inline => {
    if (x?.mention) return { mention: { ref: mentionRef(x.mention.resourceId, x.mention.documentId), ...(x.mention.name ? { name: String(x.mention.name) } : {}), ...(x.mention.text ? { text: String(x.mention.text) } : {}) } };
    if (x?.break === true) return { text: '\n' };
    // Icon runs ({ icon }) carry no text.
    const o: Inline = { text: String(x?.text ?? '') };
    if (x?.bold) o.bold = true;
    if (x?.italic) o.italic = true;
    if (x?.code) o.code = true;
    if (x?.strike || x?.strikethrough) o.strike = true;
    if (x?.underline) o.underline = true;
    const href = typeof x?.link === 'string' ? x.link : typeof x?.href === 'string' ? x.href : null;
    if (href) {
      // A link mark to another LegendKeeper page (lk://resources/<id>) is a mention; other links must be http, https or mailto.
      const ref = lkLinkRef(href);
      if (ref) return { mention: { ref, ...(o.text ? { text: o.text } : {}) } };
      if (/^(https?:|mailto:)/i.test(href.trim())) o.link = href.trim();
    }
    return o;
  }).filter((x) => x.mention || x.text);
}

/** lk://resources/<id>[/docs/<doc>] as a mention ref, or null. */
function lkLinkRef(uri: string): string | null {
  const m = /^lk:\/\/resources\/([^/?#]+)(?:\/docs\/([^/?#]+))?/i.exec(uri.trim());
  return m ? mentionRef(m[1], m[2]) : null;
}

/** Image properties (a portrait in the sidebar or an infobox) as image blocks; a hidden one is wrapped as a DM-only secret. */
export function lkImageBlocks(props: any[] = []): Block[] {
  const out: Block[] = [];
  for (const g of Array.isArray(props) ? props : []) {
    if (g?.kind !== 'image' || typeof g.url !== 'string' || !/^https?:/i.test(g.url)) continue;
    const img: Block = { kind: 'image', url: g.url, ...(g.alt ? { alt: String(g.alt) } : {}), ...(titleOf(g) ? { caption: [{ text: titleOf(g)! }] } : {}) };
    out.push(g.isHidden !== false ? { kind: 'secret', children: [img] } : img);
  }
  return out;
}

const mentionList = (items: any[] = []): Inline[] => (Array.isArray(items) ? items : []).filter((i) => i?.resourceId)
  .flatMap((i, n) => [...(n ? [{ text: ', ' }] : []), { mention: { ref: String(i.resourceId) } }]);

/** Text of player-safe blocks only: secret and unknown subtrees are skipped. */
function safeInline(bs: any[] = []): Inline[] {
  const out: Inline[] = [];
  const walk = (list: any[]) => {
    for (const b of Array.isArray(list) ? list : []) {
      if (['paragraph', 'heading', 'taskItem'].includes(b?.kind)) {
        const c = inline(b.content);
        if (c.length) { if (out.length) out.push({ text: ' ' }); out.push(...c); }
      } else if (['bulletList', 'orderedList', 'taskList', 'listItem', 'quote', 'callout', 'layout', 'layoutColumn', 'textField'].includes(b?.kind)) walk(b.children);
    }
  };
  walk(bs);
  return out;
}

/** Rows of one LegendKeeper property (sidebar or infobox), by kind. */
function propertyRows(g: any) {
  const kind = g?.kind ?? (Array.isArray(g?.rows) ? 'keyValue' : undefined);
  switch (kind) {
    case 'keyValue': return (Array.isArray(g.rows) ? g.rows : []).map((r: any) => ({ key: String(r?.key ?? ''), value: inline(Array.isArray(r?.content) && r.content.length ? r.content : r?.text ? [{ text: r.text }] : []) }));
    case 'textField': { const v = safeInline(g.children); return v.length ? [{ key: '', value: v }] : []; }
    case 'resourceLink': { const v = mentionList(g.items); return v.length ? [{ key: '', value: v }] : []; }
    case 'meter': return (Array.isArray(g.items) ? g.items : []).map((i: any) => ({ key: String(i?.name ?? ''), value: [{ text: `${Number(i?.current ?? 0)} / ${Number(i?.max ?? 0)}` }] }));
    default: return []; // image, embed, map, resourceCollection, unsupported
  }
}

/**
 * LegendKeeper PropertyBlocks (sidebar `properties`, infobox `rows`) to groups.
 * `isHidden` marks a GM-only property; anything but an explicit false is DM-only.
 */
export function lkGroups(props: any[] = []): PropertyGroup[] {
  const out: PropertyGroup[] = [];
  for (const g of Array.isArray(props) ? props : []) {
    const rows = propertyRows(g);
    if (!rows.length) continue;
    const group: PropertyGroup = { title: String(g.title ?? (g.kind === 'textField' ? 'Text' : 'Facts')), rows };
    if (g.isHidden !== false) group.dm = true;
    // A group titled Broker or Classified carries that level (it is also found by its title).
    const named = levelOfWord(group.title);
    if (named) group.level = named;
    out.push(group);
  }
  return out;
}

/** A secret block: dm level, or broker / classified when its first words say so. */
function secretBlock(children: Block[]): Block {
  const first = children[0];
  if (first && (first.kind === 'paragraph' || first.kind === 'heading')) {
    const text = first.content.map((x) => x.text ?? x.mention?.text ?? x.mention?.name ?? '').join('').trim();
    const m = /^(broker|classified)\s*:\s*/i.exec(text);
    if (m) {
      // Take the label off the first words (it may sit in the first text run).
      let cut = m[0].length;
      const content: Inline[] = [];
      for (const run of first.content) {
        if (cut > 0 && run.text !== undefined && !run.mention) {
          const lead = run.text.length - run.text.trimStart().length;
          const take = Math.min(cut + lead, run.text.length);
          const rest = run.text.slice(take);
          cut -= Math.max(0, take - lead);
          if (rest) content.push({ ...run, text: rest });
        } else content.push(run);
      }
      const level = m[1].toLowerCase() as 'broker' | 'classified';
      return { kind: 'secret', level, children: [content.length ? { ...first, content } : null, ...children.slice(1)].filter((x): x is Block => !!x) };
    }
  }
  return { kind: 'secret', children };
}

const titleOf = (b: any) => (typeof b?.title === 'string' && b.title && b.isTitleHidden === false ? b.title : undefined);

/**
 * LegendKeeper document blocks (OpenAPI `Block`, schema 1) to Alexandria blocks.
 * Layout rows and text fields are flattened; unknown kinds become `unsupported`,
 * which the leak guard drops.
 */
export function lkBlocks(bs: any[] = []): Block[] {
  return (Array.isArray(bs) ? bs : []).flatMap((b): Block[] => {
    const kids = () => lkBlocks(b.children ?? []);
    switch (b?.kind) {
      case 'heading': return [{ kind: 'heading', level: Math.min(Math.max(Number(b.level) || 2, 1), 6), content: inline(b.content) }];
      case 'paragraph': return [{ kind: 'paragraph', content: inline(b.content) }];
      case 'bulletList': return [{ kind: 'bulletList', children: kids() }];
      case 'orderedList': return [{ kind: 'orderedList', children: kids(), ...(b.start ? { start: Number(b.start) } : {}) }];
      case 'taskList': return [{ kind: 'bulletList', children: kids() }];
      case 'listItem': return [{ kind: 'listItem', children: kids(), ...(typeof b.checked === 'boolean' ? { checked: b.checked } : {}) }];
      // A task item holds runs, not children.
      case 'taskItem': return [{ kind: 'listItem', children: Array.isArray(b.content) ? [{ kind: 'paragraph', content: inline(b.content) }] : kids(), checked: b.checked === true }];
      case 'table': return [{ kind: 'table', children: kids() }];
      case 'tableRow': return [{ kind: 'tableRow', children: kids() }];
      case 'tableCell':
      case 'tableHeader': return [{ kind: 'tableCell', header: b.kind === 'tableHeader' || !!b.header, children: kids() }];
      // A secret block whose first words are "BROKER:" or "CLASSIFIED:" is broker or classified level; the label is dropped.
      case 'secret': return [secretBlock(kids())];
      case 'callout': {
        const variant = String(b.tone ?? b.variant ?? b.calloutType ?? b.type ?? b.style ?? 'note').toLowerCase();
        return [{ kind: 'callout', variant, ...(b.title ? { title: Array.isArray(b.title) ? inline(b.title) : [{ text: String(b.title) }] } : {}), children: kids() }];
      }
      case 'toggle':
      case 'details':
      case 'expand': return [{ kind: 'toggle', title: Array.isArray(b.title) ? inline(b.title) : [{ text: String(b.title ?? b.summary ?? 'More') }], children: kids() }];
      case 'blockquote':
      case 'quote': return [{ kind: 'blockquote', children: kids() }];
      case 'codeBlock':
      case 'code': return [{ kind: 'codeBlock', language: b.language ?? undefined, text: String(b.text ?? (b.content ?? []).map((x: any) => x.text ?? '').join('')) }];
      case 'horizontalRule':
      case 'rule':
      case 'divider': return [{ kind: 'divider' }];
      // Columns: the page model has none, so their blocks follow one another.
      case 'layout':
      case 'layoutColumn': return kids();
      case 'textField': {
        const t = titleOf(b);
        return [...(t ? [{ kind: 'heading', level: 3, content: [{ text: t }] } as Block] : []), ...kids()];
      }
      case 'image': {
        const url = b.url ?? b.src ?? b.asset?.url;
        return [typeof url === 'string' && /^https?:/i.test(url) ? { kind: 'image', url, ...(b.alt ? { alt: String(b.alt) } : {}), ...(b.width ? { width: Number(b.width) } : {}), ...(b.caption ? { caption: inline(b.caption) } : titleOf(b) ? { caption: [{ text: titleOf(b)! }] } : {}) } : { kind: 'unsupported', sourceKind: 'image (no url)' }];
      }
      case 'embed': return typeof b.url === 'string' && /^https?:/i.test(b.url) ? [{ kind: 'paragraph', content: [{ text: titleOf(b) ?? `${b.provider ?? 'Embed'}`, link: b.url }] }] : [];
      case 'infobox': return [...lkImageBlocks(b.rows), { kind: 'infobox', layout: b.layout ?? 'wrapRight', width: Number(b.width) || 40, groups: lkGroups(b.rows) }];
      case 'keyValue': return [{ kind: 'infobox', layout: b.layout ?? 'default', width: Number(b.width) || 100, groups: [{ title: String(b.title ?? 'Stats'), rows: propertyRows({ kind: 'keyValue', rows: b.rows }) }] }];
      case 'meter': {
        const rows = propertyRows(b);
        return rows.length ? [{ kind: 'infobox', layout: b.layout ?? 'default', width: Number(b.width) || 100, groups: [{ title: String(b.title ?? 'Meter'), rows }] }] : [];
      }
      case 'resourceLink': {
        const items = (Array.isArray(b.items) ? b.items : []).filter((i: any) => i?.resourceId);
        return items.length ? [
          ...(titleOf(b) ? [{ kind: 'heading', level: 3, content: [{ text: titleOf(b)! }] } as Block] : []),
          { kind: 'bulletList', children: items.map((i: any): Block => ({ kind: 'listItem', children: [{ kind: 'paragraph', content: [{ mention: { ref: String(i.resourceId) } }] }] })) },
        ] : [];
      }
      case 'resourceCollection': return [{ kind: 'collection', title: b.isTitleHidden ? undefined : b.title, filter: b.filter }];
      // A map block inside a page is a link to a map document: kept as a link to that page.
      case 'map': return b.resourceId ? [{ kind: 'paragraph', content: [{ mention: { ref: mentionRef(b.resourceId, b.documentId), text: typeof b.title === 'string' && b.title ? b.title : 'Map' } }] }] : [];
      // Unsupported (opaque) blocks stay unknown.
      default: return [{ kind: 'unsupported', sourceKind: String(b?.kind ?? 'unknown') }];
    }
  }).filter((b) => !(b.kind === 'paragraph' && !b.content.length));
}

/**
 * Tree order of every resource, as LegendKeeper shows it: siblings by `rank`
 * compared as plain strings (the docs say not to use a locale comparison),
 * resources with no rank last, then by name. The position is the place in a
 * depth-first walk, so siblings keep their relative order and it does not
 * change when something unrelated is edited.
 */
export function lkPositions(all: any[]): Map<string, number> {
  const ids = new Set(all.map((r) => String(r.id)));
  const kids = new Map<string, any[]>();
  for (const r of all) {
    const parent = r.parentId && ids.has(String(r.parentId)) && String(r.parentId) !== String(r.id) ? String(r.parentId) : '';
    (kids.get(parent) ?? kids.set(parent, []).get(parent)!).push(r);
  }
  const cmp = (a: any, b: any) => {
    const ra = typeof a.rank === 'string' && a.rank ? a.rank : null;
    const rb = typeof b.rank === 'string' && b.rank ? b.rank : null;
    if (ra !== rb) return ra === null ? 1 : rb === null ? -1 : ra < rb ? -1 : 1;
    return String(a.name ?? '').localeCompare(String(b.name ?? '')) || String(a.id).localeCompare(String(b.id));
  };
  const pos = new Map<string, number>();
  let n = 0;
  const walk = (parent: string, depth: number) => {
    for (const r of (kids.get(parent) ?? []).sort(cmp)) {
      if (pos.has(String(r.id)) || depth > 64) continue;
      pos.set(String(r.id), n++);
      walk(String(r.id), depth + 1);
    }
  };
  walk('', 0);
  return pos;
}

/** The page's address in the LegendKeeper app: the source's template ({project}, {id}, {doc}), or the default one. */
export function lkUrl(cfg: Record<string, any>, resourceId: string, docId?: string): string | null {
  const project = String(cfg.projectId || /\/projects\/([^/?#]+)/.exec(String(cfg.apiUrl ?? ''))?.[1] || '').trim();
  const tpl = String(cfg.webUrl || LK_WEB_URL).trim();
  if (!project && tpl.includes('{project}')) return null;
  const out = tpl.replace(/\{project\}/g, encodeURIComponent(project)).replace(/\{id\}/g, encodeURIComponent(resourceId)).replace(/\{doc\}/g, encodeURIComponent(docId ?? ''));
  return /^https?:\/\/\S+$/i.test(out) ? out : null;
}
export const LK_WEB_URL = 'https://www.legendkeeper.com/app/project/{project}/resource/{id}';

/** Every resource of the project, by cursor (100 a call). */
async function lkListResources(t: Transport, ctx: ConnectorContext): Promise<any[]> {
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
  return all;
}

const LK_TYPE_TAGS = ['pc', 'npc', 'town', 'city', 'region', 'item', 'session', 'creature', 'kaiju', 'lore', 'group', 'heart'];
const lkType = (r: any, d: any) => (d.type === 'map' ? 'map' : (r.tags ?? []).find((x: string) => LK_TYPE_TAGS.includes(x)) ?? 'page');

/** A page's external id, title and parent: the same from a list item and from a detail. */
function lkIdentity(r: any, pages: any[], d: any) {
  const multi = pages.length > 1;
  const first = d === pages[0];
  return {
    externalId: multi && !first ? `${r.id}#${d.id}` : String(r.id),
    parentExternalId: multi && !first ? String(r.id) : r.parentId ? String(r.parentId) : null,
    title: multi && d.name && d.name !== 'Main' ? `${r.name} · ${d.name}` : String(r.name),
    first, multi,
  };
}

/** What is kept between listings: each resource's parent, hidden flag and tree position, so one page can be read alone later. */
const lkCache = (all: any[], positions: Map<string, number>) => ({ res: Object.fromEntries(all.map((r) => [String(r.id), [r.parentId ? String(r.parentId) : '', r.isHidden === false ? 0 : 1, positions.get(String(r.id)) ?? -1]])) });
const lkFromCache = (cache: Record<string, any> | null | undefined) => {
  const byId = new Map<string, any>();
  const positions = new Map<string, number>();
  for (const [id, v] of Object.entries((cache?.res ?? {}) as Record<string, [string, number, number]>)) {
    byId.set(id, { id, parentId: v[0] || null, isHidden: v[1] === 0 ? false : true });
    if (v[2] >= 0) positions.set(id, v[2]);
  }
  return { byId, positions };
};

/**
 * Everything that reads one resource: its hidden state, its permissions, and its pages and timelines as entries.
 * `byId` holds the list items (or what the last listing left in the cache) for the hidden-folder rule.
 */
function lkSession(t: Transport, ctx: ConnectorContext, cfg: Record<string, any>, byId: Map<string, any>, positions: Map<string, number>) {
  const memo = new Map<string, boolean>();
  const hidden = (rid: string, depth = 0): boolean => {
    if (memo.has(rid)) return memo.get(rid)!;
    const r = byId.get(rid);
    // Not listed, or no explicit isHidden=false: fail closed.
    const h = !r || depth > 64 || r.isHidden !== false || (r.parentId ? hidden(String(r.parentId), depth + 1) : false);
    memo.set(rid, h);
    return h;
  };

  // Resource detail (documents with isHidden, properties, permissions), once each.
  const details = new Map<string, Promise<any | null>>();
  const detailOf = (rid: string) => {
    if (!details.has(rid)) details.set(rid, t.get(`/resources/${rid}`).catch((err: any) => { ctx.log(`Could not read ${byId.get(rid)?.name ?? rid}: ${err.message}`); return null; }));
    return details.get(rid)!;
  };
  // Resource permissions: { MEMBER | ADMIN | OWNER | <user id>: 0..5 }, 0 = No Access.
  // A No Access entry for players (the MEMBER role or any one user) on the
  // resource or any ancestor keeps it from the party. An unreadable detail or
  // an unknown level counts as no access.
  const denied = new Map<string, Promise<boolean>>();
  const deniesPlayers = (rid: string, depth = 0): Promise<boolean> => {
    if (!denied.has(rid)) denied.set(rid, (async () => {
      if (depth > 64) return true;
      const d = await detailOf(rid);
      const perms = d?.permissions;
      if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return true;
      for (const [who, level] of Object.entries(perms)) {
        if (who === 'ADMIN' || who === 'OWNER') continue;
        if (![1, 2, 3, 4, 5].includes(level as number)) return true;
      }
      const parent = byId.get(rid)?.parentId ?? d?.parentId;
      return parent ? deniesPlayers(String(parent), depth + 1) : false;
    })());
    return denied.get(rid)!;
  };

  /** Pages, maps and timelines of one resource. `r` is a list item or a resource detail. */
  async function* entriesFor(r: any): AsyncIterable<SyncItem> {
    if (ctx.signal.aborted) throw new Error('Sync stopped');
    if (r.isTemplate === true) return;
    // Pages and maps become pages of their own; timelines become records.
    const pages = (r.documents ?? []).filter((d: any) => d.type === 'page' || d.type === 'map');
    const timelines = (r.documents ?? []).filter((d: any) => d.type === 'time');
    if (!pages.length && !timelines.length) return;
    const detail = await detailOf(String(r.id));
    if (!detail) { ctx.log(`Skipped ${r.name}`); return; }
    const restricted = hidden(String(r.id)) || await deniesPlayers(String(r.id));
    const folder = (detail.ancestors ?? []).map((a: any) => String(a.name));
    const props = lkGroups(detail.properties);
    const sideImages = lkImageBlocks(detail.properties);
    // Extra tabs follow their page, in the order LegendKeeper ranks the tabs.
    const tabRank = (id: string) => String((detail.documents ?? []).find((x: any) => x.id === id)?.rank ?? '');
    const tabOrder = pages.map((d: any) => String(d.id)).sort((a: string, b: string) => (tabRank(a) < tabRank(b) ? -1 : tabRank(a) > tabRank(b) ? 1 : 0));
    for (const d of pages) {
      const dd = (detail.documents ?? []).find((x: any) => x.id === d.id) ?? d;
      const idn = lkIdentity(r, pages, d);
      const isHidden = restricted || dd.isHidden !== false;
      let blocks: Block[];
      if (d.type === 'map') {
        try {
          blocks = [await lkMapBlock(t, ctx, r, dd, hidden)];
        } catch (err: any) {
          ctx.log(`Skipped ${r.name} / ${d.name}: ${err.message}`);
          continue;
        }
      } else {
        let doc: any;
        try {
          doc = await t.get(`/resources/${r.id}/docs/${d.id}/blocks`);
        } catch (err: any) {
          ctx.log(`Skipped ${r.name} / ${d.name}: ${err.message}`);
          continue;
        }
        blocks = lkBlocks(Array.isArray(doc?.blocks) ? doc.blocks : Array.isArray(doc?.data) ? doc.data : Array.isArray(doc) ? doc : []);
        if (d === pages[0] && sideImages.length) blocks = [...sideImages, ...blocks];
      }
      yield {
        externalId: idn.externalId,
        parentExternalId: idn.parentExternalId,
        folder,
        title: idn.title,
        aliases: (r.aliases ?? []).map(String),
        tags: (r.tags ?? []).map(String),
        type: lkType(r, d),
        icon: r.iconGlyph ? { glyph: String(r.iconGlyph), color: r.iconColor ? String(r.iconColor) : undefined } : null,
        banner: typeof detail.banner?.url === 'string' && detail.banner.enabled !== false ? detail.banner.url : typeof detail.bannerUrl === 'string' ? detail.bannerUrl : null,
        properties: idn.first ? props : [],
        blocks,
        position: positions.has(String(r.id)) ? positions.get(String(r.id))! + (idn.first ? 0 : (1 + tabOrder.indexOf(String(d.id))) / (pages.length + 1)) : null,
        url: lkUrl(cfg, String(r.id), String(d.id)),
        visibility: !isHidden && ctx.shareVisible ? 'party' : 'dm',
        updatedAt: dd.updatedAt ?? r.updatedAt ?? null,
        sourceUpdatedAt: r.updatedAt ?? detail.updatedAt ?? null,
        depth: 'full',
      };
      // A map document's image is kept as a map of its page (shared only with the page).
      const mapUrl = d.type === 'map' ? (dd.mapImage?.url ?? d.mapImage?.url) : null;
      if (typeof mapUrl === 'string' && /^https?:\/\//i.test(mapUrl)) {
        const rec = await pictureRecord(ctx, { externalId: `${idn.externalId}#mapimg`, pageRef: idn.externalId, name: idn.title, url: mapUrl, updated: dd.updatedAt ?? r.updatedAt ?? null, visible: !isHidden && ctx.shareVisible, map: true, origin: LK_ORIGIN });
        if (rec) yield rec;
      }
    }
    for (const d of timelines) {
      const dd = (detail.documents ?? []).find((x: any) => x.id === d.id) ?? d;
      const shared = !(restricted || dd.isHidden !== false) && ctx.shareVisible;
      try {
        yield await lkTimeline(t, r, d, dd, pages.length + timelines.length > 1, shared);
      } catch (err: any) {
        if (ctx.signal.aborted) throw err;
        ctx.log(`Skipped timeline ${r.name} / ${d.name}: ${err.message}`);
        ctx.incomplete?.add('timeline');
      }
    }
  }
  return { hidden, detailOf, entriesFor, seed: (rid: string, d: any) => details.set(rid, Promise.resolve(d)) };
}

async function* lkCalendars(t: Transport, ctx: ConnectorContext): AsyncIterable<SyncItem> {
  // Calendars belong to the project. LegendKeeper has no hidden flag for them, so they stay DM-only.
  try {
    const j = await t.get('/calendars');
    for (const c of Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : []) {
      if (!c?.id || !c?.name) continue;
      yield { kind: 'calendar', externalId: String(c.id), name: String(c.name), visibility: 'dm', definition: lkCalendar(c), current: null } satisfies SyncRecord;
    }
  } catch (err: any) {
    if (ctx.signal.aborted) throw err;
    ctx.log(`Could not read calendars: ${err.message}`);
    ctx.incomplete?.add('calendar');
  }
}

/** The eager sync: everything, details included. Used when the whole project is wanted at once. */
async function* lkSync(t: Transport, ctx: ConnectorContext, cfg: Record<string, any> = {}): AsyncIterable<SyncItem> {
  const all = await lkListResources(t, ctx);
  const byId = new Map<string, any>(all.map((r) => [String(r.id), r]));
  const session = lkSession(t, ctx, cfg, byId, lkPositions(all));
  for (const r of all) yield* session.entriesFor(r);
  yield* lkCalendars(t, ctx);
}

/**
 * Tier 1: the resource list (100 a call), the calendars, and the timelines.
 * Every page of the tree exists at once with its title, type, tags, parent,
 * folder path and updated time. Permissions are in the resource detail only,
 * so a page at index depth is DM-only until its details are read (fail closed).
 */
async function* lkIndex(t: Transport, ctx: ConnectorContext, cfg: Record<string, any> = {}): AsyncIterable<SyncItem> {
  const all = await lkListResources(t, ctx);
  const byId = new Map<string, any>(all.map((r) => [String(r.id), r]));
  const positions = lkPositions(all);
  const session = lkSession(t, ctx, cfg, byId, positions);
  const prevCache = ctx.tier?.cache ?? null;
  if (ctx.tier) { ctx.tier.complete = true; ctx.tier.next = { token: null, cache: lkCache(all, positions) }; }
  const chain = (rid: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let p = byId.get(rid)?.parentId; p && byId.has(String(p)) && !seen.has(String(p)) && out.length < 64; p = byId.get(String(p))?.parentId) { seen.add(String(p)); out.unshift(String(byId.get(String(p)).name ?? '')); }
    return out;
  };
  for (const r of all) {
    if (ctx.signal.aborted) throw new Error('Sync stopped');
    if (r.isTemplate === true) continue;
    const pages = (r.documents ?? []).filter((d: any) => d.type === 'page' || d.type === 'map');
    const restricted = session.hidden(String(r.id));
    for (const d of pages) {
      const idn = lkIdentity(r, pages, d);
      const folder = chain(String(r.id));
      const tags = (r.tags ?? []).map(String);
      const type = lkType(r, d);
      yield {
        externalId: idn.externalId, parentExternalId: idn.parentExternalId, folder, title: idn.title,
        aliases: (r.aliases ?? []).map(String), tags, type,
        icon: r.iconGlyph ? { glyph: String(r.iconGlyph), color: r.iconColor ? String(r.iconColor) : undefined } : null,
        blocks: indexBlocks({ title: idn.title, type, tags, folder }),
        position: positions.has(String(r.id)) ? positions.get(String(r.id))! + (idn.first ? 0 : 0.5) : null,
        url: lkUrl(cfg, String(r.id), String(d.id)),
        // Who may read it is in the detail (permissions): until it is read, DM only.
        visibility: 'dm', restricted,
        updatedAt: r.updatedAt ?? null, sourceUpdatedAt: r.updatedAt ?? null, depth: 'index',
      };
    }
  }
  // Timelines: lane and event lists are list calls too, read when the resource changed (or was never read).
  const seenTl = (prevCache?.tl ?? {}) as Record<string, string>;
  const nextTl: Record<string, string> = {};
  let skipped = false;
  for (const r of all) {
    if (r.isTemplate === true) continue;
    const timelines = (r.documents ?? []).filter((d: any) => d.type === 'time');
    if (!timelines.length) continue;
    const stamp = String(r.updatedAt ?? '');
    if (stamp && seenTl[r.id] === stamp) { nextTl[r.id] = stamp; skipped = true; continue; }
    const before = ctx.incomplete.has('timeline');
    for await (const x of session.entriesFor({ ...r, documents: timelines })) { if (!isRecord(x)) continue; yield x; }
    if (!before && !ctx.incomplete.has('timeline')) nextTl[r.id] = stamp;
  }
  if (skipped) ctx.incomplete.add('timeline');
  if (ctx.tier) ctx.tier.next.cache = { ...(ctx.tier.next.cache ?? {}), tl: nextTl };
  yield* lkCalendars(t, ctx);
}

/** Tier 3: whole pages for these ids (resource ids, or `resource#document`). One detail call per resource, one blocks call per document. */
async function* lkDetail(t: Transport, ctx: ConnectorContext, cfg: Record<string, any>, ids: string[]): AsyncIterable<SyncItem> {
  const { byId, positions } = lkFromCache(ctx.tier?.cache);
  const session = lkSession(t, ctx, cfg, byId, positions);
  for (const rid of [...new Set(ids.map((x) => x.split('#')[0]))]) {
    if (ctx.signal.aborted) throw new Error('Sync stopped');
    let detail: any;
    try { detail = await t.get(`/resources/${rid}`); } catch (err: any) { if (/answered 404/.test(String(err.message))) continue; throw err; }
    // The detail is the resource itself: its own hidden flag and parent are fresher than the cache.
    byId.set(rid, { ...(byId.get(rid) ?? {}), id: rid, parentId: detail.parentId ?? null, isHidden: detail.isHidden });
    session.seed(rid, detail);
    for await (const x of session.entriesFor(detail)) { if (isRecord(x) && x.kind !== 'image') continue; yield x; }
  }
}

/** LegendKeeper calendar to the world clock's definition. Leap rules and month intervals are not carried over. */
export function lkCalendar(c: any): CalendarDefinition {
  const perDay = Math.max(1, (Number(c.hoursInDay) || 24) * (Number(c.minutesInHour) || 60));
  const era = Array.isArray(c.positiveEras) ? c.positiveEras.find((e: any) => e?.abbr && e.hideAbbr !== true) : null;
  return {
    name: String(c.name),
    epochYear: c.hasZeroYear === true ? 0 : 1,
    ...(era ? { yearSuffix: String(era.abbr) } : {}),
    months: (Array.isArray(c.months) ? c.months : []).map((m: any) => ({ name: String(m?.name ?? ''), days: Math.max(1, Number(m?.length) || 30), ...(m?.isIntercalary ? { intercalary: true } : {}) })),
    weekdays: (Array.isArray(c.weekdays) ? c.weekdays : []).map((w: any) => String(w?.name ?? '')),
    moons: (Array.isArray(c.moons) ? c.moons : []).filter((m: any) => m?.name).map((m: any) => ({ name: String(m.name), cycleDays: (Number(m.phase) || perDay * 28) / perDay, offsetDays: (Number(m.shift) || 0) / perDay })),
  };
}

/** The resource id in a lk://resources/<id>[/docs/<id>] link, or null. */
const lkRef = (uri: unknown) => /^lk:\/\/resources\/([^/?#]+)/.exec(String(uri ?? ''))?.[1] ?? null;

/** Every page of a cursor-paged list. */
async function lkList(t: Transport, path: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 200; i++) {
    const j = await t.get(path, { limit: 100, ...(cursor ? { cursor } : {}) });
    out.push(...(Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : []));
    if (!j?.hasMore || !j?.nextCursor) break;
    cursor = String(j.nextCursor);
  }
  return out;
}

/** A map document as one block: its image and its pins. Hidden pins, and pins under hidden folders or on hidden pages, are marked DM-only. */
async function lkMapBlock(t: Transport, ctx: ConnectorContext, r: any, doc: any, hiddenResource: (rid: string) => boolean): Promise<Block> {
  const features = (await t.get(`/resources/${r.id}/docs/${doc.id}/features`).then((j) => (Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : []))) as any[];
  const byId = new Map<string, any>(features.map((f) => [String(f.id), f]));
  const hiddenFeature = (f: any, depth = 0): boolean => f.isHidden !== false || (depth > 32 ? true : f.parentId ? (byId.has(String(f.parentId)) ? hiddenFeature(byId.get(String(f.parentId)), depth + 1) : true) : false);
  const pins = features.filter((f) => f.type === 'pin' && Array.isArray(f.pos) && f.pos.length === 2 && Number.isFinite(Number(f.pos[0])) && Number.isFinite(Number(f.pos[1]))).map((f) => {
    const ref = lkRef(f.uri);
    return {
      name: String(f.name ?? ref ?? 'Pin'), lat: Number(f.pos[0]), lng: Number(f.pos[1]),
      ...(f.iconGlyph ? { type: String(f.iconGlyph) } : {}), ...(ref ? { ref } : {}),
      // Hidden pin, or a pin for a page that is hidden: DM-only. Unknown stays DM-only.
      ...(hiddenFeature(f) || (ref && hiddenResource(ref)) ? { dm: true } : {}),
    };
  });
  const img = doc.mapImage;
  ctx.log(`Map ${r.name}: ${pins.length} pins`);
  return {
    kind: 'map', ...(img?.url && /^https?:/i.test(img.url) ? { image: String(img.url) } : {}), ...(img?.width ? { width: Number(img.width) } : {}), ...(img?.height ? { height: Number(img.height) } : {}),
    pins,
  };
}

/** A timeline document: one group per lane, events in time order. `shared` is false for a hidden timeline; events carry their own flag. */
async function lkTimeline(t: Transport, r: any, d: any, dd: any, multi: boolean, shared: boolean): Promise<SyncRecord> {
  const lanes = await lkList(t, `/resources/${r.id}/docs/${d.id}/lanes`);
  const events = await lkList(t, `/resources/${r.id}/docs/${d.id}/events`);
  const groups: TimelineGroup[] = lanes.slice().sort((a, b) => String(a.rank ?? '').localeCompare(String(b.rank ?? ''))).map((lane) => ({
    name: String(lane.name ?? 'Lane'),
    events: events.filter((e) => e.laneId === lane.id && e.type !== 'placeholder' && e.type !== 'invisible-placeholder').sort((a, b) => Number(a.start) - Number(b.start)).map((e) => ({
      id: String(e.id), name: String(e.name ?? 'Event'),
      date: e.formattedStart ? `${e.formattedStart}${e.formattedEnd ? ` – ${e.formattedEnd}` : ''}` : null,
      color: typeof e.color === 'string' ? e.color : null, ref: lkRef(e.uri),
      visibility: shared && e.isHidden === false ? 'party' as const : 'dm' as const,
    })),
  }));
  return { kind: 'timeline', externalId: `${r.id}#${d.id}`, name: multi && d.name && d.name !== 'Main' ? `${r.name} · ${d.name}` : String(r.name), visibility: shared ? 'party' : 'dm', groups };
}

// LegendKeeper allows 300 calls a minute per key and 6,000 an hour (12,000 an hour per project across keys). 60 a minute leaves room for the people using the app.
const LK_TIERED = (transport: (cfg: Record<string, any>, ctx: ConnectorContext) => Transport) => (): Tiered => ({
  budgetPerMinute: 60,
  index: (cfg, ctx) => lkIndex(transport(cfg, ctx), ctx, cfg),
  detail: (cfg, ctx, ids) => lkDetail(transport(cfg, ctx), ctx, cfg, ids),
});

const lkFields = [
  { key: 'project', label: 'Project (world) name', type: 'text' as const, help: 'Only if the server has more than one project.' },
];
const lkLinkFields = [
  { key: 'webUrl', label: 'Page address in the LegendKeeper app', type: 'text' as const, placeholder: LK_WEB_URL, help: 'Where the "Open in LegendKeeper" button goes. {project}, {id} and {doc} are replaced. Change it if the default does not open the page.' },
];

export const legendkeeperMcp: Connector = {
  id: 'legendkeeper-mcp',
  label: 'LegendKeeper (MCP server)',
  description: 'Reads a LegendKeeper world through the LegendKeeper MCP server. Keeps page layout, sidebar facts, links, secrets and hidden folders.',
  aliases: ['mcp:legendkeeper'],
  capabilities: ['pages', 'properties', 'tags', 'images', 'timelines', 'maps', 'calendars'],
  fields: [
    { key: 'transport', label: 'Connection', type: 'select', options: [['http', 'HTTP URL'], ['stdio', 'Local server (ALX_MCP_STDIO)']], default: 'http' },
    { key: 'url', label: 'MCP URL', type: 'url', placeholder: 'http://legendkeeper-mcp:8000/mcp', showIf: { transport: 'http' }, required: true },
    { key: 'token', label: 'MCP token', type: 'password', secret: true, showIf: { transport: 'http' } },
    { key: 'server', label: 'Local server name', type: 'text', showIf: { transport: 'stdio' } },
    ...lkFields,
    { key: 'projectId', label: 'Project id', type: 'text', help: 'The id in the LegendKeeper address of your world; only used for the "Open in LegendKeeper" button.' },
    ...lkLinkFields,
  ],
  validate(cfg) {
    if (cfg.webUrl && !/^https?:\/\/\S+$/.test(String(cfg.webUrl))) throw new ConfigError('Page address must start with http:// or https://');
    if (cfg.transport === 'stdio') { if (!/^[\w-]{1,40}$/.test(String(cfg.server ?? ''))) throw new ConfigError('Pick the local server name from ALX_MCP_STDIO'); }
    else if (!/^https?:\/\/\S+$/.test(String(cfg.url ?? ''))) throw new ConfigError('MCP URL must start with http:// or https://');
  },
  async test(cfg, ctx) {
    const t = mcpTransport(ctx, cfg.project);
    const j = await t.get('/resources', { limit: 5 });
    return { ok: true, message: `Connected. First resources: ${(j.data ?? []).map((r: any) => r.name).join(', ')}`, sample: (j.data ?? []).map((r: any) => r.name) };
  },
  sync: (cfg, ctx) => lkSync(mcpTransport(ctx, cfg.project), ctx, cfg),
  tiered: LK_TIERED((cfg, ctx) => mcpTransport(ctx, cfg.project)),
  readTools: () => ['api_request'],
};

export const legendkeeperApi: Connector = {
  id: 'legendkeeper-api',
  label: 'LegendKeeper (API key)',
  description: 'Reads a LegendKeeper project directly with a LegendKeeper API key. Same result as the MCP connector, no MCP server needed.',
  capabilities: ['pages', 'properties', 'tags', 'images', 'timelines', 'maps', 'calendars'],
  fields: [
    { key: 'apiUrl', label: 'Project API URL', type: 'url', required: true, placeholder: 'https://www.legendkeeper.com/api/v3/projects/<project id>', help: 'https://www.legendkeeper.com/api/v3/projects/ followed by your project id. Keys need the project owner on a paid plan.' },
    { key: 'apiKey', label: 'API key', type: 'password', secret: true, required: true, help: 'Project Settings → Developers → API Keys. Use an Admin key so hidden pages, secrets and hidden facts arrive marked (a Member key never sees them).' },
    ...lkLinkFields,
  ],
  validate(cfg) {
    if (cfg.webUrl && !/^https?:\/\/\S+$/.test(String(cfg.webUrl))) throw new ConfigError('Page address must start with http:// or https://');
    if (!/^https:\/\/\S+$/.test(String(cfg.apiUrl ?? ''))) throw new ConfigError('API URL must start with https://');
    if (String(cfg.apiKey ?? '').length < 10) throw new ConfigError('API key is required');
  },
  async test(cfg, ctx) {
    const j = await restTransport(ctx, cfg.apiUrl, cfg.apiKey).get('/resources', { limit: 5 });
    return { ok: true, message: `Connected. First resources: ${(j.data ?? []).map((r: any) => r.name).join(', ')}` };
  },
  sync: (cfg, ctx) => lkSync(restTransport(ctx, cfg.apiUrl, cfg.apiKey), ctx, cfg),
  tiered: LK_TIERED((cfg, ctx) => restTransport(ctx, cfg.apiUrl, cfg.apiKey)),
};
