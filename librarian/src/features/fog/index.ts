// Fog of war and the table display. Fog is off by default for a map picture; the DM turns it on (starts fully fogged) and
// uncovers it with circles and rectangles. Everyone may read it (players draw it over the map picture; the table screen is
// seen by players); only the DM writes. The real protection is on the server: map marks under fog are never sent to
// players (routes/map.ts), so a client that ignored the fog would still learn nothing from marks.
//
// The table display is which map picture the face-up table screen shows, set by the DM and followed live.
//
// Live events (clients refetch): `fog` { mapId, pic, version }, `table-display` { version }.
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { one, run, tx } from '../../core/db.ts';
import { requireDM } from '../../core/auth.ts';
import { everyone } from '../../core/events.ts';
import { compact, readFog, withoutLastStroke, type FogOp, type FogState } from '../../core/fog.ts';
import { HttpError, now, str } from '../../core/util.ts';
import { ctx } from '../../routes/_shared.ts';

const schema = `
CREATE TABLE IF NOT EXISTS fog_layers (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  map_id TEXT NOT NULL,
  pic TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  base TEXT,
  ops TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (world_id, map_id, pic)
);
CREATE TABLE IF NOT EXISTS table_display (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  map_id TEXT, pic TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;

const unit = (v: unknown, f: string, min = 0, max = 1) => {
  const n = Number(v);
  if (typeof v === 'boolean' || v === null || v === '' || !Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${f} must be a number from ${min} to ${max}`);
  return Math.round(n * 10_000) / 10_000;
};

/** One stroke from a request, checked and rounded. */
export function cleanOp(raw: any): FogOp {
  const v = raw?.v === 0 || raw?.v === false || raw?.reveal === false ? 0 : 1;
  const g = raw?.g === undefined || raw?.g === null ? {} : { g: unit(raw.g, 'g', 0, 2_000_000_000) };
  switch (raw?.k) {
    case 'c': return { k: 'c', x: unit(raw.x, 'x'), y: unit(raw.y, 'y'), r: unit(raw.r, 'r', 0.003, 1), v, ...g };
    case 'r': {
      const x = unit(raw.x, 'x'), y = unit(raw.y, 'y');
      return { k: 'r', x, y, w: Math.min(unit(raw.w, 'w'), 1 - x), h: Math.min(unit(raw.h, 'h'), 1 - y), v, ...g };
    }
    case 'all': return { k: 'all', v, ...g };
    default: throw new HttpError(400, "op.k must be 'c' (circle), 'r' (rectangle) or 'all'");
  }
}

const mapKey = (v: unknown) => str(v, 'mapId', { max: 60 });
const picKey = (v: unknown) => str(v, 'pic', { max: 200 }) || 'none';

export const readLayer = (d: Deps, w: string, mapId: string, pic: string) =>
  one<any>(d.db, 'SELECT * FROM fog_layers WHERE world_id = ? AND map_id = ? AND pic = ?', w, mapId, pic);

export const fogOf = (d: Deps, w: string, mapId: string, pic: string): FogState & { version: number } => {
  const row = readLayer(d, w, mapId, pic);
  return { ...readFog(row), version: row?.version ?? 0 };
};

/** Write a layer's state and tell every screen to refetch it. */
export function saveFog(d: Deps, w: string, mapId: string, pic: string, s: FogState): number {
  const next = compact(s);
  const version = (readLayer(d, w, mapId, pic)?.version ?? 0) + 1;
  run(d.db, `INSERT INTO fog_layers (world_id, map_id, pic, enabled, base, ops, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (world_id, map_id, pic) DO UPDATE SET enabled = excluded.enabled, base = excluded.base, ops = excluded.ops, version = excluded.version, updated_at = excluded.updated_at`,
    w, mapId, pic, next.enabled ? 1 : 0, next.base, JSON.stringify(next.ops), version, now());
  d.hub.emit(w, 'fog', { mapId, pic, version }, everyone);
  return version;
}

export const tableOf = (d: Deps, w: string) => {
  const r = one<any>(d.db, 'SELECT * FROM table_display WHERE world_id = ?', w);
  return { mapId: (r?.map_id ?? null) as string | null, pic: (r?.pic ?? null) as string | null, version: (r?.version ?? 0) as number };
};

export function saveTable(d: Deps, w: string, mapId: string | null, pic: string | null) {
  const version = tableOf(d, w).version + 1;
  run(d.db, `INSERT INTO table_display (world_id, map_id, pic, version, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (world_id) DO UPDATE SET map_id = excluded.map_id, pic = excluded.pic, version = excluded.version, updated_at = excluded.updated_at`, w, mapId, pic, version, now());
  d.hub.emit(w, 'table-display', { version }, everyone);
  return tableOf(d, w);
}

const feature: Feature = {
  id: 'fog',
  schema,
  worldMount: 'fog',
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    const W = (res: any) => ctx(res).world.id;

    // ---- the table display ----
    r.get('/table', (_req, res) => res.json(tableOf(d, W(res))));
    r.put('/table', requireDM, (req, res) => {
      const w = W(res);
      const b = req.body ?? {};
      const cur = tableOf(d, w);
      const mapId = b.mapId === undefined ? cur.mapId : b.mapId === null ? null : mapKey(b.mapId);
      const pic = b.pic === undefined ? cur.pic : b.pic === null ? null : picKey(b.pic);
      res.json(saveTable(d, w, mapId, pic));
    });

    // ---- fog on one map picture ----
    r.get('/map/:mapId', (req, res) => {
      const pic = picKey(req.query.pic ?? 'none');
      const f = fogOf(d, W(res), mapKey(req.params.mapId), pic);
      res.json({ mapId: req.params.mapId, pic, ...f });
    });

    const target = (req: any, res: any) => ({ w: W(res), mapId: mapKey(req.params.mapId), pic: picKey(req.body?.pic) });

    // Turning fog on starts fully fogged; off keeps the strokes, so turning it on again picks up where it was.
    r.put('/map/:mapId/enabled', requireDM, (req, res) => {
      const t = target(req, res);
      const cur = fogOf(d, t.w, t.mapId, t.pic);
      const enabled = !!req.body?.enabled;
      if (enabled && !cur.enabled && !cur.ops.length && !cur.base) saveFog(d, t.w, t.mapId, t.pic, { enabled: true, base: null, ops: [] });
      else saveFog(d, t.w, t.mapId, t.pic, { ...cur, enabled });
      res.json(fogOf(d, t.w, t.mapId, t.pic));
    });

    r.post('/map/:mapId/ops', requireDM, (req, res) => {
      const t = target(req, res);
      const cur = fogOf(d, t.w, t.mapId, t.pic);
      if (!cur.enabled) throw new HttpError(409, 'Turn fog on for this map picture first');
      const list = Array.isArray(req.body?.ops) ? req.body.ops : [req.body?.op];
      if (!list.length || list.length > 200) throw new HttpError(400, 'Send one op, or up to 200');
      const ops = list.map(cleanOp);
      saveFog(d, t.w, t.mapId, t.pic, { ...cur, ops: [...cur.ops, ...ops] });
      res.json(fogOf(d, t.w, t.mapId, t.pic));
    });

    r.post('/map/:mapId/undo', requireDM, (req, res) => {
      const t = target(req, res);
      const cur = fogOf(d, t.w, t.mapId, t.pic);
      if (!cur.ops.length) throw new HttpError(409, 'Nothing to undo');
      saveFog(d, t.w, t.mapId, t.pic, { ...cur, ops: withoutLastStroke(cur.ops) });
      res.json(fogOf(d, t.w, t.mapId, t.pic));
    });

    // Put a whole fog state back (a scene's saved fog, or an undo of one).
    r.put('/map/:mapId/state', requireDM, (req, res) => {
      const t = target(req, res);
      const b = req.body ?? {};
      const ops = Array.isArray(b.ops) ? b.ops.slice(0, 400).map(cleanOp) : [];
      const base = b.base === null || b.base === undefined ? null : str(b.base, 'base', { max: 4000 });
      if (base !== null && !/^[A-Za-z0-9+/=]+$/.test(base)) throw new HttpError(400, 'base must be base64');
      tx(d.db, () => saveFog(d, t.w, t.mapId, t.pic, { enabled: !!b.enabled, base, ops }));
      res.json(fogOf(d, t.w, t.mapId, t.pic));
    });

    return r;
  },
};
export default feature;
