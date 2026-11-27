// What happens to a session's summary once the recording ends, and again once the final transcript is made.
//
//   stop + 5 s       the running summary takes the last live lines; the hand-off is drafted for the GM.
//   final done/undo  both summaries are made again from the lines the session has now (the final transcript, or the
//                    live lines put back), and the hand-off is brought up to date (see minerva/after.ts draftHandoff).
//
// Where the hand-off goes: with Minerva on, a "Last session" draft for the Campaign Status in Minerva's review queue.
// With Minerva off, a "Summary ready" card on the Recordings page (audio_handoffs), which the GM approves (saved as a
// session log draft, never published by itself), edits or discards. Nothing is written anywhere a player can read
// without the GM's approval, and the GM's summary (asides included) never leaves the GM's side: GM-only routes only.
import type { Deps } from '../../app.ts';
import { all, one, run, tx } from '../../core/db.ts';
import { dmOnly } from '../../core/events.ts';
import { HttpError, id, now } from '../../core/util.ts';
import { getSummary, updateBoth } from './summary.ts';

export const HANDOFF_SCHEMA = `
CREATE TABLE IF NOT EXISTS audio_handoffs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES audio_sessions(id) ON DELETE CASCADE,
  world_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'discarded')),
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'live',
  log_draft_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS audio_handoffs_session ON audio_handoffs(session_id, created_at);`;

type Source = 'live' | 'final';
const sourceOf = (d: Deps, sessionId: string): Source => (one<any>(d.db, 'SELECT status FROM audio_final WHERE session_id = ?', sessionId)?.status === 'done' ? 'final' : 'live');
const minervaOn = (d: Deps, worldId: string) => { try { return !!one<any>(d.db, 'SELECT enabled FROM minerva_state WHERE world_id = ?', worldId)?.enabled; } catch { return false; } };

/** The summary for the GM's review: to Minerva when it is on, else to the Recordings page. `refresh`: the lines changed (final or undo). */
export async function deliverHandoff(d: Deps, worldId: string, sessionId: string, opts: { refresh?: boolean } = {}): Promise<'minerva' | 'recordings' | 'none'> {
  const source = sourceOf(d, sessionId);
  const m = await import('../minerva/after.ts');
  const r = m.draftHandoff(d, worldId, sessionId, { refresh: opts.refresh, source });
  if (r === 'none') return 'none';
  if (r !== 'off') return 'minerva';
  const sum = getSummary(d, sessionId, 'dm');
  if (!sum.text.trim()) return 'none';
  const rows = all<any>(d.db, 'SELECT * FROM audio_handoffs WHERE session_id = ? ORDER BY created_at, rowid', sessionId);
  const last = rows[rows.length - 1];
  const insert = () => run(d.db, `INSERT INTO audio_handoffs (id, session_id, world_id, status, text, source, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`, id('ah_'), sessionId, worldId, sum.text, source, now(), now());
  if (!last) insert();
  else if (!opts.refresh || last.text === sum.text) return 'recordings';
  else if (last.status === 'pending') run(d.db, "UPDATE audio_handoffs SET text = ?, source = ?, updated_at = ? WHERE id = ? AND status = 'pending'", sum.text, source, now(), last.id);
  else if (last.status === 'approved') insert();
  else return 'recordings';
  d.hub.emit(worldId, 'audio-handoff', { sessionId }, dmOnly);
  return 'recordings';
}

/** Stop + 5 s: fold the last live lines in, then hand off. */
export async function afterRecording(d: Deps, worldId: string, sessionId: string) {
  await updateBoth(d, worldId, sessionId, { force: true });
  await deliverHandoff(d, worldId, sessionId);
}

/** The final transcript finished (or was undone): make both summaries again from the lines now, then refresh the hand-off. */
export async function afterFinal(d: Deps, worldId: string, sessionId: string) {
  await updateBoth(d, worldId, sessionId, { rebuild: true });
  await deliverHandoff(d, worldId, sessionId, { refresh: true });
}

/** Run afterFinal whenever a session's final pass ends as done or undone (once per such change). */
export function watchFinals(d: Deps) {
  const seen = new Map<string, string>();
  d.hub.tap((worldId, type, data: any) => {
    if (type !== 'transcript-final' || !data?.sessionId || (data.status !== 'done' && data.status !== 'undone')) return;
    const f = one<any>(d.db, 'SELECT status, finished_at FROM audio_final WHERE session_id = ?', String(data.sessionId));
    const key = `${f?.status}|${f?.finished_at}`;
    if (!f || seen.get(data.sessionId) === key) return;
    seen.set(data.sessionId, key);
    if (seen.size > 2000) seen.delete(seen.keys().next().value as string);
    // After the emit returns: the final pass writes Transcript.md right after it says done.
    setTimeout(() => { void afterFinal(d, worldId, String(data.sessionId)).catch((e) => console.error('audio: summary after the final transcript failed', e)); }, 0);
  });
}

/** Where this session's summary went, for the GM's Recordings page. */
export function handoffView(d: Deps, worldId: string, sessionId: string) {
  const on = minervaOn(d, worldId);
  const sum = getSummary(d, sessionId, 'dm');
  const source = sourceOf(d, sessionId);
  const drafts = all<any>(d.db, 'SELECT id, status, title, created_at FROM minerva_drafts WHERE world_id = ? AND review = ? ORDER BY created_at, rowid', worldId, `handoff-${sessionId}`);
  const cards = all<any>(d.db, 'SELECT * FROM audio_handoffs WHERE session_id = ? AND world_id = ? ORDER BY created_at, rowid', sessionId, worldId)
    .map((h) => ({ id: h.id, status: h.status, text: h.text, source: h.source, logDraftId: h.log_draft_id, createdAt: h.created_at, updatedAt: h.updated_at, decidedAt: h.decided_at }));
  const where = drafts.length ? 'minerva' : cards.length ? 'recordings' : 'none';
  return {
    minervaOn: on, where, source, hasSummary: !!sum.text.trim(),
    minerva: drafts.map((x) => ({ id: x.id, status: x.status, title: x.title, createdAt: x.created_at })),
    cards,
  };
}

/** The GM's decision on a Recordings card: approve (saved as a session log draft, with the GM's edit) or discard. */
export function decideHandoff(d: Deps, worldId: string, sessionId: string, cardId: string, action: 'approve' | 'discard', who: string, text?: string) {
  const h = one<any>(d.db, 'SELECT * FROM audio_handoffs WHERE id = ? AND session_id = ? AND world_id = ?', cardId, sessionId, worldId);
  if (!h) throw new HttpError(404, 'No such summary');
  if (h.status !== 'pending') throw new HttpError(409, 'That summary was already decided');
  const body = typeof text === 'string' && text.trim() ? text.slice(0, 100_000) : h.text;
  if (action === 'discard') {
    run(d.db, "UPDATE audio_handoffs SET status = 'discarded', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'", now(), who, h.id);
    run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, who, 'audio.handoff_discard', sessionId, now());
    d.hub.emit(worldId, 'audio-handoff', { sessionId }, dmOnly);
    return { ok: true, status: 'discarded' as const, logDraftId: null };
  }
  const s = one<any>(d.db, 'SELECT * FROM audio_sessions WHERE id = ? AND world_id = ?', sessionId, worldId);
  if (!s) throw new HttpError(404, 'No such session');
  const did = id('sld_');
  const markdown = `# ${s.name}\n\n${body.trim()}\n`;
  const note = `from the recording's ${h.source === 'final' ? 'final transcript' : 'running notes'}, approved by the GM`;
  tx(d.db, () => {
    // Claimed first, so two clicks never make two drafts.
    if (!run(d.db, "UPDATE audio_handoffs SET status = 'approved', text = ?, decided_at = ?, decided_by = ?, log_draft_id = ? WHERE id = ? AND status = 'pending'", body, now(), who, did, h.id)) throw new HttpError(409, 'That summary was already decided');
    // A session log draft (GM only until the GM publishes it, after its leak check): never published from here.
    run(d.db, `INSERT INTO sessionlog_drafts (id, world_id, title, audio_session_id, from_at, to_at, world_start_minutes, dm_notes, used_model, proposal, date_status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, '', 1, NULL, 'none', ?, ?, ?)`, did, worldId, String(s.name).slice(0, 200), sessionId, s.started_at, s.stopped_at ?? now(), who, now(), now());
    run(d.db, 'INSERT INTO sessionlog_versions (id, draft_id, n, markdown, note, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)', id('slv_'), did, markdown, note, who, now());
  });
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, who, 'audio.handoff_approve', `${sessionId} -> ${did}`, now());
  d.hub.emit(worldId, 'audio-handoff', { sessionId }, dmOnly);
  return { ok: true, status: 'approved' as const, logDraftId: did };
}
