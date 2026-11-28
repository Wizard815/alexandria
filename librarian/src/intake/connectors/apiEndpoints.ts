// The generic API connector's endpoint list: what each endpoint of a world
// app is for (its role), and which fields of its records hold the id, title,
// body, summary, parent, tags, updated time and visibility.
//
// An endpoint the GM has not given a role (or has marked unused) is never
// called. The list is kept as JSON in the connection's `endpoints` setting,
// so a preset carries it to other worlds.
import { ConfigError } from '../connector.ts';

export const ROLES = ['pages', 'people', 'places', 'items', 'organisations', 'events', 'calendars', 'tags', 'images', 'map', 'unknown'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = {
  pages: 'Pages / articles', people: 'People / characters', places: 'Places / locations', items: 'Items', organisations: 'Organisations / factions',
  events: 'Events / timelines', calendars: 'Calendars', tags: 'Tags', images: 'Images / files', map: 'Map images', unknown: 'Not sure',
};
/** Roles that become library pages. Tags feed the names of tags; calendars become world calendars and images become the pictures of pages. */
export const PAGE_ROLES: readonly Role[] = ['pages', 'people', 'places', 'items', 'organisations', 'events'];
/** The page type a role gives records that have no type field of their own. */
export const ROLE_TYPE: Partial<Record<Role, string>> = { pages: 'page', people: 'character', places: 'location', items: 'item', organisations: 'organisation', events: 'event' };

export const PAGINGS = ['none', 'page', 'offset', 'link', 'cursor'] as const;
export type Paging = (typeof PAGINGS)[number];

export interface ApiEndpoint {
  /** Where it lives: a path under the base URL, or a full URL. `{world}` and the other placeholders are filled from the source. */
  path: string;
  role: Role;
  /** False (or role unknown): never called. */
  use: boolean;
  /** Short and stable: tells records of different endpoints apart. */
  key: string;
  itemsPath?: string;
  idField?: string;
  titleField?: string;
  bodyField?: string;
  bodyFormat?: 'markdown' | 'html' | 'text';
  summaryField?: string;
  parentField?: string;
  tagsField?: string;
  typeField?: string;
  updatedField?: string;
  urlField?: string;
  folderField?: string;
  visibilityField?: string;
  sharedValues?: string;
  paging?: Paging;
  pageParam?: string;
  /** The query parameter that sets the page size (limit, per_page ...), and the size to ask for. */
  pageSizeParam?: string;
  pageSize?: number;
  nextPath?: string;
  /** A query parameter that limits the list to what changed since a time (updated_since, lastSync ...). */
  sinceParam?: string;
  /** Where one record is, for tier 3 ({id} is the record's id): `/articles/{id}`. Without it the list is all there is. */
  detailPath?: string;
  /** Where the record is in the detail response (default: the response itself, or its `data`). */
  detailItemPath?: string;
  // Calendars (role `calendars`): where each part of a calendar record is. `idField`, `titleField` and `visibilityField` work as for pages.
  /** The array of months, and inside each month where its name and its length in days are (default `name` and `days`/`length`). A month with `intercalary: true` (or type "intercalary") is outside the week. */
  monthsField?: string;
  monthNameField?: string;
  monthDaysField?: string;
  /** The array of weekday names (strings, or objects with a `name`). */
  weekdaysField?: string;
  /** The calendar's current date: "year-month-day" text, or an object with year, month and day. */
  currentDateField?: string;
  /** A number: the year the calendar counts from (default 0). */
  epochYearField?: string;
  yearSuffixField?: string;
  /** An array of dated events (each with id, name or title, date, and optionally description): they become a timeline of the calendar. */
  eventsField?: string;
  // Images (role `images`, or `map` for map files): `urlField` holds the picture's address (relative to the base URL, or absolute); without it, `detailPath` is the download path ({id}).
  /** The field that says which page the picture belongs to (that page's id in its own list). A picture with no page is stored but shown on none. */
  pageField?: string;
  /** How sure the setup guess was, 0 to 1, and a note on how it was guessed. For the review table only. */
  confidence?: number;
  note?: string;
}

const STR_FIELDS = ['path', 'itemsPath', 'idField', 'titleField', 'bodyField', 'summaryField', 'parentField', 'tagsField', 'typeField', 'updatedField', 'urlField', 'folderField', 'visibilityField', 'sharedValues', 'pageParam', 'pageSizeParam', 'nextPath', 'sinceParam', 'detailPath', 'detailItemPath', 'monthsField', 'monthNameField', 'monthDaysField', 'weekdaysField', 'currentDateField', 'epochYearField', 'yearSuffixField', 'eventsField', 'pageField', 'note'] as const;

const slug = (s: string) => s.toLowerCase().replace(/\{\w+\}/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'list';

/** Clean a list of endpoints from the panel or a preset: known keys only, plain values, unique keys. Throws ConfigError. */
export function cleanEndpoints(input: unknown): ApiEndpoint[] {
  let raw: unknown = input;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw || '[]'); } catch { throw new ConfigError('The endpoint list is not valid JSON'); } }
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw)) throw new ConfigError('The endpoint list must be an array');
  if (raw.length > 60) throw new ConfigError('Too many endpoints (60 at most)');
  const keys = new Set<string>();
  return raw.map((r: any, i): ApiEndpoint => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new ConfigError(`Endpoint ${i + 1} is not an object`);
    const path = String(r.path ?? '').trim().slice(0, 500);
    if (!path) throw new ConfigError(`Endpoint ${i + 1} has no path`);
    const role: Role = (ROLES as readonly string[]).includes(r.role) ? r.role : 'unknown';
    let key = String(r.key ?? '').replace(/[^a-z0-9-]/gi, '').slice(0, 30) || slug(path);
    for (let n = 2; keys.has(key); n++) key = `${slug(path)}-${n}`;
    keys.add(key);
    const ep: ApiEndpoint = { path, role, key, use: r.use === true && role !== 'unknown' };
    for (const f of STR_FIELDS) if (f !== 'path' && f !== 'note' && typeof r[f] === 'string' && r[f].trim()) (ep as any)[f] = r[f].trim().slice(0, 300);
    if (typeof r.note === 'string' && r.note) ep.note = r.note.slice(0, 300);
    if (['markdown', 'html', 'text'].includes(r.bodyFormat)) ep.bodyFormat = r.bodyFormat;
    if ((PAGINGS as readonly string[]).includes(r.paging)) ep.paging = r.paging;
    const size = Number(r.pageSize);
    if (Number.isFinite(size) && size >= 1) ep.pageSize = Math.min(Math.floor(size), 1000);
    const conf = Number(r.confidence);
    if (Number.isFinite(conf)) ep.confidence = Math.max(0, Math.min(1, Math.round(conf * 100) / 100));
    return ep;
  });
}

/** The endpoints a connection has (cleaned; a bad stored list reads as none). */
export function endpointsOf(cfg: Record<string, any>): ApiEndpoint[] {
  try { return cleanEndpoints(cfg.endpoints); } catch { return []; }
}

/** The ones that will be called: marked used (the GM accepted them), with a role that gives pages, tag names, calendars or pictures. Anything else is never called. */
export const usedEndpoints = (eps: ApiEndpoint[]) => eps.filter((e) => e.use && (PAGE_ROLES.includes(e.role) || e.role === 'tags' || e.role === 'calendars' || e.role === 'images' || e.role === 'map'));
export const pageEndpoints = (eps: ApiEndpoint[]) => eps.filter((e) => e.use && PAGE_ROLES.includes(e.role));
export const calendarEndpoints = (eps: ApiEndpoint[]) => eps.filter((e) => e.use && e.role === 'calendars');
export const imageEndpoints = (eps: ApiEndpoint[]) => eps.filter((e) => e.use && e.role === 'images');
/** Endpoints whose records are map images (role `map`): downloaded like pictures, kept as maps, with a larger size cap. */
export const mapEndpoints = (eps: ApiEndpoint[]) => eps.filter((e) => e.use && e.role === 'map');

/** Make an absolute URL from the base URL and an endpoint path. A full URL stays as it is. */
export function endpointUrl(baseUrl: unknown, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  return base + (path.startsWith('/') ? path : `/${path}`);
}
