// Scenes: one button sets the whole room. A saved preset per world with any of: the players' TV (a media item, a library
// folder as a slideshow, a stage card, or media off), sound (a track and/or an ambience, volume, stop the rest), a lights
// preset, and the table map (which picture, and optionally a saved fog state). Unset parts are left alone.
//
// Everything here is DM-only. Activating applies each part through the same world API the DM's own controls use, so a
// part that fails (a deleted track, no lights set up) is reported and the others still happen; "undo scene" puts back what
// the parts that worked had changed, as far as that is possible (it says what is not).
//
// Live event `scenes` (DM only, clients refetch) on any change, activation or undo. The parts' own events (`screen`,
// `sound`, `stage`, `fog`, `table-display`) reach every screen as usual.
import { Router, type Request } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { all, one, run, tx } from '../../core/db.ts';
import { requireDM } from '../../core/auth.ts';
import { dmOnly } from '../../core/events.ts';
import { HttpError, id as newId, now, parseJson, str } from '../../core/util.ts';
import { ctx, me } from '../../routes/_shared.ts';
import { applyParts, captureParts, snapshotFor, undoParts, type Call } from './apply.ts';
import { PART_KEYS, cleanParts, type PartKey, type Parts } from './parts.ts';

const schema = `
CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  pos INTEGER NOT NULL DEFAULT 0,
  parts TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scenes_world ON scenes (world_id, pos);
CREATE TABLE IF NOT EXISTS scene_last (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  scene_id TEXT, name TEXT NOT NULL,
  at TEXT NOT NULL, by_id TEXT NOT NULL,
  parts TEXT NOT NULL, snapshot TEXT NOT NULL, report TEXT NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0
);
`;

const MAX_SCENES = 100;

interface Row { id: string; world_id: string; name: string; icon: string; color: string; pos: number; parts: string; created_at: string; updated_at: string }
const out = (r: Row) => ({ id: r.id, name: r.name, icon: r.icon, color: r.color, pos: r.pos, parts: parseJson<Parts>(r.parts, {}), updatedAt: r.updated_at });

const colorOf = (v: unknown) => {
  const c = str(v, 'color', { max: 20, optional: true }).trim();
  if (c && !/^#[0-9a-f]{3,8}$/i.test(c)) throw new HttpError(400, 'color must be like #c0392b');
  return c;
};

/** The world API as the DM making this request: the same call the DM's own buttons would make. */
export function selfFor(req: Request, worldId: string): Call {
  const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : { Cookie: String(req.headers.cookie ?? '') };
  return async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${req.socket.localPort}/api/worlds/${worldId}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...auth }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(String(j?.error ?? `${method} ${path} failed (${r.status})`));
    return j;
  };
}

const feature: Feature = {
  id: 'scenes',
  schema,
  worldMount: 'scenes',
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    r.use(requireDM);
    const { db } = d;
    const W = (res: any) => ctx(res).world.id;
    const rows = (w: string) => all<Row>(db, 'SELECT * FROM scenes WHERE world_id = ? ORDER BY pos, created_at', w);
    const find = (w: string, ref: unknown): Row => {
      const v = String(ref ?? '').trim();
      const s = one<Row>(db, 'SELECT * FROM scenes WHERE world_id = ? AND id = ?', w, v) ?? rows(w).find((x) => x.name.toLowerCase() === v.toLowerCase());
      if (!s) throw new HttpError(404, 'Scene not found');
      return s;
    };
    const changed = (w: string) => d.hub.emit(w, 'scenes', { at: now() }, dmOnly);
    const audit = (w: string, by: string, action: string, detail: string) =>
      run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', w, by, action, detail.slice(0, 500), now());
    const lastOf = (w: string) => {
      const l = one<any>(db, 'SELECT * FROM scene_last WHERE world_id = ?', w);
      return l ? { sceneId: l.scene_id as string | null, name: l.name as string, at: l.at as string, report: parseJson(l.report, {}), undone: !!l.undone, canUndo: !l.undone } : null;
    };

    r.get('/', (_req, res) => { const w = W(res); res.json({ scenes: rows(w).map(out), last: lastOf(w) }); });

    r.post('/', (req, res) => {
      const w = W(res);
      const b = req.body ?? {};
      if (rows(w).length >= MAX_SCENES) throw new HttpError(409, `A world can have up to ${MAX_SCENES} scenes`);
      const name = str(b.name, 'name', { max: 60 }).trim();
      if (!name) throw new HttpError(400, 'name is required');
      const s = { id: newId('scn_'), name, icon: str(b.icon, 'icon', { max: 40, optional: true }).trim(), color: colorOf(b.color), parts: cleanParts(b.parts), pos: (one<any>(db, 'SELECT COALESCE(MAX(pos), 0) + 1 AS p FROM scenes WHERE world_id = ?', w)!.p as number) };
      run(db, 'INSERT INTO scenes (id, world_id, name, icon, color, pos, parts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', s.id, w, s.name, s.icon, s.color, s.pos, JSON.stringify(s.parts), now(), now());
      changed(w);
      res.status(201).json(out(find(w, s.id)));
    });

    r.put('/order', (req, res) => {
      const w = W(res);
      const ids = req.body?.ids;
      if (!Array.isArray(ids) || ids.length > MAX_SCENES || ids.some((x) => typeof x !== 'string')) throw new HttpError(400, 'ids must be a list of scene ids');
      const have = new Set(rows(w).map((x) => x.id));
      const order = [...new Set(ids as string[])].filter((x) => have.has(x));
      const rest = rows(w).map((x) => x.id).filter((x) => !order.includes(x));
      tx(db, () => { [...order, ...rest].forEach((x, n) => run(db, 'UPDATE scenes SET pos = ? WHERE id = ?', n + 1, x)); });
      changed(w);
      res.json({ scenes: rows(w).map(out) });
    });

    // Undo the last activation (one level): put back what its parts changed.
    r.post('/undo', async (req, res) => {
      const w = W(res);
      const l = one<any>(db, 'SELECT * FROM scene_last WHERE world_id = ?', w);
      if (!l || l.undone) throw new HttpError(409, 'There is no scene to undo');
      const parts = parseJson<Parts>(l.parts, {});
      const parts_ = await undoParts(selfFor(req, w), parts, parseJson(l.snapshot, {}), parseJson(l.report, {}));
      run(db, 'UPDATE scene_last SET undone = 1 WHERE world_id = ?', w);
      audit(w, me(res), 'scene.undo', l.name);
      changed(w);
      const failed = Object.values(parts_).some((p) => p.status === 'failed');
      res.json({ ok: !failed, scene: { id: l.scene_id, name: l.name }, parts: parts_ });
    });

    r.get('/last', (_req, res) => res.json(lastOf(W(res))));

    // Save what is on now (TV media, sound, lights preset, table map and fog) as a scene.
    r.post('/capture', async (req, res) => {
      const w = W(res);
      const b = req.body ?? {};
      if (rows(w).length >= MAX_SCENES) throw new HttpError(409, `A world can have up to ${MAX_SCENES} scenes`);
      const name = str(b.name, 'name', { max: 60 }).trim();
      if (!name) throw new HttpError(400, 'name is required');
      const include = (Array.isArray(b.include) ? b.include : [...PART_KEYS]).filter((k: unknown): k is PartKey => PART_KEYS.includes(k as PartKey));
      const { parts, notes } = await captureParts(selfFor(req, w), include);
      const clean = cleanParts(parts);
      const sid = newId('scn_');
      run(db, 'INSERT INTO scenes (id, world_id, name, icon, color, pos, parts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', sid, w, name, str(b.icon, 'icon', { max: 40, optional: true }).trim(), colorOf(b.color),
        one<any>(db, 'SELECT COALESCE(MAX(pos), 0) + 1 AS p FROM scenes WHERE world_id = ?', w)!.p, JSON.stringify(clean), now(), now());
      changed(w);
      res.status(201).json({ scene: out(find(w, sid)), notes });
    });

    r.put('/:id', (req, res) => {
      const w = W(res);
      const cur = find(w, req.params.id);
      const b = req.body ?? {};
      const name = b.name !== undefined ? str(b.name, 'name', { max: 60 }).trim() : cur.name;
      if (!name) throw new HttpError(400, 'name is required');
      const icon = b.icon !== undefined ? str(b.icon, 'icon', { max: 40, optional: true }).trim() : cur.icon;
      const color = b.color !== undefined ? colorOf(b.color) : cur.color;
      const parts = b.parts !== undefined ? cleanParts(b.parts) : parseJson<Parts>(cur.parts, {});
      run(db, 'UPDATE scenes SET name = ?, icon = ?, color = ?, parts = ?, updated_at = ? WHERE id = ?', name, icon, color, JSON.stringify(parts), now(), cur.id);
      changed(w);
      res.json(out(find(w, cur.id)));
    });

    r.delete('/:id', (req, res) => {
      const w = W(res);
      const cur = find(w, req.params.id);
      run(db, 'DELETE FROM scenes WHERE id = ?', cur.id);
      changed(w);
      res.json({ ok: true });
    });

    // Activate by id or by name. 200 with a report per part even when some parts failed; `ok` is true when none did.
    r.post('/:id/activate', async (req, res) => {
      const w = W(res);
      const sc = find(w, req.params.id);
      const parts = parseJson<Parts>(sc.parts, {});
      const call = selfFor(req, w);
      const snapshot = await snapshotFor(call, parts);
      const report = await applyParts(call, parts);
      const worked = Object.values(report).some((p) => p?.status === 'ok');
      // Only a scene that changed something replaces what "undo" would undo.
      if (worked) {
        run(db, `INSERT INTO scene_last (world_id, scene_id, name, at, by_id, parts, snapshot, report, undone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT (world_id) DO UPDATE SET scene_id = excluded.scene_id, name = excluded.name, at = excluded.at, by_id = excluded.by_id, parts = excluded.parts, snapshot = excluded.snapshot, report = excluded.report, undone = 0`,
          w, sc.id, sc.name, now(), me(res), JSON.stringify(parts), JSON.stringify(snapshot), JSON.stringify(report));
      }
      audit(w, me(res), 'scene.activate', `${sc.name}: ${Object.entries(report).map(([k, v]) => `${k} ${v?.status}`).join(', ')}`);
      changed(w);
      res.json({ ok: !Object.values(report).some((p) => p?.status === 'failed'), scene: { id: sc.id, name: sc.name }, parts: report, undoable: worked, empty: !Object.keys(report).length });
    });

    return r;
  },
  mcpTools: [
    { name: 'list_scenes', dmOnly: true, description: "DM: the saved scenes (one-button presets that set the players' TV, sound, lights and the table map): name and which parts each sets.", props: {}, call: () => ({ method: 'GET', path: '/scenes' }) },
    {
      name: 'activate_scene', write: true,
      description: "DM: activate a saved scene by name or id: sets the players' TV, sound, lights and table map in one go, and reports per part (one failing part does not stop the others). Scenes are listed by list_scenes.",
      props: { scene: { type: 'string', description: 'Scene name or id' } },
      required: ['scene'],
      call: (a) => ({ method: 'POST', path: `/scenes/${encodeURIComponent(String(a.scene ?? ''))}/activate`, body: {} }),
    },
  ],
};
export default feature;
