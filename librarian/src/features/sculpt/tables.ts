// Small, original random tables for the sculpting generators. They are the
// no-model path: every built-in template can fill itself from these.
// A row with `|` is a tuple; generators project one part of it.
export const SETTLEMENT_START = ['Ash', 'Bell', 'Briar', 'Cinder', 'Dun', 'Elder', 'Fen', 'Gull', 'Hallow', 'Iron', 'Kettle', 'Lantern', 'Moss', 'North', 'Oak', 'Pike', 'Quill', 'Raven', 'Salt', 'Thistle', 'Willow', 'Wren'];
export const SETTLEMENT_END = ['barrow', 'brook', 'combe', 'cross', 'ford', 'gate', 'haven', 'holm', 'mere', 'moor', 'port', 'stead', 'wick', 'worth', 'vale', 'watch'];
export const TAVERN_A = ['Drowned', 'Gilded', 'Laughing', 'Limping', 'Rusty', 'Sleeping', 'Wandering', 'Crooked', 'Silver', 'Hungry', 'Merry', 'Weeping'];
export const TAVERN_B = ['Anchor', 'Badger', 'Crown', 'Dragon', 'Goose', 'Heron', 'Lantern', 'Mermaid', 'Otter', 'Pike', 'Stag', 'Tankard'];

export const RUMOUR_SUBJECT = ['the miller', 'a travelling tinker', 'the old ferryman', 'the new priest', 'three merchants from the coast', 'the widow at the end of the lane', 'a patrol that never came back', 'the lord\'s steward', 'a pedlar of charms', 'the night watch', 'a child who wanders alone', 'a pair of strangers in grey cloaks'];
export const RUMOUR_DEED = ['has been seen digging at night', 'is buying up every candle in town', 'claims to have found a door that was not there yesterday', 'left in a hurry and left the gate open', 'is paying double for news of the old road', 'swears the well water tastes of iron', 'has stopped speaking to anyone', 'was heard arguing with something in the cellar', 'carries a key nobody can match to a lock', 'is hiring guards and will not say why', 'came back from the hills changed', 'has started leaving food at the crossroads'];
export const RUMOUR_COLOUR_MUNDANE = ['and the price of grain has gone up because of it', 'and half the town thinks it is a scam', 'but nobody can prove a thing', 'and the inn is full of gossip about it', 'though the sheriff says there is nothing to it'];
export const RUMOUR_COLOUR_OMINOUS = ['and the dogs will not go near the place', 'and every candle there burns low and blue', 'and three people have gone missing since', 'and the bells ring at no hour at all', 'and the old stories say this has happened before'];
export const RUMOUR_COLOUR_HOPEFUL = ['and folk say there is a reward for whoever sorts it out', 'and the harvest looks better than it has in years', 'and a rich patron is asking for brave hands', 'and some say it is a sign of better days'];

export const TRAVEL_EVENTS: { terrain: string; text: string }[] = [
  { terrain: 'any', text: 'A merchant wagon is stuck in a rut. The driver offers coin or a favour for a push.' },
  { terrain: 'any', text: 'A column of tired soldiers marches the other way and will not say what they are running from.' },
  { terrain: 'any', text: 'A lone traveller asks to share the fire. They know a story that is a little too useful.' },
  { terrain: 'any', text: 'Fresh tracks cross the path: many boots, one pair dragging something heavy.' },
  { terrain: 'any', text: 'A shrine to a forgotten saint stands by the way, its offerings bowl full of old coins.' },
  { terrain: 'road', text: 'A toll gate that was not here last month. The keeper is nervous and the fees keep changing.' },
  { terrain: 'road', text: 'Bandits have felled a tree across the road, but they look hungrier than fierce.' },
  { terrain: 'forest', text: 'The birds fall silent all at once. Something large is moving parallel to the path.' },
  { terrain: 'forest', text: 'A ring of pale mushrooms, and inside it a lost child\'s shoe, still warm.' },
  { terrain: 'forest', text: 'A hunter\'s snare has caught something that is clearly not an animal.' },
  { terrain: 'mountain', text: 'A rockfall has closed the pass. Fresh scratches on the rocks suggest it was not an accident.' },
  { terrain: 'mountain', text: 'A rope bridge sways over a gorge. On the far side, someone is waving a lantern.' },
  { terrain: 'swamp', text: 'Lights bob over the reeds, leading off the safe path. One of them blinks twice.' },
  { terrain: 'swamp', text: 'A half-sunk boat holds a locked chest and a very recent corpse.' },
  { terrain: 'coast', text: 'The tide has left a ship\'s figurehead on the shingle, still wet and still smiling.' },
  { terrain: 'coast', text: 'Smugglers\' lamps flash from the cliffs. They want the party to look the other way.' },
  { terrain: 'desert', text: 'A caravan lies abandoned in the sand. The water barrels are full and the animals are gone.' },
  { terrain: 'desert', text: 'A sandstorm rolls in fast. A buried ruin shows its doorway as the dunes shift.' },
  { terrain: 'arctic', text: 'A frozen traveller sits upright against a boulder, one hand clutching a sealed letter.' },
  { terrain: 'underground', text: 'The tunnel floor is worn smooth by thousands of feet that left no other trace.' },
];
export const TRAVEL_CHECKS = ['Wisdom (Survival) to read the signs', 'Wisdom (Perception) to spot it first', 'Charisma (Persuasion) to talk it down', 'Dexterity (Stealth) to slip past', 'Constitution save against the weather', 'Intelligence (Investigation) to piece it together'];

export const WEATHER: Record<string, { cond: string; temp: string }[]> = {
  winter: [{ cond: 'Bitter wind and driving snow, visibility short', temp: 'far below freezing' }, { cond: 'Still, bright and bone cold; breath hangs in the air', temp: 'below freezing' }, { cond: 'Low grey cloud and a thin sleet', temp: 'just above freezing' }, { cond: 'Heavy fog that muffles every sound', temp: 'cold and damp' }],
  spring: [{ cond: 'Steady rain, mud on every road', temp: 'cool' }, { cond: 'Bright showers that clear by afternoon', temp: 'mild' }, { cond: 'A warm breeze and high clouds', temp: 'mild' }, { cond: 'Late frost and a cold, clear morning', temp: 'chilly' }],
  summer: [{ cond: 'Hot, clear and dry; the air shimmers over the road', temp: 'hot' }, { cond: 'Heavy and humid, thunderheads building to the west', temp: 'warm and sticky' }, { cond: 'A cool sea breeze and long golden light', temp: 'warm' }, { cond: 'A violent afternoon thunderstorm', temp: 'warm, then cooler' }],
  autumn: [{ cond: 'Crisp and bright, leaves falling in drifts', temp: 'cool' }, { cond: 'Low mist in the morning, burning off by noon', temp: 'cool' }, { cond: 'Gusting wind and scattered squalls', temp: 'chilly' }, { cond: 'Steady cold rain that turns the roads to soup', temp: 'cold' }],
  temperate: [{ cond: 'Overcast with a light wind', temp: 'mild' }, { cond: 'Patchy sun and passing showers', temp: 'mild' }, { cond: 'Clear and calm', temp: 'mild' }, { cond: 'Gloomy drizzle all day', temp: 'cool' }],
};
export const WEATHER_EFFECT = ['No game effect.', 'Disadvantage on Wisdom (Perception) checks that rely on hearing.', 'Travel is slowed to three-quarters pace on open ground.', 'Open flames gutter; torches need shielding.', 'Long-range attacks are made at disadvantage.', 'Anyone without shelter risks a level of exhaustion if they sleep outside.'];

export const TRAP_TRIGGER = ['a loose flagstone', 'a tripwire at ankle height', 'opening the door without lifting the latch', 'lifting the offered object from its plinth', 'speaking in the room', 'a lit torch passing the threshold', 'a lever hidden behind a sconce', 'weight on the third stair'];
export const TRAP_EFFECT = ['a scything blade sweeps across the passage', 'poisoned darts hiss from the walls', 'the floor drops away into a pit with spikes', 'the doors seal and the room begins to flood', 'a gout of fire erupts from the carved mouths', 'a rolling stone fills the corridor', 'a cloud of choking spores billows out', 'an alarm gong rings and the nearest guards wake'];
export const TRAP_NAME = ['Pressure plate', 'Tripwire blades', 'Booby-trapped door', 'Cursed plinth', 'Whisper trap', 'Torch-sensitive jets', 'Hidden lever', 'Collapsing stair'];
export const TRAP_DETECT = ['faint scratches on the stone', 'a draught from a hidden slot', 'a dull sheen of oil on the hinges', 'dust disturbed in a straight line', 'a smell of old metal'];
export const TRAP_DISARM = ['jam the mechanism with iron spikes', 'cut the wire before it draws taut', 'plug the vents with cloth', 'wedge the plate with a thrown dagger', 'find and turn the hidden stop-cock'];

export const RIDDLES: { q: string; a: string; hint: string }[] = [
  { q: 'I have cities but no houses, forests but no trees, and water but no fish. What am I?', a: 'A map', hint: 'Travellers carry me.' },
  { q: 'The more you take from me, the larger I grow. What am I?', a: 'A hole', hint: 'Dig deeper.' },
  { q: 'I speak without a mouth and answer when you call, yet I have no ears. What am I?', a: 'An echo', hint: 'Try the cave mouth.' },
  { q: 'I am light as a feather, yet the strongest person cannot hold me for long. What am I?', a: 'Breath', hint: 'You have it now.' },
  { q: 'I run but never walk, have a bed but never sleep. What am I?', a: 'A river', hint: 'Look to the water.' },
  { q: 'Three sisters stand in a row: the first is bright, the second drips, the third devours them both. Who are they?', a: 'Flame, wax and wick (a candle burning)', hint: 'Light the room.' },
  { q: 'What goes up when the rain comes down?', a: 'An umbrella', hint: 'A shelter you carry.' },
  { q: 'I have teeth but cannot bite, and I am useless alone. What am I?', a: 'A comb (or a saw)', hint: 'Look in the pocket or the toolbox.' },
  { q: 'The one who makes me does not want me; the one who buys me does not use me; the one who uses me does not know it. What am I?', a: 'A coffin', hint: 'Silence follows.' },
  { q: 'I am always coming but never arrive. What am I?', a: 'Tomorrow', hint: 'Wait for the sun.' },
];
export const PUZZLE_MECH = [
  { name: 'Standing stones', text: 'Five carved stones stand in a ring, each turning on its base. Their faces show a sun, moon, tree, wave and flame. A mural above shows them in one fixed order.', solution: 'Turn them to match the mural order: sun, wave, tree, flame, moon.', fail: 'A wrong turn resets all five and a cold wind blows out any open flame.' },
  { name: 'Weighing pans', text: 'A beam balance holds an empty pan on the left and a lit brazier on the right. Weights of five sizes sit in a niche, each stamped with a number.', solution: 'Weights totalling exactly the number written over the door balance the pan and open it.', fail: 'Too heavy and the floor tips by a few degrees; too light and the brazier flares.' },
  { name: 'Mirror gallery', text: 'A long hall is lined with tarnished mirrors. A thin beam of light enters from a slit and falls on the first.', solution: 'Angle four mirrors so the beam lands on the sunburst carving on the far wall.', fail: 'A mirror that catches the beam wrongly lashes out with a hot flash for 2d6 radiant damage.' },
  { name: 'Silent lock', text: 'A door has no handle. Eight brass bells hang in a row, each a different size, with a worn bell-rope in front of each.', solution: 'Ring them smallest to largest, in the order of the nursery rhyme carved beside the door.', fail: 'A discordant jangle that wakes anything that sleeps within earshot.' },
];

export const ROOM_PURPOSE = ['a guard post gone quiet', 'a flooded cistern', 'a collapsed library', 'a shrine to something that does not like being named', 'a barracks with the beds still made', 'an alchemist\'s workshop, half-burnt', 'a prison of narrow cells', 'a feasting hall for a very long-dead court', 'a forge with a cold, glowing anvil', 'a crypt with one open sarcophagus', 'a garden of pale, stone-hard flowers', 'a storeroom with a locked inner vault'];
export const ROOM_LIGHT = ['pitch black', 'lit by a faint green glow', 'dimly lit by a single oil lamp', 'bright with shafts of daylight from above', 'lit by guttering torches in iron cages'];
export const ROOM_SENSE = ['the air smells of wet stone and old smoke', 'something drips steadily just out of sight', 'a low hum rises from the floor', 'the walls are scored with tally marks', 'every footstep echoes twice', 'a draught carries a whisper of a tune'];
export const ROOM_EXITS = ['a stout door to the north and a narrow stair down', 'two archways, one bricked halfway up', 'a rusted grate in the floor and a door to the east', 'one door, iron-banded and barred from the far side', 'a collapsed tunnel mouth and a ladder up'];
export const ROOM_HAZARD = ['a rotten floor over a drop', 'a patch of slick, glowing fungus', 'unstable shelves of heavy tomes', 'a pool of green water that stirs when disturbed', 'nothing, which is its own kind of worry'];
export const ROOM_SECRET = ['a loose brick hides a small key', 'the mural\'s eyes follow a hidden pressure plate', 'a false back to the sarcophagus leads to a cramped passage', 'a chimney flue is wide enough to climb', 'the lamp is a lever; turning it opens a vault'];

export const FACTION_NAME_A = ['Order of', 'Brotherhood of', 'Company of', 'Circle of', 'Guild of', 'Court of', 'Sisters of', 'League of'];
export const FACTION_NAME_B = ['the Ashen Hand', 'the Lantern Road', 'the Gilded Knife', 'the Silent Tide', 'the Black Orchard', 'the Seventh Bell', 'the Hollow Crown', 'the Quiet Ledger', 'the Rising Salt', 'the Thorn and Rose'];
export const FACTION_GOAL = ['seize control of the harbour trade', 'recover a relic lost in the last war', 'keep a terrible secret buried', 'bring back an old king', 'drive foreigners out of the valley', 'corner the market in a rare herb', 'open a sealed gate beneath the city', 'protect the poor from the powerful, at any price'];
export const FACTION_METHOD = ['bribery and blackmail', 'open force and intimidation', 'a network of informants in every tavern', 'charity that builds loyalty', 'forged documents and patient lawsuits', 'sabotage and "accidents"', 'persuading the right people at the right dinners'];
export const FACTION_RESOURCE = ['a fleet of small boats', 'two dozen hardened enforcers', 'an old keep with secret cellars', 'a seat on the town council', 'a stash of alchemical fire', 'a friendly priest who hears confessions', 'ten years of other people\'s debts'];
export const FACTION_SECRET = ['their leader is not who the members believe', 'half of them want out and are afraid to say so', 'they are secretly funded by their greatest rival', 'the founding story is a lie', 'a council member is their puppet', 'their relic is a fake'];

export const SETTLE_ECON = ['fishing and salt', 'sheep and wool', 'iron and charcoal', 'a busy river crossing', 'orchards and cider', 'pilgrim traffic', 'timber and shipbuilding', 'a small but rich silver seam'];
export const SETTLE_FEATURE = ['a crooked stone bridge', 'a market square with a cracked fountain', 'an old watchtower, now a granary', 'a temple with a bell that never rings true', 'a tannery whose smell reaches the next hill', 'a well that is older than the village', 'a hall where the elders meet', 'a lone standing stone at the edge of the green'];
export const SETTLE_PROBLEM = ['the harvest is failing and nobody agrees why', 'a stranger bought the empty mill and will not come out', 'tax collectors are three months late, which is worrying', 'children are sleepwalking toward the woods', 'the mayor is ill and two relatives want his seat', 'wolves are bolder every night', 'a feud between two families is turning ugly', 'a caravan has not arrived and the wine is running low'];
export const SETTLE_SECRET = ['the founder\'s tomb was never moved from beneath the church', 'the headman owes a debt to something that is due', 'the water is slowly making people forgetful', 'a smuggling tunnel runs under three of the houses', 'half the "visitors" are spies for the neighbouring lord'];
export const SETTLE_SIZE: Record<string, [number, number]> = { hamlet: [20, 80], village: [80, 400], town: [400, 5000], city: [5000, 40000] };

export const BARKS: Record<string, string[]> = {
  friendly: ['Well met! You look like you could use a warm drink and a better map.', 'Anything I can do, you just ask. I mean it.', 'Mind the third step, it bites. Come in, come in.', 'You are the first friendly faces I have seen all week.'],
  neutral: ['Can I help you, or are you just here to stand in the road?', 'I have work to do, so keep it short.', 'Whatever it is, I am sure it is not my business.', 'Fair weather for it, anyway.'],
  hostile: ['This is not your quarter. Walk on.', 'One more step and you will regret it.', 'I know your sort. Trouble follows you like crows.', 'Say what you came to say and then leave.'],
  afraid: ['Please, keep your voice down. They have ears everywhere.', 'I did not see anything. I swear I did not.', 'Have you not heard what happened at the old mill?', 'I would not go that way if I were you. I would not go that way at all.'],
  greedy: ['That is a fine ring. How fine? Because I have a buyer.', 'Everything has a price, friend. Name yours.', 'For a coin or two I might remember something useful.', 'Information is not free, but my rates are fair. Mostly.'],
  mysterious: ['The tide turns at midnight, and so, I think, will you.', 'Some doors only open for those who knock three times.', 'You have the look of someone who is about to ask the wrong question.', 'I could tell you, but then there would be no reason for us to meet again.'],
};

export const LETTER_OPEN = ['To whom it may concern,', 'Dear friend,', 'To the bearer of this letter,', 'Greetings, and I hope this finds you well,', 'By my hand and seal,'];
export const LETTER_BODY = ['Events have moved faster than I expected. I must speak with you before the next full moon, and not in a place where walls have ears.', 'The matter we discussed has taken a turn I do not like. Meet me where the old road crosses the river, and come alone if you can.', 'I have something that belongs to you, and something that belongs to someone else that you may wish to see first. Come by the back door.', 'You were right about the ledger. Three of the names are missing, and one of them is yours. Burn this once you have read it.', 'There is work for you, and it pays well. The only condition is that you do not ask who sent it.'];
export const LETTER_CLOSE = ['Yours in haste,', 'Burn this when read,', 'With respect,', 'In trust,', 'Do not delay,'];

export const MONOLOGUE_OPEN: Record<string, string[]> = {
  revealed: ['So. You found me. I wondered how long it would take.', 'You think this is the end of something? It is only the middle.'],
  captured: ['Go on, then. You have me. But you have not asked the right question yet.', 'Chains. How quaint. They will not hold what I have already set in motion.'],
  victory: ['Look at you all. You came so close. That is the cruellest part.', 'Kneel, or do not; it makes no difference now.'],
  bargain: ['Let us not be fools. There is a deal here that serves us both.', 'You want something. I want something. Sit, and we shall see if the two can be made to fit.'],
};
export const MONOLOGUE_MID = ['Every road you took led here, and every door you opened was one I had already unlocked for you.', 'I was patient when the world was cruel to me. It was the patience that made me what I am.', 'You call me a villain. I call myself the only one honest enough to finish what the rest began.', 'The old order did not fall; it was given a push by someone who understood it better than its guardians ever did.'];
export const MONOLOGUE_TELL = ['Taps a ring against the table when angry', 'Smiles a half-second too late', 'Never raises their voice, and grows quieter when furious', 'Quotes the party\'s own words back to them', 'Glances toward the door when lying'];

export const SPINE_NPC_ROLE = ['innkeeper', 'ferryman', 'smith', 'herbalist', 'guard captain', 'priest', 'fence', 'scribe', 'farmer', 'sailor'];
export const MOODS = ['friendly', 'neutral', 'hostile', 'afraid', 'greedy', 'mysterious'];

export const GEMS = ['a polished moonstone (50 gp)', 'a small garnet (100 gp)', 'a rough sapphire (250 gp)', 'a clouded pearl (100 gp)', 'a bloodstone (50 gp)', 'a jade carving (150 gp)', 'a tourmaline (100 gp)', 'a black opal (500 gp)', 'a silver ring set with amber (75 gp)'];
export const ART = ['a gilded candlestick (25 gp)', 'a silver goblet engraved with ravens (75 gp)', 'a small oil painting of a lost city (250 gp)', 'an ivory comb (50 gp)', 'a brass astrolabe (150 gp)', 'a tapestry roll (200 gp)'];

export const TACTICS = ['They open from cover, then fall back to draw the party into a choke point.', 'The strongest hold the front while the weakest harry from the flanks.', 'They go for the lightest armour first and retreat when half are down.', 'They ambush from above or behind; if the ambush fails they scatter and regroup.', 'They fight to defend something and will not give ground until it is safe.', 'They target spellcasters, using the environment to break line of sight.'];
export const SESSION_CHECKLIST = ['Reread last session\'s notes and open threads', 'Choose three scenes you could run, in any order', 'Prepare one encounter for each pace: easy, tense, deadly', 'Have names ready for five NPCs the party may meet', 'Decide what the party can learn and what must wait', 'Check the clock: date, weather, upcoming events', 'Know the next secret you want to reveal', 'Set out maps, handouts and music'];
export const PREP_SCENE = ['A tense meeting where the party must choose a side', 'A quiet scene at an inn that hides a threat', 'A chase through crowded streets', 'A discovery in an abandoned place', 'An unexpected visitor with news'];
