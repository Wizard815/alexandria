// The 5e SRD API's data (the 5e-bits/5e-srd-api database, which dnd5eapi.co
// serves) as module terms. Used by scripts/build-srd.ts for the two built-in
// modules and by the "dnd5eapi" importer for a fresh copy. The statblock and
// spell renderers are shared with the Open5e importer, so every monster card
// has the same layout (modules/hide.ts relies on it to hide numbers from
// players) and every spell the same head lines (spells/importers.ts strips
// them).
import { clip, summarize, type Term } from './format.ts';

// ---- helpers -------------------------------------------------------------
const arr = (v: any): string => (Array.isArray(v) ? v.join('\n\n') : typeof v === 'string' ? v : '');
const descOf = (x: any): string => arr(x.desc ?? x.description).trim();
export const ordinal = (n: number) => (n === 0 ? 'Cantrip' : `Level ${n}`);
const refName = (v: any): string => (typeof v === 'string' ? v : v?.name ?? v?.index ?? '');
const list = (v: any): string[] => (Array.isArray(v) ? v.map(refName).filter(Boolean) : []);
const MD_HEADING_FIX = (s: string) => s.replace(/\n{3,}/g, '\n\n').trim();
/** 2024 text uses single newlines between paragraphs; make them paragraphs. */
export const paras = (s: string) => MD_HEADING_FIX(s.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n\n'));

export function mk(kind: Term['kind'], term: string, text: string, extra: Partial<Term> = {}): Term {
  return { id: '', term, kind, aliases: [], summary: extra.summary ?? '', text, ...extra };
}

// ---- spells --------------------------------------------------------------
export interface SpellData {
  level: number;
  school: string;
  castingTime: string;
  range: string;
  components: string[];
  material: string | null;
  duration: string;
  concentration: boolean;
  ritual: boolean;
  classes: string[];
  [k: string]: unknown;
}

/** A spell term: an italic level line, the four fields, then the text (and "At Higher Levels"). */
export function spellTerm(name: string, d: SpellData, body: string, higher = ''): Term {
  const head = `*${ordinal(d.level)} ${d.school}${d.classes.length ? ` (${d.classes.join(', ')})` : ''}*`;
  const lines = [
    `**Casting Time:** ${d.castingTime}${d.ritual ? ' (ritual)' : ''}`,
    `**Range:** ${d.range}`,
    `**Components:** ${d.components.join(', ')}${d.material ? ` (${d.material})` : ''}`,
    `**Duration:** ${d.concentration ? 'Concentration, ' : ''}${d.duration}`,
  ];
  if (higher) body += `\n\n**At Higher Levels.** ${higher}`;
  const text = `${head}\n\n${lines.join('  \n')}\n\n${body}`.trim();
  const summary = `${ordinal(d.level)} ${d.school.toLowerCase()}${d.concentration ? ', concentration' : ''}${d.ritual ? ', ritual' : ''} · ${d.castingTime} · ${d.range}. ${summarize(body, 140)}`;
  return mk('spell', name, text, { summary: clip(summary, 300), data: d });
}

export function spells(rows: any[], y: string): Term[] {
  return rows.map((s) => {
    const body = y === '2014' ? arr(s.desc) : paras(s.description ?? '');
    return spellTerm(s.name, {
      level: s.level, school: refName(s.school), castingTime: s.casting_time, range: s.range, components: s.components ?? [], material: s.material ?? null,
      duration: s.duration, concentration: !!s.concentration, ritual: !!s.ritual, classes: list(s.classes),
    }, body, s.higher_level?.length ? arr(s.higher_level) : '');
  });
}

// ---- conditions, rules and other prose terms ------------------------------
export function simple(kind: Term['kind'], rows: any[], y: string, sub?: (x: any) => string, aliasOf?: (x: any) => string[]): Term[] {
  return rows.map((x) => {
    const body = y === '2014' ? descOf(x) : paras(descOf(x));
    const text = [sub?.(x), body].filter(Boolean).join('\n\n');
    return mk(kind, x.full_name ? `${x.full_name}` : x.name, text, { aliases: aliasOf?.(x) ?? (x.full_name ? [x.name] : []) });
  }).filter((t) => t.text);
}

// ---- monsters ------------------------------------------------------------
export const ABIL = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
const ABIL_LONG: Record<string, string> = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' };
const mod = (n: number) => { const m = Math.floor((n - 10) / 2); return m >= 0 ? `+${m}` : `${m}`; };
export const crText = (cr: number) => (cr === 0.125 ? '1/8' : cr === 0.25 ? '1/4' : cr === 0.5 ? '1/2' : String(cr));

export interface Act { name: string; text: string }
/** The statblock in `data` (see docs/MODULES.md). */
export interface MonsterData {
  size: string; type: string; subtype: string | null; alignment: string; cr: number; xp: number | null;
  ac: number; acType: string | null; hp: number; hitDice: string | null; speed: Record<string, string | boolean>;
  abilities: Record<(typeof ABIL)[number], number>; savingThrows: Record<string, number>; skills: Record<string, number>;
  vulnerabilities: string[]; resistances: string[]; immunities: string[]; conditionImmunities: string[];
  senses: Record<string, string | number>; languages: string;
  traits: Act[]; actions: Act[]; bonusActions: Act[]; reactions: Act[]; legendaryActions: Act[];
  [k: string]: unknown;
}

/** A monster term from its statblock: the card layout every monster in the app has. */
export function monsterTerm(name: string, data: MonsterData, opts: { hpRoll?: string | null } = {}): Term {
  const speed = Object.entries(data.speed ?? {}).filter(([, v]) => v !== false).map(([k, v]) => (v === true ? k : `${k} ${v}`)).join(', ');
  const senses = Object.entries(data.senses ?? {}).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ');
  const sect = (title: string, xs: Act[]) => (xs.length ? `\n\n### ${title}\n\n${xs.map((a) => `**${a.name}.** ${a.text}`).join('\n\n')}` : '');
  const roll = opts.hpRoll === undefined ? data.hitDice : opts.hpRoll;
  const lines = [
    `*${data.size} ${data.type}${data.subtype ? ` (${data.subtype})` : ''}, ${data.alignment}*`,
    `**AC** ${data.ac}${data.acType ? ` (${data.acType})` : ''} · **HP** ${data.hp}${roll ? ` (${roll})` : ''} · **Speed** ${speed}`,
    `| STR | DEX | CON | INT | WIS | CHA |\n|---|---|---|---|---|---|\n| ${ABIL.map((k) => `${data.abilities[k]} (${mod(data.abilities[k])})`).join(' | ')} |`,
  ];
  const meta: string[] = [];
  const kv = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k.toUpperCase().length <= 3 ? k.toUpperCase() : k} ${v >= 0 ? '+' : ''}${v}`).join(', ');
  if (Object.keys(data.savingThrows).length) meta.push(`**Saving Throws** ${kv(data.savingThrows)}`);
  if (Object.keys(data.skills).length) meta.push(`**Skills** ${kv(data.skills)}`);
  if (data.vulnerabilities.length) meta.push(`**Vulnerabilities** ${data.vulnerabilities.join(', ')}`);
  if (data.resistances.length) meta.push(`**Resistances** ${data.resistances.join(', ')}`);
  if (data.immunities.length) meta.push(`**Damage Immunities** ${data.immunities.join(', ')}`);
  if (data.conditionImmunities.length) meta.push(`**Condition Immunities** ${data.conditionImmunities.join(', ')}`);
  if (senses) meta.push(`**Senses** ${senses}`);
  if (data.languages) meta.push(`**Languages** ${data.languages}`);
  meta.push(`**CR** ${crText(data.cr)}${data.xp ? ` (${data.xp.toLocaleString('en-US')} XP)` : ''}`);
  const text = lines.join('\n\n') + '\n\n' + meta.join('  \n') + sect('Traits', data.traits) + sect('Actions', data.actions) + sect('Bonus Actions', data.bonusActions) + sect('Reactions', data.reactions) + sect('Legendary Actions', data.legendaryActions);
  const summary = `${data.size} ${data.type}, ${data.alignment} · CR ${crText(data.cr)} · AC ${data.ac} · HP ${data.hp} · ${speed}`;
  return mk('monster', name, text, { summary: clip(summary, 300), data });
}

export function monsters(rows: any[]): Term[] {
  return rows.map((m) => {
    const ac = Array.isArray(m.armor_class) ? m.armor_class[0] : m.armor_class;
    const acv = typeof ac === 'object' ? ac?.value : ac;
    const act = (xs: any[] | undefined) => (xs ?? []).map((a) => ({ name: a.name, text: a.desc ?? '' }));
    const saves: Record<string, number> = {}, skills: Record<string, number> = {};
    for (const p of m.proficiencies ?? []) {
      const nm: string = p.proficiency?.name ?? '';
      if (nm.startsWith('Saving Throw: ')) saves[nm.slice(14).toLowerCase()] = p.value;
      else if (nm.startsWith('Skill: ')) skills[nm.slice(7)] = p.value;
    }
    const data: MonsterData = {
      size: m.size, type: m.type, subtype: m.subtype ?? null, alignment: m.alignment, cr: m.challenge_rating, xp: m.xp ?? null,
      ac: acv, acType: ac?.type ?? null, hp: m.hit_points, hitDice: m.hit_points_roll ?? m.hit_dice, speed: m.speed ?? {},
      abilities: Object.fromEntries(ABIL.map((k) => [k, m[ABIL_LONG[k]]])) as MonsterData['abilities'],
      savingThrows: saves, skills, vulnerabilities: list(m.damage_vulnerabilities), resistances: list(m.damage_resistances),
      immunities: list(m.damage_immunities), conditionImmunities: list(m.condition_immunities), senses: m.senses ?? {}, languages: m.languages ?? '',
      traits: act(m.special_abilities), actions: act(m.actions), bonusActions: act(m.bonus_actions), reactions: act(m.reactions), legendaryActions: act(m.legendary_actions),
    };
    return monsterTerm(m.name, data, { hpRoll: m.hit_points_roll ?? null });
  });
}

// ---- items ---------------------------------------------------------------
/** A magic item term: "*Category, Rarity, requires attunement*" then the text. */
export function magicItemTerm(name: string, cat: string, rarity: string, attunement: boolean, d: string, extra: Record<string, unknown> = {}): Term {
  const head = `*${[cat, rarity, attunement ? 'requires attunement' : ''].filter(Boolean).join(', ')}*`;
  return mk('item', name, `${head}\n\n${d}`.trim(), { summary: clip(`${[cat, rarity].filter(Boolean).join(', ')}. ${summarize(d.split('\n\n').slice(1).join(' ') || d, 200)}`, 300), data: { category: cat, rarity, attunement, ...extra } });
}

export function magicItems(rows: any[], y: string): Term[] {
  return rows.filter((x) => !x.variant).map((x) => magicItemTerm(x.name, x.equipment_category?.name ?? '', x.rarity?.name ?? '', !!x.attunement, y === '2014' ? arr(x.desc) : arr(x.desc ?? x.description)));
}

export function equipment(rows: any[], y: string): Term[] {
  return rows.map((x) => {
    const cost = x.cost ? `${x.cost.quantity} ${x.cost.unit}` : '';
    const cat = x.equipment_category?.name ?? '';
    const bits: string[] = [];
    if (x.weapon_category || x.category_range) bits.push(`**Category:** ${x.category_range ?? x.weapon_category}`);
    const dmg = x.damage ? `${x.damage.damage_dice} ${refName(x.damage.damage_type)}` : '';
    if (dmg) bits.push(`**Damage:** ${dmg}`);
    if (x.two_handed_damage) bits.push(`**Two-handed:** ${x.two_handed_damage.damage_dice}`);
    if (x.properties?.length) bits.push(`**Properties:** ${list(x.properties).join(', ')}`);
    if (x.mastery) bits.push(`**Mastery:** ${refName(x.mastery)}`);
    if (x.armor_class) bits.push(`**Armor Class:** ${x.armor_class.base}${x.armor_class.dex_bonus ? ' + Dex' : ''}`);
    if (x.str_minimum) bits.push(`**Strength:** ${x.str_minimum}`);
    if (x.stealth_disadvantage) bits.push('**Stealth:** Disadvantage');
    if (cost) bits.push(`**Cost:** ${cost}`);
    if (x.weight) bits.push(`**Weight:** ${x.weight} lb.`);
    const d = y === '2014' ? descOf(x) : paras(descOf(x));
    const text = [bits.join('  \n'), d].filter(Boolean).join('\n\n');
    return mk('item', x.name, text || cat, { summary: clip([cat, dmg, cost].filter(Boolean).join(' · ') || cat, 300), data: { category: cat, cost: x.cost ?? null } });
  });
}

// ---- classes and features --------------------------------------------------
export function classes(rows: any[], _y: string): Term[] {
  return rows.map((c) => {
    const saves = list(c.saving_throws);
    const primary = c.primary_ability?.desc;
    const lines = [`**Hit Die:** d${c.hit_die}`];
    if (primary) lines.push(`**Primary Ability:** ${primary}`);
    if (saves.length) lines.push(`**Saving Throws:** ${saves.join(', ')}`);
    const prof = list(c.proficiencies);
    if (prof.length) lines.push(`**Proficiencies:** ${prof.join(', ')}`);
    return mk('class', c.name, lines.join('  \n'), { summary: `Hit die d${c.hit_die}${primary ? `; primary ability ${primary}` : ''}${saves.length ? `; saves ${saves.join(', ')}` : ''}`, data: { hitDie: c.hit_die, savingThrows: saves } });
  });
}

export function features(rows: any[], y: string): Term[] {
  return rows.map((f) => {
    const cls = refName(f.class);
    const lvl = typeof f.level === 'object' ? f.level?.name : f.level;
    const body = y === '2014' ? descOf(f) : paras(descOf(f));
    const head = `*${cls}${lvl !== undefined && lvl !== null ? ` · ${typeof f.level === 'number' ? `level ${f.level}` : lvl}` : ''}*`;
    return mk('class', f.name, `${head}\n\n${body}`, { summary: clip(`${cls} feature. ${summarize(body, 220)}`, 300), data: { class: cls, level: typeof f.level === 'number' ? f.level : null } });
  }).filter((t) => t.text.length > 20);
}

// ---- assemble --------------------------------------------------------------
/** The database files read, by name (5e-SRD-<Name>.json). Backgrounds, Species and Poisons are 2024-only. */
export const SRD_FILES = ['Conditions', 'Spells', 'Monsters', 'Rules', 'Magic-Items', 'Equipment', 'Weapon-Properties', 'Damage-Types', 'Skills', 'Ability-Scores', 'Magic-Schools', 'Weapon-Mastery-Properties', 'Features', 'Classes', 'Feats', 'Traits', 'Subclasses'] as const;

/** Which files each kind of term comes from, so an import can ask for only some kinds. */
export const SRD_FILES_BY_KIND: Record<string, readonly string[]> = {
  condition: ['Conditions'],
  spell: ['Spells'],
  monster: ['Monsters'],
  rule: ['Rules', 'Weapon-Properties', 'Weapon-Mastery-Properties', 'Damage-Types', 'Skills', 'Ability-Scores', 'Magic-Schools'],
  item: ['Magic-Items', 'Equipment'],
  class: ['Classes', 'Features', 'Subclasses'],
  other: ['Feats', 'Traits'],
};

/** Every term of one edition. `load` returns a database file's rows ([] when it has none). */
export async function buildSrd(year: '2014' | '2024', load: (name: string) => Promise<any[]>, extraRules: Term[] = []): Promise<Term[]> {
  const L = load;
  const terms: Term[] = [];
  terms.push(...simple('condition', await L('Conditions'), year).map((t) => ({ ...t, summary: '' })));
  terms.push(...spells(await L('Spells'), year));
  terms.push(...monsters(await L('Monsters')));
  terms.push(...simple('rule', await L('Rules'), year));
  terms.push(...extraRules);
  terms.push(...simple('rule', await L('Weapon-Properties'), year));
  terms.push(...simple('rule', await L('Weapon-Mastery-Properties'), year, () => '', (x) => [`${x.name} mastery`]));
  terms.push(...simple('rule', await L('Damage-Types'), year, () => '', (x) => [`${x.name} damage`]));
  terms.push(...simple('rule', await L('Skills'), year));
  terms.push(...simple('rule', await L('Ability-Scores'), year, undefined, (x) => [x.name]));
  terms.push(...simple('rule', await L('Magic-Schools'), year, undefined, (x) => [`School of ${x.name}`]));
  terms.push(...magicItems(await L('Magic-Items'), year));
  terms.push(...equipment(await L('Equipment'), year));
  terms.push(...classes(await L('Classes'), year));
  terms.push(...features(await L('Features'), year));
  terms.push(...simple('other', await L('Feats'), year, (x) => (x.type ? `*${x.type} feat*` : '')));
  terms.push(...simple('other', await L('Traits'), year));
  terms.push(...simple('class', await L('Subclasses'), year, (x) => (x.class ? `*${refName(x.class)} subclass*` : '')));
  // Conditions and short terms: derive the summary from the text.
  for (const t of terms) if (!t.summary) t.summary = summarize(t.text.replace(/^\*[^\n]*\*\n\n/, ''));
  return terms;
}

export const SRD_ATTRIBUTION = {
  '2024': 'This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.',
  '2014': 'This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode.',
} as const;
