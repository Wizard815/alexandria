// Chats between people in a world. Only members of a chat can read it - the
// DM included: a DM is not in a player chat unless someone adds them.
// Chats delete themselves after the world's messageDays unless the person
// who started the chat presses Keep.
import { Router } from 'express';
import type { Deps } from '../app.ts';
import { type DB, one, all, run, tx } from '../core/db.ts';
import { requirePlayerOrDM } from '../core/auth.ts';
import { only } from '../core/events.ts';
import { DEFAULT_SETTINGS } from '../core/policy.ts';
import { HttpError, id, now, parseJson, str } from '../core/util.ts';
import { ctx, me, memberIds, settings } from './_shared.ts';

export function purgeExpiredThreads(db: DB) {
  for (const w of all<any>(db, 'SELECT id, settings FROM worlds')) {
    const days = { ...DEFAULT_SETTINGS, ...parseJson(w.settings, {}) }.messageDays;
    if (!days) continue;
    const cutoff = new Date(Date.now() - days * 864e5).toISOString();
    run(db, 'DELETE FROM threads WHERE world_id = ? AND kept = 0 AND created_at < ?', w.id, cutoff);
  }
}

export default function messageRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;

  function thread(res: any, tid: string) {
    const t = one<any>(db, `SELECT t.* FROM threads t JOIN thread_members tm ON tm.thread_id = t.id AND tm.account_id = ? WHERE t.id = ? AND t.world_id = ?`, me(res), tid, ctx(res).world.id);
    if (!t) throw new HttpError(404, 'Chat not found');
    return t;
  }
  const membersOf = (tid: string) => all<any>(db, 'SELECT account_id FROM thread_members WHERE thread_id = ?', tid).map((m) => m.account_id);
  const expiresAt = (t: any, days: number | null) => (t.kept || !days ? null : new Date(new Date(t.created_at).getTime() + days * 864e5).toISOString());

  r.get('/', (_req, res) => {
    purgeExpiredThreads(db);
    const days = settings(res).messageDays;
    const rows = all<any>(db, `SELECT t.*, (SELECT body FROM messages m WHERE m.thread_id = t.id ORDER BY at DESC LIMIT 1) AS last
      FROM threads t JOIN thread_members tm ON tm.thread_id = t.id AND tm.account_id = ? WHERE t.world_id = ? ORDER BY t.last_at DESC`, me(res), ctx(res).world.id);
    res.json(rows.map((t) => ({ ...t, kept: !!t.kept, members: membersOf(t.id), expiresAt: expiresAt(t, days), canKeep: t.starter_id === me(res) })));
  });

  r.post('/', requirePlayerOrDM, (req, res) => {
    const c = ctx(res);
    const wanted: unknown = req.body?.members;
    if (!Array.isArray(wanted) || !wanted.length || wanted.length > 50) throw new HttpError(400, 'members must list who is in the chat');
    const allowed = new Set(memberIds(db, c.world.id));
    const people = new Set<string>([me(res)]);
    for (const m of wanted) {
      if (typeof m !== 'string' || !allowed.has(m)) throw new HttpError(400, 'Everyone in a chat must be in this world');
      people.add(m);
    }
    const t = { id: id('thr_'), world_id: c.world.id, starter_id: me(res), title: str(req.body?.title, 'title', { max: 100, optional: true }) || '', kept: 0, created_at: now(), last_at: now() };
    tx(db, () => {
      run(db, 'INSERT INTO threads (id, world_id, starter_id, title, kept, created_at, last_at) VALUES (?, ?, ?, ?, 0, ?, ?)', t.id, t.world_id, t.starter_id, t.title, t.created_at, t.last_at);
      for (const p of people) run(db, 'INSERT INTO thread_members (thread_id, account_id) VALUES (?, ?)', t.id, p);
    });
    const out = { ...t, kept: false, members: [...people] };
    d.hub.emit(c.world.id, 'thread', out, only(...people));
    res.status(201).json(out);
  });

  r.get('/:tid', (req, res) => {
    const t = thread(res, String(req.params.tid));
    res.json({ ...t, kept: !!t.kept, members: membersOf(t.id), messages: all(db, 'SELECT id, author_id, body, at FROM messages WHERE thread_id = ? ORDER BY at', t.id) });
  });

  r.post('/:tid', requirePlayerOrDM, (req, res) => {
    const t = thread(res, String(req.params.tid));
    const m = { id: id('msg_'), thread_id: t.id, author_id: me(res), body: str(req.body?.body, 'body', { max: 4000 }), at: now() };
    run(db, 'INSERT INTO messages (id, thread_id, author_id, body, at) VALUES (?, ?, ?, ?, ?)', m.id, m.thread_id, m.author_id, m.body, m.at);
    run(db, 'UPDATE threads SET last_at = ? WHERE id = ?', m.at, t.id);
    d.hub.emit(ctx(res).world.id, 'message', m, only(...membersOf(t.id)));
    res.status(201).json(m);
  });

  // Add someone to a chat. Any member can, as long as they are in the world.
  r.post('/:tid/members', requirePlayerOrDM, (req, res) => {
    const t = thread(res, String(req.params.tid));
    const who = str(req.body?.accountId, 'accountId', { max: 60 });
    if (!memberIds(db, ctx(res).world.id).includes(who)) throw new HttpError(400, 'They are not in this world');
    run(db, 'INSERT OR IGNORE INTO thread_members (thread_id, account_id) VALUES (?, ?)', t.id, who);
    res.json({ members: membersOf(t.id) });
  });

  r.post('/:tid/keep', (req, res) => {
    const t = thread(res, String(req.params.tid));
    if (t.starter_id !== me(res)) throw new HttpError(403, 'Only the person who started the chat can keep it');
    const kept = req.body?.kept !== false;
    run(db, 'UPDATE threads SET kept = ? WHERE id = ?', kept ? 1 : 0, t.id);
    res.json({ kept });
  });

  return r;
}
