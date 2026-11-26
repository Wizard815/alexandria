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
  `A node may hold a game instead of plain options: {"kind": one of ${GAMES.join(', ')}, "stakeCp": 0-50, "winCp": 0-100, "dc": 10-15 (check only), "skill": "Athletics" (check only), "win": "node id", "lose": "node id"}; such a node can still have a "walk away" option.`,
  'Use 2 to 6 nodes and 2 or 3 options per node. Every "next", "win" and "lose" must be a node id in the list. Never invent campaign facts beyond what the DM wrote; keep secrets out of what the NPC says unless the DM asked for them.',
].join('\n');

const EVENT_SYSTEM = [
  'You write QUICK EVENTS for the tabletop campaign app Alexandria: something small that happens to ONE player character, played out in a few taps on their phone. Not a long talk: a moment with a choice. Examples: a pickpocket grabs their purse (chase them? and if caught, keep the coin or give it back?); they notice an undervalued gem on a stall; a rope bridge creaks; a shrine holds offerings.',
  'Return one JSON object: {"name": "short title", "npcName": "who or what it is about (A pickpocket, A rope bridge)", "npcBlurb": "one line on the scene", "places": [where it fits, from: ' + PLACES.join(', ') + '], "script": {"start": "step id", "nodes": [...]}}.',
  'Each node: {"id": "short-id", "text": "what happens, in second person, one or two sentences", "options": [{"label": "what the player does", "next": "another node id, or null to end", "effects": [...]}], "game": null}.',
  'Effects (optional, at most 3 per option): {"kind": "gold", "cp": copper} the player gains (keep it small: 1 to 100 copper), {"kind": "pay", "cp": copper} they pay for something, {"kind": "lose", "cp": copper} they lose (stolen, spilled), {"kind": "item", "name": "a simple item", "qty": 1, "note": "what it is worth or does"}, {"kind": "dmnote", "text": "a consequence only the DM sees, e.g. Kept the stolen purse; the thieves remember"}.',
  `A node may hold a skill check instead of plain options: {"kind": "check", "skill": "Perception", "dc": 10-15, "stakeCp": 0, "winCp": 0, "win": "node id", "lose": "node id"}.`,
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
