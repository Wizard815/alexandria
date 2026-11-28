// A shop generation template passes its guide to the shop generator (features/shop/gen.ts). The guide text weights the
// item picks without a model and understands directives such as "12 items", "markup 20%", "no magic", "max rarity rare";
// with a chat model it is the brief. Imported from gen.ts, not the shop feature's index.ts (that would be an import cycle).
import type { Deps } from '../../app.ts';
import { generateShop, type ShopDraft, type ShopOpts } from '../shop/gen.ts';
import { guideText } from './spec.ts';
import type { Template } from './store.ts';

const KINDS: [RegExp, string][] = [
  [/\b(smith|forge|armou?r|weapon)/i, 'blacksmith'], [/\b(alchem|apothec|herb|potion|remed)/i, 'alchemist'], [/\b(magic|arcane|wizard|enchant|curio)/i, 'magic'],
  [/\b(tavern|inn|alehouse)/i, 'tavern'], [/\b(fence|pawn|black ?market|second-hand|salvage)/i, 'fence'], [/\b(general|store|provision|supply|trading)/i, 'general'],
];
/** The shop generator's kind for a template's free-text shop type ("apothecary" is alchemist); undefined lets it choose. */
export const shopKindFor = (type: string): string | undefined => KINDS.find(([re]) => re.test(type))?.[1];

/** The guide the shop generator reads: the template's whole text (type, guide, stock, prices). */
export const shopGuide = (t: Template): string => guideText(t);

/** A shop draft made with the template's guide. Nothing is saved: the GM saves or stocks it on the Shops page. */
export async function generateShopWithTemplate(d: Deps, worldId: string, t: Template, opts: ShopOpts = {}): Promise<ShopDraft> {
  const sp: any = t.spec;
  const kind = opts.kind ?? shopKindFor(String(sp.shopType ?? ''));
  return generateShop(d, worldId, { ...(kind ? { kind } : {}), ...opts }, shopGuide(t));
}
