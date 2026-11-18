// City / town: a walled outline with gates, roads to a market square, a ring
// road, an optional river with bridges, districts (coloured), blocks of
// buildings and numbered landmarks with generated names. Not on a battle grid.
import { chance, int, makeRng, pick, seedOf } from '../../quickgen/rng.ts';
import { placeName, type PlaceKind } from '../names.ts';
import { type Canvas, newCanvas } from './canvas.ts';
import { CITY_DISTRICTS, CITY_DISTRICT_COLOURS, CITY_LANDMARKS } from './tables.ts';
import { type KeyEntry, type MapOpts, type MapResult, cap, makeNoise, rnd, sizeOf } from './util.ts';

const PX = 16, PY = 40;
const W = 960, H = 720;
const SIZE = { small: { dist: 4, lm: 7, cell: 20, rx: 330, ry: 250 }, medium: { dist: 6, lm: 10, cell: 17, rx: 400, ry: 300 }, large: { dist: 8, lm: 12, cell: 15, rx: 430, ry: 320 } };

const inPoly = (x: number, y: number, p: number[]) => {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    if ((p[i + 1] > y) !== (p[j + 1] > y) && x < ((p[j] - p[i]) * (y - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) inside = !inside;
  }
  return inside;
};
const distSeg = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

interface LandmarkKind { kind: string; name: (r: () => number, avoid?: Set<string>) => string; note: string }

export function genCity(o: MapOpts = {}): MapResult {
  const seed = seedOf(o.seed);
  const size = sizeOf(o.size);
  const S = SIZE[size];
  const r = makeRng(`${seed}|city|${size}`);
  const noise = makeNoise(r);
  const c: Canvas = newCanvas(W + PX * 2, H + PY + 30, '#e9e2cf');
  const X = (x: number) => PX + x, Y = (y: number) => PY + y;
  c.ops.push({ t: 'rect', x: PX, y: PY, w: W, h: H, fill: '#cfdcae' });
  // a few fields and trees outside
  for (let i = 0; i < 26; i++) { const x = rnd(r, 10, W - 10), y = rnd(r, 10, H - 10); c.ops.push({ t: 'circle', x: X(x), y: Y(y), r: rnd(r, 5, 9), fill: '#7aa65c', stroke: '#47693a', sw: 1.2 }); }
  const cx = W / 2, cy = H / 2;

  // ---- outline ----
  const N = 56;
  const outline: number[] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const k = 0.84 + noise(Math.cos(a) * 1.4 + 3, Math.sin(a) * 1.4 + 3, 3) * 0.3;
    outline.push(cx + Math.cos(a) * S.rx * k, cy + Math.sin(a) * S.ry * k);
  }
  const inside = (x: number, y: number) => inPoly(x, y, outline);

  // ---- river (optional) ----
  const hasRiver = chance(r, 0.6);
  const river: [number, number][] = [];
  if (hasRiver) {
    const horizontal = chance(r, 0.5);
    const off = rnd(r, -0.18, 0.18);
    for (let i = 0; i <= 40; i++) {
      const t = i / 40, wob = (noise(t * 3, seed.length, 2) - 0.5) * 120;
      river.push(horizontal ? [t * W, H * (0.5 + off) + wob] : [W * (0.5 + off) + wob, t * H]);
    }
  }
  const riverDist = (x: number, y: number) => river.length ? Math.min(...river.map(([a, b]) => Math.hypot(a - x, b - y))) : 999;

  // ---- ground, river ----
  c.ops.push({ t: 'poly', pts: outline.map((v, i) => (i % 2 ? Y(v) : X(v))), fill: '#e6dcc0' });
  if (hasRiver) {
    const segs: number[] = [];
    for (let i = 1; i < river.length; i++) segs.push(X(river[i - 1][0]), Y(river[i - 1][1]), X(river[i][0]), Y(river[i][1]));
    c.ops.push({ t: 'lines', segs, stroke: '#c9bf94', sw: 46 }, { t: 'lines', segs, stroke: '#8fbad0', sw: 36 });
  }

  // ---- roads ----
  const roads: [number, number, number, number][] = [];
  const gateAngles = [rnd(r, 0, 1), rnd(r, 2, 3), rnd(r, 4, 5.3)];
  if (size !== 'small') gateAngles.push(rnd(r, 1.4, 1.8) + 3.1);
  const edgePoint = (a: number): [number, number] => {
    let rad = 40;
    while (rad < 700 && inside(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad)) rad += 4;
    return [cx + Math.cos(a) * (rad - 4), cy + Math.sin(a) * (rad - 4)];
  };
  const gates = gateAngles.map(edgePoint);
  const plaza = 46;
  for (const [gx, gy] of gates) {
    let px = gx, py = gy;
    for (let i = 1; i <= 8; i++) {
      const t = i / 8, nx = gx + (cx - gx) * t + (noise(gx * 0.01 + t * 4, gy * 0.01, 2) - 0.5) * 50 * Math.sin(t * Math.PI), ny = gy + (cy - gy) * t + (noise(gy * 0.01, gx * 0.01 + t * 4, 2) - 0.5) * 50 * Math.sin(t * Math.PI);
      roads.push([px, py, nx, ny]);
      px = nx; py = ny;
    }
  }
  // ring road at ~55 per cent
  const ring: [number, number][] = [];
  for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI * 2; const rr = 0.52 + (noise(Math.cos(a) * 2, Math.sin(a) * 2, 2) - 0.5) * 0.14; ring.push([cx + Math.cos(a) * S.rx * rr, cy + Math.sin(a) * S.ry * rr]); }
  for (let i = 1; i < ring.length; i++) roads.push([ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]]);
  const roadDist = (x: number, y: number) => Math.min(Math.hypot(x - cx, y - cy) - plaza, ...roads.map(([a, b, d, e]) => distSeg(x, y, a, b, d, e)));

  // ---- districts: random centres, nearest wins ----
  const names = [...CITY_DISTRICTS].sort(() => r() - 0.5);
  const dist: { name: string; x: number; y: number }[] = [{ name: 'Market quarter', x: cx, y: cy }];
  for (let tries = 0; dist.length < S.dist && tries < 400; tries++) {
    const x = rnd(r, 60, W - 60), y = rnd(r, 60, H - 60);
    if (!inside(x, y) || dist.some((d) => Math.hypot(d.x - x, d.y - y) < 140)) continue;
    const nm = names.find((n) => !dist.some((d) => d.name === n));
    if (nm) dist.push({ name: nm, x, y });
  }
  if (hasRiver) {
    const others = dist.filter((q) => q.name !== 'Market quarter' && q.name !== 'Dockside');
    const near = others.sort((a, b) => riverDist(a.x, a.y) - riverDist(b.x, b.y))[0];
    if (near && !dist.some((q) => q.name === 'Dockside')) near.name = 'Dockside';
  }
  const districtAt = (x: number, y: number) => dist.reduce((b, d) => (Math.hypot(d.x - x, d.y - y) < Math.hypot(b.x - x, b.y - y) ? d : b));

  // ---- buildings ----
  const cell = S.cell;
  const shade = (hex: string, k: number) => { const n = parseInt(hex.slice(1), 16); const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k))).toString(16).padStart(2, '0'); return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`; };
  for (let gy = 6; gy < H - 6; gy += cell) for (let gx = 6; gx < W - 6; gx += cell) {
    const x = gx + rnd(r, -2, 2), y = gy + rnd(r, -2, 2);
    if (!inside(x, y) || !inPoly(x + 5, y + 5, outline) || roadDist(x, y) < 9 || riverDist(x, y) < 30 || Math.hypot(x - cx, y - cy) < plaza + 8 || chance(r, 0.1)) continue;
    const d = districtAt(x, y);
    const base = CITY_DISTRICT_COLOURS[d.name] ?? '#d8cdb0';
    const w = cell * rnd(r, 0.6, 0.85), h = cell * rnd(r, 0.6, 0.85);
    c.ops.push({ t: 'rect', x: X(x), y: Y(y), w, h, fill: shade(base, 0.9 + r() * 0.12), stroke: '#5a4d3a', sw: 0.8 });
  }
  // roads on top of the ground and under walls
  const rsegs: number[] = [];
  for (const [a, b, d, e] of roads) rsegs.push(X(a), Y(b), X(d), Y(e));
  c.ops.push({ t: 'lines', segs: rsegs, stroke: '#a89873', sw: 9 }, { t: 'lines', segs: rsegs, stroke: '#cdbf94', sw: 6 });
  // market square
  c.ops.push({ t: 'circle', x: X(cx), y: Y(cy), r: plaza, fill: '#d9c9a0', stroke: '#8a7a54', sw: 2 });
  c.ops.push({ t: 'circle', x: X(cx), y: Y(cy), r: 9, fill: '#8fbad0', stroke: '#3d5a68', sw: 1.6 });
  // bridges where a road crosses the river
  const bridges: [number, number][] = [];
  if (hasRiver) for (const [a, b, d, e] of roads) {
    const mx = (a + d) / 2, my = (b + e) / 2;
    if (riverDist(mx, my) < 22 && Math.hypot(mx - cx, my - cy) > plaza && bridges.every(([p, q]) => Math.hypot(p - mx, q - my) > 60)) {
      bridges.push([mx, my]);
      c.ops.push({ t: 'rect', x: X(mx) - 11, y: Y(my) - 11, w: 22, h: 22, fill: '#a8793f', stroke: '#4d3418', sw: 1.6 });
    }
  }
  // wall, towers, gates
  c.ops.push({ t: 'poly', pts: outline.map((v, i) => (i % 2 ? Y(v) : X(v))), stroke: '#4a4339', sw: 6 });
  for (let i = 0; i < N; i += 7) c.ops.push({ t: 'circle', x: X(outline[i * 2]), y: Y(outline[i * 2 + 1]), r: 8, fill: '#e8e1cf', stroke: '#2a2520', sw: 2 });
  for (const [gx, gy] of gates) c.ops.push({ t: 'rect', x: X(gx) - 9, y: Y(gy) - 9, w: 18, h: 18, fill: '#e8e1cf', stroke: '#2a2520', sw: 2.4 });

  // ---- landmarks ----
  const avoid = o.avoid ?? new Set<string>();
  const K = (kind: PlaceKind, flavour = 'common') => (rr: () => number, av?: Set<string>) => placeName(kind, flavour, rr, av);
  const KINDS: LandmarkKind[] = CITY_LANDMARKS.map(([nm, note]) => {
    const kind = nm.includes('temple') ? K('temple') : nm.includes('guild') ? K('guild') : nm.includes('keep') ? K('keep') : () => nm.replace(/^The /, 'The ');
    return { kind: nm, name: kind as LandmarkKind['name'], note };
  });
  const extra: LandmarkKind[] = [
    { kind: 'An inn', name: K('inn'), note: 'Beds, a loud common room and a landlord who hears everything.' },
    { kind: 'A smithy', name: K('smithy'), note: 'A forge, a ring of hammered iron signs and an apprentice who never sleeps.' },
    { kind: 'A magic shop', name: K('magic shop'), note: 'Curios behind glass, a cat on the counter and a back room that is always locked.' },
  ];
  const all = [...extra, ...KINDS].sort(() => r() - 0.5);
  const key: KeyEntry[] = [];
  const spots: [number, number][] = [[cx, cy]];
  const landmarks: { n: number; x: number; y: number; name: string; kind: string }[] = [];
  const lmCount = Math.min(S.lm, all.length);
  for (let i = 0; i < lmCount; i++) {
    let x = cx, y = cy;
    for (let t = 0; t < 120; t++) {
      const px = rnd(r, 40, W - 40), py = rnd(r, 40, H - 40);
      if (inside(px, py) && riverDist(px, py) > 40 && spots.every(([a, b]) => Math.hypot(a - px, b - py) > 70) && Math.hypot(px - cx, py - cy) > plaza + 20) { x = px; y = py; break; }
    }
    if (x === cx) continue;
    spots.push([x, y]);
    const lm = all[i];
    const nm = lm.name(r, avoid);
    const dName = districtAt(x, y).name;
    landmarks.push({ n: landmarks.length + 1, x, y, name: nm, kind: lm.kind });
    c.ops.push({ t: 'circle', x: X(x), y: Y(y), r: 15, fill: '#fffaf0', stroke: '#2a2520', sw: 1.8 });
    c.ops.push({ t: 'text', x: X(x), y: Y(y) + 4, s: String(landmarks.length), size: 12, fill: '#1f1b18', anchor: 'middle', bold: true });
    key.push({ n: String(landmarks.length), name: nm === lm.kind ? nm : `${nm}`, text: `${lm.kind === nm ? '' : cap(lm.kind) + '. '}${lm.note} Found in the ${dName}.`, dm: chance(r, 0.5) ? pick(r, ['A rival asks for a favour here.', 'The person in charge is being blackmailed.', 'A locked room holds something the watch would like to find.', 'A stranger waits here with a message for the party.', 'An old debt will come due on this doorstep.']) : undefined });
  }
  c.ops.push({ t: 'text', x: X(cx), y: Y(cy) + 28, s: 'MARKET', size: 10, fill: '#5a4d3a', anchor: 'middle', bold: true });
  dist.forEach((d, i) => {
    if (d.name === 'Market quarter') { key.push({ n: `D${i + 1}`, name: d.name, text: 'The great square and the busiest streets around it.' }); return; }
    key.push({ n: `D${i + 1}`, name: d.name, text: pick(r, ['Crowded, loud and busy from dawn.', 'Quiet streets of tall, narrow houses.', 'Cobbled lanes, smoke from many chimneys.', 'Mostly workshops, with the clatter to prove it.', 'Wide streets, high walls and few windows at street level.', 'Old and crooked, with more alleys than streets.']) });
    c.ops.push({ t: 'text', x: X(d.x), y: Y(d.y) + 3, s: d.name.toUpperCase(), size: 9, fill: '#3a2f20', anchor: 'middle', bold: true, dm: false });
  });
  const title = o.title ?? placeName('town', 'common', r, avoid);
  c.ops.push({ t: 'text', x: PX, y: 26, s: title, size: 20, fill: '#2a2218', bold: true });
  c.ops.push({ t: 'text', x: PX, y: PY + H + 20, s: `Town · ${size} · seed ${seed} · ${gates.length} gates${hasRiver ? ' · river' : ''}`, size: 11, fill: '#3a3128' });
  void int;
  return {
    kind: 'city', seed, size, flavour: hasRiver ? 'river town' : 'town', title, ftPerCell: null, canvas: c, key,
    legend: ['Square on the wall: gate', 'Grey stone ring: wall and towers', 'Brown squares over water: bridges', 'Coloured blocks: districts', 'Numbers: landmarks'],
    stats: { gates: gates.length, landmarks: landmarks.length, districts: dist.length, river: hasRiver, total: gates.length, reached: gates.length, connected: true, buildings: c.ops.length },
  };
}
