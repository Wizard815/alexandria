import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { type DB, openDb, run } from './core/db.ts';
import { EventHub } from './core/events.ts';
import { Library } from './core/library.ts';
import { authenticate, loadWorld, requireAdmin, Throttle } from './core/auth.ts';
import { HttpError, now } from './core/util.ts';
import authRoutes from './routes/auth.ts';
import adminRoutes from './routes/admin.ts';
import sourceRoutes from './routes/sources.ts';
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
}

export interface AppOptions {
  testMcp?: McpClient;
  /** Tests turn off scheduled syncs. */
  noScheduler?: boolean;
  /** Built web app (web/dist). Served at / with a fallback to index.html. */
  webDir?: string | null;
  dbFile?: string;
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
  const deps: Deps = {
    db,
    hub: new EventHub(),
    library: new Library(db, opts.dataDir ?? null),
    throttle: new Throttle(),
    dataDir: opts.dataDir ?? null,
    vaultsDir: opts.vaultsDir ?? null,
    fetch: opts.fetch ?? fetch,
    env: opts.env ?? process.env,
    testMcp: opts.testMcp,
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
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/health', (_req, res) => {
    let dbOk = true;
    try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
    res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'db-error', time: now(), uptimeSeconds: Math.round((Date.now() - started) / 1000), version: '0.4.0' });
  });

  // Calendar feed: calendar apps send Basic auth (username + scribe key).
  app.get('/dav/worlds/:world/sessions.ics', authenticate(db), loadWorld(db), icsFeed(deps));

  app.use('/api', authRoutes(deps));
  app.use('/api/admin', authenticate(db), adminRoutes(deps));
  app.use('/api/admin', authenticate(db), requireAdmin, sourceRoutes(deps));
  for (const f of FEATURES) if (f.adminRoutes) app.use(`/api/admin/${f.adminMount ?? f.id}`, authenticate(db), requireAdmin, f.adminRoutes(deps));

  const w = express.Router({ mergeParams: true });
  w.use(authenticate(db), loadWorld(db));
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
  for (const f of FEATURES) if (f.worldRoutes) w.use(`/${f.worldMount ?? f.id}`, f.worldRoutes(deps));
  app.use('/api/worlds/:world', w);
  app.get('/api/worlds', authenticate(db), listMyWorlds(deps));

  app.use('/v1', authenticate(db), modelRoutes(deps));
  app.use('/mcp', mcpServerRoutes(deps));
  for (const f of FEATURES) f.appRoutes?.(app, deps);

  if (opts.webDir && fs.existsSync(path.join(opts.webDir, 'index.html'))) {
    const webDir = opts.webDir;
    const csp = "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
    app.use(express.static(webDir, { index: false, maxAge: '1h', setHeaders: (res, f) => { if (f.endsWith('index.html')) { res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Content-Security-Policy', csp); } } }));
    // Any other GET that is not an API path is a page of the app.
    app.get(/^\/(?!api\/|mcp|v1\/|dav\/|health).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Security-Policy', csp);
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
  const timer = setInterval(() => purgeExpiredThreads(db), 60 * 60 * 1000);
  timer.unref();

  return { app, deps };
}
