// The two harnesses over one chat model (PLAN §6.3). The harness decides
// what the model is given and what it may do:
//
//   DM harness      DM copies and DM transcript lines; every MCP tool; a
//                   write tool becomes a pending action the DM confirms.
//   Player harness  player copies and the players' transcript only; read
//                   tools only; the reply passes the leak check.
//
// Tools run against the librarian's own world API over loopback HTTP with
// the caller's own token (as routes/mcpServer.ts does), so the normal
// visibility rules apply and the player harness never holds a DM token.
import type { Deps } from '../../app.ts';
import { chat, ModelUnavailable, type ChatMessage, type ChatTool } from '../../core/ai.ts';
import { all, run } from '../../core/db.ts';
import { dmOnly, only } from '../../core/events.ts';
import type { Viewer, WorldSettings } from '../../core/policy.ts';
import { featureSetting } from '../../core/policy.ts';
import { now, parseJson, id } from '../../core/util.ts';
import type { McpTool } from '../types.ts';
import { getClock } from '../clock/api.ts';
import { listSessions, sessionLines } from '../audio/api.ts';
import { worldModules } from '../modules/store.ts';
import { BLOCKED_REPLY, leakCheck } from './leak.ts';
import { finishMessage, type Citation } from './store.ts';

export const MAX_TOOL_ROUNDS = 8;
const enc = encodeURIComponent;

export interface Caller {
  worldId: string;
  worldName: string;
  accountId: string;
  viewer: Viewer;
  harness: 'dm' | 'player';
  /** The caller's own session token; held in memory only for this run. */
  token: string;
  port: number;
  settings: WorldSettings;
}

const audit = (d: Deps, worldId: string, accountId: string | null, action: string, detail = '') =>
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());

/** The tools a harness may list: the player harness gets read tools only, whatever the model asks for. */
export async function harnessTools(harness: 'dm' | 'player'): Promise<McpTool[]> {
  // Loaded when first used: mcpServer imports the feature registry, which loads this feature.
  const m = await import('../../routes/mcpServer.ts');
  const tools = m.toolsFor(harness === 'dm');
  return harness === 'dm' ? tools : tools.filter((t) => !t.write);
}

const asChatTool = (t: McpTool): ChatTool => ({ type: 'function', function: { name: t.name, description: t.description, parameters: { type: 'object', properties: t.props, required: t.required ?? [] } } });

/** What a call will do, in words, for the DM to confirm. */
export function describeCall(tool: string, a: any): string {
  const n = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  switch (tool) {
    case 'add_combatant': {
      const hp = a.hp ?? a.maxHp ?? a.statblock?.hp;
      return `Add ${n(a.name)} to combat${hp !== undefined ? ` with ${hp} HP` : ''}${a.initiative !== undefined ? `, initiative ${a.initiative}` : ''}`;
    }
    case 'damage_combatant': return `Deal ${n(a.amount)} damage to combatant ${n(a.combatant)}`;
    case 'heal_combatant': return `Heal combatant ${n(a.combatant)} for ${n(a.amount)}`;
    case 'set_conditions': return `Set conditions on combatant ${n(a.combatant)} to: ${Array.isArray(a.conditions) && a.conditions.length ? a.conditions.join(', ') : 'none'}`;
    case 'next_turn': return 'Advance combat to the next turn';
    case 'make_statblock': return `Make a statblock from ${a.moduleTermId ? `module monster ${a.moduleTermId}` : a.pageId ? `page ${a.pageId}` : `"${n(a.prompt).slice(0, 80)}"`}${a.addToCombat ? ' and add it to combat' : ''}`;
    case 'save_page': return `Save library page ${n(a.path)}${a.visibility === 'party' ? ' (shared with the party)' : ' (DM only)'}`;
    case 'add_person': return `Add ${n(a.name)} to People`;
    case 'add_item': return `Give ${n(a.qty ?? 1)} x ${n(a.name)} to ${n(a.owner)}`;
    case 'add_coin': return `Change ${n(a.owner)} coin by ${n(a.amountCp)} cp`;
    case 'advance_world_time': return `Advance the world clock: ${JSON.stringify(a)}`;
    default: return `Run ${tool} ${JSON.stringify(a ?? {}).slice(0, 200)}`;
  }
}

export interface ToolRun { ok: boolean; status: number; text: string }

/** Call a tool against the world API with the given token. */
export async function runTool(d: Deps, caller: { worldId: string; token: string; port: number }, tool: McpTool, args: any): Promise<ToolRun> {
  for (const k of tool.required ?? []) if (args?.[k] === undefined) return { ok: false, status: 400, text: `Missing ${k}` };
  const c = tool.call(args ?? {});
  const base = `http://127.0.0.1:${caller.port}/api/worlds/${enc(caller.worldId)}`;
  try {
    const r = await d.fetch(base + c.path, { method: c.method, headers: { Authorization: `Bearer ${caller.token}`, 'Content-Type': 'application/json' }, body: c.body === undefined ? undefined : JSON.stringify(c.body) });
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

// ---- context ------------------------------------------------------------------

const lineText = (l: { speaker: string; text: string; audience?: string }) => `${l.speaker}${l.audience === 'dm' ? ' (DM only)' : ''}: ${l.text}`;

function recentTranscript(d: Deps, worldId: string, includeDm: boolean, limit = 40): string {
  const s = listSessions(d.db, worldId)[0];
  if (!s) return '';
  const lines = sessionLines(d.db, worldId, s.id, { includeDm }).slice(-limit);
  return lines.length ? `Transcript of "${s.name}" (latest ${lines.length} lines, session ${s.id}):\n${lines.map(lineText).join('\n')}` : '';
}

async function get(d: Deps, c: Caller, path: string): Promise<any> {
  try {
    const r = await d.fetch(`http://127.0.0.1:${c.port}/api/worlds/${enc(c.worldId)}${path}`, { headers: { Authorization: `Bearer ${c.token}` } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export interface MessageContext { page?: string; selection?: string }

/** The system prompt: what this harness may know. */
export async function buildSystem(d: Deps, c: Caller, ctxIn: MessageContext): Promise<string> {
  const dm = c.harness === 'dm';
  const clock = (() => { try { return getClock(d.db, c.worldId).label; } catch { return ''; } })();
  const mods = worldModules(d.db, c.worldId).enabled.map((m) => m.name).join(', ');
  const L: string[] = [];
  if (dm) {
    L.push(`You are the DM's assistant for the tabletop campaign "${c.worldName}". You can see everything the DM can, including DM-only notes and secrets, and you talk only to the DM.`,
      'Use the tools to look things up instead of guessing; cite the pages and transcript lines you used by naming them. Anything that changes the world (a write tool) is only proposed: the DM confirms it before it runs, so say what you proposed and do not claim it is done. Answer rules questions with lookup_rule, never from memory.');
  } else {
    L.push(`You are a helpful guide for a player in the tabletop campaign "${c.worldName}". You know only what this player knows: the library pages shared with the party, what the players heard, and this player's own notes and items.`,
      'Use the tools to look things up. If you do not have something in what you can see, say you do not know. Never guess at secrets, hidden plots or what the DM has planned. You cannot change anything.');
  }
  if (clock) L.push(`World date: ${clock}.`);
  if (mods) L.push(`Game modules: ${mods}.`);
  const combat = await get(d, c, '/live/combat');
  if (combat?.active || combat?.combatants?.length) L.push(`Combat now (as you may see it): ${JSON.stringify(combat).slice(0, 3000)}`);
  const tr = recentTranscript(d, c.worldId, dm);
  if (tr) L.push(tr.slice(0, 6000));
  if (!dm) {
    const inv = await get(d, c, '/inventory?owner=me');
    if (inv?.items?.length) L.push(`This player's items: ${inv.items.map((i: any) => `${i.qty ?? 1} x ${i.name}${i.note ? ` (${i.note})` : ''}`).join('; ').slice(0, 1500)}`);
    const brk = await get(d, c, '/broker');
    const bought = (brk?.requests ?? []).filter((q: any) => q.answer && ['answered', 'noted'].includes(q.status)).slice(0, 12);
    if (bought.length) L.push(`Information this player bought from the broker:\n${bought.map((q: any) => `- Q: ${q.question}\n  A: ${q.answer}`).join('\n').slice(0, 3000)}`);
    const ppl = await get(d, c, '/people');
    const notes = (Array.isArray(ppl) ? ppl : ppl?.people ?? []).map((p: any) => (p.myNote || p.note ? `${p.name}: ${p.myNote ?? p.note}` : '')).filter(Boolean);
    if (notes.length) L.push(`This player's notes on people: ${notes.join('; ').slice(0, 1500)}`);
  }
  if (ctxIn.page) {
    try {
      const pg: any = d.library.get(c.worldId, ctxIn.page, c.viewer);
      L.push(`The user is looking at the library page "${pg.title}" (${pg.id}):\n${String(pg.body ?? '').slice(0, 5000)}`);
    } catch { /* not a page this viewer may open */ }
  }
  if (ctxIn.selection) L.push(`The user selected this text on the page:\n"""${ctxIn.selection.slice(0, 3000)}"""`);
  return L.join('\n\n');
}

// ---- the loop -------------------------------------------------------------------

export interface RunInput { chatId: string; replyId: string; text: string; context: MessageContext; history: ChatMessage[] }

function proposeAction(d: Deps, c: Caller, chatId: string, tool: McpTool, args: any): string {
  const aid = id('act_');
  const summary = describeCall(tool.name, args);
  run(d.db, 'INSERT INTO agent_actions (id, world_id, chat_id, account_id, tool, args, summary, call, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', aid, c.worldId, chatId, c.accountId, tool.name, JSON.stringify(args ?? {}), summary, JSON.stringify(tool.call(args ?? {})), 'pending', now());
  audit(d, c.worldId, c.accountId, 'agent.propose', `${tool.name} ${JSON.stringify(args ?? {})}`);
  d.hub.emit(c.worldId, 'agent', { kind: 'action', chatId, actionId: aid }, only(c.accountId));
  return aid;
}

/** Run one user message through the harness and store the reply. Never throws. */
export async function runAgent(d: Deps, c: Caller, input: RunInput): Promise<void> {
  const tell = () => d.hub.emit(c.worldId, 'agent', { kind: 'message', chatId: input.chatId }, only(c.accountId));
  try {
    const tools = await harnessTools(c.harness);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const auto = c.harness === 'dm' ? new Set(featureSetting<string[]>(c.settings, 'agentAutoApprove') ?? []) : new Set<string>();
    const messages: ChatMessage[] = [{ role: 'system', content: await buildSystem(d, c, input.context) }, ...input.history, { role: 'user', content: input.text }];
    const chatTools = tools.map(asChatTool);
    const cites: Citation[] = [];
    const seen = new Set<string>();
    let reply = '';
    let done = false;
    for (let round = 0; round < MAX_TOOL_ROUNDS && !done; round++) {
      const r = await chat(d, 'chat', { messages, tools: chatTools });
      if (!r.toolCalls.length) { reply = r.content; done = true; break; }
      messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.toolCalls });
      for (const tc of r.toolCalls) {
        const name = tc.function?.name ?? '';
        const args = parseJson<any>(tc.function?.arguments, {});
        const tool = byName.get(name);
        let result: string;
        try {
        if (!tool) {
          // The player harness never lists write tools, and a call to one is refused here too.
          result = `Unknown tool "${name}".`;
        } else if (tool.write && !auto.has(name)) {
          const aid = proposeAction(d, c, input.chatId, tool, args);
          result = `Proposed to the DM as action ${aid}: ${describeCall(name, args)}. It has NOT run; it waits for the DM to approve it.`;
        } else {
          const t = await runTool(d, c, tool, args);
          if (c.harness === 'dm') audit(d, c.worldId, c.accountId, tool.write ? 'agent.action' : 'agent.read', `${name} ${JSON.stringify(args ?? {})}${tool.write ? ` auto-approved -> ${t.status}` : ''}`);
          result = t.ok ? t.text : `Error ${t.status}: ${t.text}`;
          if (t.ok) for (const ci of citationsFrom(name, t.text)) if (!seen.has(`${ci.kind}:${ci.id}`)) { seen.add(`${ci.kind}:${ci.id}`); cites.push(ci); }
        }
        } catch (e: any) {
          result = `The call failed: ${String(e?.message ?? e).slice(0, 200)}`;
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, name, content: result.slice(0, 12_000) });
      }
    }
    if (!done) {
      messages.push({ role: 'user', content: 'You have used all your tool calls. Give your final answer now from what you have.' });
      reply = (await chat(d, 'chat', { messages })).content;
    }
    reply = reply.trim() || 'I have nothing to add.';
    let blocked = false;
    if (c.harness === 'player') {
      const userText = (input.history.filter((m) => m.role === 'user').map((m) => m.content ?? '') as string[]).concat(input.text, input.context.selection ?? '');
      const chk = leakCheck(d.db, c.worldId, reply, userText);
      if (chk.blocked) {
        blocked = true;
        run(d.db, 'INSERT INTO agent_leaks (id, world_id, account_id, chat_id, matched, at) VALUES (?, ?, ?, ?, ?, ?)', id('lk_'), c.worldId, c.accountId, input.chatId, chk.match ?? '', now());
        audit(d, c.worldId, c.accountId, 'agent.leak_blocked', `chat ${input.chatId}: reply shared DM-only text ("${(chk.match ?? '').slice(0, 80)}")`);
        d.hub.emit(c.worldId, 'agent', { kind: 'leak', chatId: input.chatId }, dmOnly);
        reply = BLOCKED_REPLY;
      }
    }
    finishMessage(d.db, input.replyId, reply, 'done', blocked ? [] : cites, blocked);
  } catch (err: any) {
    const msg = err instanceof ModelUnavailable ? `The chat model is not available: ${err.message}` : 'The agent hit an error. Try again.';
    if (!(err instanceof ModelUnavailable)) console.error('agent: run failed', err);
    finishMessage(d.db, input.replyId, msg, 'error');
  }
  tell();
}

/** The history the model sees: earlier finished messages, text only. */
export function historyFor(d: Deps, chatId: string, limit = 16): ChatMessage[] {
  const rows = all<any>(d.db, `SELECT role, content FROM agent_messages WHERE chat_id = ? AND status = 'done' AND content <> '' ORDER BY created_at DESC, rowid DESC LIMIT ?`, chatId, limit).reverse();
  return rows.map((r) => ({ role: r.role, content: r.content }));
}
