// NPC generator. A race-correct name (quickgen), a look, a voice and mannerism,
// a want, a secret, a hook and a tie to something real in the world (a place or
// faction the DM can see: never classified), from tables of our own. Every field
// can be locked while the rest is rerolled. Optionally a quick statblock.
import { genNames, RACES, type Race } from '../quickgen/api.ts';
import { chance, int, makeRng, pick, seedOf, type Rng } from '../quickgen/rng.ts';
import type { Statblock } from '../agent/statblock.ts';
import { crForParty, crRow, parseCr } from './cr.ts';
import { genHumanoid } from './monster.ts';
import type { WorldInfo, Tie } from './world.ts';

export const NPC_PRESETS = ['tavern-keeper', 'villain', 'shopkeeper', 'noble', 'wizard', 'rogue', 'cleric', 'quest-giver', 'town-guard', 'dwarf', 'elf', 'random'] as const;
export type NpcPreset = (typeof NPC_PRESETS)[number];
export const NPC_LOCKABLE = ['name', 'race', 'look', 'voice', 'want', 'secret', 'hook', 'tie'] as const;

interface Role { label: string; occ: string[]; races?: Race[]; cr: number; clothes: string[]; want: string[]; secret: string[]; hook: string[] }

const BUILD = ['stocky', 'lanky', 'broad-shouldered', 'wiry', 'round-bellied', 'tall and stooped', 'compact and quick', 'heavy-set', 'slight', 'barrel-chested', 'long-limbed', 'weathered and thin'];
const FACE = ['a crooked nose that has been broken at least twice', 'bright, restless eyes', 'deep laugh lines', 'a neatly trimmed beard with a single braid', 'a scar through one eyebrow', 'freckles and a gap-toothed grin', 'sunken cheeks and heavy-lidded eyes', 'a face that is hard to remember', 'a shaved head and a tattoo behind one ear', 'grey streaks in dark hair', 'warm brown eyes that never quite settle', 'one eye clouded white', 'a wide, patient smile', 'hands stained with ink or soot'];
const DISTINCT = ['A ring on every finger but one.', 'Always smells faintly of woodsmoke and cloves.', 'Carries a small bell that chimes when they move.', 'Missing the last two fingers on the left hand.', 'Wears a coin on a cord around the neck.', 'Is never seen without a chewed pipe or quill.', 'Has a pet raven that watches everything.', 'Hums a tune nobody else recognises.', 'Walks with a cane carved from a single bone.', 'Wears one boot a little too big.', 'Has a mark on the wrist that is always covered.', 'Keeps a tiny notebook and writes in it when no one is looking.', 'Blinks very slowly, as if remembering something.', 'Has an old military bearing, whatever the clothes.'];
const CLOTH_ANY = ['a patched travelling cloak over plain wool', 'a clean apron with scorch marks at the hem', 'a long coat the colour of old wine', 'a leather jerkin with a dozen small pockets', 'a faded tabard of a guild that no longer exists', 'good boots and a very plain shirt', 'a hooded cloak, mud to the knee', 'a waistcoat with brass buttons, one missing'];
const VOICE_Q = ['a low gravelly murmur', 'a bright, quick patter', 'a slow, careful drawl', 'a clipped formal tone', 'a warm, rolling baritone', 'a whisper that carries', 'a sing-song lilt', 'a flat voice that gives nothing away', 'a booming voice they keep trying to quiet', 'a gentle, tired voice', 'a rasp from too much smoke', 'a precise voice that finishes every word'];
const MANNER = ['counts things on their fingers while talking', 'never meets your eye until a deal is made', 'taps the table twice before saying anything important', 'clears their throat before every lie', 'repeats the last words you said', 'laughs a half-beat too late', 'leans in close and lowers their voice for even small talk', 'wipes their hands on whatever is nearest', 'adjusts a ring or buckle constantly', 'speaks in proverbs and gets them slightly wrong', 'glances at the door whenever it creaks', 'refuses to sit down', 'is unfailingly polite, even when threatening', 'drops a name at the start of every story'];
const WANT_ANY = ['a safe place to retire before their luck runs out', 'to be taken seriously by someone who matters', 'to find a person who vanished years ago', 'to pay off a debt before it is called in', 'to see a rival ruined without being blamed', 'to make one last great piece of work', 'revenge for an old insult nobody else remembers', 'to protect a child who is not theirs'];
const SECRET_ANY = ['is paying someone to keep quiet about an old crime', 'has been reading private letters for coin', 'knows the location of something the party wants', 'is not who they claim to be', 'is being blackmailed by someone the party knows', 'has a sick relative hidden in the cellar', 'forged the paper that gives them their position', 'saw something on the road and told no one'];
const HOOK_ANY = ['offers a job that is too well paid to be honest', 'asks the party to deliver a sealed letter without reading it', 'is followed by someone the party notices first', 'drops a name that is also on a wanted notice', 'needs a witness to sign a paper tonight', 'begs the party to look for something lost in the old well', 'passes the party a key and says nothing', 'recognises a party member\'s crest and goes pale'];

const ROLES: Record<string, Role> = {
  'tavern-keeper': { label: 'Tavern keeper', occ: ['tavern keeper', 'innkeeper', 'landlord', 'landlady', 'alehouse owner'], cr: 0, clothes: ['a stained apron and rolled sleeves', 'a clean white shirt and a ring of keys', 'a heavy leather bar-apron with a dozen hooks', 'a worn waistcoat and a towel over one shoulder'],
    want: ['to keep the taproom quiet for one whole night', 'to find out who is watering the cellar stock', 'a good bard before the festival', 'to buy out the neighbouring stable and add rooms', 'to forget a name scratched under the third table'],
    secret: ['pays protection to a gang and hates it', 'lets smugglers use the cellar for a share', 'is a retired adventurer hiding from an old party', 'brews a drink that is not entirely legal', 'keeps a ledger of every secret overheard'],
    hook: ['has a regular who has not paid in a week and is not in their room', 'wants the party to clear something out of the cellar before dusk', 'passes on a rumour for a free drink', 'has a stranger\'s locked trunk they would love to be rid of', 'needs a table of brave patrons to look like a good night'] },
  villain: { label: 'Villain', occ: ['cult leader', 'crime lord', 'corrupt magistrate', 'warlord', 'fallen paladin', 'spymaster'], cr: 5, clothes: ['black and silver, immaculate', 'a plain robe over fine armour', 'a mask of polished bone', 'riding leathers and a cloak lined with red'],
    want: ['to bring about an event that requires everyone in town to be in the wrong place', 'to rule what they were once denied', 'to claim an artefact that answers only to blood', 'to make a death look like an accident', 'to be remembered, whatever the cost'],
    secret: ['is dying and has less time than anyone knows', 'was once the party\'s ally in another life', 'is controlled by a patron they fear', 'does not actually want to win, only to be stopped', 'holds a hostage nobody knows is alive'],
    hook: ['sends a polite invitation to dinner', 'leaves a gift on the party\'s doorstep each time they win', 'offers one of the party exactly what they need', 'has taken someone the party knows', 'is seen, briefly, in the crowd at every disaster'] },
  shopkeeper: { label: 'Shopkeeper', occ: ['shopkeeper', 'merchant', 'peddler', 'apothecary', 'bookseller', 'general-store owner'], cr: 0, clothes: ['a tailored vest with a tape measure around the neck', 'a long apron and ink-stained cuffs', 'sleeve garters and a green eyeshade', 'a coat of many pockets and a lens on a cord'],
    want: ['to corner the market on lamp oil before winter', 'to sell one very strange item to the right buyer', 'to find who keeps stealing from the back room', 'to marry their daughter off into a better family', 'to be paid back for a shipment that never arrived'],
    secret: ['sells stolen goods through a false back wall', 'is going bankrupt and hiding it', 'keeps a cursed item under the counter and is afraid to sell it', 'reports every buyer of certain goods to the watch', 'is the broker\'s second set of eyes in town'],
    hook: ['offers a steep discount for a small favour', 'has an item no one has ever come back to collect', 'wants an escort for a wagon in the morning', 'swears a rival is poisoning the well and wants proof', 'has a map pressed inside an old book'] },
  noble: { label: 'Noble', occ: ['baron', 'lady of the manor', 'young lord', 'dowager', 'tax collector of the crown', 'courtier'], cr: 0.125, clothes: ['velvet the colour of dried roses, too warm for the season', 'a gold chain and a very plain sword', 'a high collar and gloves they never remove', 'a house-colour sash and a signet ring'],
    want: ['an heir that is not a disappointment', 'to unseat a cousin from a seat on the council', 'to marry someone useful, not someone liked', 'to hide that the family coffers are empty', 'to be loved by the common folk without lifting a finger'],
    secret: ['is the child of a servant and has never been told', 'owes a staggering sum to a foreign banker', 'dabbles in forbidden magic to keep the estate alive', 'has a double who attends the dull parties', 'is quietly funding the people they publicly condemn'],
    hook: ['hires the party to retrieve a letter before the wrong person reads it', 'has a dinner at which something must go wrong', 'invites the party to a hunt, with a reason', 'asks for protection from a threat they will not name', 'is about to sign a treaty and someone wants it to fail'] },
  wizard: { label: 'Wizard', occ: ['hedge wizard', 'court mage', 'retired archmage', 'apprentice', 'scholar of the arcane', 'alchemist'], cr: 3, clothes: ['robes scorched at the cuffs', 'a coat of tiny stitched runes', 'a hat that has lost a battle with a rainstorm', 'a pale scarf and a belt of small pouches'],
    want: ['one last spell component they cannot find', 'a student worthy of the work', 'to repair a mistake made forty years ago', 'access to the library no one is allowed to use', 'to prove a theory that everyone laughs at'],
    secret: ['has been dead for a decade and has not noticed the difference', 'is bound to something under their tower', 'cannot cast without a trinket they have lost', 'is writing the last chapter of someone else\'s grimoire', 'is slowly turning into the thing they study'],
    hook: ['needs someone to fetch a component from a dangerous place', 'has a door in the cellar that was not there last week', 'offers to identify a trinket in exchange for a favour', 'asks the party to witness an experiment', 'recognises a magical mark on a party member'] },
  rogue: { label: 'Rogue', occ: ['pickpocket', 'fence', 'smuggler', 'burglar', 'informant', 'con artist'], cr: 1, clothes: ['dark, close-fitting layers with a dozen cunning pockets', 'a respectable clerk\'s coat that does not fit quite right', 'a worn travelling cloak and soft boots', 'a bright waistcoat with a loose thread'],
    want: ['to be rid of a guild debt without a knife in the back', 'one big score and a boat out of town', 'to find the partner who left them to hang', 'to get a name off a wanted list', 'to have one honest day and see how it feels'],
    secret: ['is an informant for the watch', 'has forgotten how to be honest and is a little frightened of it', 'is hiding a stolen thing nobody can find', 'knows where the thieves\' guild keeps its coin', 'is the best forger in the district'],
    hook: ['slips a note into a party member\'s pocket', 'offers a job that goes wrong in a clever way', 'sells a map they swear is genuine', 'is chased through the party by someone worse', 'has a tip about a vault that is not as empty as it seems'] },
  cleric: { label: 'Cleric', occ: ['village priest', 'temple healer', 'travelling friar', 'abbess', 'grave-warden', 'itinerant preacher'], cr: 2, clothes: ['plain vestments with the hem let down', 'a travelling cloak and a holy symbol on a cord', 'a stole over a well-patched robe', 'a white habit stained at the knees'],
    want: ['to build a hospice before winter', 'to be given a sign that the faith is not empty', 'to find the missing reliquary', 'to forgive someone who has not asked', 'a replacement for the bell that cracked'],
    secret: ['has lost their faith and keeps going for others', 'hides a refugee in the crypt', 'was once a soldier and remembers it too well', 'keeps a ledger of every confession and has never used it', 'hears a voice that is not their god\'s'],
    hook: ['asks the party to escort a pilgrim', 'wants a body buried before dawn, quietly', 'offers sanctuary and a request', 'has a relic that is behaving strangely', 'needs a courier to carry a blessing to a dying lord'] },
  'quest-giver': { label: 'Quest giver', occ: ['mayor', 'caravan master', 'desperate farmer', 'guild clerk', 'old soldier', 'widow'], cr: 0, clothes: ['travel-stained and tired', 'their best clothes, worn thin', 'a good coat hung on a poor frame', 'a ribbon of office on a plain jacket'],
    want: ['someone to deal with a problem they cannot say aloud', 'proof that the old story is true', 'to see a promise kept', 'to have the road open again before market day', 'a messenger who will not be intercepted'],
    secret: ['caused the problem themselves', 'is offering far less than the job is worth', 'knows who is really behind it and cannot say', 'has already sent three parties who never returned', 'wants the party to fail for reasons of their own'],
    hook: ['lays out a pouch of coin and a worried look', 'has a map with one place marked and scratched out', 'speaks of a reward that grows each time they say it', 'has a good reason to ask now and not later', 'asks for the party by name, which is odd'] },
  'town-guard': { label: 'Town guard', occ: ['gate guard', 'watch sergeant', 'night patrol', 'wall sentry', 'captain of the watch', 'bailiff'], cr: 0.125, clothes: ['a dented helm and a tabard that has seen better years', 'mail under a surcoat in the town colours', 'a leather cap and a heavy cudgel', 'a polished breastplate and a clean cloak'],
    want: ['to finish their shift without incident', 'a promotion nobody has promised', 'to stop a rumour about the captain', 'to catch whoever has been breaking into the granary', 'to see a particular person leave town for good'],
    secret: ['takes bribes at the east gate', 'lets one family through at night for reasons of the heart', 'was part of the thing the watch pretends did not happen', 'is a thieves\' guild plant', 'has been ordered to arrest a stranger and does not agree'],
    hook: ['asks the party to look the other way for ten minutes', 'warns of a curfew starting tonight', 'wants a witness to sign a report', 'has a prisoner who asked for the party by name', 'needs a hand with something that needs not to be official'] },
  dwarf: { label: 'Dwarf', occ: ['stonemason', 'brewer', 'smith', 'tunnel-warden', 'rune-carver', 'clan factor'], races: ['dwarf'], cr: 0.5, clothes: ['a leather apron over a mail shirt', 'a braided beard beaded with copper rings', 'good boots and a hammer on the belt', 'a clan sash across a worn work-coat'],
    want: ['to finish the work that will outlast them', 'an old grievance settled in the old way', 'to taste one particular ale again', 'to restore a name struck from the clan roll', 'to be buried under stone and not under tile'],
    secret: ['knows a seam of ore the clan does not', 'is exiled and has told no one', 'found a door in the deep and closed it', 'broke an oath for an excellent reason', 'is more worried about the tunnels than they admit'],
    hook: ['will trade a favour for an escort into the lower tunnels', 'has a chunk of strange ore no one can identify', 'offers a good price for a particular rare thing', 'asks the party to carry a gift to a clan far off', 'has heard hammering from a mine that is supposed to be empty'] },
  elf: { label: 'Elf', occ: ['archer', 'herbalist', 'scribe', 'wanderer', 'court singer', 'grove warden'], races: ['elf'], cr: 0.5, clothes: ['layers of undyed linen and a cloak of leaf-green', 'a long coat embroidered with tiny stars', 'a travelling cloak and a bow too fine for the road', 'robes that shift in the light like water'],
    want: ['to hear one song they heard as a child', 'to see a particular tree flower again', 'to deliver a message to someone long gone', 'to find who has been cutting the old grove', 'to keep a promise that should have ended with their friend'],
    secret: ['is far older than they look and weary of it', 'carries the last seed of something', 'left the court under a cloud and cannot go back', 'is bound by a debt to a fey creature', 'speaks the thoughts of the trees and is afraid to say what they said'],
    hook: ['has a place to show the party that the maps do not', 'asks the party to witness a farewell', 'trades a small gift for a large favour', 'is followed by hunters who say they are friends', 'offers to read the party\'s fortune in the stars'] },
};

const SEED_RACES: Race[] = ['human', 'human', 'human', 'halfling', 'half-elf', 'dwarf', 'elf', 'gnome', 'half-orc', 'tiefling', 'dragonborn'];
const TIE_PLACE = ['grew up in', 'fled from', 'owes a debt in', 'once served a lord in', 'keeps a secret about', 'has family in', 'was robbed in', 'is buried a husband in'];
const TIE_FACTION = ['pays dues to', 'informs on', 'used to belong to', 'is courted by', 'is hunted by', 'quietly serves', 'once cheated', 'owes a favour to'];

export interface NpcOpts {
  preset?: string; race?: string; gender?: string; partyLevel?: number; partySize?: number; seed?: string | number;
  statblock?: boolean; cr?: number | string; nameStyle?: string; locks?: Record<string, unknown>; world?: WorldInfo;
}
export interface NpcResult {
  seed: string; preset: string; role: string; fields: Record<string, string>;
  tie: Pick<Tie, 'id' | 'title' | 'kind' | 'partyVisible'> | null;
  statblock?: Statblock; cr?: number;
}

const lockStr = (locks: Record<string, unknown> | undefined, k: string): string | undefined => {
  const v = locks?.[k];
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 600) : undefined;
};

export function genNpc(o: NpcOpts = {}): NpcResult {
  const seed = seedOf(o.seed);
  const r = makeRng(`${seed}|npc`);
  let preset = String(o.preset ?? 'random').toLowerCase().replace(/[\s_]+/g, '-');
  if (preset === 'merchant') preset = 'shopkeeper'; if (preset === 'priest') preset = 'cleric'; if (preset === 'guard') preset = 'town-guard'; if (preset === 'innkeeper' || preset === 'tavernkeeper') preset = 'tavern-keeper';
  if (!(NPC_PRESETS as readonly string[]).includes(preset)) throw new RangeError(`preset must be one of ${NPC_PRESETS.join(', ')}`);
  const chosen = preset === 'random' ? pick(r, NPC_PRESETS.filter((p) => p !== 'random')) : preset;
  const role = ROLES[chosen];
  const locks = o.locks && typeof o.locks === 'object' ? o.locks : {};

  // race and name
  let race = lockStr(locks, 'race') ?? String(o.race ?? '').toLowerCase().replace(/[\s_]+/g, '-');
  if (!race || race === 'any') race = role.races ? pick(r, role.races) : pick(r, SEED_RACES);
  if (!(RACES as readonly string[]).includes(race)) throw new RangeError(`race must be one of ${RACES.join(', ')}`);
  const gender = String(o.gender || 'any').toLowerCase();
  if (gender !== 'any' && gender !== 'male' && gender !== 'female') throw new RangeError('gender must be any, male or female');
  const nm = genNames({ race, gender, count: 1, seed: `${seed}|name`, style: o.nameStyle });
  const given = nm.names[0];
  // avoid names already in the library when the world says so
  let name = given?.name ?? 'Nameless';
  if (o.world?.titles.size) {
    for (let i = 0; i < 8 && o.world.titles.has(name.toLowerCase()); i++) name = genNames({ race, gender, count: 1, seed: `${seed}|name|${i}`, style: o.nameStyle }).names[0]?.name ?? name;
  }
  name = lockStr(locks, 'name') ?? name;
  const gnd = given?.gender ?? 'male';

  // text fields
  const occ = pick(r, role.occ);
  const look = `${pick(r, BUILD)} ${race}${gender === 'any' ? '' : ` (${gnd})`} with ${pick(r, FACE)}, in ${chance(r, 0.6) ? pick(r, role.clothes) : pick(r, CLOTH_ANY)}. ${pick(r, DISTINCT)}`.replace(/^./, (c) => c.toUpperCase());
  const voice = `${pick(r, VOICE_Q).replace(/^./, (c) => c.toUpperCase())}; ${pick(r, MANNER)}.`;
  const want = chance(r, 0.75) ? pick(r, role.want) : pick(r, WANT_ANY);
  const secret = chance(r, 0.75) ? pick(r, role.secret) : pick(r, SECRET_ANY);
  const hook = chance(r, 0.75) ? pick(r, role.hook) : pick(r, HOOK_ANY);

  // tie to the world: a place or a faction the DM can see (never classified); none when the world has neither
  const lockedTie = lockStr(locks, 'tie');
  const pool: Tie[] = [...(o.world?.places ?? []), ...(o.world?.factions ?? [])];
  let tie: NpcResult['tie'] = null;
  let tieText = '';
  const rt = r(); const rp = int(r, 0, 1000); // always consume, so locking never shifts later rolls
  if (lockedTie) {
    const hit = pool.find((t) => lockedTie.toLowerCase().includes(t.title.toLowerCase()));
    tie = hit ? { id: hit.id, title: hit.title, kind: hit.kind, partyVisible: hit.partyVisible } : null;
    tieText = lockedTie;
  } else if (pool.length) {
    const places = o.world!.places, factions = o.world!.factions;
    const usePlace = places.length && (!factions.length || rt < 0.5);
    const list = usePlace ? places : factions;
    const t = list[rp % list.length];
    tie = { id: t.id, title: t.title, kind: t.kind, partyVisible: t.partyVisible };
    tieText = `${pick(r, usePlace ? TIE_PLACE : TIE_FACTION)} ${t.title}`.replace(/^./, (c) => c.toUpperCase());
    tieText = `${name.split(' ')[0]} ${tieText.charAt(0).toLowerCase()}${tieText.slice(1)}.`;
  }
  const fields: Record<string, string> = {
    name, race, role: occ, look: lockStr(locks, 'look') ?? look, voice: lockStr(locks, 'voice') ?? voice,
    want: lockStr(locks, 'want') ?? cap1(want), secret: lockStr(locks, 'secret') ?? `${name.split(' ')[0]} ${secret}.`, hook: lockStr(locks, 'hook') ?? `${name.split(' ')[0]} ${hook}.`,
    ...(tieText ? { tie: tieText } : {}),
  };
  const out: NpcResult = { seed, preset: chosen, role: occ, fields, tie };
  if (o.statblock) {
    const cr = o.cr !== undefined && o.cr !== '' && o.cr !== null ? parseCr(o.cr) : chosen === 'villain' ? crForParty(Number(o.partyLevel ?? 5), Number(o.partySize ?? 4), true) : role.cr;
    out.cr = cr;
    out.statblock = genHumanoid(`${chosen} ${occ}`, cr, name, makeRng(`${seed}|sb`));
  }
  void crRow;
  return out;
}
const cap1 = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.') : s);

/** The sections of an NPC page, in order. `dm` ones never go in a player copy. */
export function npcSections(n: Pick<NpcResult, 'fields' | 'preset' | 'role'>): { key: string; label: string; text: string; dm?: boolean }[] {
  const f = n.fields;
  const out: { key: string; label: string; text: string; dm?: boolean }[] = [
    { key: 'look', label: 'Look', text: f.look }, { key: 'voice', label: 'Voice and manner', text: f.voice },
    { key: 'want', label: 'Wants', text: f.want, dm: true }, { key: 'secret', label: 'Secret', text: f.secret, dm: true }, { key: 'hook', label: 'Hook', text: f.hook, dm: true },
  ];
  if (f.tie) out.push({ key: 'tie', label: 'Ties to the world', text: f.tie, dm: true });
  return out;
}
