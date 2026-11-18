import { type Rng, int } from '../../quickgen/rng.ts';
import type { Canvas } from './canvas.ts';

export type MapKind = 'dungeon' | 'cave' | 'castle' | 'tavern' | 'battlemap' | 'city' | 'region' | 'forest';
export const MAP_KINDS: readonly MapKind[] = ['dungeon', 'cave', 'castle', 'tavern', 'battlemap', 'city', 'region', 'forest'];
export const SIZES = ['small', 'medium', 'large'] as const;

export interface MapOpts {
  seed?: string | number;
  /** small | medium | large */
  size?: string;
  /** dungeon: ruin, crypt, mine, sewer, temple, lair. tavern: dwarven, elven, pirate, haunted, common. */
  flavour?: string;
  /** battlemap: forest, ruins, river, camp, swamp, cliff, crossroads. forest: forest, wilderness, swamp. */
  theme?: string;
  /** Titles already used in this world, so generated names do not repeat them. */
  avoid?: Set<string>;
  /** Use this title instead of making one up (a tavern map takes its tavern's name). */
  title?: string;
}
export interface KeyEntry { n: string; name: string; text: string; dm?: string }
export interface MapResult {
  kind: MapKind; seed: string; size: string; flavour: string; title: string;
  /** Feet one grid square stands for, or null when the map is not on a battle grid. */
  ftPerCell: number | null;
  canvas: Canvas; key: KeyEntry[]; legend: string[];
  /** Counts and a reachability check (reached === total means everything connects). */
  stats: Record<string, number | string | boolean>;
}

export const sizeOf = (s: unknown): 'small' | 'medium' | 'large' => (s === 'small' || s === 'large' ? s : 'medium');
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Seeded 2D value noise, 0..1. */
export function makeNoise(r: Rng) {
  const P = new Uint8Array(512);
  const base = Array.from({ length: 256 }, (_x, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [base[i], base[j]] = [base[j], base[i]]; }
  for (let i = 0; i < 512; i++) P[i] = base[i & 255];
  const val = (x: number, y: number) => P[(P[x & 255] + y) & 255] / 255;
  const sm = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
    const a = val(xi, yi), b = val(xi + 1, yi), c = val(xi, yi + 1), d = val(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  return (x: number, y: number, oct = 4) => {
    let amp = 1, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) { sum += noise(x * f, y * f) * amp; norm += amp; amp *= 0.5; f *= 2; }
    return sum / norm;
  };
}

/** Which cells can be reached from `start`, moving 4-way through cells where `open(x,y)` holds. */
export function flood(w: number, h: number, start: [number, number], open: (x: number, y: number) => boolean, link?: (x: number, y: number, nx: number, ny: number) => boolean): Uint8Array {
  const seen = new Uint8Array(w * h);
  if (!open(start[0], start[1])) return seen;
  const stack = [start[1] * w + start[0]];
  seen[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i - x) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny * w + nx] || !open(nx, ny)) continue;
      if (link && !link(x, y, nx, ny)) continue;
      seen[ny * w + nx] = 1;
      stack.push(ny * w + nx);
    }
  }
  return seen;
}

/** Minimum spanning tree over points (Prim), returned as index pairs. */
export function mst(pts: [number, number][]): [number, number][] {
  const n = pts.length;
  if (n < 2) return [];
  const used = new Array<boolean>(n).fill(false);
  const best = new Array<number>(n).fill(Infinity);
  const from = new Array<number>(n).fill(-1);
  best[0] = 0;
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!used[i] && (u < 0 || best[i] < best[u])) u = i;
    used[u] = true;
    if (from[u] >= 0) out.push([from[u], u]);
    for (let v = 0; v < n; v++) {
      if (used[v]) continue;
      const d = Math.hypot(pts[u][0] - pts[v][0], pts[u][1] - pts[v][1]);
      if (d < best[v]) { best[v] = d; from[v] = u; }
    }
  }
  return out;
}

export const rnd = (r: Rng, lo: number, hi: number) => lo + r() * (hi - lo);
export { int };

/** Title, seed and scale text along the bottom of a map. */
export function footer(c: Canvas, text: string, y: number, color = '#3a3128') {
  c.ops.push({ t: 'text', x: 10, y, s: text, size: 11, fill: color });
}
