// The shop generator: from a kind, a settlement size and the party's level
// (and an optional theme), stock drawn from the world's item database, a
// shopkeeper from the NPC generator, a markup and a haggle note. Tables and
// code only; the same seed gives the same shop. A chat model, when asked and
// set, only rewrites the wording (the description and the keeper's
// personality), never the stock or the prices.
//
// Rarity follows both the settlement and the party (whichever is lower):
//   settlement  hamlet common | village uncommon | town rare | city very rare | metropolis legendary
//   party level 1-4 uncommon | 5-10 rare | 11-16 very rare | 17-20 legendary
// Items with no price (artifacts, "rarity varies") are never stocked.
//
// `guide` (optional) is text that steers a shop: a GM's template or a few
// instructions. Offline, its words weigh the draw like a theme, and plain
// directives are read: "12 items", "markup 20%", "discount 10%", "no magic",
// "max rarity rare". With a model it is also given to the model as the brief.
import type { Deps } from '../../app.ts';
import { type DB, all } from '../../core/db.ts';
import { chatJson, hasJob } from '../../core/ai.ts';
import { HttpError } from '../../core/util.ts';
import { chance, int, makeRng, pick, seedOf } from '../quickgen/rng.ts';
import { genNpc } from '../generators/npc.ts';
import { placeName } from '../generators/names.ts';
import { loadWorld } from '../generators/world.ts';
import { enabledIds } from '../modules/store.ts';
import { ensureSeeded, MAGIC_ORDER, type ItemRow } from './items.ts';
import { KIND_LABEL, SHOP_KINDS, type Keeper, type ShopKind } from './shops.ts';

export const SIZES = ['hamlet', 'village', 'town', 'city', 'metropolis'] as const;
export type Size = (typeof SIZES)[number];
const RANK: Record<string, number> = { mundane: 0, common: 1, uncommon: 2, rare: 3, 'very rare': 4, legendary: 5 };
const SIZE_CAP: Record<Size, number> = { hamlet: 1, village: 2, town: 3, city: 4, metropolis: 5 };
const SIZE_COUNT: Record<Size, number> = { hamlet: 6, village: 9, town: 12, city: 16, metropolis: 20 };
const SIZE_MARKUP: Record<Size, number> = { hamlet: 10, village: 5, town: 0, city: 0, metropolis: -5 };
export const levelCap = (level: number) => (level >= 17 ? 5 : level >= 11 ? 4 : level >= 5 ? 3 : 2);

export interface ShopOpts { kind?: string; size?: string; level?: number | string; theme?: string; seed?: string | number; count?: number | string; name?: string; enrich?: boolean; flavour?: string }
export interface DraftLine { itemId: string; name: string; type: string; rarity: string; costCp: number | null; priceCp: number | null; qty: number | null; hidden: boolean }
export interface ShopDraft {
  seed: string; kind: ShopKind; kindLabel: string; size: Size; level: number; theme: string; maxRarity: string;
  name: string; description: string; keeper: Keeper; markupPct: number; haggle: string; dmNotes: string; stock: DraftLine[];
  /** The keeper's purse in copper (what they can pay for things players sell) and how far they will haggle, in percent. */
  goldCp: number; barterPct: number;
  poolSize: number; enriched: boolean; guided: boolean; notes: string[];
}

const NAME_KIND: Record<ShopKind, 'magic shop' | 'smithy' | 'tavern' | 'guild'> = { general: 'guild', blacksmith: 'smithy', weaponsmith: 'smithy', armorer: 'smithy', alchemist: 'magic shop', enchanter: 'magic shop', magic: 'magic shop', curio: 'guild', tavern: 'tavern', fence: 'guild' };
const CURIO_NAMES = ['Curiosities', 'Trinkets', 'Oddments', 'Knick-knacks', 'Wonders', 'Baubles'];
/** The keeper's purse by settlement, in gold; a kind multiplies it. */
const SIZE_GOLD: Record<Size, number> = { hamlet: 40, village: 150, town: 800, city: 4000, metropolis: 15000 };
const KIND_GOLD: Record<ShopKind, number> = { general: 1, blacksmith: 1.5, weaponsmith: 1.5, armorer: 2, alchemist: 1.5, enchanter: 4, magic: 5, curio: 0.8, tavern: 0.5, fence: 2 };
/** How far a keeper of this kind will haggle, in percent (before reputation). */
const KIND_BARTER: Record<ShopKind, [number, number]> = { general: [8, 15], blacksmith: [5, 12], weaponsmith: [5, 12], armorer: [5, 10], alchemist: [5, 15], enchanter: [3, 8], magic: [0, 6], curio: [10, 25], tavern: [0, 8], fence: [15, 30] };
const GENERAL_NAMES = ['Provisions', 'Sundries', 'Goods', 'Supply', 'Trading Post', 'Mercantile', 'Outfitters'];
const ALCH_NAMES = ['Apothecary', 'Alembic', 'Tinctures', 'Remedies', 'Still', 'Phial'];
const FENCE_NAMES = ['Curios', 'Second-hand Goods', 'Pawnshop', 'Bric-a-brac', 'Odds and Ends', 'Salvage'];
const NPC_PRESET: Record<ShopKind, string> = { general: 'shopkeeper', blacksmith: 'dwarf', weaponsmith: 'dwarf', armorer: 'dwarf', alchemist: 'shopkeeper', enchanter: 'wizard', magic: 'wizard', curio: 'shopkeeper', tavern: 'tavern-keeper', fence: 'rogue' };
const ROLE: Record<ShopKind, string[]> = {
  general: ['general-store owner', 'shopkeeper', 'trader'], blacksmith: ['blacksmith', 'armourer', 'weaponsmith'], alchemist: ['alchemist', 'apothecary', 'herbalist'],
  weaponsmith: ['weaponsmith', 'bladesmith', 'bowyer and fletcher'], armorer: ['armorer', 'mail-maker', 'shieldwright'], enchanter: ['enchanter', 'runecarver', 'arcane artificer'], curio: ['curio dealer', 'trinket seller', 'collector of oddities'],
  magic: ['curio dealer', 'enchanter', 'arcane trader'], tavern: ['tavern keeper', 'innkeeper', 'cellarer'], fence: ['pawnbroker', 'fence', 'dealer in second-hand goods'],
};
const DESC: Record<ShopKind, string[]> = {
  general: ['Shelves to the rafters: rope, lamp oil, sacks of flour and a barrel of nails by the door.', 'A long counter, a brass bell and a smell of tallow, leather and dried apples.', 'Crates stacked in the yard and a ledger chained to the counter.'],
  blacksmith: ['The forge roars at the back; finished blades hang on pegs along the wall.', 'An open-fronted smithy, hot as summer, with a rack of helms and a water trough hissing.', 'Racks of spears, a dented anvil and a bench of mail being mended link by link.'],
  alchemist: ['Coloured glass catches the light; something on a low flame smells of cloves and sulphur.', 'Jars of dried things, a skull with a candle on it and a cat that watches every hand.', 'A narrow shop of drawers, each labelled in a careful, tiny hand.'],
  magic: ['Glass cases, a ticking clock that runs backwards and a door that is larger inside.', 'Velvet-lined drawers, a smell of ozone and a bell that rings a moment before anyone touches it.', 'Shelves of odd things under dust sheets; the owner only uncovers what a customer can afford.'],
  tavern: ['A hatch beside the bar sells travel food, candles and a few things left by guests.', 'Behind the taproom, a pantry door opens onto a small counter of road supplies.', 'The landlord keeps a cupboard of useful odds for travellers, priced in chalk on a slate.'],
  fence: ['A cluttered pawnshop where nothing has a label and everything has a story.', 'A back room behind a cobbler\'s, reached by a knock in a certain rhythm.', 'Tables of second-hand goods in front; the better pieces are kept somewhere else.'],
  weaponsmith: ['Blades on every wall, bows strung along the rafters, and a grindstone that never stops.', 'A long, narrow forge where every sword is tested on a straw man before it is sold.', 'Spears in barrels, axes on hooks and a target out back for trying a bow.'],
  armorer: ['Suits of mail on wooden stands watch the door like a row of silent guards.', 'Hammer on steel all day; helms, gauntlets and shields cover every bench.', 'A fitting room with a mirror and a rack of padded gambesons in every size.'],
  enchanter: ['Runes glow faintly on the counter; a half-finished ring turns slowly in the air.', 'A quiet workshop of chalk circles, silver wire and humming glass.', 'Scrolls in pigeonholes, wands in velvet and a smell of hot copper.'],
  curio: ['Every shelf is a jumble: music boxes, glass eyes, bent spoons and a stuffed owl.', 'Tiny drawers floor to ceiling, each holding one odd and wonderful thing.', 'A bell over the door that plays a different note for every customer.'],
};
const HAGGLE: Record<ShopKind, string[]> = {
  general: ['Knocks 5% off for a regular, or for news from the road (Persuasion DC 12).', 'Will not haggle over food; will over anything else (DC 13).', 'Gives a discount to anyone who buys three things or more.'],
  blacksmith: ['Respects anyone who knows steel: 10% off with a good Smith\'s Tools or Athletics check (DC 14).', 'Never haggles; offers a free sharpening instead.', 'Takes trade-ins of old weapons at a third of their value.'],
  alchemist: ['Will trade a potion for a rare ingredient of equal value.', 'Haggles happily, but always ends where they started (DC 15 to win 10%).', 'Gives 10% off if the buyer tells what the potion is for.'],
  magic: ['Insulted by haggling: the price goes up 10% on a failed Persuasion (DC 16).', 'Will lower a price for a favour, never for coin.', 'Accepts spell scrolls and components as part payment.'],
  tavern: ['Throws in a drink with any purchase over 1 gp.', 'Will haggle only after the second drink (DC 10).', 'Prices are what is chalked up; no exceptions.'],
  weaponsmith: ['Will knock 10% off for anyone who can show real skill with the blade (Athletics or a weapon check, DC 13).', 'Haggles over arrows, never over swords.', 'Takes old weapons in trade at a third of their value.'],
  armorer: ['Prices are fixed, but a fitting is free and so is mending dents for a month.', 'Will haggle 10% for a soldier or guard (DC 12 with proof).', 'Refuses to sell to anyone who insults the craft.'],
  enchanter: ['Prices are set by the guild; a favour or a rare component can change them.', 'Gives 5% off to a fellow spellcaster (Arcana DC 15).', 'Will enchant an item the party brings, for the price of the scroll plus a fee.'],
  curio: ['Loves to haggle and loses on purpose to anyone who tells a good story (DC 10).', 'Every price is a guess; the keeper goes down fast if pushed (DC 11).', 'Trades one trinket for another of any kind, no coin needed.'],
  fence: ['Asks no questions and expects none (Insight DC 14 shows the price is padded 20%).', 'Buys stolen goods at a quarter of their value; sells at full.', 'Haggles hard (DC 15); a failed attempt means the item is suddenly "promised to someone else".'],
};
const PERSONALITY = ['Talks prices as if they were poetry.', 'Suspicious of anyone who pays too quickly.', 'Cheerful, nosy and impossible to rush.', 'Says little, notices everything, remembers faces.', 'Proud of their goods and offended by bargain hunters.', 'Gossips while wrapping every purchase.', 'Tired, honest and short with time-wasters.', 'Charming in a way that makes customers count their coins twice.'];

/** How much an item fits a kind of shop (0 = never stocked there). */
function fit(kind: ShopKind, it: ItemRow): number {
  const n = it.name.toLowerCase();
  const magic = it.rarity !== 'mundane';
  switch (kind) {
    case 'general':
      if (magic) return it.type === 'potion' && /healing/.test(n) ? 1 : 0;
      return ({ gear: 3, food: 2, tool: 1, ammunition: 1, weapon: 0.3 } as Record<string, number>)[it.type] ?? 0;
    case 'blacksmith':
      if (['weapon', 'armor', 'shield'].includes(it.type)) return magic ? 0.6 : 3;
      if (it.type === 'ammunition') return magic ? 0.3 : 1.5;
      if (it.type === 'tool' && /smith|tinker|mason/.test(n)) return 1;
      if (it.type === 'gear' && /chain|crowbar|hammer|piton|caltrop|ball bearing|manacle|lock|spike|shovel|pick/.test(n)) return 0.5;
      return 0;
    case 'alchemist':
      if (it.type === 'potion') return 3;
      if (it.type === 'gear' && /acid|alchemist|antitoxin|oil|perfume|vial|flask|healer|poison|holy water|ink|soap|bottle|component/.test(n)) return 2;
      if (it.type === 'tool' && /alchemist|herbalism|poisoner|brewer/.test(n)) return 1;
      return 0;
    case 'magic':
      if (!magic) return it.type === 'gear' && /arcane focus|crystal|orb|spellbook|component|wand|rod|staff|ink|parchment|focus/.test(n) ? 0.6 : 0;
      return ({ 'wondrous item': 3, ring: 2, wand: 2, scroll: 2, potion: 2, staff: 1, rod: 1, weapon: 1, armor: 0.8, shield: 0.6, ammunition: 0.6 } as Record<string, number>)[it.type] ?? 0.5;
    case 'tavern':
      if (it.type === 'food') return 3;
      if (magic) return it.type === 'potion' && /healing/.test(n) ? 0.8 : 0;
      if (it.type === 'gear' && /ration|waterskin|candle|torch|lamp|oil|bedroll|blanket|tinderbox|soap|flask|jug|mug|tankard|pouch|sack|backpack|dice|playing card|rope/.test(n)) return 2;
      return 0;
    case 'fence':
      if (it.type === 'mount' || it.type === 'food') return 0;
      return magic ? 0.8 : 1;
    case 'weaponsmith':
      if (it.type === 'weapon') return magic ? 0.6 : 3;
      if (it.type === 'ammunition') return magic ? 0.4 : 2;
      if (it.type === 'tool' && /smith|fletcher|bowyer/.test(n)) return 0.5;
      if (it.type === 'gear' && /quiver|sheath|scabbard|whetstone|case, crossbow/.test(n)) return 0.8;
      return 0;
    case 'armorer':
      if (it.type === 'armor') return magic ? 0.6 : 3;
      if (it.type === 'shield') return magic ? 0.6 : 2.5;
      if (it.type === 'tool' && /smith|leatherworker/.test(n)) return 0.5;
      return 0;
    case 'enchanter':
      if (!magic) return it.type === 'gear' && /arcane focus|crystal|orb|component|ink|parchment|focus|spellbook/.test(n) ? 0.5 : 0;
      return ({ ring: 3, wand: 2.5, staff: 2, rod: 2, 'wondrous item': 2, scroll: 1.5, weapon: 1.5, armor: 1.5, shield: 1, ammunition: 0.8, potion: 0.3 } as Record<string, number>)[it.type] ?? 0.5;
    case 'curio':
      if (magic) return it.rarity === 'common' ? (it.type === 'wondrous item' ? 2 : 0.6) : it.type === 'wondrous item' ? 0.4 : 0;
      if (it.type === 'tool' && /instrument|lute|flute|drum|horn|lyre|viol|bagpipes|dulcimer|pan flute|shawm|gaming|dice|card|disguise/.test(n)) return 1.5;
      if (it.type === 'gear') return /bell|chalk|mirror|whistle|perfume|ink|candle|signet|string|bead|vial|book|map|magnifying|hourglass|music|jewel|lock|sealing wax|abacus|spyglass|scale|tinderbox|incense|robe|costume|fine clothes/.test(n) ? 2 : 0.4;
      return 0;
  }
}

/** Directives read from a guide or a theme, offline. */
export function readGuide(text: string): { count?: number; markup?: number; noMagic?: boolean; maxRank?: number; words: string[] } {
  const t = text.toLowerCase();
  const out: ReturnType<typeof readGuide> = { words: [] };
  const c = /\b(\d{1,2})\s+(?:items?|things|lines|wares)\b/.exec(t); if (c) out.count = Number(c[1]);
  const m = /\bmarkup\s*(?:of|:|=)?\s*(-?\d{1,3})\s*%?/.exec(t); if (m) out.markup = Number(m[1]);
  const dsc = /\bdiscount\s*(?:of|:|=)?\s*(\d{1,2})\s*%?/.exec(t); if (dsc) out.markup = -Number(dsc[1]);
  if (/\bno magic|\bmundane only|\bnothing magical/.test(t)) out.noMagic = true;
  const mr = /\bmax(?:imum)?\s+rarity\s*(?:is|:|=)?\s*(very rare|uncommon|common|rare|legendary)/.exec(t); if (mr) out.maxRank = RANK[mr[1]];
  const STOP = new Set('the and with for that this from have only items item shop shops sell sells stock rarity max maximum markup discount magic make give some more less into their them they are was were will what when which very rare common uncommon legendary over under about like a an of to in on at by or no not'.split(' '));
  out.words = [...new Set((t.match(/[a-z][a-z'-]{2,}/g) ?? []).filter((w) => !STOP.has(w)))].slice(0, 30);
  return out;
}

const loadItems = (db: DB, worldId: string) => all<ItemRow>(db, 'SELECT * FROM shop_items WHERE world_id = ? ORDER BY name_key, id', worldId);

/**
 * Make a shop (not saved). `guide` steers it: see the header. Throws RangeError on a bad option.
 * The item database is filled from the SRD on first use, so a new world can generate at once.
 */
export async function generateShop(d: Deps, worldId: string, opts: ShopOpts = {}, guide?: string): Promise<ShopDraft> {
  const kind = String(opts.kind ?? 'general').toLowerCase().replace(/[\s_]+/g, '-').replace(/-shop$/, '').replace(/^tavern-?.*/, 'tavern').replace(/^(general-store|store)$/, 'general').replace(/^(smith|smithy)$/, 'blacksmith').replace(/^armou?rer$/, 'armorer').replace(/^(weapons?|bladesmith|bowyer|fletcher)$/, 'weaponsmith').replace(/^(apothecary|potions?|potion-maker|potion-making)$/, 'alchemist').replace(/^(enchant|enchanting|enchantment|enchantments|runesmith)$/, 'enchanter').replace(/^(trinkets?|curios?|curiosit(y|ies)|oddit(y|ies)|misc|miscellaneous)$/, 'curio') as ShopKind;
  if (!(SHOP_KINDS as readonly string[]).includes(kind)) throw new RangeError(`kind must be one of ${SHOP_KINDS.join(', ')}`);
  const size = String(opts.size ?? 'town').toLowerCase() as Size;
  if (!(SIZES as readonly string[]).includes(size)) throw new RangeError(`size must be one of ${SIZES.join(', ')}`);
  ensureSeeded(d.db, worldId, enabledIds(d.db, worldId));
  const world = await loadWorld(d, worldId).catch(() => null);
  const levelRaw = opts.level === undefined || opts.level === null || opts.level === '' ? world?.partyLevel ?? 3 : Number(opts.level);
  if (!Number.isFinite(levelRaw) || levelRaw < 1 || levelRaw > 20) throw new RangeError('level must be a whole number from 1 to 20');
  const level = Math.floor(levelRaw);
  const theme = String(opts.theme ?? '').trim().slice(0, 200);
  const g = readGuide(`${theme}\n${String(guide ?? '').slice(0, 4000)}`);
  const seed = seedOf(opts.seed);
  const r = makeRng(`${seed}|shop|${kind}|${size}|${level}`);
  const cap = Math.min(SIZE_CAP[size], levelCap(level), g.maxRank ?? 5, g.noMagic ? 0 : 5);
  const want = Math.max(1, Math.min(60, Math.floor(Number(opts.count ?? g.count ?? SIZE_COUNT[size])) || SIZE_COUNT[size]));
  const notes: string[] = [];

  // The pool: priced items that fit this kind and the rarity cap; theme words weigh triple.
  const pool: { it: ItemRow; w: number }[] = [];
  for (const it of loadItems(d.db, worldId)) {
    if (it.cost_cp === null) continue;
    const rank = RANK[it.rarity];
    if (rank === undefined || rank > cap) continue;
    let w = fit(kind, it);
    if (w <= 0) continue;
    if (rank > 0 && rank === cap && cap > 1) w *= 0.5;
    if (g.words.length) {
      const hay = `${it.name} ${it.category} ${it.tags} ${it.description.slice(0, 300)}`.toLowerCase();
      if (g.words.some((x) => hay.includes(x))) w *= 3;
    }
    pool.push({ it, w });
  }
  if (!pool.length) notes.push('No item in the item database fits this shop yet. Import items (Items page) or pick another kind.');

  // Weighted draw without repeats.
  const bag = pool.slice();
  const picked: ItemRow[] = [];
  while (picked.length < want && bag.length) {
    const total = bag.reduce((n, b) => n + b.w, 0);
    let x = r() * total;
    let i = 0;
    for (; i < bag.length - 1; i++) { x -= bag[i].w; if (x <= 0) break; }
    picked.push(bag[i].it);
    bag.splice(i, 1);
  }
  if (picked.length < want && pool.length) notes.push(`Only ${picked.length} items fit; the item database has no more of this kind.`);
  picked.sort((a, b) => (RANK[a.rarity] ?? 0) - (RANK[b.rarity] ?? 0) || a.name.localeCompare(b.name));

  const markupPct = g.markup ?? (kind === 'fence' ? int(r, -25, 10) : SIZE_MARKUP[size] + (kind === 'magic' ? 10 : 0) + int(r, -2, 2) * 5);
  const big = size === 'city' || size === 'metropolis';
  const stock: DraftLine[] = picked.map((it) => {
    const rank = RANK[it.rarity] ?? 0;
    let qty: number | null;
    if (rank === 0) qty = big && (it.type === 'gear' || it.type === 'food' || it.type === 'ammunition') && chance(r, 0.4) ? null : it.type === 'ammunition' ? int(r, 2, 6) : int(r, 1, big ? 10 : 5);
    else qty = rank === 1 ? int(r, 1, 4) : rank === 2 ? int(r, 1, 2) : 1;
    const priceCp = Math.max(0, Math.round((it.cost_cp! * (100 + markupPct)) / 100));
    // A fence keeps its best pieces under the counter: hidden from players until the GM shows them.
    const hidden = kind === 'fence' && rank >= 2 && chance(r, 0.6);
    return { itemId: it.id, name: it.name, type: it.type, rarity: it.rarity, costCp: it.cost_cp, priceCp, qty, hidden };
  });

  // The shopkeeper: the NPC generator, then shaped to the shop.
  const npc = genNpc({ preset: NPC_PRESET[kind], seed: `${seed}|keeper`, world: world ?? undefined, partyLevel: level });
  const role = pick(r, ROLE[kind]);
  const keeper: Keeper = {
    name: npc.fields.name, race: npc.fields.race, role, look: npc.fields.look, voice: npc.fields.voice, personality: pick(r, PERSONALITY),
    secret: [npc.fields.secret, npc.fields.want ? `Wants ${npc.fields.want.charAt(0).toLowerCase()}${npc.fields.want.slice(1)}` : '', npc.fields.tie ?? ''].filter(Boolean).join(' '),
    pageId: null, seed: `${seed}|keeper`,
  };
  const avoid = world?.titles;
  let name = String(opts.name ?? '').trim().slice(0, 120);
  if (!name) {
    const first = keeper.name!.split(' ')[0];
    if (kind === 'general') name = `${first}'s ${pick(r, GENERAL_NAMES)}`;
    else if (kind === 'alchemist') name = chance(r, 0.5) ? `The ${placeName('magic shop', 'common', r, avoid).replace(/^The /, '')} ${pick(r, ALCH_NAMES)}` : `${first}'s ${pick(r, ALCH_NAMES)}`;
    else if (kind === 'fence') name = `${first}'s ${pick(r, FENCE_NAMES)}`;
    else if (kind === 'curio') name = `${first}'s ${pick(r, CURIO_NAMES)}`;
    else name = placeName(NAME_KIND[kind], String(opts.flavour ?? 'common'), r, avoid);
  }
  const goldCp = Math.round(SIZE_GOLD[size] * KIND_GOLD[kind] * (0.75 + r() * 0.5)) * 100;
  const barterPct = int(r, KIND_BARTER[kind][0], KIND_BARTER[kind][1]);
  const draft: ShopDraft = {
    seed, kind, kindLabel: KIND_LABEL[kind], size, level, theme, maxRarity: cap === 0 ? 'mundane' : MAGIC_ORDER[cap - 1],
    name, description: pick(r, DESC[kind]), keeper, markupPct, haggle: pick(r, HAGGLE[kind]),
    dmNotes: [`Generated: ${KIND_LABEL[kind].toLowerCase()} in a ${size}, party level ${level}${theme ? `, theme "${theme}"` : ''}, seed ${seed}.`, keeper.secret ? `Keeper's secret: ${keeper.secret}` : ''].filter(Boolean).join('\n'),
    stock, poolSize: pool.length, enriched: false, guided: !!guide?.trim(), notes, goldCp, barterPct,
  };
  if (opts.enrich && hasJob(d, 'chat')) return (await enrich(d, draft, guide)) ?? draft;
  return draft;
}

/** The model rewrites the wording only: description, look, voice, personality. Null when it fails or answers badly. */
async function enrich(d: Deps, draft: ShopDraft, guide?: string): Promise<ShopDraft | null> {
  const fields = { description: draft.description, look: draft.keeper.look ?? '', voice: draft.keeper.voice ?? '', personality: draft.keeper.personality ?? '' };
  try {
    const out = await chatJson<Record<string, unknown>>(d, 'chat', [
      { role: 'system', content: `You help the Game Master of a 5e tabletop role-playing game. Rewrite the given fields of a generated ${draft.kindLabel.toLowerCase()} and its keeper so they are vivid, specific and consistent, one or two sentences each. Do not invent prices, items or named people.${guide?.trim() ? ` Follow the GM's guide where it fits:\n${guide.trim().slice(0, 1500)}` : ''} Reply with JSON only, using exactly the keys given.` },
      { role: 'user', content: JSON.stringify({ shop: draft.name, keeper: `${draft.keeper.name}, ${draft.keeper.race} ${draft.keeper.role}`, theme: draft.theme, fields }) },
    ]);
    if (!out || typeof out !== 'object') return null;
    const v = (k: string) => { const x = (out as any)[k]; return typeof x === 'string' && x.trim() && x.length < 800 ? x.trim() : null; };
    const got = { description: v('description'), look: v('look'), voice: v('voice'), personality: v('personality') };
    if (!Object.values(got).some(Boolean)) return null;
    return { ...draft, description: got.description ?? draft.description, keeper: { ...draft.keeper, look: got.look ?? draft.keeper.look, voice: got.voice ?? draft.keeper.voice, personality: got.personality ?? draft.keeper.personality }, enriched: true };
  } catch { return null; }
}

/** A keeper on its own (the agent's create_shopkeeper, or "new keeper" on a shop). */
export async function generateKeeper(d: Deps, worldId: string, o: { kind?: string; seed?: string; race?: string; gender?: string } = {}): Promise<Keeper> {
  const kind = ((SHOP_KINDS as readonly string[]).includes(String(o.kind)) ? o.kind : 'general') as ShopKind;
  const seed = seedOf(o.seed);
  const world = await loadWorld(d, worldId).catch(() => null);
  let npc;
  try { npc = genNpc({ preset: NPC_PRESET[kind], seed, race: o.race, gender: o.gender, world: world ?? undefined }); } catch (e) { if (e instanceof RangeError) throw new HttpError(400, e.message); throw e; }
  const r = makeRng(`${seed}|keeper-extra`);
  return {
    name: npc.fields.name, race: npc.fields.race, role: pick(r, ROLE[kind]), look: npc.fields.look, voice: npc.fields.voice, personality: pick(r, PERSONALITY),
    secret: [npc.fields.secret, npc.fields.tie ?? ''].filter(Boolean).join(' '), pageId: null, seed,
  };
}

