// Cheap, deterministic reading of what the user typed, so most messages need
// no extra model round: which tools to offer (at most MAX_TOOLS), what to
// search the library for, and the commands that are answered by a rule with
// no model at all (rolling dice, the date, next turn, adding creatures).
import { randomInt } from 'node:crypto';

export const MAX_TOOLS = 8;
/** Offered for every message. */
export const CORE_TOOLS = ['search_library', 'read_page'];

interface Category { re: RegExp; tools: string[] }

// In the order they are tried; a message may match several. Each list is in order of usefulness.
const CATEGORIES: Category[] = [
  { re: /\b(stat ?blocks?|stats? for|monster|creature|cr \d|challenge rating)\b/i, tools: ['make_statblock', 'lookup_term', 'read_term', 'add_combatant'] },
  { re: /\b(combat|initiative|turn|round|fight|battle|damage|damaged|hit|hits|heal|heals|healed|hp|hit points|condition|prone|poisoned|stunned|grappled|frightened|encounter|attack|add \d|goblins?|orcs?|kobolds?|skeletons?|zombies?|wolf|wolves|bandits?|cultists?)\b/i, tools: ['get_combat', 'add_combatant', 'damage_combatant', 'heal_combatant', 'next_turn', 'set_conditions'] },
  { re: /\b(rules?|spell|spells|how (does|do|many|much)|dc \d|advantage|disadvantage|grapple|opportunity attack|saving throw|cast|concentration|cover|rest rules?|feat|class feature)\b/i, tools: ['lookup_rule', 'lookup_term', 'read_term'] },
  { re: /\b(session|last (time|session|game)|recap|transcript|happened|said|told|heard|remember|earlier|yesterday|we (met|found|fought|saw|decided))\b/i, tools: ['search_transcript', 'list_session_log'] },
  { re: /\b(pages?|save|write|draft|create|make a note|note|lore|wiki|library|folder|rewrite|edit|update|summari[sz]e|summary|outline)\b/i, tools: ['save_page', 'list_pages', 'list_relations'] },
  { re: /\b(npc|people|person|quote|quotes|talk(ed)? to|met)\b/i, tools: ['list_people', 'add_person', 'add_quote'] },
  { re: /\b(items?|loot|gold|coins?|copper|silver|platinum|inventory|pouch|purse|give|gave|buy|sell|price|treasure)\b/i, tools: ['get_inventory', 'add_item', 'add_coin', 'list_transfers'] },
  { re: /\b(date|time|day|days|week|month|calendar|clock|long rest|short rest|rest|dawn|dusk|midnight|holiday|festival|deadline)\b/i, tools: ['get_world_date', 'advance_world_time', 'list_world_events', 'add_world_event'] },
  { re: /\b(broker|offer|offers|information for sale|rumou?rs?)\b/i, tools: ['list_broker_requests', 'list_broker_offers', 'ask_broker_quote', 'send_broker_offer', 'add_broker_note', 'broker_answer'] },
  { re: /\b(requests?|approve|approvals?|change request|reject)\b/i, tools: ['list_requests', 'decide_request'] },
  { re: /\b(game night|schedule|rsvp|next game|real[- ]life)\b/i, tools: ['list_calendar', 'schedule_session'] },
  { re: /\b(quick event|recall check|vote|poll|reaction|twist|saving throw for the party)\b/i, tools: ['send_quick_event'] },
  { re: /\b(who is in|players|party members|character|characters|members)\b/i, tools: ['list_members', 'get_live'] },
];
const DEFAULTS = ['search_transcript', 'list_pages', 'lookup_rule', 'get_world_date', 'list_people', 'get_live'];

/**
 * At most MAX_TOOLS tool names for this message, from the ones a harness may use
 * (`available`). search_library and read_page are always in. A tool that is
 * not offered but exists is still run if the model asks for it.
 */
export function selectTools(text: string, available: string[], max = MAX_TOOLS): string[] {
  const have = new Set(available);
  const out: string[] = [];
  const add = (n: string) => { if (have.has(n) && !out.includes(n)) out.push(n); };
  for (const n of CORE_TOOLS) add(n);
  let matched = false;
  for (const c of CATEGORIES) if (c.re.test(text)) { matched = true; for (const n of c.tools) add(n); }
  // Combat words are common in plain questions ("what turn is it"): the combat list leaves room for the others.
  if (!matched || out.length < max) for (const n of DEFAULTS) add(n);
  return out.slice(0, max);
}

const STOP = new Set(('a an the and or of to in on at for with from by about is are was were be been am do does did can could would should will what whats who whom whose which when where why how that this these those there their them they it its you your yours we our us i me my mine he she his her him not no yes please tell show give find any some all more most much many also just like need want know really very into out up down over than then so if as but have has had get got say said says make made tell told ask asked remind explain describe list summari[sz]e').split(/\s+/));

/** The words worth searching the library for, longest first (more specific words rank better). */
export function searchTerms(text: string, max = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of text.toLowerCase().replace(/[’]/g, "'").match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (w.length < 3 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  // Keep the order they were typed in, but only the most specific few.
  const keep = new Set([...out].sort((a, b) => b.length - a.length).slice(0, max));
  return out.filter((w) => keep.has(w));
}

// ---- commands with no model ------------------------------------------------

export interface Roll { notation: string; parts: { sign: 1 | -1; count: number; sides: number; rolls: number[] }[]; modifier: number; total: number; text: string }

/** Roll dice like 2d6+3 or d20-1 or 1d8+1d4+2. Returns null if it is not dice notation or is absurd. */
export function rollDice(notation: string, rng: (n: number) => number = (n) => randomInt(1, n + 1)): Roll | null {
  const src = notation.replace(/\s+/g, '').toLowerCase();
  const tokens = src.match(/[+-]?[^+-]+/g);
  if (!tokens || tokens.join('') !== src) return null;
  const parts: Roll['parts'] = [];
  let modifier = 0;
  let dice = 0;
  for (const tok of tokens) {
    const sign: 1 | -1 = tok.startsWith('-') ? -1 : 1;
    const body = tok.replace(/^[+-]/, '');
    let m: RegExpMatchArray | null;
    if ((m = body.match(/^(\d*)d(\d+)$/))) {
      const count = m[1] === '' ? 1 : Number(m[1]);
      const sides = Number(m[2]);
      if (count < 1 || count > 100 || sides < 2 || sides > 1000) return null;
      dice += count;
      if (dice > 200) return null;
      parts.push({ sign, count, sides, rolls: Array.from({ length: count }, () => rng(sides)) });
    } else if (/^\d{1,6}$/.test(body)) modifier += sign * Number(body);
    else return null;
  }
  if (!parts.length) return null;
  const total = parts.reduce((s, p) => s + p.sign * p.rolls.reduce((a, b) => a + b, 0), 0) + modifier;
  const shown = parts.map((p, i) => `${i ? (p.sign < 0 ? '- ' : '+ ') : p.sign < 0 ? '-' : ''}${p.rolls.length > 1 ? `(${p.rolls.join(' + ')})` : p.rolls[0]}`).join(' ');
  const mod = modifier ? ` ${modifier < 0 ? '-' : '+'} ${Math.abs(modifier)}` : '';
  return { notation: src, parts, modifier, total, text: `**${src}**: ${shown}${mod} = **${total}**` };
}

export type FastPlan =
  | { kind: 'reply'; text: string; what: string }
  | { kind: 'date'; what: string }
  | { kind: 'calls'; calls: { tool: string; args: Record<string, unknown> }[]; intro: string; what: string }
  | { kind: 'combat'; verb: 'damage' | 'heal' | 'who'; target?: string; amount?: number; what: string };

const clean = (s: string) => s.trim().replace(/^(hey|ok|okay|so)[,\s]+/i, '').replace(/^(please|pls|can you|could you|would you)\s+/i, '').replace(/\s*(please|pls|thanks|thank you)?[.!?]*\s*$/i, '').trim();

const NOT_CREATURE = /\b(page|note|notes|item|items|person|people|npc|quote|coin|coins|gold|silver|copper|session|event|offer|request|to the (library|party|inventory)|about|for the|that|which|who)\b/i;
const singular = (w: string) => (/ies$/i.test(w) ? w.replace(/ies$/i, 'y') : /(ses|xes|ches|shes)$/i.test(w) ? w.replace(/es$/i, '') : /[^s]s$/i.test(w) ? w.replace(/s$/i, '') : w);
const title = (w: string) => w.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/**
 * A command that needs no model: rolling dice, the date, next turn, adding
 * creatures, "who's up", damage and healing by name. Null if it is something
 * else (and the model should answer). Writes are only planned here: the agent
 * still asks the DM to confirm them. `dm` is false for a player, who only
 * gets dice and the date.
 */
export function fastPlan(raw: string, dm: boolean, rng: (n: number) => number = (n) => randomInt(1, n + 1)): FastPlan | null {
  if (raw.length > 120) return null;
  const t = clean(raw);
  let m: RegExpMatchArray | null;

  if ((m = t.match(/^(?:roll|r|throw)\s+(?:me\s+)?(?:a\s+|an\s+)?(.+)$/i))) {
    let spec = m[1].replace(/^(dice|the dice)\s+/i, '');
    const adv = /\b(with )?(advantage|adv)\b/i.test(spec) ? 'adv' : /\b(with )?(disadvantage|dis)\b/i.test(spec) ? 'dis' : '';
    spec = spec.replace(/\b(with )?(advantage|adv|disadvantage|dis)\b/gi, '').trim();
    if (adv) {
      const base = spec.match(/^d20\s*([+-]\s*\d+)?$/i);
      if (!base) return null;
      const a = rng(20), b = rng(20);
      const mod = base[1] ? Number(base[1].replace(/\s+/g, '')) : 0;
      const pick = adv === 'adv' ? Math.max(a, b) : Math.min(a, b);
      return { kind: 'reply', what: 'roll', text: `**d20 with ${adv === 'adv' ? 'advantage' : 'disadvantage'}**: ${a}, ${b} → ${pick}${mod ? ` ${mod < 0 ? '-' : '+'} ${Math.abs(mod)}` : ''} = **${pick + mod}**` };
    }
    const r = rollDice(spec, rng);
    return r ? { kind: 'reply', what: 'roll', text: r.text } : null;
  }
  // A bare "2d6+3" is a roll too.
  if (/^\d*d\d+(\s*[+-]\s*(\d*d\d+|\d+))*$/i.test(t)) { const r = rollDice(t, rng); return r ? { kind: 'reply', what: 'roll', text: r.text } : null; }

  if (/^(what('?s| is| was)?|tell me|show me|whats)\s+(the\s+)?(current\s+|today'?s\s+)?(in[- ]game\s+|world\s+|game\s+)?(date|time|day)(\s+(today|now|is it|is it now))?$/i.test(t) || /^what\s+(day|date|time)\s+is\s+it(\s+now)?$/i.test(t)) return { kind: 'date', what: 'date' };

  if (!dm) return null;

  if (/^(next(\s+turn)?|end(\s+the)?\s+turn|next up|advance(\s+the)?\s+(turn|initiative)|go to the next (turn|creature|combatant))$/i.test(t)) return { kind: 'calls', what: 'next_turn', intro: 'Moving to the next turn.', calls: [{ tool: 'next_turn', args: {} }] };
  if (/^(who'?s|who is|whose)\s+(up|next|turn)(\s+(is it|now|next))?$/i.test(t) || /^whose turn( is it)?$/i.test(t)) return { kind: 'combat', verb: 'who', what: 'whose_turn' };

  if ((m = t.match(/^(?:damage|hit|hurt|deal)\s+(.+?)\s+(?:for|by|with)\s+(\d{1,4})(?:\s*(?:damage|hp|points?))?$/i)) || (m = t.match(/^(.+?)\s+takes?\s+(\d{1,4})(?:\s*(?:damage|hp))?$/i))) return { kind: 'combat', verb: 'damage', target: m[1], amount: Number(m[2]), what: 'damage' };
  if ((m = t.match(/^heal\s+(.+?)\s+(?:for|by)?\s*(\d{1,4})(?:\s*(?:hp|points?))?$/i))) return { kind: 'combat', verb: 'heal', target: m[1], amount: Number(m[2]), what: 'heal' };

  // "add 1d4 goblins", "add 3 orcs to combat", "add a goblin to initiative"
  if ((m = t.match(/^add\s+(\d*d\d+(?:\s*[+-]\s*\d+)?|\d{1,2}|an?)\s+([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,2}?)(?:\s+to\s+(?:the\s+)?(?:combat|initiative|fight|battle|encounter|tracker))?$/iu))) {
    const toCombat = /\bto\s+(?:the\s+)?(?:combat|initiative|fight|battle|encounter|tracker)$/i.test(t);
    const noun = m[2].trim();
    if (NOT_CREATURE.test(noun)) return null;
    if (/^an?$/i.test(m[1]) && !toCombat) return null;
    let n = 1;
    let rolled = '';
    if (/d/i.test(m[1])) { const r = rollDice(m[1], rng); if (!r || r.total < 1) return null; n = r.total; rolled = ` (rolled ${r.notation}: ${r.parts.flatMap((p) => p.rolls).join(', ')}${r.modifier ? ` ${r.modifier > 0 ? '+' : '-'} ${Math.abs(r.modifier)}` : ''})`; }
    else if (!/^an?$/i.test(m[1])) n = Number(m[1]);
    if (n < 1 || n > 20) return null;
    const base = title(n === 1 ? singular(noun) : singular(noun));
    const calls = Array.from({ length: n }, (_, i) => ({ tool: 'add_combatant', args: { name: n === 1 ? base : `${base} ${i + 1}`, initiative: rng(20) } }));
    return { kind: 'calls', what: 'add_combatants', calls, intro: `Adding ${n} ${base}${n === 1 ? '' : 's'}${rolled}, each with a rolled d20 initiative. I don't know their HP: tell me, or ask me to make a statblock for them.` };
  }
  return null;
}

/** "Goblin 3" -> the combatant it names, if exactly one does. */
export function matchCombatant<T extends { id: string; name: string }>(list: T[], name: string): T | null {
  const n = name.trim().toLowerCase().replace(/^the\s+/, '');
  if (!n) return null;
  const exact = list.filter((c) => c.name.toLowerCase() === n);
  if (exact.length === 1) return exact[0];
  const starts = list.filter((c) => c.name.toLowerCase().startsWith(n));
  if (starts.length === 1) return starts[0];
  const has = list.filter((c) => c.name.toLowerCase().includes(n));
  return has.length === 1 ? has[0] : null;
}
