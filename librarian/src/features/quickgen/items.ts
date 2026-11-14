// Items by rarity and type. The pool is the world's enabled game modules
// (items with a rarity and category, plus mundane gear with a listed cost)
// and the world's own library pages tagged "item" (frontmatter may give
// rarity, type and price).
//
// Prices: magic items carry a price in gp picked inside a band for their
// rarity (the SRD data lists no magic item prices, so these bands are ours):
//   common 50-100, uncommon 101-500, rare 501-5000, very rare 5001-50000,
//   legendary 50001-150000. Artifacts are priceless (priceGp null).
// Mundane gear uses its listed cost. A listed price on a library page wins.
//
// Rarity "any" means any magic rarity; "mundane" is the plain gear. Type
// "gear" means mundane gear, so it only combines with rarity any or mundane.
// Items whose rarity "varies" (like "+1, +2 or +3") are left out: they have
// no single price.
import { type DB, all } from '../../core/db.ts';
import { parseJson } from '../../core/util.ts';
import { worldModules, type WorldModules } from '../modules/store.ts';
import { type Rng, int, makeRng, seedOf } from './rng.ts';

export const RARITIES = ['common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact'] as const;
export const ALL_RARITIES = [...RARITIES, 'mundane'] as const;
export const TYPES = ['weapon', 'armor', 'potion', 'ring', 'rod', 'scroll', 'staff', 'wand', 'wondrous item', 'ammunition', 'gear'] as const;
export type Rarity = (typeof ALL_RARITIES)[number];
export type ItemType = (typeof TYPES)[number];

/** Price bands in gp, inclusive. */
export const PRICE_BANDS: Record<string, [number, number]> = {
  common: [50, 100],
  uncommon: [101, 500],
  rare: [501, 5000],
  'very rare': [5001, 50000],
  legendary: [50001, 150000],
};

export interface ItemOpts { rarity?: string; type?: string; count?: number; seed?: string | number; library?: boolean }
export interface GeneratedItem {
  name: string;
  rarity: Rarity | 'unknown';
  type: ItemType;
  /** Price in gp; null for artifacts and library pages with no price. */
  priceGp: number | null;
  attunement: boolean;
  summary: string;
  source: 'module' | 'library';
  /** Module term id, like dnd-2024:item-ring-of-protection (read it with /modules/terms/:id). */
  termId: string | null;
  moduleId: string | null;
  /** Library page id, for items from the world's own pages. */
  pageId: string | null;
}
export interface ItemsResult { seed: string; rarity: string; type: string; poolSize: number; items: GeneratedItem[] }

interface Cand { name: string; rarity: Rarity | 'unknown'; type: ItemType; fixedGp: number | null; attunement: boolean; summary: string; source: 'module' | 'library'; termId: string | null; moduleId: string | null; pageId: string | null }

const normRarity = (v: unknown): Rarity | 'any' | null => {
  const s = String(v ?? 'any').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (s === '' || s === 'any') return 'any';
  if (s === 'veryrare') return 'very rare';
  return (ALL_RARITIES as readonly string[]).includes(s) ? (s as Rarity) : null;
};
const normType = (v: unknown): ItemType | 'any' | null => {
  const s = String(v ?? 'any').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (s === '' || s === 'any') return 'any';
  if (s === 'wondrous' || s === 'wondrous items') return 'wondrous item';
  if (s === 'gear/mundane' || s === 'mundane' || s === 'mundane gear' || s === 'adventuring gear' || s === 'tool' || s === 'tools') return 'gear';
  const t = s.replace(/s$/, '');
  return (TYPES as readonly string[]).includes(t) ? (t as ItemType) : (TYPES as readonly string[]).includes(s) ? (s as ItemType) : null;
};

const RARITY_RE = /\b(very rare|uncommon|common|rare|legendary|artifact)\b/g;
const UNIT_GP: Record<string, number> = { pp: 10, gp: 1, ep: 0.5, sp: 0.1, cp: 0.01 };

function typeOfModule(name: string, category: string, text: string, magic: boolean): ItemType {
  const c = category.toLowerCase();
  const n = name.toLowerCase();
  if (/scroll/.test(n)) return 'scroll';
  if (/^potion\b|\bpotion of\b|\boil of\b|\bphilter\b/.test(n)) return 'potion';
  if (/\b(arrows?|bolts?|bullets?|needles?)\b|ammunition/.test(n) && !/case|quiver/.test(n)) return 'ammunition';
  if (c.includes('weapon')) return 'weapon';
  if (c.includes('armor')) return 'armor';
  if (c.includes('potion')) return 'potion';
  if (c.includes('ring')) return 'ring';
  if (c.includes('rod')) return 'rod';
  if (c.includes('staff')) return 'staff';
  if (c.includes('wand')) return 'wand';
  if (c.includes('scroll')) return 'scroll';
  if (c.includes('wondrous')) return 'wondrous item';
  if (c.includes('ammunition')) return 'ammunition';
  if (magic) return 'wondrous item';
  // Mundane entries in the 2024 data have no category: read the stat lines.
  if (/\*\*Damage:\*\*/.test(text)) return 'weapon';
  if (/\*\*Armor Class:\*\*/.test(text)) return 'armor';
  return 'gear';
}

const classified = new WeakMap<WorldModules, Cand[]>();
function moduleCands(wm: WorldModules): Cand[] {
  const hit = classified.get(wm);
  if (hit) return hit;
  const out: Cand[] = [];
  for (const t of wm.terms) {
    if (t.kind !== 'item') continue;
    const data: any = t.data ?? {};
    const base = { name: t.term, summary: t.summary, source: 'module' as const, termId: t.ref, moduleId: t.moduleId, pageId: null };
    const attunement = data.attunement === true;
    const rs = typeof data.rarity === 'string' ? data.rarity.toLowerCase() : '';
    if (rs) {
      const found = [...new Set([...rs.matchAll(RARITY_RE)].map((m) => m[1] as Rarity))];
      for (const rarity of found) out.push({ ...base, rarity, type: typeOfModule(t.term, String(data.category ?? ''), t.text, true), fixedGp: null, attunement });
      continue;
    }
    const cost = data.cost;
    if (cost && typeof cost.quantity === 'number' && UNIT_GP[cost.unit] !== undefined) {
      const gp = Math.round(cost.quantity * UNIT_GP[cost.unit] * 100) / 100;
      const type = typeOfModule(t.term, String(data.category ?? ''), t.text, false);
      // Healing potions and scrolls are common magic items that happen to have a shop price.
      if (type === 'potion' || type === 'scroll') out.push({ ...base, rarity: 'common', type, fixedGp: Math.min(100, Math.max(50, gp)), attunement: false });
      else out.push({ ...base, rarity: 'mundane', type, fixedGp: gp, attunement: false });
    }
  }
  classified.set(wm, out);
  return out;
}

function gpFrom(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v !== 'string') return null;
  const m = /^\s*([\d,.]+)\s*(pp|gp|ep|sp|cp)?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * (UNIT_GP[(m[2] ?? 'gp').toLowerCase()] ?? 1) * 100) / 100 : null;
}

function libraryCands(db: DB, worldId: string): Cand[] {
  const out: Cand[] = [];
  for (const p of all<any>(db, "SELECT id, title, tags, frontmatter, ai_body AS body FROM pages WHERE world_id = ? AND ai_body IS NOT NULL AND visibility <> 'classified' ORDER BY path", worldId)) {
    const tags = parseJson<unknown>(p.tags, []);
    if (!Array.isArray(tags) || !tags.some((x) => String(x).replace(/^#/, '').trim().toLowerCase() === 'item')) continue;
    const fm = parseJson<Record<string, unknown>>(p.frontmatter, {});
    const rarity = normRarity(fm.rarity ?? '__none');
    const r: Rarity | 'unknown' = rarity && rarity !== 'any' ? rarity : 'unknown';
    const type = normType(fm.type ?? fm.item_type ?? fm.category) ;
    const price = gpFrom(fm.price ?? fm.value ?? fm.cost);
    const body = String(p.body ?? '').replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim();
    out.push({
      name: p.title, rarity: r, type: type && type !== 'any' ? type : r === 'unknown' || r === 'mundane' ? 'gear' : 'wondrous item', fixedGp: price,
      attunement: fm.attunement === true || fm.attunement === 'true', summary: body.slice(0, 200), source: 'library', termId: null, moduleId: null, pageId: p.id,
    });
  }
  return out;
}

/** A price in gp inside the rarity's band, rounded to a tidy figure. */
export function priceFor(r: Rng, rarity: string): number | null {
  const band = PRICE_BANDS[rarity];
  if (!band) return null;
  const [lo, hi] = band;
  const raw = int(r, lo, hi);
  const step = raw >= 10000 ? 1000 : raw >= 1000 ? 100 : raw >= 100 ? 10 : 5;
  return Math.min(hi, Math.max(lo, Math.round(raw / step) * step));
}

/** Items matching a rarity and type, drawn without repeats. */
export function genItems(db: DB, worldId: string, opts: ItemOpts = {}): ItemsResult {
  const rarity = normRarity(opts.rarity);
  if (!rarity) throw new RangeError(`rarity must be any or one of ${ALL_RARITIES.join(', ')}`);
  const type = normType(opts.type);
  if (!type) throw new RangeError(`type must be any or one of ${TYPES.join(', ')}`);
  const count = Math.max(1, Math.min(200, Math.floor(Number(opts.count ?? 5)) || 5));
  const seed = seedOf(opts.seed);
  const r = makeRng(seed);

  const pool = [...moduleCands(worldModules(db, worldId)), ...(opts.library === false ? [] : libraryCands(db, worldId))].filter((c) => {
    if (type === 'gear') { if (c.type !== 'gear') return false; } else if (type !== 'any' && c.type !== type) return false;
    if (rarity === 'any') return type === 'gear' ? c.rarity === 'mundane' || c.rarity === 'unknown' : c.rarity !== 'mundane';
    return c.rarity === rarity;
  });

  // Draw without replacement (partial Fisher-Yates over a copy), skipping repeated names.
  const bag = pool.slice();
  const items: GeneratedItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < bag.length && items.length < count; i++) {
    const j = i + Math.floor(r() * (bag.length - i));
    [bag[i], bag[j]] = [bag[j], bag[i]];
    const c = bag[i];
    const key = c.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const priceGp = c.fixedGp !== null ? c.fixedGp : priceFor(r, c.rarity);
    items.push({ name: c.name, rarity: c.rarity, type: c.type, priceGp, attunement: c.attunement, summary: c.summary, source: c.source, termId: c.termId, moduleId: c.moduleId, pageId: c.pageId });
  }
  return { seed, rarity, type, poolSize: pool.length, items };
}
