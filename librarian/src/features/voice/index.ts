// Read aloud (PLAN §7): voice presets, and speaking selected text with the
// "voice" model job. The audio is stored under the data folder and played
// through the same `sound` live event as the sound board (channel 'voice').
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { one, all, run } from '../../core/db.ts';
import { requireDM } from '../../core/auth.ts';
import { ModelUnavailable, speak } from '../../core/ai.ts';
import { HttpError, id as newId, now, oneOf, str } from '../../core/util.ts';
import { ctx, isDM, me } from '../../routes/_shared.ts';
import { MIME, sniff, serveFile } from '../sound/files.ts';
import { sendSound, TARGETS, toPlayers, type Target } from '../sound/send.ts';
import { mintTicket, readTicket } from '../sound/ticket.ts';

const schema = `
CREATE TABLE IF NOT EXISTS voice_presets (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL, voice TEXT NOT NULL DEFAULT '', speed REAL NOT NULL DEFAULT 1, pitch REAL NOT NULL DEFAULT 1,
  effect TEXT NOT NULL DEFAULT 'none', target TEXT NOT NULL DEFAULT 'table', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS voice_files (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (world_id, name)
);
`;

const EFFECTS = ['none', 'echo', 'radio'] as const;
const PLAYER_WINDOW_MS = 60 * 60_000;

const norm = (s: string) => s.toLowerCase().replace(/[*_`>#\[\]()|~-]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Is any of this text DM-only? True when a chunk of it appears in a page's
 * DM copy but not in the copy players see (a page players cannot see has no
 * player copy at all). Text that came from somewhere else (the agent's
 * replies, the transcript) cannot be checked here.
 */
export function containsDmOnly(d: Deps, worldId: string, text: string): boolean {
  const chunks = [norm(text), ...text.split(/[.!?\n]+/).map(norm)].filter((c) => c.length >= 8);
  if (!chunks.length) return false;
  for (const p of all<any>(d.db, 'SELECT body, visibility, player_body FROM pages WHERE world_id = ?', worldId)) {
    const dm = norm(p.body ?? '');
    const pub = p.visibility === 'party' && p.player_body !== null ? norm(p.player_body) : '';
    for (const c of chunks) if (dm.includes(c) && !pub.includes(c)) return true;
  }
  return false;
}

const presetOut = (p: any) => ({ id: p.id, name: p.name, voice: p.voice, speed: p.speed, pitch: p.pitch, effect: p.effect, target: p.target });
const num = (v: unknown, f: string, min: number, max: number, dflt: number) => {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${f} must be from ${min} to ${max}`);
  return n;
};

const NAME = /^v_[A-Za-z0-9_-]+\.(mp3|ogg|wav|flac|m4a)$/;
/** The spoken line, if this person may hear it: the DM always; a player only if it went to players within the last hour. */
function lineFor(d: Deps, worldId: string, dm: boolean, name: string) {
  if (!NAME.test(name) || !d.dataDir) return null;
  const row = one<any>(d.db, 'SELECT * FROM voice_files WHERE world_id = ? AND name = ?', worldId, name);
  if (!row) return null;
  if (!dm && (!toPlayers(row.target) || Date.parse(row.created_at) < Date.now() - PLAYER_WINDOW_MS)) return null;
  return { abs: path.join(d.dataDir, 'voice', name), mime: MIME[name.split('.').pop()!] };
}

const feature: Feature = {
  id: 'voice',
  schema,
  worldMount: 'voice',
  dataDirs: ['voice'],
  appRoutes: (app, d) => {
    app.get('/api/media/voice/:ticket', (req, res) => {
      const t = readTicket(String(req.params.ticket));
      const m = t && t.k === 'voice' && one<{ role: string }>(d.db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', t.w, t.a);
      const f = t && m && lineFor(d, t.w, m.role === 'dm', t.f);
      if (!f) throw new HttpError(404, 'File not found');
      serveFile(req, res, f.abs, f.mime);
    });
  },
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    const { db } = d;
    const wid = (res: any) => ctx(res).world.id;

    // Voice names the voice model offers (Argos lists Kokoro's voices); empty when unknown.
    r.get('/voices', requireDM, async (_req, res) => {
      let names: string[] = [];
      try { names = await (await import('../models/index.ts')).listVoiceNames(d); } catch { /* no models feature or no list */ }
      res.json({ voices: names });
    });
    r.get('/presets', requireDM, (_req, res) => res.json(all<any>(db, 'SELECT * FROM voice_presets WHERE world_id = ? ORDER BY name', wid(res)).map(presetOut)));
    const fields = (b: any, cur?: any) => ({
      name: b?.name !== undefined ? str(b.name, 'name', { max: 60 }).trim() : cur?.name ?? str(undefined, 'name'),
      voice: b?.voice !== undefined ? str(b.voice, 'voice', { max: 80, optional: true }).trim() : cur?.voice ?? '',
      speed: num(b?.speed, 'speed', 0.5, 2, cur?.speed ?? 1),
      pitch: num(b?.pitch, 'pitch', 0.5, 2, cur?.pitch ?? 1),
      effect: oneOf(b?.effect, 'effect', EFFECTS, cur?.effect ?? 'none'),
      target: oneOf(b?.target, 'target', TARGETS, cur?.target ?? 'table'),
    });
    r.post('/presets', requireDM, (req, res) => {
      const p = fields(req.body ?? {});
      const pid = newId('vp_');
      run(db, 'INSERT INTO voice_presets (id, world_id, name, voice, speed, pitch, effect, target, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', pid, wid(res), p.name, p.voice, p.speed, p.pitch, p.effect, p.target, now());
      res.status(201).json(presetOut({ id: pid, ...p }));
    });
    r.put('/presets/:id', requireDM, (req, res) => {
      const cur = one<any>(db, 'SELECT * FROM voice_presets WHERE id = ? AND world_id = ?', String(req.params.id), wid(res));
      if (!cur) throw new HttpError(404, 'Preset not found');
      const p = fields(req.body ?? {}, cur);
      run(db, 'UPDATE voice_presets SET name = ?, voice = ?, speed = ?, pitch = ?, effect = ?, target = ? WHERE id = ?', p.name, p.voice, p.speed, p.pitch, p.effect, p.target, cur.id);
      res.json(presetOut({ id: cur.id, ...p }));
    });
    r.delete('/presets/:id', requireDM, (req, res) => {
      if (!run(db, 'DELETE FROM voice_presets WHERE id = ? AND world_id = ?', String(req.params.id), wid(res))) throw new HttpError(404, 'Preset not found');
      res.json({ ok: true });
    });

    r.post('/speak', requireDM, async (req, res) => {
      if (!d.dataDir) throw new HttpError(503, 'The gateway has no data folder for voice audio');
      const w = wid(res);
      const text = str(req.body?.text, 'text', { max: 2000 }).trim();
      if (!text) throw new HttpError(400, 'text is required');
      const p = one<any>(db, 'SELECT * FROM voice_presets WHERE id = ? AND world_id = ?', String(req.body?.presetId ?? ''), w);
      if (!p) throw new HttpError(404, 'Preset not found');
      const tg = oneOf(req.body?.target, 'target', TARGETS, p.target as Target);
      if (toPlayers(tg) && containsDmOnly(d, w, text) && req.body?.confirm !== true) {
        return void res.status(409).json({ error: 'This text comes from DM-only notes. Sending it to players would reveal it. Confirm to send anyway.', needsConfirm: true });
      }
      let out: { audio: Uint8Array; mime: string };
      try {
        out = await speak(d, text, { voice: p.voice || undefined, speed: p.speed, format: 'wav' });
      } catch (e) {
        if (e instanceof ModelUnavailable) throw new HttpError(503, `Read aloud is not available: ${e.message}`);
        throw e;
      }
      const type = sniff(out.audio);
      if (!type) throw new HttpError(502, 'The voice model sent audio that cannot be played');
      const dir = path.join(d.dataDir, 'voice');
      fs.mkdirSync(dir, { recursive: true });
      // Tidy up spoken lines from more than a day ago.
      for (const f of all<any>(db, 'SELECT world_id, name FROM voice_files WHERE created_at < ?', new Date(Date.now() - 86_400_000).toISOString())) {
        try { fs.rmSync(path.join(dir, f.name), { force: true }); } catch { /* ignore */ }
        run(db, 'DELETE FROM voice_files WHERE world_id = ? AND name = ?', f.world_id, f.name);
      }
      const name = `${newId('v_')}.${type}`;
      fs.writeFileSync(path.join(dir, name), out.audio);
      run(db, 'INSERT INTO voice_files (world_id, name, target, created_at) VALUES (?, ?, ?, ?)', w, name, tg, now());
      const ev = sendSound(d, w, {
        channel: 'voice', action: 'play', url: `/api/worlds/${w}/voice/file/${name}`, volume: 1, loop: false, fadeMs: 0, target: tg,
        effect: p.effect, pitch: p.pitch, label: p.name,
      });
      res.json({ ok: true, file: name, event: ev });
    });

    // The spoken line. A player gets it only if it was sent to players recently.
    r.get('/file/:name', (req, res) => {
      const f = lineFor(d, wid(res), isDM(res), String(req.params.name));
      if (!f) throw new HttpError(404, 'File not found');
      serveFile(req, res, f.abs, f.mime);
    });
    // A ticket for an <audio> tag to play it (same checks).
    r.get('/file/:name/ticket', (req, res) => {
      const name = String(req.params.name);
      if (!lineFor(d, wid(res), isDM(res), name)) throw new HttpError(404, 'File not found');
      res.json({ url: `/api/media/voice/${mintTicket({ w: wid(res), k: 'voice', f: name, a: me(res) })}` });
    });

    return r;
  },
};
export default feature;
