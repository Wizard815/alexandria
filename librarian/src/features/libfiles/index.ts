// Files in the library: maps, pictures, PDFs, handouts, item sheets, text, JSON and CSV.
//
// A file belongs to a page (an existing one, or a "file page" made for it) and
// has its own level (party, broker, dm, classified; default dm). A viewer gets
// a file only when they may see the page AND the file's level, checked on every
// request: lists carry per-viewer signed tickets (/api/media/libfile/<ticket>,
// see features/sound/ticket.ts) that are checked again on each fetch. A
// classified file is not in any AI's view. Bytes are on disk under
// <data>/libfiles/<world>/<id> (included in backups).
//
// The same routes are mounted for the library admin at
// /api/admin/library/worlds/:world/{library,files}: an admin who is the world's
// GM gets the GM view, any other admin only the party copy, and cannot upload.
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { logSearch } from '../gatewaystatus/searchlog.ts';
import express from 'express';
import type { Request, Response } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { type Auth, requireDM } from '../../core/auth.ts';
import { audienceOf, type Viewer } from '../../core/policy.ts';
import { type Level, canSeeLevel, isLevel, normLevel } from '../../core/levels.ts';
import { safePagePath } from '../../core/library.ts';
import { HttpError, id as newId, now, oneOf, str } from '../../core/util.ts';
import { ctx, me, readerFor } from '../../routes/_shared.ts';
import { mintTicket, readTicket } from '../sound/ticket.ts';
import { fileGranted } from '../libshare/grants.ts';
import { KINDS, cleanName, sniffFile } from './sniff.ts';
import { sendFile, targetFor } from './remote.ts';
import { moveFile, receiveBody, sendRanged } from './stream.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS libfiles_files (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  level TEXT NOT NULL DEFAULT 'dm',
  mime TEXT NOT NULL,
  family TEXT NOT NULL,
  size INTEGER NOT NULL,
  by_id TEXT,
  at TEXT NOT NULL,
  remote TEXT
);
CREATE INDEX IF NOT EXISTS libfiles_world ON libfiles_files (world_id, page_id);
`;

const DEFAULT_MAX_MB = 50;
export const maxBytes = (d: Deps) => Math.max(1, Number(d.env.ALX_LIBFILE_MAX_MB) || DEFAULT_MAX_MB) * 1024 * 1024;
const DEFAULT_VIDEO_MAX_MB = 2048;
export const videoMaxBytes = (d: Deps) => Math.max(1, Number(d.env.ALX_LIBFILE_VIDEO_MAX_MB) || DEFAULT_VIDEO_MAX_MB) * 1024 * 1024;
const incomingDir = (d: Deps) => path.join(d.dataDir ?? '', 'libfiles', '.incoming');
const folder = (d: Deps, world: string) => path.join(d.dataDir ?? '', 'libfiles', world);
/** Where a library file's bytes are on disk (other features serve them too, e.g. the Owlbear Rodeo map picture). */
export const libfileOnDisk = (d: Deps, world: string, fileId: string) => path.join(folder(d, world), fileId);

interface Row { id: string; world_id: string; page_id: string; name: string; kind: string; level: string; mime: string; family: string; size: number; by_id: string | null; at: string; remote: string | null }

/** Can this viewer open the file's page: its level, or (a player) a share, key or folder rule that lifts it? */
export function pageOpenable(d: Deps, worldId: string, pageId: string, visibility: unknown, viewer: Viewer): boolean {
  const aud = audienceOf(viewer);
  if (canSeeLevel(normLevel(visibility), aud)) return true;
  return aud === 'player' && !!viewer.accountId && d.library.liftedPages(worldId, viewer.accountId, pageId).has(pageId);
}

/**
 * May this viewer have this file? The page and the file's own level both count; a classified file is never for a model.
 * A player may also have a GM-only file the GM shared with them (a share on the file, or a folder rule), even when its page stays hidden.
 */
export function mayRead(d: Deps, f: Pick<Row, 'level' | 'page_id' | 'world_id'> & { id?: string }, viewer: Viewer): boolean {
  const pg = one<any>(d.db, 'SELECT visibility FROM pages WHERE id = ? AND world_id = ?', f.page_id, f.world_id);
  if (!pg) return false;
  const aud = audienceOf(viewer);
  if (pageOpenable(d, f.world_id, f.page_id, pg.visibility, viewer) && canSeeLevel(normLevel(f.level), aud)) return true;
  return aud === 'player' && !!viewer.accountId && !!f.id && fileGranted(d.db, f as any, viewer.accountId);
}

const sees = (viewer: Viewer) => audienceOf(viewer) !== 'player';

function view(d: Deps, f: Row, viewer: Viewer, pageTitle?: string) {
  const pg = sees(viewer) ? null : one<any>(d.db, 'SELECT visibility FROM pages WHERE id = ? AND world_id = ?', f.page_id, f.world_id);
  // A player never learns the page of a file they were given alone.
  const pageShown = !pg || pageOpenable(d, f.world_id, f.page_id, pg.visibility, viewer);
  const out: any = {
    id: f.id, pageId: pageShown ? f.page_id : null, name: f.name, kind: f.kind, mime: f.mime, family: f.family, size: f.size, at: f.at,
    url: `/api/media/libfile/${mintTicket({ w: f.world_id, k: 'libfile', f: f.id, a: viewer.accountId })}`,
  };
  if (pageTitle !== undefined && pageShown) out.pageTitle = pageTitle;
  // The GM (and the broker's view) also see the level and where the file was sent.
  if (sees(viewer)) { out.level = f.level; if (f.remote && viewer.role === 'dm') out.remote = JSON.parse(f.remote); }
  return out;
}

function sendBytes(req: Request, res: Response, f: Row, file: string, download: boolean) {
  res.setHeader('Content-Type', f.mime.startsWith('text/') ? `${f.mime}; charset=utf-8` : f.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
  res.setHeader('Cache-Control', 'private, no-store');
  const safe = f.name.replace(/[^\x20-\x7e]+/g, '_').replace(/"/g, '');
  res.setHeader('Content-Disposition', `${download || f.family === 'csv' ? 'attachment' : 'inline'}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  sendRanged(req, res, file);
}

/** Delete bytes on disk that no row owns (a page was deleted, so its rows went with it). */
export function sweep(d: Deps) {
  if (!d.dataDir) return;
  const root = path.join(d.dataDir, 'libfiles');
  let worlds: string[] = [];
  try { worlds = fs.readdirSync(root); } catch { return; }
  for (const w of worlds) {
    if (w.startsWith('.')) continue; // .incoming: uploads in progress
    const have = new Set(all<{ id: string }>(d.db, 'SELECT id FROM libfiles_files WHERE world_id = ?', w).map((r) => r.id));
    try { for (const n of fs.readdirSync(path.join(root, w))) if (!have.has(n)) fs.rmSync(path.join(root, w, n), { force: true }); } catch { /* gone */ }
  }
}

const log = (d: Deps, world: string, who: string | null, action: string, detail: string) =>
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', world, who, action, detail.slice(0, 500), now());

/** /files for the world (and for the admin's copy of a world). */
function fileRoutes(d: Deps): Router {
  const r = Router({ mergeParams: true });
  const W = (res: Response) => ctx(res).world.id;
  const pageOf = (res: Response, ref: unknown) => {
    const pg = one<any>(d.db, 'SELECT id, path, title, visibility, source_id, external_id FROM pages WHERE world_id = ? AND (id = ? OR path = ?)', W(res), String(ref ?? ''), String(ref ?? ''));
    // A page the viewer may not open is not found.
    if (!pg || !pageOpenable(d, W(res), pg.id, pg.visibility, ctx(res).viewer)) throw new HttpError(404, 'Page not found');
    return pg;
  };
  const fileOf = (res: Response, fid: unknown): Row => {
    const f = one<Row>(d.db, 'SELECT * FROM libfiles_files WHERE id = ? AND world_id = ?', String(fid), W(res));
    if (!f || !mayRead(d, f, ctx(res).viewer)) throw new HttpError(404, 'File not found');
    return f;
  };

  // The files the viewer may see: of one page (?page=), or all of them (the admin browser).
  r.get('/', (req, res) => {
    const c = ctx(res);
    const rows = req.query.page
      ? all<Row>(d.db, 'SELECT * FROM libfiles_files WHERE world_id = ? AND page_id = ? ORDER BY at', c.world.id, pageOf(res, req.query.page).id)
      : all<Row>(d.db, 'SELECT * FROM libfiles_files WHERE world_id = ? ORDER BY at DESC', c.world.id);
    const titles = new Map(all<any>(d.db, 'SELECT id, title FROM pages WHERE world_id = ?', c.world.id).map((p) => [p.id, p.title]));
    res.json({ max: maxBytes(d), videoMax: videoMaxBytes(d), canUpload: c.viewer.role === 'dm' && !c.viewer.audience, files: rows.filter((f) => mayRead(d, f, c.viewer)).map((f) => view(d, f, c.viewer, titles.get(f.page_id))) });
  });

  // Maps for the Map page: pictures of kind "map" the viewer may see.
  // ?view=players answers as a player would be (the table screen is seen by them), whoever is signed in.
  r.get('/maps', (req, res) => {
    const c = ctx(res);
    const v = readerFor(req, res, true);
    const titles = new Map(all<any>(d.db, 'SELECT id, title FROM pages WHERE world_id = ?', c.world.id).map((p) => [p.id, p.title]));
    res.json(all<Row>(d.db, `SELECT * FROM libfiles_files WHERE world_id = ? AND kind = 'map' AND family = 'image' ORDER BY name`, c.world.id)
      .filter((f) => mayRead(d, f, v)).map((f) => view(d, f, v, titles.get(f.page_id))));
  });

  // Where an upload could also be sent (GM). Null hides the option.
  r.get('/targets', requireDM, (req, res) => {
    const c = ctx(res);
    const pg = pageOf(res, req.query.page);
    const level = isLevel(req.query.level) ? req.query.level : 'dm';
    const mime = typeof req.query.mime === 'string' && req.query.mime ? req.query.mime.toLowerCase() : undefined;
    res.json({ target: targetFor(d, c.world.id, pg, level, mime) });
  });

  // The body is read here, not by express.raw: pictures and documents are buffered (up to the normal limit);
  // a video is recognised from its first bytes and streamed to a temp file (up to the larger video limit).
  r.post('/', requireDM, async (req: Request, res: Response) => {
    const c = ctx(res);
    if (c.viewer.audience) throw new HttpError(403, 'Files are uploaded in the app');
    if (!d.dataDir) throw new HttpError(503, 'This server has no data folder for files');
    const name = cleanName(req.query.name);
    const mb = (n: number) => Math.round(n / 1024 / 1024);
    const declared = Number(req.headers['content-length']);
    const received = await receiveBody(req, name, { max: maxBytes(d), videoMax: videoMaxBytes(d), declared: Number.isFinite(declared) ? declared : 0, tmpDir: incomingDir(d) });
    let temp = received.temp;
    try {
    if (received.tooBig) throw new HttpError(413, `That file is over ${mb(received.tooBig)} MB`);
    if (!temp && !received.body.length) throw new HttpError(400, 'Send the file as the request body');
    const body = received.body;
    const sniffed = temp ? received.sniffed! : sniffFile(body, name);
    if ('error' in sniffed) throw new HttpError(415, sniffed.error);
    const size = temp ? received.size : body.length;
    const kind = oneOf(req.query.kind ?? 'other', 'kind', KINDS, 'other');
    if (kind === 'map' && sniffed.family !== 'image') throw new HttpError(400, 'A map must be a picture');
    if (temp && req.query.send) throw new HttpError(400, 'Videos stay on this server and are not sent to a source');
    // Fail closed: no level means GM-only; a level that is not one is refused.
    const level: Level = req.query.level === undefined || req.query.level === '' ? 'dm' : isLevel(req.query.level) ? req.query.level : (() => { throw new HttpError(400, 'level must be party, broker, dm or classified'); })();
    const sendTo = req.query.send ? String(req.query.send) : '';

    let pg: any;
    let created = false;
    if (req.query.page) pg = pageOf(res, req.query.page);
    else {
      const title = str(req.query.title ?? name.replace(/\.[A-Za-z0-9]{1,8}$/, ''), 'title', { max: 200 });
      const dir = String(req.query.folder ?? '').replace(/^\/+|\/+$/g, '');
      const p = safePagePath(`${dir ? dir + '/' : ''}${title.replace(/[\\/]+/g, ' ')}.md`);
      if (one(d.db, 'SELECT 1 FROM pages WHERE world_id = ? AND path = ?', c.world.id, p)) throw new HttpError(409, 'A page with that name already exists in that folder');
      created = true;
      d.library.save(c.world.id, { path: p, title, body: '', frontmatter: { tags: ['file'] }, visibility: level }, me(res));
      pg = one<any>(d.db, 'SELECT id, path, title, visibility, source_id, external_id FROM pages WHERE world_id = ? AND path = ?', c.world.id, p);
    }
    // The page must be one this GM view can open and (for a new send) a source that takes files.
    if (sendTo) {
      const t = targetFor(d, c.world.id, pg, level, sniffed.mime);
      if (!t || t.sourceId !== sendTo) throw new HttpError(400, 'That source cannot take this file (classified files are never sent, and not every source has an upload or takes this type of file)');
    }

    const fid = newId('lf_');
    fs.mkdirSync(folder(d, c.world.id), { recursive: true });
    const dest = path.join(folder(d, c.world.id), fid);
    if (temp) { moveFile(temp, dest); temp = ''; } else fs.writeFileSync(dest, body);
    run(d.db, 'INSERT INTO libfiles_files (id, world_id, page_id, name, kind, level, mime, family, size, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      fid, c.world.id, pg.id, name, kind, level, sniffed.mime, sniffed.family, size, me(res), now());
    log(d, c.world.id, me(res), 'libfile.upload', `${name} ${kind} ${level} ${pg.path}`);
    sweep(d);
    const row = one<Row>(d.db, 'SELECT * FROM libfiles_files WHERE id = ?', fid)!;
    if (sendTo) await send(res, row, pg, body);
    emit(row);
    res.status(201).json({ ...view(d, one<Row>(d.db, 'SELECT * FROM libfiles_files WHERE id = ?', fid)!, c.viewer, pg.title), pageCreated: created, page: { id: pg.id, path: pg.path, title: pg.title } });
    } finally { if (temp) fs.rmSync(temp, { force: true }); }
  });

  /** Send to the page's source and record the result (the local copy stays whatever happens). */
  async function send(res: Response, row: Row, pg: any, bytes: Uint8Array) {
    const c = ctx(res);
    let rec: any;
    try {
      const out = await sendFile(d, c.world.id, pg, { name: row.name, mime: row.mime, level: row.level, bytes });
      rec = { source: out.target.sourceName, app: out.target.app, id: out.remoteId, error: null, at: now() };
      log(d, c.world.id, me(res), 'libfile.send', `${row.name} to ${out.target.app} ${out.target.sourceName}`);
    } catch (err: any) {
      const t = targetFor(d, c.world.id, pg, row.level, row.mime);
      rec = { source: t?.sourceName ?? '', app: t?.app ?? '', id: null, error: String(err?.message ?? err).slice(0, 300), at: now() };
      log(d, c.world.id, me(res), 'libfile.send_failed', `${row.name}: ${rec.error}`);
    }
    run(d.db, 'UPDATE libfiles_files SET remote = ? WHERE id = ?', JSON.stringify(rec), row.id);
  }
  const emit = (row: Row) => d.hub.emit(row.world_id, 'libfile', { pageId: row.page_id }, (v) => mayRead(d, row, v));

  // Try the upload to the source again (GM).
  r.post('/:fid/send', requireDM, async (req, res) => {
    const c = ctx(res);
    const row = fileOf(res, req.params.fid);
    const pg = pageOf(res, row.page_id);
    const t = targetFor(d, c.world.id, pg, row.level, row.mime);
    if (!t || (req.body?.source && t.sourceId !== req.body.source)) throw new HttpError(400, 'This file cannot be sent to a source');
    await send(res, row, pg, fs.readFileSync(path.join(folder(d, c.world.id), row.id)));
    res.json(view(d, one<Row>(d.db, 'SELECT * FROM libfiles_files WHERE id = ?', row.id)!, c.viewer, pg.title));
  });

  r.patch('/:fid', requireDM, (req, res) => {
    const c = ctx(res);
    if (c.viewer.audience) throw new HttpError(403, 'Files are changed in the app');
    const row = fileOf(res, req.params.fid);
    const b = req.body ?? {};
    const level = b.level === undefined ? row.level : isLevel(b.level) ? b.level : (() => { throw new HttpError(400, 'level must be party, broker, dm or classified'); })();
    const kind = b.kind === undefined ? row.kind : oneOf(b.kind, 'kind', KINDS);
    if (kind === 'map' && row.family !== 'image') throw new HttpError(400, 'A map must be a picture');
    const name = b.name === undefined ? row.name : cleanName(b.name, row.name);
    run(d.db, 'UPDATE libfiles_files SET level = ?, kind = ?, name = ? WHERE id = ?', level, kind, name, row.id);
    log(d, c.world.id, me(res), 'libfile.update', `${name} ${kind} ${level}`);
    const next = one<Row>(d.db, 'SELECT * FROM libfiles_files WHERE id = ?', row.id)!;
    emit(next);
    res.json(view(d, next, c.viewer));
  });

  r.delete('/:fid', requireDM, (req, res) => {
    const c = ctx(res);
    const row = fileOf(res, req.params.fid);
    run(d.db, 'DELETE FROM libfiles_files WHERE id = ?', row.id);
    fs.rmSync(path.join(folder(d, c.world.id), row.id), { force: true });
    log(d, c.world.id, me(res), 'libfile.delete', row.name);
    d.hub.emit(c.world.id, 'libfile', { pageId: row.page_id }, () => true);
    res.json({ ok: true });
  });

  // The bytes, for a caller that can send the sign-in header (the app uses tickets in <img>/<a>).
  r.get('/:fid', (req, res) => {
    const f = fileOf(res, req.params.fid);
    sendBytes(req, res, f, path.join(folder(d, W(res)), f.id), req.query.download === '1');
  });
  r.get('/:fid/ticket', (req, res) => res.json({ url: view(d, fileOf(res, req.params.fid), ctx(res).viewer).url }));
  return r;
}

/** The admin's view of a world: GM view when the admin is the world's GM, else the party copy and no writes. */
function adminWorld(d: Deps) {
  return (req: Request, res: Response, next: (e?: any) => void) => {
    const auth = res.locals.auth as Auth;
    const world = one<any>(d.db, 'SELECT id, slug, name, settings FROM worlds WHERE id = ? OR slug = ?', String(req.params.world), String(req.params.world));
    if (!world) throw new HttpError(404, 'World not found');
    const m = one<{ role: string }>(d.db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', world.id, auth.account.id);
    res.locals.w = { world, viewer: { accountId: auth.account.id, role: m?.role === 'dm' ? 'dm' : 'player' } };
    res.locals.adminView = m?.role === 'dm' ? 'dm' : 'party';
    next();
  };
}

function adminRoutes(d: Deps): Router {
  const r = Router();
  // Every world, and what this admin may open of it.
  r.get('/worlds', (_req, res) => {
    const a = (res.locals.auth as Auth).account.id;
    res.json(all<any>(d.db, `SELECT w.id, w.name, w.slug, (SELECT COUNT(*) FROM pages p WHERE p.world_id = w.id) AS pages,
      (SELECT role FROM members m WHERE m.world_id = w.id AND m.account_id = ?) AS role FROM worlds w ORDER BY w.name`, a)
      .map((w) => ({ id: w.id, name: w.name, slug: w.slug, pages: w.pages, role: w.role ?? null, view: w.role === 'dm' ? 'dm' : 'party' })));
  });
  const world = Router({ mergeParams: true });
  world.use(adminWorld(d));
  world.get('/', (_req, res) => res.json({ id: ctx(res).world.id, name: ctx(res).world.name, role: ctx(res).viewer.role === 'dm' ? 'dm' : null, view: res.locals.adminView }));
  // Reading the library: the same answers the world's own routes give this viewer. Nothing here writes.
  world.get('/library/pages', (_req, res) => res.json(d.library.list(ctx(res).world.id, ctx(res).viewer)));
  world.get('/library/pages/:pid', (req, res) => res.json(d.library.get(ctx(res).world.id, String(req.params.pid), ctx(res).viewer)));
  world.get('/library/search', (req, res) => {
    const q = str(req.query.q, 'q', { max: 200 });
    const hits = d.library.search(ctx(res).world.id, q, ctx(res).viewer);
    logSearch(d.db, { worldId: ctx(res).world.id, role: 'admin', origin: 'admin', q, hitIds: hits.map((h) => h.id) });
    res.json(hits);
  });
  world.get('/library/lint', (_req, res) => res.json(ctx(res).viewer.role === 'dm' ? d.library.lint(ctx(res).world.id) : []));
  world.use('/files', fileRoutes(d));
  r.use('/worlds/:world', world);
  return r;
}

const feature: Feature = {
  id: 'libfiles',
  schema: SCHEMA,
  dataDirs: ['libfiles'],
  worldMount: 'files',
  worldRoutes: (d) => fileRoutes(d),
  adminMount: 'library',
  adminRoutes: (d) => adminRoutes(d),
  start: (d) => { sweep(d); if (d.dataDir) fs.rmSync(incomingDir(d), { recursive: true, force: true }); },
  appRoutes: (app, d) => {
    // <img> and <a> cannot send the sign-in header: a signed ticket names one file and one account and is checked again on every fetch.
    // A member gets what their role may see; an admin who is not in the world gets the party copy only.
    app.get('/api/media/libfile/:ticket', (req, res) => {
      const t = readTicket(String(req.params.ticket));
      if (!t || t.k !== 'libfile') throw new HttpError(404, 'File not found');
      const m = one<{ role: string }>(d.db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', t.w, t.a);
      const admin = !m && one(d.db, 'SELECT 1 FROM accounts WHERE id = ? AND is_admin = 1', t.a);
      const f = (m || admin) && one<Row>(d.db, 'SELECT * FROM libfiles_files WHERE id = ? AND world_id = ?', t.f, t.w);
      if (!f || !mayRead(d, f, { accountId: t.a, role: m?.role === 'dm' ? 'dm' : 'player' })) throw new HttpError(404, 'File not found');
      sendBytes(req, res, f, path.join(folder(d, t.w), f.id), req.query.download === '1');
    });
  },
};
export default feature;
