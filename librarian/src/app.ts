import { RELEASE, VERSION } from './version.ts';
import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { type DB, openDb, run } from './core/db.ts';
import { EventHub } from './core/events.ts';
import { Jobs, jobsOf } from './core/jobs.ts';
import { Library } from './core/library.ts';
import { authenticate, loadWorld, requireAdmin, Throttle } from './core/auth.ts';
import { HttpError, now } from './core/util.ts';
import { DM_PRIORITY, withPriority } from './core/ai.ts';
import type { WorldCtx } from './core/auth.ts';
import authRoutes from './routes/auth.ts';
import adminRoutes from './routes/admin.ts';
import sourceRoutes from './routes/sources.ts';
import jobRoutes from './routes/jobs.ts';
import { accessRoutes, activityRoutes } from './routes/modelaccess.ts';
import { ensureModelSchema, pruneCalls } from './core/modelcalls.ts';
import { startScheduler } from './intake/sync.ts';
import type { McpClient } from './core/mcp.ts';
import worldRoutes, { listMyWorlds } from './routes/world.ts';
import libraryRoutes from './routes/library.ts';
import requestRoutes from './routes/requests.ts';
import messageRoutes, { purgeExpiredThreads } from './routes/messages.ts';
import quickRoutes from './routes/quick.ts';
import calendarRoutes, { icsFeed } from './routes/calendar.ts';
import liveRoutes from './routes/live.ts';
import inventoryRoutes from './routes/inventory.ts';
import mapRoutes from './routes/map.ts';
import peopleRoutes from './routes/people.ts';
import whiteboardRoutes from './routes/whiteboard.ts';
import brokerRoutes from './routes/broker.ts';
import approvalsRoutes from './routes/approvals.ts';
import modelRoutes from './routes/models.ts';
import mcpServerRoutes from './routes/mcpServer.ts';
import { FEATURES, applyFeatureSchemas } from './features/registry.ts';
import { serverModGate } from './features/mods/server.ts';

export interface Deps {
  db: DB;
  hub: EventHub;
  library: Library;
  throttle: Throttle;
  dataDir: string | null;
  vaultsDir: string | null;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  /** Tests only: an MCP client used instead of connecting to real servers. */
  testMcp?: McpClient;
  /** The heavy background work that is running (crawls, syncs, rebuilds), for the admin page and /health. */
  jobs: Jobs;
  /** What the server is doing after it started listening (src/server.ts). `warming`: it answers, but is still getting ready. */
  startup: { warming: boolean; phase: string; since: number };
}

export interface AppOptions {
  testMcp?: McpClient;
  /** Tests turn off scheduled syncs. */
  noScheduler?: boolean;
  /** Built web app (web/dist). Served at / with a fallback to index.html. */
  webDir?: string | null;
  dbFile?: string;
  /** The server rebuilds old copies after it listens (src/server.ts) instead of before. */
  deferMigration?: boolean;
  dataDir?: string | null;
  vaultsDir?: string | null;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export function audit(db: DB, worldId: string | null, accountId: string | null, action: string, detail = '') {
  run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());
}

export function createApp(opts: AppOptions = {}) {
  const db = openDb(opts.dbFile ?? ':memory:');
  applyFeatureSchemas(db);
  ensureModelSchema(db);
  const deps: Deps = {
    db,
    hub: new EventHub(),
    library: new Library(db, opts.dataDir ?? null, { deferMigration: opts.deferMigration }),
    throttle: new Throttle(),
    dataDir: opts.dataDir ?? null,
    vaultsDir: opts.vaultsDir ?? null,
    fetch: opts.fetch ?? fetch,
    env: opts.env ?? process.env,
    testMcp: opts.testMcp,
    jobs: jobsOf(db),
    startup: { warming: false, phase: '', since: Date.now() },
  };

  const app = express();
  app.disable('x-powered-by');
  // Behind Caddy/nginx, set ALX_TRUST_PROXY (e.g. "1" or "loopback, uniquelocal") so IPs and https are read right.
  const tp = deps.env.ALX_TRUST_PROXY;
  app.set('trust proxy', tp === undefined || tp === '' ? 'loopback' : /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? true : tp);
  const started = Date.now();
  // A simple per-IP limit for the API and MCP: protects a small server from runaway clients.
  const limit = Number(deps.env.ALX_RATE_LIMIT ?? 900);
  const hits = new Map<string, { n: number; at: number }>();
  const sweep = setInterval(() => { const cut = Date.now() - 60_000; for (const [k, v] of hits) if (v.at < cut) hits.delete(k); }, 60_000);
  sweep.unref();
  app.use(['/api', '/mcp', '/v1'], (req, res, next) => {
    if (!limit) return next();
    const k = req.ip ?? 'unknown';
    const h = hits.get(k);
    const t = Date.now();
    if (!h || t - h.at > 60_000) hits.set(k, { n: 1, at: t });
    else if (++h.n > limit) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: 'Too many requests. Wait a minute.' }); }
    next();
  });
  app.use(express.json({ limit: '4mb' }));
  // Browser apps on other origins (the scribe desktop app in dev, a phone
  // build) must be listed in ALX_CORS_ORIGINS, comma separated.
  const origins = (deps.env.ALX_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  app.use((req, res, next) => {
    const o = req.headers.origin;
    if (o && origins.includes(o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
      if (req.method === 'OPTIONS') return res.status(204).end();
    }
    next();
  });
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Answers at once whatever the server is doing: a server that is busy (a crawl, a re-index) or still warming up is alive.
  // 200 unless the database does not answer; `status` says "warming" while the start-up work runs, `busyJobs` how much heavy work is running.
  app.get('/health', (_req, res) => {
    let dbOk = true;
    try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
    const warming = deps.startup.warming;
    res.status(dbOk ? 200 : 503).json({
      status: !dbOk ? 'db-error' : warming ? 'warming' : 'ok', warming, phase: deps.startup.phase, busyJobs: deps.jobs.busy(),
      time: now(), uptimeSeconds: Math.round((Date.now() - started) / 1000), version: VERSION, release: RELEASE,
    });
  });

  // Calendar feed: calendar apps send Basic auth (username + scribe key).
  app.get('/dav/worlds/:world/sessions.ics', authenticate(db), loadWorld(db), icsFeed(deps));

  app.use('/api', authRoutes(deps));
  app.use('/api/admin', authenticate(db), adminRoutes(deps));
  app.use('/api/admin', authenticate(db), requireAdmin, sourceRoutes(deps));
  app.use('/api/admin/jobs', authenticate(db), requireAdmin, jobRoutes(deps));
  app.use('/api/admin/models/activity', authenticate(db), requireAdmin, activityRoutes(deps));
  app.use('/api/admin/models/access', authenticate(db), requireAdmin, accessRoutes(deps));
  // A feature that is a server mod answers 404 while the admin has it off (Admin → Mods).
  const modGate = (f: (typeof FEATURES)[number]) => serverModGate(db, f.serverMod);
  for (const f of FEATURES) if (f.adminRoutes) app.use(`/api/admin/${f.adminMount ?? f.id}`, authenticate(db), requireAdmin, modGate(f), f.adminRoutes(deps));

  const w = express.Router({ mergeParams: true });
  w.use(authenticate(db), loadWorld(db), dmGoesFirst);
  w.use(worldRoutes(deps));
  w.use('/library', libraryRoutes(deps));
  w.use('/requests', requestRoutes(deps));
  w.use('/messages', messageRoutes(deps));
  w.use('/quick-events', quickRoutes(deps));
  w.use('/calendar', calendarRoutes(deps));
  w.use('/live', liveRoutes(deps));
  w.use('/inventory', inventoryRoutes(deps));
  w.use('/map', mapRoutes(deps));
  w.use('/', peopleRoutes(deps));
  w.use('/whiteboard', whiteboardRoutes(deps));
  w.use('/broker', brokerRoutes(deps));
  w.use('/approvals', approvalsRoutes(deps));
  for (const f of FEATURES) if (f.worldRoutes) w.use(`/${f.worldMount ?? f.id}`, modGate(f), f.worldRoutes(deps));
  app.use('/api/worlds/:world', w);
  app.get('/api/worlds', authenticate(db), listMyWorlds(deps));

  app.use('/v1', authenticate(db), modelRoutes(deps));
  app.use('/mcp', mcpServerRoutes(deps));
  for (const f of FEATURES) f.appRoutes?.(app, deps);

  if (opts.webDir && fs.existsSync(path.join(opts.webDir, 'index.html'))) {
    const webDir = opts.webDir;
    // 'wasm-unsafe-eval' lets a recording device run its own speech model (WebAssembly from this origin, audio/sttassets.ts); no eval.
    const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' https: data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
    // The players' screen alone may embed YouTube (privacy-enhanced domain, nothing else) and load YouTube's IFrame Player API script
    // (so it can start and unmute each queued video after the one click that unlocks sound); every other page stays frame-free and script-free of it.
    const screenCsp = csp.replace("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' https://www.youtube.com").replace("frame-ancestors 'none'", "frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'");
    const cspFor = (p: string) => (/^\/w\/[^/]+\/screen\/players\/?$/.test(p) ? screenCsp : csp);
    app.use(express.static(webDir, { index: false, maxAge: '1h', setHeaders: (res, f) => { if (f.endsWith('index.html')) { res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Content-Security-Policy', csp); } } }));
    // Any other GET that is not an API path is a page of the app.
    app.get(/^\/(?!api\/|mcp|v1\/|dav\/|health).*/, (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Security-Policy', cspFor(req.path));
      res.sendFile('index.html', { root: webDir }); // root: so a dot folder in webDir's own path is fine
    });
  }

  app.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Body is not valid JSON' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Body too large' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the librarian' });
  });

  if (!opts.noScheduler) for (const f of FEATURES) f.start?.(deps);
  if (!opts.noScheduler) startScheduler({ db, library: deps.library, dataDir: deps.dataDir, vaultsDir: deps.vaultsDir, fetch: deps.fetch, env: deps.env });
  const timer = setInterval(() => { purgeExpiredThreads(db); pruneCalls(db); }, 60 * 60 * 1000);
  timer.unref();

  return { app, deps };
}

/**
 * Model calls made while answering the DM of a world (a generator, a statblock, the assistant's tools) go before the
 * players' (core/ai.ts, the queue). Work that sets its own priority (background passes, tracked jobs) keeps it.
 */
function dmGoesFirst(_req: Request, res: Response, next: NextFunction) {
  if ((res.locals.w as WorldCtx | undefined)?.viewer.role !== 'dm') return next();
  void withPriority(DM_PRIORITY, async () => next());
}
