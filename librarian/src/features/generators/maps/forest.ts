// Forest and wilderness: clearings joined by winding paths, trees thinned by
// noise, an optional stream, a trailhead at the map's edge, and a numbered key.
// Themes: forest, wilderness (open country with rocks and scattered trees), swamp.
import { chance, int, makeRng, pick, seedOf } from '../../quickgen/rng.ts';
import { type Canvas, newCanvas } from './canvas.ts';
import { WILD_CLEARINGS, WILD_ENCOUNTER_HINTS, WILD_OCCUPANTS } from './tables.ts';
import { type KeyEntry, type MapOpts, type MapResult, cap, makeNoise, mst, rnd, sizeOf } from './util.ts';

const CELL = 16, PX = 16, PY = 36;
const DIMS = { small: { w: 48, h: 34, k: 5 }, medium: { w: 64, h: 44, k: 7 }, large: { w: 84, h: 58, k: 10 } };
const THEMES = {
  forest: { ground: '#bcd29a', tree: ['#5a8a47', '#4d7d3d', '#69974f'], density: 0.5, clearing: '#d4e0b0' },
  wilderness: { ground: '#d4d9a6', tree: ['#7b9a58', '#6c8c4c'], density: 0.78, clearing: '#e0e3b8' },
  swamp: { ground: '#a9b78b', tree: ['#5f7a4a', '#4d6a3d'], density: 0.6, clearing: '#bac49a' },
};
export const FOREST_THEMES = Object.keys(THEMES);

export function genForest(o: MapOpts = {}): MapResult {
  const seed = seedOf(o.seed);
  const size = sizeOf(o.size);
  const theme = (THEMES as Record<string, (typeof THEMES)['forest']>)[String(o.theme)] ? String(o.theme) : 'forest';
  const T = (THEMES as Record<string, (typeof THEMES)['forest']>)[theme];
  const { w: W, h: H, k } = DIMS[size];
  const r = makeRng(`${seed}|forest|${size}|${theme}`);
  const noise = makeNoise(makeRng(`${seed}|forest-n`));
  const c: Canvas = newCanvas(W * CELL + PX * 2, H * CELL + PY + 30, '#e9e2cf');
  const X = (x: number) => PX + x * CELL, Y = (y: number) => PY + y * CELL;
  c.ops.push({ t: 'rect', x: PX, y: PY, w: W * CELL, h: H * CELL, fill: T.ground });

  // clearings
  const pts: { x: number; y: number; rx: number; ry: number }[] = [];
  for (let t = 0; t < 600 && pts.length < k; t++) {
    const rx = rnd(r, 2.6, 4.6), ry = rnd(r, 2.2, 3.8);
    const x = rnd(r, rx + 3, W - rx - 3), y = rnd(r, ry + 3, H - ry - 3);
    if (pts.some((p) => Math.hypot(p.x - x, p.y - y) < Math.max(10, p.rx + rx + 3))) continue;
    pts.push({ x, y, rx, ry });
  }
  const trail = { x: 0, y: pts.length ? pts.reduce((b, p) => (p.x < b.x ? p : b), pts[0]).y : H / 2 };

  // paths: spanning tree between clearings, plus the trailhead to the nearest
  const nodes: [number, number][] = pts.map((p) => [p.x, p.y]);
  const edges = mst(nodes);
  const wind = (a: [number, number], b: [number, number]): [number, number][] => {
    const out: [number, number][] = [a];
    const steps = Math.max(6, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1.6));
    let off = 0;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      off = off * 0.6 + rnd(r, -0.9, 0.9);
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      out.push([a[0] + dx * t - (dy / len) * off * Math.sin(t * Math.PI), a[1] + dy * t + (dx / len) * off * Math.sin(t * Math.PI)]);
    }
    out.push(b);
    return out;
  };
  const paths: [number, number][][] = edges.map(([i, j]) => wind(nodes[i], nodes[j]));
  let nearest = 0;
  nodes.forEach((n, i) => { if (Math.hypot(n[0] - trail.x, n[1] - trail.y) < Math.hypot(nodes[nearest][0] - trail.x, nodes[nearest][1] - trail.y)) nearest = i; });
  if (nodes.length) paths.push(wind([0, nodes[nearest][1]], nodes[nearest]));

  // stream across the map
  const stream: [number, number][] = [];
  const hasStream = theme !== 'swamp' && chance(r, 0.6);
  if (hasStream) { const y0 = rnd(r, H * 0.2, H * 0.8); for (let i = 0; i <= 30; i++) stream.push([(i / 30) * W, y0 + (noise(i * 0.2, 3, 2) - 0.5) * 12]); }
  const pathDist = (x: number, y: number) => Math.min(999, ...paths.flatMap((p) => p.map(([a, b]) => Math.hypot(a - x, b - y))));
  const streamDist = (x: number, y: number) => (stream.length ? Math.min(...stream.map(([a, b]) => Math.hypot(a - x, b - y))) : 999);
  const clearingDist = (x: number, y: number) => Math.min(999, ...pts.map((p) => Math.hypot((p.x - x) / p.rx, (p.y - y) / p.ry)));

  if (stream.length) {
    const segs: number[] = [];
    for (let i = 1; i < stream.length; i++) segs.push(X(stream[i - 1][0]), Y(stream[i - 1][1]), X(stream[i][0]), Y(stream[i][1]));
    c.ops.push({ t: 'lines', segs, stroke: '#7aaec6', sw: 18 }, { t: 'lines', segs, stroke: '#9cc6da', sw: 9 });
  }
  if (theme === 'swamp') {
    for (let i = 0; i < 18; i++) {
      const x = rnd(r, 2, W - 2), y = rnd(r, 2, H - 2), rx = rnd(r, 1.5, 4), ry = rnd(r, 1, 2.4);
      if (clearingDist(x, y) < 1.6) continue;
      c.ops.push({ t: 'poly', pts: Array.from({ length: 12 }, (_u, q) => { const a = (q / 12) * Math.PI * 2; return [X(x) + Math.cos(a) * rx * CELL, Y(y) + Math.sin(a) * ry * CELL]; }).flat(), fill: i % 2 ? '#6e7a52' : '#6a9ea4', a: 0.85 });
    }
  }
  for (const p of pts) c.ops.push({ t: 'poly', pts: Array.from({ length: 18 }, (_u, q) => { const a = (q / 18) * Math.PI * 2; return [X(p.x) + Math.cos(a) * p.rx * CELL, Y(p.y) + Math.sin(a) * p.ry * CELL]; }).flat(), fill: T.clearing, stroke: '#9aa97a', sw: 1.2 });
  for (const path of paths) {
    const segs: number[] = [];
    for (let i = 1; i < path.length; i++) segs.push(X(path[i - 1][0]), Y(path[i - 1][1]), X(path[i][0]), Y(path[i][1]));
    c.ops.push({ t: 'lines', segs, stroke: '#a4906a', sw: 9 }, { t: 'lines', segs, stroke: '#cdbb8e', sw: 6 });
  }

  // trees (thinned by noise, kept off paths, clearings and the stream)
  const step = theme === 'wilderness' ? 1.9 : 1.35;
  for (let y = 0.8; y < H - 0.5; y += step) for (let x = 0.8; x < W - 0.5; x += step) {
    const px = x + rnd(r, -0.5, 0.5), py = y + rnd(r, -0.5, 0.5);
    const n = noise(px * 0.16, py * 0.16, 3);
    if (n < T.density - 0.06 && theme !== 'wilderness') continue;
    if (theme === 'wilderness' && (n < 0.62 || r() < 0.6)) continue;
    if (pathDist(px, py) < 1.25 || clearingDist(px, py) < 1.15 || streamDist(px, py) < 1.5) continue;
    const rad = (theme === 'wilderness' ? 0.55 : 0.72) * (0.8 + r() * 0.5);
    c.ops.push({ t: 'circle', x: X(px), y: Y(py), r: rad * CELL, fill: T.tree[int(r, 0, T.tree.length - 1)], stroke: '#37562a', sw: 1 });
  }
  if (theme === 'wilderness') {
    for (let i = 0; i < 26; i++) {
      const x = rnd(r, 1, W - 1), y = rnd(r, 1, H - 1);
      if (pathDist(x, y) < 1.5 || clearingDist(x, y) < 1.2 || streamDist(x, y) < 1.6) continue;
      c.ops.push({ t: 'poly', pts: Array.from({ length: 6 }, (_u, q) => { const a = (q / 6) * Math.PI * 2; const d = rnd(r, 0.3, 0.6) * CELL; return [X(x) + Math.cos(a) * d, Y(y) + Math.sin(a) * d]; }).flat(), fill: '#a8a39a', stroke: '#5b574f', sw: 1.2 });
    }
  }

  // frame cover so nothing drawn past the edge shows
  const bg = '#e9e2cf';
  c.ops.push({ t: 'rect', x: 0, y: 0, w: c.w, h: PY, fill: bg }, { t: 'rect', x: 0, y: PY + H * CELL, w: c.w, h: c.h, fill: bg }, { t: 'rect', x: 0, y: 0, w: PX, h: c.h, fill: bg }, { t: 'rect', x: PX + W * CELL, y: 0, w: c.w, h: c.h, fill: bg });
  c.ops.push({ t: 'rect', x: PX, y: PY, w: W * CELL, h: H * CELL, stroke: '#2a2218', sw: 3 });

  // key: trailhead is 1
  const key: KeyEntry[] = [{ n: '1', name: 'Trailhead', text: 'Where the path leaves the road and enters the wild. Fresh tracks lead inward.', dm: pick(r, WILD_ENCOUNTER_HINTS) }];
  c.ops.push({ t: 'circle', x: X(0) + 14, y: Y(trail.y), r: 11, fill: '#fffaf0', stroke: '#2a2218', sw: 1.4 });
  c.ops.push({ t: 'text', x: X(0) + 14, y: Y(trail.y) + 4, s: '1', size: 12, fill: '#1f1b18', anchor: 'middle', bold: true });
  const names = [...WILD_CLEARINGS].sort(() => r() - 0.5);
  pts.forEach((p, i) => {
    const n = i + 2;
    c.ops.push({ t: 'circle', x: X(p.x), y: Y(p.y), r: 11, fill: '#fffaf0', stroke: '#2a2218', sw: 1.4 });
    c.ops.push({ t: 'text', x: X(p.x), y: Y(p.y) + 4, s: String(n), size: n > 9 ? 10 : 12, fill: '#1f1b18', anchor: 'middle', bold: true });
    const nm = names[i % names.length];
    key.push({ n: String(n), name: cap(nm.replace(/^(a|an) /, '')), text: `${cap(nm)}, a clearing about ${Math.round(p.rx * 2 * 25)} by ${Math.round(p.ry * 2 * 25)} ft.`, dm: `Here: ${pick(r, WILD_OCCUPANTS)}.${chance(r, 0.4) ? ' ' + pick(r, WILD_ENCOUNTER_HINTS) : ''}` });
  });
  // reachability: trailhead -> nearest clearing, plus the spanning tree
  const adj = pts.map(() => [] as number[]);
  for (const [i, j] of edges) { adj[i].push(j); adj[j].push(i); }
  const seen = new Set<number>(pts.length ? [nearest] : []);
  const stack = pts.length ? [nearest] : [];
  while (stack.length) for (const q of adj[stack.pop()!]) if (!seen.has(q)) { seen.add(q); stack.push(q); }
  const title = `${cap(theme)} map`;
  c.ops.push({ t: 'text', x: PX, y: 24, s: title, size: 18, fill: '#2a2218', bold: true });
  c.ops.push({ t: 'text', x: PX, y: PY + H * CELL + 20, s: `${cap(theme)} · ${size} · ${W * 25} by ${H * 25} ft · seed ${seed} · 1 square = 25 ft`, size: 11, fill: '#3a3128' });
  return {
    kind: 'forest', seed, size, flavour: theme, title, ftPerCell: 25, canvas: c, key,
    legend: ['Tan lines: paths', hasStream ? 'Blue: a stream (difficult terrain to cross)' : 'No stream on this map', 'Pale patches: clearings', 'Numbers: places in the key'],
    stats: { clearings: pts.length, total: pts.length, reached: seen.size, connected: seen.size === pts.length, paths: paths.length, stream: hasStream, width: W, height: H },
  };
}
