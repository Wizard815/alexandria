// Monster generator. A statblock in the format Combat already reads (agent/
// statblock.ts), built either from a game-module monster (reskinned and
// retuned to the target CR) or from the CR math in cr.ts and a per-type
// archetype. Types: dragon, undead, fiend, aberration, beast, construct,
// elemental, fey. Presets: by type, boss (legendary and lair actions), low CR,
// random, homebrew from a concept. Deterministic for a seed; no model needed.
import { chance, int, makeRng, pick, seedOf, type Rng } from '../quickgen/rng.ts';
import { isOffensive } from '../quickgen/names.ts';
import type { Feature, Statblock } from '../agent/statblock.ts';
import { normalizeStatblock } from '../agent/statblock.ts';
import { CR_STEPS, crForParty, crLabel, crRow, parseCr, profFor, type CrRow } from './cr.ts';

export const MONSTER_TYPES = ['dragon', 'undead', 'fiend', 'aberration', 'beast', 'construct', 'elemental', 'fey'] as const;
export type MonsterType = (typeof MONSTER_TYPES)[number];
export const MONSTER_PRESETS = ['dragon', 'undead', 'demon', 'aberration', 'beast', 'construct', 'elemental', 'fey', 'boss', 'low-cr', 'random', 'homebrew'] as const;
const ELEMENTS = ['fire', 'cold', 'lightning', 'acid', 'poison', 'necrotic', 'radiant', 'psychic', 'thunder', 'force'] as const;
type Element = (typeof ELEMENTS)[number];

/** A monster from an imported game module, as the route passes it in. */
export interface PoolMonster { ref: string; name: string; data: any; moduleName: string; attribution: string }
export interface MonsterOpts {
  preset?: string; type?: string; cr?: number | string; partyLevel?: number; partySize?: number; boss?: boolean;
  concept?: string; name?: string; seed?: string | number;
  /** auto: a module monster when one fits, else the built-in math. module: only the module. builtin: only the math. */
  base?: string;
  pool?: PoolMonster[];
}
export interface MonsterResult {
  seed: string; preset: string; type: string; cr: number; crLabel: string; boss: boolean;
  source: { kind: 'builtin' | 'module'; ref?: string; title?: string; module?: string; attribution?: string };
  statblock: Statblock; lair: string[]; tactics: string; description: string; table: CrRow; notes: string[];
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const mod = (score: number) => Math.floor((score - 10) / 2);
const score = (m: number) => Math.max(1, Math.min(30, 10 + 2 * m));
const signed = (n: number) => (n >= 0 ? `+${n}` : String(n));
const tier = (cr: number) => (cr < 1 ? 0 : cr < 4 ? 1 : cr < 8 ? 2 : cr < 13 ? 3 : cr < 20 ? 4 : 5);

/** "13 (2d8 + 4)": a damage figure close to `avg` using dice of `sides` and a flat bonus. */
function dmg(avg: number, flat: number, sides: number): { avg: number; text: string } {
  const per = (sides + 1) / 2;
  const n = Math.max(1, Math.round((avg - flat) / per));
  const add = Math.round(avg - n * per);
  const total = Math.max(1, Math.floor(n * per + add));
  return { avg: total, text: `${total} (${n}d${sides}${add ? ` ${add > 0 ? '+' : '-'} ${Math.abs(add)}` : ''})` };
}

interface Arch {
  type: string;
  /** names by CR tier (0 = under CR 1, up to 5 = CR 20+) */
  bases: string[][];
  adjs: string[];
  sizes: string[]; // by tier
  primary: 'str' | 'dex' | 'int' | 'wis' | 'cha';
  speed: (t: number, r: Rng) => Record<string, string>;
  senses: Record<string, string>;
  languages: string;
  alignment: string;
  acType: string; acAdj: number;
  attacks: { name: string; kind: 'melee' | 'ranged'; type: string; reach?: string }[];
  traits: Feature[];
  resist: string[]; immune: string[]; condImmune: string[]; vuln: string[];
  /** The signature action; `d` is its damage figure and `dc` the save DC. */
  special: (o: { dc: number; avg: number; sides: number; el: Element; size: string; r: Rng }) => Feature;
  bonus?: Feature[]; reactions?: Feature[];
  lair: string[]; legend: (o: { dc: number }) => Feature[];
  tactics: string[];
}

const ELEMENT_NOUN: Record<Element, string> = { fire: 'flame', cold: 'frost', lightning: 'lightning', acid: 'acid', poison: 'venom', necrotic: 'rot', radiant: 'light', psychic: 'mind', thunder: 'thunder', force: 'force' };
const ELEMENT_ADJ: Record<Element, string[]> = { fire: ['Ember', 'Cinder', 'Ash', 'Scorch'], cold: ['Frost', 'Rime', 'Winter', 'Glacial'], lightning: ['Storm', 'Thunder', 'Static', 'Tempest'], acid: ['Caustic', 'Corroded', 'Vitriol', 'Pitted'], poison: ['Venom', 'Blight', 'Toxic', 'Gall'], necrotic: ['Grave', 'Gloom', 'Bone', 'Rot'], radiant: ['Dawn', 'Gilded', 'Halo', 'Bright'], psychic: ['Mind', 'Dream', 'Hollow', 'Whisper'], thunder: ['Roar', 'Peal', 'Drum', 'Quake'], force: ['Void', 'Pale', 'Still', 'Anvil'] };
const LEGEND_LEAD = 'Immediately after another creature\'s turn, the creature can expend a use to take one of the actions below. It regains all expended uses at the start of its turn. Uses: 3 (4 in its lair).';
const legendResistance: Feature = { name: 'Legendary Resistance (3/Day)', text: 'If the creature fails a saving throw, it can choose to succeed instead.' };
const sizeNote = (size: string) => (size === 'Gargantuan' ? '90-foot Line' : size === 'Huge' ? '60-foot Cone' : size === 'Large' ? '30-foot Cone' : '15-foot Cone');

const ARCHS: Record<MonsterType, Arch> = {
  dragon: {
    type: 'dragon',
    bases: [['Wyrmling'], ['Drake', 'Young Wyrm'], ['Young Dragon'], ['Dragon'], ['Elder Dragon'], ['Ancient Wyrm']],
    adjs: [],
    sizes: ['Medium', 'Large', 'Large', 'Huge', 'Huge', 'Gargantuan'],
    primary: 'str',
    speed: (t) => ({ walk: '40 ft.', fly: `${60 + t * 10} ft.`, ...(t > 1 ? { climb: '40 ft.' } : {}) }),
    senses: { darkvision: '120 ft.', blindsight: '30 ft.' },
    languages: 'Common, Draconic', alignment: 'chaotic evil', acType: 'natural armor', acAdj: 1,
    attacks: [{ name: 'Rend', kind: 'melee', type: 'Slashing', reach: '10 ft.' }, { name: 'Tail', kind: 'melee', type: 'Bludgeoning', reach: '15 ft.' }],
    traits: [{ name: 'Frightful Presence', text: 'Each creature of the dragon\'s choice within 120 feet that can see it must succeed on a Wisdom saving throw or have the Frightened condition for 1 minute (repeating the save at the end of each of its turns).' }],
    resist: [], immune: [], condImmune: [], vuln: [],
    special: ({ dc, avg, sides, el, size }) => ({ name: 'Breath Weapon (Recharge 5-6)', text: `Dexterity Saving Throw: DC ${dc}, each creature in a ${sizeNote(size)}. Failure: ${dmg(avg, 0, sides).text} ${cap(el)} damage. Success: Half damage.` }),
    reactions: [], lair: ['The lair floor splits and a gout of {el} erupts at a point on the ground the dragon can see: Dexterity save or take damage and be knocked prone.', 'A wave of {el}-tinged fog fills a 20-foot-radius sphere, lightly obscuring it until the next lair action.', 'The walls shudder; a 10-foot section collapses into difficult terrain.'],
    legend: ({ dc }) => [{ name: 'Detect', text: 'The dragon makes a Wisdom (Perception) check.' }, { name: 'Tail Swipe', text: 'The dragon makes one Tail attack.' }, { name: 'Wing Beat (Costs 2 Actions)', text: `Each creature within 10 feet must succeed on a DC ${dc} Dexterity saving throw or take damage from the buffet and be knocked prone. The dragon can then fly up to half its Fly Speed.` }],
    tactics: ['Opens with its breath on the biggest cluster, then takes to the air out of melee reach.', 'Fights from the air and retreats when bloodied, returning when the party is hurt.', 'Targets whoever hurt it most and goads the rest of the party into scattering.'],
  },
  undead: {
    type: 'undead',
    bases: [['Ghoul', 'Skeleton Guard'], ['Wight', 'Bonewalker'], ['Wraith', 'Revenant'], ['Deathknight', 'Barrow Lord'], ['Lich Regent', 'Crypt Sovereign'], ['Dread Lich', 'Hollow King']],
    adjs: ['Grave', 'Pale', 'Hollow', 'Weeping', 'Barrow', 'Ashen', 'Rotted', 'Forsworn', 'Cold'],
    sizes: ['Medium', 'Medium', 'Medium', 'Medium', 'Medium', 'Large'],
    primary: 'str',
    speed: (t) => ({ walk: '30 ft.', ...(t >= 2 ? { fly: '40 ft.' } : {}) }),
    senses: { darkvision: '60 ft.' }, languages: 'the languages it knew in life', alignment: 'neutral evil', acType: 'ancient armor', acAdj: 0,
    attacks: [{ name: 'Grave Touch', kind: 'melee', type: 'Necrotic', reach: '5 ft.' }, { name: 'Rusted Blade', kind: 'melee', type: 'Slashing', reach: '5 ft.' }],
    traits: [{ name: 'Undead Fortitude', text: 'If damage reduces the creature to 0 Hit Points, it makes a Constitution saving throw (DC 5 + the damage taken), unless the damage is Radiant or from a Critical Hit. On a success, it drops to 1 Hit Point instead.' }, { name: 'Sunlight Sensitivity', text: 'While in sunlight, the creature has Disadvantage on attack rolls and Wisdom (Perception) checks that rely on sight.' }],
    resist: ['necrotic'], immune: ['poison'], condImmune: ['exhaustion', 'poisoned'], vuln: [],
    special: ({ dc, avg, sides }) => ({ name: 'Life Drain', text: `Constitution Saving Throw: DC ${dc}, one creature within 5 feet. Failure: ${dmg(avg, 0, sides).text} Necrotic damage, and the target's Hit Point maximum is reduced by the same amount until it finishes a Long Rest. The creature regains Hit Points equal to that amount.` }),
    reactions: [], lair: ['The shadows in the room lengthen: each creature in the dark must make a Wisdom save or be Frightened until initiative count 20 next round.', 'Skeletal hands claw out of the floor in a 15-foot square: difficult terrain and Strength save or be Restrained.', 'A cold wind snuffs every non-magical flame in the lair.'],
    legend: ({ dc }) => [{ name: 'Chill Gaze', text: `One creature within 30 feet must succeed on a DC ${dc} Wisdom saving throw or be Frightened until the end of its next turn.` }, { name: 'Grasp', text: 'The creature makes one Grave Touch attack.' }, { name: 'Slip Away', text: 'The creature moves up to its Speed without provoking opportunity attacks, passing through objects and creatures.' }],
    tactics: ['Targets the weakest-looking caster first, ignoring tanks.', 'Waits in the dark and strikes when a character is alone.', 'Sends lesser undead first to wear the party down, then arrives to drain.'],
  },
  fiend: {
    type: 'fiend',
    bases: [['Imp', 'Cinder Hound'], ['Brand Fiend', 'Chain Warden'], ['Pit Brute', 'Gall Tyrant'], ['Hellspawn Captain', 'Ash Duke'], ['Infernal Marshal', 'Wrath Lord'], ['Archfiend', 'Sovereign of Ash']],
    adjs: ['Brand', 'Ember', 'Gall', 'Hollow', 'Wrath', 'Smoulder', 'Barbed', 'Cruel'],
    sizes: ['Small', 'Medium', 'Large', 'Large', 'Huge', 'Huge'],
    primary: 'str',
    speed: (t) => ({ walk: '30 ft.', ...(t >= 3 ? { fly: '60 ft.' } : {}) }),
    senses: { darkvision: '120 ft.' }, languages: 'Infernal, telepathy 60 ft.', alignment: 'lawful evil', acType: 'infernal plate', acAdj: 1,
    attacks: [{ name: 'Barbed Claw', kind: 'melee', type: 'Piercing', reach: '5 ft.' }, { name: 'Hellfire Lash', kind: 'melee', type: 'Fire', reach: '15 ft.' }],
    traits: [{ name: 'Magic Resistance', text: 'The fiend has Advantage on saving throws against spells and other magical effects.' }, { name: 'Devil\'s Sight', text: 'Magical darkness does not impede the fiend\'s Darkvision.' }],
    resist: ['cold'], immune: ['fire', 'poison'], condImmune: ['poisoned'], vuln: [],
    special: ({ dc, avg, sides }) => ({ name: 'Hellfire Burst (Recharge 5-6)', text: `Dexterity Saving Throw: DC ${dc}, each creature in a 20-foot-radius Sphere centered on a point within 60 feet. Failure: ${dmg(avg, 0, sides).text} Fire damage. Success: Half damage. Flammable objects ignite.` }),
    reactions: [{ name: 'Infernal Retort', text: 'When a creature within 30 feet deals damage to the fiend, the attacker takes Fire damage equal to the fiend\'s proficiency bonus times 2.' }],
    lair: ['A chain of iron links bursts from the floor to bind a creature: Dexterity save or be Restrained until initiative count 20 next round.', 'The ground heaves with heat: each creature standing on the floor takes minor Fire damage on a failed Constitution save.', 'A whispered bargain: one creature must make a Charisma save or be unable to refuse the next question asked.'],
    legend: ({ dc }) => [{ name: 'Smoulder', text: `One creature within 30 feet takes minor Fire damage (DC ${dc} Dexterity save for none).` }, { name: 'Lash Out', text: 'The fiend makes one Hellfire Lash attack.' }, { name: 'Vanish in Smoke (Costs 2 Actions)', text: 'The fiend turns to smoke and reappears in an unoccupied space within 60 feet.' }],
    tactics: ['Offers a bargain mid-fight and fights on only if refused.', 'Grapples the party\'s fighter with its lash and burns it while others flail.', 'Falls back into the smoke when bloodied, shouting threats.'],
  },
  aberration: {
    type: 'aberration',
    bases: [['Gibbering Mouther', 'Eye Mote'], ['Tentacled Lurker', 'Spined Watcher'], ['Mind-Bound Thrall', 'Veil Strangler'], ['Deep Seer', 'Many-Eyed Warden'], ['Warp Sovereign', 'Brain Weaver'], ['Void Idol', 'Star-Eater']],
    adjs: ['Gaunt', 'Dripping', 'Warped', 'Whispering', 'Hollow', 'Pale', 'Slick', 'Lidless'],
    sizes: ['Small', 'Medium', 'Large', 'Large', 'Huge', 'Huge'],
    primary: 'int',
    speed: (t) => ({ walk: '30 ft.', ...(t >= 1 ? { swim: '30 ft.' } : {}), ...(t >= 3 ? { fly: '20 ft.' } : {}) }),
    senses: { darkvision: '120 ft.' }, languages: 'Deep Speech, telepathy 120 ft.', alignment: 'lawful evil', acType: 'natural armor', acAdj: 0,
    attacks: [{ name: 'Tentacle', kind: 'melee', type: 'Bludgeoning', reach: '10 ft.' }, { name: 'Bite', kind: 'melee', type: 'Piercing', reach: '5 ft.' }],
    traits: [{ name: 'Alien Mind', text: 'The creature has Advantage on saving throws against being Charmed or Frightened, and can\'t be surprised by creatures it can read the thoughts of.' }, { name: 'Amorphous', text: 'The creature can move through a space as narrow as 1 inch wide without squeezing.' }],
    resist: ['psychic'], immune: [], condImmune: ['prone'], vuln: [],
    special: ({ dc, avg, sides }) => ({ name: 'Mind Lash (Recharge 5-6)', text: `Intelligence Saving Throw: DC ${dc}, each creature in a 30-foot Cone. Failure: ${dmg(avg, 0, sides).text} Psychic damage, and the target is Stunned until the end of its next turn. Success: Half damage.` }),
    reactions: [], lair: ['The room tilts: each creature must make a Dexterity save or fall prone and slide 10 feet.', 'A chorus of whispers fills the lair: creatures that fail a Wisdom save have Disadvantage on concentration checks until the next lair action.', 'Pale tendrils creep along the floor and walls, making a 15-foot square difficult terrain.'],
    legend: ({ dc }) => [{ name: 'Gaze', text: `One creature the aberration can see within 60 feet makes a DC ${dc} Wisdom saving throw or takes minor Psychic damage.` }, { name: 'Lash', text: 'The creature makes one Tentacle attack.' }, { name: 'Warp (Costs 2 Actions)', text: 'The creature swaps places with a creature or object within 30 feet that fails a Charisma save.' }],
    tactics: ['Lets the party come to it, then picks at the loudest voice.', 'Turns allies against each other with its Mind Lash and watches.', 'Retreats into walls and water, returning when the party rests.'],
  },
  beast: {
    type: 'beast',
    bases: [['Giant Rat', 'Wild Boar', 'Marsh Hound'], ['Dire Wolf', 'Cave Lion', 'Giant Spider'], ['Armoured Boar', 'Great Bear', 'Razor Stag'], ['Thunder Elk', 'Saber Tiger', 'Giant Crocodile'], ['Mammoth', 'Mountain Wyvern', 'Old Behemoth'], ['Primeval Titan', 'Storm Roc', 'World-Eater Boar']],
    adjs: ['Scarred', 'Rabid', 'Alpha', 'Old', 'Starving', 'Hulking', 'Dire', 'Ghostly'],
    sizes: ['Small', 'Medium', 'Large', 'Large', 'Huge', 'Gargantuan'],
    primary: 'str',
    speed: (t, r) => ({ walk: `${30 + t * 5} ft.`, ...(chance(r, 0.25) ? { climb: '30 ft.' } : chance(r, 0.2) ? { swim: '40 ft.' } : {}) }),
    senses: { darkvision: '60 ft.' }, languages: '-', alignment: 'unaligned', acType: 'natural armor', acAdj: -1,
    attacks: [{ name: 'Bite', kind: 'melee', type: 'Piercing', reach: '5 ft.' }, { name: 'Claw', kind: 'melee', type: 'Slashing', reach: '5 ft.' }, { name: 'Gore', kind: 'melee', type: 'Piercing', reach: '5 ft.' }],
    traits: [{ name: 'Keen Senses', text: 'The creature has Advantage on Wisdom (Perception) checks that rely on hearing or smell.' }, { name: 'Pack Tactics', text: 'The creature has Advantage on an attack roll against a creature if at least one of its allies is within 5 feet of the target and the ally doesn\'t have the Incapacitated condition.' }],
    resist: [], immune: [], condImmune: [], vuln: [],
    special: ({ dc, avg, sides }) => ({ name: 'Pounce', text: `If the creature moves at least 20 feet straight toward a target and then hits it with a melee attack on the same turn, the target must succeed on a DC ${dc} Strength saving throw or have the Prone condition and take an extra ${dmg(Math.max(2, Math.round(avg / 3)), 0, sides).text} damage.` }),
    reactions: [], lair: [], legend: ({ dc }) => [{ name: 'Sniff the Air', text: 'The creature makes a Wisdom (Perception) check.' }, { name: 'Lunge', text: `The creature moves up to its speed and makes one attack. The target makes a DC ${dc} Strength save or falls prone.` }, { name: 'Roar (Costs 2 Actions)', text: `Each creature within 30 feet makes a DC ${dc} Wisdom saving throw or is Frightened until the end of its next turn.` }],
    tactics: ['Charges the nearest target, then reacts to pain by fleeing or going berserk.', 'Targets stragglers and avoids armoured fighters.', 'Uses the terrain: attacks from cover and breaks off if hurt.'],
  },
  construct: {
    type: 'construct',
    bases: [['Clockwork Sentry', 'Scrap Hound'], ['Iron Servant', 'Brass Guardian'], ['Stone Golem', 'Flesh Golem'], ['Bronze Colossus', 'Warforged Captain'], ['Titan Engine', 'Siege Golem'], ['Prime Automaton', 'Mountain Engine']],
    adjs: ['Rusted', 'Gilded', 'Silent', 'Humming', 'Ancient', 'Humming', 'Cracked', 'Gear-driven'],
    sizes: ['Small', 'Medium', 'Large', 'Large', 'Huge', 'Huge'],
    primary: 'str',
    speed: () => ({ walk: '30 ft.' }),
    senses: { darkvision: '60 ft.', blindsight: '30 ft.' }, languages: 'understands its maker\'s tongue but cannot speak', alignment: 'unaligned', acType: 'plating', acAdj: 2,
    attacks: [{ name: 'Slam', kind: 'melee', type: 'Bludgeoning', reach: '5 ft.' }, { name: 'Piston Fist', kind: 'melee', type: 'Bludgeoning', reach: '5 ft.' }],
    traits: [{ name: 'Immutable Form', text: 'The creature is immune to any spell or effect that would alter its form.' }, { name: 'Magic Resistance', text: 'The creature has Advantage on saving throws against spells and other magical effects.' }],
    resist: ['psychic'], immune: ['poison'], condImmune: ['charmed', 'exhaustion', 'frightened', 'paralyzed', 'poisoned'], vuln: [],
    special: ({ dc, avg, sides }) => ({ name: 'Steam Vent (Recharge 5-6)', text: `Constitution Saving Throw: DC ${dc}, each creature in a 15-foot Cone. Failure: ${dmg(avg, 0, sides).text} Fire damage. Success: Half damage.` }),
    reactions: [], lair: ['A hidden gate drops and cuts off an exit until initiative count 20 next round.', 'Gears grind in the floor: each creature on the ground makes a Dexterity save or takes minor Bludgeoning damage.', 'A dormant guardian twitches; one more minor construct joins the fight.'],
    legend: ({ dc }) => [{ name: 'Whirr', text: 'The construct moves up to half its Speed.' }, { name: 'Strike', text: 'The construct makes one Slam attack.' }, { name: 'Overload (Costs 2 Actions)', text: `Each creature within 10 feet makes a DC ${dc} Constitution saving throw or takes minor Lightning damage and cannot take Reactions until its next turn.` }],
    tactics: ['Follows its last order to the letter, ignoring everything else.', 'Pursues the nearest intruder relentlessly, but can be tricked by simple misdirection.', 'Holds a doorway and does not leave it.'],
  },
  elemental: {
    type: 'elemental',
    bases: [['Mote', 'Spark'], ['Kindling Elemental', 'Dust Devil'], ['Embercrawler', 'Tide Warden'], ['Flame Colossus', 'Stone Behemoth'], ['Tempest Lord', 'Magma Sovereign'], ['Primal Tyrant', 'World-Flood']],
    adjs: ['Roiling', 'Sullen', 'Whirling', 'Smouldering', 'Bleak', 'Seething', 'Crackling'],
    sizes: ['Small', 'Medium', 'Large', 'Large', 'Huge', 'Huge'],
    primary: 'str',
    speed: (t) => ({ walk: '30 ft.', ...(t >= 1 ? { fly: '60 ft.' } : {}) }),
    senses: { darkvision: '60 ft.' }, languages: 'a primordial tongue', alignment: 'neutral', acType: 'natural armor', acAdj: 0,
    attacks: [{ name: 'Slam', kind: 'melee', type: 'Bludgeoning', reach: '5 ft.' }, { name: 'Lash', kind: 'melee', type: 'Fire', reach: '10 ft.' }],
    traits: [{ name: 'Elemental Body', text: 'A creature that touches the elemental or hits it with a melee attack while within 5 feet takes minor damage of the elemental\'s type.' }, { name: 'Elemental Nature', text: 'The elemental doesn\'t need to eat, drink, sleep or breathe.' }],
    resist: ['bludgeoning', 'piercing', 'slashing (nonmagical)'], immune: ['poison'], condImmune: ['exhaustion', 'paralyzed', 'petrified', 'poisoned', 'unconscious'], vuln: [],
    special: ({ dc, avg, sides, el }) => ({ name: 'Elemental Burst (Recharge 5-6)', text: `Dexterity Saving Throw: DC ${dc}, each creature in a 20-foot-radius Sphere centered on the elemental. Failure: ${dmg(avg, 0, sides).text} ${cap(el)} damage. Success: Half damage.` }),
    reactions: [], lair: ['The terrain changes: a 20-foot square becomes difficult and hazardous in the elemental\'s own element.', 'A surge of the element lifts or batters each creature that fails a Strength save.', 'The element floods the lair, lightly obscuring it until the next lair action.'],
    legend: ({ dc }) => [{ name: 'Surge', text: 'The elemental moves up to its Speed without provoking opportunity attacks.' }, { name: 'Strike', text: 'The elemental makes one Slam attack.' }, { name: 'Overwhelm (Costs 2 Actions)', text: `Each creature within 10 feet makes a DC ${dc} Strength saving throw or is pushed 15 feet and knocked prone.` }],
    tactics: ['Rushes the nearest target, then wades into the party and burns.', 'Spreads itself across the room to cut off exits.', 'Targets metal armour and flammable gear first.'],
  },
  fey: {
    type: 'fey',
    bases: [['Sprite', 'Thornling'], ['Bramble Knight', 'Gloom Pixie'], ['Hag Apprentice', 'Court Duelist'], ['Briar Hag', 'Moonlit Stag'], ['Archfey Warden', 'Winter Queen\'s Hound'], ['Archfey Sovereign', 'Wild Hunt Master']],
    adjs: ['Gleaming', 'Thorny', 'Moonlit', 'Capricious', 'Mossy', 'Twilight', 'Wicked', 'Sly'],
    sizes: ['Tiny', 'Small', 'Medium', 'Medium', 'Large', 'Large'],
    primary: 'cha',
    speed: (t) => ({ walk: '30 ft.', ...(t >= 1 ? { fly: '40 ft.' } : {}) }),
    senses: { darkvision: '60 ft.' }, languages: 'Elvish, Sylvan', alignment: 'chaotic neutral', acType: 'glamour', acAdj: 0,
    attacks: [{ name: 'Thorn Blade', kind: 'melee', type: 'Piercing', reach: '5 ft.' }, { name: 'Moonbolt', kind: 'ranged', type: 'Radiant', reach: '60 ft.' }],
    traits: [{ name: 'Magic Resistance', text: 'The creature has Advantage on saving throws against spells and other magical effects.' }, { name: 'Fey Ancestry', text: 'The creature has Advantage on saving throws against being Charmed, and magic can\'t put it to sleep.' }],
    resist: [], immune: [], condImmune: [], vuln: ['cold iron weapons'],
    special: ({ dc }) => ({ name: 'Glamour (Recharge 5-6)', text: `Wisdom Saving Throw: DC ${dc}, one creature within 30 feet that can see the fey. Failure: the target has the Charmed condition for 1 minute (repeating the save at the end of each of its turns, and whenever it takes damage). The charmed creature sees the fey as a trusted friend.` }),
    bonus: [{ name: 'Fey Step', text: 'The creature magically teleports up to 30 feet to an unoccupied space it can see.' }],
    reactions: [], lair: ['The air shimmers: each creature must make a Wisdom save or believe a false landmark is real until the next lair action.', 'Thorny vines erupt in a 20-foot square: difficult terrain, and creatures that start their turn there take minor Piercing damage.', 'A pale light draws one creature (Charisma save) to walk 20 feet toward the fey.'],
    legend: ({ dc }) => [{ name: 'Tinkle', text: 'The creature makes a Dexterity (Stealth) check.' }, { name: 'Prick', text: 'The creature makes one Thorn Blade attack.' }, { name: 'Befuddle (Costs 2 Actions)', text: `One creature within 30 feet makes a DC ${dc} Wisdom saving throw or has Disadvantage on its next attack roll.` }],
    tactics: ['Talks first, fights second, and cheats at both.', 'Teleports around the edge of the fight, striking from the dark.', 'Charms the party\'s strongest member and keeps them in reserve.'],
  },
};
// The beast archetype has no lair actions or lair note; give a short generic set.
ARCHS.beast.lair = ['The beast\'s den: a narrow tunnel or ledge makes it hard for large creatures to reach it.', 'A shower of bones and rubble falls from above: Dexterity save or minor Bludgeoning damage.', 'The den\'s floor is slick with old blood and mud: difficult terrain in a 15-foot square.'];

const CONCEPT_TYPE: [RegExp, MonsterType][] = [
  [/dragon|wyrm|drake/i, 'dragon'], [/undead|ghost|zombie|skeleton|wraith|vampire|lich|wight|ghoul|revenant|spectre|haunt/i, 'undead'],
  [/demon|devil|fiend|infernal|hellish|imp\b/i, 'fiend'], [/aberra|tentacle|eldritch|mind.?flay|beholder|eye|eldritch|unknowable|cosmic|void/i, 'aberration'],
  [/construct|golem|automaton|clockwork|mech|statue|animated armor/i, 'construct'], [/elemental|spirit of|living (fire|flame|storm|stone)|magma|tempest/i, 'elemental'],
  [/fey|faerie|fairy|pixie|hag|sprite|dryad|satyr|thorn/i, 'fey'],
];
const CONCEPT_ELEMENT: [RegExp, Element][] = [[/fire|flame|ember|burn|lava|magma|ash/i, 'fire'], [/ice|frost|cold|winter|snow|freez/i, 'cold'], [/lightning|storm|spark|electric/i, 'lightning'], [/acid|slime|corrod|caustic|ooze/i, 'acid'], [/poison|venom|spider|toxic|snake|serpent/i, 'poison'], [/necrotic|rot|grave|death|decay|bone/i, 'necrotic'], [/radiant|holy|sun|light|divine/i, 'radiant'], [/psychic|mind|dream|thought|madness/i, 'psychic'], [/thunder|sound|roar|echo/i, 'thunder'], [/force|void|gravity|crush/i, 'force']];

const typeFor = (t: string): MonsterType | null => {
  const s = t.toLowerCase().trim();
  if (s === 'demon' || s === 'devil' || s === 'fiend' || s === 'demon/fiend') return 'fiend';
  return (MONSTER_TYPES as readonly string[]).includes(s) ? (s as MonsterType) : null;
};

/** Pick a module monster of this type with a CR as close to the target as possible (within 2 steps), or null. */
function fromPool(pool: PoolMonster[], type: string, cr: number, r: Rng): PoolMonster | null {
  const want = type === 'fiend' ? ['fiend', 'demon', 'devil'] : [type];
  const step = (c: number) => CR_STEPS.indexOf(CR_STEPS.reduce((b, s) => (Math.abs(s - c) < Math.abs(b - c) ? s : b), 0));
  const ts = step(cr);
  const cands = pool.filter((m) => want.some((w) => String(m.data?.type ?? '').toLowerCase().startsWith(w)) && typeof m.data?.cr === 'number' && Math.abs(step(m.data.cr) - ts) <= 2);
  if (!cands.length) return null;
  const best = Math.min(...cands.map((m) => Math.abs(step(m.data.cr) - ts)));
  const top = cands.filter((m) => Math.abs(step(m.data.cr) - ts) === best);
  return top[Math.floor(r() * top.length)];
}

function nameFor(a: Arch, type: MonsterType, cr: number, el: Element, r: Rng, boss: boolean): string {
  const t = tier(cr);
  if (type === 'dragon') {
    const age = ['Wyrmling', 'Young', 'Adult', 'Elder', 'Ancient', 'Great Wyrm'][t === 0 ? 0 : Math.min(5, t)];
    const colour = pick(r, ELEMENT_ADJ[el]);
    return age === 'Wyrmling' ? `${colour} Wyrmling` : `${age} ${colour} Dragon`;
  }
  const base = pick(r, a.bases[t]);
  const adj = pick(r, a.adjs.length ? a.adjs : ELEMENT_ADJ[el]);
  const n = chance(r, 0.65) ? `${adj} ${base}` : base;
  return boss && chance(r, 0.5) ? `${pick(r, ['The', 'Old', 'Lord', 'Mother', 'Grand'])} ${n}`.replace(/^The The/, 'The') : n;
}

/** Retune a module monster to a target CR (HP, AC, attack bonuses, save DCs) and rename it. */
function reskin(m: PoolMonster, name: string, target: CrRow, notes: string[]): Statblock {
  const sb: any = JSON.parse(JSON.stringify(m.data));
  const own = crRow(sb.cr);
  sb.name = name;
  if (own.cr !== target.cr) {
    const ratio = target.hp / Math.max(1, own.hp);
    if (Math.abs(ratio - 1) > 0.12) sb.hp = Math.max(1, Math.round(sb.hp * ratio));
    sb.hitDice = null;
    sb.ac = Math.max(1, Math.min(40, sb.ac + Math.max(-3, Math.min(3, target.ac - own.ac))));
    const dAtk = target.atk - own.atk, dDc = target.dc - own.dc;
    const fix = (f: Feature): Feature => ({ name: f.name, text: f.text.replace(/Attack Roll: ([+-]\d+)/g, (_x, n) => `Attack Roll: ${signed(Number(n) + dAtk)}`).replace(/DC (\d+)/g, (_x, n) => `DC ${Math.max(5, Number(n) + dDc)}`) });
    for (const k of ['traits', 'actions', 'bonusActions', 'reactions', 'legendaryActions']) if (Array.isArray(sb[k])) sb[k] = sb[k].map(fix);
    notes.push(`Retuned from CR ${crLabel(own.cr)} to CR ${target.label}: HP, AC, attack bonuses and save DCs adjusted; damage dice are the original's.`);
  }
  sb.cr = target.cr === 0.125 ? '1/8' : target.cr === 0.25 ? '1/4' : target.cr === 0.5 ? '1/2' : target.cr;
  sb.xp = target.xp;
  return normalizeStatblock(sb, name);
}

function build(type: MonsterType, cr: number, boss: boolean, name: string, el: Element, r: Rng, concept: string): { sb: Statblock; lair: string[] } {
  const a = ARCHS[type];
  const T = crRow(cr);
  const t = tier(cr);
  const size = a.sizes[t];
  const prof = T.prof;
  // abilities: the primary one carries the attack bonus
  const pm = Math.max(0, Math.min(10, T.atk - prof));
  const big = ['Large', 'Huge', 'Gargantuan'].includes(size);
  const con = Math.max(0, Math.min(9, Math.round(pm * 0.6 + (big ? 2 : 0) + (type === 'undead' ? 0 : 1))));
  const ab = { str: score(big ? pm + 1 : Math.max(0, pm - 1)), dex: score(big ? Math.max(0, pm - 3) : Math.max(1, pm - 1)), con: score(con), int: score(type === 'beast' ? -4 : Math.max(-1, Math.round(pm * 0.4) - 1)), wis: score(Math.round(pm * 0.4)), cha: score(type === 'beast' ? -3 : Math.round(pm * 0.3) - 1) };
  (ab as any)[a.primary] = score(pm + (a.primary === 'str' && big ? 1 : 0));
  if (a.primary !== 'str' && a.primary !== 'dex') ab.dex = score(Math.max(0, pm - 2));
  // hit points from the table (a little variance), with dice for the creature's size
  const die = { Tiny: 4, Small: 6, Medium: 8, Large: 10, Huge: 12, Gargantuan: 20 }[size] ?? 8;
  const cm = mod(ab.con);
  const targetHp = Math.max(1, Math.round(T.hp * (0.94 + r() * 0.12) * (type === 'construct' ? 1.08 : type === 'beast' ? 0.96 : 1)));
  const n = Math.max(1, Math.round(targetHp / ((die + 1) / 2 + cm)));
  const hp = Math.max(1, Math.floor(n * ((die + 1) / 2 + cm)));
  const hitDice = `${n}d${die}${cm ? ` ${cm > 0 ? '+' : '-'} ${Math.abs(cm) * n}` : ''}`;
  const ac = Math.max(10, Math.min(25, T.ac + a.acAdj + (boss ? 1 : 0)));
  // attacks
  const nAtk = cr < 2 ? 1 : cr < 8 ? 2 : 3;
  const perAtk = Math.max(1, Math.round((T.dmg * (boss ? 1.1 : 1)) / nAtk));
  const sides = die >= 10 ? 8 : 6;
  const main = a.attacks[0], second = a.attacks[1] ?? a.attacks[0];
  const reachOf = (x: Arch['attacks'][number]) => (x.reach ? x.reach : '5 ft.').replace(/\.$/, '');
  const mkAtk = (x: Arch['attacks'][number]): Feature => ({
    name: x.name,
    text: `${x.kind === 'ranged' ? 'Ranged' : 'Melee'} Attack Roll: ${signed(T.atk)}, ${x.kind === 'ranged' ? 'range ' : 'reach '}${reachOf(x)}. Hit: ${dmg(perAtk, mod(ab[a.primary] ?? ab.str), sides).text} ${x.type} damage.`,
  });
  const actions: Feature[] = [];
  if (nAtk >= 2) actions.push({ name: 'Multiattack', text: nAtk === 2 ? `The creature makes two attacks, using ${main.name} or ${second.name} in any combination.` : `The creature makes three attacks: one ${main.name} and two ${second.name}${second.name === main.name ? '' : ' (or any combination)'}.` });
  actions.push(mkAtk(main));
  if (second.name !== main.name) actions.push(mkAtk(second));
  const dc = T.dc + (boss ? 1 : 0);
  if (cr >= 1 || type === 'dragon' || type === 'beast') actions.push(a.special({ dc, avg: Math.round(T.dmg * 1.6), sides: T.dmg * 1.6 > 60 ? 10 : 6, el, size, r }));
  // traits
  const traits: Feature[] = [...a.traits.filter((_x, i) => cr >= 3 || i === 0)].map((f) => ({ ...f }));
  if (type === 'dragon' && cr < 5) traits.splice(0, traits.length);
  if (boss) traits.push(legendResistance, { name: 'Legendary Actions', text: LEGEND_LEAD });
  if (type === 'elemental' || type === 'dragon') for (const f of [...traits, ...actions]) f.text = f.text.replace(/\bminor damage of the elemental's type\b/g, `minor ${cap(el)} damage`);
  // concept extras
  const resist = [...a.resist], immune = [...a.immune];
  const speed = a.speed(t, r);
  const c = concept.toLowerCase();
  if (/fly|wing|bat|bird|hover/.test(c) && !speed.fly) speed.fly = '40 ft.';
  if (/swim|sea|water|fish|drown|kelp/.test(c) && !speed.swim) speed.swim = '40 ft.';
  if (/burrow|tunnel|worm|dig/.test(c) && !speed.burrow) speed.burrow = '20 ft.';
  if (/climb|spider|web|wall/.test(c) && !speed.climb) speed.climb = '30 ft.';
  if (/web|spider/.test(c)) actions.push({ name: 'Web (Recharge 5-6)', text: `Ranged Attack Roll: ${signed(T.atk)}, range 30/60 ft. Hit: The target has the Restrained condition until it escapes (DC ${dc} Strength check as an action).` });
  if (/regenerat|troll|undying/.test(c)) traits.push({ name: 'Regeneration', text: `The creature regains ${Math.max(3, Math.round(prof * 3))} Hit Points at the start of its turn if it has at least 1 Hit Point and has not taken ${cap(el === 'fire' ? 'cold' : 'fire')} or Radiant damage since then.` });
  if (/invisible|unseen|ghost|shadow/.test(c)) traits.push({ name: 'Shadowy', text: 'While in dim light or darkness, the creature has Advantage on Dexterity (Stealth) checks and can take the Hide action as a Bonus Action.' });
  if (/ambush|hide|lurk|pounce/.test(c)) traits.push({ name: 'Ambusher', text: 'The creature has Advantage on attack rolls against any creature it has surprised, and its first hit against a surprised creature deals extra damage equal to its proficiency bonus times 3.' });
  if (type === 'elemental' || /fire|ice|frost|lightning|storm|acid|poison/.test(c)) { if (!immune.includes(el) && el !== 'psychic' && el !== 'force') immune.push(el); }
  if (a.attacks.some((x) => x.type === 'Fire') && el !== 'fire') { /* keep the archetype's own damage type */ }
  if (el !== 'fire' && type === 'dragon') immune.push(el);
  const savingThrows: Record<string, number> = {};
  if (boss) { savingThrows.dex = mod(ab.dex) + prof; savingThrows.con = mod(ab.con) + prof; savingThrows.wis = mod(ab.wis) + prof; }
  const passive = 10 + mod(ab.wis) + (boss ? prof : 0);
  const sb = normalizeStatblock({
    name, size, type: a.type, alignment: a.alignment, cr: crLabel(cr) === String(cr) ? cr : crLabel(cr), xp: T.xp,
    ac, acType: a.acType, hp, hitDice, speed, abilities: ab, savingThrows,
    skills: { Perception: mod(ab.wis) + (boss ? prof : 0), ...(cr >= 1 ? { Stealth: mod(ab.dex) + prof } : {}) },
    vulnerabilities: a.vuln, resistances: resist, immunities: [...new Set(immune)], conditionImmunities: a.condImmune,
    senses: { ...a.senses, passive_perception: passive }, languages: a.languages,
    traits, actions, bonusActions: cr >= 3 ? (a.bonus ?? []) : [], reactions: cr >= 5 ? (a.reactions ?? []) : [],
    legendaryActions: boss ? a.legend({ dc }) : [],
  }, name);
  return { sb, lair: boss ? a.lair.map((l) => l.replace('{el}', ELEMENT_NOUN[el])) : [] };
}

export function genMonster(o: MonsterOpts = {}): MonsterResult {
  const seed = seedOf(o.seed);
  const r = makeRng(`${seed}|monster`);
  const preset = String(o.preset ?? 'random').toLowerCase().replace(/_/g, '-');
  if (!(MONSTER_PRESETS as readonly string[]).includes(preset)) throw new RangeError(`preset must be one of ${MONSTER_PRESETS.join(', ')}`);
  const concept = String(o.concept ?? '').slice(0, 400);
  if (preset === 'homebrew' && !concept.trim()) throw new RangeError('homebrew needs a concept: a sentence about the creature');
  const notes: string[] = [];

  // type
  let type: MonsterType | null = typeFor(String(o.type ?? ''));
  if (o.type && !type) throw new RangeError(`type must be one of ${MONSTER_TYPES.join(', ')} (or demon)`);
  if (!type && preset !== 'random' && preset !== 'boss' && preset !== 'low-cr' && preset !== 'homebrew') type = typeFor(preset);
  if (!type && concept) for (const [re, t] of CONCEPT_TYPE) if (re.test(concept)) { type = t; break; }
  if (!type) type = pick(r, MONSTER_TYPES);
  let el: Element = pick(r, ELEMENTS);
  const bias: Partial<Record<MonsterType, Element[]>> = { undead: ['necrotic', 'cold'], fiend: ['fire', 'necrotic'], aberration: ['psychic', 'acid'], fey: ['radiant', 'psychic', 'poison'], dragon: ['fire', 'cold', 'lightning', 'acid', 'poison'], elemental: ['fire', 'cold', 'lightning', 'thunder', 'acid'], construct: ['force', 'lightning', 'fire'], beast: ['poison', 'thunder'] };
  if (bias[type]) el = pick(r, bias[type]!);
  for (const [re, e] of CONCEPT_ELEMENT) if (concept && re.test(concept)) { el = e; break; }

  // CR
  const boss = preset === 'boss' || o.boss === true || /\bboss|legendary|lord|king|queen|ancient\b/i.test(concept);
  let cr: number;
  if (o.cr !== undefined && o.cr !== '' && o.cr !== null) cr = parseCr(o.cr);
  else if (preset === 'low-cr') cr = pick(r, [0.125, 0.25, 0.5, 1, 2, 3, 4]);
  else if (o.partyLevel) cr = crForParty(Number(o.partyLevel), Number(o.partySize ?? 4), boss);
  else cr = boss ? pick(r, [5, 8, 10, 13, 17]) : pick(r, [0.5, 1, 2, 3, 4, 5, 6, 8]);
  if (preset === 'low-cr' && cr > 4) cr = 4;
  const T = crRow(cr);
  const a = ARCHS[type];
  const conceptName = (): string => {
    const head = concept.trim().replace(/^(an?|the|some)\s+/i, '').split(/\s+(who|that|which|with|from|in|on|and|made|of)\b|[,.;]/i)[0] ?? '';
    return head.trim().split(/\s+/).slice(0, 3).map(cap).join(' ').slice(0, 60);
  };
  const name = String(o.name ?? '').trim().slice(0, 100) || (preset === 'homebrew' && conceptName() && !isOffensive(conceptName()) ? conceptName() : '') || (() => { for (let i = 0; i < 20; i++) { const n = nameFor(a, type!, cr, el, r, boss); if (!isOffensive(n)) return n; } return nameFor(a, type!, cr, el, r, boss); })();

  // build: module first (not for a boss or a homebrew, which need legendary parts and the concept)
  const base = String(o.base ?? 'auto');
  const poolPick = base !== 'builtin' && !boss && preset !== 'homebrew' && o.pool?.length ? fromPool(o.pool, type, cr, r) : null;
  let statblock: Statblock, lair: string[] = [];
  let source: MonsterResult['source'] = { kind: 'builtin' };
  if (poolPick) {
    statblock = reskin(poolPick, name, T, notes);
    source = { kind: 'module', ref: poolPick.ref, title: poolPick.name, module: poolPick.moduleName, attribution: poolPick.attribution };
    notes.push(`Based on ${poolPick.name} from ${poolPick.moduleName}.`);
  } else {
    if (base === 'module') throw new RangeError('No imported game-module monster fits that type and CR');
    const built = build(type, cr, boss, name, el, r, concept);
    statblock = built.sb; lair = built.lair;
    notes.push('Built from the CR math tables (our own fit); no module monster was used.');
  }
  if (boss && !lair.length) lair = a.lair.map((l) => l.replace('{el}', ELEMENT_NOUN[el]));
  const tactics = pick(r, a.tactics);
  const description = concept.trim() ? `Concept: ${concept.trim()}` : `${cap(statblock.size)} ${statblock.type}, CR ${crLabel(cr)}.`;
  return { seed, preset, type, cr, crLabel: crLabel(cr), boss, source, statblock, lair, tactics, description, table: T, notes };
}

/** A humanoid statblock for an NPC (a quick statblock), with weapons and a trait that fit the role. */
export function genHumanoid(role: string, cr: number, name: string, r: Rng): Statblock {
  const T = crRow(cr);
  const prof = T.prof;
  const pm = Math.max(0, Math.min(8, T.atk - prof));
  const kind = /wizard|mage|sorcer|warlock/.test(role) ? 'mage' : /cleric|priest|healer/.test(role) ? 'priest' : /rogue|thief|spy|assassin/.test(role) ? 'rogue' : /guard|soldier|captain|knight|villain|warrior/.test(role) ? 'fighter' : 'commoner';
  const ab = { str: score(kind === 'fighter' ? pm : Math.max(0, pm - 2)), dex: score(kind === 'rogue' ? pm : Math.max(0, pm - 1)), con: score(Math.max(0, Math.round(pm * 0.6))), int: score(kind === 'mage' ? pm : 0), wis: score(kind === 'priest' ? pm : Math.round(pm * 0.3)), cha: score(Math.round(pm * 0.3)) };
  const hp = Math.max(4, Math.round(T.hp * (0.95 + r() * 0.1)));
  const dm = (avg: number, m: number, s: number) => dmg(avg, m, s).text;
  const hit = (ranged = false) => `${ranged ? 'Ranged' : 'Melee'} Attack Roll: ${signed(T.atk)}, ${ranged ? 'range 60 ft.' : 'reach 5 ft.'}`;
  const actions: Feature[] = [];
  const traits: Feature[] = [];
  if (kind === 'mage') {
    actions.push({ name: 'Arcane Bolt', text: `${hit(true)} Hit: ${dm(Math.max(2, T.dmg), mod(ab.int), 8)} Force damage.` }, { name: 'Quarterstaff', text: `${hit()} Hit: ${dm(Math.max(1, Math.round(T.dmg / 3)), mod(ab.str), 6)} Bludgeoning damage.` });
    if (cr >= 1) actions.push({ name: 'Fire Burst (Recharge 6)', text: `Dexterity Saving Throw: DC ${T.dc}, each creature in a 20-foot-radius Sphere within 60 feet. Failure: ${dm(Math.round(T.dmg * 1.5), 0, 6)} Fire damage. Success: Half damage.` });
    traits.push({ name: 'Spellcasting', text: `The mage's spellcasting ability is Intelligence (spell save DC ${T.dc}). It can cast Mage Hand and Light at will, and Shield and Misty Step once each per day.` });
  } else if (kind === 'priest') {
    actions.push({ name: 'Mace', text: `${hit()} Hit: ${dm(Math.max(2, Math.round(T.dmg * 0.8)), mod(ab.str), 6)} Bludgeoning damage plus ${dm(Math.max(1, Math.round(T.dmg * 0.3)), 0, 6)} Radiant damage.` });
    if (cr >= 0.5) actions.push({ name: 'Healing Word (3/Day)', text: `One creature within 60 feet regains ${dm(Math.max(3, Math.round(T.dmg * 0.6)), mod(ab.wis), 4)} Hit Points.` });
    traits.push({ name: 'Divine Favor', text: 'The priest has Advantage on saving throws against being Charmed or Frightened.' });
  } else if (kind === 'rogue') {
    actions.push({ name: 'Shortsword', text: `${hit()} Hit: ${dm(Math.max(2, Math.round(T.dmg * 0.7)), mod(ab.dex), 6)} Piercing damage.` }, { name: 'Light Crossbow', text: `${hit(true).replace('60 ft.', '80/320 ft.')} Hit: ${dm(Math.max(2, Math.round(T.dmg * 0.6)), mod(ab.dex), 8)} Piercing damage.` });
    traits.push({ name: 'Sneak Attack (1/Turn)', text: `The rogue deals an extra ${dm(Math.max(2, prof * 3), 0, 6)} damage when it hits with an attack roll that has Advantage, or when an ally is within 5 feet of the target.` }, { name: 'Cunning Action', text: 'The rogue can Dash, Disengage or Hide as a Bonus Action.' });
  } else if (kind === 'fighter') {
    actions.push({ name: 'Multiattack', text: cr >= 2 ? 'The creature makes two Longsword attacks.' : 'The creature makes one Spear attack.' }, { name: cr >= 2 ? 'Longsword' : 'Spear', text: `${hit()} Hit: ${dm(Math.max(2, Math.round(T.dmg / (cr >= 2 ? 2 : 1))), mod(ab.str), 8)} Slashing damage.` });
    traits.push({ name: 'Disciplined', text: 'The creature has Advantage on saving throws against being Frightened.' });
  } else {
    actions.push({ name: 'Club', text: `${hit()} Hit: ${dm(Math.max(1, T.dmg), mod(ab.str), 4)} Bludgeoning damage.` });
  }
  return normalizeStatblock({
    name, size: 'Medium', type: 'humanoid', alignment: 'any alignment', cr: crLabel(T.cr) === String(T.cr) ? T.cr : crLabel(T.cr), xp: T.xp,
    ac: Math.max(10, T.ac - (kind === 'mage' ? 1 : 0)), acType: kind === 'fighter' ? 'chain shirt, shield' : kind === 'mage' ? 'mage armor' : 'leather armor', hp, hitDice: null,
    speed: { walk: '30 ft.' }, abilities: ab, savingThrows: {}, skills: { Perception: mod(ab.wis) }, senses: { passive_perception: 10 + mod(ab.wis) }, languages: 'Common and one other',
    traits, actions,
  }, name);
}
