// Player marks on a map: pins, sticky notes, routes, numbered stops and
// icons. 'party' marks are seen by everyone, 'me' marks only by their author.
// The DM can hide any party mark; DM marks ('dm') are the DM's own layer.
import { Router } from 'express';
import type { Deps } from '../app.ts';
import { one, all, run } from '../core/db.ts';
import { requirePlayerOrDM } from '../core/auth.ts';
import { canSee } from '../core/policy.ts';
import { HttpError, id, now, oneOf, str } from '../core/util.ts';
import { ctx, isDM, me, settings } from './_shared.ts';

const ICONS = ['camp', 'fight', 'danger', 'skull', 'anchor', 'question', 'rest', 'treasure', 'door', 'eye'];

function point(v: any, f: string) {
  const x = Number(v?.x), y = Number(v?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) throw new HttpError(400, `${f} must be {x, y} from 0 to 100`);
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
}

export default function mapRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;

  r.get('/:mapId/marks', (req, res) => {
    const c = ctx(res);
    const rows = all<any>(db, 'SELECT * FROM map_marks WHERE world_id = ? AND map_id = ? ORDER BY created_at', c.world.id, String(req.params.mapId));
    res.json(rows
      .filter((m) => canSee(c.viewer, m.visibility, m.author_id) && (isDM(res) || !m.hidden_by_dm || m.author_id === me(res)))
      .map((m) => ({ ...m, data: JSON.parse(m.data), hidden_by_dm: !!m.hidden_by_dm })));
  });

  r.post('/:mapId/marks', requirePlayerOrDM, (req, res) => {
    const c = ctx(res);
    const s = settings(res);
    const b = req.body ?? {};
    const kind = oneOf(b.kind, 'kind', ['pin', 'note', 'route', 'stop', 'icon'] as const);
    if (!isDM(res)) {
      if ((kind === 'pin' || kind === 'note' || kind === 'icon') && !s.mapPins) throw new HttpError(403, 'Pins and notes are off for this world');
      if (kind === 'route' && !s.mapDraw) throw new HttpError(403, 'Drawing routes is off for this world');
      if (kind === 'stop' && !s.mapStops) throw new HttpError(403, 'Numbered stops are off for this world');
    }
    const visibility = oneOf(b.visibility, 'visibility', isDM(res) ? (['party', 'me', 'dm'] as const) : (['party', 'me'] as const), 'party');
    let data: any;
    if (kind === 'route') {
      if (!Array.isArray(b.points) || b.points.length < 2 || b.points.length > 500) throw new HttpError(400, 'A route needs 2 to 500 points');
      data = { points: b.points.map((p: any, i: number) => point(p, `points[${i}]`)), arrow: b.arrow !== false, color: str(b.color, 'color', { max: 20, optional: true }) || null };
    } else {
      data = { ...point(b, 'position'), label: str(b.label, 'label', { max: 120, optional: true }) };
      if (kind === 'note') data.text = str(b.text, 'text', { max: 500 });
      if (kind === 'icon') data.icon = oneOf(b.icon, 'icon', ICONS);
      if (kind === 'stop') {
        // Stops number themselves 1, 2, 3... per author's plan unless given.
        const plan = str(b.plan, 'plan', { max: 60, optional: true }) || 'default';
        const n = one<any>(db, `SELECT COUNT(*) AS n FROM map_marks WHERE world_id = ? AND map_id = ? AND kind = 'stop' AND json_extract(data, '$.plan') = ?`, c.world.id, String(req.params.mapId), plan)!.n;
        data.plan = plan;
        data.n = n + 1;
      }
    }
    const m = { id: id('mk_'), world_id: c.world.id, map_id: str(String(req.params.mapId), 'mapId', { max: 60 }), author_id: me(res), kind, data, visibility, hidden_by_dm: false, created_at: now() };
    run(db, 'INSERT INTO map_marks (id, world_id, map_id, author_id, kind, data, visibility, hidden_by_dm, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)', m.id, m.world_id, m.map_id, m.author_id, m.kind, JSON.stringify(data), m.visibility, m.created_at);
    d.hub.emit(c.world.id, 'map-mark', m, (v) => canSee(v, m.visibility, m.author_id));
    res.status(201).json(m);
  });

  // DM: hide or show a mark. Authors keep seeing their own hidden marks.
  r.patch('/:mapId/marks/:mid', (req, res) => {
    const c = ctx(res);
    const m = one<any>(db, 'SELECT * FROM map_marks WHERE id = ? AND world_id = ?', String(req.params.mid), c.world.id);
    if (!m || !canSee(c.viewer, m.visibility, m.author_id)) throw new HttpError(404, 'Mark not found');
    if (req.body?.hidden !== undefined) {
      if (!isDM(res)) throw new HttpError(403, 'Only the DM can hide marks');
      run(db, 'UPDATE map_marks SET hidden_by_dm = ? WHERE id = ?', req.body.hidden ? 1 : 0, m.id);
    }
    if (req.body?.text !== undefined || req.body?.label !== undefined) {
      if (m.author_id !== me(res)) throw new HttpError(403, 'Only the author can edit a mark');
      const data = { ...JSON.parse(m.data) };
      if (req.body.text !== undefined) data.text = str(req.body.text, 'text', { max: 500 });
      if (req.body.label !== undefined) data.label = str(req.body.label, 'label', { max: 120, optional: true });
      run(db, 'UPDATE map_marks SET data = ? WHERE id = ?', JSON.stringify(data), m.id);
    }
    res.json({ ok: true });
  });

  r.delete('/:mapId/marks/:mid', (req, res) => {
    const c = ctx(res);
    const m = one<any>(db, 'SELECT * FROM map_marks WHERE id = ? AND world_id = ?', String(req.params.mid), c.world.id);
    if (!m || !canSee(c.viewer, m.visibility, m.author_id)) throw new HttpError(404, 'Mark not found');
    if (m.author_id !== me(res) && !isDM(res)) throw new HttpError(403, 'You can only erase your own marks');
    run(db, 'DELETE FROM map_marks WHERE id = ?', m.id);
    d.hub.emit(c.world.id, 'map-mark-removed', { id: m.id }, (v) => canSee(v, m.visibility, m.author_id));
    res.json({ ok: true });
  });

  return r;
}
