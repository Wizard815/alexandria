// Spell crafting: a world rule (off by default) where a character learns a
// new spell by combining spells they know. A recipe names the result, 1 to 5
// prerequisite spells, and optionally items (matched by name against the
// character's own inventory for now, each optionally used up), minimum
// ability scores, a minimum character level and a mana cost to learn it.
import { type DB, all, one } from '../../core/db.ts';
import { HttpError, parseJson } from '../../core/util.ts';
import { ABILITIES, ABILITY_NAMES, type Ability } from './format.ts';
import { type Character, type WorldSpell } from './store.ts';

export interface RecipeItem { name: string; qty: number; consumed: boolean; itemId?: string | null }
export interface Recipe {
  id: string;
  resultId: string;
  prereqs: string[];
  items: RecipeItem[];
  stats: Partial<Record<Ability, number>>;
  minLevel: number | null;
  manaCost: number | null;
  visibility: 'visible' | 'hidden';
  dmNotes: string;
  draft: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const rowToRecipe = (r: any): Recipe => ({
  id: r.id, resultId: r.result_id, prereqs: parseJson<string[]>(r.prereqs, []), items: parseJson<RecipeItem[]>(r.items, []), stats: parseJson(r.stats, {}),
  minLevel: r.min_level ?? null, manaCost: r.mana_cost ?? null, visibility: r.visibility === 'hidden' ? 'hidden' : 'visible', dmNotes: r.dm_notes ?? '', draft: !!r.draft,
  createdBy: r.created_by ?? '', createdAt: r.created_at, updatedAt: r.updated_at,
});

export const recipes = (db: DB, worldId: string): Recipe[] => all<any>(db, 'SELECT * FROM spells_recipes WHERE world_id = ? ORDER BY created_at, id', worldId).map(rowToRecipe);
export const recipeById = (db: DB, worldId: string, rid: string): Recipe | null => { const r = one<any>(db, 'SELECT * FROM spells_recipes WHERE world_id = ? AND id = ?', worldId, rid); return r ? rowToRecipe(r) : null; };

const bad = (m: string) => new HttpError(400, m);

/**
 * Check a recipe from the editor, an import or the assistant. `resolve` turns
 * a spell id or name into a world spell (null when unknown). Throws 400 with
 * a plain reason.
 */
export function normalizeRecipe(raw: any, resolve: (ref: string) => WorldSpell | null): Omit<Recipe, 'id' | 'createdBy' | 'createdAt' | 'updatedAt'> {
  if (!raw || typeof raw !== 'object') throw bad('A recipe must be an object');
  const resRef = String(raw.result ?? raw.resultId ?? raw.spell ?? '').trim();
  const result = resRef ? resolve(resRef) : null;
  if (!result) throw bad(`Unknown result spell: ${resRef.slice(0, 80) || '(none)'}`);
  const pre: unknown[] = Array.isArray(raw.prereqs ?? raw.prerequisites ?? raw.requires) ? (raw.prereqs ?? raw.prerequisites ?? raw.requires) : [];
  const prereqs: string[] = [];
  for (const p of pre) {
    const ref = typeof p === 'object' && p ? String((p as any).id ?? (p as any).name ?? '') : String(p ?? '');
    const s = resolve(ref.trim());
    if (!s) throw bad(`Unknown prerequisite spell: ${ref.slice(0, 80)}`);
    if (s.id === result.id) throw bad(`${result.name} cannot need itself`);
    if (!prereqs.includes(s.id)) prereqs.push(s.id);
  }
  if (prereqs.length < 1 || prereqs.length > 5) throw bad('A recipe needs 1 to 5 different prerequisite spells');
  const items: RecipeItem[] = [];
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    const name = String(typeof it === 'string' ? it : it?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) throw bad('Every item needs a name');
    const qty = Number(typeof it === 'object' ? it.qty ?? 1 : 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw bad(`${name}: the quantity must be 1 to 99`);
    const itemId = typeof it === 'object' && typeof it.itemId === 'string' && it.itemId.trim() ? it.itemId.trim().slice(0, 80) : null;
    items.push({ name, qty, consumed: typeof it === 'object' && it.consumed === true, ...(itemId ? { itemId } : {}) });
  }
  if (items.length > 5) throw bad('At most 5 items');
  const stats: Partial<Record<Ability, number>> = {};
  const rawStats = raw.stats ?? raw.abilities ?? {};
  if (rawStats && typeof rawStats === 'object') {
    for (const [k0, v] of Object.entries(rawStats)) {
      const k = k0.toLowerCase().slice(0, 3) as Ability;
      if (!(ABILITIES as readonly string[]).includes(k)) throw bad(`Unknown ability: ${k0.slice(0, 20)}`);
      if (v === null || v === '' || v === undefined) continue;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 30) throw bad(`${ABILITY_NAMES[k]}: the minimum must be 1 to 30`);
      stats[k] = n;
    }
  }
  const optInt = (v: unknown, what: string, min: number, max: number): number | null => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw bad(`${what} must be ${min} to ${max}`);
    return n;
  };
  return {
    resultId: result.id,
    prereqs,
    items,
    stats,
    minLevel: optInt(raw.minLevel, 'The minimum level', 1, 20),
    manaCost: optInt(raw.manaCost, 'The mana cost to learn', 0, 999),
    visibility: raw.visibility === 'hidden' ? 'hidden' : 'visible',
    dmNotes: typeof raw.dmNotes === 'string' ? raw.dmNotes.slice(0, 4000) : '',
    draft: raw.draft === true,
  };
}

// ---- eligibility ------------------------------------------------------------------------------------------

export type Missing =
  | { kind: 'spell'; id: string; name: string }
  | { kind: 'item'; name: string; need: number; have: number }
  | { kind: 'stat'; ability: Ability; need: number; have: number | null }
  | { kind: 'level'; need: number; have: number | null }
  | { kind: 'mana'; need: number; have: number | null };

/** How many of an item the character holds: their own approved items with the same name (case and spacing aside). */
export function holding(db: DB, worldId: string, accountId: string, name: string): number {
  const key = name.replace(/\s+/g, ' ').trim().toLowerCase();
  return all<any>(db, "SELECT name, qty FROM items WHERE world_id = ? AND owner = ? AND status = 'approved'", worldId, accountId)
    .filter((r) => String(r.name).replace(/\s+/g, ' ').trim().toLowerCase() === key)
    .reduce((n, r) => n + (Number(r.qty) || 0), 0);
}

export interface Eligibility { status: 'learned' | 'ready' | 'locked'; missing: Missing[]; met: number; total: number }

export function eligibility(db: DB, worldId: string, r: Recipe, c: Character, known: Set<string>, nameOf: (id: string) => string, mana: { on: boolean; now: number | null }): Eligibility {
  if (known.has(r.resultId)) return { status: 'learned', missing: [], met: 0, total: 0 };
  const missing: Missing[] = [];
  let total = 0;
  for (const p of r.prereqs) { total++; if (!known.has(p)) missing.push({ kind: 'spell', id: p, name: nameOf(p) }); }
  for (const it of r.items) { total++; const have = holding(db, worldId, c.accountId, it.name); if (have < it.qty) missing.push({ kind: 'item', name: it.name, need: it.qty, have }); }
  for (const [k, need] of Object.entries(r.stats) as [Ability, number][]) { total++; const have = c.abilities[k] ?? null; if (have === null || have < need) missing.push({ kind: 'stat', ability: k, need, have }); }
  if (r.minLevel) { total++; if (!c.level || c.level < r.minLevel) missing.push({ kind: 'level', need: r.minLevel, have: c.level }); }
  if (r.manaCost && mana.on) { total++; if (mana.now === null || mana.now < r.manaCost) missing.push({ kind: 'mana', need: r.manaCost, have: mana.now }); }
  return { status: missing.length ? 'locked' : 'ready', missing, met: total - missing.length, total };
}

/** Tier of each recipe result: 1 + the highest tier among its prerequisites (a spell no recipe makes is tier 0). Cycles stop at the first repeat. */
export function tiers(rs: Recipe[]): Map<string, number> {
  const by = new Map<string, Recipe[]>();
  for (const r of rs) by.set(r.resultId, [...(by.get(r.resultId) ?? []), r]);
  const memo = new Map<string, number>();
  const tierOf = (spell: string, seen: Set<string>): number => {
    if (memo.has(spell)) return memo.get(spell)!;
    const made = by.get(spell);
    if (!made || seen.has(spell)) return 0;
    const next = new Set(seen).add(spell);
    const t = 1 + Math.min(...made.map((r) => Math.max(0, ...r.prereqs.map((p) => tierOf(p, next)))));
    memo.set(spell, t);
    return t;
  };
  return new Map(rs.map((r) => [r.id, 1 + Math.max(0, ...r.prereqs.map((p) => tierOf(p, new Set([r.resultId]))))]));
}
