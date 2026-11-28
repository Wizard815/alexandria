// Player marks on a map: pins, sticky notes, routes, numbered stops and
// icons. 'party' marks are seen by everyone, 'me' marks only by their author.
// The GM can hide any party mark; GM marks ('gm') are the GM's own layer.
import { Router } from 'express';
import type { Deps } from '../app.ts';
import { one, all, run } from '../core/db.ts';
import { requirePlayerOrGM } from '../core/auth.ts';
import { canSee } from '../core/policy.ts';
import { fogLayers, markUnderFog } from '../core/fog.ts';
import { HttpError, id, now, oneOf, str } from '../core/util.ts';
import { readOnOpen } from '../features/connections/ondemand.ts';
import { ctx, isGM, me, readerFor, settings } from './_shared.ts';

const ICONS = ['camp', 'fight', 'danger', 'skull', 'anchor', 'question', 'rest', 'treasure', 'door', 'eye'];

function point(v: any, f: string) {
  const x = Number(v?.x), y = Number(v?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) throw new HttpError(400, `${f} must be {x, y} from 0 to 100`);
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
}

export default function mapRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;

  db.exec('CREATE TABLE IF NOT EXISTS map_scales (world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE, pic TEXT NOT NULL, width REAL NOT NULL, unit TEXT NOT NULL, PRIMARY KEY (world_id, pic))');

  // How wide the whole picture is in the world ("400 miles"), for the ruler. One per map picture, set by the GM, read by everyone.
  r.get('/scale', (req, res) => {
    res.json(one<any>(db, 'SELECT width, unit FROM map_scales WHERE world_id = ? AND pic = ?', ctx(res).world.id, str(req.query.pic, 'pic', { max: 200 })) ?? null);
  });
  r.put('/scale', requirePlayerOrGM, (req, res) => {
    if (!isGM(res)) throw new HttpError(403, 'Only the GM sets the scale');
    const w = ctx(res).world.id;
    const pic = str(req.body?.pic, 'pic', { max: 200 });
    const width = Number(req.body?.width);
    if (req.body?.width === null) run(db, 'DELETE FROM map_scales WHERE world_id = ? AND pic = ?', w, pic);
    else {
      if (!Number.isFinite(width) || width <= 0 || width > 1e9) throw new HttpError(400, 'width must be a number above 0');
      run(db, 'INSERT OR REPLACE INTO map_scales (world_id, pic, width, unit) VALUES (?, ?, ?, ?)', w, pic, width, str(req.body?.unit, 'unit', { max: 20 }) || 'miles');
    }
    d.hub.emit(w, 'map-scale', { pic }, () => true);
    res.json({ ok: true });
  });

  // The pins a map picture has in its own source (LegendKeeper), placed on the picture. The page is read as this viewer's copy, so a pin or a page
  // they may not see is not in it; under fog they get none. `map` is the Alexandria map whose fog counts.
  r.get('/imported/:image/pins', (req, res) => {
    const c = ctx(res);
    const v = readerFor(req, res);
    const img = one<any>(db, 'SELECT source_id, page_external FROM intake_images WHERE id = ? AND world_id = ?', String(req.params.image), c.world.id);
    const pg = img?.page_external ? one<any>(db, 'SELECT id FROM pages WHERE world_id = ? AND source_id = ? AND external_id = ?', c.world.id, img.source_id, img.page_external) : null;
    if (!pg) { res.json({ page: null, pins: [] }); return; }
    let page: any;
    try { page = d.library.get(c.world.id, pg.id, v as any); } catch { res.json({ page: null, pins: [] }); return; }
    const block = (page.blocks ?? []).find((b: any) => b.kind === 'map');
    const b = block?.bounds;
    const fog = v.role === 'gm' ? [] : fogLayers(db, c.world.id, str(req.query.map, 'map', { max: 60, optional: true }) || 'world');
    const pins = !b ? [] : (block.pins ?? []).map((p: any, i: number) => ({
      id: `p${i}`, name: p.name, icon: p.type ?? null, color: p.color ?? null, gm: p.gm === true, pageId: p.ref ? page.links[`ref:${p.ref}`] ?? null : null,
      x: ((p.lng - b[0][1]) / (b[1][1] - b[0][1])) * 100, y: ((b[1][0] - p.lat) / (b[1][0] - b[0][0])) * 100,
    })).filter((p: any) => p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100 && !markUnderFog(fog, { kind: 'pin', data: p }));
    res.json({ page: { id: page.id, title: page.title }, pins });
  });

  // GM: read the world's map pages from their source now (they are only listed until someone opens them), a few at a time.
  r.post('/imported/read', requirePlayerOrGM, async (req, res) => {
    if (!isGM(res)) throw new HttpError(403, 'Only the GM can read maps from the source');
    const w = ctx(res).world.id;
    const todo = all<any>(db, "SELECT p.id FROM pages p JOIN sources s ON s.id = p.source_id AND s.enabled = 1 WHERE p.world_id = ? AND p.kind = 'map' AND p.depth = 'index' ORDER BY p.title LIMIT 12", w);
    let read = 0;
    for (const p of todo) if ((await readOnOpen(d, w, p.id, ctx(res).viewer)) === 'fetched') read++;
    const left = one<any>(db, "SELECT count(*) AS n FROM pages p JOIN sources s ON s.id = p.source_id AND s.enabled = 1 WHERE p.world_id = ? AND p.kind = 'map' AND p.depth = 'index'", w)!.n;
    res.json({ read, left: Number(left) });
  });

  r.get('/:mapId/marks', (req, res) => {
    const c = ctx(res);
    const v = readerFor(req, res);
    const rows = all<any>(db, 'SELECT * FROM map_marks WHERE world_id = ? AND map_id = ? ORDER BY created_at', c.world.id, String(req.params.mapId));
    // Fog is enforced here, not on the page: a mark under fog is never sent to anyone but the GM (and not to the GM's
    // ?view=players table screen either), so a client that ignored the fog would still find nothing under it.
    const fog = v.role === 'gm' ? [] : fogLayers(db, c.world.id, String(req.params.mapId));
    res.json(rows
      .filter((m) => canSee(v, m.visibility, m.author_id) && (v.role === 'gm' || !m.hidden_by_gm || m.author_id === v.accountId))
      .map((m) => ({ ...m, data: JSON.parse(m.data), hidden_by_gm: !!m.hidden_by_gm }))
      .filter((m) => !markUnderFog(fog, m)));
  });

  r.post('/:mapId/marks', requirePlayerOrGM, (req, res) => {
    const c = ctx(res);
    const s = settings(res);
    const b = req.body ?? {};
    const kind = oneOf(b.kind, 'kind', ['pin', 'note', 'route', 'stop', 'icon'] as const);
    if (!isGM(res)) {
      if ((kind === 'pin' || kind === 'note' || kind === 'icon') && !s.mapPins) throw new HttpError(403, 'Pins and notes are off for this world');
      if (kind === 'route' && !s.mapDraw) throw new HttpError(403, 'Drawing routes is off for this world');
      if (kind === 'stop' && !s.mapStops) throw new HttpError(403, 'Numbered stops are off for this world');
    }
    const visibility = oneOf(b.visibility, 'visibility', isGM(res) ? (['party', 'me', 'gm'] as const) : (['party', 'me'] as const), 'party');
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
    const m = { id: id('mk_'), world_id: c.world.id, map_id: str(String(req.params.mapId), 'mapId', { max: 60 }), author_id: me(res), kind, data, visibility, hidden_by_gm: false, created_at: now() };
    run(db, 'INSERT INTO map_marks (id, world_id, map_id, author_id, kind, data, visibility, hidden_by_gm, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)', m.id, m.world_id, m.map_id, m.author_id, m.kind, JSON.stringify(data), m.visibility, m.created_at);
    // Looked up per event, so fog turned on a moment ago still counts; players get nothing for a mark under fog.
    const fog = fogLayers(db, c.world.id, m.map_id);
    const covered = markUnderFog(fog, m);
    d.hub.emit(c.world.id, 'map-mark', m, (v) => canSee(v, m.visibility, m.author_id) && (v.role === 'gm' || !covered));
    res.status(201).json(m);
  });

  // GM: hide or show a mark. Authors keep seeing their own hidden marks.
  r.patch('/:mapId/marks/:mid', (req, res) => {
    const c = ctx(res);
    const m = one<any>(db, 'SELECT * FROM map_marks WHERE id = ? AND world_id = ?', String(req.params.mid), c.world.id);
    if (!m || !canSee(c.viewer, m.visibility, m.author_id)) throw new HttpError(404, 'Mark not found');
    if (req.body?.hidden !== undefined) {
      if (!isGM(res)) throw new HttpError(403, 'Only the GM can hide marks');
      run(db, 'UPDATE map_marks SET hidden_by_gm = ? WHERE id = ?', req.body.hidden ? 1 : 0, m.id);
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
    if (m.author_id !== me(res) && !isGM(res)) throw new HttpError(403, 'You can only erase your own marks');
    run(db, 'DELETE FROM map_marks WHERE id = ?', m.id);
    d.hub.emit(c.world.id, 'map-mark-removed', { id: m.id }, (v) => canSee(v, m.visibility, m.author_id));
    res.json({ ok: true });
  });

  return r;
}
