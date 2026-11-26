// Read aloud (PLAN §7): voice presets, and speaking selected text with the
// "voice" model job. The audio is stored under the data folder and played
// through the same `sound` live event as the sound board (channel 'voice').
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { one, all, run } from '../../core/db.ts';
import { requireDM } from '../../core/auth.ts';
import { HttpError, id as newId, now, oneOf, str } from '../../core/util.ts';
import { ctx, isDM, me, settings } from '../../routes/_shared.ts';
import { serveFile } from '../sound/files.ts';
import { TARGETS, toPlayers, type Target } from '../sound/send.ts';
import { mintTicket, readTicket } from '../sound/ticket.ts';
import { findPreset, lineFor, migrateVoice, speakLine } from './line.ts';
import { npcKey, npcSchema, startNpcVoices } from './npc.ts';

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
  accounts TEXT,
  PRIMARY KEY (world_id, name)
);
${npcSchema}`;

const EFFECTS = ['none', 'echo', 'radio'] as const;

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

const feature: Feature = {
  id: 'voice',
  schema,
  migrate: migrateVoice,
  settings: {
    // NPC voices: an encounter NPC's lines are read aloud on that player's device (off by default).
    npcVoices: { type: 'boolean', default: false },
    // The preset (name or id) NPCs speak with when they have no voice of their own; empty: only NPCs given one speak.
    npcVoicePreset: { type: 'string', default: '', max: 60 },
    // The preset a new quick event's prompt is read with, to the players it went to; empty: quick events are silent.
    quickEventVoicePreset: { type: 'string', default: '', max: 60 },
  },
  worldMount: 'voice',
  dataDirs: ['voice'],
  appRoutes: (app, d) => {
    app.get('/api/media/voice/:ticket', (req, res) => {
      const t = readTicket(String(req.params.ticket));
      const m = t && t.k === 'voice' && one<{ role: string }>(d.db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', t.w, t.a);
      const f = t && m && lineFor(d, t.w, m.role === 'dm', t.f, t.a);
      if (!f) throw new HttpError(404, 'File not found');
      serveFile(req, res, f.abs, f.mime);
    });
  },
  mcpTools: [
    { name: 'list_voice_presets', dmOnly: true, description: 'DM: the saved read-aloud voice presets (name, voice, speed, effect, who hears it).', props: {}, call: () => ({ method: 'GET', path: '/voice/presets' }) },
    {
      name: 'speak', write: true,
      description: "DM: read text aloud with a voice preset (by name or id). By default it plays at the table; the preset's target says who else hears it. Text copied from DM-only notes is refused when it would reach players.",
      props: { text: { type: 'string', description: 'What to say, up to 2000 characters' }, preset: { type: 'string', description: 'Preset name' }, presetId: { type: 'string' }, target: { type: 'string', enum: [...TARGETS] } },
      required: ['text'],
      call: (a) => ({ method: 'POST', path: '/voice/speak', body: { text: a.text, preset: a.preset, presetId: a.presetId, target: a.target } }),
    },
    { name: 'list_npc_voices', dmOnly: true, description: 'DM: NPC voices: whether encounter NPCs are read aloud, the default NPC voice, the quick event voice, and which NPCs have a voice preset of their own.', props: {}, call: () => ({ method: 'GET', path: '/voice/npcs' }) },
    {
      name: 'set_npc_voice', write: true,
      description: "DM: give an NPC their own voice preset for encounters (by the NPC's name as it shows in encounters; preset by name or id). An empty preset takes the NPC's own voice away. Turning NPC voices on is the npcVoices setting.",
      props: { npc: { type: 'string', description: 'NPC name' }, preset: { type: 'string', description: 'Voice preset name; empty to remove' } },
      required: ['npc'],
      call: (a) => ({ method: 'PUT', path: '/voice/npcs', body: { npc: a.npc, preset: a.preset ?? '' } }),
    },
    {
      name: 'set_npc_voices', write: true,
      description: "DM: turn NPC voices on or off (encounter NPCs read aloud on that player's device only), and set the default NPC voice preset and the voice that reads new quick events to their players (empty: quick events stay silent).",
      props: { on: { type: 'boolean', description: 'NPC voices in encounters' }, defaultPreset: { type: 'string', description: 'Preset name for NPCs without their own' }, quickEventPreset: { type: 'string', description: 'Preset name for quick events; empty for none' } },
      call: (a) => ({ method: 'PATCH', path: '/settings', body: { npcVoices: typeof a.on === 'boolean' ? a.on : undefined, npcVoicePreset: a.defaultPreset, quickEventVoicePreset: a.quickEventPreset } }),
    },
  ],
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    const { db } = d;
    const wid = (res: any) => ctx(res).world.id;
    // NPC voices listen to encounters and quick events (once per app; routes are built once).
    startNpcVoices(d);

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
      const p = findPreset(d, w, String(req.body?.presetId ?? '')) ?? findPreset(d, w, String(req.body?.preset ?? ''));
      if (!p) throw new HttpError(404, 'Preset not found');
      const tg = oneOf(req.body?.target, 'target', TARGETS, p.target as Target);
      if (toPlayers(tg) && containsDmOnly(d, w, text) && req.body?.confirm !== true) {
        return void res.status(409).json({ error: 'This text comes from DM-only notes. Sending it to players would reveal it. Confirm to send anyway.', needsConfirm: true });
      }
      const r2 = await speakLine(d, w, text, p, tg);
      res.json({ ok: true, ...r2 });
    });

    // NPC voices: the settings and which NPCs have a preset of their own.
    r.get('/npcs', requireDM, (_req, res) => {
      const s = settings(res) as any;
      const npcs = all<any>(db, 'SELECT n.name, n.preset_id, p.name AS preset FROM voice_npcs n LEFT JOIN voice_presets p ON p.id = n.preset_id WHERE n.world_id = ? ORDER BY n.name COLLATE NOCASE', wid(res));
      res.json({ npcVoices: s.npcVoices === true, npcVoicePreset: s.npcVoicePreset ?? '', quickEventVoicePreset: s.quickEventVoicePreset ?? '', npcs: npcs.map((n) => ({ npc: n.name, presetId: n.preset_id, preset: n.preset ?? '(deleted preset)' })) });
    });
    r.put('/npcs', requireDM, (req, res) => {
      const w = wid(res);
      const name = str(req.body?.npc, 'npc', { max: 80 }).trim();
      if (!name) throw new HttpError(400, 'npc is required');
      const want = str(req.body?.preset, 'preset', { max: 80, optional: true })?.trim() ?? '';
      if (!want) {
        run(db, 'DELETE FROM voice_npcs WHERE world_id = ? AND npc = ?', w, npcKey(name));
        return void res.json({ npc: name, preset: null });
      }
      const p = findPreset(d, w, want);
      if (!p) throw new HttpError(404, `No voice preset called ${want}. Make one on the Voice page first.`);
      run(db, 'INSERT INTO voice_npcs (world_id, npc, name, preset_id) VALUES (?, ?, ?, ?) ON CONFLICT (world_id, npc) DO UPDATE SET name = excluded.name, preset_id = excluded.preset_id', w, npcKey(name), name, p.id);
      res.json({ npc: name, preset: p.name, presetId: p.id });
    });

    // The spoken line. A player gets it only if it was sent to players recently.
    r.get('/file/:name', (req, res) => {
      const f = lineFor(d, wid(res), isDM(res), String(req.params.name), me(res));
      if (!f) throw new HttpError(404, 'File not found');
      serveFile(req, res, f.abs, f.mime);
    });
    // A ticket for an <audio> tag to play it (same checks).
    r.get('/file/:name/ticket', (req, res) => {
      const name = String(req.params.name);
      if (!lineFor(d, wid(res), isDM(res), name, me(res))) throw new HttpError(404, 'File not found');
      res.json({ url: `/api/media/voice/${mintTicket({ w: wid(res), k: 'voice', f: name, a: me(res) })}` });
    });

    return r;
  },
};
export default feature;
