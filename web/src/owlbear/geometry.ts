// Geometry for the Owlbear Rodeo extension, with no Owlbear runtime in it (only types), so it is tested on its own.
//
// Owlbear items have a transform (position, rotation in degrees, scale) applied to their local shape. A map picture's
// local units are scene units: the picture is drawn with its grid offset at (0, 0) and k = scene dpi / picture dpi
// scene units per picture pixel. Alexandria's fog is in 0..1 of the picture's width and height.
import type { Curve, Image, Item, Path, PathCommand, Shape } from '@owlbear-rodeo/sdk';

/** Row-major 3 × 3, as Owlbear's MathM: [a b c; d e f; 0 0 1]. */
export type M = [number, number, number, number, number, number, number, number, number];
export interface V { x: number; y: number }

export const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];
export function inverse(m: M): M {
  const [a, b, c, d, e, f] = m;
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-14) return m;
  const i = 1 / det;
  return [e * i, -b * i, (b * f - c * e) * i, -d * i, a * i, (c * d - a * f) * i, 0, 0, 1];
}
export function fromItem(it: Pick<Item, 'position' | 'rotation' | 'scale'>): M {
  const r = (it.rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const sx = it.scale?.x ?? 1, sy = it.scale?.y ?? 1;
  return [cos * sx, -sin * sy, it.position.x, sin * sx, cos * sy, it.position.y, 0, 0, 1];
}
export const apply = (m: M, p: V): V => ({ x: m[0] * p.x + m[1] * p.y + m[2], y: m[3] * p.x + m[4] * p.y + m[5] });

/** How a map picture sits in its own local units. */
export interface PicFrame { width: number; height: number; k: number; offset: V }
export const frameOf = (img: Pick<Image, 'image' | 'grid'>, sceneDpi: number): PicFrame => ({
  width: img.image.width, height: img.image.height, k: sceneDpi / (img.grid.dpi || sceneDpi), offset: img.grid.offset ?? { x: 0, y: 0 },
});
/** 0..1 of the picture → the picture item's local units. */
export const toLocal = (f: PicFrame, u: number, v: number): V => ({ x: (u * f.width - f.offset.x) * f.k, y: (v * f.height - f.offset.y) * f.k });
/** The picture item's local units → 0..1 of the picture. */
export const toUnit = (f: PicFrame, p: V): V => ({ x: (p.x / f.k + f.offset.x) / f.width, y: (p.y / f.k + f.offset.y) / f.height });

/** Fogged cell rectangles from the librarian ([x, y, w, h] on a cols × rows grid) as path commands in the picture's local units. */
export function rectCommands(rects: [number, number, number, number][], cols: number, rows: number, f: PicFrame): PathCommand[] {
  const out: number[][] = [];
  const r2 = (n: number) => Math.round(n * 100) / 100;
  for (const [x, y, w, h] of rects) {
    const a = toLocal(f, x / cols, y / rows), b = toLocal(f, (x + w) / cols, (y + h) / rows);
    out.push([0, r2(a.x), r2(a.y)], [1, r2(b.x), r2(a.y)], [1, r2(b.x), r2(b.y)], [1, r2(a.x), r2(b.y)], [5]);
  }
  return out as unknown as PathCommand[];
}

/** A closed outline (one or more rings) and how it is filled. */
export interface Outline { rings: V[][]; evenOdd: boolean }

const SEG = 10;
/** An Owlbear fog item's outline in its own local units, or null for a kind that is not an area. */
export function outlineOf(it: Item): Outline | null {
  if (it.type === 'SHAPE') {
    const s = it as Shape, w = s.width, h = s.height;
    switch (s.shapeType) {
      case 'RECTANGLE': return { rings: [[{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]], evenOdd: false };
      case 'CIRCLE': return { rings: [Array.from({ length: 48 }, (_, i) => ({ x: (w / 2) * Math.cos((i / 48) * 2 * Math.PI), y: (h / 2) * Math.sin((i / 48) * 2 * Math.PI) }))], evenOdd: false };
      case 'TRIANGLE': return { rings: [[{ x: 0, y: 0 }, { x: w / 2, y: h }, { x: -w / 2, y: h }]], evenOdd: false };
      case 'HEXAGON': return { rings: [Array.from({ length: 6 }, (_, i) => ({ x: (w / 2) * Math.cos((i / 6) * 2 * Math.PI), y: (h / 2) * Math.sin((i / 6) * 2 * Math.PI) }))], evenOdd: false };
      default: return null;
    }
  }
  if (it.type === 'CURVE') {
    const c = it as Curve;
    return c.points?.length >= 3 ? { rings: [c.points.map((p) => ({ x: p.x, y: p.y }))], evenOdd: false } : null;
  }
  if (it.type === 'PATH') {
    const p = it as Path;
    const rings: V[][] = [];
    let ring: V[] = [];
    let at: V = { x: 0, y: 0 };
    const end = () => { if (ring.length >= 3) rings.push(ring); ring = []; };
    for (const cmd of p.commands ?? []) {
      const c = cmd as unknown as number[];
      switch (c[0]) {
        case 0: end(); at = { x: c[1], y: c[2] }; ring = [at]; break;
        case 1: at = { x: c[1], y: c[2] }; ring.push(at); break;
        case 2: case 3: {
          const [cx, cy, x, y] = [c[1], c[2], c[3], c[4]];
          for (let i = 1; i <= SEG; i++) { const t = i / SEG, u = 1 - t; ring.push({ x: u * u * at.x + 2 * u * t * cx + t * t * x, y: u * u * at.y + 2 * u * t * cy + t * t * y }); }
          at = { x, y }; break;
        }
        case 4: {
          const [ax, ay, bx, by, x, y] = [c[1], c[2], c[3], c[4], c[5], c[6]];
          for (let i = 1; i <= SEG; i++) {
            const t = i / SEG, u = 1 - t;
            ring.push({ x: u * u * u * at.x + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * x, y: u * u * u * at.y + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * y });
          }
          at = { x, y }; break;
        }
        case 5: { const first = ring[0]; end(); if (first) { at = first; } break; }
      }
    }
    end();
    return rings.length ? { rings, evenOdd: String(p.fillRule).toLowerCase() === 'evenodd' } : null;
  }
  return null;
}

/** Is the point inside the outline? Winding number for nonzero, crossings for even-odd. */
export function inside(o: Outline, p: V): boolean {
  let wn = 0, cross = 0;
  for (const r of o.rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[j], b = r[i];
      if ((a.y <= p.y) !== (b.y <= p.y)) {
        const x = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
        if (x > p.x) { cross++; wn += b.y > a.y ? 1 : -1; }
      }
    }
  }
  return o.evenOdd ? cross % 2 === 1 : wn !== 0;
}

/**
 * Owlbear's fog over one picture as a grid × grid bitmask (1 = fogged, row by row, low bit first), base64, the shape the
 * librarian keeps. A cell is fogged when its centre is inside any visible fog item.
 */
export function fogMask(items: Item[], pic: Pick<Image, 'position' | 'rotation' | 'scale' | 'image' | 'grid'>, sceneDpi: number, grid = 96): string {
  const f = frameOf(pic, sceneDpi);
  const picToWorld = fromItem(pic);
  // Each item: its outline, and the map from picture-local units to the item's local units (to test points in it).
  const shapes = items.filter((it) => it.visible !== false).map((it) => ({ o: outlineOf(it), m: mul(inverse(fromItem(it)), picToWorld) })).filter((s) => s.o) as { o: Outline; m: M }[];
  const bytes = new Uint8Array((grid * grid + 7) >> 3);
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const local = toLocal(f, (i + 0.5) / grid, (j + 0.5) / grid);
      if (shapes.some((s) => inside(s.o, apply(s.m, local)))) { const n = j * grid + i; bytes[n >> 3] |= 1 << (n & 7); }
    }
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
