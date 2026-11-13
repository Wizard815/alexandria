// Every connector Alexandria knows. Add a new world-building app by writing a
// connector and listing it here.
import { CAPABILITIES, type Capability, type Connector, type ConnectorContext, type ConfigField } from './connector.ts';
import { legendkeeperApi, legendkeeperMcp } from './connectors/legendkeeper.ts';
import { kankaApi, kankaMcp } from './connectors/kanka.ts';
import { gitRepo, markdownFolder, mcpFiles } from './connectors/markdown.ts';
import { genericApi } from './connectors/api.ts';
import { pushSource } from './connectors/push.ts';
import { mcpClient, type McpClient } from '../core/mcp.ts';

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

/**
 * Wrap an MCP client so only the connector's read tools can be called.
 * Write-sounding tool names are refused even if listed, and LegendKeeper's
 * api_request is GET only.
 */
export function readOnlyMcp(raw: McpClient, allowed: string[]): McpClient {
  const ok = new Set(allowed.filter((t) => t === 'api_request' || !WRITE_WORD.test(t)));
  return {
    call: (tool, args) => {
      if (!ok.has(tool)) throw new Error(`Refusing to call ${tool}: not a read tool for this source`);
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
