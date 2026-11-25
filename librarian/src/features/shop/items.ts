// The world's item database: what shops stock. Rows come from a game module
// (the built-in SRD 5.2 / 5.1 modules, CC-BY-4.0, or a module the DM imported),
// from a JSON or CSV file, or from the DM's own hand. Every row keeps where it
// came from and that source's attribution. dm_notes is for the DM alone.
//
// Dedupe: an item's key is its name, lower-cased with punctuation folded
// ("Thieves' Tools" = "thieves tools"). An import never adds a second row with
// a key the world already has: it skips it, or with onDuplicate 'update'
// refreshes a row that came from the same source (never a custom item).
import { type DB, all, one, run, tx } from '../../core/db.ts';
import { HttpError, id as newId, now, parseJson } from '../../core/util.ts';
import { makeRng } from '../quickgen/rng.ts';
import { priceFor } from '../quickgen/items.ts';
import { moduleDoc } from '../modules/store.ts';
import type { Term } from '../modules/format.ts';

export const ITEM_TYPES = ['weapon', 'armor', 'shield', 'ammunition', 'gear', 'tool', 'potion', 'scroll', 'ring', 'rod', 'staff', 'wand', 'wondrous item', 'mount', 'food', 'other'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export const ITEM_RARITIES = ['mundane', 'common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact', 'varies'] as const;
export type ItemRarity = (typeof ITEM_RARITIES)[number];
export const MAGIC_ORDER: ItemRarity[] = ['common', 'uncommon', 'rare', 'very rare', 'legendary'];

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS shop_items (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  category TEXT NOT NULL DEFAULT '',
  rarity TEXT NOT NULL DEFAULT 'mundane',
  cost_cp INTEGER,
  weight REAL,
  description TEXT NOT NULL DEFAULT '',
  properties TEXT NOT NULL DEFAULT '',
  attunement INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'custom',
  source_label TEXT NOT NULL DEFAULT 'Custom',
  source_ref TEXT,
  attribution TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  dm_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS shop_items_world ON shop_items (world_id, name_key);
CREATE TABLE IF NOT EXISTS shop_meta (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  seeded_at TEXT
);
`;

export interface ItemRow {
  id: string; world_id: string; name: string; name_key: string; type: string; category: string; rarity: string;
  cost_cp: number | null; weight: number | null; description: string; properties: string; attunement: number;
  source: string; source_label: string; source_ref: string | null; attribution: string; tags: string; dm_notes: string;
  created_at: string; updated_at: string; updated_by: string | null;
}

/** An item as the DM sees it (the API shape). */
export const itemOut = (r: ItemRow) => ({
  id: r.id, name: r.name, type: r.type, category: r.category, rarity: r.rarity, costCp: r.cost_cp, weight: r.weight,
  description: r.description, properties: r.properties, attunement: !!r.attunement, source: r.source, sourceLabel: r.source_label,
  sourceRef: r.source_ref, attribution: r.attribution, tags: parseJson<string[]>(r.tags, []), dmNotes: r.dm_notes, updatedAt: r.updated_at,
});

/** The key two items are the same by. */
export const nameKey = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’'`]/g, '').replace(/[^a-z0-9+]+/g, ' ').trim();

const UNIT_CP: Record<string, number> = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };

/** "15 gp", "2 sp 5 cp", "1,500", 12.5 (gp) -> copper. null when blank; throws RangeError when unreadable. */
export function parseCost(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') { if (!Number.isFinite(v) || v < 0) throw new RangeError('cost must be 0 or more'); return Math.round(v * 100); }
  const s = String(v).trim().toLowerCase().replace(/,/g, '');
  if (!s || s === '-' || s === '—') return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 100);
  let total = 0;
  let any = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(pp|gp|ep|sp|cp)\b/g)) { total += Number(m[1]) * UNIT_CP[m[2]]; any = true; }
  if (!any) throw new RangeError(`cost "${String(v).slice(0, 40)}" is not a price like 15 gp`);
  return Math.round(total);
}

export function normType(v: unknown): ItemType {
  const s = String(v ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!s) return 'other';
  if ((ITEM_TYPES as readonly string[]).includes(s)) return s as ItemType;
  const t = s.replace(/s$/, '');
  if ((ITEM_TYPES as readonly string[]).includes(t)) return t as ItemType;
  if (/wondrous/.test(s)) return 'wondrous item';
  if (/weapon/.test(s)) return 'weapon';
  if (/armou?r/.test(s)) return 'armor';
  if (/tool|kit|supplies|instrument/.test(s)) return 'tool';
  if (/gear|adventuring|mundane/.test(s)) return 'gear';
  if (/mount|vehicle|animal/.test(s)) return 'mount';
  if (/food|drink|lodging/.test(s)) return 'food';
  return 'other';
}

export function normRarity(v: unknown, fallback: ItemRarity = 'mundane'): ItemRarity {
  const s = String(v ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!s) return fallback;
  if (s === 'veryrare') return 'very rare';
  if ((ITEM_RARITIES as readonly string[]).includes(s)) return s as ItemRarity;
  if (/vari/.test(s)) return 'varies';
  const found = [...new Set([...s.matchAll(/\b(very rare|uncommon|common|rare|legendary|artifact)\b/g)].map((m) => m[1]))];
  if (found.length === 1) return found[0] as ItemRarity;
  if (found.length > 1) return 'varies';
  if (/none|mundane|normal|standard/.test(s)) return 'mundane';
  return fallback;
}

/** What a module term of kind item says about itself, as an item row's fields. */
export function fromTerm(t: Term): Omit<NewItem, 'source' | 'sourceLabel' | 'attribution'> & { sourceRef: string } {
  const data: any = t.data && typeof t.data === 'object' ? t.data : {};
  const text = String(t.text ?? '');
  const name = t.term;
  const n = name.toLowerCase();
  const category = String(data.category ?? '').trim();
  const rarityRaw = typeof data.rarity === 'string' ? data.rarity : '';
  const magic = !!rarityRaw;
  // Bold "**Key:** value" lines are stats; the rest is the description.
  const stats: [string, string][] = [];
  const rest: string[] = [];
  const paras = text.split(/\n{2,}/);
  for (const [i, p] of paras.entries()) {
    const lines = p.split('\n').map((l) => l.replace(/\s+$/, ''));
    const bold = lines.map((l) => /^\*\*([^*]+):\*\*\s*(.*)$/.exec(l.trim()));
    if (bold.every(Boolean)) { for (const b of bold) stats.push([b![1].trim(), b![2].trim()]); continue; }
    // Magic items open with "*Category, Rarity*" then a line like "Armor (Any Medium or Heavy)".
    if (magic && i === 0 && /^\*[^*].*\*$/.test(p.trim())) continue;
    rest.push(p.trim());
  }
  let weight: number | null = null;
  const props: string[] = [];
  for (const [k, v] of stats) {
    if (/^cost$/i.test(k)) continue;
    if (/^weight$/i.test(k)) { const m = /([\d.]+)/.exec(v.replace(/,/g, '')); weight = m ? Number(m[1]) : null; continue; }
    props.push(`${k}: ${v}`);
  }
  // A magic item's line under the header ("Armor (Shield), rare (requires attunement)") is a property.
  if (magic && rest.length && rest[0].length < 140 && !/[.!?]$/.test(rest[0])) props.unshift(rest.shift()!);
  const head = text.slice(0, 300);
  const attunement = data.attunement === true || /requires attunement/i.test(head);
  let costCp: number | null = null;
  if (data.cost && typeof data.cost.quantity === 'number' && UNIT_CP[data.cost.unit] !== undefined) costCp = Math.round(data.cost.quantity * UNIT_CP[data.cost.unit]);
  let rarity: ItemRarity = magic ? normRarity(rarityRaw, 'varies') : 'mundane';
  let type = typeOf(name, category, text, magic);
  // Healing potions and scrolls are listed as gear in some data but are magic.
  if (!magic && (type === 'potion' || type === 'scroll') && /\bpotion of\b|\bspell scroll\b/.test(n)) rarity = 'common';
  if (/\(.*\b(arrows?|bolts?|bullets?|needles?)\b/.test(n)) type = 'ammunition';
  // Magic items carry no price in the SRD data: one from the rarity's band (features/quickgen, our own bands), the same every time.
  if (costCp === null && MAGIC_ORDER.includes(rarity)) {
    const gp = priceFor(makeRng(`shop-price|${nameKey(name)}`), rarity);
    if (gp !== null) costCp = Math.round((type === 'potion' || type === 'scroll' || type === 'ammunition' ? Math.max(50, Math.round(gp / 2)) : gp) * 100);
  }
  return {
    name, type, category: category || (magic ? '' : stats.some(([k]) => /damage/i.test(k)) ? 'Weapon' : stats.some(([k]) => /armor class/i.test(k)) ? 'Armor' : ''),
    rarity, costCp, weight, description: rest.join('\n\n').slice(0, 8000), properties: props.join('; ').slice(0, 1000), attunement, tags: [], dmNotes: '', sourceRef: t.id,
  };
}

function typeOf(name: string, category: string, text: string, magic: boolean): ItemType {
  const c = category.toLowerCase();
  const n = name.toLowerCase();
  if (/\bscroll\b/.test(n)) return 'scroll';
  if (/^potion\b|\bpotion of\b|\boil of\b|\bphilter\b|\belixir\b/.test(n)) return 'potion';
  if (/\b(arrows?|bolts?|bullets?|needles?|sling bullets?)\b|ammunition/.test(n) && !/case|quiver|catching/.test(n)) return 'ammunition';
  if (/\bshield\b/.test(n) && !/sentinel|guardian|arrow-catching|missile/.test(n) && !magic) return 'shield';
  const has = (w: string) => new RegExp(`\\b${w}s?\\b`).test(c);
  if (has('ammunition')) return 'ammunition';
  if (has('weapon')) return 'weapon';
  if (has('armor')) return /\bshield\b/.test(n) ? 'shield' : 'armor';
  if (has('potion')) return 'potion';
  if (has('ring')) return 'ring';
  if (has('rod')) return 'rod';
  if (has('staff') || c.includes('staves')) return 'staff';
  if (has('wand')) return 'wand';
  if (has('scroll')) return 'scroll';
  if (c.includes('wondrous')) return 'wondrous item';
  if (has('tool')) return 'tool';
  if (has('mount') || has('vehicle')) return 'mount';
  if (magic) return 'wondrous item';
  if (/\*\*Damage:\*\*/.test(text)) return 'weapon';
  if (/\*\*Armor Class:\*\*/.test(text)) return /\bshield\b/.test(n) ? 'shield' : 'armor';
  if (/(tools|supplies|utensils|\bkit\b|instrument|lute|flute|drum|horn|lyre|bagpipes|viol|dulcimer|pan flute|shawm|set\b)/.test(n) && !/healer|climber|mess kit/.test(n)) return 'tool';
  if (/\b(horse|pony|mule|donkey|camel|mastiff|elephant|warhorse|cart|wagon|carriage|sled|chariot|saddle|boat|ship|galley|keelboat|rowboat|longship|sailing)\b/.test(n)) return 'mount';
  if (/\b(rations?|ale|wine|bread|cheese|meat|feast|meal|mead)\b/.test(n)) return 'food';
  return 'gear';
}

export interface NewItem {
  name: string; type: ItemType; category: string; rarity: ItemRarity; costCp: number | null; weight: number | null;
  description: string; properties: string; attunement: boolean; source: string; sourceLabel: string; sourceRef?: string | null;
  attribution: string; tags: string[]; dmNotes: string;
}

const s = (v: unknown, max: number) => (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
const tagsOf = (v: unknown): string[] => {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[;,|]/) : [];
  return [...new Set(raw.map((x) => String(x).trim().replace(/^#/, '').toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 20);
};
const boolOf = (v: unknown) => v === true || v === 1 || /^(true|yes|y|1|x|required?)$/i.test(String(v ?? '').trim());

/** A record from a request, a JSON file or a CSV row, checked. Throws HttpError 400 / RangeError on bad input. */
export function cleanItem(b: any, defaults: { source?: string; sourceLabel?: string; attribution?: string } = {}): NewItem {
  const name = s(b?.name ?? b?.term ?? b?.title, 120);
  if (!name) throw new HttpError(400, 'An item needs a name');
  let costCp: number | null;
  try {
    costCp = b?.costCp !== undefined && b?.costCp !== null && b?.costCp !== '' ? Math.round(Number(b.costCp)) : b?.cost_cp !== undefined && b?.cost_cp !== null && b?.cost_cp !== '' ? Math.round(Number(b.cost_cp)) : parseCost(b?.cost ?? b?.price ?? b?.value);
  } catch (e) { throw new HttpError(400, `${name}: ${(e as Error).message}`); }
  if (costCp !== null && (!Number.isFinite(costCp) || costCp < 0 || costCp > 10_000_000_000)) throw new HttpError(400, `${name}: cost out of range`);
  const wRaw = b?.weight;
  let weight: number | null = null;
  if (wRaw !== undefined && wRaw !== null && wRaw !== '') {
    const m = /([\d.]+)/.exec(String(wRaw).replace(/,/g, ''));
    weight = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(weight) || weight < 0 || weight > 1_000_000) throw new HttpError(400, `${name}: weight must be a number of pounds`);
  }
  const type = normType(b?.type ?? b?.item_type ?? b?.category);
  const source = s(b?.source, 60).toLowerCase().replace(/[^a-z0-9:._-]+/g, '-') || defaults.source || 'custom';
  return {
    name, type, category: s(b?.category, 80), rarity: normRarity(b?.rarity, 'mundane'), costCp, weight,
    description: s(b?.description ?? b?.text ?? b?.desc, 8000), properties: s(Array.isArray(b?.properties) ? b.properties.join('; ') : b?.properties, 1000),
    attunement: boolOf(b?.attunement ?? b?.requiresAttunement), source, sourceLabel: s(b?.sourceLabel ?? b?.source_label, 80) || defaults.sourceLabel || (source === 'custom' ? 'Custom' : source),
    sourceRef: s(b?.sourceRef ?? b?.source_ref, 200) || null, attribution: s(b?.attribution, 1000) || defaults.attribution || '',
    tags: tagsOf(b?.tags), dmNotes: s(b?.dmNotes ?? b?.dm_notes, 4000),
  };
}

export function insertItem(db: DB, worldId: string, it: NewItem, by: string | null): string {
  const iid = newId('sit_');
  const t = now();
  run(db, `INSERT INTO shop_items (id, world_id, name, name_key, type, category, rarity, cost_cp, weight, description, properties, attunement, source, source_label, source_ref, attribution, tags, dm_notes, created_at, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  iid, worldId, it.name, nameKey(it.name), it.type, it.category, it.rarity, it.costCp, it.weight, it.description, it.properties, it.attunement ? 1 : 0, it.source, it.sourceLabel, it.sourceRef ?? null, it.attribution, JSON.stringify(it.tags), it.dmNotes, t, t, by);
  return iid;
}

export function updateItem(db: DB, iid: string, it: NewItem, by: string | null) {
  run(db, `UPDATE shop_items SET name = ?, name_key = ?, type = ?, category = ?, rarity = ?, cost_cp = ?, weight = ?, description = ?, properties = ?, attunement = ?, source = ?, source_label = ?, source_ref = ?, attribution = ?, tags = ?, dm_notes = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
    it.name, nameKey(it.name), it.type, it.category, it.rarity, it.costCp, it.weight, it.description, it.properties, it.attunement ? 1 : 0, it.source, it.sourceLabel, it.sourceRef ?? null, it.attribution, JSON.stringify(it.tags), it.dmNotes, now(), by, iid);
}

export interface ImportResult { added: number; updated: number; skipped: number; errors: string[]; total: number; sample: string[]; duplicates: string[] }

/**
 * Add records to the item database in one transaction. Duplicates (same name key as a row already there, or earlier in
 * this batch) are skipped; with onDuplicate 'update' a row from the same source is refreshed instead. preview: count only.
 */
export function importItems(db: DB, worldId: string, records: NewItem[], o: { onDuplicate?: 'skip' | 'update'; preview?: boolean; by?: string | null; errors?: string[] } = {}): ImportResult {
  const have = new Map<string, { id: string; source: string }>();
  for (const r of all<{ id: string; name_key: string; source: string }>(db, 'SELECT id, name_key, source FROM shop_items WHERE world_id = ?', worldId)) if (!have.has(r.name_key)) have.set(r.name_key, { id: r.id, source: r.source });
  const out: ImportResult = { added: 0, updated: 0, skipped: 0, errors: [...(o.errors ?? [])], total: records.length, sample: [], duplicates: [] };
  const batch = new Set<string>();
  const work = () => {
    for (const it of records) {
      const k = nameKey(it.name);
      if (!k) { out.skipped++; continue; }
      if (batch.has(k)) { out.skipped++; if (out.duplicates.length < 20) out.duplicates.push(it.name); continue; }
      batch.add(k);
      const ex = have.get(k);
      if (ex) {
        if (o.onDuplicate === 'update' && ex.source === it.source && ex.source !== 'custom') { if (!o.preview) updateItem(db, ex.id, it, o.by ?? null); out.updated++; }
        else { out.skipped++; if (out.duplicates.length < 20) out.duplicates.push(it.name); }
        continue;
      }
      if (!o.preview) insertItem(db, worldId, it, o.by ?? null);
      out.added++;
      if (out.sample.length < 8) out.sample.push(it.name);
    }
  };
  if (o.preview) work(); else tx(db, work);
  return out;
}

/** The items of a game module (built-in or imported), as records with its attribution. */
export function moduleItems(db: DB, worldId: string, moduleId: string): NewItem[] {
  const m = moduleDoc(db, worldId, moduleId);
  if (!m) throw new HttpError(404, `No game module ${moduleId.slice(0, 60)} in this world`);
  const label = m.builtin ? (moduleId === 'dnd-2014' ? 'SRD 5.1' : 'SRD 5.2') : m.doc.name;
  const out: NewItem[] = [];
  for (const t of m.doc.terms) {
    if (t.kind !== 'item') continue;
    const f = fromTerm(t);
    out.push({ ...f, source: moduleId, sourceLabel: label.slice(0, 80), sourceRef: `${moduleId}:${f.sourceRef}`, attribution: m.doc.attribution.slice(0, 1000) });
  }
  return out;
}

/** First visit: the item database is filled from the world's enabled built-in modules (SRD 5.2 by default). Once only. */
export function ensureSeeded(db: DB, worldId: string, enabled: string[]) {
  if (one(db, 'SELECT 1 FROM shop_meta WHERE world_id = ? AND seeded_at IS NOT NULL', worldId)) return;
  const ids = enabled.filter((x) => x === 'dnd-2024' || x === 'dnd-2014');
  const recs = (ids.length ? ids : ['dnd-2024']).flatMap((m) => moduleItems(db, worldId, m));
  importItems(db, worldId, recs, { by: null });
  run(db, 'INSERT INTO shop_meta (world_id, seeded_at) VALUES (?, ?) ON CONFLICT (world_id) DO UPDATE SET seeded_at = excluded.seeded_at', worldId, now());
}

// ---- CSV ------------------------------------------------------------------

export const CSV_COLUMNS = ['name', 'type', 'category', 'rarity', 'cost', 'cost_cp', 'weight', 'attunement', 'description', 'properties', 'source', 'attribution', 'tags', 'dm_notes'] as const;

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF, a header row. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"' && f === '') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const data = rows.filter((r) => r.some((x) => x.trim() !== ''));
  if (!data.length) return [];
  const head = data[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  if (!head.includes('name')) throw new HttpError(400, 'The CSV needs a header row with a name column');
  return data.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const cell = (v: unknown) => { const t = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const gpText = (cp: number | null) => (cp === null ? '' : `${Math.round(cp) / 100} gp`);

export function toCsv(rows: ItemRow[]): string {
  const L = [CSV_COLUMNS.join(',')];
  for (const r of rows) L.push([r.name, r.type, r.category, r.rarity, gpText(r.cost_cp), r.cost_cp ?? '', r.weight ?? '', r.attunement ? 'yes' : '', r.description, r.properties, r.source, r.attribution, parseJson<string[]>(r.tags, []).join('; '), r.dm_notes].map(cell).join(','));
  return L.join('\r\n') + '\r\n';
}

/** Records from a JSON import: an array, or { items: [...] }. Bad records become errors, not a failed import. */
export function recordsFrom(list: unknown[], defaults: { source?: string; sourceLabel?: string; attribution?: string }): { records: NewItem[]; errors: string[] } {
  const records: NewItem[] = [];
  const errors: string[] = [];
  if (list.length > 20_000) throw new HttpError(413, 'At most 20,000 items per import');
  for (const [i, x] of list.entries()) {
    try { records.push(cleanItem(x, defaults)); } catch (e) { if (errors.length < 50) errors.push(`#${i + 1}: ${(e as Error).message}`); }
  }
  return { records, errors };
}
