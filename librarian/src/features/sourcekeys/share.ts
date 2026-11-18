// Sharing pages: /api/worlds/:world/library/pages/:id/share (mounted by routes/library.ts).
//
// What a player sees through their OWN key is theirs alone until they share it.
// A player may share a page they can see; the DM may share any page that is
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
  const rowsOf = (res: any, pageId: string) => {
    const nm = names(d.db, W(res));
    const rows = all<any>(d.db, 'SELECT from_id, to_id, kind, created_at FROM sourcekeys_shares WHERE world_id = ? AND page_id = ? ORDER BY created_at', W(res), pageId)
      .filter((x) => isDM(res) || x.from_id === me(res) || x.to_id === me(res) || x.to_id === '*');
    return { shares: rows.map((x) => ({ from: x.from_id, fromName: nm[x.from_id] ?? 'Someone', to: x.to_id === '*' ? 'party' : x.to_id, toName: x.to_id === '*' ? 'Everyone' : nm[x.to_id] ?? 'Someone', kind: x.kind, createdAt: x.created_at })) };
  };

  r.get('/', (req, res) => {
    if (ctx(res).viewer.role === 'guest') throw new HttpError(404, 'Page not found');
    const pg = pageOf(req, res);
    res.json(rowsOf(res, pg.id));
  });

  r.post('/', (req, res) => {
    const pg = pageOf(req, res);
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

  // Unshare: with `to` ("party" or a player's id) only that one; without, every share of this page that this person made (the DM may end any).
  r.delete('/', (req, res) => {
    if (ctx(res).viewer.role === 'guest') throw new HttpError(404, 'Page not found');
    const w = W(res);
    const raw = one<{ id: string }>(d.db, 'SELECT id FROM pages WHERE world_id = ? AND (id = ? OR path = ?)', w, String((req.params as any).id), String((req.params as any).id));
    if (!raw) throw new HttpError(404, 'Page not found');
    const q = String((req.query.to ?? req.body?.to ?? '') || '');
    const to = q === 'party' ? '*' : q;
    run(d.db, `DELETE FROM sourcekeys_shares WHERE world_id = ? AND page_id = ? ${isDM(res) ? '' : 'AND from_id = ?'} ${to ? 'AND to_id = ?' : ''}`, w, raw.id, ...(isDM(res) ? [] : [me(res)]), ...(to ? [to] : []));
    auditKey(d.db, w, me(res), 'unshare', `${raw.id} ${q || 'all'}`);
    d.library.touchClassified();
    d.library.changed(w, [raw.id]);
    res.json(rowsOf(res, raw.id));
  });

  return r;
}
