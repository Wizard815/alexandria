// Separate gateway admin sign-in (PLAN §13).
//
// - POST /api/admin-auth/login gives an admin session (alx_ads_...). It works
//   on /api/admin/** and /api/admin-auth/** only; every other route refuses it
//   (see core/auth.ts, authenticate).
// - Admin routes accept: an admin session, an admin key (alx_adm_), or a
//   table session (alx_ses_) only while the server allows it:
//     ALX_ADMIN_TABLE_LOGIN=1, or the server has exactly one account. A table
//     session is never accepted for an account that turned on TOTP.
// - Optional second factor per admin account: TOTP (RFC 6238) plus 10
//   single-use recovery codes.
// - ALX_ADMIN_ALLOW (CIDR list) limits admin login and every admin route by IP.
import { Router, type Express, type Request } from 'express';
import { randomBytes } from 'node:crypto';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { one, run, tx } from '../../core/db.ts';
import { type Auth, type AdminGate, Throttle, authenticate, checkPassword, requireAdmin } from '../../core/auth.ts';
import { HttpError, now, secret, sha256, str } from '../../core/util.ts';
import { parseAllowList, ipAllowed } from './cidr.ts';
import { newSecret, otpauthUri, verifyTotp } from './totp.ts';

const SESSION_HOURS = 12;

// Same row as app.ts's audit(); not imported from there because app.ts waits on the feature registry.
function audit(db: Deps['db'], worldId: string | null, accountId: string | null, action: string, detail = '') {
  run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());
}

export function tableLoginAllowed(d: Pick<Deps, 'db' | 'env'>): boolean {
  if (d.env.ALX_ADMIN_TABLE_LOGIN === '1') return true;
  return (one<{ n: number }>(d.db, 'SELECT COUNT(*) AS n FROM accounts')?.n ?? 0) <= 1;
}

const totpRow = (d: Deps, accountId: string) =>
  one<{ secret: string; enabled: number; last_step: number }>(d.db, 'SELECT secret, enabled, last_step FROM adminauth_totp WHERE account_id = ?', accountId);
const totpOn = (d: Deps, accountId: string) => !!totpRow(d, accountId)?.enabled;

function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const h = randomBytes(5).toString('hex');
    return `${h.slice(0, 5)}-${h.slice(5)}`;
  });
}
const normCode = (c: string) => c.trim().toLowerCase().replace(/\s/g, '');

function useRecovery(d: Deps, accountId: string, code: string): boolean {
  return run(d.db, 'UPDATE adminauth_recovery SET used_at = ? WHERE account_id = ? AND code_hash = ? AND used_at IS NULL', now(), accountId, sha256(normCode(code))) > 0;
}

/** A code from the authenticator app (once per time step) or an unused recovery code. */
function checkSecondFactor(d: Deps, accountId: string, code: string): 'totp' | 'recovery' | null {
  const row = totpRow(d, accountId);
  if (!row) return null;
  const step = verifyTotp(row.secret, code, row.last_step);
  if (step !== null) {
    run(d.db, 'UPDATE adminauth_totp SET last_step = ? WHERE account_id = ?', step, accountId);
    return 'totp';
  }
  if (useRecovery(d, accountId, code)) return 'recovery';
  return null;
}

function install(app: Express, d: Deps) {
  const { db } = d;
  const allow = parseAllowList(d.env.ALX_ADMIN_ALLOW);
  // Stricter than the table login (5 tries): 3 wrong tries per account and address, 10 per address.
  const perUser = new Throttle(3, 5 * 60_000);
  const perIp = new Throttle(10, 5 * 60_000);
  const factor = new Throttle(5, 5 * 60_000);

  const refuseIp = (req: Request, what: string) => {
    if (ipAllowed(req.ip, allow)) return;
    audit(db, null, null, 'admin.ip.refused', `${req.ip} ${what}`);
    throw new HttpError(403, 'Admin access is not allowed from this address');
  };

  const gate: AdminGate = {
    checkIp: (req) => refuseIp(req, `${req.method} ${req.originalUrl.split('?')[0]}`),
    checkAdmin: (auth: Auth) => {
      if (auth.via !== 'session') return;
      if (!tableLoginAllowed(d)) throw new HttpError(403, 'Sign in at /admin/login to use the admin pages');
      if (totpOn(d, auth.account.id)) throw new HttpError(403, 'This account uses an authenticator code. Sign in at /admin/login');
    },
  };
  app.locals.adminGate = gate;

  const r = Router();
  const A = authenticate(db);

  r.get('/status', (req, res) => {
    refuseIp(req, 'status');
    res.json({ tableLogin: tableLoginAllowed(d), restricted: allow.length > 0 });
  });

  r.post('/login', (req, res) => {
    refuseIp(req, 'login');
    const username = str(req.body?.username, 'username', { max: 40 });
    const password = str(req.body?.password, 'password', { max: 200 });
    const code = typeof req.body?.totp === 'string' ? req.body.totp : '';
    const uKey = `${username.toLowerCase()}|${req.ip}`;
    const iKey = `ip|${req.ip}`;
    try { perUser.check(uKey); perIp.check(iKey); } catch (e) {
      audit(db, null, null, 'admin.login.blocked', `${username} from ${req.ip}`);
      throw e;
    }
    const fail = (why: string, status = 401, msg = 'Wrong username or password') => {
      perUser.fail(uKey); perIp.fail(iKey);
      audit(db, null, acc?.id ?? null, 'admin.login.fail', `${username} from ${req.ip}: ${why}`);
      throw new HttpError(status, msg);
    };
    const acc = one<any>(db, 'SELECT id, username, display_name, is_admin, pass_hash FROM accounts WHERE username = ?', username);
    if (!acc || !checkPassword(password, acc.pass_hash)) return fail('bad password');
    if (!acc.is_admin) return fail('not an admin');
    let via = 'password';
    if (totpOn(d, acc.id)) {
      if (!code) {
        // The password was right: tell the form to ask for a code. Not a failed try.
        res.status(428).json({ error: 'Enter the code from your authenticator app', totpRequired: true });
        return;
      }
      const got = checkSecondFactor(d, acc.id, code);
      if (!got) return fail('bad code', 401, 'That code is wrong or was already used');
      via = got === 'recovery' ? 'password+recovery code' : 'password+totp';
    }
    perUser.ok(uKey); perIp.ok(iKey);
    db.prepare('DELETE FROM adminauth_sessions WHERE expires_at < ?').run(now());
    const token = secret('alx_ads_');
    const exp = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
    run(db, 'INSERT INTO adminauth_sessions (token_hash, account_id, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)', sha256(token), acc.id, now(), exp, req.ip ?? '');
    audit(db, null, acc.id, 'admin.login', `${username} from ${req.ip} (${via})`);
    if (via.endsWith('recovery code')) audit(db, null, acc.id, 'admin.recovery.used', `${one<any>(db, 'SELECT COUNT(*) AS n FROM adminauth_recovery WHERE account_id = ? AND used_at IS NULL', acc.id)!.n} left`);
    const { pass_hash: _p, ...account } = acc;
    res.json({ account: { ...account, is_admin: true }, token, expiresAt: exp });
  });

  // Everything below needs admin rights (admin session, admin key or an allowed table session).
  const admin = [A, requireAdmin];

  r.post('/logout', A, (req, res) => {
    const auth = res.locals.auth as Auth;
    if (auth.via === 'admin_session') {
      run(db, 'DELETE FROM adminauth_sessions WHERE token_hash = ?', sha256(req.headers.authorization?.slice(7) ?? ''));
      audit(db, null, auth.account.id, 'admin.logout');
    }
    res.json({ ok: true });
  });

  r.get('/me', ...admin, (req, res) => {
    const auth = res.locals.auth as Auth;
    const left = one<any>(db, 'SELECT COUNT(*) AS n FROM adminauth_recovery WHERE account_id = ? AND used_at IS NULL', auth.account.id)!.n;
    res.json({
      account: { ...auth.account, is_admin: true },
      via: auth.via,
      totp: { enabled: totpOn(d, auth.account.id), recoveryCodesLeft: left },
      network: { restricted: allow.length > 0, ranges: allow.map((c) => c.text), yourIp: req.ip, yourIpAllowed: ipAllowed(req.ip, allow) },
      tableLogin: tableLoginAllowed(d),
    });
  });

  const needFactor = (req: Request, accountId: string, code: unknown) => {
    const k = `factor|${accountId}`;
    factor.check(k);
    const c = typeof code === 'string' ? code : '';
    if (!c || !checkSecondFactor(d, accountId, c)) {
      factor.fail(k);
      audit(db, null, accountId, 'admin.totp.fail', `from ${req.ip}`);
      throw new HttpError(400, 'That code is wrong or was already used');
    }
    factor.ok(k);
  };

  r.post('/totp/setup', ...admin, (req, res) => {
    const auth = res.locals.auth as Auth;
    if (totpOn(d, auth.account.id)) throw new HttpError(409, 'An authenticator is already on. Turn it off first.');
    const s = newSecret();
    run(db, `INSERT INTO adminauth_totp (account_id, secret, enabled, last_step, created_at) VALUES (?, ?, 0, -1, ?)
      ON CONFLICT(account_id) DO UPDATE SET secret = excluded.secret, enabled = 0, last_step = -1, created_at = excluded.created_at`, auth.account.id, s, now());
    audit(db, null, auth.account.id, 'admin.totp.setup', `from ${req.ip}`);
    res.json({ secret: s, uri: otpauthUri('Alexandria', auth.account.username, s) });
  });

  r.post('/totp/enable', ...admin, (req, res) => {
    const auth = res.locals.auth as Auth;
    const row = totpRow(d, auth.account.id);
    if (!row) throw new HttpError(409, 'Start the setup first');
    if (row.enabled) throw new HttpError(409, 'An authenticator is already on');
    const k = `factor|${auth.account.id}`;
    factor.check(k);
    const step = verifyTotp(row.secret, str(req.body?.code, 'code', { max: 20 }));
    if (step === null) {
      factor.fail(k);
      audit(db, null, auth.account.id, 'admin.totp.fail', `enable from ${req.ip}`);
      throw new HttpError(400, 'That code is wrong. Check the time on your phone.');
    }
    factor.ok(k);
    const codes = newRecoveryCodes();
    tx(db, () => {
      run(db, 'UPDATE adminauth_totp SET enabled = 1, last_step = ? WHERE account_id = ?', step, auth.account.id);
      run(db, 'DELETE FROM adminauth_recovery WHERE account_id = ?', auth.account.id);
      for (const c of codes) run(db, 'INSERT INTO adminauth_recovery (account_id, code_hash) VALUES (?, ?)', auth.account.id, sha256(normCode(c)));
    });
    audit(db, null, auth.account.id, 'admin.totp.enable', `from ${req.ip}`);
    res.json({ enabled: true, recoveryCodes: codes, note: 'Save these recovery codes now. Each works once and they are not shown again.' });
  });

  r.post('/totp/disable', ...admin, (req, res) => {
    const auth = res.locals.auth as Auth;
    if (!totpOn(d, auth.account.id)) throw new HttpError(409, 'No authenticator is on');
    needFactor(req, auth.account.id, req.body?.code);
    tx(db, () => {
      run(db, 'DELETE FROM adminauth_totp WHERE account_id = ?', auth.account.id);
      run(db, 'DELETE FROM adminauth_recovery WHERE account_id = ?', auth.account.id);
    });
    audit(db, null, auth.account.id, 'admin.totp.disable', `from ${req.ip}`);
    res.json({ enabled: false });
  });

  r.post('/totp/recovery', ...admin, (req, res) => {
    const auth = res.locals.auth as Auth;
    if (!totpOn(d, auth.account.id)) throw new HttpError(409, 'No authenticator is on');
    const row = totpRow(d, auth.account.id)!;
    const k = `factor|${auth.account.id}`;
    factor.check(k);
    // A fresh authenticator code only: a recovery code can't mint more recovery codes.
    const step = verifyTotp(row.secret, str(req.body?.code, 'code', { max: 20 }), row.last_step);
    if (step === null) { factor.fail(k); throw new HttpError(400, 'That code is wrong or was already used'); }
    factor.ok(k);
    const codes = newRecoveryCodes();
    tx(db, () => {
      run(db, 'UPDATE adminauth_totp SET last_step = ? WHERE account_id = ?', step, auth.account.id);
      run(db, 'DELETE FROM adminauth_recovery WHERE account_id = ?', auth.account.id);
      for (const c of codes) run(db, 'INSERT INTO adminauth_recovery (account_id, code_hash) VALUES (?, ?)', auth.account.id, sha256(normCode(c)));
    });
    audit(db, null, auth.account.id, 'admin.totp.recovery_codes', `from ${req.ip}`);
    res.json({ recoveryCodes: codes });
  });

  app.use('/api/admin-auth', r);
}

const feature: Feature = {
  id: 'adminauth',
  schema: `
CREATE TABLE IF NOT EXISTS adminauth_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS adminauth_totp (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_step INTEGER NOT NULL DEFAULT -1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS adminauth_recovery (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY (account_id, code_hash)
);`,
  appRoutes: install,
};
export default feature;
