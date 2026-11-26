// Data systems (house rules kit 2): the blocks that let a rule be a whole
// system without code. A rule keeps its own lists (records), changes them with
// actions (create, set, add, remove, each with who may run it), moves numbers
// on rests, sessions or a DM prompt (timers), asks each player to choose (a DM
// prompt such as "Downtime day"), and shows them (views). Every change is
// logged. Pure: the checks only; recstore.ts keeps the data. See docs/MODS.md.

import type { Num, Who } from './format.ts';

export type FieldType = 'text' | 'int' | 'bool' | 'enum' | 'ref';
export interface Field { type: FieldType; label: string; optional: boolean; values?: string[]; ref?: string; min?: number; max?: number; default?: unknown }
export interface RecordKind {
  id: string; label: string; plural: string;
  /** Each record belongs to one player (a `player` field the server fills). */
  owned: boolean;
  /** The field that names a record in lists and choices. */
  title: string;
  fields: Record<string, Field>;
  /** Records made when the rule is first turned on in a world (ready-made activities, say). */
  seed: Record<string, unknown>[];
}
export type RecordOp = 'create' | 'set' | 'add' | 'remove';
export interface RecordAction {
  id: string; label: string; by: Who; record: string; do: RecordOp;
  /** Fields the caller fills in (a form, or the assistant's arguments). */
  ask: string[];
  /** Fixed values (may be "$option"). */
  set: Record<string, unknown>;
  /** add: the number field and how much ("ask" lets the caller say, e.g. the DM adds or takes days). */
  field?: string; amount?: Num | 'ask';
  /** create: copy fields from the record a ref field points at, { myField: 'theirField' } (a task's goal from its activity's days). */
  copy?: { via: string; fields: Record<string, string> };
  /** Only on records like this, e.g. { status: 'open' }. */
  where: Record<string, unknown>;
  effect?: { chat?: string; dmnote?: string };
}
export type TimerOn = 'longRest' | 'shortRest' | 'sessionStart' | 'sessionEnd' | `prompt:${string}`;
export interface Timer {
  id: string; record: string; on: TimerOn; where: Record<string, unknown>;
  field: string; add: Num;
  /** Done when field reaches this: a number, "$option", or the name of another number field of the record. */
  goal: Num;
  done: { set: Record<string, unknown>; chat?: string };
}
export interface PromptChoice { label: string; action?: string; skip?: boolean }
export interface Prompt { id: string; button: string; title: string; text: string; choices: PromptChoice[] }
export type ViewPlace = 'dm' | 'sheet' | 'player';
export interface View { id: string; title: string; record: string; place: ViewPlace; columns: string[]; where: Record<string, unknown>; actions: string[]; groupByPlayer: boolean }

export interface System { records: RecordKind[]; recordActions: RecordAction[]; timers: Timer[]; prompts: Prompt[]; views: View[] }
export const emptySystem = (): System => ({ records: [], recordActions: [], timers: [], prompts: [], views: [] });

const MAX = { kinds: 8, fields: 16, seed: 300, actions: 24, timers: 8, prompts: 4, choices: 6, views: 8 };
const SLUG = /^[a-z][a-zA-Z0-9-]{0,39}$/;
const WHO: readonly Who[] = ['dm', 'owner', 'player', 'any'];
const OPS: readonly RecordOp[] = ['create', 'set', 'add', 'remove'];
const WHEN = ['longRest', 'shortRest', 'sessionStart', 'sessionEnd'];
const PLACES: readonly ViewPlace[] = ['dm', 'sheet', 'player'];
/** Fields every record has. */
export const BUILTIN_FIELDS = ['id', 'player', 'createdAt', 'updatedAt'];

type Err = (s: string) => void;
interface Ctx { err: Err; hasOption: (name: string, type?: string) => boolean }

/** Check the kit 2 system blocks of a rule file. */
export function checkSystem(o: any, ctx: Ctx): System {
  const { err } = ctx;
  const sys = emptySystem();
  const list = (v: unknown, at: string, max: number): any[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) { err(`${at} must be a list`); return []; }
    if (v.length > max) err(`${at} holds at most ${max} entries`);
    return v.slice(0, max);
  };
  const text = (v: unknown, at: string, max: number, need = false): string => {
    if (v === undefined || v === null || v === '') { if (need) err(`${at} is required`); return ''; }
    if (typeof v !== 'string') { err(`${at} must be text`); return ''; }
    if (v.trim().length > max) err(`${at} is longer than ${max} characters`);
    return v.trim().slice(0, max);
  };
  const slug = (v: unknown, at: string): string => (typeof v === 'string' && SLUG.test(v) ? v : (err(`${at} must be a short id: letters, digits and dashes, starting with a letter`), ''));
  const num = (v: unknown, at: string, dflt: number): Num => {
    if (v === undefined || v === null) return dflt;
    if (typeof v === 'string' && v.startsWith('$')) { if (!ctx.hasOption(v.slice(1), 'int')) err(`${at}: "${v}" is not a whole-number option of this rule`); return v; }
    if (!Number.isInteger(v) || Math.abs(v as number) > 1_000_000) { err(`${at} must be a whole number or "$option"`); return dflt; }
    return v as number;
  };

  // ---- records
  if (o.records !== undefined && (typeof o.records !== 'object' || Array.isArray(o.records) || !o.records)) err('records must be an object of kind: { label, fields }');
  const kinds = Object.entries(o.records && typeof o.records === 'object' && !Array.isArray(o.records) ? o.records : {});
  if (kinds.length > MAX.kinds) err(`records holds at most ${MAX.kinds} kinds`);
  for (const [kid, k] of kinds.slice(0, MAX.kinds) as [string, any][]) {
    const at = `records.${kid}`;
    if (!SLUG.test(kid)) { err(`${at}: "${kid}" is not a record kind id`); continue; }
    if (!k || typeof k !== 'object') { err(`${at} must be { label, fields }`); continue; }
    const kind: RecordKind = { id: kid, label: text(k.label, `${at}.label`, 40) || kid, plural: text(k.plural, `${at}.plural`, 40), owned: k.owned === true, title: '', fields: {}, seed: [] };
    kind.plural ||= `${kind.label}s`;
    const fields = Object.entries(k.fields && typeof k.fields === 'object' && !Array.isArray(k.fields) ? k.fields : {});
    if (!fields.length) err(`${at}.fields must name at least one field, like { "name": "text" }`);
    if (fields.length > MAX.fields) err(`${at}.fields holds at most ${MAX.fields} fields`);
    for (const [fid, f] of fields.slice(0, MAX.fields) as [string, any][]) {
      const fat = `${at}.fields.${fid}`;
      if (!SLUG.test(fid) || BUILTIN_FIELDS.includes(fid)) { err(`${fat}: "${fid}" cannot be a field name${BUILTIN_FIELDS.includes(fid) ? ' (every record has it already)' : ''}`); continue; }
      kind.fields[fid] = field(f, fat, err);
    }
    kind.title = typeof k.title === 'string' && kind.fields[k.title] ? k.title : Object.keys(kind.fields).find((x) => kind.fields[x].type === 'text') ?? Object.keys(kind.fields)[0] ?? '';
    if (k.title !== undefined && k.title !== kind.title) err(`${at}.title "${k.title}" is not a field of ${kid}`);
    kind.seed = list(k.seed, `${at}.seed`, MAX.seed).filter((s: any, i: number) => (s && typeof s === 'object' && !Array.isArray(s) ? true : (err(`${at}.seed[${i}] must be an object of field values`), false)));
    sys.records.push(kind);
  }
  const kindOf = (id: string) => sys.records.find((k) => k.id === id);
  // Refs point at kinds that exist; seeds and enum values are checked once every kind is known.
  for (const k of sys.records) {
    for (const [fid, f] of Object.entries(k.fields)) if (f.type === 'ref' && !kindOf(f.ref ?? '')) err(`records.${k.id}.fields.${fid}: ref "${f.ref}" is not a record kind of this rule`);
    k.seed.forEach((s, i) => {
      for (const [fid, v] of Object.entries(s)) {
        const f = k.fields[fid];
        if (!f) { err(`records.${k.id}.seed[${i}].${fid} is not a field of ${k.id}`); continue; }
        if (f.type !== 'ref') { const e = fieldError(f, v); if (e) err(`records.${k.id}.seed[${i}].${fid}: ${e}`); }
      }
      for (const [fid, f] of Object.entries(k.fields)) if (!f.optional && f.default === undefined && f.type !== 'ref' && s[fid] === undefined) err(`records.${k.id}.seed[${i}] needs ${fid}`);
    });
    if (k.owned && k.seed.length) err(`records.${k.id}: a kind each player owns cannot have seed records`);
  }
  const fieldOf = (kid: string, fid: string) => kindOf(kid)?.fields[fid];
  const values = (kid: string, v: unknown, at: string, allowAsk = false) => {
    const out: Record<string, unknown> = {};
    if (v === undefined) return out;
    if (!v || typeof v !== 'object' || Array.isArray(v)) { err(`${at} must be an object of field: value`); return out; }
    for (const [fid, val] of Object.entries(v)) {
      const f = fieldOf(kid, fid);
      if (!f) { err(`${at}.${fid} is not a field of ${kid}`); continue; }
      if (typeof val === 'string' && val.startsWith('$')) { if (!ctx.hasOption(val.slice(1))) err(`${at}.${fid}: "${val}" is not an option of this rule`); }
      else if (!(allowAsk && val === 'ask')) { const e = fieldError(f, val); if (e) err(`${at}.${fid}: ${e}`); }
      out[fid] = val;
    }
    return out;
  };

  // ---- record actions
  const ids = new Set<string>();
  list(o.recordActions, 'recordActions', MAX.actions).forEach((a: any, i: number) => {
    const at = `recordActions[${i}]`;
    if (!a || typeof a !== 'object') { err(`${at} must be { id, label, by, record, do }`); return; }
    const aid = slug(a.id, `${at}.id`);
    if (aid && ids.has(aid)) err(`${at}.id "${aid}" is used twice`);
    ids.add(aid);
    const kid = typeof a.record === 'string' ? a.record : '';
    const k = kindOf(kid);
    if (!k) err(`${at}.record "${kid}" is not a record kind of this rule`);
    const op = OPS.includes(a.do) ? a.do as RecordOp : (err(`${at}.do must be one of ${OPS.join(', ')}`), 'set' as RecordOp);
    const ra: RecordAction = {
      id: aid, label: text(a.label, `${at}.label`, 40, true), by: WHO.includes(a.by) ? a.by : (err(`${at}.by must be one of ${WHO.join(', ')}`), 'dm'),
      record: kid, do: op, ask: [], set: k ? values(kid, a.set, `${at}.set`) : {}, where: k ? values(kid, a.where, `${at}.where`) : {},
    };
    ra.ask = list(a.ask, `${at}.ask`, MAX.fields).filter((f: unknown) => (typeof f === 'string' && k?.fields[f] ? true : (err(`${at}.ask: "${String(f)}" is not a field of ${kid}`), false)));
    if (op === 'add') {
      ra.field = typeof a.field === 'string' ? a.field : '';
      if (fieldOf(kid, ra.field ?? "")?.type !== 'int') err(`${at}.field must be a number field of ${kid}`);
      ra.amount = a.amount === 'ask' ? 'ask' : num(a.amount, `${at}.amount`, 1);
    }
    if (a.copy !== undefined) {
      const via = typeof a.copy?.via === 'string' ? a.copy.via : '';
      const ref = fieldOf(kid, via);
      if (op !== 'create') err(`${at}.copy only goes with do: "create"`);
      if (ref?.type !== 'ref') err(`${at}.copy.via must be a ref field of ${kid}`);
      const fields: Record<string, string> = {};
      for (const [mine, theirs] of Object.entries(a.copy?.fields ?? {})) {
        if (!fieldOf(kid, mine)) err(`${at}.copy.fields: "${mine}" is not a field of ${kid}`);
        else if (ref?.ref && typeof theirs === 'string' && !fieldOf(ref.ref, theirs) && !theirs.startsWith('$')) err(`${at}.copy.fields.${mine}: "${theirs}" is not a field of ${ref.ref}`);
        else fields[mine] = String(theirs);
      }
      ra.copy = { via, fields };
    }
    if (a.effect !== undefined) {
      const e = a.effect ?? {};
      for (const key of Object.keys(e)) if (key !== 'chat' && key !== 'dmnote') err(`${at}.effect.${key} is not an effect here (chat, dmnote)`);
      ra.effect = { ...(e.chat !== undefined ? { chat: text(e.chat, `${at}.effect.chat`, 300) } : {}), ...(e.dmnote !== undefined ? { dmnote: text(e.dmnote, `${at}.effect.dmnote`, 300) } : {}) };
    }
    for (const key of Object.keys(a)) if (!['id', 'label', 'by', 'record', 'do', 'ask', 'set', 'field', 'amount', 'copy', 'where', 'effect'].includes(key)) err(`${at}.${key} is not part of a record action`);
    sys.recordActions.push(ra);
  });
  const recAct = (id: string) => sys.recordActions.find((x) => x.id === id);

  // ---- prompts
  const promptIds = new Set<string>();
  list(o.prompts, 'prompts', MAX.prompts).forEach((p: any, i: number) => {
    const at = `prompts[${i}]`;
    if (!p || typeof p !== 'object') { err(`${at} must be { id, button, choices }`); return; }
    const pid = slug(p.id, `${at}.id`);
    if (pid && promptIds.has(pid)) err(`${at}.id "${pid}" is used twice`);
    promptIds.add(pid);
    const choices = list(p.choices, `${at}.choices`, MAX.choices).map((c: any, j: number) => {
      const cat = `${at}.choices[${j}]`;
      if (!c || typeof c !== 'object') { err(`${cat} must be { label, action } or { label, skip: true }`); return { label: '' }; }
      const ch: PromptChoice = { label: text(c.label, `${cat}.label`, 40, true) };
      if (c.skip === true) ch.skip = true;
      else {
        const ra = recAct(String(c.action ?? ''));
        if (!ra) err(`${cat}.action "${c.action}" is not a record action of this rule`);
        else if (ra.by === 'dm') err(`${cat}.action "${ra.id}" is the DM's; a player answers a prompt`);
        ch.action = String(c.action ?? '');
      }
      return ch;
    });
    if (!choices.length) err(`${at}.choices needs at least one choice`);
    sys.prompts.push({ id: pid, button: text(p.button, `${at}.button`, 30, true), title: text(p.title, `${at}.title`, 80) || text(p.button, `${at}.button`, 30), text: text(p.text, `${at}.text`, 300), choices });
  });

  // ---- timers
  list(o.timers, 'timers', MAX.timers).forEach((t: any, i: number) => {
    const at = `timers[${i}]`;
    if (!t || typeof t !== 'object') { err(`${at} must be { record, on, field, add, goal }`); return; }
    const kid = typeof t.record === 'string' ? t.record : '';
    if (!kindOf(kid)) err(`${at}.record "${kid}" is not a record kind of this rule`);
    const on = typeof t.on === 'string' && (WHEN.includes(t.on) || (t.on.startsWith('prompt:') && promptIds.has(t.on.slice(7)))) ? t.on as TimerOn : (err(`${at}.on must be ${WHEN.join(', ')} or "prompt:<prompt id>"`), 'longRest' as TimerOn);
    const fieldName = typeof t.field === 'string' ? t.field : '';
    if (kindOf(kid) && fieldOf(kid, fieldName)?.type !== 'int') err(`${at}.field must be a number field of ${kid}`);
    let goal: Num = 0;
    if (typeof t.goal === 'string' && !t.goal.startsWith('$')) { if (fieldOf(kid, t.goal)?.type !== 'int') err(`${at}.goal "${t.goal}" is not a number field of ${kid}`); goal = t.goal; }
    else goal = num(t.goal, `${at}.goal`, 1);
    sys.timers.push({
      id: typeof t.id === 'string' && SLUG.test(t.id) ? t.id : `timer-${i + 1}`, record: kid, on, where: kindOf(kid) ? values(kid, t.where, `${at}.where`) : {},
      field: fieldName, add: num(t.add, `${at}.add`, 1), goal,
      done: { set: kindOf(kid) ? values(kid, t.done?.set, `${at}.done.set`) : {}, ...(t.done?.chat !== undefined ? { chat: text(t.done.chat, `${at}.done.chat`, 300) } : {}) },
    });
  });

  // ---- views
  list(o.views, 'views', MAX.views).forEach((v: any, i: number) => {
    const at = `views[${i}]`;
    if (!v || typeof v !== 'object') { err(`${at} must be { title, record, place, columns }`); return; }
    const kid = typeof v.record === 'string' ? v.record : '';
    const k = kindOf(kid);
    if (!k) err(`${at}.record "${kid}" is not a record kind of this rule`);
    const place = PLACES.includes(v.place) ? v.place as ViewPlace : (err(`${at}.place must be one of ${PLACES.join(', ')} (dm: a tab on the DM's House rules page, sheet: a card on the player's home, player: the player's House rules page)`), 'dm' as ViewPlace);
    const columns = list(v.columns, `${at}.columns`, 8).filter((c: unknown) => (typeof c === 'string' && (k?.fields[c] || ['player', 'createdAt', 'updatedAt'].includes(c)) ? true : (err(`${at}.columns: "${String(c)}" is not a field of ${kid}`), false)));
    const actions = list(v.actions, `${at}.actions`, 8).filter((a: unknown) => { const ra = recAct(String(a)); if (!ra) { err(`${at}.actions: "${String(a)}" is not a record action of this rule`); return false; } if (ra.record !== kid) { err(`${at}.actions: "${ra.id}" works on ${ra.record}, not ${kid}`); return false; } return true; });
    sys.views.push({ id: typeof v.id === 'string' && SLUG.test(v.id) ? v.id : `view-${i + 1}`, title: text(v.title, `${at}.title`, 40, true), record: kid, place, columns: columns.length ? columns : k ? [k.title] : [], where: k ? values(kid, v.where, `${at}.where`) : {}, actions, groupByPlayer: v.groupByPlayer === true });
  });

  // ---- chat text: every {placeholder} must name something the record has
  const placeholders = (tpl: string | undefined, kid: string, at: string) => {
    const k = kindOf(kid);
    if (!tpl || !k) return;
    for (const [, a, b] of tpl.matchAll(/\{([a-zA-Z][a-zA-Z0-9-]*)(?:\.([a-zA-Z][a-zA-Z0-9-]*))?\}/g)) {
      if (!b) { if (!['name', 'player', 'title', 'note', ...BUILTIN_FIELDS].includes(a) && !k.fields[a]) err(`${at}: {${a}} is not a field of ${kid} (use {name} for the player's character, {${kid}.field} or {field} for its own fields)`); continue; }
      const target = a === kid && k.fields[a]?.type !== 'ref' ? k : k.fields[a]?.type === 'ref' ? kindOf(k.fields[a].ref!) : undefined;
      if (!target) err(`${at}: {${a}.${b}}: ${a} is not a ref field of ${kid} (write {${kid}.${b}} for its own field)`);
      else if (!target.fields[b] && !BUILTIN_FIELDS.includes(b)) err(`${at}: {${a}.${b}}: ${b} is not a field of ${target.id}`);
    }
  };
  sys.recordActions.forEach((ra, i) => { placeholders(ra.effect?.chat, ra.record, `recordActions[${i}].effect.chat`); placeholders(ra.effect?.dmnote, ra.record, `recordActions[${i}].effect.dmnote`); });
  sys.timers.forEach((t, i) => placeholders(t.done.chat, t.record, `timers[${i}].done.chat`));

  return sys;
}

function field(f: any, at: string, err: Err): Field {
  if (typeof f === 'string') {
    const optional = f.endsWith('?');
    const s = optional ? f.slice(0, -1) : f;
    if (s.startsWith('enum:')) { const values = s.slice(5).split('|').map((x) => x.trim()).filter(Boolean); if (!values.length) err(`${at}: enum needs values, like "enum:common|rare"`); return { type: 'enum', label: '', optional, values }; }
    if (s.startsWith('ref:')) return { type: 'ref', label: '', optional, ref: s.slice(4) };
    if (['text', 'int', 'bool'].includes(s)) return { type: s as FieldType, label: '', optional };
    err(`${at}: "${f}" is not a field type (text, int, bool, enum:a|b, ref:kind; add ? for optional)`);
    return { type: 'text', label: '', optional: true };
  }
  if (!f || typeof f !== 'object') { err(`${at} must be a type like "text" or { type, label }`); return { type: 'text', label: '', optional: true }; }
  const type = ['text', 'int', 'bool', 'enum', 'ref'].includes(f.type) ? f.type as FieldType : (err(`${at}.type must be text, int, bool, enum or ref`), 'text' as FieldType);
  const out: Field = { type, label: typeof f.label === 'string' ? f.label.slice(0, 40) : '', optional: f.optional === true };
  if (type === 'enum') { out.values = Array.isArray(f.values) ? f.values.filter((x: unknown) => typeof x === 'string').slice(0, 20) : []; if (!out.values!.length) err(`${at}.values must list the choices`); }
  if (type === 'ref') out.ref = typeof f.ref === 'string' ? f.ref : '';
  if (type === 'int') { if (Number.isInteger(f.min)) out.min = f.min; if (Number.isInteger(f.max)) out.max = f.max; }
  if (f.default !== undefined) { const e = fieldError(out, f.default); if (e) err(`${at}.default: ${e}`); else out.default = f.default; }
  return out;
}

/** Why `v` does not fit the field, or '' when it does. */
export function fieldError(f: Field, v: unknown): string {
  if (v === null || v === undefined || v === '') return f.optional || f.default !== undefined ? '' : 'is required';
  switch (f.type) {
    case 'text': return typeof v === 'string' && v.length <= 2000 ? '' : 'must be text (up to 2000 characters)';
    case 'int': return Number.isInteger(v) && (f.min === undefined || (v as number) >= f.min) && (f.max === undefined || (v as number) <= f.max) ? '' : `must be a whole number${f.min !== undefined ? ` from ${f.min}` : ''}${f.max !== undefined ? ` to ${f.max}` : ''}`;
    case 'bool': return typeof v === 'boolean' ? '' : 'must be true or false';
    case 'enum': return typeof v === 'string' && f.values!.includes(v) ? '' : `must be one of ${f.values!.join(', ')}`;
    case 'ref': return typeof v === 'string' && v.length <= 60 ? '' : 'must be the id of a record';
  }
}

export const hasSystem = (s: System) => s.records.length > 0;
