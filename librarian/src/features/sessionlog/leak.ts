// The leak check: compare a summary with every piece of GM-only text in the
// world, using 8-word shingles. Pure functions over the database; no models.
import type { DB } from '../../core/db.ts';
import { all, one } from '../../core/db.ts';
import type { Deps } from '../../app.ts';
import { chatJson, hasJob } from '../../core/ai.ts';
import { parseJson } from '../../core/util.ts';
import { partyBody } from '../minerva/partyText.ts';

export const SHINGLE = 8;
const GAP = '\u0000';

export interface Overlap {
  /** The overlapping passage, as written in the summary. */
  text: string;
  /** Where the GM-only text lives, e.g. "GM page: dm/Velmira" or "aside (transcript)". */
  source: string;
  /** Overlap with an aside line: asides never publish, not even with force. */
  aside: boolean;
  /** How it was found: a repeated phrase (default), distinctive terms only GM-only text has, or the audit model's judgement. */
  kind?: 'phrase' | 'terms' | 'model';
  /** For `terms`: the words that gave it away. */
  terms?: string[];
  /** For `model`: why the audit model flagged it. */
  why?: string;
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

/** The words of a GM copy that its player copy does not contain (others become gaps). */
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

/** GM-only text of a world: what a page's GM copy has and its player copy lacks, GM profile blocks and notes, GM and aside transcript lines. */
export function dmCorpus(db: DB, worldId: string): Corpus[] {
  const out: Corpus[] = [];
  const add = (source: string, aside: boolean, words: string[]) => { if (words.some((w) => w !== GAP)) out.push({ source, aside, words }); };
  for (const p of all<any>(db, 'SELECT id, updated_at, path, body, player_body, blocks, player_blocks, properties, player_properties, frontmatter, player_frontmatter FROM pages WHERE world_id = ?', worldId)) {
    // A vault page the whole party may read: only what its player copy lacks is GM-only.
    const shared = partyBody(db, worldId, p);
    if (shared !== null) { add(`GM page: ${p.path}`, false, dmOnlyWords(p.body ?? '', shared)); continue; }
    add(`GM page: ${p.path}`, false, dmOnlyWords(p.body ?? '', p.player_body));
    add(`GM blocks: ${p.path}`, false, dmOnlyWords(jsonText(p.blocks), p.player_blocks === null ? null : jsonText(p.player_blocks)));
    add(`GM facts: ${p.path}`, false, dmOnlyWords(jsonText(p.properties), p.player_properties === null ? null : jsonText(p.player_properties)));
    add(`GM frontmatter: ${p.path}`, false, dmOnlyWords(jsonText(p.frontmatter), p.player_frontmatter === null ? null : jsonText(p.player_frontmatter)));
  }
  for (const b of all<any>(db, "SELECT title, body FROM profile_blocks WHERE world_id = ? AND visibility = 'dm'", worldId)) add(`GM profile block: ${b.title}`, false, wordsOf(b.body));
  for (const i of all<any>(db, "SELECT name, dm_note FROM items WHERE world_id = ? AND dm_note != ''", worldId)) add(`GM item note: ${i.name}`, false, wordsOf(i.dm_note));
  for (const r of all<any>(db, "SELECT dm_note FROM broker_requests WHERE world_id = ? AND dm_note IS NOT NULL AND dm_note != ''", worldId)) add('GM broker note', false, wordsOf(r.dm_note));

  const mics = new Map(all<any>(db, 'SELECT id, aside FROM audio_mics WHERE world_id = ?', worldId).map((m) => [m.id as string, m.aside === 1]));
  const holds = all<any>(db, "SELECT h.session_id, h.start_ms, h.end_ms FROM audio_holds h JOIN audio_sessions s ON s.id = h.session_id WHERE s.world_id = ? AND h.kind = 'aside'", worldId);
  for (const l of all<any>(db, "SELECT session_id, start_ms, end_ms, text, sources FROM audio_lines WHERE world_id = ? AND audience = 'dm'", worldId)) {
    const aside = lineIsAside(l, mics, holds);
    add(aside ? 'aside (transcript)' : 'GM line (transcript)', aside, wordsOf(l.text));
  }
  return out;
}

/** Passages of `summary` (runs of 8+ words) that also appear in GM-only text. */
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

// ---- second check: distinctive terms ---------------------------------------------------------
//
// A paraphrase shares no run of eight words with its source ("payroll covers
// three captains" for "Velmira's payroll: three captains owe her"), but it
// keeps the rare words: names, and the few nouns only that page uses. A term
// is "rare" when GM-only text has it and nothing the players can read or said
// at the table does. A sentence is flagged when it has a rare proper noun, or
// two rare words from the same GM-only source. This is a flag for the GM to
// look at (publish anyway is allowed), never a silent pass or a hard block.

const COMMON = new Set(`about above across after again against almost along already also although always among another any anyone anything around away back because become been before behind being below beneath beside between beyond both bring brought but came can cannot come could did does done down during each either else enough even ever every everyone everything except explain far few find first for found from gave get give given goes going gone got great had has have having her here hers herself him himself his how however into its itself just keep kept know known large last later least leave left less let like likely little long look made make many may maybe might more most much must near need never new next night nobody none nothing now off often old once only onto other others otherwise our ours out over own part party people perhaps place put quite rather really said same saw say says see seem seemed seen several shall she should since some someone something sometimes soon still such take taken tell than that the their theirs them themselves then there these they thing things think this those though three through thus time together told too took toward towards turn turned two under until upon used using very want wanted was way well went were what when where whether which while who whom whose why will with within without would year years yet you your yours
secret secretly answers covers waits wait held holds hold keeps knows learn learned players player group told asked asks tells showed shows earlier meets met meet reaches reached arrive arrived arrives travel travelled traveled returns returned fight fought battle city town village road door room house hall morning evening day days week weeks month months world story session recap moment moments thread threads open question questions answer`.split(/\s+/));

const stemOf = (w: string): string => {
  const t = w.toLowerCase().replace(/['’]s$/, '');
  const x = t.replace(/(ies|ing|ed|es|s)$/, (m) => (m === 'ies' ? 'y' : ''));
  return x.length >= 4 ? x : t;
};

const sentencesOf = (text: string): string[] => text.replace(/^#+\s+/gm, '').split(/(?<=[.!?])\s+|\n+/).map((x) => x.replace(/^[-*>\s]+/, '').trim()).filter((x) => x.length > 3);

/** Stems of every word players can read or have said: their copies of pages, the player transcript, published logs, names. */
export function partyVocabulary(db: DB, worldId: string): Set<string> {
  const out = new Set<string>();
  const add = (text: string | null | undefined) => { for (const w of wordsOf(text ?? '')) out.add(stemOf(w)); };
  for (const p of all<any>(db, 'SELECT id, updated_at, path, title, aliases, player_body, player_blocks, player_properties, player_frontmatter, frontmatter FROM pages WHERE world_id = ?', worldId)) {
    const shared = partyBody(db, worldId, p);
    // A player's own notebook in the vault (journal, knowledge, goals) is what that player knows.
    const copy = shared ?? (String(p.path).startsWith('Minerva/players/') ? p.player_body ?? one<any>(db, 'SELECT body FROM pages WHERE id = ?', p.id)?.body : p.player_body);
    if (copy === null || copy === undefined) continue; // a GM-only page: not even its title is known
    add(copy); add(p.title); add(jsonText(p.player_blocks)); add(jsonText(p.player_properties)); add(jsonText(p.player_frontmatter)); add(String(p.aliases ?? ''));
  }
  for (const l of all<any>(db, "SELECT text FROM audio_lines WHERE world_id = ? AND audience = 'players'", worldId)) add(l.text);
  for (const e of all<any>(db, 'SELECT title, summary FROM sessionlog_entries WHERE world_id = ? AND unpublished_at IS NULL', worldId)) { add(e.title); add(e.summary); }
  for (const b of all<any>(db, "SELECT title, body FROM profile_blocks WHERE world_id = ? AND visibility = 'party'", worldId)) { add(b.title); add(b.body); }
  for (const i of all<any>(db, 'SELECT name, note FROM items WHERE world_id = ?', worldId)) { add(i.name); add(i.note); }
  for (const m of all<any>(db, 'SELECT m.character_name, a.display_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ?', worldId)) { add(m.character_name); add(m.display_name); }
  add(one<any>(db, 'SELECT name FROM worlds WHERE id = ?', worldId)?.name);
  return out;
}

/** Stems that GM-only text writes as names: capitalized somewhere and never in lower case (so "Sister" in a title is not a name when the notes say "the sister of"). */
function dmNames(db: DB, worldId: string): Set<string> {
  const upper = new Set<string>();
  const lower = new Set<string>();
  const scan = (text: string | null | undefined) => {
    for (const tok of String(text ?? '').replace(MARKS, ' ').split(/[^\p{L}\p{N}']+/u)) {
      if (tok.length < 3) continue;
      if (/^\p{Lu}/u.test(tok)) upper.add(stemOf(tok)); else lower.add(stemOf(tok));
    }
  };
  for (const p of all<any>(db, 'SELECT title, body, blocks, properties FROM pages WHERE world_id = ?', worldId)) { scan(p.title); scan(p.body); scan(jsonText(p.blocks)); scan(jsonText(p.properties)); }
  for (const b of all<any>(db, "SELECT title, body FROM profile_blocks WHERE world_id = ? AND visibility = 'dm'", worldId)) { scan(b.title); scan(b.body); }
  for (const i of all<any>(db, "SELECT name, dm_note FROM items WHERE world_id = ? AND dm_note != ''", worldId)) { scan(i.name); scan(i.dm_note); }
  for (const r of all<any>(db, "SELECT dm_note FROM broker_requests WHERE world_id = ? AND dm_note IS NOT NULL AND dm_note != ''", worldId)) scan(r.dm_note);
  for (const l of all<any>(db, "SELECT text FROM audio_lines WHERE world_id = ? AND audience = 'dm'", worldId)) scan(l.text);
  return new Set([...upper].filter((w) => !lower.has(w)));
}

/** Sentences of a summary that carry distinctive terms only GM-only text has. */
export function rareTermCheck(db: DB, worldId: string, summary: string, phrases: Overlap[] = []): Overlap[] {
  const vocab = partyVocabulary(db, worldId);
  const names = dmNames(db, worldId);
  // Which sources have which stems (all GM-only text: pages, notes, GM and aside lines).
  const sources = new Map<string, Set<string>>();
  for (const c of dmCorpus(db, worldId)) {
    if (c.source.startsWith('GM page: Minerva/players/')) continue; // what one player knows, not a GM secret
    const set = sources.get(c.source) ?? new Set<string>();
    for (const w of c.words) if (w !== GAP) set.add(stemOf(w));
    sources.set(c.source, set);
  }
  const out: Overlap[] = [];
  for (const sentence of sentencesOf(summary)) {
    if (phrases.some((p) => p.text && sentence.includes(p.text.slice(0, 40)))) continue; // already flagged as a repeated phrase
    const toks = sentence.replace(MARKS, ' ').split(/\s+/).map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
    const proper = new Map<string, string>();
    const keywords = new Map<string, string>();
    toks.forEach((tok, i) => {
      const st = stemOf(tok);
      if (st.length < 3 || vocab.has(st) || COMMON.has(tok.toLowerCase()) || COMMON.has(st)) return;
      const capital = /^\p{Lu}/u.test(tok) && !/^\p{Lu}+$/u.test(tok);
      if (capital && i > 0 && names.has(st)) proper.set(st, tok);
      else if (capital && i === 0 && names.has(st) && tok.length >= 4) proper.set(st, tok);
      else if (tok.length >= 5) keywords.set(st, tok);
    });
    if (!proper.size && keywords.size < 2) continue;
    // Which GM-only source has the most of these terms?
    let best: { src: string; hit: string[] } | null = null;
    for (const [src, set] of sources) {
      const hitP = [...proper.keys()].filter((t) => set.has(t));
      const hitK = [...keywords.keys()].filter((t) => set.has(t));
      if (hitP.length < 1 && hitK.length < 2) continue;
      const hit = [...hitP, ...hitK];
      if (!best || hit.length > best.hit.length) best = { src, hit };
    }
    if (!best) continue;
    out.push({ text: sentence.slice(0, 300), source: best.src, aside: false, kind: 'terms', terms: best.hit.map((t) => proper.get(t) ?? keywords.get(t) ?? t) });
  }
  return out;
}

// ---- third check: the audit model -------------------------------------------------------------

/** GM-only passages (never classified: only the AI copy of a page, which has none) closest to the summary, for the audit model. */
function candidatePassages(db: DB, worldId: string, summary: string, vocab: Set<string>): { source: string; text: string }[] {
  const mine = new Set(wordsOf(summary).map(stemOf).filter((w) => w.length >= 4 && !COMMON.has(w)));
  const scored: { source: string; text: string; score: number }[] = [];
  const consider = (source: string, text: string) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) return;
    const words = new Set(wordsOf(t).map(stemOf));
    let score = 0;
    for (const w of mine) if (words.has(w)) score += vocab.has(w) ? 0.25 : 1;
    if (score >= 1) scored.push({ source, text: t.slice(0, 700), score });
  };
  for (const p of all<any>(db, `SELECT path, ai_body, player_body FROM pages WHERE world_id = ? AND visibility <> 'classified' AND ai_body IS NOT NULL`, worldId)) {
    // A page the players can read in part: only its lines the player copy lacks.
    const theirs = new Set(sentencesOf(p.player_body ?? '').map((x) => x.toLowerCase()));
    const text = sentencesOf(p.ai_body ?? '').filter((x) => !theirs.has(x.toLowerCase())).join(' ');
    consider(`GM page: ${p.path}`, text);
  }
  for (const i of all<any>(db, "SELECT name, dm_note FROM items WHERE world_id = ? AND dm_note != ''", worldId)) consider(`GM item note: ${i.name}`, i.dm_note);
  for (const r of all<any>(db, "SELECT dm_note FROM broker_requests WHERE world_id = ? AND dm_note IS NOT NULL AND dm_note != ''", worldId)) consider('GM broker note', r.dm_note);
  return scored.sort((a, b) => b.score - a.score).slice(0, 6);
}

const AUDIT_SYSTEM = 'You check a session summary that will be shown to the players against notes only the GM has. Say which sentences of the summary reveal, hint at or paraphrase something in the GM notes that the players have not learned yet. Ignore anything that is only about what happened at the table. Answer with JSON: {"leaks":[{"sentence":"the sentence from the summary","why":"short reason, naming the note"}]}. If nothing leaks, answer {"leaks":[]}.';

/** The audit model's judgement of a summary. `ran` is false when no model answered. */
export async function modelAudit(d: Deps, worldId: string, summary: string): Promise<{ ran: boolean; overlaps: Overlap[] }> {
  if (!hasJob(d, 'audit') || !summary.trim()) return { ran: false, overlaps: [] };
  const passages = candidatePassages(d.db, worldId, summary, partyVocabulary(d.db, worldId));
  if (!passages.length) return { ran: true, overlaps: [] };
  const notes = passages.map((p, i) => `[${i + 1}] ${p.source}\n${p.text}`).join('\n\n');
  // The guard refuses anything classified before it leaves; a refusal comes back as null, like a model that is down.
  const j = await chatJson<any>(d, 'audit', [{ role: 'system', content: AUDIT_SYSTEM }, { role: 'user', content: `Summary:\n${summary.slice(0, 6000)}\n\nDM notes:\n${notes}` }], undefined, { maxTokens: 700 });
  if (!j || !Array.isArray(j.leaks)) return { ran: false, overlaps: [] };
  const overlaps: Overlap[] = [];
  for (const l of j.leaks.slice(0, 8)) {
    const sentence = String(l?.sentence ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!sentence) continue;
    const why = String(l?.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const n = /\[(\d+)\]/.exec(why)?.[1];
    overlaps.push({ text: sentence, source: n && passages[Number(n) - 1] ? passages[Number(n) - 1]!.source : 'Audit model', aside: false, kind: 'model', why });
  }
  return { ran: true, overlaps };
}

/** Every check, in order: repeated phrases, distinctive terms, then the audit model when one is set. */
export async function fullLeakCheck(d: Deps, worldId: string, summary: string): Promise<{ overlaps: Overlap[]; audited: boolean }> {
  const phrases = leakCheck(d.db, worldId, summary).map((o) => ({ ...o, kind: 'phrase' as const }));
  const terms = rareTermCheck(d.db, worldId, summary, phrases);
  const seen = [...phrases, ...terms];
  const m = await modelAudit(d, worldId, summary);
  const fresh = m.overlaps.filter((o) => !seen.some((x) => x.text.slice(0, 40) === o.text.slice(0, 40)));
  return { overlaps: [...phrases, ...terms, ...fresh], audited: m.ran };
}
