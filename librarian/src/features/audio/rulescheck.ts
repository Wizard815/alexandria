// Minerva quietly checks the table's rules calls. When a rules term from the enabled modules (a spell, a condition,
// an action, a rule) is said while recording, the lines around it and the rule's own text go to the audit model,
// which answers only "fine" or one short sentence on what the rule says. A clear mistake becomes a note for the DM
// alone (a live event and GET /audio/sessions/:sid/rule-notes); nothing is said to the players, nothing is changed.
// Each term is checked at most once every ten minutes in a session, two per pass, and a line that repeats classified
// text is never sent. World setting rulesCheck: 'off' turns it off.
import type { Deps } from '../../app.ts';
import { chatJson, hasJob, ModelUnavailable, wouldBeRefused } from '../../core/ai.ts';
import { all, one, run } from '../../core/db.ts';
import { id, now, parseJson } from '../../core/util.ts';
import { findMatches } from '../modules/match.ts';
import { worldModules } from '../modules/store.ts';
import { sessionLines, type TranscriptLine } from './api.ts';

export const RULES_SCHEMA = `
CREATE TABLE IF NOT EXISTS audio_rule_notes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES audio_sessions(id) ON DELETE CASCADE,
  world_id TEXT NOT NULL,
  term TEXT NOT NULL,
  term_ref TEXT NOT NULL,
  line_id TEXT,
  ok INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audio_rule_notes_session ON audio_rule_notes (session_id, created_at);
CREATE TABLE IF NOT EXISTS audio_rule_seen (session_id TEXT PRIMARY KEY REFERENCES audio_sessions(id) ON DELETE CASCADE, upto TEXT NOT NULL);`;

const KINDS = new Set(['spell', 'condition', 'rule', 'action']);
const AGAIN_MS = 10 * 60_000;
const PER_PASS = 2;
const busy = new Set<string>();

export interface RuleNote { id: string; term: string; ref: string; lineId: string | null; ok: boolean; note: string; at: string }
const noteOut = (r: any): RuleNote => ({ id: r.id, term: r.term, ref: r.term_ref, lineId: r.line_id, ok: r.ok === 1, note: r.note, at: r.created_at });

export function ruleNotes(d: Deps, sessionId: string, opts: { onlyFlags?: boolean; limit?: number } = {}): RuleNote[] {
  return all<any>(d.db, `SELECT * FROM audio_rule_notes WHERE session_id = ? ${opts.onlyFlags ? 'AND ok = 0' : ''} ORDER BY created_at DESC LIMIT ?`, sessionId, opts.limit ?? 50).map(noteOut);
}

const SYSTEM = [
  'You check how a tabletop RPG table used one rule, against the rule text you are given.',
  'Flag only a clear mistake that matters at the table: the wrong action type, the wrong save or check, the wrong range, duration or damage, a condition applied with the wrong effect.',
  'Do not flag flavour, jokes, a house rule the DM states, a rule from another edition the DM chose, or anything the transcript does not show.',
  'Answer with JSON only: {"ok": true} or {"ok": false, "note": "one short sentence on what the rule says"}.',
].join('\n');

/** One pass for one session: the new lines since the last pass, at most two terms checked. Never throws for a model problem. */
export async function rulesPass(d: Deps, worldId: string, sessionId: string): Promise<{ checked: number; flagged: number }> {
  const w = one<any>(d.db, 'SELECT settings FROM worlds WHERE id = ?', worldId);
  if (parseJson<any>(w?.settings, {})?.rulesCheck === 'off') return { checked: 0, flagged: 0 };
  if (!hasJob(d, 'audit') && !hasJob(d, 'chat')) return { checked: 0, flagged: 0 };
  if (busy.has(sessionId)) return { checked: 0, flagged: 0 };
  busy.add(sessionId);
  try {
    const seen = one<any>(d.db, 'SELECT upto FROM audio_rule_seen WHERE session_id = ?', sessionId)?.upto ?? '';
    const lines = sessionLines(d.db, worldId, sessionId, { includeDm: true }).filter((l) => !d.library.containsClassified(worldId, l.text) && !wouldBeRefused(d, l.text));
    const fresh = lines.filter((l) => l.updatedAt > seen);
    if (!fresh.length) return { checked: 0, flagged: 0 };
    const newest = fresh.reduce((m, l) => (l.updatedAt > m ? l.updatedAt : m), seen);
    run(d.db, 'INSERT INTO audio_rule_seen (session_id, upto) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET upto = excluded.upto', sessionId, newest);
    const viewer = { role: 'dm', accountId: '', audience: 'ai' } as any;
    const recent = new Map(all<any>(d.db, 'SELECT term, max(created_at) AS at FROM audio_rule_notes WHERE session_id = ? GROUP BY term', sessionId).map((r) => [String(r.term), Date.parse(r.at)]));
    const by = worldModules(d.db, worldId).byRef;
    const todo: { term: string; ref: string; line: TranscriptLine }[] = [];
    for (const l of fresh) {
      for (const m of findMatches(d.db, worldId, viewer, l.text, { spoken: true })) {
        if (m.source !== 'module' || !KINDS.has(m.kind)) continue;
        if (Date.now() - (recent.get(m.term) ?? 0) < AGAIN_MS || todo.some((t) => t.term === m.term)) continue;
        todo.push({ term: m.term, ref: m.id, line: l });
      }
    }
    let checked = 0, flagged = 0;
    for (const t of todo.slice(0, PER_PASS)) {
      const term: any = by.get(t.ref);
      if (!term) continue;
      const at = lines.findIndex((l) => l.id === t.line.id);
      const excerpt = lines.slice(Math.max(0, at - 3), at + 5).map((l) => `${l.speaker || 'Someone'}: ${l.text}`).join('\n');
      let j: any = null;
      try {
        j = await chatJson(d, hasJob(d, 'audit') ? 'audit' : 'chat', [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Rule: ${term.term}${term.moduleName ? ` (${term.moduleName})` : ''}\n${String(term.text ?? term.summary ?? '').slice(0, 2500)}\n\nTranscript (the rule came up in the line from ${t.line.speaker || 'someone'}: "${t.line.text.slice(0, 200)}"):\n${excerpt.slice(0, 3000)}` }]);
      } catch (e) {
        if (!(e instanceof ModelUnavailable)) console.error('audio: rules check failed', (e as any)?.message ?? e);
        break;
      }
      if (!j || typeof j.ok !== 'boolean') continue;
      checked++;
      const note = j.ok ? '' : String(j.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!j.ok && !note) continue;
      const row = { id: id('rn_'), at: now() };
      run(d.db, 'INSERT INTO audio_rule_notes (id, session_id, world_id, term, term_ref, line_id, ok, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', row.id, sessionId, worldId, t.term, t.ref, t.line.id, j.ok ? 1 : 0, note, row.at);
      if (!j.ok) {
        flagged++;
        d.hub.emit(worldId, 'rules-note', { sessionId, id: row.id, term: t.term, ref: t.ref, lineId: t.line.id, note, at: row.at }, (v) => v.role === 'dm');
      }
    }
    return { checked, flagged };
  } finally { busy.delete(sessionId); }
}
