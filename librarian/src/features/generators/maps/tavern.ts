// Tavern floor plan: the ground floor (common room, bar, hearth, tables, kitchen,
// store and cellar hatch) beside the upstairs (corridor and guest rooms). A
// flavour changes the look and a few fixtures. 1 square = 5 ft.
import { chance, int, makeRng, pick, seedOf } from '../../quickgen/rng.ts';
import { placeName } from '../names.ts';
import { type Canvas, newCanvas } from './canvas.ts';
import { TAVERN_ROOM_NOTES } from './tables.ts';
import { type KeyEntry, type MapOpts, type MapResult, cap, sizeOf } from './util.ts';

const CELL = 22, PX = 16, PY = 40;
export const TAVERN_FLAVOURS = ['common', 'dwarven', 'elven', 'pirate', 'haunted'] as const;
const PAL: Record<string, { floor: string; floor2: string; wall: string; bg: string; table: string }> = {
  common: { floor: '#dcc193', floor2: '#e4cfa8', wall: '#3b2c20', bg: '#cfc4a8', table: '#a8773f' },
  dwarven: { floor: '#c4bcae', floor2: '#cfc7b8', wall: '#2f2b28', bg: '#b9b1a1', table: '#7d6a55' },
  elven: { floor: '#d4dfbc', floor2: '#dfe8cb', wall: '#3a4a35', bg: '#c3d0aa', table: '#b09a6a' },
  pirate: { floor: '#c4a273', floor2: '#cfb083', wall: '#2c2118', bg: '#b9b8a0', table: '#8a5a30' },
  haunted: { floor: '#c4c4cc', floor2: '#cdcdd5', wall: '#25252d', bg: '#b3b3bd', table: '#78707c' },
};
const PER_SIDE = { small: 2, medium: 3, large: 4 };
const WIDTH = { small: 22, medium: 28, large: 36 };
const H = 18;

export function genTavernMap(o: MapOpts = {}): MapResult {
  const seed = seedOf(o.seed);
  const size = sizeOf(o.size);
  const fname = (TAVERN_FLAVOURS as readonly string[]).includes(String(o.flavour)) ? String(o.flavour) : 'common';
  const pal = PAL[fname];
  const r = makeRng(`${seed}|tavern|${size}|${fname}`);
  const W = WIDTH[size], per = PER_SIDE[size];
  const GAP = 3;
  const c: Canvas = newCanvas((W * 2 + GAP) * CELL + PX * 2, H * CELL + PY + 46, pal.bg);
  const X = (fx: number, x: number) => PX + (fx + x) * CELL, Y = (y: number) => PY + y * CELL;
  const line = (fx: number, x1: number, y1: number, x2: number, y2: number, sw = 3.4) => c.ops.push({ t: 'lines', segs: [X(fx, x1), Y(y1), X(fx, x2), Y(y2)], stroke: pal.wall, sw });
  const door = (fx: number, x: number, y: number, vertical: boolean) => c.ops.push({ t: 'rect', x: vertical ? X(fx, x) - 3 : X(fx, x) - CELL * 0.45, y: vertical ? Y(y) - CELL * 0.45 : Y(y) - 3, w: vertical ? 6 : CELL * 0.9, h: vertical ? CELL * 0.9 : 6, fill: '#9b6a35', stroke: pal.wall, sw: 1 });
  const label = (fx: number, x: number, y: number, s: string, size = 10, fill = '#2a2218') => c.ops.push({ t: 'text', x: X(fx, x), y: Y(y), s, size, fill, anchor: 'middle', bold: true });
  const num = (fx: number, x: number, y: number, s: string) => {
    c.ops.push({ t: 'circle', x: X(fx, x), y: Y(y), r: 10, fill: '#fffaf0', stroke: pal.wall, sw: 1.2 });
    c.ops.push({ t: 'text', x: X(fx, x), y: Y(y) + 4, s, size: s.length > 1 ? 9 : 12, fill: '#1f1b18', anchor: 'middle', bold: true });
  };

  // ---- ground floor ----
  const G = 0;
  const cw = W - 10; // common room width
  c.ops.push({ t: 'rect', x: X(G, 0), y: Y(0), w: W * CELL, h: H * CELL, fill: pal.floor });
  // plank lines
  const planks: number[] = [];
  for (let y = 1; y < H; y++) planks.push(X(G, 0), Y(y), X(G, W), Y(y));
  c.ops.push({ t: 'lines', segs: planks, stroke: '#00000022'.slice(0, 7), sw: 0.6, a: 0.12 });
  // outer walls and partitions
  c.ops.push({ t: 'rect', x: X(G, 0), y: Y(0), w: W * CELL, h: H * CELL, stroke: pal.wall, sw: 5 });
  line(G, cw, 0, cw, H);
  line(G, cw, 9, W, 9);
  // doors: front entry (south), bar hatch to the kitchen, store door, back door
  const entryX = Math.floor(cw / 2);
  c.ops.push({ t: 'rect', x: X(G, entryX - 1), y: Y(H) - 3, w: 2 * CELL, h: 6, fill: '#9b6a35', stroke: pal.wall, sw: 1 });
  label(G, entryX, H + 1.1, 'ENTRY', 9);
  door(G, cw, 5, true);
  door(G, cw, 13, true);
  c.ops.push({ t: 'rect', x: X(G, W) - 3, y: Y(4) - CELL * 0.45, w: 6, h: CELL * 0.9, fill: '#9b6a35', stroke: pal.wall, sw: 1 });
  // bar counter with stools
  c.ops.push({ t: 'rect', x: X(G, cw - 4), y: Y(2), w: 2 * CELL, h: 9 * CELL, fill: pal.table, stroke: pal.wall, sw: 2 });
  for (let y = 3; y < 11; y += 2) c.ops.push({ t: 'circle', x: X(G, cw - 5) + 4, y: Y(y) + CELL / 2, r: 6, fill: '#c9b48a', stroke: pal.wall, sw: 1 });
  label(G, cw - 3, 6.2, 'BAR', 10, '#fff5e0');
  // hearth on the west wall
  c.ops.push({ t: 'rect', x: X(G, 0), y: Y(7), w: 2.5 * CELL, h: 4 * CELL, fill: fname === 'dwarven' ? '#d9792f' : '#c96a2a', stroke: pal.wall, sw: 2 });
  c.ops.push({ t: 'text', x: X(G, 1.2), y: Y(9.2), s: 'HEARTH', size: 8, fill: '#fff', anchor: 'middle', bold: true });
  // tables
  const tables: [number, number][] = [];
  const want = size === 'small' ? 5 : size === 'medium' ? 7 : 10;
  for (let t = 0; t < 400 && tables.length < want; t++) {
    const x = int(r, 4, cw - 8), y = int(r, 2, H - 3);
    if (x < 5 && y > 5 && y < 13) continue; // hearth
    if (tables.some(([a, b]) => Math.hypot(a - x, b - y) < 3.6)) continue;
    tables.push([x, y]);
  }
  for (const [x, y] of tables) {
    const cx = X(G, x) + CELL / 2, cy = Y(y) + CELL / 2, rad = fname === 'elven' ? 14 : 12;
    for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2 + 0.4; c.ops.push({ t: 'circle', x: cx + Math.cos(a) * (rad + 8), y: cy + Math.sin(a) * (rad + 8), r: 5, fill: '#c9b48a', stroke: pal.wall, sw: 1 }); }
    if (fname === 'dwarven' || fname === 'pirate') c.ops.push({ t: 'rect', x: cx - rad - 2, y: cy - rad * 0.7, w: 2 * rad + 4, h: rad * 1.4, fill: pal.table, stroke: pal.wall, sw: 1.4 });
    else c.ops.push({ t: 'circle', x: cx, y: cy, r: rad, fill: pal.table, stroke: pal.wall, sw: 1.4 });
  }
  // flavour fixtures
  const fixtures: string[] = [];
  if (fname === 'dwarven') { for (let i = 0; i < 5; i++) c.ops.push({ t: 'circle', x: X(G, 3 + i * 2) + 8, y: Y(0) + 15, r: 9, fill: '#8a6b45', stroke: pal.wall, sw: 1.4 }); fixtures.push('a row of ale barrels along the north wall'); }
  if (fname === 'elven') { for (const px of [4, cw - 9]) { c.ops.push({ t: 'circle', x: X(G, px), y: Y(H / 2) - 4, r: 15, fill: '#9bb07c', stroke: pal.wall, sw: 2 }); } fixtures.push('two living tree trunks growing through the floor'); }
  if (fname === 'pirate') { c.ops.push({ t: 'circle', x: X(G, 3), y: Y(3), r: 16, stroke: pal.wall, sw: 2.4 }); for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI; c.ops.push({ t: 'lines', segs: [X(G, 3) - Math.cos(a) * 16, Y(3) - Math.sin(a) * 16, X(G, 3) + Math.cos(a) * 16, Y(3) + Math.sin(a) * 16], stroke: pal.wall, sw: 2 }); } fixtures.push('a ship\'s wheel bolted to the wall'); }
  if (fname === 'haunted') { c.ops.push({ t: 'circle', x: X(G, 2.5), y: Y(15), r: 9, fill: '#d8d8e8', stroke: pal.wall, sw: 1.4 }); c.ops.push({ t: 'text', x: X(G, 2.5), y: Y(15) + 3.5, s: 'X', size: 10, fill: '#5a2a6a', anchor: 'middle', bold: true, gm: true }); fixtures.push('one chair that is always cold, and is never moved'); }
  if (fname === 'common' || fname === 'elven' || fname === 'pirate') { c.ops.push({ t: 'rect', x: X(G, 1), y: Y(1), w: 5 * CELL, h: 2.5 * CELL, fill: '#8d6a3c', stroke: pal.wall, sw: 1.6, a: 0.85 }); label(G, 3.5, 2.4, 'STAGE', 8, '#fff5e0'); fixtures.push('a small stage in the north-west corner'); }
  // kitchen and store
  label(G, cw + 5, 4.6, 'KITCHEN', 9);
  c.ops.push({ t: 'rect', x: X(G, W - 4), y: Y(1), w: 3 * CELL, h: 2 * CELL, fill: '#b8b2a6', stroke: pal.wall, sw: 1.6 });
  label(G, W - 2.5, 2.3, 'OVEN', 7);
  c.ops.push({ t: 'rect', x: X(G, cw + 1), y: Y(6), w: 4 * CELL, h: 2 * CELL, fill: pal.table, stroke: pal.wall, sw: 1.4 });
  label(G, cw + 3, 7.2, 'PREP', 7, '#fff5e0');
  label(G, cw + 5, 11, 'STORE', 9);
  // stairs up and cellar hatch
  for (let i = 0; i < 5; i++) c.ops.push({ t: 'lines', segs: [X(G, W - 6) + i * 8, Y(13), X(G, W - 6) + i * 8, Y(16)], stroke: pal.wall, sw: 1.4 });
  label(G, W - 4.2, 16.9, 'UP', 8);
  c.ops.push({ t: 'rect', x: X(G, cw + 1), y: Y(14), w: 2 * CELL, h: 2.5 * CELL, fill: '#8d6a3c', stroke: pal.wall, sw: 1.6 });
  label(G, cw + 2, 15.4, 'CELLAR', 7, '#fff5e0');
  num(G, Math.floor(cw / 2), 8, '1'); // common room
  num(G, cw - 3, 1, '2'); // bar
  num(G, cw + 5, 3, '3'); // kitchen
  num(G, cw + 5, 11.5, '4'); // store
  num(G, cw + 2, 16.6, '5'); // cellar

  // ---- upstairs ----
  const U = W + GAP;
  c.ops.push({ t: 'rect', x: X(U, 0), y: Y(0), w: W * CELL, h: H * CELL, fill: pal.floor2 });
  c.ops.push({ t: 'rect', x: X(U, 0), y: Y(0), w: W * CELL, h: H * CELL, stroke: pal.wall, sw: 5 });
  const cy0 = 7, cy1 = 10;
  line(U, 0, cy0, W, cy0); line(U, 0, cy1, W, cy1);
  const key: KeyEntry[] = [
    { n: '1', name: 'Common room', text: `${W - 10 > 0 ? (cw * 5) : 0} ft across, ${tables.length} tables, ${fixtures.join(', ') || 'a hearth'} and the entry door to the street.` },
    { n: '2', name: 'Bar', text: 'A long counter with stools, taps and a hatch into the kitchen. Coin goes in the strongbox under the till.' },
    { n: '3', name: 'Kitchen', text: 'Hearth, oven and a long prep table. A back door opens onto the yard.' },
    { n: '4', name: 'Store', text: 'Sacks, crates and the stair to the guest floor. A good place to be unseen.' },
    { n: '5', name: 'Cellar', text: 'A hatch down to barrels, kegs and a cold store.', gm: chance(r, 0.5) ? 'Something here is not on the owner\'s inventory.' : undefined },
  ];
  const ws = Math.floor(W / per);
  let roomNo = 1;
  const roomKeys: KeyEntry[] = [];
  for (const side of ['n', 's'] as const) {
    for (let i = 0; i < per; i++) {
      const x0 = i * ws, x1 = i === per - 1 ? W : (i + 1) * ws;
      const y0 = side === 'n' ? 0 : cy1, y1 = side === 'n' ? cy0 : H;
      if (i > 0) line(U, x0, y0, x0, y1);
      door(U, (x0 + x1) / 2, side === 'n' ? cy0 : cy1, false);
      const owner = side === 's' && i === per - 1;
      const n = owner ? 'M' : String(roomNo++);
      num(U, (x0 + x1) / 2, (y0 + y1) / 2, n);
      // a bed or two
      const bw = Math.min(2.4, (x1 - x0) / 3) * CELL, bh = 3 * CELL;
      const by = side === 'n' ? Y(y0 + 0.6) : Y(y1 - 3.6);
      c.ops.push({ t: 'rect', x: X(U, x0 + 0.6), y: by, w: bw, h: bh, fill: '#e8dcc0', stroke: pal.wall, sw: 1.2 });
      if (!owner && chance(r, 0.5)) c.ops.push({ t: 'rect', x: X(U, x1) - 0.6 * CELL - bw, y: by, w: bw, h: bh, fill: '#e8dcc0', stroke: pal.wall, sw: 1.2 });
      roomKeys.push({ n: `R${n}`, name: owner ? 'Owner\'s room' : `Guest room ${n}`, text: owner ? `A big bed, a locked chest and a window over the road. ${(x1 - x0) * 5} by ${(y1 - y0) * 5} ft.` : `${cap(pick(r, TAVERN_ROOM_NOTES))}. ${(x1 - x0) * 5} by ${(y1 - y0) * 5} ft.`, gm: owner ? 'The chest holds the tavern\'s takings and a letter its owner would rather not have read.' : chance(r, 0.3) ? 'The current guest is not who they say they are.' : undefined });
    }
  }
  for (let i = 0; i < 5; i++) c.ops.push({ t: 'lines', segs: [X(U, W - 6) + i * 8, Y(cy0 + 0.6), X(U, W - 6) + i * 8, Y(cy1 - 0.6)], stroke: pal.wall, sw: 1.4 });
  label(U, W - 3.8, 8.9, 'DOWN', 8);
  label(U, 4, 8.8, 'CORRIDOR', 8);
  // floor captions
  const owner = o.title ?? placeName('tavern', fname, r, o.avoid);
  c.ops.push({ t: 'text', x: PX, y: 20, s: owner, size: 18, fill: '#2a2218', bold: true });
  c.ops.push({ t: 'text', x: X(G, 0), y: PY - 8, s: 'GROUND FLOOR', size: 10, fill: '#3a3128', bold: true });
  c.ops.push({ t: 'text', x: X(U, 0), y: PY - 8, s: 'UPSTAIRS', size: 10, fill: '#3a3128', bold: true });
  c.ops.push({ t: 'text', x: PX, y: PY + H * CELL + 36, s: `Tavern (${fname}) · ${size} · seed ${seed} · 1 square = 5 ft`, size: 11, fill: '#3a3128' });
  return {
    kind: 'tavern', seed, size, flavour: fname, title: owner, ftPerCell: 5, canvas: c, key: [...key, ...roomKeys],
    legend: ['Numbers: ground floor rooms', 'R: upstairs rooms (RM = owner\'s room)', ...fixtures.map(cap)],
    stats: { guestRooms: per * 2 - 1, tables: tables.length, rooms: 5 + per * 2, total: 5 + per * 2, reached: 5 + per * 2, connected: true, width: W, height: H },
  };
}
