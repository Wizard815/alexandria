// Names for places and businesses: taverns, inns, towns, guilds, magic shops
// (and a few more). Our own word lists, shaped by a flavour (dwarven, elven,
// pirate, haunted, dark ...). Same seed, same names; no repeats in a batch; names
// already used in this world's library are skipped; the offensive-word filter
// from the person-name generator applies here too.
import { chance, makeRng, pick, seedOf, type Rng } from '../quickgen/rng.ts';
import { isOffensive } from '../quickgen/names.ts';

export const PLACE_KINDS = ['tavern', 'inn', 'town', 'guild', 'magic shop', 'smithy', 'temple', 'keep', 'dungeon'] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];
export const PLACE_FLAVOURS = ['common', 'dwarven', 'elven', 'pirate', 'haunted', 'dark'] as const;
export type PlaceFlavour = (typeof PLACE_FLAVOURS)[number];

interface Words { adj: string[]; noun: string[]; thing: string[] }
const COMMON: Words = {
  adj: ['Gilded', 'Laughing', 'Limping', 'Rusty', 'Sleeping', 'Wandering', 'Crooked', 'Silver', 'Hungry', 'Merry', 'Weeping', 'Brass', 'Drunken', 'Lucky', 'Quiet', 'Red', 'Golden', 'Green', 'Blind', 'Humble', 'Broken', 'Winking', 'Dancing', 'Black'],
  noun: ['Anchor', 'Badger', 'Crown', 'Dragon', 'Goose', 'Heron', 'Lantern', 'Mermaid', 'Otter', 'Pike', 'Stag', 'Tankard', 'Kettle', 'Fiddle', 'Plough', 'Raven', 'Thistle', 'Cartwheel', 'Barrel', 'Compass', 'Hound', 'Lamb', 'Oak', 'Swan'],
  thing: ['Rest', 'Arms', 'Hearth', 'Table', 'Cup', 'Door', 'Corner', 'Lodge', 'Landing', 'Bench'],
};
const DWARVEN: Words = {
  adj: ['Deep', 'Iron', 'Stout', 'Granite', 'Anvil', 'Copper', 'Rune', 'Bearded', 'Hammered', 'Hollow', 'Foaming', 'Gilt', 'Slate', 'Ember'],
  noun: ['Mug', 'Hammer', 'Anvil', 'Cask', 'Pick', 'Forge', 'Stein', 'Vault', 'Delve', 'Axe', 'Helm', 'Cairn', 'Ingot', 'Keg'],
  thing: ['Hall', 'Hold', 'Tap', 'Delve', 'Deeps', 'Barrel', 'Bar', 'Gate'],
};
const ELVEN: Words = {
  adj: ['Silver', 'Moonlit', 'Whispering', 'Evening', 'Dewy', 'Amber', 'Quiet', 'Sunlit', 'Willow', 'Starlit', 'Gentle', 'Verdant'],
  noun: ['Bough', 'Leaf', 'Song', 'Glade', 'Willow', 'Dawn', 'Mist', 'Stag', 'Lark', 'Harp', 'Fern', 'Moth', 'Petal', 'Brook'],
  thing: ['Bower', 'Rest', 'Pavilion', 'Glen', 'Hollow', 'Terrace', 'Arbour', 'Grove'],
};
const PIRATE: Words = {
  adj: ['Salty', 'Drowned', 'Leaky', 'Scarlet', 'Barnacled', 'Grinning', 'Smuggler\'s', 'Cursed', 'Windward', 'Storm-tossed', 'One-eyed', 'Plundered'],
  noun: ['Anchor', 'Kraken', 'Mermaid', 'Cutlass', 'Parrot', 'Gull', 'Rum Barrel', 'Rope', 'Compass', 'Figurehead', 'Wreck', 'Cannon', 'Tide'],
  thing: ['Landing', 'Cove', 'Deck', 'Berth', 'Wharf', 'Hold', 'Galley', 'Bilge'],
};
const HAUNTED: Words = {
  adj: ['Pale', 'Hollow', 'Weeping', 'Last', 'Midnight', 'Whispering', 'Shrouded', 'Forgotten', 'Waning', 'Cold', 'Restless', 'Grey'],
  noun: ['Lantern', 'Widow', 'Candle', 'Raven', 'Bell', 'Shade', 'Hearse', 'Coffin', 'Owl', 'Mourner', 'Gallows', 'Wraith'],
  thing: ['Rest', 'Vigil', 'Corner', 'Haunt', 'Wake', 'Hearth', 'Lodging', 'Cellar'],
};
const DARK: Words = {
  adj: ['Black', 'Bleeding', 'Ashen', 'Blighted', 'Grim', 'Dread', 'Hollow', 'Sunless', 'Wretched', 'Barbed', 'Thorned', 'Iron'],
  noun: ['Fang', 'Crow', 'Thorn', 'Chain', 'Ember', 'Knife', 'Skull', 'Wolf', 'Cairn', 'Veil', 'Spire', 'Pyre'],
  thing: ['Rest', 'Den', 'Hold', 'Pit', 'Reach', 'Watch', 'Refuge', 'End'],
};
const WORDS: Record<PlaceFlavour, Words> = { common: COMMON, dwarven: DWARVEN, elven: ELVEN, pirate: PIRATE, haunted: HAUNTED, dark: DARK };

const TOWN_A: Record<PlaceFlavour, string[]> = {
  common: ['Ash', 'Bell', 'Briar', 'Cinder', 'Dun', 'Elder', 'Fen', 'Gull', 'Hallow', 'Kettle', 'Lantern', 'Moss', 'North', 'Oak', 'Pike', 'Quill', 'Raven', 'Salt', 'Thistle', 'West', 'Willow', 'Marrow', 'Harrow', 'Stone'],
  dwarven: ['Kaz', 'Dur', 'Thor', 'Bar', 'Grim', 'Ore', 'Slate', 'Iron', 'Deep', 'Gran', 'Mor', 'Rune'],
  elven: ['Ael', 'Sil', 'Lor', 'Fae', 'Ith', 'Mel', 'Vael', 'Thal', 'Cael', 'Elu', 'Nar', 'Ari'],
  pirate: ['Skull', 'Rum', 'Cutlass', 'Storm', 'Gull', 'Brine', 'Reef', 'Black', 'Salt', 'Tide', 'Wreck', 'Anchor'],
  haunted: ['Gloam', 'Mourn', 'Hollow', 'Wither', 'Pale', 'Dusk', 'Grave', 'Whisper', 'Cold', 'Mist', 'Dim', 'Sorrow'],
  dark: ['Blight', 'Gall', 'Dread', 'Grim', 'Bone', 'Cinder', 'Rot', 'Vex', 'Sable', 'Ruin', 'Gore', 'Nox'],
};
const TOWN_B: Record<PlaceFlavour, string[]> = {
  common: ['barrow', 'brook', 'combe', 'cross', 'ford', 'gate', 'haven', 'holm', 'mere', 'moor', 'port', 'stead', 'wick', 'worth', 'vale', 'watch', 'bury', 'field'],
  dwarven: ['heim', 'dun', 'hold', 'delve', 'gard', 'forge', 'kaz', 'peak', 'deep', 'mar'],
  elven: ['wen', 'ael', 'thil', 'dor', 'iel', 'loth', 'riel', 'vale', 'glen', 'ris'],
  pirate: ['cove', 'haven', 'bay', 'point', 'reach', 'spit', 'harbour', 'quay', 'rock', 'wash'],
  haunted: ['fall', 'moor', 'wick', 'hollow', 'wake', 'mere', 'barrow', 'reach', 'stead', 'vale'],
  dark: ['moor', 'hold', 'gate', 'fall', 'spire', 'reach', 'maw', 'wick', 'cairn', 'watch'],
};

const GUILD_A = ['Guild of', 'Brotherhood of', 'Company of', 'Order of', 'Society of', 'League of', 'Circle of', 'Fellowship of', 'Concord of'];
const GUILD_B = ['the Ashen Hand', 'the Lantern Road', 'the Gilded Knife', 'the Silent Tide', 'the Black Loom', 'the Open Ledger', 'the Seventh Key', 'the Bitter Cup', 'the Hollow Crown', 'the Iron Quill', 'the Amber Scale', 'the Fallen Star', 'the Sworn Hammers', 'the Midnight Bell', 'the Patient Spider', 'Honest Coin', 'Tide and Tar', 'the Thousand Doors'];
const SHOP_FORMS = [
  (r: Rng, w: string[][]) => `${pick(r, w[0])} ${pick(r, w[1])}`,
  (r: Rng, w: string[][]) => `The ${pick(r, w[0])} ${pick(r, w[2])}`,
  (r: Rng, w: string[][]) => `${pick(r, w[3])}'s ${pick(r, w[1])}`,
  (r: Rng, w: string[][]) => `${pick(r, w[1])} & ${pick(r, w[1])}`,
];
const MAGIC_ADJ = ['Curious', 'Glimmering', 'Peculiar', 'Gilded', 'Whispering', 'Eldritch', 'Twice-Told', 'Moonlit', 'Singing', 'Hidden', 'Borrowed', 'Starlit', 'Wandering', 'Tarnished'];
const MAGIC_NOUN = ['Cauldron', 'Quill', 'Lantern', 'Phial', 'Wand', 'Sigil', 'Orrery', 'Grimoire', 'Hourglass', 'Candle', 'Compass', 'Thimble', 'Mirror', 'Key', 'Scroll', 'Charm'];
const MAGIC_THING = ['Emporium', 'Curios', 'Cabinet', 'Apothecary', 'Exchange', 'Parlour', 'Atelier', 'Bazaar', 'Repository'];
const KEEPER_NAMES = ['Mabry', 'Orsolo', 'Vess', 'Tamsin', 'Quillon', 'Hesper', 'Borin', 'Ysolde', 'Dorrick', 'Maud', 'Ferrin', 'Lysa', 'Corvin', 'Peg', 'Alder'];
const SMITH_A = ['Red', 'Hammer', 'Anvil', 'Cinder', 'Iron', 'Bright', 'Slag', 'Steel', 'Coal', 'Spark'];
const SMITH_B = ['mark', 'works', 'forge', 'fire', 'strike', 'bellows', 'edge', 'wright', 'temper', 'hearth'];
const TEMPLE_A = ['Shrine of', 'Chapel of', 'Temple of', 'Sanctum of', 'Abbey of', 'House of'];
const TEMPLE_B = ['the Quiet Dawn', 'the Patient Flame', 'the Bright Scale', 'the Open Hand', 'the Evening Star', 'the Deep Well', 'Gentle Rains', 'the Last Lamp', 'the Weeping Saint', 'the Seven Bells'];
const KEEP_A = ['Castle', 'Fort', 'Tower', 'Keep', 'Citadel'];
const DUNGEON_A = ['Vault', 'Undercroft', 'Warrens', 'Depths', 'Catacombs', 'Barrows', 'Hollows', 'Crypt', 'Mines', 'Delve'];
const DUNGEON_B = ['the Sunken King', 'Forgotten Names', 'the Weeping Stone', 'the Ninth Lamp', 'Ashen Oaths', 'the Drowned Choir', 'Old Teeth', 'the Last Warden', 'Broken Vows', 'the Pale Mother', 'Sleeping Iron', 'the Hungry Dark'];

function oneName(kind: PlaceKind, flavour: PlaceFlavour, r: Rng): string {
  const w = WORDS[flavour];
  const ta = TOWN_A[flavour], tb = TOWN_B[flavour];
  switch (kind) {
    case 'tavern':
    case 'inn': {
      const roll = r();
      if (roll < 0.5) return `The ${pick(r, w.adj)} ${pick(r, w.noun)}`;
      if (roll < 0.75) return `The ${pick(r, w.noun)} and ${pick(r, w.noun)}`;
      if (roll < 0.9) return `${pick(r, w.noun)}'s ${pick(r, w.thing)}`;
      return `The ${pick(r, w.noun)}'s ${pick(r, w.thing)}`;
    }
    case 'town': { const a = pick(r, ta), b = pick(r, tb); return chance(r, 0.15) ? `${a}${b} on the ${pick(r, ['Water', 'Hill', 'Marsh', 'Wold', 'Green'])}` : `${a}${b}`; }
    case 'guild': return `${pick(r, GUILD_A)} ${pick(r, GUILD_B)}`;
    case 'magic shop': return SHOP_FORMS[Math.floor(r() * SHOP_FORMS.length)](r, [MAGIC_ADJ, MAGIC_NOUN, MAGIC_THING, KEEPER_NAMES]);
    case 'smithy': return chance(r, 0.5) ? `${pick(r, SMITH_A)}${pick(r, SMITH_B)}` : `${pick(r, KEEPER_NAMES)}'s ${pick(r, ['Forge', 'Anvil', 'Smithy', 'Ironworks'])}`;
    case 'temple': return `${pick(r, TEMPLE_A)} ${pick(r, TEMPLE_B)}`;
    case 'keep': return `${pick(r, KEEP_A)} ${pick(r, ta)}${pick(r, tb)}`;
    case 'dungeon': return `The ${pick(r, DUNGEON_A)} of ${pick(r, DUNGEON_B)}`;
  }
}

export interface PlaceNamesOpts { kind?: string; flavour?: string; count?: number; seed?: string | number; avoid?: Iterable<string> }
export interface PlaceNamesResult { seed: string; kind: PlaceKind; flavour: PlaceFlavour; names: string[] }

/** Place and business names. `avoid` holds titles to skip (any case). Throws RangeError on a bad kind or flavour. */
export function genPlaceNames(o: PlaceNamesOpts = {}): PlaceNamesResult {
  const kind = String(o.kind ?? 'tavern').toLowerCase().replace(/[-_]+/g, ' ') as PlaceKind;
  if (!(PLACE_KINDS as readonly string[]).includes(kind)) throw new RangeError(`kind must be one of ${PLACE_KINDS.join(', ')}`);
  const flavour = String(o.flavour ?? 'common').toLowerCase() as PlaceFlavour;
  if (!(PLACE_FLAVOURS as readonly string[]).includes(flavour)) throw new RangeError(`flavour must be one of ${PLACE_FLAVOURS.join(', ')}`);
  const count = Math.max(1, Math.min(200, Math.floor(Number(o.count ?? 8)) || 8));
  const seed = seedOf(o.seed);
  const r = makeRng(seed);
  const avoid = new Set([...(o.avoid ?? [])].map((s) => String(s).toLowerCase().trim()));
  const seen = new Set<string>();
  const names: string[] = [];
  for (let i = 0; names.length < count && i < count * 40 + 100; i++) {
    const n = oneName(kind, flavour, r);
    const key = n.toLowerCase();
    if (seen.has(key) || avoid.has(key) || isOffensive(n)) continue;
    seen.add(key);
    names.push(n);
  }
  return { seed, kind, flavour, names };
}

/** One name, for the other generators (a map's title, a tavern's name). */
export const placeName = (kind: PlaceKind, flavour: string, r: Rng, avoid?: Set<string>): string => {
  const f = (PLACE_FLAVOURS as readonly string[]).includes(flavour) ? (flavour as PlaceFlavour) : 'common';
  for (let i = 0; i < 30; i++) {
    const n = oneName(kind, f, r);
    if (!isOffensive(n) && !avoid?.has(n.toLowerCase())) return n;
  }
  return oneName(kind, f, r);
};
