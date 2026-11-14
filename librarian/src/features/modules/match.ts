// Keyword matching: given text, find the rules terms and library pages it
// mentions, so the app can highlight them and show a card on hover.
//
// - The longest phrase wins, case-insensitively, on whole words only.
// - An index (phrase -> entry) is built per world and per kind of viewer
//   (DM, or everyone else) and reused until a module or a page changes.
// - Players only ever match pages that have a player copy (visibility
//   'party' and a computed player_body). A DM-only page's title or aliases
//   never enter the player index, so they cannot be highlighted or learned.
import { type DB, all, one } from '../../core/db.ts';
import { parseJson } from '../../core/util.ts';
import type { Viewer } from '../../core/policy.ts';
import { moduleVersion, worldModules } from './store.ts';

export interface Match {
  start: number;
  end: number;
  /** The matched text as written. */
  text: string;
  /** The canonical name of the term or page. */
  term: string;
  kind: string;
  source: 'module' | 'library';
  /** Module terms: `moduleId:termId`. Library: the page id. */
  id: string;
}

interface Entry { term: string; kind: string; source: 'module' | 'library'; id: string }
interface Index { key: string; map: Map<string, Entry>; maxWords: number }

const MAX_WORDS = 6;
const MAX_TEXT = 100_000;
const MAX_MATCHES = 2000;
const STOP = new Set(['the', 'and', 'for', 'you', 'are', 'but', 'not', 'any', 'all', 'one', 'can', 'its', 'has', 'was', 'who', 'how', 'now', 'may', 'use', 'new', 'old', 'out', 'off', 'our', 'his', 'her', 'she', 'him', 'let', 'say', 'too', 'two', 'yes', 'with', 'this', 'that', 'from', 'have', 'they', 'will', 'then', 'than', 'them', 'what', 'when', 'your', 'each', 'into', 'over', 'some', 'such', 'only', 'also', 'more', 'most', 'other', 'there', 'their', 'which', 'would', 'about', 'could', 'after', 'being']);

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;
const norm = (s: string) => s.toLowerCase().replace(/’/g, "'");

interface Tok { start: number; end: number; w: string }

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(WORD)) {
    let w = norm(m[0]).replace(/^'+|'+$/g, '');
    let len = m[0].length;
    // "Velmira's" is the word Velmira; the 's stays outside the highlight.
    if (w.endsWith("'s") && w.length > 3) { w = w.slice(0, -2); len -= 2; }
    if (w) out.push({ start: m.index!, end: m.index! + len, w });
  }
  return out;
}

const keyOf = (phrase: string): { key: string; words: number } | null => {
  const t = tokens(phrase);
  if (!t.length || t.length > MAX_WORDS) return null;
  const key = t.map((x) => x.w).join(' ');
  if (key.length < 3 || /^[\d\s]+$/.test(key)) return null;
  if (t.length === 1 && STOP.has(key)) return null;
  return { key, words: t.length };
};

function build(key: string, add: (put: (phrase: string, e: Entry, opts?: { weak?: boolean }) => void) => void): Index {
  const map = new Map<string, Entry>();
  let maxWords = 1;
  add((phrase, e) => {
    const k = keyOf(phrase);
    if (!k || map.has(k.key)) return;
    map.set(k.key, e);
    if (k.words > maxWords) maxWords = k.words;
  });
  return { key, map, maxWords };
}

const indexes = new WeakMap<DB, Map<string, Index>>();

/** Cheap fingerprint of a world's pages: changes on save, delete, and when player copies are rebuilt. */
function librarySig(db: DB, worldId: string): string {
  const r = one<any>(db, "SELECT count(*) AS n, max(updated_at) AS u, sum(player_body IS NOT NULL) AS p, sum(visibility = 'party') AS v, sum(visibility = 'classified') AS c, sum(length(title) + length(aliases)) AS l FROM pages WHERE world_id = ?", worldId);
  return `${r?.n ?? 0}|${r?.u ?? ''}|${r?.p ?? 0}|${r?.v ?? 0}|${r?.c ?? 0}|${r?.l ?? 0}`;
}

function indexFor(db: DB, worldId: string, viewer: Viewer): Index {
  const dm = viewer.role === 'dm';
  const model = dm && viewer.audience !== undefined;
  const mods = worldModules(db, worldId);
  const key = `${dm ? (model ? 'ai' : 'dm') : 'pl'}|${moduleVersion(db, worldId)}|${mods.version}|${librarySig(db, worldId)}`;
  const slot = `${worldId}|${dm ? (model ? 'ai' : 'dm') : 'pl'}`;
  const cache = indexes.get(db) ?? new Map<string, Index>();
  indexes.set(db, cache);
  const hit = cache.get(slot);
  if (hit && hit.key === key) return hit;
  const idx = build(key, (put) => {
    // The world's own pages come first: a campaign page beats a generic rule of the same name.
    const rows = dm
      ? all<any>(db, `SELECT id, title, kind, aliases FROM pages WHERE world_id = ? AND visibility IN ('dm', 'party', 'broker'${model ? '' : ", 'classified'"})`, worldId)
      : all<any>(db, "SELECT id, title, kind, aliases FROM pages WHERE world_id = ? AND visibility = 'party' AND player_body IS NOT NULL", worldId);
    for (const p of rows) {
      const e: Entry = { term: p.title, kind: p.kind || 'page', source: 'library', id: p.id };
      put(p.title, e);
      for (const a of parseJson<unknown[]>(p.aliases, [])) if (typeof a === 'string') put(a, e);
    }
    for (const t of mods.terms) {
      const e: Entry = { term: t.term, kind: t.kind, source: 'module', id: t.ref };
      // Plain verbs like "Dash" or "Help" would light up every sentence: those actions match by their longer aliases ("Dash action").
      const common = t.kind === 'action' && tokens(t.term).length === 1;
      if (!common) put(t.term, e);
      for (const a of t.aliases) put(a, e);
    }
  });
  cache.set(slot, idx);
  return idx;
}

export function findMatches(db: DB, worldId: string, viewer: Viewer, text: string): Match[] {
  const idx = indexFor(db, worldId, viewer);
  const t = tokens(text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text);
  const out: Match[] = [];
  for (let i = 0; i < t.length && out.length < MAX_MATCHES;) {
    let found = false;
    for (let n = Math.min(idx.maxWords, t.length - i); n >= 1; n--) {
      // Words must be separated by spaces or hyphens only, not punctuation.
      let ok = true;
      for (let j = i; j < i + n - 1; j++) if (!/^[\s\-–—]+$/.test(text.slice(t[j].end, t[j + 1].start))) { ok = false; break; }
      if (!ok) continue;
      const key = t.slice(i, i + n).map((x) => x.w).join(' ');
      const e = idx.map.get(key);
      if (e) {
        const start = t[i].start, end = t[i + n - 1].end;
        out.push({ start, end, text: text.slice(start, end), term: e.term, kind: e.kind, source: e.source, id: e.id });
        i += n;
        found = true;
        break;
      }
    }
    if (!found) i++;
  }
  return out;
}
