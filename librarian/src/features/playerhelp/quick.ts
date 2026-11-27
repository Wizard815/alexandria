// Squire, the players' quick helper: a small second model (4B or less, or a ternary
// 9B such as Bonsai, all under about 6 GB) on its own llama.cpp server, next
// to the main chat model. It runs the 'helper' job (core/ai.ts; unset, the
// Players model, then Chat).
//
// It keeps no conversation. Every call starts fresh from a short brief built
// here from what this player may see: their sheet (HP, conditions, goals the
// DM set), their items, the combat tracker as they see it, tonight's party
// summary and the last lines the table heard, their own goals and journal, a
// few rules passages and a few library chunks shared with the party. So the
// prompt stays small (a 4K to 8K context is plenty) and the server's slots
// are recycled call after call.
//
// Each player may name their Squire and give it a personality trait
// (squire_prefs). The trait changes how it sounds, never what it says; a trait
// that is blank, too long, or tries to change the rules is not used, and the
// Squire answers in its plain voice (squireTrait).
//
// It does narrow jobs: a rules lookup, options for this turn, a summary of the
// sheet and notes, and what to do next. Anything bigger (world lore that is
// not in the brief, writing, a change to anything, a long question) is handed
// off: to the broker for in-world knowledge, or to the table helper (the
// player harness on the main model, with tools) for everything else.
import type { Deps } from '../../app.ts';
import { chat, hasJob, jobConfig, ownJobConfig, wouldBeRefused, ModelUnavailable } from '../../core/ai.ts';
import { all, one, run, type DB } from '../../core/db.ts';
import { combatViewFor } from '../../core/combatView.ts';
import type { Viewer, WorldSettings } from '../../core/policy.ts';
import { parseJson } from '../../core/util.ts';
import { latestSummary } from '../audio/summary.ts';
import { liveLines } from '../minerva/live.ts';
import { brokerContext } from '../minerva/player.ts';
import { searchRules } from '../modules/search.ts';
import { playerCard } from '../modules/hide.ts';
import { hybridPages } from '../search/embeddings.ts';
import { worldModules } from '../modules/store.ts';
import { character, knownRows, spellById } from '../spells/store.ts';
import { ABILITIES } from '../spells/format.ts';
import { playerView } from '../minerva/player.ts';

export const QUICK_TASKS = ['ask', 'rules', 'turn', 'sheet', 'suggest', 'recap'] as const;
export type QuickTask = (typeof QUICK_TASKS)[number];
export type HandoffTo = 'broker' | 'helper';

export interface BriefSection { label: string; text: string }
export interface Brief { sections: BriefSection[]; text: string; chars: number; lore: { id: string; title: string }[] }

export interface QuickAnswer {
  task: QuickTask;
  answer: string;
  handoff: { to: HandoffTo; reason: string; question: string } | null;
  model: string | null;
  ms: number;
  brief: { chars: number; sections: string[] };
}

/** What each task asks the small model to do. */
const TASKS: Record<QuickTask, string> = {
  ask: 'Answer the player\'s question in at most 80 words.',
  rules: 'Answer the rules question: name the rule, give the short version, then say in one line what it means for this character right now. Use the Rules passages; if none covers it, say so.',
  turn: 'List 3 to 5 options for this character\'s turn right now, one line each, using their health, conditions and the combat as shown. Use the actions anyone has (Attack, Dash, Disengage, Dodge, Help, Hide, Ready, Use an Object, moving) and what is under What they can do: their weapons (with the damage), class features and spells (say when one uses the bonus action, the reaction or mana). Nothing that is not listed there. If no weapons, features or spells are listed (or there is no combat), still give options from the actions anyone has and the items they carry, and add one line that their weapons, features and spells are not on their sheet yet. Do not hand this task off. Then say in one line which you would pick and why.',
  sheet: 'Sum up this character in 4 to 6 short bullets: health and conditions, what they carry that matters, their goals, and what is going on for them right now.',
  recap: 'Sum up for this player, in 4 to 8 short bullets: what happened in the past sessions (newest first), then the open quests and goals and where each one stands. Use only the brief. Where the brief says nothing, say it is not known yet; never fill a gap.',
  suggest: 'Suggest 3 things this character could do next, one line each, grounded in what just happened and their goals. Only use people, places and things named in the brief. Do not decide for them.',
};

/** The question a task stands for when the player typed none. */
const DEFAULT_Q: Record<QuickTask, string> = {
  ask: '', rules: '', turn: 'What can I do on my turn?', sheet: 'Sum up my character.', suggest: 'What should I do next?', recap: 'What has happened so far, and what are we after?',
};

// Questions that need more than a small model with a short brief.
const IN_WORLD = /\b(who\b(?:\s+\w+)?\s+(is|was|are|were|rules|runs|leads|controls|owns|killed|sent|hired)|what happened (to|at|in)|history of|tell me (about|more)|where (is|are|was|were|can i find)|why (did|does|is|are|was|were)|rumou?rs?|legends? of|secrets?|secretly)\b/i;
// ... unless it is about the fight or the rules ("who is next in initiative?").
const TABLE_TALK = /\b(initiative|my turn|next turn|round|combat|fight|hp|hit points|spell|action|attack|advantage|disadvantage|condition)\b/i;
const WRITING = /\b(write|draft|compose|rewrite|journal entry|backstory|poem|song|letter|speech)\b/i;
const CHANGES = /\b(add|remove|delete|give|send|buy|sell|update|change|set|record|save|log)\b.{0,30}\b(my|the|to|from|item|items|inventory|journal|goal|hp|coin|gold)\b/i;
const MAX_QUESTION = 400;
const REASONS = {
  broker: 'That is in-world knowledge; ask The Broker.',
  helper: 'The table helper can take this one.',
  unknown: 'Your character does not know that yet. The Broker might find out.',
} as const;
/** An answer that says the player does not know (yet). */
export const DOES_NOT_KNOW = /\b(not known( yet)?|unknown|(do|does|did)(n['’]t| not) (know|say|mention|tell)|not sure|no (information|record|mention)|(is|are)(n['’]t| not) (stated|mentioned|known|clear)|nothing (about|on) (that|this|it))\b/i;

/** Where a question goes before any model is asked, or null for the quick helper. */
/** Small models still say "(not listed in the brief)": drop those asides and call the brief the player's notes. */
export const noBriefTalk = (t: string) => t
  .replace(/\s*\([^()]*\bbrief\b[^()]*\)/gi, '')
  .replace(/\b(?:the|your|this) brief (say|mention|list|show)s\b/gi, (_m, v: string) => `your notes ${v}`)
  .replace(/\b(?:the|your|this) brief\b/gi, 'your notes')
  .replace(/(^|[.!?]\s+)your notes/g, '$1Your notes');

export function routeFirst(task: QuickTask, question: string, brief: Brief): { to: HandoffTo; reason: string } | null {
  const q = question.trim();
  if (q.length > MAX_QUESTION) return { to: 'helper', reason: 'That is a long question; the table helper can take it.' };
  if (task === 'ask' || task === 'rules') {
    if (WRITING.test(q)) return { to: 'helper', reason: 'Writing is a job for the table helper.' };
    if (CHANGES.test(q)) return { to: 'helper', reason: 'Your Squire cannot change anything; the table helper can propose it.' };
    // Who, why, history, rumours: the broker's trade, with its own secret checks. A small model asked this
    // with a page or two in front of it fills the gaps with names of its own (seen with 3-4B models).
    if (IN_WORLD.test(q) && !TABLE_TALK.test(q)) return { to: 'broker', reason: REASONS.broker };
  }
  return null;
}

const HANDOFF = /HANDOFF\s+(broker|helper)\b\s*[:\-–]?\s*(.*)$/im;
/**
 * The model's own handoff, if it wrote one: anywhere in the reply (a small model often answers first and hands off
 * after). `answer` is what came before it, which is still worth showing when it says something.
 */
export function parseHandoff(text: string): { to: HandoffTo; reason: string; answer: string } | null {
  const m = HANDOFF.exec(text);
  if (!m) return null;
  const to = m[1].toLowerCase() as HandoffTo;
  const answer = text.slice(0, m.index).trim();
  // The reason shown is ours: a small model's own "why" can carry names it made up.
  return { to, reason: REASONS[to], answer: answer.length >= 20 ? answer : '' };
}

const NAME = /\b[A-Z][a-z'’]+(?:[ -](?:of |de )?[A-Z][a-z'’]+)+\b/g;
// Game words a rules answer capitalises ("Opportunity Attack", "Dexterity Saving Throw"): never a made-up name.
const GAME_WORDS = new Set(('opportunity attack action actions bonus reaction saving save throw throws advantage disadvantage strength dexterity constitution '
  + 'intelligence wisdom charisma stealth perception athletics acrobatics insight investigation sleight hand armor armour class hit points dice '
  + 'short long rest sneak cunning inspiration initiative round turn help hide dash disengage dodge ready search use object magic cover heavily '
  + 'lightly obscured difficult terrain concentration death dungeon master dm game player character potion healing srd d&d').split(' '));
/** Names of two or more capitalised words in the answer that the brief and the question never mention. */
export function unknownNames(answer: string, known: string): string[] {
  const k = known.toLowerCase().replace(/\s+/g, ' ');
  const kWords = new Set(k.match(/[a-z'’]+/g) ?? []);
  const text = answer.replace(/[*_`#]/g, '');
  const out = new Set<string>();
  for (const m of text.matchAll(NAME)) {
    const words = m[0].split(/[ -]/).filter((w) => !/^(of|de)$/.test(w));
    if (k.includes(m[0].toLowerCase())) continue;
    // The first word of a sentence or a bullet is capitalised anyway ("Attack Smuggler ..."): it does not count.
    const before = text.slice(0, m.index).replace(/[ \t]+$/, '');
    const judged = !before || /[.!?:\n•\-*]$/.test(before) ? words.slice(1) : words;
    if (judged.some((w) => !kWords.has(w.toLowerCase()) && !GAME_WORDS.has(w.toLowerCase()))) out.add(m[0]);
  }
  return [...out];
}

/**
 * Leave out the lines that name people, places or things the brief does not have: a small model invents them
 * (a "Silas Blackwood" behind the council). What is left is shown; nothing left hands the question to the broker.
 */
export function groundAnswer(answer: string, known: string): { text: string; dropped: string[] } {
  const dropped = unknownNames(answer, known);
  if (!dropped.length) return { text: answer, dropped };
  const keep = answer.split('\n').filter((l) => !dropped.some((n) => l.replace(/[*_`#]/g, '').includes(n)));
  return { text: keep.join('\n').trim(), dropped };
}

/** Models that think out loud wrap it in <think>; the player gets the answer only. */
export const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();

const flat = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trim()}…` : s);
const tableExists = (d: Deps, name: string) => !!one(d.db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name);

/**
 * How many characters of brief fit: from the helper job's `contextTokens` option (default 4096), less room for the
 * instructions and the answer, at about 3.5 characters a token. At least 2,000, at most 16,000.
 */
export function briefBudget(d: Deps): number {
  const n = Number(jobConfig(d, 'helper')?.options?.contextTokens);
  const tokens = Number.isFinite(n) && n >= 1024 ? n : 4096;
  return Math.max(2000, Math.min(16_000, Math.round((tokens - 1200) * 3.5)));
}

/** The character: name, the sheet's health and conditions, goals the DM set for them. */
function characterPart(d: Deps, worldId: string, accountId: string): string {
  const m = one<any>(d.db, 'SELECT a.display_name AS name, m.character_name AS ch FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.account_id = ?', worldId, accountId);
  const L: string[] = [];
  if (m) L.push(`Player: ${m.name}${m.ch ? `, playing ${m.ch}` : ''}.`);
  // The player sheet (features/sheet) keeps HP and conditions; worlds without it simply have none here.
  if (tableExists(d, 'sheets')) {
    const s = one<any>(d.db, 'SELECT hp, max_hp, temp_hp, conditions FROM sheets WHERE world_id = ? AND account_id = ?', worldId, accountId);
    if (s) {
      const conds = parseJson<string[]>(s.conditions, []).filter((x) => typeof x === 'string');
      if (s.hp !== null || s.max_hp !== null) L.push(`HP: ${s.hp ?? '?'}${s.max_hp !== null ? ` of ${s.max_hp}` : ''}${s.temp_hp ? ` (+${s.temp_hp} temporary)` : ''}.`);
      L.push(`Conditions: ${conds.length ? conds.join(', ') : 'none'}.`);
    }
  }
  // No sheet (or nothing on it): their own line in the combat tracker, which a player may always see.
  if (!L.some((x) => x.startsWith('HP:'))) {
    const f = one<any>(d.db, 'SELECT hp, max_hp, temp_hp, effects FROM combatants WHERE world_id = ? AND account_id = ? LIMIT 1', worldId, accountId);
    if (f && (f.hp !== null || f.max_hp !== null)) {
      L.push(`HP: ${f.hp ?? '?'}${f.max_hp !== null ? ` of ${f.max_hp}` : ''}${f.temp_hp ? ` (+${f.temp_hp} temporary)` : ''} (combat tracker).`);
      const fx = parseJson<any[]>(f.effects, []).map((e) => e?.name).filter(Boolean);
      if (!L.some((x) => x.startsWith('Conditions:'))) L.push(`Conditions: ${fx.length ? fx.join(', ') : 'none'}.`);
    }
  }
  if (tableExists(d, 'sheet_dm_notes')) {
    const goals = all<any>(d.db, "SELECT text, done FROM sheet_dm_notes WHERE world_id = ? AND account_id = ? AND kind = 'goal' ORDER BY done, created_at LIMIT 6", worldId, accountId);
    if (goals.length) L.push(`Goals from the DM: ${goals.map((g) => `${clip(flat(g.text), 120)}${g.done ? ' (done)' : ''}`).join('; ')}.`);
  }
  return L.join('\n');
}

function itemsPart(d: Deps, worldId: string, accountId: string): string {
  const rows = all<any>(d.db, "SELECT name, qty, note FROM items WHERE world_id = ? AND owner = ? AND status = 'approved' ORDER BY name COLLATE NOCASE LIMIT 20", worldId, accountId);
  if (!rows.length) return 'Items: none of their own.';
  return `Items: ${rows.map((i) => `${i.qty && i.qty !== 1 ? `${i.qty} x ` : ''}${i.name}${i.note ? ` (${clip(flat(i.note), 60)})` : ''}`).join('; ')}.`;
}

function combatPart(d: Deps, worldId: string, v: Viewer, s: WorldSettings): string {
  let c: any;
  try { c = combatViewFor(d.db, worldId, v, s); } catch { return ''; }
  if (!c?.active) return '';
  const L = [`Combat is on, round ${c.round}. ${c.myTurn ? 'It is this character\'s turn.' : 'It is not this character\'s turn.'}`];
  if (Array.isArray(c.combatants) && c.combatants.length) {
    const order = c.combatants.slice(0, 10).map((x: any) => {
      const fx = (x.effects ?? []).map((e: any) => e.name).filter(Boolean);
      return `${x.name}${x.mine ? ' (this character)' : x.is_pc ? ' (ally)' : ''}${x.health ? `, ${x.health}` : ''}${fx.length ? `, ${fx.join('/')}` : ''}${x.id === c.currentId ? ' <- acting now' : ''}`;
    });
    L.push(`Initiative order: ${order.join('; ')}.`);
  }
  return L.join('\n');
}

function recentPart(d: Deps, worldId: string): string {
  const L: string[] = [];
  const sum = latestSummary(d, worldId, 'party');
  if (sum) L.push(`Tonight so far ("${sum.name}"): ${clip(flat(sum.text), 900)}`);
  else {
    const last = one<any>(d.db, 'SELECT number, title, summary FROM sessionlog_entries WHERE world_id = ? AND unpublished_at IS NULL ORDER BY number DESC LIMIT 1', worldId);
    if (last?.summary) L.push(`Last session (#${last.number}${last.title ? ` ${last.title}` : ''}): ${clip(flat(last.summary), 700)}`);
  }
  const live = liveLines(d, worldId, false, 6);
  if (live.session?.active && live.lines.length) L.push(`Just said at the table:\n${live.lines.map((l) => `${l.speaker}: ${clip(flat(l.text), 160)}`).join('\n')}`);
  return L.join('\n');
}

function rulesPart(d: Deps, worldId: string, q: string, s: WorldSettings): string {
  if (!q.trim()) return '';
  let hits;
  try { hits = searchRules(d.db, worldId, q, 2); } catch { return ''; }
  if (!hits.length) return '';
  return hits.map((h) => `[${h.citation || h.term}] ${clip(flat(playerCard({ kind: h.kind, text: h.passage }, s).text), 700)}`).join('\n');
}

async function lorePart(d: Deps, worldId: string, q: string, v: Viewer): Promise<{ text: string; hits: { id: string; title: string }[] }> {
  if (!q.trim()) return { text: '', hits: [] };
  let hits;
  try { hits = await hybridPages(d, worldId, q, 'party', 3, v); } catch { return { text: '', hits: [] }; }
  const keep = hits.filter((h) => h.snippet && !wouldBeRefused(d, h.snippet)).slice(0, 3);
  return { text: keep.map((h) => `[${h.title}] ${clip(flat(h.snippet), 300)}`).join('\n'), hits: keep.map((h) => ({ id: h.id, title: h.title })) };
}

const mod = (n: number) => { const m = Math.floor((n - 10) / 2); return m >= 0 ? `+${m}` : String(m); };
const plain = (s: string) => s.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
const singular = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim().replace(/(e?s)$/, '');

/**
 * What the character can do in a fight: class, level and ability scores (the spell sheet, or the player's profile),
 * weapons they carry with the module's damage line, their class features up to their level, the spells they know,
 * and any sheet note the player titled abilities, features, attacks or spells. Only their own sheet, never another's.
 */
export function kitPart(d: Deps, worldId: string, accountId: string): string {
  const L: string[] = [];
  let ch: ReturnType<typeof character> | null = null;
  try { ch = character(d.db, worldId, accountId); } catch { /* no spells feature */ }
  if (ch) {
    const head = [ch.class, ch.level ? `level ${ch.level}` : ''].filter(Boolean).join(', ');
    if (head) L.push(`Class: ${head}.`);
    const ab = ABILITIES.filter((k) => typeof ch!.abilities[k] === 'number').map((k) => `${k.toUpperCase()} ${ch!.abilities[k]} (${mod(ch!.abilities[k]!)})`);
    if (ab.length) L.push(`Ability scores: ${ab.join(', ')}.`);
    if (ch.manaMax !== null) L.push(`Mana: ${ch.mana ?? '?'} of ${ch.manaMax}.`);
  }
  let terms: any[] = [];
  try { terms = worldModules(d.db, worldId).terms as any[]; } catch { /* no modules */ }
  // Weapons: an item they carry whose name is a module item with a damage line.
  const items = all<any>(d.db, "SELECT name FROM items WHERE world_id = ? AND owner = ? AND status = 'approved' LIMIT 40", worldId, accountId);
  const byName = new Map<string, any>();
  for (const t of terms) if (t.kind === 'item' && /\*\*Damage:\*\*/.test(String(t.text ?? '')) && !byName.has(singular(t.term))) byName.set(singular(t.term), t);
  const weapons: string[] = [];
  for (const it of items) {
    const t = byName.get(singular(String(it.name)));
    if (!t || weapons.length >= 6) continue;
    const text = String(t.text);
    const dmg = /\*\*Damage:\*\*\s*([^\n]+)/.exec(text)?.[1]?.trim() ?? '';
    const props = /\*\*Properties:\*\*\s*([^\n]+)/.exec(text)?.[1]?.trim() ?? '';
    const mastery = /\*\*Mastery:\*\*\s*([^\n]+)/.exec(text)?.[1]?.trim() ?? '';
    weapons.push(`${it.name}: ${plain(dmg)}${props ? `; ${plain(props)}` : ''}${mastery ? `; mastery ${plain(mastery)}` : ''}`);
  }
  if (weapons.length) L.push(`Weapons: ${weapons.join(' | ')}.`);
  // Class features up to their level, from the module ("Rogue feature ...", data.class / data.level).
  if (ch?.class && ch.level) {
    const cls = ch.class.toLowerCase().split(/[\s/,]+/)[0];
    // The level is in data.level, or in the text's first line ("*Rogue · Rogue 3*"). A subclass's features
    // ("*Rogue · Thief 3*") are left out: the sheet does not say which subclass they took.
    const levelOf = (t: any): number | null => {
      if (Number.isInteger(t.data?.level)) return t.data.level;
      const m = /^\*[^*·]*·\s*([^*\d]+?)\s+(\d+)\*/.exec(String(t.text ?? ''));
      return m && m[1].trim().toLowerCase() === cls ? Number(m[2]) : null;
    };
    const feats = terms.filter((t) => t.kind === 'class' && String(t.data?.class ?? '').toLowerCase() === cls && !/subclass|ability score improvement|epic boon/i.test(t.term))
      .map((t) => ({ t, lv: levelOf(t) })).filter((x) => x.lv !== null && x.lv <= ch!.level!)
      .sort((a, b) => a.lv! - b.lv!).slice(0, 10)
      .map(({ t, lv }) => `${t.term} (level ${lv}): ${clip(plain(String(t.summary ?? '').replace(/^\w+ feature\.\s*/, '')), 140)}`);
    if (feats.length) L.push(`Class features:\n${feats.map((f) => `- ${f}`).join('\n')}`);
  }
  // Spells they know.
  try {
    const spells = knownRows(d.db, worldId, accountId).map((k) => spellById(d.db, worldId, k.spellId)).filter(Boolean).slice(0, 16) as any[];
    if (spells.length) L.push(`Spells known:\n${spells.map((sp) => `- ${sp.name} (${sp.level === 0 ? 'cantrip' : `level ${sp.level}`}, ${sp.castingTime}${sp.range ? `, ${sp.range}` : ''}${sp.concentration ? ', concentration' : ''})${sp.damageTypes?.length ? ` ${sp.damageTypes.join('/')}` : ''}`).join('\n')}`);
  } catch { /* no spells */ }
  // What the player wrote on their sheet under such a title (features/sheet; not a private module).
  if (tableExists(d, 'sheets')) {
    const row = one<any>(d.db, 'SELECT modules FROM sheets WHERE world_id = ? AND account_id = ?', worldId, accountId);
    for (const m of parseJson<any[]>(row?.modules, []) ?? []) {
      if (!m || m.private || !/abilit|feature|attack|weapon|spell|feat|power|trait|action/i.test(String(m.title ?? ''))) continue;
      const body = m.type === 'list' ? (m.data?.entries ?? []).map((e: any) => e?.text).filter(Boolean).join('; ') : String(m.data?.text ?? '');
      if (plain(body)) L.push(`${m.title} (their sheet): ${clip(plain(body), 500)}`);
    }
  }
  return L.join('\n');
}

/**
 * The story so far as this player knows it: the published session log (party level), the party's arcs, their own
 * goals and the DM's goals for them, their latest journal, and what they bought from the broker. Nothing DM-only.
 */
export function recapPart(d: Deps, worldId: string, accountId: string): string {
  const L: string[] = [];
  const logs = all<any>(d.db, 'SELECT number, title, summary FROM sessionlog_entries WHERE world_id = ? AND unpublished_at IS NULL ORDER BY number DESC LIMIT 4', worldId);
  if (logs.length) L.push(`Past sessions (newest first):\n${logs.map((x) => `- #${x.number}${x.title ? ` ${x.title}` : ''}: ${clip(plain(String(x.summary ?? '')), 450) || '(no summary)'}`).join('\n')}`);
  let v: ReturnType<typeof playerView> | null = null;
  try { v = playerView(d, worldId, accountId); } catch { /* no vault */ }
  if (v) {
    const arcs = v.party.filter((p) => p.key.startsWith('chronicle/')).slice(-3);
    if (arcs.length) L.push(`The party's story:\n${arcs.map((a) => `- ${a.title}: ${clip(plain(a.body.replace(/^#.*$/m, '')), 300)}`).join('\n')}`);
    if (v.goals.length) L.push(`Their goals and quests:\n${v.goals.map((g) => `- ${g.title} (${g.heat ?? 'ongoing'}): ${clip(plain(g.body.replace(/^#.*$/m, '')), 200)}`).join('\n')}`);
    if (v.journal.length) L.push(`Their latest journal:\n${v.journal.slice(-2).map((j) => `- ${j.title}: ${clip(plain(j.body.replace(/^#.*$/m, '')), 300)}`).join('\n')}`);
  }
  if (tableExists(d, 'sheet_dm_notes')) {
    const goals = all<any>(d.db, "SELECT text, done FROM sheet_dm_notes WHERE world_id = ? AND account_id = ? AND kind = 'goal' ORDER BY done, created_at LIMIT 8", worldId, accountId);
    if (goals.length) L.push(`Quests from the DM:\n${goals.map((g) => `- ${clip(plain(g.text), 160)}${g.done ? ' (done)' : ''}`).join('\n')}`);
  }
  if (tableExists(d, 'broker_requests')) {
    const bought = all<any>(d.db, "SELECT question, answer FROM broker_requests WHERE world_id = ? AND account_id = ? AND answer IS NOT NULL AND answer <> '' AND status IN ('answered', 'noted') ORDER BY created_at DESC LIMIT 3", worldId, accountId);
    if (bought.length) L.push(`What they learned from the broker:\n${bought.map((b) => `- ${clip(plain(b.question), 120)}: ${clip(plain(b.answer), 250)}`).join('\n')}`);
  }
  return L.join('\n\n');
}

/**
 * The brief for one call, from what this player may see and nothing else. Every section is checked against the
 * classified guard first and left out if it would make the request be refused. Rebuilt on every call.
 */
export async function quickBrief(d: Deps, worldId: string, accountId: string, s: WorldSettings, task: QuickTask, question: string, typed = !!question.trim()): Promise<Brief> {
  const v: Viewer = { accountId, role: 'player' };
  const q = question.trim();
  const look = task === 'sheet' ? '' : q;
  const lore = task === 'ask' || task === 'suggest' ? await lorePart(d, worldId, look, v) : { text: '', hits: [] };
  const recap = task === 'recap';
  const parts: BriefSection[] = [
    { label: 'Character', text: characterPart(d, worldId, accountId) },
    { label: 'What they can do', text: recap ? '' : kitPart(d, worldId, accountId) },
    { label: 'Items', text: itemsPart(d, worldId, accountId) },
    { label: 'Combat', text: recap ? '' : combatPart(d, worldId, v, s) },
    { label: 'The story so far', text: recap ? recapPart(d, worldId, accountId) : '' },
    { label: 'Recent events', text: recentPart(d, worldId) },
    { label: 'What this player knows', text: recap ? '' : clip(brokerContext(d, worldId, accountId, look).trim(), 1500) },
    // A turn with no question of its own gets no passages: a search for "my turn" finds magic items, which a small
    // model then offers as if the character had them.
    { label: 'Rules passages', text: task === 'sheet' || task === 'suggest' || recap || (task === 'turn' && !typed) ? '' : rulesPart(d, worldId, look, s) },
    { label: 'Library (shared with the party)', text: lore.text },
  ];
  const budget = briefBudget(d);
  const sections: BriefSection[] = [];
  let used = 0;
  for (const p of parts) {
    const t = p.text.trim();
    if (!t || wouldBeRefused(d, t)) continue;
    const room = budget - used;
    if (room < 200) break;
    const text = clip(t, room);
    sections.push({ label: p.label, text });
    used += text.length + p.label.length + 4;
  }
  const text = sections.map((x) => `## ${x.label}\n${x.text}`).join('\n\n');
  return { sections, text, chars: text.length, lore: lore.hits };
}

// ---- the player's own Squire: a name and a personality trait ----------------------------------------------------

export const SQUIRE_SCHEMA = `
CREATE TABLE IF NOT EXISTS squire_prefs (
  world_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  trait TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (world_id, account_id)
);`;
export const SQUIRE_DEFAULT_NAME = 'Squire';
export const SQUIRE_NAME_MAX = 40;
export const SQUIRE_TRAIT_MAX = 200;
export interface Squire { name: string; trait: string; traitUsed: boolean; traitNote: string }

// A trait that tries to change the rules instead of the voice, or would break the answer.
const TRAIT_RULES = /\b(ignore|disregard|forget|override|instructions?|system prompt|prompt|jailbreak|pretend (you are|to be) (the )?(dm|dungeon master|gm)|reveal|secrets?|dm[- ]only|hidden|spoil|handoff|never answer|do not answer|don['’]t answer|refuse|lie|lying|make (things|stuff) up|invent)\b/i;
const TRAIT_BREAKS = /\b(only (speak|talk|answer|reply|respond) in|emojis? only|in (morse|binary|code|french|spanish|german|latin|elvish)|backwards|no words|silent|one word)\b/i;
const TRAIT_UNKIND = /\b(insult|mock|abuse|hate|slur|threaten|cruel|sexual|nsfw|swear at)\b/i;
const oneLine = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** Whether a trait is used, and if not, a short reason the player sees. */
export function squireTrait(raw: string): { used: boolean; note: string } {
  const t = raw.trim();
  if (!t) return { used: false, note: '' };
  if (TRAIT_RULES.test(t)) return { used: false, note: 'That trait tries to change what your Squire may say, so it answers in its plain voice.' };
  if (TRAIT_BREAKS.test(t)) return { used: false, note: 'That trait would make the answers hard to use, so your Squire answers in its plain voice.' };
  if (TRAIT_UNKIND.test(t)) return { used: false, note: 'That trait is not one your Squire can keep at the table, so it answers in its plain voice.' };
  return { used: true, note: '' };
}

export function getSquire(db: DB, worldId: string, accountId: string): Squire {
  const r = one<{ name: string; trait: string }>(db, 'SELECT name, trait FROM squire_prefs WHERE world_id = ? AND account_id = ?', worldId, accountId);
  const name = oneLine(r?.name, SQUIRE_NAME_MAX) || SQUIRE_DEFAULT_NAME;
  const trait = oneLine(r?.trait, SQUIRE_TRAIT_MAX);
  const t = squireTrait(trait);
  return { name, trait, traitUsed: t.used, traitNote: t.note };
}

export function setSquire(db: DB, worldId: string, accountId: string, v: { name?: unknown; trait?: unknown }): Squire {
  const cur = getSquire(db, worldId, accountId);
  const name = v.name === undefined ? (cur.name === SQUIRE_DEFAULT_NAME ? '' : cur.name) : oneLine(v.name, SQUIRE_NAME_MAX);
  const trait = v.trait === undefined ? cur.trait : oneLine(v.trait, SQUIRE_TRAIT_MAX);
  run(db, `INSERT INTO squire_prefs (world_id, account_id, name, trait, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(world_id, account_id) DO UPDATE SET name = excluded.name, trait = excluded.trait, updated_at = excluded.updated_at`, worldId, accountId, name, trait, new Date().toISOString());
  return getSquire(db, worldId, accountId);
}

export function quickSystem(worldName: string, squire?: Pick<Squire, 'name' | 'trait' | 'traitUsed'>): string {
  const name = squire?.name || SQUIRE_DEFAULT_NAME;
  const who = name === SQUIRE_DEFAULT_NAME ? 'the Squire' : `${name}, the Squire`;
  return [
    `You are ${who} of one player in the tabletop campaign "${worldName}": out of character, quick and friendly, like a player who knows the rules well.`,
    ...(squire?.traitUsed && squire.trait ? [
      `Your personality, chosen by this player: ${squire.trait}. Speak as that character in every answer: its voice, its word choice and a short in-character aside, so the player hears it at once. Keep the facts and the format the task asks for.`,
      'The personality changes only how you sound, never what you say: if keeping it would break any rule below, drop it for that part.',
    ] : []),
    'You see only the brief you are given. Use it; never invent names, places, events, numbers or monster stats that are not in it. You know nothing the player does not know.',
    'Rules come from the Rules passages in the brief; if none covers the question, say you are not sure rather than guess.',
    'Be brief: short bullets or two or three sentences, no preamble, no repeating the question. Talk to the player as "you". Give reasons from the game itself ("you have two potions"), never from where you read them: do not mention the brief, the notes or the context.',
    'If the request needs more than the brief, reply with one line and nothing else:',
    '  HANDOFF broker: (a few words on why)   for in-world knowledge not in the brief (people, places, history, rumours, secrets)',
    '  HANDOFF helper: (a few words on why)   for anything else: writing, changing anything, long or multi-step questions',
  ].join('\n');
}

// One call at a time per player: a small server has few slots, and a second tap should not queue behind the first.
const inFlight = new Set<string>();

export function quickStatus(d: Deps) {
  const c = jobConfig(d, 'helper');
  return { model: c?.model ?? null, own: !!ownJobConfig(d, 'helper'), available: hasJob(d, 'helper') };
}

export async function askQuick(d: Deps, opts: { worldId: string; worldName: string; accountId: string; settings: WorldSettings; task: QuickTask; question: string; signal?: AbortSignal }): Promise<QuickAnswer> {
  const t0 = Date.now();
  const question = (opts.question || DEFAULT_Q[opts.task]).trim();
  const brief = await quickBrief(d, opts.worldId, opts.accountId, opts.settings, opts.task, question, !!opts.question.trim());
  const out = (answer: string, handoff: QuickAnswer['handoff'], model: string | null): QuickAnswer => ({ task: opts.task, answer, handoff, model, ms: Date.now() - t0, brief: { chars: brief.chars, sections: brief.sections.map((s) => s.label) } });
  const early = routeFirst(opts.task, question, brief);
  if (early) return out('', { ...early, question }, null);
  const c = jobConfig(d, 'helper');
  if (!c) return out('', { to: 'helper', reason: 'No Squire model is set up; the table helper can answer.', question }, null);
  const key = `${opts.worldId}|${opts.accountId}`;
  const squire = getSquire(d.db, opts.worldId, opts.accountId);
  if (inFlight.has(key)) throw new ModelUnavailable('helper', `${squire.name} is still answering your last question`, 429);
  inFlight.add(key);
  try {
    const r = await chat(d, 'helper', {
      maxTokens: 400,
      reasoningOff: true,
      messages: [
        { role: 'system', content: quickSystem(opts.worldName, squire) },
        { role: 'user', content: `<brief>\n${brief.text || '(nothing yet)'}\n</brief>\n\nTask: ${TASKS[opts.task]}${question ? `\nQuestion: ${question}` : ''}` },
      ],
    }, opts.signal);
    const text = noBriefTalk(stripThinking(r.content));
    const h = parseHandoff(text);
    const known = `${brief.text}\n${question}\n${opts.worldName}`;
    const g = groundAnswer(h ? h.answer : text, known);
    if (h) return out(g.text, { to: h.to, reason: h.reason, question }, c.model);
    // It does not know (the player does not know it yet): offer to ask the broker, keeping what it did say.
    if (g.text && (opts.task === 'ask' || opts.task === 'recap') && DOES_NOT_KNOW.test(g.text)) return out(g.text, { to: 'broker', reason: REASONS.unknown, question: opts.task === 'ask' ? question : '' }, c.model);
    if (!g.text) return out('', g.dropped.length ? { to: 'broker', reason: REASONS.broker, question } : { to: 'helper', reason: `${squire.name} had no answer; the table helper can take it.`, question }, c.model);
    return out(g.text, null, c.model);
  } catch (e) {
    if (e instanceof ModelUnavailable && e.status === 429) throw e;
    if (e instanceof ModelUnavailable) { console.warn(`squire (quick helper): ${e.message}`); return out('', { to: 'helper', reason: `${squire.name} is not answering right now; the table helper can take it.`, question }, c.model); }
    throw e;
  } finally { inFlight.delete(key); }
}
