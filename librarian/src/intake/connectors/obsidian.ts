// Obsidian, three more ways in (the vault folder and the Obsidian MCP are in markdown.ts):
//
//   obsidian-sync     Obsidian's own Sync, through its official headless client (`ob`, npm obsidian-headless, Node 22+).
//                     Before each read `ob sync` brings the remote vault (shared vaults too) into a folder under
//                     ALX_VAULTS_DIR, which is then read like any vault. WorldLore writes go into that folder and
//                     `ob sync` sends them back (only in two-way mode).
//   obsidian-rest     The "Local REST API" community plugin running in the DM's Obsidian (GET/PUT/DELETE /vault/...).
//   obsidian-publish  A site published with Obsidian Publish, read the way a browser reads it (public pages only).
//
// Every page goes through the same Markdown rules as a vault: frontmatter, [[links]], > [!secret] callouts,
// %% comments %%, DM headings and visibility.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Connector, ConnectorContext, ConnectorWrite } from '../connector.ts';
import type { Entry } from '../model.ts';
import { ConfigError, WriteRefused } from '../connector.ts';
import { joinFrontmatter, splitFrontmatter, type FM } from '../../core/frontmatter.ts';
import { markdownEntry, markdownFolder, setMarkdownPositions, vaultDir } from './markdown.ts';
import { markdownWrite } from './markdown-write.ts';

const run = promisify(execFile);
const vaultNameField = { key: 'vaultName', label: 'Obsidian vault name', type: 'text' as const, help: 'The name Obsidian shows for this vault. With it, each page gets an "Open file" button that opens the note in Obsidian on the DM’s computer.' };
const shareField = { key: 'defaultShared', label: 'Pages without a visibility are shared', type: 'boolean' as const, help: 'Off (safer): only pages with visibility: party in their frontmatter are shared.' };
const mdPath = (p: string) => /\.md$/i.test(p) && !p.split('/').some((s) => !s || s === '..' || s.startsWith('.'));

// ---------- Obsidian Sync (headless) ----------

/** The `ob` command: ALX_OBSIDIAN_BIN, else `ob` on the PATH. */
const obBin = (env: Record<string, string | undefined>) => env.ALX_OBSIDIAN_BIN || 'ob';
/** `ob` keeps its sign-in under HOME: ALX_OBSIDIAN_HOME puts it somewhere that survives a container restart (the image uses /data). */
const obEnv = (env: Record<string, string | undefined>) => ({ ...process.env, NO_COLOR: '1', ...(env.ALX_OBSIDIAN_HOME ? { HOME: env.ALX_OBSIDIAN_HOME } : {}) });

/** Run one `ob` command (an argument list, never a shell). The E2EE password goes in as an argument, as `ob` documents; it is never logged. */
export async function ob(ctx: Pick<ConnectorContext, 'env' | 'signal'>, args: string[], timeout = 600_000): Promise<string> {
  try {
    const { stdout } = await run(obBin(ctx.env), args, { timeout, signal: ctx.signal, maxBuffer: 8 * 1024 * 1024, env: obEnv(ctx.env) });
    return String(stdout);
  } catch (err: any) {
    if (err?.code === 'ENOENT') throw new Error('The Obsidian headless client is not installed on the server: npm install -g obsidian-headless (Node 22+), then run "ob login" once');
    const out = `${err?.stderr ?? ''} ${err?.stdout ?? ''}`.replace(/\s+/g, ' ').trim();
    if (/log ?in|not logged|unauthori[sz]ed|credentials/i.test(out)) throw new Error('Obsidian Sync is not signed in on the server: run "ob login" there once (see HOSTING.md, "Obsidian Sync")');
    throw new Error(`ob ${args[0]} failed: ${(out || String(err?.message ?? err)).slice(0, 200)}`);
  }
}

/** The vault folder is linked to its remote vault (and set to the chosen mode); the first time, `ob sync-setup` links it. */
async function obReady(cfg: Record<string, any>, ctx: ConnectorContext, dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  let linked = true;
  try { await ob(ctx, ['sync-status', '--path', dir], 60_000); } catch (err: any) { if (/not installed|not signed in/.test(err.message)) throw err; linked = false; }
  if (!linked) {
    ctx.log(`Linking ${dir} to the Obsidian Sync vault "${cfg.vault}"`);
    await ob(ctx, ['sync-setup', '--vault', String(cfg.vault), '--path', dir, '--device-name', 'Alexandria', ...(cfg.e2eePassword ? ['--password', String(cfg.e2eePassword)] : [])], 120_000);
  }
  // Read-only unless the DM chose two-way: the server never changes the vault by itself.
  await ob(ctx, ['sync-config', '--path', dir, '--mode', cfg.twoWay === true ? 'bidirectional' : 'pull-only'], 60_000);
}

const obFolder = (cfg: Record<string, any>, vaultsDir: string | null) => vaultDir(vaultsDir, String(cfg.folder ?? ''));

export const obsidianSync: Connector = {
  id: 'obsidian-sync',
  label: 'Obsidian Sync (official, headless)',
  description: 'Brings an Obsidian Sync vault (your own or one shared with you) to the server with Obsidian’s official headless client, then reads it like a vault. Needs an Obsidian Sync subscription.',
  capabilities: ['pages', 'properties', 'tags', 'relations'],
  fields: [
    { key: 'vault', label: 'Remote vault', type: 'text', required: true, help: 'Its name or id, as "ob sync-list-remote" shows it. Shared vaults work too.' },
    { key: 'folder', label: 'Folder on the server', type: 'text', required: true, help: 'Inside ALX_VAULTS_DIR. The vault is synced into it; use an empty folder only for this.' },
    { key: 'e2eePassword', label: 'End-to-end encryption password', type: 'password', secret: true, help: 'Only for an end-to-end encrypted vault.' },
    { key: 'twoWay', label: 'Two-way (WorldLore writes go back to Sync)', type: 'boolean', default: false, help: 'Off: pull only; the server never changes your vault. On: pages the agent writes in WorldLore are sent to Sync.' },
    vaultNameField, shareField,
  ],
  validate(cfg, ctx) {
    if (!String(cfg.vault ?? '').trim() || String(cfg.vault).length > 200) throw new ConfigError('Name the remote vault');
    obFolder(cfg, ctx.vaultsDir);
  },
  async test(cfg, ctx) {
    const out = await ob(ctx, ['sync-list-remote'], 60_000);
    const want = String(cfg.vault).trim().toLowerCase();
    const found = out.split('\n').some((l) => l.toLowerCase().includes(want));
    return found ? { ok: true, message: `Signed in. Vault "${cfg.vault}" found.` } : { ok: false, message: `Signed in, but no remote vault called "${cfg.vault}". Vaults: ${out.replace(/\s+/g, ' ').trim().slice(0, 300)}` };
  },
  async *sync(cfg, ctx) {
    const dir = obFolder(cfg, ctx.vaultsDir);
    await obReady(cfg, ctx, dir);
    await ob(ctx, ['sync', '--path', dir]);
    yield* markdownFolder.sync(cfg, ctx);
  },
};

/** WorldLore on a synced vault: the folder rules of markdown-write, then `ob sync` sends the change (two-way only). */
const pushAfter = <K extends keyof ConnectorWrite>(k: K): any => async (cfg: Record<string, any>, ctx: ConnectorContext, a: any) => {
  if (k !== 'readPage' && k !== 'roots' && cfg.twoWay !== true) throw new WriteRefused('This Obsidian Sync source is pull-only. Turn on "Two-way" to let WorldLore write to it.', 403);
  const out = await (markdownWrite as any)[k](cfg, ctx, a);
  if (k !== 'readPage' && k !== 'roots') await ob(ctx, ['sync', '--path', obFolder(cfg, ctx.vaultsDir)]).catch((err) => ctx.log(`Saved here; Obsidian Sync will get it next time: ${err.message}`));
  return out;
};
export const obsidianSyncWrite: ConnectorWrite = {
  createPage: pushAfter('createPage'), updatePage: pushAfter('updatePage'), movePage: pushAfter('movePage'), deletePage: pushAfter('deletePage'),
  readPage: pushAfter('readPage'), roots: pushAfter('roots'),
};

// ---------- Local REST API plugin ----------

export const OBSIDIAN_REST = 'https://127.0.0.1:27124';
const restBase = (cfg: Record<string, any>) => String(cfg.url || OBSIDIAN_REST).replace(/\/$/, '');
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

async function rest(ctx: Pick<ConnectorContext, 'fetch' | 'signal'> & Partial<Pick<ConnectorContext, 'calls'>>, cfg: Record<string, any>, method: string, p: string, a: { accept?: string; body?: string } = {}): Promise<Response> {
  await ctx.calls?.take();
  const url = restBase(cfg) + p;
  if (!url.startsWith(restBase(cfg) + '/')) throw new Error('Refusing a request outside the Obsidian address');
  try {
    return await ctx.fetch(url, { method, headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: a.accept ?? 'application/json', ...(a.body !== undefined ? { 'Content-Type': 'text/markdown' } : {}) }, body: a.body, signal: ctx.signal });
  } catch (err: any) {
    if (ctx.signal.aborted) throw err;
    const why = String(err?.cause?.code ?? err?.message ?? err);
    if (/CERT|SELF_SIGNED|certificate/i.test(why)) throw new Error('Obsidian’s HTTPS certificate is self-signed: turn on the plugin’s non-encrypted server (port 27123) and use http://, or add its certificate with NODE_EXTRA_CA_CERTS');
    throw new Error(`Could not reach Obsidian at ${restBase(cfg)}: ${why.slice(0, 120)}. Is Obsidian open with the Local REST API plugin on?`);
  }
}

/** Every Markdown path in the vault (the plugin lists one folder at a time; folders end with "/"). */
async function restList(cfg: Record<string, any>, ctx: ConnectorContext, dir = '', depth = 0): Promise<string[]> {
  if (depth > 30) return [];
  const r = await rest(ctx, cfg, 'GET', `/vault/${dir ? encPath(dir) + '/' : ''}`);
  if (r.status === 401 || r.status === 403) throw new Error(`Obsidian refused the API key (${r.status})`);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`Obsidian answered ${r.status} for /vault/${dir}`);
  const j: any = await r.json();
  const out: string[] = [];
  for (const f of Array.isArray(j?.files) ? j.files : []) {
    const name = String(f);
    if (name.startsWith('.')) continue;
    if (name.endsWith('/')) out.push(...await restList(cfg, ctx, `${dir ? dir + '/' : ''}${name.slice(0, -1)}`, depth + 1));
    else { const full = `${dir ? dir + '/' : ''}${name}`; if (mdPath(full)) out.push(full); }
  }
  return out;
}

/** One note: its text (the plugin's note JSON carries the whole file as `content`) and its change time. */
async function restRead(cfg: Record<string, any>, ctx: ConnectorContext, p: string): Promise<{ text: string; mtime: string | null } | null> {
  const r = await rest(ctx, cfg, 'GET', `/vault/${encPath(p)}`, { accept: 'application/vnd.olrapi.note+json' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Obsidian answered ${r.status} for ${p}`);
  const type = String(r.headers.get('content-type') ?? '');
  if (/json/.test(type)) {
    const j: any = await r.json();
    const mt = Number(j?.stat?.mtime);
    return { text: String(j?.content ?? ''), mtime: Number.isFinite(mt) && mt > 0 ? new Date(mt).toISOString() : null };
  }
  return { text: await r.text(), mtime: null };
}

export const obsidianRest: Connector = {
  id: 'obsidian-rest',
  label: 'Obsidian (Local REST API plugin)',
  description: 'Reads the vault open in your Obsidian through the Local REST API community plugin. Obsidian must be running and reachable from the server.',
  capabilities: ['pages', 'properties', 'tags', 'relations'],
  fields: [
    { key: 'url', label: 'Obsidian address', type: 'url', placeholder: OBSIDIAN_REST, help: 'https://<computer>:27124, or http://<computer>:27123 with the plugin’s non-encrypted server on (its HTTPS certificate is self-signed).' },
    { key: 'apiKey', label: 'API key', type: 'password', secret: true, required: true, help: 'Obsidian → Settings → Local REST API → API Key.' },
    { key: 'folder', label: 'Only this folder', type: 'text', help: 'A folder inside the vault. Empty: the whole vault.' },
    vaultNameField, shareField,
  ],
  validate(cfg) {
    if (cfg.url && !/^https?:\/\/\S+$/.test(String(cfg.url))) throw new ConfigError('Obsidian address must start with http:// or https://');
    if (String(cfg.apiKey ?? '').length < 8) throw new ConfigError('API key is required');
    if (cfg.folder && String(cfg.folder).split('/').some((s) => s === '..' || s.startsWith('.'))) throw new ConfigError('Bad folder');
  },
  async test(cfg, ctx) {
    const r = await rest(ctx, cfg, 'GET', '/');
    const j: any = await r.json().catch(() => null);
    if (!r.ok || j?.authenticated === false) return { ok: false, message: j?.authenticated === false ? 'Obsidian is reachable but did not accept the API key.' : `Obsidian answered ${r.status}.` };
    const files = await restList(cfg, ctx, String(cfg.folder ?? '').replace(/^\/|\/$/g, ''));
    return { ok: true, message: `Connected to Obsidian${j?.versions?.obsidian ? ' ' + j.versions.obsidian : ''}. ${files.length} notes.`, sample: files.slice(0, 5) };
  },
  async *sync(cfg, ctx) {
    const root = String(cfg.folder ?? '').replace(/^\/|\/$/g, '');
    const files = await restList(cfg, ctx, root);
    ctx.log(`Listed ${files.length} notes`);
    const entries: Entry[] = [];
    for (const f of files) {
      if (ctx.signal.aborted) throw new Error('Sync stopped');
      const got = await restRead(cfg, ctx, f);
      if (!got) continue;
      const e = markdownEntry(f, got.text, cfg.defaultShared && ctx.shareVisible ? 'party' : 'dm', cfg.vaultName);
      if (got.mtime) e.updatedAt = got.mtime;
      entries.push(e);
    }
    setMarkdownPositions(entries);
    yield* entries;
  },
};

/** A clean path under the workspace folder: plain parts, no "..", no dot-files. */
function cleanRel(p: unknown, what: string): string {
  const parts = String(p ?? '').replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  if (!parts.length) throw new WriteRefused(`Missing ${what}`, 400);
  if (parts.some((x) => x === '..' || x.startsWith('.') || /[\x00-\x1f:*?"<>|]/.test(x))) throw new WriteRefused(`Bad ${what}`, 403);
  return parts.join('/');
}
const slug = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page';
const md = (p: string) => (/\.md$/i.test(p) ? p : p + '.md');

/** WorldLore through the plugin: files under the workspace folder only. */
export const obsidianRestWrite: ConnectorWrite = {
  async createPage(cfg, ctx, a) {
    const root = cleanRel(a.root, 'workspace folder');
    const p = `${root}/${md(cleanRel(a.path || slug(a.title), 'path'))}`;
    if (await restRead(cfg, ctx, p)) throw new WriteRefused('A page with that path already exists', 409);
    const fm: FM = { title: a.title, visibility: a.level };
    const r = await rest(ctx, cfg, 'PUT', `/vault/${encPath(p)}`, { body: joinFrontmatter(fm, a.markdown.endsWith('\n') ? a.markdown : a.markdown + '\n') });
    if (!r.ok) throw new Error(`Obsidian answered ${r.status} when saving ${p}`);
    return { externalId: p };
  },
  async updatePage(cfg, ctx, a) {
    const p = inRoot(a.root, a.id);
    const cur = await restRead(cfg, ctx, p);
    if (!cur) throw new WriteRefused('No such page', 404);
    const s = splitFrontmatter(cur.text);
    const fm: FM = { ...s.fm };
    if (a.title !== undefined) fm.title = a.title;
    if (a.level !== undefined) fm.visibility = a.level;
    const body = a.markdown !== undefined ? (a.markdown.endsWith('\n') ? a.markdown : a.markdown + '\n') : s.body;
    const r = await rest(ctx, cfg, 'PUT', `/vault/${encPath(p)}`, { body: joinFrontmatter(fm, body) });
    if (!r.ok) throw new Error(`Obsidian answered ${r.status} when saving ${p}`);
    return { externalId: p };
  },
  async movePage(cfg, ctx, a) {
    const from = inRoot(a.root, a.id);
    if (!a.to) throw new WriteRefused('Say where to move it (a path under the workspace)', 400);
    const to = `${cleanRel(a.root, 'workspace folder')}/${md(cleanRel(a.to, 'path'))}`;
    const cur = await restRead(cfg, ctx, from);
    if (!cur) throw new WriteRefused('No such page', 404);
    if (await restRead(cfg, ctx, to)) throw new WriteRefused('A page with that path already exists', 409);
    // The plugin has no rename: write the new file, then remove the old one.
    const put = await rest(ctx, cfg, 'PUT', `/vault/${encPath(to)}`, { body: cur.text });
    if (!put.ok) throw new Error(`Obsidian answered ${put.status} when saving ${to}`);
    const del = await rest(ctx, cfg, 'DELETE', `/vault/${encPath(from)}`);
    if (!del.ok && del.status !== 404) throw new Error(`Obsidian answered ${del.status} when removing ${from}`);
    return { externalId: to };
  },
  async deletePage(cfg, ctx, a) {
    const p = inRoot(a.root, a.id);
    const r = await rest(ctx, cfg, 'DELETE', `/vault/${encPath(p)}`);
    if (r.status === 404) throw new WriteRefused('No such page', 404);
    if (!r.ok) throw new Error(`Obsidian answered ${r.status} when removing ${p}`);
  },
  async readPage(cfg, ctx, a) {
    const p = inRoot(a.root, a.id);
    const got = await restRead(cfg, ctx, p);
    return got ? markdownEntry(p, got.text, 'dm', cfg.vaultName) : null;
  },
  async roots(cfg, ctx) {
    const r = await rest(ctx, cfg, 'GET', '/vault/');
    const j: any = r.ok ? await r.json() : { files: [] };
    const dirs = (Array.isArray(j?.files) ? j.files : []).map(String).filter((f: string) => f.endsWith('/') && !f.startsWith('.')).map((f: string) => ({ id: f.slice(0, -1), title: f.slice(0, -1), folder: true }));
    if (!dirs.some((d: any) => d.id === 'WorldLore')) dirs.unshift({ id: 'WorldLore', title: 'WorldLore (new folder)', folder: true });
    return dirs;
  },
};
/** A page id that must be a note inside the workspace folder. */
function inRoot(root: string, id: string): string {
  const r = cleanRel(root, 'workspace folder');
  const p = cleanRel(id, 'page id');
  if (!p.startsWith(r + '/') || !/\.md$/i.test(p)) throw new WriteRefused('That page is outside the WorldLore workspace', 403);
  return p;
}

// ---------- Obsidian Publish ----------

/**
 * A Publish site's own description, from its page: `siteInfo = {"uid": ..., "host": "publish-01.obsidian.md", ...}`. The page then loads
 * `https://<host>/cache/<uid>` (every published file) and `https://<host>/access/<uid>/<path>` (one file). These are the addresses the
 * site's own pages use, not a documented API: they may change.
 */
export function publishSiteInfo(html: string): { uid: string; host: string } | null {
  const m = /siteInfo\s*=\s*(\{[^;]*?\})\s*[;,]/.exec(html) ?? /siteInfo\s*=\s*(\{[^}]*\})/.exec(html);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    const uid = String(j.uid ?? '');
    const host = String(j.host ?? '');
    return /^[0-9a-f]{16,64}$/i.test(uid) && /^[\w-]+\.obsidian\.md$/i.test(host) ? { uid, host } : null;
  } catch { return null; }
}

const siteUrl = (cfg: Record<string, any>) => {
  const s = String(cfg.site ?? '').trim();
  return /^https?:\/\//i.test(s) ? s.replace(/\/$/, '') : `https://publish.obsidian.md/${encodeURIComponent(s.replace(/^\/|\/$/g, ''))}`;
};

async function publishSite(cfg: Record<string, any>, ctx: ConnectorContext) {
  await ctx.calls?.take();
  const r = await ctx.fetch(siteUrl(cfg), { headers: { Accept: 'text/html' }, signal: ctx.signal });
  if (!r.ok) throw new Error(`The Publish site answered ${r.status}`);
  const info = publishSiteInfo(await r.text());
  if (!info) throw new Error('That address is not an Obsidian Publish site (no site information on the page)');
  return info;
}

export const obsidianPublish: Connector = {
  id: 'obsidian-publish',
  label: 'Obsidian Publish site',
  description: 'Reads the notes of a site published with Obsidian Publish, as its visitors see them. Everything it has is public, so it is shared with players when the source shares.',
  capabilities: ['pages', 'properties', 'tags', 'relations'],
  fields: [
    { key: 'site', label: 'Site', type: 'text', required: true, help: 'Its address (https://publish.obsidian.md/<name>, or your own domain), or just <name>.' },
    { key: 'private', label: 'Keep it DM-only', type: 'boolean', default: false, help: 'On: nothing from this site reaches players (for a site you keep for yourself).' },
  ],
  validate(cfg) {
    const s = String(cfg.site ?? '').trim();
    if (!s || (/^https?:/i.test(s) ? !/^https?:\/\/\S+$/.test(s) : !/^[\w.-]{1,100}$/.test(s))) throw new ConfigError('Give the site address or name');
  },
  async test(cfg, ctx) {
    const info = await publishSite(cfg, ctx);
    const files = await publishFiles(cfg, ctx, info);
    return { ok: true, message: `Found ${files.length} published notes.`, sample: files.slice(0, 5) };
  },
  async *sync(cfg, ctx) {
    const info = await publishSite(cfg, ctx);
    const files = await publishFiles(cfg, ctx, info);
    ctx.log(`Listed ${files.length} published notes`);
    const entries: Entry[] = [];
    for (const f of files) {
      if (ctx.signal.aborted) throw new Error('Sync stopped');
      await ctx.calls?.take();
      const r = await ctx.fetch(`https://${info.host}/access/${info.uid}/${encPath(f)}`, { signal: ctx.signal });
      if (!r.ok) { ctx.log(`Skipped ${f}: ${r.status}`); continue; }
      // Published means public: shared unless the DM keeps the site DM-only. Secret callouts and DM headings are still kept back.
      const e = markdownEntry(f, await r.text(), cfg.private !== true && ctx.shareVisible ? 'party' : 'dm');
      e.url = `${siteUrl(cfg)}/${encPath(f.replace(/\.md$/i, ''))}`;
      entries.push(e);
    }
    setMarkdownPositions(entries);
    yield* entries;
  },
};

async function publishFiles(cfg: Record<string, any>, ctx: ConnectorContext, info: { uid: string; host: string }): Promise<string[]> {
  await ctx.calls?.take();
  const r = await ctx.fetch(`https://${info.host}/cache/${info.uid}`, { headers: { Accept: 'application/json' }, signal: ctx.signal });
  if (!r.ok) throw new Error(`The Publish site's file list answered ${r.status}`);
  const j: any = await r.json();
  const keys = Array.isArray(j) ? j.map((x: any) => String(x?.path ?? x)) : Object.keys(j ?? {});
  return keys.filter(mdPath).slice(0, 20_000);
}
