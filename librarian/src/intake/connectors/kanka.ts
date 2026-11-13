// Kanka, through its API (token + campaign) or the mcp-kanka server.
// Private entities are DM-only. Posts are added as sections: shared posts
// (visibility all or members, no deny permission) stay visible, every other
// post becomes a secret block. Private attributes, and all attributes of an
// entity with is_attributes_private, go in a DM-only property group.
import type { CalendarDefinition, Connector, ConnectorContext, SyncItem, SyncRecord, TimelineGroup } from '../connector.ts';
import { ConfigError } from '../connector.ts';
import { type Block, type Entry, type Inline, type PropertyGroup, markdownToBlocks } from '../model.ts';
import { jsonOf } from '../../core/mcp.ts';
import { htmlToMarkdown } from '../html.ts';

// [API module, Alexandria type, legacy parent field]. Since Kanka 3.10 every
// nestable module has `parent_id`, the parent's entity id; older responses
// carried a module id in the legacy field instead.
const TYPES: [string, string, string | null][] = [
  ['characters', 'character', null], ['locations', 'location', 'location_id'], ['organisations', 'organisation', 'organisation_id'],
  ['families', 'family', 'family_id'], ['items', 'item', 'item_id'], ['notes', 'note', 'note_id'], ['journals', 'journal', 'journal_id'],
  ['quests', 'quest', 'quest_id'], ['races', 'race', 'race_id'], ['creatures', 'creature', 'creature_id'], ['events', 'event', 'event_id'],
  ['abilities', 'ability', 'ability_id'], ['timelines', 'timeline', 'timeline_id'], ['maps', 'map', 'map_id'], ['calendars', 'calendar', 'calendar_id'],
  ['tags', 'tag', 'tag_id'],
];
// visibility_id (https://app.kanka.io/api-docs/1.0/misc/visibilities): 1 all,
// 2 admin, 3 admin-self, 4 self, 5 members. The posts page numbers 2-4
// differently (2 self, 3 admin, 4 self-admin); either way only 1 and 5 reach
// players, and any other or missing value stays DM-only.
const PLAYER_VISIBLE = new Set([1, 5]);
// Post permission entries: 0 read, 1 update, 2 deny. A deny (or anything
// unknown) means not every player can read the post.
const postShared = (p: any) => PLAYER_VISIBLE.has(Number(p?.visibility_id))
  && (p.permissions == null || (Array.isArray(p.permissions) && p.permissions.every((x: any) => x?.permission === 0 || x?.permission === 1)));

// Mentions: [entity:ID], [character:ID], [location:ID|label]... The ID is
// always the entity id. Options after | that look like key:value (field:,
// anchor:, alias:) are not labels.
const MENTION_TYPES = 'entity|character|location|family|organisation|organization|item|note|journal|quest|race|creature|event|ability|timeline|map|calendar|tag|conversation|dice_roll|attribute_template|post';
const MENTION = new RegExp(`\\[(?:${MENTION_TYPES}):(\\d+)(?:\\|([^\\]]*))?\\]`, 'g');

/** Kanka text (HTML or Markdown, with [type:ID|label] mentions) to blocks with mention refs. */
export function kankaBlocks(raw: unknown): Block[] {
  let s = String(raw ?? '');
  s = s.replace(MENTION, (_m, id, opt) => {
    const label = opt && !/^\w+:/.test(opt) ? opt : '';
    return `[[@kanka:${id}${label ? '|' + label : ''}]]`;
  });
  if (/<\/?(p|br|div|span|strong|em|ul|ol|li|h\d|a|table|blockquote)\b/i.test(s)) s = htmlToMarkdown(s);
  else s = s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
  return fixRefs(markdownToBlocks(s));
}

function fixRefs(bs: Block[]): Block[] {
  const il = (c?: Inline[]) => c?.forEach((x) => {
    if (x.mention?.name?.startsWith('@kanka:')) {
      x.mention = { ref: x.mention.name.slice(1), ...(x.mention.text ? { text: x.mention.text } : {}) };
    }
  });
  const walk = (b: Block[]) => b.forEach((x) => { if ('content' in x) il(x.content); if ('title' in x && Array.isArray((x as any).title)) il((x as any).title); if ('children' in x) walk(x.children); });
  walk(bs);
  return bs;
}

const esc = (s: unknown) => String(s ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

function postBlocks(posts: any[], trust: (p: any) => boolean): Block[] {
  const out: Block[] = [];
  for (const p of posts) {
    const section: Block[] = [{ kind: 'heading', level: 2, content: [{ text: esc(p.name) || 'Post' }] }, ...kankaBlocks(p.entry ?? p.entry_parsed)];
    if (trust(p)) out.push(...section);
    else out.push({ kind: 'secret', children: section });
  }
  return out;
}

const ref = (entityId: unknown): Inline => ({ mention: { ref: `kanka:${entityId}` } });
const join = (xs: Inline[]): Inline[] => xs.flatMap((x, i) => (i ? [{ text: ', ' }, x] : [x]));
/** One line of inline text from a Kanka value: plain text stays as is, HTML and mentions are parsed. */
function textOf(v: unknown): Inline[] {
  const s = String(v ?? '');
  if (!/[<[]/.test(s)) return s.trim() ? [{ text: esc(s.trim()) }] : [];
  const out: Inline[] = [];
  const walk = (bs: Block[]) => bs.forEach((b) => {
    if (b.kind === 'secret' || b.kind === 'unsupported') return;
    if ('content' in b && b.content.length) { if (out.length) out.push({ text: ' ' }); out.push(...b.content); }
    if ('children' in b) walk(b.children);
  });
  walk(kankaBlocks(s));
  return out;
}

/**
 * Property groups of one Kanka entity. Private attributes, every attribute when
 * `is_attributes_private` is not false, private races and families, and
 * personality traits players can't see all go in DM-only groups.
 */
export function kankaProperties(e: any, type: string, lookup: (module: string, id: unknown) => string | undefined): PropertyGroup[] {
  const facts: { key: string; value: Inline[] }[] = [];
  const dmFacts: { key: string; value: Inline[] }[] = [];
  if (e.type) facts.push({ key: 'Type', value: [{ text: esc(e.type) }] });
  if (type === 'character') {
    if (e.title) facts.push({ key: 'Title', value: [{ text: esc(e.title) }] });
    for (const [field, label] of [['age', 'Age'], ['sex', 'Gender'], ['pronouns', 'Pronouns']] as const) if (e[field]) facts.push({ key: label, value: [{ text: esc(e[field]) }] });
    if (e.is_dead === true) facts.push({ key: 'Status', value: [{ text: 'Dead' }] });
  }
  if (type === 'location' && e.title) facts.push({ key: 'Title', value: [{ text: esc(e.title) }] });
  const links = (module: string, ids: unknown): Inline[] => join((Array.isArray(ids) ? ids : ids != null ? [ids] : [])
    .map((id) => lookup(module, typeof id === 'object' && id ? (id as any).id : id)).filter((x): x is string => !!x).map(ref));
  for (const [module, field, privateField, label] of [['races', 'races', 'private_races', 'Race'], ['families', 'families', 'private_families', 'Family'], ['locations', 'locations', null, 'Location']] as const) {
    const v = links(module, e[field]);
    if (v.length) facts.push({ key: label, value: v });
    const pv = privateField ? links(module, e[privateField]) : [];
    if (pv.length) dmFacts.push({ key: label, value: pv });
  }
  if (e.location_id && !Array.isArray(e.locations)) { const v = links('locations', e.location_id); if (v.length) facts.push({ key: 'Location', value: v }); }

  const attrs = (Array.isArray(e.attributes) ? e.attributes : []).filter((a: any) => a?.name && a.type_id !== 4);
  const allPrivate = e.is_attributes_private !== false;
  const row = (a: any) => ({ key: esc(a.name), value: a.type_id === 3 ? [{ text: a.value && a.value !== '0' ? 'Yes' : 'No' }] : textOf(a.parsed ?? a.value) });
  const shared = attrs.filter((a: any) => !allPrivate && a.is_private === false && a.is_hidden !== true);
  const hiddenAttrs = attrs.filter((a: any) => !shared.includes(a));

  const traits = Array.isArray(e.traits) ? e.traits : [];
  const traitShared = (t: any) => t?.is_private !== true && (t?.section === 'appearance' || (t?.section === 'personality' && e.is_personality_visible === true));
  const traitRows = (ts: any[]) => ts.filter((t) => t?.name).map((t) => ({ key: esc(t.name), value: textOf(t.entry ?? t.entry_parsed) }));
  const appearance = traitRows(traits.filter((t: any) => t?.section === 'appearance' && traitShared(t)));
  const personality = traitRows(traits.filter((t: any) => t?.section === 'personality' && traitShared(t)));
  const dmTraits = traitRows(traits.filter((t: any) => !traitShared(t)));

  return [
    ...(facts.length ? [{ title: 'Facts', rows: facts }] : []),
    ...(appearance.length ? [{ title: 'Appearance', rows: appearance }] : []),
    ...(personality.length ? [{ title: 'Personality', rows: personality }] : []),
    ...(shared.length ? [{ title: 'Attributes', rows: shared.map(row) }] : []),
    ...(dmFacts.length ? [{ title: 'Private links', dm: true, rows: dmFacts }] : []),
    ...(dmTraits.length ? [{ title: 'Private traits', dm: true, rows: dmTraits }] : []),
    ...(hiddenAttrs.length ? [{ title: 'Private attributes', dm: true, rows: hiddenAttrs.map(row) }] : []),
  ];
}

// ---------- API ----------

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Sync stopped'));
    const t = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(t); reject(new Error('Sync stopped')); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

async function* kankaApiSync(cfg: any, ctx: ConnectorContext): AsyncIterable<SyncItem> {
  const base = String(cfg.apiUrl || 'https://api.kanka.io/1.0').replace(/\/$/, '');
  // 30 requests a minute (90 for subscribers) per user; 429 when spent. Wait
  // for Retry-After when sent, else back off 15 s, 30 s, 45 s.
  const get = async (url: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await ctx.fetch(url, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' }, signal: ctx.signal });
      if (r.status === 429) {
        const ra = Number(r.headers.get('retry-after'));
        await pause(Number.isFinite(ra) && ra >= 0 && r.headers.get('retry-after') !== null ? Math.min(ra, 120) * 1000 : 15_000 * (attempt + 1), ctx.signal);
        continue;
      }
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Kanka answered ${r.status} for ${url.replace(base, '')}`);
      return r.json() as Promise<any>;
    }
    throw new Error('Kanka kept rate-limiting; try again later');
  };
  // Every page of a collection. links.next can drop ?related=1, so the next
  // URL is built here rather than followed (and never leaves the API host).
  const pages = async function* (path: string) {
    for (let page = 1; page <= 500; page++) {
      const j: any = await get(`${base}${path}${path.includes('?') ? '&' : '?'}page=${page}`);
      if (!j) return;
      yield (Array.isArray(j.data) ? j.data : []) as any[];
      const last = Number(j.meta?.last_page);
      if (!j.links?.next || (Number.isFinite(last) && last > 0 && page >= last)) return;
    }
  };
  const camp = `/campaigns/${cfg.campaignId}`;
  const rows: { mod: string; type: string; parentField: string | null; e: any }[] = [];
  for (const [mod, type, parentField] of TYPES) {
    for await (const data of pages(`${camp}/${mod}?related=1`)) for (const e of data) rows.push({ mod, type, parentField, e });
  }
  ctx.log(`Listed ${rows.length} entities`);
  // Module id -> entity id, and which entity ids exist per type.
  const byModule = new Map<string, string>(rows.map(({ mod, e }) => [`${mod}:${e.id}`, String(e.entity_id ?? e.id)]));
  const entityIds = new Set(rows.map(({ type, e }) => `${type}:${e.entity_id}`));
  const lookup = (mod: string, id: unknown) => (id == null ? undefined : byModule.get(`${mod}:${id}`));
  // Tag names, only for tags players can see (not private, not hidden).
  const tagName = new Map<string, string>(rows.filter(({ mod, e }) => mod === 'tags' && e.is_private === false && e.is_hidden !== true).map(({ e }) => [String(e.id), esc(e.name)]));
  // is_attributes_private is documented on /entities; fill it in from there when the module list leaves it out.
  if (rows.some(({ e }) => typeof e.is_attributes_private !== 'boolean' && Array.isArray(e.attributes) && e.attributes.length)) {
    const flags = new Map<string, boolean>();
    try {
      for await (const data of pages(`${camp}/entities`)) for (const x of data) if (typeof x.is_attributes_private === 'boolean') flags.set(String(x.id), x.is_attributes_private);
    } catch (err: any) { ctx.log(`Could not read attribute privacy: ${err.message}. Attributes stay DM-only.`); }
    for (const { e } of rows) if (typeof e.is_attributes_private !== 'boolean' && flags.has(String(e.entity_id))) e.is_attributes_private = flags.get(String(e.entity_id));
  }
  for (const { mod, type, parentField, e } of rows) {
    if (e.is_template === true) continue;
    const entityId = String(e.entity_id ?? e.id);
    const pid = e.parent_id != null && entityIds.has(`${type}:${e.parent_id}`) ? String(e.parent_id)
      : parentField && e[parentField] != null ? lookup(mod, e[parentField]) : undefined;
    const tags = (Array.isArray(e.tags) ? e.tags : []).map((t: any) => tagName.get(String(typeof t === 'object' && t ? t.id ?? t.tag_id : t))).filter((t: any): t is string => !!t);
    yield {
      externalId: `kanka:${entityId}`,
      parentExternalId: pid ? `kanka:${pid}` : null,
      folder: [type[0].toUpperCase() + type.slice(1) + 's'],
      title: esc(e.name),
      tags,
      type,
      icon: null,
      banner: typeof e.image_full === 'string' && /^https?:/.test(e.image_full) && e.has_custom_image !== false && !/default/.test(e.image_full) ? e.image_full : null,
      properties: kankaProperties(e, type, lookup),
      blocks: [...kankaBlocks(e.entry ?? e.entry_parsed), ...postBlocks(e.posts ?? [], postShared)],
      // Kanka's own private flag always wins; a missing flag counts as private.
      visibility: e.is_private === false && ctx.shareVisible ? 'party' : 'dm',
      url: e.urls?.view ?? null,
      updatedAt: e.updated_at ?? null,
    };
  }

  // ---- Relations, timelines, calendars and map markers ----
  // A listing that can't be read is marked incomplete, so what was stored before is kept.
  const share = (shared: boolean) => (shared && ctx.shareVisible ? 'party' : 'dm') as 'dm' | 'party';
  // A name for an unnamed element or marker, only from an entity players may see.
  const publicName = new Map<string, string>(rows.filter(({ e }) => e.is_private === false).map(({ e }) => [String(e.entity_id), esc(e.name)]));

  // Relations: GET relations lists the campaign's. Shared only for visibility "all" or "members" on a non-private relation.
  const listStrict = async (path: string): Promise<any[] | null> => {
    const out: any[] = [];
    try {
      for (let page = 1; page <= 500; page++) {
        const j: any = await get(`${base}${path}${path.includes('?') ? '&' : '?'}page=${page}`);
        if (!j) return null;
        out.push(...(Array.isArray(j.data) ? j.data : []));
        const last = Number(j.meta?.last_page);
        if (!j.links?.next || (Number.isFinite(last) && last > 0 && page >= last)) return out;
      }
      return out;
    } catch (err: any) {
      if (ctx.signal.aborted) throw err;
      ctx.log(`Could not read ${path}: ${err.message}`);
      return null;
    }
  };
  const rels = await listStrict(`${camp}/relations`);
  if (rels === null) ctx.incomplete?.add('relation');
  for (const r of rels ?? []) {
    if (r?.owner_id == null || r?.target_id == null || !r.relation) continue;
    yield {
      kind: 'relation', externalId: `kanka:rel:${r.id ?? `${r.owner_id}-${r.target_id}-${r.relation}`}`, from: `kanka:${r.owner_id}`, to: `kanka:${r.target_id}`, label: esc(r.relation),
      attitude: typeof r.attitude === 'number' ? r.attitude : null,
      visibility: share(r.is_private !== true && PLAYER_VISIBLE.has(Number(r.visibility_id))),
    } satisfies SyncRecord;
  }

  for (const { mod, e } of rows) {
    if (mod !== 'calendars' || e.is_template === true) continue;
    yield { kind: 'calendar', externalId: `kanka:${e.entity_id ?? e.id}`, name: esc(e.name), visibility: share(e.is_private === false), definition: kankaCalendar(e), current: kankaDate(e.date) } satisfies SyncRecord;
  }

  for (const { mod, e } of rows) {
    if (mod !== 'timelines' || e.is_template === true) continue;
    let tl = e;
    if (!Array.isArray(tl.eras)) {
      const j: any = await get(`${base}${camp}/timelines/${e.id}`).catch(() => null);
      if (!j?.data || !Array.isArray(j.data.eras)) { ctx.log(`Could not read the eras of ${e.name}`); ctx.incomplete?.add('timeline'); continue; }
      tl = j.data;
    }
    const timelineShared = tl.is_private === false;
    const groups: TimelineGroup[] = (tl.eras as any[]).slice().sort((a, b) => Number(a?.position ?? 0) - Number(b?.position ?? 0)).map((era) => ({
      name: esc(era.name ?? 'Era'), abbreviation: era.abbreviation ? esc(era.abbreviation) : null,
      description: era.entry || era.entry_parsed ? kankaBlocks(era.entry ?? era.entry_parsed) : [],
      events: (Array.isArray(era.elements) ? era.elements : []).slice().sort((a: any, b: any) => Number(a?.position ?? 0) - Number(b?.position ?? 0)).filter((el: any) => el?.id != null).map((el: any) => ({
        id: String(el.id),
        name: esc(el.name) || (el.entity_id != null ? publicName.get(String(el.entity_id)) : undefined) || 'Event',
        date: el.date ? esc(el.date) : null,
        description: el.entry || el.entry_parsed ? kankaBlocks(el.entry ?? el.entry_parsed) : [],
        color: typeof el.colour === 'string' ? el.colour : null,
        ref: el.entity_id != null ? `kanka:${el.entity_id}` : null,
        visibility: share(timelineShared && PLAYER_VISIBLE.has(Number(el.visibility_id))),
      })),
    }));
    yield { kind: 'timeline', externalId: `kanka:${tl.entity_id ?? tl.id}`, name: esc(tl.name), visibility: share(timelineShared), groups } satisfies SyncRecord;
  }

  const SHAPES: Record<number, string> = { 1: 'marker', 2: 'label', 3: 'circle', 4: 'polygon' };
  for (const { mod, e } of rows) {
    if (mod !== 'maps' || e.is_template === true) continue;
    const markers = await listStrict(`${camp}/maps/${e.id}/map_markers`);
    if (markers === null) { ctx.incomplete?.add('mapMarker'); continue; }
    for (const m of markers) {
      if (m?.id == null || !Number.isFinite(Number(m.latitude)) || !Number.isFinite(Number(m.longitude))) continue;
      yield {
        kind: 'mapMarker', externalId: `kanka:marker:${m.id}`, mapRef: `kanka:${e.entity_id ?? e.id}`,
        name: esc(m.name) || (m.entity_id != null ? publicName.get(String(m.entity_id)) : undefined) || 'Marker',
        latitude: Number(m.latitude), longitude: Number(m.longitude), shape: SHAPES[Number(m.shape_id)] ?? 'marker', color: typeof m.colour === 'string' && /^#?[0-9a-f]{3,8}$/i.test(m.colour) ? m.colour : null,
        ref: m.entity_id != null ? `kanka:${m.entity_id}` : null,
        visibility: share(e.is_private === false && m.is_private !== true && PLAYER_VISIBLE.has(Number(m.visibility_id))),
      } satisfies SyncRecord;
    }
  }
}

/** Kanka's "year-month-day" current date, or null. */
export function kankaDate(v: unknown): { year: number; month: number; day: number } | null {
  const m = /^(-?\d+)-(\d+)-(\d+)$/.exec(String(v ?? '').trim());
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
}

/** A Kanka calendar as the world clock's definition. */
export function kankaCalendar(e: any): CalendarDefinition {
  return {
    name: esc(e.name),
    epochYear: e.skip_year_zero === true ? 1 : 0,
    ...(e.suffix ? { yearSuffix: esc(e.suffix) } : {}),
    months: (Array.isArray(e.months) ? e.months : []).map((m: any) => ({ name: esc(m?.name), days: Math.max(1, Number(m?.length) || 30), ...(m?.type === 'intercalary' ? { intercalary: true } : {}) })),
    weekdays: (Array.isArray(e.weekdays) ? e.weekdays : []).map((w: any) => esc(typeof w === 'object' && w ? w.name : w)),
    moons: (Array.isArray(e.moons) ? e.moons : []).filter((m: any) => m?.name).map((m: any) => ({ name: esc(m.name), cycleDays: Number(m.fullmoon) || 28, offsetDays: Number(m.offset) || 0 })),
    seasons: (Array.isArray(e.seasons) ? e.seasons : []).filter((x: any) => x?.name).map((x: any) => ({ name: esc(x.name), month: Math.max(1, Number(x.month) || 1), day: Math.max(1, Number(x.day) || 1) })),
  };
}

export const kankaApi: Connector = {
  id: 'kanka-api',
  label: 'Kanka (API token)',
  description: 'Reads a Kanka campaign with a personal API token, with its relations, timelines, calendars and map markers. Private entities, posts, attributes and relations stay DM-only.',
  aliases: ['kanka'],
  capabilities: ['pages', 'properties', 'tags', 'images', 'relations', 'timelines', 'maps', 'calendars', 'items', 'characters'],
  fields: [
    { key: 'campaignId', label: 'Campaign id', type: 'text', required: true, help: 'The number in your campaign’s address.' },
    { key: 'token', label: 'API token', type: 'password', secret: true, required: true, help: 'Kanka → Settings → API.' },
    { key: 'apiUrl', label: 'API URL', type: 'url', placeholder: 'https://api.kanka.io/1.0', help: 'Only change this for a self-hosted Kanka.' },
  ],
  validate(cfg) {
    if (!/^\d+$/.test(String(cfg.campaignId ?? ''))) throw new ConfigError('Campaign id must be a number');
    if (String(cfg.token ?? '').length < 20) throw new ConfigError('API token is required');
  },
  async test(cfg, ctx) {
    const base = String(cfg.apiUrl || 'https://api.kanka.io/1.0').replace(/\/$/, '');
    const r = await ctx.fetch(`${base}/campaigns/${cfg.campaignId}/characters?page=1`, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' }, signal: ctx.signal });
    if (!r.ok) return { ok: false, message: `Kanka answered ${r.status}. Check the token and campaign id.` };
    const j: any = await r.json();
    return { ok: true, message: `Connected. ${j.meta?.total ?? (j.data ?? []).length} characters.`, sample: (j.data ?? []).slice(0, 5).map((e: any) => e.name) };
  },
  sync: kankaApiSync,
};

// ---------- MCP (mcp-kanka) ----------

const MCP_TYPES = ['character', 'creature', 'family', 'location', 'organization', 'item', 'race', 'note', 'journal', 'quest', 'event', 'ability', 'tag'];

async function* kankaMcpSync(cfg: any, ctx: ConnectorContext): AsyncIterable<Entry> {
  const mcp = ctx.mcp();
  const listed: any[] = [];
  for (const type of MCP_TYPES) {
    for (let page = 1; page <= 200; page++) {
      // Without last_synced, an unfiltered listing times out on big campaigns.
      const res = await mcp.call('find_entities', { entity_type: type, include_full: false, last_synced: '2000-01-01T00:00:00Z', limit: 100, page });
      if (res.isError) { if (page === 1) break; throw new Error(`find_entities ${type}: ${res.text.slice(0, 160)}`); }
      const j = jsonOf(res);
      const list: any[] = Array.isArray(j) ? j : j?.entities ?? [];
      listed.push(...list.filter((e) => e?.entity_id));
      const last = Number(j?.sync_info?.last_page ?? 0);
      if (!list.length || (last ? page >= last : list.length < 100)) break;
    }
  }
  ctx.log(`Listed ${listed.length} entities`);
  const trust = cfg.trustPostVisibility === true;
  const ids = listed.map((e) => Number(e.entity_id));
  for (let i = 0; i < ids.length; i += 8) {
    if (ctx.signal.aborted) throw new Error('Sync stopped');
    const res = await mcp.call('get_entities', { entity_ids: ids.slice(i, i + 8), include_posts: cfg.includePosts !== false });
    const j = jsonOf(res);
    const got = new Map<number, any>((Array.isArray(j) ? j : j?.entities ?? []).filter((e: any) => e?.success !== false && e?.entity_id).map((e: any) => [Number(e.entity_id), e]));
    for (const id of ids.slice(i, i + 8)) {
      const e = got.get(id);
      const base = listed.find((x) => Number(x.entity_id) === id);
      yield {
        externalId: `kanka:${id}`,
        parentExternalId: e?.parent_id ? `kanka:${e.parent_id}` : null,
        folder: [String(base?.entity_type ?? 'entity').replace(/^./, (c) => c.toUpperCase()) + 's'],
        title: esc(base?.name ?? e?.name ?? `Entity ${id}`),
        tags: Array.isArray(e?.tags) ? e.tags.map((t: any) => esc(typeof t === 'object' ? t.name : t)) : [],
        type: base?.entity_type ?? e?.entity_type ?? 'entity',
        banner: typeof e?.image_full === 'string' && /^https?:/.test(e.image_full) ? e.image_full : null,
        properties: e?.type ? [{ title: 'Facts', rows: [{ key: 'Type', value: [{ text: esc(e.type) }] }] }] : [],
        // Older mcp-kanka builds reported admin-only posts as visible, so posts
        // are secret unless the admin trusts this server's post visibility.
        blocks: e ? [...kankaBlocks(e.entry), ...postBlocks(e.posts ?? [], (p) => trust && p.is_hidden === false)] : [],
        // Not loaded, or no explicit is_hidden=false: DM-only.
        visibility: e && e.is_hidden === false && ctx.shareVisible ? 'party' : 'dm',
        updatedAt: e?.updated_at ?? null,
      };
    }
  }
}

export const kankaMcp: Connector = {
  id: 'kanka-mcp',
  label: 'Kanka (mcp-kanka server)',
  description: 'Reads a Kanka campaign through the mcp-kanka MCP server, read tools only.',
  aliases: ['mcp:kanka'],
  capabilities: ['pages', 'tags', 'images', 'items', 'characters'],
  fields: [
    { key: 'transport', label: 'Connection', type: 'select', options: [['stdio', 'Local server (ALX_MCP_STDIO)'], ['http', 'HTTP URL']], default: 'stdio' },
    { key: 'server', label: 'Local server name', type: 'text', showIf: { transport: 'stdio' }, placeholder: 'kanka' },
    { key: 'url', label: 'MCP URL', type: 'url', showIf: { transport: 'http' } },
    { key: 'token', label: 'MCP token', type: 'password', secret: true, showIf: { transport: 'http' } },
    { key: 'trustPostVisibility', label: 'Trust post visibility', type: 'boolean', help: 'Only with mcp-kanka that includes the admin-post fix (a4bbb02). Off: every post is DM-only.' },
  ],
  validate(cfg) {
    if ((cfg.transport ?? (cfg.url ? 'http' : 'stdio')) === 'stdio') { if (!/^[\w-]{1,40}$/.test(String(cfg.server ?? ''))) throw new ConfigError('Pick the local server name from ALX_MCP_STDIO'); }
    else if (!/^https?:\/\/\S+$/.test(String(cfg.url ?? ''))) throw new ConfigError('MCP URL must start with http:// or https://');
  },
  async test(cfg, ctx) {
    const res = await ctx.mcp().call('find_entities', { entity_type: 'character', include_full: false, last_synced: '2000-01-01T00:00:00Z', limit: 5, page: 1 });
    const j = jsonOf(res);
    if (res.isError) return { ok: false, message: res.text.slice(0, 200) };
    return { ok: true, message: `Connected. ${j?.sync_info?.total_count ?? '?'} characters.`, sample: (j?.entities ?? []).map((e: any) => e.name) };
  },
  sync: kankaMcpSync,
  readTools: () => ['find_entities', 'get_entities'],
};
