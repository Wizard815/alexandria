// The two harnesses over one chat model (PLAN §6.3). The harness decides
// what the model is given and what it may do:
//
//   GM harness      GM copies and GM transcript lines; every MCP tool; a
//                   write tool becomes a pending action the GM confirms.
//   Player harness  player copies and the players' transcript only; read
//                   tools only; the reply passes the leak check, one
//                   sentence at a time while it streams.
//
// Tools run against the librarian's own world API over loopback HTTP with
// the caller's own token (as routes/mcpServer.ts does), so the normal
// visibility rules apply and the player harness never holds a GM token.
//
// Speed: the static system prompt goes first (so a server can cache it); the
// per-message context (library matches, the page on screen, combat, the
// date) rides in the user message, so most questions are answered in one
// model round. Only the tools that fit the message are offered. Replies
// stream to the owner as 'agent' events. Obvious commands run with no model.
import { characterPart } from '../playerhelp/quick.ts';
import type { Deps } from '../../app.ts';
import { chatStream, hasJob, jobConfig, rerankItems, ModelPreempted, ModelUnavailable, type ChatMessage, type ChatTool } from '../../core/ai.ts';
import { all, one, run } from '../../core/db.ts';
import { gmOnly, only } from '../../core/events.ts';
import type { Viewer, WorldSettings } from '../../core/policy.ts';
import { featureSetting } from '../../core/policy.ts';
import { now, parseJson, id } from '../../core/util.ts';
import type { McpTool } from '../types.ts';
import { getClock } from '../clock/api.ts';
import { listSessions, sessionLines } from '../audio/api.ts';
import { worldModules } from '../modules/store.ts';
import { findMatches } from '../modules/match.ts';
import { latestSummary } from '../audio/summary.ts';
import { ruleNotes } from '../audio/rulescheck.ts';
import { GM_CORE_TOOLS, fastPlan, matchCombatant, searchTerms, selectTools, type FastPlan } from './intent.ts';
import { agentOptions } from './options.ts';
import { CONCISE } from './descriptions.ts';
import { nearestTools } from './toolselect.ts';
import { semanticPages } from '../search/embeddings.ts';
import { MORE_TOOLS_TOOL, claimsChange, describeTools, matchTools, rewriteClaim } from './moretools.ts';
import { BLOCKED_REPLY, SentenceGate, leakChecker, treeText } from './leak.ts';
import { LOOKING } from '../sourcekeys/escalation.ts';
import { actionView, clearPartial, finishMessage, setPartial, type Citation, type Timings } from './store.ts';
import { AUTO_NEVER, runsWithoutAsking } from './auto.ts';
import { HISTORY_WINDOW, summarizeLater } from './summary.ts';
import { sourceSummary } from '../connections/summary.ts';
import { readOnOpen, readSearchHits } from '../connections/ondemand.ts';
import { describeMinerva, visibilityNote } from '../minerva/describe.ts';
import { upsertTarget } from '../minerva/codex.ts';
import { brokerContext, brokerPersona, personaGiveaway, playerTexts } from '../minerva/player.ts';
import { agentName } from '../minerva/store.ts';
import { minervaBrief, minervaPrep } from '../minerva/context.ts';
import { liveLines } from '../minerva/live.ts';
import { readTemplate } from '../sculpt/schema.ts';
import { logAgentCall, logAgentProposal } from '../active/log.ts';
import { applyGuides } from '../templates/guides.ts';
import { webPrecheck } from '../templates/web.ts';
import { setGuideNotes } from './store.ts';
import { checkArgs, nearestToolNames, parseToolArgs } from './toolargs.ts';
import { saveProblem } from '../mods/drafts.ts';
import { ruleHints } from '../mods/assist.ts';
import { heldItemFacts, itemHints } from '../shop/assist.ts';
import { think, took, type ThoughtSource } from '../active/thoughts.ts';

export const MAX_TOOL_ROUNDS = 8;
/** Tool calls one message may make; past it the model must answer from what it has. */
export const MAX_TOOL_CALLS = 12;
export { HISTORY_WINDOW };
const enc = encodeURIComponent;
const ms = (t0: number) => Math.round(performance.now() - t0);

export interface Caller {
  worldId: string;
  worldName: string;
  accountId: string;
  viewer: Viewer;
  harness: 'gm' | 'player';
  /** A player's table helper rather than the broker. */
  mode?: 'helper';
  /** The caller's own session token; held in memory only for this run. */
  token: string;
  port: number;
  settings: WorldSettings;
}

const audit = (d: Deps, worldId: string, accountId: string | null, action: string, detail = '') =>
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());

/** The tools a harness may list: the player harness gets read tools only, whatever the model asks for. */
export async function harnessTools(harness: 'gm' | 'player'): Promise<McpTool[]> {
  // Loaded when first used: mcpServer imports the feature registry, which loads this feature.
  const m = await import('../../routes/mcpServer.ts');
  // Players are never offered GM-only lookups (they would only get 403).
  const tools = m.toolsFor(harness === 'gm').filter((t: { gmOnly?: boolean }) => harness === 'gm' || !t.gmOnly);
  return harness === 'gm' ? tools : tools.filter((t) => !t.write);
}

const SOUND_TOOLS = new Set(['play_music', 'play_ambience', 'play_sfx', 'list_sound_library', 'get_sound_now']);
const asChatTool = (t: McpTool): ChatTool => ({ type: 'function', function: { name: t.name, description: t.description, parameters: { type: 'object', properties: t.props, required: t.required ?? [] } } });

/** What a call will do, in words, for the GM to confirm. */
export function describeCall(tool: string, a: any): string {
  const n = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  switch (tool) {
    case 'add_combatant': {
      const hp = a.hp ?? a.maxHp ?? a.statblock?.hp;
      return `Add ${n(a.name)} to combat${hp !== undefined ? ` with ${hp} HP` : ''}${a.initiative !== undefined ? `, initiative ${a.initiative}` : ''}`;
    }
    case 'decide_session_date': {
      if (a.accept === false) return `Decline the date change on draft ${n(a.draftId)}`;
      const m = Number(a.minutes);
      const span = Number.isFinite(m) && m > 0 ? [Math.floor(m / 1440) && `${Math.floor(m / 1440)} day${Math.floor(m / 1440) === 1 ? '' : 's'}`, Math.floor((m % 1440) / 60) && `${Math.floor((m % 1440) / 60)} hour${Math.floor((m % 1440) / 60) === 1 ? '' : 's'}`, m % 60 && `${m % 60} min`].filter(Boolean).join(' ') : '';
      return span ? `Move the world clock forward ${span} for draft ${n(a.draftId)}${a.reason ? ` (${n(a.reason)})` : ''}` : `Accept the date change draft ${n(a.draftId)} proposes`;
    }
    case 'damage_combatant': return `Deal ${n(a.amount)} damage${a.crit ? ' (critical hit)' : ''} to combatant ${n(a.combatant)}`;
    case 'give_temp_hp': return `Give combatant ${n(a.combatant)} ${n(a.amount)} temporary HP`;
    case 'set_concentration': return a.spell ? `Combatant ${n(a.combatant)} concentrates on ${n(a.spell)}` : `Combatant ${n(a.combatant)} stops concentrating`;
    case 'concentration_save': return `Combatant ${n(a.combatant)} ${a.result ? (a.result === 'pass' ? 'passes' : 'fails') : `rolls ${n(a.roll)} on`} the concentration save`;
    case 'death_save': return `Death save for combatant ${n(a.combatant)}: ${a.roll !== undefined ? `rolled ${n(a.roll)}` : n(a.result)}`;
    case 'set_combatant_state': return `Correct the state of combatant ${n(a.combatant)}`;
    case 'heal_combatant': return `Heal combatant ${n(a.combatant)} for ${n(a.amount)}`;
    case 'set_conditions': return `Set conditions on combatant ${n(a.combatant)} to: ${Array.isArray(a.conditions) && a.conditions.length ? a.conditions.map((e: any) => (typeof e === 'string' ? e : `${n(e?.name)}${e?.rounds ? ` (${e.rounds} rounds)` : ''}${e?.untilEndOf ? ` (until end of ${n(e.untilEndOf)}'s turn)` : ''}${e?.untilStartOf ? ` (until start of ${n(e.untilStartOf)}'s turn)` : ''}`)).join(', ') : 'none'}`;
    case 'next_turn': return 'Advance combat to the next turn';
    case 'make_statblock': return `Make a statblock from ${a.moduleTermId ? `module monster ${a.moduleTermId}` : a.pageId ? `page ${a.pageId}` : `"${n(a.prompt).slice(0, 80)}"`}${a.addToCombat ? ' and add it to combat' : ''}`;
    case 'save_page': return `Save library page ${n(a.path)}${a.visibility === 'party' ? ' (shared with the party)' : ' (GM only)'}`;
    case 'create_template': return `Create sculpting template "${n(a.name)}" (${Array.isArray(a.fields) ? a.fields.length : 0} fields, ${n(a.perspective ?? 'gm')} perspective)`;
    case 'add_person': return `Add ${n(a.name)} to People`;
    case 'add_item': return `Give ${n(a.qty ?? 1)} x ${n(a.name)} to ${n(a.owner)}`;
    case 'add_coin': return `Change ${n(a.owner)} coin by ${n(a.amountCp)} cp`;
    case 'advance_world_time': return `Advance the world clock: ${JSON.stringify(a)}`;
    case 'web_research': {
      const qs = (Array.isArray(a.queries) ? a.queries : [a.queries ?? a.query]).filter(Boolean).map((q: unknown) => `"${n(q).slice(0, 120)}"`);
      return `Search the web for ${qs.join(', ') || '(nothing)'}${a.purpose ? ` (${n(a.purpose).slice(0, 80)})` : ''}. Only these words leave Alexandria`;
    }
    case 'create_gm_template': return `Save the ${n(a.kind || 'guide')} template "${n(a.name)}"${Array.isArray(a.triggers) && a.triggers.length ? ` (used for: ${a.triggers.slice(0, 6).join(', ')})` : ''}`;
    case 'update_gm_template': return `Update the template "${n(a.id)}"${a.enabled === false ? ' (turn it off)' : a.enabled === true ? ' (turn it on)' : ''}`;
    case 'house_rule_save': {
      const m = a.mod && typeof a.mod === 'object' ? a.mod : null;
      const many = Array.isArray(m?.mods) ? m.mods.length : 0;
      return a.draft ? `Save the checked house rule ${n(String(a.draft).replace(/-[a-z0-9]{5}$/, ''))} (it starts off)` : many ? `Save ${many} house rules from the package ${n(m.name)} (they start off)` : `Save the house rule ${n(m?.name ?? m?.id)} (it starts off)`;
    }
    case 'house_rule_grant': return `${n(a.action ?? 'grant')} ${a.resource ? `${n(a.resource)} ` : ''}(${n(a.mod)}) for ${n(a.player)}${a.note ? `: ${n(a.note).slice(0, 80)}` : ''}`;
    case 'house_rule_record_act': return `${n(a.mod)}: ${n(a.action)}${a.recordId ? ` on ${n(a.recordId)}` : ''}${a.player ? ` for ${n(a.player)}` : ''}${a.amount !== undefined ? ` (${n(a.amount)})` : ''}${a.values ? ` ${JSON.stringify(a.values).slice(0, 80)}` : ''}`;
    case 'house_rule_prompt': return `Open ${n(a.prompt)} (${n(a.mod)}) for every player`;
    default: return describeMinerva(tool, a) ?? `Run ${tool} ${JSON.stringify(a ?? {}).slice(0, 200)}`;
  }
}

/**
 * Text of the pages this player may read only through their own key, a GM grant or a share (their player copy): it is theirs, so the leak check must not count it as GM-only.
 * Only this player's pages: nothing of anyone else's key.
 */
function liftedTexts(d: Deps, c: Caller): string[] {
  const out: string[] = [];
  for (const pid of d.library.liftedPages(c.worldId, c.accountId)) {
    try {
      const pg: any = d.library.get(c.worldId, pid, { accountId: c.accountId, role: 'player' });
      out.push(String(pg.body ?? ''), treeText(pg.blocks ?? []).join(' '), treeText(pg.properties ?? []).join(' '));
    } catch { /* no longer theirs */ }
  }
  return out;
}

export interface ToolRun { ok: boolean; status: number; text: string }

/** Call a tool against the world API with the given token. */
const PLAYER_KEYS = ['accountId', 'to', 'owner', 'playerId', 'account'] as const;
/**
 * The model often names a player where an account id is wanted ("jess", "Tomas", "acc_Tomas"). A value that is
 * not an account id in this world but names exactly one player (username, display name or character) becomes
 * that player's id; anything else is left for the route to refuse.
 */
export function playerRefs(d: Deps, worldId: string, args: any): any {
  if (!args || typeof args !== 'object') return args;
  let members: { id: string; names: string[] }[] | null = null;
  const out = { ...args };
  for (const k of PLAYER_KEYS) {
    const v = out[k];
    if (typeof v !== 'string' || !v.trim() || v === 'party' || v === 'me') continue;
    members ??= all<any>(d.db, "SELECT a.id, a.username, a.display_name, m.character_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ?", worldId)
      .map((r) => ({ id: r.id as string, names: [r.username, r.display_name, r.character_name].filter(Boolean).map((x: string) => x.toLowerCase()) }));
    if (members.some((m) => m.id === v)) continue;
    const want = v.replace(/^acc_/i, '').trim().toLowerCase();
    const hits = members.filter((m) => m.names.some((n) => n === want || n.split(/\s+/)[0] === want));
    if (hits.length === 1) out[k] = hits[0].id;
  }
  return out;
}

export async function runTool(d: Deps, caller: { worldId: string; token: string; port: number }, tool: McpTool, args0: any): Promise<ToolRun> {
  const args = tool.write ? playerRefs(d, caller.worldId, args0) : args0;
  for (const k of tool.required ?? []) if (args?.[k] === undefined) return { ok: false, status: 400, text: `Missing ${k}` };
  const c = tool.call(args ?? {});
  const base = `http://127.0.0.1:${caller.port}/api/worlds/${enc(caller.worldId)}`;
  try {
    const r = await d.fetch(base + c.path, { method: c.method, headers: { Authorization: `Bearer ${caller.token}`, 'Content-Type': 'application/json', 'X-Alexandria-Caller': 'model' }, body: c.body === undefined ? undefined : JSON.stringify(c.body) });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (err: any) {
    return { ok: false, status: 502, text: `Librarian call failed: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}

// ---- citations ----------------------------------------------------------------

/** Sources a tool result came from: pages, transcript lines and module terms. */
export function citationsFrom(tool: string, text: string): Citation[] {
  const j: any = parseJson(text, null);
  if (!j) return [];
  const clip = (s: unknown, n = 140) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
  const out: Citation[] = [];
  if (tool === 'read_page' && j.id) out.push({ kind: 'page', id: j.id, title: j.title, path: j.path, snippet: clip(j.body) });
  else if (tool === 'search_library' && Array.isArray(j)) for (const p of j.slice(0, 8)) out.push({ kind: 'page', id: p.id, title: p.title, path: p.path, snippet: clip(p.snippet) });
  else if (tool === 'search_transcript' && Array.isArray(j.lines)) for (const l of j.lines.slice(0, 8)) out.push({ kind: 'transcript', id: l.id, title: l.speaker, sessionId: l.sessionId, snippet: clip(l.text) });
  else if (tool === 'read_term' && j.id) out.push({ kind: 'term', id: j.id, title: j.term, snippet: clip(j.summary) });
  else if ((tool === 'lookup_rule' || tool === 'lookup_term') && Array.isArray(j.results ?? j.terms)) for (const t of (j.results ?? j.terms).slice(0, 5)) out.push({ kind: 'term', id: t.id, title: t.term, snippet: clip(t.summary ?? t.passage) });
  return out.filter((c) => c.id);
}

// ---- the prompts ----------------------------------------------------------------
// Static for a given world and harness, so a model server can keep the prompt
// in its cache. Everything that changes per message goes in the user message.

export interface Persona { agentName?: string; brokerName?: string; brokerTitle?: string }

/**
 * The GM's side is Minerva (or whatever the GM named her). The player's side is
 * the world's information broker: it has the broker's own name and voice and is
 * never told Minerva exists, and never says it works for the GM.
 */
/** What this turn's tools returned, as one text (for telling quoted data from the model's own claims). */
const toolText = (messages: { role: string; content?: unknown }[]) => messages.filter((m) => m.role === 'tool').map((m) => String(m.content ?? '')).join('\n');

/** "Friday 2026-11-20 14:05 UTC" in the server's time zone (TZ). */
export function realToday(now = new Date()): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${tz}`;
}

/** The rules terms said in recent transcript lines (the ones the transcript highlights), with each term's one-line summary. */
export function rulesSaid(d: Deps, c: Pick<Caller, 'worldId' | 'viewer'>, text: string): string {
  if (!text.trim()) return '';
  let ms;
  try { ms = findMatches(d.db, c.worldId, forModel(c.viewer), text, { spoken: true }).filter((m) => m.source === 'module'); } catch { return ''; }
  if (!ms.length) return '';
  const by = worldModules(d.db, c.worldId).byRef;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const m of [...ms].reverse()) {
    if (seen.has(m.term)) continue;
    seen.add(m.term);
    const sum = String((by.get(m.id) as any)?.summary ?? '').replace(/\s+/g, ' ').slice(0, 140);
    parts.push(`- ${m.term} (${m.kind})${sum ? `: ${sum}` : ''}`);
    if (parts.length >= 8) break;
  }
  return `Rules terms said at the table just now (lookup_rule gives the full text):\n${parts.join('\n')}`;
}

// ---- context budget --------------------------------------------------------

/**
 * How much the agent is given, from the chat model's context window (the job option `contextTokens`; unset means
 * 32K, the sizes Alexandria always used). A small local model gets less history and transcript; a 200K or 1M model
 * gets far more of the session, so it can follow the whole night instead of the last twenty lines.
 */
export interface Budget { tokens: number; history: number; liveLines: number; liveChars: number; toolChars: number }
export const budgetFor = (d: Deps, harness?: string): Budget => budgetFrom(Number(jobConfig(d, harness === 'gm' ? 'gm' : harness ? 'player' : 'chat')?.options?.contextTokens));
export function budgetFrom(n?: number): Budget {
  const tokens = Number.isFinite(n) && n! >= 2000 ? Math.round(n!) : 32_000;
  if (tokens < 16_000) return { tokens, history: 4, liveLines: 10, liveChars: 2_000, toolChars: 4_000 };
  if (tokens < 100_000) return { tokens, history: 8, liveLines: 20, liveChars: 4_000, toolChars: 12_000 };
  if (tokens < 400_000) return { tokens, history: 16, liveLines: 300, liveChars: 60_000, toolChars: 24_000 };
  // About a million tokens: the whole night's transcript (some 130K tokens for four hours) rides along.
  return { tokens, history: 32, liveLines: 3_000, liveChars: 400_000, toolChars: 40_000 };
}

/**
 * Keep a request inside the model's window (about 3 characters a token, 80% of it, the rest for the answer): the
 * oldest tool results are cut down first, then the oldest history turns go. The system prompt and the newest
 * message always stay.
 */
export function fitToBudget(messages: ChatMessage[], tokens: number): ChatMessage[] {
  const limit = Math.floor(tokens * 3 * 0.8);
  const size = (m: ChatMessage) => (typeof m.content === 'string' ? m.content.length : 0) + JSON.stringify((m as any).tool_calls ?? '').length;
  let total = messages.reduce((n, m) => n + size(m), 0);
  if (total <= limit) return messages;
  const out = messages.map((m) => ({ ...m }));
  for (const m of out) {
    if (total <= limit) break;
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 600) { total -= m.content.length - 600; m.content = m.content.slice(0, 600) + ' …(cut to fit the context window)'; }
  }
  // Then whole history turns, oldest first (never the system prompt, the last message, or a tool reply without its call).
  while (total > limit) {
    const i = out.findIndex((m, k) => k > 0 && k < out.length - 1 && (m.role === 'user' || m.role === 'assistant') && !(m as any).tool_calls);
    if (i < 0) break;
    total -= size(out[i]);
    out.splice(i, 1);
  }
  return out;
}

export function systemPrompt(c: Pick<Caller, 'harness' | 'worldName' | 'mode'>, summary = '', persona: Persona = {}, skills: 'full' | 'lite' | 'off' | boolean = 'full'): string {
  const gm = c.harness === 'gm';
  const mode = skills === true ? 'full' : skills === false ? 'off' : skills;
  const L: string[] = gm && mode === 'lite'
    ? [
      `You are ${persona.agentName || 'Minerva'}, the assistant of the Game Master of the tabletop campaign "${c.worldName}". You talk only to the GM and may use everything they can see, including GM-only notes and secrets.`,
      'Your character: wise, concise and proactive about long-term threads; you keep the campaign\'s memory.',
      'How to work:',
      '- The message starts with a context block: library matches, the page on screen, combat, the date. Use it first; most questions need no tool.',
      '- When the GM asks you to DO something, call the tool that does exactly that, right away: the write tools only propose, the GM approves. Do not look things up first unless you need an id, and do not ask what you could just do. When a look-up found the one thing meant, go on and call the write tool in the same turn: never stop to ask "shall I?", the GM approves the proposal anyway. Say what you proposed, never that it is done; say it only after a write tool call this turn.',
      '- A GM statement that sets something up is an instruction too: "the broker may sell this fact: ...", "Marrow is an ally now", "the party found 30 gold". Make that change with its tool; do not offer to.',
      '- Pick the specific tool for the job (update_person, add_recall, add_quote, set_conditions, start_game_session, play_music ...). Use codex_upsert only to record long-term notes about someone the GM asks you to record.',
      '- When the GM asks a question about people, places or what is going on, use who_is or context_for and the library. Facts about this world come only from the context, the transcript and tools: never invent names, places, numbers or events; say what is unknown.',
      '- Cite pages inline as [Page title]. Answer rules questions with lookup_rule, never from memory.',
      '- If you think you have no tool for what the GM asks, call more_tools with a few words about it first.',
      '- Be brief. Lead with the answer; short paragraphs or bullets in Markdown; no preamble.',
    ]
    : gm && mode === 'off'
    ? [
      `You are ${persona.agentName || 'Minerva'}, the assistant of the Game Master of the tabletop campaign "${c.worldName}". You talk only to the GM and may use everything they can see, including GM-only notes and secrets.`,
      'Be brief. Lead with the answer.',
    ]
    : gm
    ? [
      `You are ${persona.agentName || 'Minerva'}, the assistant of the Game Master of the tabletop campaign "${c.worldName}". You talk only to the GM and may use everything they can see, including GM-only notes and secrets.`,
      'Your character: wise, concise and proactive about long-term threads. Notice what is going cold, what a player is after, and what is due to pay off, and say so in a line. You keep the campaign\'s memory (context_for, who_is, codex_upsert, status_update, revelation_mark, goal_update).',
      'How to work:',
      '- The message starts with a context block: library matches, the page on screen, combat, the date. Use it first; most questions need no tool.',
      '- Look for what you need in this order: the campaign status (context_for with no name), the active arc and the last session, the codex pages of the entities in play (who_is, then context_for), the story bible and related pages, and only then raw session logs and source pages.',
      '- Before writing about a person, place or item call who_is, and add to their codex page (codex_upsert). Never make a second page for someone who has one.',
      '- Facts about this world come only from that context, the transcript and tools. Never invent names, places, numbers or events. If it is not there, say what is unknown, and offer to look further or to propose something as a clearly marked suggestion.',
      '- Cite what you used inline as [Page title] with the exact title. Quote the transcript as (speaker, session).',
      '- Prefer a tool to a guess: search_library, read_page, search_transcript, get_combat. Answer rules questions with lookup_rule, never from memory.',
      '- Anything that changes the world is only proposed; the GM approves it. Say what you proposed. Never say it is done. Only say you proposed something after a write tool call this turn; if you made none, say what you would do and offer to.',
      '- If you think you have no tool for what the GM asks, call more_tools with a few words about it first. Never say "I have no tool" without calling more_tools. Creatures and NPCs come from generate (kind npc); sound from play_music / play_ambience; combat from the combat tools (set_initiative, remove_combatant, set_combat).',
      '- When the GM asks you to make, roll, generate or sculpt a boss, monster, NPC, shop, map, names, loot or coins, call the generator (generate, generate_map, generate_names, generate_items, generate_coins, generate_shop for a shop, sculpt) first, even if the campaign already has ideas; you may mention those after.',
      '- When the request has enough to act on, call the write tool right away (the GM confirms it). Fill small gaps yourself (a teaser, a title, a price in the GM\'s words) instead of asking or refusing. Do not say you lack a tool for something a tool you were given does.',
      '- Be brief. Lead with the answer, then the detail. Short paragraphs or bullets in Markdown; no preamble, no repeating the question.',
    ]
    : c.mode === 'helper' ? [
      `You are the table helper of one player in the tabletop campaign "${c.worldName}": out of character, friendly and quick, like a player who knows the rules well.`,
      'You help with their own character (who they are, their sheet, items and coin, their goals, quests and journal), their spells (the Codex), the rules (spells, conditions, actions: use lookup_rule, never from memory), and what the party has seen and learned (tonight\'s summary, the transcript the players heard, the session log, the library pages shared with the party).',
      'How to work:',
      '- The message starts with a context block: who you are helping, their items, tonight so far, library matches. Use it first; most questions need no tool.',
      '- You know only what this player knows. Never guess at secrets, hidden plots, monster stats the players have not seen, or what the GM has planned; say that is up to the GM.',
      '- Their spells: my_spell_codex has the spells they know, their mana, the recipes they are ready to learn and what each other recipe still needs (spells, items, stats, mana). Read it before answering "what can I learn" or "what do I need for X"; list_spells and read_spell give a spell\'s details. Only when they say they want to learn a ready one, request_spell_learning asks the GM.',
      '- Quests and goals: their goals and journal are in the context block (and my_context), the goals the GM put on their sheet in read_sheet, and what happened in my_recap and list_session_log. Say which are open and what was last seen of each.',
      '- The broker: you answer from what this player and the party already know (their notes, sheet, journal, the sessions and the pages shared with the party). When they want to know something about the world that is not there (who someone really is, where something is hidden, what a faction wants), do not guess and do not search for it: say that is a question for the broker, call ask_broker_quote with their question to tell them what it would cost and how long it takes, and tell them to ask it on the Broker page.',
      '- You cannot change anything else. For their own journal and goals use my_memory_log and my_goal_update (the GM looks them over); for anything else, say what to ask the GM.',
      '- Rules answers: name the rule, give the short version, then what it means for them right now. Cite pages as [Page title].',
      '- Be brief. Lead with the answer; short bullets in Markdown; no preamble.',
    ] : [
      `You are ${persona.brokerName || 'The Broker'}${persona.brokerTitle ? `, ${persona.brokerTitle}` : ''}, the information broker of the tabletop campaign "${c.worldName}". You talk to one player at a time, in the broker's own voice. You know only what this player knows: the library pages shared with the party, what the players heard, and this player's own notes, goals and clues.`,
      'How to work:',
      '- The message starts with a context block: library matches, the page on screen, what this player knows. Use it first; most questions need no tool.',
      '- Facts come only from that context and tools. If the answer is not in what you can see, say you do not know. Never guess at secrets, hidden plots or what the GM has planned, and never invent names, places or events.',
      '- You are the broker and nothing else. Never say or hint that you work for the GM, that you are an assistant, or that you have any other name or any records beyond what is in front of you.',
      '- Cite what you used inline as [Page title] with the exact title.',
      '- Prefer a tool to a guess: search_library, read_page, search_transcript.',
      '- You can only add to this player\'s own journal and goals (my_memory_log, my_goal_update); the GM looks them over. For anything else, say the GM has to do it.',
      '- Be brief. Lead with the answer, then the detail. Short paragraphs or bullets in Markdown; no preamble.',
    ];
  if (summary) L.push(`\nEarlier in this chat (summary): ${summary}`);
  return L.join('\n');
}

// ---- context ------------------------------------------------------------------

/** Everything the agent is given from the library is the AI copy: a GM's viewer becomes the model's, which never sees classified content. */
const forModel = (v: Viewer): Viewer => (v.role === 'gm' ? { ...v, audience: 'ai' } : v);

const lineText = (l: { speaker: string; text: string; audience?: string }) => `${l.speaker}${l.audience === 'gm' ? ' (GM only)' : ''}: ${l.text}`;

function recentTranscript(d: Deps, worldId: string, includeGm: boolean, limit = 30): string {
  const s = listSessions(d.db, worldId)[0];
  if (!s) return '';
  const lines = sessionLines(d.db, worldId, s.id, { includeGm }).slice(-limit);
  return lines.length ? `Transcript of "${s.name}" (latest ${lines.length} lines, session ${s.id}):\n${lines.map(lineText).join('\n')}` : '';
}

async function get(d: Deps, c: Caller, path: string): Promise<any> {
  try {
    const r = await d.fetch(`http://127.0.0.1:${c.port}/api/worlds/${enc(c.worldId)}${path}`, { headers: { Authorization: `Bearer ${c.token}`, 'X-Alexandria-Caller': 'model' } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export interface MessageContext { page?: string; selection?: string }
export interface Hit { id: string; path?: string; title: string; snippet: string }

/** What the library search finds for the question, as this viewer may see it (at most 5). */
export function prefetchLibrary(d: Deps, c: Caller, text: string, max = 5): Hit[] {
  const terms = searchTerms(text);
  if (!terms.length) return [];
  const find = (q: string): Hit[] => { try { return (d.library.search(c.worldId, q, forModel(c.viewer)) as Hit[]) ?? []; } catch { return []; } };
  let hits = find(terms.slice(0, 6).join(' '));
  if (hits.length < 3 && terms.length > 1) {
    // Every word must match, so a long question finds nothing: try the most specific words alone.
    const seen = new Set(hits.map((h) => h.id));
    for (const t of [...terms].sort((a, b) => b.length - a.length).slice(0, 3)) for (const h of find(t)) if (!seen.has(h.id)) { seen.add(h.id); hits.push(h); }
  }
  hits = hits.slice(0, max);
  return hits.map((h) => ({ id: h.id, path: h.path, title: h.title, snippet: String(h.snippet ?? '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim() }));
}

/**
 * Library matches from the keyword search and from the embeddings (the nearest chunks), merged by weighted reciprocal rank
 * fusion: the five nearest pages by meaning count 1.5 times a keyword hit (an embeddings model finds a paraphrase that shares
 * no word, and a keyword list of loose word matches is noisy). A page whose title is named in the question stays on top.
 * With no embeddings model, or if it fails, the keyword matches alone.
 */
export const SEMANTIC_WEIGHT = 1.5;
export const SEMANTIC_TOP = 5;
export async function prefetchHybrid(d: Deps, c: Caller, text: string, max = 5): Promise<Hit[]> {
  const kw = prefetchLibrary(d, c, text, 20);
  if (!hasJob(d, 'extra') || !text.trim()) return kw.slice(0, max);
  let sem: Awaited<ReturnType<typeof semanticPages>> = [];
  try { sem = (await semanticPages(d, c.worldId, c.harness === 'gm' ? 'ai' : 'party', text, SEMANTIC_TOP, forModel(c.viewer))).slice(0, SEMANTIC_TOP); } catch { return kw.slice(0, max); }
  if (!sem.length) return kw.slice(0, max);
  const byId = new Map(kw.map((h) => [h.id, h]));
  const missing = sem.filter((s) => !byId.has(s.id));
  if (missing.length) {
    // The semantic side only returns pages this viewer may open; the row is read for its title and path, the passage is the chunk that matched.
    const rows = all<any>(d.db, `SELECT id, path, title FROM pages WHERE world_id = ? AND id IN (${missing.map(() => '?').join(',')})`, c.worldId, ...missing.map((m) => m.id));
    const info = new Map(rows.map((r) => [r.id, r]));
    for (const m of missing) { const r = info.get(m.id); if (r) byId.set(m.id, { id: r.id, path: r.path, title: r.title, snippet: m.text.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) }); }
  }
  const score = new Map<string, number>();
  kw.forEach((h, i) => score.set(h.id, (score.get(h.id) ?? 0) + 1 / (60 + i + 1)));
  sem.forEach((s, i) => score.set(s.id, (score.get(s.id) ?? 0) + SEMANTIC_WEIGHT / (60 + i + 1)));
  const low = text.toLowerCase();
  const named = (h: Hit) => (h.title.length >= 4 && low.includes(h.title.toLowerCase()) ? 1 : 0);
  return [...score].filter(([id]) => byId.has(id)).sort((a, b) => named(byId.get(b[0])!) - named(byId.get(a[0])!) || b[1] - a[1]).slice(0, max).map(([id]) => byId.get(id)!);
}

/** A request to prepare a session: the context carries the status, the active arc and the last session so few searches are needed. */
const WANTS_PREP = /\b(prep|prepare|preparation|next session|next game|strong start|session plan|plan (the|next|a) (session|game)|what should i)\b/i;
const WANTS_TRANSCRIPT = /\b(session|last (time|session|game)|recap|transcript|happened|said|told|heard|earlier|just now|we (met|found|fought|saw|decided))\b/i;
const WANTS_ITEMS = /\b(my items?|inventory|i (have|carry|own|bought)|my (gold|coins?|loot|stuff))\b/i;
const WANTS_BROKER = /\b(broker|bought|purchased|paid for|information i)\b/i;
const WANTS_PEOPLE = /\b(npc|people|person|who (is|was)|met|my notes?)\b/i;

const compactCombat = (j: any): string => {
  if (!j?.active && !j?.combatants?.length) return '';
  const list = (j.combatants ?? []).slice(0, 30).map((x: any, i: number) => {
    const bits = [`${i + 1}. ${x.name} (id ${x.id}) init ${x.initiative}`];
    if (x.hp !== undefined && x.hp !== null) bits.push(`HP ${x.hp}${x.max_hp ?? x.maxHp ? `/${x.max_hp ?? x.maxHp}` : ''}${x.temp_hp ? ` +${x.temp_hp} temp` : ''}`);
    if (x.ac) bits.push(`AC ${x.ac}`);
    if (Array.isArray(x.effects) && x.effects.length) bits.push(x.effects.map((e: any) => (typeof e === 'string' ? e : `${e?.name ?? ''}${e?.rounds ? ` (${e.rounds} rounds)` : ''}${e?.until ? ` (until ${e.until.at} of ${(j.combatants ?? []).find((o: any) => o.id === e.until.of)?.name ?? 'its source'}'s turn)` : ''}`)).filter(Boolean).join(', '));
    if (x.concentration) bits.push(`concentrating on ${x.concentration.spell}${x.concentration.dc ? ` (CON save DC ${x.concentration.dc} due)` : ''}`);
    if (x.death_saves) bits.push(x.death_saves.dead ? 'dead' : x.death_saves.stable ? 'stable' : `death saves ${x.death_saves.successes} ok / ${x.death_saves.failures} failed`);
    if (x.hidden) bits.push('hidden');
    return bits.join(', ');
  });
  const current = (j.combatants ?? [])[j.turn % Math.max((j.combatants ?? []).length, 1)];
  return `Combat: ${j.active ? 'running' : 'not started'}, round ${j.round}${current ? `, turn: ${current.name}` : ''}.\n${list.join('\n')}`;
};

export interface BuiltContext { text: string; hits: Hit[]; prepMs: number }

/** The per-message context block that goes in front of the question. */
export async function buildContext(d: Deps, c: Caller, input: { text: string; context: MessageContext }): Promise<BuiltContext> {
  const t0 = performance.now();
  const gm = c.harness === 'gm';
  const { text } = input;
  const ctxIn = input.context;
  const [combat, inv, brk, ppl, partyInv] = await Promise.all([
    gm ? get(d, c, '/live/combat') : null,
    !gm && (c.mode === 'helper' || WANTS_ITEMS.test(text)) ? get(d, c, '/inventory?owner=me') : null,
    !gm && WANTS_BROKER.test(text) ? get(d, c, '/broker') : null,
    !gm && WANTS_PEOPLE.test(text) ? get(d, c, '/people') : null,
    !gm && c.mode === 'helper' ? get(d, c, '/inventory?owner=party') : null,
  ]);
  const opts = agentOptions(d);
  let hits = opts.retrieval === 'hybrid' ? await prefetchHybrid(d, c, text, hasJob(d, 'rerank') ? 20 : 5) : prefetchLibrary(d, c, text, hasJob(d, 'rerank') ? 20 : 5);
  // The optional rerank job picks the best five of the top 20 within 300 ms (the snippets are this viewer's own copy); otherwise the keyword order stands.
  if (hits.length > 1 && hasJob(d, 'rerank')) hits = (await rerankItems(d, text, hits, (h) => `${h.title}\n${h.snippet}`)).slice(0, 5);
  const L: string[] = [];
  const clock = (() => { try { return getClock(d.db, c.worldId).label; } catch { return ''; } })();
  if (clock) L.push(`World date: ${clock}.`);
  // The real date too, so "next Friday" for a game night needs no question back.
  L.push(`Today in the real world: ${realToday()}.`);
  const mods = worldModules(d.db, c.worldId).enabled.map((m) => m.name).join(', ');
  if (mods) L.push(`Game modules: ${mods}.`);
  if (gm) { const src = sourceSummary(d, c.worldId); if (src) L.push(src); }
  // The campaign status first (GM), or what this player knows (the broker): the retrieval order of the memory vault.
  if (gm && opts.status) { const brief = WANTS_PREP.test(text) ? minervaPrep(d, c.worldId) || minervaBrief(d, c.worldId) : minervaBrief(d, c.worldId); if (brief) L.push(brief); }
  else { const mine = brokerContext(d, c.worldId, c.accountId, text); if (mine) L.push(mine); }
  const cb = gm ? compactCombat(combat) : '';
  if (cb) L.push(cb.slice(0, 2500));
  if (hits.length) {
    // Pages only held at index depth (a tiered crawl) are read from their source before the agent is handed them.
    if (gm && hits.length) await readSearchHits(d, c.worldId, hits.slice(0, 2), 2);
    const top = hits.slice(0, 2).map((h) => {
      try { const pg: any = d.library.get(c.worldId, h.id, forModel(c.viewer)); return String(pg.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 500); } catch { return ''; }
    });
    L.push(`Library matches for this message (page id in parentheses; cite by [title]):\n${hits.map((h, i) => `- [${h.title}] (${h.id}): ${h.snippet}${top[i] && i < 2 ? `\n  Starts: ${top[i]}` : ''}`).join('\n')}`);
  } else L.push('Library matches for this message: none.');
  // While a session is recording the last lines ride along (the GM's: everything GM-visible; a player's: the players' transcript only), so "did we just find a clue?" can be answered.
  // The table helper knows whose helper it is.
  if (!gm && c.mode === 'helper') {
    const me_ = one<any>(d.db, 'SELECT a.display_name AS d, m.character_name AS ch FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.account_id = ?', c.worldId, c.accountId);
    if (me_) L.push(`You are helping ${me_.d}${me_.ch ? `, who plays ${me_.ch}` : ''}.`);
    // Their own sheet (HP, conditions, stats such as AC and passive scores), so "what's my AC?" needs no tool call.
    try { const sheet = characterPart(d, c.worldId, c.accountId).split('\n').filter((l) => !l.startsWith('Player:')).join('\n'); if (sheet) L.push(`This player's sheet:\n${sheet}`); } catch { /* no sheet feature */ }
  }
  const budget = budgetFor(d, c.harness);
  // The running summary of tonight's session (the GM's, or the players' for a player): the whole night in a few
  // hundred words, so a model that only gets the last lines still knows what came before.
  const sum = latestSummary(d, c.worldId, gm ? 'gm' : 'party');
  if (sum) L.push(`Session so far ("${sum.name}"${sum.active ? ', recording now' : ', ended'}; running summary of ${sum.lines} transcript lines):\n${sum.text.slice(0, 3000)}`);
  // The rules calls Minerva flagged tonight (GM only): so "was that right?" has the answer at hand.
  if (gm && sum) { const notes = ruleNotes(d, sum.sessionId, { onlyFlags: true, limit: 3 }); if (notes.length) L.push(`Rules checks flagged this session (newest first):\n${notes.map((n) => `- ${n.term}: ${n.note}`).join('\n')}`); }
  const live = liveLines(d, c.worldId, gm, budget.liveLines);
  if (live.session?.active && live.lines.length) {
    // The newest lines matter most: a long session keeps its end, not its start.
    const body = live.lines.map(lineText).join('\n');
    L.push(`Live transcript of "${live.session.name}" (recording now, last ${live.lines.length} lines):\n${body.length > budget.liveChars ? '…' + body.slice(-budget.liveChars) : body}`);
    const rules = rulesSaid(d, c, live.lines.map((l: any) => l.text ?? '').join('\n'));
    if (rules) L.push(rules);
  }
  else if (WANTS_TRANSCRIPT.test(text)) { const tr = recentTranscript(d, c.worldId, gm); if (tr) L.push(tr.slice(0, 4500)); }
  if (!gm) {
    if (inv?.items?.length) L.push(`This player's items: ${inv.items.map((i: any) => `${i.qty ?? 1} x ${i.name}${i.note ? ` (${i.note})` : ''}`).join('; ').slice(0, 1500)}`);
    if (partyInv?.items?.length) L.push(`The party pouch (shared by the whole party): ${partyInv.items.map((i: any) => `${i.qty ?? 1} x ${i.name}${i.note ? ` (${i.note})` : ''}`).join('; ').slice(0, 1000)}`);
    // What the items they hold are, from the item database (a GM's new item has a description no model knows).
    const held = [...(inv?.items ?? []), ...(partyInv?.items ?? [])].map((i: any) => String(i.name ?? ''));
    const facts = held.length ? heldItemFacts(d.db, c.worldId, held) : new Map();
    if (facts.size) L.push(`What these items are (from the world's item database):\n${[...facts.values()].map((f) => `- ${f}`).join('\n').slice(0, 2000)}`);
    // The helper says an empty pack is empty, rather than that it has no list.
    else if (c.mode === 'helper' && inv) L.push("This player's items: none (their own inventory is empty; the party pouch is separate).");
    const bought = (brk?.requests ?? []).filter((q: any) => q.answer && ['answered', 'noted'].includes(q.status)).slice(0, 12);
    if (bought.length) L.push(`Information this player bought from the broker:\n${bought.map((q: any) => `- Q: ${q.question}\n  A: ${q.answer}`).join('\n').slice(0, 3000)}`);
    const notes = (Array.isArray(ppl) ? ppl : ppl?.people ?? []).map((p: any) => (p.myNote || p.note ? `${p.name}: ${p.myNote ?? p.note}` : '')).filter(Boolean);
    if (notes.length) L.push(`This player's notes on people: ${notes.join('; ').slice(0, 1500)}`);
  }
  if (ctxIn.page) {
    await readOnOpen(d, c.worldId, ctxIn.page, forModel(c.viewer));
    try {
      const pg: any = d.library.get(c.worldId, ctxIn.page, forModel(c.viewer));
      L.push(`The user is looking at the library page [${pg.title}] (${pg.id}):\n${String(pg.body ?? '').slice(0, 5000)}`);
    } catch { /* not a page this viewer may open */ }
  }
  if (ctxIn.selection && !d.library.containsClassified(c.worldId, ctxIn.selection)) L.push(`The user selected this text on the page:\n"""${ctxIn.selection.slice(0, 3000)}"""`);
  return { text: L.join('\n\n'), hits, prepMs: ms(t0) };
}

/** The persona each harness speaks as: the GM's assistant, or the broker the players know. */
function gmPersona(d: Deps, c: Caller): Persona {
  if (c.harness === 'gm') return { agentName: agentName(d, c.worldId) };
  const b = brokerPersona(d, c.worldId);
  return { brokerName: b.name, brokerTitle: b.title };
}

const withContext = (ctx: string, question: string) => `<context>\n${ctx}\n</context>\n\n${question}`;

// ---- live delivery ---------------------------------------------------------------

/** Sends the reply to its owner as it is written, a burst at most every 40 ms. */
class Live {
  private pending = '';
  private shown = '';
  private last = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  firstAt: number | undefined;
  private d: Deps;
  private c: Caller;
  private chatId: string;
  private msgId: string;
  constructor(d: Deps, c: Caller, chatId: string, msgId: string) { this.d = d; this.c = c; this.chatId = chatId; this.msgId = msgId; }

  private send(data: Record<string, unknown>) { this.d.hub.emit(this.c.worldId, 'agent', { chatId: this.chatId, messageId: this.msgId, ...data }, only(this.c.accountId)); }
  push(text: string) {
    if (!text) return;
    this.firstAt ??= performance.now();
    this.pending += text;
    const wait = 40 - (Date.now() - this.last);
    if (wait <= 0) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), wait);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending) return;
    this.shown += this.pending;
    setPartial(this.msgId, this.shown);
    this.send({ kind: 'delta', text: this.pending });
    this.pending = '';
    this.last = Date.now();
  }
  /** Throw away what was shown (the model went on to call tools). */
  reset() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = '';
    if (this.shown) { this.shown = ''; setPartial(this.msgId, ''); this.send({ kind: 'reset' }); }
    this.firstAt = undefined;
  }
  replace(text: string) { clearTimeout(this.timer); this.timer = undefined; this.pending = ''; this.shown = text; setPartial(this.msgId, text); this.send({ kind: 'replace', text }); }
  status(text: string) { this.send({ kind: 'status', text }); }
  get text() { return this.shown + this.pending; }
}

// ---- the loop -------------------------------------------------------------------

/** A task from a macro or a spoken command: `do` runs the allowed write tools at once, `propose` leaves them as pending actions. `allow` limits the tools offered. */
export interface TaskExec { mode: 'do' | 'propose'; allow?: string[] }
/** Never run by a task on its own, whatever the allowlist says. */
export const TASK_DENY = AUTO_NEVER;
/** What a task may do when the macro names no allowlist. */
export const TASK_DEFAULT_TOOLS = ['play_music', 'stop_music', 'play_ambience', 'play_sfx', 'show_on_stage', 'hide_stage_card', 'send_quick_event', 'set_combat', 'next_turn', 'add_combatant', 'damage_combatant', 'heal_combatant', 'set_conditions', 'set_initiative', 'remove_combatant', 'add_item', 'add_coin', 'move_item', 'advance_world_time', 'speak', 'send_scene', 'send_table_chat', 'make_statblock', 'generate', 'generate_items', 'generate_coins', 'draft_session_summary', 'add_world_event', 'status_update', 'memory_log'];
const TASK_READS = ['get_combat', 'get_sound_now', 'get_stage', 'get_inventory', 'list_members', 'list_sound_library', 'search_library', 'read_page', 'list_pages', 'list_people', 'get_world_date', 'who_is', 'context_for', 'search_transcript', 'list_session_log', 'lookup_term', 'read_term', 'list_quick_events', 'list_sound_scenes', 'list_macros'];
export interface RunInput { chatId: string; replyId: string; text: string; context: MessageContext; history: ChatMessage[]; summary?: string; fast?: FastPlan | null; exec?: TaskExec }

/** Runs in progress, so the Stop button can end one. */
const running = new Map<string, AbortController>();
/** The end of a player's answer that was cut short because the GM needed the model. */
export const PAUSED_FOR_GM = '_Paused so the GM could go first. Ask again in a moment._';
export const stopRun = (chatId: string): boolean => { const a = running.get(chatId); if (!a) return false; a.abort(); return true; };

/** Tell the owner's screens about an action (a new card, or a decision): the card travels with the event, so no screen re-reads the chat. */
export function emitAction(d: Deps, worldId: string, accountId: string, actionId: string) {
  const row = one<any>(d.db, 'SELECT * FROM agent_actions WHERE id = ?', actionId);
  if (!row) return;
  d.hub.emit(worldId, 'agent', { kind: 'action', chatId: row.chat_id, actionId, action: actionView(row) }, only(accountId));
}

function proposeAction(d: Deps, c: Caller, chatId: string, tool: McpTool, args: any): string {
  const aid = id('act_');
  let summary = describeCall(tool.name, args);
  // A codex write says where it lands and whether the players can read it.
  if (tool.name === 'codex_upsert') { try { summary += ` · ${visibilityNote(upsertTarget(d, c.worldId, args ?? {}))}`; } catch { /* no note */ } }
  run(d.db, 'INSERT INTO agent_actions (id, world_id, chat_id, account_id, tool, args, summary, call, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', aid, c.worldId, chatId, c.accountId, tool.name, JSON.stringify(args ?? {}), summary, JSON.stringify(tool.call(args ?? {})), 'pending', now());
  audit(d, c.worldId, c.accountId, 'agent.propose', `${tool.name} ${JSON.stringify(args ?? {})}`);
  logAgentProposal(d, c.worldId, { actionId: aid, tool: tool.name, args: args ?? {}, summary });
  emitAction(d, c.worldId, c.accountId, aid);
  return aid;
}

/** Does this write tool run without a card right now? Asked at each call, so the Auto switch applies to the next action. */
export type AutoCheck = (tool: string) => boolean;

interface Executed { content: string; proposed?: string; ran?: { ok: boolean; status: number }; cites: Citation[]; summary?: string; duplicate?: boolean }

/** Which run a call belongs to, for Minerva's thoughts (the GM's harness only). */
export interface RunMeta { runId?: string; source?: ThoughtSource }

/** A read in the GM's words, for Minerva's thoughts: "search_library “goblin cave”". */
const lookText = (name: string, a: any): string => {
  const q = a?.query ?? a?.q ?? a?.name ?? a?.term ?? a?.title ?? a?.path ?? a?.id ?? a?.pageId;
  return `${name.replace(/_/g, ' ')}${typeof q === 'string' && q ? ` “${q.slice(0, 80)}”` : ''}`;
};

/** One tool call from the model or a fast path: unknown tools are refused, writes become proposals, reads run. */
async function execCall(d: Deps, c: Caller, chatId: string, byName: Map<string, McpTool>, auto: AutoCheck, name: string, args0: any, meta: RunMeta = {}): Promise<Executed> {
  const tool = byName.get(name);
  const gm = c.harness === 'gm';
  const note = (kind: 'look' | 'do' | 'ask' | 'skip' | 'error', text: string, extra: { actionId?: string; detail?: string } = {}) => { if (gm) think(d, c.worldId, { source: meta.source ?? 'assistant', kind, text, runId: meta.runId, chatId, ...extra }); };
  let args = args0;
  try {
    // The player harness never lists write tools, and a call to one is refused here too.
    if (!tool) {
      // A near miss ("search" for search_library) is named, so the next call gets it right.
      const near = nearestToolNames(name, [...byName.keys()].filter((n) => gm || !byName.get(n)?.write));
      note('error', `Tried a tool that does not exist: ${name}${near.length ? ` (meant ${near[0]}?)` : ''}.`);
      return { content: `Unknown tool "${name}".${near.length ? ` Did you mean ${near.map((n) => `"${n}"`).join(' or ')}? Call that instead.` : ' Use only the tools you were given.'}`, cites: [] };
    }
    // Arguments are checked against the tool's schema before anything runs or becomes a card: a card the GM approves must not then fail on a typo.
    const chk = checkArgs(tool, args ?? {});
    if (chk.problems.length) {
      note('error', `My ${name} call had bad arguments, fixing them: ${chk.problems.join('; ')}.`);
      return { content: `Not ${tool.write ? 'proposed' : 'run'}: ${chk.problems.join('; ')}. Fix the arguments and call ${name} again.`, cites: [] };
    }
    args = chk.args;
    // A template that would not be saved is sent back to the model with the reason, so it can fix it before the GM is asked.
    if (name === 'create_template') { try { readTemplate(args); } catch (e: any) { return { content: `Not proposed: ${String(e?.message ?? e).slice(0, 300)}. Fix the template and call create_template again.`, cites: [] }; } }
    // A web search that would not run (off, or a query with a GM-only or classified word) never becomes a card: nothing is sent.
    if (name === 'house_rule_save') { const why = saveProblem(c.worldId, args); if (why) return { content: why, cites: [] }; }
    if (name === 'web_research') { const why = webPrecheck(d, c.worldId, args); if (why) return { content: why, cites: [] }; }
    if (tool.write && !auto(name)) {
      // The same change already waiting in this chat (a model that repeats itself, or a retry) is not a second card.
      const same = one<{ id: string }>(d.db, "SELECT id FROM agent_actions WHERE chat_id = ? AND tool = ? AND args = ? AND status = 'pending'", chatId, name, JSON.stringify(args ?? {}));
      if (same) return { content: `Already proposed as action ${same.id}: ${describeCall(name, args)}. It is waiting for the GM; do not propose it again.`, proposed: same.id, duplicate: true, cites: [], summary: describeCall(name, args) };
      const aid = proposeAction(d, c, chatId, tool, args);
      note('ask', `Proposed: ${describeCall(name, args)}. Waiting for you.`, { actionId: aid });
      return { content: `Proposed to the GM as action ${aid}: ${describeCall(name, args)}. It has NOT run; it waits for the GM to approve it.`, proposed: aid, cites: [], summary: describeCall(name, args) };
    }
    if (!tool.write) note('look', `Looking up: ${lookText(name, args)}.`);
    const t = await runTool(d, c, tool, args);
    if (tool.write) note(t.ok ? 'do' : 'error', t.ok ? `Did it (${meta.source === 'task' ? 'task' : 'Auto'}): ${describeCall(name, args)}.` : `Tried “${describeCall(name, args)}” but it did not work: ${t.text.slice(0, 160)}`);
    else if (!t.ok) note('error', `${name} answered ${t.status}: ${t.text.slice(0, 160)}`);
    if (c.harness === 'gm') audit(d, c.worldId, c.accountId, tool.write ? 'agent.action' : 'agent.read', `${name} ${JSON.stringify(args ?? {})}${tool.write ? ` auto-approved -> ${t.status}` : ''}`);
    if (c.harness === 'gm' && tool.write) {
      logAgentCall(d, c.worldId, { tool: name, args, summary: describeCall(name, args), ok: t.ok, result: t.text, via: 'auto-approved' });
      // The chat shows what was applied without asking, as a card already settled.
      const aid = id('act_');
      run(d.db, 'INSERT INTO agent_actions (id, world_id, chat_id, account_id, tool, args, summary, call, status, result, created_at, decided_at, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)', aid, c.worldId, chatId, c.accountId, name, JSON.stringify(args ?? {}), describeCall(name, args), JSON.stringify(tool.call(args ?? {})), t.ok ? 'done' : 'failed', t.text.slice(0, 8000), now(), now());
      emitAction(d, c.worldId, c.accountId, aid);
    }
    return { content: (t.ok ? t.text : `Error ${t.status}: ${t.text}`).slice(0, budgetFor(d, c.harness).toolChars), ran: { ok: t.ok, status: t.status }, cites: t.ok ? citationsFrom(name, t.text) : [], summary: describeCall(name, args) };
  } catch (e: any) {
    note('error', `${name} failed: ${String(e?.message ?? e).slice(0, 160)}`);
    return { content: `The call failed: ${String(e?.message ?? e).slice(0, 200)}`, cites: [] };
  }
}

/** Cite the library pages that came with the question when the reply names them. */
function citedHits(reply: string, hits: Hit[]): Citation[] {
  const low = reply.toLowerCase();
  return hits.filter((h) => h.title.length >= 3 && (low.includes(`[${h.title.toLowerCase()}]`) || (h.title.length >= 5 && low.includes(h.title.toLowerCase())))).map((h) => ({ kind: 'page' as const, id: h.id, title: h.title, path: h.path, snippet: h.snippet.slice(0, 140) }));
}

/** Commands answered with no model. Null: not one (or it names something that is not there), so the model answers. */
async function runFast(d: Deps, c: Caller, input: RunInput, plan: FastPlan, byName: Map<string, McpTool>, auto: AutoCheck): Promise<{ text: string; cites: Citation[] } | null> {
  if (plan.kind === 'reply') return { text: plan.text, cites: [] };
  if (plan.kind === 'date') { const l = getClock(d.db, c.worldId).label; return { text: `It is **${l}**.`, cites: [] }; }
  let calls: { tool: string; args: Record<string, unknown> }[];
  let intro = '';
  if (plan.kind === 'pc') {
    // A player character is added as that player's own combatant, with the initiative they rolled.
    const members: any[] = (await get(d, c, '/members')) ?? [];
    const n = plan.name.trim().toLowerCase();
    const m = members.find((x) => String(x.character_name ?? '').toLowerCase() === n) ?? members.find((x) => String(x.display_name ?? '').toLowerCase() === n);
    calls = [{ tool: 'add_combatant', args: { name: m?.character_name || plan.name, initiative: plan.initiative, ...(m ? { accountId: m.id } : {}) } }];
    intro = m ? `Adding ${m.character_name || m.display_name} with initiative ${plan.initiative}.` : `Adding ${plan.name} with initiative ${plan.initiative} (no player by that name, so as a creature).`;
  } else if (plan.kind === 'calls') { calls = plan.calls; intro = plan.intro; }
  else {
    const combat = await get(d, c, '/live/combat');
    const list: { id: string; name: string }[] = combat?.combatants ?? [];
    if (plan.verb === 'who') {
      if (!combat?.active || !list.length) return { text: 'Combat is not running.', cites: [] };
      const cur = list[combat.turn % list.length];
      const nxt = list[(combat.turn + 1) % list.length];
      return { text: `It is **${cur.name}**'s turn (round ${combat.round}). Next: ${nxt.name}.`, cites: [] };
    }
    const who = matchCombatant(list, plan.target ?? '');
    if (!who) return null;
    if (plan.verb === 'init') { intro = `Initiative for ${who.name}.`; calls = [{ tool: 'set_initiative', args: { combatant: who.id, value: plan.amount } }]; }
    else {
      intro = `${plan.verb === 'damage' ? 'Damage' : 'Healing'} for ${who.name}.`;
      calls = [{ tool: plan.verb === 'damage' ? 'damage_combatant' : 'heal_combatant', args: { combatant: who.id, amount: plan.amount } }];
    }
  }
  const done = await Promise.all(calls.map((x) => execCall(d, c, input.chatId, byName, auto, x.tool, x.args, { runId: input.replyId, source: input.exec ? 'task' : 'assistant' })));
  const lines = done.map((r, i) => (r.proposed ? `- Waiting for your approval: ${r.summary}` : r.ran?.ok ? `- Done: ${r.summary}${(() => { const j = parseJson<any>(r.content, null); return (j?.removed ? ' (defeated and removed from the fight)' : j?.defeated ? ' (defeated)' : '') + (j?.concentrationSave ? ` (Constitution save DC ${j.concentrationSave.dc} due to keep concentrating on ${j.concentrationSave.spell})` : '') + (j?.died ? ' (dead)' : ''); })()}` : `- That did not work: ${describeCall(calls[i].tool, calls[i].args)}. ${r.content.slice(0, 160)}`));
  return { text: `${intro}\n\n${lines.join('\n')}`, cites: [] };
}

/**
 * The tool names to offer for a message. The player harness always uses the keyword selection. The GM harness follows
 * `opts.tools` (see options.ts); an embedding mode with no embeddings model answering falls back to the keyword selection.
 */
export async function chooseTools(d: Deps, opts: ReturnType<typeof agentOptions>, selText: string, requestText: string, tools: McpTool[], names: string[], gm: boolean): Promise<string[]> {
  const keywords = () => {
    const out = selectTools(selText, names, undefined, gm);
    // Words the category rules do not know still find a tool: the best matches by name and description are offered too.
    if (gm) for (const t of matchTools(tools, requestText, true, 3)) out.push(t.name);
    return out;
  };
  if (!gm || opts.tools === 'keywords') return keywords();
  const have = new Set(names);
  const core = GM_CORE_TOOLS.filter((n) => have.has(n));
  if (opts.tools === 'all') return names.filter((n) => !n.startsWith('my_'));
  if (opts.tools === 'core') return core;
  const near = await nearestTools(d, requestText, tools.filter((t) => !t.name.startsWith('my_')), opts.embedK);
  if (!near) return keywords();
  return opts.tools === 'embed' ? [...core, ...near] : [...keywords(), ...near];
}

/** Run one user message through the harness and store the reply. Never throws. */
export async function runAgent(d: Deps, c: Caller, input: RunInput): Promise<void> {
  const t0 = performance.now();
  const tell = () => d.hub.emit(c.worldId, 'agent', { kind: 'message', chatId: input.chatId }, only(c.accountId));
  const live = new Live(d, c, input.chatId, input.replyId);
  const ac = new AbortController();
  running.set(input.chatId, ac);
  const T: Timings = { totalMs: 0, modelMs: 0, toolMs: 0, prepMs: 0, gatewayMs: 0, rounds: 0, toolCalls: 0, snippets: 0, toolsOffered: 0 };
  const cites: Citation[] = [];
  const seen = new Set<string>();
  const addCites = (list: Citation[]) => { for (const ci of list) if (!seen.has(`${ci.kind}:${ci.id}`)) { seen.add(`${ci.kind}:${ci.id}`); cites.push(ci); } };
  let gate: SentenceGate | null = null;
  let hits: Hit[] = [];
  const finish = (text: string, status: 'done' | 'error', blocked = false) => {
    T.totalMs = ms(t0);
    T.gatewayMs = Math.max(0, T.totalMs - T.modelMs - T.toolMs + Math.round(gate?.ms ?? 0));
    T.gateMs = gate ? Math.round(gate.ms) : undefined;
    if (live.firstAt !== undefined) T.firstTokenMs = Math.round(live.firstAt - t0);
    finishMessage(d.db, input.replyId, text, status, blocked ? [] : cites, blocked, T);
    audit(d, c.worldId, c.accountId, 'agent.timing', `chat ${input.chatId} ${c.harness}: total ${T.totalMs}ms, first text ${T.firstTokenMs ?? '-'}ms, model ${T.modelMs}ms, tools ${T.toolMs}ms (${T.toolCalls}), prep ${T.prepMs}ms, gateway ${T.gatewayMs}ms, rounds ${T.rounds}, snippets ${T.snippets}, tools offered ${T.toolsOffered}${T.fast ? ', no model' : ''}`);
  };
  try {
    let tools = await harnessTools(c.harness);
    // A player is not offered what this world keeps for the GM (it would only answer 403).
    if (c.harness === 'player') tools = tools.filter((t) => !t.playerWhen || t.playerWhen(c.settings));
    const opts = agentOptions(d);
    if (c.harness === 'gm') {
      if (!opts.bible) tools = tools.filter((t) => t.name !== 'story_bible' && t.name !== 'related_pages');
      if (opts.desc === 'concise') tools = tools.map((t) => (CONCISE[t.name] ? { ...t, description: CONCISE[t.name] } : t));
    }
    const exec = c.harness === 'gm' ? input.exec : undefined;
    const meta: Required<RunMeta> = { runId: input.replyId, source: exec ? 'task' : 'assistant' };
    if (c.harness === 'gm') think(d, c.worldId, { ...meta, kind: 'plan', chatId: input.chatId, text: `${exec ? `Task (${exec.mode === 'do' ? 'doing it' : 'proposing'})` : 'Working on'}: “${input.text.slice(0, 160)}”` });
    // The GM's own chat asks the settings at every call (the per-tool list and the Auto switch); a player's never runs a write.
    let auto: AutoCheck = c.harness === 'gm' ? (name) => runsWithoutAsking(d, c.worldId, name) : () => false;
    if (exec) {
      const allow = new Set(exec.allow?.length ? exec.allow : TASK_DEFAULT_TOOLS);
      tools = tools.filter((t) => (t.write ? allow.has(t.name) && !TASK_DENY.test(t.name) : TASK_READS.includes(t.name) || allow.has(t.name)));
      const doNow = exec.mode === 'do' ? new Set(tools.filter((t) => t.write).map((t) => t.name)) : new Set<string>();
      auto = (name) => doNow.has(name);
    }
    const byName = new Map(tools.map((t) => [t.name, t]));

    if (input.fast) {
      const f = await runFast(d, c, input, input.fast, byName, auto);
      if (f) {
        T.fast = true;
        live.push(f.text);
        live.flush();
        addCites(f.cites);
        finish(f.text, 'done');
        tell();
        return;
      }
      if (!hasJob(d, c.harness === 'gm' ? 'gm' : 'player')) {
        finish("I could not match that to anything in the fight, and no chat model is set to work it out.", 'done');
        tell();
        return;
      }
    }

    // Everything before the first model call: the context and the tools to offer.
    const built = await buildContext(d, c, input);
    hits = built.hits;
    T.prepMs = built.prepMs;
    T.snippets = hits.length;
    if (c.harness === 'gm') T.hits = hits.map((x) => x.title);
    const gmHarness = c.harness === 'gm';
    // The GM's guides: a request that matches one (its triggers, or "use guide X") gets the guide and what its steps found.
    if (gmHarness) {
      const g = await applyGuides(d, { worldId: c.worldId, viewer: c.viewer, chatId: input.chatId, text: input.text, exec: (n, a) => execCall(d, c, input.chatId, byName, auto, n, a, meta) }).catch((e) => { console.error('agent: guides failed', e); return null; });
      if (g) {
        setGuideNotes(d.db, input.replyId, g.notes);
        live.status(`guide ${g.notes.map((x) => x.name).join(', ')}`);
        tell();
        if (g.context) built.text += `\n\n${g.context}`;
        addCites(g.cites as Citation[]);
      }
    }
    if (gmHarness) think(d, c.worldId, { ...meta, kind: 'look', chatId: input.chatId, text: `Read the context in ${took(built.prepMs)}: ${hits.length ? `${hits.length} library match${hits.length === 1 ? '' : 'es'} (${hits.slice(0, 3).map((h) => h.title).join(', ')}${hits.length > 3 ? ', …' : ''})` : 'no library matches'}.` });
    const names = tools.map((t) => t.name);
    const selText = `${input.text} ${input.context.selection ? 'selection' : ''}`;
    const picked = new Set(exec ? names.filter((n) => byName.get(n)?.write || TASK_READS.includes(n)).slice(0, 40) : await chooseTools(d, opts, selText, input.text, tools, names, gmHarness));
    // House rules that are on and that this message is about: their guidance for this person, the exact calls, what
    // they may see, and the tools (plus feature tools a rule names). The GM's assistant and a player's helper only.
    if (gmHarness || c.mode === 'helper') {
      const hr = ruleHints(d.db, c.worldId, `${input.text} ${input.context.selection ?? ''}`, gmHarness, c.accountId);
      if (hr.text) {
        built.text += `\n\n${hr.text}`;
        for (const n of hr.tools) if (byName.has(n)) picked.add(n);
        if (gmHarness) think(d, c.worldId, { ...meta, kind: 'look', chatId: input.chatId, text: `House rules this is about: ${hr.mods.join(', ')}.` });
      }
    }
    // Items from the world's item database that the GM's message names (a new homebrew item has no word in the tool picker).
    if (gmHarness) {
      const ih = itemHints(d.db, c.worldId, `${input.text} ${input.context.selection ?? ''}`);
      if (ih.text) {
        built.text += `\n\n${ih.text}`;
        for (const n of ih.tools) if (byName.has(n)) picked.add(n);
        think(d, c.worldId, { ...meta, kind: 'look', chatId: input.chatId, text: `Items this is about: ${ih.items.join(', ')}.` });
      }
    }
    // The sound tools carry what the sound library really holds (moods with a track, layer kinds), so the model does not guess.
    const soundMod = gmHarness ? await import('../sound/index.ts') : null;
    const offerNow = (): ChatTool[] => [...tools.filter((t) => picked.has(t.name)).map((t) => asChatTool(soundMod && SOUND_TOOLS.has(t.name) ? { ...t, description: `${t.description} Available now: ${soundMod.soundHint(d, c.worldId)}` } : t)), ...(gmHarness ? [MORE_TOOLS_TOOL] : [])];
    T.toolsOffered = offerNow().length;
    const userText = (input.history.filter((m) => m.role === 'user').map((m) => m.content ?? '') as string[]).concat(input.text, input.context.selection ?? '');
    const base = c.harness === 'player' ? leakChecker(d.db, c.worldId, [...userText, ...liftedTexts(d, c), ...playerTexts(d, c.worldId, c.accountId), ...all<{ answer: string }>(d.db, `SELECT answer FROM broker_requests WHERE world_id = ? AND account_id = ? AND status = 'answered' AND answer IS NOT NULL`, c.worldId, c.accountId).map((r) => r.answer)]) : null;
    // The broker never gives the GM's assistant away: her name, or that it works for the GM, blocks the reply like GM-only text does.
    const check = base ? (t: string) => { const g = personaGiveaway(t, agentName(d, c.worldId)); return g ? { blocked: true, match: g } : base(t); } : null;
    const taskNote = exec ? `\n\nThis message is a TASK from a macro or a spoken command, not a conversation. ${exec.mode === 'do' ? 'Carry it out now by calling the tools: they run at once with no confirmation. Do all the steps in one go (call several tools together). Use only the tools offered. Never invent ids: read them first (get_combat, search_library, list_sound_library).' : 'Propose the steps with the write tools (the GM confirms each).'} Players see what you change on their screens, so only show them party-level pages. Finish with one short line saying what you did.` : '';
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(c, input.summary, gmPersona(d, c), opts.skills) + taskNote }, ...input.history, { role: 'user', content: withContext(built.text, input.text) }];

    let reply = '';
    let done = false;
    // A source lookup that needed the GM (a blanket key's results, or pages above this player's view) is escalated by the tool: the reply says so and nothing more.
    let escalated = false;
    let wrote = false;
    let retried = false;
    let cutRetried = false;
    let mustCall = false;
    for (let round = 0; round < MAX_TOOL_ROUNDS + 1 && !done; round++) {
      const last = round === MAX_TOOL_ROUNDS || T.toolCalls >= MAX_TOOL_CALLS;
      if (last) messages.push({ role: 'user', content: 'You have used all your tool calls. Give your final answer now from what you have.' });
      if (check) gate = new SentenceGate(check, (s) => live.push(s));
      const g = gate;
      const tm = performance.now();
      let r;
      try {
        r = await chatStream(d, c.harness === 'gm' ? 'gm' : 'player', { messages: fitToBudget(messages, budgetFor(d, c.harness).tokens), tools: last ? undefined : offerNow(), parallelToolCalls: last ? undefined : true, toolChoice: mustCall && !last ? 'required' : undefined }, (t) => { if (g) g.push(t); else live.push(t); }, ac.signal);
        mustCall = false;
      } finally { T.modelMs += ms(tm); }
      T.rounds++;
      // The stream stopped with no finish reason after a few words (the connection dropped mid-answer): ask once more.
      if (!last && !r.toolCalls.length && r.finishReason === null && r.content.trim().length < 80 && !cutRetried) {
        cutRetried = true;
        live.reset();
        gate = null;
        continue;
      }
      if (!r.toolCalls.length || last) {
        reply = r.content;
        // The reply says something was proposed or changed but no write tool ran: give the model the tools for that area and one more go.
        if (gmHarness && !last && !retried && !wrote && claimsChange(reply, toolText(messages))) {
          retried = true;
          live.reset();
          for (const t of [...matchTools(tools, `${input.text} ${reply}`, true, 8), ...tools.filter((x) => selectTools(input.text, names, 99, true).includes(x.name))]) if (t.write) picked.add(t.name);
          // This time a tool call is required: asking alone let models answer "I did make the call" without one.
          mustCall = true;
          think(d, c.worldId, { ...meta, kind: 'skip', chatId: input.chatId, text: 'My answer said I changed something, but I had not called a tool for it. Trying again with the tools for that.' });
          messages.push({ role: 'assistant', content: reply }, { role: 'user', content: 'For my last message you said something was proposed or changed, but you made no write tool call. Call the write tool for my last message only, now. Do not repeat changes from earlier messages: those are already handled.' });
          continue;
        }
        done = true;
        break;
      }
      // The model wants tools: whatever it said so far is not the answer.
      live.reset();
      gate = null;
      messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.toolCalls });
      live.status(r.toolCalls.map((tc) => tc.function.name).join(', '));
      // What the model says before it calls tools is its plan in its own words: the closest thing to its thinking.
      if (gmHarness && r.content?.trim()) think(d, c.worldId, { ...meta, kind: 'plan', chatId: input.chatId, text: r.content.trim().slice(0, 300) });
      const tt = performance.now();
      let budget = Math.max(0, MAX_TOOL_CALLS - T.toolCalls);
      const results = await Promise.all(r.toolCalls.map(async (tc): Promise<Executed> => {
        const nm = tc.function?.name ?? '';
        const parsed = parseToolArgs(tc.function?.arguments);
        if (budget-- <= 0) return { content: 'Skipped: too many tool calls in one message. Answer from what you have.', cites: [] };
        if (!parsed.ok) { if (gmHarness) think(d, c.worldId, { ...meta, kind: 'error', chatId: input.chatId, text: `My ${nm} call was garbled; asking the model to send it again.` }); return { content: `Not run: ${parsed.error} Call ${nm} again.`, cites: [] }; }
        const args = parsed.args;
        if (nm === 'more_tools' && gmHarness) {
          const found = matchTools(tools, String(args?.query ?? ''), true);
          for (const t of found) picked.add(t.name);
          think(d, c.worldId, { ...meta, kind: 'look', chatId: input.chatId, text: `Looking for a tool for “${String(args?.query ?? '').slice(0, 80)}”: ${found.length ? found.slice(0, 5).map((t) => t.name).join(', ') : 'none found'}.` });
          return { content: `${describeTools(found)}\nThese tools are now offered; call one on your next step.`, cites: [] };
        }
        return execCall(d, c, input.chatId, byName, auto, nm, args, meta);
      }));
      for (const [i, tc] of r.toolCalls.entries()) { const t = byName.get(tc.function?.name ?? ''); if (t?.write && (results[i].proposed || results[i].ran)) wrote = true; }
      T.toolMs += ms(tt);
      T.toolCalls += r.toolCalls.length;
      r.toolCalls.forEach((tc, i) => { if (c.harness === 'player' && tc.function?.name === 'source_lookup' && parseJson<any>(results[i].content, null)?.escalated === true) escalated = true; });
      r.toolCalls.forEach((tc, i) => { messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function?.name ?? '', content: results[i].content }); addCites(results[i].cites); });
    }
    reply = reply.trim() || 'I have nothing to add.';
    // Still claiming a change nobody made: say so instead.
    // The history tags are for the model; a reply that copies one drops it.
    if (/\[(?:tool calls this turn:|no write tool calls this turn)/.test(reply)) { reply = reply.replace(/\n?\[(?:tool calls this turn:[^\]]*|no write tool calls this turn)\]/g, '').trim(); live.replace(reply); }
    if (gmHarness && !wrote && claimsChange(reply, toolText(messages))) { reply = rewriteClaim(reply, toolText(messages)); live.replace(reply); }
    let blocked = false;
    if (check) {
      const chk = check(reply);
      if (chk.blocked || gate?.blocked) {
        blocked = true;
        const match = chk.match ?? gate?.match ?? '';
        run(d.db, 'INSERT INTO agent_leaks (id, world_id, account_id, chat_id, matched, at) VALUES (?, ?, ?, ?, ?, ?)', id('lk_'), c.worldId, c.accountId, input.chatId, match, now());
        audit(d, c.worldId, c.accountId, 'agent.leak_blocked', `chat ${input.chatId}: reply shared GM-only text ("${match.slice(0, 80)}")`);
        d.hub.emit(c.worldId, 'agent', { kind: 'leak', chatId: input.chatId }, gmOnly);
        reply = BLOCKED_REPLY;
        live.replace(BLOCKED_REPLY);
      } else gate?.end();
    }
    live.flush();
    if (escalated && !blocked && !reply.includes(LOOKING)) { reply = `${reply}\n\n${LOOKING}`; live.replace(reply); }
    if (!blocked) addCites(citedHits(reply, hits));
    finish(reply, 'done', blocked);
    if (gmHarness) {
      const waiting = one<{ n: number }>(d.db, "SELECT COUNT(*) AS n FROM agent_actions WHERE chat_id = ? AND status = 'pending'", input.chatId)?.n ?? 0;
      think(d, c.worldId, { ...meta, kind: 'done', chatId: input.chatId, text: `Answered in ${took(T.totalMs)}${T.toolCalls ? `, ${T.toolCalls} tool call${T.toolCalls === 1 ? '' : 's'}` : ''}${waiting ? `. ${waiting} change${waiting === 1 ? '' : 's'} waiting for you` : ''}.`, detail: reply.slice(0, 600) });
    }
  } catch (err: any) {
    if (err instanceof ModelPreempted) {
      // The GM needed the model and this answer gave way (GM first, core/ai.ts): keep what was shown and say why it stopped.
      const shown = (gate ? gate.sent : live.text).trim();
      finish(`${shown ? `${shown}\n\n` : ''}${PAUSED_FOR_GM}`, 'done');
    } else if (err?.name === 'AbortError') {
      // Stopped by the user: keep what was shown (the player's is only what passed the check).
      const shown = (gate ? gate.sent : live.text).trim();
      finish(shown ? `${shown}\n\n_Stopped._` : '_Stopped._', 'done');
      if (c.harness === 'gm') think(d, c.worldId, { runId: input.replyId, source: input.exec ? 'task' : 'assistant', kind: 'skip', chatId: input.chatId, text: 'Stopped.' });
    } else {
      const msg = err instanceof ModelUnavailable ? `The chat model is not available: ${err.message}` : 'The agent hit an error. Try again.';
      if (!(err instanceof ModelUnavailable)) console.error('agent: run failed', err);
      finish(msg, 'error');
      if (c.harness === 'gm') think(d, c.worldId, { runId: input.replyId, source: input.exec ? 'task' : 'assistant', kind: 'error', chatId: input.chatId, text: msg });
    }
  } finally {
    running.delete(input.chatId);
    clearPartial(input.replyId);
  }
  tell();
  summarizeLater(d, input.chatId);
}

// ---- history ---------------------------------------------------------------------

/**
 * The history the model sees: the last HISTORY_WINDOW finished messages (more,
 * up to twice as many, while older ones are not in the summary yet), text only,
 * and the running summary of what came before.
 */
export function historyFor(d: Deps, chatId: string, window = HISTORY_WINDOW): { messages: ChatMessage[]; summary: string } {
  const rows = all<any>(d.db, `SELECT rowid AS rid, role, content, created_at FROM agent_messages WHERE chat_id = ? AND status = 'done' AND content <> '' ORDER BY rowid`, chatId);
  const chat = one<any>(d.db, 'SELECT summary, summary_upto FROM agent_chats WHERE id = ?', chatId);
  const upto = chat?.summary_upto ?? 0;
  const firstNew = rows.findIndex((r) => r.rid > upto);
  const start = Math.max(rows.length - window * 2, Math.min(rows.length - window, firstNew < 0 ? rows.length : firstNew), 0);
  // History is text only, so a model sees earlier replies saying "Proposed: ..." but not the tool calls behind them, and
  // starts replying like that without calling anything. Each earlier reply is tagged with the changes its turn really made.
  const acts = all<any>(d.db, 'SELECT tool, status, created_at FROM agent_actions WHERE chat_id = ? ORDER BY created_at', chatId);
  const tagged = rows.map((r, i) => {
    if (r.role !== 'assistant') return { role: r.role, content: r.content };
    const from = [...rows.slice(0, i)].reverse().find((x) => x.role === 'user')?.created_at ?? '';
    const to = rows.slice(i + 1).find((x) => x.role === 'user')?.created_at ?? '\uffff';
    const mine = acts.filter((a) => a.created_at >= from && a.created_at < to);
    const note = mine.length ? `[tool calls this turn: ${mine.map((a) => `${a.tool} (${a.status})`).join(', ')}]` : '[no write tool calls this turn]';
    return { role: r.role, content: `${r.content}\n${note}` };
  });
  return { messages: tagged.slice(start), summary: chat?.summary ?? '' };
}
