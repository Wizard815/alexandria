// Challenge rating math: our own table, from a smooth fit of the usual
// guidance (a creature's armor class, hit points, attack bonus, damage per round
// and save DC grow with challenge rating). The numbers are our own
// interpolation between anchor points, not copied from a published table;
// experience points are the standard published award per CR. When a game
// module is imported, its monsters are used first and are only retuned to
// these numbers when the target CR differs.
export const CR_STEPS = [0, 0.125, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
const XP: Record<number, number> = { 0: 10, 0.125: 25, 0.25: 50, 0.5: 100, 1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800, 6: 2300, 7: 2900, 8: 3900, 9: 5000, 10: 5900, 11: 7200, 12: 8400, 13: 10000, 14: 11500, 15: 13000, 16: 15000, 17: 18000, 18: 20000, 19: 22000, 20: 25000, 21: 33000, 22: 41000, 23: 50000, 24: 62000, 25: 75000, 26: 90000, 27: 105000, 28: 120000, 29: 135000, 30: 155000 };

type Anchors = [number, number][];
const AC: Anchors = [[0, 12], [1, 13], [4, 14], [8, 16], [12, 17], [16, 18], [20, 19], [30, 20]];
const HP: Anchors = [[0, 5], [0.125, 10], [0.25, 18], [0.5, 30], [1, 55], [2, 78], [3, 100], [4, 122], [5, 145], [6, 160], [8, 190], [10, 225], [12, 260], [14, 295], [16, 330], [18, 365], [20, 400], [22, 440], [25, 520], [30, 650]];
const ATK: Anchors = [[0, 3], [1, 4], [4, 6], [8, 8], [12, 9], [16, 11], [20, 13], [24, 14], [30, 16]];
const DMG: Anchors = [[0, 1], [0.125, 3], [0.25, 5], [0.5, 8], [1, 12], [2, 20], [3, 27], [4, 34], [5, 42], [8, 60], [10, 75], [12, 90], [16, 120], [20, 150], [30, 250]];
const DC: Anchors = [[0, 11], [1, 12], [4, 13], [8, 15], [12, 16], [16, 18], [20, 19], [30, 22]];

const lerp = (a: Anchors, x: number): number => {
  if (x <= a[0][0]) return a[0][1];
  for (let i = 1; i < a.length; i++) if (x <= a[i][0]) { const [x0, y0] = a[i - 1], [x1, y1] = a[i]; return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0); }
  return a[a.length - 1][1];
};

export interface CrRow { cr: number; label: string; prof: number; ac: number; hp: number; atk: number; dmg: number; dc: number; xp: number }
export const crLabel = (cr: number) => (cr === 0.125 ? '1/8' : cr === 0.25 ? '1/4' : cr === 0.5 ? '1/2' : String(cr));
export const profFor = (cr: number) => 2 + Math.max(0, Math.floor((Math.max(1, cr) - 1) / 4));

export function crRow(cr: number): CrRow {
  const c = Math.max(0, Math.min(30, cr));
  const step = CR_STEPS.reduce((b, s) => (Math.abs(s - c) < Math.abs(b - c) ? s : b), 0);
  return { cr: step, label: crLabel(step), prof: profFor(step), ac: Math.round(lerp(AC, step)), hp: Math.round(lerp(HP, step)), atk: Math.round(lerp(ATK, step)), dmg: Math.round(lerp(DMG, step)), dc: Math.round(lerp(DC, step)), xp: XP[step] };
}

/** "1/4", "0.5", 3 or "CR 3" to a CR number, or throws RangeError. */
export function parseCr(v: unknown): number {
  const raw = String(v ?? '').trim().replace(/^cr\s*/i, '');
  const frac = /^(\d+)\/(\d+)$/.exec(raw);
  const n = frac ? Number(frac[1]) / Number(frac[2]) : Number(raw);
  if (!raw || !Number.isFinite(n) || n < 0 || n > 30) throw new RangeError('cr must be a number from 0 to 30 (or 1/8, 1/4, 1/2)');
  return CR_STEPS.reduce((b, s) => (Math.abs(s - n) < Math.abs(b - n) ? s : b), 0);
}

/** A CR for one creature a party of this level and size can face: a tough fight, or a boss that takes the whole table. */
export function crForParty(level: number, size: number, boss: boolean): number {
  const l = Math.max(1, Math.min(20, Math.floor(level))), s = Math.max(1, Math.min(10, Math.floor(size)));
  const raw = l * (s / 4) * (boss ? 1.05 : 0.7);
  return CR_STEPS.reduce((b, st) => (Math.abs(st - raw) < Math.abs(b - raw) ? st : b), 0.125);
}
