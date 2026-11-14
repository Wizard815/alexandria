// Tables the agent owns: conversations, their messages, pending actions and
// the log of replies the leak check blocked.
import type { DB } from '../../core/db.ts';
import { all, one, run } from '../../core/db.ts';
import { id, now, parseJson } from '../../core/util.ts';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_chats (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  harness TEXT NOT NULL CHECK (harness IN ('dm', 'player')),
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  summary_upto INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agent_chats_owner ON agent_chats (world_id, account_id, updated_at);
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES agent_chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'working', 'error')),
  citations TEXT NOT NULL DEFAULT '[]',
  context TEXT,
  blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  timings TEXT
);
CREATE INDEX IF NOT EXISTS agent_messages_chat ON agent_messages (chat_id, created_at);
CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES agent_chats(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL,
  call TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'rejected')),
  result TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  auto INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agent_actions_world ON agent_actions (world_id, status, created_at);
CREATE TABLE IF NOT EXISTS agent_leaks (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  chat_id TEXT,
  matched TEXT NOT NULL,
  at TEXT NOT NULL
);
`;

export interface Citation { kind: 'page' | 'transcript' | 'term'; id: string; title: string; path?: string; snippet?: string; sessionId?: string }

export const newChat = (db: DB, worldId: string, accountId: string, harness: 'dm' | 'player', title = '') => {
  const c = { id: id('chat_'), world_id: worldId, account_id: accountId, harness, title: title.slice(0, 120), created_at: now(), updated_at: now() };
  run(db, 'INSERT INTO agent_chats (id, world_id, account_id, harness, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', c.id, c.world_id, c.account_id, c.harness, c.title, c.created_at, c.updated_at);
  return c;
};

export const ownChat = (db: DB, worldId: string, accountId: string, chatId: string) =>
  one<{ id: string; world_id: string; account_id: string; harness: 'dm' | 'player'; title: string; created_at: string; updated_at: string }>(db, 'SELECT * FROM agent_chats WHERE id = ? AND world_id = ? AND account_id = ?', chatId, worldId, accountId);

export const addMessage = (db: DB, chatId: string, role: 'user' | 'assistant', content: string, extra: { status?: 'done' | 'working' | 'error'; citations?: Citation[]; context?: unknown; blocked?: boolean } = {}) => {
  const m = { id: id('msg_'), chat_id: chatId, role, content, status: extra.status ?? 'done', created_at: now() };
  run(db, 'INSERT INTO agent_messages (id, chat_id, role, content, status, citations, context, blocked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', m.id, m.chat_id, m.role, m.content, m.status, JSON.stringify(extra.citations ?? []), extra.context === undefined ? null : JSON.stringify(extra.context), extra.blocked ? 1 : 0, m.created_at);
  run(db, 'UPDATE agent_chats SET updated_at = ? WHERE id = ?', m.created_at, chatId);
  return m;
};

/** Where the time of one reply went, in milliseconds (see docs/MODELS.md, "Reading the timings"). */
export interface Timings {
  totalMs: number;
  /** From the message arriving to the first text leaving for the screen. */
  firstTokenMs?: number;
  /** Time inside model calls (streaming included). */
  modelMs: number;
  /** Wall time running tools (parallel calls overlap). */
  toolMs: number;
  /** Library search and context gathering before the first model call. */
  prepMs: number;
  /** Everything that was neither the model nor a tool: totalMs - modelMs - toolMs. */
  gatewayMs: number;
  rounds: number;
  toolCalls: number;
  snippets: number;
  toolsOffered: number;
  /** Answered by a rule, with no model. */
  fast?: boolean;
  /** Time the player leak gate spent checking sentences. */
  gateMs?: number;
}

export const finishMessage = (db: DB, msgId: string, content: string, status: 'done' | 'error', citations: Citation[] = [], blocked = false, timings?: Timings) => {
  partials.delete(msgId);
  run(db, 'UPDATE agent_messages SET content = ?, status = ?, citations = ?, blocked = ?, timings = ? WHERE id = ?', content, status, JSON.stringify(citations), blocked ? 1 : 0, timings ? JSON.stringify(timings) : null, msgId);
};

/** The reply so far, for a message still being answered (what the screen would show right now). */
const partials = new Map<string, string>();
export const setPartial = (msgId: string, text: string) => { partials.set(msgId, text); };
export const clearPartial = (msgId: string) => { partials.delete(msgId); };

export const messageView = (m: any) => ({
  id: m.id, role: m.role, text: m.status === 'working' ? partials.get(m.id) ?? m.content : m.content, status: m.status, citations: parseJson<Citation[]>(m.citations, []), at: m.created_at,
  timings: m.timings ? parseJson<Timings | null>(m.timings, null) : null,
});

/** A chat with its messages and the actions waiting on the DM. */
export function chatView(db: DB, chatId: string) {
  const c = one<any>(db, 'SELECT * FROM agent_chats WHERE id = ?', chatId)!;
  // A run that died with the server never finishes: show it as failed.
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  run(db, `UPDATE agent_messages SET status = 'error', content = 'The agent was interrupted. Ask again.' WHERE chat_id = ? AND status = 'working' AND created_at < ?`, chatId, stale);
  const msgs = all<any>(db, 'SELECT * FROM agent_messages WHERE chat_id = ? ORDER BY created_at, rowid', chatId).map(messageView);
  const actions = all<any>(db, 'SELECT * FROM agent_actions WHERE chat_id = ? ORDER BY created_at, rowid', chatId).map(actionView);
  return { id: c.id, harness: c.harness, title: c.title, createdAt: c.created_at, updatedAt: c.updated_at, messages: msgs, actions, busy: msgs.some((m) => m.status === 'working') };
}

export const actionView = (a: any) => ({
  id: a.id, chatId: a.chat_id, tool: a.tool, args: parseJson(a.args, {}), summary: a.summary, call: parseJson(a.call, {}),
  status: a.status, result: a.result ? String(a.result).slice(0, 2000) : null, auto: !!a.auto, createdAt: a.created_at, decidedAt: a.decided_at,
});
