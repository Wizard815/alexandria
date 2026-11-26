// The players' quick helper: a small second model (4B or less, or a ternary
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
// It does narrow jobs: a rules lookup, options for this turn, a summary of the
// sheet and notes, and what to do next. Anything bigger (world lore that is
// not in the brief, writing, a change to anything, a long question) is handed
// off: to the broker for in-world knowledge, or to the table helper (the
// player harness on the main model, with tools) for everything else.
import type { Deps } from '../../app.ts';
import { chat, hasJob, jobConfig, ownJobConfig, wouldBeRefused, ModelUnavailable } from '../../core/ai.ts';
import { all, one } from '../../core/db.ts';
import { combatViewFor } from '../../core/combatView.ts';
import type { Viewer, WorldSettings } from '../../core/policy.ts';
import { parseJson } from '../../core/util.ts';
import { latestSummary } from '../audio/summary.ts';
import { liveLines } from '../minerva/live.ts';
import { brokerContext } from '../minerva/player.ts';
import { searchRules } from '../modules/search.ts';
import { playerCard } from '../modules/hide.ts';
import { hybridPages } from '../search/embeddings.ts';

export const QUICK_TASKS = ['ask', 'rules', 'turn', 'sheet', 'suggest'] as const;
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
  turn: 'List 3 to 5 options for this character\'s turn right now, one line each, using their health, conditions, items and the combat as shown. Use the actions anyone has (Attack, Dash, Disengage, Dodge, Help, Hide, Ready, Use an Object, moving) and what their items allow; no spells or class features unless the brief names them. Then say in one line which you would pick and why.',
  sheet: 'Sum up this character in 4 to 6 short bullets: health and conditions, what they carry that matters, their goals, and what is going on for them right now.',
  suggest: 'Suggest 3 things this character could do next, one line each, grounded in what just happened and their goals. Only use people, places and things named in the brief. Do not decide for them.',
};

/** The question a task stands for when the player typed none. */
const DEFAULT_Q: Record<QuickTask, string> = {
  ask: '', rules: '', turn: 'What can I do on my turn?', sheet: 'Sum up my character.', suggest: 'What should I do next?',
};

// Questions that need more than a small model with a short brief.
const IN_WORLD = /\b(who\b(?:\s+\w+)?\s+(is|was|are|were|rules|runs|leads|controls|owns|killed|sent|hired)|what happened (to|at|in)|history of|tell me (about|more)|where (is|are|was|were|can i find)|why (did|does|is|are|was|were)|rumou?rs?|legends? of|secrets?|secretly)\b/i;
// ... unless it is about the fight or the rules ("who is next in initiative?").
const TABLE_TALK = /\b(initiative|my turn|next turn|round|combat|fight|hp|hit points|spell|action|attack|advantage|disadvantage|condition)\b/i;
const WRITING = /\b(write|draft|compose|rewrite|journal entry|backstory|poem|song|letter|speech)\b/i;
const CHANGES = /\b(add|remove|delete|give|send|buy|sell|update|change|set|record|save|log)\b.{0,30}\b(my|the|to|from|item|items|inventory|journal|goal|hp|coin|gold)\b/i;
const MAX_QUESTION = 400;
const REASONS: Record<HandoffTo, string> = {
  broker: 'That is in-world knowledge; ask the broker.',
  helper: 'The table helper can take this one.',
};

/** Where a question goes before any model is asked, or null for the quick helper. */
export function routeFirst(task: QuickTask, question: string, brief: Brief): { to: HandoffTo; reason: string } | null {
  const q = question.trim();
  if (q.length > MAX_QUESTION) return { to: 'helper', reason: 'That is a long question; the table helper can take it.' };
  if (task === 'ask' || task === 'rules') {
    if (WRITING.test(q)) return { to: 'helper', reason: 'Writing is a job for the table helper.' };
    if (CHANGES.test(q)) return { to: 'helper', reason: 'The quick helper cannot change anything; the table helper can propose it.' };
    // Who, why, history, rumours: the broker's trade, with its own secret checks. A small model asked this
    // with a page or two in front of it fills the gaps with names of its own (seen with 3-4B models).
    if (task === 'ask' && IN_WORLD.test(q) && !TABLE_TALK.test(q)) return { to: 'broker', reason: REASONS.broker };
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

/**
 * The brief for one call, from what this player may see and nothing else. Every section is checked against the
 * classified guard first and left out if it would make the request be refused. Rebuilt on every call.
 */
export async function quickBrief(d: Deps, worldId: string, accountId: string, s: WorldSettings, task: QuickTask, question: string, typed = !!question.trim()): Promise<Brief> {
  const v: Viewer = { accountId, role: 'player' };
  const q = question.trim();
  const look = task === 'sheet' ? '' : q;
  const lore = task === 'ask' || task === 'suggest' ? await lorePart(d, worldId, look, v) : { text: '', hits: [] };
  const parts: BriefSection[] = [
    { label: 'Character', text: characterPart(d, worldId, accountId) },
    { label: 'Items', text: itemsPart(d, worldId, accountId) },
    { label: 'Combat', text: combatPart(d, worldId, v, s) },
    { label: 'Recent events', text: recentPart(d, worldId) },
    { label: 'What this player knows', text: clip(brokerContext(d, worldId, accountId, look).trim(), 1500) },
    // A turn with no question of its own gets no passages: a search for "my turn" finds magic items, which a small
    // model then offers as if the character had them.
    { label: 'Rules passages', text: task === 'sheet' || task === 'suggest' || (task === 'turn' && !typed) ? '' : rulesPart(d, worldId, look, s) },
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

export function quickSystem(worldName: string): string {
  return [
    `You are the quick helper of one player in the tabletop campaign "${worldName}": out of character, quick and friendly, like a player who knows the rules well.`,
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
  if (!c) return out('', { to: 'helper', reason: 'No quick helper model is set up; the table helper can answer.', question }, null);
  const key = `${opts.worldId}|${opts.accountId}`;
  if (inFlight.has(key)) throw new ModelUnavailable('helper', 'The quick helper is still answering your last question', 429);
  inFlight.add(key);
  try {
    const r = await chat(d, 'helper', {
      maxTokens: 400,
      reasoningOff: true,
      messages: [
        { role: 'system', content: quickSystem(opts.worldName) },
        { role: 'user', content: `<brief>\n${brief.text || '(nothing yet)'}\n</brief>\n\nTask: ${TASKS[opts.task]}${question ? `\nQuestion: ${question}` : ''}` },
      ],
    }, opts.signal);
    const text = stripThinking(r.content);
    const h = parseHandoff(text);
    const known = `${brief.text}\n${question}\n${opts.worldName}`;
    const g = groundAnswer(h ? h.answer : text, known);
    if (h) return out(g.text, { to: h.to, reason: h.reason, question }, c.model);
    if (!g.text) return out('', g.dropped.length ? { to: 'broker', reason: REASONS.broker, question } : { to: 'helper', reason: 'The quick helper had no answer; the table helper can take it.', question }, c.model);
    return out(g.text, null, c.model);
  } catch (e) {
    if (e instanceof ModelUnavailable && e.status === 429) throw e;
    if (e instanceof ModelUnavailable) return out('', { to: 'helper', reason: 'The quick helper is not answering right now; the table helper can take it.', question }, c.model);
    throw e;
  } finally { inFlight.delete(key); }
}
