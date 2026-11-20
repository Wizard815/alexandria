// The players' screen: a TV facing the table. It shows only what players may
// see (stage cards shown to everyone, the spotlight, the combat tracker's
// player view) plus a media state the DM controls (YouTube links, pictures,
// slideshows).
//
// GET .../screen/players builds everything for the anonymous PLAYER viewer,
// whoever asks: the screen is opened on the DM's computer with the DM's
// token, and a DM token must not widen what it shows. Nothing is filtered
// out of a DM view; the DM view is never built. Pictures go through
// /api/media/screen/<ticket>, which re-checks on every fetch that the picture
// is on the board or in the visible media (hiding it takes it away).
//
// Media: a queue of items {youtube | image}, a mode (off, queue, slideshow,
// focus), play/pause, loop and a slideshow interval. Writes are DM-only.
// Players and the screen only receive the visible state: hidden items are
// never sent, and only the current item is (no spoilers about what is next).
// Live event `screen` carries just { version }; clients refetch.
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Response } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { all, one, run, tx } from '../../core/db.ts';
import { requireDM } from '../../core/auth.ts';
import { everyone } from '../../core/events.ts';
import { combatViewFor } from '../../core/combatView.ts';
import { HttpError, id as newId, int, now, oneOf, str } from '../../core/util.ts';
import { ctx, me } from '../../routes/_shared.ts';
import { mintTicket, readTicket } from '../sound/ticket.ts';
import { mayRead } from '../libfiles/index.ts';
import { PLAYER, project, worldSettings, type CardRow } from '../stage/cards.ts';

const schema = `
CREATE TABLE IF NOT EXISTS screen_media (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'queue', 'slideshow', 'focus')),
  prev_mode TEXT NOT NULL DEFAULT 'queue',
  current_id TEXT,
  focus_id TEXT,
  interval_sec INTEGER NOT NULL DEFAULT 10,
  playing INTEGER NOT NULL DEFAULT 1,
  loop INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 0,
  advanced_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS screen_media_items (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('youtube', 'image', 'video')),
  ref TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  pos INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS screen_media_items_world ON screen_media_items (world_id, pos);
`;

const MODES = ['off', 'queue', 'slideshow', 'focus'] as const;
type Mode = (typeof MODES)[number];
const MAX_ITEMS = 300;
const DEFAULT_INTERVAL = 10;

interface State { world_id: string; mode: Mode; prev_mode: Mode; current_id: string | null; focus_id: string | null; interval_sec: number; playing: number; loop: number; version: number; advanced_at: number }
interface Item { id: string; world_id: string; kind: 'youtube' | 'image' | 'video'; ref: string; title: string; hidden: number; pos: number; created_at: string }

/** The 11-character video id of a YouTube link (watch, youtu.be, embed, shorts, live) or a bare id; null for anything else. Only the id is stored, so nothing else of the link ever reaches an <iframe>. */
export function youtubeId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u: URL;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const seg = u.pathname.split('/').filter(Boolean);
  let v: string | undefined;
  if (host === 'youtu.be') v = seg[0];
  else if (host === 'youtube.com') v = seg[0] === 'watch' ? u.searchParams.get('v') ?? undefined : ['embed', 'shorts', 'live', 'v'].includes(seg[0]) ? seg[1] : undefined;
  else if (host === 'youtube-nocookie.com') v = seg[0] === 'embed' ? seg[1] : undefined;
  return v && /^[\w-]{11}$/.test(v) ? v : null;
}
export const embedUrl = (vid: string) => `https://www.youtube-nocookie.com/embed/${vid}?autoplay=1`;

const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
const cleanDir = (raw: unknown) => String(raw ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

const stateOf = (d: Deps, wid: string): State =>
  one<State>(d.db, 'SELECT * FROM screen_media WHERE world_id = ?', wid)
  ?? { world_id: wid, mode: 'off', prev_mode: 'queue', current_id: null, focus_id: null, interval_sec: DEFAULT_INTERVAL, playing: 1, loop: 1, version: 0, advanced_at: 0 };
const itemsOf = (d: Deps, wid: string) => all<Item>(d.db, 'SELECT * FROM screen_media_items WHERE world_id = ? ORDER BY pos, created_at, id', wid);

/** What is on screen now: the focused item, else the current one of the mode's pool (slideshows cycle pictures only). Hidden items are never in a pool. */
export function resolve(s: Pick<State, 'mode' | 'current_id' | 'focus_id'>, items: Item[]): Item | null {
  const visible = items.filter((i) => !i.hidden);
  if (s.mode === 'off') return null;
  if (s.mode === 'focus') return visible.find((i) => i.id === s.focus_id) ?? null;
  const pool = s.mode === 'slideshow' ? visible.filter((i) => i.kind === 'image') : visible;
  return pool.find((i) => i.id === s.current_id) ?? pool[0] ?? null;
}

const mayFetchScreenPicture = (d: Deps, worldId: string, ref: string): boolean => {
  const s = stateOf(d, worldId);
  if (s.mode !== 'off' && itemsOf(d, worldId).some((i) => i.ref === ref && i.kind === 'image' && !i.hidden)) return true;
  // A picture on a card shown to everyone is already on the screen's board.
  return !!one(d.db, `SELECT 1 FROM stage_cards WHERE world_id = ? AND ref = ? AND kind IN ('image', 'event') AND visibility = 'all' AND shown_at IS NOT NULL`, worldId, ref);
};

function sendBytes(res: Response, mime: string, body: Buffer | fs.ReadStream) {
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'private, no-store');
  if (Buffer.isBuffer(body)) res.end(body);
  else body.on('error', () => res.destroy()).pipe(res);
}

const libFolder = (d: Deps, world: string) => path.join(d.dataDir ?? '', 'libfiles', world);

/** Move the slideshow on when its interval has run out. Called every second by the timer (and directly by tests). */
export function tick(d: Deps, nowMs = Date.now()): number {
  let moved = 0;
  for (const s of all<State>(d.db, `SELECT * FROM screen_media WHERE mode = 'slideshow' AND playing = 1`)) {
    if (nowMs - s.advanced_at < s.interval_sec * 1000) continue;
    step(d, s.world_id, 1, nowMs);
    moved++;
  }
  return moved;
}

/** Next (+1) or previous (-1) in the mode's pool. At the end it wraps when looping, else stays (a slideshow then pauses). */
function step(d: Deps, wid: string, dir: 1 | -1, nowMs = Date.now()) {
  const s = stateOf(d, wid);
  const items = itemsOf(d, wid).filter((i) => !i.hidden);
  const pool = s.mode === 'slideshow' ? items.filter((i) => i.kind === 'image') : items;
  let playing = s.playing;
  let cur = s.current_id;
  if (pool.length) {
    const at = pool.findIndex((i) => i.id === s.current_id);
    let to = at < 0 ? (dir === 1 ? 0 : pool.length - 1) : at + dir;
    if (to >= pool.length || to < 0) {
      if (s.loop) to = (to + pool.length) % pool.length;
      else { to = Math.max(0, Math.min(pool.length - 1, to)); if (s.mode === 'slideshow') playing = 0; }
    }
    cur = pool[to].id;
  }
  run(d.db, 'UPDATE screen_media SET current_id = ?, playing = ?, advanced_at = ?, version = version + 1 WHERE world_id = ?', cur, playing, nowMs, wid);
  d.hub.emit(wid, 'screen', { version: s.version + 1 }, everyone);
}

const feature: Feature = {
  id: 'playerscreen',
  schema,
  worldMount: 'screen',
  start: (d) => {
    const t = setInterval(() => { try { tick(d); } catch (e) { console.error('players screen tick', e); } }, 1000);
    t.unref?.();
    return () => clearInterval(t);
  },
  appRoutes: (app, d) => {
    // <img> cannot send the sign-in header: the ticket names one picture and one member, and the
    // picture must still be on the screen (board or visible media) when it is fetched.
    app.get('/api/media/screen/:ticket', (req, res) => {
      const t = readTicket(String(req.params.ticket));
      const m = t && t.k === 'screen' && one(d.db, 'SELECT 1 FROM members WHERE world_id = ? AND account_id = ?', t.w, t.a);
      if (!t || !m || !mayFetchScreenPicture(d, t.w, t.f)) throw new HttpError(404, 'Picture not found');
      if (t.f.startsWith('stg_')) {
        const u = one<any>(d.db, 'SELECT mime, data FROM stage_images WHERE id = ? AND world_id = ?', t.f, t.w);
        if (!u) throw new HttpError(404, 'Picture not found');
        return sendBytes(res, u.mime, Buffer.from(u.data));
      }
      // A library file is served only while players themselves could open it.
      const f = one<any>(d.db, 'SELECT * FROM libfiles_files WHERE id = ? AND world_id = ?', t.f, t.w);
      if (!f || f.family !== 'image' || !mayRead(d, f, PLAYER)) throw new HttpError(404, 'Picture not found');
      sendBytes(res, f.mime, fs.createReadStream(path.join(libFolder(d, t.w), f.id)));
    });
  },
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    const { db } = d;
    const W = (res: Response) => ctx(res).world.id;
    const audit = (wid: string, by: string, action: string, detail: string) =>
      run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', wid, by, action, detail.slice(0, 500), now());

    /** Write a change to the state row (created on first use) and tell every client to refetch. */
    function save(wid: string, patch: Partial<Pick<State, 'mode' | 'prev_mode' | 'current_id' | 'focus_id' | 'interval_sec' | 'playing' | 'loop'>>, restart = false) {
      const s = { ...stateOf(d, wid), ...patch };
      run(db, `INSERT INTO screen_media (world_id, mode, prev_mode, current_id, focus_id, interval_sec, playing, loop, version, advanced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (world_id) DO UPDATE SET mode = excluded.mode, prev_mode = excluded.prev_mode, current_id = excluded.current_id, focus_id = excluded.focus_id,
        interval_sec = excluded.interval_sec, playing = excluded.playing, loop = excluded.loop, version = excluded.version, advanced_at = excluded.advanced_at`,
        wid, s.mode, s.prev_mode, s.current_id, s.focus_id, s.interval_sec, s.playing, s.loop, s.version + 1, restart ? Date.now() : s.advanced_at);
      d.hub.emit(wid, 'screen', { version: s.version + 1 }, everyone);
    }

    const itemUrl = (wid: string, i: Item, account: string) =>
      i.kind === 'image' ? `/api/media/screen/${mintTicket({ w: wid, k: 'screen', f: i.ref, a: account })}` : null;

    /** The board as the table sees it. Always the PLAYER view; `account` only names who the picture tickets are for. */
    function board(wid: string, account: string) {
      const s = worldSettings(db, wid);
      const st = one<any>(db, 'SELECT layout, spotlight_id FROM stage_state WHERE world_id = ?', wid) ?? { layout: 'grid', spotlight_id: null };
      const rows = all<CardRow>(db, 'SELECT * FROM stage_cards WHERE world_id = ? ORDER BY z, created_at', wid)
        // Only cards shown to everyone: a card for chosen players is not for the table.
        .filter((c) => c.visibility === 'all' && c.shown_at && c.kind !== 'combat' && c.kind !== 'drawing');
      const cards = rows.map((c) => {
        const out = project(d, c, PLAYER, s);
        if (!out) return null;
        // The PLAYER view has no account to sign a picture ticket for; the screen has its own.
        if (c.ref?.startsWith('stg_') && (c.kind === 'image' || c.kind === 'event')) out.data.url = `/api/media/screen/${mintTicket({ w: wid, k: 'screen', f: c.ref, a: account })}`;
        return out;
      }).filter(Boolean) as any[];
      const combat = combatViewFor(db, wid, PLAYER, s);
      return {
        layout: st.layout, spotlightId: cards.some((c) => c.id === st.spotlight_id) ? st.spotlight_id : null, cards,
        combat: (combat as any).active ? combat : null,
        monsterHealth: s.monsterHealth,
      };
    }

    function publicMedia(wid: string, account: string) {
      const s = stateOf(d, wid);
      const items = itemsOf(d, wid);
      const cur = resolve(s, items);
      return {
        mode: s.mode, playing: !!s.playing, loop: !!s.loop, intervalSec: s.interval_sec, version: s.version, advancedAt: s.advanced_at,
        current: cur ? { id: cur.id, kind: cur.kind, embed: cur.kind === 'youtube' ? embedUrl(cur.ref) : null, url: itemUrl(wid, cur, account) } : null,
      };
    }

    /** The DM's whole picture, hidden items included. Thumbnails use the DM's own tickets for the ordinary file routes. */
    function dmMedia(wid: string, account: string) {
      const s = stateOf(d, wid);
      const items = itemsOf(d, wid);
      const cur = resolve(s, items);
      return {
        mode: s.mode, prevMode: s.prev_mode, playing: !!s.playing, loop: !!s.loop, intervalSec: s.interval_sec, version: s.version, currentId: cur?.id ?? null, focusId: s.mode === 'focus' ? s.focus_id : null,
        items: items.map((i) => ({
          id: i.id, kind: i.kind, ref: i.ref, title: i.title, hidden: !!i.hidden,
          thumb: i.kind === 'image' ? `/api/media/${i.ref.startsWith('stg_') ? 'stage' : 'libfile'}/${mintTicket({ w: wid, k: i.ref.startsWith('stg_') ? 'stage' : 'libfile', f: i.ref, a: account })}` : i.kind === 'youtube' ? `https://img.youtube.com/vi/${i.ref}/mqdefault.jpg` : null,
        })),
      };
    }

    // ---- what the table sees (any member; always the player view) ----
    r.get('/players', (_req, res) => {
      const c = ctx(res);
      const acc = c.viewer.accountId;
      res.json({ world: { name: c.world.name }, stage: board(c.world.id, acc), media: publicMedia(c.world.id, acc) });
    });

    // ---- the DM's controls ----
    r.get('/media', requireDM, (_req, res) => res.json(dmMedia(W(res), me(res))));

    /** Where the DM can pick pictures from: folders of library pictures (with how many players may see) and the world's stage pictures. */
    r.get('/media/sources', requireDM, (_req, res) => {
      const w = W(res);
      const files = all<any>(db, `SELECT f.*, p.path AS page_path FROM libfiles_files f JOIN pages p ON p.id = f.page_id WHERE f.world_id = ? AND f.family = 'image' ORDER BY p.path, f.name LIMIT 1000`, w);
      const folders = new Map<string, { folder: string; images: number; shared: number }>();
      const list = files.map((f) => {
        const dir = dirOf(f.page_path);
        const shared = mayRead(d, f, PLAYER);
        const e = folders.get(dir) ?? { folder: dir, images: 0, shared: 0 };
        e.images++; if (shared) e.shared++;
        folders.set(dir, e);
        return { id: f.id, name: f.name, folder: dir, shared, thumb: `/api/media/libfile/${mintTicket({ w, k: 'libfile', f: f.id, a: me(res) })}` };
      });
      const stage = all<any>(db, `SELECT i.id, (SELECT COALESCE(NULLIF(c.caption, ''), NULLIF(c.label, '')) FROM stage_cards c WHERE c.ref = i.id AND c.world_id = i.world_id LIMIT 1) AS label FROM stage_images i WHERE i.world_id = ? ORDER BY i.at DESC LIMIT 200`, w)
        .map((i) => ({ id: i.id, label: i.label ?? '', thumb: `/api/media/stage/${mintTicket({ w, k: 'stage', f: i.id, a: me(res) })}` }));
      res.json({ folders: [...folders.values()].sort((a, b) => a.folder.localeCompare(b.folder)), files: list, stage });
    });

    /** A picture players may be shown: a stage picture of this world, or a library picture players could open themselves (fail closed on the file's and its page's level). */
    const imageRef = (w: string, raw: unknown): string => {
      const v = str(raw, 'ref', { max: 200 });
      if (/^stg_[\w-]+$/.test(v)) {
        if (!one(db, 'SELECT 1 FROM stage_images WHERE id = ? AND world_id = ?', v, w)) throw new HttpError(400, 'That picture was not uploaded to this world');
        return v;
      }
      if (/^lf_[\w-]+$/.test(v)) {
        const f = one<any>(db, 'SELECT * FROM libfiles_files WHERE id = ? AND world_id = ?', v, w);
        if (!f) throw new HttpError(400, 'File not found');
        if (f.family !== 'image') throw new HttpError(400, 'Only pictures can go on the screen');
        if (!mayRead(d, f, PLAYER)) throw new HttpError(409, 'Players cannot open that file. Share it with the party first (set the file and its page to party).');
        return v;
      }
      throw new HttpError(400, 'ref must be a stage picture id or a library file id');
    };
    const nextPos = (w: string) => one<any>(db, 'SELECT COALESCE(MAX(pos), 0) + 1 AS p FROM screen_media_items WHERE world_id = ?', w)!.p as number;
    const item = (w: string, iid: unknown) => {
      const i = one<Item>(db, 'SELECT * FROM screen_media_items WHERE id = ? AND world_id = ?', String(iid), w);
      if (!i) throw new HttpError(404, 'Item not found');
      return i;
    };

    r.post('/media/items', requireDM, (req, res) => {
      const w = W(res);
      const b = req.body ?? {};
      const kind = oneOf(b.kind, 'kind', ['youtube', 'image', 'video'] as const);
      if (one<any>(db, 'SELECT COUNT(*) AS n FROM screen_media_items WHERE world_id = ?', w)!.n >= MAX_ITEMS) throw new HttpError(409, 'The screen queue is full; remove some items first');
      let ref: string;
      let title = str(b.title, 'title', { max: 160, optional: true }).trim();
      if (kind === 'youtube') {
        const vid = youtubeId(b.url ?? b.ref);
        if (!vid) throw new HttpError(400, 'That is not a YouTube link (use a youtube.com or youtu.be address)');
        ref = vid;
        if (!title) title = `YouTube ${vid}`;
      } else if (kind === 'image') {
        ref = imageRef(w, b.ref);
      } else throw new HttpError(400, 'Video files are not supported yet: the library does not take them');
      const iid = newId('scm_');
      tx(db, () => {
        run(db, 'INSERT INTO screen_media_items (id, world_id, kind, ref, title, hidden, pos, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)', iid, w, kind, ref, title, nextPos(w), now());
        // "Play now": show it straight away in the queue.
        if (b.play === true) save(w, { mode: 'queue', current_id: iid, focus_id: null, playing: 1 }, true);
        else save(w, {});
      });
      audit(w, me(res), 'screen.queue', `${kind} ${ref}`);
      res.status(201).json(dmMedia(w, me(res)));
    });

    r.patch('/media/items/:iid', requireDM, (req, res) => {
      const w = W(res);
      const i = item(w, req.params.iid);
      const b = req.body ?? {};
      const hidden = b.hidden === undefined ? i.hidden : b.hidden ? 1 : 0;
      const title = b.title === undefined ? i.title : str(b.title, 'title', { max: 160, optional: true }).trim();
      run(db, 'UPDATE screen_media_items SET hidden = ?, title = ? WHERE id = ?', hidden, title, i.id);
      save(w, {});
      res.json(dmMedia(w, me(res)));
    });

    r.delete('/media/items/:iid', requireDM, (req, res) => {
      const w = W(res);
      const i = item(w, req.params.iid);
      const s = stateOf(d, w);
      tx(db, () => {
        run(db, 'DELETE FROM screen_media_items WHERE id = ?', i.id);
        save(w, {
          current_id: s.current_id === i.id ? null : s.current_id,
          // Removing the focused item ends the focus.
          ...(s.mode === 'focus' && s.focus_id === i.id ? { mode: s.prev_mode, focus_id: null } : {}),
        });
      });
      res.json(dmMedia(w, me(res)));
    });

    // New order: the listed ids first, in that order; items not listed keep their place after them.
    r.put('/media/order', requireDM, (req, res) => {
      const w = W(res);
      const ids = req.body?.ids;
      if (!Array.isArray(ids) || ids.length > MAX_ITEMS || ids.some((x) => typeof x !== 'string')) throw new HttpError(400, 'ids must be a list of item ids');
      const have = new Set(itemsOf(d, w).map((i) => i.id));
      const order = [...new Set(ids as string[])].filter((x) => have.has(x));
      const rest = itemsOf(d, w).map((i) => i.id).filter((x) => !order.includes(x));
      tx(db, () => { [...order, ...rest].forEach((x, n) => run(db, 'UPDATE screen_media_items SET pos = ? WHERE id = ?', n + 1, x)); save(w, {}); });
      res.json(dmMedia(w, me(res)));
    });

    // Load every picture of a library folder as a slideshow. Pictures players may not open are skipped (and counted), never shown.
    r.post('/media/folder', requireDM, (req, res) => {
      const w = W(res);
      const b = req.body ?? {};
      const dir = cleanDir(b.folder);
      const files = all<any>(db, `SELECT f.*, p.path AS page_path FROM libfiles_files f JOIN pages p ON p.id = f.page_id WHERE f.world_id = ? AND f.family = 'image' ORDER BY p.path, f.name`, w)
        .filter((f) => !dir || dirOf(f.page_path) === dir || f.page_path.startsWith(`${dir}/`));
      const okFiles = files.filter((f) => mayRead(d, f, PLAYER));
      if (!okFiles.length) throw new HttpError(files.length ? 409 : 404, files.length ? `None of the ${files.length} pictures in that folder are shared with the party` : 'No pictures in that folder');
      const interval = int(b.intervalSec, 'intervalSec', { min: 2, max: 3600, optional: true });
      const replace = b.replace !== false;
      let first = '';
      tx(db, () => {
        if (replace) run(db, 'DELETE FROM screen_media_items WHERE world_id = ?', w);
        let pos = nextPos(w);
        for (const f of okFiles.slice(0, MAX_ITEMS)) {
          const iid = newId('scm_');
          first ||= iid;
          run(db, 'INSERT INTO screen_media_items (id, world_id, kind, ref, title, hidden, pos, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)', iid, w, 'image', f.id, f.name.replace(/\.[A-Za-z0-9]{1,8}$/, ''), pos++, now());
        }
        save(w, { mode: 'slideshow', current_id: first, focus_id: null, playing: 1, ...(interval ? { interval_sec: interval } : {}) }, true);
      });
      audit(w, me(res), 'screen.folder', `${dir || '/'} ${okFiles.length} pictures`);
      res.json({ ...dmMedia(w, me(res)), loaded: Math.min(okFiles.length, MAX_ITEMS), skipped: files.length - okFiles.length });
    });

    // Mode, which item is current, play/pause, loop and interval.
    r.put('/media', requireDM, (req, res) => {
      const w = W(res);
      const b = req.body ?? {};
      const s = stateOf(d, w);
      const patch: Parameters<typeof save>[1] = {};
      let restart = false;
      if (b.mode !== undefined) {
        const mode = oneOf(b.mode, 'mode', ['off', 'queue', 'slideshow'] as const);
        patch.mode = mode;
        patch.focus_id = null;
        if (mode !== 'off') { patch.prev_mode = mode; restart = true; if (mode !== s.mode) patch.playing = 1; }
      }
      if (b.currentId !== undefined) {
        const i = item(w, b.currentId);
        if (i.hidden) throw new HttpError(409, 'That item is hidden; unhide it first');
        patch.current_id = i.id;
        restart = true;
      }
      if (b.playing !== undefined) { patch.playing = b.playing ? 1 : 0; restart = restart || !!b.playing; }
      if (b.loop !== undefined) patch.loop = b.loop ? 1 : 0;
      if (b.intervalSec !== undefined) patch.interval_sec = int(b.intervalSec, 'intervalSec', { min: 2, max: 3600 })!;
      save(w, patch, restart);
      res.json(dmMedia(w, me(res)));
    });

    // Show one item alone until unfocused (id: null).
    r.post('/media/focus', requireDM, (req, res) => {
      const w = W(res);
      const s = stateOf(d, w);
      const fid = req.body?.id;
      if (fid === null || fid === undefined || fid === '') {
        if (s.mode === 'focus') save(w, { mode: s.prev_mode, focus_id: null }, true);
      } else {
        const i = item(w, fid);
        if (i.hidden) throw new HttpError(409, 'That item is hidden; unhide it first');
        save(w, { mode: 'focus', prev_mode: s.mode === 'focus' ? s.prev_mode : s.mode === 'off' ? 'queue' : s.mode, focus_id: i.id });
      }
      res.json(dmMedia(w, me(res)));
    });

    for (const [name, dir] of [['next', 1], ['previous', -1]] as const) {
      r.post(`/media/${name}`, requireDM, (_req, res) => {
        const w = W(res);
        const s = stateOf(d, w);
        if (s.mode === 'off') throw new HttpError(409, 'The screen media is off');
        if (s.mode === 'focus') throw new HttpError(409, 'One item is focused; unfocus it first');
        step(d, w, dir);
        res.json(dmMedia(w, me(res)));
      });
    }

    r.post('/media/clear', requireDM, (_req, res) => {
      const w = W(res);
      tx(db, () => { run(db, 'DELETE FROM screen_media_items WHERE world_id = ?', w); save(w, { mode: 'off', current_id: null, focus_id: null }); });
      audit(w, me(res), 'screen.clear', '');
      res.json(dmMedia(w, me(res)));
    });

    return r;
  },
  mcpTools: [
    {
      name: 'queue_media',
      description: "DM: add something to the players' screen (the TV facing the table). Give a YouTube link as url, or a picture as ref (a library file id players may open, or a stage picture id). Set play true to show it right now. Players only ever see what is queued here.",
      write: true,
      props: {
        url: { type: 'string', description: 'A youtube.com or youtu.be link' },
        ref: { type: 'string', description: 'A library picture file id or a stage picture id' },
        title: { type: 'string' },
        play: { type: 'boolean', description: 'Show it now' },
      },
      call: (a) => ({ method: 'POST', path: '/screen/media/items', body: { kind: a.url ? 'youtube' : 'image', url: a.url, ref: a.ref, title: a.title, play: a.play === true } }),
    },
    {
      name: 'show_media',
      description: "DM: control the players' screen media. action: off, queue, slideshow, next, previous, pause, resume, clear (empties the queue), or unfocus. To show one queued item alone, give itemId with action focus.",
      write: true,
      props: {
        action: { type: 'string', enum: ['off', 'queue', 'slideshow', 'next', 'previous', 'pause', 'resume', 'clear', 'focus', 'unfocus'] },
        itemId: { type: 'string', description: 'For focus: the queued item id' },
      },
      required: ['action'],
      call: (a) => {
        switch (a.action) {
          case 'off': case 'queue': case 'slideshow': return { method: 'PUT', path: '/screen/media', body: { mode: a.action } };
          case 'pause': return { method: 'PUT', path: '/screen/media', body: { playing: false } };
          case 'resume': return { method: 'PUT', path: '/screen/media', body: { playing: true } };
          case 'next': case 'previous': case 'clear': return { method: 'POST', path: `/screen/media/${a.action}`, body: {} };
          case 'focus': return { method: 'POST', path: '/screen/media/focus', body: { id: a.itemId ?? 'missing' } };
          default: return { method: 'POST', path: '/screen/media/focus', body: { id: null } };
        }
      },
    },
  ],
};
export default feature;
