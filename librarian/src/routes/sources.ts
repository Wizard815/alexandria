// Library admin: world sources. Any connector in the registry can be added;
// the admin panel builds its form from the connector's fields.
import { Router } from 'express';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { one, all, run } from '../core/db.ts';
import type { Auth } from '../core/auth.ts';
import { HttpError, id, int, oneOf, str } from '../core/util.ts';
import { CONNECTORS, connectorFor, mergeSecrets, publicConfig } from '../intake/registry.ts';
import { ConfigError } from '../intake/connector.ts';
import { connectorContext, getRun, isRunning, listRuns, runSync, stopSync } from '../intake/sync.ts';

export default function sourceRoutes(d: Deps) {
  const r = Router();
  const { db } = d;
  const me = (res: any) => (res.locals.auth as Auth).account.id;
  const deps = () => ({ db, library: d.library, dataDir: d.dataDir, vaultsDir: d.vaultsDir, fetch: d.fetch, env: d.env, mcp: d.testMcp });

  const shape = (s: any) => {
    const c = connectorFor(s.kind, JSON.parse(s.config || '{}'));
    const last = one<any>(db, 'SELECT id, status, started_at, finished_at, stats, error FROM sync_runs WHERE source_id = ? ORDER BY started_at DESC LIMIT 1', s.id);
    return {
      id: s.id, world_id: s.world_id, kind: c?.id ?? s.kind, connector: c ? { id: c.id, label: c.label } : null, name: s.name,
      config: publicConfig(c, JSON.parse(s.config || '{}')), default_visibility: s.default_visibility, schedule_minutes: s.schedule_minutes,
      enabled: !!s.enabled, running: isRunning(s.id), last_sync_at: s.last_sync_at, last_status: s.last_status,
      last_run: last ? { ...last, stats: JSON.parse(last.stats || '{}') } : null,
      pages: one<any>(db, 'SELECT COUNT(*) AS n FROM pages WHERE source_id = ?', s.id)!.n,
    };
  };

  const validated = (kind: string, cfg: Record<string, any>) => {
    const c = connectorFor(kind, cfg);
    if (!c) throw new HttpError(400, `Unknown kind of source: ${kind}`);
    for (const f of c.fields) if (f.required && (cfg[f.key] === undefined || cfg[f.key] === '') && visible(f, cfg)) throw new HttpError(400, `${f.label} is required`);
    try {
      c.validate(cfg, { vaultsDir: d.vaultsDir, env: d.env });
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
    return c;
  };
  const visible = (f: any, cfg: any) => !f.showIf || Object.entries(f.showIf).every(([k, v]) => (cfg[k] ?? c0(f, k)) === v);
  const c0 = (_f: any, _k: string) => undefined;

  r.get('/connectors', (_req, res) => {
    res.json(CONNECTORS.map((c) => ({ id: c.id, label: c.label, description: c.description, fields: c.fields })));
  });

  r.get('/sources', (_req, res) => res.json(all<any>(db, 'SELECT * FROM sources ORDER BY name').map(shape)));
  r.get('/worlds/:id/sources', (req, res) => res.json(all<any>(db, 'SELECT * FROM sources WHERE world_id = ? ORDER BY name', String(req.params.id)).map(shape)));

  r.post('/worlds/:id/sources', (req, res) => {
    const wid = String(req.params.id);
    if (!one(db, 'SELECT 1 FROM worlds WHERE id = ?', wid)) throw new HttpError(404, 'World not found');
    const cfg = req.body?.config && typeof req.body.config === 'object' ? req.body.config : {};
    const c = validated(str(req.body?.kind, 'kind', { max: 40 }), cfg);
    const sid = id('src_');
    const vis = oneOf(req.body?.defaultVisibility, 'defaultVisibility', ['dm', 'party'] as const, 'dm');
    const sched = req.body?.scheduleMinutes === null ? null : int(req.body?.scheduleMinutes, 'scheduleMinutes', { min: 5, max: 10080, optional: true });
    run(db, 'INSERT INTO sources (id, world_id, kind, name, config, default_visibility, schedule_minutes) VALUES (?, ?, ?, ?, ?, ?, ?)', sid, wid, c.id, str(req.body?.name, 'name', { max: 80 }), JSON.stringify(cfg), vis, sched);
    audit(db, wid, me(res), 'source.create', `${c.id} ${sid}`);
    res.status(201).json(shape(one<any>(db, 'SELECT * FROM sources WHERE id = ?', sid)));
  });

  r.patch('/sources/:sid', (req, res) => {
    const s = one<any>(db, 'SELECT * FROM sources WHERE id = ?', String(req.params.sid));
    if (!s) throw new HttpError(404, 'Source not found');
    const b = req.body ?? {};
    let cfg = JSON.parse(s.config || '{}');
    if (b.config && typeof b.config === 'object') {
      const c = connectorFor(s.kind, cfg)!;
      cfg = mergeSecrets(c, b.config, cfg);
      validated(s.kind, cfg);
    }
    run(db, 'UPDATE sources SET name = ?, config = ?, default_visibility = ?, schedule_minutes = ?, enabled = ? WHERE id = ?',
      b.name !== undefined ? str(b.name, 'name', { max: 80 }) : s.name, JSON.stringify(cfg),
      b.defaultVisibility !== undefined ? oneOf(b.defaultVisibility, 'defaultVisibility', ['dm', 'party'] as const) : s.default_visibility,
      b.scheduleMinutes !== undefined ? (b.scheduleMinutes === null ? null : int(b.scheduleMinutes, 'scheduleMinutes', { min: 5, max: 10080 })) : s.schedule_minutes,
      b.enabled !== undefined ? (b.enabled ? 1 : 0) : s.enabled, s.id);
    audit(db, s.world_id, me(res), 'source.update', s.id);
    res.json(shape(one<any>(db, 'SELECT * FROM sources WHERE id = ?', s.id)));
  });

  // Try settings before saving them ({kind, config}), or a saved source.
  async function test(kind: string, cfg: any, src: any) {
    const c = validated(kind, cfg);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30_000);
    const lines: string[] = [];
    const made = connectorContext(deps(), { ...src, kind: c.id }, cfg, ctl.signal, (m) => lines.push(m));
    try {
      return await c.test(cfg, made.ctx);
    } catch (err: any) {
      return { ok: false, message: err instanceof ConfigError ? err.message : `Could not connect: ${String(err.message).slice(0, 200)}` };
    } finally {
      clearTimeout(t);
      made.close();
    }
  }
  r.post('/sources/test', async (req, res) => {
    const cfg = req.body?.config && typeof req.body.config === 'object' ? req.body.config : {};
    res.json(await test(str(req.body?.kind, 'kind', { max: 40 }), cfg, { id: 'test', default_visibility: 'dm' }));
  });
  r.post('/sources/:sid/test', async (req, res) => {
    const s = one<any>(db, 'SELECT * FROM sources WHERE id = ?', String(req.params.sid));
    if (!s) throw new HttpError(404, 'Source not found');
    res.json(await test(s.kind, JSON.parse(s.config || '{}'), s));
  });

  // Start a sync. ?wait=1 waits for the result; otherwise it runs in the background.
  r.post('/sources/:sid/sync', async (req, res) => {
    const s = one<any>(db, 'SELECT * FROM sources WHERE id = ?', String(req.params.sid));
    if (!s) throw new HttpError(404, 'Source not found');
    audit(db, s.world_id, me(res), 'source.sync', s.id);
    const p = runSync(deps(), s.id, me(res));
    if (req.query.wait) {
      const out = await p;
      if (out.status !== 'ok') throw new HttpError(502, `Sync failed: ${out.error ?? out.status}`);
      return res.json({ ...out, pages: out.stats.pages });
    }
    p.catch(() => {});
    await new Promise((r2) => setTimeout(r2, 20));
    res.status(202).json({ started: true, run: listRuns(db, s.id, 1)[0] ?? null });
  });
  r.post('/sources/:sid/stop', (req, res) => {
    stopSync(String(req.params.sid));
    res.json({ ok: true });
  });
  r.get('/sources/:sid/runs', (req, res) => res.json(listRuns(db, String(req.params.sid), Math.min(Number(req.query.limit) || 20, 100))));
  r.get('/runs/:rid', (req, res) => {
    const out = getRun(db, String(req.params.rid));
    if (!out) throw new HttpError(404, 'Run not found');
    res.json(out);
  });

  // Delete a source. ?pages=1 also deletes the pages it imported.
  r.delete('/sources/:sid', (req, res) => {
    const s = one<any>(db, 'SELECT * FROM sources WHERE id = ?', String(req.params.sid));
    if (!s) throw new HttpError(404, 'Source not found');
    stopSync(s.id);
    if (req.query.pages) d.library.removeMissing(s.world_id, s.id, new Set());
    run(db, 'DELETE FROM sources WHERE id = ?', s.id);
    d.library.rebuildPlayerCopies(s.world_id);
    audit(db, s.world_id, me(res), 'source.delete', `${s.id}${req.query.pages ? ' with pages' : ''}`);
    res.json({ ok: true });
  });

  return r;
}
