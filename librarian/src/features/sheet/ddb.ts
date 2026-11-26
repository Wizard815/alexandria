// Importing a character from D&D Beyond. There is no official D&D Beyond API:
// this reads the same character JSON the D&D Beyond site itself loads
// (character-service.dndbeyond.com, public characters only). It can change or
// stop working at any time without notice, so every screen that offers it
// says so, and a player can paste the JSON by hand when the fetch fails.
//
// What comes in is reduced to a small summary (the Character module) plus
// numbers the sheet already keeps elsewhere: HP, temporary HP and conditions
// (sheets), class, level and ability scores (the spells feature's sheet).
import { HttpError } from '../../core/util.ts';

export const DDB_WARNING = 'D&D Beyond has no official API. This import reads the character data the D&D Beyond site uses for itself, so it can break or change without notice. Check the numbers after importing.';
const HOST = 'https://character-service.dndbeyond.com/character/v5/character/';
const MAX_BYTES = 6_000_000;
const TIMEOUT_MS = 15_000;

const ABIL = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
type Ab = (typeof ABIL)[number];
const ABIL_NAME: Record<Ab, string> = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' };
// D&D Beyond's condition ids (1 to 15, alphabetical as in the rules).
const CONDITION = ['Blinded', 'Charmed', 'Deafened', 'Exhaustion', 'Frightened', 'Grappled', 'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious'];
const ALIGNMENT = ['', 'Lawful Good', 'Neutral Good', 'Chaotic Good', 'Lawful Neutral', 'True Neutral', 'Chaotic Neutral', 'Lawful Evil', 'Neutral Evil', 'Chaotic Evil'];
const SKILLS = ['acrobatics', 'animal-handling', 'arcana', 'athletics', 'deception', 'history', 'insight', 'intimidation', 'investigation', 'medicine', 'nature', 'perception', 'performance', 'persuasion', 'religion', 'sleight-of-hand', 'stealth', 'survival'];
const COINS = ['pp', 'gp', 'ep', 'sp', 'cp'] as const;

// The standard multiclass spellcaster table (caster level 1-20 -> slots of levels 1-9).
const FULL_SLOTS: number[][] = [
  [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1],
];
const RESET: Record<number, string> = { 1: 'short rest', 2: 'long rest', 3: 'dawn', 4: 'other' };
// Class features every character has, which only clutter a short list.
const DULL_FEATURES = /^(hit points|proficiencies|ability score improvement|equipment|spellcasting|core .* traits|subclass feature|.* subclass|epic boon|weapon mastery)$/i;

export interface DdbClass { name: string; subclass: string; level: number }
export interface DdbCharacter {
  source: 'dndbeyond';
  ddbId: string;
  url: string;
  importedAt: string;
  name: string;
  race: string;
  background: string;
  alignment: string;
  classes: DdbClass[];
  level: number;
  abilities: Record<Ab, number>;
  castingAbility: '' | 'int' | 'wis' | 'cha';
  hp: { max: number; now: number; temp: number };
  ac: number | null;
  speed: number | null;
  prof: number;
  saves: Ab[];
  skills: { name: string; expertise: boolean }[];
  languages: string[];
  feats: string[];
  spells: { name: string; level: number }[];
  items: { name: string; qty: number; equipped: boolean }[];
  coins: Partial<Record<(typeof COINS)[number], number>>;
  conditions: string[];
  initiative: number;
  passivePerception: number;
  inspiration: boolean;
  hitDice: { die: number; total: number; used: number }[];
  /** Spell slots by spell level 1-9 (index 0 = level 1); pact magic separately. */
  slots: { level: number; max: number; used: number }[];
  pact: { level: number; max: number; used: number } | null;
  attacks: { name: string; hit: number; damage: string; range: string }[];
  features: { name: string; from: string }[];
  /** Abilities with a number of uses (Rage, Ki, Channel Divinity...). */
  uses: { name: string; max: number; used: number; reset: string }[];
  traits: { personality: string; ideals: string; bonds: string; flaws: string; backstory: string };
}

/** The character id in a D&D Beyond link (or a bare id), or null. */
export function ddbCharacterId(input: unknown): string | null {
  const s = String(input ?? '').trim();
  if (/^\d{3,12}$/.test(s)) return s;
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (!/(^|\.)dndbeyond\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/\/characters?\/(?:v\d+\/character\/)?(\d{3,12})(?:\/|$)/i);
  return m ? m[1] : null;
}

/** Fetches a public character's JSON from D&D Beyond. Errors say what to do next. */
export async function fetchDdb(fetcher: typeof fetch, ddbId: string): Promise<unknown> {
  if (!/^\d{3,12}$/.test(ddbId)) throw new HttpError(400, 'That is not a D&D Beyond character link');
  let r: Response;
  try {
    r = await fetcher(HOST + ddbId, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  } catch {
    throw new HttpError(502, 'Could not reach D&D Beyond. Try again, or paste the character JSON instead.');
  }
  if (r.status === 401 || r.status === 403) throw new HttpError(403, 'D&D Beyond says this character is private. On D&D Beyond, open the character, go to Home > Character Settings and set Character Privacy to Public, then try again.');
  if (r.status === 404) throw new HttpError(404, 'D&D Beyond has no character with that link. Check the link, or make the character public.');
  if (!r.ok) throw new HttpError(502, `D&D Beyond answered ${r.status}. The unofficial character link may have changed; paste the character JSON instead.`);
  const len = Number(r.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new HttpError(502, 'That character is too large to import');
  const text = await r.text();
  if (text.length > MAX_BYTES) throw new HttpError(502, 'That character is too large to import');
  try { return JSON.parse(text); } catch { throw new HttpError(502, 'D&D Beyond did not send character data. The unofficial character link may have changed; paste the character JSON instead.'); }
}

const str = (v: unknown, max = 80) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const int = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : null;
};
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const mod = (score: number) => Math.floor((score - 10) / 2);
const uniq = (xs: string[]) => { const seen = new Set<string>(); return xs.filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())); };

/**
 * Reduces D&D Beyond's character JSON to what the sheet uses. It is careful
 * with every field: the format is not documented and can change, so anything
 * missing becomes empty rather than failing the whole import.
 */
export function mapDdb(raw: unknown, url = ''): DdbCharacter {
  const root: any = raw && typeof raw === 'object' ? raw : null;
  if (root && root.success === false) throw new HttpError(400, str(root.message, 200) || 'D&D Beyond sent an error instead of a character');
  const c: any = root?.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data : root;
  if (!c || typeof c !== 'object' || !('stats' in c || 'classes' in c || 'name' in c)) throw new HttpError(400, 'That does not look like a D&D Beyond character');

  const mods: any[] = c.modifiers && typeof c.modifiers === 'object' ? Object.values(c.modifiers).flatMap(arr) : [];
  const has = (type: string, sub: string) => mods.some((m) => m?.type === type && m?.subType === sub);
  const sum = (type: string, sub: string) => mods.filter((m) => m?.type === type && m?.subType === sub).reduce((n, m) => n + (int(m?.value, -99, 99) ?? 0), 0);

  // Ability scores: base, racial and other bonuses, "set" items (Gauntlets of Ogre Power), then any override.
  const byId = (list: unknown, i: number) => int(arr(list).find((x) => x?.id === i + 1)?.value, 0, 99);
  const abilities = {} as Record<Ab, number>;
  ABIL.forEach((k, i) => {
    let v = (byId(c.stats, i) ?? 10) + (byId(c.bonusStats, i) ?? 0) + sum('bonus', `${ABIL_NAME[k]}-score`);
    const set = mods.filter((m) => m?.type === 'set' && m?.subType === `${ABIL_NAME[k]}-score`).map((m) => int(m?.value, 1, 30) ?? 0);
    if (set.length) v = Math.max(v, ...set);
    const over = byId(c.overrideStats, i);
    abilities[k] = Math.max(1, Math.min(30, over ?? v));
  });

  const classes: DdbClass[] = arr(c.classes).map((k) => ({ name: str(k?.definition?.name, 40), subclass: str(k?.subclassDefinition?.name, 60), level: int(k?.level, 1, 20) ?? 1 }))
    .filter((k) => k.name).slice(0, 6);
  const level = Math.max(1, Math.min(20, classes.reduce((n, k) => n + k.level, 0) || 1));
  const castId = arr(c.classes).map((k) => int(k?.definition?.spellCastingAbilityId, 0, 6)).find((x) => x && x >= 4);
  const castingAbility = (castId ? ABIL[castId - 1] : '') as DdbCharacter['castingAbility'];

  // HP: D&D Beyond keeps the rolled/average base, adds Constitution per level and per-level bonuses (Tough), unless overridden.
  const perLevel = sum('bonus', 'hit-points-per-level');
  const calcMax = (int(c.baseHitPoints, 0, 9999) ?? 0) + (int(c.bonusHitPoints, -999, 9999) ?? 0) + (mod(abilities.con) + perLevel) * level;
  const max = Math.max(1, int(c.overrideHitPoints, 1, 99999) ?? calcMax);
  const now = Math.max(0, max - (int(c.removedHitPoints, 0, 99999) ?? 0));
  const temp = int(c.temporaryHitPoints, 0, 99999) ?? 0;

  const prof = Math.ceil(level / 4) + 1;
  const saves = ABIL.filter((k) => has('proficiency', `${ABIL_NAME[k]}-saving-throws`));
  const skills = SKILLS.filter((s) => has('proficiency', s) || has('expertise', s))
    .map((s) => ({ name: s.split('-').map((w) => (w === 'of' ? w : w[0].toUpperCase() + w.slice(1))).join(' '), expertise: has('expertise', s) }));
  const languages = uniq(mods.filter((m) => m?.type === 'language').map((m) => str(m?.friendlySubtypeName, 40))).slice(0, 20);
  const feats = uniq(arr(c.feats).map((f) => str(f?.definition?.name, 60))).slice(0, 30);

  const spellLists = [...arr(c.classSpells).flatMap((k) => arr(k?.spells)), ...(c.spells && typeof c.spells === 'object' ? Object.values(c.spells).flatMap(arr) : [])];
  const spells: { name: string; level: number }[] = [];
  for (const s of spellLists) {
    const name = str(s?.definition?.name, 80);
    if (name && !spells.some((x) => x.name.toLowerCase() === name.toLowerCase())) spells.push({ name, level: int(s?.definition?.level, 0, 9) ?? 0 });
  }
  spells.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

  const inv = arr(c.inventory);
  const items = inv.map((it) => ({ name: str(it?.definition?.name, 120), qty: int(it?.quantity, 0, 1_000_000) ?? 1, equipped: it?.equipped === true })).filter((it) => it.name).slice(0, 200);

  // Armour class, as an estimate: worn armour (or 10) with the Dexterity its type allows, a shield, and flat bonuses.
  const dex = mod(abilities.dex);
  const worn = inv.filter((it) => it?.equipped === true && it?.definition && int(it.definition.armorClass, 0, 30) !== null);
  const armour = worn.find((it) => [1, 2, 3].includes(it.definition.armorTypeId));
  const shield = worn.find((it) => it.definition.armorTypeId === 4);
  let ac: number | null = null;
  if (c.stats) {
    const t = armour?.definition.armorTypeId;
    const base = armour ? int(armour.definition.armorClass, 0, 30)! : 10;
    ac = base + (t === 3 ? 0 : t === 2 ? Math.min(dex, 2) : dex);
    if (!armour) ac += Math.max(0, ...mods.filter((m) => m?.type === 'set' && m?.subType === 'unarmored-armor-class').map((m) => int(m?.value, 0, 10) ?? 0), sumAbilityAc(mods, abilities));
    if (shield) ac += int(shield.definition.armorClass, 0, 10) ?? 2;
    ac += sum('bonus', 'armor-class');
    const over = arr(c.characterValues).find((v) => v?.typeId === 1 && v?.value !== null && v?.value !== undefined);
    if (over) ac = int(over.value, 0, 50) ?? ac;
  }
  const walk = int(c.race?.weightSpeeds?.normal?.walk, 0, 200);
  const speed = walk === null ? null : walk + sum('bonus', 'speed');

  const coins: DdbCharacter['coins'] = {};
  for (const k of COINS) { const n = int(c.currencies?.[k], 0, 1e9); if (n) coins[k] = n; }
  const conditions = arr(c.conditions).map((x) => {
    const n = CONDITION[(int(x?.id, 0, 99) ?? 0) - 1];
    return n === 'Exhaustion' && int(x?.level, 1, 10) ? `Exhaustion ${int(x.level, 1, 10)}` : n;
  }).filter((x): x is string => !!x);


  // Initiative and passive Perception.
  const initiative = dex + sum('bonus', 'initiative');
  const percProf = has('expertise', 'perception') ? 2 * prof : has('proficiency', 'perception') ? prof : 0;
  const passivePerception = 10 + mod(abilities.wis) + percProf + sum('bonus', 'passive-perception');

  const hitDice = arr(c.classes).map((k) => ({ die: int(k?.definition?.hitDice, 4, 12) ?? 8, total: int(k?.level, 1, 20) ?? 1, used: int(k?.hitDiceUsed, 0, 20) ?? 0 }));

  // Spell slots: D&D Beyond works them out in the browser, so they come from each class's own table (one caster)
  // or the multiclass table (caster levels added up); the JSON only says how many are used.
  const casters = arr(c.classes).filter((k) => k?.definition?.canCastSpells !== false && Array.isArray(k?.definition?.spellRules?.levelSpellSlots) && String(k?.definition?.name).toLowerCase() !== 'warlock');
  let table: number[] = [];
  if (casters.length === 1) {
    table = arr(casters[0].definition.spellRules.levelSpellSlots[int(casters[0].level, 1, 20) ?? 1]).map((n) => int(n, 0, 9) ?? 0);
  } else if (casters.length > 1) {
    const lvl = casters.reduce((n, k) => {
      const div = int(k.definition.spellRules.multiClassSpellSlotDivisor, 1, 3) ?? 1;
      const up = k.definition.spellRules.multiClassSpellSlotRounding === 2;
      const l = (int(k.level, 1, 20) ?? 1) / div;
      return n + (up ? Math.ceil(l) : Math.floor(l));
    }, 0);
    table = lvl > 0 ? FULL_SLOTS[Math.min(20, lvl) - 1] : [];
  }
  const usedAt = (list: unknown, l: number) => int(arr(list).find((x) => x?.level === l)?.used, 0, 9) ?? 0;
  const slots = table.map((max, i) => ({ level: i + 1, max, used: Math.min(max, usedAt(c.spellSlots, i + 1)) })).filter((x) => x.max > 0);
  const lock = arr(c.classes).find((k) => String(k?.definition?.name).toLowerCase() === 'warlock');
  let pact: DdbCharacter['pact'] = null;
  if (lock) {
    const row = arr(arr(lock.definition?.spellRules?.levelSpellSlots)[int(lock.level, 1, 20) ?? 1]).map((n) => int(n, 0, 9) ?? 0);
    const at = row.findIndex((n, i) => n > 0 && row.slice(i + 1).every((m) => !m));
    if (at >= 0) pact = { level: at + 1, max: row[at], used: Math.min(row[at], usedAt(c.pactMagic, at + 1)) };
  }

  // Attacks with worn weapons, as an estimate: proficient, Strength (Dexterity for ranged or the better with finesse).
  const attacks: DdbCharacter['attacks'] = [];
  for (const it of inv) {
    const def = it?.definition;
    if (!it?.equipped || def?.filterType !== 'Weapon') continue;
    const finesse = arr(def.properties).some((p) => /finesse/i.test(String(p?.name)));
    const ranged = def.attackType === 2;
    const ab = ranged ? dex : finesse ? Math.max(dex, mod(abilities.str)) : mod(abilities.str);
    const magic = arr(def.grantedModifiers).filter((m) => m?.type === 'bonus' && m?.subType === 'magic').reduce((n, m) => n + (int(m?.value, 0, 5) ?? 0), 0);
    const dice = str(def.damage?.diceString, 20);
    const dmg = dice ? `${dice}${ab + magic ? (ab + magic > 0 ? ` + ${ab + magic}` : ` - ${-(ab + magic)}`) : ''}${def.damageType ? ` ${String(def.damageType).toLowerCase()}` : ''}` : '';
    const range = def.range ? `${int(def.range, 0, 2000)}${def.longRange ? `/${int(def.longRange, 0, 2000)}` : ''} ft` : '';
    attacks.push({ name: str(def.name, 60), hit: prof + ab + magic, damage: dmg, range });
    if (attacks.length >= 12) break;
  }

  // Features: class features up to the class level, racial traits and feats.
  const features: DdbCharacter['features'] = [];
  const addF = (name: string, from: string) => { if (name && !DULL_FEATURES.test(name) && !features.some((f) => f.name.toLowerCase() === name.toLowerCase())) features.push({ name, from }); };
  for (const k of arr(c.classes)) {
    const lvl = int(k?.level, 1, 20) ?? 1;
    for (const f of [...arr(k?.classFeatures), ...arr(k?.subclassDefinition?.classFeatures)]) {
      const d = f?.definition ?? f;
      if ((int(d?.requiredLevel, 1, 20) ?? 1) <= lvl) addF(str(d?.name, 60), str(k?.definition?.name, 40));
    }
  }
  for (const t of arr(c.race?.racialTraits)) addF(str(t?.definition?.name, 60), str(c.race?.baseName, 40) || 'Species');

  // Limited uses: D&D Beyond's actions with a use count. A count of 0 with "uses = proficiency" or an ability gets that number.
  const uses: DdbCharacter['uses'] = [];
  const allActions = c.actions && typeof c.actions === 'object' ? Object.values(c.actions).flatMap(arr) : [];
  for (const a of allActions) {
    const lu = a?.limitedUse;
    if (!lu) continue;
    let mx = int(lu.maxUses, 0, 99) ?? 0;
    if (lu.useProficiencyBonus) mx += prof * (int(lu.proficiencyBonusOperator, 0, 3) === 2 ? 0 : 1);
    const stat = int(lu.statModifierUsesId, 0, 6);
    if (stat) mx += Math.max(1, mod(abilities[ABIL[stat - 1]]));
    const name = str(a?.name, 40);
    if (!name || mx < 1 || uses.some((u) => u.name.toLowerCase() === name.toLowerCase())) continue;
    uses.push({ name, max: mx, used: Math.min(mx, int(lu.numberUsed, 0, 99) ?? 0), reset: RESET[int(lu.resetType, 0, 9) ?? 0] ?? '' });
    if (uses.length >= 20) break;
  }

  const traits = {
    personality: str(c.traits?.personalityTraits, 600), ideals: str(c.traits?.ideals, 400), bonds: str(c.traits?.bonds, 400), flaws: str(c.traits?.flaws, 400),
    backstory: typeof c.notes?.backstory === 'string' ? c.notes.backstory.trim().slice(0, 3000) : '',
  };

  const ddbId = String(int(c.id, 0, 1e12) ?? '');
  return {
    source: 'dndbeyond',
    ddbId,
    url: str(c.readonlyUrl, 300) || url || (ddbId ? `https://www.dndbeyond.com/characters/${ddbId}` : ''),
    importedAt: new Date().toISOString(),
    name: str(c.name, 80) || 'Unnamed character',
    race: str(c.race?.fullName, 60) || str(c.race?.baseName, 60),
    background: str(c.background?.definition?.name, 60),
    alignment: ALIGNMENT[int(c.alignmentId, 0, 9) ?? 0] ?? '',
    classes, level, abilities, castingAbility,
    hp: { max, now, temp }, ac, speed, prof, saves, skills, languages, feats,
    spells: spells.slice(0, 300), items, coins, conditions,
    initiative, passivePerception, inspiration: c.inspiration === true, hitDice, slots, pact, attacks: attacks.slice(0, 12), features: features.slice(0, 60), uses, traits,
  };
}

/** Unarmoured Defence (barbarian Con, monk Wis): the extra ability modifier D&D Beyond lists as an "ignore"-style set. */
function sumAbilityAc(mods: any[], ab: Record<Ab, number>): number {
  let best = 0;
  for (const m of mods) {
    if (m?.type !== 'set' || m?.subType !== 'unarmored-armor-class' || m?.statId === null || m?.statId === undefined) continue;
    const k = ABIL[(int(m.statId, 1, 6) ?? 0) - 1];
    if (k) best = Math.max(best, mod(ab[k]));
  }
  return best;
}

/**
 * Checks the Character module's data when a player saves their sheet layout:
 * the same shape as an import, with every field bounded, so a hand-made save
 * cannot store anything else.
 */
export function cleanCharacter(d: any): DdbCharacter | Record<string, never> {
  if (!d || typeof d !== 'object' || d.source !== 'dndbeyond') return {};
  const ab = {} as Record<Ab, number>;
  for (const k of ABIL) ab[k] = int(d.abilities?.[k], 1, 30) ?? 10;
  const cast = ['int', 'wis', 'cha'].includes(d.castingAbility) ? d.castingAbility : '';
  const url = str(d.url, 300);
  const coins: DdbCharacter['coins'] = {};
  for (const k of COINS) { const n = int(d.coins?.[k], 0, 1e9); if (n) coins[k] = n; }
  return {
    source: 'dndbeyond',
    ddbId: /^\d{1,12}$/.test(String(d.ddbId ?? '')) ? String(d.ddbId) : '',
    url: /^https:\/\/([\w-]+\.)*dndbeyond\.com\//i.test(url) ? url : '',
    importedAt: str(d.importedAt, 40),
    name: str(d.name, 80), race: str(d.race, 60), background: str(d.background, 60), alignment: str(d.alignment, 30),
    classes: arr(d.classes).slice(0, 6).map((k) => ({ name: str(k?.name, 40), subclass: str(k?.subclass, 60), level: int(k?.level, 1, 20) ?? 1 })),
    level: int(d.level, 1, 20) ?? 1,
    abilities: ab, castingAbility: cast,
    hp: { max: int(d.hp?.max, 0, 99999) ?? 0, now: int(d.hp?.now, 0, 99999) ?? 0, temp: int(d.hp?.temp, 0, 99999) ?? 0 },
    ac: int(d.ac, 0, 50), speed: int(d.speed, 0, 400), prof: int(d.prof, 0, 10) ?? 2,
    saves: ABIL.filter((k) => arr(d.saves).includes(k)),
    skills: arr(d.skills).slice(0, 30).map((s) => ({ name: str(s?.name, 40), expertise: s?.expertise === true })).filter((s) => s.name),
    languages: arr(d.languages).slice(0, 20).map((x) => str(x, 40)).filter(Boolean),
    feats: arr(d.feats).slice(0, 30).map((x) => str(x, 60)).filter(Boolean),
    spells: arr(d.spells).slice(0, 300).map((s) => ({ name: str(s?.name, 80), level: int(s?.level, 0, 9) ?? 0 })).filter((s) => s.name),
    items: arr(d.items).slice(0, 200).map((it) => ({ name: str(it?.name, 120), qty: int(it?.qty, 0, 1_000_000) ?? 1, equipped: it?.equipped === true })).filter((it) => it.name),
    coins,
    conditions: arr(d.conditions).slice(0, 20).map((x) => str(x, 40)).filter(Boolean),
    initiative: int(d.initiative, -20, 40) ?? 0,
    passivePerception: int(d.passivePerception, 0, 60) ?? 10,
    inspiration: d.inspiration === true,
    hitDice: arr(d.hitDice).slice(0, 6).map((h) => ({ die: int(h?.die, 4, 12) ?? 8, total: int(h?.total, 1, 20) ?? 1, used: int(h?.used, 0, 20) ?? 0 })),
    slots: arr(d.slots).slice(0, 9).map((x) => ({ level: int(x?.level, 1, 9) ?? 1, max: int(x?.max, 0, 9) ?? 0, used: int(x?.used, 0, 9) ?? 0 })),
    pact: d.pact && typeof d.pact === 'object' ? { level: int(d.pact.level, 1, 9) ?? 1, max: int(d.pact.max, 0, 9) ?? 0, used: int(d.pact.used, 0, 9) ?? 0 } : null,
    attacks: arr(d.attacks).slice(0, 12).map((a) => ({ name: str(a?.name, 60), hit: int(a?.hit, -10, 40) ?? 0, damage: str(a?.damage, 60), range: str(a?.range, 30) })).filter((a) => a.name),
    features: arr(d.features).slice(0, 60).map((f) => ({ name: str(f?.name, 60), from: str(f?.from, 40) })).filter((f) => f.name),
    uses: arr(d.uses).slice(0, 20).map((u) => ({ name: str(u?.name, 40), max: int(u?.max, 1, 99) ?? 1, used: int(u?.used, 0, 99) ?? 0, reset: str(u?.reset, 20) })).filter((u) => u.name),
    traits: { personality: str(d.traits?.personality, 600), ideals: str(d.traits?.ideals, 400), bonds: str(d.traits?.bonds, 400), flaws: str(d.traits?.flaws, 400), backstory: typeof d.traits?.backstory === 'string' ? d.traits.backstory.slice(0, 3000) : '' },
  };
}
