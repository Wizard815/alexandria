// A small seedable random generator, so a seed always gives the same output.
export type Rng = () => number;

function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** mulberry32. Same seed, same sequence. */
export function makeRng(seed: string | number): Rng {
  let a = fnv(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seed to use: the caller's, or a fresh short one (returned so a roll can be repeated). */
export function seedOf(seed: unknown): string {
  const s = seed === undefined || seed === null ? '' : String(seed).trim().slice(0, 64);
  return s || Math.floor(Math.random() * 0x7fffffff).toString(36);
}

export const pick = <T,>(r: Rng, a: readonly T[]): T => a[Math.floor(r() * a.length)];
export const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
export const chance = (r: Rng, p: number) => r() < p;
/** Roll `n` dice with `sides` sides. */
export const dice = (r: Rng, n: number, sides: number) => { let t = 0; for (let i = 0; i < n; i++) t += int(r, 1, sides); return t; };
