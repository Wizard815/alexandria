// Turns an import request into a module document. Four sources, one result:
//   json   a module in the documented format
//   zip    a .zip of Markdown files, one term per file
//   folder files picked in the browser, one term per file
//   git    a repository cloned read-only into a temp folder, then as a folder
//   api    a JSON API with a simple field mapping
// Every path ends in normalizeModule(), which applies the size limits.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Deps } from '../../app.ts';
import { splitFrontmatter } from '../../core/frontmatter.ts';
import { HttpError, id as newId } from '../../core/util.ts';
import { htmlToMarkdown } from '../../intake/html.ts';
import { pick } from '../../intake/connectors/api.ts';
import { KINDS, LIMITS, asKind, normalizeModule, slug, type ModuleDoc } from './format.ts';
import { readZip, ZIP_LIMITS } from './zip.ts';

export interface SourceFile { path: string; text: string }

const FILE_LIMITS = { files: 20_000, fileChars: 200_000, totalChars: 24_000_000 };
const META_KEYS = ['id', 'name', 'version', 'license', 'attribution'] as const;

function metaOf(b: any): Partial<ModuleDoc> {
  const m = b?.module && typeof b.module === 'object' ? b.module : {};
  const out: any = {};
  for (const k of META_KEYS) if (typeof m[k] === 'string' && m[k].trim()) out[k] = m[k].trim();
  return out;
}

// ---- Markdown files -------------------------------------------------------
export function termsFromFiles(files: SourceFile[], meta: Partial<ModuleDoc>): { raw: any; warnings: string[] } {
  const warnings: string[] = [];
  if (files.length > FILE_LIMITS.files) throw new HttpError(413, `More than ${FILE_LIMITS.files} files`);
  // A single top-level folder (as zips of a repository have) is ignored.
  const norm = files.map((f) => ({ ...f, path: f.path.replace(/\\/g, '/').replace(/^\.?\//, '') })).filter((f) => !/(^|\/)(\.|__MACOSX)/.test(f.path));
  const tops = new Set(norm.map((f) => f.path.split('/')[0]));
  const strip = tops.size === 1 && norm.every((f) => f.path.includes('/')) ? 1 : 0;
  let total = 0;
  const terms: any[] = [];
  let fileMeta: any = {};
  for (const f of norm) {
    const rel = f.path.split('/').slice(strip).join('/');
    total += f.text.length;
    if (total > FILE_LIMITS.totalChars) throw new HttpError(413, 'The files are too large together');
    if (rel.toLowerCase() === 'module.json') {
      try { fileMeta = JSON.parse(f.text); } catch { warnings.push('module.json is not valid JSON; ignored'); }
      continue;
    }
    if (!/\.(md|markdown)$/i.test(rel)) continue;
    const base = path.posix.basename(rel).replace(/\.(md|markdown)$/i, '');
    if (/^(readme|license|changelog|contributing)$/i.test(base) || base.startsWith('_')) continue;
    if (f.text.length > FILE_LIMITS.fileChars) { warnings.push(`${rel} is longer than ${FILE_LIMITS.fileChars} characters; skipped`); continue; }
    const { fm, body } = splitFrontmatter(f.text);
    let text = body.trim();
    let term = String(fm.title ?? fm.term ?? fm.name ?? '').trim();
    if (!term) {
      const h1 = /^#\s+(.+)$/m.exec(text);
      if (h1) { term = h1[1].trim(); text = text.replace(h1[0], '').trim(); }
    }
    if (!term) term = base.replace(/[-_]+/g, ' ');
    const dirs = rel.split('/').slice(0, -1).map((d) => d.toLowerCase());
    const dirKind = dirs.map((d) => asKind(d)).find((k) => k !== 'other');
    const kind = fm.kind ? asKind(fm.kind) : dirKind ?? 'other';
    terms.push({ term, kind, aliases: fm.aliases ?? [], summary: typeof fm.summary === 'string' ? fm.summary : '', text, id: typeof fm.id === 'string' ? fm.id : undefined });
  }
  const fm = { ...fileMeta };
  return { raw: { ...Object.fromEntries(META_KEYS.map((k) => [k, meta[k] ?? fm[k]])), terms }, warnings };
}

// ---- zip ------------------------------------------------------------------
export function termsFromZip(buf: Buffer, meta: Partial<ModuleDoc>) {
  const entries = readZip(buf, ZIP_LIMITS, (n) => /\.(md|markdown|json)$/i.test(n) && !/(^|\/)(\.|__MACOSX)/.test(n));
  const files: SourceFile[] = entries.filter((e) => /\.(md|markdown)$/i.test(e.name) || /(^|\/)module\.json$/i.test(e.name)).map((e) => ({ path: e.name, text: e.read().toString('utf8') }));
  return termsFromFiles(files, meta);
}

// ---- git ------------------------------------------------------------------
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return true;
  return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

export function checkRemote(url: string, allowLocal: boolean, schemes: string[]) {
  let u: URL;
  try { u = new URL(url); } catch { throw new HttpError(400, 'That is not a web address'); }
  if (!schemes.includes(u.protocol)) throw new HttpError(400, `Only ${schemes.join(' / ')} addresses are allowed`);
  if (!allowLocal && isPrivateHost(u.hostname)) throw new HttpError(400, 'Addresses on this server or its private network are not allowed');
  return u;
}

function walk(root: string, files: SourceFile[], state = { n: 0, total: 0 }, rel = '') {
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.isSymbolicLink()) continue;
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) { walk(root, files, state, r); continue; }
    if (!ent.isFile() || !/\.(md|markdown)$/i.test(ent.name) && ent.name.toLowerCase() !== 'module.json') continue;
    if (++state.n > FILE_LIMITS.files) throw new HttpError(413, `More than ${FILE_LIMITS.files} files`);
    const size = fs.statSync(path.join(root, r)).size;
    if (size > FILE_LIMITS.fileChars * 4) continue;
    state.total += size;
    if (state.total > FILE_LIMITS.totalChars) throw new HttpError(413, 'The repository is too large');
    files.push({ path: r, text: fs.readFileSync(path.join(root, r), 'utf8') });
  }
}

async function termsFromGit(b: any, d: Deps, meta: Partial<ModuleDoc>) {
  const allowLocal = d.env.ALX_ALLOW_LOCAL_URLS === '1';
  const url = String(b.url ?? '').trim();
  if (!url) throw new HttpError(400, 'url is required');
  if (allowLocal && (url.startsWith('/') || url.startsWith('file://'))) { /* tests and trusted hosts only */ }
  else checkRemote(url, false, ['https:', 'http:']);
  const ref = b.ref === undefined || b.ref === '' ? null : String(b.ref);
  if (ref !== null && !/^[\w][\w./-]{0,99}$/.test(ref)) throw new HttpError(400, 'ref is not a valid branch or tag name');
  const tmpRoot = path.join(d.dataDir ?? os.tmpdir(), 'modules-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, newId('git-'));
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('git', ['clone', '--depth', '1', '--single-branch', '--no-tags', ...(ref ? ['--branch', ref] : []), '--', url, dir], {
        timeout: 90_000,
        maxBuffer: 1_000_000,
        env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: allowLocal ? 'https:http:file' : 'https:http', GIT_CONFIG_NOSYSTEM: '1' },
      }, (err, _o, stderr) => (err ? reject(new HttpError(400, `git could not fetch that repository: ${String(stderr || err.message).split('\n')[0].slice(0, 200)}`)) : resolve()));
    });
    const files: SourceFile[] = [];
    const sub = b.path ? String(b.path).replace(/^\/+/, '') : '';
    const base = path.resolve(dir, sub);
    if (!base.startsWith(dir)) throw new HttpError(400, 'path must stay inside the repository');
    if (!fs.existsSync(base)) throw new HttpError(400, 'That folder is not in the repository');
    walk(base, files);
    const defName = path.basename(url.replace(/\.git$/, '').replace(/\/+$/, ''));
    return termsFromFiles(files, { name: defName, ...meta });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- API ------------------------------------------------------------------
async function termsFromApi(b: any, d: Deps, meta: Partial<ModuleDoc>) {
  const allowLocal = d.env.ALX_ALLOW_LOCAL_URLS === '1';
  const url = String(b.url ?? '').trim();
  const first = checkRemote(url, allowLocal, ['https:', 'http:']);
  const map = b.mapping && typeof b.mapping === 'object' ? b.mapping : {};
  const get = (item: any, spec: unknown): any => {
    if (typeof spec !== 'string' || !spec) return undefined;
    const parts = spec.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 1) return pick(item, parts[0]);
    return parts.map((p) => pick(item, p)).filter((v) => v !== undefined && v !== null && v !== '').map((v) => (Array.isArray(v) ? v.join('\n\n') : String(v))).join('\n\n');
  };
  const fmt = b.textFormat === 'html' || b.textFormat === 'text' ? b.textFormat : 'markdown';
  const maxItems = Math.min(Number(b.maxItems) || 5000, LIMITS.terms);
  const paging: string = ['page', 'link', 'cursor'].includes(b.paging) ? b.paging : 'none';
  const pageParam = typeof b.pageParam === 'string' && b.pageParam ? b.pageParam : 'page';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (b.token) headers[b.authHeader || 'Authorization'] = (b.authHeader && b.authHeader !== 'Authorization' ? '' : 'Bearer ') + String(b.token);
  const terms: any[] = [];
  let next: string | null = url;
  let page = Number(b.pageStart ?? 1);
  let bytes = 0;
  for (let i = 0; next && i < 400 && terms.length < maxItems; i++) {
    const u: URL = new URL(next);
    if (paging === 'page') u.searchParams.set(pageParam, String(page));
    checkRemote(u.toString(), allowLocal, ['https:', 'http:']);
    const r = await d.fetch(u.toString(), { headers, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new HttpError(400, `${u.host} answered ${r.status}`);
    const text = await r.text();
    bytes += text.length;
    if (bytes > 24_000_000) throw new HttpError(413, 'The API returned too much data');
    let j: any;
    try { j = JSON.parse(text); } catch { throw new HttpError(400, 'The API did not answer with JSON'); }
    const items = b.itemsPath ? pick(j, b.itemsPath) : j;
    if (!Array.isArray(items)) throw new HttpError(400, 'No list at the items path');
    for (const it of items) {
      if (terms.length >= maxItems) break;
      const name = get(it, map.term ?? 'name');
      if (name === undefined || name === null || name === '') continue;
      let body = get(it, map.text ?? 'description') ?? '';
      if (typeof body !== 'string') body = Array.isArray(body) ? body.map(String).join('\n\n') : JSON.stringify(body, null, 2);
      if (fmt === 'html') body = htmlToMarkdown(body);
      const al = get(it, map.aliases);
      const kindRaw = map.kind ? get(it, map.kind) : undefined;
      terms.push({
        term: String(name),
        id: map.id ? String(get(it, map.id) ?? '') || undefined : undefined,
        kind: kindRaw !== undefined && kindRaw !== null ? asKind(kindRaw) : asKind(b.kind ?? map.defaultKind ?? 'other'),
        aliases: Array.isArray(al) ? al.map(String) : typeof al === 'string' ? al.split(',') : [],
        summary: map.summary ? String(get(it, map.summary) ?? '') : '',
        text: body,
        data: map.data ? get(it, map.data) : undefined,
      });
    }
    if (!items.length) break;
    if (paging === 'page') page += 1;
    else if (paging === 'link') { const n = pick(j, b.nextPath); next = n ? new URL(String(n), u).toString() : null; }
    else if (paging === 'cursor') { const c = pick(j, b.nextPath); if (!c) break; const n = new URL(url); n.searchParams.set(pageParam, String(c)); next = n.toString(); }
    else break;
  }
  void first;
  const defName = new URL(url).hostname;
  return { raw: { ...Object.fromEntries(META_KEYS.map((k) => [k, meta[k]])), name: meta.name ?? defName, terms }, warnings: [] as string[] };
}

// ---- entry point ----------------------------------------------------------
/** The raw request body of an import (preview or save) to a normalised module. */
export async function readModule(b: any, d: Deps, rawZip?: Buffer): Promise<{ module: ModuleDoc; warnings: string[]; source: string }> {
  if (!b || typeof b !== 'object') b = {};
  const meta = metaOf(b);
  const type = rawZip ? 'zip' : String(b.type ?? '');
  let r: { raw: any; warnings: string[] };
  let source = type;
  switch (type) {
    case 'json': {
      let j: any = b.json;
      if (typeof j === 'string') { try { j = JSON.parse(j); } catch { throw new HttpError(400, 'That is not valid JSON'); } }
      r = { raw: { ...j, ...Object.fromEntries(Object.entries(meta)) }, warnings: [] };
      break;
    }
    case 'zip': {
      const buf = rawZip ?? Buffer.from(String(b.zip ?? ''), 'base64');
      if (!buf.length) throw new HttpError(400, 'zip is empty');
      r = termsFromZip(buf, meta);
      break;
    }
    case 'folder': {
      const files: unknown = b.files;
      if (!Array.isArray(files) || !files.length) throw new HttpError(400, 'files must be a list of { path, text }');
      if (files.length > FILE_LIMITS.files) throw new HttpError(413, `More than ${FILE_LIMITS.files} files`);
      r = termsFromFiles(files.map((f: any) => ({ path: String(f?.path ?? ''), text: String(f?.text ?? '') })), meta);
      break;
    }
    case 'git':
      r = await termsFromGit(b, d, meta);
      source = `git ${String(b.url)}`;
      break;
    case 'api':
      r = await termsFromApi(b, d, meta);
      source = `api ${String(b.url)}`;
      break;
    default:
      throw new HttpError(400, `type must be one of: json, zip, folder, git, api`);
  }
  const { module, warnings } = normalizeModule(r.raw, meta);
  return { module, warnings: [...r.warnings, ...warnings], source };
}

void KINDS;
void slug;
