// Tavern generator: a name, an owner (the tavern-keeper NPC preset), an
// atmosphere, a priced menu in the world's coin setting, rooms, patrons,
// rumours (what the party already knows from the story bible when there is
// one, else from tables) and a floor plan from the tavern map. Our own tables.
import { coinText, genNames } from '../quickgen/api.ts';
import { chance, int, makeRng, pick, seedOf, type Rng } from '../quickgen/rng.ts';
import * as ST from '../sculpt/tables.ts';
import { genNpc, type NpcResult } from './npc.ts';
import { placeName } from './names.ts';
import { genMap, type MapResult } from './maps/index.ts';
import { TAVERN_FLAVOURS } from './maps/tavern.ts';
import type { WorldInfo } from './world.ts';

export const TAVERN_PRESETS = ['common', 'dwarven', 'elven', 'pirate', 'haunted'] as const;
export const TAVERN_LOCKABLE = ['name', 'atmosphere', 'menu', 'rooms', 'patrons', 'rumours'] as const;

/** A price in copper as text in the world's coins: gold only, gold/silver/copper, or all coins. */
export function priceText(cp: number, coins: string): string {
  const c = Math.max(0, Math.round(cp));
  if (coins === 'gold') {
    const gp = c / 100;
    return `${Number.isInteger(gp) ? gp : gp.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} gp`;
  }
  const gp = Math.floor(c / 100), sp = Math.floor((c % 100) / 10), cp2 = c % 10;
  return coinText({ pp: 0, gp, ep: 0, sp, cp: cp2 });
}

type Item = [string, number];
interface Menu { drinks: Item[]; food: Item[]; look: string[]; patronsKind: string[] }
const MENUS: Record<string, Menu> = {
  common: {
    drinks: [['Small ale', 4], ['House cider', 6], ['Strong ale', 8], ['Mulled wine', 12], ['Hot honeyed milk', 3], ['Spiced mead', 14], ['Fruit cordial', 5]],
    food: [['Barley stew and bread', 8], ['Half a roast chicken', 18], ['Meat pie', 10], ['Cheese, pickles and dark bread', 9], ['Fried river fish', 12], ['Sausage and mash', 10], ['Apple tart', 6]],
    look: ['A low, beamed room that smells of woodsmoke, wet wool and bread; a fire crackles in a wide hearth.', 'A cheerful, crowded taproom of mismatched chairs, with a wall of old tankards over the bar.', 'A tidy, quiet house with brass lamps, sanded floors and a cat asleep on the best chair.'],
    patronsKind: ['a carter', 'a ferryman', 'an off-duty guard', 'a travelling tinker', 'a farmer in for market', 'a bard with a damaged lute', 'a pilgrim', 'a merchant\'s clerk'],
  },
  dwarven: {
    drinks: [['Black stout', 8], ['Deepmoss ale', 6], ['Forge-fire spirit', 20], ['Stonewater (clear and cold)', 2], ['Honey stout', 10], ['Mountain mead', 16]],
    food: [['Rock-salt ram roast', 20], ['Mushroom and barley pot', 9], ['Cave-cheese board', 11], ['Smoked haunch and root mash', 16], ['Flatbread with seed butter', 5], ['Marrow bone and bread', 8]],
    look: ['A vaulted hall of dressed stone, long benches, and a hearth big enough to roast a pig; the beer pours from copper taps in the shape of axes.', 'A half-cellar of low arches and carved pillars; every beam is rune-marked and every cup is the size of a helm.', 'A smoky hall with an anvil for a table, the bar a single slab of granite.'],
    patronsKind: ['a miner off shift', 'a rune-carver', 'a clan factor with a ledger', 'a retired shield-bearer', 'a brewer comparing notes', 'a surveyor with maps', 'a stonemason', 'a drover from the high road'],
  },
  elven: {
    drinks: [['Dewflower tea', 6], ['Pale wine', 24], ['Moonpetal cordial', 12], ['Honey-and-heather mead', 18], ['Spring water with mint', 2], ['Silver-bark brandy', 30]],
    food: [['Honeyed greens and flatbread', 12], ['Roast nuts and berries', 6], ['Glazed pear', 8], ['River fish in leaf', 16], ['Mushroom and herb pie', 14], ['Seed bread with nut butter', 5]],
    look: ['A tree-hall of living wood with lanterns like captured stars, low singing and the scent of rain on leaves.', 'A terraced garden under a lattice of branches; tables are slices of single trunks and nobody raises their voice.', 'A glass-roofed pavilion where moths drift over every lamp and the music never quite stops.'],
    patronsKind: ['a traveller from the old forest', 'a court musician on break', 'a herbalist', 'a scribe copying a poem', 'a hunter in green', 'a young noble on a gap year', 'a grove warden', 'a half-elf who is a little lost'],
  },
  pirate: {
    drinks: [['Black rum', 8], ['Watered grog', 3], ['Spiced rum punch', 14], ['Dark ale', 6], ['Sea-salt whiskey', 18], ['Lime water', 2]],
    food: [['Salt fish and ship\'s biscuit', 6], ['Fish stew in a bread bowl', 9], ['Roast gull (it is probably gull)', 8], ['Pickled eggs and onions', 4], ['Plantain and spiced rice', 10], ['Fried squid rings', 12]],
    look: ['A low, creaking house built from ship\'s timbers, with a figurehead over the bar and nets full of bottles on the ceiling.', 'A noisy, sweaty dockside den: sand on the floor, charts nailed to the walls, a parrot on every shoulder it can reach.', 'A converted hull with portholes for windows, rope for rails and a map of the coast burned into the bar-top.'],
    patronsKind: ['a deckhand on shore leave', 'a navigator with a hangover', 'a quartermaster counting coin', 'a ship\'s cook looking for a berth', 'a smuggler who is not hiding', 'a dockside fence', 'a harbour clerk', 'a boatswain with an eyepatch'],
  },
  haunted: {
    drinks: [['Cold ale', 5], ['Widow\'s wine', 15], ['Grave-dust tea', 4], ['Dark spirit that tastes of smoke', 20], ['Midnight milk', 3], ['Hot cider that is never quite warm', 6]],
    food: [['Pale soup', 5], ['Funeral cake', 6], ['Thin stew and heel of bread', 7], ['Cold roast, carved for one', 14], ['Salted nuts', 3], ['Midnight pie', 11]],
    look: ['A damp, quiet room where the candles burn blue at the edges and one chair is never sat in; the floor creaks when nobody is walking.', 'A narrow, dark taproom with draughts that come from the wrong direction, a mirror turned to the wall, and a clock that is always four minutes slow.', 'A tidy house with a smell of lavender over something older; every guest says they heard their name in the night.'],
    patronsKind: ['a nervous gravedigger', 'a travelling medium', 'a witness who does not like to talk', 'a priest on a long errand', 'a local who has outlived three landlords', 'a student of the occult', 'a hooded stranger who does not touch the drink', 'a child who should not be there'],
  },
};
const PATRON_TRAIT = ['is telling the same story for the third time tonight', 'is nursing one drink and watching the door', 'has a bandaged hand and a nervous smile', 'is writing a letter and crossing most of it out', 'is trying to sell a map to anyone who will look', 'is very drunk and very polite', 'has coin and wants to lose it at cards', 'is asleep in the corner, probably', 'keeps looking at the party\'s weapons', 'is humming the same four notes'];
const ROOM_KINDS: [string, number][] = [['floor space by the fire', 4], ['a bed in a shared room', 8], ['a private room', 50], ['the best room, with a view and a lock', 120]];
const TRUTH = ['true', 'half-true', 'false', 'true but old', 'exaggerated'];

export interface TavernOpts { flavour?: string; size?: string; partyLevel?: number; seed?: string | number; locks?: Record<string, unknown>; world?: WorldInfo; coins?: string }
export interface TavernResult {
  seed: string; flavour: string; size: string; fields: Record<string, string>;
  owner: NpcResult; map: MapResult; rumourTruth: string[];
}
const lockStr = (locks: Record<string, unknown> | undefined, k: string): string | undefined => { const v = locks?.[k]; return typeof v === 'string' && v.trim() ? v.trim().slice(0, 2000) : undefined; };

export function genTavern(o: TavernOpts = {}): TavernResult {
  const seed = seedOf(o.seed);
  // Empty (a save that only passed the kind and the seed) means the default, as when it was generated.
  const flavour = String(o.flavour ?? '').toLowerCase().trim().replace(/^(undefined|null)$/, '') || 'common';
  if (!(TAVERN_PRESETS as readonly string[]).includes(flavour)) throw new RangeError(`flavour must be one of ${TAVERN_PRESETS.join(', ')}`);
  const size = o.size === 'small' || o.size === 'large' ? o.size : 'medium';
  const coins = o.coins ?? o.world?.coins ?? 'gsc';
  const locks = o.locks && typeof o.locks === 'object' ? o.locks : {};
  const r = makeRng(`${seed}|tavern|${flavour}`);
  const menu = MENUS[flavour];
  const avoid = o.world?.titles;

  const name = lockStr(locks, 'name') ?? placeName('tavern', flavour, r, avoid);
  // owner: race follows the flavour where it makes sense
  const ownerRace = flavour === 'dwarven' ? 'dwarf' : flavour === 'elven' ? 'elf' : flavour === 'pirate' ? pick(r, ['human', 'half-orc', 'tiefling', 'dragonborn']) : flavour === 'haunted' ? pick(r, ['human', 'halfling', 'tiefling']) : pick(r, ['human', 'halfling', 'half-elf', 'dwarf', 'gnome']);
  const owner = genNpc({ preset: 'tavern-keeper', race: ownerRace, seed: `${seed}|owner`, world: o.world });
  const atmosphere = lockStr(locks, 'atmosphere') ?? pick(r, menu.look);
  const take = <T,>(a: T[], n: number): T[] => { const pool = [...a]; const out: T[] = []; while (out.length < n && pool.length) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]); return out; };
  const line = ([n, cp]: Item) => `- ${n}: ${priceText(cp, coins)}`;
  const menuText = lockStr(locks, 'menu') ?? [`**Drinks**`, ...take(menu.drinks, 4).map(line), '', `**Food**`, ...take(menu.food, 4).map(line)].join('\n');
  const roomsText = lockStr(locks, 'rooms') ?? ROOM_KINDS.map(([n, cp]) => `- ${n.charAt(0).toUpperCase()}${n.slice(1)}: ${priceText(Math.round(cp * (flavour === 'elven' ? 2 : 1)), coins)} a night`).join('\n');
  const patrons = lockStr(locks, 'patrons') ?? take(menu.patronsKind, 4).map((k) => {
    const g = genNames({ race: flavour === 'dwarven' ? 'dwarf' : flavour === 'elven' ? 'elf' : 'any', count: 1, seed: `${seed}|p|${k}` }).names[0];
    return `- ${g?.name ?? 'A patron'}, ${k}, ${pick(r, PATRON_TRAIT)}.`;
  }).join('\n');
  // rumours: the party's own knowledge when the world has any, else tables
  const rumourTruth: string[] = [];
  const rumourLines: string[] = [];
  const known = o.world?.rumours ?? [];
  for (let i = 0; i < 3; i++) {
    const t = pick(r, TRUTH);
    if (known.length && i < known.length && chance(r, 0.7)) rumourLines.push(`- "They say ${known[int(r, 0, known.length - 1)].replace(/[.]+$/, '').replace(/^./, (c) => c.toLowerCase())}."`);
    else rumourLines.push(`- "${pick(r, ST.RUMOUR_SUBJECT).replace(/^./, (c) => c.toUpperCase())} ${pick(r, ST.RUMOUR_DEED)}, ${pick(r, [ST.RUMOUR_COLOUR_MUNDANE, ST.RUMOUR_COLOUR_OMINOUS, ST.RUMOUR_COLOUR_HOPEFUL][int(r, 0, 2)])}."`);
    rumourTruth.push(t);
  }
  const map = genMap('tavern', { seed: `${seed}|map`, size, flavour: (TAVERN_FLAVOURS as readonly string[]).includes(flavour) ? flavour : 'common', title: name });
  const fields: Record<string, string> = { name, atmosphere, menu: menuText, rooms: roomsText, patrons, rumours: lockStr(locks, 'rumours') ?? rumourLines.join('\n') };
  void ST;
  return { seed, flavour, size, fields, owner, map, rumourTruth };
}
