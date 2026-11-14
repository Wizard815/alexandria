// Accounts, sessions and API keys.
// - Passwords: scrypt with a per-account salt.
// - Sessions and keys: random tokens, stored only as SHA-256 hashes, shown once.
// - Key prefixes: alx_ses_ (browser session), alx_adm_ (admin key),
//   alx_scr_ (scribe key, bound to one world), alx_ads_ (gateway admin
//   session, valid only on /api/admin/** and /api/admin-auth/**).
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { type DB, one, run } from './db.ts';
import { repeatsClassified } from './ai.ts';
import { libraryOf } from './library.ts';
import { HttpError, id, now, secret, sha256 } from './util.ts';
import type { Role, Viewer } from './policy.ts';

export interface Account {
  id: string;
  username: string;
  display_name: string;
  is_admin: number;
}

export interface Auth {
  account: Account;
  via: 'session' | 'admin_key' | 'scribe_key' | 'admin_session';
  keyWorldId: string | null;
  /** read keys can only read; write keys and sessions are limited by role. */
  access: 'read' | 'write';
}

export interface WorldCtx {
  world: { id: string; slug: string; name: string; settings: string };
  viewer: Viewer;
}

const SESSION_DAYS = 30;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function checkPassword(pw: string, stored: string | null): boolean {
  if (!stored) return false;
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const got = scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, got);
}

export function validatePassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 10 || pw.length > 200) {
    throw new HttpError(400, 'Password must be 10 to 200 characters');
  }
  return pw;
}

export function validateUsername(u: unknown): string {
  if (typeof u !== 'string' || !/^[a-zA-Z0-9_.-]{2,40}$/.test(u)) {
    throw new HttpError(400, 'Username must be 2 to 40 letters, numbers, dots, dashes or underscores');
  }
  return u;
}

export function createAccount(db: DB, username: string, password: string | null, isAdmin: boolean, displayName?: string): Account {
  const acc = { id: id('acc_'), username, display_name: displayName || username, is_admin: isAdmin ? 1 : 0 };
  try {
    run(db, 'INSERT INTO accounts (id, username, display_name, pass_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      acc.id, username, acc.display_name, password ? hashPassword(password) : null, acc.is_admin, now());
  } catch (err: any) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'That username is taken');
    throw err;
  }
  return acc;
}

export function createSession(db: DB, accountId: string): string {
  const token = secret('alx_ses_');
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  run(db, 'INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(token), accountId, now(), exp);
  return token;
}

export function createKey(db: DB, accountId: string, scope: 'admin' | 'scribe', label: string, worldId: string | null, access: 'read' | 'write' = 'read'): { id: string; key: string } {
  const key = secret(scope === 'admin' ? 'alx_adm_' : 'alx_scr_');
  const kid = id('key_');
  run(db, 'INSERT INTO api_keys (id, account_id, scope, world_id, label, prefix, key_hash, created_at, access) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    kid, accountId, scope, worldId, label, key.slice(0, 12), sha256(key), now(), access);
  return { id: kid, key };
}

/** Resolve a bearer token (session or API key) to an account. Admin sessions
 *  (alx_ads_) resolve only when the caller asks for them, so every other
 *  consumer (MCP, /v1, join) fails closed. */
export function resolveToken(db: DB, token: string, opts: { adminSession?: boolean } = {}): Auth | null {
  if (token.startsWith('alx_ads_')) {
    if (!opts.adminSession) return null;
    const row = one<any>(db, `SELECT a.id, a.username, a.display_name, a.is_admin, s.expires_at FROM adminauth_sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?`, sha256(token));
    if (!row || row.expires_at < now() || !row.is_admin) return null;
    return { account: { id: row.id, username: row.username, display_name: row.display_name, is_admin: row.is_admin }, via: 'admin_session', keyWorldId: null, access: 'write' };
  }
  if (token.startsWith('alx_ses_')) {
    const row = one<any>(db, `SELECT a.id, a.username, a.display_name, a.is_admin, s.expires_at FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?`, sha256(token));
    if (!row || row.expires_at < now()) return null;
    return { account: row, via: 'session', keyWorldId: null, access: 'write' };
  }
  if (token.startsWith('alx_adm_') || token.startsWith('alx_scr_')) {
    const row = one<any>(db, `SELECT a.id, a.username, a.display_name, a.is_admin, k.id AS key_id, k.scope, k.world_id, k.access FROM api_keys k JOIN accounts a ON a.id = k.account_id WHERE k.key_hash = ? AND k.revoked = 0`, sha256(token));
    if (!row) return null;
    // An admin key stops working if its account loses the admin flag.
    if (row.scope === 'admin' && !row.is_admin) return null;
    run(db, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', now(), row.key_id);
    return { account: row, via: row.scope === 'admin' ? 'admin_key' : 'scribe_key', keyWorldId: row.world_id, access: row.access === 'write' ? 'write' : 'read' };
  }
  return null;
}

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  if (h?.startsWith('Basic ')) {
    // Calendar apps can only send Basic auth: username + key as password.
    const dec = Buffer.from(h.slice(6), 'base64').toString();
    const pw = dec.slice(dec.indexOf(':') + 1);
    return pw || null;
  }
  return null;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The admin-sign-in feature installs a gate on app.locals (see features/adminauth). */
export interface AdminGate {
  /** Throws 403 when the request's IP is outside ALX_ADMIN_ALLOW (and audits it). */
  checkIp(req: Request): void;
  /** Throws 403 when this caller may not use admin routes (e.g. a table session on a multi-account server). */
  checkAdmin(auth: Auth): void;
}
const gateOf = (req: Request) => req.app.locals.adminGate as AdminGate | undefined;
const isAdminPath = (req: Request) => /^\/api\/admin(-auth)?(\/|\?|$)/.test(req.originalUrl);

export function authenticate(db: DB) {
  return (req: Request, res: Response, next: NextFunction) => {
    const onAdmin = isAdminPath(req);
    if (onAdmin) gateOf(req)?.checkIp(req);
    const tok = bearer(req);
    const auth = tok ? resolveToken(db, tok, { adminSession: onAdmin }) : null;
    if (!auth) throw new HttpError(tok?.startsWith('alx_ads_') && !onAdmin ? 403 : 401, tok?.startsWith('alx_ads_') && !onAdmin ? 'Admin sessions only work on admin pages' : 'Sign in first');
    if (auth.access === 'read' && !READ_METHODS.has(req.method)) throw new HttpError(403, 'This key is read-only');
    res.locals.auth = auth;
    next();
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const auth = res.locals.auth as Auth;
  // Scribe keys never carry admin rights, even on an admin's account.
  if (!auth.account.is_admin || auth.via === 'scribe_key') throw new HttpError(403, 'Admins only');
  gateOf(req)?.checkAdmin(auth);
  next();
}

/**
 * Load the world named in :world (id or slug) and the caller's role in it.
 * Admins get no game access from the admin flag alone: they must be a member.
 * A scribe key only works for the world it was made for.
 */
export function loadWorld(db: DB) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = res.locals.auth as Auth;
    const key = String(req.params.world);
    const world = one<any>(db, 'SELECT id, slug, name, settings FROM worlds WHERE id = ? OR slug = ?', key, key);
    if (!world) throw new HttpError(404, 'World not found');
    if (auth.via === 'scribe_key' && auth.keyWorldId !== world.id) throw new HttpError(403, 'This key is for another world');
    const m = one<{ role: Role }>(db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', world.id, auth.account.id);
    if (!m) throw new HttpError(404, 'World not found');
    // A write key only writes while its owner is a DM of this world.
    if (auth.via !== 'session' && auth.access === 'write' && m.role !== 'dm') {
      auth.access = 'read';
      if (!READ_METHODS.has(req.method)) throw new HttpError(403, 'Write keys work only for the DM of this world');
    }
    // A request from a model (the MCP server, the agent's tools) says so: a DM's copy of it then has no classified content. Spoofing only shows less.
    const fromModel = String(req.headers['x-alexandria-caller'] ?? '').toLowerCase() === 'model';
    const ctx: WorldCtx = { world, viewer: { accountId: auth.account.id, role: m.role, ...(fromModel && m.role === 'dm' ? { audience: 'ai' as const } : {}) } };
    res.locals.w = ctx;
    // What a model is told never repeats classified content, whatever route it came from (the MCP server, the agent's tools, a client that sends the marker).
    if (ctx.viewer.audience === 'ai') {
      const json = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (repeatsClassified(db, libraryOf(db), body, `${req.method} ${req.path}`, world.id)) return res.status(409).type('json').send(JSON.stringify({ error: 'Withheld: this answer repeats classified content, which is never sent to any AI.' }));
        return json(body);
      }) as typeof res.json;
    }
    next();
  };
}

export function requireDM(req: Request, res: Response, next: NextFunction) {
  if ((res.locals.w as WorldCtx).viewer.role !== 'dm') throw new HttpError(403, 'DMs only');
  next();
}

export function requirePlayerOrDM(req: Request, res: Response, next: NextFunction) {
  if ((res.locals.w as WorldCtx).viewer.role === 'guest') throw new HttpError(403, 'Guests can only read');
  next();
}

/** Simple per-key failure counter to slow down password guessing. */
export class Throttle {
  private fails = new Map<string, { n: number; until: number }>();
  private max: number;
  private lockMs: number;
  constructor(max = 5, lockMs = 60_000) {
    this.max = max;
    this.lockMs = lockMs;
  }
  check(key: string) {
    const f = this.fails.get(key);
    if (f && f.until > Date.now()) throw new HttpError(429, 'Too many tries. Wait a minute and try again.');
  }
  fail(key: string) {
    const f = this.fails.get(key) ?? { n: 0, until: 0 };
    f.n++;
    if (f.n >= this.max) { f.until = Date.now() + this.lockMs; f.n = 0; }
    this.fails.set(key, f);
  }
  ok(key: string) {
    this.fails.delete(key);
  }
}
