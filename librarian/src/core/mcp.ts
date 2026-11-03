// A small MCP client so a world source can be an MCP server (the Kanka MCP,
// the LegendKeeper MCP, ...). Two transports:
//  - http:  Streamable HTTP (POST JSON-RPC; the reply is JSON or an SSE stream)
//  - stdio: a local server process, started only from commands the server
//           operator listed in ALX_MCP_STDIO (never from API input)
// Sources only ever call read tools; see READ_TOOLS in sources.ts.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { HttpError } from './util.ts';

export interface McpToolResult {
  text: string;
  structured: unknown;
  isError: boolean;
}

export interface McpClient {
  call(tool: string, args: Record<string, unknown>): Promise<McpToolResult>;
  listTools(): Promise<{ name: string }[]>;
  close(): void;
}

const PROTOCOL = '2025-03-26';
const CLIENT = { name: 'alexandria-librarian', version: '0.2.0' };

function toResult(r: any): McpToolResult {
  const parts = Array.isArray(r?.content) ? r.content : [];
  const text = parts.filter((p: any) => p?.type === 'text').map((p: any) => String(p.text)).join('\n');
  return { text, structured: r?.structuredContent ?? null, isError: !!r?.isError };
}

/** Parse a tool's text output as JSON when it is JSON. */
export function jsonOf(res: McpToolResult): any {
  if (res.structured && typeof res.structured === 'object') {
    const s: any = res.structured;
    // FastMCP wraps non-object returns as { result: ... }
    return Object.keys(s).length === 1 && 'result' in s ? s.result : s;
  }
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

export class HttpMcp implements McpClient {
  private url: string;
  private token: string | null;
  private fetchImpl: typeof fetch;
  private session: string | null = null;
  private nextId = 1;
  private ready: Promise<void> | null = null;
  private timeoutMs: number;

  constructor(url: string, token: string | null, fetchImpl: typeof fetch, timeoutMs = 60_000) {
    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  private async rpc(method: string, params: unknown, notify = false): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    if (method !== 'initialize') headers['MCP-Protocol-Version'] = PROTOCOL;
    const id = notify ? undefined : this.nextId++;
    const r = await this.fetchImpl(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id !== undefined ? { id } : {}) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (notify) return null;
    if (r.status === 401 || r.status === 403) throw new HttpError(502, `MCP server refused the token (${r.status})`);
    if (!r.ok) throw new HttpError(502, `MCP server answered ${r.status}`);
    const type = r.headers.get('content-type') ?? '';
    let msg: any;
    if (type.includes('text/event-stream')) {
      const body = await r.text();
      for (const block of body.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const m = JSON.parse(data);
        if (m.id === id) { msg = m; break; }
      }
    } else msg = await r.json();
    if (!msg) throw new HttpError(502, 'MCP server sent no reply');
    if (msg.error) throw new HttpError(502, `MCP error: ${String(msg.error.message ?? msg.error.code).slice(0, 200)}`);
    return msg.result;
  }

  private init() {
    this.ready ??= (async () => {
      await this.rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
      await this.rpc('notifications/initialized', {}, true);
    })();
    return this.ready;
  }

  async call(tool: string, args: Record<string, unknown>) {
    await this.init();
    return toResult(await this.rpc('tools/call', { name: tool, arguments: args }));
  }

  async listTools() {
    await this.init();
    return ((await this.rpc('tools/list', {}))?.tools ?? []) as { name: string }[];
  }

  close() {
    if (!this.session) return;
    const headers: Record<string, string> = { 'Mcp-Session-Id': this.session };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    this.fetchImpl(this.url, { method: 'DELETE', headers }).catch(() => {});
  }
}

export class StdioMcp implements McpClient {
  private proc: ChildProcessWithoutNullStreams;
  private buf = '';
  private nextId = 1;
  private waiting = new Map<number, { ok: (v: any) => void; fail: (e: any) => void }>();
  private ready: Promise<void>;

  constructor(command: string[], env: Record<string, string>) {
    const proc = spawn(command[0], command.slice(1), { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        const w = m.id !== undefined ? this.waiting.get(m.id) : undefined;
        if (!w) continue;
        this.waiting.delete(m.id);
        if (m.error) w.fail(new HttpError(502, `MCP error: ${String(m.error.message).slice(0, 200)}`));
        else w.ok(m.result);
      }
    });
    this.proc.stderr.resume();
    this.proc.on('exit', () => {
      for (const w of this.waiting.values()) w.fail(new HttpError(502, 'MCP server process stopped'));
      this.waiting.clear();
    });
    this.ready = (async () => {
      await this.rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    })();
  }

  private rpc(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((ok, fail) => {
      const t = setTimeout(() => {
        this.waiting.delete(id);
        fail(new HttpError(504, `MCP call ${method} timed out`));
      }, 120_000);
      this.waiting.set(id, { ok: (v) => { clearTimeout(t); ok(v); }, fail: (e) => { clearTimeout(t); fail(e); } });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async call(tool: string, args: Record<string, unknown>) {
    await this.ready;
    return toResult(await this.rpc('tools/call', { name: tool, arguments: args }));
  }

  async listTools() {
    await this.ready;
    return ((await this.rpc('tools/list', {}))?.tools ?? []) as { name: string }[];
  }

  close() {
    this.proc.kill();
  }
}

/**
 * Build a client from a source config.
 *   { transport: 'http', url, token }
 *   { transport: 'stdio', server: '<name in ALX_MCP_STDIO>' }
 * ALX_MCP_STDIO is JSON set by the operator: {"kanka": {"command": ["uvx", "mcp-kanka"], "env": {...}}}
 */
export function mcpClient(cfg: any, env: Record<string, string | undefined>, fetchImpl: typeof fetch): McpClient {
  if (cfg.transport === 'stdio') {
    let servers: any = {};
    try { servers = JSON.parse(env.ALX_MCP_STDIO || '{}'); } catch { /* ignore */ }
    const s = servers[cfg.server];
    if (!s || !Array.isArray(s.command) || !s.command.length) throw new HttpError(400, `No stdio MCP server named "${cfg.server}" in ALX_MCP_STDIO`);
    return new StdioMcp(s.command.map(String), s.env ?? {});
  }
  return new HttpMcp(String(cfg.url), cfg.token ? String(cfg.token) : null, fetchImpl);
}
