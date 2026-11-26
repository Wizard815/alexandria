// House rules and the assistant: when a message to the DM's assistant or a player's helper is about a rule that is
// on (its name, its counters, its record kinds, its prompt button, or the words its `assistant` part lists), the
// harness adds a short note to the context: what the rule is, the rule's own guidance for that person (the DM's text
// only to the DM, the player's only to players), the exact tool calls they can make with it, and the records and
// counters they may see (a player: shared lists and their own). It also offers the house rule tools, plus any
// feature tools the rule names (the Codex's study tools for a spell rule). Nothing here needs code in the rule.
import type { DB } from '../../core/db.ts';
import { names as accountNames } from '../../routes/_shared.ts';
import { counters, enabledMods, playerIds, type Installed } from './store.ts';
import { listRecords, type Rec } from './recstore.ts';
import type { RecordKind } from './system.ts';

export interface RuleHints { tools: string[]; text: string; mods: string[] }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The words that bring a rule up: its own list, then its name, counters, record kinds, prompt buttons, chat words and terms. */
export function ruleWords(m: Installed): string[] {
  const mod = m.mod;
  const w = new Set<string>(mod.assistant?.words ?? []);
  const add = (s: string | undefined) => { const t = (s ?? '').trim().toLowerCase(); if (t.length >= 4) w.add(t); };
  add(mod.name); add(mod.id.replace(/-/g, ' '));
  for (const r of mod.resources) add(r.label);
  for (const k of mod.system.records) { add(k.label); add(k.plural); }
  for (const p of mod.system.prompts) add(p.button);
  for (const c of mod.commands) add(`/${c.word}`);
  for (const r of mod.rules) add(r.term.replace(/\s*\(house rule\)\s*$/i, ''));
  return [...w];
}

export function ruleMatches(m: Installed, text: string): boolean {
  const t = text.toLowerCase();
  return ruleWords(m).some((w) => new RegExp(`(^|[^a-z0-9])${esc(w)}`, 'i').test(t));
}

const fieldHint = (k: RecordKind, f: string) => {
  const s = k.fields[f];
  if (!s) return f;
  return s.type === 'enum' ? `${f}: one of ${s.values!.join(' | ')}` : s.type === 'ref' ? `${f}: the id of a ${s.ref}` : `${f}: ${s.type}`;
};
/** A record in one line; a ref field shows the title of the record it points at (a task shows its activity's name). */
const short = (k: RecordKind, r: Rec, nm: Record<string, string>, withPlayer: boolean, titleOf: (id: unknown) => string | null) => {
  const show = (f: string) => (k.fields[f]?.type === 'ref' ? titleOf(r[f]) : null) ?? String(r[f] ?? '-');
  const rest = Object.keys(k.fields).filter((f) => f !== k.title).slice(0, 4).map((f) => `${f} ${show(f)}`).join(', ');
  return `${withPlayer && r.player ? `${nm[r.player] ?? 'a player'}: ` : ''}${r[k.title] !== undefined ? show(k.title) : r.id} (id ${r.id}${rest ? `; ${rest}` : ''})`;
};

/** One rule's note for this person. */
function ruleNote(db: DB, worldId: string, m: Installed, dm: boolean, accountId: string, nm: Record<string, string>): { text: string; tools: string[] } {
  const mod = m.mod;
  const L: string[] = [`House rule "${mod.name}" (mod id ${mod.id}) is on at this table.${mod.summary ? ` ${mod.summary}` : ''}`];
  const guide = dm ? mod.assistant?.dm : mod.assistant?.player;
  if (guide) L.push(guide);
  const tools = new Set<string>(['house_rules', ...(mod.assistant?.tools ?? [])]);
  const can = (by: string) => dm || by !== 'dm';
  const calls: string[] = [];
  const recordKinds = new Map(mod.system.records.map((k) => [k.id, k]));
  for (const a of mod.actions.filter((x) => can(x.by))) {
    if (dm) { calls.push(`house_rule_grant {"mod":"${mod.id}","action":"${a.id}","player":"<name>"${a.resource === '*' ? ',"resource":"<' + mod.resources.map((r) => r.id).join('|') + '>"' : ''},"note":"<why>"}: ${a.label}`); tools.add('house_rule_grant'); }
    else if (a.by !== 'dm') { calls.push(`house_rule_spend {"mod":"${mod.id}","action":"${a.id}"}: ${a.label}`); tools.add('house_rule_spend'); }
  }
  for (const ra of mod.system.recordActions.filter((x) => can(x.by))) {
    const k = recordKinds.get(ra.record)!;
    const tool = dm ? 'house_rule_record_act' : 'house_rule_my_record';
    tools.add(tool);
    const parts = [`"mod":"${mod.id}"`, `"action":"${ra.id}"`];
    if (ra.do !== 'create') parts.push(`"recordId":"<${k.label.toLowerCase()} id>"`);
    if (dm && ra.do === 'create' && k.owned) parts.push('"player":"<name>"');
    if (ra.ask.length) parts.push(`"values":{${ra.ask.map((f) => `"${f}":<${fieldHint(k, f)}>`).join(',')}}`);
    if (ra.do === 'add' && ra.amount === 'ask') parts.push('"amount":<number, negative takes away>');
    const by = ra.by === 'owner' ? (k.owned ? ' (on their own)' : '') : ra.by === 'dm' ? ' (DM)' : '';
    calls.push(`${tool} {${parts.join(',')}}: ${ra.label}${by}${Object.keys(ra.where).length ? `, only while ${Object.entries(ra.where).map(([f, v]) => `${f} is ${v}`).join(' and ')}` : ''}`);
  }
  if (dm) for (const p of mod.system.prompts) { calls.push(`house_rule_prompt {"mod":"${mod.id}","prompt":"${p.id}"}: the ${p.button} button (every player is asked: ${p.choices.map((c) => c.label).join(' / ')})`); tools.add('house_rule_prompt'); }
  if (calls.length) L.push(`${dm ? 'You can' : 'This player can'}:\n${calls.slice(0, 14).map((c) => `- ${c}`).join('\n')}`);
  // What they may see now.
  const seen = new Map<string, { k: RecordKind; rows: Rec[] }>();
  for (const k of mod.system.records) seen.set(k.id, { k, rows: listRecords(db, worldId, m, k.id, { ...(!dm && k.owned ? { player: accountId } : {}), limit: 40 }) });
  const byId = new Map<string, string>();
  for (const { k, rows } of seen.values()) for (const r of rows) byId.set(r.id, String(r[k.title] ?? r.id));
  const titleOf = (id: unknown) => (typeof id === 'string' ? byId.get(id) ?? null : null);
  for (const { k, rows } of seen.values()) {
    if (!rows.length) continue;
    tools.add('house_rule_records');
    const head = k.owned ? (dm ? `${k.plural} (by player)` : `Their ${k.plural.toLowerCase()}`) : k.plural;
    L.push(`${head}: ${rows.slice(0, 14).map((r) => short(k, r, nm, dm && k.owned, titleOf)).join('; ')}${rows.length > 14 ? `; and ${rows.length - 14} more (house_rule_records)` : ''}`);
  }
  if (mod.resources.length) {
    tools.add('house_rule_counters');
    const who = dm ? playerIds(db, worldId) : [accountId];
    const lines = who.map((a) => { const cs = counters(db, worldId, m, a); return cs.length ? `${dm ? `${nm[a] ?? a}: ` : ''}${cs.map((c) => `${c.label} ${c.value}${c.max !== null ? `/${c.max}` : ''}`).join(', ')}` : ''; }).filter(Boolean).slice(0, 8);
    if (lines.length) L.push(`${dm ? 'Counters' : 'Their counters'}: ${lines.join('; ')}`);
  }
  return { text: L.join('\n'), tools: [...tools] };
}

/** The notes and tools for a message, for the DM (`dm`) or a player (`accountId`). At most three rules, about 3,500 characters. */
export function ruleHints(db: DB, worldId: string, text: string, dm: boolean, accountId: string): RuleHints {
  let on: Installed[] = [];
  try { on = enabledMods(db, worldId); } catch { return { tools: [], text: '', mods: [] }; }
  const hit = on.filter((m) => ruleMatches(m, text)).slice(0, 3);
  if (!hit.length) return { tools: [], text: '', mods: [] };
  const nm = accountNames(db, worldId);
  if (dm) for (const k of Object.keys(nm)) if (k === accountId) delete nm[k];
  const notes = hit.map((m) => ruleNote(db, worldId, m, dm, accountId, nm));
  let body = notes.map((n) => n.text).join('\n\n');
  if (body.length > 3500) body = body.slice(0, 3490) + ' ...';
  return { tools: [...new Set(notes.flatMap((n) => n.tools))], text: `House rules this is about (the ids are for tool calls; say names, not ids, to people):\n${body}`, mods: hit.map((m) => m.mod.id) };
}
