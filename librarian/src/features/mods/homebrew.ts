// Homebrew rules: the quick way for a Game Master to change a 5e rule at their table ("you can make one weapon
// attack with your bonus action, at disadvantage") without writing a rule file. The quick form turns a name and a
// sentence into an ordinary house rule (kit 2) that is marked `homebrew`, carries the text for players, a note for
// the assistants with `always` on (so Minerva, Squire and the Broker keep it in mind on every message, not only
// when the words match), and optionally a roll button on the player's sheet. Pure: no database. See docs/MODS.md.
import { ROLL_KINDS, ROLL_MODES, ROLL_PLACES, type ModFile, type RollKind, type RollMode, type RollPlace, type SheetRoll } from './format.ts';
import { parseVer } from './semver.ts';

export interface HomebrewInput {
  name: string;
  /** The rule as players read it. */
  text: string;
  /** Extra guidance only the Game Master's assistant sees. */
  gm?: string;
  /** Words or phrases that bring it up, on top of the ones found in the text. */
  words?: string[];
  roll?: { label: string; kind?: RollKind; mode?: RollMode; places?: RollPlace[]; word?: string } | null;
}

/** 5e phrases worth matching on when they appear in a homebrew rule's name or text. */
const PHRASES = ['bonus action', 'reaction', 'opportunity attack', 'two-weapon', 'off-hand', 'short rest', 'long rest', 'death save', 'critical hit', 'critical', 'initiative', 'concentration', 'grapple', 'shove', 'inspiration', 'hit dice', 'hit points', 'spell slot', 'cantrip', 'potion', 'disadvantage', 'advantage', 'flanking', 'cover', 'exhaustion', 'saving throw', 'ability check', 'skill check', 'attack roll', 'damage roll', 'healing', 'movement', 'dash', 'dodge', 'disengage', 'help action', 'hide', 'ready'];

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36).replace(/-+$/, '');

/** The words a homebrew rule is found by: the GM's own, then the 5e phrases its name and text use. */
export function homebrewWords(name: string, text: string, own: string[] = []): string[] {
  const t = ` ${name} ${text} `.toLowerCase();
  const out = new Set<string>(own.map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 3 && w.length <= 40));
  for (const p of PHRASES) if (new RegExp(`(^|[^a-z])${p.replace(/-/g, '[- ]?')}([^a-z]|$)`).test(t)) out.add(p);
  return [...out].slice(0, 24);
}

/** The first sentence, for the summary. */
const firstSentence = (s: string) => { const m = /^(.+?[.!?])(\s|$)/s.exec(s.trim()); return (m ? m[1] : s.trim()).slice(0, 300); };

/** Bump the patch part of a version (1.0.3 -> 1.0.4); anything else starts again at 1.0.1. */
export function nextVersion(v: string | undefined): string {
  const p = v ? parseVer(v) : null;
  return p ? `${p[0]}.${p[1]}.${p[2] + 1}` : '1.0.1';
}

/** A homebrew rule as a house rule file, ready for checkMod/importMod. */
export function homebrewFile(id: string, input: HomebrewInput, version = '1.0.0'): Record<string, unknown> {
  const name = String(input.name ?? '').trim();
  const text = String(input.text ?? '').trim();
  const gm = String(input.gm ?? '').trim();
  const roll = input.roll && String(input.roll.label ?? '').trim() ? input.roll : null;
  const rolls: SheetRoll[] = roll ? [{
    id: 'roll', label: String(roll.label).trim().slice(0, 40),
    kind: ROLL_KINDS.includes(roll.kind as RollKind) ? roll.kind as RollKind : 'attack',
    mode: ROLL_MODES.includes(roll.mode as RollMode) ? roll.mode as RollMode : 'normal', note: '',
    places: Array.isArray(roll.places) ? roll.places.filter((x) => ROLL_PLACES.includes(x)) : ['sheet'],
    word: typeof roll.word === 'string' ? roll.word.trim().toLowerCase().replace(/^\//, '') : '',
  }] : [];
  return {
    kit: 2, id, name, version, author: 'Game Master', summary: firstSentence(text), homebrew: true,
    targets: { builtFor: [], worksWith: ['assistant', ...(rolls.length ? ['sheet', 'chat'] : [])] },
    rules: [{ term: `${name} (house rule)`, text }],
    ...(rolls.length ? { rolls } : {}),
    assistant: {
      words: homebrewWords(name, text, input.words ?? []),
      dm: `${text}${gm ? ` ${gm}` : ''}`.slice(0, 1200),
      player: text.slice(0, 1200),
      always: true,
    },
  };
}

/** The rules every assistant keeps in mind while they are on: homebrew ones and any with assistant.always. */
export const alwaysOn = (mods: ModFile[]) => mods.filter((m) => m.homebrew || m.assistant?.always);

/** The context note for those rules, for the Game Master's assistant (`gm`) or a player's (their text only). */
export function alwaysNote(mods: ModFile[], gm: boolean, max = 1600): string {
  const plain = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
  const lines = alwaysOn(mods).map((m) => {
    const t = plain((gm ? m.assistant?.dm : m.assistant?.player) || m.rules.map((r) => r.text).join(' ') || m.summary);
    return `- ${m.name}: ${t.length > 400 ? `${t.slice(0, 399)}…` : t}${m.rolls.length ? ` (the sheet has a "${m.rolls[0].label}" button for it)` : ''}`;
  });
  if (!lines.length) return '';
  let body = '';
  for (const l of lines) { if (body.length + l.length + 1 > max) { body += '\n- (more house rules: see the house rules list)'; break; } body += `${body ? '\n' : ''}${l}`; }
  return `Homebrew rules at this table. They change the 5e rules here, so follow them over the rules book and say when one applies:\n${body}`;
}

/** The dice for a sheet roll: 1d20, 2d20kh1 or 2d20kl1, plus the bonus. */
export function rollExpr(mode: RollMode, bonus: number): string {
  const d = mode === 'advantage' ? '2d20kh1' : mode === 'disadvantage' ? '2d20kl1' : '1d20';
  return bonus ? `${d}${bonus < 0 ? '-' : '+'}${Math.abs(bonus)}` : d;
}

// ---- suggested extras: what the assistant (or, without a model, word rules) offers to add to a saved rule ----------

export interface Suggestions {
  source: 'model' | 'rules';
  roll: { label: string; kind: RollKind; mode: RollMode; why: string } | null;
  gm: { text: string; why: string } | null;
  words: { list: string[]; why: string } | null;
}

export const SUGGEST_SYSTEM = [
  'You help a Game Master of a 5e tabletop role-playing game set up a homebrew rule in an app called Alexandria.',
  'For a rule, Alexandria can add three extras. Suggest only the ones that really help this rule:',
  '1. roll: a roll button on the players\' sheets, only when the rule changes a specific roll a player makes. kind "attack" is a d20 plus a weapon\'s attack bonus; kind "d20" is a d20 plus a bonus the player types (a check or save). mode is "normal", "advantage" or "disadvantage". label is the button text, at most 30 letters.',
  '2. gm: a short private note (at most 300 letters) for the Game Master\'s assistant: how to rule the edge cases, what to remind players of.',
  '3. words: up to 6 words or short phrases players might use when asking about the rule that are not already in it.',
  'Each extra has "why": one short sentence a Game Master reads.',
  'Reply with JSON only: {"roll": null or {"label","kind","mode","why"}, "gm": null or {"text","why"}, "words": null or {"list": [...], "why"}}',
].join('\n');

/** Clean what a model said into Suggestions, dropping anything malformed. */
export function cleanSuggestions(raw: any, source: Suggestions['source']): Suggestions {
  const s = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
  const r = raw?.roll;
  const roll = r && typeof r === 'object' && s(r.label, 40) ? {
    label: s(r.label, 40), kind: ROLL_KINDS.includes(r.kind) ? r.kind as RollKind : 'attack' as RollKind,
    mode: ROLL_MODES.includes(r.mode) ? r.mode as RollMode : 'normal' as RollMode, why: s(r.why, 200),
  } : null;
  const gm = raw?.gm && s(raw.gm.text, 300) ? { text: s(raw.gm.text, 300), why: s(raw.gm.why, 200) } : null;
  const list = Array.isArray(raw?.words?.list) ? raw.words.list.map((w: unknown) => s(w, 40).toLowerCase()).filter((w: string) => w.length >= 3).slice(0, 6) : [];
  return { source, roll, gm, words: list.length ? { list, why: s(raw.words.why, 200) } : null };
}

/** Without a model: a roll button when the rule names an attack, check or save with advantage or disadvantage. */
export function ruleSuggestions(name: string, text: string): Suggestions {
  const t = ` ${name} ${text} `.toLowerCase();
  const mode: RollMode | null = /disadvantage/.test(t) ? 'disadvantage' : /(^|[^s])advantage/.test(t) ? 'advantage' : null;
  const attack = /\battack/.test(t);
  const check = /\b(checks?|saving throws?|saves?)\b/.test(t);
  let roll: Suggestions['roll'] = null;
  if (mode && (attack || check)) {
    const label = attack ? (/bonus action/.test(t) ? 'Bonus action attack' : /reaction/.test(t) ? 'Reaction attack' : `${name}`.slice(0, 30)) : `${name}`.slice(0, 30);
    roll = { label, kind: attack ? 'attack' : 'd20', mode, why: `The rule changes ${attack ? 'an attack roll' : 'a check or save'} to ${mode}, so players can roll it from their sheet.` };
  }
  return { source: 'rules', roll, gm: null, words: null };
}
