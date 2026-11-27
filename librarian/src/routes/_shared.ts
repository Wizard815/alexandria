import type { Request, Response } from 'express';
import type { WorldCtx } from '../core/auth.ts';
import { type DB, all } from '../core/db.ts';
import { DEFAULT_SETTINGS, type Viewer, type WorldSettings } from '../core/policy.ts';
import { parseJson } from '../core/util.ts';

export const ctx = (res: Response) => res.locals.w as WorldCtx;
export const isDM = (res: Response) => ctx(res).viewer.role === 'dm';
export const me = (res: Response) => ctx(res).viewer.accountId;

/**
 * Who a read is answered for. A GM who adds ?view=players gets exactly what a player gets: the screen lying on the table is
 * seen by the players, so it asks for their copy instead of trusting the page to hide things. `keepAccount` keeps the GM's
 * account id (for a signed picture address) while still dropping the role; otherwise the id goes too, so nothing the GM
 * authored or owns ("only me" marks, the GM's own combatant) can match. Anyone else always gets their own view.
 */
export function readerFor(req: Request, res: Response, keepAccount = false): Viewer {
  const v = ctx(res).viewer;
  if (v.role !== 'dm' || req.query.view !== 'players') return v;
  return { accountId: keepAccount ? v.accountId : '', role: 'player' };
}

export function settings(res: Response): WorldSettings {
  return { ...DEFAULT_SETTINGS, ...parseJson(ctx(res).world.settings, {}) };
}

export function memberIds(db: DB, worldId: string, roles: string[] = ['dm', 'player', 'guest']): string[] {
  return all<{ account_id: string; role: string }>(db, 'SELECT account_id, role FROM members WHERE world_id = ?', worldId)
    .filter((m) => roles.includes(m.role))
    .map((m) => m.account_id);
}

export function names(db: DB, worldId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of all<any>(db, 'SELECT a.id, a.display_name, m.character_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ?', worldId)) {
    out[m.id] = m.character_name || m.display_name;
  }
  return out;
}
