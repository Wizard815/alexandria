import { Router } from 'express';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { one, all, run, tx } from '../core/db.ts';
import {
  type Auth, authenticate, checkPassword, createAccount, createKey, createSession, hashPassword,
  validatePassword, validateUsername,
} from '../core/auth.ts';
import { HttpError, now, oneOf, sha256, str } from '../core/util.ts';

export default function authRoutes(d: Deps) {
  const r = Router();
  const { db } = d;

  // First run: the first account becomes the admin. Closed once any account exists.
  r.get('/setup', (_req, res) => {
    res.json({ needsSetup: !one(db, 'SELECT 1 FROM accounts LIMIT 1') });
  });
  r.post('/setup', (req, res) => {
    const username = validateUsername(req.body?.username);
    const password = validatePassword(req.body?.password);
    const acc = tx(db, () => {
      if (one(db, 'SELECT 1 FROM accounts LIMIT 1')) throw new HttpError(409, 'Setup is already done');
      return createAccount(db, username, password, true);
    });
    audit(db, null, acc.id, 'setup', username);
    res.status(201).json({ account: acc, token: createSession(db, acc.id) });
  });

  r.post('/auth/login', (req, res) => {
    const username = str(req.body?.username, 'username', { max: 40 });
    const password = str(req.body?.password, 'password', { max: 200 });
    const key = `${username.toLowerCase()}|${req.ip}`;
    d.throttle.check(key);
    const acc = one<any>(db, 'SELECT id, username, display_name, is_admin, pass_hash FROM accounts WHERE username = ?', username);
    if (!acc || !checkPassword(password, acc.pass_hash)) {
      d.throttle.fail(key);
      throw new HttpError(401, 'Wrong username or password');
    }
    d.throttle.ok(key);
    const { pass_hash: _, ...account } = acc;
    res.json({ account, token: createSession(db, acc.id) });
  });

  // Reset a password with a one-time code from an admin.
  r.post('/auth/reset', (req, res) => {
    const username = validateUsername(req.body?.username);
    const code = str(req.body?.code, 'code', { max: 100 });
    const password = validatePassword(req.body?.password);
    const key = `reset|${username.toLowerCase()}`;
    d.throttle.check(key);
    const row = one<any>(db, `SELECT rc.code_hash, a.id FROM reset_codes rc JOIN accounts a ON a.id = rc.account_id
      WHERE a.username = ? AND rc.code_hash = ? AND rc.used = 0 AND rc.expires_at > ?`, username, sha256(code), now());
    if (!row) {
      d.throttle.fail(key);
      throw new HttpError(400, 'That code is wrong or has expired');
    }
    tx(db, () => {
      run(db, 'UPDATE reset_codes SET used = 1 WHERE code_hash = ?', row.code_hash);
      run(db, 'UPDATE accounts SET pass_hash = ? WHERE id = ?', hashPassword(password), row.id);
      run(db, 'DELETE FROM sessions WHERE account_id = ?', row.id);
    });
    audit(db, null, row.id, 'password.reset');
    res.json({ token: createSession(db, row.id) });
  });

  // Join a world with an invite code from its DM.
  r.post('/join', (req, res) => {
    const code = str(req.body?.code, 'code', { max: 100 });
    d.throttle.check(`join|${req.ip}`);
    const inv = one<any>(db, 'SELECT * FROM invites WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?', sha256(code), now());
    if (!inv) {
      d.throttle.fail(`join|${req.ip}`);
      throw new HttpError(400, 'That invite code is wrong or has expired');
    }
    const username = validateUsername(req.body?.username);
    const password = validatePassword(req.body?.password);
    const character = str(req.body?.characterName, 'characterName', { max: 80, optional: true }) || null;
    const acc = tx(db, () => {
      const a = createAccount(db, username, password, false, str(req.body?.displayName, 'displayName', { max: 60, optional: true }) || undefined);
      run(db, 'INSERT INTO members (world_id, account_id, role, character_name) VALUES (?, ?, ?, ?)', inv.world_id, a.id, inv.role, character);
      run(db, 'UPDATE invites SET used_by = ? WHERE code_hash = ?', a.id, inv.code_hash);
      return a;
    });
    audit(db, inv.world_id, acc.id, 'join', inv.role);
    res.status(201).json({ account: acc, token: createSession(db, acc.id), worldId: inv.world_id });
  });

  const A = authenticate(db);

  r.post('/auth/logout', A, (req, res) => {
    const tok = req.headers.authorization?.slice(7) ?? '';
    run(db, 'DELETE FROM sessions WHERE token_hash = ?', sha256(tok));
    res.json({ ok: true });
  });

  r.get('/me', A, (_req, res) => {
    const a = (res.locals.auth as Auth).account;
    const worlds = all(db, `SELECT w.id, w.slug, w.name, m.role, m.character_name FROM members m JOIN worlds w ON w.id = m.world_id WHERE m.account_id = ? ORDER BY w.name`, a.id);
    const theme = one<{ theme: string | null }>(db, 'SELECT theme FROM accounts WHERE id = ?', a.id)?.theme;
    res.json({ account: { ...a, is_admin: !!a.is_admin }, theme: theme ? JSON.parse(theme) : null, worlds });
  });

  // Per-account look: race theme, light/dark, effects on or off.
  r.put('/me/theme', A, (req, res) => {
    const a = (res.locals.auth as Auth).account;
    const theme = {
      race: str(req.body?.race, 'race', { max: 30, optional: true }) || 'human',
      mode: oneOf(req.body?.mode, 'mode', ['dark', 'light'] as const, 'dark'),
      effects: req.body?.effects !== false,
    };
    run(db, 'UPDATE accounts SET theme = ? WHERE id = ?', JSON.stringify(theme), a.id);
    res.json(theme);
  });

  r.post('/me/password', A, (req, res) => {
    const a = (res.locals.auth as Auth).account;
    const row = one<any>(db, 'SELECT pass_hash FROM accounts WHERE id = ?', a.id);
    if (!checkPassword(str(req.body?.current, 'current', { max: 200 }), row?.pass_hash)) throw new HttpError(400, 'Current password is wrong');
    run(db, 'UPDATE accounts SET pass_hash = ? WHERE id = ?', hashPassword(validatePassword(req.body?.password)), a.id);
    audit(db, null, a.id, 'password.change');
    res.json({ ok: true });
  });

  // MCP / app keys. Shown once; only the hash is kept.
  r.get('/keys', A, (_req, res) => {
    const a = (res.locals.auth as Auth).account;
    res.json(all(db, 'SELECT id, scope, world_id, label, prefix, created_at, last_used_at, revoked FROM api_keys WHERE account_id = ? ORDER BY created_at DESC', a.id));
  });
  r.post('/keys', A, (req, res) => {
    const auth = res.locals.auth as Auth;
    if (auth.via !== 'session') throw new HttpError(403, 'Make keys from a signed-in session, not with another key');
    const scope = oneOf(req.body?.scope, 'scope', ['admin', 'scribe'] as const);
    const label = str(req.body?.label, 'label', { max: 60 });
    let worldId: string | null = null;
    if (scope === 'admin') {
      if (!auth.account.is_admin) throw new HttpError(403, 'Only admins can make admin keys');
    } else {
      worldId = str(req.body?.worldId, 'worldId', { max: 60 });
      if (!one(db, 'SELECT 1 FROM members WHERE world_id = ? AND account_id = ?', worldId, auth.account.id)) throw new HttpError(404, 'World not found');
    }
    const k = createKey(db, auth.account.id, scope, label, worldId);
    audit(db, worldId, auth.account.id, 'key.create', `${scope} ${label}`);
    res.status(201).json({ id: k.id, key: k.key, note: 'Copy this key now. It will not be shown again.' });
  });
  r.delete('/keys/:id', A, (req, res) => {
    const a = (res.locals.auth as Auth).account;
    if (!run(db, 'UPDATE api_keys SET revoked = 1 WHERE id = ? AND account_id = ?', String(req.params.id), a.id)) throw new HttpError(404, 'Key not found');
    audit(db, null, a.id, 'key.revoke', String(req.params.id));
    res.json({ ok: true });
  });

  return r;
}
