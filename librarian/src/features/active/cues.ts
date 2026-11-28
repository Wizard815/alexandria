// Active mode, layer one: a fast rules pass over one transcript line. It
// never calls a model and never touches the database: everything it needs
// (the tracker, the party, the pages players may see, the sound library) is
// handed in. It returns INTENTS (what the line seems to ask for, with a
// confidence); intents.ts turns them into tool calls. Precision first: a cue
// needs a clear verb, and a line that only mentions something is ignored.

export type Category = 'music' | 'sfx' | 'stage' | 'events' | 'combat' | 'combatAdd' | 'items' | 'clock' | 'notes';
export const CATEGORIES: Category[] = ['music', 'sfx', 'stage', 'events', 'combat', 'combatAdd', 'items', 'clock', 'notes'];

export interface LineIn {
  id: string;
  text: string;
  speaker: string;
  /** gm: the GM's own mic; player: a player's own mic; other: room mic or nobody known. */
  role: 'gm' | 'player' | 'other';
  accountId: string | null;
  /** A GM-only line (aside): nothing players see may follow from it. */
  aside: boolean;
}

export interface CombatantLite { id: string; name: string; hp?: number | null; maxHp?: number | null; effects: string[]; isPc: boolean; accountId?: string | null; concentration?: { spell: string; dc: number | null } | null }
export interface CueCtx {
  combat: { active: boolean; turn: number; combatants: CombatantLite[] };
  party: { accountId: string; name: string; character: string }[];
  /** Pages players may open (title, id): the stage only ever shows these. */
  pages: { id: string; title: string; path?: string }[];
  sfx: string[];
  /** The player asked to roll initiative a moment ago. */
  initiativeOpen: boolean;
}

export type Intent =
  | { kind: 'music'; mood?: 'calm' | 'tense' | 'sneaky' | 'combat'; stop?: boolean; why: string }
  | { kind: 'ambience'; layers: string[]; stop?: boolean; why: string }
  | { kind: 'sfx'; name: string; why: string }
  | { kind: 'stage'; phrase: string; text?: string; title?: string; why: string }
  | { kind: 'event'; skill: string; dc?: number; save: boolean; why: string }
  | { kind: 'combat_start' | 'combat_end' | 'next_turn'; why: string; ask?: boolean }
  | { kind: 'damage' | 'heal'; ids: string[]; amount: number; why: string; crit?: boolean }
  | { kind: 'condition'; id: string; add: string[]; remove: string[]; /** Ends at the end / start of the creature's own next turn. */ until?: 'end' | 'start'; rounds?: number; why: string }
  | { kind: 'temp_hp'; ids: string[]; amount: number; why: string }
  | { kind: 'concentration'; id: string; action: 'start' | 'lose' | 'pass'; spell?: string; why: string }
  | { kind: 'death_save'; id: string; roll?: number; result?: 'success' | 'failure'; why: string }
  | { kind: 'remove_creature'; id: string; why: string }
  | { kind: 'add_monsters'; name: string; count: number; why: string }
  | { kind: 'initiative'; accountId: string | null; name: string; value: number; why: string }
  | { kind: 'coins'; owner: string; ownerName: string; cp: number; each?: boolean; why: string }
  | { kind: 'item'; owner: string; ownerName: string; name: string; qty: number; why: string }
  | { kind: 'use_item'; accountId: string; phrase: string; why: string }
  | { kind: 'clock'; preset?: 'short-rest' | 'long-rest' | 'next-day'; minutes?: number; why: string };
export type Scored = Intent & { confidence: number };

const w = (n: number | string) => String(n);
export const norm = (s: string) => s.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MOODS: [RegExp, 'calm' | 'tense' | 'sneaky' | 'combat'][] = [
  [/\b(tens\w*|eerie|ominous|suspens\w*|dread\w*|creepy|spooky|dark|foreboding|unsettling|scary|horror|mysterious|uneasy)\b/, 'tense'],
  [/\b(sneak\w*|stealth\w*|infiltrat\w*|creeping|furtive)\b/, 'sneaky'],
  [/\b(combat|battle|fight\w*|boss|epic|action|intense|war|chase|dramatic)\b/, 'combat'],
  [/\b(calm|peaceful|relax\w*|gentle|soft|warm|cozy|tavern|village|market|happy|light|pleasant|soothing|quiet|town)\b/, 'calm'],
];
export const moodOf = (s: string): 'calm' | 'tense' | 'sneaky' | 'combat' | undefined => { const t = norm(s); for (const [re, m] of MOODS) if (re.test(t)) return m; return undefined; };

const LAYERS: [RegExp, string][] = [
  [/\b(rain\w*|drizzle|downpour|shower)\b/, 'rain'], [/\b(thunder\w*|storm\w*)\b/, 'storm'], [/\b(wind\w*|gale|breeze|howling wind)\b/, 'wind'],
  [/\b(fire|fireplace|hearth|campfire|crackling|flames?)\b/, 'fire'], [/\b(tavern|inn|crowd|chatter|bar)\b/, 'tavern'], [/\b(cave|drip\w*|dungeon)\b/, 'cave'],
  [/\b(forest|woods|birds?|jungle)\b/, 'forest'], [/\b(sea|waves?|ocean|harbou?r|docks?|shore)\b/, 'sea'], [/\b(night|crickets?)\b/, 'night'], [/\b(river|stream|waterfall)\b/, 'river'],
];
export const layersOf = (s: string): string[] => { const t = norm(s); const out: string[] = []; for (const [re, l] of LAYERS) if (re.test(t) && !out.includes(l)) out.push(l); return out; };

const SFX_WORDS: [RegExp, string][] = [
  [/\b(creak\w*)\b/, 'creak'], [/\bthunder\w*\b/, 'thunder'], [/\b(roars?|roared)\b/, 'roar'], [/\b(howls?|howled)\b/, 'howl'], [/\b(explo\w+|blast)\b/, 'explosion'],
  [/\b(crash\w*|shatter\w*)\b/, 'crash'], [/\b(clash\w*|swords? (clang|ring)\w*)\b/, 'clash'], [/\bbells?\b.*\b(toll\w*|ring\w*|chime\w*)\b|\b(toll\w*|ring\w*) (of )?(the )?bells?\b/, 'bell'],
  [/\bknock\w*\b/, 'knock'], [/\bsplash\w*\b/, 'splash'], [/\bslam\w*\b/, 'slam'], [/\b(growl\w*)\b/, 'growl'],
];

const MONSTERS = 'goblins?|hobgoblins?|orcs?|ogres?|kobolds?|skeletons?|zombies?|wolf|wolves|bandits?|cultists?|trolls?|giants?|ghouls?|gnolls?|bugbears?|harpies?|spiders?|rats?|bears?|owlbears?|imps?|thugs?|guards?|soldiers?|assassins?|drakes?|wights?|wraiths?|specters?|ghosts?|cultist|mercenar(?:y|ies)|brigands?|smugglers?|pirates?|sahuagin|lizardfolk|minotaurs?|gargoyles?|golems?|mimics?|oozes?|bats?|snakes?|crabs?';
const NUMW: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, 'a pair of': 2, 'a couple of': 2, several: 3 } as any;
const CONDS = 'prone|poisoned|stunned|frightened|grappled|restrained|blinded|deafened|charmed|paralyzed|incapacitated|unconscious|invisible|exhausted|petrified|burning|bleeding|slowed|asleep|dazed|confused|enraged|hasted|blessed';
const PRON = new Set(['it', 'he', 'she', 'they', 'him', 'her', 'them', 'you', 'that', 'this']);

export const SKILLS = 'perception|investigation|insight|stealth|athletics|acrobatics|arcana|history|nature|religion|survival|medicine|persuasion|deception|intimidation|performance|sleight of hand|animal handling|strength|dexterity|constitution|intelligence|wisdom|charisma|dex|con|wis|int|str|cha';
const COIN_CP: Record<string, number> = { cp: 1, copper: 1, sp: 10, silver: 10, ep: 50, electrum: 50, gp: 100, gold: 100, pp: 1000, platinum: 1000 };

const UNITS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUMRUN = new RegExp(`\\b(?:(?:(?:an? |one )?hundred)(?:(?: and)? (?:(?:${Object.keys(TENS).join('|')})(?:[- ](?:${Object.keys(UNITS).slice(1, 10).join('|')}))?|${Object.keys(UNITS).join('|')}))?|(?:${Object.keys(TENS).join('|')})(?:[- ](?:${Object.keys(UNITS).slice(1, 10).join('|')}))?|(?:${Object.keys(UNITS).join('|')}))\\b`, 'gi');
const WORD_UNIT = /^\s*(?:gold|gp|silver|sp|copper|cp|platinum|pp|coins?|pieces?|damage|hp|hit points?|points?|health|for initiative|on initiative|initiative|hours?|days?|minutes?)\b/i;
const WORD_VERB = /(?:takes?|took|deals?|dealt|for|heals?|regains?|recovers?|rolled|got|rolls?|total of|with a|that'?s|it'?s|is|a|an)\s+$/i;
/** "fifty gold" -> "50 gold", "takes eight" -> "takes 8": number words only where an amount is meant. */
export function digitize(text: string): string {
  return text.replace(NUMRUN, (m, off: number) => {
    const after = text.slice(off + m.length);
    const before = text.slice(0, off);
    if (!(WORD_UNIT.test(after) || (WORD_VERB.test(before) && /^\s*(?:[.,!?;]|$|from|with|by|damage|fire|cold|points)/i.test(after) && !/\b(?:an?|one)$/i.test(before.trim() + ' ' ) ))) return m;
    const w = m.toLowerCase().replace(/-/g, ' ').replace(/^(an?|one) hundred/, 'hundred').replace(/ and /, ' ').split(/\s+/);
    let total = 0; let cur = 0;
    for (const x of w) { if (x === 'hundred') cur = (cur || 1) * 100; else if (x in TENS) cur += TENS[x]; else if (x in UNITS) cur += UNITS[x]; }
    total += cur;
    return String(total);
  });
}

const sentences = (t: string): string[] => t.replace(/\s+/g, ' ').split(/(?<=[.!?;])\s+(?=[A-Za-z"'“])/).map((s) => s.trim()).filter(Boolean);

// ---- names ---------------------------------------------------------------------------
interface Mention { start: number; end: number; ids: string[]; text: string }

/** Combatants named in a sentence: the full name, the name without its number, a player's own name or character, and a bare monster noun. */
export function mentions(s: string, ctx: CueCtx): Mention[] {
  const t = s;
  const out: Mention[] = [];
  const list = ctx.combat.combatants;
  const alias = new Map<string, string[]>();
  const add = (k: string, id: string) => { k = norm(k); if (k.length < 3) return; const a = alias.get(k) ?? []; if (!a.includes(id)) a.push(id); alias.set(k, a); };
  for (const c of list) {
    add(c.name, c.id);
    const base = c.name.replace(/\s+\d+$/, '');
    add(base, c.id);
    // "Goblin Boss" is also "the boss" only when unique; the first word alone is too loose for a multi-word name, except PCs' first names.
    const first = base.split(' ')[0];
    if (c.isPc || base.split(' ').length === 1) add(first, c.id);
    else if (list.filter((x) => x.name.toLowerCase().startsWith(first.toLowerCase())).length === 1 && first.length >= 4) add(first, c.id);
    if (c.accountId) { const p = ctx.party.find((x) => x.accountId === c.accountId); if (p) { add(p.name, c.id); add(p.character, c.id); add(p.name.split(' ')[0], c.id); add(p.character.split(' ')[0], c.id); } }
  }
  const keys = [...alias.keys()].sort((a, b) => b.length - a.length);
  if (!keys.length) return out;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:the\\s+)?(${keys.map(esc).join('|')})(?:\\s+(\\d+))?(?![\\p{L}\\p{N}])`, 'giu');
  const taken: [number, number][] = [];
  for (const m of t.matchAll(re)) {
    const s0 = m.index!;
    const e0 = s0 + m[0].length;
    if (taken.some(([a, b]) => s0 < b && e0 > a)) continue;
    let ids = [...(alias.get(norm(m[1])) ?? [])];
    // A number picks one: "goblin 2".
    if (m[2] && ids.length > 1) { const pick = list.filter((c) => ids.includes(c.id) && new RegExp(`\\b${m[2]}$`).test(c.name)); if (pick.length) ids = pick.map((c) => c.id); }
    else if (m[2] && ids.length === 1) { /* "Tom 2"? leave */ }
    // Possessive ("Tom's fireball") is not the one being hurt.
    const after = t.slice(e0, e0 + 2);
    if (/^['’]s/.test(after)) continue;
    taken.push([s0, e0]);
    out.push({ start: s0, end: e0, ids, text: m[0] });
  }
  return out;
}

const partyByName = (ctx: CueCtx, name: string) => {
  const n = norm(name);
  return ctx.party.find((p) => [p.name, p.character, p.name.split(' ')[0], p.character.split(' ')[0]].some((x) => x && norm(x) === n));
};

// ---- the rules -------------------------------------------------------------------------

/** Cues in one line. `explicit` is a spoken command ("Minerva, ...") already stripped of the wake word. */
export function cuesOf(line: LineIn, ctx: CueCtx, opts: { explicit?: boolean } = {}): Scored[] {
  const out: Scored[] = [];
  const push = (i: Intent, confidence: number) => out.push({ ...i, confidence: opts.explicit ? Math.max(confidence, 0.9) : confidence } as Scored);
  const gm = line.role === 'gm' || opts.explicit === true;
  const text = line.text;
  if (!text.trim()) return out;
  if (line.role === 'player' && !opts.explicit) return playerCues(line, ctx);
  // Room mics and unknown speakers never trigger anything.
  if (!gm) return out;
  const low = norm(text);

  // -- music, ambience, sound effects --
  let m: RegExpMatchArray | null;
  if ((m = low.match(/\b(?:stop|kill|cut|silence|turn off|fade out)\s+(?:the\s+)?music\b|\bmusic\s+(?:off|stop)\b/))) push({ kind: 'music', stop: true, why: m[0] }, 0.95);
  else if ((m = low.match(/\bmusic\s*[:\-–,]\s*(.{2,80})/))) { const mood = moodOf(m[1]); if (mood) push({ kind: 'music', mood, why: m[0] }, 0.95); }
  else if ((m = low.match(/\b(?:put on|play|start|cue|queue|switch to|change (?:the )?music to|give me|bring in|bring up)\s+(?:some |a bit of |a little )?(?:something\s+)?(.{0,30}?)\bmusic\b|\bsomething\s+(\w+)\s+(?:for (?:this|the)|please|now|musically)|\b(battle|combat|boss|tavern|tense|eerie|calm|sneaky|stealth)\s+(?:music|theme|track|soundtrack)\b|\bmusic\s+(?:becomes?|turns?|shifts?|swells?)\s+(.{2,30})/))) {
    const mood = moodOf(`${m[1] ?? ''} ${m[2] ?? ''} ${m[3] ?? ''} ${m[4] ?? ''}`);
    if (mood) push({ kind: 'music', mood, why: m[0] }, 0.9);
  }
  if (opts.explicit && !out.some((x) => x.kind === 'music') && /\b(play|put on|something|give me|switch to|start|cue)\b/.test(low) && !/\b(stop|off|silence)\b/.test(low)) { const mood = moodOf(low); if (mood && !/\b(rain|storm|wind|fire|tavern chatter)\b/.test(low)) push({ kind: 'music', mood, why: low.slice(0, 60) }, 0.9); }
  if ((m = low.match(/\b(?:ambience|ambient|atmosphere)\s*[:\-–,]\s*(.{2,60})/))) { const l = layersOf(m[1]); if (l.length) push({ kind: 'ambience', layers: l, why: m[0] }, 0.95); }
  else if ((m = low.match(/\b(?:add|put on|play|start|bring in|with)\s+(?:the\s+)?(?:sound|sounds|noise|noises)\s+of\s+(.{2,40})/))) { const l = layersOf(m[1]); if (l.length) push({ kind: 'ambience', layers: l, why: m[0] }, 0.9); }
  else if ((m = low.match(/\b(?:it |rain |snow )?(?:starts?|begins?|began|starts to|begins to)\s+(?:to\s+)?(?:rain|pour|storm)\b|\b(?:rain|a storm|thunder)\s+(?:begins|starts|breaks|rolls in|falls)\b|\bthe\s+(?:rain|storm)\s+(?:hammers|pelts|lashes|pours)\b|\bit(?:'s| is)\s+(?:pouring|raining)\b/))) push({ kind: 'ambience', layers: ['rain'], why: m[0] }, 0.8);
  else if ((m = low.match(/\b(?:the\s+)?(?:tavern|inn|room|hall|crowd|common room|market|square)\s+(?:goes|falls|grows|becomes|turns)\s+(?:quiet|silent|still|hushed)\b|\bsilence falls\b|\ba hush falls\b/))) push({ kind: 'ambience', layers: [], stop: true, why: m[0] }, 0.8);
  else if (/\b(?:stop|kill|cut|silence)\s+(?:the\s+)?(?:ambience|ambient sound|sounds)\b/.test(low)) push({ kind: 'ambience', layers: [], stop: true, why: 'stop ambience' }, 0.95);
  if ((m = low.match(/\b(?:sfx|sound effect|sound)\s*[:\-–]\s*(.{2,40})/))) { const hit = SFX_WORDS.find(([re]) => re.test(m![1])); push({ kind: 'sfx', name: hit ? hit[1] : m[1].trim(), why: m[0] }, 0.95); }
  else for (const s of sentences(low)) {
    const hit = SFX_WORDS.find(([re]) => re.test(s));
    if (!hit) continue;
    // Narrated sound: something happens, the table should hear it. A question or a plan is not narration.
    if (/\?|\b(if|when|would|could|might|maybe|should|can i|do i|did you|will it)\b/.test(s)) continue;
    if (!/\b(a|the|an|you hear|from|in the|echoes?|outside|behind|above|below|ahead|suddenly|loud)\b/.test(s)) continue;
    if (ctx.sfx.length && !ctx.sfx.some((n) => norm(n).includes(hit[1]))) continue;
    push({ kind: 'sfx', name: hit[1], why: s.slice(0, 80) }, 0.82);
    break;
  }

  // -- stage --
  if ((m = low.match(/\b(?:show|display|put up|hand|pass|slide|reveal|flash|pull up|bring up)\s+(?:them|the players|the party|the table|everyone|you|the group|everybody|us|up)?\s*(?:with\s+)?(?:the\s+|a\s+|an\s+|this\s+|that\s+)?(.{3,80})/)) && !/\b(music|sound|initiative)\b/.test(m[1])) {
    const phrase = m[1].replace(/\b(on|to) (the )?(stage|screen|table|board)\b.*$/, '').replace(/[.!?;].*$/, '').trim().slice(0, 90);
    if (phrase.length >= 3) push({ kind: 'stage', phrase, why: m[0].slice(0, 80) }, 0.7);
  }

  // -- quick events --
  if (!/\binitiative\b/.test(low) && (m = low.match(new RegExp(`\\b(?:roll|make|give me|let me (?:see|get)|i need|need)\\s+(?:me\\s+)?(?:an?\\s+|your\\s+)?(?:dc\\s*(\\d{1,2})\\s*)?(${SKILLS})(?:\\s*\\(?(?:dc\\s*(\\d{1,2})\\)?)?)?\\s*(check|save|saving throw|roll)?\\b`)))) {
    const dc = Number(m[1] ?? m[3]) || undefined;
    const sv = /save|saving/.test(m[4] ?? '') || /^(strength|dexterity|constitution|intelligence|wisdom|charisma|dex|con|wis|int|str|cha)$/.test(m[2]) && /save/.test(low);
    push({ kind: 'event', skill: m[2], dc, save: !!sv, why: m[0].slice(0, 80) }, m[4] || dc ? 0.9 : 0.7);
  }

  // -- clock --
  if ((m = low.match(/\b(?:take|takes|taking|settle (?:in )?for|have|make camp for)\s+(?:a\s+)?long rest\b|\b(?:you|the party|everyone)\s+(?:rests?|sleeps?)\s+(?:through the night|for the night|for eight hours|until (?:morning|dawn))|\bwhat is a long rest\b/)) && !/\?/.test(low)) push({ kind: 'clock', preset: 'long-rest', why: m[0] }, 0.88);
  else if ((m = low.match(/\b(?:take|takes|taking|have)\s+(?:a\s+)?short rest\b|\bcatch your breath for an hour\b/)) && !/\?/.test(low)) push({ kind: 'clock', preset: 'short-rest', why: m[0] }, 0.88);
  else if ((m = low.match(/\b(\d{1,2}|an?|one|two|three|four|five|six|seven|eight|ten|twelve)\s+(hours?|days?|minutes?|weeks?)\s+(?:later|pass(?:es)?|go by|goes by|have passed|of travel)\b|\b(?:an?|one)\s+(hour|day)\s+(?:later|passes)\b|\bthe next (morning|day)\b|\bdawn (?:breaks|comes|arrives)\b|\bby the time you (?:arrive|reach|get)\b/))) {
    if (m[2]) {
      const n = /^\d/.test(m[1]) ? Number(m[1]) : (NUMW[m[1]] ?? Number({ four: 4, five: 5, six: 6, seven: 7, eight: 8, ten: 10, twelve: 12 }[m[1] as string] ?? 1));
      const unit = m[2].replace(/s$/, '');
      const minutes = n * (unit === 'minute' ? 1 : unit === 'hour' ? 60 : unit === 'day' ? 1440 : 10080);
      if (minutes > 0 && minutes <= 10080) push({ kind: 'clock', minutes, why: m[0] }, 0.82);
    } else if (m[4]) push({ kind: 'clock', minutes: m[4] === 'hour' ? 60 : 1440, why: m[0] }, 0.82);
    else if (m[5]) push({ kind: 'clock', preset: 'next-day', why: m[0] }, 0.6);
  }

  // -- coins and items --
  for (const s of sentences(text)) {
    const sl = norm(s);
    if (/\?/.test(sl) || /\b(costs?|price|pay|pays|paid|spend|spent|buy|sell|sells|would|could|might|if you)\b/.test(sl) && !/\b(you|party) (are paid|get paid|receive)\b/.test(sl)) { /* a price or a question */ }
    else {
      const cm = sl.match(/\b(?:give|gives|hand|hands|pay|pays|reward|rewards|award|awards|grant)\s+(?:(?:each of )?(you|the party|everyone|everybody|the group)|([a-z][\w'-]*(?:\s[a-z][\w'-]*)?))\s+(?:an?\s+|the\s+|some\s+)?(\d[\d,]*)\s*(gold(?: pieces| coins)?|gp|silver(?: pieces| coins)?|sp|copper(?: pieces| coins)?|cp|platinum(?: pieces| coins)?|pp)\b/)
        ?? sl.match(/\b(you|the party|everyone|everybody|the group|[a-z][\w'-]*)\s+(?:each\s+)?(?:find|finds|loot|loots|receive|receives|gets?|pocket|pockets|discover|discovers|collects?|are rewarded with|is rewarded with|earn|earns)\s+(?:an?\s+|the\s+)?(\d[\d,]*)\s*(gold(?: pieces| coins)?|gp|silver(?: pieces| coins)?|sp|copper(?: pieces| coins)?|cp|platinum(?: pieces| coins)?|pp)\b/)
        ?? sl.match(/\b(?:you|the party)\s+(?:also\s+)?(?:find|finds|discover|loot|spot)\s+.{0,40}?(\d[\d,]*)\s*(gold|gp|silver|sp|copper|cp|platinum|pp)\b/);
      if (cm) {
        const unit = (cm[4] ?? cm[3] ?? cm[2]) as string;
        const numStr = cm.length === 4 && cm[1] && /\d/.test(cm[1]) ? cm[1] : cm.length === 4 ? cm[2] : (cm[3] ?? cm[2]);
        const amount = Number(String(cm.find((g, i) => i > 0 && /^\d[\d,]*$/.test(g ?? '')) ?? '0').replace(/,/g, ''));
        const coin = COIN_CP[(String(cm.find((g, i) => i > 0 && /^(gold|gp|silver|sp|copper|cp|platinum|pp)/.test(g ?? '')) ?? unit)).split(' ')[0]];
        const who = (cm[1] && !/^\d/.test(cm[1]) ? cm[1] : cm[2] && !/^\d/.test(cm[2]) ? cm[2] : '') as string;
        void numStr;
        if (amount > 0 && coin && amount * coin <= 1_000_000) {
          const p = who && !/^(you|the party|everyone|everybody|the group)$/.test(who) ? partyByName(ctx, who) : undefined;
          if (!who || /^(you|the party|everyone|everybody|the group)$/.test(who)) push({ kind: 'coins', owner: 'party', ownerName: 'the party', cp: amount * coin, each: /\beach\b/.test(sl), why: s.slice(0, 80) }, 0.85);
          else if (p) push({ kind: 'coins', owner: p.accountId, ownerName: p.character || p.name, cp: amount * coin, why: s.slice(0, 80) }, 0.9);
        }
      }
      if (!cm) {
        const g = sl.match(/\b(?:give|gives|hand|hands|slip|slips|toss|tosses|present|presents)\s+(you|the party|everyone|everybody|the group|[a-z][\w'-]*)\s+(?:an?\s+|the\s+|some\s+|one\s+)?([a-z0-9][a-z0-9' -]{2,50}?)(?=$|[,.!;]| as | for | to | from | because| in return| and (?:says|tells|asks|then))/);
        const f = sl.match(/\byou\s+(?:also\s+)?(?:find|discover|spot|come across|pick up|uncover|notice (?:among|in)|pull out|retrieve|come upon)\s+(?:an?\s+|the\s+|some\s+|(\w+)\s+)?([a-z0-9][a-z0-9' -]{2,50}?)(?=$|[,.!;]| in | on | under | inside | behind | hidden | among | beneath| lying| tucked| wedged| half| there| with| beside| near)/)
          ?? sl.match(/\b(?:inside|within|in the (?:chest|box|crate|drawer|satchel|pouch)|under the \w+|behind the \w+)[^.]{0,40}?(?:is|are|lies|sits|rests|hides)\s+(?:an?\s+|the\s+|some\s+)?([a-z0-9][a-z0-9' -]{2,50}?)(?=$|[,.!;])/);
        const NOTITEM = /^(way|nothing|yourselves?|yourself|tracks?|footprints?|trail|door|doors|path|room|corridor|that|this|it|them|more|out|no one|someone|anything|a lot|the exit|exit|stairs|staircase|passage|hallway|body|bodies|answers?|time|clue|clues|signs?|marks?|blood|dust|shadows?|silence|light|dark|smell|cold|warmth|rest|peace|trouble|each other|something|everything|just)\b/;
        if (g && !NOTITEM.test(g[2])) {
          const whoN = g[1];
          const toParty = /^(you|the party|everyone|everybody|the group)$/.test(whoN);
          const p = toParty ? undefined : partyByName(ctx, whoN);
          const [qty, name] = qtyName(g[2]);
          if (name && (toParty || p)) push({ kind: 'item', owner: toParty ? 'party' : p!.accountId, ownerName: toParty ? 'the party' : p!.character || p!.name, name, qty, why: s.slice(0, 80) }, 0.85);
        } else if (f) {
          const raw = (f[1] && !/^(an?|the|some)$/.test(f[1]) && /^(silver|golden|old|rusty|small|large|tiny|heavy|ornate|bronze|iron|steel|wooden|ancient|strange|glowing|folded|sealed|crumpled|three|two|four|five|six|\d+)$/.test(f[1]) ? `${f[1]} ` : '') + (f[2] ?? f[1] ?? '');
          const [qty, name] = qtyName(raw);
          if (name && !NOTITEM.test(name) && name.split(' ').length <= 6) push({ kind: 'item', owner: 'party', ownerName: 'the party', name, qty, why: s.slice(0, 80) }, 0.72);
        }
      }
    }
  }

  // -- combat --
  const combatCue = combatCues(low, text, ctx);
  for (const c of combatCue) out.push({ ...c, confidence: opts.explicit ? Math.max(c.confidence, 0.9) : c.confidence } as Scored);

  return dedupe(out);
}

function qtyName(raw: string): [number, string] {
  let t = raw.trim().replace(/^(?:an?|the|some)\s+/, '');
  let qty = 1;
  const m = t.match(/^(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(.+)$/);
  if (m) { qty = /^\d/.test(m[1]) ? Number(m[1]) : (NUMW[m[1]] ?? 1); t = m[2]; }
  t = t.replace(/\s+(?:and|then|which|that|but|while)\b.*$/, '').trim();
  const name = t.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return [Math.max(1, Math.min(qty, 999)), name.slice(0, 80)];
}

function combatCues(low: string, raw: string, ctx: CueCtx): Scored[] {
  const out: Scored[] = [];
  const push = (i: Intent, confidence: number) => out.push({ ...i, confidence } as Scored);
  const c = ctx.combat;
  let m: RegExpMatchArray | null;
  const q = /\?/.test(low);
  if (!c.active && !q && !/\bdon'?t\b|\bnot yet\b|\bwhen\b|\bif\b/.test(low) && (m = low.match(/\b(?:roll|rolling|everyone roll|everybody roll|time to roll|give me|go ahead and roll)\s+(?:for\s+)?initiative\b|\binitiative\s*[,!:]?\s*(?:everyone|everybody|please)\b|\b(?:combat|the fight|the battle|the encounter)\s+(?:begins|starts|breaks out|erupts)\b|\bdraw your (?:weapons|swords|steel)\b/))) push({ kind: 'combat_start', why: m[0] }, /initiative/.test(m[0]) ? 0.93 : 0.75);
  // A fight already under way (the recording started mid-combat, nobody said "initiative"): a damage amount and an
  // attack word in one line. Only ever offered, never started on its own.
  else if (!c.active && !q && /\b\d+\s+(?:points?\s+of\s+)?(?:[a-z]+\s+)?damage\b|\b(?:takes?|deals?|did|does|for)\s+\d+\b/.test(low) && /\b(?:to hit|hits?|miss(?:es)?|attacks?|crit\w*|legendary action|your turn|my turn|armor class|ac \d+|saving throw|save)\b/.test(low)) push({ kind: 'combat_start', why: 'fight under way', ask: true }, 0.7);
  if (c.active && !q && (m = low.match(/\b(?:end|ends|ending|stop)\s+(?:the\s+)?(?:combat|fight|battle|encounter)\b|\b(?:combat|the fight|the battle|the encounter)\s+(?:is\s+|has\s+)?(?:over|ends|ended|finished|done)\b|\bthe (?:last|final)\s+(?:\w+\s+){0,2}(?:falls|dies|drops|is dead|is down)\b|\bsilence (?:returns|settles)\b.*\b(?:fight|battle)\b/))) push({ kind: 'combat_end', why: m[0] }, /last|final|silence/.test(m[0]) ? 0.6 : 0.93);
  if (!c.active || !c.combatants.length) return out;

  if (!q && sentences(low).some((x) => /^\W*(?:(?:ok|okay|alright|all right|so|right|and|then|now)[,.]?\s+)*(?:next turn|next up|top of the (?:next )?round|moving on to the next (?:turn|combatant)|on to the next (?:turn|combatant))\b/.test(x) && x.split(' ').length <= 9)) push({ kind: 'next_turn', why: 'next turn' }, 0.86);
  const list = c.combatants;
  const nxt = list[(c.turn + 1) % list.length];
  if (nxt && !q) {
    const nm = norm(nxt.name.replace(/\s+\d+$/, ''));
    const alias = ctx.party.find((p) => p.accountId === nxt.accountId);
    const keys = [nm, nm.split(' ')[0], ...(alias ? [norm(alias.name.split(' ')[0]), norm(alias.character.split(' ')[0])] : [])].filter((k) => k.length >= 3);
    if (keys.some((k) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(k)}(?:\\s+\\d+)?[,]?\\s+(?:you(?:'re| are)\\s+up|your turn|it(?:'s| is) your turn|you're next)|\\bit(?:'s| is)\\s+(?:the\\s+)?${esc(k)}(?:\\s+\\d+)?(?:'s)?\\s+turn\\b|\\b${esc(k)}(?:'s| is)\\s+up\\b`, 'iu').test(low)) && !/next turn/.test(low)) push({ kind: 'next_turn', why: 'names the next in order' }, 0.8);
  }

  for (const s of sentences(raw)) {
    const sl = norm(s);
    if (/\?/.test(sl) || /\b(if|would|could|might|should|can i|do i|may i|how much|what)\b/.test(sl.split(/[,;]/)[0])) continue;
    const ms = mentions(s, ctx);
    // area damage: "every monster takes 14", "all the goblins take 5"
    const area = sl.match(/\b(?:every|each|all(?: of)?(?: the)?)\s+(monsters?|enemies|creatures|foes|goblins?|orcs?|skeletons?|bandits?|wolves|kobolds?|zombies?|cultists?|guards?)\s+(?:takes?|take|suffers?|is hit for|are hit for|loses?)\s+(\d{1,4})\b(?!\s*(?:minutes?|hours?|rounds?|turns?|feet|gold|gp))/);
    if (area) {
      const noun = area[1].replace(/s$/, '');
      const ids = list.filter((x) => !x.isPc && (/^(monster|enemie|creature|foe)/.test(noun) || x.name.toLowerCase().includes(noun.replace(/ie$/, 'y')))).map((x) => x.id);
      if (ids.length) push({ kind: 'damage', ids, amount: Number(area[2]), why: area[0] }, 0.85);
      continue;
    }
    for (let i = 0; i < ms.length; i++) {
      const mt = ms[i];
      const before = s.slice(Math.max(0, mt.start - 50), mt.start).toLowerCase();
      const after = s.slice(mt.end, mt.end + 70).toLowerCase();
      const pcOnly = mt.ids.every((id) => list.find((x) => x.id === id)?.isPc);
      const noTime = '(?!\\s*(?:minutes?|hours?|days?|rounds?|turns?|steps?|feet|ft|seconds?|gold|gp|silver|sp|copper|cp|coins?|more turns?|%|percent))';
      const num = (re: RegExp, s: string): number | null => { const x = re.exec(s); return x ? Number(x[1]) : null; };
      // damage
      let dmg: number | null = num(new RegExp(`^\\W*(?:(?:also|then|now|just|still)\\s+)?(?:takes?|took|suffers?|suffered|loses|lost|is dealt|are dealt|receives?)\\s+(\\d{1,4})\\b${noTime}`), after);
      dmg ??= num(new RegExp(`^\\W*(?:is|are|gets?)\\s+hit\\s+for\\s+(\\d{1,4})\\b${noTime}`), after);
      if (dmg === null && /(?:hit|hits|hurt|hurts|strike|strikes|stab|stabs|slash|slashes|burn|burns|blast|blasts|catch|catches|smash|smashes|deal|deals|punish|punishes|shoot|shoots|clip|clips)\s+(?:the\s+)?$/.test(before)) dmg = num(/^\s+(?:for|by)\s+(\d{1,4})\b/, after);
      if (dmg === null) dmg = num(/(\d{1,4})\s*(?:points?\s+of\s+)?(?:[a-z]+\s+)?damage\s+(?:to|on|against)\s+(?:the\s+)?$/, before);
      if (dmg !== null) {
        // "It's a crit! Tomas takes 18": said in the same line, the hit is a critical one (two death save failures
        // on a downed character). "Not a crit" and "no crit" are not.
        const crit = /\b(?:crit|crits|critted|critical(?:ly)?(?:\s+hit)?|nat(?:ural)?\s+(?:20|twenty))\b/i.test(low) && !/\b(?:not|no|isn'?t|wasn'?t|without)\s+(?:a\s+)?(?:crit|critical)/i.test(low);
        push({ kind: 'damage', ids: mt.ids, amount: dmg, why: s.slice(0, 80), ...(crit ? { crit: true } : {}) }, mt.ids.length === 1 ? 0.92 : 0.55);
        // "takes 9 damage and falls to the floor, dead": the same sentence may end the creature.
        if (!pcOnly && mt.ids.length === 1 && /\b(?:and|then|,)\s+(?:it\s+)?(?:dies|is dead|is slain|drops dead|falls?\b[^.;]{0,25}\bdead|collapses[^.;]{0,15}\bdead|is killed)\b/.test(after)) push({ kind: 'remove_creature', id: mt.ids[0], why: s.slice(0, 80) }, 0.82);
        continue;
      }
      // temporary hit points are never healing ("Tomas gains 8 temporary hit points")
      const tmp = num(/^\W*(?:(?:also|then|now)\s+)?(?:gains?|gets?|receives?|is granted|has)\s+(\d{1,3})\s+(?:temporary\s+hit\s+points|temp(?:orary)?\s+(?:hp|hit\s+points))/, after);
      if (tmp !== null) { push({ kind: 'temp_hp', ids: mt.ids, amount: tmp, why: s.slice(0, 80) }, mt.ids.length === 1 ? 0.9 : 0.55); continue; }
      // concentration: starting a spell, losing it, or keeping it
      if (mt.ids.length === 1) {
        const cs = after.match(/^\W*(?:(?:is|are)\s+)?(?:now\s+)?concentrat(?:es|ing)\s+on\s+([a-z' -]{3,40}?)(?:[.,;!?]|\s+(?:and|but|while|as|so|with|to)\b|$)/);
        if (cs && !/^(?:it|that|this|them)$/.test(cs[1])) { push({ kind: 'concentration', id: mt.ids[0], action: 'start', spell: cs[1].replace(/(^|\s)(\p{L})/gu, (_x, a, b) => a + b.toUpperCase()).replace(/\b(Of|The|And)\b/g, (x) => x.toLowerCase()), why: s.slice(0, 80) }, 0.85); continue; }
        if (/^\W*(?:(?:also|then|now)\s+)?(?:loses|lost|drops|dropped|breaks|broke)\s+(?:his|her|their|its|the)?\s*concentration\b|^\W*fails\s+(?:his|her|their|its|the)?\s*concentration\s+(?:check|save|saving throw)|^\W*(?:fails|failed)\s+(?:the\s+)?(?:con(?:stitution)?\s+)?save\b[^.;]{0,30}\bconcentration/.test(after)) { push({ kind: 'concentration', id: mt.ids[0], action: 'lose', why: s.slice(0, 80) }, 0.88); continue; }
        if (/^\W*(?:makes|made|passes|passed|succeeds on|keeps|kept|holds|held)\s+(?:his|her|their|its|the)?\s*concentration(?:\s+(?:check|save|saving throw))?\b/.test(after)) { push({ kind: 'concentration', id: mt.ids[0], action: 'pass', why: s.slice(0, 80) }, 0.85); continue; }
      }
      // a death save at the table: "Tomas rolls a 14 on his death save", "Tomas fails a death save"
      if (mt.ids.length === 1 && pcOnly && /\bdeath sav/.test(after)) {
        const dr = after.match(/^\W*(?:rolls?|rolled|got|gets|makes|made|throws?|threw)\s+(?:an?\s+)?(?:natural\s+|nat\s+)?(\d{1,2})\b/);
        const nat = /\b(?:natural|nat)\s+(?:20|twenty)\b/.test(after) ? 20 : /\b(?:natural|nat)\s+(?:1|one)\b/.test(after) ? 1 : null;
        const roll = nat ?? (dr ? Number(dr[1]) : null);
        if (roll !== null && roll >= 1 && roll <= 20) { push({ kind: 'death_save', id: mt.ids[0], roll, why: s.slice(0, 80) }, 0.85); continue; }
        if (/^\W*(?:fails?|failed|blows|botches)\b/.test(after)) { push({ kind: 'death_save', id: mt.ids[0], result: 'failure', why: s.slice(0, 80) }, 0.8); continue; }
        if (/^\W*(?:succeeds?|succeeded|passes|passed|makes|made)\b/.test(after)) { push({ kind: 'death_save', id: mt.ids[0], result: 'success', why: s.slice(0, 80) }, 0.8); continue; }
      }
      // healing
      let hl: number | null = num(new RegExp(`^\\W*(?:(?:also|then|now)\\s+)?(?:heals?|regains?|recovers?|gets? healed|is healed|gains?)\\s+(?:for\\s+)?(\\d{1,4})\\b(?:\\s*(?:hit points|hp|health|points))?${noTime}`), after);
      if (hl !== null && /spell slot|inspiration|exhaustion/.test(after)) hl = null;
      if (hl === null && /\b(?:heal|heals|healing|cure|cures|mend|mends)\s+(?:the\s+)?$/.test(before)) hl = num(/^\s+(?:for\s+)?(\d{1,4})\b/, after);
      if (hl !== null) { push({ kind: 'heal', ids: mt.ids, amount: hl, why: s.slice(0, 80) }, mt.ids.length === 1 ? 0.9 : 0.55); continue; }
      // conditions
      const vocative = after.match(new RegExp(`^[,]?\\s+you(?:'re| are)\\s+(?:now\\s+|also\\s+)?(${CONDS})\\b`));
      if (vocative) { push({ kind: 'condition', id: mt.ids[0], add: [cap(vocative[1])], remove: [], why: s.slice(0, 80) }, mt.ids.length === 1 ? 0.88 : 0.5); continue; }
      const looseGone = after.match(new RegExp(`^[^.;]{0,40}?\\bno longer\\s+(${CONDS})\\b`));
      if (looseGone && mt.ids.length === 1) { push({ kind: 'condition', id: mt.ids[0], add: [], remove: [cap(looseGone[1])], why: s.slice(0, 80) }, 0.85); continue; }
      const gone = after.match(new RegExp(`^\\W*(?:is|are)\\s+no longer\\s+(${CONDS})\\b|^\\W*(?:shakes? off|recovers? from|is cured of|breaks? free of|is freed from|throws? off)\\s+(?:the\\s+)?(${CONDS})\\b`));
      if (gone) { push({ kind: 'condition', id: mt.ids[0], add: [], remove: [cap(gone[1] ?? gone[2])], why: s.slice(0, 80) }, mt.ids.length === 1 ? 0.88 : 0.5); continue; }
      const cd = after.match(new RegExp(`^\\W*(?:(?:is|are|falls?|gets?|becomes?|now|also|still|go(?:es)?|has been|was|were)\\s+)*(?:knocked\\s+|now\\s+)?(${CONDS})\\b`));
      // "stunned until the end of his next turn", "poisoned for 3 rounds": the condition carries its duration
      const span = /\buntil\s+(?:the\s+)?(end|start)\s+of\s+(?:his|her|their|its)\s+next\s+turn\b/.exec(after);
      const rd = /\bfor\s+(\d{1,2})\s+rounds?\b/.exec(after);
      if (cd && !/\bnot\b/.test(after.slice(0, (cd.index ?? 0) + 12))) { push({ kind: 'condition', id: mt.ids[0], add: [cap(cd[1])], remove: [], ...(span && mt.ids.length === 1 ? { until: span[1] as 'end' | 'start' } : rd ? { rounds: Number(rd[1]) } : {}), why: s.slice(0, 80) }, mt.ids.length === 1 ? 0.88 : 0.5); continue; }
      // dies: only a creature, never a player character
      if (!pcOnly && mt.ids.length === 1 && /^\W*(?:dies|is dead|is slain|is defeated|drops dead|falls dead|is killed|collapses dead|slumps lifeless|is down for good|crumples and (?:dies|is still)|dies on the spot)\b/.test(after)) push({ kind: 'remove_creature', id: mt.ids[0], why: s.slice(0, 80) }, 0.82);
      void i;
    }
  }
  return out;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Monsters joining the fight and initiative rolls, from GM or player lines. */
function addCues(line: LineIn, ctx: CueCtx): Scored[] {
  const out: Scored[] = [];
  const low = norm(line.text);
  const re = new RegExp(`\\b(an?|one|two|three|four|five|six|seven|eight|nine|ten|\\d{1,2}|a pair of|a couple of|several)\\s+((?:[a-z]+\\s+)?(?:${MONSTERS}))\\b(?:[^.!?]{0,60}?)\\b(burst|bursts|jump|jumps|leap|leaps|attack|attacks|ambush|ambushes|appear|appears|rush|rushes|emerge|emerges|charge|charges|spring|springs|drop|drops|descend|descends|storm|storms|swarm|swarms|surround|surrounds|step out|stream out|pour out|lunge|lunges|come at|come out of|dart|darts)\\b`);
  const q = /\?|\b(if|would|could|might|maybe|what if|you might|there could|there might|possibly|do you want|should)\b/.test(low);
  const m = re.exec(low);
  if (m && !q) {
    const n = /^\d/.test(m[1]) ? Number(m[1]) : (NUMW[m[1]] ?? 1);
    const noun = m[2].replace(/^(?:\w+\s+)(?=(?:\w+)$)/, (x) => (new RegExp(`^(?:${MONSTERS})$`).test(m[2]) ? x : x)).trim();
    let name = noun.split(' ').slice(-1)[0];
    name = name === 'wolves' ? 'wolf' : name.replace(/ies$/, 'y').replace(/(?<![s])s$/, '');
    if (n >= 1 && n <= 12) out.push({ kind: 'add_monsters', name: cap(name), count: n, why: m[0].slice(0, 80), confidence: 0.8 });
    // a second kind in the same line: "two goblins and an ogre"
    const second = low.match(new RegExp(`\\band\\s+(an?|one|two|three|four|\\d{1,2})\\s+((?:${MONSTERS}))\\b`));
    if (second && second[2] !== m[2]) { const n2 = /^\d/.test(second[1]) ? Number(second[1]) : (NUMW[second[1]] ?? 1); out.push({ kind: 'add_monsters', name: cap(second[2].replace(/ies$/, 'y').replace(/(?<![s])s$/, '')), count: n2, why: second[0], confidence: 0.8 }); }
  }
  void line; void ctx;
  return out;
}

function playerCues(line: LineIn, ctx: CueCtx): Scored[] {
  const out: Scored[] = [];
  const low = norm(line.text);
  if (!line.accountId || /\?/.test(low)) return out;
  // What a player may legitimately set off: their own initiative roll and using their own item. Never a scene.
  let m: RegExpMatchArray | null;
  if (ctx.combat.active || ctx.initiativeOpen) {
    if ((m = low.match(/^(\d{1,2})\s+(?:for|on)\s+initiative\b/)) || (m = low.match(/\b(?:i (?:rolled|got|have|get|roll)|my initiative(?: is)?|initiative(?: is)?|that's|it's|it is|a)\s+(?:a\s+)?(\d{1,2})\b(?:\s*(?:for|on)\s+initiative)?/)) && /initiative/.test(low)) {
      const p = ctx.party.find((x) => x.accountId === line.accountId);
      out.push({ kind: 'initiative', accountId: line.accountId, name: p?.character || p?.name || line.speaker, value: Number(m[1]), why: low.slice(0, 80), confidence: 0.9 });
    } else if (ctx.initiativeOpen && (m = low.match(/^(?:i (?:rolled|got)(?: a)?|that's a|it's a|a|total of|that is a)?\s*(\d{1,2})\.?$/))) {
      const p = ctx.party.find((x) => x.accountId === line.accountId);
      out.push({ kind: 'initiative', accountId: line.accountId, name: p?.character || p?.name || line.speaker, value: Number(m[1]), why: low.slice(0, 80), confidence: 0.8 });
    }
  }
  if ((m = low.match(/\bi\s+(?:(?:quickly|carefully|just|then|also|now|will|'ll|go to|want to|would like to)\s+)*(?:drink|drinks|quaff|quaffs|eat|eats|swallow|swallows|use|uses|apply|applies|read|burn|light)\s+(?:my\s+|the\s+|a\s+|an\s+|one of my\s+|this\s+)?([a-z][a-z' -]{2,40}?)(?=$|[,.!;]| and | to | on | before | now| then)/)) && !/\b(i would|should i|can i|may i|could i)\b/.test(low)) out.push({ kind: 'use_item', accountId: line.accountId, phrase: m[1].trim(), why: low.slice(0, 80), confidence: 0.75 });
  return out;
}

/** Everything the lines say: GM rules, plus creatures joining and player rolls. */
export function allCues(line0: LineIn, ctx: CueCtx, opts: { explicit?: boolean } = {}): Scored[] {
  const line = { ...line0, text: digitize(line0.text) };
  const base = cuesOf(line, ctx, opts);
  if (line.role === 'gm' || opts.explicit) return dedupe([...base, ...addCues(line, ctx)]);
  return base;
}

function dedupe(list: Scored[]): Scored[] {
  const seen = new Set<string>();
  return list.filter((x) => { const k = JSON.stringify([x.kind, (x as any).ids ?? (x as any).id ?? (x as any).name ?? (x as any).mood ?? (x as any).amount ?? '']) + w((x as any).amount ?? ''); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---- wake word -------------------------------------------------------------------------

/** "Minerva, play something tense" -> "play something tense". Only at the start of a sentence in the line. */
export function wakeCommand(text: string, wakeWord: string): string | null {
  const ww = norm(wakeWord || 'Minerva');
  if (!ww) return null;
  const re = new RegExp(`(?:^|[.!?]\\s+)(?:hey\\s+|ok\\s+|okay\\s+)?${esc(ww)}[,:;.!\\s-]+(.{3,})$`, 'i');
  const m = re.exec(text.trim());
  return m ? m[1].trim() : null;
}
