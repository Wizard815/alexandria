// A connector turns one kind of world source into Alexandria entries.
// To support a new world-building app, write one connector: describe its
// settings (the admin panel builds the form from them), test the connection,
// and yield entries. Everything after that (storage, the leak guard, search,
// the Library, AI tools) is shared.
import type { Entry } from './model.ts';
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
}

export interface TestResult {
  ok: boolean;
  message: string;
  /** A few entry titles, or one normalized sample entry. */
  sample?: unknown;
}

export interface Connector {
  id: string;
  label: string;
  description: string;
  /** Older kind names that map to this connector. */
  aliases?: string[];
  fields: ConfigField[];
  /** Throw an Error with a clear message when the settings are not usable. */
  validate(cfg: Record<string, any>, ctx: Pick<ConnectorContext, 'vaultsDir' | 'env'>): void;
  test(cfg: Record<string, any>, ctx: ConnectorContext): Promise<TestResult>;
  /** Every entry the source has. A full listing: entries not yielded are removed. */
  sync(cfg: Record<string, any>, ctx: ConnectorContext): AsyncIterable<Entry>;
  /** The MCP tools this connector may call with these settings (read tools only). */
  readTools?: (cfg: Record<string, any>) => string[];
  /** MCP connection settings ({transport, url, token, server}) from this connector's settings. */
  mcpConfig?: (cfg: Record<string, any>) => Record<string, any>;
}

export class ConfigError extends Error {}
