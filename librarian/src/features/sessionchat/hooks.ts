// What other features may do with session chat without reaching into its
// routes: post a message as someone (fanned out to each reader's own view)
// and answer a chat command ("/reroll personal"). Commands are looked up per
// world, so a house rule that is off in a world never answers there.
import type { Deps } from '../../app.ts';
import { all, one, type DB } from '../../core/db.ts';
import { only } from '../../core/events.ts';
import { HttpError } from '../../core/util.ts';
import type { Role, Viewer } from '../../core/policy.ts';
import { addMessage, canRead, currentSession, viewMessage, type Channel } from './chat.ts';

export interface CommandCall {
  worldId: string; channel: Channel; sessionId: string; viewer: Viewer;
  word: string; args: string[]; replyTo: string | null;
}
/** What a command does: post this text as the caller's message (a /roll ... line is rolled on the server), or nothing more. */
export interface CommandResult { body?: string; replyTo?: string | null }
export type CommandResolver = (d: Deps, call: CommandCall) => CommandResult | null;

const resolvers: CommandResolver[] = [];
/** A feature registers one resolver; it returns null for words it does not own in that world. */
export function addCommandResolver(fn: CommandResolver) { resolvers.push(fn); }

/** "/word a b" when a resolver owns it in this world; null for plain text, /roll and unknown words. */
export function runCommand(d: Deps, base: Omit<CommandCall, 'word' | 'args'>, body: string): CommandResult | null {
  const m = /^\/([a-z][a-z0-9]{1,19})(?:\s+(.*))?$/is.exec(body.trim());
  if (!m || m[1].toLowerCase() === 'roll') return null;
  const call: CommandCall = { ...base, word: m[1].toLowerCase(), args: (m[2] ?? '').trim().split(/\s+/).filter(Boolean).map((a) => a.toLowerCase()) };
  for (const r of resolvers) { const out = r(d, call); if (out) return out; }
  return null;
}

/** Send each reader their own view of a message; only readers of the channel get it. */
export function fanout(d: Deps, worldId: string, channel: Channel, type: string, row: any) {
  for (const m of all<any>(d.db, 'SELECT account_id, role FROM members WHERE world_id = ?', worldId)) {
    const v: Viewer = { accountId: m.account_id, role: m.role };
    if (!canRead(v, channel)) continue;
    d.hub.emit(worldId, 'chat', { type, channel, sessionId: row.session_id, message: viewMessage(d.db, row, v, worldId) }, only(v.accountId));
  }
}

/** Post a message in the running session as `authorId`. Throws 409 when no session is running. */
export function postChat(d: Deps, worldId: string, channel: Channel, authorId: string, role: Role, body: string, replyTo: string | null = null) {
  const s = currentSession(d.db, worldId);
  if (!s) throw new HttpError(409, 'No session is running');
  const row = addMessage(d.db, worldId, { sessionId: s.id, channel, authorId, role, body, replyTo });
  fanout(d, worldId, channel, 'new', row);
  return row;
}

/** A roll message of this world, with its author's role, or null. */
export function rollMessage(db: DB, worldId: string, id: string): { row: any; authorRole: Role } | null {
  const row = one<any>(db, "SELECT * FROM sessionchat_messages WHERE id = ? AND world_id = ? AND kind = 'roll' AND deleted_at IS NULL", id, worldId);
  if (!row) return null;
  const m = one<any>(db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', worldId, row.author_id);
  return { row, authorRole: (m?.role ?? 'guest') as Role };
}

/** The latest roll in the running session's channel that `fits`. */
export function latestRoll(db: DB, worldId: string, channel: Channel, fits: (authorId: string, role: Role) => boolean): any | null {
  const s = currentSession(db, worldId);
  if (!s) return null;
  const rows = all<any>(db, "SELECT m.*, mb.role AS author_role FROM sessionchat_messages m LEFT JOIN members mb ON mb.world_id = m.world_id AND mb.account_id = m.author_id WHERE m.session_id = ? AND m.channel = ? AND m.kind = 'roll' AND m.deleted_at IS NULL ORDER BY m.at DESC, m.rowid DESC LIMIT 50", s.id, channel);
  return rows.find((r) => fits(r.author_id, (r.author_role ?? 'guest') as Role)) ?? null;
}
