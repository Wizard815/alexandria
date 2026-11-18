// Battle map: a 5 ft grid with terrain for a fight. A theme picks the ground
// and what is scattered on it; numbered spots in the key give cover and hazards.
import { chance, int, makeRng, pick, seedOf, type Rng } from '../../quickgen/rng.ts';
import { type Canvas, newCanvas } from './canvas.ts';
import { BATTLE_THEMES } from './tables.ts';
import { type KeyEntry, type MapOpts, type MapResult, cap, rnd, sizeOf } from './util.ts';

const CELL = 32, PX = 16, PY = 36;
const DIMS = { small: { w: 24, h: 18 }, medium: { w: 32, h: 22 }, large: { w: 42, h: 28 } };
export const BATTLE_THEME_NAMES = Object.keys(BATTLE_THEMES);

export function genBattlemap(o: MapOpts = {}): MapResult {
  const seed = seedOf(o.seed);
  const size = sizeOf(o.size);
  const theme = BATTLE_THEMES[String(o.theme)] ? String(o.theme) : 'forest';
  const T = BATTLE_THEMES[theme];
  const { w: W, h: H } = DIMS[size];
  const r = makeRng(`${seed}|battle|${size}|${theme}`);
  const c: Canvas = newCanvas(W * CELL + PX * 2, H * CELL + PY + 30, '#e9e2cf');
  const X = (x: number) => PX + x * CELL, Y = (y: number) => PY + y * CELL;
  c.ops.push({ t: 'rect', x: PX, y: PY, w: W * CELL, h: H * CELL, fill: T.ground });

  // keep-clear zones so the fight has room: nothing blocks the middle fully
  const blocked: [number, number, number][] = []; // x, y, radius (cells) of things that block movement
  const free = (x: number, y: number, rad = 1) => !blocked.some(([bx, by, br]) => Math.hypot(bx - x, by - y) < br + rad) && x > 0.6 && y > 0.6 && x < W - 0.6 && y < H - 0.6;
  const tree = (x: number, y: number, rad = 0.85, tone = 0) => {
    const g = ['#6c9a52', '#5d8a46', '#7aa65c'][tone % 3];
    c.ops.push({ t: 'circle', x: X(x), y: Y(y), r: rad * CELL, fill: g, stroke: '#3d5f2c', sw: 1.6 });
    c.ops.push({ t: 'circle', x: X(x) - 3, y: Y(y) - 3, r: rad * CELL * 0.55, fill: '#8cb868', a: 0.7 });
  };
  const rock = (x: number, y: number, rad = 0.6) => {
    c.ops.push({ t: 'poly', pts: Array.from({ length: 7 }, (_u, i) => { const a = (i / 7) * Math.PI * 2; const d = rad * CELL * (0.85 + ((i * 7 + Math.floor(x * 3)) % 4) * 0.07); return [X(x) + Math.cos(a) * d, Y(y) + Math.sin(a) * d]; }).flat(), fill: '#a8a39a', stroke: '#5b574f', sw: 1.6 });
    blocked.push([x, y, rad]);
  };
  const thick = (pts: [number, number][], w: number, col: string, a = 1) => {
    const segs: number[] = [];
    for (let i = 1; i < pts.length; i++) segs.push(X(pts[i - 1][0]), Y(pts[i - 1][1]), X(pts[i][0]), Y(pts[i][1]));
    c.ops.push({ t: 'lines', segs, stroke: col, sw: w * CELL, a });
  };
  const wander = (from: [number, number], to: [number, number], jitter: number, steps = 18): [number, number][] => {
    const out: [number, number][] = [from];
    let off = 0;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      off = off * 0.7 + rnd(r, -jitter, jitter);
      out.push([from[0] + (to[0] - from[0]) * t + (to[1] === from[1] ? 0 : off), from[1] + (to[1] - from[1]) * t + (to[0] === from[0] ? 0 : off)]);
    }
    out.push(to);
    return out;
  };
  const scatterTrees = (n: number, clear?: (x: number, y: number) => boolean) => { for (let i = 0; i < n * 6 && n > 0; i++) { const x = rnd(r, 0.8, W - 0.8), y = rnd(r, 0.8, H - 0.8); if (clear?.(x, y) || !free(x, y, 0.9)) continue; tree(x, y, rnd(r, 0.7, 1.1), i); blocked.push([x, y, 0.5]); n--; } };

  const spots: [number, number][] = [];
  const addSpot = (x: number, y: number) => spots.push([x, y]);
  const notes: string[] = [];

  switch (theme) {
    case 'forest': {
      const trail = wander([0, H * 0.35], [W, H * 0.65], 1.2);
      thick(trail, 1.4, '#cdb98a', 0.9);
      const nearTrail = (x: number, y: number) => trail.some(([a, b]) => Math.hypot(a - x, b - y) < 1.6) || Math.hypot(x - W / 2, y - H / 2) < Math.min(W, H) * 0.22;
      scatterTrees(Math.round(W * H * 0.11), nearTrail);
      for (let i = 0; i < 3; i++) rock(rnd(r, 3, W - 3), rnd(r, 3, H - 3), rnd(r, 0.5, 0.8));
      notes.push('Trees block movement but not sight above 10 ft. The trail is open ground.');
      break;
    }
    case 'ruins': {
      const bx = int(r, 4, W - 15), by = int(r, 3, H - 12), bw = int(r, 9, 12), bh = int(r, 7, 9);
      const edges: [number, number, number, number][] = [[bx, by, bx + bw, by], [bx + bw, by, bx + bw, by + bh], [bx + bw, by + bh, bx, by + bh], [bx, by + bh, bx, by]];
      for (const [x1, y1, x2, y2] of edges) {
        const len = Math.hypot(x2 - x1, y2 - y1), gap = rnd(r, 0.3, 0.6), gw = rnd(r, 1.5, 3);
        const t0 = gap * len - gw / 2, t1 = gap * len + gw / 2;
        const dx = (x2 - x1) / len, dy = (y2 - y1) / len;
        thick([[x1, y1], [x1 + dx * t0, y1 + dy * t0]], 0.45, '#7d776b'); thick([[x1 + dx * t1, y1 + dy * t1], [x2, y2]], 0.45, '#7d776b');
      }
      thick([[bx + 4, by], [bx + 4, by + 3]], 0.3, '#8b857a');
      for (let i = 0; i < 9; i++) { const x = rnd(r, bx - 2, bx + bw + 2), y = rnd(r, by - 2, by + bh + 2); c.ops.push({ t: 'circle', x: X(x), y: Y(y), r: rnd(r, 5, 11), fill: '#b4ad9f', stroke: '#6b665b', sw: 1 }); }
      for (let i = 0; i < 4; i++) { const x = rnd(r, bx + 1, bx + bw - 1), y = rnd(r, by + 1, by + bh - 1); c.ops.push({ t: 'circle', x: X(x), y: Y(y), r: 0.45 * CELL, fill: '#cfc8b8', stroke: '#5b574f', sw: 2 }); blocked.push([x, y, 0.45]); }
      scatterTrees(8, (x, y) => x > bx - 1 && x < bx + bw + 1 && y > by - 1 && y < by + bh + 1);
      notes.push('Wall segments are full cover; gaps are doorways. Rubble is difficult terrain.');
      break;
    }
    case 'river': {
      const mx = rnd(r, W * 0.35, W * 0.65);
      const path = wander([mx, 0], [mx + rnd(r, -3, 3), H], 1.6, 24);
      thick(path, 4.6, '#c9bf94');
      thick(path, 3.4, '#8fbad0');
      thick(path, 1.4, '#a8cde0', 0.7);
      for (const t of [0.3, 0.7]) { const p = path[Math.floor(path.length * t)]; c.ops.push({ t: 'rect', x: X(p[0]) - 2.2 * CELL, y: Y(p[1]) - 0.6 * CELL, w: 4.4 * CELL, h: 1.2 * CELL, fill: '#dccb98', a: 0.8 }); }
      const bp = path[Math.floor(path.length * 0.5)];
      c.ops.push({ t: 'rect', x: X(bp[0]) - 2.6 * CELL, y: Y(bp[1]) - 0.5 * CELL, w: 5.2 * CELL, h: CELL, fill: '#a8793f', stroke: '#4d3418', sw: 1.6 });
      for (const p of path) blocked.push([p[0], p[1], 1.6]);
      scatterTrees(Math.round(W * H * 0.05));
      for (let i = 0; i < 4; i++) { const x = rnd(r, 2, W - 2), y = rnd(r, 2, H - 2); if (free(x, y, 1.2)) rock(x, y); }
      notes.push('The river is difficult terrain to cross (DC 10 to swim). Fords and the footbridge are the only dry crossings.');
      break;
    }
    case 'camp': {
      const cx = W / 2 + rnd(r, -2, 2), cy = H / 2 + rnd(r, -1, 1);
      c.ops.push({ t: 'circle', x: X(cx), y: Y(cy), r: 6.5 * CELL, fill: '#d3c79a', a: 0.55 });
      c.ops.push({ t: 'circle', x: X(cx), y: Y(cy), r: 0.7 * CELL, fill: '#e87a2a', stroke: '#6b2d0e', sw: 2 });
      c.ops.push({ t: 'circle', x: X(cx), y: Y(cy), r: 1.2 * CELL, stroke: '#8d8678', sw: 2, a: 0.9 });
      blocked.push([cx, cy, 0.8]);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + rnd(r, 0, 1), d = rnd(r, 3, 4.5), tx = cx + Math.cos(a) * d, ty = cy + Math.sin(a) * d;
        c.ops.push({ t: 'poly', pts: [X(tx), Y(ty) - 1.5 * CELL, X(tx) + 1.6 * CELL, Y(ty) + 1.2 * CELL, X(tx) - 1.6 * CELL, Y(ty) + 1.2 * CELL], fill: ['#b5654a', '#9c8e5a', '#6f7f9a'][i], stroke: '#3a2a1a', sw: 1.8 });
        blocked.push([tx, ty, 1.5]);
      }
      c.ops.push({ t: 'rect', x: X(cx) + 5 * CELL, y: Y(cy) - 2 * CELL, w: 3.2 * CELL, h: 1.8 * CELL, fill: '#a07a48', stroke: '#3a2a1a', sw: 1.8 });
      blocked.push([cx + 6.6, cy - 1.1, 1.8]);
      for (let i = 0; i < 4; i++) c.ops.push({ t: 'rect', x: X(cx) - 6 * CELL + (i % 2) * CELL, y: Y(cy) + 3 * CELL + Math.floor(i / 2) * CELL, w: 0.9 * CELL, h: 0.9 * CELL, fill: '#b58c52', stroke: '#3a2a1a', sw: 1.2 });
      scatterTrees(Math.round(W * H * 0.07), (x, y) => Math.hypot(x - cx, y - cy) < 7.5);
      notes.push('Tents give full cover from outside. The campfire lights a 20 ft radius.');
      break;
    }
    case 'swamp': {
      for (let i = 0; i < Math.round(W * H * 0.018); i++) {
        const x = rnd(r, 2, W - 2), y = rnd(r, 2, H - 2), rx = rnd(r, 1.5, 3.4), ry = rnd(r, 1, 2.2);
        c.ops.push({ t: 'poly', pts: Array.from({ length: 12 }, (_u, k) => { const a = (k / 12) * Math.PI * 2; return [X(x) + Math.cos(a) * rx * CELL, Y(y) + Math.sin(a) * ry * CELL]; }).flat(), fill: i % 2 ? '#6e7a52' : '#4f7f86', a: 0.85 });
      }
      const cw = wander([0, H * 0.7], [W, H * 0.3], 1.6);
      thick(cw, 1.1, '#9a7a4a', 0.95);
      scatterTrees(Math.round(W * H * 0.025), (x, y) => cw.some(([a, b]) => Math.hypot(a - x, b - y) < 1.5));
      for (let i = 0; i < 40; i++) { const x = rnd(r, 1, W - 1), y = rnd(r, 1, H - 1); c.ops.push({ t: 'lines', segs: [X(x), Y(y), X(x) - 3, Y(y) - 12, X(x), Y(y), X(x) + 2, Y(y) - 14], stroke: '#4e6a3a', sw: 1.6 }); }
      notes.push('Mud and reeds are difficult terrain. The plank causeway is the only firm footing.');
      break;
    }
    case 'cliff': {
      const side = chance(r, 0.5);
      const edge: [number, number][] = [];
      for (let i = 0; i <= 12; i++) edge.push([side ? W * 0.55 + Math.sin(i * 0.9) * 1.3 + rnd(r, -0.6, 0.6) : W * 0.45 - Math.sin(i * 0.9) * 1.3 + rnd(r, -0.6, 0.6), (i / 12) * H]);
      const poly = [...edge.flatMap(([x, y]) => [X(x), Y(y)]), ...(side ? [X(W), Y(H), X(W), Y(0)] : [X(0), Y(H), X(0), Y(0)])];
      c.ops.push({ t: 'poly', pts: poly, fill: '#c8bfa4', stroke: '#4d463a', sw: 3 });
      c.ops.push({ t: 'text', x: X(side ? W - 3 : 3), y: Y(2), s: '+10 FT', size: 14, fill: '#5b5445', anchor: 'middle', bold: true });
      for (const [x, y] of edge) blocked.push([x, y, 0.9]);
      // ramp
      const ry = Math.floor(H * 0.55), rx = side ? W * 0.55 : W * 0.45;
      c.ops.push({ t: 'rect', x: X(rx - 1.6), y: Y(ry), w: 3.2 * CELL, h: 2 * CELL, fill: '#b5aa86', stroke: '#4d463a', sw: 1.6 });
      for (let i = 0; i < 5; i++) c.ops.push({ t: 'lines', segs: [X(rx - 1.6) + i * 0.7 * CELL, Y(ry), X(rx - 1.6) + i * 0.7 * CELL, Y(ry + 2)], stroke: '#4d463a', sw: 1 });
      for (let i = 0; i < 9; i++) { const x = rnd(r, 1, W - 1), y = rnd(r, 1, H - 1); if (free(x, y, 1)) rock(x, y, rnd(r, 0.4, 0.8)); }
      scatterTrees(Math.round(W * H * 0.02));
      notes.push('The shaded half is a ledge 10 ft higher. Climbing the face is DC 12; the ramp is difficult terrain.');
      break;
    }
    case 'crossroads': {
      const cx = W / 2, cy = H / 2;
      thick([[0, cy], [W, cy]], 2.6, '#d3c08a'); thick([[cx, 0], [cx, H]], 2.6, '#d3c08a');
      thick([[0, cy], [W, cy]], 0.15, '#b8a370', 0.6);
      c.ops.push({ t: 'rect', x: X(cx) - 0.25 * CELL, y: Y(cy) - 1.8 * CELL, w: 0.5 * CELL, h: 1.8 * CELL, fill: '#6b4a28', stroke: '#2a1a0a', sw: 1.4 });
      c.ops.push({ t: 'rect', x: X(cx) + 3 * CELL, y: Y(cy) + 2 * CELL, w: 1.4 * CELL, h: 1.4 * CELL, fill: '#bdb6a4', stroke: '#4d463a', sw: 2 });
      blocked.push([cx + 3.7, cy + 2.7, 1]);
      for (const [x1, y1, x2, y2] of [[0, cy - 2, W, cy - 2], [0, cy + 2, W, cy + 2]]) c.ops.push({ t: 'lines', segs: [X(x1), Y(y1), X(x2), Y(y2)], stroke: '#6d7f4d', sw: 5, a: 0.5 });
      scatterTrees(Math.round(W * H * 0.04), (x, y) => Math.abs(y - cy) < 3 || Math.abs(x - cx) < 3);
      for (let i = 0; i < 3; i++) rock(rnd(r, 2, W - 2), rnd(r, 2, H - 2), 0.5);
      notes.push('Roads are open ground. The ditches on both sides give half cover to a prone creature.');
      break;
    }
  }

  // anything drawn past the edge is covered
  const edgeBg = '#e9e2cf';
  c.ops.push({ t: 'rect', x: 0, y: 0, w: c.w, h: PY, fill: edgeBg }, { t: 'rect', x: 0, y: PY + H * CELL, w: c.w, h: c.h, fill: edgeBg }, { t: 'rect', x: 0, y: 0, w: PX, h: c.h, fill: edgeBg }, { t: 'rect', x: PX + W * CELL, y: 0, w: c.w, h: c.h, fill: edgeBg });
  // grid on top
  const grid: number[] = [];
  for (let x = 0; x <= W; x++) grid.push(X(x), Y(0), X(x), Y(H));
  for (let y = 0; y <= H; y++) grid.push(X(0), Y(y), X(W), Y(y));
  c.ops.push({ t: 'lines', segs: grid, stroke: '#2b2b2b', sw: 0.6, a: 0.28 });
  c.ops.push({ t: 'rect', x: PX, y: PY, w: W * CELL, h: H * CELL, stroke: '#2a2218', sw: 3 });

  // numbered spots with a note each
  const key: KeyEntry[] = [];
  const features = [...T.features].sort(() => r() - 0.5);
  const nspots = Math.min(features.length, size === 'small' ? 4 : 6);
  for (let i = 0; i < nspots; i++) {
    let x = rnd(r, 2, W - 2), y = rnd(r, 2, H - 2);
    for (let t = 0; t < 80 && (spots.some(([a, b]) => Math.hypot(a - x, b - y) < 4) || !free(x, y, 1)); t++) { x = rnd(r, 2, W - 2); y = rnd(r, 2, H - 2); }
    addSpot(x, y);
    c.ops.push({ t: 'circle', x: X(x), y: Y(y), r: 11, fill: '#fffaf0', stroke: '#2a2218', sw: 1.4 });
    c.ops.push({ t: 'text', x: X(x), y: Y(y) + 4, s: String(i + 1), size: 12, fill: '#1f1b18', anchor: 'middle', bold: true });
    key.push({ n: String(i + 1), name: cap(features[i].replace(/\s*\(.*\)$/, '')), text: cap(features[i]) + '.' });
  }
  const hazards = [...T.hazard].sort(() => r() - 0.5).slice(0, 2);
  hazards.forEach((h, i) => {
    const x = rnd(r, 3, W - 3), y = rnd(r, 3, H - 3);
    c.ops.push({ t: 'circle', x: X(x), y: Y(y), r: 10, fill: '#f2b8b0', stroke: '#8a2a20', sw: 1.2, dm: true });
    c.ops.push({ t: 'text', x: X(x), y: Y(y) + 3.5, s: `H${i + 1}`, size: 9, fill: '#6b1a12', anchor: 'middle', bold: true, dm: true });
    key.push({ n: `H${i + 1}`, name: 'Hazard', text: 'Nothing looks wrong here.', dm: `${cap(h)}.` });
  });
  key.push({ n: '*', name: 'Terrain', text: notes.join(' ') });
  const title = `${cap(theme)} battle map`;
  c.ops.push({ t: 'text', x: PX, y: 24, s: title, size: 18, fill: '#2a2218', bold: true });
  c.ops.push({ t: 'text', x: PX, y: PY + H * CELL + 20, s: `${cap(theme)} · ${size} · ${W * 5} by ${H * 5} ft · seed ${seed} · 1 square = 5 ft`, size: 11, fill: '#3a3128' });
  void pick;
  return {
    kind: 'battlemap', seed, size, flavour: theme, title, ftPerCell: 5, canvas: c, key,
    legend: ['Grid: one square is 5 ft', 'Numbers: spots in the key', 'DM view only: H = hazard'],
    stats: { total: 1, reached: 1, connected: true, spots: nspots, width: W, height: H },
  };
}
