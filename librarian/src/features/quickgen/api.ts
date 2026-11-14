// The generators other features import (Sculpting, the item card, ...).
//
//   genNames({ race, gender, count, seed, style })        -> { seed, names: [{ name, given, family, race, gender }] }
//   genItems(db, worldId, { rarity, type, count, seed })   -> { seed, items: [{ name, rarity, type, priceGp, termId, pageId, ... }] }
//   genCoins({ mode, level | cr, seed, coins })            -> { pp, gp, ep, sp, cp, totalCp, text, ... }
//
// All are deterministic for a given seed and throw RangeError on a bad
// argument. No model is called.
export { genNames, RACES, GENDERS, isOffensive } from './names.ts';
export type { GeneratedName, NamesOpts, NamesResult, Race, Gender, NameStyle } from './names.ts';
export { genItems, RARITIES, ALL_RARITIES, TYPES, PRICE_BANDS, priceFor } from './items.ts';
export type { GeneratedItem, ItemOpts, ItemsResult, Rarity, ItemType } from './items.ts';
export { genCoins, coinText, tierOf } from './coins.ts';
export type { CoinOpts, CoinResult, CoinMode, CoinSetting } from './coins.ts';
export { makeRng } from './rng.ts';
