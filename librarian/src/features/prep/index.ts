// Session prep: before a game night the GM's assistant drafts a short note for each player (where their
// character stands, what happened last time, their open goals, something to think about), the GM reads and edits
// each one, and sends it. A sent prep arrives as a private chat between the GM and that player (Messages), kept so
// it does not expire.
//
// Spoilers: each draft is written by the Players model from that player's own brief (features/playerhelp/quick.ts:
// their sheet, items, goals, journal, the published session log and what the party heard) and nothing else. The
// GM's own line (`note`) is added as written. A draft is the GM's alone until it is sent.
import { Router, type Response } from 'express';
import type { Deps } from '../../app.ts';
import { chat, hasJob, ModelUnavailable, wouldBeRefused } from '../../core/ai.ts';
import { requireGM } from '../../core/auth.ts';
import { all, one, run, tx } from '../../core/db.ts';
import { gmOnly, only } from '../../core/events.ts';
import { HttpError, id, now, str } from '../../core/util.ts';
import { ctx, isGM, me, settings } from '../../routes/_shared.ts';
import { kitPart, quickBrief, stripThinking } from '../playerhelp/quick.ts';
import type { Feature } from '../types.ts';

const schema = `
CREATE TABLE IF NOT EXISTS prep_notes (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent')),
  by_model INTEGER NOT NULL DEFAULT 0,
  thread_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS prep_notes_world ON prep_notes (world_id, status, created_at);
`;

const MAX_TEXT = 4000;

const SYSTEM = [
  'You write a short session prep note for one player of a tabletop RPG, sent by their GM before the next game night.',
  'Write to the player as "you", warm and brief, in Markdown, under 170 words, with these parts when the brief has them:',
  '**Last time** (2 or 3 bullets), **Where you stand** (health, conditions, what matters in their pack, spells they could learn), **Your threads** (their open goals and quests), and one line **To think about** before the session (a choice or a question for their character).',
  'Use only the brief. Never invent people, places, events, items or numbers. Leave a part out when the brief has nothing for it. Do not mention the brief, notes or context.',
].join('\n');

interface Row { id: string; world_id: string; account_id: string; title: string; text: string; status: 'draft' | 'sent'; by_model: number; thread_id: string | null; created_at: string; updated_at: string; sent_at: string | null }
const out = (r: Row, names: Map<string, string>) => ({ id: r.id, accountId: r.account_id, name: names.get(r.account_id) ?? '', title: r.title, text: r.text, status: r.status, byModel: !!r.by_model, threadId: r.thread_id, createdAt: r.created_at, updatedAt: r.updated_at, sentAt: r.sent_at });

const playersOf = (d: Deps, w: string) => all<any>(d.db, "SELECT m.account_id AS id, COALESCE(NULLIF(m.character_name, ''), a.display_name) AS name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.role = 'player' ORDER BY name COLLATE NOCASE", w) as { id: string; name: string }[];

/** One player's draft: the Players model on their own brief, or the brief itself when no model answers. */
async function draftFor(d: Deps, res: Response, aid: string, name: string): Promise<{ text: string; byModel: boolean }> {
  const c = ctx(res);
  const s = settings(res);
  const brief = await quickBrief(d, c.world.id, aid, s, 'recap', '');
  const kit = kitPart(d, c.world.id, aid).trim();
  const text = `${brief.text}${kit && !wouldBeRefused(d, kit) ? `\n\n## What they can do\n${kit.slice(0, 1200)}` : ''}`.trim();
  if (!text) return { text: `Hi ${name}! See you at the next session.`, byModel: false };
  if (hasJob(d, 'player')) {
    try {
      const r = await chat(d, 'player', { messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `The player's character: ${name}.\n\n${text}` }], maxTokens: 500, temperature: 0.4 });
      const t = stripThinking(r.content).trim();
      if (t) return { text: t.slice(0, MAX_TEXT), byModel: true };
    } catch (e) { if (!(e instanceof ModelUnavailable)) throw e; }
  }
  // No model: the brief's own parts, so the GM still has something to edit.
  return { text: brief.sections.filter((x) => x.label !== 'Library (shared with the party)').map((x) => `**${x.label}**\n${x.text}`).join('\n\n').slice(0, MAX_TEXT), byModel: false };
}

function routes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;
  const W = (res: Response) => ctx(res).world.id;
  const names = (w: string) => new Map(playersOf(d, w).map((p) => [p.id, p.name]));
  const changed = (w: string) => d.hub.emit(w, 'prep', {}, gmOnly);

  // The GM: every draft and the last sent ones. A player: the preps sent to them.
  r.get('/', (_req, res) => {
    const w = W(res);
    const rows = isGM(res)
      ? all<Row>(db, "SELECT * FROM prep_notes WHERE world_id = ? AND (status = 'draft' OR sent_at > ?) ORDER BY status, created_at DESC LIMIT 200", w, new Date(Date.now() - 14 * 864e5).toISOString())
      : all<Row>(db, "SELECT * FROM prep_notes WHERE world_id = ? AND account_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 20", w, me(res));
    res.json({ preps: rows.map((x) => out(x, names(w))), model: hasJob(d, 'player') });
  });

  // Draft a prep for each player (or the ones named). An older draft for the same player is replaced.
  r.post('/', requireGM, async (req, res) => {
    const w = W(res);
    const all_ = playersOf(d, w);
    const wanted: unknown = req.body?.accountIds;
    const pick = Array.isArray(wanted) && wanted.length
      ? all_.filter((p) => wanted.some((x) => typeof x === 'string' && (x === p.id || x.trim().toLowerCase() === p.name.toLowerCase())))
      : all_;
    if (!pick.length) throw new HttpError(400, Array.isArray(wanted) && wanted.length ? 'None of those are players in this world' : 'There are no players yet');
    const title = str(req.body?.title, 'title', { max: 120, optional: true }) || 'Before our next session';
    const note = str(req.body?.note, 'note', { max: 1000, optional: true })?.trim() ?? '';
    const made: Row[] = [];
    for (const p of pick) {
      const dft = await draftFor(d, res, p.id, p.name);
      const text = `${dft.text}${note ? `\n\n**From the GM:** ${note}` : ''}`.slice(0, MAX_TEXT);
      const row: Row = { id: id('prep_'), world_id: w, account_id: p.id, title, text, status: 'draft', by_model: dft.byModel ? 1 : 0, thread_id: null, created_at: now(), updated_at: now(), sent_at: null };
      tx(db, () => {
        run(db, "DELETE FROM prep_notes WHERE world_id = ? AND account_id = ? AND status = 'draft'", w, p.id);
        run(db, 'INSERT INTO prep_notes (id, world_id, account_id, title, text, status, by_model, thread_id, created_at, updated_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', row.id, w, row.account_id, row.title, row.text, row.status, row.by_model, null, row.created_at, row.updated_at, null);
      });
      made.push(row);
    }
    changed(w);
    res.status(201).json({ preps: made.map((x) => out(x, names(w))) });
  });

  const draftOf = (res: Response, pid: string) => {
    const x = one<Row>(db, 'SELECT * FROM prep_notes WHERE id = ? AND world_id = ?', pid, W(res));
    if (!x) throw new HttpError(404, 'Prep not found');
    return x;
  };

  r.patch('/:pid', requireGM, (req, res) => {
    const x = draftOf(res, String(req.params.pid));
    if (x.status !== 'draft') throw new HttpError(409, 'This prep was already sent');
    const text = req.body?.text !== undefined ? str(req.body.text, 'text', { max: MAX_TEXT }).trim() : x.text;
    if (!text) throw new HttpError(400, 'text is required');
    const title = req.body?.title !== undefined ? (str(req.body.title, 'title', { max: 120 }).trim() || x.title) : x.title;
    run(db, 'UPDATE prep_notes SET text = ?, title = ?, updated_at = ? WHERE id = ?', text, title, now(), x.id);
    changed(W(res));
    res.json(out(one<Row>(db, 'SELECT * FROM prep_notes WHERE id = ?', x.id)!, names(W(res))));
  });

  r.delete('/:pid', requireGM, (req, res) => {
    const x = draftOf(res, String(req.params.pid));
    run(db, 'DELETE FROM prep_notes WHERE id = ?', x.id);
    changed(W(res));
    res.json({ ok: true });
  });

  // Send drafts (the ones named, or every draft): each becomes a kept private chat between the GM and that player.
  r.post('/send', requireGM, (req, res) => {
    const w = W(res);
    const ids: unknown = req.body?.ids;
    const rows = Array.isArray(ids) && ids.length
      ? ids.map((x) => one<Row>(db, "SELECT * FROM prep_notes WHERE id = ? AND world_id = ? AND status = 'draft'", String(x), w)).filter((x): x is Row => !!x)
      : all<Row>(db, "SELECT * FROM prep_notes WHERE world_id = ? AND status = 'draft' ORDER BY created_at", w);
    if (!rows.length) throw new HttpError(409, 'No drafts to send. Draft the session prep first.');
    const gmId = me(res);
    const sent: Row[] = [];
    for (const x of rows) {
      const at = now();
      const tid = id('thr_');
      const mid = id('msg_');
      tx(db, () => {
        run(db, 'INSERT INTO threads (id, world_id, starter_id, title, kept, created_at, last_at) VALUES (?, ?, ?, ?, 1, ?, ?)', tid, w, gmId, x.title.slice(0, 100), at, at);
        for (const p of new Set([gmId, x.account_id])) run(db, 'INSERT INTO thread_members (thread_id, account_id) VALUES (?, ?)', tid, p);
        run(db, 'INSERT INTO messages (id, thread_id, author_id, body, at) VALUES (?, ?, ?, ?, ?)', mid, tid, gmId, x.text.slice(0, 4000), at);
        run(db, "UPDATE prep_notes SET status = 'sent', thread_id = ?, sent_at = ?, updated_at = ? WHERE id = ?", tid, at, at, x.id);
      });
      const members = [gmId, x.account_id];
      d.hub.emit(w, 'thread', { id: tid, world_id: w, starter_id: gmId, title: x.title, kept: true, members, created_at: at, last_at: at }, only(...members));
      d.hub.emit(w, 'message', { id: mid, thread_id: tid, author_id: gmId, body: x.text, at }, only(...members));
      d.hub.emit(w, 'prep', { id: x.id, accountId: x.account_id, sent: true }, only(gmId, x.account_id));
      sent.push({ ...x, status: 'sent', thread_id: tid, sent_at: at });
    }
    res.json({ sent: sent.map((x) => out(x, names(w))) });
  });

  return r;
}

const feature: Feature = {
  id: 'prep',
  schema,
  worldMount: 'prep',
  worldRoutes: routes,
  mcpTools: [
    {
      name: 'draft_session_prep', gmOnly: true,
      description: "GM: draft a short session prep note for each player (or the ones named), each written only from what that player knows: last time, where their character stands, their open goals, one thing to think about. The GM's own line (note) is added as written. Drafts wait for the GM; send them with send_session_prep.",
      props: { accountIds: { type: 'array', items: { type: 'string' }, description: 'Players (account ids or character names); leave out for everyone' }, note: { type: 'string', description: 'A line from the GM for every player, e.g. "We start in the crypt; bring your sheets."' }, title: { type: 'string' } },
      call: (a) => ({ method: 'POST', path: '/prep', body: { accountIds: a.accountIds, note: a.note, title: a.title } }),
    },
    { name: 'list_session_prep', gmOnly: true, description: 'GM: the session prep drafts waiting to be sent, and the ones sent in the last two weeks.', props: {}, call: () => ({ method: 'GET', path: '/prep' }) },
    {
      name: 'edit_session_prep', write: true,
      description: "GM: change one session prep draft's text or title before it is sent (its id from list_session_prep).",
      props: { id: { type: 'string' }, text: { type: 'string' }, title: { type: 'string' } },
      required: ['id'],
      call: (a) => ({ method: 'PATCH', path: `/prep/${encodeURIComponent(String(a.id))}`, body: { text: a.text, title: a.title } }),
    },
    {
      name: 'send_session_prep', write: true,
      description: 'GM: send session prep drafts to their players (the ids named, or every draft). Each player gets theirs as a private message from the GM.',
      props: { ids: { type: 'array', items: { type: 'string' }, description: 'Draft ids; leave out to send every draft' } },
      call: (a) => ({ method: 'POST', path: '/prep/send', body: { ids: a.ids } }),
    },
  ],
};
export default feature;
