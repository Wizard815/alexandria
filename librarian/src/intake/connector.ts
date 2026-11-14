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
  /** Pages the source shows to players become party, unless the admin keeps them DM-only. */
  shareVisible: boolean;
  /** Record kinds whose listing could not be read this time. Their stored records are kept, not removed. */
  incomplete: Set<SyncRecord['kind']>;
}

/** What a connector can provide. Screens use only what the world's sources have. */
export const CAPABILITIES = ['pages', 'properties', 'tags', 'images', 'relations', 'timelines', 'maps', 'calendars', 'items', 'characters'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Anything a source gives besides a page. Source ids are the source's own ("kanka:123"). */
export type SyncRecord =
  /** A link between two pages (their externalIds). */
  | { kind: 'relation'; externalId: string; from: string; to: string; label: string; attitude?: number | null; visibility: 'dm' | 'party' }
  /** A timeline: groups (eras, lanes) of dated events, each event with its own visibility. */
  | { kind: 'timeline'; externalId: string; name: string; visibility: 'dm' | 'party'; groups: TimelineGroup[] }
  /** A calendar definition for the world clock (see CalendarDefinition). */
  | { kind: 'calendar'; externalId: string; name: string; visibility: 'dm' | 'party'; definition: CalendarDefinition; current?: { year: number; month: number; day: number } | null }
  /** A pin on a map page (mapRef is the map page's externalId). */
  | { kind: 'mapMarker'; externalId: string; mapRef: string; name: string; latitude: number; longitude: number; shape?: string; color?: string | null; ref?: string | null; visibility: 'dm' | 'party' };

export interface TimelineEvent { id: string; name: string; date?: string | null; description?: Block[]; color?: string | null; ref?: string | null; visibility: 'dm' | 'party' }
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
export type WriteLevel = 'party' | 'broker' | 'dm' | 'classified';

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
  /** Top-level things the DM may pick as the workspace root. */
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
  /** The MCP tools this connector may call with these settings (read tools only). */
  readTools?: (cfg: Record<string, any>) => string[];
  /** Write-back for the WorldLore workspace. Sources without it stay read-only. */
  write?: ConnectorWrite;
  /** MCP connection settings ({transport, url, token, server}) from this connector's settings. */
  mcpConfig?: (cfg: Record<string, any>) => Record<string, any>;
}

export class ConfigError extends Error {}
