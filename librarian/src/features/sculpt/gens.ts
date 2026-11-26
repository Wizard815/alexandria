// Generators for {{gen:name ...}} and for fields with a `gen` or `fallback`.
// Everything here is deterministic for a seed and calls no model.
import { genCoins, genItems, genNames } from '../quickgen/api.ts';
import { worldModules } from '../modules/store.ts';
import { dice, int, pick } from '../quickgen/rng.ts';
import type { RenderCtx } from './ctx.ts';
import { makeRng, parseCall, rollText, type Call, type Rng, substitute } from './lang.ts';
import * as T from './tables.ts';

type P = Record<string, string>;
type Gen = (rc: RenderCtx, p: P, r: Rng) => string;

const num = (v: string | undefined, d: number, lo: number, hi: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const bullets = (a: string[]) => a.map((x) => `- ${x}`).join('\n');
const sample = <X,>(r: Rng, a: readonly X[], n: number): X[] => {
  const pool = [...a];
  const out: X[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return out;
};
const pickRow = <X,>(r: Rng, rows: readonly X[]): X => rows[Math.floor(r() * rows.length)];

// ---- people and places ----
const name: Gen = (_rc, p, r) => {
  try {
    const g = genNames({ race: (p.race || 'any').toLowerCase(), gender: (p.gender || 'any').toLowerCase(), count: 1, seed: String(Math.floor(r() * 1e9)), style: p.style });
    return p.part === 'race' ? g.names[0]?.race ?? '' : g.names[0]?.name ?? '';
  } catch { return `${cap(pick(r, T.SETTLEMENT_START).toLowerCase())}${pick(r, T.SETTLEMENT_END)} ${pick(r, T.FACTION_NAME_B).replace(/^the /, '')}`; }
};
const placeName = (r: Rng) => `${pick(r, T.SETTLEMENT_START)}${pick(r, T.SETTLEMENT_END)}`;
const place: Gen = (_rc, p, r) => {
  const k = (p.kind || 'village').toLowerCase();
  if (k === 'tavern' || k === 'inn') return `The ${pick(r, T.TAVERN_A)} ${pick(r, T.TAVERN_B)}`;
  return placeName(r);
};
const settlement: Gen = (_rc, p, r) => {
  const size = (p.size || 'village').toLowerCase();
  const [lo, hi] = T.SETTLE_SIZE[size] ?? T.SETTLE_SIZE.village;
  switch (p.part) {
    case 'name': return placeName(r);
    case 'population': return `about ${Math.round((lo + r() * (hi - lo)) / 10) * 10 || lo}`;
    case 'economy': return pick(r, T.SETTLE_ECON);
    case 'features': return bullets(sample(r, T.SETTLE_FEATURE, 3));
    case 'problem': return cap(pick(r, T.SETTLE_PROBLEM));
    case 'secret': return cap(pick(r, T.SETTLE_SECRET));
    default: return placeName(r);
  }
};
const faction: Gen = (_rc, p, r) => {
  switch (p.part) {
    case 'name': return `${pick(r, T.FACTION_NAME_A)} ${pick(r, T.FACTION_NAME_B)}`;
    case 'goal': return cap(pick(r, T.FACTION_GOAL));
    case 'method': return cap(pick(r, T.FACTION_METHOD));
    case 'resources': return bullets(sample(r, T.FACTION_RESOURCE, 3));
    case 'secret': return cap(pick(r, T.FACTION_SECRET));
    default: return `${pick(r, T.FACTION_NAME_A)} ${pick(r, T.FACTION_NAME_B)}`;
  }
};
const room: Gen = (_rc, p, r) => {
  switch (p.part) {
    case 'purpose': return cap(pick(r, T.ROOM_PURPOSE));
    case 'light': return cap(pick(r, T.ROOM_LIGHT));
    case 'sense': return cap(pick(r, T.ROOM_SENSE));
    case 'exits': return cap(pick(r, T.ROOM_EXITS));
    case 'hazard': return cap(pick(r, T.ROOM_HAZARD));
    case 'secret': return cap(pick(r, T.ROOM_SECRET));
    default: return cap(pick(r, T.ROOM_PURPOSE));
  }
};

// ---- loot ----
const fallbackItems = ['Potion of healing', 'Spell scroll (cantrip)', 'Bag of holding', 'Cloak of protection', 'Driftglobe'];
const priceText = (gp: number | null): string => (gp == null ? 'priceless' : `${gp.toLocaleString('en-US')} gp`);
const item: Gen = (rc, p, r) => {
  try {
    const res = genItems(rc.d.db, rc.worldId, { rarity: (p.rarity || 'any').toLowerCase(), type: (p.type || 'any').toLowerCase(), count: 1, seed: String(Math.floor(r() * 1e9)) });
    const it = res.items[0];
    if (!it) return p.part === 'name' || !p.part ? pick(r, fallbackItems) : '';
    switch (p.part) {
      case 'name': return it.name;
      case 'rarity': return it.rarity;
      case 'type': return it.type;
      case 'price': return priceText(it.priceGp);
      case 'attune': return it.attunement ? 'Requires attunement' : '';
      case 'summary': return it.summary;
      default: return `${it.name} (${it.rarity} ${it.type}, ${priceText(it.priceGp)})`;
    }
  } catch { return p.part && p.part !== 'name' ? '' : pick(r, fallbackItems); }
};
const items: Gen = (rc, p, r) => {
  const level = num(p.level, rc.partyLevel(), 1, 20);
  const n = num(p.count, level >= 11 ? 3 : level >= 5 ? 2 : 1, 1, 10);
  const rarity = p.rarity || (level >= 17 ? 'very rare' : level >= 11 ? 'rare' : level >= 5 ? 'uncommon' : 'common');
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const call = item(rc, { rarity: i === 0 ? rarity : level >= 5 ? 'common' : rarity, type: p.type ?? '' }, r);
    if (call && !lines.includes(call)) lines.push(call);
  }
  return bullets(lines);
};
const coins: Gen = (rc, p, r) => {
  try {
    return genCoins({ mode: (p.mode || 'individual').toLowerCase(), level: p.cr ? undefined : num(p.level, rc.partyLevel(), 1, 20), cr: p.cr || undefined, coins: rc.coinSetting(), seed: String(Math.floor(r() * 1e9)) }).text;
  } catch { return `${pick(r, [5, 10, 25, 50, 100])} gp`; }
};
const valuables: Gen = (rc, p, r) => {
  const n = num(p.count, 2, 1, 6);
  return bullets(sample(r, [...T.GEMS, ...T.ART], n));
};

// ---- encounters ----
interface Mon { name: string; ref: string; cr: number; xp: number; ac: number; hp: number; type: string; dex?: number; env?: string[] }
const monsterCache = new WeakMap<object, Mon[]>();
const FALLBACK_MON: Mon[] = [
  { name: 'Goblin', ref: '', cr: 0.25, xp: 50, ac: 15, hp: 7, type: 'humanoid' }, { name: 'Wolf', ref: '', cr: 0.25, xp: 50, ac: 13, hp: 11, type: 'beast' },
  { name: 'Skeleton', ref: '', cr: 0.25, xp: 50, ac: 14, hp: 13, type: 'undead' }, { name: 'Bandit Captain', ref: '', cr: 2, xp: 450, ac: 15, hp: 65, type: 'humanoid' },
  { name: 'Ogre', ref: '', cr: 2, xp: 450, ac: 11, hp: 59, type: 'giant' }, { name: 'Owlbear', ref: '', cr: 3, xp: 700, ac: 13, hp: 59, type: 'monstrosity' },
  { name: 'Troll', ref: '', cr: 5, xp: 1800, ac: 15, hp: 84, type: 'giant' }, { name: 'Young Green Dragon', ref: '', cr: 8, xp: 3900, ac: 18, hp: 136, type: 'dragon' },
];
export function monstersOf(rc: RenderCtx): Mon[] {
  const wm = worldModules(rc.d.db, rc.worldId);
  const hit = monsterCache.get(wm);
  if (hit) return hit;
  const out: Mon[] = [];
  for (const t of wm.terms) {
    if (t.kind !== 'monster') continue;
    const d: any = t.data;
    if (!d || typeof d !== 'object' || typeof d.cr !== 'number') continue;
    // Habitats from the source; a creature tagged with a dozen or more (every plane) is "anywhere" and goes by type.
    out.push({ name: t.term, ref: t.ref, cr: d.cr, xp: Number(d.xp) || 0, ac: Number(d.ac) || 10, hp: Number(d.hp) || 1, type: String(d.type ?? "").toLowerCase(), dex: Number(d.abilities?.dex) || 10, ...(Array.isArray(d.environments) && d.environments.length && d.environments.length <= 12 ? { env: d.environments.map((e: unknown) => String(e).toLowerCase()) } : {}) });
  }
  out.sort((a, b) => a.xp - b.xp || a.name.localeCompare(b.name));
  monsterCache.set(wm, out);
  return out;
}
export const crText = (cr: number) => (cr === 0.125 ? '1/8' : cr === 0.25 ? '1/4' : cr === 0.5 ? '1/2' : String(cr));
const THRESH: Record<string, number[]> = {
  easy: [25, 50, 75, 125, 250, 300, 350, 450, 550, 600, 800, 1000, 1100, 1250, 1400, 1600, 2000, 2100, 2400, 2800],
  medium: [50, 100, 150, 250, 500, 600, 750, 900, 1100, 1200, 1600, 2000, 2200, 2500, 2800, 3200, 3900, 4200, 4900, 5700],
  hard: [75, 150, 225, 375, 750, 900, 1100, 1400, 1600, 1900, 2400, 3000, 3400, 3800, 4300, 4800, 5900, 6300, 7300, 8500],
  deadly: [100, 200, 400, 500, 1100, 1400, 1700, 2100, 2400, 2800, 3600, 4500, 5100, 5700, 6400, 7200, 8800, 9500, 10900, 12700],
};
export const ENVIRONMENTS: Record<string, string[]> = {
  forest: ['beast', 'plant', 'fey', 'humanoid', 'monstrosity', 'giant'],
  swamp: ['ooze', 'undead', 'beast', 'monstrosity', 'plant', 'humanoid'],
  mountain: ['giant', 'dragon', 'monstrosity', 'beast', 'elemental', 'humanoid'],
  coast: ['beast', 'monstrosity', 'elemental', 'humanoid', 'undead'],
  desert: ['undead', 'beast', 'elemental', 'monstrosity', 'construct', 'humanoid'],
  dungeon: ['undead', 'ooze', 'aberration', 'construct', 'humanoid', 'monstrosity'],
  urban: ['humanoid', 'fiend', 'undead', 'construct', 'beast'],
  underground: ['aberration', 'ooze', 'monstrosity', 'fiend', 'beast', 'humanoid'],
  arctic: ['beast', 'giant', 'elemental', 'undead', 'monstrosity'],
  plains: ['beast', 'humanoid', 'monstrosity', 'giant', 'fey'],
};
/** Habitat names in monster data that count as each environment. */
const ENV_WORDS: Record<string, string[]> = {
  forest: ['forest', 'jungle', 'woodland'], swamp: ['swamp', 'marsh', 'bog'], mountain: ['mountain', 'hill'], coast: ['coast', 'shore', 'sea', 'ocean', 'water'],
  desert: ['desert', 'badlands'], dungeon: ['dungeon', 'ruin', 'tomb', 'lair'], urban: ['urban', 'city', 'settlement', 'sewer'],
  underground: ['underground', 'underdark', 'underworld', 'cave', 'cavern'], arctic: ['arctic', 'tundra', 'polar', 'ice'], plains: ['plain', 'grassland', 'steppe', 'farm'],
};
const encounter: Gen = (rc, p, r) => {
  const level = num(p.level, rc.partyLevel(), 1, 20);
  const size = num(p.size, Number(rc.vars()['party.size']) || 4, 1, 10);
  const diff = THRESH[(p.difficulty || 'medium').toLowerCase()] ? (p.difficulty || 'medium').toLowerCase() : 'medium';
  const budget = size * THRESH[diff][level - 1];
  let all = monstersOf(rc);
  if (!all.length) all = FALLBACK_MON;
  const types = ENVIRONMENTS[(p.env || p.environment || '').toLowerCase()];
  // A monster whose source names its habitats (Open5e books do) goes by those; the rest by creature type.
  const words = ENV_WORDS[(p.env || p.environment || '').toLowerCase()] ?? [];
  let cands = types ? all.filter((m) => (m.env ? m.env.some((e) => words.some((w) => e.includes(w))) : types.includes(m.type) || types.some((t) => m.type.startsWith(t)))) : all;
  if (cands.length < 4) cands = all;
  const groups: { m: Mon; n: number }[] = [];
  let used = 0;
  const shares = r() < 0.5 ? [1] : [0.6, 0.4];
  for (const sh of shares) {
    const share = budget * sh;
    const pool = cands.filter((m) => m.xp > 0 && m.xp <= share && m.xp * 12 >= share && !groups.some((g) => g.m.name === m.name));
    const from = pool.length ? pool : cands.filter((m) => m.xp > 0 && m.xp <= share).slice(-5);
    if (!from.length) continue;
    const m = pickRow(r, from);
    const n = Math.max(1, Math.min(12, Math.floor(share / m.xp)));
    groups.push({ m, n });
    used += m.xp * n;
  }
  if (!groups.length) {
    const m = cands.find((x) => x.xp > 0) ?? all[0];
    groups.push({ m, n: 1 });
    used = m.xp;
  }
  if (p.part === 'title') return `${groups[0].n}× ${groups[0].m.name}${groups.length > 1 ? ` and ${groups[1].m.name}` : ''}`;
  if (p.part === 'xp') return `${diff} for ${size} level ${level} characters: ${used.toLocaleString('en-US')} of ${budget.toLocaleString('en-US')} XP budget`;
  return groups.map((g) => `- ${g.n}× ${g.m.name} (CR ${crText(g.m.cr)}, AC ${g.m.ac}, HP ${g.m.hp})`).join('\n');
};
const tactics: Gen = (_rc, _p, r) => pick(r, T.TACTICS);

// ---- travel, weather, traps, puzzles ----
const rumour: Gen = (_rc, p, r) => {
  const tone = (p.tone || 'mixed').toLowerCase();
  const colour = tone === 'mundane' ? T.RUMOUR_COLOUR_MUNDANE : tone === 'ominous' ? T.RUMOUR_COLOUR_OMINOUS : tone === 'hopeful' ? T.RUMOUR_COLOUR_HOPEFUL : [...T.RUMOUR_COLOUR_MUNDANE, ...T.RUMOUR_COLOUR_OMINOUS, ...T.RUMOUR_COLOUR_HOPEFUL];
  const where = p.place ? ` around ${p.place}` : '';
  return `${cap(pick(r, T.RUMOUR_SUBJECT))} ${pick(r, T.RUMOUR_DEED)}${where}, ${pick(r, colour)}.`;
};
const travel: Gen = (_rc, p, r) => {
  const terrain = (p.terrain || 'any').toLowerCase();
  const pool = T.TRAVEL_EVENTS.filter((e) => e.terrain === terrain || e.terrain === 'any');
  if (p.part === 'check') return pick(r, T.TRAVEL_CHECKS);
  return pickRow(r, pool).text;
};
const seasonKey = (s: string, climate: string): keyof typeof T.WEATHER => {
  const c = climate.toLowerCase();
  if (c === 'cold') return 'winter';
  if (c === 'hot' || c === 'arid') return 'summer';
  const x = s.toLowerCase();
  if (/winter|frost|snow|cold|hearth/.test(x)) return 'winter';
  if (/spring|thaw|bloom|sow|rain/.test(x)) return 'spring';
  if (/summer|sun|high|hot/.test(x)) return 'summer';
  if (/autumn|fall|harvest|leaf|dusk/.test(x)) return 'autumn';
  return 'temperate';
};
const weather: Gen = (rc, p, r) => {
  const key = seasonKey(p.season || rc.season(), p.climate || '');
  const table = T.WEATHER[key];
  const w = pickRow(r, table);
  const effect = pick(r, T.WEATHER_EFFECT);
  if (p.part === 'cond') return w.cond;
  if (p.part === 'temp') return w.temp;
  if (p.part === 'effect') return effect;
  if (p.part === 'forecast') {
    const days: string[] = [];
    let cur = w;
    for (let i = 1; i <= 3; i++) { if (r() < 0.5) cur = pickRow(r, table); days.push(`Day ${i}: ${cur.cond.toLowerCase()}`); }
    return bullets(days);
  }
  return `${w.cond}. Temperature: ${w.temp}. ${effect}`;
};
const trap: Gen = (rc, p, r) => {
  const level = num(p.level, rc.partyLevel(), 1, 20);
  const danger = (p.danger || 'dangerous').toLowerCase();
  const tier = level >= 17 ? 3 : level >= 11 ? 2 : level >= 5 ? 1 : 0;
  const dc = (danger === 'setback' ? [10, 12, 15, 18] : danger === 'deadly' ? [15, 17, 20, 23] : [12, 15, 18, 21])[tier];
  const dmg = (danger === 'setback' ? ['1d10', '2d10', '4d10', '10d10'] : danger === 'deadly' ? ['4d10', '10d10', '18d10', '24d10'] : ['2d10', '4d10', '10d10', '18d10'])[tier];
  const row = Math.floor(r() * T.TRAP_EFFECT.length);
  switch (p.part) {
    case 'name': return cap(T.TRAP_NAME[row]);
    case 'trigger': return cap(T.TRAP_TRIGGER[row % T.TRAP_TRIGGER.length]);
    case 'effect': return cap(T.TRAP_EFFECT[row]);
    case 'detect': return `DC ${dc} Wisdom (Perception) or Intelligence (Investigation): ${pick(r, T.TRAP_DETECT)}.`;
    case 'disarm': return `DC ${dc} Dexterity (thieves' tools): ${pick(r, T.TRAP_DISARM)}.`;
    case 'damage': return `${rollText(dmg, r)} damage, Dexterity save DC ${dc} for half.`;
    case 'dc': return String(dc);
    default: return cap(T.TRAP_EFFECT[row]);
  }
};
const puzzle: Gen = (_rc, p, r) => {
  if ((p.kind || 'riddle').toLowerCase() === 'riddle') {
    const x = pickRow(r, T.RIDDLES);
    return p.part === 'name' ? 'The riddle' : p.part === 'solution' ? x.a : p.part === 'hint' ? x.hint : p.part === 'fail' ? 'Nothing happens, and whatever was listening grows impatient.' : x.q;
  }
  const x = pickRow(r, T.PUZZLE_MECH);
  return p.part === 'name' ? x.name : p.part === 'solution' ? x.solution : p.part === 'fail' ? x.fail : p.part === 'hint' ? 'A scratch, mural or inscription nearby shows the intended order.' : x.text;
};
const riddle: Gen = (_rc, p, r) => { const x = pickRow(r, T.RIDDLES); return p.part === 'a' ? x.a : p.part === 'hint' ? x.hint : x.q; };

// ---- speech and handouts ----
const bark: Gen = (_rc, p, r) => {
  const pool = T.BARKS[(p.mood || 'neutral').toLowerCase()] ?? T.BARKS.neutral;
  return bullets(sample(r, pool, num(p.count, 3, 1, 6)).map((l) => `"${l}"`));
};
const letter: Gen = (_rc, p, r) => {
  switch (p.part) {
    case 'open': return pick(r, T.LETTER_OPEN);
    case 'close': return pick(r, T.LETTER_CLOSE);
    default: return `${pick(r, T.LETTER_OPEN)}\n\n${pick(r, T.LETTER_BODY)}\n\n${pick(r, T.LETTER_CLOSE)}`;
  }
};
const monologue: Gen = (_rc, p, r) => {
  const open = T.MONOLOGUE_OPEN[(p.situation || 'revealed').toLowerCase()] ?? T.MONOLOGUE_OPEN.revealed;
  if (p.part === 'tells') return bullets(sample(r, T.MONOLOGUE_TELL, 2));
  return `${pick(r, open)} ${pick(r, T.MONOLOGUE_MID)}`;
};
const checklist: Gen = (_rc, _p, r) => bullets(sample(r, T.SESSION_CHECKLIST, 6));
const prepScenes: Gen = (_rc, _p, r) => bullets(sample(r, T.PREP_SCENE, 3));
const level: Gen = (rc) => String(rc.partyLevel());
const location: Gen = (rc) => rc.vars().location ?? '';
const treasure: Gen = (rc, p, r) => {
  const lv = num(p.level, rc.partyLevel(), 1, 20);
  const lines = [coins(rc, { mode: p.mode || 'individual', level: String(lv) }, r)];
  const it = item(rc, { rarity: lv >= 11 ? 'uncommon' : 'common' }, r);
  if (it) lines.push(it);
  return bullets(lines);
};
const names: Gen = (_rc, p, r) => {
  const n = num(p.count, 3, 1, 10);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    try { const g = genNames({ race: p.race || 'any', gender: 'any', count: 1, seed: String(Math.floor(r() * 1e9)) }).names[0]; if (g) out.push(`${g.name} (${g.race})`); } catch { /* skip */ }
  }
  return bullets(out);
};
const truth: Gen = (_rc, p, r) => {
  const n = p.die === 'd20' ? 20 : 6;
  const rows = Array.from({ length: n }, (_x, i) => i + 1);
  const t = sample(r, rows, Math.max(1, Math.round(n / 4))).sort((a, b) => a - b);
  const h = sample(r, rows.filter((x) => !t.includes(x)), Math.max(1, Math.round(n / 6))).sort((a, b) => a - b);
  return `True: ${t.join(', ')}. Half-true: ${h.join(', ')}. The rest are false or exaggerated.`;
};
const party: Gen = (rc) => rc.vars()['party.names'];
const season: Gen = (rc) => rc.season();
const date: Gen = (rc) => rc.vars()['world.date'] ?? '';
const clock: Gen = date;

export const GENERATORS: Record<string, Gen> = {
  name, place, settlement, faction, room, item, items, coins, valuables, encounter, tactics, rumour, travel, weather, trap, riddle, puzzle, bark, letter, monologue,
  checklist, scenes: prepScenes, party, season, date, clock, level, location, treasure, names, truth,
};

/** Run one parsed call. `scope` makes the seed for this spot; `sk` shares a seed between calls. */
export function runCall(rc: RenderCtx | null, call: Call, base: string, scope: string, get: (n: string) => string): string {
  try {
    if (call.kind === 'dice') return rollText(substitute(call.name, get), makeRng(`${base}|${scope}`));
    if (call.kind === 'pick') {
      const opts = substitute(call.name, get).split('|').map((s) => s.trim()).filter(Boolean);
      return opts.length ? pick(makeRng(`${base}|${scope}`), opts) : '';
    }
    const g = GENERATORS[call.name];
    if (!rc) return "";
    if (!g) return '';
    const p: P = {};
    for (const [k, v] of Object.entries(call.params)) p[k] = substitute(v, get).trim();
    return g(rc, p, makeRng(p.sk ? `${base}|sk:${p.sk}` : `${base}|${scope}`));
  } catch { return ''; }
}

/** Run a field's `gen`/`fallback` expression ("gen:coins level=$level", "dice:1d6", "pick:a|b"). */
export function runExpr(rc: RenderCtx, expr: string, base: string, scope: string, get: (n: string) => string): string {
  const call = parseCall(expr.trim().replace(/^\{\{|\}\}$/g, ''));
  return call ? runCall(rc, call, base, scope, get) : '';
}
export const isExpr = (s: string | undefined): s is string => !!s && /^(gen|dice|pick):/.test(s.trim());
export const gensKnown = (name: string) => name in GENERATORS;
void dice; void int;
