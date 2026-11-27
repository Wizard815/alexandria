// Cave: cellular automata on a 5 ft grid, keeping only the largest open
// region so every chamber connects; chambers are picked far apart and numbered.
import { chance, int, makeRng, pick, seedOf } from '../../quickgen/rng.ts';
import { type Canvas, newCanvas, runs } from './canvas.ts';
import { CAVE_FEATURES, CAVE_OCCUPANTS, CAVE_ROOMS, DUNGEON_HAZARD, DUNGEON_LOOT } from './tables.ts';
import { type KeyEntry, type MapOpts, type MapResult, cap, flood, sizeOf } from './util.ts';
import { placeName } from '../names.ts';

const CELL = 16, PX = 16, PY = 36;
const DIMS = { small: { w: 48, h: 32, k: 4 }, medium: { w: 68, h: 44, k: 7 }, large: { w: 88, h: 58, k: 10 } };

export function genCave(o: MapOpts = {}): MapResult {
  const seed = seedOf(o.seed);
  const size = sizeOf(o.size);
  const { w: W, h: H, k: want } = DIMS[size];
  const wet = o.flavour === 'flooded';
  let open = new Uint8Array(W * H);
  let best: Uint8Array | null = null;
  for (let attempt = 0; attempt < 12 && !best; attempt++) {
    const r = makeRng(`${seed}|cave|${size}|${attempt}`);
    for (let i = 0; i < W * H; i++) { const x = i % W, y = (i - x) / W; open[i] = x < 2 || y < 2 || x >= W - 2 || y >= H - 2 ? 0 : r() < 0.54 ? 1 : 0; }
    for (let step = 0; step < 5; step++) {
      const next = new Uint8Array(W * H);
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        let walls = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && !open[(y + dy) * W + x + dx]) walls++;
        next[y * W + x] = walls >= 5 ? 0 : walls <= 3 ? 1 : open[y * W + x];
      }
      open = next;
    }
    // keep the biggest connected region
    const seen = new Uint8Array(W * H);
    let bestRegion: Uint8Array | null = null, bestN = 0;
    for (let i = 0; i < W * H; i++) {
      if (!open[i] || seen[i]) continue;
      const reg = flood(W, H, [i % W, Math.floor(i / W)], (x, y) => open[y * W + x] === 1);
      let n = 0;
      for (let j = 0; j < reg.length; j++) if (reg[j]) { seen[j] = 1; n++; }
      if (n > bestN) { bestN = n; bestRegion = reg; }
    }
    if (bestRegion && bestN > W * H * 0.28) best = bestRegion;
  }
  // A last resort that always works: a rough oval.
  if (!best) {
    best = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (((x - W / 2) / (W / 2.6)) ** 2 + ((y - H / 2) / (H / 2.6)) ** 2 < 1) best[y * W + x] = 1;
  }
  const floor = best;
  const isOpen = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && floor[y * W + x] === 1;

  // ---- chambers: far-apart points inside the cave, numbered from the entrance ----
  const r = makeRng(`${seed}|cave-key|${size}`);
  const cells: [number, number][] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isOpen(x, y)) cells.push([x, y]);
  // entrance: the open cell nearest the left edge
  let entrance = cells[0];
  for (const c of cells) if (c[0] < entrance[0]) entrance = c;
  const pts: [number, number][] = [entrance];
  while (pts.length < want) {
    let bestC = cells[0], bd = -1;
    for (let i = 0; i < 60; i++) {
      const c = cells[int(r, 0, cells.length - 1)];
      const d = Math.min(...pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
      if (d > bd) { bd = d; bestC = c; }
    }
    pts.push(bestC);
  }
  const reachedSet = flood(W, H, entrance, isOpen);
  const reached = pts.filter((p) => reachedSet[p[1] * W + p[0]]).length;

  // ---- draw ----
  const pal = wet ? { floor: '#d6dfd6', rock: '#4a4f52', wall: '#171a1c', bg: '#c4cfd0', water: '#8db6c9' } : { floor: '#e6d9bd', rock: '#4a3f33', wall: '#1d1812', bg: '#d8cbaa', water: '#8db6c9' };
  const c: Canvas = newCanvas(W * CELL + PX * 2, H * CELL + PY + 28, pal.bg);
  const X = (x: number) => PX + x * CELL, Y = (y: number) => PY + y * CELL;
  c.ops.push({ t: 'rect', x: PX, y: PY, w: W * CELL, h: H * CELL, fill: pal.rock });
  for (const [x, y, n] of runs(cells)) c.ops.push({ t: 'rect', x: X(x), y: Y(y), w: n * CELL + 0.6, h: CELL + 0.6, fill: pal.floor });
  // a few pools of water
  const pools = size === 'small' ? 1 : 3;
  const waterCells = new Set<number>();
  for (let p = 0; p < pools; p++) {
    const [px, py] = cells[int(r, 0, cells.length - 1)];
    for (let dy = -3; dy <= 3; dy++) for (let dx = -4; dx <= 4; dx++) if (isOpen(px + dx, py + dy) && (dx / 4) ** 2 + (dy / 3) ** 2 + (r() - 0.5) * 0.5 < 1) waterCells.add((py + dy) * W + px + dx);
  }
  waterCells.delete(entrance[1] * W + entrance[0]);
  for (const [x, y, n] of runs([...waterCells].map((i) => [i % W, Math.floor(i / W)] as [number, number]))) c.ops.push({ t: 'rect', x: X(x), y: Y(y), w: n * CELL + 0.6, h: CELL + 0.6, fill: pal.water, a: 0.85 });
  const grid: number[] = [];
  for (const [x, y, n] of runs(cells)) { grid.push(X(x), Y(y), X(x + n), Y(y)); for (let i = 0; i <= n; i++) grid.push(X(x + i), Y(y), X(x + i), Y(y + 1)); }
  c.ops.push({ t: 'lines', segs: grid, stroke: '#000000', sw: 0.6, a: 0.12 });
  const walls: number[] = [];
  for (let y = 0; y <= H; y++) for (let x = 0; x <= W; x++) {
    const a = isOpen(x, y), right = isOpen(x + 1, y), down = isOpen(x, y + 1);
    if (a !== right && x < W) walls.push(X(x + 1), Y(y), X(x + 1), Y(y + 1));
    if (a !== down && y < H) walls.push(X(x), Y(y + 1), X(x + 1), Y(y + 1));
  }
  c.ops.push({ t: 'lines', segs: walls, stroke: pal.wall, sw: 3 });

  const key: KeyEntry[] = [];
  const names = new Set<string>();
  pts.forEach(([x, y], i) => {
    let room = pick(r, CAVE_ROOMS);
    for (let t = 0; t < 8 && names.has(room); t++) room = pick(r, CAVE_ROOMS);
    names.add(room);
    const entry = i === 0;
    const gm = [`Occupants: ${pick(r, CAVE_OCCUPANTS)}.`];
    if (chance(r, 0.35)) gm.push(`Hazard: ${pick(r, DUNGEON_HAZARD)}.`);
    if (chance(r, 0.3)) gm.push(`Treasure: ${pick(r, DUNGEON_LOOT)}.`);
    key.push({ n: String(i + 1), name: entry ? 'Cave mouth' : cap(room.replace(/^(a|an) /, '')), text: `${entry ? 'Daylight fades here as the passage narrows. ' : ''}${cap(room)}; ${pick(r, CAVE_FEATURES)}.`, gm: gm.join(' ') });
    const mx = X(x) + CELL / 2, my = Y(y) + CELL / 2;
    c.ops.push({ t: 'circle', x: mx, y: my, r: 10, fill: '#fffaf0', stroke: pal.wall, sw: 1.4 });
    c.ops.push({ t: 'text', x: mx, y: my + 4, s: String(i + 1), size: i > 8 ? 10 : 12, fill: '#1f1b18', anchor: 'middle', bold: true });
  });
  const title = placeName('dungeon', 'common', r, o.avoid).replace(/^The \w+ of/, 'The Caverns of');
  c.ops.push({ t: 'text', x: PX, y: 24, s: title, size: 18, fill: '#2a2218', bold: true });
  c.ops.push({ t: 'text', x: PX, y: PY + H * CELL + 18, s: `Cave · ${size} · seed ${seed} · 1 square = 5 ft`, size: 11, fill: '#3a3128' });
  return {
    kind: 'cave', seed, size, flavour: wet ? 'flooded' : 'dry', title, ftPerCell: 5, canvas: c, key,
    legend: ['Blue: shallow water (difficult terrain)', 'Numbers: chambers in the key'],
    stats: { rooms: pts.length, total: pts.length, reached, connected: reached === pts.length, openCells: cells.length, width: W, height: H },
  };
}
