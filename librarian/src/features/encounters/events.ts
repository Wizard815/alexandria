// Built-in quick events: small things that happen to a player, each tagged
// with the places it fits (town, road, woods, cave ...). They run on the
// encounter engine (script.ts): steps, answers, checks and effects, with the
// "NPC" being whoever or whatever the event is about. ids start with
// "builtin:ev-"; like the NPC starters they cannot be edited (copy one).
import { parseScript, type Starter } from './script.ts';

const ev = (s: Omit<Starter, 'script' | 'kind'> & { script: unknown }): Starter => ({ ...s, kind: 'event', script: parseScript(s.script) });

export const EVENT_STARTERS: Starter[] = [
  ev({
    id: 'builtin:ev-pickpocket', name: 'Pickpocket in the crowd', npcName: 'A quick-fingered urchin', npcBlurb: 'A tug at your belt in a busy street.', places: ['town', 'city', 'market'],
    script: { start: 'tug', nodes: [
      { id: 'tug', text: 'You feel a tug at your belt. A small figure darts into the crowd with your coin purse!', options: [{ label: 'Give chase', next: 'chase' }, { label: 'Let it go', next: null, effects: [{ kind: 'lose', cp: 50 }, { kind: 'dmnote', text: 'Let a pickpocket get away with 5 sp.' }] }] },
      { id: 'chase', text: 'You shove through the crowd after them, ducking carts and washing lines.', game: { kind: 'check', skill: 'Athletics', dc: 12, stakeCp: 0, winCp: 0, win: 'caught', lose: 'gone' } },
      { id: 'gone', text: 'They vanish into the alleys. Your purse is lighter.', options: [{ label: 'Curse your luck', next: null, effects: [{ kind: 'lose', cp: 50 }] }] },
      { id: 'caught', text: 'You grab a skinny kid by the collar. They hand back your purse, and a second, fatter purse that is not yours.', options: [
        { label: 'Keep both purses', next: null, effects: [{ kind: 'gold', cp: 30 }, { kind: 'dmnote', text: "Kept a stranger's stolen purse (3 sp)." }] },
        { label: 'Hand the extra purse to the watch', next: 'watch' },
        { label: 'Let the kid keep the other purse', next: null, effects: [{ kind: 'dmnote', text: 'Let the young pickpocket go with a stolen purse. The kid may remember the kindness.' }] },
      ] },
      { id: 'watch', text: 'The guard sergeant weighs the purse, then flips you a coin. "Honest folk are rare. Thanks."', options: [{ label: 'Pocket the reward', next: null, effects: [{ kind: 'gold', cp: 10 }, { kind: 'dmnote', text: 'Returned a stolen purse to the watch; the sergeant knows their face.' }] }] },
    ] },
  }),
  ev({
    id: 'builtin:ev-gem', name: 'Undervalued gem', npcName: 'A bead seller', npcBlurb: 'A dusty tray of glass beads on a market stall.', places: ['market', 'town', 'city', 'village'],
    script: { start: 'tray', nodes: [
      { id: 'tray', text: 'Among the glass beads on a dusty tray, one stone catches the light differently. The seller is busy haggling with someone else.', options: [{ label: 'Look closer', next: 'look' }, { label: 'Walk on', next: null }] },
      { id: 'look', text: 'You turn the stone in your fingers.', game: { kind: 'check', skill: 'Investigation', dc: 13, stakeCp: 0, winCp: 0, win: 'real', lose: 'glass' } },
      { id: 'glass', text: 'Just glass, and a chipped one at that.', options: [{ label: 'Put it back', next: null }] },
      { id: 'real', text: 'It is a real garnet, rough-cut and priced as glass: 2 sp.', options: [
        { label: 'Buy it (2 sp)', next: null, effects: [{ kind: 'pay', cp: 20 }, { kind: 'item', name: 'Uncut garnet', qty: 1, note: 'Worth about 10 gp to a jeweller. Bought for 2 sp.' }] },
        { label: 'Tell the seller what it is worth', next: 'honest' },
        { label: 'Leave it', next: null },
      ] },
      { id: 'honest', text: 'The seller blinks, then grins and presses a bead bracelet into your hand. "For your honesty. Come back any time."', options: [{ label: 'Thank them', next: null, effects: [{ kind: 'item', name: 'Bead bracelet', qty: 1, note: 'A gift from a grateful market seller.' }, { kind: 'dmnote', text: 'Was honest with a bead seller about a garnet; the seller is a friend now.' }] }] },
    ] },
  }),
  ev({
    id: 'builtin:ev-lostpurse', name: 'Purse in the mud', npcName: 'A lost purse', npcBlurb: 'A purse with a merchant seal, half sunk in a rut.', places: ['road', 'town', 'village'],
    script: { start: 'see', nodes: [
      { id: 'see', text: 'A leather purse lies in the mud, stamped with a merchant house seal. It clinks.', options: [{ label: 'Pocket it', next: null, effects: [{ kind: 'gold', cp: 30 }, { kind: 'dmnote', text: 'Kept a merchant house purse found on the road (3 sp).' }] }, { label: 'Look for the owner', next: 'owner' }, { label: 'Leave it', next: null }] },
      { id: 'owner', text: 'Up the road a flustered merchant is searching a ditch, muttering.', options: [{ label: 'Hand it back', next: null, effects: [{ kind: 'gold', cp: 10 }, { kind: 'dmnote', text: 'Returned a lost purse to a merchant; the merchant house owes them a favour.' }] }, { label: 'Keep it after all', next: null, effects: [{ kind: 'gold', cp: 30 }, { kind: 'dmnote', text: 'Saw the owner of a lost purse and kept it anyway.' }] }] },
    ] },
  }),
  ev({
    id: 'builtin:ev-bridge', name: 'Rickety rope bridge', npcName: 'A rope bridge', npcBlurb: 'Fraying rope over a fast stream.', places: ['road', 'woods', 'mountains'],
    script: { start: 'edge', nodes: [
      { id: 'edge', text: 'The path crosses a gorge on a rope bridge with more gaps than planks.', options: [{ label: 'Cross carefully', next: 'cross' }, { label: 'Take the long way round', next: null, effects: [{ kind: 'dmnote', text: 'Took the long way round a rope bridge (an hour lost).' }] }] },
      { id: 'cross', text: 'Halfway across, a plank cracks under your foot.', game: { kind: 'check', skill: 'Acrobatics', dc: 11, stakeCp: 0, winCp: 0, win: 'safe', lose: 'slip' } },
      { id: 'safe', text: 'You hop to the next plank and reach the far side, heart pounding.', options: [{ label: 'Onward', next: null }] },
      { id: 'slip', text: 'You catch the rope just in time, but a few coins spill from your purse into the water below.', options: [{ label: 'Haul yourself up', next: null, effects: [{ kind: 'lose', cp: 15 }] }] },
    ] },
  }),
  ev({
    id: 'builtin:ev-mushrooms', name: 'Glowing mushrooms', npcName: 'A ring of glowing mushrooms', npcBlurb: 'Pale caps that glow a soft blue.', places: ['woods', 'cave', 'swamp'],
    script: { start: 'ring', nodes: [
      { id: 'ring', text: 'A ring of pale mushrooms glows soft blue in the shade.', options: [{ label: 'Pick some', next: 'pick' }, { label: 'Leave them be', next: null }] },
      { id: 'pick', text: 'You kneel and work one loose, careful of the gills.', game: { kind: 'check', skill: 'Nature', dc: 12, stakeCp: 0, winCp: 0, win: 'good', lose: 'numb' } },
      { id: 'good', text: 'You know these: glowcaps. Alchemists pay for them.', options: [{ label: 'Wrap them up', next: null, effects: [{ kind: 'item', name: 'Glowcap mushroom', qty: 3, note: 'Glows faintly. An alchemist might pay 5 sp each.' }] }] },
      { id: 'numb', text: 'Your fingers tingle, then go numb.', options: [{ label: 'Shake it off', next: null, effects: [{ kind: 'dmnote', text: 'Numb fingers from glowcap spores: disadvantage on Sleight of Hand for an hour.' }] }] },
    ] },
  }),
  ev({
    id: 'builtin:ev-echo', name: 'Whispering echo', npcName: 'An echo', npcBlurb: 'A voice in the dark that is almost yours.', places: ['cave', 'dungeon', 'ruins'],
    script: { start: 'name', nodes: [
      { id: 'name', text: 'From deeper in the dark, an echo says your name. You did not speak.', options: [{ label: 'Call back', next: 'answer' }, { label: 'Back away slowly', next: null }] },
      { id: 'answer', text: 'The echo laughs, softly, and says: "Left at the bones." Then silence.', options: [{ label: 'Remember it', next: null, effects: [{ kind: 'dmnote', text: 'Heard a whispering echo say "Left at the bones." The DM decides what it means.' }] }] },
    ] },
  }),
  ev({
    id: 'builtin:ev-plate', name: 'Pressure plate', npcName: 'A loose flagstone', npcBlurb: 'Click.', places: ['dungeon', 'ruins'],
    script: { start: 'click', nodes: [
      { id: 'click', text: 'Click. The flagstone under your foot sinks a finger’s width.', options: [{ label: 'Throw yourself aside', next: 'dodge' }, { label: 'Freeze and keep your weight on it', next: 'hold' }] },
      { id: 'dodge', text: 'A dart hisses out of the wall.', game: { kind: 'check', skill: 'Dexterity save', dc: 12, stakeCp: 0, winCp: 0, win: 'miss', lose: 'hit' } },
      { id: 'hold', text: 'Nothing happens while you stand still. Someone will have to wedge it.', options: [{ label: 'Call for help', next: null, effects: [{ kind: 'dmnote', text: 'Is standing on a dart trap pressure plate; a Thieves’ Tools or wedge check frees them.' }] }] },
      { id: 'miss', text: 'The dart clatters off the far wall.', options: [{ label: 'Phew', next: null }] },
      { id: 'hit', text: 'The dart grazes your arm. It stings.', options: [{ label: 'Pull it out', next: null, effects: [{ kind: 'dmnote', text: 'Hit by a trap dart: 1d4 piercing.' }] }] },
    ] },
  }),
  ev({
    id: 'builtin:ev-spill', name: 'Spilled ale', npcName: 'A tipsy patron', npcBlurb: 'Swaying, mug in each hand.', places: ['tavern'],
    script: { start: 'spill', nodes: [
      { id: 'spill', text: 'A patron stumbles and a full mug of ale soaks your sleeve. "Oh! Sorry, friend, sorry."', options: [{ label: 'Accept a drink as an apology', next: null, effects: [{ kind: 'item', name: 'Mug of ale', qty: 1 }] }, { label: 'Demand coin for your clothes', next: 'demand' }, { label: 'Shrug it off', next: null }] },
      { id: 'demand', text: 'They squint at you, deciding whether to be offended.', game: { kind: 'check', skill: 'Intimidation', dc: 12, stakeCp: 0, winCp: 5, win: 'pays', lose: 'scene' } },
      { id: 'pays', text: 'They fumble a few coppers onto the table and back away.', options: [{ label: 'Fair enough', next: null }] },
      { id: 'scene', text: 'They laugh in your face. A few regulars turn to look.', options: [{ label: 'Let it go', next: null, effects: [{ kind: 'dmnote', text: 'Made a small scene in the tavern; the regulars noticed.' }] }] },
    ] },
  }),
  ev({
    id: 'builtin:ev-beggar', name: 'Old beggar', npcName: 'An old beggar', npcBlurb: 'A hand held out from a doorway.', places: ['city', 'town'],
    script: { start: 'ask', nodes: [
      { id: 'ask', text: '"Spare a copper for an old soldier?"', options: [{ label: 'Give a copper', next: 'token', effects: [{ kind: 'pay', cp: 1 }] }, { label: 'Ignore them', next: null }] },
      { id: 'token', text: 'They press a carved bone token into your palm. "Show that at the Leaky Lamp if you ever need a friend."', options: [{ label: 'Keep the token', next: null, effects: [{ kind: 'item', name: 'Carved bone token', qty: 1, note: 'From an old beggar: "show it at the Leaky Lamp".' }, { kind: 'dmnote', text: 'Has a token of the beggars’ network.' }] }] },
    ] },
  }),
  ev({
    id: 'builtin:ev-camp', name: 'Abandoned camp', npcName: 'A cold campfire', npcBlurb: 'Ashes still warm, a pack left behind.', places: ['road', 'woods', 'mountains'],
    script: { start: 'camp', nodes: [
      { id: 'camp', text: 'Just off the path: a campfire, ashes still warm, and a pack someone left in a hurry.', options: [{ label: 'Search the pack', next: 'search' }, { label: 'Leave it alone', next: null }] },
      { id: 'search', text: 'You rummage through it, keeping one eye on the trees.', game: { kind: 'check', skill: 'Perception', dc: 10, stakeCp: 0, winCp: 0, win: 'find', lose: 'little' } },
      { id: 'find', text: 'Rations, and a few coins sewn into the lining.', options: [{ label: 'Take them', next: null, effects: [{ kind: 'item', name: 'Rations (1 day)', qty: 2 }, { kind: 'gold', cp: 12 }, { kind: 'dmnote', text: 'Took supplies from an abandoned camp. Whoever left it might come back.' }] }] },
      { id: 'little', text: 'Only a torn map scrap, too smudged to read.', options: [{ label: 'Move on', next: null }] },
    ] },
  }),
  ev({
    id: 'builtin:ev-shrine', name: 'Roadside shrine', npcName: 'A mossy shrine', npcBlurb: 'A stone figure with a bowl of offerings.', places: ['road', 'woods', 'mountains', 'ruins'],
    script: { start: 'bowl', nodes: [
      { id: 'bowl', text: 'A small mossy shrine. The bowl at its feet holds a few coins and dried flowers.', options: [
        { label: 'Leave an offering (1 sp)', next: null, effects: [{ kind: 'pay', cp: 10 }, { kind: 'dmnote', text: 'Left an offering at a shrine: the DM may grant +1 on their next saving throw.' }] },
        { label: 'Take the coins from the bowl', next: null, effects: [{ kind: 'gold', cp: 15 }, { kind: 'dmnote', text: 'Took coins from a shrine. Bad luck may follow.' }] },
        { label: 'Say a quiet word and move on', next: null },
      ] },
    ] },
  }),
  ev({
    id: 'builtin:ev-bottle', name: 'Message in a bottle', npcName: 'A bottle in the surf', npcBlurb: 'Green glass, waxed shut.', places: ['coast'],
    script: { start: 'bottle', nodes: [
      { id: 'bottle', text: 'A green bottle rolls in the surf at your feet, its neck sealed with wax.', options: [{ label: 'Open it', next: null, effects: [{ kind: 'item', name: 'Message in a bottle', qty: 1, note: 'A water-stained note. The DM knows what it says.' }, { kind: 'dmnote', text: 'Found a message in a bottle: tell them what it says.' }] }, { label: 'Throw it back', next: null }] },
    ] },
  }),
  ev({
    id: 'builtin:ev-mud', name: 'Sucking mud', npcName: 'Sucking mud', npcBlurb: 'The ground gives way underfoot.', places: ['swamp', 'woods'],
    script: { start: 'sink', nodes: [
      { id: 'sink', text: 'The ground gives way and you sink to the knees in cold, sucking mud.', game: { kind: 'check', skill: 'Athletics', dc: 12, stakeCp: 0, winCp: 0, win: 'out', lose: 'boot' } },
      { id: 'out', text: 'You haul yourself out, filthy but whole.', options: [{ label: 'Scrape off the worst', next: null }] },
      { id: 'boot', text: 'You get out, but the mud keeps a boot and something from your belt.', options: [{ label: 'Squelch onward', next: null, effects: [{ kind: 'lose', cp: 10 }, { kind: 'dmnote', text: 'Lost a boot in the swamp: slowed until they replace it.' }] }] },
    ] },
  }),
];
