// Intake: what each source provides (capabilities), the records sources give
// besides pages (relations, timelines, calendars, map markers), and the push
// API for tools that cannot be polled.
//
// Push: a DM or admin makes a source key (alx_push_...) for one source. The
// key can only call the three /api/intake/<source>/... endpoints for that
// source: it is not an account token, so it can't read anything or reach any
// other route. Entries go through library.saveEntry and the same leak guard
// as synced pages; a pushed entry is shared only when it says "party" AND the
// source's "share what the source shares" switch is on.
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import type { Auth } from '../../core/auth.ts';
import { HttpError, id, now, secret, sha256 } from '../../core/util.ts';
import type { Feature } from '../types.ts';
import { ctx, isDM } from '../../routes/_shared.ts';
import { RECORDS_SCHEMA, calendarsFor, markersFor, timelinesFor } from '../../intake/records.ts';
import { capabilityUnion, connectorFor } from '../../intake/registry.ts';
import { prefixFor, runSync } from '../../intake/sync.ts';
import { cleanEntry } from '../../intake/push.ts';

/** Limits. Environment variables can lower or raise them. */
const MAX_ENTRIES_PER_REQUEST = 100;
const MAX_KEYS_PER_SOURCE = 10;
const KEY_RE = /^Bearer\s+(alx_push_[A-Za-z0-9_-]{16,128})\s*$/;

const schema = `
${RECORDS_SCHEMA}
-- Source keys for the push API. Only the hash is kept.
CREATE TABLE IF NOT EXISTS intake_keys (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);

`;

/** Key management, shared by the admin routes (any source) and the DM routes (this world's sources). */
function keyRoutes(d: Deps, scope: (req: Request, res: Response) => string | null, actor: (res: Response) => string) {
  const r = Router({ mergeParams: true });
  const sourceOf = (req: Request, res: Response) => {
    const s = one<any>(d.db, 'SELECT * FROM sources WHERE id = ?', String(req.params.sid));
    const world = scope(req, res);
    if (!s || (world && s.world_id !== world)) throw new HttpError(404, 'Source not found');
    return s;
  };
  const shape = (k: any) => ({ id: k.id, label: k.label, prefix: k.prefix, created_at: k.created_at, last_used_at: k.last_used_at, revoked: !!k.revoked });
  r.get('/sources/:sid/keys', (req, res) => {
    const s = sourceOf(req, res);
    res.json(all<any>(d.db, 'SELECT * FROM intake_keys WHERE source_id = ? ORDER BY created_at DESC', s.id).map(shape));
  });
  // The key is in this response and nowhere else, ever.
  r.post('/sources/:sid/keys', (req, res) => {
    const s = sourceOf(req, res);
    const label = String(req.body?.label ?? '').trim().slice(0, 80) || 'Push key';
    if (one<any>(d.db, 'SELECT COUNT(*) AS n FROM intake_keys WHERE source_id = ? AND revoked = 0', s.id)!.n >= MAX_KEYS_PER_SOURCE) throw new HttpError(409, `A source can have ${MAX_KEYS_PER_SOURCE} keys. Revoke one first.`);
    const key = secret('alx_push_');
    const kid = id('ikey_');
    run(d.db, 'INSERT INTO intake_keys (id, source_id, world_id, label, prefix, key_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', kid, s.id, s.world_id, label, key.slice(0, 14), sha256(key), actor(res), now());
    audit(d.db, s.world_id, actor(res), 'intake.key.create', `${s.id} ${kid}`);
    res.status(201).json({ ...shape(one<any>(d.db, 'SELECT * FROM intake_keys WHERE id = ?', kid)), key });
  });
  r.delete('/keys/:kid', (req, res) => {
    const k = one<any>(d.db, 'SELECT * FROM intake_keys WHERE id = ?', String(req.params.kid));
    const world = scope(req, res);
    if (!k || (world && k.world_id !== world)) throw new HttpError(404, 'Key not found');
    run(d.db, 'UPDATE intake_keys SET revoked = 1 WHERE id = ?', k.id);
    audit(d.db, k.world_id, actor(res), 'intake.key.revoke', `${k.source_id} ${k.id}`);
    res.json({ ok: true });
  });
  return r;
}

// Not imported from app.ts: app.ts loads the features, so that would be a cycle.
const audit = (db: Deps['db'], worldId: string | null, who: string | null, action: string, detail = '') =>
  run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, who, action, detail.slice(0, 500), now());

const accountId = (res: Response) => (res.locals.auth as Auth).account.id;

// ---- the push API ------------------------------------------------------------------

/** Per-key request and entry budgets (a minute at a time), kept in memory. */
class KeyLimiter {
  private w = new Map<string, { at: number; requests: number; entries: number }>();
  check(key: string, entries: number, maxRequests: number, maxEntries: number) {
    const t = Date.now();
    let x = this.w.get(key);
    if (!x || t - x.at >= 60_000) { x = { at: t, requests: 0, entries: 0 }; this.w.set(key, x); }
    x.requests++;
    x.entries += entries;
    if (x.requests > maxRequests || x.entries > maxEntries) throw Object.assign(new HttpError(429, 'Too many requests for this key. Wait a minute.'), { retryAfter: Math.max(1, Math.ceil((x.at + 60_000 - t) / 1000)) });
  }
}

function pushApi(app: import('express').Express, d: Deps) {
  const limiter = new KeyLimiter();
  const maxReq = Number(d.env.ALX_PUSH_REQUESTS_PER_MIN ?? 120);
  const maxEntries = Number(d.env.ALX_PUSH_ENTRIES_PER_MIN ?? 2000);
  const lastWebhook = new Map<string, number>();
  const deps = () => ({ db: d.db, library: d.library, dataDir: d.dataDir, vaultsDir: d.vaultsDir, fetch: d.fetch, env: d.env, mcp: d.testMcp });

  // Resolves the key. A key works for the one source it was made for; anything else is refused.
  const keyed = (entries: (req: Request) => number) => (req: Request, res: Response, next: NextFunction) => {
    const m = KEY_RE.exec(String(req.headers.authorization ?? ''));
    if (!m) throw new HttpError(401, 'Send the source key as "Authorization: Bearer alx_push_..."');
    const k = one<any>(d.db, 'SELECT * FROM intake_keys WHERE key_hash = ? AND revoked = 0', sha256(m[1]));
    if (!k) throw new HttpError(401, 'That source key is not valid');
    if (k.source_id !== String(req.params.sourceId)) throw new HttpError(403, 'This key is for a different source');
    const src = one<any>(d.db, 'SELECT * FROM sources WHERE id = ?', k.source_id);
    if (!src) throw new HttpError(404, 'Source not found');
    try {
      limiter.check(k.id, entries(req), maxReq, maxEntries);
    } catch (err: any) {
      if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
      throw err;
    }
    run(d.db, 'UPDATE intake_keys SET last_used_at = ? WHERE id = ?', now(), k.id);
    res.locals.pushKey = k;
    res.locals.pushSource = src;
    next();
  };
  const src = (res: Response) => res.locals.pushSource as any;
  const needPush = (res: Response) => {
    const c = connectorFor(src(res).kind, JSON.parse(src(res).config || '{}'));
    if (!c?.push) throw new HttpError(400, 'This source pulls its own pages; only a push source accepts entries');
    if (!src(res).enabled) throw new HttpError(409, 'This source is switched off');
  };

  app.post('/api/intake/:sourceId/entries', keyed((req) => (Array.isArray(req.body?.entries) ? req.body.entries.length : 1)), (req, res) => {
    needPush(res);
    const s = src(res);
    const list = req.body?.entries;
    if (!Array.isArray(list)) throw new HttpError(400, 'Send { "entries": [ ... ] }');
    if (!list.length) throw new HttpError(400, 'No entries');
    if (list.length > MAX_ENTRIES_PER_REQUEST) throw new HttpError(413, `At most ${MAX_ENTRIES_PER_REQUEST} entries per request`);
    const shareOk = s.default_visibility === 'party';
    const prefix = prefixFor('push', s.name);
    const errors: { externalId: string | null; error: string }[] = [];
    const saved: { externalId: string; visibility: string }[] = [];
    for (const raw of list) {
      let e;
      try {
        e = cleanEntry(raw, shareOk);
      } catch (err: any) {
        errors.push({ externalId: typeof raw?.externalId === 'string' ? raw.externalId : null, error: err.message });
        continue;
      }
      try {
        d.library.saveEntry(s.world_id, s.id, prefix, e, (res.locals.pushKey as any).created_by ?? null);
        saved.push({ externalId: e.externalId, visibility: e.visibility });
      } catch (err: any) {
        errors.push({ externalId: e.externalId, error: err.message });
      }
    }
    // Player copies are built after the batch, so links and secrets are checked together.
    d.library.rebuildPlayerCopies(s.world_id);
    run(d.db, 'UPDATE sources SET last_sync_at = ?, last_status = ? WHERE id = ?', now(), `push: ${saved.length} entries${errors.length ? `, ${errors.length} refused` : ''}`, s.id);
    if (saved.length) d.hub.emit(s.world_id, 'page', { source: s.id, count: saved.length }, () => true);
    res.status(errors.length && !saved.length ? 400 : 200).json({ saved: saved.length, shared: saved.filter((x) => x.visibility === 'party').length, errors });
  });

  app.delete('/api/intake/:sourceId/entries/:externalId', keyed(() => 1), (req, res) => {
    needPush(res);
    const s = src(res);
    const pg = one<any>(d.db, 'SELECT id FROM pages WHERE world_id = ? AND source_id = ? AND external_id = ?', s.world_id, s.id, String(req.params.externalId));
    if (!pg) throw new HttpError(404, 'No such entry in this source');
    d.library.remove(s.world_id, pg.id);
    d.hub.emit(s.world_id, 'page', { source: s.id, removed: 1 }, () => true);
    res.json({ ok: true });
  });

  // For a webhook (a git push, a CI job): start a sync of a pull source. One a minute is plenty; it runs in the background.
  app.post('/api/intake/:sourceId/sync', keyed(() => 1), (req, res) => {
    const s = src(res);
    if (connectorFor(s.kind, JSON.parse(s.config || '{}'))?.push) throw new HttpError(400, 'A push source has nothing to sync; push entries instead');
    if (!s.enabled) throw new HttpError(409, 'This source is switched off');
    const last = lastWebhook.get(s.id) ?? 0;
    if (Date.now() - last < 10_000) { res.setHeader('Retry-After', '10'); throw new HttpError(429, 'A sync was just requested. Wait a few seconds.'); }
    lastWebhook.set(s.id, Date.now());
    audit(d.db, s.world_id, null, 'source.sync', `${s.id} by source key`);
    runSync(deps(), s.id, null).catch(() => {});
    res.status(202).json({ started: true });
  });
}

const feature: Feature = {
  id: 'intake',
  schema,
  worldMount: 'intake',
  worldRoutes: (d) => {
    const r = Router({ mergeParams: true });
    // What the world's sources provide, so screens can hide what no source has. Names of sources are for the DM only.
    r.get('/capabilities', (_req, res) => {
      const w = ctx(res).world.id;
      const sources = all<any>(d.db, 'SELECT id, name, kind, config FROM sources WHERE world_id = ? ORDER BY name', w);
      res.json({
        capabilities: capabilityUnion(sources),
        ...(isDM(res) ? { sources: sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, capabilities: capabilityUnion([s]) })) } : {}),
      });
    });
    r.get('/calendars', (_req, res) => res.json(calendarsFor(d.db, ctx(res).world.id, ctx(res).viewer)));
    r.get('/timelines', (_req, res) => res.json(timelinesFor(d.db, ctx(res).world.id, ctx(res).viewer)));
    r.get('/markers', (_req, res) => res.json(markersFor(d.db, ctx(res).world.id, ctx(res).viewer)));
    // The DM makes source keys for this world's sources.
    r.use((req, res, next) => {
      if (!/^\/(sources\/[^/]+\/keys|keys\/[^/]+)$/.test(req.path)) return next();
      if (!isDM(res)) throw new HttpError(403, 'Only the DM can manage source keys');
      next();
    });
    r.use(keyRoutes(d, (_req, res) => ctx(res).world.id, accountId));
    return r;
  },
  adminMount: 'intake',
  adminRoutes: (d) => keyRoutes(d, () => null, accountId),
  appRoutes: (app, d) => pushApi(app, d),
};

export default feature;
