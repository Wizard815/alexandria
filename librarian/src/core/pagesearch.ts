// Library page search: the FTS5 indexes (DM copy and party copy), the title
// and alias list used for exact matches and typo tolerance, query parsing
// (words, "phrases", -exclusions), ranking and snippets.
//
// Leak rules (see policy.ts and levels.ts): every index is built ONLY from
// the matching copy of a page.
//   party   player copies   (pages.player_body)   what players may search
//   broker  broker copies   (pages.broker_body)   what the broker may use
//   ai      AI copies       (pages.ai_body)       everything but classified: every model-facing search
//   dm      DM copies       (pages.body)          only the DM's own screen
// A search reads the table and page_names scope of its own copy, and
// snippets are cut from that copy's column, never from pages.body.
//
// This file does not import db.ts (db.ts calls ensureSearchIndex while
// opening), it only uses the database handle it is given.
import type { DatabaseSync } from 'node:sqlite';

type DB = DatabaseSync;

/** Bump when the index layout or what goes in it changes: the index is rebuilt on start. */
export const SEARCH_INDEX_VERSION = 4;

const FTS_COLS = 'page_id UNINDEXED, world_id UNINDEXED, title, aliases, headings, body';
const FTS_OPTS = `tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'`;
/** bm25 weights per column: page_id, world_id, title, aliases, headings, body. */
const WEIGHTS = '0, 0, 12, 10, 3, 1';

export type Scope = 'dm' | 'party' | 'broker' | 'ai';
const TABLES: Record<Scope, string> = { dm: 'fts_dm', party: 'fts_party', broker: 'fts_broker', ai: 'fts_ai' };
const ftsTable = (scope: Scope) => TABLES[scope] ?? 'fts_party';
/** The pages columns that hold a scope's copy: body and sidebar properties. */
const COPY_COLS: Record<Scope, { body: string; props: string }> = {
  dm: { body: 'body', props: 'properties' },
  party: { body: 'player_body', props: 'player_properties' },
  broker: { body: 'broker_body', props: 'broker_properties' },
  ai: { body: 'ai_body', props: 'ai_properties' },
};
/** A SQL guard that keeps only pages that have this scope's copy (and a level the copy's audience may read). */
export const scopeGuard = (scope: Scope, alias = 'p'): string => {
  const a = alias ? `${alias}.` : '';
  switch (scope) {
    case 'party': return `AND ${a}visibility = 'party' AND ${a}player_body IS NOT NULL`;
    case 'broker': return `AND ${a}visibility IN ('party', 'broker') AND ${a}broker_body IS NOT NULL`;
    case 'ai': return `AND ${a}visibility IN ('party', 'broker', 'dm') AND ${a}ai_body IS NOT NULL`;
    default: return '';
  }
};

// ---- text helpers ----------------------------------------------------------

/** Lower case and strip accents, one output character per input character so offsets still line up. */
export function foldKeep(s: string): string {
  let out = '';
  for (const ch of s) {
    const f = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    out += f.length === ch.length ? f : ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch;
  }
  return out;
}

const WORD = /[\p{L}\p{N}_]+/gu;
export const wordsOf = (s: string): string[] => foldKeep(s).match(WORD) ?? [];
/** Normal form of a name: folded words joined by one space. */
export const normName = (s: string): string => wordsOf(s).join(' ');

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---- query parsing -----------------------------------------------------------

export interface QTerm { words: string[]; phrase: boolean; prefix: boolean }
export interface ParsedQuery { pos: QTerm[]; not: QTerm[]; norm: string }

/**
 * Words, "quoted phrases" and -exclusions. The last plain word gets prefix
 * matching while you type (not when the query ends in a space or a quote).
 */
export function parseQuery(q: string): ParsedQuery {
  const pos: QTerm[] = [];
  const not: QTerm[] = [];
  const re = /(-?)"([^"]*)"?|(-?)([^\s"]+)/gu;
  let m: RegExpExecArray | null;
  let last: QTerm | null = null; // the final token typed, when it is a plain positive word
  const trailingSpace = /[\s"]$/.test(q);
  let n = 0;
  while ((m = re.exec(q)) && n++ < 40) {
    const neg = (m[1] || m[3]) === '-';
    const quoted = m[2] !== undefined;
    const words = wordsOf(quoted ? m[2] : m[4]).slice(0, 12);
    if (!words.length) continue;
    const t: QTerm = { words, phrase: quoted || words.length > 1, prefix: false };
    last = null;
    if (neg) not.push(t);
    else {
      pos.push(t);
      if (!quoted) last = t;
    }
  }
  // Prefix only for the very last term typed, and only if it was a plain word.
  if (last && !trailingSpace) (last as QTerm).prefix = true;
  return { pos, not, norm: pos.flatMap((t) => t.words).join(' ') };
}

const fts = (t: QTerm) => `"${t.words.join(' ')}"${t.prefix ? '*' : ''}`;

/** FTS5 MATCH text. mode 'or' is the fallback when AND finds nothing. */
export function ftsExpr(p: ParsedQuery, mode: 'and' | 'or'): string | null {
  if (!p.pos.length) return null;
  const terms = p.pos.slice(0, 12).map(fts);
  let e = mode === 'and' ? terms.join(' ') : terms.join(' OR ');
  if (terms.length > 1 || p.not.length) e = `(${e})`;
  if (p.not.length) e += ` NOT (${p.not.slice(0, 12).map((t) => fts({ ...t, prefix: false })).join(' OR ')})`;
  return e;
}

// ---- snippets ----------------------------------------------------------------

/** Plain reading text of Markdown: no link brackets, emphasis marks or heading hashes. */
export function plainText(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]|#]*)(?:#[^\]]*)?\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const BOUND = '(?<![\\p{L}\\p{N}_])';
const ENDB = '(?![\\p{L}\\p{N}_])';
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One regex per distinct word: whole word, or a prefix for the word being typed. */
function wordRegexes(p: ParsedQuery): { w: string; re: RegExp }[] {
  const seen = new Map<string, boolean>();
  for (const t of p.pos) t.words.forEach((w, i) => { const pre = t.prefix && i === t.words.length - 1; seen.set(w, (seen.get(w) ?? false) || pre); });
  return [...seen].map(([w, pre]) => ({ w, re: new RegExp(`${BOUND}${reEsc(w)}${pre ? '' : ENDB}`, 'gu') }));
}

/** Marks of the query words in text: [start, end) pairs, merged, sorted. */
function markRanges(folded: string, rx: { re: RegExp }[], limit = 400): [number, number][] {
  const out: [number, number][] = [];
  for (const { re } of rx) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(folded)) && n++ < limit) { out.push([m.index, m.index + m[0].length]); if (!m[0].length) re.lastIndex++; }
  }
  out.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** Escaped HTML of text with `<mark>` around query words. Safe to put in innerHTML. */
export function markHtml(text: string, p: ParsedQuery): string {
  const f = foldKeep(text);
  let out = '';
  let at = 0;
  for (const [a, b] of markRanges(f, wordRegexes(p))) {
    out += escapeHtml(text.slice(at, a)) + '<mark>' + escapeHtml(text.slice(a, b)) + '</mark>';
    at = b;
  }
  return out + escapeHtml(text.slice(at));
}

export interface Snippet { html: string; text: string; matched: boolean }

/**
 * A short passage around the best match: the window holding the most
 * different query words (a whole phrase counts extra), with `<mark>` around
 * the words and everything else HTML-escaped.
 */
export function makeSnippet(source: string, p: ParsedQuery, width = 180): Snippet {
  const text = plainText(source.length > 300_000 ? source.slice(0, 300_000) : source);
  const folded = foldKeep(text);
  const rx = wordRegexes(p);
  const hits: { at: number; w: string }[] = [];
  for (const { w, re } of rx) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(folded)) && n++ < 200) hits.push({ at: m.index, w });
  }
  hits.sort((a, b) => a.at - b.at);
  let start = 0;
  let matched = false;
  if (hits.length) {
    matched = true;
    let best = -1;
    const phrases = p.pos.filter((t) => t.phrase && t.words.length > 1).map((t) => t.words.join(' '));
    for (let i = 0; i < hits.length && i < 200; i++) {
      const lim = hits[i].at + width - 40;
      const seen = new Set<string>();
      for (let j = i; j < hits.length && hits[j].at <= lim; j++) seen.add(hits[j].w);
      let s = seen.size * 10;
      for (const ph of phrases) if (folded.slice(hits[i].at, hits[i].at + width).replace(/[^\p{L}\p{N}_]+/gu, ' ').includes(ph)) s += 25;
      if (s > best) { best = s; start = hits[i].at; }
    }
    start = Math.max(0, start - 40);
  }
  let end = Math.min(text.length, start + width);
  if (start > 0) { const sp = text.indexOf(' ', start); if (sp >= 0 && sp < start + 20) start = sp + 1; }
  if (end < text.length) { const sp = text.lastIndexOf(' ', end); if (sp > start + width / 2) end = sp; }
  const slice = text.slice(start, end);
  const pre = start > 0 ? '…' : '';
  const post = end < text.length ? '…' : '';
  return { html: pre + markHtml(slice, p) + post, text: pre + slice + post, matched };
}

/**
 * For a typo hit: a query whose words are the words actually present in the
 * text that are within a few typos of the typed ones, so they can be marked.
 */
export function fuzzyExpand(text: string, p: ParsedQuery): ParsedQuery {
  const toks = new Set(wordsOf(text.length > 300_000 ? text.slice(0, 300_000) : text));
  const pos: QTerm[] = [];
  for (const t of p.pos) {
    for (const w of t.words) {
      const k = /\d/.test(w) ? 0 : allowedEdits(w.length);
      for (const tok of toks) {
        if (Math.abs(tok.length - w.length) > k + (t.prefix ? 8 : 0)) continue;
        if (editDistance(w, tok, k) <= k || (t.prefix && tok.length > w.length && editDistance(w, tok.slice(0, w.length), k) <= k)) pos.push({ words: [tok], phrase: false, prefix: false });
      }
    }
  }
  return { pos: pos.length ? pos : p.pos, not: [], norm: p.norm };
}

// ---- edit distance -----------------------------------------------------------

/** Optimal string alignment distance, giving up (returns max + 1) past max. */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

/** How many typos a word of this length may have. */
export const allowedEdits = (len: number) => (len <= 3 ? 0 : len <= 5 ? 1 : 2);

// ---- index -------------------------------------------------------------------

const KEY_DM_ALIAS = /^(secret|secrets|dm|dm_.*|gm|gm_.*|private)$/i;

/** Aliases written under DM-only keys (secret: { aliases }, dm_aliases ...). Only the DM index gets these. */
export function dmOnlyAliases(fm: any): string[] {
  const out: string[] = [];
  const take = (v: any) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(x); };
  if (!fm || typeof fm !== 'object') return out;
  for (const [k, v] of Object.entries(fm)) {
    if (!KEY_DM_ALIAS.test(k)) continue;
    if (/alias/i.test(k)) take(v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v as any)) if (/^aliases?$/i.test(k2)) take(v2);
  }
  return out;
}

/**
 * Aliases a player may search by. Markdown pages: the aliases left in the
 * player frontmatter (secret/dm keys are already gone). Imported pages: the
 * source's aliases, minus any that name a DM-only page.
 */
export function playerAliases(origin: string, playerFm: any, pageAliases: string[], hiddenTitles: Set<string>): string[] {
  const src = origin === 'markdown' ? (Array.isArray(playerFm?.aliases) ? playerFm.aliases : typeof playerFm?.aliases === 'string' ? [playerFm.aliases] : []) : pageAliases;
  return src.map(String).filter((a: string) => a.trim() && !hiddenTitles.has(a.trim().toLowerCase()) && !/\(hidden\)/i.test(a));
}

const headingsOf = (md: string) => [...md.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) => plainText(m[1])).join('\n');

/** Sidebar facts ("Climate: mild") as text, so they can be searched. Pass the groups the viewer may see. */
export function factsText(groups: any): string {
  if (typeof groups === 'string') { try { groups = JSON.parse(groups); } catch { return ''; } }
  if (!Array.isArray(groups)) return '';
  const inl = (c: any) => (Array.isArray(c) ? c.map((x: any) => x?.text ?? x?.mention?.text ?? x?.mention?.name ?? '').join('') : '');
  return groups.map((g: any) => (Array.isArray(g?.rows) ? g.rows.map((r: any) => `${r?.key ?? ''}: ${inl(r?.value)}`).join('\n') : '')).filter(Boolean).join('\n');
}

const withFacts = (body: string, facts: string) => (facts ? `${body}\n\n${facts}` : body);

// The title/alias list used for typo tolerance is cached per database and
// dropped whenever any index row changes.
const gens = new WeakMap<DB, number>();
const nameCache = new WeakMap<DB, { gen: number; rows: Map<string, { id: string; toks: string[] }[]> }>();
const bump = (db: DB) => gens.set(db, (gens.get(db) ?? 0) + 1);

/** The page's index rows for one scope, replacing what was there. `facts` is factsText() of the same copy. */
export function indexPage(db: DB, scope: Scope, pid: string, worldId: string, title: string, aliases: string[], body: string, facts = '') {
  unindexPage(db, scope, pid);
  db.prepare(`INSERT INTO ${ftsTable(scope)} (page_id, world_id, title, aliases, headings, body) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(pid, worldId, title, aliases.join('\n'), headingsOf(body), withFacts(body, facts));
  bump(db);
  const ins = db.prepare('INSERT INTO page_names (page_id, world_id, scope, kind, name, norm) VALUES (?, ?, ?, ?, ?, ?)');
  const t = normName(title);
  if (t) ins.run(pid, worldId, scope, 'title', title, t);
  for (const a of aliases) { const n = normName(a); if (n) ins.run(pid, worldId, scope, 'alias', a, n); }
}

export function unindexPage(db: DB, scope: Scope, pid: string) {
  bump(db);
  db.prepare(`DELETE FROM ${ftsTable(scope)} WHERE page_id = ?`).run(pid);
  db.prepare('DELETE FROM page_names WHERE page_id = ? AND scope = ?').run(pid, scope);
}

export function unindexWorld(db: DB, scope: Scope, worldId: string) {
  bump(db);
  db.prepare(`DELETE FROM ${ftsTable(scope)} WHERE world_id = ?`).run(worldId);
  db.prepare('DELETE FROM page_names WHERE world_id = ? AND scope = ?').run(worldId, scope);
}

function createTables(db: DB) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_dm USING fts5(${FTS_COLS}, ${FTS_OPTS});
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_party USING fts5(${FTS_COLS}, ${FTS_OPTS});
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_broker USING fts5(${FTS_COLS}, ${FTS_OPTS});
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_ai USING fts5(${FTS_COLS}, ${FTS_OPTS});
    CREATE TABLE IF NOT EXISTS page_names (page_id TEXT NOT NULL, world_id TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, norm TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS page_names_lookup ON page_names (world_id, scope, norm);
    CREATE INDEX IF NOT EXISTS page_names_page ON page_names (page_id);
    CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
}

/** Rebuild every index from the pages table (DM copy and the stored player, broker and AI copies). */
export function rebuildAll(db: DB) {
  bump(db);
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM fts_dm; DELETE FROM fts_party; DELETE FROM fts_broker; DELETE FROM fts_ai; DELETE FROM page_names;');
    // Titles to hide from each copy's aliases: pages above the copy's level.
    const hidden: Record<'party' | 'broker' | 'ai', Map<string, Set<string>>> = { party: new Map(), broker: new Map(), ai: new Map() };
    const cond: Record<'party' | 'broker' | 'ai', string> = { party: `visibility <> 'party'`, broker: `visibility NOT IN ('party', 'broker')`, ai: `visibility NOT IN ('party', 'broker', 'dm')` };
    for (const k of ['party', 'broker', 'ai'] as const) {
      for (const r of db.prepare(`SELECT world_id, lower(title) AS t FROM pages WHERE ${cond[k]}`).all() as any[]) {
        if (!hidden[k].has(r.world_id)) hidden[k].set(r.world_id, new Set());
        hidden[k].get(r.world_id)!.add(r.t);
      }
    }
    const parse = (s: string | null) => { try { return JSON.parse(s || 'null'); } catch { return null; } };
    for (const pg of db.prepare('SELECT * FROM pages').iterate() as Iterable<any>) {
      const al: string[] = (parse(pg.aliases) ?? []).map(String);
      const dmAl = [...al, ...(pg.origin === 'markdown' ? dmOnlyAliases(parse(pg.frontmatter)) : [])];
      indexPage(db, 'dm', pg.id, pg.world_id, pg.title, dmAl, pg.body, factsText(pg.properties));
      for (const [scope, pre] of [['party', 'player_'], ['broker', 'broker_'], ['ai', 'ai_']] as const) {
        if (pg[`${pre}body`] === null || pg[`${pre}body`] === undefined) continue;
        indexPage(db, scope, pg.id, pg.world_id, pg.title, playerAliases(pg.origin, parse(pg[`${pre}frontmatter`]), al, hidden[scope].get(pg.world_id) ?? new Set()), pg[`${pre}body`], factsText(pg[`${pre}properties`]));
      }
    }
    db.prepare(`INSERT INTO search_meta (key, value) VALUES ('index_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(String(SEARCH_INDEX_VERSION));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Called when the database opens. Creates the search tables; when they are
 * missing, from an older layout or an older SEARCH_INDEX_VERSION, drops them
 * and rebuilds the index from the pages table.
 */
export function ensureSearchIndex(db: DB) {
  const sqlOf = (n: string) => ((db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(n) as any)?.sql as string | undefined) ?? '';
  const metaOk = sqlOf('search_meta') && (db.prepare(`SELECT value FROM search_meta WHERE key = 'index_version'`).get() as any)?.value === String(SEARCH_INDEX_VERSION);
  const layoutOk = ['fts_dm', 'fts_party', 'fts_broker', 'fts_ai'].every((t) => sqlOf(t).includes('headings'));
  if (metaOk && layoutOk) { createTables(db); return; }
  db.exec('DROP TABLE IF EXISTS fts_dm; DROP TABLE IF EXISTS fts_party; DROP TABLE IF EXISTS fts_broker; DROP TABLE IF EXISTS fts_ai; DROP TABLE IF EXISTS page_names;');
  createTables(db);
  rebuildAll(db);
}

// ---- search ------------------------------------------------------------------

export interface PageHit {
  id: string; path: string; title: string;
  /** Plain text around the best match (what other features and agents read). */
  snippet: string;
  /** The same passage as escaped HTML with <mark> around matches. Safe for innerHTML. */
  snippetHtml: string;
  score: number; titleHtml: string; matchedOn: 'title' | 'alias' | 'text' | 'fuzzy' | 'semantic';
  /** 3 exact title, 2 exact alias, 1 title starts with the query, 0 otherwise. */
  tier: number;
  /** The text score before the tier is added. */
  relevance: number;
}

interface Cand { id: string; path: string; title: string; updated_at: string; rel: number; tier: number; fuzzy?: number; on: PageHit['matchedOn'] }

const recency = (iso: string, nowMs: number) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.exp(-Math.max(0, nowMs - t) / (180 * 86_400_000));
};

/**
 * Search the pages one viewer may see. `scope` is 'dm' only for a DM; every
 * other viewer reads the party index and the player copy.
 */
export function searchPages(db: DB, worldId: string, q: string, scope: Scope, limit = 20, nowMs = Date.now()): PageHit[] {
  const p = parseQuery(q);
  if (!p.pos.length) return [];
  limit = Math.max(1, Math.min(limit, 200));
  const table = ftsTable(scope);
  const guard = scopeGuard(scope);
  const run = (expr: string, n: number) => db.prepare(`SELECT ${table}.page_id AS id, p.path, ${table}.title AS title, p.updated_at, bm25(${table}, ${WEIGHTS}) AS rank
    FROM ${table} JOIN pages p ON p.id = ${table}.page_id
    WHERE ${table} MATCH ? AND ${table}.world_id = ? ${guard} ORDER BY rank LIMIT ?`).all(expr, worldId, n) as any[];
  const pool = Math.max(limit * 3, 60);
  let rows: any[] = [];
  const and = ftsExpr(p, 'and');
  try {
    rows = and ? run(and, pool) : [];
    if (!rows.length && p.pos.length > 1) rows = run(ftsExpr(p, 'or')!, pool);
  } catch { rows = []; }

  // Exact and prefix matches on titles and aliases rank first.
  const names = new Map<string, number>(); // page -> tier
  const lookup = (sql: string, ...a: any[]) => { for (const r of db.prepare(sql).all(...a) as any[]) names.set(r.page_id, Math.max(names.get(r.page_id) ?? 0, r.kind === 'title' ? 3 : 2)); };
  if (!p.not.length && p.norm) lookup('SELECT page_id, kind FROM page_names WHERE world_id = ? AND scope = ? AND norm = ?', worldId, scope, p.norm);
  const startsWith = new Set<string>();
  if (p.norm && p.pos.length === 1) {
    for (const r of db.prepare(`SELECT page_id FROM page_names WHERE world_id = ? AND scope = ? AND norm >= ? AND norm < ? LIMIT 200`).all(worldId, scope, p.norm, p.norm + '￿') as any[]) startsWith.add(r.page_id);
  }

  const cands = new Map<string, Cand>();
  for (const r of rows) {
    const tier = names.get(r.id) ?? (startsWith.has(r.id) ? 1 : 0);
    cands.set(r.id, { id: r.id, path: r.path, title: r.title, updated_at: r.updated_at, rel: -r.rank, tier, on: tier >= 3 ? 'title' : tier === 2 ? 'alias' : 'text' });
  }
  // An exact name match is always listed, even when the AND query lost it.
  const missing = [...names.keys()].filter((id) => !cands.has(id));
  if (missing.length) {
    for (const r of db.prepare(`SELECT p.id, p.path, p.title, p.updated_at FROM pages p WHERE p.world_id = ? AND p.id IN (${missing.map(() => '?').join(',')}) ${guard}`).all(worldId, ...missing) as any[]) {
      const tier = names.get(r.id)!;
      cands.set(r.id, { id: r.id, path: r.path, title: r.title, updated_at: r.updated_at, rel: 0, tier, on: tier >= 3 ? 'title' : 'alias' });
    }
  }

  const ranked = [...cands.values()].map((c) => ({ c, s: c.tier * 1000 + c.rel * (1 + 0.1 * recency(c.updated_at, nowMs)) }));
  ranked.sort((a, b) => b.s - a.s || a.c.title.localeCompare(b.c.title));
  const out: { c: Cand; s: number }[] = ranked.slice(0, limit);

  // Typo tolerance when the index found little.
  if (out.length < Math.min(limit, 5) && !p.not.length) {
    const have = new Set(out.map((x) => x.c.id));
    const floor = out.length ? Math.max(out[out.length - 1].s, 0.0001) : 1;
    for (const f of fuzzyNames(db, worldId, scope, p, guard)) {
      if (have.has(f.c.id)) continue;
      out.push({ c: f.c, s: (floor * 0.5) / (1 + f.dist) });
      have.add(f.c.id);
      if (out.length >= limit) break;
    }
  }

  // Snippets come from the same copy the index was built from.
  const cols = `${COPY_COLS[scope].body} AS body, ${COPY_COLS[scope].props} AS properties`;
  const body = db.prepare(`SELECT ${cols} FROM pages WHERE id = ?`);
  return out.map(({ c, s }) => {
    const row: any = body.get(c.id);
    const text = withFacts(String(row?.body ?? ''), factsText(row?.properties));
    const fz = c.fuzzy !== undefined;
    const sn = makeSnippet(text, fz ? fuzzyExpand(text, p) : p);
    return {
      id: c.id, path: c.path, title: c.title, snippet: sn.text, snippetHtml: sn.html, titleHtml: markHtml(c.title, fz ? fuzzyExpand(c.title, p) : p),
      score: Math.round(s * 1e4) / 1e4, matchedOn: c.fuzzy !== undefined ? 'fuzzy' : c.on, tier: c.tier, relevance: c.fuzzy !== undefined ? 0 : c.rel,
    };
  });
}

/** Titles and aliases that are close to the query words (typos, missing letters). */
function fuzzyNames(db: DB, worldId: string, scope: Scope, p: ParsedQuery, guard: string): { c: Cand; dist: number }[] {
  const plain = p.pos.filter((t) => !t.phrase || t.words.length === 1).flatMap((t) => t.words.map((w) => ({ w, prefix: t.prefix })));
  const all = p.pos.flatMap((t) => t.words);
  if (!plain.length || plain.length !== all.length) return [];
  const gen = gens.get(db) ?? 0;
  let cache = nameCache.get(db);
  if (!cache || cache.gen !== gen) { cache = { gen, rows: new Map() }; nameCache.set(db, cache); }
  const key = `${worldId}|${scope}`;
  let rows = cache.rows.get(key);
  if (!rows) {
    rows = (db.prepare('SELECT page_id, norm FROM page_names WHERE world_id = ? AND scope = ?').all(worldId, scope) as any[]).map((r) => ({ id: r.page_id as string, toks: String(r.norm).split(' ') }));
    cache.rows.set(key, rows);
  }
  const found = new Map<string, number>();
  for (const r of rows) {
    let total = 0;
    let ok = true;
    for (const { w, prefix } of plain) {
      const k = /\d/.test(w) ? 0 : allowedEdits(w.length); // ids and numbers are not typos
      let d = k + 1;
      for (const t of r.toks) {
        if (Math.abs(t.length - w.length) > k && !(prefix && t.length > w.length)) continue;
        d = Math.min(d, editDistance(w, t, k));
        if (prefix && t.length > w.length) d = Math.min(d, editDistance(w, t.slice(0, w.length), k));
        if (d === 0) break;
      }
      if (d > k) { ok = false; break; }
      total += d;
    }
    if (!ok || total === 0) continue;
    const prev = found.get(r.id);
    if (prev === undefined || total < prev) found.set(r.id, total);
  }
  // Only the pages that matched are read from the pages table.
  const best = new Map<string, { c: Cand; dist: number }>();
  const top = [...found].sort((a, b) => a[1] - b[1]).slice(0, 100);
  if (top.length) {
    const info = db.prepare(`SELECT p.id, p.path, p.title, p.updated_at FROM pages p WHERE p.world_id = ? AND p.id IN (${top.map(() => '?').join(',')}) ${guard}`).all(worldId, ...top.map((t) => t[0])) as any[];
    for (const r of info) best.set(r.id, { c: { id: r.id, path: r.path, title: r.title, updated_at: r.updated_at, rel: 0, tier: 0, fuzzy: found.get(r.id)!, on: 'fuzzy' }, dist: found.get(r.id)! });
  }
  return [...best.values()].sort((a, b) => a.dist - b.dist || b.c.updated_at.localeCompare(a.c.updated_at));
}
