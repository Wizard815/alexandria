// Fog of war for maps: what the DM has uncovered on one map picture, in map-normalised 0..1 coordinates so it fits any size.
// Kept as a short list of strokes (circle or rectangle, reveal or hide) on top of a base: fully fogged, or a low-res bitmask
// once the list has been compacted. The server decides what is fogged (marks under fog are never sent to players); the
// client only draws it. A circle's radius is a fraction of the map's width, and the map is taken as FOG_ASPECT wide to tall,
// so the same stroke is the same ellipse on every screen the picture is stretched to.
import type { DB } from './db.ts';
import { all } from './db.ts';
import { parseJson } from './util.ts';

export const FOG_ASPECT = 1.6;
export const FOG_GRID = 96;
const MAX_OPS = 240;
const KEEP_OPS = 80;

/** `g` ties the circles of one drag together, so "undo last stroke" takes the whole drag back. */
export type FogOp =
  | { k: 'c'; x: number; y: number; r: number; v: 0 | 1; g?: number }
  | { k: 'r'; x: number; y: number; w: number; h: number; v: 0 | 1; g?: number }
  | { k: 'all'; v: 0 | 1; g?: number };

/** v: 1 uncovers the area, 0 covers it again. base: base64 bitmask (1 = fogged), or null for a fully fogged map. */
export interface FogState { enabled: boolean; base: string | null; ops: FogOp[] }

export const EMPTY_FOG: FogState = { enabled: false, base: null, ops: [] };

const cell = (base: Buffer | null, x: number, y: number): boolean => {
  if (!base) return true;
  const i = Math.min(FOG_GRID - 1, Math.max(0, Math.floor(y * FOG_GRID))) * FOG_GRID + Math.min(FOG_GRID - 1, Math.max(0, Math.floor(x * FOG_GRID)));
  return (base[i >> 3] & (1 << (i & 7))) !== 0;
};

function applies(op: FogOp, x: number, y: number): boolean {
  if (op.k === 'all') return true;
  if (op.k === 'r') return x >= op.x && x <= op.x + op.w && y >= op.y && y <= op.y + op.h;
  const dx = x - op.x, dy = (y - op.y) / FOG_ASPECT;
  return dx * dx + dy * dy <= op.r * op.r;
}

const evalAt = (base: Buffer | null, ops: FogOp[], x: number, y: number): boolean => {
  let fogged = cell(base, x, y);
  for (const op of ops) if (applies(op, x, y)) fogged = op.v === 0;
  return fogged;
};

/** Is this point (0..1, 0..1) under fog? A map with fog off is never fogged. */
export function isFogged(s: FogState, x: number, y: number): boolean {
  if (!s.enabled) return false;
  return evalAt(s.base ? Buffer.from(s.base, 'base64') : null, s.ops, x, y);
}

/** The strokes with the last stroke (every trailing op of the same group) taken off. */
export function withoutLastStroke(ops: FogOp[]): FogOp[] {
  if (!ops.length) return ops;
  const g = ops[ops.length - 1].g;
  if (g === undefined) return ops.slice(0, -1);
  let n = ops.length;
  while (n > 0 && ops[n - 1].g === g) n--;
  return ops.slice(0, n);
}

/** Fold the oldest strokes into the bitmask so the list stays short; the newest KEEP_OPS stay undoable. */
export function compact(s: FogState): FogState {
  if (s.ops.length <= MAX_OPS) return s;
  const cut = s.ops.length - KEEP_OPS;
  const base = s.base ? Buffer.from(s.base, 'base64') : null;
  const old = s.ops.slice(0, cut);
  const out = Buffer.alloc((FOG_GRID * FOG_GRID + 7) >> 3);
  for (let j = 0; j < FOG_GRID; j++) {
    for (let i = 0; i < FOG_GRID; i++) {
      if (evalAt(base, old, (i + 0.5) / FOG_GRID, (j + 0.5) / FOG_GRID)) { const n = j * FOG_GRID + i; out[n >> 3] |= 1 << (n & 7); }
    }
  }
  return { ...s, base: out.toString('base64'), ops: s.ops.slice(cut) };
}

export const readFog = (row: { enabled: number; base: string | null; ops: string } | undefined | null): FogState =>
  row ? { enabled: !!row.enabled, base: row.base ?? null, ops: parseJson<FogOp[]>(row.ops, []) } : EMPTY_FOG;

/** The fog states that apply to marks on one map: every picture of it that has fog on. A mark under any of them is hidden. */
export function fogLayers(db: DB, worldId: string, mapId: string): FogState[] {
  return all<any>(db, 'SELECT enabled, base, ops FROM fog_layers WHERE world_id = ? AND map_id = ? AND enabled = 1', worldId, mapId).map(readFog);
}

/** Where a mark sits, as points on the 0..100 scale (a route has several). */
const pointsOf = (m: { kind: string; data: any }): { x: number; y: number }[] =>
  m.kind === 'route' ? (Array.isArray(m.data?.points) ? m.data.points : []) : [m.data];

/** Fail closed: a mark is hidden when any of its points is under fog, and when its position cannot be read at all. */
export function markUnderFog(layers: FogState[], m: { kind: string; data: any }): boolean {
  if (!layers.length) return false;
  const pts = pointsOf(m);
  if (!pts.length) return true;
  return pts.some((p) => {
    const x = Number(p?.x) / 100, y = Number(p?.y) / 100;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
    return layers.some((l) => isFogged(l, x, y));
  });
}
