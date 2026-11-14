// Session chat storage and rules. Two channels per game session:
//   table: everyone in the world (DM included)
//   party: players only. Nobody else can read, list or receive it: not the
//          DM, not an admin, not a DM's key, not the DM agent.
// Every reader goes through canRead(); there is no other path to party rows.
import { type DB, all, one, run } from '../../core/db.ts';
import { DEFAULT_SETTINGS } from '../../core/policy.ts';
import type { Role, Viewer } from '../../core/policy.ts';
import { HttpError, id, now, parseJson } from '../../core/util.ts';
import { listSessions } from '../audio/api.ts';
import { isRoll, parseRoll } from './dice.ts';

export type Channel = 'table' | 'party';
export const CHANNELS: readonly Channel[] = ['table', 'party'];
export const EDIT_WINDOW_MS = 10 * 60_000;
export const MAX_BODY = 2000;

export const isChannel = (c: unknown): c is Channel => c === 'table' || c === 'party';
/** Table: every member. Party: players only. */
export const canRead = (v: Viewer, c: Channel) => (c === 'table' ? true : v.role === 'player');
export const canWrite = (v: Viewer, c: Channel) => (c === 'table' ? v.role !== 'guest' : v.role === 'player');

export function readable(v: Viewer): Channel[] { return CHANNELS.filter((c) => canRead(v, c)); }

// ---- sessions ----

/**
 * The session chats belong to: the one the DM started, else the recording
 * session or the people checked in on /live. Starts one by itself only when
 * something is going on that began after the last chat session ended.
 */
export function currentSession(db: DB, worldId: string): any | null {
  let open = one<any>(db, 'SELECT * FROM sessionchat_sessions WHERE world_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', worldId);
  if (open) {
    // A session that started with the recording or the room ends with it.
    if (open.source === 'audio' && open.audio_session_id) {
      const a = listSessions(db, worldId).find((s) => s.id === open.audio_session_id);
      if (a && !a.active) { endSession(db, open.id, a.stoppedAt ?? now()); open = null; }
    } else if (open.source === 'live' && !one(db, 'SELECT 1 FROM presence WHERE world_id = ?', worldId)) {
      endSession(db, open.id, now()); open = null;
    }
    if (open) return open;
  }
  const last = one<any>(db, 'SELECT ended_at FROM sessionchat_sessions WHERE world_id = ? ORDER BY started_at DESC LIMIT 1', worldId);
  const after = last?.ended_at ?? '';
  const audio = listSessions(db, worldId).find((s) => s.active && s.startedAt > after);
  if (audio) return startSession(db, worldId, audio.name || 'Recorded session', null, 'audio', audio.id);
  const p = one<any>(db, 'SELECT MAX(at) AS at FROM presence WHERE world_id = ?', worldId);
  if (p?.at && p.at > after) return startSession(db, worldId, 'Game night', null, 'live', null);
  return null;
}

export function startSession(db: DB, worldId: string, title: string, by: string | null, source: 'manual' | 'audio' | 'live', audioId: string | null) {
  const s = { id: id('scs_'), world_id: worldId, title, started_by: by, started_at: now(), ended_at: null, source, audio_session_id: audioId };
  run(db, 'INSERT INTO sessionchat_sessions (id, world_id, title, started_by, started_at, source, audio_session_id) VALUES (?, ?, ?, ?, ?, ?, ?)', s.id, worldId, title, by, s.started_at, source, audioId);
  return s;
}
export function endSession(db: DB, sessionId: string, at: string) {
  run(db, 'UPDATE sessionchat_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL', at, sessionId);
}
export const sessionOut = (s: any) => s && ({ id: s.id, title: s.title, startedAt: s.started_at, endedAt: s.ended_at, source: s.source, open: !s.ended_at, startedBy: s.started_by });

// ---- links, mentions, rendering ----

const PAGE_TOKEN = /\[\[page:([A-Za-z0-9_-]{1,120})\]\]/g;

/** Pages a viewer may open (same rule as the library: players see shared pages with a player copy). */
function pageFor(db: DB, worldId: string, pageId: string, role: Role): { id: string; title: string } | null {
  const pg = one<any>(db, 'SELECT id, title, visibility, player_body FROM pages WHERE world_id = ? AND id = ?', worldId, pageId);
  if (!pg) return null;
  if (role !== 'dm' && (pg.visibility !== 'party' || pg.player_body === null)) return null;
  return { id: pg.id, title: pg.title };
}

/** Every page id linked in a body. */
export const linkedPages = (body: string) => [...new Set([...body.matchAll(PAGE_TOKEN)].map((m) => m[1]))];

/** What this reader sees: page links they may open become [[page:ID|Title]], the rest "(hidden)". */
export function renderBody(db: DB, worldId: string, body: string, role: Role): string {
  return body.replace(PAGE_TOKEN, (_m, pid: string) => {
    const pg = pageFor(db, worldId, pid, role);
    return pg ? `[[page:${pg.id}|${pg.title.replace(/[\]|]/g, '')}]]` : '(hidden)';
  });
}

/** Players may only link what they can open; the DM may link any page of the world. */
export function checkLinks(db: DB, worldId: string, body: string, role: Role) {
  for (const pid of linkedPages(body)) {
    if (!pageFor(db, worldId, pid, role)) throw new HttpError(400, 'You can only link pages you can see');
  }
}

/** Account ids named with @ in a body (character name or account name, case-insensitive). */
export function mentionIds(db: DB, worldId: string, body: string): string[] {
  const rows = all<any>(db, 'SELECT a.id, a.display_name, a.username, m.character_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ?', worldId);
  const out = new Set<string>();
  const lower = body.toLowerCase();
  for (const r of rows) {
    for (const n of new Set([r.character_name, r.display_name, r.username].filter((x): x is string => !!x && x.length > 0))) {
      const needle = `@${n.toLowerCase()}`;
      let from = 0;
      for (;;) {
        const at = lower.indexOf(needle, from);
        if (at < 0) break;
        const before = at === 0 ? ' ' : lower[at - 1];
        const after = lower[at + needle.length] ?? ' ';
        if (/[\s(,.;:!?"']/.test(before) && !/[\p{L}\p{N}_]/u.test(after)) { out.add(r.id); break; }
        from = at + 1;
      }
    }
  }
  return [...out];
}

// ---- messages ----

export function viewMessage(db: DB, m: any, v: Viewer, worldId: string) {
  const hidden = !!m.hidden_at;
  const deleted = !!m.deleted_at;
  const dm = v.role === 'dm';
  const blank = deleted || (hidden && !dm);
  const body = blank ? '' : renderBody(db, worldId, m.body, v.role);
  const reactions: Record<string, { emoji: string; count: number; mine: boolean }> = {};
  for (const r of all<any>(db, 'SELECT emoji, account_id FROM sessionchat_reactions WHERE message_id = ?', m.id)) {
    const e = (reactions[r.emoji] ??= { emoji: r.emoji, count: 0, mine: false });
    e.count++;
    if (r.account_id === v.accountId) e.mine = true;
  }
  let reply: any = null;
  if (m.reply_to) {
    const p = one<any>(db, 'SELECT * FROM sessionchat_messages WHERE id = ?', m.reply_to);
    if (p) {
      const pBlank = !!p.deleted_at || (!!p.hidden_at && !dm);
      reply = { id: p.id, authorId: p.author_id, snippet: pBlank ? '' : renderBody(db, worldId, p.body, v.role).replace(/\[\[page:[^|\]]+\|([^\]]*)\]\]/g, '$1').slice(0, 90) };
    }
  }
  const mentions: string[] = parseJson(m.mentions, []);
  return {
    id: m.id, sessionId: m.session_id, channel: m.channel as Channel, authorId: m.author_id, at: m.at,
    kind: m.kind as 'text' | 'roll', body, roll: blank ? null : parseJson(m.roll, null),
    replyTo: reply, mentions, mentionsMe: mentions.includes(v.accountId),
    editedAt: m.edited_at, deleted, hidden, reactions: Object.values(reactions),
  };
}

export interface NewMessage { sessionId: string; channel: Channel; authorId: string; role: Role; body: string; replyTo?: string | null }

export function addMessage(db: DB, worldId: string, n: NewMessage) {
  const body = n.body.trim();
  if (!body) throw new HttpError(400, 'Say something first');
  if (body.length > MAX_BODY) throw new HttpError(400, `Messages can be up to ${MAX_BODY} characters`);
  let kind: 'text' | 'roll' = 'text';
  let roll: string | null = null;
  if (isRoll(body)) { kind = 'roll'; roll = JSON.stringify(parseRoll(body)); }
  else checkLinks(db, worldId, body, n.role);
  if (n.replyTo) {
    const p = one<any>(db, 'SELECT id FROM sessionchat_messages WHERE id = ? AND session_id = ? AND channel = ? AND deleted_at IS NULL', n.replyTo, n.sessionId, n.channel);
    if (!p) throw new HttpError(400, 'The message you are replying to is not in this chat');
  }
  // Only people who can read the channel can be pinged by it.
  const pingable = new Set(all<any>(db, 'SELECT account_id, role FROM members WHERE world_id = ?', worldId).filter((m) => canRead({ accountId: m.account_id, role: m.role }, n.channel)).map((m) => m.account_id));
  const mentions = kind === 'roll' ? [] : mentionIds(db, worldId, body).filter((a) => pingable.has(a) && a !== n.authorId);
  const row = { id: id('scm_'), world_id: worldId, session_id: n.sessionId, channel: n.channel, author_id: n.authorId, body, reply_to: n.replyTo ?? null, kind, roll, mentions: JSON.stringify(mentions), edited_at: null, deleted_at: null, hidden_at: null, hidden_by: null, at: now() };
  run(db, 'INSERT INTO sessionchat_messages (id, world_id, session_id, channel, author_id, body, reply_to, kind, roll, mentions, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    row.id, worldId, row.session_id, row.channel, row.author_id, row.body, row.reply_to, row.kind, row.roll, row.mentions, row.at);
  return row;
}

export function unreadCounts(db: DB, worldId: string, sessionId: string, accountId: string, channel: Channel): number {
  const rd = one<any>(db, 'SELECT last_at FROM sessionchat_reads WHERE account_id = ? AND session_id = ? AND channel = ?', accountId, sessionId, channel);
  return one<any>(db, `SELECT COUNT(*) AS n FROM sessionchat_messages WHERE world_id = ? AND session_id = ? AND channel = ? AND author_id <> ? AND deleted_at IS NULL AND hidden_at IS NULL AND at > ?`, worldId, sessionId, channel, accountId, rd?.last_at ?? '')!.n;
}

/** Retention follows each world's messageDays (null keeps everything). */
export function purgeChat(db: DB) {
  for (const w of all<any>(db, 'SELECT id, settings FROM worlds')) {
    const days = { ...DEFAULT_SETTINGS, ...parseJson<any>(w.settings, {}) }.messageDays;
    if (!days) continue;
    const cutoff = new Date(Date.now() - days * 864e5).toISOString();
    run(db, 'DELETE FROM sessionchat_messages WHERE world_id = ? AND at < ?', w.id, cutoff);
    run(db, `DELETE FROM sessionchat_sessions WHERE world_id = ? AND ended_at IS NOT NULL AND ended_at < ? AND NOT EXISTS (SELECT 1 FROM sessionchat_messages m WHERE m.session_id = sessionchat_sessions.id)`, w.id, cutoff);
    run(db, `DELETE FROM sessionchat_trades WHERE world_id = ? AND status <> 'open' AND created_at < ?`, w.id, cutoff);
  }
}
