// Castle / keep: a moat, a curtain wall with corner and wall towers, a
// gatehouse, a courtyard with buildings along the walls, and a keep whose
// floor is split into rooms joined by doors. 1 square = 5 ft.
import { chance, int, makeRng, pick, seedOf, type Rng } from '../../quickgen/rng.ts';
import { placeName } from '../names.ts';
import { type Canvas, newCanvas } from './canvas.ts';
import { CASTLE_BUILDINGS, CASTLE_BUILDING_NOTE, KEEP_ROOMS } from './tables.ts';
import { type KeyEntry, type MapOpts, type MapResult, cap, sizeOf } from './util.ts';

const CELL = 14, PX = 16, PY = 36;
const DIMS = { small: { w: 62, h: 50, b: 4 }, medium: { w: 68, h: 56, b: 6 }, large: { w: 84, h: 68, b: 8 } };

interface Rect { x: number; y: number; w: number; h: number }
interface Leaf extends Rect { id: number }

/** Split the keep into rooms. Returns the leaves and the doors between them. */
function bsp(r: Rng, rect: Rect, depth: number, leaves: Leaf[], doors: { a: number; b: number; x: number; y: number; vertical: boolean }[]): Leaf[] {
  const canV = rect.w >= 10, canH = rect.h >= 10;
  if (depth === 0 || (!canV && !canH) || (depth < 3 && chance(r, 0.15))) { const l = { ...rect, id: leaves.length }; leaves.push(l); return [l]; }
  const vertical = canV && (!canH || rect.w >= rect.h ? chance(r, 0.75) : chance(r, 0.25));
  const ratio = 0.38 + r() * 0.24;
  const a: Rect = vertical ? { x: rect.x, y: rect.y, w: Math.round(rect.w * ratio), h: rect.h } : { x: rect.x, y: rect.y, w: rect.w, h: Math.round(rect.h * ratio) };
  const b: Rect = vertical ? { x: a.x + a.w, y: rect.y, w: rect.w - a.w, h: rect.h } : { x: rect.x, y: a.y + a.h, w: rect.w, h: rect.h - a.h };
  const la = bsp(r, a, depth - 1, leaves, doors), lb = bsp(r, b, depth - 1, leaves, doors);
  // a door between a leaf of each side that touch along the split with at least 3 cells in common
  const cand: { a: number; b: number; x: number; y: number }[] = [];
  for (const p of la) for (const q of lb) {
    if (vertical && p.x + p.w === q.x) { const lo = Math.max(p.y, q.y), hi = Math.min(p.y + p.h, q.y + q.h); if (hi - lo >= 3) cand.push({ a: p.id, b: q.id, x: q.x, y: Math.floor((lo + hi) / 2) }); }
    if (!vertical && p.y + p.h === q.y) { const lo = Math.max(p.x, q.x), hi = Math.min(p.x + p.w, q.x + q.w); if (hi - lo >= 3) cand.push({ a: p.id, b: q.id, x: Math.floor((lo + hi) / 2), y: q.y }); }
  }
  const pickd = cand[int(r, 0, cand.length - 1)];
  if (pickd) doors.push({ ...pickd, vertical });
  return [...la, ...lb];
}

export function genCastle(o: MapOpts = {}): MapResult {
  const seed = seedOf(o.seed);
  const size = sizeOf(o.size);
  const { w: W, h: H, b: nb } = DIMS[size];
  const r = makeRng(`${seed}|castle|${size}`);
  const pal = { ground: '#cfd9b0', court: '#d9d2bd', wall: '#6f675c', stone: '#e8e1cf', line: '#2a2520', water: '#9fc2d4', roof: '#cdbfa5' };
  const c: Canvas = newCanvas(W * CELL + PX * 2, H * CELL + PY + 28, pal.ground);
  const X = (x: number) => PX + x * CELL, Y = (y: number) => PY + y * CELL;
  const rect = (q: Rect, fill: string, stroke?: string, sw = 2) => c.ops.push({ t: 'rect', x: X(q.x), y: Y(q.y), w: q.w * CELL, h: q.h * CELL, fill, stroke, sw });

  // geometry
  const m = 5; // wall rect inset (moat lies outside it)
  const wall: Rect = { x: m + 2, y: m + 2, w: W - 2 * (m + 2), h: H - 2 * (m + 2) };
  const inner: Rect = { x: wall.x + 2, y: wall.y + 2, w: wall.w - 4, h: wall.h - 4 };
  rect({ x: 1, y: 1, w: W - 2, h: H - 2 }, pal.water);
  rect({ x: m - 0, y: m - 0, w: W - 2 * m, h: H - 2 * m }, pal.ground);
  rect(wall, pal.wall, pal.line, 2);
  rect(inner, pal.court, pal.line, 1.5);

  const key: KeyEntry[] = [];
  const links: [string, string][] = [];

  // gatehouse (south, centre)
  const gate: Rect = { x: Math.floor(W / 2) - 4, y: wall.y + wall.h - 4, w: 8, h: 6 };
  rect(gate, pal.stone, pal.line, 2);
  c.ops.push({ t: 'rect', x: X(gate.x + 3), y: Y(gate.y - 1), w: 2 * CELL, h: 7 * CELL, fill: pal.court });
  for (let i = 0; i < 4; i++) c.ops.push({ t: 'lines', segs: [X(gate.x + 3) + i * 9 + 2, Y(gate.y) + 4, X(gate.x + 3) + i * 9 + 2, Y(gate.y + 2) - 2], stroke: pal.line, sw: 1.2 });
  // drawbridge across the moat
  c.ops.push({ t: 'rect', x: X(gate.x + 3), y: Y(gate.y + gate.h), w: 2 * CELL, h: (H - (gate.y + gate.h) - 1) * CELL, fill: '#a07a48', stroke: pal.line, sw: 1.2 });

  // keep (north centre) and its rooms
  const kw = size === 'small' ? 20 : size === 'medium' ? 24 : 32, kh = size === 'small' ? 14 : size === 'medium' ? 18 : 22;
  const keep: Rect = { x: Math.floor(W / 2) - Math.floor(kw / 2), y: inner.y + 3, w: kw, h: kh };
  rect(keep, pal.roof, pal.line, 3);
  const leaves: Leaf[] = [];
  const kdoors: { a: number; b: number; x: number; y: number; vertical: boolean }[] = [];
  bsp(r, keep, size === 'small' ? 2 : 3, leaves, kdoors);
  for (const l of leaves) c.ops.push({ t: 'rect', x: X(l.x), y: Y(l.y), w: l.w * CELL, h: l.h * CELL, fill: pal.stone, stroke: pal.line, sw: 1.5 });
  // the keep's outer door: a leaf touching the south face
  const south = leaves.filter((l) => l.y + l.h === keep.y + keep.h);
  const front = south[int(r, 0, south.length - 1)];
  const frontX = front.x + Math.floor(front.w / 2);
  const doorOps = (x: number, y: number, vertical: boolean) => {
    // vertical: the wall is vertical (a door in a vertical wall); else horizontal.
    c.ops.push({ t: 'rect', x: vertical ? X(x) - 3 : X(x) - CELL * 0.4, y: vertical ? Y(y) - CELL * 0.4 : Y(y) - 3, w: vertical ? 6 : CELL * 0.8, h: vertical ? CELL * 0.8 : 6, fill: '#9b6a35', stroke: pal.line, sw: 1 });
  };
  for (const d of kdoors) doorOps(d.x, d.y, d.vertical);
  doorOps(frontX, keep.y + keep.h, false);
  // keep rooms: BFS over the doors for reachability
  const adj = new Map<number, number[]>();
  for (const d of kdoors) { adj.set(d.a, [...(adj.get(d.a) ?? []), d.b]); adj.set(d.b, [...(adj.get(d.b) ?? []), d.a]); }
  const seen = new Set<number>([front.id]);
  const q = [front.id];
  while (q.length) for (const n of adj.get(q.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
  const keepNames = [...KEEP_ROOMS].sort(() => r() - 0.5);
  const frontName = 'Great entry hall';
  const keepKeys: KeyEntry[] = leaves.map((l, i) => ({
    n: `K${i + 1}`, name: l.id === front.id ? frontName : keepNames[i % keepNames.length],
    text: `${l.id === front.id ? 'The keep\'s only ground-floor entrance, a heavy double door. ' : ''}${l.w * 5} by ${l.h * 5} ft, stone floor and narrow windows.`,
    dm: chance(r, 0.4) ? `Guard: ${pick(r, ['two sentries', 'a sleepy porter', 'a patrolling man-at-arms', 'nobody until the bell rings'])}.` : undefined,
  }));
  leaves.forEach((l, i) => {
    c.ops.push({ t: 'circle', x: X(l.x + l.w / 2), y: Y(l.y + l.h / 2), r: 10, fill: '#fffaf0', stroke: pal.line, sw: 1.2 });
    c.ops.push({ t: 'text', x: X(l.x + l.w / 2), y: Y(l.y + l.h / 2) + 3.5, s: `K${i + 1}`, size: 9, fill: '#1f1b18', anchor: 'middle', bold: true });
  });
  links.push(['court', `K${front.id + 1}`]);
  for (const d of kdoors) links.push([`K${d.a + 1}`, `K${d.b + 1}`]);

  // buildings along the west and east walls
  const bw = size === 'small' ? 8 : size === 'medium' ? 9 : 11, bh = 8;
  const slots: { x: number; y: number; left: boolean }[] = [];
  for (let y = inner.y + 1; y + bh <= gate.y - 1; y += bh + 2) {
    for (const left of [true, false]) {
      const x = left ? inner.x + 1 : inner.x + inner.w - bw - 1;
      if (y < keep.y + keep.h + 2 && y + bh > keep.y - 1 && x < keep.x + keep.w + 1 && x + bw > keep.x - 1) continue;
      slots.push({ x, y, left });
    }
  }
  const names = [...CASTLE_BUILDINGS].sort(() => r() - 0.5);
  const placed: { n: number; q: Rect; name: string }[] = [];
  for (let i = 0; i < Math.min(nb, slots.length); i++) {
    const s = slots[i];
    const q: Rect = { x: s.x, y: s.y, w: bw, h: bh };
    const name = names[i % names.length];
    rect(q, pal.roof, pal.line, 2);
    c.ops.push({ t: 'rect', x: X(q.x) + 3, y: Y(q.y) + 3, w: q.w * CELL - 6, h: q.h * CELL - 6, fill: pal.stone, stroke: '#a89f8a', sw: 0.8 });
    doorOps(s.left ? q.x + q.w : q.x, q.y + Math.floor(q.h / 2), true);
    placed.push({ n: i + 3, q, name });
    links.push(['court', `B${i + 3}`]);
  }
  placed.forEach(({ n, q, name }) => {
    c.ops.push({ t: 'circle', x: X(q.x + q.w / 2), y: Y(q.y + q.h / 2), r: 10, fill: '#fffaf0', stroke: pal.line, sw: 1.2 });
    c.ops.push({ t: 'text', x: X(q.x + q.w / 2), y: Y(q.y + q.h / 2) + 4, s: String(n), size: 12, fill: '#1f1b18', anchor: 'middle', bold: true });
    key.push({ n: String(n), name, text: CASTLE_BUILDING_NOTE[name] ?? 'A working building of the castle.', dm: chance(r, 0.4) ? `Occupied by: ${pick(r, ['three servants', 'a bored sergeant and two guards', 'a craftsman who talks too much', 'nobody at this hour', 'a stable boy who sees everything'])}.` : undefined });
  });

  // well and training ground in the courtyard
  const wx = Math.floor(W / 2), wy = Math.floor((keep.y + keep.h + gate.y) / 2);
  c.ops.push({ t: 'circle', x: X(wx) , y: Y(wy), r: CELL * 1.2, fill: pal.water, stroke: pal.line, sw: 2 });
  c.ops.push({ t: 'text', x: X(wx), y: Y(wy) + CELL * 2.6, s: 'WELL', size: 9, fill: '#3a3128', anchor: 'middle' });

  // towers: four corners, plus wall towers on long sides
  const towers: { x: number; y: number; name: string }[] = [
    { x: wall.x, y: wall.y, name: 'Northwest tower' }, { x: wall.x + wall.w, y: wall.y, name: 'Northeast tower' },
    { x: wall.x, y: wall.y + wall.h, name: 'Southwest tower' }, { x: wall.x + wall.w, y: wall.y + wall.h, name: 'Southeast tower' },
  ];
  if (size !== 'small') { towers.push({ x: wall.x, y: wall.y + Math.floor(wall.h / 2), name: 'West wall tower' }, { x: wall.x + wall.w, y: wall.y + Math.floor(wall.h / 2), name: 'East wall tower' }); }
  towers.forEach((t, i) => {
    c.ops.push({ t: 'circle', x: X(t.x), y: Y(t.y), r: CELL * 3.2, fill: pal.stone, stroke: pal.line, sw: 2.4 });
    c.ops.push({ t: 'circle', x: X(t.x), y: Y(t.y), r: CELL * 1.6, stroke: pal.line, sw: 1 });
    c.ops.push({ t: 'text', x: X(t.x), y: Y(t.y) + 4, s: `T${i + 1}`, size: 11, fill: '#1f1b18', anchor: 'middle', bold: true });
    key.push({ n: `T${i + 1}`, name: t.name, text: 'Three floors with arrow slits, a spiral stair and a wall-walk door. Battlements on top.', dm: chance(r, 0.5) ? `Held by: ${pick(r, ['two archers', 'a lone lookout', 'a ballista crew of three', 'nobody, and the door is barred from inside'])}.` : undefined });
    links.push(['court', `T${i + 1}`]);
  });

  key.unshift(
    { n: '1', name: 'Gatehouse', text: 'A drawbridge, a portcullis and a murder-hole passage 40 ft long. The gate is shut at dusk.', dm: `Gate guards: ${pick(r, ['four men-at-arms', 'two sleepy guards and a sergeant', 'a captain and six'])}. Passwords change weekly.` },
    { n: '2', name: 'Courtyard', text: 'Cobbled, with a well and a mustering ground. Everything in the castle opens onto it.', dm: `Wanderers: ${pick(r, ['servants hauling water', 'a drill under a stern sergeant', 'a merchant arguing about a bill', 'a messenger who looks lost'])}.` },
  );
  key.push(...keepKeys);
  links.push(['gate', 'court']);

  // reachability over the declared links, from the gate
  const nodes = new Set<string>(['gate', 'court', ...links.flat()]);
  const lseen = new Set<string>(['gate']);
  const lq = ['gate'];
  while (lq.length) {
    const n = lq.pop()!;
    for (const [a, b] of links) { const o2 = a === n ? b : b === n ? a : null; if (o2 && !lseen.has(o2)) { lseen.add(o2); lq.push(o2); } }
  }
  // keep rooms: only those reached by the BFS count as reachable
  const total = nodes.size;
  const reached = [...nodes].filter((n) => lseen.has(n) && (!/^K\d+$/.test(n) || seen.has(Number(n.slice(1)) - 1))).length;

  c.ops.push({ t: 'text', x: X(gate.x + 4), y: Y(gate.y + 3) + 4, s: '1', size: 12, fill: '#1f1b18', anchor: 'middle', bold: true });
  c.ops.push({ t: 'text', x: X(wx), y: Y(wy) - CELL * 2, s: '2', size: 12, fill: '#1f1b18', anchor: 'middle', bold: true });
  const title = placeName('keep', 'common', r, o.avoid);
  c.ops.push({ t: 'text', x: PX, y: 24, s: title, size: 18, fill: '#2a2218', bold: true });
  c.ops.push({ t: 'text', x: PX, y: PY + H * CELL + 18, s: `Castle · ${size} · seed ${seed} · 1 square = 5 ft`, size: 11, fill: '#3a3128' });
  return {
    kind: 'castle', seed, size, flavour: 'castle', title, ftPerCell: 5, canvas: c, key,
    legend: ['Blue ring: moat', 'T: tower', 'K: room of the keep', 'Numbers: buildings and the key'],
    stats: { total, reached, connected: reached === total, towers: towers.length, buildings: placed.length, keepRooms: leaves.length, width: W, height: H },
  };
}
void cap;
