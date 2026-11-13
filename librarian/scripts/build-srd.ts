// Regenerates the bundled game modules under src/features/modules/data/.
//
//   node --experimental-strip-types librarian/scripts/build-srd.ts [--from <dir>] [--save-raw <dir>]
//
// The SRD 5.1 (2014) and SRD 5.2 (2024) data comes from the 5e SRD API's
// seed database (packages/5e-database of the 5e-bits/5e-srd-api repository,
// files src/{2014,2024}/en/5e-SRD-*.json). With --from <dir> it reads files
// named <year>-<Name>.json from a folder instead (for offline builds); with
// --save-raw <dir> it keeps the downloaded files there. Behind a proxy run it
// with NODE_USE_ENV_PROXY=1.
//
// The 2024 database has no "rules" file, so the core rules for SRD 5.2 come
// from data/rules-2024.handwritten.json (short paraphrases written for this
// app, same attribution). Edit that file, then run this script again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clip, normalizeModule, summarize, type Term } from '../src/features/modules/format.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'src', 'features', 'modules', 'data');
const SOURCE = 'https://raw.githubusercontent.com/5e-bits/5e-srd-api/main/packages/5e-database/src';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const fromDir = opt('--from');
const saveRaw = opt('--save-raw');

const NAMES = ['Conditions', 'Spells', 'Monsters', 'Rules', 'Magic-Items', 'Equipment', 'Weapon-Properties', 'Damage-Types', 'Skills', 'Ability-Scores', 'Magic-Schools', 'Weapon-Mastery-Properties', 'Features', 'Classes', 'Feats', 'Traits', 'Subclasses'];

async function load(year: string, name: string): Promise<any[]> {
  const file = `${year}-${name}.json`;
  if (fromDir) {
    const p = path.join(fromDir, file);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  }
  const r = await fetch(`${SOURCE}/${year}/en/5e-SRD-${name}.json`);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
  const t = await r.text();
  if (saveRaw) { fs.mkdirSync(saveRaw, { recursive: true }); fs.writeFileSync(path.join(saveRaw, file), t); }
  return JSON.parse(t);
}

// ---- helpers -------------------------------------------------------------
const arr = (v: any): string => (Array.isArray(v) ? v.join('\n\n') : typeof v === 'string' ? v : '');
const descOf = (x: any): string => arr(x.desc ?? x.description).trim();
const ordinal = (n: number) => (n === 0 ? 'Cantrip' : `Level ${n}`);
const refName = (v: any): string => (typeof v === 'string' ? v : v?.name ?? v?.index ?? '');
const list = (v: any): string[] => (Array.isArray(v) ? v.map(refName).filter(Boolean) : []);
const MD_HEADING_FIX = (s: string) => s.replace(/\n{3,}/g, '\n\n').trim();
/** 2024 text uses single newlines between paragraphs; make them paragraphs. */
const paras = (s: string) => MD_HEADING_FIX(s.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n\n'));

function mk(kind: Term['kind'], term: string, text: string, extra: Partial<Term> = {}): Term {
  return { id: '', term, kind, aliases: [], summary: extra.summary ?? '', text, ...extra };
}

// ---- spells --------------------------------------------------------------
function spells(rows: any[], y: string): Term[] {
  return rows.map((s) => {
    const classes = list(s.classes);
    const school = refName(s.school);
    const comps: string[] = s.components ?? [];
    const head = `*${ordinal(s.level)}${s.level === 0 ? ` ${school}` : ` ${school}`}${classes.length ? ` (${classes.join(', ')})` : ''}*`;
    const lines = [
      `**Casting Time:** ${s.casting_time}${s.ritual ? ' (ritual)' : ''}`,
      `**Range:** ${s.range}`,
      `**Components:** ${comps.join(', ')}${s.material ? ` (${s.material})` : ''}`,
      `**Duration:** ${s.concentration ? 'Concentration, ' : ''}${s.duration}`,
    ];
    let body = y === '2014' ? arr(s.desc) : paras(s.description ?? '');
    if (s.higher_level?.length) body += `\n\n**At Higher Levels.** ${arr(s.higher_level)}`;
    const text = `${head}\n\n${lines.join('  \n')}\n\n${body}`.trim();
    const summary = `${ordinal(s.level)} ${school.toLowerCase()}${s.concentration ? ', concentration' : ''}${s.ritual ? ', ritual' : ''} · ${s.casting_time} · ${s.range}. ${summarize(body, 140)}`;
    return mk('spell', s.name, text, {
      summary: clip(summary, 300),
      data: { level: s.level, school, castingTime: s.casting_time, range: s.range, components: comps, material: s.material ?? null, duration: s.duration, concentration: !!s.concentration, ritual: !!s.ritual, classes },
    });
  });
}

// ---- conditions, rules and other prose terms ------------------------------
function simple(kind: Term['kind'], rows: any[], y: string, sub?: (x: any) => string, aliasOf?: (x: any) => string[]): Term[] {
  return rows.map((x) => {
    const body = y === '2014' ? descOf(x) : paras(descOf(x));
    const text = [sub?.(x), body].filter(Boolean).join('\n\n');
    return mk(kind, x.full_name ? `${x.full_name}` : x.name, text, { aliases: aliasOf?.(x) ?? (x.full_name ? [x.name] : []) });
  }).filter((t) => t.text);
}

// ---- monsters ------------------------------------------------------------
const ABIL: [string, string][] = [['str', 'strength'], ['dex', 'dexterity'], ['con', 'constitution'], ['int', 'intelligence'], ['wis', 'wisdom'], ['cha', 'charisma']];
const mod = (n: number) => { const m = Math.floor((n - 10) / 2); return m >= 0 ? `+${m}` : `${m}` };
const crText = (cr: number) => (cr === 0.125 ? '1/8' : cr === 0.25 ? '1/4' : cr === 0.5 ? '1/2' : String(cr));

function monsters(rows: any[]): Term[] {
  return rows.map((m) => {
    const ac = Array.isArray(m.armor_class) ? m.armor_class[0] : m.armor_class;
    const acv = typeof ac === 'object' ? ac?.value : ac;
    const act = (xs: any[] | undefined) => (xs ?? []).map((a) => ({ name: a.name, text: a.desc ?? '' }));
    const speed = Object.entries(m.speed ?? {}).filter(([, v]) => v !== false).map(([k, v]) => (v === true ? k : `${k} ${v}`)).join(', ');
    const saves: Record<string, number> = {}, skills: Record<string, number> = {};
    for (const p of m.proficiencies ?? []) {
      const nm: string = p.proficiency?.name ?? '';
      if (nm.startsWith('Saving Throw: ')) saves[nm.slice(14).toLowerCase()] = p.value;
      else if (nm.startsWith('Skill: ')) skills[nm.slice(7)] = p.value;
    }
    const senses = Object.entries(m.senses ?? {}).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ');
    const data: any = {
      size: m.size, type: m.type, subtype: m.subtype ?? null, alignment: m.alignment, cr: m.challenge_rating, xp: m.xp ?? null,
      ac: acv, acType: ac?.type ?? null, hp: m.hit_points, hitDice: m.hit_points_roll ?? m.hit_dice, speed: m.speed ?? {},
      abilities: { str: m.strength, dex: m.dexterity, con: m.constitution, int: m.intelligence, wis: m.wisdom, cha: m.charisma },
      savingThrows: saves, skills, vulnerabilities: list(m.damage_vulnerabilities), resistances: list(m.damage_resistances),
      immunities: list(m.damage_immunities), conditionImmunities: list(m.condition_immunities), senses: m.senses ?? {}, languages: m.languages ?? '',
      traits: act(m.special_abilities), actions: act(m.actions), bonusActions: act(m.bonus_actions), reactions: act(m.reactions), legendaryActions: act(m.legendary_actions),
    };
    const sect = (title: string, xs: { name: string; text: string }[]) => (xs.length ? `\n\n### ${title}\n\n${xs.map((a) => `**${a.name}.** ${a.text}`).join('\n\n')}` : '');
    const lines = [
      `*${m.size} ${m.type}${m.subtype ? ` (${m.subtype})` : ''}, ${m.alignment}*`,
      `**AC** ${acv}${ac?.type ? ` (${ac.type})` : ''} · **HP** ${m.hit_points}${m.hit_points_roll ? ` (${m.hit_points_roll})` : ''} · **Speed** ${speed}`,
      `| STR | DEX | CON | INT | WIS | CHA |\n|---|---|---|---|---|---|\n| ${ABIL.map(([, k]) => `${m[k]} (${mod(m[k])})`).join(' | ')} |`,
    ];
    const meta: string[] = [];
    const kv = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k.toUpperCase().length <= 3 ? k.toUpperCase() : k} ${v >= 0 ? '+' : ''}${v}`).join(', ');
    if (Object.keys(saves).length) meta.push(`**Saving Throws** ${kv(saves)}`);
    if (Object.keys(skills).length) meta.push(`**Skills** ${kv(skills)}`);
    if (data.vulnerabilities.length) meta.push(`**Vulnerabilities** ${data.vulnerabilities.join(', ')}`);
    if (data.resistances.length) meta.push(`**Resistances** ${data.resistances.join(', ')}`);
    if (data.immunities.length) meta.push(`**Damage Immunities** ${data.immunities.join(', ')}`);
    if (data.conditionImmunities.length) meta.push(`**Condition Immunities** ${data.conditionImmunities.join(', ')}`);
    if (senses) meta.push(`**Senses** ${senses}`);
    if (m.languages) meta.push(`**Languages** ${m.languages}`);
    meta.push(`**CR** ${crText(m.challenge_rating)}${m.xp ? ` (${m.xp.toLocaleString('en-US')} XP)` : ''}`);
    const text = lines.join('\n\n') + '\n\n' + meta.join('  \n') + sect('Traits', data.traits) + sect('Actions', data.actions) + sect('Bonus Actions', data.bonusActions) + sect('Reactions', data.reactions) + sect('Legendary Actions', data.legendaryActions);
    const summary = `${m.size} ${m.type}, ${m.alignment} · CR ${crText(m.challenge_rating)} · AC ${acv} · HP ${m.hit_points} · ${speed}`;
    return mk('monster', m.name, text, { summary: clip(summary, 300), data });
  });
}

// ---- items ---------------------------------------------------------------
function magicItems(rows: any[], y: string): Term[] {
  return rows.filter((x) => !x.variant).map((x) => {
    const d = y === '2014' ? arr(x.desc) : arr(x.desc ?? x.description);
    const rarity = x.rarity?.name ?? '';
    const cat = x.equipment_category?.name ?? '';
    const head = `*${[cat, rarity, x.attunement ? 'requires attunement' : ''].filter(Boolean).join(', ')}*`;
    return mk('item', x.name, `${head}\n\n${d}`.trim(), { summary: clip(`${[cat, rarity].filter(Boolean).join(', ')}. ${summarize(d.split('\n\n').slice(1).join(' ') || d, 200)}`, 300), data: { category: cat, rarity, attunement: !!x.attunement } });
  });
}

function equipment(rows: any[], y: string): Term[] {
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
function classes(rows: any[], y: string): Term[] {
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

function features(rows: any[], y: string): Term[] {
  return rows.map((f) => {
    const cls = refName(f.class);
    const lvl = typeof f.level === 'object' ? f.level?.name : f.level;
    const body = y === '2014' ? descOf(f) : paras(descOf(f));
    const head = `*${cls}${lvl !== undefined && lvl !== null ? ` · ${typeof f.level === 'number' ? `level ${f.level}` : lvl}` : ''}*`;
    return mk('class', f.name, `${head}\n\n${body}`, { summary: clip(`${cls} feature. ${summarize(body, 220)}`, 300), data: { class: cls, level: typeof f.level === 'number' ? f.level : null } });
  }).filter((t) => t.text.length > 20);
}

// ---- assemble --------------------------------------------------------------
async function build(year: '2014' | '2024') {
  const L = async (n: string) => load(year, n);
  const terms: Term[] = [];
  terms.push(...simple('condition', await L('Conditions'), year).map((t) => ({ ...t, summary: '' })));
  terms.push(...spells(await L('Spells'), year));
  terms.push(...monsters(await L('Monsters')));
  const rules = await L('Rules');
  terms.push(...simple('rule', rules, year));
  if (year === '2024') {
    const hand = JSON.parse(fs.readFileSync(path.join(dataDir, 'rules-2024.handwritten.json'), 'utf8')) as Term[];
    terms.push(...hand);
  }
  terms.push(...simple('rule', await L('Weapon-Properties'), year));
  terms.push(...simple('rule', await L('Weapon-Mastery-Properties'), year, (x) => '', (x) => [`${x.name} mastery`]));
  terms.push(...simple('rule', await L('Damage-Types'), year, (x) => '', (x) => [`${x.name} damage`]));
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

const ATTRIBUTION = {
  '2024': 'This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.',
  '2014': 'This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode.',
} as const;

const META = {
  '2024': { id: 'dnd-2024', name: 'D&D 2024 (SRD 5.2)', version: '5.2.1', file: 'srd-2024.json' },
  '2014': { id: 'dnd-2014', name: 'D&D 5e 2014 (SRD 5.1)', version: '5.1', file: 'srd-2014.json' },
} as const;

void NAMES;
fs.mkdirSync(dataDir, { recursive: true });
for (const year of ['2024', '2014'] as const) {
  const m = META[year];
  const terms = await build(year);
  const { module, warnings } = normalizeModule({ id: m.id, name: m.name, version: m.version, license: 'CC-BY-4.0', attribution: ATTRIBUTION[year], terms });
  for (const w of warnings) console.warn(`${year}: ${w}`);
  const out = path.join(dataDir, m.file);
  fs.writeFileSync(out, JSON.stringify(module));
  const kinds: Record<string, number> = {};
  for (const t of module.terms) kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
  console.log(`${m.file}: ${module.terms.length} terms, ${(fs.statSync(out).size / 1e6).toFixed(2)} MB`, kinds);
}
