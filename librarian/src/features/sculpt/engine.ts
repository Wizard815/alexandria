// The sculpting engine: deterministic generators first (names, stock, coins,
// encounters, the clock), then ONE chat call for the text that is still blank
// (for a batch, one call that returns an array). Rendering turns {{key}},
// {{#if}}, {{#each}}, inline {{gen:...}} and {{#dm}}...{{/dm}} into Markdown
// with secret blocks. The same values always render the same text.
import type { Deps } from '../../app.ts';
import { chatJson, hasJob, type ChatMessage } from '../../core/ai.ts';
import { one } from '../../core/db.ts';
import type { Viewer } from '../../core/policy.ts';
import { normalizeStatblock, statblockMarkdown } from '../agent/statblock.ts';
import { genNames as qgNames, genItems as qgItems } from '../quickgen/api.ts';
import { bodyHash, firstLeak, makeCtx, type Overrides, type RenderCtx } from './ctx.ts';
import { GENERATORS, isExpr, runCall, runExpr } from './gens.ts';
import { CALL_RE, expandBlocks, hashStr, listItems, makeRng, parseCall, rollDice, rollText, type BlockEnv } from './lang.ts';
import type { Field, TemplateDef } from './templates.ts';

export { bodyHash };
export type Values = Record<string, string>;
export interface Tpl extends Omit<TemplateDef, 'key'> { id: string }
export interface Part { dm: boolean; md: string }
export interface SculptResult { values: Values; md: string; parts: Part[]; notes: string[]; filled: string[]; model: boolean; usedModel: boolean; leaks: { key: string; match: string }[] }
export interface BatchResult extends SculptResult { results: SculptResult[]; count: number; batch: boolean }

const PLAYER: Viewer = { accountId: 'sculpt-player-view', role: 'player' };
const SEED = '__seed';

// ---- local generators ----
const pick = <T,>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const A = ['Bra', 'Cal', 'Dor', 'El', 'Fen', 'Gar', 'Hal', 'Ira', 'Jor', 'Kes', 'Lir', 'Mar', 'Nel', 'Or', 'Per', 'Quin', 'Rhe', 'Sel', 'Tam', 'Ul', 'Ves', 'Wyn'];
const B = ['a', 'e', 'i', 'o', 'u', 'ia', 'ei', 'or', 'an', 'el'];
const C = ['dric', 'wen', 'ra', 'mund', 'thas', 'lin', 'na', 'ric', 'vik', 'sa', 'dan', 'bel', 'mar', 'tor'];
const SURN = ['Ashby', 'Brightwater', 'Cobb', 'Dunmere', 'Fairweather', 'Greyfield', 'Hollis', 'Marsh', 'Thorne', 'Whitlock'];
const localName = (): string => `${pick(A)}${pick(B)}${pick(C)} ${pick(SURN)}`;

/** A name from quick gen, using the race and gender fields when they are filled. */
function genName(race: string, gender: string): { name: string; race?: string } {
  try {
    const r = qgNames({ race: race.trim().toLowerCase() || 'any', gender: gender.trim().toLowerCase() || 'any', count: 1 });
    const n = r.names[0];
    if (n?.name) return { name: n.name, race: n.race };
  } catch { /* unknown race or gender: plain name */ }
  return { name: localName() };
}

const STOCK: Record<string, [string, number][]> = {
  smith: [['Dagger', 200], ['Shortsword', 1000], ['Longsword', 1500], ['Handaxe', 500], ['Shield', 1000], ['Chain shirt', 5000], ['Iron spikes (10)', 100], ['Warhammer', 1500], ['Crossbow bolts (20)', 100]],
  alchemist: [["Potion of healing", 5000], ['Antitoxin', 5000], ["Alchemist's fire", 5000], ['Acid vial', 2500], ['Ink and quill', 1000], ['Herbal salve', 1000], ['Smoke pellet', 500], ['Empty flask', 2]],
  general: [['Rope, 50 ft', 100], ['Torch', 1], ['Rations (1 day)', 50], ['Backpack', 200], ['Bedroll', 100], ['Lantern', 500], ['Oil flask', 10], ['Waterskin', 20], ['Tinderbox', 50], ['Crowbar', 200]],
  magic: [['Spell scroll (cantrip)', 5000], ['Wand of light', 25000], ['Cloak of billowing', 12000], ['Bag of tricks (grey)', 40000], ['Potion of climbing', 18000], ['Driftglobe', 30000], ['Lantern of rumours', 15000]],
};
const MULT: Record<string, number> = { cheap: 0.8, fair: 1, dear: 1.35 };
export function fmtCp(cp: number): string {
  if (cp >= 100 && cp % 100 === 0) return `${cp / 100} gp`;
  if (cp >= 100) return `${Math.round(cp / 10) / 10} gp`.replace(/\.0 gp/, ' gp');
  if (cp >= 10 && cp % 10 === 0) return `${cp / 10} sp`;
  return `${Math.max(1, Math.round(cp))} cp`;
}
const SHOP_STOCK: Record<string, { rarity: string; type: string }[]> = {
  smith: [{ rarity: 'mundane', type: 'weapon' }, { rarity: 'mundane', type: 'armor' }],
  alchemist: [{ rarity: 'common', type: 'potion' }, { rarity: 'uncommon', type: 'potion' }],
  general: [{ rarity: 'mundane', type: 'gear' }],
  magic: [{ rarity: 'common', type: 'any' }, { rarity: 'uncommon', type: 'any' }],
};
function genStock(db: any, worldId: string, kind: string, price: string): string {
  const k = kind.toLowerCase();
  const m = MULT[price.toLowerCase()] ?? 1;
  const lines: string[] = [];
  for (const want of SHOP_STOCK[k] ?? SHOP_STOCK.general) {
    try {
      for (const it of qgItems(db, worldId, { ...want, count: 4 }).items) if (it.priceGp != null) lines.push(`- ${it.name} — ${fmtCp(it.priceGp * 100 * m)}`);
    } catch { /* that rarity/type has nothing in this world's modules */ }
  }
  if (lines.length) return [...new Set(lines)].slice(0, 8).join('\n');
  const table = STOCK[k] ?? STOCK.general;
  return [...table].sort(() => Math.random() - 0.5).slice(0, 7).map(([n, cp]) => `- ${n} — ${fmtCp(cp * m)}`).join('\n');
}
const genItem = (kind: string): string => pick(STOCK[kind.toLowerCase()] ?? STOCK.general)[0];

// ---- table-like values ----
const dieOf = (f: Field, values: Values): number => {
  const raw = (f.dieField ? values[f.dieField] : '') || '';
  const n = Number(raw.replace(/^d/i, ''));
  const d = Number.isFinite(n) && n >= 2 && n <= 100 ? n : f.die ?? 6;
  return Math.max(2, Math.min(d, 30));
};
const cells = (line: string): string[] => line.split('|').map((c) => c.trim());
const mdCell = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ');
function tableMd(head: string[], rows: string[][]): string {
  const n = Math.max(head.length, ...rows.map((r) => r.length));
  const h = Array.from({ length: n }, (_x, i) => mdCell(head[i] ?? ''));
  return [`| ${h.join(' | ')} |`, `| ${h.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${Array.from({ length: n }, (_x, i) => mdCell(r[i] ?? '')).join(' | ')} |`)].join('\n');
}

/** Turn what a model (or a person) gave for a table or roll table into stored lines. */
function tableLines(f: Field, v: unknown, values: Values): string {
  const arr: unknown[] = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\r?\n/) : v && typeof v === 'object' ? Object.values(v as object) : [];
  const rows = arr.map((x) => (Array.isArray(x) ? x.map(String).join(' | ') : x && typeof x === 'object' ? Object.values(x as object).map(String).join(' | ') : String(x ?? '')).replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);
  if (f.type !== 'rollTable') return rows.join('\n');
  const max = dieOf(f, values);
  return rows.slice(0, max).map((r, i) => (/^\d+(\s*[-–]\s*\d+)?\s*[|.:)]/.test(r) ? r.replace(/^(\d+(?:\s*[-–]\s*\d+)?)\s*[.:)]\s*/, '$1 | ') : `${i + 1} | ${r}`)).join('\n');
}

// ---- rendering ----
function valueMd(f: Field | undefined, v: string, rc?: RenderCtx, values: Values = {}): string {
  const t = (v ?? '').trim();
  if (!t) return '';
  switch (f?.type) {
    case 'statblock':
      try { return statblockMarkdown(normalizeStatblock(JSON.parse(t))).trim(); } catch { return ''; }
    case 'list': return t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => (/^([-*+]|\d+\.)\s/.test(l) ? l : `- ${l}`)).join('\n');
    case 'table': {
      const lines = t.split(/\r?\n/).filter((l) => l.trim());
      if (f.columns?.length) return tableMd(f.columns, lines.map(cells));
      return lines.length > 1 ? tableMd(cells(lines[0]), lines.slice(1).map(cells)) : lines[0];
    }
    case 'rollTable': return tableMd([`d${dieOf(f, values)}`, 'Result'], t.split(/\r?\n/).filter((l) => l.trim()).map(cells));
    case 'image': return /^https:\/\/[^\s"'<>]+$/.test(t) ? `![${f.label}](${t})` : '';
    case 'pageLink': return /\[\[/.test(t) ? t : `[[${t}]]`;
    default: return t;
  }
}

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const FIELD_KEY = /^[a-z][a-z0-9_]*$/;
const CTX_KEY = /^(world\.[a-z]+|party\.[a-z]+|location)$/;

/** Inline calls and blocks resolved against the values: stable, because every call's seed comes from the values. */
function expandBody(tpl: Pick<Tpl, 'fields' | 'body'>, values: Values, rc?: RenderCtx): string {
  const fields = new Map(tpl.fields.map((f) => [f.key, f]));
  const get = (n: string): string => (fields.has(n) ? values[n] ?? '' : rc?.vars()[n] ?? '');
  const env: BlockEnv = {
    truthy: (n) => !!get(n).trim(),
    items: (n) => (fields.has(n) ? listItems(values[n] ?? '') : n === 'party.names' ? get(n).split(',').map((s) => s.trim()).filter(Boolean) : []),
  };
  let body = expandBlocks(tpl.body, env);
  const seed = values[SEED] || '0';
  const seen = new Map<string, number>();
  body = body.replace(CALL_RE, (_m, inner: string) => {
    const call = parseCall(inner);
    if (!call) return '';
    const k = hashStr(call.raw);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return runCall(rc ?? null, call, seed, `b:${k}:${n}`, get);
  });
  return body;
}

export function renderParts(tpl: Pick<Tpl, 'fields' | 'body' | 'perspective'>, values: Values, rc?: RenderCtx): Part[] {
  const fields = new Map(tpl.fields.map((f) => [f.key, f]));
  const player = tpl.perspective === 'player';
  const parts: Part[] = [];
  let inDm = false;
  const push = (dm: boolean, line: string) => {
    const last = parts.at(-1);
    if (last && last.dm === dm) last.md += `\n${line}`; else parts.push({ dm, md: line });
  };
  for (const raw of expandBody(tpl, values, rc).split(/\r?\n/)) {
    let line = raw;
    let lineDm = inDm;
    if (/^\s*\{\{#dm\}\}\s*$/.test(line)) { inDm = true; continue; }
    if (/^\s*\{\{\/dm\}\}\s*$/.test(line)) { inDm = false; continue; }
    if (/\{\{#dm\}\}/.test(line) && /\{\{\/dm\}\}/.test(line)) { line = line.replace(/\{\{#dm\}\}|\{\{\/dm\}\}/g, ''); lineDm = true; }
    let tokens = 0;
    let shown = 0;
    line = line.replace(TOKEN, (m, inner: string) => {
      const t = inner.trim();
      if (FIELD_KEY.test(t) && fields.has(t)) {
        tokens++;
        if (fields.get(t)!.dmOnly) lineDm = true;
        const v = valueMd(fields.get(t), values[t] ?? '', rc, values);
        if (v) shown++;
        return v || '…';
      }
      if (CTX_KEY.test(t) && rc) {
        tokens++;
        const v = rc.vars()[t] ?? '';
        if (v) shown++;
        return v || '…';
      }
      const pg = /^page:\s*(.+)$/.exec(t);
      if (pg && rc) {
        tokens++;
        const p = rc.page(pg[1]);
        // A GM template reads the AI copy, which may hold secrets: those lines stay GM-only.
        if (!player) lineDm = true;
        if (p) { shown++; return p.excerpt; }
        return '…';
      }
      return m;
    });
    if (tokens > 0 && shown === 0) continue;
    if (lineDm && player) continue;
    push(lineDm, line);
  }
  return parts.map((p) => ({ dm: p.dm, md: p.md.replace(/^\n+|\n+$/g, '') })).filter((p) => p.md.trim());
}

/** Secret blocks are `> [!secret]` callouts: players' copies drop them. */
export const secretBlock = (md: string): string => ['> [!secret] GM', ...md.split('\n').map((l) => (l.trim() ? `> ${l}` : '>'))].join('\n');

export function renderMd(parts: Part[]): string {
  return `${parts.map((p) => (p.dm ? secretBlock(p.md) : p.md)).join('\n\n')}\n`;
}
/** What a player may see of a rendering, as plain text. */
export const publicText = (parts: Part[]): string => parts.filter((p) => !p.dm).map((p) => p.md).join('\n\n').trim();

// ---- the leak check ----
export interface Leak { key: string; match: string }

/**
 * Player-perspective templates: GM-only fields never appear, page fields must be pages players
 * can open, and neither the values nor the rendered text may repeat GM-only notes.
 */
export function cleanForPlayer(d: Deps, worldId: string, tpl: Tpl, values: Values, rc: RenderCtx = makeCtx(d, worldId, true)): { values: Values; leaks: Leak[] } {
  if (tpl.perspective !== 'player') return { values, leaks: [] };
  const out: Values = {};
  const leaks: Leak[] = [];
  const dmKeys = new Set(tpl.fields.filter((f) => f.dmOnly).map((f) => f.key));
  const byKey = new Map(tpl.fields.map((f) => [f.key, f]));
  for (const [k, v] of Object.entries(values)) {
    if (dmKeys.has(k)) continue;
    const f = byKey.get(k);
    if ((f?.type === 'page' || f?.type === 'pageLink') && v.trim() && !rc.playerCanSee(v)) { leaks.push({ key: k, match: 'a page players cannot open' }); out[k] = ''; continue; }
    const hit = firstLeak(rc, v);
    if (hit) { leaks.push({ key: k, match: hit }); out[k] = ''; } else out[k] = v;
  }
  if (!leaks.length) {
    const hit = firstLeak(rc, publicText(renderParts(tpl, out, rc)));
    if (hit) { leaks.push({ key: '(text)', match: hit }); for (const f of tpl.fields) if (['list', 'longtext', 'text', 'table', 'rollTable'].includes(f.type)) out[f.key] = ''; }
  }
  return { values: out, leaks };
}

// ---- model context ----
const excerpt = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

function notesFor(d: Deps, worldId: string, tpl: Tpl, values: Values, viewer: Viewer, rc: RenderCtx): string[] {
  const out: string[] = [];
  for (const f of tpl.fields) {
    if ((f.type !== 'page' && f.type !== 'pageLink') || !values[f.key]) continue;
    const id = one<any>(d.db, `SELECT id FROM pages WHERE world_id = ? AND (id = ? OR title = ? COLLATE NOCASE OR path = ? OR path = ?)`, worldId, values[f.key].trim(), values[f.key].trim(), values[f.key].trim(), `${values[f.key].trim()}.md`)?.id;
    if (!id) continue;
    try {
      const pg: any = d.library.get(worldId, id, viewer);
      out.push(`${pg.title}: ${excerpt(String(pg.body ?? ''), 700)}`);
    } catch { /* not visible to this viewer */ }
  }
  const q = [tpl.name, ...Object.entries(values).filter(([k, v]) => v && k !== SEED && !tpl.fields.find((f) => f.key === k)?.dmOnly && !['statblock', 'rollTable', 'table', 'image'].includes(tpl.fields.find((f) => f.key === k)?.type ?? '')).map(([, v]) => v.slice(0, 60))].join(' ');
  try {
    for (const h of d.library.search(worldId, q, viewer, 5) as any[]) {
      if (out.length >= 5) break;
      const line = `${h.title}: ${excerpt(String(h.snippet ?? ''), 240)}`;
      if (!out.some((o) => o.startsWith(`${h.title}:`))) out.push(line);
    }
  } catch { /* search found nothing */ }
  return out.slice(0, 5);
}

const SHAPE = '{"name":"","size":"Medium","type":"","alignment":"","cr":1,"xp":200,"ac":13,"acType":"","hp":27,"hitDice":"5d8+5","speed":{"walk":"30 ft."},"abilities":{"str":10,"dex":14,"con":12,"int":10,"wis":10,"cha":10},"skills":{},"senses":{"passive_perception":10},"languages":"","traits":[{"name":"","text":""}],"actions":[{"name":"","text":"Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Slashing damage."}],"bonusActions":[],"reactions":[]}';

const MODEL_TYPES = new Set(['text', 'longtext', 'number', 'select', 'list', 'statblock', 'name', 'table', 'rollTable']);
export const MAX_BATCH = 20;

export interface RunOpts { lock?: string[]; only?: string[]; count?: number; seed?: string; context?: Overrides; rc?: RenderCtx }

interface Item { values: Values; filled: string[]; blank: Field[]; notes: string[] }

/** Steps that need no model: defaults, generators, dice. */
function deterministic(rc: RenderCtx, tpl: Tpl, input: Values, opts: RunOpts, seed: string, reroll: string): Item {
  const fieldKeys = new Set(tpl.fields.map((f) => f.key));
  const values: Values = { [SEED]: seed };
  for (const f of tpl.fields) values[f.key] = typeof input[f.key] === 'string' ? input[f.key] : input[f.key] == null ? '' : String(input[f.key]);
  const locked = new Set((opts.lock ?? []).filter((k) => fieldKeys.has(k)));
  const only = opts.only?.length ? new Set(opts.only.filter((k) => fieldKeys.has(k))) : null;
  const wanted = (f: Field) => (only ? only.has(f.key) : !locked.has(f.key) && !values[f.key].trim());
  const filled: string[] = [];
  const notes: string[] = [];
  const get = (n: string): string => (fieldKeys.has(n) ? values[n] ?? '' : rc.vars()[n] ?? '');
  const todo = tpl.fields.filter(wanted);
  if (only) for (const f of todo) values[f.key] = '';

  for (const f of todo) if (f.default && !values[f.key].trim()) { values[f.key] = f.default; filled.push(f.key); }

  for (const f of todo) {
    if (values[f.key].trim()) continue;
    let v = '';
    const scope = `f:${f.key}${reroll}`;
    if (f.gen === 'clock') v = rc.vars()['world.date'] ?? '';
    else if (f.gen === 'stock') v = genStock(rc.d.db, rc.worldId, values.kind || (tpl.fields.find((x) => x.key === 'kind')?.options?.[0] ?? 'general'), values.price || 'fair');
    else if (isExpr(f.gen)) v = f.type === 'rollTable' ? rollRows(rc, f, f.gen, seed, scope, values, get) : runExpr(rc, f.gen, seed, scope, get);
    else if (f.type === 'name') {
      const g = genName(values.race ?? '', values.gender ?? '');
      v = g?.name ?? '';
      if (g?.race && g.race !== 'any' && tpl.fields.some((x) => x.key === 'race') && !values.race.trim() && !locked.has('race') && !only) { values.race = g.race; filled.push('race'); }
    } else if (f.type === 'item') v = genItem(values.kind || '');
    else if (f.type === 'coins') v = runExpr(rc, `gen:coins mode=individual level=${values.level || values.cr || rc.partyLevel()}`, seed, scope, get);
    if (v) { values[f.key] = v; filled.push(f.key); }
  }

  // Dice fields: a bare expression is rolled once and stored as "11 (2d6+3)".
  for (const f of tpl.fields) {
    if (f.type !== 'dice') continue;
    const t = values[f.key].trim();
    if (!t) continue;
    if (/^[+-]?(\d*d\d+|\d+)([+-](\d*d\d+|\d+))*$/i.test(t.replace(/\s+/g, '')) && /d/i.test(t)) {
      try { values[f.key] = rollText(t, makeRng(`${seed}|dice:${f.key}${reroll}`)); if (!filled.includes(f.key)) filled.push(f.key); } catch (e: any) { notes.push(`${f.label}: ${e?.message ?? 'not valid'}`); }
    }
  }
  const blank = tpl.fields.filter((f) => wanted(f) && !values[f.key].trim() && MODEL_TYPES.has(f.type) && !isExpr(f.gen) && f.gen !== 'clock' && f.gen !== 'stock');
  return { values, filled, blank, notes };
}

/** Rows for a roll table from a generator expression: one per face of the die, no repeats. */
function rollRows(rc: RenderCtx, f: Field, expr: string, seed: string, scope: string, values: Values, get: (n: string) => string): string {
  const n = dieOf(f, values);
  const rows: string[] = [];
  for (let i = 0; i < n * 4 && rows.length < n; i++) {
    const r = runExpr(rc, expr, seed, `${scope}:${i}`, get);
    if (r && !rows.includes(r)) rows.push(r);
  }
  return rows.map((r, i) => `${i + 1} | ${r}`).join('\n');
}

function applyFallbacks(rc: RenderCtx, tpl: Tpl, item: Item, seed: string, reroll: string) {
  const get = (n: string): string => (tpl.fields.some((f) => f.key === n) ? item.values[n] ?? '' : rc.vars()[n] ?? '');
  for (const f of item.blank) {
    if (item.values[f.key].trim() || !isExpr(f.fallback)) continue;
    const scope = `fb:${f.key}${reroll}`;
    const v = f.type === 'rollTable' ? rollRows(rc, f, f.fallback, seed, scope, item.values, get) : runExpr(rc, f.fallback, seed, scope, get);
    if (v) { item.values[f.key] = v; if (!item.filled.includes(f.key)) item.filled.push(f.key); }
  }
}

function takeModelValue(f: Field, raw: unknown, item: Item) {
  if (raw == null || raw === '') return;
  const values = item.values;
  if (f.type === 'statblock') {
    try { values[f.key] = JSON.stringify(normalizeStatblock(typeof raw === 'string' ? JSON.parse(raw) : raw, values.name)); item.filled.push(f.key); } catch (e: any) { item.notes.push(`${f.label}: ${e?.message ?? 'not valid'}`); }
    return;
  }
  if (f.type === 'table' || f.type === 'rollTable') { const s = tableLines(f, raw, values); if (s) { values[f.key] = s; item.filled.push(f.key); } return; }
  let v: unknown = raw;
  if (Array.isArray(v)) v = v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
  else if (typeof v === 'object') v = Object.values(v as object).join('\n');
  let s = String(v).trim();
  if (f.type === 'select' && f.options?.length) {
    const hit = f.options.find((o) => o.toLowerCase() === s.toLowerCase());
    if (!hit) { item.notes.push(`${f.label}: the model chose "${s.slice(0, 30)}", which is not an option.`); return; }
    s = hit;
  }
  values[f.key] = s;
  item.filled.push(f.key);
}

/** Fill the blanks. At most one model call, however many results are asked for. */
export async function sculptMany(d: Deps, worldId: string, worldName: string, tpl: Tpl, input: Values, opts: RunOpts = {}): Promise<BatchResult> {
  const count = Math.max(1, Math.min(MAX_BATCH, Math.floor(opts.count ?? 1) || 1));
  const player = tpl.perspective === 'player';
  const rc = opts.rc ?? makeCtx(d, worldId, player, opts.context);
  const base = opts.seed || (typeof input[SEED] === 'string' && input[SEED] && opts.only?.length ? input[SEED] : Math.floor(Math.random() * 0x7fffffff).toString(36));
  const reroll = opts.only?.length ? `:${Math.floor(Math.random() * 1e9).toString(36)}` : '';
  const items: Item[] = [];
  for (let i = 0; i < count; i++) items.push(deterministic(rc, tpl, input, opts, count > 1 ? `${base}:${i}` : base, reroll));
  const notes: string[] = [];
  const blankKeys = items[0].blank;

  const missingPages = tpl.fields.filter((f) => (f.type === 'page' || f.type === 'pageLink') && f.required && !items[0].values[f.key].trim());
  for (const f of missingPages) notes.push(`${f.label} needs a library page: pick one yourself.`);

  const model = hasJob(d, 'chat');
  let usedModel = false;
  const needModel = items.some((it) => it.blank.length);
  if (needModel && model) {
    const viewer: Viewer = player ? PLAYER : { accountId: 'sculpt-dm-view', role: 'dm', audience: 'ai' };
    const contextOf = (it: Item) => Object.fromEntries(tpl.fields.filter((f) => it.values[f.key].trim() && !it.blank.includes(f) && f.type !== 'statblock' && !(player && f.dmOnly)).map((f) => [f.key, it.values[f.key].slice(0, 400)]));
    const snippets = notesFor(d, worldId, tpl, items[0].values, viewer, rc);
    const world = Object.fromEntries(Object.entries(rc.vars()).filter(([k, v]) => v && ['world.date', 'world.season', 'party.level', 'location'].includes(k)));
    const desc = (f: Field) => ({ key: f.key, label: f.label, type: f.type, ...(f.options ? { options: f.options } : {}), ...(f.hint ? { hint: f.hint } : {}), ...(f.type === 'rollTable' ? { rows: dieOf(f, items[0].values) } : {}), ...(f.type === 'table' && f.columns ? { columns: f.columns } : {}) });
    const sys = [
      `You fill blank fields of the template "${tpl.name}" for the Game Master of a 5e tabletop role-playing game. World: ${worldName}.`,
      count > 1 ? `Reply with one JSON object {"results": [...]} holding exactly ${count} different objects, each with the blank field keys.` : 'Reply with one JSON object whose keys are exactly the blank field keys.',
      'Be short, concrete and ready to use at the table. Plain text, no Markdown headings. A "list" is an array of short strings. A "select" is one of its options. A "number" is a number. A "rollTable" is an array of exactly "rows" short strings, one per face of the die. A "table" is an array of rows, each an array of cells.',
      blankKeys.some((f) => f.type === 'statblock') ? `A "statblock" is an object like ${SHAPE}. Keep numbers consistent with the CR.` : '',
      player ? 'This is for the players: use only the player-visible notes given. Never invent or hint at secrets, hidden causes or hidden identities.' : 'Stay consistent with the world notes.',
    ].filter(Boolean).join(' ');
    const payload: any = count > 1
      ? { count, blank: blankKeys.map(desc), items: items.map((it) => ({ filled: contextOf(it) })), worldNotes: snippets }
      : { blank: blankKeys.map(desc), filled: contextOf(items[0]), worldNotes: snippets };
    if (Object.keys(world).length) payload.world = world;
    const messages: ChatMessage[] = [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify(payload) }];
    let raw: any = null;
    try { raw = await chatJson<any>(d, 'chat', messages, undefined, count > 1 ? { maxTokens: 3000 } : {}); usedModel = true; } catch { raw = null; }
    const answers: any[] = count > 1 ? (Array.isArray(raw?.results) ? raw.results : Array.isArray(raw) ? raw : []) : raw && typeof raw === 'object' ? [raw] : [];
    const fallbackable = blankKeys.every((f) => isExpr(f.fallback));
    if (raw && typeof raw === 'object' && !answers.some((a) => a && blankKeys.some((f) => a[f.key] != null && a[f.key] !== ''))) { if (!fallbackable) notes.push('The chat model answered without any of the blank fields. Try again.'); }
    else if (!raw || typeof raw !== 'object') { if (!fallbackable) notes.push('The chat model did not return usable text. Try again, or fill the blanks by hand.'); }
    items.forEach((it, i) => { const a = answers[i]; if (a && typeof a === 'object') for (const f of it.blank) takeModelValue(f, a[f.key], it); });
  }
  // Generators stand in where the model is missing or said nothing.
  items.forEach((it, i) => applyFallbacks(rc, tpl, it, count > 1 ? `${base}:${i}` : base, reroll));
  const still = blankKeys.filter((f) => !f.optional && items.some((it) => !it.values[f.key].trim()));
  if (still.length && !model) notes.push(`No chat model is set (Admin → Models), so ${still.map((f) => f.label).join(', ')} stay empty. Fill them by hand.`);

  const results: SculptResult[] = items.map((it, i) => {
    const cleaned = cleanForPlayer(d, worldId, tpl, it.values, rc);
    const rn = [...(i === 0 ? notes : []), ...it.notes];
    for (const l of cleaned.leaks) {
      rn.push(`Blocked "${tpl.fields.find((f) => f.key === l.key)?.label ?? l.key}": it repeats words from GM-only notes.`);
      const j = it.filled.indexOf(l.key);
      if (j >= 0) it.filled.splice(j, 1);
    }
    const parts = renderParts(tpl, cleaned.values, rc);
    return { values: cleaned.values, md: renderMd(parts), parts, notes: rn, filled: [...new Set(it.filled)], model, usedModel, leaks: cleaned.leaks };
  });
  const first = results[0];
  const md = count > 1 ? results.map((r) => r.md.trim()).join('\n\n---\n\n') + '\n' : first.md;
  return { ...first, md, results, count, batch: count > 1, notes: [...new Set(results.flatMap((r) => r.notes))] };
}

/** One result. At most one model call. */
export async function sculpt(d: Deps, worldId: string, worldName: string, tpl: Tpl, input: Values, opts: RunOpts = {}): Promise<SculptResult> {
  const r = await sculptMany(d, worldId, worldName, tpl, input, { ...opts, count: 1 });
  const { results: _r, count: _c, batch: _b, ...one1 } = r;
  void _r; void _c; void _b;
  return one1;
}
void GENERATORS; void rollDice;
