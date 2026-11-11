// Markdown sources: a vault folder on the server (Obsidian, Lokus, Otterly),
// a git repo of reference files, or any MCP server that can list and read
// files (an Obsidian MCP, a filesystem MCP...). Frontmatter becomes tags,
// aliases and sidebar facts; [[wiki links]] become links; > [!secret]
// callouts, %% comments %%, <!-- dm --> blocks and DM headings stay DM-only.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Connector, ConnectorContext } from '../connector.ts';
import { ConfigError } from '../connector.ts';
import type { Entry, Inline, PropertyGroup } from '../model.ts';
import { type FM, type FMValue, splitFrontmatter } from '../../core/frontmatter.ts';
import { normVisibility } from '../../core/policy.ts';
import { jsonOf } from '../../core/mcp.ts';

const run = promisify(execFile);
const RESERVED = new Set(['title', 'visibility', 'tags', 'tag', 'aliases', 'alias', 'knowledge', 'type', 'icon', 'banner', 'cssclass', 'cssclasses', 'publish', 'permalink']);
const DM_KEY = /^(secret|secrets|dm|dm_.*|gm|gm_.*|private)$/i;

function valueInline(v: FMValue): Inline[] {
  const s = Array.isArray(v) ? v.map((x) => String(x ?? '')).join(', ') : v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
  const out: Inline[] = [];
  let last = 0;
  for (const m of s.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g)) {
    if (m.index! > last) out.push({ text: s.slice(last, m.index) });
    out.push({ mention: { name: m[1].trim(), ...(m[2] ? { text: m[2].trim() } : {}) } });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

/** Frontmatter keys as sidebar facts. Nested secret:/dm: maps become DM-only groups. */
export function frontmatterGroups(fm: FM): PropertyGroup[] {
  const facts: PropertyGroup = { title: 'Facts', rows: [] };
  const groups: PropertyGroup[] = [];
  for (const [k, v] of Object.entries(fm)) {
    if (RESERVED.has(k.toLowerCase()) || /^(kanka|lk)_/.test(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      groups.push({ title: k, ...(DM_KEY.test(k) ? { dm: true } : {}), rows: Object.entries(v).map(([kk, vv]) => ({ key: kk, value: valueInline(vv) })) });
    } else facts.rows.push({ key: k.replace(/_/g, ' '), value: valueInline(v) });
  }
  return [...(facts.rows.length ? [facts] : []), ...groups];
}

const list = (v: FMValue | undefined) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(/\s*,\s*/) : []).map((x) => x.replace(/^#/, '')).filter(Boolean);

export function markdownEntry(relPath: string, text: string, defaultVisibility: 'dm' | 'party'): Entry {
  const { fm, body } = splitFrontmatter(text);
  const parts = relPath.split('/');
  const file = parts.pop()!.replace(/\.md$/i, '');
  const title = typeof fm.title === 'string' && fm.title ? fm.title : (/^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? file);
  const k = String(fm.knowledge ?? '').toLowerCase();
  return {
    externalId: relPath,
    folder: parts,
    title,
    aliases: list(fm.aliases ?? fm.alias),
    tags: [...list(fm.tags ?? fm.tag), ...[...body.matchAll(/(?:^|\s)#([\p{L}][\w/-]*)/gu)].map((m) => m[1])].filter((x, i, a) => a.indexOf(x) === i).slice(0, 40),
    type: typeof fm.type === 'string' ? fm.type : 'page',
    icon: typeof fm.icon === 'string' ? { glyph: fm.icon } : null,
    banner: typeof fm.banner === 'string' && /^https?:/.test(fm.banner) ? fm.banner : null,
    properties: frontmatterGroups(fm),
    blocks: [], // the library parses `markdown` itself so the Markdown leak guard runs first
    markdown: body,
    frontmatter: fm,
    visibility: fm.visibility !== undefined && fm.visibility !== null ? (normVisibility(fm.visibility) === 'party' ? 'party' : 'dm') : defaultVisibility,
    knowledge: k === 'common' || k === 'local' || k === 'deep' ? k : null,
  } as Entry;
}

function* walk(root: string, dir = root): Generator<string> {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) yield* walk(root, full);
    else if (ent.isFile() && /\.md$/i.test(ent.name)) yield path.relative(root, full).split(path.sep).join('/');
  }
}

function vaultDir(vaultsDir: string | null, folder: string) {
  if (!vaultsDir) throw new ConfigError('Vault sources are off: set ALX_VAULTS_DIR on the librarian');
  const root = path.resolve(vaultsDir);
  const full = path.resolve(root, folder || '.');
  if (full !== root && !full.startsWith(root + path.sep)) throw new ConfigError('The folder must be inside ALX_VAULTS_DIR');
  return full;
}

const shareField = { key: 'defaultShared', label: 'Pages without a visibility are shared', type: 'boolean' as const, help: 'Off (safer): only pages with visibility: party in their frontmatter are shared.' };

export const markdownFolder: Connector = {
  id: 'markdown-folder',
  label: 'Markdown folder (Obsidian, Lokus, Otterly)',
  description: 'Reads a folder of Markdown notes on the server, read-only. Frontmatter, wiki links, callouts and tags are kept.',
  aliases: ['vault'],
  fields: [{ key: 'folder', label: 'Folder', type: 'text', required: true, help: 'Inside ALX_VAULTS_DIR on the server.' }, shareField],
  validate(cfg, ctx) {
    vaultDir(ctx.vaultsDir, String(cfg.folder ?? ''));
  },
  async test(cfg, ctx) {
    const dir = vaultDir(ctx.vaultsDir, cfg.folder);
    if (!fs.existsSync(dir)) return { ok: false, message: 'Folder not found' };
    const files = [...walk(dir)];
    return { ok: true, message: `Found ${files.length} Markdown files.`, sample: files.slice(0, 5) };
  },
  async *sync(cfg, ctx) {
    const dir = vaultDir(ctx.vaultsDir, cfg.folder);
    if (!fs.existsSync(dir)) throw new Error('Folder not found');
    for (const rel of walk(dir)) yield markdownEntry(rel, fs.readFileSync(path.join(dir, rel), 'utf8'), cfg.defaultShared && ctx.shareVisible ? 'party' : 'dm');
  },
};

export const gitRepo: Connector = {
  id: 'git',
  label: 'Git repository',
  description: 'Clones a repository of Markdown reference files (read-only) and imports it. Pulls again on every sync.',
  fields: [
    { key: 'url', label: 'Repository URL', type: 'url', required: true, placeholder: 'https://github.com/you/dnd-ref' },
    { key: 'subdir', label: 'Subfolder', type: 'text', help: 'Only import this folder.' },
    { key: 'branch', label: 'Branch', type: 'text', placeholder: 'main' },
    shareField,
  ],
  validate(cfg) {
    if (!/^https:\/\/[\w.-]+\/[\w./~-]+$/.test(String(cfg.url ?? ''))) throw new ConfigError('Repository URL must be an https:// URL');
    if (cfg.subdir && String(cfg.subdir).split('/').includes('..')) throw new ConfigError('Bad subfolder');
    if (cfg.branch && !/^[\w./-]{1,100}$/.test(String(cfg.branch))) throw new ConfigError('Bad branch name');
  },
  async test(cfg, ctx) {
    const { stdout } = await run('git', ['ls-remote', '--heads', '--', cfg.url], { timeout: 30_000, signal: ctx.signal });
    return { ok: true, message: `Reachable. ${stdout.trim().split('\n').filter(Boolean).length} branches.` };
  },
  async *sync(cfg, ctx) {
    if (!ctx.dataDir) throw new Error('Git sources need ALX_DATA_DIR');
    const dir = path.join(ctx.dataDir, 'sources', ctx.sourceId);
    // execFile with an argument list: the URL never reaches a shell.
    if (fs.existsSync(path.join(dir, '.git'))) await run('git', ['-C', dir, 'pull', '--ff-only', '--depth', '1'], { timeout: 180_000 });
    else await run('git', ['clone', '--depth', '1', ...(cfg.branch ? ['--branch', cfg.branch] : []), '--', cfg.url, dir], { timeout: 180_000 });
    const sub = cfg.subdir ? path.resolve(dir, cfg.subdir) : dir;
    if (!sub.startsWith(dir)) throw new Error('Bad subfolder');
    for (const rel of walk(sub)) yield markdownEntry(rel, fs.readFileSync(path.join(sub, rel), 'utf8'), cfg.defaultShared && ctx.shareVisible ? 'party' : 'dm');
  },
};

// Known MCP file servers. "list" returns file paths; "read" returns file text.
const PRESETS: Record<string, { list: string; listArgs: Record<string, unknown>; read: string; readArg: string }> = {
  obsidian: { list: 'obsidian_list_files_in_vault', listArgs: {}, read: 'obsidian_get_file_contents', readArg: 'filepath' },
  filesystem: { list: 'search_files', listArgs: { path: '.', pattern: '*.md' }, read: 'read_file', readArg: 'path' },
};

function pathsFrom(res: { text: string; structured: unknown }): string[] {
  const j = jsonOf(res as any);
  const arr = Array.isArray(j) ? j : Array.isArray(j?.files) ? j.files : Array.isArray(j?.results) ? j.results : null;
  const raw = arr ? arr.map((x: any) => (typeof x === 'string' ? x : x?.path ?? x?.name ?? '')) : res.text.split('\n').map((l) => l.replace(/^\[(FILE|DIR)\]\s*/i, '').trim());
  return raw.filter((p: string) => /\.md$/i.test(p) && !p.split('/').some((s: string) => s.startsWith('.') || s === '..'));
}

export const mcpFiles: Connector = {
  id: 'mcp-files',
  label: 'Notes app through MCP (Obsidian, filesystem…)',
  description: 'Reads Markdown files through any MCP server that can list and read files. Presets for the Obsidian MCP and the filesystem MCP, or name the tools yourself.',
  fields: [
    { key: 'transport', label: 'Connection', type: 'select', options: [['stdio', 'Local server (ALX_MCP_STDIO)'], ['http', 'HTTP URL']], default: 'stdio' },
    { key: 'server', label: 'Local server name', type: 'text', showIf: { transport: 'stdio' }, placeholder: 'obsidian' },
    { key: 'url', label: 'MCP URL', type: 'url', showIf: { transport: 'http' } },
    { key: 'token', label: 'MCP token', type: 'password', secret: true, showIf: { transport: 'http' } },
    { key: 'preset', label: 'Server type', type: 'select', options: [['obsidian', 'Obsidian MCP'], ['filesystem', 'Filesystem MCP'], ['custom', 'Other (name the tools)']], default: 'obsidian' },
    { key: 'listTool', label: 'List tool', type: 'text', showIf: { preset: 'custom' } },
    { key: 'listArgs', label: 'List tool arguments (JSON)', type: 'textarea', showIf: { preset: 'custom' }, placeholder: '{}' },
    { key: 'readTool', label: 'Read tool', type: 'text', showIf: { preset: 'custom' } },
    { key: 'readArg', label: 'Read tool path argument', type: 'text', showIf: { preset: 'custom' }, placeholder: 'path' },
    shareField,
  ],
  validate(cfg) {
    if ((cfg.transport ?? (cfg.url ? 'http' : 'stdio')) === 'stdio') { if (!/^[\w-]{1,40}$/.test(String(cfg.server ?? ''))) throw new ConfigError('Pick the local server name from ALX_MCP_STDIO'); }
    else if (!/^https?:\/\/\S+$/.test(String(cfg.url ?? ''))) throw new ConfigError('MCP URL must start with http:// or https://');
    if (cfg.preset === 'custom') {
      if (!/^[\w.-]{1,80}$/.test(String(cfg.listTool ?? '')) || !/^[\w.-]{1,80}$/.test(String(cfg.readTool ?? ''))) throw new ConfigError('Name the list and read tools');
      if (cfg.listArgs) try { JSON.parse(cfg.listArgs); } catch { throw new ConfigError('List tool arguments must be JSON'); }
    }
  },
  async test(cfg, ctx) {
    const p = preset(cfg);
    const files = pathsFrom(await ctx.mcp().call(p.list, p.listArgs));
    return { ok: true, message: `Found ${files.length} Markdown files.`, sample: files.slice(0, 5) };
  },
  async *sync(cfg, ctx) {
    const p = preset(cfg);
    const mcp = ctx.mcp();
    const files = pathsFrom(await mcp.call(p.list, p.listArgs));
    ctx.log(`Listed ${files.length} files`);
    for (const f of files) {
      if (ctx.signal.aborted) throw new Error('Sync stopped');
      const res = await mcp.call(p.read, { [p.readArg]: f });
      if (res.isError) { ctx.log(`Skipped ${f}: ${res.text.slice(0, 120)}`); continue; }
      yield markdownEntry(f.replace(/^\.?\//, ''), res.text, cfg.defaultShared && ctx.shareVisible ? 'party' : 'dm');
    }
  },
  readTools: (cfg) => { const p = preset(cfg); return [p.list, p.read]; },
};

function preset(cfg: any) {
  if (cfg.preset === 'custom') return { list: cfg.listTool, listArgs: cfg.listArgs ? JSON.parse(cfg.listArgs) : {}, read: cfg.readTool, readArg: cfg.readArg || 'path' };
  return PRESETS[cfg.preset ?? 'obsidian'] ?? PRESETS.obsidian;
}

export const MCP_FILE_TOOLS = Object.values(PRESETS).flatMap((p) => [p.list, p.read]);
