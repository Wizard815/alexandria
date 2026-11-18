// The map generators. genMap(kind, opts) returns a canvas (drawn from shapes),
// a keyed list and some counts; toSvg / toPng in canvas.ts write the picture.
// Deterministic for a seed; no model is called.
import { genCastle } from './castle.ts';
import { genBattlemap } from './battlemap.ts';
import { genCave } from './cave.ts';
import { genForest } from './forest.ts';
import { genRegion } from './region.ts';
import { genCity } from './city.ts';
import { genTavernMap } from './tavern.ts';
import { genDungeon } from './dungeon.ts';
import { MAP_KINDS, type MapKind, type MapOpts, type MapResult } from './util.ts';

export { MAP_KINDS, SIZES } from './util.ts';
export type { KeyEntry, MapKind, MapOpts, MapResult } from './util.ts';
export { toPng, toSvg } from './canvas.ts';

const MAKERS: Partial<Record<MapKind, (o: MapOpts) => MapResult>> = { dungeon: genDungeon, cave: genCave, castle: genCastle, tavern: genTavernMap, battlemap: genBattlemap, city: genCity, region: genRegion, forest: genForest };

export function genMap(kind: string, o: MapOpts = {}): MapResult {
  if (!(MAP_KINDS as readonly string[]).includes(kind)) throw new RangeError(`kind must be one of ${MAP_KINDS.join(', ')}`);
  const make = MAKERS[kind as MapKind];
  if (!make) throw new RangeError(`${kind} maps are not available yet`);
  return make(o);
}
