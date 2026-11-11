// Library admin: accounts, worlds, who plays in which world, and sources.
// Admin is the plumbing. Being an admin does not open any world's content.
import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { one, all, run, tx } from '../core/db.ts';
import { type Auth, createAccount, requireAdmin, validatePassword, validateUsername } from '../core/auth.ts';
import { DEFAULT_SETTINGS } from '../core/policy.ts';
import { HttpError, id, now, oneOf, sha256, str } from '../core/util.ts';

export default function adminRoutes(d: Deps) {
  const r = Router();
  const { db } = d;
  r.use(requireAdmin);
  const me = (res: any) => (res.locals.auth as Auth).account.id;

  r.get('/overview', (_req, res) => {
    res.json({
      accounts: one<any>(db, 'SELECT COUNT(*) AS n FROM accounts')!.n,
      worlds: one<any>(db, 'SELECT COUNT(*) AS n FROM worlds')!.n,
      sources: all(db, 'SELECT s.id, s.kind, s.name, w.name AS world, s.last_sync_at, s.last_status FROM sources s JOIN worlds w ON w.id = s.world_id'),
      liveConnections: all<any>(db, 'SELECT id FROM worlds').reduce((n, w) => n + d.hub.count(w.id), 0),
      runs: all<any>(db, `SELECT r.id, r.status, r.started_at, r.finished_at, r.stats, r.error, s.name AS source, w.name AS world FROM sync_runs r
        JOIN sources s ON s.id = r.source_id JOIN worlds w ON w.id = r.world_id ORDER BY r.started_at DESC LIMIT 15`).map((r) => ({ ...r, stats: JSON.parse(r.stats || '{}') })),
      pages: one<any>(db, 'SELECT COUNT(*) AS n FROM pages')!.n,
      system: {
        dataDir: d.dataDir, vaultsDir: d.vaultsDir, publicUrl: d.env.ALX_PUBLIC_URL ?? null,
        modelEndpoint: !!(d.env.MODEL_BASE_URL || d.env.OPENAI_BASE_URL || d.env.LOCAL_LLM_URL),
        stdioMcpServers: (() => { try { return Object.keys(JSON.parse(d.env.ALX_MCP_STDIO || '{}')); } catch { return []; } })(),
        node: process.version,
      },
    });
  });

  // A consistent copy of the whole database (every world), for backups.
  r.get('/backup', (_req, res) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-backup-'));
    const file = path.join(dir, 'librarian.db');
    try {
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      audit(db, null, me(res), 'backup.download');
      res.setHeader('Content-Type', 'application/vnd.sqlite3');
      res.setHeader('Content-Disposition', `attachment; filename="alexandria-${new Date().toISOString().slice(0, 10)}.db"`);
      res.sendFile(file, () => fs.rmSync(dir, { recursive: true, force: true }));
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  });

  // Accounts
  r.get('/accounts', (_req, res) => {
    res.json(all(db, `SELECT a.id, a.username, a.display_name, a.is_admin, a.created_at,
      (SELECT json_group_array(json_object('world', m.world_id, 'role', m.role)) FROM members m WHERE m.account_id = a.id) AS worlds
      FROM accounts a ORDER BY a.username`).map((a: any) => ({ ...a, is_admin: !!a.is_admin, worlds: JSON.parse(a.worlds) })));
  });

  r.post('/accounts', (req, res) => {
    const username = validateUsername(req.body?.username);
    const pw = req.body?.password ? validatePassword(req.body.password) : null;
    const acc = createAccount(db, username, pw, req.body?.isAdmin === true, str(req.body?.displayName, 'displayName', { max: 60, optional: true }) || undefined);
    audit(db, null, me(res), 'account.create', username);
    // No password given: hand back a one-time code the person uses to set one.
    const code = pw ? null : resetCode(acc.id);
    res.status(201).json({ account: acc, resetCode: code });
  });

  r.patch('/accounts/:id', (req, res) => {
    const acc = one<any>(db, 'SELECT id, is_admin FROM accounts WHERE id = ?', String(req.params.id));
    if (!acc) throw new HttpError(404, 'Account not found');
    if (req.body?.isAdmin !== undefined) {
      if (typeof req.body.isAdmin !== 'boolean') throw new HttpError(400, 'isAdmin must be true or false');
      if (!req.body.isAdmin && acc.is_admin && one<any>(db, 'SELECT COUNT(*) AS n FROM accounts WHERE is_admin = 1')!.n <= 1) {
        throw new HttpError(400, 'Keep at least one admin');
      }
      run(db, 'UPDATE accounts SET is_admin = ? WHERE id = ?', req.body.isAdmin ? 1 : 0, acc.id);
    }
    if (req.body?.displayName !== undefined) run(db, 'UPDATE accounts SET display_name = ? WHERE id = ?', str(req.body.displayName, 'displayName', { max: 60 }), acc.id);
    audit(db, null, me(res), 'account.update', acc.id);
    res.json({ ok: true });
  });

  // One-time reset code (24 h). Signs the account out everywhere when used.
  r.post('/accounts/:id/reset-code', (req, res) => {
    if (!one(db, 'SELECT 1 FROM accounts WHERE id = ?', String(req.params.id))) throw new HttpError(404, 'Account not found');
    audit(db, null, me(res), 'account.reset_code', String(req.params.id));
    res.json({ code: resetCode(String(req.params.id)), expiresInHours: 24 });
  });

  r.delete('/accounts/:id', (req, res) => {
    if (String(req.params.id) === me(res)) throw new HttpError(400, 'You cannot delete your own account');
    if (!run(db, 'DELETE FROM accounts WHERE id = ?', String(req.params.id))) throw new HttpError(404, 'Account not found');
    audit(db, null, me(res), 'account.delete', String(req.params.id));
    res.json({ ok: true });
  });

  function resetCode(accountId: string) {
    const code = randomBytes(6).toString('hex').toUpperCase().replace(/(.{4})(?=.)/g, '$1-');
    run(db, 'INSERT INTO reset_codes (code_hash, account_id, expires_at) VALUES (?, ?, ?)', sha256(code), accountId, new Date(Date.now() + 864e5).toISOString());
    return code;
  }

  // Worlds
  r.get('/worlds', (_req, res) => {
    res.json(all(db, `SELECT w.id, w.slug, w.name, w.created_at, (SELECT COUNT(*) FROM members m WHERE m.world_id = w.id) AS members,
      (SELECT COUNT(*) FROM pages p WHERE p.world_id = w.id) AS pages FROM worlds w ORDER BY w.name`));
  });

  r.post('/worlds', (req, res) => {
    const name = str(req.body?.name, 'name', { max: 80 });
    const slug = str(req.body?.slug, 'slug', { max: 40, optional: true }) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw new HttpError(400, 'Slug must be lowercase letters, numbers and dashes');
    const dm = str(req.body?.dmAccountId, 'dmAccountId', { max: 60 });
    if (!one(db, 'SELECT 1 FROM accounts WHERE id = ?', dm)) throw new HttpError(400, 'DM account not found');
    const wid = id('wld_');
    tx(db, () => {
      if (one(db, 'SELECT 1 FROM worlds WHERE slug = ?', slug)) throw new HttpError(409, 'That slug is taken');
      run(db, 'INSERT INTO worlds (id, slug, name, settings, created_at) VALUES (?, ?, ?, ?, ?)', wid, slug, name, JSON.stringify(DEFAULT_SETTINGS), now());
      run(db, 'INSERT INTO members (world_id, account_id, role) VALUES (?, ?, ?)', wid, dm, 'dm');
    });
    audit(db, wid, me(res), 'world.create', name);
    res.status(201).json({ id: wid, slug, name });
  });

  r.delete('/worlds/:id', (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Send {"confirm": true} to delete a world and everything in it');
    if (!run(db, 'DELETE FROM worlds WHERE id = ?', String(req.params.id))) throw new HttpError(404, 'World not found');
    audit(db, null, me(res), 'world.delete', String(req.params.id));
    res.json({ ok: true });
  });

  // Members
  r.get('/worlds/:id/members', (req, res) => {
    res.json(all(db, 'SELECT a.id, a.username, a.display_name, m.role, m.character_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? ORDER BY m.role, a.username', String(req.params.id)));
  });
  r.put('/worlds/:id/members/:account', (req, res) => {
    const role = oneOf(req.body?.role, 'role', ['dm', 'player', 'guest'] as const);
    if (!one(db, 'SELECT 1 FROM worlds WHERE id = ?', String(req.params.id)) || !one(db, 'SELECT 1 FROM accounts WHERE id = ?', String(req.params.account))) throw new HttpError(404, 'World or account not found');
    const character = str(req.body?.characterName, 'characterName', { max: 80, optional: true }) || null;
    run(db, `INSERT INTO members (world_id, account_id, role, character_name) VALUES (?, ?, ?, ?)
      ON CONFLICT (world_id, account_id) DO UPDATE SET role = excluded.role, character_name = COALESCE(excluded.character_name, members.character_name)`, String(req.params.id), String(req.params.account), role, character);
    audit(db, String(req.params.id), me(res), 'member.set', `${String(req.params.account)} ${role}`);
    res.json({ ok: true });
  });
  r.delete('/worlds/:id/members/:account', (req, res) => {
    if (!run(db, 'DELETE FROM members WHERE world_id = ? AND account_id = ?', String(req.params.id), String(req.params.account))) throw new HttpError(404, 'Member not found');
    run(db, 'UPDATE api_keys SET revoked = 1 WHERE world_id = ? AND account_id = ?', String(req.params.id), String(req.params.account));
    audit(db, String(req.params.id), me(res), 'member.remove', String(req.params.account));
    res.json({ ok: true });
  });

  r.get('/audit', (req, res) => {
    res.json(all(db, 'SELECT * FROM audit ORDER BY id DESC LIMIT ?', Math.min(Number(req.query.limit) || 100, 1000)));
  });

  return r;
}
