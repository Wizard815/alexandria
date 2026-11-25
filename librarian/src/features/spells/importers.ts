// Spells into a world from somewhere else: a JSON or CSV file the DM uploads,
// a game module the world has (its terms of kind "spell"), or library pages.
// Everything is stored for this world only, marked with its source, and a
// spell with the same name and source as one already there is skipped (or
// replaced when asked).
import type { Deps } from '../../app.ts';
import { all } from '../../core/db.ts';
import { redactMarkdown } from '../../core/policy.ts';
import { normLevel } from '../../core/levels.ts';
import { HttpError, parseJson } from '../../core/util.ts';
import { moduleDoc } from '../modules/store.ts';
import { LIMITS, normalizeSpell, parseCsv, type Spell } from './format.ts';
import { duplicateOf, saveCustom } from './store.ts';

export interface ImportRead { source: string; attribution: string; spells: Omit<Spell, 'id'>[]; warnings: string[] }

const cleanSource = (s: unknown, fallback: string) => (typeof s === 'string' && s.trim() ? s.replace(/\s+/g, ' ').trim().slice(0, 120) : fallback);

function fromRows(rows: unknown[], source: string, warnings: string[]): Omit<Spell, 'id'>[] {
  const out: Omit<Spell, 'id'>[] = [];
  if (rows.length > LIMITS.spellsPerImport) throw new HttpError(413, `At most ${LIMITS.spellsPerImport} spells at a time`);
  rows.forEach((r, i) => {
    try { out.push(normalizeSpell(r, source, `Row ${i + 1}`)); } catch (e: any) { if (warnings.length < 50) warnings.push(e.message); }
  });
  return out;
}

/** Read what the DM sent, without saving anything. */
export function readImport(d: Deps, worldId: string, b: any): ImportRead {
  const warnings: string[] = [];
  const type = String(b?.type ?? '');
  if (type === 'json') {
    let j = b.json;
    if (typeof j === 'string') { try { j = JSON.parse(j); } catch { throw new HttpError(400, 'That is not valid JSON'); } }
    const rows = Array.isArray(j) ? j : Array.isArray(j?.spells) ? j.spells : Array.isArray(j?.terms) ? j.terms.filter((t: any) => !t.kind || t.kind === 'spell') : Array.isArray(j?.results) ? j.results : null;
    if (!rows) throw new HttpError(400, 'Send a list of spells, or an object with a "spells" list');
    const source = cleanSource(b.source, cleanSource(j?.name ?? j?.source, 'Imported'));
    return { source, attribution: cleanSource(b.attribution ?? j?.attribution, ''), spells: fromRows(rows, source, warnings), warnings };
  }
  if (type === 'csv') {
    if (typeof b.csv !== 'string' || !b.csv.trim()) throw new HttpError(400, 'csv is required');
    if (b.csv.length > 8_000_000) throw new HttpError(413, 'The CSV is too large');
    const source = cleanSource(b.source, 'Imported CSV');
    return { source, attribution: cleanSource(b.attribution, ''), spells: fromRows(parseCsv(b.csv), source, warnings), warnings };
  }
  if (type === 'module') {
    const m = moduleDoc(d.db, worldId, String(b.moduleId ?? ''));
    if (!m) throw new HttpError(404, 'Module not found');
    const source = cleanSource(b.source, m.doc.name);
    const rows = m.doc.terms.filter((t) => t.kind === 'spell').map((t) => ({ ...(t.data && typeof t.data === 'object' ? t.data : {}), name: t.term, text: stripHead(t.text) }));
    if (!rows.length) throw new HttpError(400, `${m.doc.name} has no spells`);
    return { source, attribution: m.doc.attribution ?? '', spells: fromRows(rows, source, warnings), warnings };
  }
  if (type === 'library') {
    // Pages the DM picked, or every page in a folder. A classified page is never read (its text may never reach a model),
    // and DM-only parts inside a page (secret blocks, DM comments) are left out: they stay on the page.
    const ids: string[] = Array.isArray(b.pageIds) ? b.pageIds.map(String).slice(0, 2000) : [];
    const folder = typeof b.folder === 'string' ? b.folder.replace(/^\/+|\/+$/g, '') : '';
    if (!ids.length && !folder) throw new HttpError(400, 'Choose pages (pageIds) or a folder');
    const rows = all<any>(d.db, `SELECT id, path, title, visibility, frontmatter, body, tags FROM pages WHERE world_id = ? AND (${ids.length ? `id IN (${ids.map(() => '?').join(',')})` : '0'}${folder ? ' OR path LIKE ?' : ''})`, worldId, ...ids, ...(folder ? [`${folder}/%`] : []));
    const spells: Omit<Spell, 'id'>[] = [];
    for (const p of rows) {
      if (normLevel(p.visibility) === 'classified') { warnings.push(`${p.title}: classified pages are not read`); continue; }
      const fm = parseJson<Record<string, unknown>>(p.frontmatter, {});
      const tags = parseJson<string[]>(p.tags, []).map((t) => String(t).toLowerCase());
      const isSpell = fm.level !== undefined || String(fm.kind ?? fm.type ?? '').toLowerCase() === 'spell' || tags.includes('spell');
      if (!isSpell) { if (ids.length) warnings.push(`${p.title}: not a spell (give it a level in its frontmatter or a "spell" tag)`); continue; }
      const source = cleanSource(b.source, `Library: ${p.path}`.slice(0, 120));
      try { spells.push(normalizeSpell({ ...fm, name: fm.name ?? fm.title ?? p.title, text: stripHead(redactMarkdown(String(p.body ?? ''), 'player')), source }, source, p.title)); } catch (e: any) { warnings.push(e.message); }
    }
    if (!spells.length && !warnings.length) warnings.push('No spells found there');
    return { source: cleanSource(b.source, 'Library'), attribution: '', spells, warnings };
  }
  throw new HttpError(400, 'type must be json, csv, module or library');
}

/** Module and SRD texts start with an italic level line and the four fields; the spell card shows those itself. */
function stripHead(t: string): string {
  return String(t ?? '').replace(/^\*[^*\n]+\*\s*\n+/, '').replace(/^(?:\*\*(?:Casting Time|Range|Components?|Duration):\*\*[^\n]*\n?)+/i, '').trim();
}

export interface ImportResult { added: { id: string; name: string }[]; replaced: { id: string; name: string }[]; skipped: { name: string; source: string; why: string }[] }

/** Save what readImport found: new spells are added, same name + source is skipped (or replaced with `replace`). */
export function saveImport(d: Deps, worldId: string, read: ImportRead, replace: boolean): ImportResult {
  const out: ImportResult = { added: [], replaced: [], skipped: [] };
  const seen = new Set<string>();
  for (const s of read.spells) {
    const key = `${s.name.toLowerCase()}|${s.source.toLowerCase()}`;
    if (seen.has(key)) { out.skipped.push({ name: s.name, source: s.source, why: 'twice in this import' }); continue; }
    seen.add(key);
    const dup = duplicateOf(d.db, worldId, s.name, s.source);
    if (dup && (dup.startsWith('srd:') || !replace)) { out.skipped.push({ name: s.name, source: s.source, why: dup.startsWith('srd:') ? 'already in the SRD list' : 'already imported' }); continue; }
    if (dup) { saveCustom(d.db, worldId, s, 'import', read.attribution, dup); out.replaced.push({ id: dup, name: s.name }); continue; }
    out.added.push({ id: saveCustom(d.db, worldId, s, 'import', read.attribution), name: s.name });
  }
  return out;
}
