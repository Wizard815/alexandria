// Notion as a world source (the public API, https://developers.notion.com/reference, version 2022-06-28).
//
//   Listing  POST /v1/search                       every page and database the integration was given (100 a call)
//   Pages    GET  /v1/pages/{id}                    properties, parent, public_url
//            GET  /v1/blocks/{id}/children          the page's blocks (100 a call), read again below any block with children
//   Database GET  /v1/databases/{id}               its title and description (its rows are pages, listed by search)
//
// Notion only shows an integration the pages someone shared with it (Share → Connections), so the GM chooses what Alexandria reads.
// Who may read a page (fails closed: anything unsure is the GM's):
//   - a "Visibility" property (select, status or multi-select) on a database row: party, players, public or shared is the players';
//     broker and classified are those levels; anything else (dm, gm, secret...) the GM's;
//   - else a page published to the web (Share → Publish) is the players';
//   - else the source's "Pages without a visibility are shared" setting (off by default).
// Toggles, toggle headings and callouts whose title starts with Secret, GM or GM become secret blocks: players never see them.
import type { Connector, ConnectorContext, SyncItem } from '../connector.ts';
import { ConfigError } from '../connector.ts';
import { type Block, type Entry, type Inline, type PropertyRow, indexBlocks } from '../model.ts';
import { normLevel, type Level } from '../../core/levels.ts';

export const NOTION_API = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-28';
const ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const MAX_DEPTH = 8;
const MAX_BLOCKS = 3000;

/** A Notion id (with or without dashes, or the end of a notion.so address) in its dashed form; null when there is none. */
export function notionId(v: unknown): string | null {
  const s = String(v ?? '').trim().replace(/^notion:/, '');
  const hex = ID.test(s) ? s.replace(/-/g, '') : /([0-9a-f]{32})(?:[?#].*)?$/i.exec(s)?.[1];
  if (!hex) return null;
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const ext = (id: string) => `notion:${id}`;

// ---------- HTTP ----------

/** One call to the Notion API. Retries a 429 after Retry-After (Notion's limit is about three a second). Never leaves the API's address. */
export async function notionHttp(ctx: Pick<ConnectorContext, 'fetch' | 'signal' | 'log'> & Partial<Pick<ConnectorContext, 'calls'>>, cfg: Record<string, any>, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const url = NOTION_API + path;
  if (!url.startsWith(NOTION_API + '/') || /\/\.\.?(\/|$)/.test(path)) throw new Error('Refusing a request outside the Notion API');
  for (let attempt = 0; ; attempt++) {
    await ctx.calls?.take();
    const r = await ctx.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, 'Notion-Version': NOTION_VERSION, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctx.signal,
    });
    if (r.status === 429 && attempt < 4) {
      const wait = Math.min(30, Math.max(1, Number(r.headers.get('retry-after')) || 2 ** attempt));
      ctx.log(`Notion asked to slow down; waiting ${wait}s`);
      await new Promise((res, rej) => { const t = setTimeout(res, wait * 1000); ctx.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('Sync stopped')); }, { once: true }); });
      continue;
    }
    const text = await r.text();
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = null; }
    return { status: r.status, body: j };
  }
}

async function call(ctx: ConnectorContext, cfg: Record<string, any>, method: string, path: string, body?: unknown): Promise<any> {
  const r = await notionHttp(ctx, cfg, method, path, body);
  if (r.status === 401) throw new Error('Notion refused the integration token (401)');
  if (r.status === 404) return null;
  if (r.status < 200 || r.status >= 300) throw new Error(`Notion answered ${r.status} for ${path.split('?')[0]}: ${String(r.body?.message ?? '').slice(0, 160)}`);
  return r.body;
}

/** Every result of a paginated list (start_cursor / next_cursor). */
async function* paged(ctx: ConnectorContext, cfg: Record<string, any>, method: 'GET' | 'POST', path: string, body: Record<string, any> = {}, max = 20_000): AsyncIterable<any> {
  let cursor: string | null = null;
  let n = 0;
  for (let page = 0; page < 1000; page++) {
    const q = method === 'GET' ? `${path}${path.includes('?') ? '&' : '?'}page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}` : path;
    const j = await call(ctx, cfg, method, q, method === 'POST' ? { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } : undefined);
    if (!j) return;
    for (const x of Array.isArray(j.results) ? j.results : []) { yield x; if (++n >= max) return; }
    if (!j.has_more || !j.next_cursor) return;
    cursor = String(j.next_cursor);
  }
}

// ---------- rich text and blocks ----------

/** Notion rich text to inline runs. Page and database mentions point at the page here. */
export function notionInline(rich: any[] | undefined): Inline[] {
  const out: Inline[] = [];
  for (const t of Array.isArray(rich) ? rich : []) {
    const a = t?.annotations ?? {};
    const style = { ...(a.bold ? { bold: true } : {}), ...(a.italic ? { italic: true } : {}), ...(a.strikethrough ? { strike: true } : {}), ...(a.underline ? { underline: true } : {}), ...(a.code ? { code: true } : {}) };
    if (t?.type === 'mention') {
      const m = t.mention ?? {};
      const target = notionId(m.page?.id ?? m.database?.id);
      if (target) { out.push({ mention: { ref: ext(target), text: String(t.plain_text ?? '') || undefined } }); continue; }
    }
    const text = String(t?.plain_text ?? t?.text?.content ?? '');
    if (!text) continue;
    const href = typeof t?.href === 'string' && /^https?:\/\//i.test(t.href) ? t.href : null;
    const linked = href ? notionId(/notion\.so\/|notion\.site\//.test(href) ? href : '') : null;
    if (linked) out.push({ mention: { ref: ext(linked), text } });
    else out.push({ text, ...style, ...(href ? { link: href } : {}) });
  }
  return out;
}
const plain = (rich: any[] | undefined) => (Array.isArray(rich) ? rich.map((t) => String(t?.plain_text ?? t?.text?.content ?? '')).join('') : '');

/** A title that marks a hidden part: Secret, GM, GM (with "notes", "only" and the like after it). */
export const SECRET_TITLE = /^\s*(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*)?(secret|secrets|dm|gm|dungeon master|game master)\b/iu;

/** A Notion block (with `children` already read in) as Alexandria blocks. */
function blockOf(b: any): Block[] {
  const t = String(b?.type ?? '');
  const v = b?.[t] ?? {};
  const kids = (): Block[] => notionBlocks(Array.isArray(b?.children) ? b.children : []);
  const rich = notionInline(v.rich_text);
  switch (t) {
    case 'paragraph': return rich.length || b.children?.length ? [{ kind: 'paragraph', content: rich }, ...kids()] : [];
    case 'heading_1': case 'heading_2': case 'heading_3': {
      const level = Number(t.slice(-1));
      if (v.is_toggleable) {
        const body = kids();
        return SECRET_TITLE.test(plain(v.rich_text)) ? [{ kind: 'secret', children: [{ kind: 'heading', level, content: rich }, ...body] }] : [{ kind: 'heading', level, content: rich }, ...body];
      }
      return [{ kind: 'heading', level, content: rich }];
    }
    case 'bulleted_list_item': case 'numbered_list_item': case 'to_do':
      return [{ kind: 'listItem', children: [{ kind: 'paragraph', content: rich }, ...kids()], ...(t === 'to_do' ? { checked: v.checked === true } : {}) }];
    case 'toggle': {
      const body = kids();
      return SECRET_TITLE.test(plain(v.rich_text)) ? [{ kind: 'secret', children: body }] : [{ kind: 'toggle', title: rich, children: body }];
    }
    case 'callout': {
      const body: Block[] = [{ kind: 'paragraph', content: rich }, ...kids()];
      if (SECRET_TITLE.test(plain(v.rich_text))) return [{ kind: 'secret', children: body }];
      return [{ kind: 'callout', variant: 'info', children: body }];
    }
    case 'quote': return [{ kind: 'blockquote', children: [{ kind: 'paragraph', content: rich }, ...kids()] }];
    case 'code': return [{ kind: 'codeBlock', language: typeof v.language === 'string' ? v.language : undefined, text: plain(v.rich_text) }];
    case 'equation': return [{ kind: 'codeBlock', language: 'latex', text: String(v.expression ?? '') }];
    case 'divider': return [{ kind: 'divider' }];
    case 'image': {
      const url = v.type === 'external' ? v.external?.url : v.file?.url;
      return typeof url === 'string' && /^https?:\/\//i.test(url) ? [{ kind: 'image', url, alt: plain(v.caption) || undefined, caption: v.caption?.length ? notionInline(v.caption) : undefined }] : [];
    }
    case 'bookmark': case 'embed': case 'link_preview': case 'video': case 'pdf': case 'file': case 'audio': {
      const url = v.url ?? v.external?.url; // uploaded files' addresses expire within the hour: only links that last are kept
      return typeof url === 'string' && /^https?:\/\//i.test(url) ? [{ kind: 'paragraph', content: [{ text: plain(v.caption) || url, link: url }] }] : [];
    }
    case 'child_page': case 'child_database': {
      const id = notionId(b.id);
      return id ? [{ kind: 'paragraph', content: [{ mention: { ref: ext(id), text: String(v.title ?? '') || undefined } }] }] : [];
    }
    case 'link_to_page': {
      const id = notionId(v.page_id ?? v.database_id);
      return id ? [{ kind: 'paragraph', content: [{ mention: { ref: ext(id) } }] }] : [];
    }
    case 'table': {
      const rows = (Array.isArray(b.children) ? b.children : []).filter((r: any) => r?.type === 'table_row');
      return [{ kind: 'table', children: rows.map((r: any, i: number) => ({ kind: 'tableRow', children: (r.table_row?.cells ?? []).map((c: any) => ({ kind: 'tableCell', ...(i === 0 && v.has_column_header ? { header: true } : {}), children: [{ kind: 'paragraph', content: notionInline(c) }] })) })) }];
    }
    case 'column_list': case 'column': case 'synced_block': case 'template': return kids();
    case 'table_of_contents': case 'breadcrumb': return [];
    case 'unsupported': return kids();
    default: return [{ kind: 'unsupported', sourceKind: `notion:${t || 'block'}` }, ...kids()];
  }
}

/** A run of Notion blocks as Alexandria blocks; neighbouring list items become one list. */
export function notionBlocks(list: any[]): Block[] {
  const out: Block[] = [];
  for (const b of list) {
    const t = String(b?.type ?? '');
    const made = blockOf(b);
    const listKind = t === 'numbered_list_item' ? 'orderedList' : t === 'bulleted_list_item' || t === 'to_do' ? 'bulletList' : null;
    if (listKind && made.length === 1 && made[0].kind === 'listItem') {
      const last = out[out.length - 1];
      if (last && last.kind === listKind) last.children.push(made[0]);
      else out.push({ kind: listKind, children: [made[0]] });
    } else out.push(...made);
  }
  return out;
}

// ---------- pages ----------

const VIS_PROP = /^(visibility|access|audience|shared with)$/i;
const PARTY = /^(party|players?|public|shared|everyone|all)$/i;

/** Who may read a page or database: its Visibility property, else whether it is published to the web, else the source's default. */
export function notionAccess(x: any, cfg: Record<string, any>): { shared: boolean; level?: Level } {
  for (const [name, p] of Object.entries<any>(x?.properties ?? {})) {
    if (!VIS_PROP.test(name.trim())) continue;
    const vals: string[] = p?.type === 'select' ? [p.select?.name] : p?.type === 'status' ? [p.status?.name] : p?.type === 'multi_select' ? (p.multi_select ?? []).map((o: any) => o?.name) : p?.type === 'checkbox' ? [p.checkbox ? 'party' : 'dm'] : [];
    const names = vals.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
    if (!names.length) continue; // an empty property says nothing
    if (names.every((n) => PARTY.test(n))) return { shared: true };
    const lv = names.map((n) => normLevel(n)).find((l) => l === 'broker' || l === 'classified');
    return { shared: false, ...(lv ? { level: lv } : {}) };
  }
  if (typeof x?.public_url === 'string' && x.public_url) return { shared: true };
  return { shared: cfg.defaultShared === true };
}

export function notionTitle(x: any): string {
  if (x?.object === 'database') return plain(x.title) || 'Untitled database';
  for (const p of Object.values<any>(x?.properties ?? {})) if (p?.type === 'title') return plain(p.title) || 'Untitled';
  return 'Untitled';
}

/** The page or database this one sits in (a page inside a block is listed under the page the block belongs to when we know it). */
function parentOf(x: any, kinds: Record<string, string>): string | null {
  const p = x?.parent ?? {};
  const id = notionId(p.type === 'page_id' ? p.page_id : p.type === 'database_id' ? p.database_id : p.type === 'block_id' ? p.block_id : null);
  // Without a listing (one page read on its own) the parent is taken as it is; with one, only a parent the listing has.
  return id && (kinds[id] || !Object.keys(kinds).length) && p.type !== 'block_id' ? ext(id) : id && kinds[id] ? ext(id) : null;
}

/** A database row's properties as facts (the title and visibility are left out; tags become tags). */
export function notionProperties(x: any): { rows: PropertyRow[]; tags: string[] } {
  const rows: PropertyRow[] = [];
  const tags: string[] = [];
  for (const [name, p] of Object.entries<any>(x?.properties ?? {})) {
    if (!p || p.type === 'title' || VIS_PROP.test(name.trim())) continue;
    let value: Inline[] = [];
    switch (p.type) {
      case 'rich_text': value = notionInline(p.rich_text); break;
      case 'number': value = p.number == null ? [] : [{ text: String(p.number) }]; break;
      case 'select': case 'status': value = p[p.type]?.name ? [{ text: String(p[p.type].name) }] : []; break;
      case 'multi_select': {
        const names = (p.multi_select ?? []).map((o: any) => String(o?.name ?? '')).filter(Boolean);
        if (/^tags?$/i.test(name.trim())) { tags.push(...names); continue; }
        value = names.length ? [{ text: names.join(', ') }] : [];
        break;
      }
      case 'date': value = p.date?.start ? [{ text: `${p.date.start}${p.date.end ? ` – ${p.date.end}` : ''}` }] : []; break;
      case 'checkbox': value = [{ text: p.checkbox ? 'Yes' : 'No' }]; break;
      case 'url': value = typeof p.url === 'string' && /^https?:\/\//i.test(p.url) ? [{ text: p.url, link: p.url }] : []; break;
      case 'email': case 'phone_number': value = p[p.type] ? [{ text: String(p[p.type]) }] : []; break;
      case 'people': value = (p.people ?? []).map((u: any) => String(u?.name ?? '')).filter(Boolean).map((n: string, i: number) => ({ text: i ? `, ${n}` : n })); break;
      case 'relation': value = (p.relation ?? []).map((r: any) => notionId(r?.id)).filter(Boolean).flatMap((id: string, i: number) => (i ? [{ text: ', ' }, { mention: { ref: ext(id) } }] : [{ mention: { ref: ext(id) } }])); break;
      case 'formula': { const f = p.formula ?? {}; const v = f[f.type]; value = v == null || v === '' ? [] : [{ text: typeof v === 'object' ? String(v.start ?? '') : String(v) }]; break; }
      default: continue; // created/edited times and people, rollups, files, unique ids: not facts
    }
    if (value.length) rows.push({ key: name.slice(0, 80), value });
  }
  return { rows, tags };
}

const httpUrl = (u: unknown) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);
const iconOf = (x: any) => (x?.icon?.type === 'emoji' && typeof x.icon.emoji === 'string' ? { glyph: x.icon.emoji } : null);
const coverOf = (x: any) => httpUrl(x?.cover?.type === 'external' ? x.cover.external?.url : x?.cover?.file?.url);

/** A page (or database) read in full, with its blocks. */
export function notionEntry(x: any, blocks: any[], cfg: Record<string, any>, kinds: Record<string, string>, shareVisible: boolean): Entry {
  const id = notionId(x.id)!;
  const acc = notionAccess(x, cfg);
  const { rows, tags } = notionProperties(x);
  const head: Block[] = x.object === 'database' && Array.isArray(x.description) && x.description.length ? [{ kind: 'paragraph', content: notionInline(x.description) }] : [];
  return {
    externalId: ext(id), parentExternalId: parentOf(x, kinds), title: notionTitle(x), tags, type: x.object === 'database' ? 'collection' : 'page',
    icon: iconOf(x), banner: coverOf(x), properties: rows.length ? [{ title: 'Properties', rows }] : [],
    blocks: [...head, ...notionBlocks(blocks)],
    visibility: acc.shared && shareVisible ? 'party' : 'dm', sourceShared: acc.shared, ...(acc.level ? { level: acc.level } : {}),
    url: httpUrl(x.url), updatedAt: x.last_edited_time ?? null, sourceUpdatedAt: x.last_edited_time ?? null, depth: 'full',
  };
}

/** A page's blocks, read again below every block with children (to MAX_DEPTH, at most MAX_BLOCKS). */
export async function notionChildren(ctx: ConnectorContext, cfg: Record<string, any>, id: string, budget = { left: MAX_BLOCKS }, depth = 0): Promise<any[]> {
  const out: any[] = [];
  for await (const b of paged(ctx, cfg, 'GET', `/blocks/${id}/children`)) {
    if (budget.left-- <= 0) { ctx.log('A page has more blocks than Alexandria reads; the rest is left out'); break; }
    // A child page is its own page here (only its link is kept), so its blocks are not read into this one.
    if (b?.has_children && depth < MAX_DEPTH && b.type !== 'child_page' && b.type !== 'child_database') b.children = await notionChildren(ctx, cfg, String(b.id), budget, depth + 1);
    out.push(b);
  }
  return out;
}

// ---------- listing ----------

interface NotionCache { k: Record<string, string> }

/** Everything the integration can see, through /search: pages and databases (archived and trashed ones left out). Only those under the root page when one is set. */
async function listAll(cfg: Record<string, any>, ctx: ConnectorContext): Promise<any[]> {
  const all: any[] = [];
  for await (const x of paged(ctx, cfg, 'POST', '/search', { sort: { direction: 'descending', timestamp: 'last_edited_time' } })) {
    if ((x?.object === 'page' || x?.object === 'database') && notionId(x.id) && !x.archived && !x.in_trash) all.push(x);
  }
  const root = notionId(cfg.rootPage);
  if (!root) return all;
  const byId = new Map(all.map((x) => [notionId(x.id)!, x]));
  const under = (x: any): boolean => {
    for (let cur = x, i = 0; cur && i < 64; i++) {
      const id = notionId(cur.id);
      if (id === root) return true;
      const p = cur.parent ?? {};
      cur = byId.get(notionId(p.page_id ?? p.database_id ?? p.block_id) ?? '');
    }
    return false;
  };
  return all.filter(under);
}

async function* notionIndex(cfg: Record<string, any>, ctx: ConnectorContext, state: { next?: NotionCache }): AsyncIterable<SyncItem> {
  const all = await listAll(cfg, ctx);
  const kinds: Record<string, string> = {};
  for (const x of all) kinds[notionId(x.id)!] = x.object === 'database' ? 'd' : 'p';
  state.next = { k: kinds };
  ctx.log(`Listed ${all.length} Notion pages and databases`);
  for (const x of all) {
    const title = notionTitle(x);
    const type = x.object === 'database' ? 'collection' : 'page';
    const { tags } = notionProperties(x);
    yield {
      externalId: ext(notionId(x.id)!), parentExternalId: parentOf(x, kinds), title, tags, type, icon: iconOf(x),
      blocks: indexBlocks({ title, type, tags }), url: httpUrl(x.url),
      visibility: 'dm', restricted: !notionAccess(x, cfg).shared, updatedAt: x.last_edited_time ?? null, sourceUpdatedAt: x.last_edited_time ?? null, depth: 'index',
    } satisfies Entry;
  }
}

async function* notionDetail(cfg: Record<string, any>, ctx: ConnectorContext, ids: string[], cache: NotionCache | null): AsyncIterable<SyncItem> {
  const kinds = cache?.k ?? {};
  for (const e of ids) {
    if (ctx.signal.aborted) throw new Error('Sync stopped');
    const id = notionId(e);
    if (!id) continue;
    const entry = await readNotion(cfg, ctx, id, kinds);
    if (entry) yield entry;
  }
}

/** One page or database, read fresh. Null: Notion no longer has it (or it is in the trash). */
export async function readNotion(cfg: Record<string, any>, ctx: ConnectorContext, id: string, kinds: Record<string, string> = {}): Promise<Entry | null> {
  const isDb = kinds[id] === 'd';
  let x = await call(ctx, cfg, 'GET', `/${isDb ? 'databases' : 'pages'}/${id}`);
  if (!x && !isDb) x = await call(ctx, cfg, 'GET', `/databases/${id}`);
  if (!x || x.archived || x.in_trash) return null;
  const blocks = x.object === 'page' ? await notionChildren(ctx, cfg, id) : [];
  return notionEntry(x, blocks, cfg, kinds, ctx.shareVisible);
}

async function* notionSync(cfg: Record<string, any>, ctx: ConnectorContext): AsyncIterable<SyncItem> {
  const state: { next?: NotionCache } = {};
  const ids: string[] = [];
  for await (const x of notionIndex(cfg, ctx, state)) ids.push((x as Entry).externalId);
  const prev = ctx.calls?.phase;
  if (ctx.calls) ctx.calls.phase = 'detail';
  try { yield* notionDetail(cfg, ctx, ids, state.next ?? null); } finally { if (ctx.calls && prev) ctx.calls.phase = prev; }
}

export const notionApi: Connector = {
  id: 'notion-api',
  label: 'Notion',
  description: 'Reads the Notion pages and databases you shared with an integration: text, toggles, tables, database properties and pictures. Only pages with a Visibility of party, or published to the web, reach players.',
  aliases: ['notion'],
  capabilities: ['pages', 'properties', 'tags', 'images', 'relations'],
  fields: [
    { key: 'token', label: 'Integration token', type: 'password', secret: true, required: true, help: 'notion.so/my-integrations → New integration (internal) → its secret. Then, in Notion, share the world’s top page with it: ••• → Connections.' },
    { key: 'rootPage', label: 'Only under this page', type: 'text', help: 'A page’s address or id. Empty: everything shared with the integration.' },
    { key: 'defaultShared', label: 'Pages without a visibility are shared', type: 'boolean', default: false, help: 'Off (safer): only pages with Visibility = party (a database property) or published to the web are the players’.' },
  ],
  validate(cfg) {
    if (!/^(secret_|ntn_)\w{20,}$/.test(String(cfg.token ?? '').trim())) throw new ConfigError('Integration token is required (it starts with ntn_ or secret_)');
    if (cfg.rootPage && !notionId(cfg.rootPage)) throw new ConfigError('"Only under this page" must be a Notion page address or id');
  },
  async test(cfg, ctx) {
    const me = await notionHttp(ctx, cfg, 'GET', '/users/me');
    if (me.status === 401) return { ok: false, message: 'Notion refused the integration token.' };
    if (me.status !== 200) return { ok: false, message: `Notion answered ${me.status}.` };
    const r = await notionHttp(ctx, cfg, 'POST', '/search', { page_size: 20 });
    const list: any[] = Array.isArray(r.body?.results) ? r.body.results : [];
    if (!list.length) return { ok: false, message: `Connected as ${me.body?.name ?? 'the integration'}, but no page is shared with it yet. In Notion: ••• → Connections → add it on the world’s top page.` };
    if (cfg.rootPage) {
      const root = notionId(cfg.rootPage)!;
      const got = await notionHttp(ctx, cfg, 'GET', `/pages/${root}`);
      if (got.status !== 200) return { ok: false, message: 'Connected, but the integration cannot see the page in "Only under this page". Share it with the integration.' };
    }
    return { ok: true, message: `Connected as ${me.body?.name ?? 'the integration'}.`, sample: list.map(notionTitle).slice(0, 5) };
  },
  sync: notionSync,
  tiered: () => ({
    // Notion's limit is about three requests a second on average: details take 90 a minute.
    budgetPerMinute: 90,
    index: async function* (cfg, ctx) {
      const state: { next?: NotionCache } = {};
      yield* notionIndex(cfg, ctx, state);
      if (ctx.tier) { ctx.tier.complete = true; ctx.tier.next = { token: null, cache: (state.next ?? null) as unknown as Record<string, any> }; }
    },
    detail: (cfg, ctx, ids) => notionDetail(cfg, ctx, ids, (ctx.tier?.cache ?? null) as NotionCache | null),
  }),
};
