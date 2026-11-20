// Active mode, layer two: an intent becomes a candidate (tool calls, who sees
// the effect, how long to wait before the same thing may fire again) or
// nothing. Safety lives here: stage cards only ever show pages players can
// open, and a DM-aside line only gets the categories listed in ASIDE_OK.
import type { Deps } from '../../app.ts';
import { pageView } from '../stage/cards.ts';
import { norm, SKILLS, type Category, type CueCtx, type Scored } from './cues.ts';

const SKILL_RE = new RegExp(`^(?:${SKILLS}|initiative)$`, 'i');
/**
 * Is this a thing a character can carry? Rules and the model both propose items from table talk, and
 * real sessions gave "Strength Score Of 20", "Plus Four", "Resistance", "Going" and long garbled phrases.
 */
export function itemName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (n.length < 2 || n.length > 40) return false;
  const words = n.split(/\s+/);
  if (words.length > 5) return false;
  if (words.filter((w) => /^(of|the|on|to|for|in|at|with|and|from)$/.test(w)).length > 1) return false;
  if (/\d+$/.test(n) || /^plus \w+$/.test(n)) return false;
  if (words.length === 1 && /ing$/.test(n)) return false;
  return !/\b(score|check|save|saving throw|bonus|modifier|advantage|disadvantage|resistance|immunity|vulnerability|health|hp|hit points?|damage|inspiration|proficiency|initiative|turn|action|reaction|re-?roll|level|xp|experience|spell slots?|armor class|ac|credit|chance|try|moment|break|hug|ride|call|number|idea|thought|time|point|points|life|luck|reach|speed|stat|stats)\b/.test(n);
}
import { dexModifier, findMonster } from '../modules/search.ts';

/** HP, AC and the Dexterity modifier (for initiative) from the rules module's statblock for a creature named exactly (or by an alias), else nothing. */
export function statsFor(d: Deps, worldId: string, name: string): { hp?: number; maxHp?: number; ac?: number; dexMod?: number } {
  try {
    const t = findMonster(d.db, worldId, name);
    if (!t) return {};
    const hp = /\bHP (\d+)/.exec(t.summary ?? '')?.[1]; const ac = /\bAC (\d+)/.exec(t.summary ?? '')?.[1];
    const dex = dexModifier(t);
    return { ...(hp ? { hp: Number(hp), maxHp: Number(hp) } : {}), ...(ac ? { ac: Number(ac) } : {}), ...(dex !== null ? { dexMod: dex } : {}) };
  } catch { return {}; }
}

/** 2160 -> "1 day 12 hours", 90 -> "1 hour 30 min": exact, so the DM approves what will happen. */
export function spanText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), r = m % 60;
  const part = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : '');
  return [part(d, 'day', 'days'), part(h, 'hour', 'hours'), part(r, 'min', 'min')].filter(Boolean).join(' ') || '0 min';
}

export interface Call { tool: string; args: Record<string, any> }
export interface Candidate {
  category: Category; calls: Call[]; summary: string; confidence: number; cue: string; ruleKey: string;
  visible: 'dm' | 'table' | 'players'; dedupeKey: string; dedupeMs: number;
  /** A player's own words: never run without the DM's tap. */
  playerSource?: boolean;
  /** Always a confirm card, whatever the setting. */
  forceAsk?: boolean;
  source: 'rules' | 'model';
  /** What is still unsure (the model may settle it). */
  borderline?: boolean;
  /** Intent kind, for the model to check. */
  kind: string;
}

/** Categories a DM-aside line may set off: only things on the DM's side. */
export const ASIDE_OK: ReadonlySet<Category> = new Set<Category>(['music', 'combat']);

const stable = (o: unknown): string => JSON.stringify(o, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'for', 'in', 'on', 'at', 'with', 'them', 'this', 'that', 'their', 'it', 'map', 'picture', 'image', 'handout', 'page', 'note', 'letter', 'scroll', 'drawing', 'sketch']);
const toks = (s: string) => norm(s).replace(/[^\p{L}\p{N} ]/gu, ' ').split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
const GENERIC = new Set(['map', 'picture', 'image', 'handout', 'page', 'note', 'letter', 'scroll', 'drawing', 'sketch', 'poster']);

/** The page a phrase names, among the pages players may open. Null when none, or when two fit equally well. */
export function matchPage(ctx: CueCtx, phrase: string): { id: string; title: string; score: number; ambiguous: boolean } | null {
  const want = toks(phrase);
  const hasKind = new RegExp(`\\b(${[...GENERIC].join('|')})\\b`).test(norm(phrase));
  if (!want.length) return null;
  const scored = ctx.pages.map((p) => {
    const have = new Set(toks(`${p.title} ${p.path ?? ''}`));
    const titleToks = new Set(toks(p.title));
    const wantSet = new Set(want);
    const near = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
    const hit = want.filter((t) => [...have].some((h) => near(h, t))).length;
    const titleHit = [...titleToks].filter((h) => [...wantSet].some((t) => near(h, t))).length;
    const cover = titleToks.size ? titleHit / titleToks.size : 0;
    const titleKind = new RegExp(`\\b(${[...GENERIC].join('|')})\\b`).test(norm(p.title));
    // Either the phrase is mostly the page's name, or the page's name is mostly in the phrase (the DM talks around it).
    const score = Math.max(hit / want.length, titleHit >= Math.min(2, titleToks.size) ? cover : 0) + (hasKind && titleKind ? 0.1 : 0);
    return { p, score };
  }).filter((x) => x.score >= 0.6).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  return { id: scored[0].p.id, title: scored[0].p.title, score: scored[0].score, ambiguous: scored.length > 1 && scored[1].score >= scored[0].score - 0.05 };
}

const cp = (n: number) => { const g = Math.floor(n / 100), s = Math.floor((n % 100) / 10), c = n % 10; return [g && `${g} gp`, s && `${s} sp`, c && `${c} cp`].filter(Boolean).join(' ') || '0 cp'; };
const list = (a: string[]) => a.join(', ');

export function build(d: Deps, worldId: string, ctx: CueCtx, it: Scored, cue: string): Candidate | null {
  const base = { cue: cue.slice(0, 200), confidence: it.confidence, source: 'rules' as const, kind: it.kind };
  const rk = (x: string) => `${it.kind}:${norm(x).replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 40)}`;
  const combatant = (id: string) => ctx.combat.combatants.find((c) => c.id === id);
  switch (it.kind) {
    case 'music':
      if (it.stop) return { ...base, category: 'music', calls: [{ tool: 'stop_music', args: {} }], summary: 'Stop the music', ruleKey: rk('stop music'), visible: 'table', dedupeKey: 'music:stop', dedupeMs: 20_000 };
      if (!it.mood) return null;
      return { ...base, category: 'music', calls: [{ tool: 'play_music', args: { mood: it.mood } }], summary: `Play ${it.mood} music`, ruleKey: rk(`music ${it.mood}`), visible: 'table', dedupeKey: `music:${it.mood}`, dedupeMs: 10_000 };
    case 'ambience':
      if (it.stop || !it.layers.length) return { ...base, category: 'music', calls: [{ tool: 'play_ambience', args: {} }], summary: 'Stop the ambience', ruleKey: rk('ambience stop'), visible: 'table', dedupeKey: 'amb:stop', dedupeMs: 60_000 };
      return { ...base, category: 'music', calls: [{ tool: 'play_ambience', args: { layers: it.layers.map((kind) => ({ kind, volume: 0.5 })) } }], summary: `Ambience: ${list(it.layers)}`, ruleKey: rk(`ambience ${it.layers.join(' ')}`), visible: 'table', dedupeKey: `amb:${it.layers.join('+')}`, dedupeMs: 10_000 };
    case 'sfx':
      return { ...base, category: 'sfx', calls: [{ tool: 'play_sfx', args: { name: it.name } }], summary: `Sound effect: ${it.name}`, ruleKey: rk(`sfx ${it.name}`), visible: 'table', dedupeKey: `sfx:${norm(it.name)}`, dedupeMs: 25_000 };
    case 'stage': {
      if (it.text) {
        return { ...base, category: 'stage', calls: [{ tool: 'show_on_stage', args: { kind: 'text', title: it.title ?? 'A note', text: it.text } }], summary: `Show the players "${(it.title ?? 'a note')}"`, ruleKey: rk('stage text'), visible: 'players', dedupeKey: `stage:text:${norm(it.text).slice(0, 40)}`, dedupeMs: 60_000 };
      }
      const pg = matchPage(ctx, it.phrase);
      if (!pg) return null;
      // Fail closed: the page must open for a player right now.
      if (!pageView(d, worldId, pg.id)) return null;
      return { ...base, category: 'stage', confidence: pg.ambiguous ? Math.min(it.confidence, 0.6) : Math.max(it.confidence, pg.score >= 0.99 ? 0.85 : it.confidence), borderline: pg.ambiguous || pg.score < 0.99, calls: [{ tool: 'show_on_stage', args: { kind: 'place', ref: pg.id, title: pg.title } }], summary: `Show the players "${pg.title}"`, ruleKey: rk(`stage ${pg.title}`), visible: 'players', dedupeKey: `stage:${pg.id}`, dedupeMs: 90_000 };
    }
    case 'event': {
      // A roll the table can make: a skill, an ability or initiative ("D4 check" is a die, not a check).
      if (!SKILL_RE.test(it.skill.trim())) return null;
      const skill = it.skill.replace(/^(\w)/, (c) => c.toUpperCase());
      const title = `${skill} ${it.save ? 'save' : 'check'}${it.dc ? ` (DC ${it.dc})` : ''}`;
      return { ...base, category: 'events', calls: [{ tool: 'send_quick_event', args: { kind: it.save ? 'save' : 'notice', title, prompt: `Roll ${/^[aeiou]/i.test(skill) ? 'an' : 'a'} ${skill} ${it.save ? 'save' : 'check'}.`, skill, ...(it.dc ? { dc: it.dc } : {}) } }], summary: `Ask the table for ${/^[aeiou]/i.test(title) ? 'an' : 'a'} ${title}`, ruleKey: rk(`event ${it.skill}`), visible: 'players', dedupeKey: `event:${norm(it.skill)}:${it.dc ?? ''}`, dedupeMs: 30_000 };
    }
    case 'combat_start':
      if (it.ask) return { ...base, category: 'combat', calls: [{ tool: 'set_combat', args: { active: true } }], summary: 'This sounds like a fight: start the combat tracker?', ruleKey: rk('combat underway'), visible: 'players', dedupeKey: 'combat:underway', dedupeMs: 600_000, forceAsk: true };
      return { ...base, category: 'combat', calls: [{ tool: 'set_combat', args: { active: true } }], summary: 'Start combat', ruleKey: rk('combat start'), visible: 'players', dedupeKey: 'combat:start', dedupeMs: 30_000 };
    case 'combat_end':
      return { ...base, category: 'combat', calls: [{ tool: 'set_combat', args: { active: false } }], summary: 'End combat', ruleKey: rk('combat end'), visible: 'players', dedupeKey: 'combat:end', dedupeMs: 30_000 };
    case 'next_turn':
      return { ...base, category: 'combat', calls: [{ tool: 'next_turn', args: {} }], summary: 'Next turn', ruleKey: rk('next turn'), visible: 'players', dedupeKey: 'combat:next', dedupeMs: 4_000 };
    case 'damage':
    case 'heal': {
      const ids = it.ids;
      if (!ids.length) return null;
      if (ids.length === 1 && !combatant(ids[0])) return null;
      const names = ids.map((i) => combatant(i)?.name ?? '?');
      const tool = it.kind === 'damage' ? 'damage_combatant' : 'heal_combatant';
      return { ...base, category: 'combat', borderline: ids.length > 1 && it.confidence < 0.8, calls: ids.map((c) => ({ tool, args: { combatant: c, amount: it.amount } })), summary: `${it.kind === 'damage' ? `${it.amount} damage to` : `Heal ${it.amount} for`} ${list(names)}`, ruleKey: rk(`${it.kind} ${names[0]}`), visible: 'players', dedupeKey: `${it.kind}:${ids.join(',')}:${it.amount}`, dedupeMs: 15_000 };
    }
    case 'condition': {
      const c = combatant(it.id);
      if (!c) return null;
      const have = c.effects.map(String);
      // Bare names keep any timer the creature's condition already has (the server matches by name); new ones may carry their own.
      const timed = (a: string) => (it.until ? { name: a, [it.until === 'end' ? 'untilEndOf' : 'untilStartOf']: c.id } : it.rounds ? { name: a, rounds: it.rounds } : a);
      const next = [...have.filter((e) => !it.remove.some((r) => norm(r) === norm(e)) && !it.add.some((a) => norm(a) === norm(e))), ...it.add.map(timed)];
      if (!it.until && !it.rounds && stable(next.map((e) => norm(String(e))).sort()) === stable(have.map(norm).sort())) return null;
      return { ...base, category: 'combat', calls: [{ tool: 'set_conditions', args: { combatant: c.id, conditions: next } }], summary: `${c.name}: ${it.add.length ? `now ${list(it.add)}` : `no longer ${list(it.remove)}`}`, ruleKey: rk(`condition ${c.name} ${it.add.concat(it.remove).join(' ')}`), visible: 'players', dedupeKey: `cond:${c.id}:${next.map((e) => norm(typeof e === "string" ? e : JSON.stringify(e))).sort().join("+")}`, dedupeMs: 20_000 };
    }
    case 'temp_hp': {
      if (!it.ids.length || it.ids.some((i) => !combatant(i))) return null;
      const names = it.ids.map((i) => combatant(i)!.name);
      return { ...base, category: 'combat', calls: it.ids.map((c) => ({ tool: 'give_temp_hp', args: { combatant: c, amount: it.amount } })), summary: `${it.amount} temporary HP for ${list(names)}`, ruleKey: rk(`temp ${names[0]}`), visible: 'players', dedupeKey: `temp:${it.ids.join(',')}:${it.amount}`, dedupeMs: 15_000 };
    }
    case 'concentration': {
      const c = combatant(it.id);
      if (!c) return null;
      const cur = c.concentration;
      if (it.action === 'start') return { ...base, category: 'combat', calls: [{ tool: 'set_concentration', args: { combatant: c.id, spell: it.spell } }], summary: `${c.name} concentrates on ${it.spell}`, ruleKey: rk(`conc ${c.name} ${it.spell}`), visible: 'players', dedupeKey: `conc:${c.id}:${norm(it.spell ?? '')}`, dedupeMs: 20_000 };
      if (!cur) return null; // nothing to lose or keep
      // A pending save is settled; otherwise losing it just clears it.
      if (it.action === 'pass') return cur.dc === null ? null : { ...base, category: 'combat', calls: [{ tool: 'concentration_save', args: { combatant: c.id, result: 'pass' } }], summary: `${c.name} keeps concentration on ${cur.spell}`, ruleKey: rk(`conc pass ${c.name}`), visible: 'players', dedupeKey: `concpass:${c.id}`, dedupeMs: 20_000 };
      return { ...base, category: 'combat', calls: [cur.dc === null ? { tool: 'set_concentration', args: { combatant: c.id } } : { tool: 'concentration_save', args: { combatant: c.id, result: 'fail' } }], summary: `${c.name} loses concentration on ${cur.spell}`, ruleKey: rk(`conc lose ${c.name}`), visible: 'players', dedupeKey: `conclose:${c.id}`, dedupeMs: 20_000 };
    }
    case 'death_save': {
      const c = combatant(it.id);
      // Only a player character who is down (HP known and 0) rolls death saves.
      if (!c || !c.isPc || c.hp === null || c.hp === undefined || c.hp > 0) return null;
      return { ...base, category: 'combat', calls: [{ tool: 'death_save', args: { combatant: c.id, ...(it.roll !== undefined ? { roll: it.roll } : { result: it.result }) } }], summary: `${c.name}: death save ${it.roll !== undefined ? `rolled ${it.roll}` : it.result}`, ruleKey: rk(`death ${c.name}`), visible: 'players', dedupeKey: `death:${c.id}:${it.roll ?? it.result}`, dedupeMs: 8_000 };
    }
    case 'remove_creature': {
      const c = combatant(it.id);
      if (!c || c.isPc) return null;
      return { ...base, category: 'combatAdd', calls: [{ tool: 'remove_combatant', args: { combatant: c.id } }], summary: `Take ${c.name} out of the fight`, ruleKey: rk(`remove ${c.name}`), visible: 'players', dedupeKey: `remove:${c.id}`, dedupeMs: 20_000 };
    }
    case 'add_monsters': {
      const existing = ctx.combat.combatants.filter((c) => norm(c.name).startsWith(norm(it.name))).length;
      const { dexMod, ...stats } = statsFor(d, worldId, it.name);
      // Each creature rolls its own d20, plus Dexterity when its statblock is known.
      const calls: Call[] = Array.from({ length: it.count }, (_, i) => ({ tool: 'add_combatant', args: { name: it.count === 1 && !existing ? it.name : `${it.name} ${existing + i + 1}`, initiative: Math.max(-20, Math.min(60, 1 + Math.floor(Math.random() * 20) + (dexMod ?? 0))), ...stats } }));
      return { ...base, category: 'combatAdd', calls, summary: `Add ${it.count} ${it.name}${it.count === 1 ? '' : 's'} to the fight`, ruleKey: rk(`add ${it.name}`), visible: 'players', dedupeKey: `add:${norm(it.name)}:${it.count}`, dedupeMs: 60_000 };
    }
    case 'initiative': {
      const inFight = it.accountId ? ctx.combat.combatants.find((c) => c.accountId === it.accountId) : undefined;
      const call: Call = inFight ? { tool: 'set_initiative', args: { combatant: inFight.id, value: it.value } } : { tool: 'add_combatant', args: { name: it.name, initiative: it.value, ...(it.accountId ? { accountId: it.accountId } : {}) } };
      return { ...base, category: 'combat', calls: [call], summary: `${it.name}: initiative ${it.value}`, ruleKey: rk(`initiative ${it.name}`), visible: 'players', dedupeKey: `init:${it.accountId ?? it.name}`, dedupeMs: 20_000, playerSource: false };
    }
    case 'coins':
      return { ...base, category: 'items', calls: it.owner === 'party' && it.each ? ctx.party.map((p) => ({ tool: 'add_coin', args: { owner: p.accountId, amountCp: it.cp, note: 'Awarded at the table' } })) : [{ tool: 'add_coin', args: { owner: it.owner, amountCp: it.cp, note: 'Awarded at the table' } }], summary: `${it.each ? 'Each: ' : ''}${cp(it.cp)} to ${it.each ? 'every player' : it.ownerName}`, ruleKey: rk(`coins ${it.ownerName}`), visible: 'players', dedupeKey: `coins:${it.owner}:${it.cp}`, dedupeMs: 40_000 };
    case 'item':
      if (!itemName(it.name)) return null;
      return { ...base, category: 'items', calls: [{ tool: 'add_item', args: { owner: it.owner, name: it.name, qty: it.qty, reason: 'Found at the table' } }], summary: `Give ${it.qty > 1 ? `${it.qty} x ` : ''}${it.name} to ${it.ownerName}`, ruleKey: rk(`item ${it.name}`), visible: 'players', dedupeKey: `item:${it.owner}:${norm(it.name)}`, dedupeMs: 60_000 };
    case 'use_item':
      return null; // resolved against the player's inventory by the engine
    case 'clock': {
      const call: Call = { tool: 'advance_world_time', args: it.preset ? { preset: it.preset, reason: 'At the table' } : { minutes: it.minutes, reason: 'At the table' } };
      return { ...base, category: 'clock', calls: [call], summary: it.preset ? `Advance the clock: ${it.preset.replace('-', ' ')}` : `Advance the clock by ${spanText(it.minutes!)}`, ruleKey: rk(`clock ${it.preset ?? it.minutes}`), visible: 'players', dedupeKey: `clock:${it.preset ?? it.minutes}`, dedupeMs: 90_000 };
    }
  }
  return null;
}
