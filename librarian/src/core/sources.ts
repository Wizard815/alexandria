// World sources: where a world's library comes from. A source belongs to
// exactly one world.
//  - vault: a Markdown folder on the server (Obsidian, Lokus, Otterly),
//           limited to folders under ALX_VAULTS_DIR
//  - git:   a repo of reference files (e.g. your dnd-ref repo), cloned
//           read-only into the data folder; an optional subfolder
//  - kanka: a Kanka campaign, read through the Kanka API
//  - mcp:   an MCP server (profile 'kanka' = the mcp-kanka server,
//           'legendkeeper' = the LegendKeeper MCP), read tools only
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Library } from './library.ts';
import { HttpError } from './util.ts';
import { jsonOf, mcpClient, type McpClient } from './mcp.ts';

const run = promisify(execFile);

export interface SourceRow {
  id: string;
  world_id: string;
  kind: 'vault' | 'git' | 'kanka' | 'mcp';
  name: string;
  config: string;
  default_visibility: string;
}

export interface SyncDeps {
  library: Library;
  dataDir: string | null;
  vaultsDir: string | null;
  fetch: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Tests inject a client here instead of connecting. */
  mcp?: McpClient;
}

/** Config keys that must never be sent back to a client. */
export const SECRET_CONFIG_KEYS = ['token', 'apiKey', 'password'];

export function publicConfig(cfg: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) out[k] = SECRET_CONFIG_KEYS.includes(k) ? (v ? '••••' : '') : v;
  return out;
}

export function validateConfig(kind: string, cfg: Record<string, unknown>, vaultsDir: string | null) {
  if (kind === 'vault') {
    if (!vaultsDir) throw new HttpError(400, 'Vault sources are off: set ALX_VAULTS_DIR on the librarian');
    resolveVault(vaultsDir, String(cfg.folder ?? ''));
  } else if (kind === 'git') {
    const url = String(cfg.url ?? '');
    if (!/^https:\/\/[\w.-]+\/[\w./~-]+$/.test(url)) throw new HttpError(400, 'Git URL must be an https:// URL');
    if (cfg.subdir !== undefined && (typeof cfg.subdir !== 'string' || cfg.subdir.split('/').includes('..'))) throw new HttpError(400, 'Bad subfolder');
  } else if (kind === 'kanka') {
    if (!/^\d+$/.test(String(cfg.campaignId ?? ''))) throw new HttpError(400, 'Kanka campaignId must be a number');
    if (typeof cfg.token !== 'string' || cfg.token.length < 20) throw new HttpError(400, 'Kanka token is required');
  } else if (kind === 'mcp') {
    if (cfg.profile !== 'kanka' && cfg.profile !== 'legendkeeper') throw new HttpError(400, "MCP profile must be 'kanka' or 'legendkeeper'");
    if (cfg.transport === 'stdio') {
      if (typeof cfg.server !== 'string' || !/^[\w-]{1,40}$/.test(cfg.server)) throw new HttpError(400, 'stdio MCP needs the server name from ALX_MCP_STDIO');
    } else if (typeof cfg.url !== 'string' || !/^https?:\/\/[^\s]+$/.test(cfg.url)) throw new HttpError(400, 'MCP url must be http(s)');
  } else throw new HttpError(400, 'Unknown source kind');
}

function resolveVault(vaultsDir: string, folder: string): string {
  const root = path.resolve(vaultsDir);
  const full = path.resolve(root, folder);
  if (full !== root && !full.startsWith(root + path.sep)) throw new HttpError(400, 'Vault folder must be inside ALX_VAULTS_DIR');
  return full;
}

export async function syncSource(src: SourceRow, deps: SyncDeps, by: string): Promise<number> {
  const cfg = JSON.parse(src.config || '{}');
  if (src.kind === 'vault') {
    const dir = resolveVault(deps.vaultsDir ?? '', String(cfg.folder ?? ''));
    if (!fs.existsSync(dir)) throw new HttpError(400, 'Vault folder not found');
    return deps.library.importFolder(src.world_id, dir, src.id, src.default_visibility, by);
  }
  if (src.kind === 'git') {
    if (!deps.dataDir) throw new HttpError(400, 'Git sources need ALX_DATA_DIR');
    const dir = path.join(deps.dataDir, 'sources', src.id);
    // execFile with an argument list: the URL never reaches a shell.
    if (fs.existsSync(path.join(dir, '.git'))) await run('git', ['-C', dir, 'pull', '--ff-only', '--depth', '1'], { timeout: 120_000 });
    else await run('git', ['clone', '--depth', '1', '--', cfg.url, dir], { timeout: 120_000 });
    const sub = cfg.subdir ? path.resolve(dir, cfg.subdir) : dir;
    if (!sub.startsWith(dir)) throw new HttpError(400, 'Bad subfolder');
    return deps.library.importFolder(src.world_id, sub, src.id, src.default_visibility, by);
  }
  if (src.kind === 'kanka') return syncKanka(src, cfg, deps, by);
  if (src.kind === 'mcp') {
    const raw = deps.mcp ?? mcpClient(cfg, deps.env ?? {}, deps.fetch);
    const client = readOnly(raw);
    try {
      return cfg.profile === 'legendkeeper' ? await syncLegendKeeperMcp(src, cfg, client, deps, by) : await syncKankaMcp(src, cfg, client, deps, by);
    } finally {
      if (!deps.mcp) raw.close();
    }
  }
  throw new HttpError(400, 'Unknown source kind');
}

/** Tools a source may call. Anything else is refused before it is sent. */
export const READ_TOOLS = new Set(['find_entities', 'get_entities', 'search_entities', 'list_projects', 'browse_tree', 'get_resource', 'read_document', 'search', 'list_tags', 'api_request']);

function readOnly(c: McpClient): McpClient {
  return {
    call: (tool, args) => {
      if (!READ_TOOLS.has(tool)) throw new HttpError(500, `Refusing to call non-read MCP tool ${tool}`);
      // LegendKeeper's raw API tool can write; only GET is allowed.
      if (tool === 'api_request' && String(args.method ?? 'GET').toUpperCase() !== 'GET') throw new HttpError(500, 'Refusing a non-GET api_request');
      return c.call(tool, args);
    },
    listTools: () => c.listTools(),
    close: () => c.close(),
  };
}

const KANKA_MCP_TYPES = ['character', 'creature', 'family', 'location', 'organization', 'race', 'note', 'journal', 'quest', 'event', 'ability'];

/** Turn Kanka mentions into wiki links: [entity:12|Odda] / [entity:12] -> [[Odda]]. */
export function kankaMentions(md: string, names: Map<number, string>): string {
  return md.replace(/\[entity:(\d+)(?:\|([^\]]+))?\]/g, (m, id, label) => {
    const name = names.get(Number(id));
    if (label) return name && name !== label ? `[[${name}|${label}]]` : `[[${label}]]`;
    return name ? `[[${name}]]` : '(hidden)';
  });
}

/** Kanka text can still be HTML or HTML-escaped; normalise to Markdown. */
function kankaText(s: unknown): string {
  const t = String(s ?? '');
  return /<\/?(p|br|div|span|strong|em|ul|li|h\d|a)\b/i.test(t) ? htmlToMarkdown(t) : t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}

async function syncKankaMcp(src: SourceRow, cfg: any, mcp: McpClient, deps: SyncDeps, by: string) {
  // find_entities without a name filter times out unless last_synced is set;
  // an old last_synced lists everything, fast, with paging.
  const listed: any[] = [];
  for (const type of KANKA_MCP_TYPES) {
    for (let page = 1; page <= 200; page++) {
      const res = await mcp.call('find_entities', { entity_type: type, include_full: false, last_synced: '2000-01-01T00:00:00Z', limit: 100, page });
      if (res.isError) {
        if (page === 1) break; // module off in this campaign
        throw new HttpError(502, `find_entities ${type} failed: ${res.text.slice(0, 200)}`);
      }
      const j = jsonOf(res);
      const list: any[] = Array.isArray(j) ? j : j?.entities ?? [];
      listed.push(...list.filter((e) => e && e.entity_id));
      const last = Number(j?.sync_info?.last_page ?? 0);
      if (!list.length || (last ? page >= last : list.length < 100)) break;
    }
  }
  const names = new Map<number, string>(listed.map((e) => [Number(e.entity_id), kankaText(e.name)]));

  // Full entities and posts, a few at a time (each one can take seconds).
  const full = new Map<number, any>();
  const ids = [...names.keys()];
  for (let i = 0; i < ids.length; i += 8) {
    const res = await mcp.call('get_entities', { entity_ids: ids.slice(i, i + 8), include_posts: cfg.includePosts !== false });
    const j = jsonOf(res);
    for (const e of (Array.isArray(j) ? j : j?.entities ?? [])) if (e && e.success !== false && e.entity_id) full.set(Number(e.entity_id), e);
  }
  // Older mcp-kanka builds reported admin-only posts as visible, so posts are
  // DM-only unless the source says to trust them.
  const trustPosts = cfg.trustPostVisibility === true;

  let count = 0;
  try {
    for (const id of ids) {
      const e = full.get(id);
      // Could not load it: keep a DM-only stub rather than guessing.
      const name = names.get(id)!;
      const fm: Record<string, any> = { kanka_id: id, kanka_type: e?.entity_type ?? listed.find((x) => Number(x.entity_id) === id)?.entity_type };
      if (e?.type) fm.type = kankaText(e.type);
      if (Array.isArray(e?.tags) && e.tags.length) fm.tags = e.tags.map((t: any) => kankaText(typeof t === 'object' ? t.name : t));
      if (e?.parent_id && names.has(Number(e.parent_id))) fm.parent = `[[${names.get(Number(e.parent_id))}]]`;
      if (e?.entity_type === 'quest' && e.is_completed !== undefined) fm.completed = !!e.is_completed;
      let body = e ? kankaMentions(kankaText(e.entry), names).trim() : '';
      for (const p of e?.posts ?? []) {
        const text = `## ${kankaText(p.name) || 'Post'}\n\n${kankaMentions(kankaText(p.entry), names).trim()}`;
        body += p.is_hidden === false && trustPosts ? `\n\n${text}` : `\n\n<!-- dm -->\n${text}\n<!-- /dm -->`;
      }
      // Hidden in Kanka is always DM-only; a missing flag counts as hidden.
      const visibility = e && e.is_hidden === false ? src.default_visibility : 'dm';
      deps.library.save(src.world_id, { path: `kanka/${fm.kanka_type ?? 'entity'}/${slug(name)}-${id}.md`, title: name, body: body + '\n', frontmatter: fm, visibility, sourceId: src.id }, by, { batch: true });
      count++;
    }
  } finally {
    deps.library.rebuildPlayerCopies(src.world_id);
  }
  return count;
}

/** read_document puts a header (title, path, then ---) above the Markdown. */
export function stripLkHeader(text: string): string {
  const m = /^Resource "[\s\S]*?\n---\r?\n/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** [Name](lk://resources/<id>) -> [[Name]]; unresolved \[\[Name\]\] -> [[Name]]. */
export function lkLinks(md: string, names: Map<string, string>): string {
  return md
    .replace(/\[([^\]]*)\]\(lk:\/\/resources\/([\w-]+)\)/g, (_m, label: string, id: string) => {
      const name = names.get(id);
      if (!name) return label ? `[[${label}]]` : '(hidden)';
      return label && label !== name ? `[[${name}|${label}]]` : `[[${name}]]`;
    })
    .replace(/\\\[\\\[([^\]]+?)\\\]\\\]/g, '[[$1]]');
}

async function syncLegendKeeperMcp(src: SourceRow, cfg: any, mcp: McpClient, deps: SyncDeps, by: string): Promise<number> {
  const project = cfg.project ? { project: String(cfg.project) } : {};
  // 1. Every resource, by cursor.
  const resources: any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 500; i++) {
    const res = await mcp.call('api_request', { method: 'GET', path: '/resources', query: { limit: 100, ...(cursor ? { cursor } : {}) }, ...project });
    const j = jsonOf(res);
    if (res.isError || !j || !Array.isArray(j.data)) throw new HttpError(502, `LegendKeeper /resources failed: ${res.text.slice(0, 200)}`);
    resources.push(...j.data);
    if (!j.hasMore || !j.nextCursor) break;
    cursor = String(j.nextCursor);
  }
  const byId = new Map<string, any>(resources.map((r) => [String(r.id), r]));
  const names = new Map<string, string>(resources.map((r) => [String(r.id), String(r.name)]));

  // 2. Hidden is inherited: a resource is hidden if it or any ancestor is.
  const hiddenMemo = new Map<string, boolean>();
  const isHidden = (rid: string, depth = 0): boolean => {
    if (hiddenMemo.has(rid)) return hiddenMemo.get(rid)!;
    const r = byId.get(rid);
    // Unknown parent (not listed): fail closed.
    const h = !r || depth > 50 || r.isHidden !== false || (r.parentId ? isHidden(String(r.parentId), depth + 1) : false);
    hiddenMemo.set(rid, h);
    return h;
  };
  const treePath = (r: any): string[] => {
    const out: string[] = [];
    let cur = r.parentId ? byId.get(String(r.parentId)) : null;
    for (let i = 0; cur && i < 50; i++) {
      out.unshift(slug(cur.name));
      cur = cur.parentId ? byId.get(String(cur.parentId)) : null;
    }
    return out;
  };

  let count = 0;
  try {
    for (const r of resources) {
      if (r.isTemplate === true) continue;
      const docs: any[] = (r.documents ?? []).filter((d: any) => d.type === 'page');
      for (const d of docs) {
        // Document-level hidden only comes from the doc endpoint.
        const meta = jsonOf(await mcp.call('api_request', { method: 'GET', path: `/resources/${r.id}/docs/${d.id}`, ...project }));
        const docHidden = !meta || meta.isHidden !== false;
        const res = await mcp.call('read_document', { resource: String(r.id), document: String(d.id), format: 'markdown', ...project });
        if (res.isError) continue;
        // Markdown keeps > [!secret] blocks marked, which the leak guard removes.
        // Never import format=text: it prints secret text with no marker.
        const body = lkLinks(stripLkHeader(res.text), names);
        const title = docs.length > 1 && d.name && d.name !== 'Main' ? `${r.name} · ${d.name}` : String(r.name);
        const fm: Record<string, any> = { lk_id: r.id, lk_doc: d.id };
        if (Array.isArray(r.tags) && r.tags.length) fm.tags = r.tags.map(String);
        if (Array.isArray(r.aliases) && r.aliases.length) fm.aliases = r.aliases.map(String);
        if (r.parentId && names.has(String(r.parentId))) fm.parent = `[[${names.get(String(r.parentId))}]]`;
        const visibility = isHidden(String(r.id)) || docHidden ? 'dm' : src.default_visibility;
        const file = [...treePath(r), `${slug(title)}-${String(r.id).slice(0, 8)}.md`].join('/');
        deps.library.save(src.world_id, { path: `lk/${file}`, title, body, frontmatter: fm, visibility, sourceId: src.id }, by, { batch: true });
        count++;
      }
    }
  } finally {
    deps.library.rebuildPlayerCopies(src.world_id);
  }
  return count;
}

const KANKA_TYPES = ['characters', 'locations', 'organisations', 'families', 'items', 'notes', 'journals', 'quests', 'races', 'creatures'];

async function syncKanka(src: SourceRow, cfg: any, deps: SyncDeps, by: string) {
  try {
    return await syncKankaApi(src, cfg, deps, by);
  } finally {
    deps.library.rebuildPlayerCopies(src.world_id);
  }
}

async function syncKankaApi(src: SourceRow, cfg: any, deps: SyncDeps, by: string) {
  const base = (cfg.apiUrl || 'https://api.kanka.io/1.0').replace(/\/$/, '');
  let count = 0;
  for (const type of KANKA_TYPES) {
    let url: string | null = `${base}/campaigns/${cfg.campaignId}/${type}?page=1`;
    let pages = 0;
    while (url && pages++ < 200) {
      const r = await deps.fetch(url, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' } });
      if (r.status === 404) break;
      if (!r.ok) throw new HttpError(502, `Kanka answered ${r.status} for ${type}`);
      const j: any = await r.json();
      for (const e of j.data ?? []) {
        const fm: Record<string, any> = { kanka_id: e.entity_id ?? e.id, kanka_type: type };
        if (e.type) fm.type = e.type;
        if (e.title) fm.title_text = e.title;
        // Kanka's own private flag always wins: private means DM only.
        const visibility = e.is_private ? 'dm' : src.default_visibility;
        deps.library.save(src.world_id, { path: `kanka/${type}/${slug(e.name)}-${e.id}.md`, title: e.name, body: htmlToMarkdown(e.entry ?? ''), frontmatter: fm, visibility, sourceId: src.id }, by, { batch: true });
        count++;
      }
      url = j.links?.next ?? null;
    }
  }
  return count;
}

function slug(s: string) {
  return String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page';
}

export function htmlToMarkdown(html: string): string {
  return html
    .replace(/\r/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n${'#'.repeat(Number(n))} ${t}\n`)
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
