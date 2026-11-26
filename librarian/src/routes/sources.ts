// Library admin: world sources. A source is a connection (the account-level
// settings and secrets, see features/connections) plus what is specific to
// one world (the campaign, the project, a folder), a schedule and an audience.
// Any connector in the registry can be added; the admin panel builds its form
// from the connector's fields, and each field says whether it belongs to the
// connection or to the source.
//
// The old API still works: a source made with all its settings in `config`
// gets a connection made for it (or an identical one reused).
import { Router } from 'express';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { one, all, run } from '../core/db.ts';
import type { Auth } from '../core/auth.ts';
import { HttpError, id, int, oneOf, str } from '../core/util.ts';
import { CONNECTORS, connectorFor, mergeSecrets } from '../intake/registry.ts';
import { ConfigError, type Connector } from '../intake/connector.ts';
import { connectorContext, getRun, isRunning, listRuns, runSync, stopSync } from '../intake/sync.ts';
import { AUDIENCES, AUDIENCE_LABEL, SECRET_MASK, adoptSource, effectiveConfig, forceRecordsDm, getConnection, maskedConfig, normAudience, splitConfig, type SourceAudience } from '../intake/connections.ts';
import { BUILTIN_PRESETS } from '../intake/presets.ts';
import { embeddingCoverage } from '../features/search/embeddings.ts';
import { worldStatus } from '../features/connections/status.ts';
import { crawlRunning, latestCrawl, levelCounts, shapeCrawl, startCrawl, stopCrawl } from '../features/connections/crawl.ts';

/** The picker order: the dedicated connectors first, the generic API (with its presets) last. */
const ORDER = ['legendkeeper-mcp', 'legendkeeper-api', 'kanka-api', 'kanka-mcp', 'worldanvil-api', 'markdown-folder', 'obsidian-sync', 'obsidian-rest', 'obsidian-publish', 'git', 'mcp-files', 'push', 'api'];

export default function sourceRoutes(d: Deps) {
  const r = Router();
  const { db } = d;
  const me = (res: any) => (res.locals.auth as Auth).account.id;
  const deps = () => ({ db, library: d.library, dataDir: d.dataDir, vaultsDir: d.vaultsDir, fetch: d.fetch, env: d.env, mcp: d.testMcp });
  const parse = (s: unknown): Record<string, any> => { try { return JSON.parse(String(s || '{}')); } catch { return {}; } };

  const shape = (s: any) => {
    const own = parse(s.config);
    const cfg = effectiveConfig(db, s);
    const c = connectorFor(s.kind, own);
    const conn = getConnection(db, s.connection_id);
    const last = one<any>(db, 'SELECT id, status, started_at, finished_at, stats, error FROM sync_runs WHERE source_id = ? ORDER BY started_at DESC LIMIT 1', s.id);
    const audience = normAudience(s.audience);
    return {
      id: s.id, world_id: s.world_id, kind: c?.id ?? s.kind, connector: c ? { id: c.id, label: c.label } : null, name: s.name,
      connection: conn ? { id: conn.id, name: conn.name } : null,
      config: maskedConfig(c, cfg), default_visibility: s.default_visibility, schedule_minutes: s.schedule_minutes,
      audience, audience_label: AUDIENCE_LABEL[audience],
      enabled: !!s.enabled, running: isRunning(s.id), last_sync_at: s.last_sync_at, last_status: s.last_status,
      last_run: last ? { ...last, stats: JSON.parse(last.stats || '{}') } : null,
      pages: one<any>(db, 'SELECT COUNT(*) AS n FROM pages WHERE source_id = ?', s.id)!.n,
    };
  };

  const defaultOf = (c: Connector, k: string) => c.fields.find((f) => f.key === k)?.default;
  const visible = (c: Connector, f: Connector['fields'][number], cfg: any) => !f.showIf || Object.entries(f.showIf).every(([k, v]) => (cfg[k] ?? defaultOf(c, k)) === v);

  /** The settings a source would run with must be complete and valid for its connector. */
  const validated = (kind: string, cfg: Record<string, any>) => {
    const c = connectorFor(kind, cfg);
    if (!c) throw new HttpError(400, `Unknown kind of source: ${kind}`);
    for (const f of c.fields) if (f.required && (cfg[f.key] === undefined || cfg[f.key] === '') && visible(c, f, cfg)) throw new HttpError(400, `${f.label} is required`);
    try {
      c.validate(cfg, { vaultsDir: d.vaultsDir, env: d.env });
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
    return c;
  };

  const connectionFor = (cid: unknown, kind?: string) => {
    const conn = getConnection(db, String(cid));
    if (!conn) throw new HttpError(404, 'Connection not found');
    const c = connectorFor(conn.kind);
    if (!c) throw new HttpError(409, 'That connection is of a kind the librarian no longer knows');
    if (kind && connectorFor(kind)?.id !== c.id) throw new HttpError(400, `That connection is for ${c.label}, not ${kind}`);
    return { conn, c };
  };

  /** Audience changes: sharing with players needs an explicit yes, and every change is in the audit log. */
  const audienceOf = (b: any, fallback: SourceAudience): SourceAudience => (b.audience === undefined ? fallback : oneOf(b.audience, 'audience', AUDIENCES));
  const needConfirm = (next: SourceAudience, prev: SourceAudience, b: any) => {
    if (next === 'party' && prev !== 'party' && b.confirmParty !== true) throw new HttpError(400, 'Sharing everything from a source with players needs confirmation: send confirmParty: true. Secret, broker and classified parts of a page stay hidden either way.');
  };
  const applyAudience = (s: any, prev: SourceAudience, next: SourceAudience, res: any) => {
    audit(db, s.world_id, me(res), 'source.audience', `${s.id} ${prev} -> ${next}${next === 'party' ? ' (confirmed by the admin)' : ''}`.slice(0, 480));
    if (next === 'dm') forceRecordsDm(db, s.id);
    return d.library.applyAudience(s.world_id, s.id);
  };

  r.get('/connectors', (_req, res) => {
    const sorted = [...CONNECTORS].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
    res.json(sorted.map((c) => ({
      id: c.id, label: c.label, description: c.description, capabilities: c.capabilities, push: !!c.push, fields: c.fields,
      group: c.id === 'api' ? 'generic' : 'dedicated', hasConnection: c.fields.some((f) => f.scope === 'connection'),
      ...(c.id === 'api' ? { presets: [...BUILTIN_PRESETS, ...all<any>(db, 'SELECT * FROM connection_presets ORDER BY name').map((p) => ({ id: p.id, name: p.name, description: p.description, config: parse(p.config), builtin: false, unverified: false }))] } : {}),
    })));
  });

  r.get('/sources', (_req, res) => res.json(all<any>(db, 'SELECT * FROM sources ORDER BY name').map(shape)));
  r.get('/worlds/:id/sources', (req, res) => res.json(all<any>(db, 'SELECT * FROM sources WHERE world_id = ? ORDER BY name', String(req.params.id)).map(shape)));

  r.post('/worlds/:id/sources', (req, res) => {
    const wid = String(req.params.id);
    if (!one(db, 'SELECT 1 FROM worlds WHERE id = ?', wid)) throw new HttpError(404, 'World not found');
    const input = req.body?.config && typeof req.body.config === 'object' && !Array.isArray(req.body.config) ? req.body.config : {};
    let c: Connector;
    let connectionId: string | null = null;
    let own: Record<string, any> = input;
    if (req.body?.connectionId) {
      const x = connectionFor(req.body.connectionId, typeof req.body?.kind === 'string' ? req.body.kind : undefined);
      c = x.c;
      connectionId = x.conn.id;
      own = splitConfig(c, input).source; // the connection's settings come from the connection, never from here
      validated(c.id, effectiveConfig(db, { kind: c.id, config: JSON.stringify(own), connection_id: connectionId }));
    } else {
      c = validated(str(req.body?.kind, 'kind', { max: 40 }), input);
    }
    const sid = id('src_');
    const vis = oneOf(req.body?.defaultVisibility, 'defaultVisibility', ['dm', 'party'] as const, 'dm');
    const audience = audienceOf(req.body ?? {}, 'auto');
    needConfirm(audience, 'auto', req.body ?? {});
    const sched = req.body?.scheduleMinutes === null ? null : int(req.body?.scheduleMinutes, 'scheduleMinutes', { min: 5, max: 10080, optional: true });
    run(db, 'INSERT INTO sources (id, world_id, kind, name, config, default_visibility, schedule_minutes, connection_id, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      sid, wid, c.id, str(req.body?.name, 'name', { max: 80 }), JSON.stringify(own), vis, sched, connectionId, audience);
    // The old way: all settings in one config. Give the source a connection (or reuse an identical one).
    if (!connectionId) adoptSource(db, { id: sid, kind: c.id, config: JSON.stringify(own), name: String(req.body?.name) });
    audit(db, wid, me(res), 'source.create', `${c.id} ${sid}`);
    if (audience !== 'auto') audit(db, wid, me(res), 'source.audience', `${sid} auto -> ${audience}${audience === 'party' ? ' (confirmed by the admin)' : ''}`);
    res.status(201).json(shape(one<any>(db, 'SELECT * FROM sources WHERE id = ?', sid)));
  });

  r.patch('/sources/:sid', (req, res) => {
    const s = one<any>(db, 'SELECT * FROM sources WHERE id = ?', String(req.params.sid));
    if (!s) throw new HttpError(404, 'Source not found');
    const b = req.body ?? {};
    let own = parse(s.config);
    if (b.config && typeof b.config === 'object' && !Array.isArray(b.config)) {
      const c = connectorFor(s.kind, own)!;
      if (s.connection_id) {
        // The connection's own settings are changed on the connection, which other sources use too.
        const conn = getConnection(db, s.connection_id);
        const { connection, source } = splitConfig(c, b.config);
        const cur = parse(conn?.config);
        for (const [k, v] of Object.entries(connection)) {
          if (v === SECRET_MASK || v === '' || v === undefined || v === null) continue;
          if (String(v) !== String(cur[k] ?? '')) throw new HttpError(409, `"${k}" belongs to the connection "${conn?.name}", which other sources may use. Change it in Admin > Connections.`);
        }
        own = mergeSecrets(c, source, own);
      } else own = mergeSecrets(c, b.config, own);
      validated(s.kind, effectiveConfig(db, { kind: s.kind, config: JSON.stringify(own), connection_id: s.connection_id }));
    }
    const prevAud = normAudience(s.audience);
    const nextAud = audienceOf(b, prevAud);
    if (nextAud !== prevAud) needConfirm(nextAud, prevAud, b);
    run(db, 'UPDATE sources SET name = ?, config = ?, default_visibility = ?, schedule_minutes = ?, enabled = ?, audience = ? WHERE id = ?',
      b.name !== undefined ? str(b.name, 'name', { max: 80 }) : s.name, JSON.stringify(own),
      b.defaultVisibility !== undefined ? oneOf(b.defaultVisibility, 'defaultVisibility', ['dm', 'party'] as const) : s.default_visibility,
      b.scheduleMinutes !== undefined ? (b.scheduleMinutes === null ? null : int(b.scheduleMinutes, 'scheduleMinutes', { min: 5, max: 10080 })) : s.schedule_minutes,
      b.enabled !== undefined ? (b.enabled ? 1 : 0) : s.enabled, nextAud, s.id);
    audit(db, s.world_id, me(res), 'source.update', s.id);
    // The default switch changes what an `auto` source shares: the pages already saved follow it at the next sync.
    if (nextAud !== prevAud) applyAudience(s, prevAud, nextAud, res);
    // The default visibility is what lets a page the source calls shared through: pages already read follow it now, not at the next sync.
    else if (b.defaultVisibility !== undefined && b.defaultVisibility !== s.default_visibility) {
      audit(db, s.world_id, me(res), 'source.visibility', `${s.id} ${s.default_visibility} -> ${b.defaultVisibility}`.slice(0, 480));
      d.library.applyAudience(s.world_id, s.id);
    }
    // Moving a source to another connection of the same kind.
    if (b.connectionId !== undefined && b.connectionId !== s.connection_id) {
      if (b.connectionId === null) throw new HttpError(400, 'A source cannot be detached from its connection');
      const x = connectionFor(b.connectionId, s.kind);
      run(db, 'UPDATE sources SET connection_id = ? WHERE id = ?', x.conn.id, s.id);
      audit(db, s.world_id, me(res), 'source.connection', `${s.id} -> ${x.conn.id}`);
    }
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
    const input = req.body?.config && typeof req.body.config === 'object' ? req.body.config : {};
    if (req.body?.connectionId) {
      const { conn, c } = connectionFor(req.body.connectionId, typeof req.body?.kind === 'string' ? req.body.kind : undefined);
      const cfg = effectiveConfig(db, { kind: c.id, config: JSON.stringify(splitConfig(c, input).source), connection_id: conn.id });
      return res.json(await test(c.id, cfg, { id: 'test', default_visibility: 'dm', audience: 'dm' }));
    }
    res.json(await test(str(req.body?.kind, 'kind', { max: 40 }), input, { id: 'test', default_visibility: 'dm', audience: 'dm' }));
  });
  r.post('/sources/:sid/test', async (req, res) => {
    const s = one<any>(db, 'SELECT * FROM sources WHERE id = ?', String(req.params.sid));
    if (!s) throw new HttpError(404, 'Source not found');
    res.json(await test(s.kind, effectiveConfig(db, s), s));
  });

  // Start a sync. ?wait=1 waits for the result; otherwise it runs in the background.
  r.post('/sources/:sid/sync', async (req, res) => {
    const s = one<any>(db, 'SELECT * FROM sources WHERE id = ?', String(req.params.sid));
    if (!s) throw new HttpError(404, 'Source not found');
    if (connectorFor(s.kind, parse(s.config))?.push) throw new HttpError(400, 'A push source receives entries from your tool; there is nothing to sync');
    audit(db, s.world_id, me(res), 'source.sync', s.id);
    const p = runSync(deps(), s.id, me(res), { tiered: true, full: req.body?.full === true });
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

  // ---- the world page: sources, levels, embeddings, crawl ---------------------

  const world = (req: any) => {
    const w = one<any>(db, 'SELECT id, slug, name FROM worlds WHERE id = ?', String(req.params.id));
    if (!w) throw new HttpError(404, 'World not found');
    return w;
  };

  r.get('/worlds/:id/overview', (req, res) => {
    const w = world(req);
    const sources = all<any>(db, 'SELECT * FROM sources WHERE world_id = ? ORDER BY name', w.id).map(shape);
    const levels = levelCounts(d, w.id);
    res.json({
      world: w, sources, levels, pages: Object.values(levels).reduce((a, b) => a + b, 0),
      embeddings: embeddingCoverage(d, w.id), crawl: latestCrawl(d, w.id), crawling: crawlRunning(w.id), status: worldStatus(d, w.id),
    });
  });

  // The crawl: a first full sync of the world's sources, then embeddings for every page. Cancel it with /crawl/stop.
  r.post('/worlds/:id/crawl', (req, res) => {
    const w = world(req);
    const ids = Array.isArray(req.body?.sourceIds) ? req.body.sourceIds.map(String) : undefined;
    const out = startCrawl(d, w.id, { mode: 'crawl', sourceIds: ids, by: me(res), full: req.body?.full === true });
    audit(db, w.id, me(res), 'world.crawl', out.id);
    res.status(202).json({ started: true, id: out.id });
  });
  r.post('/worlds/:id/reindex', (req, res) => {
    const w = world(req);
    const out = startCrawl(d, w.id, { mode: 'reindex', by: me(res) });
    audit(db, w.id, me(res), 'world.reindex', out.id);
    res.status(202).json({ started: true, id: out.id });
  });
  r.post('/worlds/:id/crawl/stop', (req, res) => {
    const w = world(req);
    res.json({ ok: true, stopped: stopCrawl(w.id) });
  });
  r.get('/worlds/:id/crawls', (req, res) => {
    const w = world(req);
    res.json(all<any>(db, 'SELECT id, world_id, mode, status, progress, error, started_at, finished_at FROM connections_crawls WHERE world_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 10', w.id).map((x) => shapeCrawl(x)));
  });
  r.get('/crawls/:cid', (req, res) => {
    const row = one<any>(db, 'SELECT * FROM connections_crawls WHERE id = ?', String(req.params.cid));
    if (!row) throw new HttpError(404, 'Crawl not found');
    res.json(shapeCrawl(row, true));
  });

  return r;
}
