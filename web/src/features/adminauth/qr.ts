// A small QR code encoder: byte mode, error correction level M, versions
// 1 to 10 (up to 213 bytes at version 10, plenty for an otpauth:// URI).
// qrMatrix() returns the modules; qrSvg() draws them.

// Per version (index 1..10): data codewords per block group and EC codewords per block, level M.
// groups: [blockCount, dataCodewordsPerBlock][]
const VERSIONS: { ec: number; groups: [number, number][] }[] = [
  { ec: 0, groups: [] },
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
];
const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const dataCapacity = (v: number) => VERSIONS[v].groups.reduce((n, [b, d]) => n + b * d, 0);

// GF(256) with the QR polynomial 0x11D.
const EXP = new Array<number>(512);
const LOG = new Array<number>(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsRemainder(data: number[], ecLen: number): number[] {
  // Generator polynomial (x - a^0)(x - a^1)...(x - a^(ecLen-1)), highest degree first without the leading 1.
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= mul(gen[j], EXP[i]); }
    gen = next;
  }
  const rem = new Array<number>(ecLen).fill(0);
  for (const b of data) {
    const f = b ^ rem.shift()!;
    rem.push(0);
    if (f !== 0) for (let i = 0; i < ecLen; i++) rem[i] ^= mul(gen[i + 1], f);
  }
  return rem;
}

function utf8(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

function makeCodewords(bytes: number[], version: number): number[] {
  const cap = dataCapacity(version);
  const bits: number[] = [];
  const put = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);

  const { ec, groups } = VERSIONS[version];
  const blocks: { data: number[]; ecc: number[] }[] = [];
  let at = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      const d = data.slice(at, at + len);
      at += len;
      blocks.push({ data: d, ecc: rsRemainder(d, ec) });
    }
  }
  const out: number[] = [];
  const maxLen = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ecc[i]);
  return out;
}

const bchFormat = (data: number) => {
  let r = data << 10;
  for (let i = 14; i >= 10; i--) if ((r >>> i) & 1) r ^= 0x537 << (i - 10);
  return ((data << 10) | r) ^ 0x5412;
};
const bchVersion = (v: number) => {
  let r = v << 12;
  for (let i = 17; i >= 12; i--) if ((r >>> i) & 1) r ^= 0x1f25 << (i - 12);
  return (v << 12) | r;
};

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(m: boolean[][]): number {
  const n = m.length;
  let p = 0;
  const runs = (line: boolean[]) => {
    let s = 0, run = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++;
      else { if (run >= 5) s += run - 2; run = 1; }
    }
    return s;
  };
  const finder = (line: boolean[]) => {
    let s = 0;
    const a = [true, false, true, true, true, false, true, false, false, false, false];
    const b = [false, false, false, false, true, false, true, true, true, false, true];
    for (let i = 0; i + 11 <= line.length; i++) {
      if (a.every((v, k) => line[i + k] === v)) s += 40;
      if (b.every((v, k) => line[i + k] === v)) s += 40;
    }
    return s;
  };
  for (let i = 0; i < n; i++) {
    const row = m[i];
    const col = m.map((r) => r[i]);
    p += runs(row) + runs(col) + finder(row) + finder(col);
  }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) p += 3;
  const dark = m.reduce((s, r) => s + r.filter(Boolean).length, 0);
  p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return p;
}

/** The QR modules (true = dark). Throws when the text is too long for version 10. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = utf8(text);
  let version = 1;
  // Header bits: 4 mode + count; must fit in the data codewords.
  const fits = (v: number) => Math.ceil((4 + (v >= 10 ? 16 : 8) + bytes.length * 8) / 8) <= dataCapacity(v);
  while (version <= 10 && !fits(version)) version++;
  if (version > 10) throw new Error('Text is too long for the QR code');
  const n = 17 + 4 * version;
  const cw = makeCodewords(bytes, version);

  const mods: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const fn: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const set = (r: number, c: number, dark: boolean) => { mods[r][c] = dark; fn[r][c] = true; };

  const finder = (r0: number, c0: number) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || c < 0 || r >= n || c >= n) continue;
      const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      set(r, c, inside && Math.max(Math.abs(dr - 3), Math.abs(dc - 3)) !== 2);
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const pos = ALIGN[version];
  for (const ar of pos) for (const ac of pos) {
    if ((ar === 6 && ac === 6) || (ar === 6 && ac === pos[pos.length - 1]) || (ac === 6 && ar === pos[pos.length - 1])) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(ar + dr, ac + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  // Reserve format and version areas; real bits are written per mask below.
  const reserve = () => {
    for (let i = 0; i < 9; i++) { fn[8][i] = true; fn[i][8] = true; }
    for (let i = 0; i < 8; i++) { fn[8][n - 1 - i] = true; fn[n - 1 - i][8] = true; }
    set(n - 8, 8, true); // the always-dark module
    if (version >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { fn[i][n - 11 + j] = true; fn[n - 11 + j][i] = true; }
  };
  reserve();

  // Place data bits in the zigzag, right to left in column pairs, skipping column 6.
  const bits: boolean[] = [];
  for (const b of cw) for (let i = 7; i >= 0; i--) bits.push(((b >>> i) & 1) === 1);
  const placed: boolean[][] = mods.map((r) => r.slice());
  let k = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const up = ((right + 1) & 2) === 0;
        const r = up ? n - 1 - vert : vert;
        if (!fn[r][c]) { placed[r][c] = k < bits.length ? bits[k] : false; k++; }
      }
    }
  }

  const build = (mask: number) => {
    const m = placed.map((row) => row.slice());
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (!fn[r][c] && MASKS[mask](r, c)) m[r][c] = !m[r][c];
    // Format info: level M = 00, then the mask.
    const f = bchFormat((0b00 << 3) | mask);
    const bit = (i: number) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
    m[7][8] = bit(6); m[8][8] = bit(7); m[8][7] = bit(8);
    for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i++) m[8][n - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) m[n - 15 + i][8] = bit(i);
    m[n - 8][8] = true;
    if (version >= 7) {
      const v = bchVersion(version);
      for (let i = 0; i < 18; i++) {
        const b = ((v >>> i) & 1) === 1;
        const a = Math.floor(i / 3), c = (i % 3) + n - 11;
        m[a][c] = b; m[c][a] = b;
      }
    }
    return m;
  };

  let best = build(0), bestP = penalty(best);
  for (let mask = 1; mask < 8; mask++) {
    const m = build(mask);
    const p = penalty(m);
    if (p < bestP) { best = m; bestP = p; }
  }
  return best;
}

/** An SVG path string for the dark modules, plus the size (with a 4-module quiet zone). */
export function qrSvg(text: string, px = 220): string {
  const m = qrMatrix(text);
  const q = 4, size = m.length + q * 2;
  let d = '';
  for (let r = 0; r < m.length; r++) {
    let c = 0;
    while (c < m.length) {
      if (!m[r][c]) { c++; continue; }
      let e = c;
      while (e < m.length && m[r][e]) e++;
      d += `M${c + q} ${r + q}h${e - c}v1h${c - e}z`;
      c = e;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
