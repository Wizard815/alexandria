// The leak check: compare a summary with every piece of DM-only text in the
// world, using 8-word shingles. Pure functions over the database; no models.
import type { DB } from '../../core/db.ts';
import { all } from '../../core/db.ts';
import { parseJson } from '../../core/util.ts';

export const SHINGLE = 8;
const GAP = '\u0000';

export interface Overlap {
  /** The overlapping passage, as written in the summary. */
  text: string;
  /** Where the DM-only text lives, e.g. "DM page: dm/Velmira" or "aside (transcript)". */
  source: string;
  /** Overlap with an aside line: asides never publish, not even with force. */
  aside: boolean;
}

const MARKS = /[`*_#>\[\]()|~]/g;

/** Lower-cased words of a text, markdown marks removed. */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().replace(MARKS, ' ').split(/[^\p{L}\p{N}']+/u).filter(Boolean);
}

function shingles(ws: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + SHINGLE <= ws.length; i++) out.push(ws.slice(i, i + SHINGLE).join(' '));
  return out;
}

/** Every string inside a JSON value (page blocks and properties). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}
const jsonText = (s: string | null | undefined) => strings(parseJson<unknown>(s, [])).join('\n');

interface Corpus { source: string; aside: boolean; words: string[] }

/** The words of a DM copy that its player copy does not contain (others become gaps). */
function dmOnlyWords(dm: string, player: string | null): string[] {
  const ws = wordsOf(dm);
  const seen = new Set(shingles(wordsOf(player ?? '')));
  const keep = new Array<boolean>(ws.length).fill(false);
  shingles(ws).forEach((s, i) => { if (!seen.has(s)) for (let k = 0; k < SHINGLE; k++) keep[i + k] = true; });
  return ws.map((w, i) => (keep[i] ? w : GAP));
}

export function lineIsAside(l: { session_id: string; start_ms: number; end_ms: number; sources: string }, mics: Map<string, boolean>, holds: { session_id: string; start_ms: number; end_ms: number }[]): boolean {
  if (parseJson<string[]>(l.sources, []).some((m) => mics.get(m))) return true;
  return holds.some((h) => h.session_id === l.session_id && h.end_ms >= l.start_ms - 1000 && h.start_ms <= l.end_ms + 1000);
}

/** DM-only text of a world: what a page's DM copy has and its player copy lacks, DM profile blocks and notes, DM and aside transcript lines. */
export function dmCorpus(db: DB, worldId: string): Corpus[] {
  const out: Corpus[] = [];
  const add = (source: string, aside: boolean, words: string[]) => { if (words.some((w) => w !== GAP)) out.push({ source, aside, words }); };
  for (const p of all<any>(db, 'SELECT path, body, player_body, blocks, player_blocks, properties, player_properties, frontmatter, player_frontmatter FROM pages WHERE world_id = ?', worldId)) {
    add(`DM page: ${p.path}`, false, dmOnlyWords(p.body ?? '', p.player_body));
    add(`DM blocks: ${p.path}`, false, dmOnlyWords(jsonText(p.blocks), p.player_blocks === null ? null : jsonText(p.player_blocks)));
    add(`DM facts: ${p.path}`, false, dmOnlyWords(jsonText(p.properties), p.player_properties === null ? null : jsonText(p.player_properties)));
    add(`DM frontmatter: ${p.path}`, false, dmOnlyWords(jsonText(p.frontmatter), p.player_frontmatter === null ? null : jsonText(p.player_frontmatter)));
  }
  for (const b of all<any>(db, "SELECT title, body FROM profile_blocks WHERE world_id = ? AND visibility = 'dm'", worldId)) add(`DM profile block: ${b.title}`, false, wordsOf(b.body));
  for (const i of all<any>(db, "SELECT name, dm_note FROM items WHERE world_id = ? AND dm_note != ''", worldId)) add(`DM item note: ${i.name}`, false, wordsOf(i.dm_note));
  for (const r of all<any>(db, "SELECT dm_note FROM broker_requests WHERE world_id = ? AND dm_note IS NOT NULL AND dm_note != ''", worldId)) add('DM broker note', false, wordsOf(r.dm_note));

  const mics = new Map(all<any>(db, 'SELECT id, aside FROM audio_mics WHERE world_id = ?', worldId).map((m) => [m.id as string, m.aside === 1]));
  const holds = all<any>(db, "SELECT h.session_id, h.start_ms, h.end_ms FROM audio_holds h JOIN audio_sessions s ON s.id = h.session_id WHERE s.world_id = ? AND h.kind = 'aside'", worldId);
  for (const l of all<any>(db, "SELECT session_id, start_ms, end_ms, text, sources FROM audio_lines WHERE world_id = ? AND audience = 'dm'", worldId)) {
    const aside = lineIsAside(l, mics, holds);
    add(aside ? 'aside (transcript)' : 'DM line (transcript)', aside, wordsOf(l.text));
  }
  return out;
}

/** Passages of `summary` (runs of 8+ words) that also appear in DM-only text. */
export function leakCheck(db: DB, worldId: string, summary: string): Overlap[] {
  const display: string[] = [];
  const norm: string[] = [];
  for (const tok of summary.replace(MARKS, ' ').split(/\s+/)) {
    const parts = wordsOf(tok);
    if (!parts.length) continue;
    // A token like "dock-master" counts as two words but is shown once.
    parts.forEach((p, i) => { norm.push(p); display.push(i === 0 ? tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') : ''); });
  }
  if (norm.length < SHINGLE) return [];
  const index = new Map<string, Map<string, boolean>>();
  for (const c of dmCorpus(db, worldId)) {
    for (let i = 0; i + SHINGLE <= c.words.length; i++) {
      const win = c.words.slice(i, i + SHINGLE);
      if (win.includes(GAP)) continue;
      const k = win.join(' ');
      const m = index.get(k) ?? new Map<string, boolean>();
      m.set(c.source, (m.get(c.source) ?? false) || c.aside);
      index.set(k, m);
    }
  }
  const hit: (Map<string, boolean> | null)[] = norm.map(() => null);
  for (let i = 0; i + SHINGLE <= norm.length; i++) {
    const m = index.get(norm.slice(i, i + SHINGLE).join(' '));
    if (!m) continue;
    for (let k = 0; k < SHINGLE; k++) {
      const cur = hit[i + k] ?? new Map<string, boolean>();
      for (const [s, a] of m) cur.set(s, (cur.get(s) ?? false) || a);
      hit[i + k] = cur;
    }
  }
  const out: Overlap[] = [];
  for (let i = 0; i < norm.length;) {
    if (!hit[i]) { i++; continue; }
    let j = i;
    const srcs = new Map<string, boolean>();
    while (j < norm.length && hit[j]) { for (const [s, a] of hit[j]!) srcs.set(s, (srcs.get(s) ?? false) || a); j++; }
    const first = [...srcs.entries()].sort((a, b) => Number(b[1]) - Number(a[1]))[0];
    out.push({ text: display.slice(i, j).filter(Boolean).join(' '), source: first[0], aside: [...srcs.values()].some(Boolean) });
    i = j;
  }
  return out;
}
