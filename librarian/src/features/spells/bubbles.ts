// Spell bubbles: each school's spells grouped, level by level, into small
// bubbles of about four. A bubble opens once the character knows any spell in
// the bubble before it on the same school's path (the lowest bubbles are open
// from the start); learning one spell in a bubble opens the next, and the rest
// of the bubble stays open to learn as well. Pure, no imports: the Spell Tree
// app copies this file.

export interface BubbleSpell { id: string; name: string; level: number; school: string; lines: string[] }
export interface Bubble {
  id: string;
  school: string;
  level: number;
  /** A readable name: the bubble's first spell ("the Fireball bubble"). */
  name: string;
  /** The bubble before it on the school's path; null for the first ones. */
  parent: string | null;
  spells: string[];
}

const ELEMENT_ORDER = ['Necrotic', 'Poison', 'Acid', 'Fire', 'Lightning', 'Thunder', 'Cold', 'Force', 'Radiant', 'Psychic'];
const elemKey = (s: BubbleSpell) => {
  const i = s.lines.map((l) => ELEMENT_ORDER.indexOf(l)).filter((x) => x >= 0);
  return i.length ? Math.min(...i) : ELEMENT_ORDER.length;
};

/** Every school's spells in bubbles of about `size` (spells sharing an element sit together). */
export function makeBubbles(list: BubbleSpell[], size = 4): Bubble[] {
  const out: Bubble[] = [];
  const per = Math.max(2, Math.round(size));
  const schools = [...new Set(list.map((s) => s.school || 'Others'))].sort();
  for (const school of schools) {
    let prev: Bubble[] = [];
    for (let lv = 0; lv <= 9; lv++) {
      const here = list.filter((s) => (s.school || 'Others') === school && s.level === lv).sort((a, b) => elemKey(a) - elemKey(b) || a.name.localeCompare(b.name));
      if (!here.length) continue;
      const k = Math.ceil(here.length / per);
      const mine: Bubble[] = [];
      let at = 0;
      for (let i = 0; i < k; i++) {
        // As even as can be: 9 spells make 3 + 3 + 3, not 4 + 4 + 1.
        const n = Math.floor(here.length / k) + (i < here.length % k ? 1 : 0);
        const group = here.slice(at, at + n);
        at += n;
        const parent = prev.length ? prev[Math.min(prev.length - 1, Math.floor((i * prev.length) / k))].id : null;
        mine.push({ id: `${school}:${lv}:${i}`, school, level: lv, name: `${group[0].name} bubble`, parent, spells: group.map((s) => s.id) });
      }
      out.push(...mine);
      prev = mine;
    }
  }
  return out;
}

/** Which bubble each spell is in. */
export const bubbleOf = (bubbles: Bubble[]): Map<string, Bubble> => {
  const m = new Map<string, Bubble>();
  for (const b of bubbles) for (const id of b.spells) m.set(id, b);
  return m;
};

/** Open: the first bubbles always; any other once a spell in the bubble before it is known. */
export function bubbleOpen(b: Bubble, byId: Map<string, Bubble>, known: Set<string>): boolean {
  if (!b.parent) return true;
  const p = byId.get(b.parent);
  return !p || p.spells.some((id) => known.has(id));
}
