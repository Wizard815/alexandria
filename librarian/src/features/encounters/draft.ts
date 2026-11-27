// Draft an encounter from the DM's description with the world's chat model
// (a local model through Argos in most setups). The model's script goes
// through parseScript like anything a DM saves; when there is no model, or it
// returns nothing usable, the DM gets a simple one-step draft built from
// their own words to edit by hand.
import type { Deps } from '../../app.ts';
import { chatJson, hasJob, type ChatMessage } from '../../core/ai.ts';
import { GAMES, LIMITS, PLACES, cleanPlaces, parseScript, quickScript, type EncounterKind, type Place, type Script } from './script.ts';

export interface EncounterDraft { name: string; npcName: string; npcBlurb: string; script: Script; usedModel: boolean; note: string | null; kind: EncounterKind; places: Place[] }
export interface DraftOptions { kind?: EncounterKind; guide?: string; places?: Place[] }

const SYSTEM = [
  'You write short NPC encounters for the tabletop campaign app Alexandria. An NPC walks up to ONE player character and a small talk plays out on their phone, a few taps long.',
  'Return one JSON object: {"name": "short title", "npcName": "...", "npcBlurb": "one line on how they look", "script": {"start": "step id", "nodes": [...]}}.',
  'Each node: {"id": "short-id", "text": "what the NPC says, in quotes, with a little action", "options": [{"label": "what the player says or does", "next": "another node id, or null to end", "effects": [...]}], "game": null}.',
  `Effects (optional, at most 3 per option): {"kind": "gold", "cp": copper} (keep it small: 1 to 100 copper), {"kind": "item", "name": "a simple mundane item", "qty": 1}, {"kind": "shop", "shopId": ""} to show their wares.`,
  `A node may hold a game instead of plain options: {"kind": one of ${GAMES.join(', ')}, "stakeCp": 0-50, "winCp": 0-100, "dc": 12 (check only; add "dcMax": 15 to pick the DC from a range), "skill": "Athletics" (check only), "win": "node id", "lose": "node id"}; such a node can still have a "walk away" option.`,
  'Use 2 to 6 nodes and 2 or 3 options per node. Every "next", "win" and "lose" must be a node id in the list. Never invent campaign facts beyond what the DM wrote; keep secrets out of what the NPC says unless the DM asked for them.',
].join('\n');

const EVENT_SYSTEM = [
  'You write QUICK EVENTS for the tabletop campaign app Alexandria: something small that happens to ONE player character, played out in a few taps on their phone. Not a long talk: a moment with a choice. Examples: a pickpocket grabs their purse (chase them? and if caught, keep the coin or give it back?); they notice an undervalued gem on a stall; a rope bridge creaks; a shrine holds offerings.',
  'Return one JSON object: {"name": "short title", "npcName": "who or what it is about (A pickpocket, A rope bridge)", "npcBlurb": "one line on the scene", "places": [where it fits, from: ' + PLACES.join(', ') + '], "script": {"start": "step id", "nodes": [...]}}.',
  'Each node: {"id": "short-id", "text": "what happens, in second person, one or two sentences", "options": [{"label": "what the player does", "next": "another node id, or null to end", "effects": [...]}], "game": null}.',
  'Effects (optional, at most 3 per option): {"kind": "gold", "cp": copper} the player gains (keep it small: 1 to 100 copper), {"kind": "pay", "cp": copper} they pay for something, {"kind": "lose", "cp": copper} they lose (stolen, spilled), {"kind": "item", "name": "a simple item", "qty": 1, "note": "what it is worth or does"}, {"kind": "dmnote", "text": "a consequence only the DM sees, e.g. Kept the stolen purse; the thieves remember"}.',
  `A node may hold a skill check instead of plain options: {"kind": "check", "skill": "Perception", "dc": 10, "dcMax": 14 (a range; the DC is picked from it when the player rolls, so give a spread of 3 to 6), "stakeCp": 0, "winCp": 0, "win": "node id", "lose": "node id"}.`,
  'A node that needs a quick answer (a thief running off, a plank cracking) may have a timer: "timer": {"secs": 10-60, "fallback": the index of the option picked for them when time runs out, or -1 on a check node to fail it}. Only time the moments that are really urgent; most nodes have none.',
  'Use 2 to 5 nodes. Give the player a real choice with a consequence (honest or greedy, bold or careful) and put each consequence in a dmnote. Every "next", "win" and "lose" must be a node id in the list. Never invent campaign facts beyond what the DM wrote.',
].join('\n');

/** A one-step draft from the DM's own words: the first sentence as the line, two plain answers. */
export function fallbackDraft(prompt: string, kind: EncounterKind = 'npc', places: Place[] = []): EncounterDraft {
  const p = prompt.trim().replace(/\s+/g, ' ');
  const name = (p.split(/[.!?]/)[0] || (kind === 'event' ? 'New quick event' : 'New encounter')).slice(0, 60);
  if (kind === 'event') {
    const where = places.length ? places : cleanPlaces(p.toLowerCase().match(/[a-z]+(?: road)?/g) ?? []);
    return { name, npcName: name.slice(0, 80), npcBlurb: p.slice(0, 300), script: quickScript(p.slice(0, LIMITS.text) || 'Something happens.', ['Deal with it', 'Ignore it']), usedModel: false, note: null, kind, places: where };
  }
  return { name, npcName: 'A stranger', npcBlurb: p.slice(0, 300), script: quickScript('"Excuse me, have you a moment?"', ['Of course', 'Not now']), usedModel: false, note: null, kind, places };
}

/**
 * Local models often get the links slightly wrong. Fix what can be fixed
 * without guessing at meaning: ids made safe, a link to a step that does not
 * exist ends the talk instead, and a game's missing win/lose step is the
 * start. Anything else still has to pass parseScript.
 */
export function repair(v: any): any {
  if (!v || typeof v !== 'object' || !Array.isArray(v.nodes)) return v;
  const safe = (x: unknown) => String(x ?? '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const nodes = v.nodes.filter((n: any) => n && typeof n === 'object').slice(0, LIMITS.nodes).map((n: any, i: number) => ({ ...n, id: safe(n.id) || `step-${i + 1}` }));
  const ids = new Set(nodes.map((n: any) => n.id));
  const link = (x: unknown) => { const id = x ? safe(x) : ''; return id && ids.has(id) ? id : null; };
  const start = link(v.start) ?? nodes[0]?.id;
  for (const n of nodes) {
    if (Array.isArray(n.options)) n.options = n.options.slice(0, LIMITS.options).map((o: any) => (o && typeof o === 'object' ? { ...o, next: link(o.next), effects: Array.isArray(o.effects) ? o.effects.slice(0, LIMITS.effects) : [] } : o));
    if (n.game && typeof n.game === 'object') n.game = { ...n.game, win: link(n.game.win) ?? start, lose: link(n.game.lose) ?? start };
  }
  return { start, nodes };
}

export async function draftEncounter(d: Deps, prompt: string, worldName: string, o: DraftOptions = {}): Promise<EncounterDraft> {
  const kind = o.kind ?? 'npc';
  const base = fallbackDraft(prompt, kind, o.places ?? []);
  if (!hasJob(d, 'chat')) return { ...base, note: 'No chat model is set up, so this is a plain starting point to edit.' };
  const messages: ChatMessage[] = [
    { role: 'system', content: kind === 'event' ? EVENT_SYSTEM : SYSTEM },
    ...(o.guide ? [{ role: 'system' as const, content: o.guide.slice(0, 4000) }] : []),
    { role: 'user', content: `World: ${worldName.slice(0, 100)}${o.places?.length ? `\nPlaces it should fit: ${o.places.join(', ')}` : ''}\nThe DM wants:\n${prompt.slice(0, 3000)}` },
  ];
  const j: any = await chatJson(d, 'chat', messages, undefined, { maxTokens: 2500 }).catch(() => null);
  if (!j || typeof j !== 'object') return { ...base, note: 'The model gave no usable answer, so this is a plain starting point to edit.' };
  try {
    const script = parseScript(repair(j.script ?? (Array.isArray(j.nodes) ? j : null)));
    if (script.nodes.length > LIMITS.nodes) throw new Error('too long');
    const s = (v: unknown, max: number, dflt: string) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : dflt);
    const places = o.places?.length ? o.places : cleanPlaces(j.places).length ? cleanPlaces(j.places) : base.places;
    return { name: s(j.name, 120, base.name), npcName: s(j.npcName, 80, kind === 'event' ? s(j.name, 80, base.npcName) : 'A stranger'), npcBlurb: s(j.npcBlurb, 300, ''), script, usedModel: true, note: null, kind, places };
  } catch (e: any) {
    return { ...base, note: `The model's draft did not hold together (${String(e?.message ?? e).slice(0, 120)}), so this is a plain starting point to edit.` };
  }
}

// ---------------- fill in the blanks ----------------

const FILL_SYSTEM = [
  'You help a DM finish a half-written event for the tabletop campaign app Alexandria. You get the event as JSON: steps ("nodes") with what happens ("text"), the player\'s answers ("options", each with "label", "next" and "effects") and sometimes a skill check ("game").',
  'Fill in ONLY what is empty: an empty "text", an empty answer "label", a check with no "skill", an item with no "name", a DM note ("dmnote") with no "text", and the "name", "npcName" or "npcBlurb" when they are empty. A step with no answers and no check may get 2 or 3 answers. An answer with no effects may get one small effect if it clearly fits (a DM note for a consequence, a little coin).',
  'Keep every field that already has a value exactly as it is. Keep every step id, every "next", "win" and "lose" link, and the order of the answers. Do not add or remove steps. Never invent campaign facts beyond what the DM wrote.',
  'Effects: {"kind": "gold", "cp": 1-100}, {"kind": "pay", "cp": n}, {"kind": "lose", "cp": n}, {"kind": "item", "name": "...", "qty": 1, "note": "..."}, {"kind": "dmnote", "text": "a consequence only the DM sees"}.',
  'Return the whole event as one JSON object: {"name": "...", "npcName": "...", "npcBlurb": "...", "script": {"start": "...", "nodes": [...]}}.',
].join('\n');

export interface FillInput { script: any; name?: string; npcName?: string; npcBlurb?: string; kind?: EncounterKind; hint?: string; step?: string | null }
export interface FillResult { script: any; name: string; npcName: string; npcBlurb: string; filled: number; usedModel: boolean; note: string | null }

const blank = (v: unknown) => typeof v !== 'string' || !v.trim();
const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** The DM's half-written script in a safe shape: nothing required, nothing longer than the limits. */
export function looseScript(v: any): any {
  const nodes = (Array.isArray(v?.nodes) ? v.nodes : []).slice(0, LIMITS.nodes).filter((n: any) => n && typeof n === 'object' && typeof n.id === 'string').map((n: any) => ({
    ...n,
    text: typeof n.text === 'string' ? n.text.slice(0, LIMITS.text) : '',
    options: (Array.isArray(n.options) ? n.options : []).slice(0, LIMITS.options).filter((o: any) => o && typeof o === 'object').map((o: any) => ({
      label: typeof o.label === 'string' ? o.label.slice(0, LIMITS.label) : '', next: typeof o.next === 'string' && o.next ? o.next : null,
      effects: (Array.isArray(o.effects) ? o.effects : []).slice(0, LIMITS.effects).filter((e: any) => e && typeof e === 'object'),
    })),
    game: n.game && typeof n.game === 'object' ? n.game : null,
  }));
  return { start: typeof v?.start === 'string' ? v.start : nodes[0]?.id ?? '', nodes };
}

const fillEffect = (e: any, m: any): [any, boolean] => {
  if (!m || typeof m !== 'object' || m.kind !== e.kind) return [e, false];
  if (e.kind === 'item' && blank(e.name) && str(m.name, LIMITS.label)) return [{ ...e, name: str(m.name, LIMITS.label), ...(blank(e.note) && str(m.note, 200) ? { note: str(m.note, 200) } : {}) }, true];
  if (e.kind === 'dmnote' && blank(e.text) && str(m.text, 300)) return [{ ...e, text: str(m.text, 300) }, true];
  return [e, false];
};

/** A small effect the model added to an answer that had none, if it is one of the plain kinds and in bounds. */
const newEffect = (m: any): any | null => {
  if (!m || typeof m !== 'object') return null;
  const cp = Number(m.cp);
  if ((m.kind === 'gold' || m.kind === 'pay' || m.kind === 'lose') && Number.isInteger(cp) && cp >= 1 && cp <= 100) return { kind: m.kind, cp };
  if (m.kind === 'dmnote' && str(m.text, 300)) return { kind: 'dmnote', text: str(m.text, 300) };
  if (m.kind === 'item' && str(m.name, LIMITS.label)) return { kind: 'item', name: str(m.name, LIMITS.label), qty: 1, ...(str(m.note, 200) ? { note: str(m.note, 200) } : {}) };
  return null;
};

/**
 * Take what the model filled in, but only into the blanks: every value the DM wrote stays, no step is added or
 * removed, and links only point at steps that exist. With step, only that step is touched. Returns how many blanks
 * were filled.
 */
export function mergeFill(orig: any, model: any, step: string | null = null): { script: any; filled: number } {
  const s = looseScript(orig);
  const ids = new Set<string>(s.nodes.map((n: any) => n.id));
  const by = new Map<string, any>((Array.isArray(model?.nodes) ? model.nodes : []).filter((n: any) => n && typeof n === 'object').map((n: any) => [String(n.id), n]));
  let filled = 0;
  const nodes = s.nodes.map((n: any) => {
    const m = by.get(n.id);
    if (!m || (step && n.id !== step)) return n;
    const out = { ...n };
    if (blank(n.text) && str(m.text, LIMITS.text)) { out.text = str(m.text, LIMITS.text); filled++; }
    const mo: any[] = Array.isArray(m.options) ? m.options : [];
    if (!n.options.length && !n.game && mo.length) {
      out.options = mo.slice(0, 3).map((o: any) => ({ label: str(o?.label, LIMITS.label), next: typeof o?.next === 'string' && ids.has(o.next) ? o.next : null, effects: (Array.isArray(o?.effects) ? o.effects : []).map(newEffect).filter(Boolean).slice(0, 1) })).filter((o: any) => o.label);
      filled += out.options.length;
    } else {
      out.options = n.options.map((o: any, j: number) => {
        const p = mo[j];
        if (!p || typeof p !== 'object') return o;
        const q = { ...o };
        if (blank(o.label) && str(p.label, LIMITS.label)) { q.label = str(p.label, LIMITS.label); filled++; }
        const pe: any[] = Array.isArray(p.effects) ? p.effects : [];
        if (o.effects.length) q.effects = o.effects.map((e: any, k: number) => { const [v, did] = fillEffect(e, pe[k]); if (did) filled++; return v; });
        else { const add = pe.map(newEffect).filter(Boolean).slice(0, 1); if (add.length) { q.effects = add; filled++; } }
        return q;
      });
    }
    if (n.game && n.game.kind === 'check' && blank(n.game.skill) && str(m.game?.skill, 40)) { out.game = { ...n.game, skill: str(m.game.skill, 40) }; filled++; }
    return out;
  });
  return { script: { ...s, nodes }, filled };
}

/** Fill the blanks of a half-written event (or one step of it) with the chat model; the DM's own words stay. */
export async function fillEncounter(d: Deps, worldName: string, o: FillInput): Promise<FillResult> {
  const kind = o.kind ?? 'npc';
  const s = looseScript(o.script);
  const keep = { name: o.name ?? '', npcName: o.npcName ?? '', npcBlurb: o.npcBlurb ?? '' };
  const none = (note: string): FillResult => ({ script: s, ...keep, filled: 0, usedModel: false, note });
  if (!s.nodes.length) return none('There is nothing to fill in yet: add a step first.');
  if (!hasJob(d, 'chat')) return none('No chat model is set up, so nothing was filled in.');
  const messages: ChatMessage[] = [
    { role: 'system', content: FILL_SYSTEM },
    { role: 'user', content: [
      `World: ${worldName.slice(0, 100)}`,
      `This is ${kind === 'event' ? 'a quick event that happens to a player' : 'an NPC encounter'}.`,
      o.step ? `Fill in only the step "${o.step}"; leave the other steps as they are.` : '',
      o.hint ? `The DM adds: ${o.hint.slice(0, 500)}` : '',
      JSON.stringify({ ...keep, script: s }).slice(0, 12_000),
    ].filter(Boolean).join('\n') },
  ];
  const j: any = await chatJson(d, 'chat', messages, undefined, { maxTokens: 2500 }).catch(() => null);
  if (!j || typeof j !== 'object') return { ...none('The model gave no usable answer, so nothing was filled in.'), usedModel: true };
  const { script, filled } = mergeFill(s, j.script ?? (Array.isArray(j.nodes) ? j : null), o.step ?? null);
  const head = o.step ? keep : {
    name: keep.name.trim() ? keep.name : str(j.name, 120) ?? keep.name,
    npcName: keep.npcName.trim() ? keep.npcName : str(j.npcName, 80) ?? keep.npcName,
    npcBlurb: keep.npcBlurb.trim() ? keep.npcBlurb : str(j.npcBlurb, 300) ?? keep.npcBlurb,
  };
  const more = (['name', 'npcName', 'npcBlurb'] as const).filter((k) => head[k] !== keep[k]).length;
  return { script, ...head, filled: filled + more, usedModel: true, note: filled + more ? null : 'The model left everything as it was.' };
}
