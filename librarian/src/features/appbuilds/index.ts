// The apps, hosted by this server: the Android APK and the desktop installers live in a
// folder of the server (ALX_APPS_DIR, default <data>/apps). Anyone signed in can download
// them from This device; the Android and desktop apps update themselves from here.
//
// GET    /api/apps                         public: {downloads, version, release, hosted}
// GET    /api/apps/builds                  signed in: the builds, newest per platform
// POST   /api/apps/builds/:file/ticket     signed-in session: a 15-minute download link
// GET    /api/apps/file/:file?t=<ticket>   the file itself (a link a browser or the app can open)
// GET    /api/admin/apps                   admins: the builds, the release source, the last fetch
// POST   /api/admin/apps/fetch             admins: fetch the latest GitHub release into the folder
// PUT    /api/admin/apps/:file?version=&replace=1  admins: upload a build (the raw file as the body)
// DELETE /api/admin/apps/:file             admins: remove a build
//
// Builds are copied in by "Fetch the latest release" (Admin, or ALX_APPS_AUTO_FETCH=1 every
// 12 hours) or by hand: drop Alexandria-...-android.apk, -windows-x64-setup.exe, -macos-*.dmg
// or -linux-x86_64.tar.gz into the folder. A version in the name (…-0.2.0-…) or the fetched
// release's tag tells the apps whether it is newer than theirs.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Express, Request, Response } from 'express';
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { authenticate, requireAdmin, type Auth } from '../../core/auth.ts';
import { HttpError, now } from '../../core/util.ts';
import { RELEASE, VERSION } from '../../version.ts';

/** The public downloads page /get-app links to when this server hosts no builds. */
export const DEFAULT_DOWNLOADS = 'https://github.com/Wizard815/alexandria/releases/latest';
export const DEFAULT_REPO = 'Wizard815/alexandria';
const TICKET_MS = 15 * 60_000;
/** The largest build an admin can upload (ALX_APPS_MAX_MB, default 1536 MB). */
const maxUpload = (d: Deps) => Math.max(1, Number(d.env.ALX_APPS_MAX_MB) || 1536) * 1048576;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,159}$/;

export type Platform = 'android' | 'windows' | 'macos' | 'linux';
export interface Build { file: string; platform: Platform; arch: string; version: string | null; release: string | null; size: number; sha256: string; at: string }
interface Meta { version?: string | null; release?: string | null; sha256?: string; size?: number; mtimeMs?: number }

export function platformOf(file: string): { platform: Platform; arch: string } | null {
  const f = file.toLowerCase();
  if (f.endsWith('.apk')) return { platform: 'android', arch: /arm64|aarch64/.test(f) ? 'arm64' : 'universal' };
  if (f.endsWith('.exe') || f.endsWith('.msi')) return { platform: 'windows', arch: /arm64/.test(f) ? 'arm64' : 'x64' };
  if (f.endsWith('.dmg')) return { platform: 'macos', arch: /x64|x86_64|intel/.test(f) ? 'x64' : /aarch64|arm64/.test(f) ? 'arm64' : 'universal' };
  if (f.endsWith('.tar.gz') || f.endsWith('.appimage') || f.endsWith('.deb')) return { platform: 'linux', arch: /aarch64|arm64/.test(f) ? 'arm64' : 'x86_64' };
  return null;
}

/** "0.2.0-alpha.1" from a file name, or null. A prerelease must be alpha, beta, rc, pre or dev, so "-android" is not one. */
export const versionIn = (file: string): string | null => /(?:^|[-_v])(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|pre|dev)(?:\.?\d+)?)?)(?=[-_.]|$)/i.exec(file.replace(/\.(apk|exe|msi|dmg|tar\.gz|appimage|deb)$/i, ''))?.[1] ?? null;

/** Semver order (prereleases before the release); -1, 0 or 1. Null sorts first. */
export function compareVersions(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const [ma, pa = ''] = a.split('-', 2);
  const [mb, pb = ''] = b.split('-', 2);
  const na = ma.split('.').map(Number), nb = mb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) < (nb[i] ?? 0) ? -1 : 1;
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  const xa = pa.split('.'), xb = pb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const p = xa[i], q = xb[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const np = /^\d+$/.test(p), nq = /^\d+$/.test(q);
    if (np && nq) return Number(p) < Number(q) ? -1 : 1;
    if (np !== nq) return np ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export function appsDir(d: Deps): string | null {
  const own = String(d.env.ALX_APPS_DIR ?? '').trim();
  if (own) return path.resolve(own);
  return d.dataDir ? path.join(d.dataDir, 'apps') : null;
}

const metaPath = (dir: string) => path.join(dir, 'builds.json');
function readMeta(dir: string): Record<string, Meta> {
  try { return JSON.parse(fs.readFileSync(metaPath(dir), 'utf8')) ?? {}; } catch { return {}; }
}
function writeMeta(dir: string, m: Record<string, Meta>) {
  fs.writeFileSync(metaPath(dir) + '.tmp', JSON.stringify(m, null, 2));
  fs.renameSync(metaPath(dir) + '.tmp', metaPath(dir));
}
async function sha256Of(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

/** Every build in the folder, newest version first within a platform. Hashes are kept in builds.json. */
export async function listBuilds(dir: string | null): Promise<Build[]> {
  if (!dir || !fs.existsSync(dir)) return [];
  const meta = readMeta(dir);
  let changed = false;
  const out: Build[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !NAME.test(e.name) || e.name.endsWith('.part')) continue;
    const kind = platformOf(e.name);
    if (!kind) continue;
    const st = fs.statSync(path.join(dir, e.name));
    let m = meta[e.name] ?? {};
    if (!m.sha256 || m.size !== st.size || m.mtimeMs !== st.mtimeMs) {
      m = { ...m, sha256: await sha256Of(path.join(dir, e.name)), size: st.size, mtimeMs: st.mtimeMs };
      meta[e.name] = m;
      changed = true;
    }
    out.push({ file: e.name, ...kind, version: m.version ?? versionIn(e.name), release: m.release ?? null, size: st.size, sha256: m.sha256!, at: new Date(st.mtimeMs).toISOString() });
  }
  for (const k of Object.keys(meta)) if (!out.some((b) => b.file === k)) { delete meta[k]; changed = true; }
  if (changed) { try { writeMeta(dir, meta); } catch { /* read-only folder: hashes are worked out again next time */ } }
  return out.sort((a, b) => a.platform.localeCompare(b.platform) || compareVersions(b.version, a.version) || b.at.localeCompare(a.at));
}

// ---- download tickets: a link a browser or the app opens without the sign-in header ----

const tickets = new Map<string, { file: string; exp: number; account: string }>();
function makeTicket(file: string, account: string): { t: string; exp: number } {
  const t = randomBytes(18).toString('base64url');
  const exp = Date.now() + TICKET_MS;
  for (const [k, v] of tickets) if (v.exp < Date.now()) tickets.delete(k);
  tickets.set(t, { file, exp, account });
  return { t, exp };
}

// ---- fetching the latest release from GitHub ----

export interface FetchState { running: boolean; startedAt: string | null; finishedAt: string | null; release: string | null; version: string | null; files: string[]; error: string | null }
const state: FetchState = { running: false, startedAt: null, finishedAt: null, release: null, version: null, files: [], error: null };
export const fetchState = () => ({ ...state });

export async function fetchLatest(d: Deps, dir: string): Promise<FetchState> {
  if (state.running) return fetchState();
  Object.assign(state, { running: true, startedAt: now(), finishedAt: null, error: null, files: [] });
  try {
    const repo = String(d.env.ALX_APP_RELEASES_REPO ?? '').trim() || DEFAULT_REPO;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('ALX_APP_RELEASES_REPO must look like owner/name');
    const r = await d.fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'alexandria-server' } });
    if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${repo}'s latest release`);
    const rel: any = await r.json();
    const version = String(rel.tag_name ?? '').replace(/^v/, '') || null;
    const release = String(rel.name ?? '').replace(/^Alexandria\s+/i, '') || null;
    fs.mkdirSync(dir, { recursive: true });
    const meta = readMeta(dir);
    const got: string[] = [];
    for (const a of Array.isArray(rel.assets) ? rel.assets : []) {
      const name = String(a?.name ?? '');
      const url = String(a?.browser_download_url ?? '');
      if (!NAME.test(name) || !platformOf(name) || !/^https:\/\//.test(url)) continue;
      const target = path.join(dir, name);
      if (fs.existsSync(target) && meta[name]?.version === version && fs.statSync(target).size === a.size) { got.push(name); continue; }
      const dl = await d.fetch(url, { headers: { 'User-Agent': 'alexandria-server' }, redirect: 'follow' } as any);
      if (!dl.ok || !dl.body) throw new Error(`Downloading ${name} failed (${dl.status})`);
      const part = target + '.part';
      await pipeline(Readable.fromWeb(dl.body as any), fs.createWriteStream(part));
      fs.renameSync(part, target);
      const st = fs.statSync(target);
      meta[name] = { version, release, sha256: await sha256Of(target), size: st.size, mtimeMs: st.mtimeMs };
      got.push(name);
    }
    if (!got.length) throw new Error(`The latest release of ${repo} (${rel.tag_name ?? '?'}) has no app files`);
    // Older builds of a platform this release brings are replaced.
    const fresh = new Set(got.map((n) => platformOf(n)!.platform));
    for (const e of fs.readdirSync(dir)) {
      const k = platformOf(e);
      if (k && fresh.has(k.platform) && !got.includes(e) && NAME.test(e)) { fs.rmSync(path.join(dir, e), { force: true }); delete meta[e]; }
    }
    writeMeta(dir, meta);
    Object.assign(state, { release, version, files: got });
  } catch (e: any) {
    state.error = String(e?.message ?? e).slice(0, 300);
  } finally {
    Object.assign(state, { running: false, finishedAt: now() });
  }
  return fetchState();
}

function sendFile(dir: string, file: string, res: Response, head: boolean) {
  const full = path.join(dir, file);
  const st = fs.statSync(full);
  const type = file.endsWith('.apk') ? 'application/vnd.android.package-archive' : file.endsWith('.dmg') ? 'application/x-apple-diskimage' : file.endsWith('.tar.gz') ? 'application/gzip' : 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', String(st.size));
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  res.setHeader('Cache-Control', 'no-store');
  if (head) return res.end();
  fs.createReadStream(full).pipe(res);
}

const feature: Feature = {
  id: 'appbuilds',
  appRoutes: (app: Express, d: Deps) => {
    const dir = () => appsDir(d);
    const auth = authenticate(d.db);

    app.get('/api/apps', async (_req, res, next) => {
      try {
        const url = String(d.env.ALX_APP_DOWNLOADS ?? '').trim();
        const builds = await listBuilds(dir());
        res.json({ downloads: /^https?:\/\//.test(url) ? url : DEFAULT_DOWNLOADS, version: VERSION, release: RELEASE, hosted: builds.length > 0 });
      } catch (e) { next(e); }
    });

    app.get('/api/apps/builds', auth, async (_req, res, next) => {
      try {
        const builds = await listBuilds(dir());
        const latest: Partial<Record<Platform, Build>> = {};
        for (const b of builds) if (!latest[b.platform]) latest[b.platform] = b;
        res.json({ builds, latest });
      } catch (e) { next(e); }
    });

    app.post('/api/apps/builds/:file/ticket', auth, async (req, res, next) => {
      try {
        const a = res.locals.auth as Auth;
        if (a.via !== 'session') throw new HttpError(403, 'Download from a signed-in session');
        const file = String(req.params.file);
        const b = (await listBuilds(dir())).find((x) => x.file === file);
        if (!b) throw new HttpError(404, 'No such build on this server');
        const t = makeTicket(file, a.account.id);
        res.status(201).json({ url: `/api/apps/file/${encodeURIComponent(file)}?t=${t.t}`, ticket: t.t, file, sha256: b.sha256, size: b.size, version: b.version, expiresAt: new Date(t.exp).toISOString() });
      } catch (e) { next(e); }
    });

    const serve = (head: boolean) => (req: Request, res: Response) => {
      const file = String(req.params.file);
      const t = tickets.get(String(req.query.t ?? ''));
      if (!t || t.exp < Date.now() || t.file !== file) throw new HttpError(401, 'This download link has expired. Start the download again from This device.');
      const root = dir();
      if (!root || !NAME.test(file) || !platformOf(file) || !fs.existsSync(path.join(root, file))) throw new HttpError(404, 'No such build on this server');
      sendFile(root, file, res, head);
    };
    app.head('/api/apps/file/:file', serve(true));
    app.get('/api/apps/file/:file', serve(false));
  },

  adminMount: 'apps',
  adminRoutes: (d: Deps) => {
    const r = Router();
    r.get('/', async (_req, res, next) => {
      try {
        res.json({ dir: appsDir(d), repo: String(d.env.ALX_APP_RELEASES_REPO ?? '').trim() || DEFAULT_REPO, auto: d.env.ALX_APPS_AUTO_FETCH === '1', builds: await listBuilds(appsDir(d)), fetch: fetchState() });
      } catch (e) { next(e); }
    });
    r.post('/fetch', requireAdmin, (_req, res) => {
      const root = appsDir(d);
      if (!root) throw new HttpError(409, 'This server has no data folder for app builds (set ALX_APPS_DIR)');
      void fetchLatest(d, root);
      res.status(202).json(fetchState());
    });
    // Upload a build: the file itself as the body (streamed to disk, never held in memory).
    // ?version= overrides the version in the name; ?replace=1 removes older builds of the same
    // platform and arch once the new one is in. Someone with a Mac can upload the macOS build.
    r.put('/:file', requireAdmin, async (req, res, next) => {
      const root = appsDir(d);
      const file = String(req.params.file);
      const part = root ? path.join(root, `${file}.part`) : '';
      try {
        if (!root) throw new HttpError(409, 'This server has no data folder for app builds (set ALX_APPS_DIR)');
        // The apps install what is here, so only a person signed in as admin uploads: never a key.
        const via = (res.locals.auth as Auth | undefined)?.via;
        if (via !== 'session' && via !== 'admin_session') throw new HttpError(403, 'Upload builds from a signed-in admin session, not with a key');
        const kind = NAME.test(file) ? platformOf(file) : null;
        if (!kind) throw new HttpError(400, 'Name the file like a release build: Alexandria-<version>-android.apk, -windows-x64-setup.exe, -macos-universal.dmg or -linux-x64.tar.gz');
        const v = String(req.query.version ?? '').trim().replace(/^v/, '');
        if (v && !VERSION_RE.test(v)) throw new HttpError(400, 'The version must look like 1.2.3 or 1.2.3-beta.1');
        const version = v || versionIn(file);
        if (!version) throw new HttpError(400, 'Give the version (in the file name or as ?version=), so the apps can tell it is newer');
        const max = maxUpload(d);
        if (Number(req.headers['content-length'] ?? 0) > max) throw new HttpError(413, `A build can be at most ${Math.round(max / 1048576)} MB`);
        fs.mkdirSync(root, { recursive: true });
        const h = createHash('sha256');
        let size = 0;
        const out = fs.createWriteStream(part);
        await pipeline(req, async function* (src) {
          for await (const chunk of src as AsyncIterable<Buffer>) {
            size += chunk.length;
            if (size > max) throw new HttpError(413, `A build can be at most ${Math.round(max / 1048576)} MB`);
            h.update(chunk);
            yield chunk;
          }
        }, out);
        if (!size) throw new HttpError(400, 'The file was empty');
        const target = path.join(root, file);
        fs.renameSync(part, target);
        const st = fs.statSync(target);
        const meta = readMeta(root);
        meta[file] = { version, release: null, sha256: h.digest('hex'), size: st.size, mtimeMs: st.mtimeMs };
        const removed: string[] = [];
        if (req.query.replace === '1') {
          for (const e of fs.readdirSync(root)) {
            const k = platformOf(e);
            if (e !== file && k && k.platform === kind.platform && k.arch === kind.arch && NAME.test(e) && !e.endsWith('.part')) { fs.rmSync(path.join(root, e), { force: true }); delete meta[e]; removed.push(e); }
          }
        }
        writeMeta(root, meta);
        const auth = res.locals.auth as Auth;
        try { d.db.prepare('INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(null, auth?.account?.id ?? null, 'apps.upload', `${file} ${version}`, now()); } catch { /* the audit is best effort */ }
        res.status(201).json({ build: (await listBuilds(root)).find((b) => b.file === file), removed });
      } catch (e) {
        if (part) fs.rmSync(part, { force: true });
        next(e);
      }
    });
    r.delete('/:file', requireAdmin, (req, res) => {
      const root = appsDir(d);
      const file = String(req.params.file);
      if (!root || !NAME.test(file) || !platformOf(file) || !fs.existsSync(path.join(root, file))) throw new HttpError(404, 'No such build');
      fs.rmSync(path.join(root, file));
      res.json({ ok: true });
    });
    return r;
  },

  // ALX_APPS_AUTO_FETCH=1: the latest release is fetched at start and every 12 hours.
  start: (d: Deps) => {
    if (d.env.ALX_APPS_AUTO_FETCH !== '1') return;
    const root = appsDir(d);
    if (!root) return;
    const run = () => { void fetchLatest(d, root); };
    const first = setTimeout(run, 30_000);
    const every = setInterval(run, 12 * 3600_000);
    first.unref?.(); every.unref?.();
    return () => { clearTimeout(first); clearInterval(every); };
  },
};
export default feature;
