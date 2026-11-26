// Owlbear Rodeo: play a casual online session on an Owlbear Rodeo map, with this world's map pictures and fog of war.
//
// The extension (web/owlbear/) is served by this server at /owlbear/, so the DM adds
// https://<this server>/owlbear/manifest.json in Owlbear Rodeo and nothing else needs hosting. It runs in every
// browser in the Owlbear room, but only the GM's copy holds the link key (alx_obr_..., made on DM → Setup → Owlbear
// Rodeo) and does the work:
//   - it puts the linked map picture into the Owlbear scene as the map (the table screen's picture by default),
//   - Alexandria leads (default): this world's fog for that picture is drawn as one locked fog shape on top, kept
//     in step every couple of seconds;
//   - Owlbear leads: the GM fogs and reveals with Owlbear's own tools, and that fog is sent here, so the table
//     screen, the Map page and the players' marks (which are hidden under fog by routes/map.ts) follow it.
//
// The picture is sent to Owlbear through /api/owlbear/pic/<picture secret>/<picture>, which serves only pictures the
// players may already see (the table screen's rule), with CORS open so Owlbear can draw it. Like any virtual table,
// Owlbear's fog is drawn in each player's browser over the whole picture; Alexandria's own marks are not sent at all.
import { Router, type Express, type Request, type Response } from 'express';
import fs from 'node:fs';
import type { Deps } from '../../app.ts';
import { requireDM } from '../../core/auth.ts';
import { type DB, all, one, run } from '../../core/db.ts';
import { dmOnly } from '../../core/events.ts';
import { HttpError, now, secret, sha256, str } from '../../core/util.ts';
import { imageVisibleTo, mapImagesFor } from '../../intake/records.ts';
import { ctx, me } from '../../routes/_shared.ts';
import { fogOf, saveFog, tableOf } from '../fog/index.ts';
import { libfileOnDisk, mayRead } from '../libfiles/index.ts';
import type { Feature } from '../types.ts';
import { fogRects, readMask, stateFromMask } from './mask.ts';

const KEY_PREFIX = 'alx_obr_';
/** An extension seen within this long is "connected" (it asks every 2 s while the room is open). */
const ONLINE_MS = 20_000;
export const EXTENSION_VERSION = '1.0.0';

type Lead = 'alexandria' | 'owlbear';
interface Link {
  world_id: string; key_hash: string; prefix: string; created_by: string; created_at: string; last_seen_at: string | null;
  pic_secret: string; room: string | null; player: string | null; follow: number; map_id: string | null; pic: string | null;
  lead: Lead; cells: number; pushed_at: string | null;
}

const linkOf = (db: DB, w: string) => one<Link>(db, 'SELECT * FROM owlbear_links WHERE world_id = ?', w);

/** What players may see of the world, as the table screen answers it (whoever asks). */
const PLAYERS = { accountId: '', role: 'player' as const };

interface Picture { value: string; label: string; group: 'source' | 'library'; mime: string }

/** Map pictures the players may see: the ones that may go to Owlbear. */
function pictures(d: Deps, w: string): Picture[] {
  const titles = new Map(all<any>(d.db, 'SELECT id, title FROM pages WHERE world_id = ?', w).map((p) => [p.id, p.title]));
  const imp = mapImagesFor(d.db, w, 'player').map((m) => {
    const mime = one<any>(d.db, 'SELECT mime FROM intake_images WHERE id = ?', m.id)?.mime ?? 'image/png';
    return { value: `imp:${m.id}`, group: 'source' as const, label: `${m.name || 'Map'}${m.page ? ` (${m.page.title})` : ''}`, mime };
  });
  const lib = all<any>(d.db, `SELECT * FROM libfiles_files WHERE world_id = ? AND kind = 'map' AND family = 'image' ORDER BY name`, w)
    .filter((f) => mayRead(d, f, PLAYERS))
    .map((f) => ({ value: `lib:${f.id}`, group: 'library' as const, label: `${f.name}${titles.get(f.page_id) ? ` (${titles.get(f.page_id)})` : ''}`, mime: String(f.mime) }));
  return [...imp, ...lib];
}

/** The picture an Owlbear scene should show now: the table screen's (following it) or the one chosen. */
function target(d: Deps, l: Link) {
  const t = tableOf(d, l.world_id);
  const mapId = (l.follow ? t.mapId : l.map_id) || 'world';
  const pic = l.follow ? t.pic : l.pic;
  const p = pic ? pictures(d, l.world_id).find((x) => x.value === pic) ?? null : null;
  return { mapId, pic: p ? p.value : null, label: p?.label ?? null, mime: p?.mime ?? null, url: p ? `/api/owlbear/pic/${l.pic_secret}/${encodeURIComponent(p.value)}` : null, hidden: !!pic && !p };
}

function status(d: Deps, l: Link) {
  const t = target(d, l);
  const f = t.pic ? fogOf(d, l.world_id, t.mapId, t.pic) : null;
  return {
    link: { follow: !!l.follow, mapId: l.map_id, pic: l.pic, lead: l.lead, cells: l.cells },
    target: t,
    fog: f ? { enabled: f.enabled, version: f.version } : null,
  };
}

const LEADS: Lead[] = ['alexandria', 'owlbear'];

/** Change what the link shows (from the extension or the DM page). */
function setLink(d: Deps, l: Link, b: any) {
  const follow = b.follow === undefined ? !!l.follow : !!b.follow;
  const mapId = b.mapId === undefined ? l.map_id : b.mapId === null ? null : str(b.mapId, 'mapId', { max: 60 }) || null;
  const pic = b.pic === undefined ? l.pic : b.pic === null ? null : str(b.pic, 'pic', { max: 200 }) || null;
  if (pic && b.pic !== undefined && !pictures(d, l.world_id).some((p) => p.value === pic)) throw new HttpError(400, 'Pick a map picture the players may see (share its page with them first)');
  const lead: Lead = b.lead === undefined ? l.lead : LEADS.includes(b.lead) ? b.lead : (() => { throw new HttpError(400, "lead must be 'alexandria' or 'owlbear'"); })();
  const cells = b.cells === undefined ? l.cells : Math.round(Number(b.cells));
  if (!Number.isFinite(cells) || cells < 0 || cells > 400) throw new HttpError(400, 'cells must be 0 (picture size) to 400');
  run(d.db, 'UPDATE owlbear_links SET follow = ?, map_id = ?, pic = ?, lead = ?, cells = ? WHERE world_id = ?', follow ? 1 : 0, mapId, pic, lead, cells, l.world_id);
  d.hub.emit(l.world_id, 'owlbear', {}, dmOnly);
  return linkOf(d.db, l.world_id)!;
}

function linkFromKey(db: DB, req: Request): Link {
  const h = req.get('authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token.startsWith(KEY_PREFIX)) throw new HttpError(401, 'Send the Owlbear Rodeo link key');
  const l = one<Link>(db, 'SELECT * FROM owlbear_links WHERE key_hash = ?', sha256(token));
  if (!l) throw new HttpError(401, 'That Owlbear Rodeo link key is not valid (made a new one?)');
  // The key belongs to a DM; a DM who lost the world loses the link.
  if (!one(db, "SELECT 1 FROM members WHERE world_id = ? AND account_id = ? AND role = 'dm'", l.world_id, l.created_by)) throw new HttpError(403, 'The DM who made this key no longer runs the world');
  const was = l.last_seen_at;
  run(db, 'UPDATE owlbear_links SET last_seen_at = ? WHERE world_id = ?', now(), l.world_id);
  return { ...l, last_seen_at: was };
}

const cleanName = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max) : '') || null;

// Pages the extension is shown in: Owlbear Rodeo embeds them, so they (and only they) may be framed by it.
const OBR_FRAME = 'https://www.owlbear.rodeo https://owlbear.rodeo https://*.owlbear.rodeo';
const EXT_CSP = `default-src 'self'; script-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors ${OBR_FRAME}; base-uri 'self'; form-action 'none'`;

function manifest(req: Request) {
  return {
    name: 'Alexandria',
    version: EXTENSION_VERSION,
    manifest_version: 1,
    author: 'Alexandria',
    description: "Your Alexandria world's map pictures and fog of war on the Owlbear Rodeo table.",
    icon: '/owlbear/icon.svg',
    background_url: '/owlbear/background.html',
    action: { title: 'Alexandria', icon: '/owlbear/icon.svg', popover: '/owlbear/popover.html', width: 360, height: 520 },
    homepage_url: `${req.protocol}://${req.get('host')}/`,
  };
}

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V8l8-4 8 4v11"/><path d="M8 19v-7M12 19v-7M16 19v-7"/><path d="M3 19h18"/></svg>`;

function appRoutes(app: Express, d: Deps) {
  const { db } = d;

  // The extension's own files. Owlbear Rodeo reads the manifest and icon from its own origin (CORS), and frames the pages.
  app.use('/owlbear', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path === '/manifest.json' || req.path === '/icon.svg') res.setHeader('Access-Control-Allow-Origin', '*');
    if (/^\/(popover|background)\.html$/.test(req.path)) {
      res.removeHeader('X-Frame-Options');
      res.setHeader('Content-Security-Policy', EXT_CSP);
      res.setHeader('Cache-Control', 'no-cache');
    }
    next();
  });
  app.get('/owlbear/manifest.json', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.json(manifest(req)); });
  app.get('/owlbear/icon.svg', (_req, res) => { res.setHeader('Content-Type', 'image/svg+xml'); res.setHeader('Cache-Control', 'public, max-age=86400'); res.send(ICON); });

  // The map picture for the Owlbear scene. Only pictures the players may see; Owlbear draws it in every browser of the room.
  app.get('/api/owlbear/pic/:secret/:pic', (req, res) => {
    const l = one<Link>(db, 'SELECT * FROM owlbear_links WHERE pic_secret = ?', String(req.params.secret));
    const pic = String(req.params.pic);
    if (!l) throw new HttpError(404, 'Picture not found');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    if (pic.startsWith('imp:')) {
      const img = one<any>(db, 'SELECT * FROM intake_images WHERE id = ? AND world_id = ?', pic.slice(4), l.world_id);
      if (!img || img.kind !== 'map' || !imageVisibleTo(db, img, 'player')) throw new HttpError(404, 'Picture not found');
      res.setHeader('Content-Type', img.mime);
      res.end(Buffer.from(img.data));
      return;
    }
    if (pic.startsWith('lib:')) {
      const f = one<any>(db, "SELECT * FROM libfiles_files WHERE id = ? AND world_id = ? AND family = 'image'", pic.slice(4), l.world_id);
      const file = f && d.dataDir ? libfileOnDisk(d, l.world_id, f.id) : '';
      if (!f || !mayRead(d, f, PLAYERS) || !file || !fs.existsSync(file)) throw new HttpError(404, 'Picture not found');
      res.setHeader('Content-Type', f.mime);
      res.end(fs.readFileSync(file));
      return;
    }
    throw new HttpError(404, 'Picture not found');
  });

  // ---- the GM's extension, with the link key ----
  const r = Router();
  r.use((req, res, next) => {
    (res as any).locals.obr = linkFromKey(db, req);
    next();
  });
  const L = (res: Response) => (res as any).locals.obr as Link;

  // First call when the extension starts: the world, the pictures it may use, what to show now.
  r.get('/hello', (req, res) => {
    const l = L(res);
    const room = cleanName(req.query.room, 120), player = cleanName(req.query.player, 60);
    if (room !== l.room || player !== l.player) run(db, 'UPDATE owlbear_links SET room = ?, player = ? WHERE world_id = ?', room, player, l.world_id);
    if (!l.last_seen_at || Date.now() - Date.parse(l.last_seen_at) > ONLINE_MS) d.hub.emit(l.world_id, 'owlbear', {}, dmOnly);
    const w = one<any>(db, 'SELECT id, slug, name FROM worlds WHERE id = ?', l.world_id);
    res.json({ world: { id: w.id, slug: w.slug, name: w.name }, version: EXTENSION_VERSION, pictures: pictures(d, l.world_id).map(({ value, label, group }) => ({ value, label, group })), ...status(d, l) });
  });

  // Asked every couple of seconds: cheap, so the fog is only fetched when its version moves.
  r.get('/state', (_req, res) => res.json(status(d, L(res))));

  r.put('/link', (req, res) => res.json(status(d, setLink(d, L(res), req.body ?? {}))));

  // The fog of the shown picture as rectangles of fogged cells (cols × rows, the picture's own shape).
  r.get('/fog', (req, res) => {
    const l = L(res);
    const t = target(d, l);
    if (!t.pic) { res.json({ enabled: false, version: 0, cols: 0, rows: 0, rects: [] }); return; }
    const cols = Math.round(Number(req.query.cols ?? 160)), rows = Math.round(Number(req.query.rows ?? 100));
    if (!(cols >= 8 && cols <= 400 && rows >= 8 && rows <= 400)) throw new HttpError(400, 'cols and rows must be 8 to 400');
    const f = fogOf(d, l.world_id, t.mapId, t.pic);
    res.json({ mapId: t.mapId, pic: t.pic, enabled: f.enabled, version: f.version, cols, rows, rects: fogRects(f, cols, rows) });
  });

  // Owlbear leads: the GM's Owlbear fog, as a FOG_GRID bitmask over the picture (1 = fogged).
  r.put('/fog', (req, res) => {
    const l = L(res);
    if (l.lead !== 'owlbear') throw new HttpError(409, 'Alexandria leads the fog for this link: switch the link to "Owlbear leads" first');
    const t = target(d, l);
    if (!t.pic) throw new HttpError(409, 'No map picture is linked');
    const mask = readMask(req.body?.mask);
    if (!mask) throw new HttpError(400, 'mask must be a base64 96 × 96 bitmask');
    const cur = fogOf(d, l.world_id, t.mapId, t.pic);
    const next = stateFromMask(mask, Date.now());
    const version = saveFog(d, l.world_id, t.mapId, t.pic, next.base !== null ? next : { enabled: true, base: cur.base, ops: [...cur.ops, ...next.ops] });
    run(db, 'UPDATE owlbear_links SET pushed_at = ? WHERE world_id = ?', now(), l.world_id);
    res.json({ ok: true, version });
  });

  app.use('/api/owlbear', r);
}

function worldRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;
  const W = (res: Response) => ctx(res).world.id;
  r.use(requireDM);

  r.get('/', (req, res) => {
    const w = W(res);
    const l = linkOf(db, w);
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({
      manifestUrl: `${base}/owlbear/manifest.json`,
      secure: req.secure || /^localhost(:\d+)?$/.test(req.get('host') ?? ''),
      version: EXTENSION_VERSION,
      key: l ? { prefix: l.prefix, createdAt: l.created_at } : null,
      lastSeen: l?.last_seen_at ?? null,
      online: !!l?.last_seen_at && Date.now() - Date.parse(l.last_seen_at) < ONLINE_MS,
      room: l?.room ?? null,
      player: l?.player ?? null,
      pushedAt: l?.pushed_at ?? null,
      pictures: pictures(d, w).map(({ value, label, group }) => ({ value, label, group })),
      ...(l ? status(d, l) : { link: null, target: null, fog: null }),
    });
  });

  // A new link key (shown once). It replaces the old one, which stops working; the picture addresses change with it.
  r.post('/key', (_req, res) => {
    const w = W(res);
    const key = secret(KEY_PREFIX);
    run(db, `INSERT INTO owlbear_links (world_id, key_hash, prefix, created_by, created_at, pic_secret) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (world_id) DO UPDATE SET key_hash = excluded.key_hash, prefix = excluded.prefix, created_by = excluded.created_by, created_at = excluded.created_at, last_seen_at = NULL, pic_secret = excluded.pic_secret`,
    w, sha256(key), key.slice(0, KEY_PREFIX.length + 4), me(res), now(), secret('').slice(0, 24));
    run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', w, me(res), 'owlbear.key', '', now());
    res.status(201).json({ key });
  });

  r.delete('/key', (_req, res) => {
    run(db, 'DELETE FROM owlbear_links WHERE world_id = ?', W(res));
    res.json({ ok: true });
  });

  r.put('/link', (req, res) => {
    const l = linkOf(db, W(res));
    if (!l) throw new HttpError(409, 'Make a link key first');
    res.json(status(d, setLink(d, l, req.body ?? {})));
  });

  return r;
}

const feature: Feature = {
  id: 'owlbear',
  schema: `
    CREATE TABLE IF NOT EXISTS owlbear_links (
      world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
      key_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      pic_secret TEXT NOT NULL UNIQUE,
      room TEXT,
      player TEXT,
      follow INTEGER NOT NULL DEFAULT 1,
      map_id TEXT,
      pic TEXT,
      lead TEXT NOT NULL DEFAULT 'alexandria',
      cells INTEGER NOT NULL DEFAULT 0,
      pushed_at TEXT
    );
  `,
  worldMount: 'owlbear',
  worldRoutes,
  appRoutes,
  mcpTools: [
    {
      name: 'owlbear_status',
      description: 'Owlbear Rodeo link: is the extension connected, which map picture the Owlbear scene shows, who leads the fog (Alexandria or Owlbear).',
      dmOnly: true,
      props: {},
      call: () => ({ method: 'GET', path: '/owlbear' }),
    },
    {
      name: 'owlbear_link',
      description: 'Change what the Owlbear Rodeo scene shows: follow the table screen, or a chosen map picture (value from owlbear_status pictures); and who leads the fog.',
      write: true,
      props: {
        follow: { type: 'boolean', description: 'Show whatever the table screen shows' },
        pic: { type: 'string', description: 'A picture value from owlbear_status (used when follow is false)' },
        mapId: { type: 'string', description: "The Alexandria map whose fog counts (default 'world')" },
        lead: { type: 'string', enum: ['alexandria', 'owlbear'], description: 'Who draws the fog: alexandria (default) or owlbear' },
      },
      call: (a) => ({ method: 'PUT', path: '/owlbear/link', body: a }),
    },
  ],
};
export default feature;
