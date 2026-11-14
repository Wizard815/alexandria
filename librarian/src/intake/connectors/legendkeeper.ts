// LegendKeeper, through its MCP server (read tools only) or its REST v3 API.
// Pages keep their LegendKeeper layout: the document blocks map one to one
// onto Alexandria blocks, sidebar properties become the property bar, and
// mentions stay links. Hidden is inherited from hidden folders and documents.
import type { CalendarDefinition, Connector, ConnectorContext, SyncItem, SyncRecord, TimelineGroup } from '../connector.ts';
import { ConfigError } from '../connector.ts';
import type { Block, Entry, Inline, PropertyGroup } from '../model.ts';
import { jsonOf } from '../../core/mcp.ts';
import { levelOfWord } from '../../core/levels.ts';

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

/** Waits, but stops early when the sync is stopped. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
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
function restTransport(ctx: ConnectorContext, base: string, key: string): Transport {
  const root = base.replace(/\/$/, '');
  return {
    async get(path, query) {
      const qs = query ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))).toString() : '';
      for (let attempt = 0; ; attempt++) {
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

function inline(c: any[] = []): Inline[] {
  return (Array.isArray(c) ? c : []).map((x): Inline => {
    if (x?.mention) return { mention: { ref: String(x.mention.resourceId ?? ''), ...(x.mention.name ? { name: String(x.mention.name) } : {}), ...(x.mention.text ? { text: String(x.mention.text) } : {}) } };
    if (x?.break === true) return { text: '\n' };
    // Icon runs ({ icon }) carry no text.
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
      case 'infobox': return [{ kind: 'infobox', layout: b.layout ?? 'wrapRight', width: Number(b.width) || 40, groups: lkGroups(b.rows) }];
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
      // map blocks inside a page (a link to a map document) and unsupported (opaque) stay unknown.
      default: return [{ kind: 'unsupported', sourceKind: String(b?.kind ?? 'unknown') }];
    }
  }).filter((b) => !(b.kind === 'paragraph' && !b.content.length));
}

async function* lkSync(t: Transport, ctx: ConnectorContext): AsyncIterable<SyncItem> {
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
      const parent = byId.get(rid)?.parentId;
      return parent ? deniesPlayers(String(parent), depth + 1) : false;
    })());
    return denied.get(rid)!;
  };

  for (const r of all) {
    if (ctx.signal.aborted) throw new Error('Sync stopped');
    if (r.isTemplate === true) continue;
    // Pages and maps become pages of their own; timelines become records.
    const pages = (r.documents ?? []).filter((d: any) => d.type === 'page' || d.type === 'map');
    const timelines = (r.documents ?? []).filter((d: any) => d.type === 'time');
    if (!pages.length && !timelines.length) continue;
    const detail = await detailOf(String(r.id));
    if (!detail) { ctx.log(`Skipped ${r.name}`); continue; }
    const restricted = hidden(String(r.id)) || await deniesPlayers(String(r.id));
    const folder = (detail.ancestors ?? []).map((a: any) => String(a.name));
    const props = lkGroups(detail.properties);
    for (const d of pages) {
      const dd = (detail.documents ?? []).find((x: any) => x.id === d.id) ?? d;
      const multi = pages.length > 1;
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
      }
      yield {
        externalId: multi && d !== pages[0] ? `${r.id}#${d.id}` : String(r.id),
        parentExternalId: multi && d !== pages[0] ? String(r.id) : r.parentId ? String(r.parentId) : null,
        folder,
        title: multi && d.name && d.name !== 'Main' ? `${r.name} · ${d.name}` : String(r.name),
        aliases: (r.aliases ?? []).map(String),
        tags: (r.tags ?? []).map(String),
        type: d.type === 'map' ? 'map' : (r.tags ?? []).find((x: string) => ['pc', 'npc', 'town', 'city', 'region', 'item', 'session', 'creature', 'kaiju', 'lore', 'group', 'heart'].includes(x)) ?? 'page',
        icon: r.iconGlyph ? { glyph: String(r.iconGlyph), color: r.iconColor ? String(r.iconColor) : undefined } : null,
        banner: typeof detail.banner?.url === 'string' && detail.banner.enabled !== false ? detail.banner.url : typeof detail.bannerUrl === 'string' ? detail.bannerUrl : null,
        properties: d === pages[0] ? props : [],
        blocks,
        visibility: !isHidden && ctx.shareVisible ? 'party' : 'dm',
        updatedAt: dd.updatedAt ?? r.updatedAt ?? null,
      };
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

const lkFields = [
  { key: 'project', label: 'Project (world) name', type: 'text' as const, help: 'Only if the server has more than one project.' },
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
  capabilities: ['pages', 'properties', 'tags', 'images', 'timelines', 'maps', 'calendars'],
  fields: [
    { key: 'apiUrl', label: 'Project API URL', type: 'url', required: true, placeholder: 'https://www.legendkeeper.com/api/v3/projects/<project id>', help: 'https://www.legendkeeper.com/api/v3/projects/ followed by your project id. Keys need the project owner on a paid plan.' },
    { key: 'apiKey', label: 'API key', type: 'password', secret: true, required: true, help: 'Project Settings → Developers → API Keys. Use an Admin key so hidden pages, secrets and hidden facts arrive marked (a Member key never sees them).' },
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
