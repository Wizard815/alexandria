import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { all, one, run } from '../core/db.ts';
import { type Auth, bearer, requireDM } from '../core/auth.ts';
import { mergeSettings, settingsFor } from '../core/policy.ts';
import { HttpError, int, now, oneOf, sha256 } from '../core/util.ts';
import { ctx, isDM, me, settings } from './_shared.ts';

export function listMyWorlds(d: Deps) {
  return (_req: Request, res: Response) => {
    const a = (res.locals.auth as Auth);
    let rows = all<any>(d.db, `SELECT w.id, w.slug, w.name, m.role FROM members m JOIN worlds w ON w.id = m.world_id WHERE m.account_id = ? ORDER BY w.name`, a.account.id);
    if (a.via === 'scribe_key') rows = rows.filter((w) => w.id === a.keyWorldId);
    res.json(rows);
  };
}

export { settingsFor } from '../core/policy.ts';

export default function worldRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;

  r.get('/', (_req, res) => {
    const c = ctx(res);
    res.json({ id: c.world.id, slug: c.world.slug, name: c.world.name, role: c.viewer.role, settings: settingsFor(settings(res), c.viewer.role) });
  });

  // People in this world, by name. Players see names and roles, nothing else.
  r.get('/members', (_req, res) => {
    res.json(all(db, `SELECT a.id, a.display_name, m.role, m.character_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? ORDER BY m.role, a.display_name`, ctx(res).world.id));
  });

  r.get('/settings', (_req, res) => res.json(settingsFor(settings(res), ctx(res).viewer.role)));
  r.patch('/settings', requireDM, (req, res) => {
    const c = ctx(res);
    let next;
    try {
      next = mergeSettings(settings(res), req.body ?? {});
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
    run(db, 'UPDATE worlds SET settings = ? WHERE id = ?', JSON.stringify(next), c.world.id);
    audit(db, c.world.id, me(res), 'settings.update', Object.keys(req.body ?? {}).join(','));
    d.hub.emitPer(c.world.id, 'settings', (v) => settingsFor(next, v.role));
    res.json(next);
  });

  // Invite codes for players and guests. The code is shown once.
  r.post('/invites', requireDM, (req, res) => {
    const c = ctx(res);
    const role = oneOf(req.body?.role, 'role', ['player', 'guest'] as const, 'player');
    const days = int(req.body?.days, 'days', { min: 1, max: 30, optional: true }) ?? 7;
    const code = randomBytes(8).toString('base64url');
    run(db, 'INSERT INTO invites (code_hash, world_id, role, created_by, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(code), c.world.id, role, me(res), new Date(Date.now() + days * 864e5).toISOString());
    audit(db, c.world.id, me(res), 'invite.create', role);
    res.status(201).json({ code, role, expiresInDays: days });
  });

  // Live updates for this world. Each event is filtered per viewer.
  r.get('/events', (req, res) => {
    const c = ctx(res);
    const auth = res.locals.auth as Auth;
    const hash = sha256(bearer(req) ?? '');
    // Checked again for every event: a person removed from the world, moved to another role, signed out or whose key was revoked gets nothing more.
    const alive = () => {
      const m = one<{ role: string }>(db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', c.world.id, c.viewer.accountId);
      if (!m || m.role !== c.viewer.role) return false;
      if (auth.via === 'session') return !!one(db, 'SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?', hash, now());
      return !!one(db, 'SELECT 1 FROM api_keys k JOIN accounts a ON a.id = k.account_id WHERE k.key_hash = ? AND k.revoked = 0 AND (k.scope <> \'admin\' OR a.is_admin = 1)', hash);
    };
    d.hub.subscribe(c.world.id, c.viewer, res, alive);
  });

  r.get('/audit', requireDM, (req, res) => {
    res.json(all(db, 'SELECT * FROM audit WHERE world_id = ? ORDER BY id DESC LIMIT ?', ctx(res).world.id, Math.min(Number(req.query.limit) || 100, 1000)));
  });

  r.get('/whoami', (_req, res) => res.json({ ...ctx(res).viewer, dm: isDM(res), at: now() }));

  return r;
}
