// "Me" (a player's own character profile, block by block, each with who can
// see it) and "People" (NPCs the party has met: what they said, recalls,
// and each player's private notes on them).
import { Router } from 'express';
import type { Deps } from '../app.ts';
import { one, all, run } from '../core/db.ts';
import { requireDM, requirePlayerOrDM } from '../core/auth.ts';
import { canSee } from '../core/policy.ts';
import { HttpError, id, int, now, oneOf, str } from '../core/util.ts';
import { ctx, isDM, me, memberIds } from './_shared.ts';

export default function peopleRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;

  // ---- Me ----
  r.get('/profiles/:aid', (req, res) => {
    const c = ctx(res);
    const aid = String(req.params.aid) === 'me' ? me(res) : String(req.params.aid);
    if (!memberIds(db, c.world.id).includes(aid)) throw new HttpError(404, 'Player not found');
    const blocks = all<any>(db, 'SELECT * FROM profile_blocks WHERE world_id = ? AND account_id = ? ORDER BY section, sort', c.world.id, aid)
      .filter((b) => canSee(c.viewer, b.visibility, b.account_id));
    const m = one<any>(db, 'SELECT a.display_name, m.character_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.account_id = ?', c.world.id, aid);
    res.json({ accountId: aid, name: m.character_name || m.display_name, blocks });
  });

  r.put('/profiles/me/blocks', requirePlayerOrDM, (req, res) => {
    const c = ctx(res);
    const b = req.body ?? {};
    const vals = {
      section: oneOf(b.section, 'section', ['story', 'traits', 'goals', 'bonds', 'basics'] as const),
      title: str(b.title, 'title', { max: 120 }),
      body: str(b.body, 'body', { max: 20_000, optional: true }),
      visibility: oneOf(b.visibility, 'visibility', ['me', 'dm', 'party'] as const, 'me'),
      sort: int(b.sort, 'sort', { min: 0, max: 1000, optional: true }) ?? 0,
    };
    let bid = b.id ? str(b.id, 'id', { max: 60 }) : null;
    if (bid) {
      if (!run(db, 'UPDATE profile_blocks SET section = ?, title = ?, body = ?, visibility = ?, sort = ? WHERE id = ? AND world_id = ? AND account_id = ?', vals.section, vals.title, vals.body, vals.visibility, vals.sort, bid, c.world.id, me(res))) throw new HttpError(404, 'Block not found');
    } else {
      bid = id('blk_');
      run(db, 'INSERT INTO profile_blocks (id, world_id, account_id, section, title, body, visibility, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', bid, c.world.id, me(res), vals.section, vals.title, vals.body, vals.visibility, vals.sort);
    }
    res.json({ id: bid, ...vals });
  });

  r.delete('/profiles/me/blocks/:bid', (req, res) => {
    if (!run(db, 'DELETE FROM profile_blocks WHERE id = ? AND world_id = ? AND account_id = ?', String(req.params.bid), ctx(res).world.id, me(res))) throw new HttpError(404, 'Block not found');
    res.json({ ok: true });
  });

  // ---- People ----
  r.get('/people', (_req, res) => {
    const c = ctx(res);
    const people = all<any>(db, 'SELECT * FROM people WHERE world_id = ? ORDER BY name', c.world.id).filter((p) => canSee(c.viewer, p.visibility, null));
    res.json(people.map((p) => ({
      ...p,
      quotes: all<any>(db, 'SELECT id, text, said, visibility FROM quotes WHERE person_id = ?', p.id).filter((q) => canSee(c.viewer, q.visibility, null)),
      recalls: all(db, 'SELECT id, account_id, text, success, at FROM recalls WHERE person_id = ? ORDER BY at', p.id),
      myNote: one<any>(db, 'SELECT body FROM person_notes WHERE person_id = ? AND account_id = ?', p.id, me(res))?.body ?? '',
    })));
  });

  r.post('/people', requireDM, (req, res) => {
    const c = ctx(res);
    const b = req.body ?? {};
    const p = {
      id: id('ppl_'), name: str(b.name, 'name', { max: 120 }), role: str(b.role, 'role', { max: 120, optional: true }),
      attitude: str(b.attitude, 'attitude', { max: 60, optional: true }), kind: oneOf(b.kind, 'kind', ['ally', 'neutral', 'rival'] as const, 'neutral'),
      page_id: b.pageId ? str(b.pageId, 'pageId', { max: 60 }) : null, met: str(b.met, 'met', { max: 60, optional: true }),
      visibility: oneOf(b.visibility, 'visibility', ['dm', 'party'] as const, 'party'),
    };
    if (p.page_id && !one(db, 'SELECT 1 FROM pages WHERE id = ? AND world_id = ?', p.page_id, c.world.id)) throw new HttpError(400, 'Page not found');
    run(db, 'INSERT INTO people (id, world_id, name, role, attitude, kind, page_id, met, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', p.id, c.world.id, p.name, p.role, p.attitude, p.kind, p.page_id, p.met, p.visibility);
    if (p.visibility === 'party') d.hub.emit(c.world.id, 'person', p, () => true);
    res.status(201).json(p);
  });

  const person = (res: any, pid: string) => {
    const p = one<any>(db, 'SELECT * FROM people WHERE id = ? AND world_id = ?', pid, ctx(res).world.id);
    if (!p || !canSee(ctx(res).viewer, p.visibility, null)) throw new HttpError(404, 'Person not found');
    return p;
  };

  r.patch('/people/:pid', requireDM, (req, res) => {
    const p = person(res, String(req.params.pid));
    const b = req.body ?? {};
    run(db, 'UPDATE people SET name = ?, role = ?, attitude = ?, kind = ?, met = ?, visibility = ? WHERE id = ?',
      b.name !== undefined ? str(b.name, 'name', { max: 120 }) : p.name,
      b.role !== undefined ? str(b.role, 'role', { max: 120, optional: true }) : p.role,
      b.attitude !== undefined ? str(b.attitude, 'attitude', { max: 60, optional: true }) : p.attitude,
      b.kind !== undefined ? oneOf(b.kind, 'kind', ['ally', 'neutral', 'rival'] as const) : p.kind,
      b.met !== undefined ? str(b.met, 'met', { max: 60, optional: true }) : p.met,
      b.visibility !== undefined ? oneOf(b.visibility, 'visibility', ['dm', 'party'] as const) : p.visibility, p.id);
    res.json({ ok: true });
  });

  r.post('/people/:pid/quotes', requireDM, (req, res) => {
    const p = person(res, String(req.params.pid));
    const q = { id: id('quo_'), person_id: p.id, text: str(req.body?.text, 'text', { max: 1000 }), said: str(req.body?.said, 'said', { max: 80, optional: true }), visibility: oneOf(req.body?.visibility, 'visibility', ['dm', 'party'] as const, 'party') };
    run(db, 'INSERT INTO quotes (id, person_id, text, said, visibility) VALUES (?, ?, ?, ?, ?)', q.id, q.person_id, q.text, q.said, q.visibility);
    if (q.visibility === 'party' && p.visibility === 'party') d.hub.emit(ctx(res).world.id, 'quote', q, () => true);
    res.status(201).json(q);
  });

  // Recalls: what a character remembered (or failed to) about a person.
  r.post('/people/:pid/recalls', requireDM, (req, res) => {
    const p = person(res, String(req.params.pid));
    const aid = str(req.body?.accountId, 'accountId', { max: 60 });
    if (!memberIds(db, ctx(res).world.id, ['player']).includes(aid)) throw new HttpError(400, 'Player not found');
    if (typeof req.body?.success !== 'boolean') throw new HttpError(400, 'success must be true or false');
    const x = { id: id('rec_'), person_id: p.id, account_id: aid, text: str(req.body?.text, 'text', { max: 1000 }), success: req.body.success ? 1 : 0, at: now() };
    run(db, 'INSERT INTO recalls (id, person_id, account_id, text, success, at) VALUES (?, ?, ?, ?, ?, ?)', x.id, x.person_id, x.account_id, x.text, x.success, x.at);
    if (p.visibility === 'party') d.hub.emit(ctx(res).world.id, 'recall', x, () => true);
    res.status(201).json(x);
  });

  // Each player's own note on a person. Nobody else, DM included, reads it.
  r.put('/people/:pid/note', requirePlayerOrDM, (req, res) => {
    const p = person(res, String(req.params.pid));
    const body = str(req.body?.body, 'body', { max: 10_000, optional: true });
    run(db, `INSERT INTO person_notes (person_id, account_id, body) VALUES (?, ?, ?) ON CONFLICT (person_id, account_id) DO UPDATE SET body = excluded.body`, p.id, me(res), body);
    res.json({ ok: true, dm: isDM(res) });
  });

  return r;
}
