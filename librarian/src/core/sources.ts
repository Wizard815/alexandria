// World sources: where a world's library comes from. A source belongs to
// exactly one world.
//  - vault: a Markdown folder on the server (Obsidian, Lokus, Otterly),
//           limited to folders under ALX_VAULTS_DIR
//  - git:   a repo of reference files (e.g. your dnd-ref repo), cloned
//           read-only into the data folder; an optional subfolder
//  - kanka: a Kanka campaign, read through the Kanka API
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Library } from './library.ts';
import { HttpError } from './util.ts';

const run = promisify(execFile);

export interface SourceRow {
  id: string;
  world_id: string;
  kind: 'vault' | 'git' | 'kanka';
  name: string;
  config: string;
  default_visibility: string;
}

export interface SyncDeps {
  library: Library;
  dataDir: string | null;
  vaultsDir: string | null;
  fetch: typeof fetch;
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
  throw new HttpError(400, 'Unknown source kind');
}

const KANKA_TYPES = ['characters', 'locations', 'organisations', 'families', 'items', 'notes', 'journals', 'quests', 'races', 'creatures'];

async function syncKanka(src: SourceRow, cfg: any, deps: SyncDeps, by: string) {
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
        deps.library.save(src.world_id, { path: `kanka/${type}/${slug(e.name)}-${e.id}.md`, title: e.name, body: htmlToMarkdown(e.entry ?? ''), frontmatter: fm, visibility, sourceId: src.id }, by);
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
