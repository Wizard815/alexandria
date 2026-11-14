// The running summary of a chat: when more than the last few messages have
// piled up, the small (audit) model folds the older ones into a short summary
// that goes in the system prompt, so the model never re-reads a long chat.
// Without an audit model a plain digest does the same job. It runs after a
// reply, never in front of one.
import type { Deps } from '../../app.ts';
import { chat, hasJob } from '../../core/ai.ts';
import { all, one, run } from '../../core/db.ts';

export const HISTORY_WINDOW = 8;
/** Older, unsummarized messages needed before the summary is rewritten. */
export const SUMMARY_AFTER = 4;
const MAX_SUMMARY = 1400;

const busy = new Set<string>();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, ' ').trim();

/** Fold the older messages into the summary (in the background, once at a time per chat). */
export function summarizeLater(d: Deps, chatId: string): void {
  if (busy.has(chatId)) return;
  busy.add(chatId);
  void summarize(d, chatId).catch(() => { /* a summary is a nicety: the next reply tries again */ }).finally(() => busy.delete(chatId));
}

export async function summarize(d: Deps, chatId: string): Promise<boolean> {
  const rows = all<any>(d.db, `SELECT rowid AS rid, role, content FROM agent_messages WHERE chat_id = ? AND status = 'done' AND content <> '' ORDER BY rowid`, chatId);
  const chatRow = one<any>(d.db, 'SELECT summary, summary_upto FROM agent_chats WHERE id = ?', chatId);
  if (!chatRow || rows.length <= HISTORY_WINDOW) return false;
  const older = rows.slice(0, rows.length - HISTORY_WINDOW).filter((r) => r.rid > chatRow.summary_upto);
  if (older.length < SUMMARY_AFTER) return false;
  const prior: string = chatRow.summary ?? '';
  let next = '';
  if (hasJob(d, 'audit')) {
    try {
      const r = await chat(d, 'audit', {
        messages: [
          { role: 'system', content: 'You keep a running summary of a conversation between a user and a tabletop-RPG assistant. Merge the new messages into the summary. Keep names, decisions, facts the user established, and open questions. At most 120 words, plain text, no preamble.' },
          { role: 'user', content: `Summary so far:\n${prior || '(none)'}\n\nNew messages:\n${older.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${clip(m.content, 700)}`).join('\n')}` },
        ],
        maxTokens: 300, temperature: 0,
      });
      next = r.content.trim();
    } catch { /* fall back to the digest */ }
  }
  if (!next) next = `${prior}\n${older.map((m) => (m.role === 'user' ? `- Asked: ${clip(m.content, 120)}` : `  Answered: ${clip(m.content, 160)}`)).join('\n')}`.trim();
  if (next.length > MAX_SUMMARY) next = next.slice(next.length - MAX_SUMMARY);
  run(d.db, 'UPDATE agent_chats SET summary = ?, summary_upto = ? WHERE id = ?', next, older[older.length - 1].rid, chatId);
  return true;
}
