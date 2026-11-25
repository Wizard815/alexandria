// Spell search: every filter of the Codex in one place, so the page, the API
// and the assistant's list_spells tool find the same spells.
import { nameKey, type Spell } from './format.ts';

export interface SpellQuery {
  q?: string;
  /** Also look in the description, not only the name. */
  text?: boolean;
  levels?: number[];
  school?: string;
  cls?: string;
  v?: boolean;
  s?: boolean;
  m?: boolean;
  material?: string;
  costly?: boolean;
  consumed?: boolean;
  castingTime?: string;
  range?: string;
  duration?: string;
  concentration?: boolean;
  ritual?: boolean;
  damage?: string;
  save?: string;
  attack?: string;
  source?: string;
}

const yes = (v: unknown): boolean | undefined => (v === undefined || v === null || v === '' ? undefined : v === true || v === '1' || v === 'true' || v === 'yes');
const word = (v: unknown, max = 80): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** A query from URL parameters (level=1,2 or level=0-3, v=1, concentration=0 ...). */
export function queryFrom(p: Record<string, unknown>): SpellQuery {
  let levels: number[] | undefined;
  const lv = word(p.level, 20);
  if (lv) {
    const range = lv.match(/^(\d)\s*-\s*(\d)$/);
    levels = range ? Array.from({ length: Math.max(0, Number(range[2]) - Number(range[1]) + 1) }, (_, i) => Number(range[1]) + i) : lv.split(',').map((x) => (/^c/i.test(x.trim()) ? 0 : Number(x))).filter((n) => Number.isInteger(n) && n >= 0 && n <= 9);
  }
  return {
    q: word(p.q, 200), text: yes(p.text), levels, school: word(p.school), cls: word(p.class), v: yes(p.v), s: yes(p.s), m: yes(p.m), material: word(p.material),
    costly: yes(p.costly), consumed: yes(p.consumed), castingTime: word(p.castingTime), range: word(p.range), duration: word(p.duration),
    concentration: yes(p.concentration), ritual: yes(p.ritual), damage: word(p.damage), save: word(p.save), attack: word(p.attack), source: word(p.source, 120),
  };
}

const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
/** "action" finds Action but not Bonus Action or Reaction; anything else matches anywhere. */
const castMatch = (ct: string, want: string): boolean => {
  const w = want.toLowerCase().trim();
  if (w === 'action') return /^action\b/i.test(ct.trim());
  if (w === 'bonus' || w === 'bonus action') return /^bonus action/i.test(ct.trim());
  if (w === 'reaction') return /^reaction/i.test(ct.trim());
  if (w === 'long' || w === 'minutes') return /\b(minute|hour)/i.test(ct);
  return has(ct, w);
};
const rangeMatch = (r: string, want: string): boolean => {
  const w = want.toLowerCase().trim();
  if (w === 'self' || w === 'touch' || w === 'sight' || w === 'unlimited') return r.toLowerCase().startsWith(w);
  return has(r, w);
};

export function matches(sp: Spell, f: SpellQuery): boolean {
  if (f.q) {
    const k = nameKey(f.q);
    const inName = nameKey(sp.name).includes(k) || has(sp.name, f.q);
    if (!inName && !(f.text && has(sp.text, f.q))) return false;
  }
  if (f.levels?.length && !f.levels.includes(sp.level)) return false;
  if (f.school && sp.school.toLowerCase() !== f.school.toLowerCase()) return false;
  if (f.cls && !sp.classes.some((c) => c.toLowerCase() === f.cls!.toLowerCase())) return false;
  if (f.v !== undefined && sp.components.v !== f.v) return false;
  if (f.s !== undefined && sp.components.s !== f.s) return false;
  if (f.m !== undefined && sp.components.m !== f.m) return false;
  if (f.material && !has(sp.material, f.material)) return false;
  if (f.costly !== undefined && sp.materialCost !== f.costly) return false;
  if (f.consumed !== undefined && sp.materialConsumed !== f.consumed) return false;
  if (f.castingTime && !castMatch(sp.castingTime, f.castingTime)) return false;
  if (f.range && !rangeMatch(sp.range, f.range)) return false;
  if (f.duration && !has(sp.duration, f.duration)) return false;
  if (f.concentration !== undefined && sp.concentration !== f.concentration) return false;
  if (f.ritual !== undefined && sp.ritual !== f.ritual) return false;
  if (f.damage && !sp.damageTypes.some((d) => d.toLowerCase() === f.damage!.toLowerCase())) return false;
  if (f.save && !sp.saves.some((d) => d.toLowerCase().startsWith(f.save!.toLowerCase().slice(0, 3)))) return false;
  if (f.attack && sp.attack !== f.attack.toLowerCase()) return false;
  if (f.source && sp.source.toLowerCase() !== f.source.toLowerCase()) return false;
  return true;
}

/** Filter, then order: a name that starts with the words first, then by level and name. */
export function search<T extends Spell>(list: T[], f: SpellQuery): T[] {
  const out = list.filter((s) => matches(s, f));
  const k = f.q ? nameKey(f.q) : '';
  return out.sort((a, b) => {
    if (k) {
      const sa = nameKey(a.name).startsWith(k) ? 0 : 1, sb = nameKey(b.name).startsWith(k) ? 0 : 1;
      if (sa !== sb) return sa - sb;
    }
    return a.level - b.level || a.name.localeCompare(b.name);
  });
}

/** The values each filter can take in this list (for the filter menus). */
export function facets(list: Spell[]) {
  const set = (f: (s: Spell) => string[]) => [...new Set(list.flatMap(f).filter(Boolean))].sort();
  return {
    schools: set((s) => [s.school]),
    classes: set((s) => s.classes),
    damageTypes: set((s) => s.damageTypes),
    saves: set((s) => s.saves),
    castingTimes: set((s) => [s.castingTime.split(',')[0]]),
    sources: set((s) => [s.source]),
  };
}
