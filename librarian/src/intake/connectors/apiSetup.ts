// Automatic setup for the generic API connector. Given a base URL (and the
// auth), find out what the app offers and guess how to read it:
//
//   1. look for an OpenAPI or Swagger spec at the usual paths
//   2. with one: take its GET endpoints, guess each one's role (pages, people,
//      places, items, organisations, events, calendars, tags, images, or not
//      sure) and the field mapping from the response schemas; one sample call
//      only for a list whose schema says too little
//   3. without one: one sample call to the base URL and to each list URL the
//      GM gave, guessed from the shape of the JSON
//
// The result is a list of endpoints with confidence, for the GM to review.
// Nothing is saved or imported here, and nothing marked unsure is used: an
// endpoint stays unused until the GM assigns it a role.
import { type ApiEndpoint, type Role, type Paging, ROLES, PAGE_ROLES, cleanEndpoints } from './apiEndpoints.ts';
import { pick } from './api.ts';

export const SPEC_PATHS = ['/openapi.json', '/swagger.json', '/v1/openapi.json', '/api-docs', '/.well-known/openapi'];
const MAX_SAMPLES = 8;
const MAX_ENDPOINTS = 40;

export interface DiscoverInput {
  baseUrl: string;
  token?: string;
  authHeader?: string;
  /** One or two list URLs (or paths) to try when the app has no spec. */
  listUrls?: string[];
}
export interface DiscoverResult {
  /** Where the endpoints came from. */
  source: 'openapi' | 'sample';
  specUrl: string | null;
  title: string | null;
  /** Requests made to the app by this discovery (spec lookups and samples). */
  calls: number;
  endpoints: ApiEndpoint[];
  notes: string[];
}

// ---- roles ---------------------------------------------------------------------------------------

const ROLE_WORDS: [Role, RegExp][] = [
  ['people', /^(characters?|npcs?|pcs?|people|persons?|actors?|players?|heroes|villains|creatures?|monsters?|races?)$/],
  ['places', /^(locations?|places?|regions?|cities|city|towns?|settlements?|realms?|worlds?|maps?|lands?|countries|kingdoms?|dungeons?)$/],
  ['items', /^(items?|equipment|artifacts?|artefacts?|objects?|loot|weapons?|armou?rs?|gear|treasures?|spells?)$/],
  ['organisations', /^(organi[sz]ations?|factions?|groups?|guilds?|families|family|houses?|orders?|clans?|cults?|companies|teams?|nations?)$/],
  ['events', /^(events?|timelines?|histor(y|ies)|sessions?|chronicles?|eras?|journals?|quests?|campaigns?)$/],
  ['calendars', /^(calendars?|moons?|weather)$/],
  ['tags', /^(tags?|labels?|categories|category)$/],
  ['map', /^(battle-?maps?|world-?maps?|map-?(images?|files?|art|assets?)|maps?-?(images?|files?))$/],
  ['images', /^(images?|files?|assets?|media|uploads?|attachments?|pictures?|photos?|handouts?|documents?)$/],
  ['pages', /^(articles?|pages?|posts?|notes?|entries|entry|lore|docs?|wiki|wikis|topics?|entities|resources?|records?|stories|story|chapters?|content)$/],
];
const FUZZY: [Role, RegExp][] = [
  ['people', /(character|npc|person|people)/], ['places', /(location|place|region|city|town)/], ['items', /(item|artifact|weapon|equipment)/],
  ['organisations', /(organi[sz]ation|faction|guild|famil)/], ['events', /(event|timeline|histor|quest)/], ['calendars', /(calendar)/], ['tags', /(tag|categor)/],
  ['images', /(image|file|asset|media|upload)/], ['pages', /(article|page|note|entr|lore|doc|wiki|post)/],
];

/** Guess an endpoint's role from the words of its path (best), then its tags and summary. */
export function guessRole(path: string, hints: string[] = []): { role: Role; confidence: number } {
  const segs = path.split(/[/?#]/).filter((s) => s && !/^\{.*\}$/.test(s) && !/^v\d+$/i.test(s) && s !== 'api').map((s) => s.toLowerCase());
  const last = segs[segs.length - 1] ?? '';
  for (const [role, re] of ROLE_WORDS) if (re.test(last)) return { role, confidence: 0.9 };
  for (const [role, re] of FUZZY) if (re.test(last)) return { role, confidence: 0.7 };
  for (const h of hints.map((x) => x.toLowerCase())) {
    for (const [role, re] of ROLE_WORDS) if (re.test(h)) return { role, confidence: 0.5 };
    for (const [role, re] of FUZZY) if (re.test(h)) return { role, confidence: 0.4 };
  }
  return { role: 'unknown', confidence: 0 };
}

// ---- field mapping ----------------------------------------------------------------------------------

interface Prop { name: string; kind: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null'; samples: unknown[] }
const kindOf = (v: unknown): Prop['kind'] => (v === null || v === undefined ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : 'string');

const SYN = {
  id: ['id', 'uuid', '_id', 'slug', 'key', 'entity_id', 'identifier', 'guid'],
  title: ['name', 'title', 'label', 'display_name', 'displayname', 'heading', 'headline'],
  body: ['entry', 'body', 'content', 'markdown', 'text', 'html', 'article', 'details', 'description', 'notes', 'bio', 'lore'],
  summary: ['summary', 'excerpt', 'snippet', 'blurb', 'short_description', 'shortdescription', 'abstract', 'tagline', 'teaser', 'intro'],
  parent: ['parent_id', 'parentid', 'parent', 'location_id', 'parent_location_id', 'folder_id', 'parentresourceid'],
  tags: ['tags', 'labels', 'categories', 'keywords'],
  updated: ['updated_at', 'updatedat', 'updated', 'modified', 'modified_at', 'last_modified', 'lastmodified', 'changed_at', 'updated_on'],
  type: ['type', 'kind', 'category', 'entity_type', 'entity_type_code', 'type_name'],
  url: ['url', 'link', 'permalink', 'web_url', 'html_url', 'app_url'],
  folder: ['folder', 'path', 'folder_path'],
};
// Visibility fields and what they say when a record is for everyone.
const VIS: [string, string][] = [['is_private', 'false'], ['private', 'false'], ['is_hidden', 'false'], ['ishidden', 'false'], ['hidden', 'false'], ['secret', 'false'], ['is_secret', 'false'], ['gm_only', 'false'], ['dm_only', 'false'], ['is_public', 'true'], ['public', 'true'], ['visible', 'true'], ['is_visible', 'true'], ['visibility', ''], ['visibility_id', '1']];
const SHARED_WORDS = ['public', 'all', 'everyone', 'players', 'party', 'shared', 'visible', 'member', 'members'];

const norm = (s: string) => s.toLowerCase();
const find = (props: Prop[], names: string[]) => { for (const n of names) { const p = props.find((x) => norm(x.name) === n); if (p) return p; } return undefined; };

interface Mapping { fields: Partial<ApiEndpoint>; score: number; notes: string[] }

/** Guess which field is which from the property names (and sample values when there are some). */
export function mapFields(props: Prop[]): Mapping {
  const f: Partial<ApiEndpoint> = {};
  const notes: string[] = [];
  const id = find(props, SYN.id);
  if (id) f.idField = id.name;
  const title = find(props, SYN.title);
  if (title) f.titleField = title.name;
  // The body: a named field, preferring the one whose samples are long; HTML or Markdown from what it holds.
  const bodies = SYN.body.map((n) => props.find((x) => norm(x.name) === n)).filter((p): p is Prop => !!p && p.kind !== 'array' && p.kind !== 'object' && p.name !== f.titleField);
  const body = bodies.sort((a, b) => longest(b) - longest(a))[0];
  if (body) {
    f.bodyField = body.name;
    const txt = body.samples.filter((s): s is string => typeof s === 'string').join('\n');
    f.bodyFormat = /<\/?(p|br|div|h\d|ul|li|strong|em|a)\b/i.test(txt) ? 'html' : 'markdown';
  }
  const summary = SYN.summary.map((n) => props.find((x) => norm(x.name) === n)).find((p) => p && p.name !== f.bodyField);
  if (summary) f.summaryField = summary.name;
  const parent = find(props, SYN.parent);
  if (parent && parent.name !== f.idField) f.parentField = parent.name;
  const tags = find(props, SYN.tags);
  if (tags) f.tagsField = tags.name;
  const updated = find(props, SYN.updated);
  if (updated) f.updatedField = updated.name;
  const type = SYN.type.map((n) => props.find((x) => norm(x.name) === n && x.kind === 'string')).find(Boolean);
  if (type) f.typeField = type.name;
  const url = SYN.url.map((n) => props.find((x) => norm(x.name) === n && x.kind === 'string' && x.samples.every((s) => typeof s !== 'string' || /^https?:\/\//.test(s)))).find(Boolean);
  if (url) f.urlField = url.name;
  // Visibility: a flag or a word. Shared means "the value for everyone"; anything unsure stays GM-only.
  for (const [name, shared] of VIS) {
    const p = props.find((x) => norm(x.name) === name);
    if (!p) continue;
    f.visibilityField = p.name;
    if (name === 'visibility') {
      const seen = [...new Set(p.samples.map((s) => String(s).toLowerCase()))].filter((s) => SHARED_WORDS.includes(s));
      f.sharedValues = seen.length ? seen.join(', ') : 'public, all, everyone, players';
    } else if (name === 'visibility_id') f.sharedValues = '1, 5';
    else f.sharedValues = shared;
    break;
  }
  if (!f.visibilityField) notes.push('No visibility field found: every record stays GM-only until you map one.');
  const score = (f.idField ? 0.3 : 0) + (f.titleField ? 0.3 : 0) + (f.bodyField || f.summaryField ? 0.25 : 0) + (f.updatedField || f.tagsField || f.parentField ? 0.15 : 0);
  return { fields: f, score, notes };
}
// Calendars and pictures have their own fields. Names are guessed from the response schema or a sample; the GM reviews them.
const CAL = {
  months: ['months', 'month_list', 'monthnames', 'month_names', 'months_list'],
  weekdays: ['weekdays', 'week_days', 'days_of_week', 'daysofweek', 'daynames', 'day_names'],
  current: ['current_date', 'currentdate', 'date', 'today', 'now'],
  epoch: ['epoch_year', 'epochyear', 'epoch', 'start_year', 'startyear'],
  suffix: ['year_suffix', 'yearsuffix', 'suffix', 'era_name', 'era'],
  events: ['events', 'reminders', 'holidays'],
};
const IMG = {
  url: ['url', 'src', 'file_url', 'fileurl', 'download_url', 'downloadurl', 'image_url', 'imageurl', 'image_full', 'href', 'link', 'uri', 'path', 'file', 'full'],
  page: ['entity_id', 'entityid', 'page_id', 'pageid', 'owner_id', 'ownerid', 'article_id', 'resource_id', 'resourceid', 'character_id', 'location_id', 'parent_id', 'entity', 'owner', 'page'],
};

/** The extra fields of a calendars or images endpoint, and how complete the guess is (0 to 1). Null for any other role. */
export function mapRoleFields(role: Role, props: Prop[], base: Mapping): Mapping | null {
  if (role !== 'calendars' && role !== 'images' && role !== 'map') return null;
  const f: Partial<ApiEndpoint> = { ...base.fields };
  const notes: string[] = [...base.notes.filter((n) => !/visibility/.test(n))];
  const named = (names: string[], kinds?: Prop['kind'][]) => names.map((n) => props.find((x) => norm(x.name) === n && (!kinds || kinds.includes(x.kind)))).find(Boolean);
  let score = (f.idField ? 0.3 : 0) + (f.titleField ? 0.2 : 0);
  if (role === 'calendars') {
    const months = named(CAL.months, ['array']); if (months) f.monthsField = months.name;
    const wd = named(CAL.weekdays, ['array']); if (wd) f.weekdaysField = wd.name;
    const cur = named(CAL.current, ['string', 'object']); if (cur) f.currentDateField = cur.name;
    const ep = named(CAL.epoch, ['number']); if (ep) f.epochYearField = ep.name;
    const su = named(CAL.suffix, ['string']); if (su) f.yearSuffixField = su.name;
    const ev = named(CAL.events, ['array']); if (ev) f.eventsField = ev.name;
    // The body of a calendar is not a page body.
    delete f.bodyField; delete f.bodyFormat; delete f.summaryField;
    if (months) score += 0.5; else notes.push('No months field found: map one before using this calendar.');
  } else {
    const url = named(IMG.url, ['string']); if (url) f.urlField = url.name;
    const pg = named(IMG.page, ['number', 'string', 'object']); if (pg && pg.name !== f.idField) f.pageField = pg.name;
    delete f.bodyField; delete f.bodyFormat; delete f.summaryField; delete f.parentField;
    // The `url` guess of mapFields only takes http addresses; a picture's address may be relative.
    if (url) score += 0.5; else notes.push('No address field found: map one (or a download path) before using these images.');
    if (!f.pageField && role === 'images') notes.push('No field says which page a picture belongs to: pictures would be stored but shown on no page.');
  }
  return { fields: f, score: Math.min(1, score), notes };
}

/** Can the endpoint be switched on as it stands? Pages and tags need an id and title; calendars months; pictures an address. */
export function endpointUsable(ep: ApiEndpoint): boolean {
  if (ep.role === 'calendars') return !!(ep.idField && ep.titleField && ep.monthsField);
  if (ep.role === 'images' || ep.role === 'map') return !!(ep.idField && (ep.urlField || ep.detailPath));
  return (PAGE_ROLES.includes(ep.role) || ep.role === 'tags') && !!(ep.idField && ep.titleField);
}

const longest = (p: Prop) => p.samples.reduce<number>((n, s) => Math.max(n, typeof s === 'string' ? s.length : 0), 0);

/** Properties of the records in a sample: each key, its kind, and up to a few values. */
function propsOfSample(items: any[]): Prop[] {
  const by = new Map<string, Prop>();
  for (const it of items.slice(0, 5)) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    for (const [k, v] of Object.entries(it)) {
      const p = by.get(k) ?? by.set(k, { name: k, kind: kindOf(v), samples: [] }).get(k)!;
      if (p.kind === 'null') p.kind = kindOf(v);
      if (p.samples.length < 5 && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) p.samples.push(v);
    }
  }
  return [...by.values()];
}

/** Where the list is in a response (the response itself, or the first array of objects, or one inside `data`), and the records. */
export function findList(j: any): { path: string; items: any[] } | null {
  if (Array.isArray(j)) return { path: '', items: j };
  if (!j || typeof j !== 'object') return null;
  const preferred = ['data', 'items', 'results', 'records', 'entries', 'resources', 'list', 'rows', 'objects', 'pages', 'articles'];
  const keys = [...preferred.filter((k) => k in j), ...Object.keys(j).filter((k) => !preferred.includes(k))];
  for (const k of keys) if (Array.isArray(j[k]) && (j[k].length === 0 || typeof j[k][0] === 'object')) return { path: k, items: j[k] };
  for (const k of keys) {
    const v = j[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const k2 of Object.keys(v)) if (Array.isArray(v[k2]) && (v[k2].length === 0 || typeof v[k2][0] === 'object')) return { path: `${k}.${k2}`, items: v[k2] };
  }
  return null;
}

/** How a response pages: a next link, a cursor, page numbers, or not at all. */
export function guessPaging(j: any, params: string[]): { paging: Paging; pageParam?: string; nextPath?: string; pageSizeParam?: string; sinceParam?: string } {
  const has = (...n: string[]) => params.find((p) => n.includes(p.toLowerCase()));
  const out: ReturnType<typeof guessPaging> = { paging: 'none' };
  const size = has('limit', 'per_page', 'perpage', 'page_size', 'pagesize', 'size', 'take', 'count', 'max_results');
  if (size) out.pageSizeParam = size;
  const since = has('updated_since', 'lastsync', 'since', 'modified_since', 'updated_after', 'modified_after', 'changed_since');
  if (since) out.sinceParam = since;
  const link = j && typeof j === 'object' ? (['links.next', 'next', 'next_page_url', 'nextpage', 'next_url', 'meta.next', 'pagination.next', '_links.next.href'].find((p) => p in flat(j))) : undefined;
  const cursor = j && typeof j === 'object' ? (['nextCursor', 'next_cursor', 'cursor', 'next_page_token', 'nextPageToken', 'meta.next_cursor', 'pagination.next_cursor', 'pagination.cursor'].find((p) => p in flat(j))) : undefined;
  const cursorParam = has('cursor', 'after', 'page_token', 'pagetoken', 'starting_after', 'next');
  if (cursor && cursorParam) return { ...out, paging: 'cursor', pageParam: cursorParam, nextPath: cursor };
  if (link) return { ...out, paging: 'link', nextPath: link };
  const page = has('page', 'page_number', 'pagenumber');
  if (page) return { ...out, paging: 'page', pageParam: page };
  const offset = has('offset', 'skip', 'start');
  if (offset) return { ...out, paging: 'offset', pageParam: offset };
  return out;
}
/** Dotted paths of a response's scalar-ish leaves, two levels deep, for finding `links.next` and the like. */
function flat(j: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(j ?? {})) {
    out[k] = v;
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = v2;
  }
  return out;
}

// ---- OpenAPI -----------------------------------------------------------------------------------------

type Spec = Record<string, any>;
const deref = (spec: Spec, node: any, depth = 0): any => {
  if (!node || typeof node !== 'object' || depth > 8) return node;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    const target = node.$ref.slice(2).split('/').reduce((o: any, k: string) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
    return deref(spec, target, depth + 1);
  }
  return node;
};
/** Properties of an object schema, following refs and allOf. */
function schemaProps(spec: Spec, schema: any, depth = 0): Prop[] {
  const s = deref(spec, schema, depth);
  if (!s || depth > 6) return [];
  const out: Prop[] = [];
  for (const part of [s, ...(Array.isArray(s.allOf) ? s.allOf.map((x: any) => deref(spec, x, depth + 1)) : [])]) {
    for (const [name, raw] of Object.entries<any>(part?.properties ?? {})) {
      const p = deref(spec, raw, depth + 1);
      const t = Array.isArray(p?.type) ? p.type.find((x: string) => x !== 'null') : p?.type;
      const kind: Prop['kind'] = t === 'string' || t === 'number' || t === 'boolean' || t === 'array' || t === 'object' ? t : t === 'integer' ? 'number' : p?.properties ? 'object' : 'string';
      out.push({ name, kind, samples: Array.isArray(p?.enum) ? p.enum.slice(0, 5) : p?.example !== undefined ? [p.example] : [] });
    }
  }
  return out;
}

/** The records' schema of a list response: the array itself, or the first array property (one level down too). */
function listSchema(spec: Spec, resp: any): { path: string; itemProps: Prop[]; top: Prop[] } | null {
  const sch = deref(spec, resp?.content?.['application/json']?.schema ?? resp?.schema);
  if (!sch) return null;
  const t = Array.isArray(sch.type) ? sch.type.find((x: string) => x !== 'null') : sch.type;
  if (t === 'array') return { path: '', itemProps: schemaProps(spec, sch.items), top: [] };
  const top = schemaProps(spec, sch);
  const order = [...['data', 'items', 'results', 'records', 'entries', 'resources', 'list'].filter((k) => top.some((p) => p.name === k)), ...top.map((p) => p.name)];
  for (const k of order) {
    const p = deref(spec, findProp(spec, sch, k));
    if (p?.type === 'array') return { path: k, itemProps: schemaProps(spec, p.items), top };
  }
  for (const k of order) {
    const p = deref(spec, findProp(spec, sch, k));
    if (p?.type === 'object' || p?.properties) for (const q of schemaProps(spec, p)) {
      const qp = deref(spec, findProp(spec, p, q.name));
      if (qp?.type === 'array') return { path: `${k}.${q.name}`, itemProps: schemaProps(spec, qp.items), top };
    }
  }
  return null;
}
function findProp(spec: Spec, schema: any, name: string): any {
  const s = deref(spec, schema);
  if (s?.properties?.[name]) return s.properties[name];
  for (const part of Array.isArray(s?.allOf) ? s.allOf : []) { const r = findProp(spec, part, name); if (r) return r; }
  return undefined;
}

const LEADING_PARAM = /^\{(\w+)\}$/;

/** What a spec says about the app: its GET endpoints as endpoints with role and mapping guesses. */
export function analyzeSpec(spec: Spec, baseUrl: string): { endpoints: ApiEndpoint[]; needsSample: Set<string>; title: string | null } {
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
  const serverPath = (() => { const s = spec.servers?.[0]?.url ?? (spec.basePath ? spec.basePath : ''); try { return new URL(s, baseUrl).pathname.replace(/\/+$/, ''); } catch { return ''; } })();
  const relative = (p: string) => {
    let full = serverPath && !p.startsWith(serverPath) ? serverPath + p : p;
    if (basePath && full.startsWith(basePath + '/')) full = full.slice(basePath.length);
    return full;
  };
  const gets: { path: string; op: any; params: any[] }[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
    const op = item?.get;
    if (!op || typeof op !== 'object') continue;
    gets.push({ path, op, params: [...(item.parameters ?? []), ...(op.parameters ?? [])].map((x) => deref(spec, x)) });
  }
  const listPaths = new Set<string>();
  const endpoints: ApiEndpoint[] = [];
  const needsSample = new Set<string>();
  const details: { path: string; op: any }[] = [];
  for (const g of gets) {
    const segs = g.path.split('/').filter(Boolean);
    const last = segs[segs.length - 1] ?? '';
    // One record (ends in {id}): a detail endpoint of the list above it.
    if (LEADING_PARAM.test(last)) { details.push({ path: g.path, op: g.op }); continue; }
    // A list may sit under one leading id (the world: {project}, {campaign}); more than that needs values we do not have.
    const pathParams = segs.filter((s) => LEADING_PARAM.test(s));
    if (pathParams.length > 1) continue;
    const required = g.params.filter((p) => p.required && p.in !== 'path');
    if (required.length) continue;
    const hints = [...(g.op.tags ?? []), String(g.op.summary ?? ''), String(g.op.operationId ?? '')].flatMap((x: string) => String(x).split(/[^A-Za-z]+/)).filter(Boolean);
    const { role, confidence } = guessRole(g.path, hints);
    const ok = g.op.responses?.['200'] ?? g.op.responses?.['default'];
    const ls = listSchema(spec, deref(spec, ok));
    if (!ls && role === 'unknown') continue;
    const world = pathParams[0] ? g.path.replace(pathParams[0], '{world}') : g.path;
    const key = world.split('/').filter((s) => s && !/^\{/.test(s)).pop() ?? 'list';
    const map0 = ls ? mapFields(ls.itemProps) : { fields: {}, score: 0, notes: [] as string[] };
    const map = (ls ? mapRoleFields(role, ls.itemProps, map0) : null) ?? map0;
    const pg = guessPaging(null, g.params.map((p) => String(p.name)));
    // Paging from the response schema: a next link or cursor property.
    const topFlat = Object.fromEntries((ls?.top ?? []).map((p) => [p.name, 1]));
    const nested = ls?.top.flatMap((p) => schemaProps(spec, findProp(spec, deref(spec, ok)?.content?.['application/json']?.schema, p.name)).map((q) => `${p.name}.${q.name}`)) ?? [];
    const flatKeys = { ...topFlat, ...Object.fromEntries(nested.map((k) => [k, 1])) };
    const resp = guessPaging(flatKeys, g.params.map((p) => String(p.name)));
    const paging = resp.paging !== 'none' ? resp : pg;
    const ep: ApiEndpoint = {
      path: relative(world), role, key: key.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'list', use: false,
      ...(ls ? { itemsPath: ls.path || undefined } : {}), ...map.fields, ...paging, confidence: Math.round((confidence * 0.35 + map.score * 0.65) * 100) / 100,
      note: [ls ? 'fields guessed from the response schema' : 'no response schema', ...map.notes].join('; '),
    };
    if (!ep.pageSize && ep.pageSizeParam) ep.pageSize = 100;
    if (map.score < 0.6) needsSample.add(ep.key);
    listPaths.add(g.path);
    endpoints.push(ep);
  }
  // Pair each detail endpoint with the list that has the same path before the {id}.
  for (const dt of details) {
    const parent = dt.path.replace(/\/\{[^}]+\}$/, '');
    const ep = endpoints.find((e) => e.path === relative(parent.replace(/\{\w+\}/, '{world}')) || e.path === relative(parent));
    if (ep && !ep.detailPath) {
      ep.detailPath = relative(dt.path.replace(/\{[^}]+\}$/, '{id}').replace(/\{(?!id\})\w+\}/, '{world}'));
      // The detail response often has what the list leaves out (the body): map it from there, and note where the record sits in the response.
      const ok = dt.op.responses?.['200'] ?? dt.op.responses?.['default'];
      const sch = deref(spec, deref(spec, ok)?.content?.['application/json']?.schema ?? deref(spec, ok)?.schema);
      let props = schemaProps(spec, sch);
      const wrap = props.length === 1 || props.some((p) => p.name === 'data') ? props.find((p) => p.kind === 'object' && (props.length === 1 || p.name === 'data')) : undefined;
      if (wrap) { props = schemaProps(spec, findProp(spec, sch, wrap.name)); ep.detailItemPath = wrap.name; }
      const gm = mapFields(props);
      if (!ep.bodyField && gm.fields.bodyField) { ep.bodyField = gm.fields.bodyField; ep.bodyFormat = gm.fields.bodyFormat; }
      if (!ep.summaryField && gm.fields.summaryField) ep.summaryField = gm.fields.summaryField;
      if (gm.fields.bodyField) ep.note = `${ep.note ?? ''}; the body comes from the detail endpoint`.replace(/^; /, '');
    }
  }
  // Role-less lists with no usable mapping are left out of the table's "use" column, never switched on.
  for (const ep of endpoints) ep.use = endpointUsable(ep) && (ep.confidence ?? 0) >= 0.5;
  return { endpoints: endpoints.slice(0, MAX_ENDPOINTS), needsSample, title: typeof spec.info?.title === 'string' ? spec.info.title : null };
}

// ---- discovery -------------------------------------------------------------------------------------------

export async function discoverApi(fetchFn: typeof fetch, input: DiscoverInput, signal?: AbortSignal): Promise<DiscoverResult> {
  const baseUrl = String(input.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) throw new Error('Give the base URL of the app\'s API (https://...)');
  const origin = new URL(baseUrl).origin;
  const notes: string[] = [];
  let calls = 0;
  const hdr = (url: string): Record<string, string> => {
    const h: Record<string, string> = { Accept: 'application/json' };
    // The token goes only to the host of the base URL.
    if (input.token && new URL(url).origin === origin) h[input.authHeader || 'Authorization'] = (input.authHeader && input.authHeader !== 'Authorization' ? '' : 'Bearer ') + input.token;
    return h;
  };
  const get = async (url: string): Promise<{ status: number; json: any }> => {
    calls++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    signal?.addEventListener('abort', () => ctl.abort(), { once: true });
    try {
      const r = await fetchFn(url, { headers: hdr(url), signal: ctl.signal });
      let json: any = null;
      try { json = await r.json(); } catch { /* not JSON */ }
      return { status: r.status, json };
    } catch { return { status: 0, json: null }; } finally { clearTimeout(timer); }
  };

  // 1. The spec.
  let spec: Spec | null = null;
  let specUrl: string | null = null;
  const tried = new Set<string>();
  for (const p of SPEC_PATHS) {
    for (const url of [baseUrl + p, origin + p]) {
      if (tried.has(url) || tried.size >= 10) continue;
      tried.add(url);
      const r = await get(url);
      if (r.status === 200 && r.json && typeof r.json === 'object' && (r.json.openapi || r.json.swagger) && r.json.paths) { spec = r.json; specUrl = url; break; }
    }
    if (spec) break;
  }

  let endpoints: ApiEndpoint[] = [];
  let title: string | null = null;
  const needsSample = new Set<string>();
  if (spec) {
    const a = analyzeSpec(spec, baseUrl);
    endpoints = a.endpoints;
    title = a.title;
    a.needsSample.forEach((k) => needsSample.add(k));
    notes.push(`Found the spec at ${specUrl}: ${endpoints.length} list endpoints.`);
    if (!endpoints.length) notes.push('The spec lists no GET endpoints that return a list without extra parameters. Give a list URL to try one by hand.');
  } else {
    notes.push(`No OpenAPI or Swagger spec found (tried ${tried.size} places).`);
  }

  // 2. Samples: a list whose schema said too little (up to a few), or, with no spec, the base URL and the list URLs given.
  const sampleUrls: { path: string; url: string; why: 'spec' | 'given' | 'base' }[] = [];
  if (spec) {
    for (const ep of endpoints) if (needsSample.has(ep.key) && ep.role !== 'unknown' && !/\{\w+\}/.test(ep.path) && sampleUrls.length < MAX_SAMPLES) sampleUrls.push({ path: ep.path, url: baseUrl + ep.path, why: 'spec' });
  } else {
    sampleUrls.push({ path: '', url: baseUrl, why: 'base' });
    for (const u of (input.listUrls ?? []).slice(0, 2)) {
      const url = /^https?:\/\//i.test(u) ? u : baseUrl + (u.startsWith('/') ? u : `/${u}`);
      sampleUrls.push({ path: url.startsWith(baseUrl) ? url.slice(baseUrl.length) || '/' : url, url, why: 'given' });
    }
  }
  for (const s of sampleUrls) {
    const r = await get(s.url);
    if (r.status !== 200 || r.json === null) { notes.push(`${s.path || baseUrl} answered ${r.status || 'nothing'}${r.status === 401 || r.status === 403 ? ' (check the token)' : ''}.`); continue; }
    const list = findList(r.json);
    if (list && list.items.length && list.items.some((x) => x && typeof x === 'object')) {
      const props = propsOfSample(list.items);
      const existing = endpoints.find((e) => e.path === s.path);
      const m0 = mapFields(props);
      const m = mapRoleFields(existing && existing.role !== 'unknown' ? existing.role : guessRole(s.path || '/', []).role, props, m0) ?? m0;
      const paging = guessPaging(r.json, endpoints.find((e) => e.path === s.path)?.pageParam ? [] : []);
      const { role, confidence } = guessRole(s.path || '/', []);
      const merged: ApiEndpoint = {
        ...(existing ?? { path: s.path || '/', role, key: (s.path.split('/').filter(Boolean).pop() ?? 'list').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'list', use: false }),
        ...(existing && existing.role === 'unknown' ? { role } : {}),
        itemsPath: list.path || undefined, ...m.fields, ...(existing ? {} : paging),
        confidence: Math.round(((existing ? (existing.confidence ?? 0) : confidence * 0.35) * (existing ? 0.5 : 1) + m.score * 0.65) * 100) / 100,
        note: `${existing ? 'schema and ' : ''}one sample call (${list.items.length} records); ${m.notes.join('; ')}`.replace(/; $/, ''),
      };
      merged.use = endpointUsable(merged) && (merged.confidence ?? 0) >= 0.5;
      if (existing) Object.assign(existing, merged); else endpoints.push(merged);
    } else if (s.why === 'base' && r.json && typeof r.json === 'object') {
      // A root document that points at its endpoints: noted, never called until the GM assigns a role.
      for (const [k, v] of Object.entries(flat(r.json))) {
        const href = typeof v === 'string' ? v : typeof (v as any)?.href === 'string' ? (v as any).href : null;
        if (!href || !href.startsWith(baseUrl) || href === baseUrl || /\{/.test(href) || endpoints.length >= MAX_ENDPOINTS) continue;
        const path = href.slice(baseUrl.length);
        if (!endpoints.some((e) => e.path === path)) endpoints.push({ path, role: 'unknown', use: false, key: k.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 30) || 'list', confidence: 0, note: 'named on the base URL, not called' });
      }
    } else if (s.why !== 'base') notes.push(`${s.path} did not return a list of records.`);
  }
  // Give unknown, unused endpoints a role guess for the table where the name says something; they stay unused.
  for (const ep of endpoints) {
    if (ep.role === 'unknown') { const g = guessRole(ep.path, []); if (g.role !== 'unknown') { ep.role = g.role; ep.confidence = Math.min(ep.confidence ?? 0, 0.3); ep.use = false; } }
  }
  const finalEndpoints = cleanEndpoints(endpoints.map((e) => ({ ...e, use: e.use && (e.confidence ?? 0) >= 0.5 })));
  return { source: spec ? 'openapi' : 'sample', specUrl, title, calls, endpoints: finalEndpoints, notes };
}

export { pick, ROLES };


// ---- MCP tools: which tool lists, which one reads one item ------------------------------------------------

export interface McpToolInfo { name: string; description?: string; inputSchema?: any }
export interface McpGuess {
  /** The best tool to list records, or null. */
  listTool: { name: string; confidence: number } | null;
  /** Tools that read one record from its id (get_*, read_*, fetch_*), best first, with the argument that takes the id. */
  detailTools: { name: string; idArg: string; idType: 'string' | 'number'; confidence: number }[];
  notes: string[];
}

const NOT_READ = /(create|update|delete|write|set_|put|patch|post|append|remove|move|upload|insert|edit|rename|replace|restore|run_|manage|advance|retreat|add_|save|import|send)/i;
const ID_ARGS = ['id', 'uuid', '_id', 'slug', 'key', 'identifier', 'guid', 'entity_id', 'page_id', 'article_id', 'record_id', 'item_id', 'document_id', 'resource_id'];
/** The word a tool is about, singular ("list_articles" and "get_article" both: "article"). */
const stem = (name: string) => name.toLowerCase().replace(/^(list|search|find|query|browse|all|get|read|fetch|retrieve|show|load|open|lookup)[_-]?/, '').replace(/[_-]?(by[_-]?id|detail|details)$/, '').replace(/ies$/, 'y').replace(/s$/, '');

/** Guess the list tool and the per-item read tool of an MCP server from tool names and input schemas. Nothing is called. */
export function guessMcpTools(tools: McpToolInfo[], listTool?: string): McpGuess {
  const notes: string[] = [];
  const reads = tools.filter((t) => t?.name && !NOT_READ.test(t.name));
  const required = (t: McpToolInfo): string[] => (Array.isArray(t.inputSchema?.required) ? t.inputSchema.required.map(String) : []);
  const props = (t: McpToolInfo): Record<string, any> => (t.inputSchema?.properties && typeof t.inputSchema.properties === 'object' ? t.inputSchema.properties : {});
  const listCands = reads.filter((t) => /^(list|search|find|query|browse|all)[_-]|s$/i.test(t.name) && required(t).length === 0)
    .map((t) => ({ name: t.name, confidence: /^(list|all|browse)[_-]/i.test(t.name) ? 0.8 : 0.6 }));
  const chosenList = listTool ? { name: listTool, confidence: 1 } : listCands.sort((a, b) => b.confidence - a.confidence)[0] ?? null;
  const want = chosenList ? stem(chosenList.name) : '';
  const detail = reads.filter((t) => /^(get|read|fetch|retrieve|show|load|open|lookup)[_-]?/i.test(t.name) && t.name !== chosenList?.name).flatMap((t) => {
    const ps = props(t);
    const idArg = ID_ARGS.map((n) => Object.keys(ps).find((k) => k.toLowerCase() === n)).find(Boolean)
      ?? Object.keys(ps).find((k) => /_?id$/i.test(k) && required(t).includes(k));
    if (!idArg) return [];
    // Other required arguments (a world, a project) need values we do not have: allowed, but less sure.
    const others = required(t).filter((k) => k !== idArg).length;
    const type = ps[idArg]?.type === 'integer' || ps[idArg]?.type === 'number' ? 'number' as const : 'string' as const;
    const same = want && stem(t.name) === want;
    return [{ name: t.name, idArg, idType: type, confidence: Math.round(((same ? 0.9 : 0.5) - Math.min(others, 2) * 0.1) * 100) / 100 }];
  }).sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
  if (!chosenList) notes.push('No tool that lists records without required arguments was found: name the list tool.');
  if (!detail.length) notes.push('No tool that reads one record from its id was found: leave the read tool blank (the list is all there is) or name one.');
  return { listTool: chosenList, detailTools: detail.slice(0, 6), notes };
}
