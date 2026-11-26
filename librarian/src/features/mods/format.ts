// The house rule (mod) file format and its validator. A mod is data, never
// code: options the DM tunes, per-character counters, actions that change
// them (with an effect such as a server reroll), triggers on rests and
// sessions, where it shows (sheet card, DM bar, Table block), chat commands,
// rule text, and presets (values for world settings other features own, so a
// whole system such as spell points or MANA turns on with one switch).
// Pure: no database. See docs/MODS.md.

import { parseRange, parseVer } from './semver.ts';
import { checkSystem, emptySystem, type System } from './system.ts';
export const KIT_VERSION = 2;
/** The mod API version this Alexandria offers (code mods, see the Workshop design). */
export const MOD_API = 1;
/** What a mod may touch. Data rules get theirs from the parts they use (impliedPermissions). */
export const PERMISSIONS = {
  'chat.post': 'Post in session chat',
  'chat.commands': 'Add chat words like /reroll',
  'chat.buttons': 'Add buttons under chat messages',
  'sheet.card': 'Show a card on the player sheet',
  'sheet.write': 'Change the player sheet',
  'dmband': 'Show chips on the DM status bar',
  'table': 'Add a block to the DM Table',
  'clock.read': 'Run on rests and sessions',
  'clock.write': 'Move the world clock',
  'settings.write': 'Change world settings while on',
  'glossary': 'Add rule text to the glossary',
  'assistant.tools': 'Give the assistant tools',
  'records': 'Keep its own lists',
  'net': 'Reach the internet',
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const MAX_JSON = 128_000;
const MAX = { options: 16, resources: 12, actions: 24, triggers: 12, commands: 8, rules: 12, presets: 24, args: 8 };

export type OptionSpec =
  | { type: 'boolean'; default: boolean; label: string; help?: string }
  | { type: 'int'; default: number; min: number; max: number; label: string; help?: string }
  | { type: 'enum'; default: string; values: string[]; label: string; help?: string }
  | { type: 'string'; default: string; max: number; label: string; help?: string };

/** A number in a mod: a whole number or "$option" (an int option of this mod). */
export type Num = number | string;
/** A yes/no in a mod: true, false or "$option" (a boolean option). */
export type Flag = boolean | string;

export interface Resource { id: string; label: string; icon: string; max: Num | null; start: Num; private: boolean }
export type Who = 'dm' | 'owner' | 'player' | 'any';
export type Whose = 'own' | 'anyPlayer' | 'dm';
export interface Effect { reroll?: { whose: Whose; keepBetter: Flag }; chat?: string; dmnote?: string }
export interface Action {
  id: string; label: string; by: Who;
  /** A resource id, or '*' when the caller names one (a Grant that gives any type). */
  resource: string;
  add: Num;
  askReason: boolean;
  effect?: Effect;
}
export type When = 'longRest' | 'shortRest' | 'sessionStart' | 'sessionEnd';
export interface Trigger { on: When; resource: string; set?: Num | 'max'; add?: Num }
export interface Command { word: string; args: string[]; action: string }
export interface Rule { term: string; text: string }
export interface Requires { settings: string[]; /** Other house rules it builds on: id → version range. */ mods: Record<string, string> }
export interface Targets { /** Parts of Alexandria or game modules it is made for: it cannot be turned on without them. */ builtFor: string[]; /** Ones it adds to when present. */ worksWith: string[] }

export interface ModFile {
  kit: number;
  id: string;
  name: string;
  version: string;
  author: string;
  summary: string;
  /** Mods in the same group are exclusive (e.g. 'magic': spell slots, spell points or MANA). */
  group: string;
  options: Record<string, OptionSpec>;
  resources: Resource[];
  actions: Action[];
  triggers: Trigger[];
  commands: Command[];
  sheet: { title: string; resources: string[] } | null;
  dmBand: { chips: string[]; actions: string[] } | null;
  table: { title: string; actions: string[] } | null;
  rules: Rule[];
  /** World settings to set while the mod is on (values may be "$option"); restored when it goes off. */
  presets: Record<string, unknown>;
  requires: Requires;
  /** Kit 2: the Alexandria versions it is built for (a range like ">=0.2"), '' for any. */
  alexandria: string;
  /** Kit 2: the mod API version it was written against (0 = none, a data rule). */
  api: number;
  targets: Targets;
  /** Rules that cannot be on at the same time (they are turned off when this one goes on). */
  conflicts: string[];
  permissions: Permission[];
  /** Kit 2 data system: its own lists, record actions, timers, prompts and views (system.ts). */
  system: System;
}

export interface Checked { mod: ModFile | null; errors: string[] }

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ICON = /^fa-[a-z0-9-]{1,40}$/;
const WHO: readonly Who[] = ['dm', 'owner', 'player', 'any'];
const WHOSE: readonly Whose[] = ['own', 'anyPlayer', 'dm'];
const WHEN: readonly When[] = ['longRest', 'shortRest', 'sessionStart', 'sessionEnd'];

/**
 * Check and clean a mod. Never throws: every problem is a plain sentence in
 * `errors` (the assistant reads them and fixes the file), and `mod` is null
 * when there is any.
 */
export function checkMod(raw: unknown): Checked {
  const errors: string[] = [];
  const err = (s: string) => { if (errors.length < 40) errors.push(s); };
  let o: any = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_JSON) return { mod: null, errors: [`The file is larger than ${MAX_JSON / 1000} KB`] };
    try { o = JSON.parse(raw); } catch (e: any) { return { mod: null, errors: [`The file is not valid JSON: ${e.message}`] }; }
  } else {
    try { if (JSON.stringify(raw ?? null).length > MAX_JSON) return { mod: null, errors: [`The file is larger than ${MAX_JSON / 1000} KB`] }; } catch { return { mod: null, errors: ['The file is not valid JSON'] }; }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { mod: null, errors: ['A mod is a JSON object with at least an id and a name'] };

  const text = (v: unknown, at: string, max: number, need = false): string => {
    if (v === undefined || v === null || v === '') { if (need) err(`${at} is required`); return ''; }
    if (typeof v !== 'string') { err(`${at} must be text`); return ''; }
    const t = v.trim();
    if (t.length > max) err(`${at} is longer than ${max} characters`);
    return t.slice(0, max);
  };
  const slug = (v: unknown, at: string): string => {
    if (typeof v !== 'string' || !SLUG.test(v)) { err(`${at} must be a short id: lowercase letters, digits and dashes (like "hero-points")`); return ''; }
    return v;
  };
  const list = (v: unknown, at: string, max: number): any[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) { err(`${at} must be a list`); return []; }
    if (v.length > max) err(`${at} holds at most ${max} entries`);
    return v.slice(0, max);
  };

  if (o.kit !== undefined && !(Number.isInteger(o.kit) && o.kit >= 1 && o.kit <= KIT_VERSION)) err(typeof o.kit === 'number' && o.kit > KIT_VERSION ? `kit ${o.kit} needs a newer Alexandria (this one reads mod kit versions 1 to ${KIT_VERSION})` : `kit must be 1 or ${KIT_VERSION}`);
  const mod: ModFile = {
    kit: Number.isInteger(o.kit) && o.kit >= 1 && o.kit <= KIT_VERSION ? o.kit : 1,
    id: slug(o.id, 'id'),
    name: text(o.name, 'name', 60, true),
    version: text(o.version, 'version', 20) || '1.0.0',
    author: text(o.author, 'author', 60),
    summary: text(o.summary, 'summary', 300),
    group: o.group === undefined || o.group === '' ? '' : slug(o.group, 'group'),
    options: {}, resources: [], actions: [], triggers: [], commands: [], sheet: null, dmBand: null, table: null, rules: [], presets: {},
    requires: { settings: [], mods: {} },
    alexandria: '', api: 0, targets: { builtFor: [], worksWith: [] }, conflicts: [], permissions: [], system: emptySystem(),
  };

  // ---- options
  if (o.options !== undefined && (typeof o.options !== 'object' || Array.isArray(o.options) || !o.options)) err('options must be an object of name: { type, default, label }');
  const optEntries = Object.entries(o.options && typeof o.options === 'object' && !Array.isArray(o.options) ? o.options : {});
  if (optEntries.length > MAX.options) err(`options holds at most ${MAX.options} entries`);
  for (const [k, v] of optEntries.slice(0, MAX.options) as [string, any][]) {
    const at = `options.${k}`;
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,29}$/.test(k)) { err(`${at}: option names are letters and digits, starting with a letter`); continue; }
    if (!v || typeof v !== 'object') { err(`${at} must be { type, default, label }`); continue; }
    const label = text(v.label, `${at}.label`, 80) || k;
    const help = text(v.help, `${at}.help`, 200) || undefined;
    if (v.type === 'boolean') {
      if (typeof v.default !== 'boolean') err(`${at}.default must be true or false`);
      mod.options[k] = { type: 'boolean', default: !!v.default, label, ...(help ? { help } : {}) };
    } else if (v.type === 'int') {
      const min = Number.isInteger(v.min) ? v.min : 0, max = Number.isInteger(v.max) ? v.max : 999;
      if (min > max) err(`${at}: min is above max`);
      if (!Number.isInteger(v.default) || v.default < min || v.default > max) err(`${at}.default must be a whole number from ${min} to ${max}`);
      mod.options[k] = { type: 'int', default: Number.isInteger(v.default) ? v.default : min, min, max, label, ...(help ? { help } : {}) };
    } else if (v.type === 'enum') {
      const values = list(v.values, `${at}.values`, 12).map((x, i) => text(x, `${at}.values[${i}]`, 40)).filter(Boolean);
      if (!values.length) err(`${at}.values needs at least one choice`);
      if (!values.includes(v.default)) err(`${at}.default must be one of its values`);
      mod.options[k] = { type: 'enum', default: values.includes(v.default) ? v.default : values[0] ?? '', values, label, ...(help ? { help } : {}) };
    } else if (v.type === 'string') {
      const max = Number.isInteger(v.max) && v.max > 0 && v.max <= 400 ? v.max : 80;
      mod.options[k] = { type: 'string', default: text(v.default, `${at}.default`, max), max, label, ...(help ? { help } : {}) };
    } else err(`${at}.type must be boolean, int, enum or string`);
  }
  const intOpt = (s: string) => mod.options[s]?.type === 'int';
  const boolOpt = (s: string) => mod.options[s]?.type === 'boolean';
  const num = (v: unknown, at: string, lo: number, hi: number, dflt: number): Num => {
    if (v === undefined || v === null) return dflt;
    if (typeof v === 'string' && v.startsWith('$')) { if (!intOpt(v.slice(1))) err(`${at}: "${v}" is not a whole-number option of this mod`); return v; }
    if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) { err(`${at} must be a whole number from ${lo} to ${hi}, or "$option"`); return dflt; }
    return v as number;
  };
  const flag = (v: unknown, at: string): Flag => {
    if (v === undefined || v === null) return false;
    if (typeof v === 'string' && v.startsWith('$')) { if (!boolOpt(v.slice(1))) err(`${at}: "${v}" is not a true/false option of this mod`); return v; }
    if (typeof v !== 'boolean') { err(`${at} must be true, false or "$option"`); return false; }
    return v;
  };

  // ---- resources
  const resIds = new Set<string>();
  list(o.resources, 'resources', MAX.resources).forEach((r: any, i: number) => {
    const at = `resources[${i}]`;
    if (!r || typeof r !== 'object') { err(`${at} must be { id, label }`); return; }
    const rid = slug(r.id, `${at}.id`);
    if (rid && resIds.has(rid)) err(`${at}.id "${rid}" is used twice`);
    resIds.add(rid);
    const icon = r.icon === undefined ? 'fa-circle' : typeof r.icon === 'string' && ICON.test(r.icon) ? r.icon : (err(`${at}.icon must be a Font Awesome name like "fa-dice-d20"`), 'fa-circle');
    mod.resources.push({ id: rid, label: text(r.label, `${at}.label`, 40, true), icon, max: r.max === null || r.max === undefined ? null : num(r.max, `${at}.max`, 0, 9999, 1), start: num(r.start, `${at}.start`, 0, 9999, 0), private: r.private === true });
  });
  const hasRes = (id: string) => resIds.has(id);

  // ---- actions
  const actIds = new Set<string>();
  list(o.actions, 'actions', MAX.actions).forEach((a: any, i: number) => {
    const at = `actions[${i}]`;
    if (!a || typeof a !== 'object') { err(`${at} must be { id, label, by, resource, add }`); return; }
    const aid = slug(a.id, `${at}.id`);
    if (aid && actIds.has(aid)) err(`${at}.id "${aid}" is used twice`);
    actIds.add(aid);
    const by = WHO.includes(a.by) ? a.by as Who : (err(`${at}.by must be one of ${WHO.join(', ')}`), 'dm' as Who);
    const resource = typeof a.resource === 'string' ? a.resource : '';
    if (resource !== '*' && !hasRes(resource)) err(`${at} uses resource "${resource || '(none)'}", which this mod does not define`);
    const action: Action = { id: aid, label: text(a.label, `${at}.label`, 40, true), by, resource, add: num(a.add, `${at}.add`, -999, 999, 0), askReason: a.askReason === true };
    if (a.effect !== undefined) {
      const e = a.effect, eat = `${at}.effect`;
      if (!e || typeof e !== 'object') err(`${eat} must be an object`);
      else {
        const eff: Effect = {};
        if (e.reroll !== undefined) {
          const whose = WHOSE.includes(e.reroll?.whose) ? e.reroll.whose as Whose : (err(`${eat}.reroll.whose must be one of ${WHOSE.join(', ')}`), 'own' as Whose);
          eff.reroll = { whose, keepBetter: flag(e.reroll?.keepBetter, `${eat}.reroll.keepBetter`) };
        }
        if (e.chat !== undefined) eff.chat = text(e.chat, `${eat}.chat`, 300);
        if (e.dmnote !== undefined) eff.dmnote = text(e.dmnote, `${eat}.dmnote`, 300);
        for (const k of Object.keys(e)) if (!['reroll', 'chat', 'dmnote'].includes(k)) err(`${eat}.${k} is not an effect (use reroll, chat or dmnote)`);
        action.effect = eff;
      }
    }
    mod.actions.push(action);
  });
  const hasAct = (id: string) => actIds.has(id);

  // ---- triggers
  list(o.triggers, 'triggers', MAX.triggers).forEach((t: any, i: number) => {
    const at = `triggers[${i}]`;
    if (!t || typeof t !== 'object') { err(`${at} must be { on, resource, set or add }`); return; }
    const on = WHEN.includes(t.on) ? t.on as When : (err(`${at}.on must be one of ${WHEN.join(', ')}`), 'longRest' as When);
    const resource = typeof t.resource === 'string' ? t.resource : '';
    if (resource !== '*' && !hasRes(resource)) err(`${at} uses resource "${resource || '(none)'}", which this mod does not define`);
    const tr: Trigger = { on, resource };
    if (t.set !== undefined) tr.set = t.set === 'max' ? 'max' : num(t.set, `${at}.set`, 0, 9999, 0);
    if (t.add !== undefined) tr.add = num(t.add, `${at}.add`, -999, 999, 0);
    if (tr.set === undefined && tr.add === undefined) err(`${at} needs set or add`);
    mod.triggers.push(tr);
  });

  // ---- commands
  const words = new Set<string>();
  list(o.commands, 'commands', MAX.commands).forEach((c: any, i: number) => {
    const at = `commands[${i}]`;
    if (!c || typeof c !== 'object') { err(`${at} must be { word, action }`); return; }
    const word = typeof c.word === 'string' && /^[a-z][a-z0-9]{1,19}$/.test(c.word) ? c.word : (err(`${at}.word must be a short lowercase word, like "reroll"`), '');
    if (['roll', 'me', 'help'].includes(word)) err(`${at}.word "${word}" belongs to the chat itself`);
    if (word && words.has(word)) err(`${at}.word "${word}" is used twice`);
    words.add(word);
    const args = list(c.args, `${at}.args`, MAX.args).map((x: unknown, j: number) => typeof x === 'string' && /^[a-z0-9-]{1,20}$/.test(x) ? x : (err(`${at}.args[${j}] must be a short lowercase word`), '')).filter(Boolean);
    const action = typeof c.action === 'string' ? c.action : '';
    const targets = action.includes('$1') ? args.map((a: string) => action.replace('$1', a)) : [action];
    if (action.includes('$1') && !args.length) err(`${at}.action uses $1 but the command has no args`);
    for (const t of targets) if (!hasAct(t)) err(`${at} points at action "${t}", which this mod does not define`);
    mod.commands.push({ word, args, action });
  });

  // ---- where it shows
  const resList = (v: unknown, at: string) => list(v, at, MAX.resources).filter((x: any) => { if (!hasRes(x)) { err(`${at}: "${x}" is not a resource of this mod`); return false; } return true; });
  const actList = (v: unknown, at: string) => list(v, at, MAX.actions).filter((x: any) => { if (!hasAct(x)) { err(`${at}: "${x}" is not an action of this mod`); return false; } return true; });
  if (o.sheet) mod.sheet = { title: text(o.sheet.title, 'sheet.title', 40) || mod.name, resources: resList(o.sheet.resources ?? [...resIds], 'sheet.resources') };
  if (o.dmBand) mod.dmBand = { chips: resList(o.dmBand.chips ?? [], 'dmBand.chips'), actions: actList(o.dmBand.actions ?? [], 'dmBand.actions') };
  if (o.table) mod.table = { title: text(o.table.title, 'table.title', 40) || mod.name, actions: actList(o.table.actions ?? [], 'table.actions') };

  // ---- rules text
  list(o.rules, 'rules', MAX.rules).forEach((r: any, i: number) => {
    const at = `rules[${i}]`;
    if (!r || typeof r !== 'object') { err(`${at} must be { term, text }`); return; }
    mod.rules.push({ term: text(r.term, `${at}.term`, 80, true), text: text(r.text, `${at}.text`, 4000, true) });
  });

  // ---- presets and what they need
  if (o.presets !== undefined) {
    if (!o.presets || typeof o.presets !== 'object' || Array.isArray(o.presets)) err('presets must be an object of world setting: value');
    else {
      const ent = Object.entries(o.presets);
      if (ent.length > MAX.presets) err(`presets holds at most ${MAX.presets} settings`);
      for (const [k, v] of ent.slice(0, MAX.presets)) {
        if (!/^[a-zA-Z][a-zA-Z0-9]{0,59}$/.test(k)) { err(`presets.${k} is not a setting name`); continue; }
        if (typeof v === 'string' && v.startsWith('$') && !mod.options[v.slice(1)]) err(`presets.${k}: "${v}" is not an option of this mod`);
        mod.presets[k] = v;
      }
    }
  }
  if (o.requires !== undefined) {
    if (!o.requires || typeof o.requires !== 'object' || Array.isArray(o.requires)) err('requires must be an object: { settings?: [...], mods?: { id: version range } }');
    mod.requires.settings = list(o.requires?.settings, 'requires.settings', 12).filter((x: unknown, i: number) => typeof x === 'string' && /^[a-zA-Z][a-zA-Z0-9]{0,59}$/.test(x) ? true : (err(`requires.settings[${i}] is not a setting name`), false));
    const rm = o.requires?.mods;
    if (rm !== undefined) {
      if (!rm || typeof rm !== 'object' || Array.isArray(rm)) err('requires.mods must be an object of rule id: version range, like { "inspiration-rerolls": "^1" }');
      else {
        const ent = Object.entries(rm);
        if (ent.length > 12) err('requires.mods holds at most 12 rules');
        for (const [k, v] of ent.slice(0, 12)) {
          if (!SLUG.test(k)) { err(`requires.mods: "${k}" is not a rule id`); continue; }
          if (k === mod.id) { err('requires.mods: a rule cannot need itself'); continue; }
          if (typeof v !== 'string' || !parseRange(v)) { err(`requires.mods.${k}: "${String(v)}" is not a version range (like "^1", ">=1.2" or "*")`); continue; }
          mod.requires.mods[k] = v.trim() || '*';
        }
      }
    }
  }

  // ---- kit 2: what it is built for, needs and conflicts with
  if (o.alexandria !== undefined && o.alexandria !== '') {
    if (typeof o.alexandria !== 'string' || !parseRange(o.alexandria)) err(`alexandria must be a version range, like ">=0.2" or "^0.1"`);
    else mod.alexandria = o.alexandria.trim();
  }
  if (o.api !== undefined) {
    if (!Number.isInteger(o.api) || o.api < 0 || o.api > 99) err('api must be the mod API version, a whole number like 1');
    else mod.api = o.api;
  }
  if (o.targets !== undefined) {
    if (!o.targets || typeof o.targets !== 'object' || Array.isArray(o.targets)) err('targets must be an object: { builtFor: [...], worksWith: [...] }');
    else {
      for (const k of Object.keys(o.targets)) if (k !== 'builtFor' && k !== 'worksWith') err(`targets.${k} is not a part of targets (builtFor, worksWith)`);
      const ids = (v: unknown, at: string) => list(v, at, 8).filter((x: unknown, i: number) => typeof x === 'string' && SLUG.test(x) ? true : (err(`${at}[${i}] must be a module id like "sheet", "codex" or "dnd-2024"`), false));
      mod.targets.builtFor = [...new Set(ids(o.targets.builtFor, 'targets.builtFor'))];
      mod.targets.worksWith = [...new Set(ids(o.targets.worksWith, 'targets.worksWith'))].filter((x) => !mod.targets.builtFor.includes(x));
    }
  }
  if (o.conflicts !== undefined) {
    mod.conflicts = [...new Set(list(o.conflicts, 'conflicts', 12).filter((x: unknown, i: number) => typeof x === 'string' && SLUG.test(x) && x !== mod.id ? true : (err(`conflicts[${i}] must be the id of another rule`), false)))] as string[];
    for (const c of mod.conflicts) if (mod.requires.mods[c]) err(`${c} cannot be both needed and in conflicts`);
  }
  if (o.permissions !== undefined) {
    mod.permissions = [...new Set(list(o.permissions, 'permissions', 16).filter((x: unknown, i: number) => typeof x === 'string' && x in PERMISSIONS ? true : (err(`permissions[${i}] "${String(x)}" is not a permission (${Object.keys(PERMISSIONS).join(', ')})`), false)))] as Permission[];
  }

  // ---- kit 2 data system
  if (['records', 'recordActions', 'timers', 'prompts', 'views'].some((k) => o[k] !== undefined)) {
    mod.system = checkSystem(o, { err, hasOption: (name, type) => !!mod.options[name] && (!type || mod.options[name].type === type) });
    if (!mod.system.records.length && (o.recordActions || o.timers || o.prompts || o.views)) err('recordActions, timers, prompts and views work on records: add a "records" part');
    const taken = new Set(mod.actions.map((a) => a.id));
    for (const ra of mod.system.recordActions) if (taken.has(ra.id)) err(`recordActions: "${ra.id}" is also the id of an action; give it another`);
  }

  const known = new Set(['kit', 'id', 'name', 'version', 'author', 'summary', 'group', 'options', 'resources', 'actions', 'triggers', 'commands', 'sheet', 'dmBand', 'table', 'rules', 'presets', 'requires', 'alexandria', 'api', 'targets', 'conflicts', 'permissions', 'records', 'recordActions', 'timers', 'prompts', 'views']);
  for (const k of Object.keys(o)) if (!known.has(k)) err(`"${k}" is not part of a mod (see docs/MODS.md for the parts)`);

  if (o.version !== undefined && !parseVer(mod.version)) err(`version must look like 1.0.0 (major.minor.patch)`);

  return errors.length ? { mod: null, errors } : { mod, errors: [] };
}

/** A checked rule back in the shape of a file (what is saved, exported and shown to the assistant). */
export function toFile(mod: ModFile): Record<string, unknown> {
  const { system, ...rest } = mod;
  if (!system.records.length) return rest;
  return {
    ...rest,
    records: Object.fromEntries(system.records.map((k) => [k.id, { label: k.label, plural: k.plural, owned: k.owned, title: k.title, fields: k.fields, ...(k.seed.length ? { seed: k.seed } : {}) }])),
    ...(system.recordActions.length ? { recordActions: system.recordActions } : {}),
    ...(system.timers.length ? { timers: system.timers } : {}),
    ...(system.prompts.length ? { prompts: system.prompts } : {}),
    ...(system.views.length ? { views: system.views } : {}),
  };
}

/** What a rule touches, from the parts it uses, plus what it declares. */
export function impliedPermissions(mod: ModFile): Permission[] {
  const p = new Set<Permission>(mod.permissions);
  if (mod.commands.length) p.add('chat.commands');
  if (mod.actions.some((a) => a.effect?.chat || a.effect?.reroll)) p.add('chat.post');
  if (mod.actions.some((a) => a.effect?.reroll)) p.add('chat.buttons');
  if (mod.sheet) p.add('sheet.card');
  if (mod.dmBand) p.add('dmband');
  if (mod.table) p.add('table');
  if (mod.triggers.length) p.add('clock.read');
  if (Object.keys(mod.presets).length) p.add('settings.write');
  if (mod.rules.length) p.add('glossary');
  if (mod.system.records.length) p.add('records');
  if (mod.system.prompts.length || mod.system.recordActions.some((a) => a.effect?.chat) || mod.system.timers.some((t) => t.done.chat)) p.add('chat.post');
  if (mod.system.timers.some((t) => !t.on.startsWith('prompt:'))) p.add('clock.read');
  if (mod.system.views.some((v) => v.place === 'sheet')) p.add('sheet.card');
  return (Object.keys(PERMISSIONS) as Permission[]).filter((k) => p.has(k));
}

/** The DM's option values over the defaults, checked; unknown or bad values fall back to the default. */
export function resolveOptions(mod: ModFile, saved: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(mod.options)) {
    const v = saved?.[k];
    out[k] = okOption(spec, v) ? v : spec.default;
  }
  return out;
}

export function okOption(spec: OptionSpec, v: unknown): boolean {
  switch (spec.type) {
    case 'boolean': return typeof v === 'boolean';
    case 'int': return Number.isInteger(v) && (v as number) >= spec.min && (v as number) <= spec.max;
    case 'enum': return typeof v === 'string' && spec.values.includes(v);
    case 'string': return typeof v === 'string' && v.length <= spec.max;
  }
}

/** A "$option" reference read against the options; anything else as given. */
export function val<T>(v: T | string, opts: Record<string, unknown>): T {
  if (typeof v === 'string' && v.startsWith('$')) return opts[v.slice(1)] as T;
  return v as T;
}

/** The presets with their "$option" values filled in. */
export function presetValues(mod: ModFile, opts: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(mod.presets).map(([k, v]) => [k, val(v, opts)]));
}

/** The chat words this mod answers, each with the action id it runs. */
export function commandActions(mod: ModFile): { word: string; arg: string | null; action: string }[] {
  const out: { word: string; arg: string | null; action: string }[] = [];
  for (const c of mod.commands) {
    if (c.action.includes('$1')) for (const a of c.args) out.push({ word: c.word, arg: a, action: c.action.replace('$1', a) });
    else out.push({ word: c.word, arg: null, action: c.action });
  }
  return out;
}

// ---- packages ------------------------------------------------------------
//
// What Export hands out and what Import takes: one `.alxmod.json` file that
// holds one or more rules with who made it and for which Alexandria. A bare
// rule file (no wrapper) is still accepted everywhere.

export const PACKAGE_TYPE = 'alexandria-house-rules';
export const MAX_PACKAGE = 25;
export const MAX_PACKAGE_JSON = 512_000;

export interface PackageInfo { name: string; author: string; summary: string; exported: string; alexandria: string }
export interface ModPackage extends PackageInfo { type: typeof PACKAGE_TYPE; kit: number; mods: Record<string, unknown>[] }

/** Wrap rules as a package to share. */
export function makePackage(mods: ModFile[], info: Partial<PackageInfo> & { alexandria: string }): ModPackage {
  return {
    type: PACKAGE_TYPE, kit: KIT_VERSION,
    name: info.name ?? (mods.length === 1 ? mods[0].name : 'House rules'),
    author: info.author ?? (mods.length === 1 ? mods[0].author : ''),
    summary: info.summary ?? (mods.length === 1 ? mods[0].summary : mods.map((m) => m.name).join(', ')),
    exported: info.exported ?? new Date().toISOString(),
    alexandria: info.alexandria,
    mods: mods.map(toFile),
  };
}

export interface Unpacked { mods: ModFile[]; errors: string[]; info: PackageInfo | null }

/** Read a package or a bare rule file and check every rule in it. `mods` is empty when anything is wrong. */
export function unpack(raw: unknown): Unpacked {
  let o: any = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_PACKAGE_JSON) return { mods: [], info: null, errors: [`The file is larger than ${MAX_PACKAGE_JSON / 1000} KB`] };
    try { o = JSON.parse(raw); } catch (e: any) { return { mods: [], info: null, errors: [`The file is not valid JSON: ${e.message}`] }; }
  }
  const isPackage = o && typeof o === 'object' && !Array.isArray(o) && (o.type === PACKAGE_TYPE || Array.isArray(o.mods));
  if (!isPackage) {
    const { mod, errors } = checkMod(o);
    return { mods: mod ? [mod] : [], info: null, errors };
  }
  try { if (JSON.stringify(o).length > MAX_PACKAGE_JSON) return { mods: [], info: null, errors: [`The file is larger than ${MAX_PACKAGE_JSON / 1000} KB`] }; } catch { return { mods: [], info: null, errors: ['The file is not valid JSON'] }; }
  const errors: string[] = [];
  if (typeof o.kit === 'number' && o.kit > KIT_VERSION) errors.push(`This package needs a newer Alexandria (house rules kit ${o.kit}; this one reads ${KIT_VERSION})`);
  if (!Array.isArray(o.mods) || o.mods.length === 0) errors.push('A package holds its rules in "mods", a list with at least one rule');
  else if (o.mods.length > MAX_PACKAGE) errors.push(`A package holds at most ${MAX_PACKAGE} rules`);
  const mods: ModFile[] = [];
  const seen = new Set<string>();
  for (const [i, m] of (Array.isArray(o.mods) ? o.mods.slice(0, MAX_PACKAGE) : []).entries()) {
    const c = checkMod(m);
    const at = `mods[${i}]${c.mod ? ` (${c.mod.id})` : typeof m?.id === 'string' ? ` (${m.id})` : ''}`;
    for (const e of c.errors) if (errors.length < 40) errors.push(`${at}: ${e}`);
    if (c.mod) {
      if (seen.has(c.mod.id)) errors.push(`${at}: the id ${c.mod.id} is in the package twice`);
      seen.add(c.mod.id);
      mods.push(c.mod);
    }
  }
  const s = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const info: PackageInfo = { name: s(o.name, 80), author: s(o.author, 80), summary: s(o.summary, 400), exported: s(o.exported, 40), alexandria: s(o.alexandria, 40) };
  return errors.length ? { mods: [], info, errors } : { mods, info, errors: [] };
}
