import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { all, one, run } from '../core/db.ts';
import { type Auth, bearer, requireGM } from '../core/auth.ts';
import { mergeSettings, settingsFor } from '../core/policy.ts';
import { HttpError, int, now, oneOf, sha256 } from '../core/util.ts';
import { ctx, isGM, me, settings } from './_shared.ts';

const NEW_KIND: Record<string, string> = {
  'mods.import': 'houseRules', 'mods.update': 'houseRules', 'mods.on': 'houseRules',
  'shop.item.add': 'items', 'shop.items.import': 'items', 'shop.item.edit': 'items',
  'templates.import': 'templates', 'templates.create': 'templates', 'templates.starters': 'templates', 'templates.update': 'templates', 'encounter.template.create': 'templates',
  'modules.import': 'gameModules', 'modules.enable': 'gameModules', 'modules.feed': 'gameModules', 'spells.import': 'spells', 'spells.recipe.import': 'spells',
};
const NEW_VERB: Record<string, string> = {
  'mods.import': 'added house rule ', 'mods.update': 'updated house rule ', 'shop.item.add': 'added item ', 'shop.items.import': 'imported items: ', 'shop.item.edit': 'changed item ',
  'templates.import': 'imported templates: ', 'templates.create': 'made template ', 'templates.starters': 'added starter templates: ', 'templates.update': 'changed template ', 'encounter.template.create': 'made encounter template ',
  'modules.import': 'imported game module ', 'modules.enable': 'turned on game modules ', 'modules.feed': 'fed into spells and items: ', 'spells.import': 'imported spells: ', 'spells.recipe.import': 'imported spell recipes: ',
};
const WHATS_NEW = Object.keys(NEW_KIND);

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
  r.patch('/settings', requireGM, (req, res) => {
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
  r.post('/invites', requireGM, (req, res) => {
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

  r.get('/audit', requireGM, (req, res) => {
    res.json(all(db, 'SELECT * FROM audit WHERE world_id = ? ORDER BY id DESC LIMIT ?', ctx(res).world.id, Math.min(Number(req.query.limit) || 100, 1000)));
  });

  // What the GM added to this world lately (house rules, items, templates and guides, game modules, spells), newest
  // first, for the assistant's "what's new?": the audit log holds every add, so nothing has to register for it.
  r.get('/whats-new', requireGM, (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = all<{ action: string; detail: string; at: string }>(db, `SELECT action, detail, at FROM audit WHERE world_id = ? AND at >= ? AND action IN (${WHATS_NEW.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 200`, ctx(res).world.id, since, ...WHATS_NEW);
    const out: Record<string, { what: string; at: string }[]> = {};
    for (const r of rows) {
      const kind = NEW_KIND[r.action];
      const what = r.action === 'mods.on' ? `turned on ${r.detail.split(',').filter((x) => x && !x.startsWith('-')).map((x) => x.replace(/^\+/, '')).join(', ')}` : `${NEW_VERB[r.action] ?? ''}${r.detail}`.trim();
      if ((out[kind] ??= []).length < 25 && !out[kind].some((x) => x.what === what)) out[kind].push({ what: what.slice(0, 240), at: r.at.slice(0, 16) });
    }
    res.json({ days, ...out, note: Object.keys(out).length ? 'Newest first. Look each one up with its own tool (house_rules, search_items, list_gm_templates, lookup_term).' : `Nothing was added in the last ${days} days.` });
  });

  r.get('/whoami', (_req, res) => res.json({ ...ctx(res).viewer, gm: isGM(res), at: now() }));

  return r;
}
