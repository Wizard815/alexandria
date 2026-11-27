// A connector turns one kind of world source into Alexandria entries.
// To support a new world-building app, write one connector: describe its
// settings (the admin panel builds the form from them), test the connection,
// and yield entries. Everything after that (storage, the leak guard, search,
// the Library, AI tools) is shared.
import type { Block, Entry } from './model.ts';
import type { McpClient } from '../core/mcp.ts';

export interface ConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'number' | 'boolean' | 'select' | 'textarea';
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: [string, string][];
  /** Never sent back to clients. */
  secret?: boolean;
  default?: unknown;
  /** Only show when another field has this value, e.g. { transport: 'http' }. */
  showIf?: Record<string, unknown>;
  /**
   * Where the setting lives. `connection`: the account-level settings and
   * secrets (a token, an MCP URL), set once in Admin > Connections and shared
   * by every world that uses the connection. `source`: specific to one world
   * (a campaign id, a project, a folder). Set by the registry; no scope means source.
   */
  scope?: 'connection' | 'source';
}

export interface ConnectorContext {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  dataDir: string | null;
  vaultsDir: string | null;
  /** A read-only MCP client for this source's MCP settings. */
  mcp: () => McpClient;
  log: (msg: string) => void;
  signal: AbortSignal;
  /** The source's own id, for scratch folders. */
  sourceId: string;
  /** Pages the source shows to players become party, unless the admin keeps them GM-only. */
  shareVisible: boolean;
  /** Record kinds whose listing could not be read this time. Their stored records are kept, not removed. */
  incomplete: Set<SyncRecord['kind']>;
  /** Calls made to the source, by tier: transports add to the one for the current phase. */
  calls?: CallCounter;
  /** Tiered crawl state (see Tiered): what the last listing left, and what this one leaves. */
  tier?: TierState;
  /**
   * A listing of changed pages (the connector read only some entities' records): which relation owners and map pages it read in full.
   * The records of those, and only those, are replaced; every other stored record is kept.
   */
  refreshed?: { relationOwners: Set<string>; mapRefs: Set<string>; pictureOwners?: Set<string> };
  /** Pictures already stored for this source: externalId to the marker it was stored with (so an unchanged picture is not downloaded again). */
  heldImages?: Map<string, string>;
  /** Largest picture to download (bytes) and how many a run may download: the source's limits. `maxMapBytes`: the larger cap for map images. */
  imageLimits?: { maxBytes: number; perRun: number; maxHeld: number; maxMapBytes: number };
}

/** Calls made to a source in this run, by phase. A transport awaits `take()` before every request it sends: it waits for the source's rate limit, then counts the call. */
export class CallCounter {
  index = 0;
  detail = 0;
  phase: 'index' | 'detail' = 'index';
  /** Waits until another call is allowed (the source's rate limit). `paceMs`: the least time since the last paced call (scan pacing). */
  gate?: (phase: 'index' | 'detail', paceMs: number) => Promise<void>;
  /** The gap the index tier keeps between its calls while a scan is spread over a window (0: none). */
  paceMs = 0;
  /** Calls waited for by `take()` whose request has not gone out yet: the fetch does not wait for them again. */
  credit = 0;
  /** Called after each counted call (the crawl uses it to refresh its numbers). */
  onHit?: () => void;
  async take() {
    if (this.gate) { await this.gate(this.phase, this.phase === 'index' ? this.paceMs : 0); this.credit++; }
    this[this.phase]++;
    this.onHit?.();
  }
}

/** What a tiered connector keeps between listings. `cache` is the connector's own JSON (small). */
export interface TierState {
  /** The last listing's token (Kanka `sync`), or null. */
  token: string | null;
  cache: Record<string, any> | null;
  /** The caller asks for a complete listing (the first one, or the periodic one). */
  full: boolean;
  /** Set by the connector: false when only changed items were listed (nothing may be removed). */
  complete: boolean;
  /** Set by the connector: the token and cache to keep for next time. */
  next: { token: string | null; cache: Record<string, any> | null };
}

/**
 * A tiered connector lists first and fetches page details later. Tier 1
 * (`index`) uses list calls only and yields every page with what the list
 * gives (depth `index`, `summary` or, where the list has the whole body,
 * `full`). Tier 3 (`detail`) fetches whole pages for the ids it is given.
 * `sync` (the old, eager sync) stays the way to read everything in one go.
 */
export interface Tiered {
  /** Detail calls a minute that stay inside the source's published rate limit, with room for other users of the same key. */
  budgetPerMinute: number;
  /** Background detail calls a minute when the GM sets none (default: half of budgetPerMinute). */
  budgetDefault?: number;
  /** Tier 1. Only list calls. */
  index(cfg: Record<string, any>, ctx: ConnectorContext): AsyncIterable<SyncItem>;
  /** Tier 3. Whole pages for these external ids (ones the source no longer has are left out). */
  detail(cfg: Record<string, any>, ctx: ConnectorContext, ids: string[]): AsyncIterable<SyncItem>;
}

/** What a connector can provide. Screens use only what the world's sources have. */
export const CAPABILITIES = ['pages', 'properties', 'tags', 'images', 'relations', 'timelines', 'maps', 'calendars', 'items', 'characters'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Anything a source gives besides a page. Source ids are the source's own ("kanka:123"). */
export type SyncRecord =
  /** A link between two pages (their externalIds). */
  | { kind: 'relation'; externalId: string; from: string; to: string; label: string; attitude?: number | null; visibility: 'gm' | 'party' }
  /** A timeline: groups (eras, lanes) of dated events, each event with its own visibility. */
  | { kind: 'timeline'; externalId: string; name: string; visibility: 'gm' | 'party'; groups: TimelineGroup[] }
  /** A calendar definition for the world clock (see CalendarDefinition). */
  | { kind: 'calendar'; externalId: string; name: string; visibility: 'gm' | 'party'; definition: CalendarDefinition; current?: { year: number; month: number; day: number } | null }
  /** A pin on a map page (mapRef is the map page's externalId). */
  | { kind: 'mapMarker'; externalId: string; mapRef: string; name: string; latitude: number; longitude: number; shape?: string; color?: string | null; ref?: string | null; visibility: 'gm' | 'party' }
  /**
   * A picture of a page (`pageRef`: the source's own id of the page, or of the record the picture belongs to). `data` is the file when it was
   * downloaded now; without it the picture already stored under `externalId` is kept (and its link refreshed). `marker` says which version of the
   * picture was stored (its URL and update time). `visibility` `party` means the picture may follow its page; it never makes a GM-only page visible.
   * `later`: not downloaded now but queued (with `url`) for the picture downloader (intake/imagequeue.ts). `inline`: a picture in the page's
   * text (served in place of its address, not listed with the page's own pictures).
   */
  | { kind: 'image'; externalId: string; pageRef?: string | null; name: string; marker: string; mime?: string; data?: Uint8Array | null; visibility: 'gm' | 'party'; map?: boolean; url?: string; inline?: boolean; later?: boolean };

export interface TimelineEvent { id: string; name: string; date?: string | null; description?: Block[]; color?: string | null; ref?: string | null; visibility: 'gm' | 'party' }
export interface TimelineGroup { name: string; abbreviation?: string | null; description?: Block[]; events: TimelineEvent[] }

/** The shape the world clock reads. `month` in seasons is 1-based. */
export interface CalendarDefinition {
  name: string;
  epochYear: number;
  yearSuffix?: string;
  months: { name: string; days: number; intercalary?: boolean }[];
  weekdays: string[];
  moons?: { name: string; cycleDays: number; offsetDays: number }[];
  seasons?: { name: string; month: number; day: number }[];
}

/** A sync yields pages, and records for the other things a source has. Records have `kind`; entries don't. */
export type SyncItem = Entry | SyncRecord;
export const isRecord = (x: SyncItem): x is SyncRecord => typeof (x as any)?.kind === 'string';

export interface TestResult {
  ok: boolean;
  message: string;
  /** A few entry titles, or one normalized sample entry. */
  sample?: unknown;
}

/** Secrecy level of a page the workspace writes. `classified` is never sent to any AI. */
export type WriteLevel = 'party' | 'broker' | 'gm' | 'classified';

/** A workspace write was refused (outside the root, name taken, ...). `status` is the HTTP status to answer with. */
export class WriteRefused extends Error {
  status: number;
  constructor(message: string, status = 403) { super(message); this.status = status; }
}

/**
 * Write-back, used only by the WorldLore workspace (features/worldlore): the
 * one part of a source the AI may change. Every method gets the workspace
 * `root` and must refuse (WriteRefused 403) anything not inside it, checking
 * the source itself rather than a cache.
 */
export interface ConnectorWrite {
  /** `path` is a file path under the root (Markdown); `parent` is a page id under the root (LegendKeeper). Neither: the root itself. */
  createPage(cfg: Record<string, any>, ctx: ConnectorContext, a: { root: string; path?: string; parent?: string | null; title: string; markdown: string; level: WriteLevel }): Promise<{ externalId: string }>;
  updatePage(cfg: Record<string, any>, ctx: ConnectorContext, a: { root: string; id: string; title?: string; markdown?: string; level?: WriteLevel }): Promise<{ externalId: string }>;
  /** `to`: a new parent id (LegendKeeper; null or the root id for the top of the workspace) or a new path under the root (Markdown). */
  movePage(cfg: Record<string, any>, ctx: ConnectorContext, a: { root: string; id: string; to: string | null }): Promise<{ externalId: string }>;
  deletePage(cfg: Record<string, any>, ctx: ConnectorContext, a: { root: string; id: string }): Promise<void>;
  /** The page as an entry, to re-sync just that page. Null: not readable (sync the whole source instead). */
  readPage?(cfg: Record<string, any>, ctx: ConnectorContext, a: { root: string; id: string }): Promise<Entry | null>;
  /** Top-level things the GM may pick as the workspace root. */
  roots?(cfg: Record<string, any>, ctx: ConnectorContext): Promise<{ id: string; title: string; folder?: boolean; kind?: string }[]>;
  /** Pages at any depth whose name has `q`, as possible roots (for sources too big to list). */
  search?(cfg: Record<string, any>, ctx: ConnectorContext, q: string): Promise<{ id: string; title: string; folder?: boolean; kind?: string }[]>;
}

export interface Connector {
  id: string;
  label: string;
  description: string;
  /** Older kind names that map to this connector. */
  aliases?: string[];
  fields: ConfigField[];
  /** What this connector provides. */
  capabilities: Capability[];
  /** A push source: entries are sent to it (POST /api/intake/<id>/entries). It has nothing to sync. */
  push?: boolean;
  /** Throw an Error with a clear message when the settings are not usable. */
  validate(cfg: Record<string, any>, ctx: Pick<ConnectorContext, 'vaultsDir' | 'env'>): void;
  test(cfg: Record<string, any>, ctx: ConnectorContext): Promise<TestResult>;
  /** Every entry the source has, plus records (relations, timelines, calendars, markers). A full listing: anything not yielded is removed. */
  sync(cfg: Record<string, any>, ctx: ConnectorContext): AsyncIterable<SyncItem>;
  /** Tiered crawling (list first, details later). Sources without it are read whole by `sync`. */
  tiered?: (cfg: Record<string, any>) => Tiered | null;
  /** The MCP tools this connector may call with these settings (read tools only). */
  readTools?: (cfg: Record<string, any>) => string[];
  /** Write-back for the WorldLore workspace. Sources without it stay read-only. */
  write?: ConnectorWrite;
  /** MCP connection settings ({transport, url, token, server}) from this connector's settings. */
  mcpConfig?: (cfg: Record<string, any>) => Record<string, any>;
}

export class ConfigError extends Error {}
