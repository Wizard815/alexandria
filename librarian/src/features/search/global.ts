// Search across the whole world for one viewer: library pages, people, game
// module terms, transcript lines, session log entries and items. One ranked
// list. Every kind applies the same visibility rules the rest of the app
// uses (players: player copies, shared rows, published entries, players'
// transcript lines, their own and the party's items).
//
// Other features' tables are read defensively: a missing table or a failed
// query only drops that kind.
import type { Deps } from '../../app.ts';
import { all } from '../../core/db.ts';
import { canSee, type Viewer } from '../../core/policy.ts';
import { type ParsedQuery, makeSnippet, markHtml, parseQuery, wordsOf, escapeHtml } from '../../core/pagesearch.ts';
import { names } from '../../routes/_shared.ts';
import { searchRules, searchTerms } from '../modules/search.ts';
import { hybridPages } from './embeddings.ts';
import { scoreFields } from './match.ts';

export const KINDS = ['page', 'person', 'term', 'transcript', 'log', 'item'] as const;
export type Kind = (typeof KINDS)[number];

export interface GlobalHit {
  kind: Kind;
  id: string;
  title: string;
  /** Plain text around the match. */
  snippet: string;
  /** The same passage as escaped HTML with <mark> around matches. Safe for innerHTML. */
  snippetHtml: string;
  /** Path under /w/:world/ (the DM's pages are under dm/). */
  link: string;
  /** Larger is better; comparable across kinds. */
  score: number;
  /** The title with <mark>, escaped. */
  titleHtml?: string;
  /** Small extra facts for the UI (page path, term kind, speaker...). */
  meta?: Record<string, unknown>;
}

const WEIGHT: Record<Kind, number> = { page: 1, person: 0.95, item: 0.85, term: 0.8, log: 0.75, transcript: 0.6 };

export function parseKinds(v: unknown): Kind[] {
  if (v === undefined || v === null || v === '') return [...KINDS];
  const out = new Set<Kind>();
  for (const raw of String(v).split(',')) {
    const k = raw.trim().toLowerCase();
    if (!k) continue;
    const base = k.replace(/s$/, '').replace(/^people$/, 'person').replace(/^line$/, 'transcript');
    const hit = KINDS.find((x) => x === k || x === base || (k === 'people' && x === 'person') || (k === 'lines' && x === 'transcript') || (k === 'transcripts' && x === 'transcript') || (k === 'terms' && x === 'term') || (k === 'rules' && x === 'term') || (k === 'session' && x === 'log') || (k === 'sessionlog' && x === 'log'));
    if (!hit) return [];
    out.add(hit);
  }
  return [...out];
}

const safe = <T>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };

/** Normalize raw relevances of one kind to 0..1 and apply the kind's weight. */
function finish(kind: Kind, rows: { hit: Omit<GlobalHit, 'score' | 'kind'>; rel: number; exact?: boolean; fuzzy?: boolean }[]): GlobalHit[] {
  const max = Math.max(...rows.map((r) => r.rel), 1e-9);
  return rows.map((r) => ({
    ...r.hit,
    kind,
    score: Math.round(WEIGHT[kind] * ((r.exact ? 1 : 0.4 + 0.6 * (r.rel / max)) * (r.fuzzy ? 0.5 : 1)) * 1e4) / 1e4,
  }));
}

const clipText = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---- kinds -------------------------------------------------------------------

async function pages(d: Deps, worldId: string, v: Viewer, q: string, limit: number, semantic: boolean): Promise<GlobalHit[]> {
  const scope = v.role === 'dm' ? 'dm' : 'party';
  const hits = semantic ? await hybridPages(d, worldId, q, scope, limit) : (d.library.search(worldId, q, v, limit) as any[]);
  const base = v.role === 'dm' ? 'dm/library' : 'library';
  return finish('page', hits.map((h: any) => ({
    hit: { id: h.id, title: h.title, snippet: h.snippet, snippetHtml: h.snippetHtml, titleHtml: h.titleHtml, link: `${base}?page=${encodeURIComponent(h.id)}`, meta: { path: h.path, matchedOn: h.matchedOn } },
    rel: h.relevance || 0.001, exact: h.tier >= 2 || (h.tier === 1 && false), fuzzy: h.matchedOn === 'fuzzy',
  })));
}

function people(d: Deps, worldId: string, v: Viewer, p: ParsedQuery): GlobalHit[] {
  const rows = all<any>(d.db, 'SELECT * FROM people WHERE world_id = ? ORDER BY name', worldId).filter((r) => canSee(v, r.visibility, null));
  const out: { hit: Omit<GlobalHit, 'score' | 'kind'>; rel: number; exact?: boolean }[] = [];
  const quotes = all<any>(d.db, 'SELECT person_id, text, visibility FROM quotes WHERE person_id IN (SELECT id FROM people WHERE world_id = ?)', worldId);
  for (const r of rows) {
    const qs = quotes.filter((x) => x.person_id === r.id && canSee(v, x.visibility, null)).map((x) => String(x.text));
    const detail = [r.role, r.met, ...qs].filter(Boolean).join('. ');
    const rel = scoreFields(p, [{ text: r.name, weight: 10, fuzzy: true }, { text: r.role, weight: 3 }, { text: r.met, weight: 1.5 }, { text: qs.join(' '), weight: 1 }]);
    if (!rel) continue;
    const sn = makeSnippet(detail || r.name, p);
    out.push({
      hit: { id: r.id, title: r.name, snippet: sn.text, snippetHtml: sn.html, titleHtml: markHtml(r.name, p), link: `${v.role === 'dm' ? 'dm/' : ''}people`, meta: { role: r.role, attitude: r.attitude, pageId: r.page_id } },
      rel, exact: wordsOf(r.name).join(' ') === p.norm,
    });
  }
  return finish('person', out);
}

function terms(d: Deps, worldId: string, v: Viewer, q: string, p: ParsedQuery): GlobalHit[] {
  const seen = new Set<string>();
  const out: { hit: Omit<GlobalHit, 'score' | 'kind'>; rel: number; exact?: boolean }[] = [];
  const base = `${v.role === 'dm' ? 'dm/' : ''}rules`;
  const add = (id: string, term: string, kind: string, summary: string, module: string, rel: number, exact: boolean) => {
    if (seen.has(id)) return;
    seen.add(id);
    const sn = makeSnippet(summary, p);
    out.push({ hit: { id, title: term, snippet: sn.text, snippetHtml: sn.html, titleHtml: markHtml(term, p), link: `${base}?q=${encodeURIComponent(term)}`, meta: { termKind: kind, module } }, rel, exact });
  };
  // By name first (what you type while looking for "fireball"), then by meaning of the question.
  const byName = searchTerms(d.db, worldId, q, { limit: 8 }).terms;
  byName.forEach((t, i) => add(t.id, t.term, t.kind, t.summary, t.module, 100 - i, p.norm !== '' && wordsOf(t.term).join(' ') === p.norm));
  if (byName.length < 3) for (const r of searchRules(d.db, worldId, q, 5)) add(r.id, r.term, r.kind, r.summary || r.passage, r.module, r.score, false);
  return finish('term', out);
}

function transcript(d: Deps, worldId: string, v: Viewer, p: ParsedQuery): GlobalHit[] {
  const dm = v.role === 'dm';
  // Cheap prefilter on the longest plain ASCII word; the matcher does the real work.
  const w = p.pos.flatMap((t) => t.words).filter((x) => /^[a-z0-9]+$/.test(x)).sort((a, b) => b.length - a.length)[0];
  const like = w ? `AND l.text LIKE ? ESCAPE '\\'` : '';
  const rows = all<any>(d.db, `SELECT l.id, l.session_id, l.start_ms, l.speaker_account, l.speaker_label, l.text, s.name AS session_name
    FROM audio_lines l LEFT JOIN audio_sessions s ON s.id = l.session_id
    WHERE l.world_id = ? ${dm ? '' : "AND l.audience = 'players'"} ${like} ORDER BY l.start_ms LIMIT 3000`, worldId, ...(w ? [`%${w}%`] : []));
  if (!rows.length) return [];
  const nm = names(d.db, worldId);
  const out: { hit: Omit<GlobalHit, 'score' | 'kind'>; rel: number }[] = [];
  for (const r of rows) {
    const rel = scoreFields(p, [{ text: r.text, weight: 1 }]);
    if (!rel) continue;
    const speaker = r.speaker_account ? nm[r.speaker_account] ?? 'Someone' : r.speaker_label || 'Someone';
    const sn = makeSnippet(r.text, p, 200);
    const min = Math.floor(r.start_ms / 60000);
    const sec = String(Math.floor((r.start_ms % 60000) / 1000)).padStart(2, '0');
    out.push({
      hit: { id: r.id, title: `${speaker} (${r.session_name ?? 'Session'}, ${min}:${sec})`, snippet: sn.text, snippetHtml: sn.html, titleHtml: escapeHtml(`${speaker} (${r.session_name ?? 'Session'}, ${min}:${sec})`), link: `${dm ? 'dm/' : ''}audio?line=${encodeURIComponent(r.id)}`, meta: { sessionId: r.session_id, startMs: r.start_ms, speaker } },
      rel,
    });
  }
  out.sort((a, b) => b.rel - a.rel);
  return finish('transcript', out.slice(0, 30));
}

function log(d: Deps, worldId: string, v: Viewer, p: ParsedQuery): GlobalHit[] {
  const dm = v.role === 'dm';
  const rows = all<any>(d.db, `SELECT id, number, title, summary, unpublished_at FROM sessionlog_entries WHERE world_id = ? ${dm ? '' : 'AND unpublished_at IS NULL'} ORDER BY number DESC`, worldId);
  const out: { hit: Omit<GlobalHit, 'score' | 'kind'>; rel: number }[] = [];
  for (const r of rows) {
    const rel = scoreFields(p, [{ text: r.title, weight: 8, fuzzy: true }, { text: r.summary, weight: 1 }]);
    if (!rel) continue;
    const sn = makeSnippet(r.summary, p);
    const title = /^session\b/i.test(String(r.title).trim()) ? r.title : `Session ${r.number}: ${r.title}`;
    out.push({ hit: { id: r.id, title, snippet: sn.text, snippetHtml: sn.html, titleHtml: markHtml(title, p), link: `${dm ? 'dm/sessionlog' : 'log'}?entry=${encodeURIComponent(r.id)}`, meta: { number: r.number, published: !r.unpublished_at } }, rel });
  }
  return finish('log', out);
}

function items(d: Deps, worldId: string, v: Viewer, p: ParsedQuery): GlobalHit[] {
  const dm = v.role === 'dm';
  const rows = dm
    ? all<any>(d.db, `SELECT * FROM items WHERE world_id = ? AND status IN ('approved', 'pending')`, worldId)
    : all<any>(d.db, `SELECT * FROM items WHERE world_id = ? AND status = 'approved' AND owner IN (?, 'party')`, worldId, v.accountId);
  const nm = names(d.db, worldId);
  const out: { hit: Omit<GlobalHit, 'score' | 'kind'>; rel: number; exact?: boolean }[] = [];
  for (const r of rows) {
    // dm_note is the DM's: it is only ever read for the DM.
    const rel = scoreFields(p, [{ text: r.name, weight: 10, fuzzy: true }, { text: r.note ?? '', weight: 2 }, { text: dm ? r.dm_note ?? '' : '', weight: 1 }]);
    if (!rel) continue;
    const owner = r.owner === 'party' ? 'Party stash' : nm[r.owner] ?? 'Someone';
    const sn = makeSnippet(`${r.note || ''}${dm && r.dm_note ? ` ${r.dm_note}` : ''}` || `Held by ${owner}`, p);
    out.push({
      hit: { id: r.id, title: r.name, snippet: sn.text, snippetHtml: sn.html, titleHtml: markHtml(r.name, p), link: dm ? 'dm/party' : 'inventory', meta: { owner, qty: r.qty } },
      rel, exact: wordsOf(r.name).join(' ') === p.norm,
    });
  }
  return finish('item', out);
}

// ---- entry point -------------------------------------------------------------

export interface GlobalOpts { kinds?: Kind[]; limit?: number; perKind?: number; semantic?: boolean }

/** One ranked list. Kinds that fail (missing tables, bad data) are left out. */
export async function globalSearch(d: Deps, worldId: string, viewer: Viewer, q: string, opts: GlobalOpts = {}): Promise<GlobalHit[]> {
  const p = parseQuery(q);
  if (!p.pos.length) return [];
  const kinds = opts.kinds ?? [...KINDS];
  const perKind = Math.max(1, Math.min(opts.perKind ?? 8, 50));
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 200));
  const parts = await Promise.all(kinds.map(async (k): Promise<GlobalHit[]> => {
    try {
      switch (k) {
        case 'page': return await pages(d, worldId, viewer, q, perKind, opts.semantic !== false);
        case 'person': return people(d, worldId, viewer, p);
        case 'term': return terms(d, worldId, viewer, q, p);
        case 'transcript': return transcript(d, worldId, viewer, p);
        case 'log': return log(d, worldId, viewer, p);
        case 'item': return items(d, worldId, viewer, p);
      }
    } catch { return []; }
  }));
  const all_ = parts.flatMap((hits) => hits.sort((a, b) => b.score - a.score).slice(0, perKind));
  all_.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return safe(() => all_.slice(0, limit), []);
}
