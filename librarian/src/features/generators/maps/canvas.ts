// A tiny drawing surface for the map generators. A map is a list of shapes in
// pixels; the same list is written as an SVG and rasterised to a PNG (pure JS,
// no dependency) so a map can be a library file the Map page and the stage can
// show. Shapes marked `gm` (secret doors, traps) are left out of the player view.
import zlib from 'node:zlib';

export type Op =
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; sw?: number; a?: number; gm?: boolean }
  | { t: 'poly'; pts: number[]; fill?: string; stroke?: string; sw?: number; close?: boolean; a?: number; gm?: boolean }
  | { t: 'lines'; segs: number[]; stroke: string; sw: number; a?: number; gm?: boolean }
  | { t: 'circle'; x: number; y: number; r: number; fill?: string; stroke?: string; sw?: number; a?: number; gm?: boolean }
  | { t: 'text'; x: number; y: number; s: string; size: number; fill: string; anchor?: 'start' | 'middle' | 'end'; bold?: boolean; gm?: boolean };

export interface Canvas { w: number; h: number; bg: string; ops: Op[] }

export const newCanvas = (w: number, h: number, bg: string): Canvas => ({ w: Math.round(w), h: Math.round(h), bg, ops: [] });

const r1 = (n: number) => Math.round(n * 10) / 10;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The SVG text. Only the shapes this view may show are written. */
export function toSvg(c: Canvas, o: { gm?: boolean; title?: string } = {}): string {
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${c.w} ${c.h}" width="${c.w}" height="${c.h}" font-family="Georgia, 'Times New Roman', serif">`];
  if (o.title) out.push(`<title>${esc(o.title)}</title>`);
  out.push(`<rect width="${c.w}" height="${c.h}" fill="${c.bg}"/>`);
  const paint = (op: { fill?: string; stroke?: string; sw?: number; a?: number }) =>
    `${op.fill ? ` fill="${op.fill}"` : ' fill="none"'}${op.a !== undefined && op.a < 1 ? ` fill-opacity="${op.a}"` : ''}${op.stroke ? ` stroke="${op.stroke}" stroke-width="${r1(op.sw ?? 1)}" stroke-linejoin="round" stroke-linecap="round"` : ''}`;
  for (const op of c.ops) {
    if (op.gm && !o.gm) continue;
    switch (op.t) {
      case 'rect': out.push(`<rect x="${r1(op.x)}" y="${r1(op.y)}" width="${r1(op.w)}" height="${r1(op.h)}"${paint(op)}/>`); break;
      case 'circle': out.push(`<circle cx="${r1(op.x)}" cy="${r1(op.y)}" r="${r1(op.r)}"${paint(op)}/>`); break;
      case 'poly': {
        let d = '';
        for (let i = 0; i + 1 < op.pts.length; i += 2) d += `${i ? 'L' : 'M'}${r1(op.pts[i])} ${r1(op.pts[i + 1])}`;
        out.push(`<path d="${d}${op.close === false ? '' : 'Z'}"${paint(op)}/>`);
        break;
      }
      case 'lines': {
        let d = '';
        for (let i = 0; i + 3 < op.segs.length; i += 4) d += `M${r1(op.segs[i])} ${r1(op.segs[i + 1])}L${r1(op.segs[i + 2])} ${r1(op.segs[i + 3])}`;
        if (d) out.push(`<path d="${d}" fill="none" stroke="${op.stroke}" stroke-width="${r1(op.sw)}" stroke-linecap="round"${op.a !== undefined && op.a < 1 ? ` stroke-opacity="${op.a}"` : ''}/>`);
        break;
      }
      case 'text': out.push(`<text x="${r1(op.x)}" y="${r1(op.y)}" font-size="${r1(op.size)}" fill="${op.fill}" text-anchor="${op.anchor ?? 'start'}"${op.bold ? ' font-weight="bold"' : ''}>${esc(op.s)}</text>`); break;
    }
  }
  out.push('</svg>');
  return out.join('\n');
}

// ---- PNG ----------------------------------------------------------------

const FONT: Record<string, string> = {
  '0': '01110 10001 10011 10101 11001 10001 01110', '1': '00100 01100 00100 00100 00100 00100 01110', '2': '01110 10001 00001 00010 00100 01000 11111',
  '3': '11110 00001 00001 01110 00001 00001 11110', '4': '00010 00110 01010 10010 11111 00010 00010', '5': '11111 10000 11110 00001 00001 10001 01110',
  '6': '00110 01000 10000 11110 10001 10001 01110', '7': '11111 00001 00010 00100 01000 01000 01000', '8': '01110 10001 10001 01110 10001 10001 01110',
  '9': '01110 10001 10001 01111 00001 00010 01100',
  A: '01110 10001 10001 11111 10001 10001 10001', B: '11110 10001 10001 11110 10001 10001 11110', C: '01110 10001 10000 10000 10000 10001 01110',
  D: '11110 10001 10001 10001 10001 10001 11110', E: '11111 10000 10000 11110 10000 10000 11111', F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111', H: '10001 10001 10001 11111 10001 10001 10001', I: '01110 00100 00100 00100 00100 00100 01110',
  J: '00111 00010 00010 00010 00010 10010 01100', K: '10001 10010 10100 11000 10100 10010 10001', L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001', N: '10001 10001 11001 10101 10011 10001 10001', O: '01110 10001 10001 10001 10001 10001 01110',
  P: '11110 10001 10001 11110 10000 10000 10000', Q: '01110 10001 10001 10001 10101 10010 01101', R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110', T: '11111 00100 00100 00100 00100 00100 00100', U: '10001 10001 10001 10001 10001 10001 01110',
  V: '10001 10001 10001 10001 10001 01010 00100', W: '10001 10001 10001 10101 10101 10101 01010', X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100', Z: '11111 00001 00010 00100 01000 10000 11111',
  '-': '00000 00000 00000 11111 00000 00000 00000', '.': '00000 00000 00000 00000 00000 00110 00110', ':': '00000 00110 00110 00000 00110 00110 00000',
  '/': '00001 00001 00010 00100 01000 10000 10000', '(': '00010 00100 01000 01000 01000 00100 00010', ')': '01000 00100 00010 00010 00010 00100 01000',
  "'": '00100 00100 01000 00000 00000 00000 00000', ',': '00000 00000 00000 00000 00110 00100 01000', '+': '00000 00100 00100 11111 00100 00100 00000',
  '#': '01010 01010 11111 01010 11111 01010 01010', '?': '01110 10001 00001 00110 00100 00000 00100', '=': '00000 00000 11111 00000 11111 00000 00000',
};
const GLYPH = new Map(Object.entries(FONT).map(([k, v]) => [k, v.split(' ').map((r) => parseInt(r, 2))]));

type RGB = [number, number, number];
function rgb(c: string): RGB {
  const s = c.replace('#', '');
  if (s.length === 3) return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)];
  return [parseInt(s.slice(0, 2), 16) || 0, parseInt(s.slice(2, 4), 16) || 0, parseInt(s.slice(4, 6), 16) || 0];
}

class Raster {
  w: number; h: number; d: Uint8Array;
  constructor(w: number, h: number, bg: string) {
    this.w = w; this.h = h; this.d = new Uint8Array(w * h * 3);
    const [r, g, b] = rgb(bg);
    for (let i = 0; i < w * h; i++) { this.d[i * 3] = r; this.d[i * 3 + 1] = g; this.d[i * 3 + 2] = b; }
  }
  px(x: number, y: number, c: RGB, a: number) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    if (a >= 1) { this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; return; }
    this.d[i] += (c[0] - this.d[i]) * a; this.d[i + 1] += (c[1] - this.d[i + 1]) * a; this.d[i + 2] += (c[2] - this.d[i + 2]) * a;
  }
  rect(x: number, y: number, w: number, h: number, c: RGB, a: number) {
    const x0 = Math.max(0, Math.round(x)), x1 = Math.min(this.w, Math.round(x + w)), y0 = Math.max(0, Math.round(y)), y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.px(xx, yy, c, a);
  }
  poly(pts: number[], c: RGB, a: number) {
    const n = pts.length / 2;
    let miny = Infinity, maxy = -Infinity;
    for (let i = 1; i < pts.length; i += 2) { miny = Math.min(miny, pts[i]); maxy = Math.max(maxy, pts[i]); }
    const y0 = Math.max(0, Math.floor(miny)), y1 = Math.min(this.h - 1, Math.ceil(maxy));
    const xs: number[] = [];
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5;
      xs.length = 0;
      for (let i = 0; i < n; i++) {
        const ax = pts[i * 2], ay = pts[i * 2 + 1], bx = pts[((i + 1) % n) * 2], by = pts[((i + 1) % n) * 2 + 1];
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = Math.max(0, Math.round(xs[i])), xb = Math.min(this.w, Math.round(xs[i + 1]));
        for (let x = xa; x < xb; x++) this.px(x, y, c, a);
      }
    }
  }
  circle(cx: number, cy: number, r: number, c: RGB, a: number, inner = 0) {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(this.w - 1, Math.ceil(cx + r)), y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(this.h - 1, Math.ceil(cy + r));
    const r2 = r * r, i2 = inner * inner;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d2 = dx * dx + dy * dy;
      if (d2 <= r2 && d2 >= i2) this.px(x, y, c, a);
    }
  }
  line(x1: number, y1: number, x2: number, y2: number, sw: number, c: RGB, a: number) {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (sw / 2), ny = (dx / len) * (sw / 2);
    this.poly([x1 + nx, y1 + ny, x2 + nx, y2 + ny, x2 - nx, y2 - ny, x1 - nx, y1 - ny], c, a);
    if (sw > 3) { this.circle(x1, y1, sw / 2, c, a); this.circle(x2, y2, sw / 2, c, a); }
  }
  text(x: number, y: number, s: string, size: number, c: RGB, anchor: string) {
    const sc = Math.max(1, size / 9);
    const width = s.length * 6 * sc;
    let cx = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
    const top = y - 7 * sc;
    for (const ch of s.toUpperCase()) {
      const g = GLYPH.get(ch);
      if (g) for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) if (g[row] & (1 << (4 - col))) this.rect(cx + col * sc, top + row * sc, sc + 0.5, sc + 0.5, c, 1);
      cx += 6 * sc;
    }
  }
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** The map as a PNG, at most `max` pixels on its long side. Pure JS: shapes are drawn 2x then averaged down. */
export function toPng(c: Canvas, o: { gm?: boolean; max?: number } = {}): Buffer {
  const f = Math.min(1.5, (o.max ?? 1400) / Math.max(c.w, c.h));
  const ow = Math.max(1, Math.round(c.w * f)), oh = Math.max(1, Math.round(c.h * f));
  const SS = 2, k = f * SS;
  const R = new Raster(ow * SS, oh * SS, c.bg);
  for (const op of c.ops) {
    if (op.gm && !o.gm) continue;
    const a = 'a' in op && op.a !== undefined ? op.a : 1;
    switch (op.t) {
      case 'rect': {
        if (op.fill) R.rect(op.x * k, op.y * k, op.w * k, op.h * k, rgb(op.fill), a);
        if (op.stroke) {
          const s = (op.sw ?? 1) * k, c2 = rgb(op.stroke);
          R.rect(op.x * k - s / 2, op.y * k - s / 2, op.w * k + s, s, c2, 1); R.rect(op.x * k - s / 2, (op.y + op.h) * k - s / 2, op.w * k + s, s, c2, 1);
          R.rect(op.x * k - s / 2, op.y * k - s / 2, s, op.h * k + s, c2, 1); R.rect((op.x + op.w) * k - s / 2, op.y * k - s / 2, s, op.h * k + s, c2, 1);
        }
        break;
      }
      case 'circle':
        if (op.fill) R.circle(op.x * k, op.y * k, op.r * k, rgb(op.fill), a);
        if (op.stroke) { const s = (op.sw ?? 1) * k; R.circle(op.x * k, op.y * k, op.r * k + s / 2, rgb(op.stroke), 1, Math.max(0, op.r * k - s / 2)); }
        break;
      case 'poly': {
        const pts = op.pts.map((v) => v * k);
        if (op.fill && pts.length >= 6) R.poly(pts, rgb(op.fill), a);
        if (op.stroke) {
          const n = pts.length / 2, cl = op.close !== false;
          for (let i = 0; i < (cl ? n : n - 1); i++) R.line(pts[i * 2], pts[i * 2 + 1], pts[((i + 1) % n) * 2], pts[((i + 1) % n) * 2 + 1], (op.sw ?? 1) * k, rgb(op.stroke), 1);
        }
        break;
      }
      case 'lines': { const col = rgb(op.stroke); for (let i = 0; i + 3 < op.segs.length; i += 4) R.line(op.segs[i] * k, op.segs[i + 1] * k, op.segs[i + 2] * k, op.segs[i + 3] * k, op.sw * k, col, a); break; }
      case 'text': R.text(op.x * k, op.y * k, op.s, op.size * k, rgb(op.fill), op.anchor ?? 'start'); break;
    }
  }
  // Average each SS x SS block, then PNG-encode with the "Sub" filter.
  const row = ow * 3;
  const raw = Buffer.alloc((row + 1) * oh);
  for (let y = 0; y < oh; y++) {
    const base = y * (row + 1);
    raw[base] = 1;
    for (let x = 0; x < ow; x++) for (let ch = 0; ch < 3; ch++) {
      let sum = 0;
      for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) sum += R.d[((y * SS + dy) * R.w + x * SS + dx) * 3 + ch];
      raw[base + 1 + x * 3 + ch] = Math.round(sum / (SS * SS));
    }
    for (let i = row - 1; i >= 3; i--) raw[base + 1 + i] = (raw[base + 1 + i] - raw[base + 1 + i - 3]) & 0xff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ow, 0); ihdr.writeUInt32BE(oh, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))]);
}

// ---- helpers the generators share ----------------------------------------

/** Merge a set of cells into horizontal runs: [x, y, length]. */
export function runs(cells: Iterable<[number, number]>): [number, number, number][] {
  const rows = new Map<number, number[]>();
  for (const [x, y] of cells) { const r = rows.get(y); if (r) r.push(x); else rows.set(y, [x]); }
  const out: [number, number, number][] = [];
  for (const [y, xs] of [...rows].sort((a, b) => a[0] - b[0])) {
    xs.sort((a, b) => a - b);
    let s = xs[0], p = xs[0];
    for (let i = 1; i <= xs.length; i++) {
      if (i < xs.length && xs[i] === p + 1) { p = xs[i]; continue; }
      out.push([s, y, p - s + 1]);
      s = xs[i]; p = xs[i];
    }
  }
  return out;
}
