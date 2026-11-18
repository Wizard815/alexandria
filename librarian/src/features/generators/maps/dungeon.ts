// Dungeon: rooms placed without overlap, joined by corridors with doors (some
// secret), numbered, with a keyed list. Rooms and corridors live on a 5 ft grid.
import { chance, int, makeRng, pick, seedOf } from '../../quickgen/rng.ts';
import { placeName } from '../names.ts';
import { type Canvas, newCanvas, runs } from './canvas.ts';
import { DUNGEON_FLAVOURS, DUNGEON_HAZARD, DUNGEON_LIGHT, DUNGEON_LOOT, DUNGEON_SECRET, DUNGEON_SENSE } from './tables.ts';
import { type KeyEntry, type MapOpts, type MapResult, cap, flood, sizeOf } from './util.ts';

const CELL = 20, PX = 16, PY = 36;
const DIMS = { small: { w: 40, h: 28, rooms: 6 }, medium: { w: 56, h: 38, rooms: 10 }, large: { w: 76, h: 52, rooms: 16 } };
export const DUNGEON_FLAVOUR_NAMES = Object.keys(DUNGEON_FLAVOURS);

interface Room { id: number; x: number; y: number; w: number; h: number }
const noArticle = (s: string) => cap(s.replace(/^(a|an|the) /i, ''));

export function genDungeon(o: MapOpts = {}): MapResult {
  const seed = seedOf(o.seed);
  const size = sizeOf(o.size);
  const fname = DUNGEON_FLAVOURS[String(o.flavour)] ? String(o.flavour) : 'ruin';
  const fl = DUNGEON_FLAVOURS[fname];
  const r = makeRng(`${seed}|dungeon|${size}|${fname}`);
  const { w: W, h: H, rooms: want } = DIMS[size];

  // ---- rooms ----
  const rooms: Room[] = [];
  for (let tries = 0; tries < 600 && rooms.length < want; tries++) {
    const rw = int(r, 4, size === 'small' ? 8 : 10), rh = int(r, 4, size === 'small' ? 7 : 9);
    const x = int(r, 2, W - rw - 3), y = int(r, 2, H - rh - 3);
    if (rooms.some((q) => x < q.x + q.w + 3 && x + rw + 3 > q.x && y < q.y + q.h + 3 && y + rh + 3 > q.y)) continue;
    rooms.push({ id: rooms.length + 1, x, y, w: rw, h: rh });
  }
  // Number the rooms left to right so the key reads naturally from the entrance.
  rooms.sort((a, b) => a.x + a.w / 2 - (b.x + b.w / 2));
  rooms.forEach((q, i) => { q.id = i + 1; });

  const reg = new Int16Array(W * H); // 0 rock, -1 corridor, >0 room id
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : reg[y * W + x]);
  for (const q of rooms) for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) reg[y * W + x] = q.id;
  const cx = (q: Room) => q.x + Math.floor(q.w / 2), cy = (q: Room) => q.y + Math.floor(q.h / 2);

  // ---- corridors ----
  const links: [number, number][] = [];
  for (let i = 1; i < rooms.length; i++) {
    let best = 0, bd = Infinity;
    for (let j = 0; j < i; j++) { const d = Math.hypot(cx(rooms[i]) - cx(rooms[j]), cy(rooms[i]) - cy(rooms[j])); if (d < bd) { bd = d; best = j; } }
    links.push([best, i]);
  }
  const extra = Math.floor(rooms.length / 3);
  for (let k = 0; k < extra && rooms.length > 3; k++) {
    const a = int(r, 0, rooms.length - 1), b = int(r, 0, rooms.length - 1);
    if (a !== b && !links.some(([p, q]) => (p === a && q === b) || (p === b && q === a))) links.push([a, b]);
  }
  const paths: [number, number][][] = [];
  for (const [a, b] of links) {
    const path: [number, number][] = [];
    let x = cx(rooms[a]), y = cy(rooms[a]);
    const tx = cx(rooms[b]), ty = cy(rooms[b]);
    const horizFirst = chance(r, 0.5);
    path.push([x, y]);
    const stepX = () => { while (x !== tx) { x += Math.sign(tx - x); path.push([x, y]); } };
    const stepY = () => { while (y !== ty) { y += Math.sign(ty - y); path.push([x, y]); } };
    if (horizFirst) { stepX(); stepY(); } else { stepY(); stepX(); }
    for (const [px, py] of path) if (reg[py * W + px] === 0) reg[py * W + px] = -1;
    paths.push(path);
  }

  // ---- doors: wherever a path passes between two different regions ----
  const door = new Map<string, 'door' | 'arch' | 'secret'>();
  const edge = (x1: number, y1: number, x2: number, y2: number) => (x1 === x2 ? `v${x1},${Math.min(y1, y2)}` : `h${Math.min(x1, x2)},${y1}`);
  const edgesOfPaths: string[] = [];
  for (const path of paths) {
    for (let i = 1; i < path.length; i++) {
      const [x1, y1] = path[i - 1], [x2, y2] = path[i];
      if (at(x1, y1) !== at(x2, y2)) { const k = edge(x1, y1, x2, y2); if (!door.has(k)) { door.set(k, chance(r, 0.7) ? 'door' : 'arch'); edgesOfPaths.push(k); } }
    }
  }
  // One or two of the doors on the extra links are secret (the ones past the first spanning links).
  const secretWant = Math.min(2, Math.floor(rooms.length / 4));
  const spare = edgesOfPaths.slice(Math.max(0, edgesOfPaths.length - 2 * extra - 2));
  for (let i = 0; i < secretWant && spare.length; i++) door.set(spare.splice(int(r, 0, spare.length - 1), 1)[0], 'secret');

  // ---- reachability, with every door counted as open ----
  const linked = (x: number, y: number, nx: number, ny: number) => at(x, y) === at(nx, ny) || door.has(edge(x, y, nx, ny));
  const start: [number, number] = [cx(rooms[0]), cy(rooms[0])];
  const seen = flood(W, H, start, (x, y) => at(x, y) !== 0, linked);
  const reached = rooms.filter((q) => seen[cy(q) * W + cx(q)]).length;

  // ---- draw ----
  const c: Canvas = newCanvas(W * CELL + PX * 2, H * CELL + PY + 28, fl.palette.bg);
  const X = (x: number) => PX + x * CELL, Y = (y: number) => PY + y * CELL;
  c.ops.push({ t: 'rect', x: PX, y: PY, w: W * CELL, h: H * CELL, fill: fl.palette.rock });
  const floorCells: [number, number][] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (reg[y * W + x] !== 0) floorCells.push([x, y]);
  for (const [x, y, n] of runs(floorCells)) c.ops.push({ t: 'rect', x: X(x), y: Y(y), w: n * CELL, h: CELL, fill: fl.palette.floor });
  // grid on the floor
  const grid: number[] = [];
  for (const [x, y, n] of runs(floorCells)) { grid.push(X(x), Y(y), X(x + n), Y(y)); for (let i = 0; i <= n; i++) grid.push(X(x + i), Y(y), X(x + i), Y(y + 1)); }
  for (let y = 0; y < H; y++) { const row = floorCells.filter(([, yy]) => yy === y).map(([x]) => x); if (row.length) grid.push(X(Math.min(...row)), Y(y + 1), X(Math.max(...row) + 1), Y(y + 1)); }
  c.ops.push({ t: 'lines', segs: grid, stroke: fl.palette.grid, sw: 0.7 });
  // walls
  const walls: number[] = [];
  for (let y = -1; y < H; y++) for (let x = -1; x < W; x++) {
    const a = at(x, y);
    const rt = at(x + 1, y), dn = at(x, y + 1);
    if (x >= -1 && (a !== 0 || rt !== 0) && a !== rt && (!door.has(edge(x, y, x + 1, y)) || door.get(edge(x, y, x + 1, y)) === 'secret')) walls.push(X(x + 1), Y(y), X(x + 1), Y(y + 1));
    if ((a !== 0 || dn !== 0) && a !== dn && (!door.has(edge(x, y, x, y + 1)) || door.get(edge(x, y, x, y + 1)) === 'secret')) walls.push(X(x), Y(y + 1), X(x + 1), Y(y + 1));
  }
  c.ops.push({ t: 'lines', segs: walls, stroke: fl.palette.wall, sw: 3.2 });
  // doors
  for (const [k, kind] of door) {
    const [dir, rest] = [k[0], k.slice(1)];
    const [x, y] = rest.split(',').map(Number);
    const horiz = dir === 'v'; // v-edge sits between (x,y) and (x,y+1): a horizontal wall piece
    const mx = horiz ? X(x) + CELL / 2 : X(x + 1), my = horiz ? Y(y + 1) : Y(y) + CELL / 2;
    if (kind === 'arch') { c.ops.push({ t: 'rect', x: horiz ? mx - CELL * 0.35 : mx - 2, y: horiz ? my - 2 : my - CELL * 0.35, w: horiz ? CELL * 0.7 : 4, h: horiz ? 4 : CELL * 0.7, fill: fl.palette.floor }); continue; }
    const rect = { x: horiz ? mx - CELL * 0.36 : mx - 3, y: horiz ? my - 3 : my - CELL * 0.36, w: horiz ? CELL * 0.72 : 6, h: horiz ? 6 : CELL * 0.72 };
    if (kind === 'door') c.ops.push({ t: 'rect', ...rect, fill: '#9b6a35', stroke: fl.palette.wall, sw: 1.2 });
    else {
      c.ops.push({ t: 'rect', ...rect, fill: '#c9a0e8', stroke: '#4b2a66', sw: 1.2, dm: true });
      c.ops.push({ t: 'text', x: mx, y: my - 5, s: 'S', size: 10, fill: '#4b2a66', anchor: 'middle', bold: true, dm: true });
    }
  }
  // stairs in the entrance room
  const e = rooms[0];
  for (let i = 0; i < 4; i++) c.ops.push({ t: 'lines', segs: [X(e.x + 1) + i * 5, Y(e.y + 1), X(e.x + 1) + i * 5, Y(e.y + 3)], stroke: fl.palette.wall, sw: 1.4 });
  c.ops.push({ t: 'text', x: X(e.x + 1), y: Y(e.y + 3) + 11, s: 'UP', size: 9, fill: fl.palette.wall, bold: true });

  // ---- the key ----
  const key: KeyEntry[] = [];
  const exitsOf = (q: Room): string => {
    const out: string[] = [];
    for (const [k, kind] of door) {
      if (kind === 'secret') continue;
      const [dir, rest] = [k[0], k.slice(1)];
      const [x, y] = rest.split(',').map(Number);
      const a: [number, number] = [x, y], b: [number, number] = dir === 'v' ? [x, y + 1] : [x + 1, y];
      const [inside, outside] = at(a[0], a[1]) === q.id ? [a, b] : at(b[0], b[1]) === q.id ? [b, a] : [null, null];
      if (!inside || !outside) continue;
      const d = outside[0] > inside[0] ? 'east' : outside[0] < inside[0] ? 'west' : outside[1] > inside[1] ? 'south' : 'north';
      out.push(`${d} (${kind === 'arch' ? 'archway' : 'door'})`);
    }
    return out.join(', ') || 'none visible';
  };
  const secretIn = (q: Room): string[] => {
    const out: string[] = [];
    for (const [k, kind] of door) {
      if (kind !== 'secret') continue;
      const [dir, rest] = [k[0], k.slice(1)];
      const [x, y] = rest.split(',').map(Number);
      const a: [number, number] = [x, y], b: [number, number] = dir === 'v' ? [x, y + 1] : [x + 1, y];
      if ((at(a[0], a[1]) === q.id || at(b[0], b[1]) === q.id) && !out.length) out.push('a secret door (DC 15 to find)');
    }
    return out;
  };
  const used = new Set<string>();
  for (const q of rooms) {
    let purpose = pick(r, fl.rooms);
    for (let i = 0; i < 6 && used.has(purpose); i++) purpose = pick(r, fl.rooms);
    used.add(purpose);
    const light = pick(r, DUNGEON_LIGHT), sense = pick(r, DUNGEON_SENSE);
    const dm: string[] = [`Occupants: ${pick(r, fl.occupants)}.`];
    if (chance(r, 0.45)) dm.push(`Hazard: ${pick(r, DUNGEON_HAZARD)}.`);
    if (chance(r, 0.4)) dm.push(`Secret: ${pick(r, DUNGEON_SECRET)}.`);
    if (chance(r, 0.4)) dm.push(`Treasure: ${pick(r, DUNGEON_LOOT)}.`);
    dm.push(...secretIn(q).map((s) => `Hidden: ${s}.`));
    const entrance = q.id === 1;
    key.push({
      n: String(q.id),
      name: entrance ? 'Entrance' : noArticle(purpose),
      text: `${entrance ? 'A stair climbs out of the dark here. ' : ''}${cap(purpose)}, ${q.w * 5} by ${q.h * 5} ft, ${light}; ${sense}. ${cap(pick(r, fl.features))}. Exits: ${exitsOf(q)}.`,
      dm: [...new Set(dm)].join(' '),
    });
  }
  // traps in the corridors (DM view only)
  const corr = floorCells.filter(([x, y]) => at(x, y) === -1);
  const trapN = size === 'small' ? 1 : size === 'medium' ? 2 : 4;
  for (let i = 0; i < trapN && corr.length; i++) {
    const [x, y] = corr.splice(int(r, 0, corr.length - 1), 1)[0];
    const n = `T${i + 1}`;
    c.ops.push({ t: 'circle', x: X(x) + CELL / 2, y: Y(y) + CELL / 2, r: 7, fill: '#f2b8b0', stroke: '#8a2a20', sw: 1.2, dm: true });
    c.ops.push({ t: 'text', x: X(x) + CELL / 2, y: Y(y) + CELL / 2 + 3.5, s: n, size: 8, fill: '#6b1a12', anchor: 'middle', bold: true, dm: true });
    key.push({ n, name: 'Trap', text: 'A stretch of corridor that looks like any other.', dm: `${cap(pick(r, DUNGEON_HAZARD))}. Spot DC 13, disarm DC 13.` });
  }
  // room numbers on top of everything
  for (const q of rooms) {
    const mx = X(cx(q)) + CELL / 2, my = Y(cy(q)) + CELL / 2;
    c.ops.push({ t: 'circle', x: mx, y: my, r: 10, fill: '#fffaf0', stroke: fl.palette.wall, sw: 1.4 });
    c.ops.push({ t: 'text', x: mx, y: my + 4, s: String(q.id), size: q.id > 9 ? 10 : 12, fill: '#1f1b18', anchor: 'middle', bold: true });
  }
  const title = placeName('dungeon', 'common', r, o.avoid);
  c.ops.push({ t: 'text', x: PX, y: 24, s: title, size: 18, fill: '#2a2218', bold: true });
  c.ops.push({ t: 'text', x: PX, y: PY + H * CELL + 18, s: `${cap(fname)} · ${size} · seed ${seed} · 1 square = 5 ft`, size: 11, fill: '#3a3128' });

  return {
    kind: 'dungeon', seed, size, flavour: fname, title, ftPerCell: 5, canvas: c, key,
    legend: ['Brown rectangle: door', 'Gap in the wall: open archway', 'UP: stairs to the surface', 'DM view only: S = secret door, T = trap'],
    stats: { rooms: rooms.length, total: rooms.length, reached, connected: reached === rooms.length, doors: door.size, secretDoors: [...door.values()].filter((v) => v === 'secret').length, width: W, height: H },
  };
}
