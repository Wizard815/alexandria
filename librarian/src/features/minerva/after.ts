// After each session (docs/MINERVA.md §8) and the arcs sessions are filed
// under (§4.5). When a session log is published its page is filed under the
// open arc, and Minerva drafts the status diff, codex accretions and
// promotions, each player's journal and knowledge, and hook and goal heat as
// one review for the DM. A model improves the status text when one is set;
// every draft is also made from the data alone.
import type { Deps } from '../../app.ts';
import { chatJson, hasJob, ModelUnavailable } from '../../core/ai.ts';
import { one, run } from '../../core/db.ts';
import { dmOnly } from '../../core/events.ts';
import { HttpError, id, now } from '../../core/util.ts';
import { listSessions, sessionLines } from '../audio/api.ts';
import { searchTerms } from '../agent/intent.ts';
import { findCodex, promotionCandidates, promotionDraft } from './codex.ts';
import { createDraft, type Op } from './ops.ts';
import { listMysteries } from './revelations.ts';
import { refreshHome } from './seed.ts';
import { audit, findArc, listArcs, openArc, requireEnabled, type Arc } from './store.ts';
import { STATUS_PATH, appendToSection, listPages, norm, players, readPage, sectionOf, setSection, slug, writePage } from './vault.ts';

const clean = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const bullets = (text: string): string[] => text.split('\n').map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter((l) => l && !/^_.*_$/.test(l) && !l.startsWith('>'));
const wordRe = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');

// ---- arcs ----------------------------------------------------------------------------

export function startArc(d: Deps, worldId: string, title: string, by: string | null): Arc {
  requireEnabled(d.db, worldId);
  const t = clean(title, 100);
  if (!t) throw new HttpError(400, 'title is required');
  const open = openArc(d.db, worldId);
  if (open) throw new HttpError(409, `Close ${open.title} first: sessions are filed under the open arc`);
  const n = (one<any>(d.db, 'SELECT MAX(n) AS n FROM minerva_arcs WHERE world_id = ?', worldId)?.n ?? 0) + 1;
  const sl = `${String(n).padStart(2, '0')}-${slug(t)}`;
  run(d.db, 'INSERT INTO minerva_arcs (id, world_id, n, slug, title, status, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id('arc_'), worldId, n, sl, t, 'open', now());
  audit(d, worldId, by, 'minerva.arc_start', sl);
  refreshHome(d, worldId, by);
  d.hub.emit(worldId, 'minerva', { kind: 'arc' }, dmOnly);
  return findArc(d.db, worldId, sl)!;
}

/** The arc new sessions go under: the open one, or a first one made now. */
export function arcForSession(d: Deps, worldId: string, by: string | null): Arc {
  return openArc(d.db, worldId) ?? startArc(d, worldId, `Arc ${(listArcs(d.db, worldId).at(-1)?.n ?? 0) + 1}`, by);
}

const sessionPagesOf = (d: Deps, worldId: string, arcSlug: string) => listPages(d, worldId, `chronicle/arcs/${arcSlug}/sessions/`).filter((p) => p.fm.type === 'session').sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));

/** Close the open arc and draft its one-page summary for the DM. */
export async function closeArc(d: Deps, worldId: string, ref: string, by: string | null): Promise<{ arc: Arc; draft: string }> {
  requireEnabled(d.db, worldId);
  const arc = !ref || ref === 'open' ? openArc(d.db, worldId) : findArc(d.db, worldId, ref);
  if (!arc) throw new HttpError(404, 'No such arc');
  if (readPage(d, worldId, `chronicle/arcs/${arc.slug}/summary.md`)) throw new HttpError(409, 'That arc already has a summary');
  const sessions = sessionPagesOf(d, worldId, arc.slug);
  const moments: string[] = [];
  const carried: string[] = [];
  for (const s of sessions) {
    const n = /session-(\d+)/.exec(s.rel)?.[1];
    moments.push(...bullets(sectionOf(s.body, 'Key moments')?.text ?? '').slice(0, 3).map((b) => `- ${b} ([[session-${n}]])`));
    carried.push(...bullets(sectionOf(s.body, 'Open threads')?.text ?? ''));
  }
  const lastOpen = [...new Set(carried.slice(-6))];
  let intro = '';
  if (hasJob(d, 'chat') && moments.length) {
    try {
      const j: any = await chatJson(d, 'chat', [
        { role: 'system', content: 'You write the one-page summary of a tabletop campaign arc from its session recaps. Use only the material. JSON only: {"summary": "3-5 sentences on what mattered and what changed"}.' },
        { role: 'user', content: `Arc: ${arc.title}\n\n${moments.join('\n').slice(0, 6000)}` },
      ]);
      intro = clean(j?.summary, 1500);
    } catch (e) { if (!(e instanceof ModelUnavailable)) throw e; }
  }
  const body = `# ${arc.title}\n\n${intro ? `${intro}\n\n` : ''}## What mattered\n${moments.join('\n') || '_No sessions were filed._'}\n\n## Threads carried forward\n${lastOpen.map((x) => `- ${x}`).join('\n') || '_None._'}\n\n## The DM's view\n> [!secret]\n> _What the arc was really about, and what the players have not seen yet._\n`;
  const dr = createDraft(d, worldId, {
    review: `arc-${arc.slug}`, kind: 'arc', title: `Summary of ${arc.title}`,
    op: { op: 'create', rel: `chronicle/arcs/${arc.slug}/summary.md`, title: `${arc.title}: summary`, fm: { type: 'arc', level: 'party', arc: arc.slug, tags: [] }, body },
  });
  run(d.db, `UPDATE minerva_arcs SET status = 'closed', closed_at = ? WHERE id = ?`, now(), arc.id);
  audit(d, worldId, by, 'minerva.arc_close', arc.slug);
  refreshHome(d, worldId, by);
  return { arc: findArc(d.db, worldId, arc.slug)!, draft: dr.id };
}

// ---- session pages and the log ------------------------------------------------------------

/** A line for the DM's eyes: one callout holds every line of the section. */
export const secretLines = (existing: string, line: string): string => (existing.trim() ? `${existing.trim()}\n> - ${line}` : `> [!secret]\n> - ${line}`);

export function sessionRel(arcSlug: string, n: number) { return `chronicle/arcs/${arcSlug}/sessions/session-${n}.md`; }

/** DM capture of what just happened (memory_log), under the session in progress. Only the DM can read it. */
export function memoryLog(d: Deps, worldId: string, a: { text: string; about?: string; session?: number }, by: string | null): { rel: string } {
  requireEnabled(d.db, worldId);
  const text = clean(a.text, 2000);
  if (!text) throw new HttpError(400, 'text is required');
  const n = a.session ?? (one<any>(d.db, 'SELECT MAX(number) AS n FROM sessionlog_entries WHERE world_id = ?', worldId)?.n ?? 0) + 1;
  const arc = arcForSession(d, worldId, by);
  const filed = one<any>(d.db, 'SELECT rel FROM minerva_sessions WHERE world_id = ? AND number = ?', worldId, n)?.rel as string | undefined;
  const rel = filed ?? sessionRel(arc.slug, n);
  const cur = readPage(d, worldId, rel);
  const line = `${new Date().toISOString().slice(0, 10)}: ${text}${a.about ? ` (about ${clean(a.about, 80)})` : ''}`;
  const base = cur?.body ?? `# Session ${n}\n\n`;
  writePage(d, worldId, rel, {
    title: cur?.title ?? `Session ${n}`, fm: cur ? undefined : { type: 'session', level: 'dm', arc: arc.slug, tags: [] },
    body: setSection(base, 'Log', secretLines(sectionOf(base, 'Log')?.text ?? '', line)), by,
  });
  return { rel };
}

/** File a conversation by speaker: into each player's journal and, as DM notes, the session page. */
export function conversationLog(d: Deps, worldId: string, a: { lines: { speaker: string; text: string }[]; session?: number }, by: string | null): { journals: number; rel: string } {
  requireEnabled(d.db, worldId);
  const lines = (a.lines ?? []).map((l) => ({ speaker: clean(l?.speaker, 80), text: clean(l?.text, 1000) })).filter((l) => l.speaker && l.text).slice(0, 300);
  if (!lines.length) throw new HttpError(400, 'lines needs at least one { speaker, text }');
  const n = a.session ?? (one<any>(d.db, 'SELECT MAX(number) AS n FROM sessionlog_entries WHERE world_id = ?', worldId)?.n ?? 0) + 1;
  const ps = players(d, worldId);
  const byPlayer = new Map<string, string[]>();
  for (const l of lines) {
    const p = ps.find((x) => norm(x.character) === norm(l.speaker) || norm(x.name) === norm(l.speaker));
    if (p) byPlayer.set(p.accountId, [...(byPlayer.get(p.accountId) ?? []), `- ${l.text}`]);
  }
  const arc = arcForSession(d, worldId, by);
  for (const [acc, ls] of byPlayer) {
    const rel = `players/${acc}/journal/session-${n}.md`;
    const cur = readPage(d, worldId, rel);
    writePage(d, worldId, rel, { title: `Session ${n}`, fm: cur ? undefined : { type: 'journal', level: 'party', player: acc, arc: arc.slug, tags: [] }, body: appendToSection(cur?.body ?? `# Session ${n}\n\n`, 'What you said', ls.join('\n')), by });
  }
  const filed = one<any>(d.db, 'SELECT rel FROM minerva_sessions WHERE world_id = ? AND number = ?', worldId, n)?.rel as string | undefined;
  const rel = filed ?? sessionRel(arc.slug, n);
  const cur = readPage(d, worldId, rel);
  let sec = sectionOf(cur?.body ?? '', 'Conversation')?.text ?? '';
  for (const l of lines) sec = secretLines(sec, `${l.speaker}: ${l.text}`);
  writePage(d, worldId, rel, { title: cur?.title ?? `Session ${n}`, fm: cur ? undefined : { type: 'session', level: 'dm', arc: arc.slug, tags: [] }, body: setSection(cur?.body ?? `# Session ${n}\n\n`, 'Conversation', sec), by });
  return { journals: byPlayer.size, rel };
}

// ---- filing a published session log -----------------------------------------------------------

export interface FileResult { number: number; rel: string; review: string; drafts: number; already?: boolean }

const STATUS_SECTION_OPS = (text: string, section: string): Op => ({ op: 'section', rel: STATUS_PATH, section, text, mode: 'replace' });

async function modelStatus(d: Deps, worldId: string, summary: string): Promise<{ changed: string[]; next: string[] } | null> {
  if (!hasJob(d, 'chat') || !summary.trim()) return null;
  try {
    const status = readPage(d, worldId, STATUS_PATH);
    const j: any = await chatJson(d, 'chat', [
      { role: 'system', content: 'You help a Dungeon Master keep a campaign status document current. From the session recap, say what changed and what to prepare next. Use only the material; never invent. JSON only: {"changed": ["short bullet", ...], "next": ["short bullet", ...]} with at most 6 bullets each.' },
      { role: 'user', content: `Current status "Now":\n${(status ? sectionOf(status.body, 'Now')?.text : '') ?? ''}\n\nSession recap (what the players know):\n${summary.slice(0, 6000)}` },
    ]);
    const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => clean(x, 240)).filter(Boolean).slice(0, 6) : []);
    const out = { changed: list(j?.changed), next: list(j?.next) };
    return out.changed.length || out.next.length ? out : null;
  } catch (e) { if (e instanceof ModelUnavailable) return null; throw e; }
}

/** File one published session log entry into the vault and draft the review. Safe to call twice. */
export async function fileSession(d: Deps, worldId: string, entryId: string, by: string | null): Promise<FileResult> {
  requireEnabled(d.db, worldId);
  const entry = one<any>(d.db, 'SELECT * FROM sessionlog_entries WHERE id = ? AND world_id = ?', entryId, worldId);
  if (!entry) throw new HttpError(404, 'No such session log entry');
  const done = one<any>(d.db, 'SELECT * FROM minerva_sessions WHERE world_id = ? AND entry_id = ?', worldId, entryId);
  if (done) return { number: done.number, rel: done.rel, review: `session-${done.number}`, drafts: 0, already: true };
  const n: number = entry.number;
  const arc = arcForSession(d, worldId, by);
  const rel = sessionRel(arc.slug, n);
  const cur = readPage(d, worldId, rel);
  const draft = entry.draft_id ? one<any>(d.db, 'SELECT dm_notes, audio_session_id, from_at, to_at FROM sessionlog_drafts WHERE id = ?', entry.draft_id) : null;
  const log = sectionOf(cur?.body ?? '', 'Log')?.text ?? '';
  const conv = sectionOf(cur?.body ?? '', 'Conversation')?.text ?? '';
  const notes = clean(draft?.dm_notes, 4000) && String(draft!.dm_notes).trim().split('\n').map((l: string) => `> ${l.replace(/^[-*]\s+/, '- ')}`).join('\n');
  let body = `# Session ${n}: ${entry.title}\n\nIn the world: ${entry.world_from_label === entry.world_to_label ? entry.world_from_label : `${entry.world_from_label} to ${entry.world_to_label}`}.\n\n${String(entry.summary).trim()}\n`;
  if (log) body = setSection(body, 'Log', log);
  if (conv) body = setSection(body, 'Conversation', conv);
  if (notes) body = setSection(body, 'DM notes', `> [!secret]\n${notes}`);
  writePage(d, worldId, rel, { title: `Session ${n}: ${entry.title}`, fm: { type: 'session', level: 'party', arc: arc.slug, sources: [entry.id], tags: [] }, body, by });
  run(d.db, 'INSERT INTO minerva_sessions (world_id, entry_id, number, arc_slug, rel, filed_at) VALUES (?, ?, ?, ?, ?, ?)', worldId, entryId, n, arc.slug, rel, now());

  const review = `session-${n}`;
  let count = 0;
  const add = (kind: string, title: string, op: Op, byAccount: string | null = null) => { createDraft(d, worldId, { review, kind, title, op, byAccount, tool: 'after_session' }); count++; };
  const summary = String(entry.summary);
  const recap = bullets(sectionOf(summary, 'Recap')?.text ?? '');
  const moments = bullets(sectionOf(summary, 'Key moments')?.text ?? '');
  const open = bullets(sectionOf(summary, 'Open threads')?.text ?? '');
  const met = bullets(sectionOf(summary, 'People met')?.text ?? '');

  // 1. The status doc: what changed, what is next, the threads by heat.
  const ms = await modelStatus(d, worldId, summary);
  const changed = ms?.changed.length ? ms.changed : [...moments, ...recap.slice(0, moments.length ? 0 : 4)].slice(0, 8);
  const next = ms?.next.length ? ms.next : open.slice(0, 6);
  if (changed.length) add('status', 'Status: what changed last session', STATUS_SECTION_OPS(changed.map((x) => `- ${x}`).join('\n'), 'What changed last session'));
  if (next.length) add('status', 'Status: next session', STATUS_SECTION_OPS(next.map((x) => `- ${x}`).join('\n'), 'Next session'));

  // 2. Hooks and goals: heat follows what happened.
  const lines = sessionTexts(d, worldId, draft);
  const corpus = `${summary}\n${[...lines.values()].flat().join('\n')}`;
  const threads: { title: string; heat: string }[] = [];
  const heatStep: Record<string, string> = { on: 'ongoing', ongoing: 'simmering', simmering: 'sleeping' };
  for (const h of listPages(d, worldId, 'dm/hooks/')) {
    const heat = String(h.fm.heat ?? 'ongoing');
    const hit = wordRe(h.title).test(corpus);
    const next_ = hit ? 'on' : heat === 'on' ? heatStep.on : heat;
    if (next_ !== heat) add('heat', `Hook "${h.title}": ${heat} to ${next_}`, { op: 'heat', rel: h.rel, heat: next_ as any });
    threads.push({ title: h.title, heat: next_ });
  }
  for (const g of listPages(d, worldId, 'players/').filter((p) => p.fm.type === 'goal')) {
    const heat = String(g.fm.heat ?? 'ongoing');
    const hit = wordRe(g.title).test(corpus);
    const next_ = hit ? 'on' : heat === 'on' ? heatStep.on : heat;
    if (next_ !== heat) add('heat', `Goal "${g.title}": ${heat} to ${next_}`, { op: 'heat', rel: g.rel, heat: next_ as any }, null);
  }
  if (threads.length) {
    add('status', 'Status: active threads', { op: 'threads', rel: STATUS_PATH, items: threads.map((t) => ({ title: t.title, heat: t.heat as any })) });
  }

  // 3. Codex: who appeared again; who now deserves a page.
  const pages = listPages(d, worldId, 'codex/');
  for (const m of met) {
    const nm = /^\**([^*:—–,(-]+?)\**\s*(?:[:—–,(-]|$)/.exec(m)?.[1]?.trim() ?? m;
    const page = findCodex(d, worldId, { name: nm }, pages);
    if (page && !page.body.includes(`[[session-${n}]]`)) add('codex', `${page.title}: appeared in session ${n}`, { op: 'codex', name: page.title, entity: String(page.fm.entity ?? '') || undefined, section: 'appearances', text: m.slice(0, 240), session: n });
  }
  for (const c of promotionCandidates(d, worldId).slice(0, 8)) {
    try { const p = promotionDraft(d, worldId, c.name, c.kind); add('promote', `Promote ${c.name} (${c.reasons.join(', ')})`, { op: 'create', ...p }); } catch { /* has a page now */ }
  }

  // 4. Each player's journal entry, and the clues their own words suggest they found.
  const mysteries = listMysteries(d, worldId);
  for (const p of players(d, worldId)) {
    const said = (lines.get(p.accountId) ?? []).filter((t) => t.split(/\s+/).length >= 5).sort((a, b) => b.length - a.length).slice(0, 4);
    const text = [recap.length ? recap.slice(0, 6).map((r) => `- ${r}`).join('\n') : '', said.length ? `\nYou said:\n${said.map((s) => `- ${s}`).join('\n')}` : ''].join('').trim();
    if (text) add('journal', `${p.character || p.name}: journal for session ${n}`, { op: 'section', rel: `players/${p.accountId}/journal/session-${n}.md`, section: 'From the session log', mode: 'append', text, title: `Session ${n}`, fm: { type: 'journal', level: 'party', player: p.accountId, arc: arc.slug, tags: [] } });
    const mine = (lines.get(p.accountId) ?? []).join(' ');
    for (const m of mysteries) for (const c of m.clues) {
      if (c.found.some((f) => f.accountId === p.accountId)) continue;
      const keys = searchTerms(c.text, 8).filter((w) => w.length >= 4);
      if (keys.length < 3) continue;
      const have = keys.filter((w) => norm(mine).includes(w)).length;
      if (have / keys.length >= 0.6) add('knowledge', `${p.character || p.name} may have found a clue of "${m.title}"`, { op: 'mark', mystery: m.slug, clue: c.n, player: p.accountId, session: n });
    }
  }
  refreshHome(d, worldId, by);
  audit(d, worldId, by, 'minerva.file_session', `${rel} ${count} drafts`);
  d.hub.emit(worldId, 'minerva', { kind: 'review', review }, dmOnly);
  return { number: n, rel, review, drafts: count };
}

/** What each player said in the session's recording (the players' transcript only), by account. */
function sessionTexts(d: Deps, worldId: string, draft: { audio_session_id?: string | null; from_at?: string; to_at?: string } | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!draft) return out;
  const sessions = listSessions(d.db, worldId).filter((s) => (draft.audio_session_id ? s.id === draft.audio_session_id : (!draft.from_at || (s.stoppedAt ?? '9') >= draft.from_at) && (!draft.to_at || s.startedAt <= draft.to_at)));
  for (const s of sessions) for (const l of sessionLines(d.db, worldId, s.id, { includeDm: false })) if (l.speakerId) out.set(l.speakerId, [...(out.get(l.speakerId) ?? []), l.text]);
  return out;
}

