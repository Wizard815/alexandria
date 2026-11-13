// Searching the enabled modules: by name (the term browser, lookup_term) and
// by meaning-ish keywords (rules questions, lookup_rule). Plain scoring over
// the merged term list; no model, so it is free and works offline.
import type { DB } from '../../core/db.ts';
import { clip } from './format.ts';
import { type MergedTerm, worldModules } from './store.ts';

const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'do', 'does', 'did', 'how', 'what', 'when', 'where', 'which', 'who', 'why', 'can', 'could', 'should', 'would', 'i', 'you', 'we', 'my', 'me', 'it', 'its', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'with', 'work', 'works', 'rule', 'rules', 'about', 'tell', 'explain', 'happen', 'happens', 'if', 'there', 'be', 'get', 'gets', 'much', 'many', 'dnd', 'd&d', '5e']);

const words = (s: string) => s.toLowerCase().replace(/[’]/g, "'").match(/[\p{L}\p{N}]+/gu) ?? [];
/** Crude stemmer: enough that "grappling", "grappled" and "grapple" meet. */
export function stem(w: string): string {
  if (w.length <= 4) return w;
  return w.replace(/(ing|ed|es|s|ly|er)$/, '').replace(/(.)\1$/, '$1').replace(/e$/, '') || w;
}

interface Doc { t: MergedTerm; name: string; aliases: string[]; summary: string; text: string; nameStems: string[] }
const docs = new WeakMap<MergedTerm[], Doc[]>();
function docsOf(terms: MergedTerm[]): Doc[] {
  let d = docs.get(terms);
  if (!d) {
    d = terms.map((t) => ({ t, name: t.term.toLowerCase(), aliases: t.aliases.map((a) => a.toLowerCase()), summary: t.summary.toLowerCase(), text: t.text.toLowerCase(), nameStems: [...words(t.term), ...t.aliases.flatMap(words)].map(stem) }));
    docs.set(terms, d);
  }
  return d;
}

const count = (hay: string, needle: string, cap = 6): number => {
  let n = 0, i = 0;
  while (n < cap && (i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
};

export interface TermHit { id: string; moduleId: string; module: string; term: string; kind: string; summary: string; aliases: string[] }
const hit = (t: MergedTerm): TermHit => ({ id: t.ref, moduleId: t.moduleId, module: t.moduleName, term: t.term, kind: t.kind, summary: t.summary, aliases: t.aliases });

/** Terms by name: exact, then prefix, then contains. No query lists them alphabetically. */
export function searchTerms(db: DB, worldId: string, q: string, opts: { kind?: string; module?: string; limit?: number; offset?: number } = {}) {
  const all = worldModules(db, worldId).terms.filter((t) => (!opts.kind || t.kind === opts.kind) && (!opts.module || t.moduleId === opts.module));
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const needle = q.trim().toLowerCase();
  if (!needle) {
    const sorted = [...all].sort((a, b) => a.term.localeCompare(b.term));
    return { total: sorted.length, terms: sorted.slice(offset, offset + limit).map(hit) };
  }
  const scored: { t: MergedTerm; s: number }[] = [];
  for (const t of all) {
    const n = t.term.toLowerCase();
    const al = t.aliases.map((a) => a.toLowerCase());
    let s = 0;
    if (n === needle) s = 100;
    else if (al.includes(needle)) s = 90;
    else if (n.startsWith(needle)) s = 70;
    else if (al.some((a) => a.startsWith(needle))) s = 60;
    else if (n.includes(needle)) s = 40;
    else if (al.some((a) => a.includes(needle))) s = 30;
    if (s) scored.push({ t, s: s - t.rank * 0.1 - n.length / 1000 });
  }
  scored.sort((a, b) => b.s - a.s || a.t.term.localeCompare(b.t.term));
  return { total: scored.length, terms: scored.slice(offset, offset + limit).map((x) => hit(x.t)) };
}

export interface RuleHit extends TermHit { passage: string; citation: string; score: number }

/** The paragraph(s) of a term's text that best answer the query. */
function passageOf(text: string, stems: string[], max = 1200): string {
  if (text.length <= max) return text;
  const paras = text.split(/\n{2,}/);
  let best = 0, bestScore = -1;
  paras.forEach((p, i) => {
    const l = p.toLowerCase();
    const s = stems.reduce((n, st) => n + (l.includes(st) ? 1 : 0), 0);
    if (s > bestScore) { best = i; bestScore = s; }
  });
  let out = paras[best];
  for (let i = best + 1; i < paras.length && out.length + paras[i].length < max; i++) out += '\n\n' + paras[i];
  return clip(out, max);
}

/**
 * Rank rules and terms for a question like "how does grappling work?".
 * A name or alias hit beats a summary hit beats a hit in the body; a term
 * that matches every word of the question beats one that matches some.
 */
export function searchRules(db: DB, worldId: string, q: string, limit = 5): RuleHit[] {
  const qs = q.toLowerCase().replace(/[’]/g, "'");
  const ws = words(qs).filter((w) => !STOP.has(w));
  if (!ws.length) return [];
  const stems = [...new Set(ws.map(stem))].filter((s) => s.length >= 2);
  const phrase = ws.join(' ');
  const scored: { d: Doc; s: number }[] = [];
  for (const d of docsOf(worldModules(db, worldId).terms)) {
    let s = 0;
    let matched = 0;
    if (d.name === phrase || d.aliases.includes(phrase)) s += 120;
    else if (phrase.length > 3 && (d.name.includes(phrase) || d.aliases.some((a) => a.includes(phrase)))) s += 60;
    // A question that contains the whole term name ("how does the Dodge action work").
    if (d.name.length > 3 && qs.includes(d.name)) s += 50;
    for (const st of stems) {
      let w = 0;
      if (d.nameStems.some((n) => n === st || n.startsWith(st) || st.startsWith(n) && n.length >= 4)) w = 12;
      else if (d.summary.includes(st)) w = 3 + Math.min(2, count(d.summary, st));
      else {
        const c = count(d.text, st);
        if (c) w = 1 + Math.min(c, 4) * 0.5;
      }
      if (w) matched++;
      s += w;
    }
    if (!s) continue;
    if (stems.length > 1) s *= 0.5 + 0.5 * (matched / stems.length);
    // Rules and actions answer rules questions; spells and monsters only when named.
    if (d.t.kind === 'rule' || d.t.kind === 'action' || d.t.kind === 'condition') s *= 1.25;
    scored.push({ d, s: s - d.t.rank * 0.5 });
  }
  scored.sort((a, b) => b.s - a.s || a.d.t.term.localeCompare(b.d.t.term));
  return scored.slice(0, Math.min(Math.max(limit, 1), 20)).map(({ d, s }) => ({
    ...hit(d.t),
    passage: passageOf(d.t.text, stems),
    citation: `${d.t.moduleName}: ${d.t.term}`,
    score: Math.round(s * 100) / 100,
  }));
}
