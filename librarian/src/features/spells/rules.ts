// The spell rules engine (Spell_Plan.md, step 1): every number the plan names
// as a per-world setting, with the plan's numbers as defaults, and pure
// formulas over them. No database here: the routes and the UI feed it a
// character's state and show what it returns.
//
// - Pools and highest spell level per caster type (full, half, third, none)
//   and for multiclass characters.
// - Casting: upcasting with a surcharge, one leveled spell per turn, surge
//   cast, echo strain, the once-per-long-rest limit on high spells,
//   overchannel and low mana.
// - Dual cast: empower and fuse, the Arcana check, what unlocks it, and the
//   study point a successful fuse banks toward a recipe.
// - Learning: tier gates, ability minimums, level and pool requirements, study
//   points, progress per day, materials, the graded final check and the
//   shortcuts (level-up insight, a memory of learning, scroll).
// - Spell lines: mastery per line (gifts count or not) and hybrid spells.
//
// The world stores only what it changes (`spellRules`, a partial object);
// `resolveRules` lays it over the defaults.

export type CasterType = 'full' | 'half' | 'third' | 'none';
export const CASTER_TYPES: readonly CasterType[] = ['full', 'half', 'third', 'none'];
export type StudySource = 'alone' | 'text' | 'mentor';
export const STUDY_SOURCES: readonly StudySource[] = ['alone', 'text', 'mentor'];

/** The plan's cost table: cantrip, then 1st to 9th. The live table is the `spellManaCosts` setting. */
export const PLAN_COSTS = [0, 2, 3, 5, 6, 7, 9, 11, 13, 15];

export interface TierGate {
  /** How many recipe spells the character must know (the tier minimum). */
  known: number;
  /** Where they come from: cantrips, the level just below, or any level. */
  from: 'cantrip' | 'below' | 'any';
  /** An Arcana check (DC = the final check's DC) before study may start. */
  arcanaCheck: boolean;
  /** Study sources allowed at this level. */
  sources: StudySource[];
  /** Only a research project the DM approved (or a gift) teaches it. */
  researchOnly: boolean;
}

export interface SpellRules {
  /** Mana pool by character level 1 to 20, per caster type. */
  pools: Record<CasterType, number[]>;
  /** Extra mana per spell level raised when upcasting (0 turns it off). */
  upcastSurcharge: number;
  /** One leveled spell per turn (cantrips are free of this). */
  oneLeveledPerTurn: boolean;
  /** A second leveled spell in a turn: cost ×multiplier, CON save DC base + spell level, fatigue on a failure, once per short rest. */
  surge: { on: boolean; costMultiplier: number; dcBase: number; fatigue: number };
  /** Each repeat of the same leveled spell before a short rest costs `step` more per repeat. */
  echoStrain: { on: boolean; step: number };
  /** Spells of `fromLevel` and up: once per long rest each. */
  highLevelLimit: { on: boolean; fromLevel: number };
  /** Go below 0 mana down to minus the character level; CON save DC base + mana short; fatigue on a failure. */
  overchannel: { on: boolean; dcBase: number; fatigue: number };
  /** Below this share of the pool: disadvantage on concentration saves. */
  lowMana: { on: boolean; belowPct: number };
  dualCast: {
    on: boolean;
    /** What unlocks it: the Dual cast ability (the DM grants it per character; nothing in play gives it yet), or a character level. */
    unlock: 'ability' | 'level';
    level: number;
    empowerMultiplier: number;
    empowerLevels: number;
    fuseMultiplier: number;
    dcBase: number;
    /** On a failed Arcana check the mana is spent and the next roll takes this penalty. */
    failPenalty: number;
    /** A successful fuse of two recipe spells banks this many study points (up to half the recipe) and reveals it. */
    insightPoints: number;
  };
  learning: {
    /** Study points = ceil(C² ÷ pointsDivisor) × hybrid × (1 − discount), C = the spell's mana cost (a cantrip counts as 1). */
    pointsDivisor: number;
    hybridMultiplier: number;
    discountPerExtraSpell: number;
    maxDiscount: number;
    /** Study points per 8-hour day. */
    rates: Record<StudySource, number>;
    labBonus: number;
    /** Share of the study points taken off a spell on the character's own class list (0 turns it off). Any class may study any spell. */
    classDiscount: number;
    /** Materials = materialsPerC2 × C² coin; a mentor charges mentorFeeMultiplier × that again. */
    materialsPerC2: number;
    mentorFeeMultiplier: number;
    /** Final check DC by spell level (cantrip to 9th). */
    checkDC: number[];
    greatMargin: number;
    greatRefund: number;
    setbackMargin: number;
    setbackProgressLoss: number;
    setbackFatigue: number;
    /** Share of the materials lost on an ordinary failure and on a setback (fail by the margin or a natural 1). */
    failCoinLoss: number;
    setbackCoinLoss: number;
    /** Minimum casting ability score by spell level (cantrip to 9th). */
    abilityMin: number[];
    /** The pool must hold at least this many times the spell's cast cost. */
    poolMultiple: number;
    /** The caster type must reach the spell's level. */
    levelGate: boolean;
    gates: TierGate[];
    levelUpInsightBank: number;
    /** A memory of learning a spell (taken whole, e.g. by a memory spell): learn it at once. With `save` on, a WIS save first. */
    memory: { save: boolean; dcBase: number; dcPerLevel: number; bankOnFail: number; exhaustion: number };
    /** A scroll is a study aid, never the spell itself: decoding it adds study points; the spell is still studied and checked. */
    scroll: { hoursPerLevel: number; bank: number };
  };
  lines: { giftsCountForMastery: boolean; hybridMastery: number };
  /** Non-casters with gifted leveled spells: casts of each per long rest (cantrips are at will). */
  giftedLeveledPerLongRest: number;
  /** Mana potions, Common to Legendary. */
  potions: number[];
}

const gate = (known: number, from: TierGate['from'], arcanaCheck: boolean, sources: StudySource[], researchOnly = false): TierGate => ({ known, from, arcanaCheck, sources, researchOnly });

export const DEFAULT_SPELL_RULES: SpellRules = {
  pools: {
    full: [4, 6, 14, 17, 27, 32, 38, 44, 57, 64, 73, 77, 84, 88, 97, 101, 112, 119, 128, 139],
    half: [4, 5, 6, 8, 14, 15, 17, 19, 27, 28, 32, 34, 38, 40, 44, 46, 57, 58, 64, 66],
    third: [0, 0, 4, 5, 6, 7, 14, 15, 16, 17, 18, 19, 27, 28, 29, 32, 33, 34, 38, 40],
    none: Array(20).fill(0),
  },
  upcastSurcharge: 1,
  oneLeveledPerTurn: true,
  surge: { on: true, costMultiplier: 2, dcBase: 10, fatigue: 1 },
  echoStrain: { on: true, step: 1 },
  highLevelLimit: { on: true, fromLevel: 6 },
  overchannel: { on: true, dcBase: 10, fatigue: 1 },
  lowMana: { on: false, belowPct: 25 },
  dualCast: { on: true, unlock: 'ability', level: 5, empowerMultiplier: 2, empowerLevels: 2, fuseMultiplier: 1.5, dcBase: 10, failPenalty: 2, insightPoints: 1 },
  learning: {
    pointsDivisor: 2,
    hybridMultiplier: 1.25,
    discountPerExtraSpell: 0.1,
    maxDiscount: 0.2,
    rates: { alone: 1, text: 2, mentor: 3 },
    labBonus: 1,
    classDiscount: 0.25,
    materialsPerC2: 10,
    mentorFeeMultiplier: 1,
    checkDC: [10, 13, 13, 15, 15, 18, 18, 22, 22, 22],
    greatMargin: 10,
    greatRefund: 0.5,
    setbackMargin: 10,
    setbackProgressLoss: 0.25,
    setbackFatigue: 1,
    failCoinLoss: 0,
    setbackCoinLoss: 0,
    abilityMin: [0, 12, 12, 13, 13, 15, 15, 17, 17, 18],
    poolMultiple: 2,
    levelGate: true,
    gates: [
      gate(0, 'any', false, ['alone', 'text', 'mentor']),
      gate(2, 'cantrip', false, ['alone', 'text', 'mentor']),
      gate(2, 'below', false, ['alone', 'text', 'mentor']),
      gate(2, 'below', false, ['alone', 'text', 'mentor']),
      gate(2, 'below', true, ['alone', 'text', 'mentor']),
      gate(2, 'below', true, ['alone', 'text', 'mentor']),
      gate(3, 'below', false, ['text', 'mentor']),
      gate(3, 'below', false, ['text', 'mentor']),
      gate(3, 'below', false, ['text', 'mentor'], true),
      gate(3, 'below', false, ['text', 'mentor'], true),
    ],
    levelUpInsightBank: 0.5,
    memory: { save: false, dcBase: 10, dcPerLevel: 2, bankOnFail: 0.25, exhaustion: 1 },
    scroll: { hoursPerLevel: 1, bank: 0.25 },
  },
  lines: { giftsCountForMastery: true, hybridMastery: 2 },
  giftedLeveledPerLongRest: 1,
  potions: [10, 25, 50, 75, 100],
};

// ---- the setting: a partial object laid over the defaults ------------------------------------------------

const ENUMS: Record<string, readonly string[]> = { 'dualCast.unlock': ['ability', 'level'], 'learning.gates.from': ['cantrip', 'below', 'any'] };
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Check `v` against the shape of `def`; throws a plain reason naming the key. Numbers are 0 to 100000. */
function checkShape(v: unknown, def: unknown, key: string, enumKey: string): void {
  if (Array.isArray(def)) {
    if (!Array.isArray(v)) throw new Error(`spellRules.${key} must be a list`);
    if (key.endsWith('sources')) {
      if (!v.length || !v.every((x) => (STUDY_SOURCES as readonly string[]).includes(x as string))) throw new Error(`spellRules.${key} must list some of ${STUDY_SOURCES.join(', ')}`);
      return;
    }
    if (v.length !== def.length) throw new Error(`spellRules.${key} must have ${def.length} entries`);
    v.forEach((x, i) => checkShape(x, def[i], `${key}.${i}`, enumKey));
    return;
  }
  if (isPlain(def)) {
    if (!isPlain(v)) throw new Error(`spellRules.${key} must be an object`);
    for (const [k, x] of Object.entries(v)) {
      if (!(k in def)) throw new Error(`Unknown spell rule: ${key}.${k}`.slice(0, 120));
      checkShape(x, def[k], `${key}.${k}`, `${enumKey}.${k}`);
    }
    return;
  }
  if (typeof def === 'boolean') { if (typeof v !== 'boolean') throw new Error(`spellRules.${key} must be true or false`); return; }
  if (typeof def === 'number') { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100000) throw new Error(`spellRules.${key} must be a number from 0 to 100000`); return; }
  if (typeof def === 'string') {
    const allowed = ENUMS[enumKey.replace(/^\./, '')];
    if (typeof v !== 'string' || (allowed && !allowed.includes(v))) throw new Error(`spellRules.${key} must be one of ${allowed?.join(', ') ?? 'text'}`);
  }
}

/** Validate the `spellRules` setting: any part of the rules, every key known, every value the right kind. */
export function checkSpellRules(v: unknown): void {
  if (!isPlain(v)) throw new Error('spellRules must be an object');
  for (const [k, x] of Object.entries(v)) {
    if (!(k in DEFAULT_SPELL_RULES)) throw new Error(`Unknown spell rule: ${k}`.slice(0, 120));
    checkShape(x, (DEFAULT_SPELL_RULES as any)[k], k, k);
  }
}

const merge = (def: any, over: any): any => {
  if (!isPlain(def) || !isPlain(over)) return over === undefined ? structuredClone(def) : structuredClone(over);
  const out: any = {};
  for (const k of Object.keys(def)) out[k] = k in over ? merge(def[k], over[k]) : structuredClone(def[k]);
  return out;
};

/** The world's rules: its stored changes over the defaults. A list (a table, the gates) is replaced whole, except gates merge per level. */
export function resolveRules(stored: unknown): SpellRules {
  if (!isPlain(stored)) return structuredClone(DEFAULT_SPELL_RULES);
  const r = merge(DEFAULT_SPELL_RULES, stored) as SpellRules;
  const g = (stored as any).learning?.gates;
  if (Array.isArray(g)) r.learning.gates = DEFAULT_SPELL_RULES.learning.gates.map((d, i) => merge(d, g[i] ?? {}));
  return r;
}

// ---- pools and spell levels ------------------------------------------------------------------------------

const lv20 = (level: number) => Math.max(1, Math.min(20, Math.floor(level)));

/** Caster levels for a multiclass character: full + half ÷ 2 + third ÷ 3, each rounded down. */
export function casterLevel(levels: Partial<Record<CasterType, number>>): number {
  return Math.min(20, (levels.full ?? 0) + Math.floor((levels.half ?? 0) / 2) + Math.floor((levels.third ?? 0) / 3));
}

/** The pool of one caster type at a character level. */
export function poolFor(type: CasterType, level: number, r: SpellRules): number {
  if (!level || level < 1) return 0;
  return r.pools[type][lv20(level) - 1] ?? 0;
}

/**
 * The pool of a character with levels in several caster types: a single
 * caster type uses its own table; more than one uses the full table at the
 * combined caster level (the plan's multiclass rule).
 */
export function multiclassPool(levels: Partial<Record<CasterType, number>>, r: SpellRules): number {
  const types = (['full', 'half', 'third'] as const).filter((t) => (levels[t] ?? 0) > 0);
  if (types.length === 0) return 0;
  if (types.length === 1) return poolFor(types[0], levels[types[0]]!, r);
  const cl = casterLevel(levels);
  return cl > 0 ? poolFor('full', cl, r) : 0;
}

const HALF_STEPS = [1, 5, 9, 13, 17];
const THIRD_STEPS = [3, 7, 13, 19];

/** The highest spell level a caster type may cast at a character level (0: none). */
export function highestSpellLevel(type: CasterType, level: number): number {
  if (!level || level < 1) return 0;
  const l = lv20(level);
  if (type === 'full') return Math.min(9, Math.ceil(l / 2));
  if (type === 'half') return HALF_STEPS.filter((x) => l >= x).length;
  if (type === 'third') return THIRD_STEPS.filter((x) => l >= x).length;
  return 0;
}

/** The highest spell level of a multiclass character: the full table at the combined caster level, or a single type's own. */
export function multiclassHighest(levels: Partial<Record<CasterType, number>>): number {
  const types = (['full', 'half', 'third'] as const).filter((t) => (levels[t] ?? 0) > 0);
  if (types.length === 0) return 0;
  if (types.length === 1) return highestSpellLevel(types[0], levels[types[0]]!);
  return highestSpellLevel('full', casterLevel(levels));
}

// ---- casting -----------------------------------------------------------------------------------------------

/** Cost at a cast level: the table's cost at that level plus the surcharge per level raised. */
export function upcastCost(spellLevel: number, castLevel: number, costs: number[], r: Pick<SpellRules, 'upcastSurcharge'>, own?: number | null): number {
  const at = Math.max(spellLevel, Math.min(9, castLevel));
  const raised = at - spellLevel;
  const base = own === null || own === undefined ? costs[at] ?? 0 : own + Math.max(0, (costs[at] ?? 0) - (costs[spellLevel] ?? 0));
  return base + r.upcastSurcharge * raised;
}

export interface CastState {
  /** Mana now and the pool's maximum. */
  mana: number;
  max: number;
  characterLevel: number;
  /** Leveled spells already cast this turn (a dual cast counts as one). */
  leveledThisTurn: number;
  /** A surge cast was used since the last short rest. */
  surgeUsed: boolean;
  /** Times this spell was cast at a level since the last short rest. */
  echoCount: number;
  /** This spell (6th level and up) was cast since the last long rest. */
  highUsed: boolean;
}

export interface Save { ability: 'con' | 'wis' | 'int'; dc: number; why: string; onFail: string }

export interface CastQuote {
  allowed: boolean;
  cost: number;
  castLevel: number;
  /** Each line of the cost, in order, for the cast panel. */
  breakdown: { what: string; mana: number }[];
  reasons: string[];
  saves: Save[];
  surge: boolean;
  manaAfter: number;
  /** Disadvantage on concentration saves after this cast (low mana rule). */
  lowMana: boolean;
}

/**
 * What a cast costs and whether it may happen. Cantrips cost the table's
 * cantrip cost and ignore the per-turn, echo and high-level rules.
 */
export function quoteCast(spell: { level: number; manaCost?: number | null }, castLevel: number, st: CastState, costs: number[], r: SpellRules): CastQuote {
  const at = Math.max(spell.level, Math.min(9, castLevel));
  const breakdown: CastQuote['breakdown'] = [];
  const reasons: string[] = [];
  const saves: Save[] = [];
  const base = upcastCost(spell.level, at, costs, { upcastSurcharge: 0 }, spell.manaCost);
  breakdown.push({ what: at > spell.level ? `Cast at level ${at}` : spell.level ? `Level ${spell.level}` : 'Cantrip', mana: base });
  const surcharge = r.upcastSurcharge * (at - spell.level);
  if (surcharge) breakdown.push({ what: `Upcast +${r.upcastSurcharge} per level raised`, mana: surcharge });
  let cost = base + surcharge;
  let surge = false;
  if (spell.level > 0) {
    if (r.echoStrain.on && st.echoCount > 0) { const e = r.echoStrain.step * st.echoCount; breakdown.push({ what: `Echo strain (cast ${st.echoCount} time${st.echoCount === 1 ? '' : 's'} since a short rest)`, mana: e }); cost += e; }
    if (r.oneLeveledPerTurn && st.leveledThisTurn >= 1) {
      if (!r.surge.on) reasons.push('One leveled spell per turn');
      else if (st.surgeUsed || st.leveledThisTurn >= 2) reasons.push('Surge cast is used up until a short rest');
      else {
        surge = true;
        const extra = Math.ceil(cost * r.surge.costMultiplier) - cost;
        breakdown.push({ what: `Surge cast ×${r.surge.costMultiplier}`, mana: extra });
        cost += extra;
        saves.push({ ability: 'con', dc: r.surge.dcBase + spell.level, why: 'Surge cast', onFail: `${r.surge.fatigue} fatigue` });
      }
    }
    if (r.highLevelLimit.on && at >= r.highLevelLimit.fromLevel && st.highUsed) reasons.push(`Spells of level ${r.highLevelLimit.fromLevel} and up: once per long rest each`);
  }
  const after = st.mana - cost;
  if (after < 0) {
    if (!r.overchannel.on) reasons.push(`Not enough mana (needs ${cost}, has ${st.mana})`);
    else if (after < -Math.max(0, st.characterLevel)) reasons.push(`Overchannel goes down to -${Math.max(0, st.characterLevel)} only`);
    else saves.push({ ability: 'con', dc: r.overchannel.dcBase + Math.min(cost - Math.max(0, st.mana), cost), why: 'Overchannel', onFail: `${r.overchannel.fatigue} fatigue` });
  }
  const lowMana = r.lowMana.on && st.max > 0 && after < (st.max * r.lowMana.belowPct) / 100;
  return { allowed: reasons.length === 0, cost, castLevel: at, breakdown, reasons, saves, surge, manaAfter: after, lowMana };
}

// ---- dual cast ---------------------------------------------------------------------------------------------

export interface DualQuote { allowed: boolean; reasons: string[]; cost: number; dc: number; effectiveLevel: number | null; concentration: boolean }

/** May this character dual cast at all: they have the Dual cast ability, or (when the world unlocks it by level) reached the level. */
export function dualCastUnlocked(characterLevel: number, hasAbility: boolean, r: SpellRules): boolean {
  if (!r.dualCast.on) return false;
  return r.dualCast.unlock === 'ability' ? hasAbility : characterLevel >= r.dualCast.level;
}

/**
 * Empower (the same spell twice: ×2 mana, counts as cast 2 levels higher) or
 * fuse (two different spells: both costs ×1.5, at most one concentration).
 * Costs come from `upcastCost` at each spell's own level. The Arcana check DC
 * is the base plus both spell levels.
 */
export function quoteDual(
  a: { id: string; level: number; manaCost?: number | null; concentration?: boolean },
  b: { id: string; level: number; manaCost?: number | null; concentration?: boolean },
  ctx: { characterLevel: number; hasAbility: boolean; usedSinceShortRest: boolean; penalty: number },
  costs: number[],
  r: SpellRules,
): DualQuote {
  const reasons: string[] = [];
  if (!r.dualCast.on) reasons.push('Dual cast is off in this world');
  else if (!dualCastUnlocked(ctx.characterLevel, ctx.hasAbility, r)) reasons.push(r.dualCast.unlock === 'ability' ? 'Dual cast needs the Dual cast ability' : `Dual cast opens at character level ${r.dualCast.level}`);
  if (ctx.usedSinceShortRest) reasons.push('Dual cast is used up until a short rest');
  const ca = upcastCost(a.level, a.level, costs, r, a.manaCost), cb = upcastCost(b.level, b.level, costs, r, b.manaCost);
  const dc = r.dualCast.dcBase + a.level + b.level + Math.max(0, ctx.penalty);
  if (a.id === b.id) {
    return { allowed: reasons.length === 0, reasons, cost: Math.ceil(ca * r.dualCast.empowerMultiplier), dc, effectiveLevel: a.level + r.dualCast.empowerLevels, concentration: !!a.concentration };
  }
  if (a.concentration && b.concentration) reasons.push('At most one of the two spells may need concentration');
  return { allowed: reasons.length === 0, reasons, cost: Math.ceil((ca + cb) * r.dualCast.fuseMultiplier), dc, effectiveLevel: null, concentration: !!(a.concentration || b.concentration) };
}

/**
 * Learning in play: a successful fuse of two spells that are both parts of a
 * recipe banks study points toward it, never past half of what it needs, and
 * reveals the recipe. Returns the new banked total (unchanged when it does not apply).
 */
export function fuseInsight(recipePrereqs: string[], a: string, b: string, banked: number, needed: number, r: SpellRules): { banked: number; reveal: boolean } {
  if (a === b || !recipePrereqs.includes(a) || !recipePrereqs.includes(b)) return { banked, reveal: false };
  const cap = Math.floor(needed / 2);
  return { banked: Math.max(banked, Math.min(cap, banked + r.dualCast.insightPoints)), reveal: true };
}

// ---- learning ----------------------------------------------------------------------------------------------

/** Complexity: the spell's mana cost at its own level, a cantrip counting as 1. */
export const complexity = (level: number, costs: number[], own?: number | null): number => Math.max(1, own ?? costs[level] ?? 0);

/** Study points a spell needs. `extraSpells` = recipe spells beyond the tier minimum. */
export function studyPoints(c: number, opts: { hybrid?: boolean; extraSpells?: number; ownClass?: boolean }, r: SpellRules): number {
  const L = r.learning;
  const discount = Math.min(L.maxDiscount, Math.max(0, opts.extraSpells ?? 0) * L.discountPerExtraSpell);
  const own = opts.ownClass ? 1 - Math.min(0.9, Math.max(0, L.classDiscount ?? 0)) : 1;
  return Math.max(1, Math.ceil(Math.ceil((c * c) / L.pointsDivisor) * (opts.hybrid ? L.hybridMultiplier : 1) * (1 - discount) * own - 1e-9));
}

/** Progress per 8-hour day from a study source, with or without a lab. */
export const dailyProgress = (source: StudySource, lab: boolean, r: SpellRules): number => r.learning.rates[source] + (lab ? r.learning.labBonus : 0);

/** Days to finish from `banked` points. */
export const studyDays = (needed: number, banked: number, perDay: number): number => (perDay > 0 ? Math.ceil(Math.max(0, needed - banked) / perDay) : Infinity);

/** Materials and the mentor's fee, in coin. */
export function studyCoin(c: number, source: StudySource, r: SpellRules): { materials: number; mentorFee: number } {
  const materials = r.learning.materialsPerC2 * c * c;
  return { materials, mentorFee: source === 'mentor' ? Math.round(materials * r.learning.mentorFeeMultiplier) : 0 };
}

export const finalCheckDC = (spellLevel: number, r: SpellRules): number => r.learning.checkDC[Math.max(0, Math.min(9, spellLevel))];

export type CheckOutcome = 'great' | 'success' | 'fail' | 'setback';

export interface CheckResult {
  outcome: CheckOutcome;
  learned: boolean;
  total: number;
  dc: number;
  /** Study points after the check. */
  banked: number;
  /** Coin back (great success) or lost (failures), as a positive number each. */
  refund: number;
  coinLost: number;
  fatigue: number;
}

/**
 * The final check: d20 + casting modifier + proficiency against the DC. Beat
 * it by the margin: learned with part of the materials back. Meet it:
 * learned. Miss it: progress kept, try after a long rest. Miss by the margin
 * or a natural 1: lose part of the progress and gain fatigue.
 */
export function gradeFinalCheck(d20: number, bonus: number, spellLevel: number, banked: number, materials: number, r: SpellRules): CheckResult {
  const L = r.learning;
  const dc = finalCheckDC(spellLevel, r);
  const total = d20 + bonus;
  if (d20 !== 1 && total >= dc + L.greatMargin) return { outcome: 'great', learned: true, total, dc, banked, refund: Math.floor(materials * L.greatRefund), coinLost: 0, fatigue: 0 };
  if (d20 !== 1 && total >= dc) return { outcome: 'success', learned: true, total, dc, banked, refund: 0, coinLost: 0, fatigue: 0 };
  if (d20 === 1 || total <= dc - L.setbackMargin) {
    return { outcome: 'setback', learned: false, total, dc, banked: Math.max(0, Math.ceil(banked * (1 - L.setbackProgressLoss) - 1e-9)), refund: 0, coinLost: Math.floor(materials * L.setbackCoinLoss), fatigue: L.setbackFatigue };
  }
  return { outcome: 'fail', learned: false, total, dc, banked, refund: 0, coinLost: Math.floor(materials * L.failCoinLoss), fatigue: 0 };
}

/** Level-up insight: a free attempt; on a failure, bank this share of the study. */
export const levelUpInsightBank = (needed: number, banked: number, r: SpellRules): number => Math.min(needed, Math.max(banked, Math.floor(needed * r.learning.levelUpInsightBank)));

/**
 * A full memory of learning a spell: the character learns it at once. With
 * `memory.save` on (off by default), a WIS save DC base + per level × spell
 * level first; a failure banks a share of the study and gives exhaustion.
 */
export function memoryLearn(spellLevel: number, saveTotal: number | null, needed: number, banked: number, r: SpellRules): { learned: boolean; dc: number | null; banked: number; exhaustion: number } {
  const R = r.learning.memory;
  if (!R.save) return { learned: true, dc: null, banked, exhaustion: 0 };
  const dc = R.dcBase + R.dcPerLevel * spellLevel;
  if (saveTotal !== null && saveTotal >= dc) return { learned: true, dc, banked, exhaustion: 0 };
  return { learned: false, dc, banked: Math.min(needed, banked + Math.floor(needed * R.bankOnFail)), exhaustion: R.exhaustion };
}

/** A scroll: hours to decode, and the study points using it up adds. It never teaches the spell by itself. */
export function scroll(spellLevel: number, needed: number, r: SpellRules): { hours: number; points: number } {
  return { hours: Math.max(1, spellLevel) * r.learning.scroll.hoursPerLevel, points: Math.floor(needed * r.learning.scroll.bank) };
}

export type LearnMissing =
  | { kind: 'gate'; need: number; from: TierGate['from']; have: number }
  | { kind: 'arcana'; dc: number }
  | { kind: 'ability'; need: number; have: number | null }
  | { kind: 'level'; spellLevel: number; highest: number }
  | { kind: 'pool'; need: number; have: number }
  | { kind: 'source'; allowed: StudySource[] }
  | { kind: 'research' }
  | { kind: 'mastery'; line: string; need: number; have: number };

export interface LearnInput {
  spellLevel: number;
  /** The spell's cast cost at its own level (for the pool requirement). */
  castCost: number;
  /** Levels of the recipe spells the character knows. */
  knownRecipeLevels: number[];
  /** Highest spell level the character may cast (from their caster type). */
  highest: number;
  casterLevel: number;
  abilityScore: number | null;
  poolMax: number;
  source: StudySource;
  /** The DM approved a research project for this spell. */
  research: boolean;
  /** The character passed the Arcana check this gate asks for. */
  arcanaPassed: boolean;
  /** For a hybrid spell: mastery the character has in each of its lines. */
  hybridMastery?: Record<string, number>;
}

/** Everything the plan's requirement table asks, as a list of what is missing (empty: may start studying). */
export function learnGates(x: LearnInput, r: SpellRules): LearnMissing[] {
  const L = r.learning;
  const g = L.gates[Math.max(0, Math.min(9, x.spellLevel))];
  const out: LearnMissing[] = [];
  const counted = x.knownRecipeLevels.filter((l) => (g.from === 'cantrip' ? l === 0 : g.from === 'below' ? l === x.spellLevel - 1 : true)).length;
  if (counted < g.known) out.push({ kind: 'gate', need: g.known, from: g.from, have: counted });
  if (g.arcanaCheck && !x.arcanaPassed) out.push({ kind: 'arcana', dc: finalCheckDC(x.spellLevel, r) });
  const min = L.abilityMin[Math.max(0, Math.min(9, x.spellLevel))];
  if (min > 0 && (x.abilityScore === null || x.abilityScore < min)) out.push({ kind: 'ability', need: min, have: x.abilityScore });
  if (L.levelGate && x.spellLevel > 0 && x.highest < x.spellLevel) out.push({ kind: 'level', spellLevel: x.spellLevel, highest: x.highest });
  if (L.poolMultiple > 0 && x.poolMax < L.poolMultiple * x.castCost) out.push({ kind: 'pool', need: L.poolMultiple * x.castCost, have: x.poolMax });
  if (g.researchOnly && !x.research) out.push({ kind: 'research' });
  if (!g.sources.includes(x.source)) out.push({ kind: 'source', allowed: g.sources });
  for (const [line, have] of Object.entries(x.hybridMastery ?? {})) if (have < r.lines.hybridMastery) out.push({ kind: 'mastery', line, need: r.lines.hybridMastery, have });
  return out;
}

/** Recipe spells beyond the tier minimum, for the study discount. */
export const extraRecipeSpells = (recipeSize: number, spellLevel: number, r: SpellRules): number => Math.max(0, recipeSize - r.learning.gates[Math.max(0, Math.min(9, spellLevel))].known);

// ---- spell lines -------------------------------------------------------------------------------------------

/** Mastery per line: how many known spells are in it. Gifted spells count unless the world says no. */
export function lineMastery(known: { id: string; how: string }[], linesOf: (id: string) => string[], r: SpellRules): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of known) {
    if (k.how === 'gift' && !r.lines.giftsCountForMastery) continue;
    for (const line of linesOf(k.id)) out[line] = (out[line] ?? 0) + 1;
  }
  return out;
}

/** A spell in two or more lines is a hybrid: it needs mastery in each and costs more study. */
export const isHybrid = (lines: string[]): boolean => new Set(lines).size >= 2;

// ---- preview tables for Settings → Spell rules -----------------------------------------------------------

export interface RulesPreview {
  pools: Record<CasterType, number[]>;
  highest: Record<CasterType, number[]>;
  costs: number[];
  study: { level: number; complexity: number; points: number; days: Record<StudySource, number | null>; materials: number; dc: number; researchOnly: boolean }[];
}

/** The live preview: pools and highest level per character level, and time and cost per spell level and source. */
export function preview(costs: number[], r: SpellRules): RulesPreview {
  const levels = Array.from({ length: 20 }, (_, i) => i + 1);
  const highest = Object.fromEntries(CASTER_TYPES.map((t) => [t, levels.map((l) => highestSpellLevel(t, l))])) as Record<CasterType, number[]>;
  const study = Array.from({ length: 10 }, (_, level) => {
    const c = complexity(level, costs);
    const points = studyPoints(c, {}, r);
    const g = r.learning.gates[level];
    const days = Object.fromEntries(STUDY_SOURCES.map((s) => [s, g.sources.includes(s) ? studyDays(points, 0, dailyProgress(s, false, r)) : null])) as Record<StudySource, number | null>;
    return { level, complexity: c, points, days, materials: studyCoin(c, 'alone', r).materials, dc: finalCheckDC(level, r), researchOnly: g.researchOnly };
  });
  return { pools: structuredClone(r.pools), highest, costs: [...costs], study };
}
