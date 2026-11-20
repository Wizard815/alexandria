// Live help while a session is recording (docs/MINERVA.md). A light background
// pass reads the DM-visible transcript lines that arrived since it last ran
// and drafts SUGGESTIONS into the Review queue, below everything else:
//   - a clue the table seems to have found      (revelation_mark)
//   - a new NPC that was named                  (codex / promotion)
//   - a promise or a goal                       (goal_update, or a hook page)
// Nothing is applied: the DM approves each one on the Review page. The audit
// model improves the wording when one is set; without it the same suggestions
// come from the rules below. The pass is rate limited (every two minutes, or
// at once after 30 new lines) and never sends text that holds classified
// content: such a line is left out before anything is read.
import type { Deps } from '../../app.ts';
import { chatJson, hasJob, ModelUnavailable, wouldBeRefused } from '../../core/ai.ts';
import { all, one, run } from '../../core/db.ts';
import { now } from '../../core/util.ts';
import { listSessions, sessionLines, type TranscriptLine } from '../audio/api.ts';
import { searchTerms } from '../agent/intent.ts';
import { findCodex, promotionDraft, whoIs } from './codex.ts';
import { createDraft, listDrafts, type Op } from './ops.ts';
import { listMysteries } from './revelations.ts';
import { currentSession, stateOf } from './store.ts';
import { norm, players, readPage } from './vault.ts';
import { goalOp } from './player.ts';

/** Run again after this long, if there is anything new. */
export const LIVE_EVERY_MS = 2 * 60_000;
/** Or as soon as this many new lines have come in. */
export const LIVE_LINES = 30;
/** Lines handed to the harness and the pass. */
export const RECENT_LINES = 20;
export const SUGGEST_PREFIX = 'suggest-';

/** The lines of the session being recorded (or the latest), as the viewer may read them, with classified text left out. */
export function liveLines(d: Deps, worldId: string, includeDm: boolean, limit = RECENT_LINES): { session: { id: string; name: string; active: boolean } | null; lines: TranscriptLine[] } {
  const s = listSessions(d.db, worldId)[0];
  if (!s) return { session: null, lines: [] };
  const lines = sessionLines(d.db, worldId, s.id, { includeDm }).filter((l) => !d.library.containsClassified(worldId, l.text) && !wouldBeRefused(d, l.text));
  return { session: { id: s.id, name: s.name, active: s.active }, lines: lines.slice(-limit) };
}

interface Seen { sessionId: string; seenAt: string; lastAt: string | null }
const seenOf = (d: Deps, worldId: string): Seen | null => {
  const r = one<any>(d.db, 'SELECT session_id, seen_at, last_at FROM minerva_live WHERE world_id = ?', worldId);
  return r ? { sessionId: r.session_id, seenAt: r.seen_at, lastAt: r.last_at } : null;
};
const saveSeen = (d: Deps, worldId: string, sessionId: string, seenAt: string) =>
  run(d.db, `INSERT INTO minerva_live (world_id, session_id, seen_at, last_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (world_id) DO UPDATE SET session_id = excluded.session_id, seen_at = excluded.seen_at, last_at = excluded.last_at`, worldId, sessionId, seenAt, now());

export interface Suggestion { kind: 'clue' | 'npc' | 'goal' | 'hook'; title: string; op: Op; why: string }

const wordRe = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');
const PROMISE = /\b(i promise|i swear|you have my word|i['’]ll (protect|find|bring|make sure|get|help|return|deliver)|we['’]ll (protect|find|bring|make sure|get|help|return|deliver)|i will (protect|find|bring|make sure|get|help|return|deliver)|i owe you|swear to|vow to|i['’]ll never)\b/i;
const COMMON = new Set(['The', 'And', 'But', 'You', 'Your', 'They', 'Then', 'What', 'When', 'Where', 'Who', 'Why', 'How', 'Yes', 'Not', 'This', 'That', 'There', 'Here', 'Okay', 'Well', 'Let', 'Can', 'Could', 'Would', 'Should', 'Will', 'Just', 'Now', 'Maybe', 'Please', 'Thanks', 'Dungeon', 'Master', 'Roll', 'Initiative']);

/** The suggestions the rules find in new lines: clues by keyword overlap, new capitalised names said more than once, promises. */
export function rulesSuggestions(d: Deps, worldId: string, lines: TranscriptLine[], session: number): Suggestion[] {
  const out: Suggestion[] = [];
  const ps = players(d, worldId);
  const who = (l: TranscriptLine) => ps.find((p) => p.accountId === l.speakerId) ?? ps.find((p) => norm(p.character) === norm(l.speaker) || norm(p.name) === norm(l.speaker));
  const text = lines.map((l) => l.text).join('\n');

  // Clues: most of a clue's key words in what one player said (the same test the after-session review uses).
  for (const m of listMysteries(d, worldId)) {
    if (m.status !== 'open') continue;
    for (const c of m.clues) {
      const keys = searchTerms(c.text, 8).filter((w) => w.length >= 4);
      if (keys.length < 3) continue;
      for (const p of ps) {
        if (c.found.some((f) => f.accountId === p.accountId)) continue;
        const mine = norm(lines.filter((l) => who(l)?.accountId === p.accountId).map((l) => l.text).join(' '));
        if (!mine) continue;
        const have = keys.filter((w) => mine.includes(w)).length;
        if (have / keys.length >= 0.6) out.push({ kind: 'clue', title: `${p.character || p.name} may have found a clue of "${m.title}"`, why: `Said at the table: ${keys.filter((w) => mine.includes(w)).join(', ')}`, op: { op: 'mark', mystery: m.slug, clue: c.n, player: p.accountId, session } });
      }
    }
  }

  // New NPCs: a capitalised name said at least twice that no codex page, library page or player has.
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/(?<=[\p{Ll},;:]\s)([A-Z][\p{L}'’-]{2,}(?:\s+[A-Z][\p{L}'’-]{2,})?)\b/gu)) {
    const nm = m[1].trim();
    if (COMMON.has(nm.split(' ')[0])) continue;
    counts.set(nm, (counts.get(nm) ?? 0) + 1);
  }
  const pcNames = new Set(ps.flatMap((p) => [norm(p.character), norm(p.name)]));
  for (const [nm, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    if (n < 2 || pcNames.has(norm(nm))) continue;
    if (findCodex(d, worldId, { name: nm }) || whoIs(d, worldId, nm, { partial: false }).length) continue;
    try { const p = promotionDraft(d, worldId, nm); out.push({ kind: 'npc', title: `New NPC named: ${nm}`, why: `Named ${n} times in the last few minutes`, op: { op: 'create', ...p } }); } catch { /* has a page now */ }
    if (out.filter((x) => x.kind === 'npc').length >= 3) break;
  }

  // Promises and goals: a player says they will do something, and no goal of theirs mentions it yet.
  for (const l of lines) {
    const p = who(l);
    if (!p || !PROMISE.test(l.text)) continue;
    const goal = l.text.replace(/\s+/g, ' ').trim().slice(0, 80);
    const exists = !!readPage(d, worldId, `players/${p.accountId}/goals/${goal.replace(/[\\/:*?"<>|]/g, ' ').slice(0, 80)}.md`);
    out.push({ kind: 'goal', title: `${p.character || p.name} made a promise`, why: `"${l.text.slice(0, 120)}"`, op: goalOp(p.accountId, { goal, heat: 'on', text: `Promise made in session ${session}: ${l.text.replace(/\s+/g, ' ').trim().slice(0, 300)}` }, exists) });
    if (out.filter((x) => x.kind === 'goal').length >= 2) break;
  }
  return out;
}

/** The audit model may sharpen what the rules found: it only ever picks from them (it cannot add an op), so it cannot make one up. */
async function modelFilter(d: Deps, worldId: string, found: Suggestion[], lines: TranscriptLine[]): Promise<Suggestion[]> {
  if (!found.length || !hasJob(d, 'audit')) return found;
  try {
    const j: any = await chatJson(d, 'audit', [
      { role: 'system', content: 'You help a Dungeon Master. Below are suggestions drafted from the last minutes of a tabletop session transcript. Keep only the ones the transcript really supports. Reply with JSON only: {"keep": [numbers]}.' },
      { role: 'user', content: `Transcript:\n${lines.map((l) => `${l.speaker}: ${l.text}`).join('\n').slice(0, 5000)}\n\nSuggestions:\n${found.map((s, i) => `${i}. ${s.title} (${s.why})`).join('\n')}` },
    ]);
    const keep = Array.isArray(j?.keep) ? new Set(j.keep.map(Number)) : null;
    return keep ? found.filter((_, i) => keep.has(i)) : found;
  } catch (e) { if (e instanceof ModelUnavailable) return found; throw e; }
}

export interface PassResult { ran: boolean; reason?: string; lines: number; drafted: number }

/**
 * One pass for a world. `force` skips the rate limit (the DM asked). Never throws for a model problem.
 * Drafts are low priority (kind suggest-*): they sort below the review's own drafts.
 */
export async function suggestionPass(d: Deps, worldId: string, opts: { force?: boolean; at?: number } = {}): Promise<PassResult> {
  try { if (!stateOf(d.db, worldId).enabled) return { ran: false, reason: 'Minerva is off', lines: 0, drafted: 0 }; } catch { return { ran: false, reason: 'Minerva is off', lines: 0, drafted: 0 }; }
  const s = listSessions(d.db, worldId)[0];
  if (!s || !s.active) return { ran: false, reason: 'No session is recording', lines: 0, drafted: 0 };
  const seen = seenOf(d, worldId);
  const since = seen && seen.sessionId === s.id ? seen.seenAt : '';
  const all_ = sessionLines(d.db, worldId, s.id, { includeDm: true }).filter((l) => !d.library.containsClassified(worldId, l.text) && !wouldBeRefused(d, l.text));
  const fresh = all_.filter((l) => l.updatedAt > since);
  if (!fresh.length) return { ran: false, reason: 'No new lines', lines: 0, drafted: 0 };
  const ago = seen?.lastAt ? (opts.at ?? Date.now()) - Date.parse(seen.lastAt) : Infinity;
  if (!opts.force && fresh.length < LIVE_LINES && ago < LIVE_EVERY_MS) return { ran: false, reason: 'Too soon', lines: fresh.length, drafted: 0 };

  const recent = all_.slice(-Math.max(RECENT_LINES, fresh.length > 60 ? 60 : fresh.length));
  const newest = fresh.reduce((m, l) => (l.updatedAt > m ? l.updatedAt : m), since);
  saveSeen(d, worldId, s.id, newest);
  const found = await modelFilter(d, worldId, rulesSuggestions(d, worldId, recent, currentSession(d.db, worldId)), recent);
  // One suggestion once: not again while it waits, and not again after the DM decided on it.
  const known = new Set(all<any>(d.db, `SELECT title FROM minerva_drafts WHERE world_id = ? AND kind LIKE '${SUGGEST_PREFIX}%'`, worldId).map((r) => String(r.title)));
  let drafted = 0;
  for (const sg of found) {
    const title = sg.title.slice(0, 200);
    if (known.has(title)) continue;
    createDraft(d, worldId, { review: 'live', kind: `${SUGGEST_PREFIX}${sg.kind}`, title, op: sg.op, tool: 'live_suggestion' });
    known.add(title);
    drafted++;
  }
  return { ran: true, lines: fresh.length, drafted };
}

/** Worlds with a recording running and Minerva on: the scheduler's list. */
export function liveWorlds(d: Deps): string[] {
  return all<any>(d.db, `SELECT DISTINCT s.world_id AS w FROM audio_sessions s JOIN minerva_state m ON m.world_id = s.world_id AND m.enabled = 1 WHERE s.stopped_at IS NULL`).map((r) => String(r.w));
}

export const pendingSuggestions = (d: Deps, worldId: string) => listDrafts(d, worldId, 'pending').filter((x) => x.kind.startsWith(SUGGEST_PREFIX));
