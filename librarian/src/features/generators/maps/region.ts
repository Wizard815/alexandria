// World / region: a noise heightmap with an island falloff becomes sea, beach,
// plains, forest, hills, mountains and snow; rivers run downhill from the
// peaks; towns are placed on good land and joined by roads; a few features are
// keyed. Not on a battle grid.
import { chance, int, makeRng, pick, seedOf } from '../../quickgen/rng.ts';
import { placeName } from '../names.ts';
import { type Canvas, newCanvas, runs } from './canvas.ts';
import { REGION_FEATURES, REGION_TOWN_NOTE } from './tables.ts';
import { type KeyEntry, type MapOpts, type MapResult, cap, makeNoise, sizeOf } from './util.ts';

const PX = 16, PY = 40, CELL = 10;
const DIMS = { small: { w: 80, h: 54, towns: 6, feats: 4 }, medium: { w: 104, h: 70, towns: 9, feats: 6 }, large: { w: 128, h: 86, towns: 13, feats: 8 } };
const COL = { deep: '#5b8db4', shallow: '#82b2cf', beach: '#e6d9a8', plains: '#b9cc82', grass: '#93bb68', forest: '#5f8f4f', swamp: '#6d8a64', hills: '#b3b588', rock: '#9a938a', snow: '#f0f0f0', dry: '#d9c98b' };

export function genRegion(o: MapOpts = {}): MapResult {
  const seed = seedOf(o.seed);
  const size = sizeOf(o.size);
  const { w: W, h: H, towns: nTowns, feats } = DIMS[size];
  const r = makeRng(`${seed}|region|${size}`);
  const nh = makeNoise(makeRng(`${seed}|h`)), nm = makeNoise(makeRng(`${seed}|m`));
  const e = new Float32Array(W * H), m = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (x / W - 0.5) * 2, dy = (y / H - 0.5) * 2;
    const d = Math.min(1.4, Math.sqrt(dx * dx * 0.9 + dy * dy * 1.1));
    e[y * W + x] = nh(x * 0.055, y * 0.055, 5) * 0.68 + (1 - d * d) * 0.5 - 0.02;
    m[y * W + x] = nm(x * 0.07 + 40, y * 0.07 + 40, 4);
  }
  const SEA = 0.4;
  const land = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && e[y * W + x] >= SEA;
  const biome = (x: number, y: number): keyof typeof COL => {
    const v = e[y * W + x], mo = m[y * W + x];
    if (v < 0.3) return 'deep';
    if (v < SEA) return 'shallow';
    if (v < SEA + 0.03) return 'beach';
    if (v > 0.9) return 'snow';
    if (v > 0.8) return 'rock';
    if (v > 0.67) return 'hills';
    if (v < 0.46 && mo > 0.68) return 'swamp';
    if (mo > 0.6) return 'forest';
    if (mo > 0.42) return 'grass';
    if (mo > 0.3) return 'plains';
    return 'dry';
  };

  const c: Canvas = newCanvas(W * CELL + PX * 2, H * CELL + PY + 30, '#e9e2cf');
  const X = (x: number) => PX + x * CELL, Y = (y: number) => PY + y * CELL;
  const byColour = new Map<string, [number, number][]>();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const b = biome(x, y);
    const lift = b === 'deep' || b === 'shallow' ? 1 : 0.94 + Math.min(0.12, Math.max(0, (e[y * W + x] - 0.4) * 0.35));
    const base = COL[b];
    const n = parseInt(base.slice(1), 16);
    const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * lift))).toString(16).padStart(2, '0');
    const col = lift === 1 ? base : `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
    const q = byColour.get(col);
    if (q) q.push([x, y]); else byColour.set(col, [[x, y]]);
  }
  for (const [col, cells] of byColour) for (const [x, y, len] of runs(cells)) c.ops.push({ t: 'rect', x: X(x), y: Y(y), w: len * CELL + 0.5, h: CELL + 0.5, fill: col });

  // ---- rivers ----
  const riverCells = new Set<number>();
  const peaks: [number, number][] = [];
  for (let i = 0; i < W * H; i++) if (e[i] > 0.7) peaks.push([i % W, Math.floor(i / W)]);
  const nRivers = Math.min(peaks.length, size === 'small' ? 3 : size === 'medium' ? 5 : 7);
  for (let k = 0; k < nRivers; k++) {
    let [x, y] = peaks[int(r, 0, peaks.length - 1)];
    const path: [number, number][] = [[x, y]];
    const seen = new Set<number>([y * W + x]);
    for (let step = 0; step < 260; step++) {
      let bx = -1, by = -1, be = e[y * W + x] + 0.02;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H || seen.has(ny * W + nx)) continue;
        const v = e[ny * W + nx] + (r() - 0.5) * 0.008;
        if (v < be) { be = v; bx = nx; by = ny; }
      }
      if (bx < 0) break;
      x = bx; y = by; seen.add(y * W + x); path.push([x, y]);
      if (e[y * W + x] < SEA) break;
    }
    if (path.length < 8) continue;
    const segs: number[] = [];
    for (let i = 1; i < path.length; i++) { segs.push(X(path[i - 1][0] + 0.5), Y(path[i - 1][1] + 0.5), X(path[i][0] + 0.5), Y(path[i][1] + 0.5)); riverCells.add(path[i][1] * W + path[i][0]); }
    c.ops.push({ t: 'lines', segs, stroke: '#4f8fb5', sw: 2.2 });
  }

  // ---- towns ----
  const cand: { x: number; y: number; score: number }[] = [];
  for (let y = 3; y < H - 3; y++) for (let x = 3; x < W - 3; x++) {
    const v = e[y * W + x];
    if (v < SEA + 0.03 || v > 0.7) continue;
    const mo = m[y * W + x];
    let score = r() * 0.6 + (mo > 0.35 && mo < 0.75 ? 0.5 : 0);
    if (riverCells.has(y * W + x) || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => riverCells.has((y + b) * W + x + a))) score += 0.7;
    if ([[2, 0], [-2, 0], [0, 2], [0, -2]].some(([a, b]) => !land(x + a, y + b))) score += 0.4;
    cand.push({ x, y, score });
  }
  cand.sort((a, b) => b.score - a.score);
  const towns: { x: number; y: number; name: string; tier: number }[] = [];
  const avoid = o.avoid ?? new Set<string>();
  const used = new Set<string>();
  for (const q of cand) {
    if (towns.length >= nTowns) break;
    if (towns.some((t) => Math.hypot(t.x - q.x, t.y - q.y) < (size === 'small' ? 10 : 12))) continue;
    const mk = () => placeName('town', 'common', r, avoid).replace(/ on the .*/, '');
    let name = mk();
    for (let i = 0; i < 20 && used.has(name); i++) name = mk();
    used.add(name);
    towns.push({ x: q.x, y: q.y, name, tier: towns.length === 0 ? 3 : towns.length < 3 ? 2 : 1 });
  }
  // roads: join each town to its nearest earlier town when the line stays mostly on land
  const edges: [number, number][] = [];
  for (let i = 1; i < towns.length; i++) {
    const order = towns.slice(0, i).map((t, j) => ({ j, d: Math.hypot(t.x - towns[i].x, t.y - towns[i].y) })).sort((a, b) => a.d - b.d);
    for (const { j } of order.slice(0, 3)) {
      let wet = 0;
      for (let s = 0; s <= 20; s++) { const x = Math.round(towns[i].x + ((towns[j].x - towns[i].x) * s) / 20), y = Math.round(towns[i].y + ((towns[j].y - towns[i].y) * s) / 20); if (!land(x, y) || e[y * W + x] > 0.74) wet++; }
      if (wet <= 2) { edges.push([i, j]); break; }
    }
  }
  // Join separate groups of towns by the shortest road that does not cross the sea (a pass over the hills is fine).
  const seaOnLine = (i: number, j: number) => { let n = 0; for (let s2 = 0; s2 <= 20; s2++) { const x = Math.round(towns[i].x + ((towns[j].x - towns[i].x) * s2) / 20), y = Math.round(towns[i].y + ((towns[j].y - towns[i].y) * s2) / 20); if (!land(x, y)) n++; } return n; };
  const groupOf = () => { const g = towns.map((_t, i) => i); const find = (i: number): number => (g[i] === i ? i : (g[i] = find(g[i]))); for (const [i, j] of edges) g[find(i)] = find(j); return towns.map((_t, i) => find(i)); };
  for (let guard = 0; guard < towns.length; guard++) {
    const g = groupOf();
    let best: [number, number, number] | null = null;
    for (let i = 0; i < towns.length; i++) for (let j = i + 1; j < towns.length; j++) {
      if (g[i] === g[j] || seaOnLine(i, j) > 3) continue;
      const d = Math.hypot(towns[i].x - towns[j].x, towns[i].y - towns[j].y);
      if (!best || d < best[0]) best = [d, i, j];
    }
    if (!best) break;
    edges.push([best[1], best[2]]);
  }
  const dash: number[] = [];
  for (const [i, j] of edges) {
    const a = towns[i], b = towns[j];
    const len = Math.hypot(b.x - a.x, b.y - a.y) * CELL, n = Math.floor(len / 9);
    for (let s = 0; s < n; s++) { const t0 = s / n, t1 = (s + 0.55) / n; dash.push(X(a.x + (b.x - a.x) * t0 + 0.5), Y(a.y + (b.y - a.y) * t0 + 0.5), X(a.x + (b.x - a.x) * t1 + 0.5), Y(a.y + (b.y - a.y) * t1 + 0.5)); }
  }
  c.ops.push({ t: 'lines', segs: dash, stroke: '#6b4a28', sw: 1.8 });
  // reachability from the capital over roads
  const adj = towns.map(() => [] as number[]);
  for (const [i, j] of edges) { adj[i].push(j); adj[j].push(i); }
  const reachT = new Set<number>(towns.length ? [0] : []);
  const stack = towns.length ? [0] : [];
  while (stack.length) for (const n of adj[stack.pop()!]) if (!reachT.has(n)) { reachT.add(n); stack.push(n); }

  const key: KeyEntry[] = [];
  towns.forEach((t, i) => {
    const rad = t.tier === 3 ? 7 : t.tier === 2 ? 5.5 : 4.2;
    c.ops.push({ t: 'circle', x: X(t.x + 0.5), y: Y(t.y + 0.5), r: rad, fill: t.tier === 3 ? '#8a2a20' : '#fffaf0', stroke: '#2a2218', sw: 1.8 });
    c.ops.push({ t: 'text', x: X(t.x + 0.5), y: Y(t.y + 0.5) - rad - 4, s: t.name, size: 10, fill: '#1f1b18', anchor: 'middle', bold: true });
    key.push({ n: String(i + 1), name: t.name, text: `${t.tier === 3 ? 'The largest city of the region' : t.tier === 2 ? 'A walled town' : 'A village'}: ${pick(r, REGION_TOWN_NOTE)}.`, gm: chance(r, 0.5) ? pick(r, ['The reeve is quietly afraid of someone.', 'A shrine here is older than the town and not entirely harmless.', 'Trade has dried up, and nobody says why.', 'A rival town funds raiders against this one.', 'A visitor from the capital has overstayed.']) : undefined });
  });
  // features (letters)
  const fcand = cand.filter((q) => towns.every((t) => Math.hypot(t.x - q.x, t.y - q.y) > 6));
  const fnames = [...REGION_FEATURES].sort(() => r() - 0.5);
  const fpts: [number, number][] = [];
  for (let i = 0; i < feats && fcand.length; i++) {
    const q = fcand[int(r, 0, fcand.length - 1)];
    if (fpts.some(([a, b]) => Math.hypot(a - q.x, b - q.y) < 8)) continue;
    fpts.push([q.x, q.y]);
    const ch = String.fromCharCode(65 + fpts.length - 1);
    c.ops.push({ t: 'poly', pts: [X(q.x + 0.5), Y(q.y + 0.5) - 8, X(q.x + 0.5) + 7, Y(q.y + 0.5), X(q.x + 0.5), Y(q.y + 0.5) + 8, X(q.x + 0.5) - 7, Y(q.y + 0.5)], fill: '#f3e7b3', stroke: '#2a2218', sw: 1.4 });
    c.ops.push({ t: 'text', x: X(q.x + 0.5), y: Y(q.y + 0.5) + 3.5, s: ch, size: 9, fill: '#1f1b18', anchor: 'middle', bold: true });
    key.push({ n: ch, name: cap(fnames[i % fnames.length]), text: `${cap(fnames[i % fnames.length])}, a day or two from the nearest road.`, gm: pick(r, ['Something stirs here at night.', 'Locals avoid it and will not say why.', 'It is exactly what it looks like, which is the problem.', 'A faction wants it, and has quietly begun to dig.']) });
  }
  const title = `${placeName('town', 'common', r, avoid).replace(/ on the .*/, '')} ${pick(r, ['Marches', 'Reaches', 'Vales', 'Isles', 'Realm', 'Coast'])}`;
  c.ops.push({ t: 'text', x: PX, y: 26, s: title, size: 20, fill: '#2a2218', bold: true });
  c.ops.push({ t: 'text', x: PX, y: PY + H * CELL + 20, s: `Region · ${size} · seed ${seed} · 1 square = about 6 miles`, size: 11, fill: '#3a3128' });
  return {
    kind: 'region', seed, size, flavour: 'region', title, ftPerCell: null, canvas: c, key,
    legend: ['Dashed brown line: road', 'Blue line: river', 'Red dot: the largest city', 'Letters in diamonds: places of interest', 'Scale: 1 square is about 6 miles'],
    stats: { towns: towns.length, features: fpts.length, rivers: nRivers, roads: edges.length, total: towns.length, reached: reachT.size, connected: reachT.size === towns.length, landCells: e.reduce((n, v) => n + (v >= SEA ? 1 : 0), 0), width: W, height: H },
  };
}
