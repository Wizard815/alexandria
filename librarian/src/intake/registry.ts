// Every connector Alexandria knows. Add a new world-building app by writing a
// connector and listing it here.
import { CAPABILITIES, type Capability, type Connector, type ConnectorContext, type ConfigField } from './connector.ts';
import { legendkeeperApi, legendkeeperMcp } from './connectors/legendkeeper.ts';
import { kankaApi, kankaMcp } from './connectors/kanka.ts';
import { gitRepo, markdownFolder, mcpFiles } from './connectors/markdown.ts';
import { genericApi } from './connectors/api.ts';
import { pushSource } from './connectors/push.ts';
import { lkMcpWrite, lkRestWrite } from './connectors/legendkeeper-write.ts';
import { markdownWrite } from './connectors/markdown-write.ts';
import { kankaMcpWrite, kankaRestWrite } from './connectors/kanka-write.ts';
import { mcpClient, type McpClient } from '../core/mcp.ts';

// Write-back (WorldLore workspace only). Sources without it stay read-only.
legendkeeperMcp.write = lkMcpWrite;
legendkeeperApi.write = lkRestWrite;
markdownFolder.write = markdownWrite;
kankaApi.write = kankaRestWrite;
kankaMcp.write = kankaMcpWrite;

export const CONNECTORS: Connector[] = [legendkeeperMcp, legendkeeperApi, kankaApi, kankaMcp, markdownFolder, gitRepo, mcpFiles, genericApi, pushSource];

/** The union of what these sources provide. */
export function capabilityUnion(sources: { kind: string; config?: string }[]): Capability[] {
  const out = new Set<Capability>();
  for (const s of sources) for (const c of connectorFor(s.kind, JSON.parse(s.config || '{}'))?.capabilities ?? []) out.add(c);
  return CAPABILITIES.filter((c) => out.has(c));
}

/** Find a connector by id, or by an older kind name ("vault", "kanka", "mcp" + profile). */
export function connectorFor(kind: string, cfg: Record<string, any> = {}): Connector | null {
  const key = kind === 'mcp' ? `mcp:${cfg.profile ?? 'legendkeeper'}` : kind;
  return CONNECTORS.find((c) => c.id === key || c.aliases?.includes(key)) ?? null;
}

export function publicFields(c: Connector): ConfigField[] {
  return c.fields;
}

/** Settings without secret values, for sending to the admin panel. */
export function publicConfig(c: Connector | null, cfg: Record<string, unknown>) {
  const secret = new Set((c?.fields ?? []).filter((f) => f.secret).map((f) => f.key).concat(['token', 'apiKey', 'password', 'mcpToken']));
  return Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, secret.has(k) ? (v ? '••••' : '') : v]));
}

/** Keep stored secret values when the admin panel sends back "••••". */
export function mergeSecrets(c: Connector, next: Record<string, unknown>, prev: Record<string, unknown>) {
  const out = { ...next };
  for (const f of c.fields) if (f.secret && (out[f.key] === '••••' || out[f.key] === undefined)) out[f.key] = prev[f.key];
  return out;
}

const WRITE_WORD = /(create|update|delete|write|set|put|patch|post|append|remove|move|upload|insert|edit|rename|replace|restore|run_|manage|advance|retreat)/i;

/** The only write tools the WorldLore workspace may call on the LegendKeeper MCP. Nothing else, ever. */
export const WORKSPACE_MCP_WRITE: readonly string[] = ['create_resource', 'write_page', 'update_resource', 'move_resource', 'delete_resource'];

/**
 * The only write tools the WorldLore workspace may call on the mcp-kanka
 * server: create, update and delete entities (the connector limits them to
 * notes and journals under the root). Posts, relations, attributes, tags,
 * permissions, calendars, migrations and the rest are never reachable.
 */
export const WORKSPACE_KANKA_MCP_WRITE: readonly string[] = ['create_entities', 'update_entities', 'delete_entities'];

const WORKSPACE_WRITES: Record<string, readonly string[]> = { 'legendkeeper-mcp': WORKSPACE_MCP_WRITE, 'kanka-mcp': WORKSPACE_KANKA_MCP_WRITE };

/** Argument checks for the Kanka write tools: notes and journals only, a handful of ids. */
function kankaWriteArgs(tool: string, args: Record<string, any>) {
  const list = (v: unknown, max = 5): any[] => { if (!Array.isArray(v) || v.length < 1 || v.length > max) throw new Error(`Refusing ${tool}: one to ${max} items only`); return v; };
  if (tool === 'create_entities') for (const e of list(args.entities)) { if (e?.entity_type !== 'note' && e?.entity_type !== 'journal') throw new Error('Refusing create_entities: notes and journals only'); }
  else if (tool === 'update_entities') for (const u of list(args.updates)) { if (!Number.isInteger(u?.entity_id) || u.entity_id < 1) throw new Error('Refusing update_entities: an integer entity_id is required'); }
  else if (tool === 'delete_entities') { for (const id of list(args.entity_ids)) if (!Number.isInteger(id) || id < 1) throw new Error('Refusing delete_entities: integer entity ids only'); }
}

/**
 * Wrap an MCP client so only the connector's read tools can be called.
 * Write-sounding tool names are refused even if listed, and LegendKeeper's
 * api_request is GET only.
 *
 * `opts.workspace` is the one exception, used only by workspaceMcpFactory
 * (the WorldLore code path): it also allows the connector's workspace write
 * tools (`true`: WORKSPACE_MCP_WRITE; or an explicit list such as
 * WORKSPACE_KANKA_MCP_WRITE), and delete_resource only with confirm=true.
 */
export function readOnlyMcp(raw: McpClient, allowed: string[], opts: { workspace?: boolean | readonly string[] } = {}): McpClient {
  const ok = new Set(allowed.filter((t) => t === 'api_request' || !WRITE_WORD.test(t)));
  const ws = new Set(opts.workspace === true ? WORKSPACE_MCP_WRITE : opts.workspace || []);
  return {
    call: (tool, args) => {
      if (!ok.has(tool) && !ws.has(tool)) throw new Error(`Refusing to call ${tool}: not a read tool for this source`);
      if (WORKSPACE_KANKA_MCP_WRITE.includes(tool)) kankaWriteArgs(tool, args);
      if (tool === 'delete_resource' && args.confirm !== true) throw new Error('Refusing delete_resource without confirm=true');
      if (tool === 'api_request' && String(args.method ?? 'GET').toUpperCase() !== 'GET') throw new Error('Refusing a non-GET api_request');
      return raw.call(tool, args);
    },
    listTools: () => raw.listTools(),
    close: () => raw.close(),
  };
}

export function makeMcpFactory(c: Connector, cfg: Record<string, any>, env: ConnectorContext['env'], fetchImpl: typeof fetch, injected?: McpClient) {
  let client: McpClient | null = null;
  const factory = () => {
    if (!client) {
      const mc = c.mcpConfig ? c.mcpConfig(cfg) : { ...cfg, transport: cfg.transport ?? (cfg.url ? 'http' : 'stdio') };
      const raw = injected ?? mcpClient(mc, env, fetchImpl);
      client = readOnlyMcp(raw, c.readTools ? c.readTools(cfg) : []);
    }
    return client;
  };
  return { factory, close: () => { if (client && !injected) client.close(); client = null; } };
}

/**
 * The MCP client the WorldLore workspace writes through: the connector's read
 * tools plus that connector's workspace write tools (WORKSPACE_WRITES: the
 * LegendKeeper MCP and mcp-kanka only).
 * Everything else (sync, test, every other caller) uses makeMcpFactory.
 */
export function workspaceMcpFactory(c: Connector, cfg: Record<string, any>, env: ConnectorContext['env'], fetchImpl: typeof fetch, injected?: McpClient) {
  let client: McpClient | null = null;
  const factory = () => {
    if (!client) {
      const mc = c.mcpConfig ? c.mcpConfig(cfg) : { ...cfg, transport: cfg.transport ?? (cfg.url ? 'http' : 'stdio') };
      const raw = injected ?? mcpClient(mc, env, fetchImpl);
      client = readOnlyMcp(raw, c.readTools ? c.readTools(cfg) : [], { workspace: WORKSPACE_WRITES[c.id] });
    }
    return client;
  };
  return { factory, close: () => { if (client && !injected) client.close(); client = null; } };
}
