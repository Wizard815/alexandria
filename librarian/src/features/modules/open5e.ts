// Open5e (https://open5e.com, API v2) as module terms: spells, creatures,
// magic items, mundane gear, conditions, feats, backgrounds and species from
// the books Open5e carries (Tome of Beasts, Deep Magic, Vault of Magic, Level
// Up A5e, Black Flag, the SRDs ...). Free, no key. Each term gets the same
// `data` and card layout as the built-in SRD (srd5e.ts), so the encounter
// builder, initiative, the Codex spell import and the shop item import read
// them like any SRD term.
import { clip, summarize, type Kind, type Term } from './format.ts';
import { ABIL, magicItemTerm, mk, monsterTerm, spellTerm, type Act, type MonsterData } from './srd5e.ts';

export const OPEN5E_BASE = 'https://api.open5e.com';

/** Open5e endpoints read, and the kind of term each gives. */
export const OPEN5E_ENDPOINTS: { path: string; kind: Kind; label: string }[] = [
  { path: 'spells', kind: 'spell', label: 'spells' },
  { path: 'creatures', kind: 'monster', label: 'monsters' },
  { path: 'magicitems', kind: 'item', label: 'magic items' },
  { path: 'items', kind: 'item', label: 'gear' },
  { path: 'conditions', kind: 'condition', label: 'conditions' },
  { path: 'feats', kind: 'other', label: 'feats' },
  { path: 'backgrounds', kind: 'other', label: 'backgrounds' },
  { path: 'species', kind: 'other', label: 'species' },
];

const s = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const nm = (v: any): string => (typeof v === 'string' ? v : s(v?.name));
const cap = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const title = (t: string) => t.replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };

/** "action" → "Action", "bonus-action" → "Bonus Action", "10minutes" → "10 minutes". */
export function castingTime(v: unknown, reaction?: unknown): string {
  const t = s(v).trim();
  const out = /^(\d+)\s*([a-z]+)$/i.test(t) ? t.replace(/^(\d+)\s*([a-z]+)$/i, '$1 $2') : /^(turn|round)$/i.test(t) ? `1 ${t.toLowerCase()}` : t.split('-').map(cap).join(' ');
  const cond = s(reaction).trim();
  return cond && /reaction/i.test(out) ? `${out}, ${cond}` : out;
}

// ---- spells ----------------------------------------------------------------
export function spellOf(x: any): Term {
  const components = [x.verbal ? 'V' : '', x.somatic ? 'S' : '', x.material ? 'M' : ''].filter(Boolean);
  const classes = Array.isArray(x.classes) ? x.classes.map(nm).filter(Boolean) : [];
  const save = s(x.saving_throw_ability).trim();
  const body = s(x.desc).trim();
  const t = spellTerm(s(x.name), {
    level: Number(x.level) || 0,
    school: cap(nm(x.school)),
    castingTime: castingTime(x.casting_time, x.reaction_condition),
    range: s(x.range_text) || (num(x.range) ? `${x.range} ${s(x.range_unit) || 'feet'}` : ''),
    components,
    material: s(x.material_specified).trim() || null,
    duration: cap(s(x.duration)),
    concentration: !!x.concentration,
    ritual: !!x.ritual,
    classes,
    ...(Array.isArray(x.damage_types) && x.damage_types.length ? { damageTypes: x.damage_types.map((d: unknown) => cap(nm(d))).filter(Boolean) } : {}),
    ...(save ? { saves: [cap(save)] } : {}),
    ...(num(x.material_cost) ? { materialCost: true } : {}),
    ...(x.material_consumed ? { materialConsumed: true } : {}),
  }, body, s(x.higher_level).trim());
  return t;
}

// ---- creatures -------------------------------------------------------------
const LONG = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' } as const;

function usage(u: any): string {
  if (!u || typeof u !== 'object') return '';
  const p = num(u.param);
  if (u.type === 'RECHARGE_ON_ROLL' && p) return p >= 6 ? ' (Recharge 6)' : ` (Recharge ${p}–6)`;
  if (u.type === 'PER_DAY' && p) return ` (${p}/Day)`;
  if (u.type === 'RECHARGE_AFTER_REST') return ' (Recharges after a Short or Long Rest)';
  return '';
}

const resist = (display: unknown, list: unknown): string[] => {
  const d = s(display).trim();
  if (d) return [d];
  return Array.isArray(list) ? list.map(nm).filter(Boolean).map((x) => x.toLowerCase()) : [];
};

export function creatureOf(x: any): Term {
  const speed: Record<string, string | boolean> = {};
  const unit = s(x.speed?.unit) === 'feet' || !x.speed?.unit ? 'ft.' : s(x.speed.unit);
  for (const [k, v] of Object.entries(x.speed ?? {})) {
    if (k === 'unit') continue;
    if (v === true) speed[k] = true;
    else if (num(v)) speed[k] = `${v} ${unit}`;
  }
  const senses: Record<string, string | number> = {};
  for (const k of ['blindsight', 'darkvision', 'tremorsense', 'truesight'] as const) { const r = num(x[`${k}_range`]); if (r) senses[k] = `${r} ft.`; }
  if (num(x.passive_perception) !== null) senses.passive_perception = Number(x.passive_perception);
  const saves: Record<string, number> = {};
  for (const [k, l] of Object.entries(LONG)) { const v = num(x.saving_throws?.[l]); if (v !== null) saves[k] = v; }
  const skills: Record<string, number> = {};
  for (const [k, v] of Object.entries(x.skill_bonuses ?? {})) if (num(v) !== null) skills[title(k)] = Number(v);
  const acts = (Array.isArray(x.actions) ? [...x.actions] : []).sort((a, b) => (Number(a.order_in_statblock) || 0) - (Number(b.order_in_statblock) || 0));
  const of = (type: string): Act[] => acts.filter((a) => (a.action_type ?? 'ACTION') === type).map((a) => {
    const cost = num(a.legendary_action_cost);
    return { name: `${s(a.name)}${usage(a.usage_limits)}${type === 'LEGENDARY_ACTION' && cost && cost > 1 ? ` (Costs ${cost} Actions)` : ''}`, text: s(a.desc) };
  });
  const ri = x.resistances_and_immunities ?? {};
  const env = Array.isArray(x.environments) ? x.environments.map(nm).filter(Boolean) : [];
  const data: MonsterData = {
    size: nm(x.size), type: nm(x.type).toLowerCase(), subtype: s(x.subcategory) || null, alignment: s(x.alignment) || 'unaligned',
    cr: num(x.challenge_rating) ?? 0, xp: num(x.experience_points), ac: num(x.armor_class) ?? 10, acType: s(x.armor_detail) || null,
    hp: num(x.hit_points) ?? 1, hitDice: s(x.hit_dice).replace(/\s*([+-])\s*/g, ' $1 ') || null, speed,
    abilities: Object.fromEntries(ABIL.map((k) => [k, num(x.ability_scores?.[LONG[k]]) ?? 10])) as MonsterData['abilities'],
    savingThrows: saves, skills,
    vulnerabilities: resist(ri.damage_vulnerabilities_display, ri.damage_vulnerabilities),
    resistances: resist(ri.damage_resistances_display, ri.damage_resistances),
    immunities: resist(ri.damage_immunities_display, ri.damage_immunities),
    conditionImmunities: resist(ri.condition_immunities_display, ri.condition_immunities),
    senses, languages: s(x.languages?.as_string ?? x.languages),
    traits: (Array.isArray(x.traits) ? x.traits : []).map((t: any) => ({ name: s(t.name), text: s(t.desc) })),
    actions: of('ACTION'), bonusActions: of('BONUS_ACTION'), reactions: of('REACTION'), legendaryActions: of('LEGENDARY_ACTION'),
    ...(env.length ? { environments: env } : {}),
  };
  return monsterTerm(s(x.name), data);
}

// ---- items -----------------------------------------------------------------
const gp = (v: unknown) => { const n = num(v); return n && n > 0 ? { quantity: n, unit: 'gp' } : null; };
const lb = (x: any) => { const w = num(x.weight); return w && w > 0 ? `**Weight:** ${w} ${s(x.weight_unit) === 'lb' || !x.weight_unit ? 'lb.' : s(x.weight_unit)}` : ''; };

export function magicItemOf(x: any): Term {
  const att = !!x.requires_attunement;
  const detail = s(x.attunement_detail).trim();
  const cost = gp(x.cost);
  const stats = [cost ? `**Cost:** ${cost.quantity} gp` : '', lb(x)].filter(Boolean).join('  \n');
  const body = [stats, s(x.desc).trim()].filter(Boolean).join('\n\n');
  return magicItemTerm(s(x.name), nm(x.category), nm(x.rarity), att, body, { ...(detail ? { attunementDetail: detail } : {}), ...(cost ? { cost } : {}) });
}

export function itemOf(x: any): Term {
  const cat = nm(x.category);
  const cost = gp(x.cost);
  const bits: string[] = [];
  const w = x.weapon && typeof x.weapon === 'object' ? x.weapon : null;
  const a = x.armor && typeof x.armor === 'object' ? x.armor : null;
  if (w?.damage_dice) bits.push(`**Damage:** ${w.damage_dice}${w.damage_type ? ` ${nm(w.damage_type)}` : ''}`);
  if (Array.isArray(w?.properties) && w.properties.length) bits.push(`**Properties:** ${w.properties.map((p: any) => `${nm(p.property ?? p)}${p.detail ? ` (${p.detail})` : ''}`).join(', ')}`);
  if (a?.ac_display) bits.push(`**Armor Class:** ${a.ac_display}`);
  if (a?.strength_score_required) bits.push(`**Strength:** ${a.strength_score_required}`);
  if (a?.grants_stealth_disadvantage) bits.push('**Stealth:** Disadvantage');
  if (cost) bits.push(`**Cost:** ${cost.quantity} gp`);
  const wt = lb(x);
  if (wt) bits.push(wt);
  const d = s(x.desc).trim();
  const text = [bits.join('  \n'), d].filter(Boolean).join('\n\n');
  const dmg = w?.damage_dice ? `${w.damage_dice}${w.damage_type ? ` ${nm(w.damage_type)}` : ''}` : '';
  return mk('item', s(x.name), text || cat, { summary: clip([cat, dmg, cost ? `${cost.quantity} gp` : ''].filter(Boolean).join(' · ') || summarize(d), 300), data: { category: cat, cost } });
}

// ---- prose ------------------------------------------------------------------
export function conditionOf(x: any): Term {
  const text = (Array.isArray(x.descriptions) ? x.descriptions.map((d: any) => s(d.desc)) : [s(x.desc)]).filter(Boolean).join('\n\n').trim();
  return mk('condition', s(x.name), text, { summary: summarize(text) });
}

const benefits = (x: any) => (Array.isArray(x.benefits) ? x.benefits : []).map((b: any) => (b.name ? `**${s(b.name)}.** ${s(b.desc)}` : `- ${s(b.desc)}`)).join('\n\n');

export function featOf(x: any): Term {
  const head = `*${x.type ? `${cap(s(x.type).toLowerCase())} feat` : 'Feat'}*`;
  const pre = s(x.prerequisite).replace(/^\*|\*$/g, '').trim();
  const text = [head, pre ? `**Prerequisite:** ${pre}` : '', s(x.desc).trim(), benefits(x)].filter(Boolean).join('\n\n');
  return mk('other', s(x.name), text, { summary: summarize([s(x.desc), benefits(x)].join(' ')), data: { feat: true, ...(pre ? { prerequisite: pre } : {}) } });
}

export function backgroundOf(x: any): Term {
  const text = ['*Background*', s(x.desc).trim(), benefits(x)].filter(Boolean).join('\n\n');
  return mk('other', s(x.name), text, { summary: summarize(s(x.desc) || benefits(x)), data: { background: true } });
}

export function speciesOf(x: any): Term {
  const traits = (Array.isArray(x.traits) ? x.traits : []).map((t: any) => `**${s(t.name)}.** ${s(t.desc)}`).join('\n\n');
  const parent = x.subspecies_of ? nm(x.subspecies_of) : '';
  const text = [`*${parent ? `${parent} subspecies` : 'Species'}*`, s(x.desc).trim(), traits].filter(Boolean).join('\n\n');
  return mk('other', s(x.name), text, { summary: summarize(s(x.desc) || traits), data: { species: true, ...(parent ? { of: parent } : {}) } });
}

export const OPEN5E_CONVERT: Record<string, (x: any) => Term> = {
  spells: spellOf, creatures: creatureOf, magicitems: magicItemOf, items: itemOf, conditions: conditionOf, feats: featOf, backgrounds: backgroundOf, species: speciesOf,
};

/** A credit line for the documents a module was made from (their own licence, publisher and page). */
export function open5eAttribution(docs: any[]): string {
  const parts = docs.map((d) => {
    const lic = Array.isArray(d.licenses) ? d.licenses.map(nm).filter(Boolean).join(', ') : '';
    const by = nm(d.publisher);
    return `${s(d.name)}${by ? ` by ${by}` : ''}${lic ? `, used under the ${lic}` : ''}${d.permalink ? ` (${s(d.permalink)})` : ''}.`;
  });
  return clip(`This module includes material from ${parts.join(' ')} Data from the Open5e API (https://open5e.com).`, 2000);
}

export function open5eLicense(docs: any[]): string {
  const keys = [...new Set(docs.flatMap((d) => (Array.isArray(d.licenses) ? d.licenses.map((l: any) => s(l.key)) : [])).filter(Boolean))];
  const label: Record<string, string> = { 'cc-by-40': 'CC-BY-4.0', 'ogl-10a': 'OGL-1.0a', cc0: 'CC0' };
  return keys.map((k) => label[k] ?? k).join(', ');
}
