// Original tables for the keyed lists of the generated maps. The map decides
// the geometry; these only fill in what each place is like.
export interface Flavour { palette: { floor: string; rock: string; wall: string; grid: string; bg: string }; rooms: string[]; features: string[]; occupants: string[] }

export const DUNGEON_FLAVOURS: Record<string, Flavour> = {
  ruin: {
    palette: { floor: '#f3ecdb', rock: '#d6cbb1', wall: '#2f2a26', grid: '#d7cdb5', bg: '#e7dcc3' },
    rooms: ['a guard post gone quiet', 'a collapsed library', 'a flooded cistern', 'a shrine to some forgotten saint', 'a barracks with rotten bunks', 'a kitchen with a cold hearth', 'a cellar of broken casks', 'a map room with the maps long gone', 'an armoury stripped to the racks', 'a scriptorium of toppled desks', 'a well room with a sealed lid', 'a trophy hall of cracked statues'],
    features: ['a toppled statue with one raised hand', 'a hearth blackened by an old fire', 'a long table split down the middle', 'a mosaic floor missing half its tiles', 'a rusted portcullis wedged half open', 'a stair that ends in rubble', 'a bronze gong green with age', 'a stone basin of still black water'],
    occupants: ['empty, but something has walked here recently', 'a pair of sentries who have not been relieved in years', 'a nest of giant rats under the rubble', 'a lone scavenger hiding from something worse', 'a patrol that is not quite alive', 'a sleeping creature curled in the corner', 'nothing visible, but the dust has footprints', 'a cult initiate rehearsing a prayer'],
  },
  crypt: {
    palette: { floor: '#e4e1dc', rock: '#b9b5ae', wall: '#252325', grid: '#cbc7c0', bg: '#cfcac2' },
    rooms: ['an ossuary stacked to the ceiling', 'a family vault of sealed niches', 'a mourners\' chapel with no mourners', 'a bone-dry well of urns', 'an embalmer\'s workroom', 'a sarcophagus hall', 'a lamp-lit antechamber', 'a hall of weeping statues', 'a priest\'s cell with a single cot', 'a catacomb junction of six low arches'],
    features: ['a lidded sarcophagus carved with a sleeping knight', 'rows of numbered burial niches', 'a basin of oil with a floating wick', 'a stone door etched with a warning in an old tongue', 'a rotted funeral bier', 'a mural of a procession that never ends'],
    occupants: ['restless dead rising slowly from their niches', 'a ghost that repeats one sentence', 'a grave robber who is badly hurt', 'a ghoul pack feeding quietly', 'a single skeleton guarding a door out of habit', 'nothing, and the quiet is worse'],
  },
  mine: {
    palette: { floor: '#e8dcc6', rock: '#bfae93', wall: '#3a2f26', grid: '#d3c4a8', bg: '#cbb99b' },
    rooms: ['an ore-sorting floor', 'a collapsed gallery propped with timbers', 'a smelter with a cold furnace', 'a foreman\'s hut of crooked planks', 'a flooded lower shaft', 'a pump house with a silent wheel', 'a powder store behind a sagging door', 'a miners\' mess with a long bench', 'a vein of glittering rock', 'a lift chamber with a snapped chain'],
    features: ['a cart on a bent rail', 'a heap of tailings glittering faintly', 'a lamp hook with a dead lantern', 'timber props creaking overhead', 'a drift of pale dust that stirs without wind', 'a pick left embedded in the wall'],
    occupants: ['burrowing things that fear lamplight', 'a prospector who will not say how long he has been down here', 'a swarm of cave bats', 'a rock-eating creature mid-meal', 'kobold diggers with a plan', 'only the sound of dripping'],
  },
  sewer: {
    palette: { floor: '#dcd9c7', rock: '#a9a794', wall: '#2c3a2c', grid: '#c4c1ad', bg: '#bcb9a2' },
    rooms: ['a junction of three slow channels', 'a sluice chamber with a stuck wheel', 'a collapsed overflow tank', 'a tinker\'s hideout on a dry ledge', 'a drowned maintenance room', 'a smugglers\' drop with a rope ladder', 'a grating that looks up on a street', 'a nest of rubbish and bones'],
    features: ['a rusted ladder to a manhole', 'a walkway slick with algae', 'a barrel of something that should not be opened', 'chalk marks that someone keeps renewing', 'a pipe that gurgles in rhythm', 'a heap of lost shoes'],
    occupants: ['a swarm of rats that do not scatter', 'a smuggler crew counting coin', 'an ooze coating the ceiling', 'a thieves\' lookout with a whistle', 'a tired gutter-wizard collecting samples', 'a croaking thing in the dark water'],
  },
  temple: {
    palette: { floor: '#f1e8d4', rock: '#d9c9a7', wall: '#4a2c2c', grid: '#dccfb4', bg: '#e6d7b8' },
    rooms: ['a vestry of folded robes', 'a sanctum with a cracked altar', 'a reliquary behind iron bars', 'a novices\' dormitory', 'a bell loft with a silent bell', 'a confessional of curtained booths', 'a processional hall of pillars', 'a ritual bath drained dry', 'an abbot\'s study heavy with incense'],
    features: ['an altar stained dark in a ring', 'a font of water that never settles', 'candles that relight when you look away', 'a lectern with a book chained open', 'a window of coloured glass showing no scene', 'a bronze censer swinging slowly'],
    occupants: ['acolytes in a trance', 'a priest who is certain you are late', 'a guardian statue that tracks the party', 'a hidden cultist watching from the gallery', 'nothing, though the censer is still warm', 'a choir that is singing in an empty room'],
  },
  lair: {
    palette: { floor: '#e9dcc1', rock: '#b9a584', wall: '#35291f', grid: '#cdbd9e', bg: '#c5b290' },
    rooms: ['a trophy chamber of mismatched armour', 'a feeding pit ringed with bones', 'a cramped nest of stolen bedding', 'a pool room fed by a hidden spring', 'a stash behind a heavy boulder', 'a sleeping hall with a high ceiling', 'a watch ledge above the entrance', 'a prison alcove with a barred hole'],
    features: ['a heap of glittering junk', 'claw marks high on the wall', 'a firepit with a spit', 'a rope bridge over a dark gap', 'a pile of hides still drying', 'a cracked egg the size of a barrel'],
    occupants: ['a hunting party about to leave', 'a youngling alone and hungry', 'the lair\'s master asleep with one eye open', 'captives who are not as helpless as they look', 'a pack of hounds that know the party\'s scent', 'a scout posted to watch the entrance'],
  },
};
export const DUNGEON_LIGHT = ['pitch black', 'lit by a faint green glow', 'dim, one oil lamp guttering', 'bright from a shaft of daylight', 'torchlit and warm', 'lit by pale blue fungus', 'flickering with a draught from somewhere'];
export const DUNGEON_SENSE = ['the air smells of wet stone and old smoke', 'something drips steadily just out of sight', 'a low hum rises from the floor', 'the walls are cold enough to see your breath', 'a faint sweet rot hangs in the air', 'distant metal clinks, then stops', 'dust hangs thick and undisturbed', 'a warm draught carries a smell of animals'];
export const DUNGEON_HAZARD = ['a rotten floor over a shallow drop', 'a patch of slick, glowing fungus', 'a tripwire across the doorway', 'unstable shelves of heavy objects', 'a pressure plate under the dust', 'a vent that puffs a sleeping gas when stepped near', 'a section of ceiling that comes down when touched', 'a scything blade on a hidden track'];
export const DUNGEON_SECRET = ['a loose brick hides a small key', 'a hidden catch opens a narrow passage', 'a false back to the cabinet hides a cache', 'a scratched message names a name', 'a pressure stone drops a section of wall', 'a hollow beneath the hearth holds a purse', 'a ring of keys behind a loose panel'];
export const DUNGEON_LOOT = ['a purse of coins', 'a small gem in a rotted pouch', 'a dented but valuable silver cup', 'a minor potion in a stoppered vial', 'a signed letter worth more to someone else', 'a tarnished brooch with a crest', 'a scroll tube with a faded scroll', 'a lockbox with a simple lock'];

export const CAVE_ROOMS = ['a wide chamber with a domed roof', 'a low crawl that opens into a pocket', 'a pool of cold, clear water', 'a stalagmite forest', 'a narrow gallery of glittering rock', 'a ledge above a dark drop', 'a chimney of pale stone with a wisp of daylight', 'a sandy hollow with old bones', 'a fungal garden', 'a dry nest of leaves and fur', 'a shelf with a collapsed fire-ring', 'a chamber that echoes strangely'];
export const CAVE_FEATURES = ['dripping water that rings like a bell', 'fresh claw marks at head height', 'a pale glow from the walls', 'a tangle of old rope', 'webbing across the roof', 'a warm breeze from a crack', 'a scatter of sheep bones', 'a rusted helm half buried'];
export const CAVE_OCCUPANTS = ['empty', 'a sleeping beast', 'a scouting party', 'a hermit who knows the tunnels', 'a swarm of bats', 'something large that waits in the water', 'a pack of small, hungry things'];

export const CASTLE_BUILDINGS = ['Great hall', 'Barracks', 'Stables', 'Kitchen and bakery', 'Chapel', 'Smithy', 'Armoury', 'Granary', 'Guest hall', 'Mews and kennels', 'Brewhouse', 'Steward\'s office'];
export const CASTLE_BUILDING_NOTE: Record<string, string> = {
  'Great hall': 'Long tables, a raised dais and a smoking hearth. Where the lord dines and holds court.',
  Barracks: 'Rows of bunks, weapon racks by the door, and a sergeant\'s cot near the stair.',
  Stables: 'Stalls for a dozen horses, a loft of hay and a farrier\'s corner.',
  'Kitchen and bakery': 'Ovens, hanging pots and a scullery with a trapdoor to the cold store.',
  Chapel: 'A small altar, three pews and a squint through the wall into the lord\'s gallery.',
  Smithy: 'A forge, an anvil and racks of half-finished blades and horseshoes.',
  Armoury: 'Locked cages of spears, shields and mail, with a quartermaster\'s ledger.',
  Granary: 'Sacks and bins behind a heavy door; the floor is raised against damp and rats.',
  'Guest hall': 'Clean beds for visitors, a window seat and a bell pull that rings in the steward\'s office.',
  'Mews and kennels': 'Perches for hawks, pens for hounds and a keeper who sleeps lightly.',
  Brewhouse: 'Vats, barrels and a sour smell of malt; a good place to hide something heavy.',
  'Steward\'s office': 'A desk of ledgers, a strongbox and a window that watches the gate.',
};
export const KEEP_ROOMS = ['Throne room', 'Lord\'s solar', 'Armoury', 'Library', 'Council chamber', 'Guest chambers', 'Wardrobe and linen store', 'Treasury', 'Cellar stair', 'Captain\'s quarters', 'Chapel gallery', 'Servants\' hall'];

export const TAVERN_ROOM_NOTES = ['a narrow bed, a washstand and a window onto the yard', 'two cots and a trunk; the door sticks', 'a big bed, a good lock and a stained ceiling', 'a quiet corner room with a view of the road', 'a cramped garret over the kitchen, warm and smelling of bread', 'a clean room for one with a small writing desk'];

export const BATTLE_THEMES: Record<string, { ground: string; features: string[]; hazard: string[] }> = {
  forest: { ground: '#cfe0b4', features: ['a fallen trunk (half cover)', 'a thicket (difficult terrain)', 'a boulder (full cover)', 'a game trail', 'a shallow stream (difficult terrain)', 'a tangle of roots (difficult terrain)'], hazard: ['hanging vines that snag armour', 'a hollow tree with a nest', 'mushroom rings (spore cloud when stepped on)'] },
  ruins: { ground: '#d9d2c0', features: ['a broken wall (half cover)', 'a toppled column (half cover)', 'a rubble heap (difficult terrain)', 'a doorway into a roofless room', 'a cracked statue (full cover)', 'a stair to a ledge (5 ft up)'], hazard: ['a floor that gives way into a cellar', 'a loose arch that could fall', 'a rusted gate hanging by one hinge'] },
  river: { ground: '#d4e2b8', features: ['a ford (difficult terrain)', 'a wooden footbridge', 'a mossy boulder (half cover)', 'a muddy bank (difficult terrain)', 'a reed bed (half cover)', 'a deep pool (swim, DC 10)'], hazard: ['a fast current that pushes 10 ft per round', 'slippery stones (DC 11 Dex or fall prone)', 'a drifting log in the current'] },
  camp: { ground: '#d7dfb5', features: ['a campfire (lit, 5 ft radius)', 'a tent (full cover from outside)', 'a wagon (half cover)', 'a stack of crates (half cover)', 'a picket line of horses', 'a cookpot on a tripod'], hazard: ['a tripwire with bells', 'a barrel of lamp oil near the fire', 'a startled horse that may bolt'] },
  swamp: { ground: '#bccaa0', features: ['a mud flat (difficult terrain)', 'a reed bed (half cover)', 'a dead tree (half cover)', 'a pool of black water', 'a narrow causeway', 'a hummock of dry ground'], hazard: ['sucking mud (DC 12 Str to leave)', 'a rising bog gas', 'a hidden sinkhole'] },
  cliff: { ground: '#d9d0b8', features: ['a ledge 10 ft up', 'a rock slide (difficult terrain)', 'a boulder (full cover)', 'a narrow path along the edge', 'a cave mouth', 'a scree slope (difficult terrain)'], hazard: ['a crumbling edge (DC 12 Dex or slip)', 'loose stones overhead', 'a gusting wind (disadvantage on ranged attacks)'] },
  crossroads: { ground: '#d9dfb7', features: ['a signpost with one broken arm', 'a roadside shrine (half cover)', 'a milestone (half cover)', 'an overturned cart (full cover)', 'a ditch (half cover when prone)', 'a stand of birches'], hazard: ['a hidden snare pit by the verge', 'a loose-wheeled cart that rolls downhill', 'a gibbet creaking in the wind'] },
};

export const CITY_DISTRICTS = ['Market quarter', 'Temple hill', 'Craftsmen\'s row', 'Noble heights', 'Dockside', 'Old town', 'Gate ward', 'Tanners\' quarter', 'Scholars\' close', 'Garrison yard'];
export const CITY_DISTRICT_COLOURS: Record<string, string> = {
  'Market quarter': '#e3b97a', 'Temple hill': '#d9c9e4', 'Craftsmen\'s row': '#d7b49a', 'Noble heights': '#c7d4e6', Dockside: '#b8d0d0', 'Old town': '#dcd0b0', 'Gate ward': '#d0c2a6', 'Tanners\' quarter': '#c5b89a', 'Scholars\' close': '#d5dcc0', 'Garrison yard': '#c9c9c9',
};
export const CITY_LANDMARKS = [
  ['The city hall', 'Civic offices, a tall clock tower and a locked records room.'], ['The great temple', 'Bells, incense and a long queue for the morning blessing.'], ['The guild hall', 'A hall of banners; membership is a prerequisite for most trade here.'],
  ['The grand market', 'Awnings, hawkers, and a lost-and-found stall run by a retired thief.'], ['The old keep', 'The oldest stone in the city, now a garrison and a prison.'], ['The healer\'s house', 'A cheerful sanatorium with an unusual number of locked cabinets.'],
  ['The lamplighters\' yard', 'Ladders, oil and a gang who know every rooftop.'], ['The great library', 'Silence, ladders and a restricted reading room.'], ['The arena', 'Sand, a roaring crowd and a betting ring behind the stands.'], ['The playhouse', 'A theatre with an off-stage door that leads somewhere else.'],
  ['The smugglers\' steps', 'A staircase to the water that most people pretend is not there.'], ['The bell foundry', 'Heat, noise and bronze bells that ring on their own at midnight.'],
];

export const REGION_FEATURES = ['a standing stone circle', 'a ruined watchtower', 'an abandoned mine', 'a hermit\'s hut', 'a lonely shrine', 'a haunted ford', 'a crumbling bridge', 'a dragon\'s lair (rumoured)', 'a fey crossing', 'a bandit camp', 'a sunken ship', 'a salt flat', 'a sacred grove'];
export const REGION_TOWN_NOTE = ['a quiet farming village', 'a mining town of low roofs and smoke', 'a river port full of barges', 'a walled market town', 'a fishing village with a famous harbour bell', 'a pilgrim\'s hamlet around an old shrine', 'a logging camp grown into a town', 'a crossroads inn and the huddle around it', 'a garrison town on the border'];

export const WILD_CLEARINGS = ['a mossy campsite with an old fire-ring', 'a hunter\'s cabin with a sagging roof', 'a shrine to an old forest saint', 'a ruined watchtower overgrown with ivy', 'a pond with a half-sunk boat', 'a ring of tall stones', 'a charcoal burner\'s clearing', 'a toppled tree with a hollow like a door', 'a meadow of white flowers that never seem to wilt', 'a bandit lookout in the branches', 'a lone grave with fresh flowers', 'a spring of clear water with a tin cup on a chain'];
export const WILD_OCCUPANTS = ['quiet, though the birds have gone silent', 'a lone traveller resting', 'a hunting party', 'a wolf pack\'s lair on the far side', 'a hermit with a kind word and a hard bargain', 'a trap line with a trapper nearby', 'a fey presence that vanishes if looked at', 'nothing, but tracks lead out'];
export const WILD_ENCOUNTER_HINTS = ['A game trail crosses the path here; something big uses it at dusk.', 'The path forks and the left branch is muddier than it should be.', 'A rope is tied to a branch at head height. It is old, and it is new.', 'Birdsong stops abruptly for a heartbeat.', 'A thin line of smoke rises somewhere to the north.'];
