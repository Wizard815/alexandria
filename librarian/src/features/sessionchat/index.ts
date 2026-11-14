// Session chats (table + party) and trade offers between players.
// Party chat is for players only: every route and every live event goes
// through canRead()/readable() in chat.ts, so the DM, an admin, a DM's key
// and the DM agent get a 403 and never a live event.
import { Router, type Response } from 'express';
import type { Deps } from '../../app.ts';
import { requireDM, requirePlayerOrDM } from '../../core/auth.ts';
import { all, one, run, type DB } from '../../core/db.ts';
import { only } from '../../core/events.ts';
import type { Viewer } from '../../core/policy.ts';
import { HttpError, int, now, str } from '../../core/util.ts';
import { ctx, isDM, me, names, settings } from '../../routes/_shared.ts';
import type { Feature } from '../types.ts';
import {
  EDIT_WINDOW_MS, MAX_BODY, addMessage, canRead, canWrite, checkLinks, currentSession, endSession, isChannel, purgeChat, readable,
  sessionOut, startSession, unreadCounts, viewMessage, mentionIds, type Channel,
} from './chat.ts';
import { acceptTrade, closeTrade, createTrade, tradeOut } from './trade.ts';

const audit = (db: DB, worldId: string, accountId: string, action: string, detail = '') => { run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now()); };

const feature: Feature = {
  id: 'sessionchat',
  schema: `
    CREATE TABLE IF NOT EXISTS sessionchat_sessions (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      started_by TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      audio_session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS sessionchat_sessions_world ON sessionchat_sessions(world_id, started_at);
    CREATE TABLE IF NOT EXISTS sessionchat_messages (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessionchat_sessions(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('table', 'party')),
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      reply_to TEXT,
      kind TEXT NOT NULL DEFAULT 'text',
      roll TEXT,
      mentions TEXT NOT NULL DEFAULT '[]',
      edited_at TEXT,
      deleted_at TEXT,
      hidden_at TEXT,
      hidden_by TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessionchat_messages_chan ON sessionchat_messages(session_id, channel, at);
    CREATE TABLE IF NOT EXISTS sessionchat_reactions (
      message_id TEXT NOT NULL REFERENCES sessionchat_messages(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      PRIMARY KEY (message_id, account_id, emoji)
    );
    CREATE TABLE IF NOT EXISTS sessionchat_reads (
      account_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessionchat_sessions(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      last_at TEXT NOT NULL,
      PRIMARY KEY (account_id, session_id, channel)
    );
    CREATE TABLE IF NOT EXISTS sessionchat_trades (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      offer_item_id TEXT,
      offer_item_name TEXT,
      offer_qty INTEGER NOT NULL DEFAULT 0,
      offer_cp INTEGER NOT NULL DEFAULT 0,
      want_item_name TEXT,
      want_qty INTEGER NOT NULL DEFAULT 0,
      want_cp INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'declined', 'cancelled')),
      fail_reason TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS sessionchat_trades_world ON sessionchat_trades(world_id, created_at);
  `,
  worldMount: 'sessionchat',
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    const { db } = d;
    const W = (res: Response) => ctx(res).world.id;
    const viewer = (res: Response): Viewer => ctx(res).viewer;
    const roles = (worldId: string) => all<any>(db, 'SELECT account_id, role FROM members WHERE world_id = ?', worldId).map((m) => ({ accountId: m.account_id as string, role: m.role as Viewer['role'] }));

    /** Send each reader their own view of a message; only readers of the channel get it. */
    function fanout(worldId: string, channel: Channel, type: string, row: any) {
      for (const v of roles(worldId)) {
        if (!canRead(v, channel)) continue;
        d.hub.emit(worldId, 'chat', { type, channel, sessionId: row.session_id, message: viewMessage(db, row, v, worldId) }, only(v.accountId));
      }
    }
    const channelOf = (res: Response, raw: unknown, write = false): Channel => {
      if (!isChannel(raw)) throw new HttpError(404, 'No such chat');
      const v = viewer(res);
      if (!canRead(v, raw)) throw new HttpError(403, 'Party chat is for the players only');
      if (write && !canWrite(v, raw)) throw new HttpError(403, 'Guests can only read');
      return raw;
    };
    const sessionById = (res: Response, sid: string) => {
      const s = one<any>(db, 'SELECT * FROM sessionchat_sessions WHERE id = ? AND world_id = ?', sid, W(res));
      if (!s) throw new HttpError(404, 'Session not found');
      return s;
    };
    const messageFor = (res: Response, mid: string) => {
      const m = one<any>(db, 'SELECT * FROM sessionchat_messages WHERE id = ? AND world_id = ?', mid, W(res));
      // A message in a channel the caller cannot read does not exist for them.
      if (!m || !canRead(viewer(res), m.channel)) throw new HttpError(404, 'Message not found');
      return m;
    };
    const openSession = (m: any) => {
      if (one(db, 'SELECT 1 FROM sessionchat_sessions WHERE id = ? AND ended_at IS NOT NULL', m.session_id)) throw new HttpError(409, 'This session has ended; its chat is read-only');
    };

    // ---- sessions ----

    /** The current session (or null) and my channels with unread counts. */
    r.get('/current', (_req, res) => {
      purgeChat(db);
      const s = currentSession(db, W(res));
      const v = viewer(res);
      res.json({
        session: sessionOut(s),
        channels: readable(v).map((c) => ({ channel: c, canWrite: !!s && canWrite(v, c), unread: s ? unreadCounts(db, W(res), s.id, v.accountId, c) : 0 })),
      });
    });

    r.get('/sessions', (_req, res) => {
      currentSession(db, W(res));
      const v = viewer(res);
      res.json(all<any>(db, 'SELECT * FROM sessionchat_sessions WHERE world_id = ? ORDER BY started_at DESC LIMIT 100', W(res)).map((s) => ({
        ...sessionOut(s),
        counts: Object.fromEntries(readable(v).map((c) => [c, one<any>(db, 'SELECT COUNT(*) AS n FROM sessionchat_messages WHERE session_id = ? AND channel = ? AND deleted_at IS NULL', s.id, c)!.n])),
      })));
    });

    r.post('/sessions/start', requireDM, (req, res) => {
      const w = W(res);
      const cur = currentSession(db, w);
      if (cur) throw new HttpError(409, 'A session is already running');
      const s = startSession(db, w, str(req.body?.title, 'title', { max: 100, optional: true }) || 'Game night', me(res), 'manual', null);
      audit(db, w, me(res), 'sessionchat.start', s.title);
      for (const m of roles(w)) d.hub.emit(w, 'chat-session', { session: sessionOut(s) }, only(m.accountId));
      res.status(201).json(sessionOut(s));
    });

    r.post('/sessions/end', requireDM, (_req, res) => {
      const w = W(res);
      const cur = currentSession(db, w);
      if (!cur) throw new HttpError(409, 'No session is running');
      endSession(db, cur.id, now());
      audit(db, w, me(res), 'sessionchat.end', cur.title);
      const ended = one<any>(db, 'SELECT * FROM sessionchat_sessions WHERE id = ?', cur.id);
      for (const m of roles(w)) d.hub.emit(w, 'chat-session', { session: sessionOut(ended) }, only(m.accountId));
      res.json(sessionOut(ended));
    });

    // ---- messages ----

    r.get('/chat/:channel', (req, res) => {
      const ch = channelOf(res, req.params.channel);
      const w = W(res);
      const sid = typeof req.query.session === 'string' ? sessionById(res, req.query.session).id : currentSession(db, w)?.id;
      if (!sid) return res.json({ session: null, messages: [] });
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
      const before = typeof req.query.before === 'string' ? req.query.before : '9999';
      const rows = all<any>(db, 'SELECT * FROM sessionchat_messages WHERE session_id = ? AND channel = ? AND at < ? ORDER BY at DESC, rowid DESC LIMIT ?', sid, ch, before, limit).reverse();
      const v = viewer(res);
      res.json({ session: sessionOut(one<any>(db, 'SELECT * FROM sessionchat_sessions WHERE id = ?', sid)), messages: rows.map((m) => viewMessage(db, m, v, w)) });
    });

    r.post('/chat/:channel', requirePlayerOrDM, (req, res) => {
      const ch = channelOf(res, req.params.channel, true);
      const w = W(res);
      const s = currentSession(db, w);
      if (!s) throw new HttpError(409, isDM(res) ? 'No session is running: press Start session' : 'No session is running yet');
      if (typeof req.body?.body !== 'string') throw new HttpError(400, 'body must be text');
      const row = addMessage(db, w, { sessionId: s.id, channel: ch, authorId: me(res), role: viewer(res).role, body: req.body.body, replyTo: typeof req.body?.replyTo === 'string' ? req.body.replyTo : null });
      fanout(w, ch, 'new', row);
      res.status(201).json(viewMessage(db, row, viewer(res), w));
    });

    r.patch('/messages/:mid', requirePlayerOrDM, (req, res) => {
      const m = messageFor(res, String(req.params.mid));
      if (m.author_id !== me(res)) throw new HttpError(403, 'You can only edit your own messages');
      openSession(m);
      if (m.deleted_at) throw new HttpError(404, 'Message not found');
      if (m.kind !== 'text') throw new HttpError(400, 'Dice rolls cannot be edited');
      if (Date.now() - new Date(m.at).getTime() > EDIT_WINDOW_MS) throw new HttpError(403, 'Messages can only be edited for 10 minutes');
      const body = str(req.body?.body, 'body', { max: MAX_BODY }).trim();
      if (!body) throw new HttpError(400, 'Say something first');
      checkLinks(db, W(res), body, viewer(res).role);
      const ping = new Set(roles(W(res)).filter((x) => canRead(x, m.channel)).map((x) => x.accountId));
      const mentions = mentionIds(db, W(res), body).filter((a) => ping.has(a) && a !== m.author_id);
      run(db, 'UPDATE sessionchat_messages SET body = ?, mentions = ?, edited_at = ? WHERE id = ?', body, JSON.stringify(mentions), now(), m.id);
      const row = one<any>(db, 'SELECT * FROM sessionchat_messages WHERE id = ?', m.id);
      fanout(W(res), m.channel, 'edit', row);
      res.json(viewMessage(db, row, viewer(res), W(res)));
    });

    r.delete('/messages/:mid', requirePlayerOrDM, (req, res) => {
      const m = messageFor(res, String(req.params.mid));
      if (m.author_id !== me(res)) throw new HttpError(403, 'You can only delete your own messages');
      openSession(m);
      if (Date.now() - new Date(m.at).getTime() > EDIT_WINDOW_MS) throw new HttpError(403, 'Messages can only be deleted for 10 minutes');
      run(db, 'UPDATE sessionchat_messages SET deleted_at = ? WHERE id = ?', now(), m.id);
      const row = one<any>(db, 'SELECT * FROM sessionchat_messages WHERE id = ?', m.id);
      fanout(W(res), m.channel, 'delete', row);
      res.json({ ok: true });
    });

    // Moderation: the DM hides a table-chat message. Party chat is not theirs to moderate.
    r.post('/messages/:mid/hide', requireDM, (req, res) => {
      const m = messageFor(res, String(req.params.mid));
      if (m.channel !== 'table') throw new HttpError(403, 'Only table chat can be moderated');
      const hide = req.body?.hidden !== false;
      run(db, 'UPDATE sessionchat_messages SET hidden_at = ?, hidden_by = ? WHERE id = ?', hide ? now() : null, hide ? me(res) : null, m.id);
      audit(db, W(res), me(res), hide ? 'sessionchat.hide' : 'sessionchat.unhide', m.id);
      const row = one<any>(db, 'SELECT * FROM sessionchat_messages WHERE id = ?', m.id);
      fanout(W(res), 'table', 'hide', row);
      res.json(viewMessage(db, row, viewer(res), W(res)));
    });

    r.post('/messages/:mid/react', requirePlayerOrDM, (req, res) => {
      const m = messageFor(res, String(req.params.mid));
      openSession(m);
      const emoji = str(req.body?.emoji, 'emoji', { max: 16 });
      if (m.deleted_at || (m.hidden_at && !isDM(res))) throw new HttpError(404, 'Message not found');
      const has = one(db, 'SELECT 1 FROM sessionchat_reactions WHERE message_id = ? AND account_id = ? AND emoji = ?', m.id, me(res), emoji);
      if (has && req.body?.on !== true) run(db, 'DELETE FROM sessionchat_reactions WHERE message_id = ? AND account_id = ? AND emoji = ?', m.id, me(res), emoji);
      else if (!has) {
        if (one<any>(db, 'SELECT COUNT(DISTINCT emoji) AS n FROM sessionchat_reactions WHERE message_id = ?', m.id)!.n >= 12) throw new HttpError(400, 'That message has enough reactions');
        run(db, 'INSERT INTO sessionchat_reactions (message_id, account_id, emoji) VALUES (?, ?, ?)', m.id, me(res), emoji);
      }
      fanout(W(res), m.channel, 'react', m);
      res.json(viewMessage(db, m, viewer(res), W(res)));
    });

    r.post('/read', (req, res) => {
      const ch = channelOf(res, req.body?.channel);
      const s = typeof req.body?.session === 'string' ? sessionById(res, req.body.session) : currentSession(db, W(res));
      if (s) run(db, `INSERT INTO sessionchat_reads (account_id, session_id, channel, last_at) VALUES (?, ?, ?, ?) ON CONFLICT (account_id, session_id, channel) DO UPDATE SET last_at = excluded.last_at`, me(res), s.id, ch, now());
      res.json({ ok: true });
    });

    // ---- trades ----

    const tradeAudience = (t: any) => only(t.from_id, t.to_id);
    const emitTrade = (w: string, t: any) => d.hub.emit(w, 'trade', tradeOut(t), tradeAudience(t));
    const tradingOn = (res: Response) => {
      if (!settings(res).playerTransfers) throw new HttpError(403, 'Giving and trading is turned off in this world; ask the DM');
    };
    const playerOnly = (res: Response) => { if (viewer(res).role !== 'player') throw new HttpError(403, 'Trades are between players'); };

    r.get('/trades', (_req, res) => {
      playerOnly(res);
      res.json(all<any>(db, 'SELECT * FROM sessionchat_trades WHERE world_id = ? AND (from_id = ? OR to_id = ?) ORDER BY created_at DESC LIMIT 100', W(res), me(res), me(res)).map(tradeOut));
    });

    r.post('/trades', requirePlayerOrDM, (req, res) => {
      playerOnly(res);
      tradingOn(res);
      const w = W(res);
      const b = req.body ?? {};
      const toId = str(b.to, 'to', { max: 60 });
      if (!roles(w).some((m) => m.accountId === toId && m.role === 'player')) throw new HttpError(400, 'Trade with a player in this world');
      const offerItemId = typeof b.offerItemId === 'string' && b.offerItemId ? b.offerItemId : null;
      const wantItem = typeof b.wantItem === 'string' && b.wantItem.trim() ? str(b.wantItem, 'wantItem', { max: 120 }).trim() : null;
      const t = createTrade(db, w, {
        fromId: me(res), toId, offerItemId,
        offerQty: offerItemId ? int(b.offerQty, 'offerQty', { min: 1, max: 1_000_000, optional: true }) ?? 1 : 0,
        offerCp: int(b.offerCp, 'offerCp', { min: 0, max: 100_000_000, optional: true }) ?? 0,
        wantItemName: wantItem,
        wantQty: wantItem ? int(b.wantQty, 'wantQty', { min: 1, max: 1_000_000, optional: true }) ?? 1 : 0,
        wantCp: int(b.wantCp, 'wantCp', { min: 0, max: 100_000_000, optional: true }) ?? 0,
        note: str(b.note, 'note', { max: 200, optional: true }),
      });
      audit(db, w, me(res), 'trade.offer', `${me(res)}->${toId}`);
      emitTrade(w, t);
      res.status(201).json(tradeOut(t));
    });

    r.post('/trades/:tid/accept', requirePlayerOrDM, (req, res) => {
      playerOnly(res);
      tradingOn(res);
      const w = W(res);
      const nm = names(db, w);
      const t = acceptTrade(db, w, String(req.params.tid), me(res), typeof req.body?.itemId === 'string' ? req.body.itemId : null, (x) => (x === 'party' ? 'the party pouch' : nm[x] ?? 'someone'));
      audit(db, w, me(res), 'trade.accept', t.id);
      emitTrade(w, t);
      for (const o of [t.from_id, t.to_id]) {
        d.hub.emit(w, 'item', { id: t.offer_item_id ?? '' }, only(o));
        d.hub.emit(w, 'coin', { owner: o, balance: undefined }, only(o));
        d.hub.emit(w, 'transfer', { kind: 'trade', id: t.id }, only(o));
      }
      res.json(tradeOut(t));
    });
    for (const [verb, how] of [['decline', 'declined'], ['cancel', 'cancelled']] as const) {
      r.post(`/trades/:tid/${verb}`, requirePlayerOrDM, (req, res) => {
        playerOnly(res);
        const t = closeTrade(db, W(res), String(req.params.tid), me(res), how);
        emitTrade(W(res), t);
        res.json(tradeOut(t));
      });
    }

    return r;
  },
  mcpTools: [
    { name: 'read_table_chat', description: 'The table chat of the current game session (everyone in the world, DM included): newest messages, dice rolls and replies.', props: { limit: { type: 'integer', description: 'How many messages (default 50, max 200)' } }, call: (a) => ({ method: 'GET', path: `/sessionchat/chat/table?limit=${Math.min(200, Math.max(1, Number(a.limit) || 50))}` }) },
    { name: 'send_table_chat', write: true, description: 'Post to the table chat of the current game session as the DM. Start with /roll 2d6+3 for a server-side dice roll. Player keys are read-only, so players post from the app.', props: { body: { type: 'string', description: 'Up to 2000 characters' }, replyTo: { type: 'string', description: 'Message id to reply to' } }, required: ['body'], call: (a) => ({ method: 'POST', path: '/sessionchat/chat/table', body: { body: a.body, replyTo: a.replyTo } }) },
    { name: 'read_party_chat', playerOnly: true, description: 'The party chat of the current game session: players only. The DM cannot read it.', props: { limit: { type: 'integer', description: 'How many messages (default 50, max 200)' } }, call: (a) => ({ method: 'GET', path: `/sessionchat/chat/party?limit=${Math.min(200, Math.max(1, Number(a.limit) || 50))}` }) },
  ],
  start: (d: Deps) => {
    const t = setInterval(() => { try { purgeChat(d.db); } catch { /* next time */ } }, 3_600_000);
    t.unref?.();
    return () => clearInterval(t);
  },
};
export default feature;
