// Write-back for the Markdown folder, used only by the WorldLore workspace.
// Files are written inside the workspace root folder and nowhere else:
// every path is resolved, must stay under the root, and no part of it may be
// a symbolic link (so a link planted in the folder cannot lead out of it).
import fs from 'node:fs';
import path from 'node:path';
import type { ConnectorWrite, WriteLevel } from '../connector.ts';
import { WriteRefused } from '../connector.ts';
import { joinFrontmatter, splitFrontmatter, type FM } from '../../core/frontmatter.ts';
import { markdownEntry, vaultDir } from './markdown.ts';

const posix = (p: string) => p.split(path.sep).join('/');

/** A relative path made only of plain parts: no '..', no dot-files, no absolute or drive paths. */
function cleanRel(p: unknown, what: string): string {
  const raw = String(p ?? '').replace(/\\/g, '/');
  if (raw.startsWith('/')) throw new WriteRefused(`Bad ${what}`, 403);
  const parts = raw.split('/').filter((x) => x && x !== '.');
  if (!parts.length) throw new WriteRefused(`Missing ${what}`, 400);
  if (parts.some((x) => x === '..' || x.startsWith('.') || /[\x00-\x1f:*?"<>|]/.test(x)) || /^[a-zA-Z]:/.test(parts[0])) throw new WriteRefused(`Bad ${what}`, 403);
  return parts.join('/');
}

/** Throws when `full` or any existing part of it below `from` is a symbolic link. */
function noLinks(from: string, full: string) {
  const rel = path.relative(from, full);
  let cur = from;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    let st: fs.Stats;
    try { st = fs.lstatSync(cur); } catch { return; } // the rest does not exist yet
    if (st.isSymbolicLink()) throw new WriteRefused('A link in the folder leads out of the workspace', 403);
  }
}

interface Ctx { base: string; rootAbs: string; rootRel: string }

function setup(cfg: Record<string, any>, vaultsDir: string | null, root: string): Ctx {
  const base = vaultDir(vaultsDir, String(cfg.folder ?? ''));
  const rootRel = cleanRel(root, 'workspace folder');
  const rootAbs = path.resolve(base, rootRel);
  if (!rootAbs.startsWith(base + path.sep)) throw new WriteRefused('The workspace folder is outside the source folder', 403);
  noLinks(base, rootAbs);
  return { base, rootAbs, rootRel };
}

/** A path under the workspace root, as an absolute path. `rel` is relative to the root. */
function underRoot(c: Ctx, rel: string, ensureMd = true): string {
  let r = cleanRel(rel, 'path');
  if (ensureMd && !/\.md$/i.test(r)) r += '.md';
  const full = path.resolve(c.rootAbs, r);
  if (!full.startsWith(c.rootAbs + path.sep)) throw new WriteRefused('That path is outside the WorldLore workspace', 403);
  noLinks(c.rootAbs, full);
  return full;
}

/** A page id (path relative to the source folder) that must be a file inside the workspace root. */
function pageFile(c: Ctx, id: string): string {
  const rel = cleanRel(id, 'page id');
  const full = path.resolve(c.base, rel);
  if (!full.startsWith(c.rootAbs + path.sep)) throw new WriteRefused('That page is outside the WorldLore workspace', 403);
  noLinks(c.base, full);
  return full;
}

const idOf = (c: Ctx, full: string) => posix(path.relative(c.base, full));

function mkdirs(c: Ctx, dir: string) {
  if (!dir.startsWith(c.rootAbs)) throw new WriteRefused('That path is outside the WorldLore workspace', 403);
  noLinks(c.base, dir);
  fs.mkdirSync(dir, { recursive: true });
}

const slug = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page';

export const markdownWrite: ConnectorWrite = {
  async createPage(cfg, ctx, a) {
    const c = setup(cfg, ctx.vaultsDir, a.root);
    const full = underRoot(c, a.path || slug(a.title));
    mkdirs(c, path.dirname(full));
    const fm: FM = { title: a.title, visibility: a.level };
    try {
      fs.writeFileSync(full, joinFrontmatter(fm, a.markdown.endsWith('\n') ? a.markdown : a.markdown + '\n'), { flag: 'wx' });
    } catch (err: any) {
      if (err?.code === 'EEXIST') throw new WriteRefused('A page with that path already exists', 409);
      throw err;
    }
    return { externalId: idOf(c, full) };
  },

  async updatePage(cfg, ctx, a) {
    const c = setup(cfg, ctx.vaultsDir, a.root);
    const full = pageFile(c, a.id);
    if (!fs.existsSync(full) || !fs.lstatSync(full).isFile()) throw new WriteRefused('No such page', 404);
    const cur = splitFrontmatter(fs.readFileSync(full, 'utf8'));
    const fm: FM = { ...cur.fm };
    if (a.title !== undefined) fm.title = a.title;
    if (a.level !== undefined) fm.visibility = a.level;
    const body = a.markdown !== undefined ? (a.markdown.endsWith('\n') ? a.markdown : a.markdown + '\n') : cur.body;
    fs.writeFileSync(full, joinFrontmatter(fm, body));
    return { externalId: idOf(c, full) };
  },

  async movePage(cfg, ctx, a) {
    const c = setup(cfg, ctx.vaultsDir, a.root);
    const from = pageFile(c, a.id);
    if (!a.to) throw new WriteRefused('Say where to move it (a path under the workspace)', 400);
    const to = underRoot(c, a.to);
    if (!fs.existsSync(from) || !fs.lstatSync(from).isFile()) throw new WriteRefused('No such page', 404);
    if (fs.existsSync(to)) throw new WriteRefused('A page with that path already exists', 409);
    mkdirs(c, path.dirname(to));
    fs.renameSync(from, to);
    return { externalId: idOf(c, to) };
  },

  async deletePage(cfg, ctx, a) {
    const c = setup(cfg, ctx.vaultsDir, a.root);
    const full = pageFile(c, a.id);
    if (!fs.existsSync(full) || !fs.lstatSync(full).isFile()) throw new WriteRefused('No such page', 404);
    fs.unlinkSync(full);
  },

  async readPage(cfg, ctx, a) {
    const c = setup(cfg, ctx.vaultsDir, a.root);
    const full = pageFile(c, a.id);
    if (!fs.existsSync(full)) return null;
    return markdownEntry(idOf(c, full), fs.readFileSync(full, 'utf8'), 'dm');
  },

  async roots(cfg, ctx) {
    const base = vaultDir(ctx.vaultsDir, String(cfg.folder ?? ''));
    const dirs = fs.existsSync(base)
      ? fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => ({ id: e.name, title: e.name, folder: true }))
      : [];
    if (!dirs.some((d) => d.id === 'WorldLore')) dirs.unshift({ id: 'WorldLore', title: 'WorldLore (new folder)', folder: true });
    return dirs;
  },
};

export type { WriteLevel };
