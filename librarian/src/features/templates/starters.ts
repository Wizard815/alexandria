// Built-in starter templates: a ready-made one of each useful kind, so the DM starts from something that works
// instead of a blank form. They are not in the world until the DM picks "Use this starter" (a normal create, so
// every check a template gets applies: cleanTemplate, the classified check, versions). ids start with "starter:".
import { cleanTemplate, type TemplateInput } from './spec.ts';

export interface StarterTemplate extends TemplateInput { id: string }

const t = (id: string, v: Omit<TemplateInput, 'enabled' | 'spec'> & { spec: Record<string, unknown> }): StarterTemplate => ({ id: `starter:${id}`, ...cleanTemplate({ ...v, enabled: true }) });

export const STARTER_TEMPLATES: StarterTemplate[] = [
  // ---- quick events ----
  t('events-town', {
    kind: 'event', name: 'Town & city temptations', description: 'Small moments in streets and markets that test a character: a thief, a find, a stranger in need.',
    triggers: ['quick event', 'town event', 'city event'],
    spec: { places: ['town', 'city', 'market', 'village', 'tavern'], theme: 'petty crime, honest or greedy choices, small kindnesses', instructions: 'One moment, one choice. Start in the middle of it ("A hand brushes your belt"). The greedy choice pays a little more now; the honest one earns a friend or a favour.', tone: 'Light and quick, second person.', choices: 3, checks: true, maxRewardCp: 100, consequences: 'Every choice that matters gets a dmnote: who saw it and who might remember.' },
  }),
  t('events-wild', {
    kind: 'event', name: 'Wilderness hazards & finds', description: 'Things that happen on the road and in the wild: a rotten bridge, a strange plant, an abandoned camp.',
    triggers: ['road event', 'wilderness event', 'travel event'],
    spec: { places: ['road', 'woods', 'mountains', 'swamp', 'coast'], theme: 'hazards, finds and signs of others on the road', instructions: 'A hazard gets a skill check with a small cost on a failure (a few coins lost, an hour lost, a minor wound in a dmnote). A find gets a simple item with a note on what it is worth.', tone: 'Vivid, one or two sentences a step.', choices: 2, checks: true, maxRewardCp: 50, consequences: 'Wounds, lost time and conditions go in a dmnote so the DM applies them.' },
  }),
  t('events-deep', {
    kind: 'event', name: 'Underground moments', description: 'Caves, dungeons and ruins: traps, echoes, odd things in the dark.',
    triggers: ['dungeon event', 'cave event'],
    spec: { places: ['cave', 'dungeon', 'ruins'], theme: 'traps, eerie signs and small treasures', instructions: 'Keep it tense. A trap is a save or check; a strange sign is a clue the DM explains later (put the real meaning in a dmnote, never in what the player reads).', tone: 'Tense and quiet.', choices: 2, checks: true, maxRewardCp: 50, consequences: 'Damage and clues go in a dmnote.' },
  }),
  // ---- spells ----
  t('spell-balanced', {
    kind: 'spell', name: 'Balanced homebrew spell', description: 'A new spell of any level that sits beside the SRD spells of its level.',
    triggers: ['spell', 'new spell', 'homebrew spell'],
    spec: { minLevel: 0, maxLevel: 9, schools: [], classes: [], lines: [], balance: 'Match the damage dice, area, range and duration of SRD spells of the same level. A rider (a condition, a push) costs about one damage die. Concentration for anything that lasts.', mana: '', naming: 'Plain and evocative; no real-world names.', instructions: 'Write the text fresh, never copied. Say who saves and what happens on a success.', higherLevels: true },
  }),
  t('spell-cantrip', {
    kind: 'spell', name: 'Cantrip', description: 'A small at-will spell that grows at levels 5, 11 and 17.',
    triggers: ['cantrip'],
    spec: { minLevel: 0, maxLevel: 0, schools: [], classes: [], lines: [], balance: 'One target, 1d10 damage at most (1d6 to 1d8 with a rider), or a small utility effect.', mana: 'Cantrips cost no mana.', naming: '', instructions: 'Say what it does at character levels 5, 11 and 17.', higherLevels: true },
  }),
  // ---- library pages ----
  t('page-recap', {
    kind: 'library', name: 'Session recap', description: 'A page per session: what happened, who they met, loose ends.',
    triggers: ['recap', 'session notes'],
    spec: { folder: 'Sessions', titlePattern: 'Session {name}', sections: ['Summary', 'Where they went', 'People met', 'Loot & coin', 'Loose ends', 'Next time (DM)'], tags: ['session'], body: '# Session {name}\n\n## Summary\n\n## Where they went\n\n## People met\n\n## Loot & coin\n\n## Loose ends\n\n## Next time\n> [!secret] DM\n> \n' },
  }),
  t('page-item', {
    kind: 'library', name: 'Magic item', description: 'A magic item page: what it looks like, what it does, its story.',
    triggers: ['magic item', 'artifact', 'relic'],
    spec: { folder: 'Items', titlePattern: '{name}', sections: ['Look', 'Properties', 'Attunement', 'History', 'Secrets (DM)'], tags: ['item', 'magic item'], body: '# {name}\n*Wondrous item, rarity (requires attunement)*\n\n## Look\n\n## Properties\n\n## Attunement\n\n## History\n\n## Secrets\n> [!secret] DM\n> \n' },
  }),
  t('page-monster', {
    kind: 'library', name: 'Monster', description: 'A creature page with its lair, tactics and lore (the statblock comes from the monster generator).',
    triggers: ['monster', 'creature'],
    spec: { folder: 'Bestiary', titlePattern: '{name}', sections: ['Look', 'Behaviour', 'Lair', 'Tactics', 'Lore', 'Secrets (DM)'], tags: ['monster'], body: '# {name}\n\n## Look\n\n## Behaviour\n\n## Lair\n\n## Tactics\n\n## Lore\n\n## Secrets\n> [!secret] DM\n> \n' },
  }),
  t('page-faction', {
    kind: 'library', name: 'Faction', description: 'A faction, guild or cult: leaders, goals, allies and rivals.',
    triggers: ['faction', 'guild', 'cult'],
    spec: { folder: 'Factions', titlePattern: '{name}', sections: ['Overview', 'Leaders', 'Goals', 'Resources', 'Allies & rivals', 'Hooks', 'Secrets (DM)'], tags: ['faction'], body: '# {name}\n\n## Overview\n\n## Leaders\n\n## Goals\n\n## Resources\n\n## Allies & rivals\n\n## Hooks\n\n## Secrets\n> [!secret] DM\n> \n' },
  }),
  // ---- guides ----
  t('guide-town', {
    kind: 'guide', name: 'Towns', description: 'Make a town that fits the world: its lore, the places around it, the towns already written.',
    triggers: ['town', 'village', 'city', 'hamlet'],
    spec: { task: 'Make a town', instructions: 'Keep it consistent with the region and the neighbouring towns: roads, trade, rivalries. Give the players three hooks.', steps: [{ kind: 'library', text: 'Search the world library for lore about the town, its region and anything the request names.' }, { kind: 'neighbours', text: 'Find the towns around it and keep the new one consistent with them.' }, { kind: 'exemplars', text: 'Read two existing town pages and follow how they are structured.' }], sections: ['Overview', 'Geography & layout', 'People & culture', 'Places of note', 'Power & factions', 'Rumours & hooks', 'Secrets (DM)'], tone: '', folder: 'Places', exemplars: [] },
  }),
  t('guide-dungeon', {
    kind: 'guide', name: 'Dungeons', description: 'Make a dungeon: its history, areas, inhabitants, traps and treasure.',
    triggers: ['dungeon', 'crypt', 'lair', 'cave'],
    spec: { task: 'Make a dungeon', instructions: 'Five to eight areas. Each area: what they see, what is there, what can go wrong. Keep the treasure to the party\'s level.', steps: [{ kind: 'library', text: 'Search the world library for lore about the place and who built or lives in it.' }, { kind: 'exemplars', text: 'Read existing dungeon pages and follow their structure.' }], sections: ['Overview', 'History', 'Areas', 'Inhabitants', 'Traps & hazards', 'Treasure', 'Secrets (DM)'], tone: '', folder: 'Places/Dungeons', exemplars: [] },
  }),
  // ---- generators, shops, macros, assist ----
  t('gen-tavern', {
    kind: 'generator', name: 'Taverns', description: 'A tavern with its keeper, menu, regulars and rumours.',
    triggers: ['tavern', 'inn'],
    spec: { generator: 'tavern', fields: [{ name: 'Keeper', hint: 'name, look, one quirk' }, { name: 'Menu', hint: 'three dishes and prices' }, { name: 'Regulars', hint: 'two or three' }, { name: 'Rumours', hint: 'three, one of them true' }], sections: ['Overview', 'Keeper', 'Menu', 'Regulars', 'Rumours'], instructions: 'Make one rumour true and say which in a secret block.', folder: 'Places' },
  }),
  t('shop-apothecary', {
    kind: 'shop', name: 'Apothecary', description: 'Potions, herbs and remedies.',
    triggers: ['apothecary', 'alchemist', 'herbalist'],
    spec: { shopType: 'apothecary', guide: 'Mostly healing potions, herbs and antitoxins; one odd item the keeper will not explain. 12 items, max rarity uncommon.', stock: ['Potion of healing', 'Antitoxin', 'Herbalism kit', 'Healer\'s kit'], priceNotes: 'Book prices; healing potions 10% dearer in a small town.' },
  }),
  t('macro-recap', {
    kind: 'macro', name: 'Recap last session', description: 'Drafts a recap of the last session for the players.',
    triggers: [],
    spec: { prompt: 'Write a short recap of the last session for the players, from the session log and transcripts. Mention {{focus}}. Nothing DM-only.', params: [{ name: 'focus', label: 'Make sure to mention', default: 'the loose ends' }], mode: 'propose', tools: '' },
  }),
  t('assist-combat', {
    kind: 'assist', name: 'Combat helper', description: 'The combat tracker beside the assistant, ready to run a fight.',
    triggers: [],
    spec: { layout: 'cols', panes: ['combat', 'assistant'], prompt: 'Help me run this fight: track initiative and HP, and remind me of conditions at the start of each turn.' },
  }),
];

export const starterTemplate = (id: string) => STARTER_TEMPLATES.find((s) => s.id === id) ?? null;
