// Connections: the account-level half of a world source (a Kanka token, a
// LegendKeeper API key, an MCP URL, a generic API's auth and field mapping),
// kept once and shared by every world that uses it. A source is then a
// connection plus what is specific to one world, a schedule and an audience
// (see docs/CONNECTORS.md).
//
//   GET/POST          /api/admin/connections
//   GET/PATCH/DELETE  /api/admin/connections/:id
//   POST              /api/admin/connections/test | /:id/test
//   GET/POST/DELETE   /api/admin/connections/presets ... (generic API presets, import, export)
//   POST              /api/admin/connections/api-discover (generic API: find the spec, guess the endpoints)
//   POST              /api/admin/connections/mcp-discover (generic API over MCP: list the server's tools, guess the list and read tools)
//   PUT               /api/admin/connections/:id/endpoints (the reviewed endpoint list)
//   GET               /api/admin/connections/tiers/world/:world (each source's tiers: index, details, budget)
//   PATCH             /api/admin/connections/tiers/:source (background budget, pause, fetch everything, spread the first scan, the connection's calls-per-minute/second limits)
//   GET               /api/worlds/:world/world-sources   (GM: the sources; players: nothing)
//   GET               /api/worlds/:world/world-sources/depths (GM: pages not yet read in full)
//   GET               /api/worlds/:world/world-sources/status (GM: why players see nothing, a refused key, a wait for the site)
//   MCP               world_sources
//
// The world pages (overview, crawl, re-index) are in routes/sources.ts.
// Secrets are never returned: the panel gets "••••" and sends it back to keep one.
import { Router } from 'express';
import type { Deps } from '../../app.ts';
import type { Feature } from '../types.ts';
import { all, one, run } from '../../core/db.ts';
import type { Auth } from '../../core/auth.ts';
import { HttpError, id, now, str } from '../../core/util.ts';
import { ctx, isDM } from '../../routes/_shared.ts';
import { pageLevel } from '../../core/levels.ts';
import { ConfigError, type Connector } from '../../intake/connector.ts';
import { CONNECTORS, connectorFor, makeMcpFactory } from '../../intake/registry.ts';
import { AUDIENCE_LABEL, SECRET_MASK, connectionKeys, createConnection, getConnection, hasConnection, keepSecrets, maskedConfig, migrateSources, normAudience, splitConfig, type ConnectionRow } from '../../intake/connections.ts';
import { BUILTIN_PRESETS, cleanPresetConfig, cleanPresetName, exportPreset, parsePresetImport, type Preset } from '../../intake/presets.ts';
import { connectorContext } from '../../intake/sync.ts';
import { dmOnly } from '../../core/events.ts';
import { cleanEndpoints } from '../../intake/connectors/apiEndpoints.ts';
import { discoverApi, guessMcpTools } from '../../intake/connectors/apiSetup.ts';
import { startDetailWorker, tierSummary } from '../../intake/detail.ts';
import { TIER_SCHEMA, depthsOf, ensureTierSchema, setSettings } from '../../intake/tiers.ts';
import { CRAWL_SCHEMA } from './crawl.ts';
import { sourceSummary } from './summary.ts';
import { worldStatus } from './status.ts';

const schema = `
-- A connection: one connector's account-level settings and secrets, used by any number of sources in any number of worlds.
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Saved field mappings for the generic API connector. Not tied to a world and holding no secret.
CREATE TABLE IF NOT EXISTS connection_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
${CRAWL_SCHEMA}
${TIER_SCHEMA}
`;

const audit = (d: Deps, res: any, action: string, detail: string, worldId: string | null = null) =>
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, (res.locals.auth as Auth)?.account?.id ?? null, action, detail.slice(0, 500), now());

const parse = (s: string | null | undefined): Record<string, any> => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const defaultOf = (c: Connector, k: string) => c.fields.find((f) => f.key === k)?.default;
const visible = (c: Connector, f: Connector['fields'][number], cfg: Record<string, any>) => !f.showIf || Object.entries(f.showIf).every(([k, v]) => (cfg[k] ?? defaultOf(c, k)) === v);

/** The connection part of settings: only known connection keys, plain values, required ones present. */
function connectionConfig(c: Connector, input: unknown, prev: Record<string, any> = {}): Record<string, any> {
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) throw new HttpError(400, 'config must be an object');
  const keys = connectionKeys(c);
  const kept = keepSecrets(c, (input ?? {}) as Record<string, any>, prev);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(kept)) {
    if (!keys.has(k) || v === undefined || v === null || v === '') continue;
    out[k] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, k === 'endpoints' ? 60_000 : 4000);
  }
  for (const f of c.fields) if (f.scope === 'connection' && f.required && visible(c, f, out) && (out[f.key] === undefined || out[f.key] === '')) throw new HttpError(400, `${f.label} is required`);
  return out;
}

/** Sources by world for a connection (names only: this is the admin panel). */
const usage = (d: Deps, cid: string) => all<any>(d.db, 'SELECT s.id AS source_id, s.name AS source_name, s.world_id, w.name AS world_name FROM sources s JOIN worlds w ON w.id = s.world_id WHERE s.connection_id = ? ORDER BY w.name, s.name', cid);

function shapeConnection(d: Deps, r: ConnectionRow, withUsage = false) {
  const c = connectorFor(r.kind);
  const uses = usage(d, r.id);
  return {
    id: r.id, name: r.name, kind: c?.id ?? r.kind, connector: c ? { id: c.id, label: c.label } : null,
    config: maskedConfig(c, parse(r.config)), notes: r.notes, sources: uses.length, worlds: new Set(uses.map((u) => u.world_id)).size,
    created_at: r.created_at, updated_at: r.updated_at, ...(withUsage ? { usage: uses } : {}),
  };
}

const presetRow = (r: any): Preset => ({ id: r.id, name: r.name, description: r.description, config: parse(r.config), builtin: false, unverified: false });
const allPresets = (d: Deps): Preset[] => [...BUILTIN_PRESETS, ...all<any>(d.db, 'SELECT * FROM connection_presets ORDER BY name').map(presetRow)];
const findPreset = (d: Deps, pid: string) => BUILTIN_PRESETS.find((p) => p.id === pid) ?? (() => { const r = one<any>(d.db, 'SELECT * FROM connection_presets WHERE id = ?', pid); return r ? presetRow(r) : null; })();

/**
 * Try a connection. A connector needs a campaign or a project to read anything,
 * so the test takes a `sample` of the world-specific settings; without one it
 * says what is missing instead of guessing.
 */
async function testConnection(d: Deps, c: Connector, connection: Record<string, any>, sample: unknown) {
  const own = sample && typeof sample === 'object' && !Array.isArray(sample) ? splitConfig(c, sample as Record<string, any>).source : {};
  const cfg = { ...own, ...connection };
  const missing = c.fields.filter((f) => f.scope !== 'connection' && f.required && visible(c, f, cfg) && (cfg[f.key] === undefined || cfg[f.key] === '')).map((f) => f.label);
  if (missing.length) return { ok: false, message: `To try this connection, add a sample of: ${missing.join(', ')}.` };
  try { c.validate(cfg, { vaultsDir: d.vaultsDir, env: d.env }); } catch (err: any) { return { ok: false, message: err.message }; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  const made = connectorContext({ db: d.db, library: d.library, dataDir: d.dataDir, vaultsDir: d.vaultsDir, fetch: d.fetch, env: d.env, mcp: d.testMcp }, { id: 'test', kind: c.id, default_visibility: 'dm', audience: 'dm' }, cfg, ctl.signal, () => {});
  try { return await c.test(cfg, made.ctx); } catch (err: any) {
    return { ok: false, message: err instanceof ConfigError ? err.message : `Could not connect: ${String(err.message).slice(0, 200)}` };
  } finally { clearTimeout(timer); made.close(); }
}

const feature: Feature = {
  id: 'connections',
  schema,
  migrate(db) {
    // Pages saved before audiences: what the source said is what they are, and what marks them on their own is read from their tags.
    for (const p of all<any>(db, `SELECT id, visibility, tags, frontmatter FROM pages WHERE source_id IS NOT NULL AND source_level IS NULL`)) {
      let tags: unknown = []; let fm: any = {};
      try { tags = JSON.parse(p.tags || '[]'); fm = JSON.parse(p.frontmatter || '{}'); } catch { /* no tags */ }
      const m = pageLevel({ visibility: 'party', tags, frontmatter: fm });
      run(db, 'UPDATE pages SET source_level = ?, marker_level = ? WHERE id = ?', p.visibility, p.visibility === 'broker' || p.visibility === 'classified' ? p.visibility : m, p.id);
    }
    // Depth columns on pages (index, summary, full) for the tiered crawl.
    ensureTierSchema(db);
    // A crawl the server stopped under is not running any more.
    run(db, `UPDATE connections_crawls SET status = 'stopped', finished_at = ? WHERE status = 'running'`, now());
    migrateSources(db);
  },

  adminMount: 'connections',
  adminRoutes: (d: Deps) => {
    const r = Router();

    r.get('/', (_req, res) => res.json(all<ConnectionRow>(d.db, 'SELECT * FROM connections ORDER BY name').map((x) => shapeConnection(d, x))));

    r.post('/', (req, res) => {
      const c = connectorFor(str(req.body?.kind, 'kind', { max: 40 }));
      if (!c) throw new HttpError(400, 'Unknown kind of connection');
      if (!hasConnection(c)) throw new HttpError(400, `${c.label} has no account settings to keep: add it as a source of a world and give it its folder or address there`);
      let base: Record<string, any> = {};
      if (req.body?.presetId !== undefined) {
        if (c.id !== 'api') throw new HttpError(400, 'Presets are for the generic API connector');
        const p = findPreset(d, String(req.body.presetId));
        if (!p) throw new HttpError(404, 'Preset not found');
        base = { ...p.config };
      }
      const incoming = req.body?.config && typeof req.body.config === 'object' ? req.body.config : {};
      const cfg = connectionConfig(c, { ...base, ...incoming });
      const row = createConnection(d.db, { name: str(req.body?.name, 'name', { max: 80 }), kind: c.id, config: cfg, notes: str(req.body?.notes, 'notes', { max: 1000, optional: true }) ?? '' });
      audit(d, res, 'connection.create', `${c.id} ${row.id}`);
      res.status(201).json(shapeConnection(d, row, true));
    });


    // ---- generic API: find the endpoints and guess the fields -------------------------------------
    // Looks for an OpenAPI or Swagger spec; without one, one sample call to the base URL and to each list URL given.
    // Nothing is saved: the answer is a table of endpoints (role, mapping, confidence) for the GM to review.
    r.post('/api-discover', async (req, res) => {
      const b = req.body ?? {};
      let token = typeof b.token === 'string' && b.token !== SECRET_MASK ? b.token : undefined;
      let authHeader = typeof b.authHeader === 'string' && b.authHeader ? b.authHeader : undefined;
      if (b.connectionId) {
        const conn = getConnection(d.db, String(b.connectionId));
        if (!conn || conn.kind !== 'api') throw new HttpError(404, 'Generic API connection not found');
        const cc = parse(conn.config);
        if (token === undefined) token = cc.token;
        if (authHeader === undefined) authHeader = cc.authHeader;
        if (!b.baseUrl) b.baseUrl = cc.baseUrl;
      }
      const baseUrl = str(b.baseUrl, 'baseUrl', { max: 500 });
      const listUrls = Array.isArray(b.listUrls) ? b.listUrls.map((x: unknown) => String(x).slice(0, 500)).filter(Boolean).slice(0, 2) : [];
      try {
        const out = await discoverApi(d.fetch, { baseUrl, token, authHeader, listUrls });
        audit(d, res, 'connection.discover', `${out.source} ${out.calls} calls ${out.endpoints.length} endpoints`);
        res.json(out);
      } catch (e: any) { throw new HttpError(400, e.message); }
    });

    // Generic API over an MCP server: which tool lists, which one reads one item. Asks the server for its tool list (no tool is called).
    r.post('/mcp-discover', async (req, res) => {
      const b = req.body ?? {};
      let cfg: Record<string, any> = {};
      if (b.connectionId) {
        const conn = getConnection(d.db, String(b.connectionId));
        if (!conn || conn.kind !== 'api') throw new HttpError(404, 'Generic API connection not found');
        cfg = parse(conn.config);
      }
      const inc = b.config && typeof b.config === 'object' ? b.config : {};
      for (const k of ['server', 'mcpUrl', 'mcpToken']) if (typeof inc[k] === 'string' && inc[k] !== SECRET_MASK && inc[k] !== '') cfg[k] = inc[k].slice(0, 500);
      if (!cfg.server && !cfg.mcpUrl) throw new HttpError(400, 'Give a local MCP server name or an MCP URL');
      const c = connectorFor('api')!;
      const made = makeMcpFactory(c, { ...cfg, transport: 'mcp', tool: 'list' }, d.env, d.fetch, d.testMcp);
      try {
        const tools = await Promise.race([made.factory().listTools(), new Promise<never>((_, no) => setTimeout(() => no(new Error('The MCP server did not answer in time')), 20_000))]);
        const guess = guessMcpTools(tools, typeof b.listTool === 'string' && b.listTool ? b.listTool : cfg.tool || undefined);
        audit(d, res, 'connection.mcp-discover', `${tools.length} tools`);
        res.json({ tools: tools.map((t) => t.name), ...guess });
      } catch (e: any) { throw new HttpError(400, `Could not list the server's tools: ${String(e.message).slice(0, 200)}`); } finally { made.close(); }
    });

    // The GM's reviewed list: each endpoint's role and mapping, or "unused". Saved on the connection; a preset can be made from it.
    r.put('/:cid/endpoints', (req, res) => {
      const row = getConnection(d.db, String(req.params.cid));
      if (!row || row.kind !== 'api') throw new HttpError(404, 'Generic API connection not found');
      let eps;
      try { eps = cleanEndpoints(req.body?.endpoints); } catch (e: any) { throw new HttpError(400, e.message); }
      const cfg = parse(row.config);
      if (typeof req.body?.baseUrl === 'string') { if (req.body.baseUrl) cfg.baseUrl = req.body.baseUrl.slice(0, 500); else delete cfg.baseUrl; }
      // Only an endpoint marked used (with a role that gives pages) is ever called; unused ones are kept so the review can be reopened.
      cfg.endpoints = JSON.stringify(eps);
      const c = connectorFor('api')!;
      try { c.validate({ ...cfg, ...(req.body?.sample && typeof req.body.sample === 'object' ? req.body.sample : {}) }, { vaultsDir: d.vaultsDir, env: d.env }); } catch (e: any) { throw new HttpError(400, e.message); }
      run(d.db, 'UPDATE connections SET config = ?, updated_at = ? WHERE id = ?', JSON.stringify(Object.fromEntries(Object.entries(cfg).sort(([x], [y]) => (x < y ? -1 : 1)))), now(), row.id);
      audit(d, res, 'connection.endpoints', `${row.id} ${eps.filter((e) => e.use).length} used of ${eps.length}`);
      res.json(shapeConnection(d, getConnection(d.db, row.id)!, true));
    });

    // ---- tiers: what is listed, what is read, the budget ---------------------------------------------------
    r.get('/tiers/world/:wid', (req, res) => {
      const rows = all<any>(d.db, 'SELECT * FROM sources WHERE world_id = ? ORDER BY name', String(req.params.wid));
      res.json(rows.map((s) => ({ id: s.id, name: s.name, ...tierSummary(d, s) })));
    });
    r.patch('/tiers/:sid', (req, res) => {
      const s = one<any>(d.db, 'SELECT * FROM sources WHERE id = ?', String(req.params.sid));
      if (!s) throw new HttpError(404, 'Source not found');
      const b = req.body ?? {};
      const upd: { budget?: number | null; paused?: boolean; fetchAll?: boolean; spread?: number | null; limits?: Record<string, number> } = {};
      if (b.spread !== undefined) {
        if (b.spread === null || b.spread === '') upd.spread = null;
        else { const n = Number(b.spread); if (!Number.isInteger(n) || n < 0 || n > 1440) throw new HttpError(400, 'spread is minutes, 0 to 1440 (0: as fast as the limits allow)'); upd.spread = n; }
      }
      // The calls-a-minute and calls-a-second limits belong to the connection: every world that uses it shares them.
      const lim: Record<string, number> = {};
      for (const [k, key, max] of [['perMinute', 'maxPerMinute', 6000], ['perSecond', 'maxPerSecond', 100], ['perHour', 'maxPerHour', 100_000]] as const) {
        if (b.limits?.[k] === undefined) continue;
        const n = Number(b.limits[k]);
        if (!Number.isInteger(n) || n < (k === 'perMinute' ? 1 : 0) || n > max) throw new HttpError(400, k === 'perMinute' ? 'perMinute is calls a minute, 1 to 6000' : k === 'perHour' ? 'perHour is calls an hour, 0 to 100000 (0: no cap)' : 'perSecond is calls a second, 0 to 100 (0: no cap)');
        lim[key] = n;
      }
      if (b.budget !== undefined) {
        if (b.budget === null || b.budget === '') upd.budget = null;
        else { const n = Number(b.budget); if (!Number.isInteger(n) || n < 0 || n > 600) throw new HttpError(400, 'budget is calls a minute, 0 to 600'); upd.budget = n; }
      }
      if (b.paused !== undefined) upd.paused = b.paused === true;
      if (b.fetchAll !== undefined) upd.fetchAll = b.fetchAll === true;
      if (!tierSummary(d, s).tiered) throw new HttpError(400, 'This source is read whole; it has no tiers to set');
      setSettings(d.db, s.id, { ...upd, limits: undefined } as any);
      if (Object.keys(lim).length) {
        if (s.connection_id) {
          const conn = getConnection(d.db, s.connection_id);
          if (conn) run(d.db, 'UPDATE connections SET config = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...parse(conn.config), ...lim }), now(), conn.id);
        } else run(d.db, 'UPDATE sources SET config = ? WHERE id = ?', JSON.stringify({ ...parse(s.config), ...lim }), s.id);
        upd.limits = lim;
      }
      audit(d, res, 'source.tiers', `${s.id} ${JSON.stringify(upd)}`, s.world_id);
      const out = { id: s.id, name: s.name, ...tierSummary(d, s) };
      d.hub.emit(s.world_id, 'tiers', { sources: [out] }, dmOnly);
      res.json(out);
    });

    // ---- presets (before /:cid) ----------------------------------------------
    r.get('/presets', (_req, res) => res.json(allPresets(d)));

    r.post('/presets', (req, res) => {
      let config: unknown = req.body?.config;
      if (req.body?.connectionId) {
        const conn = getConnection(d.db, String(req.body.connectionId));
        if (!conn || conn.kind !== 'api') throw new HttpError(404, 'Pick a generic API connection to save as a preset');
        config = parse(conn.config);
      }
      let clean: Record<string, any>;
      try { clean = cleanPresetConfig(config); } catch (e: any) { throw new HttpError(400, e.message); }
      let name: string;
      try { name = cleanPresetName(req.body?.name); } catch (e: any) { throw new HttpError(400, e.message); }
      const pid = id('pre_');
      run(d.db, 'INSERT INTO connection_presets (id, name, description, config, created_at) VALUES (?, ?, ?, ?, ?)', pid, name, String(req.body?.description ?? '').slice(0, 500), JSON.stringify(clean), now());
      audit(d, res, 'connection.preset.save', pid);
      res.status(201).json(presetRow(one<any>(d.db, 'SELECT * FROM connection_presets WHERE id = ?', pid)));
    });

    r.post('/presets/import', (req, res) => {
      let p: ReturnType<typeof parsePresetImport>;
      try { p = parsePresetImport(req.body?.preset ?? req.body?.json ?? req.body); } catch (e: any) { throw new HttpError(400, e.message); }
      const pid = id('pre_');
      run(d.db, 'INSERT INTO connection_presets (id, name, description, config, created_at) VALUES (?, ?, ?, ?, ?)', pid, p.name, p.description, JSON.stringify(p.config), now());
      audit(d, res, 'connection.preset.import', pid);
      res.status(201).json(presetRow(one<any>(d.db, 'SELECT * FROM connection_presets WHERE id = ?', pid)));
    });

    r.get('/presets/:pid/export', (req, res) => {
      const p = findPreset(d, String(req.params.pid));
      if (!p) throw new HttpError(404, 'Preset not found');
      res.json(exportPreset(p));
    });

    r.delete('/presets/:pid', (req, res) => {
      if (BUILTIN_PRESETS.some((p) => p.id === req.params.pid)) throw new HttpError(400, 'Built-in presets cannot be deleted');
      if (!run(d.db, 'DELETE FROM connection_presets WHERE id = ?', String(req.params.pid))) throw new HttpError(404, 'Preset not found');
      audit(d, res, 'connection.preset.delete', String(req.params.pid));
      res.json({ ok: true });
    });

    // ---- test -------------------------------------------------------------------
    r.post('/test', async (req, res) => {
      const c = connectorFor(str(req.body?.kind, 'kind', { max: 40 }));
      if (!c) throw new HttpError(400, 'Unknown kind of connection');
      const prev = req.body?.connectionId ? parse(getConnection(d.db, String(req.body.connectionId))?.config) : {};
      res.json(await testConnection(d, c, connectionConfig(c, req.body?.config ?? {}, prev), req.body?.sample));
    });

    r.get('/:cid', (req, res) => {
      const row = getConnection(d.db, String(req.params.cid));
      if (!row) throw new HttpError(404, 'Connection not found');
      res.json(shapeConnection(d, row, true));
    });

    r.patch('/:cid', (req, res) => {
      const row = getConnection(d.db, String(req.params.cid));
      if (!row) throw new HttpError(404, 'Connection not found');
      const c = connectorFor(row.kind);
      if (!c) throw new HttpError(409, 'This connection is of a kind the librarian no longer knows');
      const b = req.body ?? {};
      // Settings sent now are laid over the saved ones; an empty value clears one, the mask keeps a secret.
      const cfg = b.config !== undefined ? connectionConfig(c, { ...parse(row.config), ...b.config }, parse(row.config)) : parse(row.config);
      run(d.db, 'UPDATE connections SET name = ?, config = ?, notes = ?, updated_at = ? WHERE id = ?',
        b.name !== undefined ? str(b.name, 'name', { max: 80 }) : row.name, JSON.stringify(Object.fromEntries(Object.entries(cfg).sort(([x], [y]) => (x < y ? -1 : 1)))),
        b.notes !== undefined ? str(b.notes, 'notes', { max: 1000, optional: true }) ?? '' : row.notes, now(), row.id);
      audit(d, res, 'connection.update', row.id);
      res.json(shapeConnection(d, getConnection(d.db, row.id)!, true));
    });

    r.delete('/:cid', (req, res) => {
      const row = getConnection(d.db, String(req.params.cid));
      if (!row) throw new HttpError(404, 'Connection not found');
      const uses = usage(d, row.id);
      if (uses.length) throw new HttpError(409, `${uses.length} source${uses.length === 1 ? ' still uses' : 's still use'} this connection (${uses.slice(0, 3).map((u) => `${u.source_name} in ${u.world_name}`).join(', ')}). Remove or move them first.`);
      run(d.db, 'DELETE FROM connections WHERE id = ?', row.id);
      audit(d, res, 'connection.delete', row.id);
      res.json({ ok: true });
    });

    r.post('/:cid/test', async (req, res) => {
      const row = getConnection(d.db, String(req.params.cid));
      if (!row) throw new HttpError(404, 'Connection not found');
      const c = connectorFor(row.kind);
      if (!c) throw new HttpError(409, 'This connection is of a kind the librarian no longer knows');
      res.json(await testConnection(d, c, parse(row.config), req.body?.sample));
    });

    // Fill a generic API connection from a preset (replaces its mapping; keeps its token and notes).
    r.post('/:cid/preset', (req, res) => {
      const row = getConnection(d.db, String(req.params.cid));
      if (!row || row.kind !== 'api') throw new HttpError(404, 'Generic API connection not found');
      const p = findPreset(d, str(req.body?.presetId, 'presetId', { max: 80 }));
      if (!p) throw new HttpError(404, 'Preset not found');
      const c = connectorFor('api')!;
      const prev = parse(row.config);
      const secretKeys = c.fields.filter((f) => f.secret).map((f) => f.key);
      const next = { ...p.config, ...Object.fromEntries(secretKeys.filter((k) => prev[k] !== undefined).map((k) => [k, prev[k]])) };
      run(d.db, 'UPDATE connections SET config = ?, updated_at = ? WHERE id = ?', JSON.stringify(connectionConfig(c, next, prev)), now(), row.id);
      audit(d, res, 'connection.preset.apply', `${row.id} ${p.id}`);
      res.json(shapeConnection(d, getConnection(d.db, row.id)!, true));
    });

    return r;
  },

  worldMount: 'world-sources',
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    // What this world's sources are and who each one is shared with. Players get nothing from here.
    r.get('/', (_req, res) => {
      if (!isDM(res)) return res.json({ sources: [] });
      const w = ctx(res).world.id;
      const rows = all<any>(d.db, 'SELECT s.*, c.name AS connection_name, (SELECT COUNT(*) FROM pages p WHERE p.source_id = s.id) AS pages FROM sources s LEFT JOIN connections c ON c.id = s.connection_id WHERE s.world_id = ? ORDER BY s.name', w);
      res.json({
        summary: sourceSummary(d, w),
        sources: rows.map((s) => {
          const a = normAudience(s.audience);
          return { id: s.id, name: s.name, kind: connectorFor(s.kind)?.label ?? s.kind, connection: s.connection_name ?? null, audience: a, audience_label: AUDIENCE_LABEL[a], enabled: !!s.enabled, schedule_minutes: s.schedule_minutes, last_sync_at: s.last_sync_at, last_status: s.last_status, pages: s.pages };
        }),
      });
    });
    // Why players may see nothing, a key the site refuses for content, a wait for the site: for the GM's library and the world page.
    r.get('/status', (_req, res) => {
      if (!isDM(res)) return res.json({ pages: 0, levels: { party: 0, broker: 0, dm: 0, classified: 0 }, dmOnly: null, refused: [], waiting: null });
      res.json(worldStatus(d, ctx(res).world.id));
    });
    // Pages not yet read in full: for the GM's depth badge.
    r.get('/depths', (_req, res) => {
      if (!isDM(res)) return res.json({ depths: {} });
      res.json({ depths: depthsOf(d.db, ctx(res).world.id) });
    });
    return r;
  },

  // The background reader: a few calls a minute, the pages people open or link to first. Not started in tests.
  start: (d: Deps) => startDetailWorker(
    { db: d.db, library: d.library, dataDir: d.dataDir, vaultsDir: d.vaultsDir, fetch: d.fetch, env: d.env, mcp: d.testMcp },
    (results) => {
      for (const t of results) {
        const s = one<any>(d.db, 'SELECT * FROM sources WHERE id = ?', t.sourceId);
        if (s) d.hub.emit(s.world_id, 'tiers', { sources: [{ id: s.id, name: s.name, ...tierSummary(d, s) }] }, dmOnly);
      }
    },
  ),

  mcpTools: [
    {
      name: 'world_sources', dmOnly: true,
      description: "GM: where this world's library comes from: each source (name, kind of app, connection), its audience (GM only, shared with players, or following the source's own flags), the schedule and when it last synced.",
      props: {}, call: () => ({ method: 'GET', path: '/world-sources' }),
    },
  ],
};
export default feature;
