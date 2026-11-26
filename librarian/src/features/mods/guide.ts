// The Mod studio's guide: what the assistant reads to write a house rule file
// on its own (house_rule_guide), and a plain-words preview of what a checked
// rule will do once it is on (shown by house_rule_check, so the DM can agree
// to the rule without reading JSON). Pure. See docs/MODS.md.
import fs from 'node:fs';
import path from 'node:path';
import type { ModFile } from './format.ts';
import { MODS_DIR } from './catalog.ts';

export const GUIDE_PARTS = ['start', 'counters', 'data', 'presets', 'manifest', 'assistant'] as const;
export type GuidePart = typeof GUIDE_PARTS[number];

const START = `# Making a house rule

A house rule is one JSON file (kit 2). Pick the smallest kind that does the job:

1. Counters: points or tokens a player holds and spends (hero points, luck, inspiration rerolls, fate dice).
   Parts: options, resources, actions, triggers, commands, sheet, dmBand, table, rules. Read part "counters".
2. A data system: lists the rule keeps (activities, tasks, projects, reputation, a crafting queue), progress
   that moves on rests, sessions or a DM button, and a popup that asks each player to choose (a downtime day).
   Parts: records, recordActions, timers, prompts, views. Read part "data". A rule may use counters and data together.
3. Presets: switch on a system Alexandria already has (spell points, the MANA spell system, spell crafting) with
   your own values. Parts: presets, options, requires, group. Read part "presets".
If none of these can do it, it needs code: say so plainly and offer the closest rule you can make.

Every file has: "kit": 2, "id" (lowercase-with-dashes), "name", "version" ("1.0.0"), "author", "summary"
(one sentence a DM reads), and "rules": [{ "term", "text" }] with the rule in plain words for the glossary.
Add "targets": { "builtFor": [...], "worksWith": [...] } with the parts it is made for (part "manifest").
Add "assistant" so the DM's assistant and the player helper know how to help with it (part "assistant").

How to work:
- Look at a close example first: house_rule_file with one of the example ids below. Copy its shape.
- Write the whole file, then call house_rule_check with it. Fix every error it lists (each says where and what)
  and check again until ok is true. Read its notes too.
- Tell the DM in plain words what the rule does: use the check's preview lines, not the JSON.
- Save it with house_rule_save { "draft": <the draft id the check gave> } only after the DM agrees; do not type the
  file again. If you change anything, check again and save the new draft. It starts off; the DM turns it on under House rules → Rules.
- To change a rule the world has, read it with house_rule_file, edit it, keep its id and raise its version.
  A rule that comes with Alexandria keeps its id: copy it under a new id (and a new name) instead.
Write numbers as numbers, yes/no as true/false. "$name" in place of a number or yes/no reads the option "name".
Chat text may use {name} (always the player's character) and {note} (the reason given). Record text may also use
{field}, {title} (the field that names the record), {kind.field} for the record's own field (a field called name
is {project.name}, since {name} is the player) and {ref.field} (a field of the record a ref field points at).`;

const COUNTERS = `# Counters

"options": { "max": { "type": "int", "default": 3, "min": 1, "max": 10, "label": "Most hero points" } }
  Option types: boolean (default true/false), int (default, min, max), enum (values: [...], default), string.
  "help" adds a line under the option. The DM changes options; "$max" anywhere reads it.
"resources": [{ "id": "hero", "label": "Hero point", "icon": "fa-star", "max": "$max", "start": 1, "private": false }]
  One counter per player. max null = no cap. icon is a Font Awesome name. private: only its owner and the DM see it.
"actions": [{ "id": "give", "label": "Give", "by": "dm", "resource": "hero", "add": 1, "askReason": true },
            { "id": "spend", "label": "Spend", "by": "owner", "resource": "hero", "add": -1,
              "effect": { "chat": "{name} spends a hero point: +1d6 ({note})" } }]
  by: dm, owner (the player whose counter it is), player (any player, on anyone) or any.
  resource "*" lets the caller pick which counter (one Grant for several types).
  effect: "chat" posts to table chat, "dmnote" a note only the DM sees,
  "reroll": { "whose": "own" | "anyPlayer" | "dm", "keepBetter": false } rerolls the latest chat roll.
  A spend with nothing left and a give past max are refused for you; you never check that yourself.
"triggers": [{ "on": "sessionStart", "resource": "hero", "add": 1 }]
  on: longRest, shortRest, sessionStart, sessionEnd. "set": a number or "max", and/or "add".
"commands": [{ "word": "hero", "action": "spend" }]  makes /hero in chat run Spend.
  With "args": ["a", "b"] and "action": "use-$1", /hero a runs use-a. roll, me and help are taken.
"sheet": { "title": "Hero points", "resources": ["hero"] }  the player's card and sheet show these counters.
"dmBand": { "chips": ["hero"], "actions": ["give"] }  chips on the DM's party bar, with these actions.
"table": { "title": "Hero points", "actions": ["give"] }  a block on the DM Table.
Limits: 16 options, 12 resources, 24 actions, 12 triggers, 8 commands, 12 rules.
Example ids: hero-points (small), inspiration-rerolls (three kinds of reroll tokens, chat words, reroll effect).`;

const DATA = `# Data systems: records, recordActions, timers, prompts, views

"records": { "<kind>": { "label", "plural"?, "owned"?: true, "title"?: "<field>", "fields": {...}, "seed"?: [...] } }
  A kind is a list the rule keeps (activity, task). owned: each record belongs to one player (the server fills
  "player"). title: the field that names a record (default: the first text field).
  Fields: "text", "int", "bool", "enum:a|b|c", "ref:<kind>"; add "?" for optional ("text?"). Or an object:
  { "type": "int" | "text" | "bool" | "enum" | "ref", "label", "default"?, "min"?, "max"?, "values"? (enum),
    "ref"? (kind), "optional"? }. Every record also has id, player, createdAt, updatedAt.
  seed: ready-made records made when the rule is first turned on (not for owned kinds; up to 300).
"recordActions": [{ "id", "label", "by": "dm" | "owner" | "player" | "any", "record": "<kind>",
                    "do": "create" | "set" | "add" | "remove", ... }]
  create: "ask": [fields the caller fills in], "set": { fixed values }, "copy": { "via": "<ref field>",
    "fields": { "myField": "theirField" } } copies from the record the ref points at (a task's goal from its
    activity's days).
  set: changes a record: "ask" and/or "set". add: "field": "<int field>", "amount": a number or "ask"
    (the caller says how much; negative takes away). remove: deletes it.
  "where": { "status": "open" } only on records like this. "effect": { "chat": "...", "dmnote": "..." }.
  owner means the player who owns the record; on a create by owner the record becomes theirs.
"timers": [{ "id", "record": "<kind>", "on": "longRest" | "shortRest" | "sessionStart" | "sessionEnd" |
             "prompt:<prompt id>", "where"?, "field": "<int field>", "add": 1, "goal": "<field>" | number | "$opt",
             "done": { "set": { "status": "done" }, "chat": "{name} finished {activity.name}!" } }]
  Moves a number on every matching record; when it reaches goal, done runs once. With prompt:<id> it moves
  only the records of players who picked a choice of that prompt (not skip).
"prompts": [{ "id", "button": "Downtime", "title", "text", "choices": [{ "label", "action": "<record action>" }
              | { "label": "Skip", "skip": true }] }]
  The DM presses the button: every player gets a popup with the choices; a choice runs its record action for them.
"views": [{ "id", "title", "record": "<kind>", "place": "dm" | "sheet" | "player", "columns": [fields],
            "where"?, "actions"?: [record action ids], "groupByPlayer"?: true }]
  dm: a tab on the DM's House rules page. sheet: the player's sheet and home card. player: the player's House rules page.
Limits: 8 kinds, 16 fields each, 24 record actions, 8 timers, 4 prompts (6 choices), 8 views.
Example id: downtime-lite (activities by tier, tasks with days, a Downtime day popup, DM add/take days).
Tiers of time (common 1 day ... legendary 3 months) are just an enum field plus a days field on the activity.`;

const ASSISTANT = `# Assistant: how the DM's assistant and the player helper work with the rule

"assistant": { "words": ["downtime", "a day passes"], "dm": "...", "player": "...", "tools": ["my_spell_codex"] }
When a message to the DM's assistant or a player's helper mentions the rule (its name, counters, record kinds,
prompt button, chat words, or any of "words"), they get a note: the rule's summary, its guidance text for them,
the exact calls they can make with it, and what they may see now (a player: shared lists and their own records
and counters). The house rule tools are offered with it.
- words: up to 24 extra words or phrases (3 to 40 letters) that bring the rule up.
- dm: guidance only the DM's assistant sees (up to 1200 letters): when to open a prompt, how to reward, what to
  watch for.
- player: guidance only the player helper sees: how to help a player choose, plan or spend. Write it as advice
  to the helper ("suggest two activities that fit ...").
- tools: other tools to offer when the rule comes up, from a feature: the Codex's my_spell_codex, read_spell,
  list_spell_recipes, draft_spell_recipe, list_spells. A tool this server does not have is left out.
Example ids: spell-crafting, spell-points, downtime-lite.`;

const MANIFEST = `# Manifest (kit 2)

"targets": { "builtFor": ["sheet"], "worksWith": ["chat"] }
  The parts it is made for (it cannot be turned on where one is missing) and parts it only adds to.
  Parts: sheet, codex, chat, table, combat, inventory, clock, map, shop, encounters, stage, assistant, library,
  or a game module id (dnd-2024). Counters usually build for sheet; downtime for sheet; spell rules for codex.
"requires": { "settings": ["spellRulesOn"], "mods": { "other-rule": "^1" } }
  Turning it on turns those on first; turning one of them off asks to turn this one off too.
"conflicts": ["other-rule"]  rules that cannot be on at the same time. "group": "magic" does the same for a set
  (spell slots, spell points and MANA are one group).
"alexandria": ">=0.1"  versions it is built for. "permissions": ["records", ...] only for what its parts do not
  already show; leave it out normally.`;

/** World settings a preset may set, with today's defaults. */
function presetsPart(defaults: Record<string, unknown>): string {
  const lines = Object.entries(defaults).map(([k, v]) => {
    let s = JSON.stringify(v);
    if (s.length > 70) s = s.slice(0, 67) + '...';
    return `- ${k}: ${s}`;
  });
  return `# Presets

"presets": { "<world setting>": value } sets world settings while the rule is on and puts them back when it
goes off. A value may be "$option". Use it to switch on a system Alexandria has, with your table's numbers.
"requires": { "settings": [...] } names settings it cannot work without. Rules that pick one way of doing
the same thing share a "group" (magic: spell slots, spell points, MANA, a mana pool).
A setting this server does not have yet is skipped (house_rule_check says so).
Example ids: spell-points (the spell points variant), mana-pool, mana-system, spell-crafting.

Settings on this server and their defaults:
${lines.join('\n')}`;
}

export function guideText(part: string | undefined, defaults: Record<string, unknown>, exampleIds: string[]): string {
  const p = (GUIDE_PARTS as readonly string[]).includes(part ?? '') ? part as GuidePart : 'start';
  const body = p === 'counters' ? COUNTERS : p === 'data' ? DATA : p === 'manifest' ? MANIFEST : p === 'assistant' ? ASSISTANT : p === 'presets' ? presetsPart(defaults) : START;
  const more = p === 'start' ? `\n\nParts: ${GUIDE_PARTS.join(', ')}. Example ids: ${exampleIds.join(', ')}.` : '';
  return body + more;
}

// ---- examples: rule files in mods/examples (not built in; there to copy) ----

export const EXAMPLES_DIR = path.join(MODS_DIR, 'examples');
/** The example files by rule id, read on each call (they are small, and a DM may drop one in). */
export function exampleFiles(dir = EXAMPLES_DIR): Map<string, unknown> {
  const out = new Map<string, unknown>();
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.alxmod.json')).sort(); } catch { return out; }
  for (const n of names) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (o && typeof o.id === 'string') out.set(o.id, o);
    } catch { /* a broken example is skipped */ }
  }
  return out;
}

// ---- preview: what a checked rule does, in plain words ----

const WHO_SAYS: Record<string, string> = { dm: 'The DM', owner: 'A player (their own)', player: 'Any player', any: 'Anyone' };
const WHEN_SAYS: Record<string, string> = { longRest: 'a long rest', shortRest: 'a short rest', sessionStart: 'the start of a session', sessionEnd: 'the end of a session' };
const num = (v: unknown, opts: ModFile['options']) => typeof v === 'string' && v.startsWith('$') ? `${(opts[v.slice(1)] as any)?.default ?? v} (option ${v.slice(1)})` : String(v);
const signed = (v: unknown, opts: ModFile['options']) => typeof v === 'number' ? (v >= 0 ? `+${v}` : String(v)) : num(v, opts);

export function previewMod(mod: ModFile): string[] {
  const L: string[] = [];
  const o = mod.options;
  const res = new Map(mod.resources.map((r) => [r.id, r]));
  const rname = (id: string) => id === '*' ? 'a counter the caller picks' : res.get(id)?.label ?? id;
  for (const [k, s] of Object.entries(o)) L.push(`Option the DM can change: ${s.label} (${k}, default ${JSON.stringify(s.default)})`);
  for (const r of mod.resources) L.push(`Each player has ${r.label} (starts at ${num(r.start, o)}, ${r.max === null ? 'no cap' : `at most ${num(r.max, o)}`}${r.private ? ', only they and the DM see it' : ''})`);
  for (const a of mod.actions) {
    const fx = [a.effect?.reroll ? `rerolls ${a.effect.reroll.whose === 'own' ? 'their own' : a.effect.reroll.whose === 'dm' ? "the DM's" : "any player's"} latest roll` : '', a.effect?.chat ? `posts "${a.effect.chat}"` : '', a.effect?.dmnote ? 'notes it for the DM' : ''].filter(Boolean);
    L.push(`${WHO_SAYS[a.by]} can ${a.label}: ${signed(a.add, o)} ${rname(a.resource)}${a.askReason ? ', with a reason' : ''}${fx.length ? `, ${fx.join(', ')}` : ''}`);
  }
  for (const t of mod.triggers) L.push(`At ${WHEN_SAYS[t.on]}: ${rname(t.resource)} ${t.set !== undefined ? `set to ${t.set === 'max' ? 'its max' : num(t.set, o)}` : ''}${t.add !== undefined ? `${t.set !== undefined ? ', then ' : ''}${signed(t.add, o)}` : ''}`);
  for (const c of mod.commands) L.push(`Chat word /${c.word}${c.args.length ? ` ${c.args.join('|')}` : ''} runs ${c.action}`);
  if (mod.sheet) L.push(`Shows on the player's sheet: ${mod.sheet.resources.map(rname).join(', ')}`);
  if (mod.dmBand) L.push(`Shows on the DM's party bar: ${mod.dmBand.chips.map(rname).join(', ') || 'no chips'}${mod.dmBand.actions.length ? ` with ${mod.dmBand.actions.join(', ')}` : ''}`);
  if (mod.table) L.push(`A block on the DM Table: ${mod.table.title}`);
  const s = mod.system;
  for (const k of s.records) L.push(`Keeps a list of ${k.plural}${k.owned ? ' (each player has their own)' : ''}: ${Object.keys(k.fields).join(', ')}${k.seed.length ? `; starts with ${k.seed.length} ready-made` : ''}`);
  const kindLabel = (id: string) => s.records.find((k) => k.id === id)?.label.toLowerCase() ?? id;
  for (const a of s.recordActions) {
    const what = a.do === 'create' ? `make a ${kindLabel(a.record)}${a.ask.length ? ` (asks ${a.ask.join(', ')})` : ''}` : a.do === 'set' ? `change a ${kindLabel(a.record)}${a.ask.length ? ` (${a.ask.join(', ')})` : ''}` : a.do === 'add' ? `${a.amount === 'ask' ? 'add or take' : signed(a.amount, o)} ${a.field} on a ${kindLabel(a.record)}` : `remove a ${kindLabel(a.record)}`;
    L.push(`${WHO_SAYS[a.by]} can ${a.label}: ${what}${Object.keys(a.where).length ? ` while ${Object.entries(a.where).map(([k, v]) => `${k} is ${v}`).join(' and ')}` : ''}`);
  }
  for (const t of s.timers) {
    const when = t.on.startsWith('prompt:') ? `each ${s.prompts.find((p) => p.id === t.on.slice(7))?.title ?? t.on.slice(7)} (for players who did not skip)` : `at ${WHEN_SAYS[t.on]}`;
    L.push(`${when[0].toUpperCase()}${when.slice(1)}: ${signed(t.add, o)} ${t.field} on each ${kindLabel(t.record)}; done when it reaches ${typeof t.goal === 'string' && !t.goal.startsWith('$') ? `its ${t.goal}` : num(t.goal, o)}${t.done.chat ? `, then posts "${t.done.chat}"` : ''}`);
  }
  for (const p of s.prompts) L.push(`The DM gets a ${p.button} button: every player is asked "${p.text || p.title}" with ${p.choices.map((c) => c.label).join(' / ')}`);
  for (const v of s.views) L.push(`${v.place === 'dm' ? "A tab on the DM's House rules page" : v.place === 'sheet' ? "On the player's sheet" : "On the player's House rules page"}: ${v.title} (${v.columns.join(', ')})`);
  const pre = Object.entries(mod.presets);
  if (pre.length) L.push(`While on, sets: ${pre.map(([k, v]) => `${k} = ${typeof v === 'string' && v.startsWith('$') ? num(v, o) : JSON.stringify(v).slice(0, 40)}`).join('; ')}`);
  if (mod.group) L.push(`Only one rule of the ${mod.group} group is on at a time`);
  for (const [id, r] of Object.entries(mod.requires.mods)) L.push(`Needs the house rule ${id} ${r}`);
  if (mod.conflicts.length) L.push(`Turns off: ${mod.conflicts.join(', ')}`);
  if (mod.assistant) L.push(`The assistant knows it${mod.assistant.words.length ? ` when someone says ${mod.assistant.words.slice(0, 4).join(', ')}` : ''}${mod.assistant.dm ? '; guidance for the DM' : ''}${mod.assistant.player ? '; guidance for the player helper' : ''}${mod.assistant.tools.length ? `; offers ${mod.assistant.tools.join(', ')}` : ''}`);
  if (!L.length) L.push('Does nothing in play yet: add counters (resources and actions), records or presets');
  for (const r of mod.rules) L.push(`Adds to the glossary: ${r.term}`);
  return L;
}
