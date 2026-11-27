// Fog as cells, for Owlbear Rodeo. Owlbear draws fog as shapes on its fog layer; Alexandria keeps strokes (core/fog.ts).
// Going out, the fog of one map picture is sampled on a grid and the fogged cells are merged into as few rectangles as
// possible (one Owlbear path). Coming back, Owlbear's fog arrives as a bitmask on the same FOG_GRID as a compacted fog's
// base, and becomes strokes: cover everything, then uncover each clear rectangle, all one stroke so one undo takes it back.
import { FOG_GRID, isFogged, type FogOp, type FogState } from '../../core/fog.ts';

/** [x, y, w, h] in cells. */
export type CellRect = [number, number, number, number];

/** Merge the true cells of a grid into rectangles: runs along each row, a run that repeats in the next row grows down. */
export function rectsOf(cols: number, rows: number, on: (i: number, j: number) => boolean): CellRect[] {
  const out: CellRect[] = [];
  let open = new Map<string, number>();
  for (let j = 0; j < rows; j++) {
    const next = new Map<string, number>();
    let i = 0;
    while (i < cols) {
      if (!on(i, j)) { i++; continue; }
      const s = i;
      while (i < cols && on(i, j)) i++;
      const k = `${s},${i}`;
      const at = open.get(k);
      if (at !== undefined) { out[at][3]++; next.set(k, at); }
      else { next.set(k, out.length); out.push([s, j, i - s, 1]); }
    }
    open = next;
  }
  return out;
}

/** The fogged cells of a fog state on a cols × rows grid (sampled at each cell's centre), as rectangles. */
export function fogRects(s: FogState, cols: number, rows: number): CellRect[] {
  if (!s.enabled) return [];
  const grid = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) grid[j * cols + i] = isFogged(s, (i + 0.5) / cols, (j + 0.5) / rows) ? 1 : 0;
  return rectsOf(cols, rows, (i, j) => grid[j * cols + i] === 1);
}

const MASK_BYTES = (FOG_GRID * FOG_GRID + 7) >> 3;
/** More clear rectangles than this and the mask is kept as a base bitmask instead (no undo for that push). */
export const MAX_PUSH_OPS = 400;

/** Read a FOG_GRID × FOG_GRID bitmask (1 = fogged, row by row, low bit first), or null if it is not one. */
export function readMask(b64: unknown): Buffer | null {
  if (typeof b64 !== 'string' || b64.length > 4000 || !/^[A-Za-z0-9+/=]*$/.test(b64)) return null;
  const buf = Buffer.from(b64, 'base64');
  return buf.length === MASK_BYTES ? buf : null;
}

const bit = (m: Buffer, i: number, j: number) => { const n = j * FOG_GRID + i; return (m[n >> 3] & (1 << (n & 7))) !== 0; };

/** Owlbear's fog as one Alexandria stroke (cover all, uncover each clear rectangle), or as a base when it is too detailed. */
export function stateFromMask(mask: Buffer, g: number): FogState {
  const clear = rectsOf(FOG_GRID, FOG_GRID, (i, j) => !bit(mask, i, j));
  if (clear.length > MAX_PUSH_OPS) return { enabled: true, base: mask.toString('base64'), ops: [] };
  const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
  const ops: FogOp[] = [{ k: 'all', v: 0, g }];
  for (const [x, y, w, h] of clear) ops.push({ k: 'r', x: r4(x / FOG_GRID), y: r4(y / FOG_GRID), w: r4(w / FOG_GRID), h: r4(h / FOG_GRID), v: 1, g });
  return { enabled: true, base: null, ops };
}
