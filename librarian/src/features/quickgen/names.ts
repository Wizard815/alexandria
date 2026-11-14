// Names by race and gender. Every race has its own syllable sets and
// patterns, and a few short word lists for family and clan names. Nothing
// here is copied from a published table. Same seed, same names; no repeats
// within one batch; a filter drops anything that reads as a slur.
import { type Rng, chance, makeRng, pick, seedOf } from './rng.ts';

export const RACES = ['human', 'elf', 'half-elf', 'dwarf', 'halfling', 'gnome', 'half-orc', 'orc', 'tiefling', 'dragonborn', 'goliath', 'aasimar'] as const;
export const GENDERS = ['male', 'female'] as const;
export type Race = (typeof RACES)[number];
export type Gender = (typeof GENDERS)[number];
export type NameStyle = 'default' | 'virtue';

export interface GeneratedName { name: string; given: string; family: string; race: Race; gender: Gender }
export interface NamesResult { seed: string; race: string; gender: string; names: GeneratedName[] }
export interface NamesOpts { race?: string; gender?: string; count?: number; seed?: string | number; style?: string }

/** Syllable set: onset + (0..2 middles) + ending. `mid` is the chance of a middle. */
interface Syl { a: string[]; m: string[]; z: string[]; mid: number }
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const build = (r: Rng, s: Syl): string => {
  let out = pick(r, s.a);
  const mids = chance(r, s.mid) ? (chance(r, 0.25) ? 2 : 1) : 0;
  for (let i = 0; i < mids; i++) out += pick(r, s.m);
  return cap(out + pick(r, s.z));
};
const compound = (r: Rng, a: string[], b: string[]) => cap(pick(r, a) + pick(r, b));

const HUMAN = {
  male: { a: ['bar', 'cor', 'dam', 'ed', 'fen', 'gar', 'hal', 'jor', 'kel', 'lor', 'mar', 'nor', 'os', 'per', 'rol', 'sam', 'tor', 'wil', 'bran', 'dren', 'thom', 'har'], m: ['a', 'e', 'i', 'o', 'en', 'in', 'ar'], z: ['an', 'ick', 'ard', 'on', 'us', 'in', 'ric', 'mund', 'ren', 'wyn', 'ter', 'lan'], mid: 0.3 },
  female: { a: ['al', 'bri', 'cel', 'da', 'el', 'fay', 'gwen', 'hel', 'is', 'jan', 'kay', 'lil', 'mar', 'nel', 'ora', 'pen', 'ros', 'sel', 'tess', 'wen', 'yar', 'eli'], m: ['a', 'e', 'i', 'li', 'ra', 'na', 'en'], z: ['a', 'ia', 'ine', 'elle', 'wyn', 'ana', 'ette', 'ith', 'ra', 'lyn', 'ora', 'ey'], mid: 0.3 },
};
const HUMAN_FAM = { a: ['ash', 'black', 'brook', 'cold', 'dun', 'east', 'fair', 'glen', 'hart', 'iron', 'long', 'mill', 'north', 'oak', 'pike', 'red', 'stone', 'thorn', 'west', 'wood', 'hollow', 'marsh'], z: ['ford', 'worth', 'ley', 'stead', 'wick', 'ham', 'field', 'man', 'son', 'croft', 'well', 'by', 'ton', 'shaw'] };

const ELF = {
  male: { a: ['ael', 'cal', 'er', 'fae', 'ith', 'lor', 'mel', 'nar', 'ol', 'rhy', 'sil', 'tha', 'vae', 'zeph', 'ilu'], m: ['a', 'e', 'ia', 'ae', 'ri', 'li', 'na', 'th'], z: ['ion', 'ril', 'an', 'eth', 'dor', 'ael', 'iel', 'as', 'or', 'ien'], mid: 0.55 },
  female: { a: ['ael', 'ari', 'cae', 'eli', 'fae', 'ila', 'lue', 'mia', 'nym', 'sael', 'tir', 'vael', 'yla', 'osa'], m: ['a', 'e', 'ia', 'ae', 'ri', 'li', 'na', 'sh'], z: ['wen', 'iel', 'ara', 'ia', 'ith', 'elle', 'ine', 'lis', 'anna', 'ea'], mid: 0.55 },
};
const ELF_FAM = { a: ['moon', 'star', 'dew', 'thorn', 'ember', 'mist', 'wren', 'lark', 'frost', 'ivy', 'amber', 'rain', 'silver', 'willow', 'dusk', 'dawn'], z: ['song', 'bough', 'glade', 'step', 'weave', 'shade', 'whisper', 'leaf', 'brook', 'wind', 'veil', 'light'] };

const DWARF = {
  male: { a: ['bar', 'bor', 'dur', 'dor', 'gim', 'gor', 'kaz', 'mor', 'thor', 'tor', 'bal', 'drom', 'rur', 'hald', 'brom'], m: ['a', 'o', 'u', 'in', 'ar', 'or'], z: ['in', 'ak', 'ur', 'dun', 'grim', 'rik', 'din', 'gar', 'li', 'mund', 'bek'], mid: 0.25 },
  female: { a: ['bri', 'dag', 'gun', 'hil', 'kar', 'mag', 'nor', 'rag', 'sig', 'thr', 'vel', 'amb', 'dis', 'ilda'], m: ['a', 'i', 'un', 'ar', 'ra'], z: ['a', 'da', 'ild', 'rid', 'dis', 'na', 'run', 'va', 'gret', 'wyn'], mid: 0.25 },
};
const DWARF_CLAN = { a: ['stone', 'iron', 'deep', 'anvil', 'coal', 'granite', 'rune', 'ore', 'copper', 'hammer', 'bronze', 'forge', 'cairn', 'slate'], z: ['beard', 'fist', 'hand', 'helm', 'delver', 'brow', 'shield', 'axe', 'back', 'heart', 'maker', 'vein'] };

const HALFLING = {
  male: { a: ['bil', 'cob', 'dun', 'fin', 'gar', 'hob', 'jas', 'lin', 'mer', 'nob', 'pip', 'rob', 'sam', 'tob', 'wil', 'ped'], m: ['o', 'e', 'a', 'i'], z: ['by', 'bo', 'wick', 'o', 'kin', 'ley', 'ric', 'lo', 'ton', 'rin'], mid: 0.2 },
  female: { a: ['ber', 'cas', 'dai', 'em', 'fen', 'gil', 'hil', 'ju', 'li', 'mar', 'nel', 'pri', 'ros', 'tan', 'wil', 'mol'], m: ['a', 'e', 'i', 'o'], z: ['lie', 'a', 'ly', 'bell', 'wyn', 'ie', 'dy', 'sy', 'ette', 'ra'], mid: 0.2 },
};
const HALFLING_FAM = { a: ['good', 'tea', 'green', 'under', 'bramble', 'apple', 'honey', 'cherry', 'pepper', 'clover', 'hazel', 'tum', 'barley', 'thistle', 'merry', 'burrow'], z: ['barrel', 'bough', 'hill', 'foot', 'brush', 'fellow', 'pot', 'basket', 'wick', 'cobble', 'dell', 'wort'] };

const GNOME = {
  male: { a: ['al', 'bim', 'dim', 'fiz', 'gim', 'jeb', 'kel', 'nim', 'orr', 'pip', 'quill', 'rib', 'sim', 'tin', 'wren', 'zan'], m: ['a', 'i', 'o', 'e', 'ble', 'ni', 'wi'], z: ['ble', 'wick', 'dle', 'kin', 'zo', 'bin', 'li', 'sprocket', 'nik', 'dab'], mid: 0.6 },
  female: { a: ['bel', 'cal', 'dee', 'fin', 'gwen', 'lil', 'mim', 'nyx', 'pol', 'rin', 'sab', 'tilly', 'wee', 'zin', 'ella'], m: ['a', 'i', 'o', 'e', 'ni', 'ba', 'li'], z: ['wick', 'bell', 'ie', 'ette', 'zel', 'bee', 'li', 'sy', 'dilly', 'nia'], mid: 0.6 },
};
const GNOME_FAM = { a: ['cog', 'spark', 'bolt', 'whistle', 'gear', 'copper', 'fizz', 'tinker', 'button', 'nimble', 'sprocket', 'quick', 'brass', 'glim'], z: ['wheel', 'spring', 'fuse', 'whirl', 'toggle', 'pocket', 'latch', 'gadget', 'widget', 'bright', 'spindle', 'snap'] };

const ORC = {
  male: { a: ['gru', 'bol', 'dra', 'gor', 'kro', 'mog', 'ruk', 'thok', 'uz', 'zug', 'varg', 'hak', 'brug', 'skar'], m: ['a', 'o', 'u', 'ak', 'ug'], z: ['k', 'g', 'sh', 'gash', 'nak', 'tuk', 'rok', 'bog', 'mar', 'dak'], mid: 0.25 },
  female: { a: ['bru', 'gra', 'huk', 'kra', 'mor', 'nag', 'ozo', 'ruu', 'shag', 'urz', 'vol', 'yag', 'zar'], m: ['a', 'u', 'o', 'ag', 'ur'], z: ['a', 'ga', 'ka', 'za', 'ush', 'ra', 'tha', 'ba', 'ok'], mid: 0.25 },
};
const ORC_EPITHET = { a: ['bone', 'blood', 'iron', 'skull', 'night', 'storm', 'ash', 'black', 'red', 'grim', 'gut', 'rock'], z: ['gnasher', 'breaker', 'render', 'fang', 'hide', 'cleaver', 'tusk', 'eater', 'howl', 'scar', 'fist', 'maw'] };

const TIEFLING = {
  male: { a: ['ak', 'bal', 'dam', 'ek', 'kal', 'leu', 'mor', 'ner', 'ori', 'rai', 'sar', 'skam', 'zeph', 'mal', 'vass'], m: ['a', 'e', 'i', 'ia', 'ek', 'ar'], z: ['os', 'ith', 'ius', 'mos', 'ex', 'ael', 'eus', 'oth', 'ar', 'eon'], mid: 0.4 },
  female: { a: ['ani', 'bri', 'cri', 'dam', 'ily', 'kal', 'lev', 'mor', 'nem', 'ori', 'rie', 'sel', 'vel', 'zai'], m: ['a', 'e', 'i', 'ia', 'ri', 'ne'], z: ['a', 'ia', 'ith', 'ena', 'isse', 'eth', 'ira', 'ara', 'ys', 'ine'], mid: 0.4 },
};
const VIRTUES = ['Ardent', 'Beacon', 'Candor', 'Clemency', 'Despair', 'Ember', 'Fervor', 'Glory', 'Grace', 'Hope', 'Insight', 'Jest', 'Mercy', 'Mirth', 'Naught', 'Oath', 'Patience', 'Prudence', 'Quiet', 'Reverie', 'Resolve', 'Sorrow', 'Temperance', 'Valor', 'Vigil', 'Wistful', 'Zeal', 'Rue', 'Solace', 'Ruin', 'Pride', 'Tenacity'];

const DRAGONBORN = {
  male: { a: ['ar', 'bal', 'dra', 'gor', 'hesk', 'kri', 'med', 'nad', 'pand', 'rhog', 'sor', 'tark', 'vor', 'ghesh', 'bhar'], m: ['a', 'o', 'ak', 'ar', 'ik'], z: ['jhan', 'rash', 'dar', 'gan', 'ius', 'tan', 'jin', 'kar', 'ash', 'ran'], mid: 0.3 },
  female: { a: ['aka', 'bir', 'dar', 'fae', 'hav', 'jhe', 'kav', 'nal', 'sora', 'thav', 'uadj', 'ish', 'myr', 'perr'], m: ['a', 'i', 'ar', 'ik', 'ra'], z: ['la', 'ra', 'ala', 'ia', 'va', 'sha', 'ith', 'nys', 'ae', 'ka'], mid: 0.3 },
};
const DRAGON_CLAN = { a: ['cly', 'del', 'ken', 'dro', 'fen', 'har', 'ker', 'myas', 'nem', 'ors', 'shes', 'thev', 'yarj', 'vir'], z: ['amar', 'ryn', 'ath', 'ruk', 'dal', 'jan', 'zor', 'mir', 'thas', 'kul', 'ghar', 'ixis'] };

const GOLIATH = {
  male: { a: ['ag', 'bar', 'dor', 'ev', 'gae', 'kav', 'mal', 'nal', 'orn', 'tha', 'ul', 'vim', 'tho', 'kar'], m: ['a', 'o', 'u', 'ra', 'lo'], z: ['thi', 'ek', 'ak', 'oth', 'ala', 'oun', 'rim', 'ur'], mid: 0.35 },
  female: { a: ['aua', 'gae', 'ila', 'kuo', 'lo', 'mae', 'nal', 'pae', 'sal', 'tha', 'ven', 'yel', 'ora'], m: ['a', 'o', 'e', 'lu', 'ri'], z: ['ia', 'ala', 'tha', 'ue', 'lo', 'nae', 'va', 'ira', 'ela'], mid: 0.35 },
};
const GOLIATH_FAM = { a: ['high', 'sky', 'cloud', 'rock', 'crag', 'wind', 'summit', 'boulder', 'peak', 'frost', 'thunder', 'cairn'], z: ['strider', 'climber', 'hand', 'runner', 'breaker', 'lifter', 'watcher', 'caller', 'shoulder', 'stone', 'leaper', 'bearer'] };

const AASIMAR = {
  male: { a: ['aur', 'cael', 'dav', 'eze', 'gab', 'hel', 'ior', 'ser', 'lum', 'mic', 'raz', 'sol', 'uri', 'zad'], m: ['a', 'e', 'i', 'io', 'el', 'ar'], z: ['iel', 'ion', 'ael', 'us', 'ias', 'ar', 'on', 'ius', 'el'], mid: 0.4 },
  female: { a: ['aur', 'cael', 'ede', 'gab', 'hel', 'ilu', 'lum', 'mir', 'ser', 'sol', 'uri', 'zel', 'ana', 'ori'], m: ['a', 'e', 'i', 'io', 'el', 'ri'], z: ['iel', 'ia', 'ael', 'ena', 'ina', 'ora', 'ea', 'ith', 'elle'], mid: 0.4 },
};

// ---- the filter ---------------------------------------------------------
// Fragments that must never appear in a generated name (checked with spaces,
// apostrophes and hyphens removed). Short on purpose: a rare false hit only
// costs one re-roll.
const BLOCKED = ['nigg', 'nigr', 'negro', 'fagg', 'fag', 'cunt', 'kike', 'spic', 'chink', 'gook', 'coon', 'dyke', 'tard', 'shit', 'fuck', 'cock', 'twat', 'slut', 'whore', 'paki', 'wop', 'dago', 'homo', 'porn', 'rape', 'dick', 'piss', 'cum', 'tit', 'anus', 'nazi', 'hitler', 'jew', 'gyp', 'tranny', 'bitch', 'bastard', 'ass', 'arse', 'sex', 'poo', 'turd', 'damn'];
const BLOCK_RE = new RegExp(BLOCKED.join('|'), 'i');
/** True when a name contains an offensive fragment. */
export const isOffensive = (name: string): boolean => BLOCK_RE.test(name.replace(/[\s'’-]/g, ''));

// ---- per race -----------------------------------------------------------

type Maker = (r: Rng, g: Gender, style: NameStyle) => { given: string; family: string };
const given = (set: Record<Gender, Syl>): ((r: Rng, g: Gender) => string) => (r, g) => build(r, set[g]);
const fam = (f: { a: string[]; z: string[] }, p = 1) => (r: Rng) => (chance(r, p) ? compound(r, f.a, f.z) : '');

const gHuman = given(HUMAN), gElf = given(ELF), gOrc = given(ORC);
const fHuman = fam(HUMAN_FAM), fElf = fam(ELF_FAM);
const gDwarf = given(DWARF), gHalfling = given(HALFLING), gGnome = given(GNOME), gTiefling = given(TIEFLING), gDragon = given(DRAGONBORN), gGoliath = given(GOLIATH), gAasimar = given(AASIMAR);
const fDwarf = fam(DWARF_CLAN), fHalfling = fam(HALFLING_FAM), fGnome = fam(GNOME_FAM), fDragon = fam(DRAGON_CLAN), fGoliath = fam(GOLIATH_FAM);
const fOrcSome = fam(ORC_EPITHET, 0.4), fOrcMost = fam(ORC_EPITHET, 0.5);

const MAKERS: Record<Race, Maker> = {
  human: (r, g) => ({ given: gHuman(r, g), family: fHuman(r) }),
  elf: (r, g) => ({ given: gElf(r, g), family: fElf(r) }),
  'half-elf': (r, g) => ({ given: chance(r, 0.5) ? gHuman(r, g) : gElf(r, g), family: chance(r, 0.5) ? fHuman(r) : fElf(r) }),
  dwarf: (r, g) => ({ given: gDwarf(r, g), family: fDwarf(r) }),
  halfling: (r, g) => ({ given: gHalfling(r, g), family: fHalfling(r) }),
  gnome: (r, g) => ({ given: gGnome(r, g), family: fGnome(r) }),
  'half-orc': (r, g) => (chance(r, 0.5) ? { given: gOrc(r, g), family: fOrcSome(r) } : { given: gHuman(r, g), family: fHuman(r) }),
  orc: (r, g) => ({ given: gOrc(r, g), family: fOrcMost(r) }),
  tiefling: (r, g, style) => (style === 'virtue' ? { given: pick(r, VIRTUES), family: '' } : { given: gTiefling(r, g), family: chance(r, 0.6) ? fHuman(r) : '' }),
  dragonborn: (r, g) => ({ given: gDragon(r, g), family: fDragon(r) }),
  goliath: (r, g) => ({ given: gGoliath(r, g), family: fGoliath(r) }),
  aasimar: (r, g) => ({ given: gAasimar(r, g), family: fHuman(r) }),
};
const full = (g: string, f: string) => (f ? `${g} ${f}` : g);

export const isRace = (v: unknown): v is Race => (RACES as readonly string[]).includes(String(v));

/** Names for a race and gender. `race`/`gender` may be 'any'. Never returns duplicates; may return fewer than `count` if a tiny set runs dry. */
export function genNames(opts: NamesOpts = {}): NamesResult {
  const race = String(opts.race ?? 'any').toLowerCase().replace(/[\s_]+/g, '-');
  const gender = String(opts.gender ?? 'any').toLowerCase();
  if (race !== 'any' && !isRace(race)) throw new RangeError(`race must be any or one of ${RACES.join(', ')}`);
  if (gender !== 'any' && gender !== 'male' && gender !== 'female') throw new RangeError('gender must be any, male or female');
  const style: NameStyle = opts.style === 'virtue' ? 'virtue' : 'default';
  const count = Math.max(1, Math.min(2000, Math.floor(Number(opts.count ?? 10)) || 10));
  const seed = seedOf(opts.seed);
  const r = makeRng(seed);
  const seen = new Set<string>();
  const names: GeneratedName[] = [];
  const maxTries = count * 40 + 100;
  for (let i = 0; names.length < count && i < maxTries; i++) {
    const rc = race === 'any' ? pick(r, RACES) : (race as Race);
    const g: Gender = gender === 'any' ? (chance(r, 0.5) ? 'male' : 'female') : (gender as Gender);
    const { given: gv, family } = MAKERS[rc](r, g, style);
    const name = full(gv, family);
    const key = name.toLowerCase();
    if (seen.has(key) || isOffensive(name)) continue;
    seen.add(key);
    names.push({ name, given: gv, family, race: rc, gender: g });
  }
  return { seed, race, gender, names };
}
