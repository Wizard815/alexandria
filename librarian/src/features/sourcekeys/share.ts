// Sharing pages: /api/worlds/:world/library/pages/:id/share (mounted by routes/library.ts).
//
// What a player sees through their OWN key is theirs alone until they share it.
// A player may share a page they can see; the GM may share any page that is
// not broker or classified. Either way the recipient gets the SAME player copy
// (marker levels stripped, never broker or classified), and sharing never lifts
// a page above what the sharer could see. Shares are read live: unsharing, or
// the sharer losing sight of the page (a key revoked), ends them at once, in the
// library, search, offline bulk, MCP and the agent alike.
import { Router } from 'express';
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { HttpError, now } from '../../core/util.ts';
import { normLevel } from '../../core/levels.ts';
import { ctx, isDM, me, memberIds, names } from '../../routes/_shared.ts';
import { auditKey } from './store.ts';

/** GM: every page share in the world, for the Sharing page. Titles only, never page text. */
export function allShares(d: Deps, worldId: string) {
  const nm = names(d.db, worldId);
  return all<any>(d.db, `SELECT s.page_id, s.from_id, s.to_id, s.kind, s.created_at, p.title, p.folder FROM sourcekeys_shares s
    JOIN pages p ON p.id = s.page_id AND p.world_id = s.world_id WHERE s.world_id = ? ORDER BY s.created_at DESC LIMIT 1000`, worldId)
    .map((x) => ({ pageId: x.page_id, title: x.title, from: x.from_id, fromName: nm[x.from_id] ?? 'Someone', to: x.to_id === '*' ? 'party' : x.to_id, toName: x.to_id === '*' ? 'Everyone' : nm[x.to_id] ?? 'Someone', kind: x.kind, createdAt: x.created_at }));
}

export function shareRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const W = (res: any): string => ctx(res).world.id;
  const pageOf = (req: any, res: any) => {
    const pg = one<any>(d.db, 'SELECT id, title, visibility, marker_level FROM pages WHERE world_id = ? AND (id = ? OR path = ?)', W(res), String(req.params.id), String(req.params.id));
    if (!pg) throw new HttpError(404, 'Page not found');
    // A player can share only what they can open; for anything else the page is simply not found.
    if (!isDM(res)) {
      if (ctx(res).viewer.role !== 'player') throw new HttpError(404, 'Page not found');
      try { d.library.get(W(res), pg.id, ctx(res).viewer); } catch { throw new HttpError(404, 'Page not found'); }
    } else if (normLevel(pg.visibility) === 'broker' || normLevel(pg.visibility) === 'classified') throw new HttpError(409, 'A broker or classified page cannot be shared with players');
    return pg;
  };
  /** Why a GM's share of this page would not hold (library.ts liftedInfo skips it and pruneShares deletes it), so it is refused instead of vanishing. */
  const refuseDead = (pg: any, res: any) => {
    if (!isDM(res)) return;
    if (normLevel(pg.visibility) === 'party') throw new HttpError(409, 'Everyone can already see this page');
    if (pg.marker_level != null && pg.marker_level !== 'party') throw new HttpError(409, 'This page is marked GM-only in its own title, tags or text. Remove that mark to share it.');
  };
  const rowsOf = (res: any, pageId: string) => {
    const nm = names(d.db, W(res));
    const rows = all<any>(d.db, 'SELECT from_id, to_id, kind, created_at FROM sourcekeys_shares WHERE world_id = ? AND page_id = ? ORDER BY created_at', W(res), pageId)
      .filter((x) => isDM(res) || x.from_id === me(res) || x.to_id === me(res) || x.to_id === '*');
    const pg = one<any>(d.db, 'SELECT visibility, marker_level FROM pages WHERE id = ?', pageId);
    const everyone = pg ? normLevel(pg.visibility) === 'party' : false;
    const locked = isDM(res) && !!pg && !everyone && pg.marker_level != null && pg.marker_level !== 'party';
    return { everyone, locked, shares: rows.map((x) => ({ from: x.from_id, fromName: nm[x.from_id] ?? 'Someone', to: x.to_id === '*' ? 'party' : x.to_id, toName: x.to_id === '*' ? 'Everyone' : nm[x.to_id] ?? 'Someone', kind: x.kind, createdAt: x.created_at, mine: x.from_id === me(res) })) };
  };

  r.get('/', (req, res) => {
    if (ctx(res).viewer.role === 'guest') throw new HttpError(404, 'Page not found');
    const pg = pageOf(req, res);
    res.json(rowsOf(res, pg.id));
  });

  r.post('/', (req, res) => {
    const pg = pageOf(req, res);
    refuseDead(pg, res);
    const w = W(res);
    const players = new Set(memberIds(d.db, w, ['player']));
    const to = req.body?.to;
    let targets: string[];
    if (to === 'party') targets = ['*'];
    else if (Array.isArray(to) && to.length && to.length <= 50 && to.every((x: unknown) => typeof x === 'string')) {
      targets = [...new Set<string>(to)].filter((x) => x !== me(res));
      if (targets.some((x) => !players.has(x))) throw new HttpError(400, 'to must be "party" or a list of players in this world');
    } else throw new HttpError(400, 'to must be "party" or a list of players in this world');
    const kind = isDM(res) ? 'dm' : 'share';
    for (const t of targets) run(d.db, 'INSERT OR REPLACE INTO sourcekeys_shares (world_id, page_id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)', w, pg.id, me(res), t, kind, now());
    auditKey(d.db, w, me(res), 'share', `${pg.id} to ${targets.join(',')} (${kind})`);
    d.library.touchClassified();
    d.library.changed(w, [pg.id]);
    res.status(201).json(rowsOf(res, pg.id));
  });

  // Unshare: with `to` ("party" or a player's id) only that one; without, every share of this page that this person made (the GM may end any).
  r.delete('/', (req, res) => {
    if (ctx(res).viewer.role === 'guest') throw new HttpError(404, 'Page not found');
    const w = W(res);
    const raw = one<{ id: string }>(d.db, 'SELECT id FROM pages WHERE world_id = ? AND (id = ? OR path = ?)', w, String((req.params as any).id), String((req.params as any).id));
    if (!raw) throw new HttpError(404, 'Page not found');
    const q = String((req.query.to ?? req.body?.to ?? '') || '');
    const to = q === 'party' ? '*' : q;
    if (!isDM(res)) {
      // Only your own shares can be ended by you: say so, rather than doing nothing.
      const others = all<any>(d.db, `SELECT from_id FROM sourcekeys_shares WHERE world_id = ? AND page_id = ? ${to ? 'AND to_id = ?' : ''}`, w, raw.id, ...(to ? [to] : []));
      if (others.length && !others.some((x) => x.from_id === me(res))) throw new HttpError(403, 'You did not make that share, so only the person who did can end it.');
    }
    run(d.db, `DELETE FROM sourcekeys_shares WHERE world_id = ? AND page_id = ? ${isDM(res) ? '' : 'AND from_id = ?'} ${to ? 'AND to_id = ?' : ''}`, w, raw.id, ...(isDM(res) ? [] : [me(res)]), ...(to ? [to] : []));
    auditKey(d.db, w, me(res), 'unshare', `${raw.id} ${q || 'all'}`);
    d.library.touchClassified();
    // Unsharing ends what the recipient shared onward (changed() prunes the chain).
    d.library.changed(w, [raw.id]);
    res.json(rowsOf(res, raw.id));
  });

  return r;
}
