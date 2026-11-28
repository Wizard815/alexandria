// Mana (spell points): an optional per-world rule that replaces spell slots.
// Each character has a pool; its maximum comes from the GM's formula or table
// by character level (or the GM sets it by hand); casting a spell costs mana
// from the GM's cost table (per spell level) unless the spell has its own
// cost. Rests give mana back as the world's settings say. The default cost
// table and pool formula are this app's own simple numbers, editable.
import { ABILITIES, type Ability } from './format.ts';
import type { Character } from './store.ts';

export const DEFAULT_COSTS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18];
export const DEFAULT_POOL = { mode: 'formula' as 'formula' | 'table', formula: 'level * 4 + mod', table: [4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80] };
export const DEFAULT_REST = { long: 'full' as RestGain, short: 'none' as RestGain };
export const DEFAULT_MAX_LEVEL = { on: false, table: [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 9, 9] };
export type RestGain = 'none' | 'quarter' | 'half' | 'full';
export const REST_GAINS: readonly RestGain[] = ['none', 'quarter', 'half', 'full'];

const intList = (v: unknown, n: number, min: number, max: number, what: string): number[] => {
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => Number.isInteger(x) && x >= min && x <= max)) throw new Error(`${what} must be ${n} whole numbers from ${min} to ${max}`);
  return v as number[];
};

export function checkCosts(v: unknown) { intList(v, 10, 0, 999, 'spellManaCosts (cantrip, then levels 1 to 9)'); }
export function checkPool(v: unknown) {
  const o = v as any;
  if (!o || typeof o !== 'object' || !['formula', 'table'].includes(o.mode)) throw new Error('spellManaPool.mode must be formula or table');
  intList(o.table, 20, 0, 9999, 'spellManaPool.table (character levels 1 to 20)');
  if (typeof o.formula !== 'string' || o.formula.length > 200) throw new Error('spellManaPool.formula must be text up to 200 characters');
  compile(o.formula); // throws on a bad formula
}
export function checkRest(v: unknown) {
  const o = v as any;
  if (!o || !REST_GAINS.includes(o.long) || !REST_GAINS.includes(o.short)) throw new Error(`spellManaRest needs long and short, each one of ${REST_GAINS.join(', ')}`);
}
export function checkMaxLevel(v: unknown) {
  const o = v as any;
  if (!o || typeof o.on !== 'boolean') throw new Error('spellManaMaxLevel.on must be true or false');
  intList(o.table, 20, 0, 9, 'spellManaMaxLevel.table (character levels 1 to 20)');
}

// ---- the pool formula: + - * / ( ), numbers, names and min/max/floor/ceil/round ------------------------------

type Node = { n: number } | { v: string } | { op: string; a: Node; b: Node } | { neg: Node } | { fn: string; args: Node[] };
const FNS: Record<string, (...x: number[]) => number> = { min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round, abs: Math.abs };
export const FORMULA_VARS = ['level', 'mod', 'str', 'dex', 'con', 'int', 'wis', 'cha', 'strMod', 'dexMod', 'conMod', 'intMod', 'wisMod', 'chaMod'];

export function compile(src: string): Node {
  const toks = src.match(/\d+(?:\.\d+)?|[A-Za-z_]\w*|[-+*/(),]|\S/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const take = (t?: string) => { const x = toks[i++]; if (t && x !== t) throw new Error(`The formula expects ${t} near "${x ?? 'the end'}"`); return x; };
  const atom = (): Node => {
    const t = take();
    if (t === undefined) throw new Error('The formula ends too early');
    if (t === '(') { const e = expr(); take(')'); return e; }
    if (t === '-') return { neg: atom() };
    if (/^\d/.test(t)) return { n: Number(t) };
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === '(') {
        if (!FNS[t]) throw new Error(`Unknown function in the formula: ${t}`);
        take('(');
        const args = [expr()];
        while (peek() === ',') { take(','); args.push(expr()); }
        take(')');
        return { fn: t, args };
      }
      if (!FORMULA_VARS.includes(t)) throw new Error(`Unknown name in the formula: ${t} (use ${FORMULA_VARS.join(', ')})`);
      return { v: t };
    }
    throw new Error(`Unexpected "${t}" in the formula`);
  };
  const term = (): Node => { let a = atom(); while (peek() === '*' || peek() === '/') { const op = take()!; a = { op, a, b: atom() }; } return a; };
  const expr = (): Node => { let a = term(); while (peek() === '+' || peek() === '-') { const op = take()!; a = { op, a, b: term() }; } return a; };
  if (!toks.length) throw new Error('The formula is empty');
  const e = expr();
  if (i < toks.length) throw new Error(`Unexpected "${toks[i]}" in the formula`);
  return e;
}

function evaluate(n: Node, vars: Record<string, number>): number {
  if ('n' in n) return n.n;
  if ('v' in n) return vars[n.v] ?? 0;
  if ('neg' in n) return -evaluate(n.neg, vars);
  if ('fn' in n) return FNS[n.fn](...n.args.map((a) => evaluate(a, vars)));
  const a = evaluate(n.a, vars), b = evaluate(n.b, vars);
  return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : b === 0 ? 0 : a / b;
}

export const abilityMod = (score: number | undefined): number => (typeof score === 'number' ? Math.floor((score - 10) / 2) : 0);

/** The spellcasting modifier: the character's chosen ability, else the best of INT, WIS and CHA. */
export function castingMod(c: Pick<Character, 'abilities' | 'castingAbility'>): number {
  if (c.castingAbility) return abilityMod(c.abilities[c.castingAbility]);
  const known = (['int', 'wis', 'cha'] as Ability[]).filter((k) => typeof c.abilities[k] === 'number');
  return known.length ? Math.max(...known.map((k) => abilityMod(c.abilities[k]))) : 0;
}

export interface ManaRules {
  on: boolean;
  costs: number[];
  pool: typeof DEFAULT_POOL;
  rest: typeof DEFAULT_REST;
  maxLevel: typeof DEFAULT_MAX_LEVEL;
  overdraw: boolean;
}

/** The pool's maximum: the GM's number for this character, else the formula or table at the character's level. Null without a level. */
export function poolMax(c: Character, r: ManaRules): number | null {
  if (c.manaMax !== null && c.manaMax !== undefined) return c.manaMax;
  if (!c.level) return null;
  const lv = Math.max(1, Math.min(20, c.level));
  if (r.pool.mode === 'table') return r.pool.table[lv - 1] ?? 0;
  const vars: Record<string, number> = { level: lv, mod: castingMod(c) };
  for (const k of ABILITIES) { vars[k] = c.abilities[k] ?? 10; vars[`${k}Mod`] = abilityMod(c.abilities[k]); }
  try { return Math.max(0, Math.floor(evaluate(compile(r.pool.formula), vars))); } catch { return null; }
}

/** Current mana: what is stored, or a full pool when nothing has been spent yet. */
export const poolNow = (c: Character, max: number | null): number | null => (c.mana !== null && c.mana !== undefined ? c.mana : max);

/** What casting this spell at this level costs: the GM's per-spell cost (plus the table's step for casting higher), else the table. */
export function castCost(spell: { level: number; manaOverride?: number | null; manaCost?: number | null }, castLevel: number, r: Pick<ManaRules, 'costs'>): number {
  const at = Math.max(spell.level, Math.min(9, castLevel));
  const own = spell.manaOverride ?? spell.manaCost ?? null;
  if (own === null || own === undefined) return r.costs[at] ?? 0;
  return own + Math.max(0, (r.costs[at] ?? 0) - (r.costs[spell.level] ?? 0));
}

/** The highest spell level the character may cast with mana, or null with no limit. */
export function maxCastLevel(c: Character, r: ManaRules): number | null {
  if (!r.maxLevel.on) return null;
  if (!c.level) return 0;
  return r.maxLevel.table[Math.max(1, Math.min(20, c.level)) - 1] ?? 0;
}

/** Mana back after a rest: none, a quarter, half or all of the maximum (never above it). */
export function restGain(gain: RestGain, cur: number, max: number): number {
  const add = gain === 'full' ? max : gain === 'half' ? Math.ceil(max / 2) : gain === 'quarter' ? Math.ceil(max / 4) : 0;
  return Math.max(cur, Math.min(max, cur + add));
}
