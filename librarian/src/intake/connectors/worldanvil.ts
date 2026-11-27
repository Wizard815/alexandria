// World Anvil, through its public API v2 ("Boromir",
// https://www.worldanvil.com/api/external/boromir/documentation).
//
// Every call carries two keys: an application key (x-application-key), which
// World Anvil gives to the person who runs an app (Grandmaster guild members
// and above, by request form), and a user token (x-auth-token), which each
// user makes on their own "API Tokens" page. Alexandria keeps both on the
// connection; the application key may instead be set once for the whole
// server with ALX_WORLDANVIL_APP_KEY.
//
// Reading: articles, categories and maps are pages; secrets embedded with
// [secret:id] (and secrets linked to an article) become secret blocks;
// [subcontainer:id], [userstate:...] and /* comments */ are secret blocks too;
// map markers and timeline events become records. World Anvil has no "what
// changed since" filter, so every listing is complete: a page is read again
// (tier 3) only when its listed update time moved.
//
// Who may see what (fail closed): a draft is GM-only; a public page is the
// players'; a private page is the players' only when one of its subscriber
// groups is named in "Player subscriber groups". A secret is a secret block
// unless it is shared with one of those groups.
import type { Connector, ConnectorContext, SyncItem, SyncRecord, TimelineEvent, TimelineGroup } from '../connector.ts';
import { ConfigError } from '../connector.ts';
import { type Block, type Entry, type Inline, type PropertyGroup, type PropertyRow, indexBlocks, markdownToBlocks } from '../model.ts';
import { pictureRecord } from '../images.ts';

export const WA_API = 'https://www.worldanvil.com/api/external/boromir';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 50;
const MAX_PAGES = 400;

export const waBase = (cfg: { apiUrl?: unknown }) => String(cfg.apiUrl || WA_API).replace(/\/$/, '');

/** The application key: the connection's own, else the server's ALX_WORLDANVIL_APP_KEY. */
export const waAppKey = (cfg: Record<string, any>, env: Record<string, string | undefined> = {}) => String(cfg.appKey || env.ALX_WORLDANVIL_APP_KEY || '').trim();

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Sync stopped'));
    const t = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(t); reject(new Error('Sync stopped')); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

const VERSION = '1';

/**
 * One World Anvil request. The keys are sent only to the API base (any other URL is refused). 429: wait for
 * Retry-After, else back off 15 s, 30 s, 45 s. Any other status is returned for the caller to judge.
 */
export async function waHttp(ctx: Pick<ConnectorContext, 'fetch' | 'signal' | 'env'> & Partial<Pick<ConnectorContext, 'calls'>>, cfg: Record<string, any>, method: string, path: string, a: { query?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const base = waBase(cfg);
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(a.query ?? {})) url.searchParams.set(k, v);
  if (!url.toString().startsWith(base + '/')) throw new Error('Refusing a World Anvil request outside the API URL');
  for (let attempt = 0; attempt < 4; attempt++) {
    await ctx.calls?.take();
    const r = await ctx.fetch(url.toString(), {
      method,
      headers: {
        'x-application-key': waAppKey(cfg, ctx.env),
        'x-auth-token': String(cfg.token ?? ''),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        // World Anvil asks every app to name itself: name, address and version.
        'User-Agent': `Alexandria ( https://github.com/Wizard815/alexandria, ${VERSION} )`,
      },
      body: a.body === undefined ? undefined : JSON.stringify(a.body),
      signal: ctx.signal,
    });
    if (r.status === 429) {
      const ra = Number(r.headers.get('retry-after'));
      await pause(Number.isFinite(ra) && ra >= 0 && r.headers.get('retry-after') !== null ? Math.min(ra, 120) * 1000 : 15_000 * (attempt + 1), ctx.signal);
      continue;
    }
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  throw new Error('World Anvil kept rate-limiting; try again later');
}

/** A GET or POST that must succeed (404: null). */
async function waCall(ctx: ConnectorContext, cfg: Record<string, any>, method: string, path: string, a: { query?: Record<string, string>; body?: unknown } = {}): Promise<any> {
  const r = await waHttp(ctx, cfg, method, path, a);
  if (r.status === 404) return null;
  if (r.status < 200 || r.status >= 300 || r.body?.success === false) {
    const why = r.body?.error?.summary ?? r.body?.error?.message ?? r.body?.message ?? '';
    throw new Error(`World Anvil answered ${r.status} for ${path}${why ? `: ${String(why).slice(0, 120)}` : ''}`);
  }
  return r.body;
}

/** Every item of a list endpoint (POST with limit and offset, 50 at a time). */
async function* waList(ctx: ConnectorContext, cfg: Record<string, any>, path: string, id: string): AsyncIterable<any> {
  for (let page = 0; page < MAX_PAGES; page++) {
    if (ctx.signal.aborted) throw new Error('Sync stopped');
    const j = await waCall(ctx, cfg, 'POST', path, { query: { id }, body: { limit: String(PAGE), offset: String(page * PAGE) } });
    const list: any[] = Array.isArray(j?.entities) ? j.entities : [];
    for (const x of list) if (x && typeof x === 'object') yield x;
    if (list.length < PAGE) return;
  }
}

/** World Anvil dates ({ date: '2022-08-23 14:00:42.000000', timezone: 'UTC' }, or a string) as ISO time. */
export function waDate(v: unknown): string | null {
  const raw = typeof v === 'object' && v ? (v as any).date : v;
  const s = String(raw ?? '').trim();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?/.exec(s);
  if (!m) return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
  const tz = typeof v === 'object' && v ? String((v as any).timezone ?? 'UTC') : 'UTC';
  const iso = `${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 4) : ''}${/^(UTC|Z|GMT|\+00:00)$/i.test(tz) ? 'Z' : ''}`;
  return Number.isNaN(Date.parse(iso)) ? null : new Date(iso).toISOString();
}

/** The player subscriber groups the GM named (ids or titles), lower-cased. */
export function playerGroups(cfg: Record<string, any>): Set<string> {
  return new Set(String(cfg.playerGroups ?? '').split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean));
}
const groupsOf = (x: any): { id: string; title: string }[] => (Array.isArray(x?.subscribergroups) ? x.subscribergroups : []).filter((g: any) => g && typeof g === 'object').map((g: any) => ({ id: String(g.id ?? '').toLowerCase(), title: String(g.title ?? g.name ?? '').trim().toLowerCase() }));
const inGroups = (x: any, groups: Set<string>) => groupsOf(x).some((g) => (g.id && groups.has(g.id)) || (g.title && groups.has(g.title)));

/**
 * Does World Anvil itself let the players see this? A draft: no. Public: yes. Private: only when one of its subscriber groups is a player group.
 * A missing or unknown state: no.
 */
export function waShared(x: any, groups: Set<string>): boolean {
  if (!x || x.isDraft === true) return false;
  if (x.state === 'public') return true;
  return x.state === 'private' && inGroups(x, groups);
}

const tagsOf = (x: any): string[] => (Array.isArray(x?.tags) ? x.tags : String(x?.tags ?? '').split(',')).map((t: unknown) => String(t ?? '').trim()).filter(Boolean).slice(0, 50);

/** World Anvil article templates as Alexandria page types. */
const TYPE: Record<string, string> = {
  person: 'character', organization: 'organisation', location: 'location', settlement: 'location', landmark: 'location', item: 'item',
  species: 'race', ethnicity: 'race', plot: 'quest', report: 'note', condition: 'ability', spell: 'ability', militaryconflict: 'event', myth: 'note', document: 'note',
};
export const waType = (entityClass: unknown) => { const c = String(entityClass ?? '').toLowerCase(); return TYPE[c] ?? (c && c !== 'article' ? c : 'page'); };

// ---------- BBCode ----------

export interface BbcodeCtx {
  /** An image id to its address (from the world's image list). */
  image?: (id: string) => string | null | undefined;
  /** A secret's content and whether players may see it; undefined when it could not be read (GM-only, with a note). */
  secret?: (id: string) => { title: string; content: string; shared: boolean } | undefined;
  /** The player subscriber groups (ids or titles, lower-case). */
  groups?: Set<string>;
  /** The title of a page by id, for [map:id] and similar. */
  title?: (id: string) => string | undefined;
}

const MENTION = /@\[([^\]]*)\]\((?:[\w-]+):([0-9a-f-]{36})\)/gi;

/** BBCode to Markdown, with mentions as [[@wa:<id>|label]]. Hidden parts are left out here: see waBlocks. */
function bbInline(s: string, c: BbcodeCtx): string {
  let t = s;
  t = t.replace(/\r/g, '');
  t = t.replace(MENTION, (_m, label, id) => `[[@wa:${id.toLowerCase()}${label ? '|' + String(label).replace(/[|\]]/g, ' ') : ''}]]`);
  // Links to other kinds of content: categories, maps, timelines and histories.
  t = t.replace(/\[(category|timeline|history|book):([0-9a-f-]{36})[^\]]*\]([\s\S]*?)\[\/\1\]/gi, (_m, kind, id, label) => (kind.toLowerCase() === 'category' ? `[[@wa:${id.toLowerCase()}|${label.trim() || 'Category'}]]` : label));
  t = t.replace(/\[(map|book):([0-9a-f-]{36})[^\]]*\]/gi, (_m, _k, id) => { const name = c.title?.(id.toLowerCase()); return name ? `[[@wa:${id.toLowerCase()}|${name}]]` : ''; });
  t = t.replace(/\[img:(\d+)[^\]]*\]/gi, (_m, id) => { const u = c.image?.(id); return u && /^https?:\/\//i.test(u) ? `\n\n![](${u.replace(/[()\s]/g, encodeURIComponent)})\n\n` : ''; });
  t = t.replace(/\[url[:=]([^\]|]*)(?:\|[^\]]*)?\]([\s\S]*?)\[\/url\]/gi, (_m, href, label) => (/^https?:\/\//i.test(href.trim()) ? `[${label}](${href.trim()})` : label));
  t = t.replace(/\[h([1-6])(?:\|[^\]]*)?\]([\s\S]*?)\[\/h\1\]/gi, (_m, n, x) => `\n\n${'#'.repeat(Number(n))} ${x.trim()}\n\n`);
  t = t.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, '**$1**').replace(/\[i\]([\s\S]*?)\[\/i\]/gi, '*$1*').replace(/\[s\]([\s\S]*?)\[\/s\]/gi, '~~$1~~');
  t = t.replace(/\[code\]([\s\S]*?)\[\/code\]/gi, (_m, x) => '`' + x.replace(/`/g, "'") + '`');
  t = t.replace(/\[(quote|aloud)\]([\s\S]*?)\[\/\1\]/gi, (_m, _k, x) => {
    const [body, who] = x.split(/\|(?=[^|]*$)/);
    const lines = (who !== undefined ? body : x).trim().split('\n').map((l: string) => `> ${l}`);
    if (who !== undefined && who.trim()) lines.push(`> — ${who.trim()}`);
    return `\n\n${lines.join('\n')}\n\n`;
  });
  t = t.replace(/\[spoiler\]([\s\S]*?)\[\/spoiler\]/gi, (_m, x) => x.split(/\|(?=[^|]*$)/)[0]);
  t = t.replace(/\[tooltip:[^\]]*\]([\s\S]*?)\[\/tooltip\]/gi, '$1');
  t = t.replace(/\[redacted:?\d*\]/gi, '█████');
  t = t.replace(/^--(.+?)::(.+?)--\s*$/gm, (_m, k, v) => `**${k.trim()}:** ${v.trim()}`);
  // Lists: [li] items, and the "- " shortcut lines World Anvil also accepts.
  t = t.replace(/\[\/?(ul|ol|list)\]/gi, '\n\n').replace(/\[li\]/gi, '\n- ').replace(/\[\/li\]/gi, '');
  t = t.replace(/^-- /gm, '  - ');
  // Tables: rows of cells (a header row gets the Markdown separator).
  t = t.replace(/\[table\]([\s\S]*?)\[\/table\]/gi, (_m, body) => {
    const rows = [...String(body).matchAll(/\[tr\]([\s\S]*?)\[\/tr\]/gi)].map((r) => [...r[1].matchAll(/\[(td|th)(?::\d+)?\]([\s\S]*?)\[\/\1\]/gi)].map((x) => x[2].replace(/\n+/g, ' ').replace(/\|/g, '/').trim()));
    if (!rows.length) return '';
    const w = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${Array.from({ length: w }, (_, i) => r[i] ?? '').join(' | ')} |`;
    return `\n\n${line(rows[0])}\n|${' --- |'.repeat(w)}\n${rows.slice(1).map(line).join('\n')}\n\n`;
  });
  t = t.replace(/\[br\]/gi, '\n').replace(/\[hr\]/gi, '\n\n---\n\n');
  t = t.replace(/\[\/?(p|in|row|col\d?|section|container|concol|left|right|center|justify|rtl)\b[^\]]*\]/gi, '\n\n');
  // Anything else that looks like a tag is dropped, its words kept.
  t = t.replace(/\[\/?[a-z][\w-]*(?:[:=|][^\]\n]*)?\]/gi, '');
  return t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Turn [[@wa:id|label]] mentions into refs. */
function fixRefs(bs: Block[]): Block[] {
  const il = (c?: Inline[]) => c?.forEach((x) => {
    if (x.mention?.name?.startsWith('@wa:')) x.mention = { ref: x.mention.name.slice(1), ...(x.mention.text ? { text: x.mention.text } : {}) };
  });
  const walk = (b: Block[]) => b.forEach((x) => { if ('content' in x) il(x.content); if ('title' in x && Array.isArray((x as any).title)) il((x as any).title); if ('children' in x) walk(x.children); if (x.kind === 'infobox') x.groups.forEach((g) => g.rows.forEach((r) => il(r.value))); });
  walk(bs);
  return bs;
}

const HOLE = (n: number) => `WAHIDDEN${n}X`;

/**
 * World Anvil BBCode as blocks. Hidden parts become secret blocks: an embedded [secret:id] (unless the secret is shared with a player
 * group), [subcontainer:group]...[/subcontainer] (unless the group is a player group), [userstate:...]...[/userstate] (followers are not
 * players) and /* comments *\/. [noparse] text is kept as written.
 */
export function waBlocks(raw: unknown, c: BbcodeCtx = {}): Block[] {
  const holes: Block[][] = [];
  const hole = (bs: Block[]) => { holes.push(bs); return `\n\n${HOLE(holes.length - 1)}\n\n`; };
  const groups = c.groups ?? new Set<string>();
  const noparse: string[] = [];
  let s = String(raw ?? '').replace(/\[noparse\]([\s\S]*?)\[\/noparse\]/gi, (_m, x) => { noparse.push(x); return `WANOPARSE${noparse.length - 1}X`; });
  // Nested hidden containers: innermost first, so an outer one holds the inner one's hole.
  for (let guard = 0; guard < 20; guard++) {
    const before = s;
    s = s.replace(/\[subcontainer:([^\]]*)\]((?:(?!\[subcontainer:)[\s\S])*?)\[\/subcontainer\]/i, (_m, ids, body) => {
      const open = String(ids).split(/[,|]/).map((x) => x.trim().toLowerCase()).some((x) => x && groups.has(x));
      return open ? body : hole([{ kind: 'secret', children: fill(markdownToBlocks(bbInline(body, c))) }]);
    });
    s = s.replace(/\[userstate:[^\]]*\]((?:(?!\[userstate:)[\s\S])*?)\[\/userstate\]/i, (_m, body) => hole([{ kind: 'secret', children: fill(markdownToBlocks(bbInline(body, c))) }]));
    if (s === before) break;
  }
  s = s.replace(/\/\*([\s\S]*?)\*\//g, (_m, body) => (String(body).trim() ? hole([{ kind: 'secret', children: [{ kind: 'paragraph', content: [{ text: String(body).trim() }] }] }]) : ''));
  s = s.replace(/\[secret:([0-9a-f-]{36})\]/gi, (_m, id) => {
    const sec = c.secret?.(id.toLowerCase());
    if (!sec) return hole([{ kind: 'secret', children: [{ kind: 'paragraph', content: [{ text: 'A World Anvil secret that could not be read.' }] }] }]);
    const body: Block[] = [...(sec.title ? [{ kind: 'heading', level: 3, content: [{ text: sec.title }] } as Block] : []), ...fill(markdownToBlocks(bbInline(sec.content, c)))];
    return hole(sec.shared ? body : [{ kind: 'secret', children: body }]);
  });
  const md = bbInline(s, c).replace(/WANOPARSE(\d+)X/g, (_m, n) => noparse[Number(n)] ?? '');
  return fixRefs(fill(markdownToBlocks(md)));

  // A paragraph that is only a hole becomes the hidden blocks.
  function fill(bs: Block[]): Block[] {
    const out: Block[] = [];
    for (const b of bs) {
      if (b.kind === 'paragraph' && b.content.length === 1 && /^WAHIDDEN\d+X$/.test(String(b.content[0].text ?? '').trim())) {
        out.push(...(holes[Number(/\d+/.exec(String(b.content[0].text))![0])] ?? []));
        continue;
      }
      if (b.kind === 'paragraph' && b.content.some((x) => /WAHIDDEN\d+X/.test(String(x.text ?? '')))) {
        // A hole inside running text: the text stays, the hidden part follows it.
        const ids = b.content.flatMap((x) => [...String(x.text ?? '').matchAll(/WAHIDDEN(\d+)X/g)].map((m) => Number(m[1])));
        b.content.forEach((x) => { if (x.text) x.text = x.text.replace(/WAHIDDEN\d+X/g, ''); });
        out.push(b, ...ids.flatMap((i) => holes[i] ?? []));
        continue;
      }
      if ('children' in b) (b as any).children = fill(b.children);
      out.push(b);
    }
    return out;
  }
}

// ---------- pages ----------

/** Article fields that are not text a reader sees (metadata, display switches, links handled elsewhere). */
const NOT_CONTENT = new Set(['id', 'title', 'slug', 'state', 'isWip', 'isDraft', 'entityClass', 'icon', 'url', 'folderId', 'tags', 'updateDate', 'subscribergroups', 'isEditable', 'success', 'position', 'excerpt', 'wordcount', 'creationDate', 'publicationDate', 'notificationDate', 'likes', 'views', 'userMetadata', 'articleMetadata', 'cssClasses', 'displayCss', 'templateType', 'customArticleTemplate', 'content', 'author', 'category', 'world', 'pronunciation', 'snippet', 'seeded', 'sidebarcontent', 'sidepanelcontenttop', 'sidepanelcontent', 'sidebarcontentbottom', 'footnotes', 'fullfooter', 'authornotes', 'scrapbook', 'credits', 'displaySidebar', 'timeline', 'prompt', 'showSeeded', 'webhookUpdate', 'communityUpdate', 'commentPlaceholder', 'metaTitle', 'metadDescription', 'metaDescription', 'subheading', 'coverIsMap', 'isFeaturedArticle', 'isAdultContent', 'isLocked', 'allowComments', 'showInToc', 'isEmphasized', 'displayAuthor', 'displayChildrenUnder', 'displayTitle', 'displaySheet', 'badge', 'secrets', 'histories', 'editURL', 'cover', 'gallery', 'articleNext', 'articlePrevious', 'block', 'orgchart', 'manuscripts', 'ancestry', 'articleParent', 'systemMeta', 'presentationParameters', 'isDeleted', 'parent', 'children']);
const META_KEY = /(^is[A-Z]|^display|^show|css|url$|URL$|Date$|^meta|^notification|^webhook|^seo)/;
const human = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());

/** A referenced page (an ArticleRef and the like) as a mention. */
const refOf = (v: any): Inline | null => (v && typeof v === 'object' && UUID.test(String(v.id ?? '')) ? { mention: { ref: `wa:${String(v.id).toLowerCase()}`, ...(v.title ? { text: String(v.title) } : {}) } } : null);

/** The sections of an article besides its main text, in reading order. `hidden`: always a secret block. */
const SECTIONS: { key: string; title: string; hidden?: (a: any) => boolean }[] = [
  { key: 'sidepanelcontenttop', title: 'Sidebar' },
  { key: 'sidebarcontent', title: 'Sidebar' },
  { key: 'sidepanelcontent', title: 'Sidebar' },
  { key: 'sidebarcontentbottom', title: 'Sidebar' },
  { key: 'fullfooter', title: 'Footer' },
  { key: 'footnotes', title: 'Footnotes' },
  { key: 'authornotes', title: "Author's notes" },
  // Storyteller seeds are for game masters unless the article shows them; the scrapbook is the author's.
  { key: 'seeded', title: 'Storyteller seeds', hidden: (a) => a.showSeeded !== true },
  { key: 'scrapbook', title: 'Scrapbook', hidden: () => true },
];

export interface WaLookups {
  groups: Set<string>;
  image: (id: string) => string | null | undefined;
  title: (id: string) => string | undefined;
  /** An id to the page it is (article, category or map), or undefined. */
  known: (id: string) => boolean;
  shareVisible: boolean;
}

function parentOf(x: any, worldId: string, lk: WaLookups): string | null {
  const ids = [x?.articleParent?.id, x?.ancestry?.firstUp?.id, x?.parent?.id, x?.category?.id, x?.folderId].map((v) => String(v ?? '').toLowerCase()).filter((v) => UUID.test(v));
  for (const id of ids) if (id !== worldId && lk.known(id)) return `wa:${id}`;
  return null;
}

/** An article read in full (granularity 2 or 3) as an entry. */
export function waArticleEntry(a: any, worldId: string, lk: WaLookups, secrets: Map<string, { title: string; content: string; shared: boolean }>): Entry {
  const id = String(a.id).toLowerCase();
  const bb: BbcodeCtx = { image: lk.image, title: lk.title, groups: lk.groups, secret: (sid) => secrets.get(sid) };
  const shared = waShared(a, lk.groups);
  const facts: PropertyRow[] = [];
  if (a.pronunciation) facts.push({ key: 'Pronunciation', value: [{ text: String(a.pronunciation) }] });
  if (a.subheading) facts.push({ key: 'Subheading', value: [{ text: String(a.subheading) }] });
  const extra: Block[] = [];
  // Template fields (a Person's species, a Settlement's population...): short ones are facts, long ones sections, links mentions.
  for (const [k, v] of Object.entries(a ?? {})) {
    if (NOT_CONTENT.has(k) || META_KEY.test(k) || v == null || v === '') continue;
    if (typeof v === 'string' || typeof v === 'number') {
      const text = String(v).trim();
      if (!text || UUID.test(text)) continue;
      if (text.length <= 160 && !/\n|\[\w/.test(text)) facts.push({ key: human(k), value: [{ text }] });
      else extra.push({ kind: 'heading', level: 2, content: [{ text: human(k) }] }, ...waBlocks(text, bb));
    } else if (Array.isArray(v)) {
      const refs = v.map(refOf).filter((x): x is Inline => !!x);
      if (refs.length) facts.push({ key: human(k), value: refs.flatMap((x, i) => (i ? [{ text: ', ' }, x] : [x])) });
    } else if (typeof v === 'object') {
      const r = refOf(v);
      if (r && String((v as any).entityClass ?? '') !== 'World') facts.push({ key: human(k), value: [r] });
    }
  }
  const blocks: Block[] = [...waBlocks(a.content, bb), ...extra];
  for (const s of SECTIONS) {
    const text = String(a[s.key] ?? '').trim();
    if (!text) continue;
    const body: Block[] = [{ kind: 'heading', level: 2, content: [{ text: s.title }] }, ...waBlocks(text, bb)];
    blocks.push(...(s.hidden?.(a) ? [{ kind: 'secret', children: body } as Block] : body));
  }
  // Secrets linked to the article but not embedded in its text: kept at the end, each hidden unless shared with the players.
  const embedded = new Set([...JSON.stringify(a).matchAll(/\[secret:([0-9a-f-]{36})\]/gi)].map((m) => m[1].toLowerCase()));
  for (const ref of Array.isArray(a.secrets) ? a.secrets : []) {
    const sid = String(ref?.id ?? '').toLowerCase();
    if (!sid || embedded.has(sid)) continue;
    const sec = secrets.get(sid);
    const body: Block[] = [{ kind: 'heading', level: 3, content: [{ text: sec?.title || String(ref?.title ?? 'Secret') }] }, ...(sec ? waBlocks(sec.content, bb) : [{ kind: 'paragraph', content: [{ text: 'A World Anvil secret that could not be read.' }] } as Block])];
    blocks.push(sec?.shared ? { kind: 'heading', level: 2, content: [{ text: 'Revealed secrets' }] } : { kind: 'divider' }, ...(sec?.shared ? body : [{ kind: 'secret', children: body } as Block]));
  }
  const updated = waDate(a.updateDate);
  return {
    externalId: `wa:${id}`,
    parentExternalId: parentOf(a, worldId, lk),
    title: String(a.title ?? 'Untitled'),
    tags: tagsOf(a),
    type: waType(a.entityClass ?? a.templateType),
    icon: null,
    banner: typeof a.cover?.url === 'string' && /^https?:\/\//i.test(a.cover.url) ? a.cover.url : null,
    properties: facts.length ? [{ title: 'Facts', rows: facts }] : [],
    blocks: fixRefs(blocks),
    visibility: shared && lk.shareVisible ? 'party' : 'dm', sourceShared: shared,
    url: typeof a.url === 'string' && /^https?:\/\//i.test(a.url) ? a.url : null,
    position: Number.isFinite(Number(a.position)) && a.position !== null ? Number(a.position) : null,
    updatedAt: updated, sourceUpdatedAt: updated, depth: 'full',
  };
}

/** A category read in full as an entry: its description, under its parent category. */
export function waCategoryEntry(x: any, worldId: string, lk: WaLookups): Entry {
  const shared = waShared(x, lk.groups);
  const bb: BbcodeCtx = { image: lk.image, title: lk.title, groups: lk.groups };
  const updated = waDate(x.updateDate);
  const custom = ['custom1', 'custom2', 'custom3', 'custom4', 'custom5'].map((k) => String(x[k] ?? '').trim()).filter(Boolean);
  return {
    externalId: `wa:${String(x.id).toLowerCase()}`, parentExternalId: parentOf(x, worldId, lk), title: String(x.title ?? 'Category'), tags: tagsOf(x), type: 'category', icon: null,
    banner: typeof x.pagecover?.url === 'string' && /^https?:\/\//i.test(x.pagecover.url) ? x.pagecover.url : null,
    blocks: fixRefs([...waBlocks(x.description ?? x.excerpt, bb), ...custom.flatMap((t) => waBlocks(t, bb))]),
    visibility: shared && lk.shareVisible ? 'party' : 'dm', sourceShared: shared,
    url: typeof x.url === 'string' && /^https?:\/\//i.test(x.url) ? x.url : null,
    position: Number.isFinite(Number(x.position)) && x.position !== null ? Number(x.position) : null,
    updatedAt: updated, sourceUpdatedAt: updated, depth: 'full',
  };
}

/** A map read in full as an entry: its description and legend. Its picture and markers are records. */
export function waMapEntry(x: any, worldId: string, lk: WaLookups): Entry {
  const shared = waShared(x, lk.groups);
  const bb: BbcodeCtx = { image: lk.image, title: lk.title, groups: lk.groups };
  const updated = waDate(x.updateDate);
  const legend = String(x.legend ?? '').trim();
  return {
    externalId: `wa:${String(x.id).toLowerCase()}`, parentExternalId: parentOf(x, worldId, lk), title: String(x.title ?? 'Map'), tags: tagsOf(x), type: 'map', icon: null, banner: null,
    blocks: fixRefs([...waBlocks(x.description, bb), ...(legend ? [{ kind: 'heading', level: 2, content: [{ text: 'Legend' }] } as Block, ...waBlocks(legend, bb)] : [])]),
    visibility: shared && lk.shareVisible ? 'party' : 'dm', sourceShared: shared,
    url: typeof x.url === 'string' && /^https?:\/\//i.test(x.url) ? x.url : null,
    position: Number.isFinite(Number(x.position)) && x.position !== null ? Number(x.position) : null,
    updatedAt: updated, sourceUpdatedAt: updated, depth: 'full',
  };
}

// ---------- the crawl ----------

/** What a listing keeps for the next one and for reading pages one at a time. Small: ids, kinds, titles, addresses. */
export interface WaCache {
  /** The world's id (resolved from a name or address once). */
  w: string;
  /** Page id to kind: a article, c category, m map. */
  k: Record<string, 'a' | 'c' | 'm'>;
  /** Page id to title (for [map:id] links). */
  t: Record<string, string>;
  /** Image id to address. */
  i: Record<string, string>;
  /** Map id: [update time, picture address, the map's markers as records]. */
  mp?: Record<string, [string, string | null, SyncRecord[]]>;
  /** Timeline event (history) id: [update time, event, the timelines it is on]. */
  hs?: Record<string, [string, TimelineEvent, string[]]>;
}

/** The world's id from a uuid, or from its name, slug or address among the token user's worlds. */
async function resolveWorld(cfg: Record<string, any>, ctx: ConnectorContext): Promise<string> {
  const want = String(cfg.worldId ?? '').trim();
  if (UUID.test(want)) return want.toLowerCase();
  const me = await waCall(ctx, cfg, 'GET', '/identity');
  const uid = String(me?.id ?? '');
  if (!uid) throw new Error('World Anvil did not say whose token this is');
  const slug = (/\/w\/([^/?#]+)/.exec(want)?.[1] ?? want).toLowerCase();
  for await (const w of waList(ctx, cfg, '/user/worlds', uid)) {
    const names = [w.slug, w.title, w.name, w.url].map((v) => String(v ?? '').toLowerCase());
    if (names.includes(slug) || names.includes(want.toLowerCase()) || String(w.url ?? '').toLowerCase().includes(`/w/${slug}`)) return String(w.id).toLowerCase();
  }
  throw new Error(`No world called "${want}" among this token's worlds`);
}

const lookupsOf = (cache: WaCache, cfg: Record<string, any>, ctx: ConnectorContext): WaLookups => ({
  groups: playerGroups(cfg),
  image: (id) => cache.i[id],
  title: (id) => cache.t[id],
  known: (id) => !!cache.k[id],
  shareVisible: ctx.shareVisible,
});

/**
 * Tier 1: list categories, articles and maps (index depth, GM-only until read), the image list (for [img:id]), and the map markers and
 * timeline events that changed since the last listing (one call each; unchanged ones come from the cache). Every listing is complete.
 */
async function* waIndex(cfg: Record<string, any>, ctx: ConnectorContext, state: { prev: WaCache | null; next?: WaCache }): AsyncIterable<SyncItem> {
  const prev = state.prev;
  const worldId = prev?.w && (!cfg.worldId || prev.w === String(cfg.worldId).toLowerCase() || !UUID.test(String(cfg.worldId))) ? prev.w : await resolveWorld(cfg, ctx);
  const cache: WaCache = { w: worldId, k: {}, t: {}, i: {}, mp: {}, hs: {} };
  const groups = playerGroups(cfg);
  const cats: any[] = []; const arts: any[] = []; const maps: any[] = [];
  for await (const x of waList(ctx, cfg, '/world/categories', worldId)) if (UUID.test(String(x.id ?? ''))) cats.push(x);
  for await (const x of waList(ctx, cfg, '/world/articles', worldId)) if (UUID.test(String(x.id ?? ''))) arts.push(x);
  const withMaps = cfg.importMaps !== false;
  if (withMaps) {
    try { for await (const x of waList(ctx, cfg, '/world/maps', worldId)) if (UUID.test(String(x.id ?? ''))) maps.push(x); }
    catch (err: any) { if (ctx.signal.aborted) throw err; ctx.log(`Could not list maps: ${err.message}`); ctx.incomplete?.add('mapMarker'); ctx.incomplete?.add('image'); }
  }
  try { for await (const x of waList(ctx, cfg, '/world/images', worldId)) if (x.id != null && typeof x.url === 'string' && /^https?:\/\//i.test(x.url)) cache.i[String(x.id)] = x.url; }
  catch (err: any) { if (ctx.signal.aborted) throw err; ctx.log(`Could not list images: ${err.message}. Pictures in text are left out.`); Object.assign(cache.i, prev?.i ?? {}); }
  for (const [kind, rows] of [['c', cats], ['a', arts], ['m', maps]] as const) for (const x of rows) { const id = String(x.id).toLowerCase(); cache.k[id] = kind; cache.t[id] = String(x.title ?? ''); }
  ctx.log(`Listed ${arts.length} articles, ${cats.length} categories and ${maps.length} maps`);
  state.next = cache;
  const lk = lookupsOf(cache, cfg, ctx);
  // Index pages: what the list gives. A draft, or a private page no player group can see, is restricted at once.
  for (const [kind, rows] of [['c', cats], ['a', arts], ['m', maps]] as const) {
    for (const x of rows) {
      const type = kind === 'c' ? 'category' : kind === 'm' ? 'map' : waType(x.entityClass);
      const title = String(x.title ?? 'Untitled');
      const tags = tagsOf(x);
      const updated = waDate(x.updateDate);
      yield {
        externalId: `wa:${String(x.id).toLowerCase()}`, parentExternalId: parentOf(x, worldId, lk), title, tags, type, icon: null,
        blocks: indexBlocks({ title, type, tags }),
        url: typeof x.url === 'string' && /^https?:\/\//i.test(x.url) ? x.url : null,
        visibility: 'dm', restricted: !waShared(x, groups), updatedAt: updated, sourceUpdatedAt: updated, depth: 'index',
      } satisfies Entry;
    }
  }
  const share = (ok: boolean) => (ok && ctx.shareVisible ? 'party' : 'dm') as 'dm' | 'party';

  // Map pictures and markers: read again only for a map whose update time moved (a marker's own change moves the map's too, as far as
  // World Anvil documents; a full refresh reads them all).
  for (const m of maps) {
    const id = String(m.id).toLowerCase();
    const updated = String(waDate(m.updateDate) ?? '');
    const had = prev?.mp?.[id];
    let entry: [string, string | null, SyncRecord[]] | null = had && had[0] === updated && updated ? had : null;
    if (!entry) {
      try {
        const full = await waCall(ctx, cfg, 'GET', '/map', { query: { id, granularity: '2' } });
        const recs: SyncRecord[] = [];
        const mapShared = waShared(full ?? m, groups);
        for (const ref of Array.isArray(full?.markers) ? full.markers : []) {
          const mid = String(ref?.id ?? '');
          if (!mid) continue;
          const mk = await waCall(ctx, cfg, 'GET', '/marker', { query: { id: mid, granularity: '2' } }).catch((err) => { if (ctx.signal.aborted) throw err; return null; });
          if (!mk || !Number.isFinite(Number(mk.geoX)) || !Number.isFinite(Number(mk.geoY))) continue;
          const target = [mk.targetArticle, mk.targetLocation, mk.targetOrganization, mk.targetMap, mk.targetCategory].find((t) => t && UUID.test(String(t.id ?? '')));
          recs.push({
            kind: 'mapMarker', externalId: `wa:marker:${mid}`, mapRef: `wa:${id}`, name: String(mk.title || target?.title || 'Marker').slice(0, 300),
            // World Anvil places markers in the map picture's pixels: y down, x across.
            latitude: Number(mk.geoY), longitude: Number(mk.geoX),
            shape: mk.type === 'polygon' || mk.type === 'circle' || mk.type === 'label' ? String(mk.type) : 'marker',
            color: typeof mk.colorFill === 'string' && /^#?[0-9a-f]{3,8}$/i.test(mk.colorFill) ? mk.colorFill : null,
            ref: target ? `wa:${String(target.id).toLowerCase()}` : null,
            visibility: share(mapShared && waShared(mk, groups)),
          });
        }
        const pic = typeof full?.image?.url === 'string' && /^https?:\/\//i.test(full.image.url) ? full.image.url : null;
        entry = [updated, pic, recs];
      } catch (err: any) {
        if (ctx.signal.aborted) throw err;
        ctx.log(`Could not read map ${m.title}: ${err.message}`);
        ctx.incomplete?.add('mapMarker');
        entry = had ?? null;
      }
    }
    if (!entry) continue;
    cache.mp![id] = entry;
    yield* entry[2];
    if (entry[1]) {
      const rec = await pictureRecord(ctx, { externalId: `wa:mapimg:${id}`, pageRef: `wa:${id}`, name: String(m.title ?? 'Map'), url: entry[1], updated: entry[0] || null, visible: share(waShared(m, groups)) === 'party', map: true, origin: new URL(waBase(cfg)).origin });
      if (rec) yield rec;
    }
  }

  // Timelines: each World Anvil timeline is one, its events (histories) in date order; events on no timeline form "World history".
  if (cfg.importTimelines !== false) {
    try {
      const tls: any[] = [];
      for await (const x of waList(ctx, cfg, '/world/timelines', worldId)) if (x?.id) tls.push(x);
      const hist: any[] = [];
      for await (const x of waList(ctx, cfg, '/world/histories', worldId)) if (x?.id) hist.push(x);
      for (const h of hist) {
        const hid = String(h.id).toLowerCase();
        const updated = String(waDate(h.updateDate) ?? '');
        const had = prev?.hs?.[hid];
        if (had && had[0] === updated && updated) { cache.hs![hid] = had; continue; }
        const full = await waCall(ctx, cfg, 'GET', '/history', { query: { id: hid, granularity: '2' } }).catch((err) => { if (ctx.signal.aborted) throw err; return null; });
        if (!full) { if (had) cache.hs![hid] = had; continue; }
        const ref = [full.article, full.location, ...(Array.isArray(full.characters) ? full.characters : []), ...(Array.isArray(full.organizations) ? full.organizations : [])].find((t) => t && UUID.test(String(t.id ?? '')));
        const date = [full.year, full.month, full.day].filter((v) => v !== null && v !== undefined && v !== '').join('-');
        const text = String(full.fullcontent || full.content || '').trim();
        const ev: TimelineEvent = {
          id: hid, name: String(full.title ?? 'Event'), date: String(full.displayDateName || date || '') || null,
          description: text ? waBlocks(text, { image: (i) => cache.i[i], title: (i) => cache.t[i], groups }) : [],
          color: typeof full.backgroundColor === 'string' ? full.backgroundColor : null,
          ref: ref ? `wa:${String(ref.id).toLowerCase()}` : null,
          visibility: share(waShared(full, groups)),
        };
        cache.hs![hid] = [updated, ev, (Array.isArray(full.timelines) ? full.timelines : []).map((t: any) => String(t?.id ?? '').toLowerCase()).filter(Boolean)];
      }
      const events = Object.values(cache.hs!);
      const year = (e: TimelineEvent) => Number(/^-?\d+/.exec(String(e.date ?? ''))?.[0] ?? Infinity);
      const groupOf = (name: string, evs: TimelineEvent[]): TimelineGroup => ({ name, events: evs.slice().sort((a, b) => year(a) - year(b)) });
      for (const tl of tls) {
        const tid = String(tl.id).toLowerCase();
        yield { kind: 'timeline', externalId: `wa:${tid}`, name: String(tl.title ?? 'Timeline'), visibility: share(waShared(tl, groups)), groups: [groupOf(String(tl.title ?? 'Timeline'), events.filter((e) => e[2].includes(tid)).map((e) => e[1]))] } satisfies SyncRecord;
      }
      const loose = events.filter((e) => !e[2].some((t) => tls.some((tl) => String(tl.id).toLowerCase() === t))).map((e) => e[1]);
      if (loose.length) yield { kind: 'timeline', externalId: `wa:history:${worldId}`, name: 'World history', visibility: share(true), groups: [groupOf('World history', loose)] } satisfies SyncRecord;
    } catch (err: any) {
      if (ctx.signal.aborted) throw err;
      ctx.log(`Could not read timelines: ${err.message}`);
      ctx.incomplete?.add('timeline');
    }
  }
}

/** The secrets an article embeds or links, read one at a time. */
async function readSecrets(cfg: Record<string, any>, ctx: ConnectorContext, a: any, groups: Set<string>): Promise<Map<string, { title: string; content: string; shared: boolean }>> {
  const ids = new Set<string>([...JSON.stringify(a ?? {}).matchAll(/\[secret:([0-9a-f-]{36})\]/gi)].map((m) => m[1].toLowerCase()));
  for (const s of Array.isArray(a?.secrets) ? a.secrets : []) if (UUID.test(String(s?.id ?? ''))) ids.add(String(s.id).toLowerCase());
  const out = new Map<string, { title: string; content: string; shared: boolean }>();
  for (const id of [...ids].slice(0, 50)) {
    const s = await waCall(ctx, cfg, 'GET', '/secret', { query: { id, granularity: '0' } }).catch((err) => { if (ctx.signal.aborted) throw err; ctx.log(`Could not read a secret of ${a?.title}: ${err.message}`); return null; });
    // A secret is shared only through a player subscriber group (World Anvil keeps every secret private otherwise).
    if (s) out.set(id, { title: String(s.title ?? ''), content: String(s.content ?? ''), shared: s.isDraft !== true && inGroups(s, groups) });
  }
  return out;
}

/** Tier 3: whole pages for these ids (articles with their secrets, categories, maps). */
async function* waDetail(cfg: Record<string, any>, ctx: ConnectorContext, ids: string[], cache: WaCache | null): AsyncIterable<SyncItem> {
  if (!cache?.w) return;
  const lk = lookupsOf(cache, cfg, ctx);
  for (const ext of ids) {
    if (ctx.signal.aborted) throw new Error('Sync stopped');
    const id = ext.replace(/^wa:/, '').toLowerCase();
    if (!UUID.test(id)) continue;
    const kind = cache.k[id] ?? 'a';
    if (kind === 'c') {
      const x = await waCall(ctx, cfg, 'GET', '/category', { query: { id, granularity: '2' } });
      if (x) yield waCategoryEntry(x, cache.w, lk);
    } else if (kind === 'm') {
      const x = await waCall(ctx, cfg, 'GET', '/map', { query: { id, granularity: '2' } });
      if (x) yield waMapEntry(x, cache.w, lk);
    } else {
      // Granularity 3 adds the article's ancestry (its parent article); some articles only answer at 2.
      let r = await waHttp(ctx, cfg, 'GET', '/article', { query: { id, granularity: '3' } });
      if (r.status === 400 || r.status === 422 || r.status === 500) r = await waHttp(ctx, cfg, 'GET', '/article', { query: { id, granularity: '2' } });
      if (r.status === 404) continue;
      if (r.status < 200 || r.status >= 300 || !r.body || r.body.success === false) throw new Error(`World Anvil answered ${r.status} for /article`);
      const secrets = await readSecrets(cfg, ctx, r.body, lk.groups);
      yield waArticleEntry(r.body, cache.w, lk, secrets);
    }
  }
}

/** Everything at once: the listing, then every page read in full. */
async function* waSync(cfg: Record<string, any>, ctx: ConnectorContext): AsyncIterable<SyncItem> {
  const state: { prev: WaCache | null; next?: WaCache } = { prev: null };
  const ids: string[] = [];
  for await (const x of waIndex(cfg, ctx, state)) {
    if ((x as any).kind) yield x;
    else ids.push((x as Entry).externalId);
  }
  const prevPhase = ctx.calls?.phase;
  if (ctx.calls) ctx.calls.phase = 'detail';
  try { yield* waDetail(cfg, ctx, ids, state.next ?? null); } finally { if (ctx.calls && prevPhase) ctx.calls.phase = prevPhase; }
}

export const worldAnvilApi: Connector = {
  id: 'worldanvil-api',
  label: 'World Anvil (API)',
  description: 'Reads a World Anvil world with an application key and your user token: articles, categories, secrets, maps with markers, and timelines. Drafts, private pages and secrets stay GM-only unless shared with a player subscriber group.',
  aliases: ['worldanvil'],
  capabilities: ['pages', 'properties', 'tags', 'images', 'timelines', 'maps', 'items', 'characters'],
  fields: [
    { key: 'worldId', label: 'World', type: 'text', required: true, help: 'The world’s id, or its name or address (https://www.worldanvil.com/w/<world>). Test the connection to see your worlds.' },
    { key: 'token', label: 'User API token', type: 'password', secret: true, required: true, help: 'World Anvil → your account → API Tokens. It reads what you can read, secrets included.' },
    { key: 'appKey', label: 'Application key', type: 'password', secret: true, help: 'The key World Anvil gave you for this app (request form; Grandmaster guild and above). Leave empty if the server sets ALX_WORLDANVIL_APP_KEY.' },
    { key: 'apiUrl', label: 'API URL', type: 'url', placeholder: WA_API, help: 'Leave empty.' },
    { key: 'playerGroups', label: 'Player subscriber groups', type: 'text', help: 'Names or ids of the subscriber groups your players are in, comma separated. Private pages and secrets shared with these groups are the players’; everything else private stays GM-only.' },
    { key: 'importMaps', label: 'Import maps and markers', type: 'boolean', default: true, help: 'One call per changed map and one per marker on it.' },
    { key: 'importTimelines', label: 'Import timelines', type: 'boolean', default: true, help: 'One call per changed timeline event.' },
  ],
  validate(cfg, ctx) {
    if (!String(cfg.worldId ?? '').trim()) throw new ConfigError('World is required: its id, name or address');
    if (String(cfg.token ?? '').length < 10) throw new ConfigError('User API token is required');
    if (!waAppKey(cfg, ctx.env)) throw new ConfigError('Application key is required (or set ALX_WORLDANVIL_APP_KEY on the server)');
    if (cfg.apiUrl && !/^https:\/\/\S+$/.test(String(cfg.apiUrl))) throw new ConfigError('API URL must start with https://');
  },
  async test(cfg, ctx) {
    const me = await waHttp(ctx, cfg, 'GET', '/identity');
    if (me.status === 401 || me.status === 403) return { ok: false, message: `World Anvil refused the keys (${me.status}). Check the application key and the user token.` };
    if (me.status !== 200 || !me.body?.id) return { ok: false, message: `World Anvil answered ${me.status}.` };
    const worlds: { id: string; title: string }[] = [];
    try { for await (const w of waList(ctx, cfg, '/user/worlds', String(me.body.id))) { worlds.push({ id: String(w.id), title: String(w.title ?? w.name ?? '') }); if (worlds.length >= 20) break; } } catch { /* the identity is enough */ }
    let world = '';
    try { const wid = await resolveWorld(cfg, ctx); world = worlds.find((w) => w.id.toLowerCase() === wid)?.title || wid; } catch (err: any) {
      return { ok: false, message: `Connected as ${me.body.username ?? 'you'}, but ${err.message}. Your worlds: ${worlds.map((w) => `${w.title} (${w.id})`).join(', ') || 'none'}.`, sample: worlds };
    }
    return { ok: true, message: `Connected as ${me.body.username ?? 'you'}. World: ${world}.`, sample: worlds.map((w) => `${w.title} (${w.id})`) };
  },
  sync: waSync,
  // World Anvil publishes no rate limit: stay gentle (see DEFAULT_LIMITS).
  tiered: () => ({
    budgetPerMinute: 48,
    index: async function* (cfg, ctx) {
      const state: { prev: WaCache | null; next?: WaCache } = { prev: (ctx.tier?.cache ?? null) as WaCache | null };
      yield* waIndex(cfg, ctx, state);
      if (ctx.tier) { ctx.tier.complete = true; ctx.tier.next = { token: null, cache: (state.next ?? null) as unknown as Record<string, any> }; }
    },
    detail: (cfg, ctx, ids) => waDetail(cfg, ctx, ids, (ctx.tier?.cache ?? null) as WaCache | null),
  }),
};
