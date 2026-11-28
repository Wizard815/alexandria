// Edits to the vault as data. A tool's write, a draft from the after-session
// workflow and a player's journal entry are all an Op: it can be shown to the
// GM as a diff, edited, approved (applied) or rejected (docs/MINERVA.md §7-§8).
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { gmOnly } from '../../core/events.ts';
import { HttpError, id, now, parseJson } from '../../core/util.ts';
import type { FM } from '../../core/frontmatter.ts';
import { codexUpsert, upsertTarget } from './codex.ts';
import { markRevelation } from './revelations.ts';
import { audit, findArc } from './store.ts';
import { HEATS, THREADS_SECTION, appendToSection, mergeThreads, readPage, sectionOf, setSection, writePage, type Heat } from './vault.ts';

export type Op =
  | { op: 'section'; rel: string; section: string; text: string; mode: 'append' | 'replace'; title?: string; fm?: FM }
  | { op: 'create'; rel: string; title: string; fm: FM; body: string }
  | { op: 'heat'; rel: string; heat: Heat }
  | { op: 'threads'; rel: string; items: { title: string; heat: Heat }[] }
  | { op: 'mark'; mystery: string; clue?: string | number; player: string; session?: number | null; kind?: 'clue' | 'theory' | 'reached'; text?: string }
  | { op: 'codex'; name?: string; entity?: string; kind?: string; section: string; text: string; session?: number | null; visible?: boolean }
  | { op: 'level'; rel: string; level: string };

export interface Applied { rel?: string; note: string }

/** Apply one op to the vault. */
export function applyOp(d: Deps, worldId: string, op: Op, by: string | null): Applied {
  switch (op.op) {
    case 'section': {
      const cur = readPage(d, worldId, op.rel);
      const base = cur?.body ?? `# ${op.title ?? op.rel.split('/').pop()!.replace(/\.md$/i, '')}\n\n`;
      const body = op.mode === 'replace' ? setSection(base, op.section, op.text) : appendToSection(base, op.section, op.text);
      writePage(d, worldId, op.rel, { title: op.title, fm: op.fm, body, by });
      return { rel: op.rel, note: `${op.mode === 'replace' ? 'Rewrote' : 'Added to'} ${op.section}` };
    }
    case 'create': {
      if (readPage(d, worldId, op.rel)) throw new HttpError(409, `${op.rel} already exists; add to it instead`);
      writePage(d, worldId, op.rel, { title: op.title, fm: op.fm, body: op.body, by });
      return { rel: op.rel, note: 'Created the page' };
    }
    case 'heat': {
      const p = readPage(d, worldId, op.rel);
      if (!p) throw new HttpError(404, `No such page: ${op.rel}`);
      if (!(HEATS as readonly string[]).includes(op.heat)) throw new HttpError(400, `heat must be one of ${HEATS.join(', ')}`);
      writePage(d, worldId, op.rel, { fm: { heat: op.heat }, by });
      return { rel: op.rel, note: `Heat is now ${op.heat}` };
    }
    case 'threads': {
      const cur = readPage(d, worldId, op.rel);
      const base = cur?.body ?? `# Campaign Status\n\n`;
      writePage(d, worldId, op.rel, { body: setSection(base, THREADS_SECTION, mergeThreads(sectionOf(base, THREADS_SECTION)?.text ?? '', op.items)), by });
      return { rel: op.rel, note: `Updated the heat of ${op.items.length} thread${op.items.length === 1 ? '' : 's'}` };
    }
    case 'mark': {
      const r = markRevelation(d, worldId, { ...op, by });
      return { note: `${r.player}: ${op.kind === 'reached' ? 'reached' : op.kind === 'theory' ? 'theory noted' : `clue ${r.clue}`} of ${r.mystery}` };
    }
    case 'codex': {
      const r = codexUpsert(d, worldId, { ...op, by });
      return { rel: r.rel, note: r.created ? 'Made the codex page' : 'Added to the codex page' };
    }
    case 'level': {
      const p = readPage(d, worldId, op.rel);
      if (!p) throw new HttpError(404, `No such page: ${op.rel}`);
      if (!['party', 'broker', 'gm', 'classified'].includes(op.level)) throw new HttpError(400, 'level must be party, broker, gm or classified');
      writePage(d, worldId, op.rel, { fm: { level: op.level }, by });
      return { rel: op.rel, note: `Level is now ${op.level}` };
    }
    default: throw new HttpError(400, 'Unknown change');
  }
}

/** What an op would change, for the GM: the text of the part it touches, before and after. */
export function previewOp(d: Deps, worldId: string, op: Op): { rel: string; where: string; before: string; after: string; level?: string; visibleToPlayers?: boolean } {
  switch (op.op) {
    case 'section': {
      const cur = readPage(d, worldId, op.rel);
      const base = cur?.body ?? '';
      const next = op.mode === 'replace' ? setSection(base, op.section, op.text) : appendToSection(base, op.section, op.text);
      return { rel: op.rel, where: op.section, before: sectionText(base, op.section), after: sectionText(next, op.section) };
    }
    case 'threads': {
      const base = readPage(d, worldId, op.rel)?.body ?? '';
      const before = sectionText(base, THREADS_SECTION);
      return { rel: op.rel, where: THREADS_SECTION, before, after: mergeThreads(before, op.items) };
    }
    case 'create': return { rel: op.rel, where: 'new page', before: '', after: op.body };
    case 'heat': return { rel: op.rel, where: 'heat', before: String(readPage(d, worldId, op.rel)?.fm.heat ?? ''), after: op.heat };
    case 'mark': return { rel: '', where: op.kind === 'reached' ? 'reached' : op.kind === 'theory' ? 'theory' : 'clue', before: '', after: `${op.player}: ${op.text ?? op.clue ?? ''} (${op.mystery})` };
    case 'codex': { const t = upsertTarget(d, worldId, op); return { rel: '', where: op.section, before: '', after: `${op.name ?? op.entity}: ${op.text}`, level: t.level, visibleToPlayers: t.visible }; }
    case 'level': return { rel: op.rel, where: 'level', before: String(readPage(d, worldId, op.rel)?.fm.level ?? ''), after: op.level };
  }
}
const sectionText = (body: string, heading: string): string => {
  const m = new RegExp(`^##[ \\t]+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'im').exec(body);
  if (!m) return '';
  const from = m.index + m[0].length;
  const next = /^##[ \t]+\S/m.exec(body.slice(from));
  return body.slice(from, next ? from + next.index : undefined).trim();
};

// ---- drafts --------------------------------------------------------------------

export interface Draft { id: string; review: string; kind: string; title: string; op: Op; status: 'pending' | 'approved' | 'rejected' | 'failed'; byAccount: string | null; tool: string; createdAt: string; decidedAt: string | null; note: string }
const draftOut = (r: any): Draft => ({ id: r.id, review: r.review, kind: r.kind, title: r.title, op: parseJson<Op>(r.op, { op: 'level', rel: '', level: 'gm' }), status: r.status, byAccount: r.by_account, tool: r.tool, createdAt: r.created_at, decidedAt: r.decided_at, note: r.note });

export function createDraft(d: Deps, worldId: string, a: { review?: string; kind: string; title: string; op: Op; byAccount?: string | null; tool?: string }): Draft {
  const did = id('md_');
  run(d.db, 'INSERT INTO minerva_drafts (id, world_id, review, kind, title, op, status, by_account, tool, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', did, worldId, a.review ?? '', a.kind, a.title.slice(0, 200), JSON.stringify(a.op), 'pending', a.byAccount ?? null, a.tool ?? '', now());
  d.hub.emit(worldId, 'minerva', { kind: 'draft', id: did }, gmOnly);
  return getDraft(d, worldId, did)!;
}

export const getDraft = (d: Deps, worldId: string, did: string): Draft | null => { const r = one<any>(d.db, 'SELECT * FROM minerva_drafts WHERE id = ? AND world_id = ?', did, worldId); return r ? draftOut(r) : null; };

export function listDrafts(d: Deps, worldId: string, status: string | null = 'pending'): Draft[] {
  // Live suggestions (kind suggest-*) sort below everything else.
  return all<any>(d.db, `SELECT * FROM minerva_drafts WHERE world_id = ? ${status ? 'AND status = ?' : ''} ORDER BY (kind LIKE 'suggest-%'), created_at, rowid LIMIT 500`, worldId, ...(status ? [status] : [])).map(draftOut);
}

/** The GM's decision. Approving applies the op; a failure is kept on the draft. */
export function decideDraft(d: Deps, worldId: string, did: string, decision: 'approve' | 'reject', who: string, edit?: { text?: string; body?: string }): Draft {
  const dr = getDraft(d, worldId, did);
  if (!dr) throw new HttpError(404, 'No such draft');
  if (dr.status !== 'pending') throw new HttpError(409, 'That draft was already decided');
  let op = dr.op;
  if (edit && (edit.text !== undefined || edit.body !== undefined)) {
    if ('text' in op && edit.text !== undefined) op = { ...op, text: String(edit.text).slice(0, 20_000) } as Op;
    if ('body' in op && edit.body !== undefined) op = { ...op, body: String(edit.body).slice(0, 200_000) } as Op;
    run(d.db, 'UPDATE minerva_drafts SET op = ? WHERE id = ?', JSON.stringify(op), did);
  }
  if (decision === 'reject') {
    run(d.db, `UPDATE minerva_drafts SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`, now(), who, did);
    audit(d, worldId, who, 'minerva.reject', `${dr.kind} ${dr.title}`);
    return getDraft(d, worldId, did)!;
  }
  // Claim it first, so two clicks never apply it twice.
  if (!run(d.db, `UPDATE minerva_drafts SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`, now(), who, did)) throw new HttpError(409, 'That draft was already decided');
  try {
    const r = applyOp(d, worldId, op, who);
    run(d.db, 'UPDATE minerva_drafts SET note = ? WHERE id = ?', r.note, did);
    audit(d, worldId, who, 'minerva.approve', `${dr.kind} ${dr.title}`);
  } catch (e: any) {
    run(d.db, `UPDATE minerva_drafts SET status = 'failed', note = ? WHERE id = ?`, String(e?.message ?? e).slice(0, 300), did);
    throw e;
  }
  return getDraft(d, worldId, did)!;
}

export const arcOf = (d: Deps, worldId: string, ref: string) => findArc(d.db, worldId, ref);
