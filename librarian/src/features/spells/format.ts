// The spell format: one record per spell, the same for the bundled SRD 5.2.1
// spells, a DM's homebrew and anything imported (JSON, CSV, a game module, a
// library page). This file checks and normalises one, and works out the
// fields the search filters use (components, costly or consumed materials,
// damage types, saving throws) from the text when a source does not give them.
import { HttpError } from '../../core/util.ts';

export const SCHOOLS = ['Abjuration', 'Conjuration', 'Divination', 'Enchantment', 'Evocation', 'Illusion', 'Necromancy', 'Transmutation'] as const;
export const DAMAGE_TYPES = ['Acid', 'Bludgeoning', 'Cold', 'Fire', 'Force', 'Lightning', 'Necrotic', 'Piercing', 'Poison', 'Psychic', 'Radiant', 'Slashing', 'Thunder'] as const;
export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type Ability = (typeof ABILITIES)[number];
export const ABILITY_NAMES: Record<Ability, string> = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };

export interface Spell {
  id: string;
  name: string;
  level: number;
  school: string;
  classes: string[];
  castingTime: string;
  ritual: boolean;
  range: string;
  components: { v: boolean; s: boolean; m: boolean };
  material: string;
  /** The material has a gold value (a costly component). */
  materialCost: boolean;
  /** The spell consumes the material. */
  materialConsumed: boolean;
  duration: string;
  concentration: boolean;
  damageTypes: string[];
  saves: string[];
  attack: '' | 'melee' | 'ranged';
  /** Markdown: the description, including what happens at higher levels. */
  text: string;
  /** Where it came from: "SRD 5.2.1", "Homebrew", a file or module name. */
  source: string;
  /** A mana cost the source gives for this spell (the world's table applies otherwise). */
  manaCost?: number | null;
}

export const LIMITS = { name: 120, text: 30_000, short: 300, classes: 20, spellsPerImport: 5000 };

export const slug = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

/** The name as a dedupe key: case, accents, apostrophes and spacing do not count. */
export const nameKey = (s: string): string => slug(s);

const clip = (v: unknown, max: number): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').replace(/\s+/g, ' ').trim().slice(0, max);
const bool = (v: unknown): boolean => v === true || v === 1 || (typeof v === 'string' && /^(y|yes|true|1|x)$/i.test(v.trim()));

/** "Level 3", "3rd", "cantrip", 3 → 3. */
export function parseLevel(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 9) return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/cantrip/.test(s) || s === '0') return 0;
  const m = s.match(/\d/);
  const n = m ? Number(m[0]) : NaN;
  return n >= 0 && n <= 9 ? n : null;
}

export function parseSchool(v: unknown): string {
  const s = clip(typeof v === 'object' && v ? (v as any).name : v, 40);
  const hit = SCHOOLS.find((x) => x.toLowerCase() === s.toLowerCase() || x.toLowerCase().startsWith(s.toLowerCase().slice(0, 4)) && s.length >= 4);
  return hit ?? (s ? s[0].toUpperCase() + s.slice(1) : '');
}

/** "V, S, M (a pinch of soot)" or ["V","S","M"] → flags and the material text. */
export function parseComponents(v: unknown, material?: unknown): { components: Spell['components']; material: string } {
  let text = '';
  let flags: string[] = [];
  if (Array.isArray(v)) flags = v.map((x) => String(x).trim().toUpperCase());
  else if (v && typeof v === 'object') { const o = v as any; flags = [o.v || o.verbal ? 'V' : '', o.s || o.somatic ? 'S' : '', o.m || o.material ? 'M' : ''].filter(Boolean); if (typeof o.material === 'string') text = o.material; }
  else {
    const s = String(v ?? '');
    const paren = s.match(/\(([\s\S]*)\)\s*$/);
    if (paren) text = paren[1];
    flags = s.replace(/\([\s\S]*\)\s*$/, '').split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  }
  if (typeof material === 'string' && material.trim()) text = material;
  const m = flags.includes('M') || flags.includes('MATERIAL') || !!text.trim();
  return { components: { v: flags.includes('V') || flags.includes('VERBAL'), s: flags.includes('S') || flags.includes('SOMATIC'), m }, material: clip(text, 400) };
}

export const isCostly = (material: string): boolean => /\b(?:worth|costing|cost of|value of)\b[^.;]*?\d[\d,]*\+?\s*(?:gp|gold|pp|sp)\b|\b\d[\d,]*\+?\s*gp\b/i.test(material);
export const isConsumed = (material: string): boolean => /\bconsume[sd]?\b|\bconsuming\b/i.test(material);
const DAMAGE_RE = new RegExp(`\\b(${DAMAGE_TYPES.join('|')})\\s+damage\\b`, 'gi');
const SAVE_RE = /\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+saving throw/gi;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1).toLowerCase();
export const damageTypesIn = (text: string): string[] => [...new Set([...text.matchAll(DAMAGE_RE)].map((m) => cap(m[1])))].sort();
export const savesIn = (text: string): string[] => [...new Set([...text.matchAll(SAVE_RE)].map((m) => cap(m[1])))].sort();
export const attackIn = (text: string): Spell['attack'] => (/\bmelee spell attack/i.test(text) ? 'melee' : /\branged spell attack/i.test(text) ? 'ranged' : '');

/** "1 minute or Ritual" → the casting time and whether it is a ritual. */
export function parseCastingTime(v: unknown, ritual?: unknown): { castingTime: string; ritual: boolean } {
  const s = clip(v, LIMITS.short);
  const r = /\bor ritual\b|\(ritual\)/i.test(s);
  return { castingTime: s.replace(/\s*(?:or ritual|\(ritual\))\s*/i, '').trim(), ritual: r || bool(ritual) };
}

/** "Concentration, up to 1 minute" → the duration and whether it needs concentration. */
export function parseDuration(v: unknown, conc?: unknown): { duration: string; concentration: boolean } {
  const s = clip(v, LIMITS.short);
  const c = /^concentration\b/i.test(s);
  const rest = s.replace(/^concentration,?\s*/i, '').trim();
  return { duration: c ? (rest ? rest[0].toUpperCase() + rest.slice(1) : 'Concentration') : s, concentration: c || bool(conc) };
}

const list = (v: unknown, max = LIMITS.classes): string[] => {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;/|]/) : [];
  return [...new Set(arr.map((x) => clip(typeof x === 'object' && x ? (x as any).name : x, 60)).filter(Boolean))].slice(0, max);
};

const pick = (o: any, ...keys: string[]): unknown => { for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined; };

/**
 * One spell from any shape a source might use: our own format, the module
 * format's `data` (level, school, castingTime, components[], material ...),
 * the 5e-SRD API shape (casting_time, desc[], higher_level[]) or a CSV row.
 * Throws 400 with a plain reason when it is not a spell.
 */
export function normalizeSpell(raw: any, source: string, where = 'spell'): Omit<Spell, 'id'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, `${where} is not an object`);
  const name = clip(pick(raw, 'name', 'term', 'title'), LIMITS.name);
  if (!name) throw new HttpError(400, `${where} needs a name`);
  const d = raw.data && typeof raw.data === 'object' ? { ...raw.data, ...raw } : raw;
  const level = parseLevel(pick(d, 'level', 'lvl', 'spellLevel', 'spell_level'));
  if (level === null) throw new HttpError(400, `${where} (${name}) needs a level from 0 (cantrip) to 9`);
  const ct = parseCastingTime(pick(d, 'castingTime', 'casting_time', 'time', 'castTime'), pick(d, 'ritual'));
  const du = parseDuration(pick(d, 'duration'), pick(d, 'concentration'));
  const comp = parseComponents(pick(d, 'components', 'component'), pick(d, 'material', 'materials'));
  if (raw.v !== undefined || raw.s !== undefined || raw.m !== undefined) {
    comp.components = { v: bool(raw.v) || comp.components.v, s: bool(raw.s) || comp.components.s, m: bool(raw.m) || comp.components.m };
  }
  const desc = pick(raw, 'text', 'description', 'desc', 'body', 'entries');
  let text = Array.isArray(desc) ? desc.map((x) => String(x)).join('\n\n') : typeof desc === 'string' ? desc : '';
  const higher = pick(raw, 'higherLevel', 'higher_level', 'higherLevels', 'atHigherLevels');
  const higherText = Array.isArray(higher) ? higher.join(' ') : typeof higher === 'string' ? higher : '';
  if (higherText && !text.includes(higherText.slice(0, 40))) text += `\n\n**${level === 0 ? 'Cantrip Upgrade' : 'Using a Higher-Level Spell Slot'}.** ${higherText}`;
  text = text.replace(/\r/g, '').trim().slice(0, LIMITS.text);
  const plain = `${text}`;
  const flagList = (v: unknown) => list(v, 13).map(cap);
  const dmg = pick(d, 'damageTypes', 'damage_types', 'damageType', 'damage_type', 'damage');
  const saves = pick(d, 'saves', 'save', 'savingThrow', 'saving_throw', 'dc');
  const atk = String(pick(d, 'attack', 'attackType', 'attack_type') ?? '').toLowerCase();
  const material = comp.material;
  const mana = pick(d, 'manaCost', 'mana', 'spellPoints', 'spell_points');
  const manaN = mana === undefined ? null : Number(mana);
  return {
    name,
    level,
    school: parseSchool(pick(d, 'school', 'magicSchool')),
    classes: list(pick(d, 'classes', 'class', 'lists', 'spellLists')),
    castingTime: ct.castingTime,
    ritual: ct.ritual,
    range: clip(pick(d, 'range', 'area'), LIMITS.short),
    components: comp.components,
    material,
    materialCost: pick(d, 'materialCost', 'costly') !== undefined ? bool(pick(d, 'materialCost', 'costly')) : isCostly(material),
    materialConsumed: pick(d, 'materialConsumed', 'consumed') !== undefined ? bool(pick(d, 'materialConsumed', 'consumed')) : isConsumed(material),
    duration: du.duration,
    concentration: du.concentration,
    damageTypes: dmg !== undefined && (typeof dmg !== 'object' || Array.isArray(dmg)) ? flagList(dmg).filter((x) => (DAMAGE_TYPES as readonly string[]).includes(x)) : damageTypesIn(plain),
    saves: saves !== undefined && typeof saves === 'string' && !/^\d+$/.test(saves) || Array.isArray(saves) ? flagList(saves).map((x) => ABILITY_NAMES[x.toLowerCase().slice(0, 3) as Ability] ?? x).filter((x) => Object.values(ABILITY_NAMES).includes(x)) : savesIn(plain),
    attack: atk.startsWith('melee') ? 'melee' : atk.startsWith('ranged') ? 'ranged' : attackIn(plain),
    text,
    source: clip(pick(raw, 'source') ?? source, 120) || source,
    ...(Number.isInteger(manaN) && (manaN as number) >= 0 && (manaN as number) <= 999 ? { manaCost: manaN } : {}),
  };
}

/** "Level 3 evocation · Action · 150 feet": a one-line summary for a card. */
export function spellLine(s: Pick<Spell, 'level' | 'school' | 'castingTime' | 'range' | 'concentration' | 'ritual'>): string {
  const head = s.level === 0 ? `${s.school || 'Unknown'} cantrip` : `Level ${s.level} ${(s.school || '').toLowerCase()}`.trim();
  return [head + (s.concentration ? ', concentration' : '') + (s.ritual ? ', ritual' : ''), s.castingTime, s.range].filter(Boolean).join(' · ');
}

export function componentsText(s: Pick<Spell, 'components' | 'material'>): string {
  const f = [s.components.v && 'V', s.components.s && 'S', s.components.m && 'M'].filter(Boolean).join(', ');
  return s.components.m && s.material ? `${f} (${s.material})` : f;
}

// ---- CSV -------------------------------------------------------------------------------------------------

/** RFC 4180-ish: quoted fields, doubled quotes, commas or semicolons, CRLF. */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const alias: Record<string, string> = { casting_time: 'castingTime', spell_level: 'level', higher_level: 'higherLevel', at_higher_levels: 'higherLevel', damage_type: 'damageTypes', damage_types: 'damageTypes', saving_throw: 'saves', mana_cost: 'manaCost', mana: 'manaCost', spell_points: 'manaCost', material_cost: 'materialCost', costly: 'materialCost', consumed: 'materialConsumed', material_consumed: 'materialConsumed' };
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [alias[h] ?? h, (r[i] ?? '').trim()])));
}

const csvCell = (v: unknown): string => { const s = Array.isArray(v) ? v.join('; ') : v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const CSV_COLUMNS = ['name', 'level', 'school', 'classes', 'castingTime', 'ritual', 'range', 'components', 'material', 'duration', 'concentration', 'damageTypes', 'saves', 'manaCost', 'source', 'text'] as const;
export function toCsv(spells: Spell[]): string {
  const rows = spells.map((s) => CSV_COLUMNS.map((c) => csvCell(c === 'components' ? [s.components.v && 'V', s.components.s && 'S', s.components.m && 'M'].filter(Boolean).join(', ') : (s as any)[c])).join(','));
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}
