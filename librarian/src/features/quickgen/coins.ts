// Gold and coin amounts. Our own formula, not a published table.
//
//   tier   = party level 1-4 -> 1, 5-10 -> 2, 11-16 -> 3, 17-20 -> 4
//            (a challenge rating counts as level ceil(CR), at least 1, at most 20)
//   value  = dice(tier) x unit(tier, mode) x (1 + 0.1 x levels into the tier)
//
//   individual: 2d6 x 1 gp | 3d6 x 5 gp | 4d6 x 25 gp | 5d6 x 100 gp   (a pocketful)
//   hoard:      6d6 x 10 gp | 8d6 x 100 gp | 10d6 x 800 gp | 12d6 x 5000 gp
//
// The value is then split into coins that follow the world's coin setting:
//   gold: gold pieces only
//   gsc:  gold, silver, copper (most of it gold, the rest loose change)
//   all:  also electrum, and platinum for big sums
// totalCp is always the exact sum of the coins shown (pp = 1000 cp, gp = 100,
// ep = 50, sp = 10, cp = 1).
import { type Rng, dice, makeRng, seedOf } from './rng.ts';

export type CoinMode = 'individual' | 'hoard';
export type CoinSetting = 'gsc' | 'all' | 'gold';
export interface CoinOpts { mode?: string; level?: number | string; cr?: number | string; seed?: string | number; coins?: string }
export interface CoinResult {
  seed: string;
  mode: CoinMode;
  level: number;
  cr: number | null;
  tier: number;
  coinSetting: CoinSetting;
  roll: string;
  pp: number; gp: number; ep: number; sp: number; cp: number;
  totalCp: number;
  text: string;
}

const DICE: Record<CoinMode, [number, number][]> = {
  individual: [[2, 1], [3, 5], [4, 25], [5, 100]],
  hoard: [[6, 10], [8, 100], [10, 800], [12, 5000]],
};
const TIER_START = [1, 5, 11, 17];
export const tierOf = (level: number) => (level >= 17 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1);

const nz = (n: number, unit: string) => (n ? `${n.toLocaleString('en-US')} ${unit}` : '');
export const coinText = (c: { pp: number; gp: number; ep: number; sp: number; cp: number }) =>
  [nz(c.pp, 'pp'), nz(c.gp, 'gp'), nz(c.ep, 'ep'), nz(c.sp, 'sp'), nz(c.cp, 'cp')].filter(Boolean).join(', ') || '0 cp';

function split(r: Rng, valueCp: number, setting: CoinSetting) {
  const out = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
  if (setting === 'gold') { out.gp = Math.max(1, Math.round(valueCp / 100)); return out; }
  let left = valueCp;
  if (setting === 'all') {
    if (left >= 100_000) { out.pp = Math.floor((left * (0.1 + r() * 0.35)) / 1000); left -= out.pp * 1000; }
    if (left >= 5_000) { out.ep = Math.floor((left * (r() * 0.08)) / 50); left -= out.ep * 50; }
  }
  const gold = Math.floor((left * (0.85 + r() * 0.15)) / 100);
  out.gp = gold; left -= gold * 100;
  out.sp = Math.floor(left / 10); left -= out.sp * 10;
  out.cp = left;
  return out;
}

export function genCoins(opts: CoinOpts = {}): CoinResult {
  const mode = String(opts.mode ?? 'individual').toLowerCase();
  if (mode !== 'individual' && mode !== 'hoard') throw new RangeError('mode must be individual or hoard');
  const setting: CoinSetting = opts.coins === 'all' || opts.coins === 'gold' ? opts.coins : 'gsc';
  let cr: number | null = null;
  let level: number;
  if (opts.cr !== undefined && opts.cr !== '' && opts.cr !== null && (opts.level === undefined || opts.level === '')) {
    const raw = String(opts.cr);
    const frac = /^(\d+)\/(\d+)$/.exec(raw);
    const n = frac ? Number(frac[1]) / Number(frac[2]) : Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 30) throw new RangeError('cr must be a number from 0 to 30 (or a fraction like 1/2)');
    cr = n;
    level = Math.min(20, Math.max(1, Math.ceil(n)));
  } else {
    level = Math.floor(Number(opts.level ?? 1));
    if (!Number.isFinite(level) || level < 1 || level > 20) throw new RangeError('level must be a whole number from 1 to 20');
  }
  const tier = tierOf(level);
  const seed = seedOf(opts.seed);
  const r = makeRng(seed);
  const [n, unitGp] = DICE[mode][tier - 1];
  const rolled = dice(r, n, 6);
  const scale = 1 + 0.1 * (level - TIER_START[tier - 1]);
  const valueCp = Math.max(1, Math.round(rolled * unitGp * scale * 100));
  const c = split(r, valueCp, setting);
  const totalCp = c.pp * 1000 + c.gp * 100 + c.ep * 50 + c.sp * 10 + c.cp;
  return { seed, mode, level, cr, tier, coinSetting: setting, roll: `${n}d6 x ${unitGp} gp x ${scale.toFixed(1)}`, ...c, totalCp, text: coinText(c) };
}
