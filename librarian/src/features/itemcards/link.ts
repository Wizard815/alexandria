// Shared by the inventory routes (add/edit accept pageId) and the card routes.
import type { Response } from 'express';
import type { Deps } from '../../app.ts';
import { HttpError } from '../../core/util.ts';
import { ctx } from '../../routes/_shared.ts';

/**
 * Check a pageId from a request body. undefined = not sent (leave alone),
 * null = clear the link. A page must exist in this world; players may only
 * link pages they can open (shared pages), so a player can never point an
 * item at a DM-only page.
 */
export function checkPageId(d: Deps, res: Response, raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 120) throw new HttpError(400, 'pageId must be a page id or null');
  const c = ctx(res);
  try {
    return String((d.library.get(c.world.id, raw, c.viewer) as any).id);
  } catch {
    throw new HttpError(400, 'Pick a page you can open');
  }
}
