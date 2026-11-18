// One task for the DM's assistant, outside a conversation: a macro's Minerva
// step, or a spoken request the rules did not cover. It runs in its own chat
// (so the DM can read what happened). In `do` mode the allowed write tools run
// at once; in `propose` mode they wait as pending actions.
import type { Deps } from '../../app.ts';
import { all, one } from '../../core/db.ts';
import { DEFAULT_SETTINGS } from '../../core/policy.ts';
import { parseJson } from '../../core/util.ts';
import { runAgent, type Caller } from '../agent/harness.ts';
import { addMessage, newChat } from '../agent/store.ts';

export interface TaskOut { chatId: string; reply: string; pending: number; ok: boolean }

export async function runTask(d: Deps, who: { worldId: string; accountId: string; token: string; port: number }, o: { prompt: string; mode: 'do' | 'propose'; allow?: string[]; title?: string }): Promise<TaskOut> {
  const w = one<any>(d.db, 'SELECT name, settings FROM worlds WHERE id = ?', who.worldId);
  if (!w) return { chatId: '', reply: 'No such world', pending: 0, ok: false };
  const caller: Caller = { worldId: who.worldId, worldName: w.name, accountId: who.accountId, viewer: { accountId: who.accountId, role: 'dm' }, harness: 'dm', token: who.token, port: who.port, settings: { ...DEFAULT_SETTINGS, ...parseJson(w.settings, {}) } };
  const chat = newChat(d.db, who.worldId, who.accountId, 'dm', (o.title ?? o.prompt).slice(0, 80));
  addMessage(d.db, chat.id, 'user', o.prompt, {});
  const reply = addMessage(d.db, chat.id, 'assistant', '', { status: 'working' });
  await runAgent(d, caller, { chatId: chat.id, replyId: reply.id, text: o.prompt, context: {}, history: [], summary: '', fast: null, exec: { mode: o.mode, allow: o.allow } });
  const m = one<any>(d.db, 'SELECT content, status FROM agent_messages WHERE id = ?', reply.id);
  const pending = all<any>(d.db, "SELECT id FROM agent_actions WHERE chat_id = ? AND status = 'pending'", chat.id).length;
  return { chatId: chat.id, reply: String(m?.content ?? ''), pending, ok: m?.status === 'done' };
}
