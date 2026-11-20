// Draws Alexandria's app icons (a gold "A" on the dark theme colour) into
// web/public/icons as PNGs, using only built-in modules.
// Run from web/: node scripts/make-icons.mjs   (the PNGs are committed)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const out = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/icons');
fs.mkdirSync(out, { recursive: true });
const BG = [0x12, 0x16, 0x1f], GOLD = [0xd9, 0xb2, 0x6a];

// The glyph lives in a 100x100 box.
function inGlyph(x, y) {
  const apex = [50, 14], bl = [22, 86], br = [78, 86], t = 11;
  const dist = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy);
  };
  const p = [x, y];
  if (dist(p, apex, bl) < t / 2 || dist(p, apex, br) < t / 2) return true;
  return y > 58 && y < 67 && x > 33 && x < 67; // crossbar
}

let table;
function crc(buf) {
  table ??= Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, 'latin1');
  data.copy(b, 8);
  b.writeUInt32BE(crc(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}

function png(size, maskable) {
  const scale = maskable ? 0.58 : 0.78; // maskable keeps the glyph inside the safe circle
  const ss = 3, stride = size * 3 + 1, raw = Buffer.alloc(stride * size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const fx = px + (sx + 0.5) / ss, fy = py + (sy + 0.5) / ss;
        if (inGlyph((fx / size - 0.5) / scale * 100 + 50, (fy / size - 0.5) / scale * 100 + 50)) hits++;
        else if (!maskable) { const r = Math.hypot(fx - size / 2, fy - size / 2) / size; if (r > 0.455 && r < 0.485) hits++; }
      }
      const a = hits / (ss * ss), o = py * stride + 1 + px * 3;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BG[c] * (1 - a) + GOLD[c] * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['maskable-192.png', 192, true], ['maskable-512.png', 512, true], ['apple-touch-icon.png', 180, true]]) {
  fs.writeFileSync(path.join(out, name), png(size, maskable));
  console.log('wrote', name);
}
