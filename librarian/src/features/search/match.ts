// A small in-memory matcher for the things that are not library pages
// (people, items, transcript lines, log entries): same query syntax as page
// search (words, "phrases", -exclusions, prefix on the last word), accents
// folded, whole words only.
import { type ParsedQuery, editDistance, allowedEdits, wordsOf } from '../../core/pagesearch.ts';

export interface Field { text: string; weight: number; /** Allow a typo in short fields such as names. */ fuzzy?: boolean }

/** 0 when the text does not match every term (or has an excluded one); otherwise a relevance. */
export function scoreFields(p: ParsedQuery, fields: Field[]): number {
  if (!p.pos.length) return 0;
  const toks = fields.map((f) => wordsOf(f.text));
  const has = (ws: string[], prefix: boolean, fuzzy: boolean, tk: string[]): number => {
    let n = 0;
    outer: for (let i = 0; i + ws.length <= tk.length; i++) {
      for (let j = 0; j < ws.length; j++) {
        const last = j === ws.length - 1;
        const t = tk[i + j];
        const w = ws[j];
        const ok = t === w || (prefix && last && t.startsWith(w)) || (fuzzy && ws.length === 1 && !/\d/.test(w) && editDistance(w, t, allowedEdits(w.length)) <= allowedEdits(w.length));
        if (!ok) continue outer;
      }
      n++;
    }
    return n;
  };
  for (const t of p.not) for (const tk of toks) if (has(t.words, false, false, tk)) return 0;
  let total = 0;
  for (const t of p.pos) {
    let best = 0;
    toks.forEach((tk, i) => {
      const f = fields[i];
      const exact = has(t.words, t.prefix, false, tk);
      const n = exact || (f.fuzzy ? has(t.words, t.prefix, true, tk) : 0);
      if (n) best = Math.max(best, f.weight * (exact ? 1 : 0.6) * (1 + 0.1 * Math.min(n, 5)));
    });
    if (!best) return 0;
    total += best;
  }
  // A name that is exactly the query ranks first.
  const q = p.pos.flatMap((t) => t.words).join(' ');
  if (fields[0] && wordsOf(fields[0].text).join(' ') === q) total += fields[0].weight * 3;
  return total;
}
