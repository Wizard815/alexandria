// "/roll 2d6+3 sneak attack": rolled on the server so nobody can fudge it.
import { randomInt } from 'node:crypto';
import { HttpError } from '../../core/util.ts';

export interface RollTerm { term: string; dice: number[]; kept?: number[]; sum: number }
export interface Roll { expr: string; terms: RollTerm[]; total: number; note: string }

const MAX_DICE = 100;
const MAX_SIDES = 1000;

/** A message that starts with /roll. */
export function isRoll(body: string): boolean { return /^\/roll(\s|$)/i.test(body.trim()); }

/**
 * Terms: NdM (optional kh/kl/dh/dl count), whole numbers, joined by + or -.
 * Anything after the expression is a comment ("attack").
 */
export function parseRoll(body: string, rng: (sides: number) => number = (n) => randomInt(1, n + 1)): Roll {
  const m = /^\/roll\s*(.*)$/is.exec(body.trim());
  let pos = (m?.[1] ?? '').trim();
  const re = /^([+-]?)\s*(?:(\d*)d(\d+)(?:(kh|kl|dh|dl)(\d+)?)?|(\d+))/i;
  const terms: RollTerm[] = [];
  let total = 0;
  let count = 0;
  let first = true;
  let exprText = '';
  while (pos) {
    const t = re.exec(pos);
    if (!t || (!first && !t[1])) break;
    const sign = t[1] === '-' ? -1 : 1;
    const mark = sign < 0 ? '-' : '+';
    if (t[6] !== undefined) {
      const n = Number(t[6]);
      if (n > 1_000_000) throw new HttpError(400, 'That number is too big');
      terms.push({ term: `${mark}${n}`, dice: [], sum: sign * n });
      total += sign * n;
    } else {
      const n = t[2] === '' ? 1 : Number(t[2]);
      const sides = Number(t[3]);
      if (n < 1 || sides < 1) throw new HttpError(400, 'Dice need at least 1 die with 1 side');
      count += n;
      if (count > MAX_DICE || sides > MAX_SIDES) throw new HttpError(400, `Roll at most ${MAX_DICE} dice with up to ${MAX_SIDES} sides`);
      const dice = Array.from({ length: n }, () => rng(sides));
      let kept = dice;
      if (t[4]) {
        const k = Math.min(n, t[5] ? Number(t[5]) : 1);
        const sorted = [...dice].sort((a, b) => a - b);
        const mode = t[4].toLowerCase();
        kept = mode === 'kh' ? sorted.slice(n - k) : mode === 'kl' ? sorted.slice(0, k) : mode === 'dh' ? sorted.slice(0, n - k) : sorted.slice(k);
      }
      const sum = kept.reduce((a, b) => a + b, 0);
      terms.push({ term: `${mark}${n}d${sides}${t[4] ? `${t[4].toLowerCase()}${t[5] ?? 1}` : ''}`, dice, kept: t[4] ? kept : undefined, sum: sign * sum });
      total += sign * sum;
    }
    exprText += t[0].replace(/\s+/g, '');
    pos = pos.slice(t[0].length).trimStart();
    first = false;
    if (!/^[+-]/.test(pos)) break;
  }
  if (!terms.length) throw new HttpError(400, 'Try /roll 2d6+3 or /roll d20');
  return { expr: exprText.replace(/^\+/, ''), terms, total, note: pos.slice(0, 120) };
}
