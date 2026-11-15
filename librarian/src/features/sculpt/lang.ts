// The template language: inline calls ({{gen:...}}, {{dice:...}}, {{pick:...}}),
// blocks ({{#if}}, {{#each}}), dice, and the seeded random numbers that make a
// render repeatable (the same values always render the same text).
import { makeRng, type Rng } from '../quickgen/rng.ts';

export { makeRng };
export type { Rng };

/** A short stable hash of a string, for seeds. */
export function hashStr(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export const pickOf = <T,>(r: Rng, a: readonly T[]): T => a[Math.floor(r() * a.length)];
export const intIn = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

// ---- dice ----
export interface Roll { total: number; text: string }
/** Roll "2d6+3", "d20", "1d8+1d4-2" or a plain number. Throws RangeError on nonsense. */
export function rollDice(expr: string, r: Rng): Roll {
  const src = expr.trim().toLowerCase().replace(/\s+/g, '');
  if (!src) throw new RangeError('empty dice expression');
  if (!/^[+-]?(\d*d\d+|\d+)([+-](\d*d\d+|\d+))*$/.test(src)) throw new RangeError(`not a dice expression: ${expr.slice(0, 40)}`);
  let total = 0;
  const shown: string[] = [];
  let dieCount = 0;
  for (const m of src.matchAll(/([+-]?)(\d*)d(\d+)|([+-]?)(\d+)/g)) {
    if (m[3] !== undefined) {
      const sign = m[1] === '-' ? -1 : 1;
      const n = m[2] === '' ? 1 : Number(m[2]);
      const sides = Number(m[3]);
      dieCount += n;
      if (n > 100 || sides < 1 || sides > 1000 || dieCount > 200) throw new RangeError('too many dice');
      let sub = 0;
      for (let i = 0; i < n; i++) sub += intIn(r, 1, sides);
      total += sign * sub;
      shown.push(`${sign < 0 ? '-' : shown.length ? '+' : ''}${n}d${sides}`);
    } else {
      const sign = m[4] === '-' ? -1 : 1;
      total += sign * Number(m[5]);
      shown.push(`${sign < 0 ? '-' : shown.length ? '+' : ''}${m[5]}`);
    }
  }
  return { total, text: shown.join('') };
}
export const rollText = (expr: string, r: Rng): string => { const x = rollDice(expr, r); return /d/i.test(expr) ? `${x.total} (${x.text})` : String(x.total); };

// ---- inline calls ----
export interface Call { kind: 'gen' | 'dice' | 'pick'; name: string; params: Record<string, string>; raw: string }
export const CALL_RE = /\{\{\s*((?:gen|dice|pick):[^{}]*?)\s*\}\}/g;

/** key=value pairs; a value may be "quoted with spaces". */
export function parseParams(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([a-z_][a-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S*))/gi)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

export function parseCall(inner: string): Call | null {
  const m = /^\s*(gen|dice|pick):\s*([\s\S]*?)\s*$/.exec(inner);
  if (!m) return null;
  const kind = m[1] as Call['kind'];
  const rest = m[2];
  if (kind === 'dice') return { kind, name: rest, params: {}, raw: inner.trim() };
  if (kind === 'pick') return { kind, name: rest, params: {}, raw: inner.trim() };
  const g = /^([a-z][a-z0-9_]*)\s*([\s\S]*)$/i.exec(rest);
  if (!g) return null;
  return { kind, name: g[1].toLowerCase(), params: parseParams(g[2]), raw: inner.trim() };
}

/** Replace $name in an expression with a value (a field, or a context variable). */
export function substitute(expr: string, get: (name: string) => string): string {
  return expr.replace(/\$([a-z_][a-z0-9_.]*)/gi, (_m, n: string) => get(n.replace(/\.$/, '')));
}

// ---- blocks: {{#if x}} ... {{else}} ... {{/if}}, {{#each list}} ... {{/each}} ----
type Node = { t: 'text'; s: string } | { t: 'if'; cond: string; yes: Node[]; no: Node[] } | { t: 'each'; list: string; body: Node[] };
const TAG_RE = /\{\{\s*(#if\s+[^{}]+?|#each\s+[^{}]+?|else|\/if|\/each)\s*\}\}/g;

export function parseBlocks(src: string): Node[] {
  const root: Node[] = [];
  const stack: { node: Node; kind: 'if' | 'each'; inElse: boolean }[] = [];
  const cur = (): Node[] => {
    const top = stack.at(-1);
    if (!top) return root;
    if (top.node.t === 'if') return top.inElse ? top.node.no : top.node.yes;
    return (top.node as Extract<Node, { t: 'each' }>).body;
  };
  let last = 0;
  for (const m of src.matchAll(TAG_RE)) {
    if (m.index! > last) cur().push({ t: 'text', s: src.slice(last, m.index) });
    last = m.index! + m[0].length;
    const tag = m[1].trim();
    if (tag.startsWith('#if')) {
      const node: Node = { t: 'if', cond: tag.slice(3).trim(), yes: [], no: [] };
      cur().push(node);
      stack.push({ node, kind: 'if', inElse: false });
    } else if (tag.startsWith('#each')) {
      const node: Node = { t: 'each', list: tag.slice(5).trim(), body: [] };
      cur().push(node);
      stack.push({ node, kind: 'each', inElse: false });
    } else if (tag === 'else') {
      const top = stack.at(-1);
      if (top?.kind === 'if') top.inElse = true;
    } else {
      const want = tag === '/if' ? 'if' : 'each';
      if (stack.at(-1)?.kind === want) stack.pop();
    }
  }
  if (last < src.length) cur().push({ t: 'text', s: src.slice(last) });
  return root;
}

export interface BlockEnv {
  /** Is this field or context variable non-blank? */
  truthy: (name: string) => boolean;
  /** The items of a list field or a context list. */
  items: (name: string) => string[];
}
const MAX_EACH = 200;

export function expandBlocks(src: string, env: BlockEnv): string {
  if (!/\{\{\s*(#if|#each)\b/.test(src)) return src;
  const run = (nodes: Node[], item?: { text: string; i: number }): string => nodes.map((n) => {
    if (n.t === 'text') return item ? n.s.replace(/\{\{\s*this(?:\.(\d+))?\s*\}\}/g, (_m, c) => (c ? (item.text.split('|')[Number(c) - 1] ?? '').trim() : item.text)).replace(/\{\{\s*@index\s*\}\}/g, String(item.i)).replace(/\{\{\s*@n\s*\}\}/g, String(item.i + 1)) : n.s;
    if (n.t === 'if') {
      const neg = n.cond.startsWith('!');
      const name = n.cond.replace(/^!\s*/, '').trim();
      const ok = env.truthy(name);
      return run(neg ? (ok ? n.no : n.yes) : ok ? n.yes : n.no, item);
    }
    return env.items(n.list.trim()).slice(0, MAX_EACH).map((text, i) => run(n.body, { text, i })).join('');
  }).join('');
  return run(parseBlocks(src));
}

/** The lines of a list value, without bullets. */
export const listItems = (v: string): string[] => (v ?? '').split(/\r?\n/).map((l) => l.replace(/^\s*([-*+]|\d+[.)])\s+/, '').trim()).filter(Boolean);
