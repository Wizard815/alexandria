// Sound (PLAN §5): the music, ambience and effects libraries on the gateway,
// the DM's sound board, players' own on/off switches, and Spotify.
//
// Live event `sound`: { channel: 'music'|'ambience'|'sfx'|'voice', action:
// 'play'|'stop'|'set', url, volume, loop, fadeMs, target: 'table'|'players'|
// 'both', at, ... }. The DM's page plays what is aimed at the table; a
// player's device plays what is aimed at players on channels it switched on.
import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { one, all, run } from '../../core/db.ts';
import { requireDM } from '../../core/auth.ts';
import { HttpError, id as newId, now, oneOf, str } from '../../core/util.ts';
import { ctx, isDM, me, names } from '../../routes/_shared.ts';
import { dmOnly } from '../../core/events.ts';
import { MIME, sniff, serveFile } from './files.ts';
import { scan, withOverrides, nearest, type Index, type Track } from './library.ts';
import { sendSound, TARGETS, toPlayers, type Target } from './send.ts';
import * as spotify from './spotify.ts';
import { mintTicket, readTicket } from './ticket.ts';

const schema = `
CREATE TABLE IF NOT EXISTS sound_moods (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
  PRIMARY KEY (world_id, track_id)
);
CREATE TABLE IF NOT EXISTS sound_scenes (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL, area TEXT NOT NULL DEFAULT '', layers TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sound_pads (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  label TEXT NOT NULL, file TEXT NOT NULL, bank TEXT NOT NULL DEFAULT 'general',
  volume REAL NOT NULL DEFAULT 0.8, loop INTEGER NOT NULL DEFAULT 0, key TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT 'table', created_at TEXT NOT NULL
);
-- What is playing now, for a device that joins late.
CREATE TABLE IF NOT EXISTS sound_state (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  music TEXT, ambience TEXT, updated_at TEXT
);
-- Files players may fetch: what is playing, or was sent to devices.
CREATE TABLE IF NOT EXISTS sound_allowed (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, file_id TEXT NOT NULL, expires_at TEXT,
  PRIMARY KEY (world_id, kind, file_id)
);
CREATE TABLE IF NOT EXISTS sound_listeners (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL, device TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  music INTEGER NOT NULL DEFAULT 0, ambience INTEGER NOT NULL DEFAULT 0, sfx INTEGER NOT NULL DEFAULT 0,
  vol_music REAL NOT NULL DEFAULT 0.8, vol_ambience REAL NOT NULL DEFAULT 0.6, vol_sfx REAL NOT NULL DEFAULT 0.8,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (world_id, account_id, device)
);
CREATE TABLE IF NOT EXISTS sound_spotify (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  client_id TEXT, refresh_token TEXT, access_token TEXT, expires_at INTEGER,
  events TEXT NOT NULL DEFAULT '{}', pending TEXT
);
`;

const KINDS = ['music', 'ambience', 'sfx'] as const;
type Kind = (typeof KINDS)[number];
const SFX_EXPIRY_MS = 15 * 60_000;
const UPLOAD_LIMIT: Record<string, number> = { sfx: 10 * 1024 * 1024, ambience: 25 * 1024 * 1024 };

const vol = (v: unknown, field: string, dflt: number) => {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new HttpError(400, `${field} must be from 0 to 1`);
  return Math.round(n * 100) / 100;
};
const fade = (v: unknown, dflt: number) => {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 30_000) throw new HttpError(400, 'fadeMs must be from 0 to 30000');
  return Math.round(n);
};
const target = (v: unknown, dflt: Target): Target => oneOf(v, 'target', TARGETS, dflt);
const spot = (v: unknown, f: string) => {
  const n = Number(v);
  if (v === null || v === '' || v === undefined || !Number.isFinite(n) || n < 0 || n > 1) throw new HttpError(400, `${f} must be from 0 to 1`);
  return n;
};
const cleanName = (v: unknown, f: string) => {
  const s = str(v, f, { max: 60 }).trim().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s+/g, ' ').trim();
  if (!s || s.startsWith('.')) throw new HttpError(400, `${f} needs letters or numbers`);
  return s;
};

// One index per app, rescanned on demand or after a minute.
const indexes = new WeakMap<Deps, Index>();
function indexOf(d: Deps, force = false): Index {
  let i = indexes.get(d);
  if (force || !i || Date.now() - i.scannedAt > 60_000) { i = scan(d.dataDir); indexes.set(d, i); }
  return i;
}

/** May this person fetch this file now? A DM: any file. A player: only what is playing for them or was sent to devices. */
function fileFor(d: Deps, worldId: string, dm: boolean, kind: string, fid: string) {
  const f = indexOf(d).files.get(fid);
  if (!f || f.kind !== kind) return null;
  if (!dm && !one(d.db, 'SELECT 1 FROM sound_allowed WHERE world_id = ? AND kind = ? AND file_id = ? AND (expires_at IS NULL OR expires_at > ?)', worldId, kind, fid, now())) return null;
  return f;
}

const feature: Feature = {
  id: 'sound',
  schema,
  worldMount: 'sound',
  dataDirs: ['music', 'ambience', 'sfx'],
  // Audio tags play from /api/media/sound/<ticket> (see ticket.ts).
  appRoutes: (app, d) => {
    app.get('/api/media/sound/:ticket', (req, res) => {
      const t = readTicket(String(req.params.ticket));
      const m = t && one<{ role: string }>(d.db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', t.w, t.a);
      const f = t && m && fileFor(d, t.w, m.role === 'dm', t.k, t.f);
      if (!f) throw new HttpError(404, 'File not found');
      serveFile(req, res, f.abs, f.mime);
    });
  },
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    const { db } = d;
    const idx = (force = false): Index => indexOf(d, force);
    const wid = (res: express.Response) => ctx(res).world.id;
    const url = (res: express.Response, kind: Kind, fid: string) => `/api/worlds/${wid(res)}/sound/file/${kind}/${fid}`;
    const overrides = (worldId: string) => new Map(all<any>(db, 'SELECT track_id, x, y FROM sound_moods WHERE world_id = ?', worldId).map((m) => [m.track_id, { x: m.x, y: m.y }]));
    const tracks = (worldId: string): Track[] => withOverrides(idx().music, overrides(worldId));
    const getState = (worldId: string) => {
      const s = one<any>(db, 'SELECT * FROM sound_state WHERE world_id = ?', worldId);
      return { music: s?.music ? JSON.parse(s.music) : null, ambience: s?.ambience ? JSON.parse(s.ambience) : null };
    };
    const setState = (worldId: string, patch: { music?: unknown; ambience?: unknown }) => {
      run(db, 'INSERT OR IGNORE INTO sound_state (world_id) VALUES (?)', worldId);
      if ('music' in patch) run(db, 'UPDATE sound_state SET music = ?, updated_at = ? WHERE world_id = ?', patch.music ? JSON.stringify(patch.music) : null, now(), worldId);
      if ('ambience' in patch) run(db, 'UPDATE sound_state SET ambience = ?, updated_at = ? WHERE world_id = ?', patch.ambience ? JSON.stringify(patch.ambience) : null, now(), worldId);
    };
    const allow = (worldId: string, kind: Kind, fid: string, ttlMs: number | null) =>
      run(db, 'INSERT OR REPLACE INTO sound_allowed (world_id, kind, file_id, expires_at) VALUES (?, ?, ?, ?)', worldId, kind, fid, ttlMs === null ? null : new Date(Date.now() + ttlMs).toISOString());
    const clearAllowed = (worldId: string, kind: Kind) => run(db, 'DELETE FROM sound_allowed WHERE world_id = ? AND kind = ?', worldId, kind);

    // ---- the library -------------------------------------------------------
    r.get('/library', requireDM, (_req, res) => {
      const i = idx();
      const m = tracks(wid(res));
      const areas = [...new Set(m.map((t) => t.area).filter(Boolean))].sort();
      const layers = [...new Set(i.ambience.map((a) => a.layer))].sort();
      const banks = [...new Set(i.sfx.map((s) => s.bank))].sort();
      res.json({
        music: m, areas, ambience: i.ambience, layers, sfx: i.sfx, banks,
        configured: !!d.dataDir, scannedAt: new Date(i.scannedAt).toISOString(),
      });
    });
    r.post('/rescan', requireDM, (_req, res) => {
      const i = idx(true);
      res.json({ music: i.music.length, ambience: i.ambience.length, sfx: i.sfx.length });
    });
    r.put('/tracks/:id/mood', requireDM, (req, res) => {
      const t = idx().music.find((x) => x.id === String(req.params.id));
      if (!t) throw new HttpError(404, 'Track not found');
      if (req.body?.clear) run(db, 'DELETE FROM sound_moods WHERE world_id = ? AND track_id = ?', wid(res), t.id);
      else run(db, 'INSERT OR REPLACE INTO sound_moods (world_id, track_id, x, y) VALUES (?, ?, ?, ?)', wid(res), t.id, spot(req.body?.x, 'x'), spot(req.body?.y, 'y'));
      res.json(tracks(wid(res)).find((x) => x.id === t.id));
    });

    // Upload a sound effect or an ambience loop (DM). The body is the raw file.
    r.post('/upload', requireDM, express.raw({ type: () => true, limit: '26mb' }), (req, res) => {
      if (!d.dataDir) throw new HttpError(503, 'The gateway has no data folder for sounds');
      const kind = oneOf(req.query.kind, 'kind', ['sfx', 'ambience'] as const);
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Send the audio file as the request body');
      if (body.length > UPLOAD_LIMIT[kind]) throw new HttpError(413, `That file is over ${UPLOAD_LIMIT[kind] / 1024 / 1024} MB`);
      const type = sniff(body);
      if (!type) throw new HttpError(415, 'Only mp3, ogg, wav, flac or m4a audio can be uploaded');
      const folder = cleanName(req.query.bank ?? req.query.layer ?? (kind === 'sfx' ? 'general' : 'misc'), kind === 'sfx' ? 'bank' : 'layer');
      const base = cleanName(String(req.query.name ?? 'sound').replace(/\.[A-Za-z0-9]{1,5}$/, ''), 'name');
      const dir = path.join(d.dataDir, kind, kind === 'ambience' ? folder.toLowerCase() : folder);
      fs.mkdirSync(dir, { recursive: true });
      let file = `${base}.${type}`;
      for (let n = 2; fs.existsSync(path.join(dir, file)); n++) file = `${base} ${n}.${type}`;
      fs.writeFileSync(path.join(dir, file), body);
      const i = idx(true);
      const rel = `${kind === 'ambience' ? folder.toLowerCase() : folder}/${file}`;
      const hit = (kind === 'sfx' ? i.sfx : i.ambience).find((f) => f.path === rel);
      res.status(201).json(hit ?? { path: rel });
    });

    // Stream a file (Range supported). A player gets only what is playing
    // for them now, or was sent to devices.
    r.get('/file/:kind/:id', (req, res) => {
      const kind = oneOf(req.params.kind, 'kind', KINDS);
      const f = fileFor(d, wid(res), isDM(res), kind, String(req.params.id));
      if (!f) throw new HttpError(404, 'File not found');
      serveFile(req, res, f.abs, f.mime || MIME.mp3);
    });
    // A ticket for an <audio> tag to play the same file (same checks).
    r.get('/file/:kind/:id/ticket', (req, res) => {
      const kind = oneOf(req.params.kind, 'kind', KINDS);
      if (!fileFor(d, wid(res), isDM(res), kind, String(req.params.id))) throw new HttpError(404, 'File not found');
      res.json({ url: `/api/media/sound/${mintTicket({ w: wid(res), k: kind, f: String(req.params.id), a: me(res) })}` });
    });

    // What is playing now. Players see only what is aimed at them.
    r.get('/now', (_req, res) => {
      const s = getState(wid(res));
      if (isDM(res)) return res.json(s);
      res.json({
        music: s.music && toPlayers(s.music.target) ? s.music : null,
        ambience: s.ambience && toPlayers(s.ambience.target) ? s.ambience : null,
      });
    });

    // ---- music -------------------------------------------------------------
    const playTrack = (res: express.Response, t: Track, o: { volume: number; fadeMs: number; target: Target; reason?: string }) => {
      const ev = {
        channel: 'music' as const, action: 'play' as const, url: url(res, 'music', t.id), volume: o.volume, loop: true, fadeMs: o.fadeMs, target: o.target,
        id: t.id, title: t.title,
      };
      const w = wid(res);
      clearAllowed(w, 'music');
      if (toPlayers(o.target)) allow(w, 'music', t.id, null);
      setState(w, { music: { ...ev, at: now() } });
      return sendSound(d, w, ev);
    };

    r.post('/music/play', requireDM, (req, res) => {
      const t = idx().music.find((x) => x.id === String(req.body?.trackId));
      if (!t) throw new HttpError(404, 'Track not found');
      const ev = playTrack(res, tracks(wid(res)).find((x) => x.id === t.id)!, { volume: vol(req.body?.volume, 'volume', 0.7), fadeMs: fade(req.body?.fadeMs, 1500), target: target(req.body?.target, 'table') });
      res.json({ track: t, event: ev });
    });
    r.post('/music/mood', requireDM, (req, res) => {
      const x = spot(req.body?.x, 'x'), y = spot(req.body?.y, 'y');
      const area = req.body?.area ? str(req.body.area, 'area', { max: 120 }) : undefined;
      const pick = nearest(tracks(wid(res)), x, y, area);
      if (!pick) return res.json({ track: null, changed: false, fadeMs: 0, note: 'No track with a mood spot in that area' });
      const cur = getState(wid(res)).music;
      const fadeMs = fade(req.body?.fadeMs, 4000);
      // Same track as now: leave it playing, no new event.
      if (cur?.id === pick.id) return res.json({ track: pick, changed: false, fadeMs: 0 });
      const ev = playTrack(res, pick, { volume: vol(req.body?.volume, 'volume', cur?.volume ?? 0.7), fadeMs, target: target(req.body?.target, cur?.target ?? 'table') });
      res.json({ track: pick, changed: true, fadeMs, event: ev });
    });
    r.post('/music/stop', requireDM, (req, res) => {
      const w = wid(res);
      const cur = getState(w).music;
      clearAllowed(w, 'music');
      setState(w, { music: null });
      const ev = sendSound(d, w, { channel: 'music', action: 'stop', url: null, volume: 0, loop: false, fadeMs: fade(req.body?.fadeMs, 1500), target: cur?.target ?? 'both' });
      res.json({ ok: true, event: ev });
    });

    // ---- ambience ----------------------------------------------------------
    const layersOf = (v: unknown) => {
      if (!Array.isArray(v) || v.length > 12) throw new HttpError(400, 'layers must be a list of up to 12 {kind, volume}');
      return v.map((l: any, i: number) => ({ kind: str(l?.kind, `layers[${i}].kind`, { max: 40 }).toLowerCase(), volume: vol(l?.volume, `layers[${i}].volume`, 0.5), file: l?.file ? String(l.file) : undefined }));
    };
    const applyScene = (res: express.Response, layers: ReturnType<typeof layersOf>, o: { fadeMs: number; target: Target }) => {
      const w = wid(res);
      const i = idx();
      const prev: any[] = getState(w).ambience?.layers ?? [];
      const next: any[] = [];
      const missing: string[] = [];
      for (const l of layers) {
        const f = (l.file && i.ambience.find((a) => a.id === l.file && a.layer === l.kind)) || i.ambience.find((a) => a.layer === l.kind);
        if (!f) { missing.push(l.kind); continue; }
        next.push({ kind: l.kind, id: f.id, volume: l.volume, url: url(res, 'ambience', f.id) });
      }
      clearAllowed(w, 'ambience');
      if (toPlayers(o.target)) for (const l of next) allow(w, 'ambience', l.id, null);
      setState(w, { ambience: next.length ? { layers: next, target: o.target, at: now() } : null });
      const events = [];
      for (const p of prev) if (!next.some((n) => n.kind === p.kind)) events.push(sendSound(d, w, { channel: 'ambience', action: 'stop', url: p.url, volume: 0, loop: true, fadeMs: o.fadeMs, target: o.target, layer: p.kind }));
      for (const l of next) {
        const was = prev.find((p) => p.kind === l.kind && p.id === l.id);
        events.push(sendSound(d, w, { channel: 'ambience', action: was ? 'set' : 'play', url: l.url, volume: l.volume, loop: true, fadeMs: o.fadeMs, target: o.target, layer: l.kind, id: l.id }));
      }
      return { layers: next.map((l) => ({ kind: l.kind, volume: l.volume })), missing, events };
    };
    r.post('/ambience/scene', requireDM, (req, res) => {
      res.json(applyScene(res, layersOf(req.body?.layers ?? []), { fadeMs: fade(req.body?.fadeMs, 3000), target: target(req.body?.target, 'table') }));
    });
    r.post('/ambience/stop', requireDM, (req, res) => {
      res.json(applyScene(res, [], { fadeMs: fade(req.body?.fadeMs, 3000), target: target(req.body?.target, getState(wid(res)).ambience?.target ?? 'both') }));
    });

    const sceneOut = (s: any) => ({ id: s.id, name: s.name, area: s.area, layers: JSON.parse(s.layers) });
    r.get('/scenes', requireDM, (_req, res) => res.json(all<any>(db, 'SELECT * FROM sound_scenes WHERE world_id = ? ORDER BY name', wid(res)).map(sceneOut)));
    r.post('/scenes', requireDM, (req, res) => {
      const s = { id: newId('sc_'), name: str(req.body?.name, 'name', { max: 80 }).trim(), area: str(req.body?.area, 'area', { max: 120, optional: true }), layers: layersOf(req.body?.layers ?? []) };
      run(db, 'INSERT INTO sound_scenes (id, world_id, name, area, layers, created_at) VALUES (?, ?, ?, ?, ?, ?)', s.id, wid(res), s.name, s.area, JSON.stringify(s.layers), now());
      res.status(201).json(s);
    });
    r.put('/scenes/:id', requireDM, (req, res) => {
      const cur = one<any>(db, 'SELECT * FROM sound_scenes WHERE id = ? AND world_id = ?', String(req.params.id), wid(res));
      if (!cur) throw new HttpError(404, 'Scene not found');
      const name = req.body?.name !== undefined ? str(req.body.name, 'name', { max: 80 }).trim() : cur.name;
      const area = req.body?.area !== undefined ? str(req.body.area, 'area', { max: 120, optional: true }) : cur.area;
      const layers = req.body?.layers !== undefined ? layersOf(req.body.layers) : JSON.parse(cur.layers);
      run(db, 'UPDATE sound_scenes SET name = ?, area = ?, layers = ? WHERE id = ?', name, area, JSON.stringify(layers), cur.id);
      res.json({ id: cur.id, name, area, layers });
    });
    r.delete('/scenes/:id', requireDM, (req, res) => {
      if (!run(db, 'DELETE FROM sound_scenes WHERE id = ? AND world_id = ?', String(req.params.id), wid(res))) throw new HttpError(404, 'Scene not found');
      res.json({ ok: true });
    });
    r.post('/scenes/:id/play', requireDM, (req, res) => {
      const s = one<any>(db, 'SELECT * FROM sound_scenes WHERE id = ? AND world_id = ?', String(req.params.id), wid(res));
      if (!s) throw new HttpError(404, 'Scene not found');
      res.json({ scene: sceneOut(s), ...applyScene(res, JSON.parse(s.layers), { fadeMs: fade(req.body?.fadeMs, 3000), target: target(req.body?.target, 'table') }) });
    });

    // ---- sound effects and pads ---------------------------------------------
    r.post('/sfx/play', requireDM, (req, res) => {
      const w = wid(res);
      const pad = req.body?.padId ? one<any>(db, 'SELECT * FROM sound_pads WHERE id = ? AND world_id = ?', String(req.body.padId), w) : null;
      if (req.body?.padId && !pad) throw new HttpError(404, 'Pad not found');
      const fid = String(pad?.file ?? req.body?.id ?? '');
      const f = idx().sfx.find((s) => s.id === fid);
      if (!f) throw new HttpError(404, 'Sound effect not found');
      const tg = target(req.body?.target, (pad?.target as Target) ?? 'table');
      if (toPlayers(tg)) allow(w, 'sfx', f.id, SFX_EXPIRY_MS);
      const ev = sendSound(d, w, {
        channel: 'sfx', action: 'play', url: url(res, 'sfx', f.id), id: f.id, name: f.name,
        volume: vol(req.body?.volume, 'volume', pad?.volume ?? 0.8), loop: req.body?.loop !== undefined ? !!req.body.loop : !!pad?.loop, fadeMs: 0, target: tg,
      });
      res.json({ ok: true, event: ev });
    });
    r.post('/sfx/stop', requireDM, (req, res) => {
      const f = idx().sfx.find((s) => s.id === String(req.body?.id ?? ''));
      if (!f) throw new HttpError(404, 'Sound effect not found');
      res.json({ ok: true, event: sendSound(d, wid(res), { channel: 'sfx', action: 'stop', url: url(res, 'sfx', f.id), id: f.id, volume: 0, loop: false, fadeMs: fade(req.body?.fadeMs, 300), target: target(req.body?.target, 'both') }) });
    });

    const padOut = (p: any) => ({ id: p.id, label: p.label, file: p.file, bank: p.bank, volume: p.volume, loop: !!p.loop, key: p.key, target: p.target });
    const padFields = (b: any, cur?: any) => {
      const file = b?.file !== undefined ? String(b.file) : cur?.file;
      const f = idx().sfx.find((s) => s.id === file);
      if (!f) throw new HttpError(400, 'file must be the id of a sound effect in the library');
      const key = b?.key !== undefined ? str(b.key, 'key', { max: 1, optional: true }) : cur?.key ?? '';
      return {
        label: b?.label !== undefined ? str(b.label, 'label', { max: 60 }).trim() : cur?.label ?? f.name,
        file: f.id, bank: b?.bank !== undefined ? str(b.bank, 'bank', { max: 60, optional: true }) || f.bank : cur?.bank ?? f.bank,
        volume: vol(b?.volume, 'volume', cur?.volume ?? 0.8), loop: b?.loop !== undefined ? (b.loop ? 1 : 0) : cur?.loop ?? 0,
        key, target: target(b?.target, (cur?.target as Target) ?? 'table'),
      };
    };
    r.get('/pads', requireDM, (_req, res) => res.json(all<any>(db, 'SELECT * FROM sound_pads WHERE world_id = ? ORDER BY bank, label', wid(res)).map(padOut)));
    r.post('/pads', requireDM, (req, res) => {
      const p = padFields(req.body ?? {});
      const pid = newId('pd_');
      run(db, 'INSERT INTO sound_pads (id, world_id, label, file, bank, volume, loop, key, target, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', pid, wid(res), p.label, p.file, p.bank, p.volume, p.loop, p.key, p.target, now());
      res.status(201).json(padOut({ id: pid, ...p }));
    });
    r.put('/pads/:id', requireDM, (req, res) => {
      const cur = one<any>(db, 'SELECT * FROM sound_pads WHERE id = ? AND world_id = ?', String(req.params.id), wid(res));
      if (!cur) throw new HttpError(404, 'Pad not found');
      const p = padFields(req.body ?? {}, cur);
      run(db, 'UPDATE sound_pads SET label = ?, file = ?, bank = ?, volume = ?, loop = ?, key = ?, target = ? WHERE id = ?', p.label, p.file, p.bank, p.volume, p.loop, p.key, p.target, cur.id);
      res.json(padOut({ id: cur.id, ...p }));
    });
    r.delete('/pads/:id', requireDM, (req, res) => {
      if (!run(db, 'DELETE FROM sound_pads WHERE id = ? AND world_id = ?', String(req.params.id), wid(res))) throw new HttpError(404, 'Pad not found');
      res.json({ ok: true });
    });

    // ---- players' switches --------------------------------------------------
    const switchOut = (l: any) => ({ device: l.device, label: l.label, music: !!l.music, ambience: !!l.ambience, sfx: !!l.sfx, volumes: { music: l.vol_music, ambience: l.vol_ambience, sfx: l.vol_sfx } });
    const device = (v: unknown) => {
      const s = str(v, 'device', { max: 80 });
      if (!/^[A-Za-z0-9_-]{6,80}$/.test(s)) throw new HttpError(400, 'device must be 6 to 80 letters, numbers, - or _');
      return s;
    };
    r.get('/me/switches', (req, res) => {
      const dev = device(req.query.device);
      const l = one<any>(db, 'SELECT * FROM sound_listeners WHERE world_id = ? AND account_id = ? AND device = ?', wid(res), me(res), dev);
      res.json(l ? switchOut(l) : { device: dev, label: '', music: false, ambience: false, sfx: false, volumes: { music: 0.8, ambience: 0.6, sfx: 0.8 } });
    });
    r.put('/me/switches', (req, res) => {
      const w = wid(res);
      const b = req.body ?? {};
      const dev = device(b.device);
      const cur = one<any>(db, 'SELECT * FROM sound_listeners WHERE world_id = ? AND account_id = ? AND device = ?', w, me(res), dev);
      const flag = (k: string) => (b[k] !== undefined ? (b[k] ? 1 : 0) : cur?.[k] ?? 0);
      const v = b.volumes ?? {};
      const next = {
        label: b.label !== undefined ? str(b.label, 'label', { max: 40, optional: true }) : cur?.label ?? '',
        music: flag('music'), ambience: flag('ambience'), sfx: flag('sfx'),
        vm: vol(v.music, 'volumes.music', cur?.vol_music ?? 0.8), va: vol(v.ambience, 'volumes.ambience', cur?.vol_ambience ?? 0.6), vs: vol(v.sfx, 'volumes.sfx', cur?.vol_sfx ?? 0.8),
      };
      run(db, `INSERT OR REPLACE INTO sound_listeners (world_id, account_id, device, label, music, ambience, sfx, vol_music, vol_ambience, vol_sfx, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        w, me(res), dev, next.label, next.music, next.ambience, next.sfx, next.vm, next.va, next.vs, now());
      d.hub.emit(w, 'sound-listeners', { at: now() }, dmOnly);
      res.json(switchOut(one<any>(db, 'SELECT * FROM sound_listeners WHERE world_id = ? AND account_id = ? AND device = ?', w, me(res), dev)));
    });
    // Who hears what (DM). Devices not seen for 12 hours are marked stale.
    r.get('/listeners', requireDM, (_req, res) => {
      const w = wid(res);
      const who = names(db, w);
      const cut = new Date(Date.now() - 12 * 3600_000).toISOString();
      const rows = all<any>(db, 'SELECT * FROM sound_listeners WHERE world_id = ? ORDER BY account_id, device', w);
      res.json(rows.map((l) => ({ account: l.account_id, name: who[l.account_id] ?? 'Someone', ...switchOut(l), seenAt: l.seen_at, stale: l.seen_at < cut })));
    });

    // ---- Spotify (DM) --------------------------------------------------------
    r.get('/spotify', requireDM, (_req, res) => res.json(spotify.spotifyStatus(d, wid(res))));
    r.put('/spotify', requireDM, (req, res) => {
      spotify.setClientId(d, wid(res), str(req.body?.clientId, 'clientId', { max: 64 }).trim());
      res.json(spotify.spotifyStatus(d, wid(res)));
    });
    r.post('/spotify/login', requireDM, (req, res) => res.json({ url: spotify.loginUrl(d, wid(res), str(req.body?.redirectUri, 'redirectUri', { max: 500 })) }));
    // The web page Spotify sends the DM back to posts the code here.
    r.post('/spotify/callback', requireDM, async (req, res) => {
      await spotify.finishLogin(d, wid(res), str(req.body?.code, 'code', { max: 2000 }), str(req.body?.state, 'state', { max: 200 }));
      res.json(spotify.spotifyStatus(d, wid(res)));
    });
    r.put('/spotify/events', requireDM, (req, res) => {
      spotify.setEvents(d, wid(res), req.body?.events);
      res.json(spotify.spotifyStatus(d, wid(res)));
    });
    r.post('/spotify/play', requireDM, async (req, res) => res.json(await spotify.playEvent(d, wid(res), str(req.body?.event, 'event', { max: 40 }))));
    r.delete('/spotify', requireDM, (_req, res) => { spotify.disconnect(d, wid(res)); res.json(spotify.spotifyStatus(d, wid(res))); });

    return r;
  },
};
export default feature;
