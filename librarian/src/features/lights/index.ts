// Lights (PLAN §16.2): drivers for WLED, Philips Hue, Home Assistant and
// OpenRGB; light groups and scenes; hooks that follow the game. Everything
// the gateway does here is fire-and-forget: a light that is slow or down is
// counted on the status page and never holds up a game action.
import { Router } from 'express';
import type { Feature } from '../types.ts';
import { all, one, run } from '../../core/db.ts';
import { requireDM, requirePlayerOrDM } from '../../core/auth.ts';
import { HttpError, id, int, now, oneOf, parseJson, str } from '../../core/util.ts';
import { ctx, me } from '../../routes/_shared.ts';
import { toHex, parseColor } from './color.ts';
import { KINDS, cleanConfig, cleanEffect, cleanTarget, huePair, maskConfig, send, type Kind } from './drivers.ts';
import { applyItems, findScene, itemsOf, linksFor, memOf, runScene, statusOf, type SceneItem } from './engine.ts';
import { cleanHooks, getHooks, installHooks, saveHooks, startPoll } from './hooks.ts';

const audit = (db: any, worldId: string, accountId: string | null, action: string, detail = '') => run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());

const schema = `
CREATE TABLE IF NOT EXISTS lights_drivers (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lights_drivers_world ON lights_drivers(world_id);
CREATE TABLE IF NOT EXISTS lights_groups (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  driver_id TEXT NOT NULL REFERENCES lights_drivers(id) ON DELETE CASCADE,
  name TEXT NOT NULL, target TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lights_groups_world ON lights_groups(world_id);
CREATE TABLE IF NOT EXISTS lights_scenes (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL, items TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lights_scenes_world ON lights_scenes(world_id);
CREATE TABLE IF NOT EXISTS lights_hooks (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE, config TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lights_player_colors (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  color TEXT NOT NULL, PRIMARY KEY (world_id, account_id)
);
`;

const driverOut = (d: any, r: any) => {
  const cfg = parseJson<Record<string, any>>(r.config, {});
  return { id: r.id, kind: r.kind as Kind, name: r.name, enabled: !!r.enabled, config: maskConfig(r.kind, cfg), paired: r.kind === 'hue' ? !!cfg.user : undefined, status: statusOf(d, r.id) };
};
const groupOut = (r: any) => ({ id: r.id, name: r.name, driverId: r.driver_id, target: parseJson(r.target, {}) });
const sceneOut = (r: any) => ({ id: r.id, name: r.name, items: itemsOf(r) });

function cleanItems(db: any, worldId: string, body: any): SceneItem[] {
  const list = Array.isArray(body.items) ? body.items : [{ group: body.group, color: body.color, brightness: body.brightness, effect: body.effect, transitionMs: body.transitionMs, off: body.off }];
  if (!list.length || list.length > 40) throw new HttpError(400, 'A scene needs 1 to 40 items');
  return list.map((x: any, i: number): SceneItem => {
    const group = x?.group ? String(x.group) : '';
    if (group && !one(db, 'SELECT 1 FROM lights_groups WHERE id = ? AND world_id = ?', group, worldId)) throw new HttpError(400, `items[${i}].group is not a light group of this world`);
    const off = x?.off === true;
    const c = parseColor(x?.color ?? '#ffffff');
    if (!c && !off) throw new HttpError(400, `items[${i}].color must be a colour like #ff8800`);
    return { group, color: toHex(c ?? [0, 0, 0]), brightness: int(x?.brightness, `items[${i}].brightness`, { min: 1, max: 100, optional: true }) ?? 100, effect: cleanEffect(x?.effect), transitionMs: int(x?.transitionMs, `items[${i}].transitionMs`, { min: 0, max: 10_000, optional: true }) ?? 400, off };
  });
}

const feature: Feature = {
  id: 'lights',
  schema,
  worldMount: 'lights',
  worldRoutes: (d) => {
    installHooks(d);
    const r = Router({ mergeParams: true });
    const { db } = d;
    const W = (res: any): string => ctx(res).world.id;

    // ---- a player picks their own turn colour ----
    r.get('/me', (_req, res) => res.json({ color: one<{ color: string }>(db, 'SELECT color FROM lights_player_colors WHERE world_id = ? AND account_id = ?', W(res), me(res))?.color ?? null }));
    r.put('/me', requirePlayerOrDM, (req, res) => {
      const c = req.body?.color === null || req.body?.color === '' ? null : parseColor(req.body?.color);
      if (req.body?.color && !c) throw new HttpError(400, 'color must be a colour like #ff8800');
      if (!c) run(db, 'DELETE FROM lights_player_colors WHERE world_id = ? AND account_id = ?', W(res), me(res));
      else run(db, 'INSERT INTO lights_player_colors (world_id, account_id, color) VALUES (?, ?, ?) ON CONFLICT (world_id, account_id) DO UPDATE SET color = excluded.color', W(res), me(res), toHex(c));
      res.json({ color: c ? toHex(c) : null });
    });

    // ---- status ----
    r.get('/status', requireDM, (_req, res) => {
      const w = W(res);
      const m = memOf(d);
      res.json({
        drivers: all<any>(db, 'SELECT * FROM lights_drivers WHERE world_id = ? ORDER BY name', w).map((x) => driverOut(d, x)),
        groups: all<any>(db, 'SELECT * FROM lights_groups WHERE world_id = ? ORDER BY name', w).length,
        scenes: all<any>(db, 'SELECT * FROM lights_scenes WHERE world_id = ? ORDER BY name', w).length,
        lastScene: m.scenes.get(w) ?? null,
        hooksOn: Object.entries(getHooks(d, w)).filter(([, v]: any) => v.on).map(([k]) => k),
        limits: { updatesPerSecondPerGroup: Math.round(1000 / Math.max(1, Number(d.env.ALX_LIGHTS_MIN_MS ?? 250) || 250)), timeoutMs: 1000 },
      });
    });

    // ---- drivers ----
    r.get('/drivers', requireDM, (_req, res) => res.json(all<any>(db, 'SELECT * FROM lights_drivers WHERE world_id = ? ORDER BY name', W(res)).map((x) => driverOut(d, x))));
    r.post('/drivers', requireDM, (req, res) => {
      const kind = oneOf(req.body?.kind, 'kind', KINDS);
      const name = str(req.body?.name, 'name', { max: 60 }).trim();
      if (!name) throw new HttpError(400, 'name is required');
      if (one<any>(db, 'SELECT COUNT(*) AS n FROM lights_drivers WHERE world_id = ?', W(res))!.n >= 20) throw new HttpError(409, 'That is plenty of light drivers: remove one first');
      const cfg = cleanConfig(kind, req.body?.config ?? req.body);
      const did = id('ldr_');
      run(db, 'INSERT INTO lights_drivers (id, world_id, kind, name, config, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', did, W(res), kind, name, JSON.stringify(cfg), now());
      audit(db, W(res), me(res), 'lights.driver.add', `${kind} ${name}`);
      res.status(201).json(driverOut(d, one(db, 'SELECT * FROM lights_drivers WHERE id = ?', did)));
    });
    const driver = (res: any, did: string) => {
      const row = one<any>(db, 'SELECT * FROM lights_drivers WHERE id = ? AND world_id = ?', did, W(res));
      if (!row) throw new HttpError(404, 'Light driver not found');
      return row;
    };
    r.put('/drivers/:id', requireDM, (req, res) => {
      const row = driver(res, String(req.params.id));
      const cfg = req.body?.config !== undefined ? cleanConfig(row.kind, req.body.config, parseJson(row.config, {})) : parseJson(row.config, {});
      const name = req.body?.name !== undefined ? str(req.body.name, 'name', { max: 60 }).trim() : row.name;
      const enabled = req.body?.enabled !== undefined ? (req.body.enabled ? 1 : 0) : row.enabled;
      run(db, 'UPDATE lights_drivers SET name = ?, config = ?, enabled = ? WHERE id = ?', name, JSON.stringify(cfg), enabled, row.id);
      audit(db, W(res), me(res), 'lights.driver.update', `${row.kind} ${name}`);
      res.json(driverOut(d, one(db, 'SELECT * FROM lights_drivers WHERE id = ?', row.id)));
    });
    r.delete('/drivers/:id', requireDM, (req, res) => {
      const row = driver(res, String(req.params.id));
      run(db, 'DELETE FROM lights_drivers WHERE id = ?', row.id);
      audit(db, W(res), me(res), 'lights.driver.delete', `${row.kind} ${row.name}`);
      res.json({ ok: true });
    });
    /** The test button: sends once, waits for the answer and says what happened. */
    r.post('/drivers/:id/test', requireDM, async (req, res) => {
      const row = driver(res, String(req.params.id));
      const color = parseColor(req.body?.color ?? '#00ff66') ?? [0, 255, 102];
      let groups = linksFor(d, W(res)).filter((l) => l.driverId === row.id);
      if (req.body?.groupId) groups = groups.filter((l) => l.groupId === String(req.body.groupId));
      if (!groups.length) {
        if (row.kind !== 'wled') throw new HttpError(400, 'Add a light group for this driver first (it says which lights to use)');
        groups = [{ driverId: row.id, driverName: row.name, kind: row.kind, cfg: parseJson(row.config, {}), groupId: '', groupName: '', target: {} }];
      }
      const results: { group: string; ok: boolean; error?: string }[] = [];
      for (const g of groups) {
        try { await send(d, g.kind, g.cfg, g.target, { on: true, color, brightness: 60, effect: '', transitionMs: 200 }); results.push({ group: g.groupName, ok: true }); }
        catch (e: any) { results.push({ group: g.groupName, ok: false, error: String(e?.message ?? e).slice(0, 200) }); }
      }
      res.json({ ok: results.every((x) => x.ok), results });
    });
    /** Hue: press the bridge's button, then call this. It keeps the username the bridge hands out. */
    r.post('/drivers/:id/pair', requireDM, async (req, res) => {
      const row = driver(res, String(req.params.id));
      if (row.kind !== 'hue') throw new HttpError(400, 'Only Philips Hue bridges are paired');
      const cfg = parseJson<Record<string, any>>(row.config, {});
      let out;
      try { out = await huePair(d, cfg.host); } catch (e: any) { return void res.status(502).json({ error: `The bridge did not answer: ${String(e?.message ?? e).slice(0, 150)}` }); }
      if (out.user) {
        run(db, 'UPDATE lights_drivers SET config = ? WHERE id = ?', JSON.stringify({ ...cfg, user: out.user }), row.id);
        audit(db, W(res), me(res), 'lights.driver.pair', row.name);
        return void res.json({ paired: true, waiting: false });
      }
      res.status(out.waiting ? 409 : 502).json({ paired: false, waiting: out.waiting, error: out.waiting ? 'Press the button on the bridge, then pair again within 30 seconds.' : out.error });
    });

    // ---- groups ----
    r.get('/groups', requireDM, (_req, res) => res.json(all<any>(db, 'SELECT * FROM lights_groups WHERE world_id = ? ORDER BY name', W(res)).map(groupOut)));
    const groupFields = (res: any, b: any, cur?: any) => {
      const drv = driver(res, String(b.driverId ?? cur?.driver_id ?? ''));
      return { driver: drv, name: b.name !== undefined ? str(b.name, 'name', { max: 60 }).trim() : cur.name, target: b.target !== undefined || !cur ? cleanTarget(drv.kind, b.target) : parseJson(cur.target, {}) };
    };
    r.post('/groups', requireDM, (req, res) => {
      const f = groupFields(res, req.body ?? {});
      if (!f.name) throw new HttpError(400, 'name is required');
      if (one<any>(db, 'SELECT COUNT(*) AS n FROM lights_groups WHERE world_id = ?', W(res))!.n >= 60) throw new HttpError(409, 'That is plenty of light groups: remove one first');
      const gid = id('lgr_');
      run(db, 'INSERT INTO lights_groups (id, world_id, driver_id, name, target, created_at) VALUES (?, ?, ?, ?, ?, ?)', gid, W(res), f.driver.id, f.name, JSON.stringify(f.target), now());
      res.status(201).json(groupOut(one(db, 'SELECT * FROM lights_groups WHERE id = ?', gid)));
    });
    r.put('/groups/:id', requireDM, (req, res) => {
      const cur = one<any>(db, 'SELECT * FROM lights_groups WHERE id = ? AND world_id = ?', String(req.params.id), W(res));
      if (!cur) throw new HttpError(404, 'Light group not found');
      const f = groupFields(res, req.body ?? {}, cur);
      run(db, 'UPDATE lights_groups SET driver_id = ?, name = ?, target = ? WHERE id = ?', f.driver.id, f.name, JSON.stringify(f.target), cur.id);
      res.json(groupOut(one(db, 'SELECT * FROM lights_groups WHERE id = ?', cur.id)));
    });
    r.delete('/groups/:id', requireDM, (req, res) => {
      if (!run(db, 'DELETE FROM lights_groups WHERE id = ? AND world_id = ?', String(req.params.id), W(res))) throw new HttpError(404, 'Light group not found');
      res.json({ ok: true });
    });

    // ---- scenes ----
    r.get('/scenes', requireDM, (_req, res) => res.json(all<any>(db, 'SELECT * FROM lights_scenes WHERE world_id = ? ORDER BY name', W(res)).map(sceneOut)));
    r.post('/scenes', requireDM, (req, res) => {
      const name = str(req.body?.name, 'name', { max: 60 }).trim();
      if (!name) throw new HttpError(400, 'name is required');
      if (findScene(d, W(res), name)) throw new HttpError(409, 'A scene with that name already exists');
      const sid = id('lsc_');
      run(db, 'INSERT INTO lights_scenes (id, world_id, name, items, created_at) VALUES (?, ?, ?, ?, ?)', sid, W(res), name, JSON.stringify(cleanItems(db, W(res), req.body ?? {})), now());
      res.status(201).json(sceneOut(one(db, 'SELECT * FROM lights_scenes WHERE id = ?', sid)));
    });
    r.put('/scenes/:id', requireDM, (req, res) => {
      const cur = one<any>(db, 'SELECT * FROM lights_scenes WHERE id = ? AND world_id = ?', String(req.params.id), W(res));
      if (!cur) throw new HttpError(404, 'Scene not found');
      const b = req.body ?? {};
      const name = b.name !== undefined ? str(b.name, 'name', { max: 60 }).trim() : cur.name;
      const clash = findScene(d, W(res), name);
      if (clash && clash.id !== cur.id) throw new HttpError(409, 'A scene with that name already exists');
      const items = b.items !== undefined || b.color !== undefined ? JSON.stringify(cleanItems(db, W(res), b)) : cur.items;
      run(db, 'UPDATE lights_scenes SET name = ?, items = ? WHERE id = ?', name, items, cur.id);
      res.json(sceneOut(one(db, 'SELECT * FROM lights_scenes WHERE id = ?', cur.id)));
    });
    r.delete('/scenes/:id', requireDM, (req, res) => {
      if (!run(db, 'DELETE FROM lights_scenes WHERE id = ? AND world_id = ?', String(req.params.id), W(res))) throw new HttpError(404, 'Scene not found');
      // A hook that pointed at it simply stops lighting anything.
      res.json({ ok: true });
    });
    r.post('/scenes/:id/run', requireDM, (req, res) => {
      const out = runScene(d, W(res), String(req.params.id));
      audit(db, W(res), me(res), 'lights.scene', out.scene.name);
      res.json({ ok: true, ...out });
    });
    r.post('/off', requireDM, (_req, res) => {
      const queued = applyItems(d, W(res), [{ group: '', color: '#000000', brightness: 1, effect: '', transitionMs: 400, off: true }]);
      res.json({ ok: true, queued });
    });

    // ---- hooks ----
    r.get('/hooks', requireDM, (_req, res) => res.json(getHooks(d, W(res))));
    r.put('/hooks', requireDM, (req, res) => {
      const next = cleanHooks(d, W(res), req.body, getHooks(d, W(res)));
      saveHooks(d, W(res), next);
      audit(db, W(res), me(res), 'lights.hooks', Object.entries(next).filter(([, v]: any) => v.on).map(([k]) => k).join(','));
      res.json(next);
    });

    return r;
  },
  start: (d) => startPoll(d),
  mcpTools: [
    {
      name: 'list_light_scenes', dmOnly: true,
      description: "DM: the room's light scenes (colours and effects per light group) and whether any lights are set up. Run one with run_light_scene.",
      props: {}, call: () => ({ method: 'GET', path: '/lights/scenes' }),
    },
    {
      name: 'run_light_scene', write: true,
      description: 'DM: set the room lights to a saved light scene, by name or id (from list_light_scenes). A light that is down never stops the game.',
      props: { scene: { type: 'string', description: 'Light scene name or id' } },
      required: ['scene'],
      call: (a) => ({ method: 'POST', path: `/lights/scenes/${encodeURIComponent(String(a.scene))}/run` }),
    },
    {
      name: 'lights_off', write: true,
      description: 'DM: turn every room light off.',
      props: {}, call: () => ({ method: 'POST', path: '/lights/off' }),
    },
  ],
};
export default feature;
