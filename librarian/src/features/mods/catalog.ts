// Every house rule that ships with Alexandria: the mod kit's own (inspiration
// as rerolls, the MANA system switch) and the ones features declare in their
// `houseRules` (the spells feature's spell points, simple mana pool and spell
// crafting). Kept apart from index.ts so the feature registry can fill it
// while it loads without an import cycle.
import { checkMod, type ModFile } from './format.ts';

export interface Shipped { mod: ModFile; feature: string }
const shipped = new Map<string, Shipped>();

export function addHouseRules(feature: string, raws: unknown[]) {
  for (const raw of raws) {
    const { mod, errors } = checkMod(raw);
    if (!mod) throw new Error(`features/${feature}: a house rule is not a valid mod: ${errors.join('; ')}`);
    if (shipped.has(mod.id)) throw new Error(`features/${feature}: house rule ${mod.id} already exists`);
    shipped.set(mod.id, { mod, feature });
  }
}

export const shippedMods = (): Shipped[] => [...shipped.values()];
export const shippedMod = (id: string): Shipped | undefined => shipped.get(id);

/** Wizard's house rule: the DM rewards roleplay with three kinds of reroll. */
export const INSPIRATION_REROLLS = {
  kit: 1,
  id: 'inspiration-rerolls',
  name: 'Inspiration as rerolls',
  version: '1.0.0',
  author: 'Wizard',
  summary: 'The DM rewards good roleplay with rerolls: a personal reroll for your own roll, an everyone reroll for any player\'s roll, and a DM reroll that makes the DM roll again.',
  options: {
    cap: { type: 'int', default: 1, min: 1, max: 9, label: 'Most of each type a player can hold' },
    keepBetter: { type: 'boolean', default: false, label: 'Keep the better of the two rolls', help: 'Off: the reroll stands, as with normal inspiration.' },
  },
  resources: [
    { id: 'personal', label: 'Personal reroll', icon: 'fa-dice-d20', max: '$cap', start: 0 },
    { id: 'everyone', label: 'Everyone reroll', icon: 'fa-people-group', max: '$cap', start: 0 },
    { id: 'dm', label: 'DM reroll', icon: 'fa-dragon', max: '$cap', start: 0 },
  ],
  actions: [
    { id: 'grant', label: 'Grant', by: 'dm', resource: '*', add: 1, askReason: true },
    { id: 'take', label: 'Take back', by: 'dm', resource: '*', add: -1 },
    { id: 'use-personal', label: 'Reroll my roll', by: 'owner', resource: 'personal', add: -1, effect: { reroll: { whose: 'own', keepBetter: '$keepBetter' } } },
    { id: 'use-everyone', label: 'Reroll anyone\'s roll', by: 'owner', resource: 'everyone', add: -1, effect: { reroll: { whose: 'anyPlayer', keepBetter: '$keepBetter' } } },
    { id: 'use-dm', label: 'Make the DM reroll', by: 'owner', resource: 'dm', add: -1, effect: { reroll: { whose: 'dm', keepBetter: '$keepBetter' } } },
  ],
  commands: [{ word: 'reroll', args: ['personal', 'everyone', 'dm'], action: 'use-$1' }],
  // The player sheet's Re-rolls module and the DM status bar chips show these counters.
  presets: { sheetRerolls: true, sheetRerollCap: '$cap' },
  sheet: { title: 'Rerolls', resources: ['personal', 'everyone', 'dm'] },
  dmBand: { chips: ['personal', 'everyone', 'dm'], actions: ['grant'] },
  table: { title: 'Reward roleplay', actions: ['grant'] },
  rules: [{
    term: 'Inspiration (house rule)',
    text: 'Inspiration comes as rerolls, given by the DM to reward roleplay. **Personal reroll**: reroll one of your own rolls. **Everyone reroll**: reroll any player\'s roll, yours or an ally\'s. **DM reroll**: make the DM reroll one of their rolls. The new roll stands unless the DM turned on "keep the better". In session chat, press Reroll on a roll or type `/reroll personal`, `/reroll everyone` or `/reroll dm`.',
  }],
};

/** Wizard's MANA spell system (the spells feature's rules engine) as one switch. Needs the MANA engine (spellRulesOn). */
export const MANA_SYSTEM = {
  kit: 1,
  id: 'mana-system',
  name: 'MANA spell system',
  version: '1.0.0',
  author: 'Wizard',
  group: 'magic',
  summary: 'Spells cost mana from a pool by caster type, with study, spell lines, surge casting and dual casting. Replaces spell slots for every character.',
  presets: { spellMana: true, spellRulesOn: true, spellManaName: 'Mana' },
  requires: { settings: ['spellRulesOn'] },
  rules: [{ term: 'MANA (house rule)', text: 'Spells are cast from a mana pool instead of spell slots. Pools depend on caster type and level; new spells are learned by study. See the Codex for costs and your pool.' }],
};

addHouseRules('mods', [INSPIRATION_REROLLS, MANA_SYSTEM]);
