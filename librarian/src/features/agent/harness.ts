// The two harnesses over one chat model (PLAN §6.3). The harness decides
// what the model is given and what it may do:
//
//   DM harness      DM copies and DM transcript lines; every MCP tool; a
//                   write tool becomes a pending action the DM confirms.
//   Player harness  player copies and the players' transcript only; read
//                   tools only; the reply passes the leak check, one
//                   sentence at a time while it streams.
//
// Tools run against the librarian's own world API over loopback HTTP with
// the caller's own token (as routes/mcpServer.ts does), so the normal
// visibility rules apply and the player harness never holds a DM token.
//
// Speed: the static system prompt goes first (so a server can cache it); the
// per-message context (library matches, the page on screen, combat, the
// date) rides in the user message, so most questions are answered in one
// model round. Only the tools that fit the message are offered. Replies
// stream to the owner as 'agent' events. Obvious commands run with no model.
import type { Deps } from '../../app.ts';
import { chatStream, hasJob, rerankItems, ModelUnavailable, type ChatMessage, type ChatTool } from '../../core/ai.ts';
import { all, one, run } from '../../core/db.ts';
import { dmOnly, only } from '../../core/events.ts';
import type { Viewer, WorldSettings } from '../../core/policy.ts';
import { featureSetting } from '../../core/policy.ts';
import { now, parseJson, id } from '../../core/util.ts';
import type { McpTool } from '../types.ts';
import { getClock } from '../clock/api.ts';
import { listSessions, sessionLines } from '../audio/api.ts';
import { worldModules } from '../modules/store.ts';
import { fastPlan, matchCombatant, searchTerms, selectTools, type FastPlan } from './intent.ts';
import { BLOCKED_REPLY, SentenceGate, leakChecker } from './leak.ts';
import { clearPartial, finishMessage, setPartial, type Citation, type Timings } from './store.ts';
import { HISTORY_WINDOW, summarizeLater } from './summary.ts';

export const MAX_TOOL_ROUNDS = 8;
export { HISTORY_WINDOW };
const enc = encodeURIComponent;
const ms = (t0: number) => Math.round(performance.now() - t0);

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

export function systemPrompt(c: Pick<Caller, 'harness' | 'worldName'>, summary = ''): string {
  const dm = c.harness === 'dm';
  const L: string[] = dm
    ? [
      `You are the assistant of the Dungeon Master of the tabletop campaign "${c.worldName}". You talk only to the DM and may use everything they can see, including DM-only notes and secrets.`,
      'How to work:',
      '- The message starts with a context block: library matches, the page on screen, combat, the date. Use it first; most questions need no tool.',
      '- Facts about this world come only from that context, the transcript and tools. Never invent names, places, numbers or events. If it is not there, say what is unknown, and offer to look further or to propose something as a clearly marked suggestion.',
      '- Cite what you used inline as [Page title] with the exact title. Quote the transcript as (speaker, session).',
      '- Prefer a tool to a guess: search_library, read_page, search_transcript, get_combat. Answer rules questions with lookup_rule, never from memory.',
      '- Anything that changes the world is only proposed; the DM approves it. Say what you proposed. Never say it is done.',
      '- Be brief. Lead with the answer, then the detail. Short paragraphs or bullets in Markdown; no preamble, no repeating the question.',
    ]
    : [
      `You are a helpful guide for a player in the tabletop campaign "${c.worldName}". You know only what this player knows: the library pages shared with the party, what the players heard, and this player's own notes and items.`,
      'How to work:',
      '- The message starts with a context block: library matches, the page on screen, what you may know. Use it first; most questions need no tool.',
      '- Facts come only from that context and tools. If the answer is not in what you can see, say you do not know. Never guess at secrets, hidden plots or what the DM has planned, and never invent names, places or events.',
      '- Cite what you used inline as [Page title] with the exact title.',
      '- Prefer a tool to a guess: search_library, read_page, search_transcript.',
      '- You cannot change anything. If asked to, say the DM has to do it.',
      '- Be brief. Lead with the answer, then the detail. Short paragraphs or bullets in Markdown; no preamble.',
    ];
  if (summary) L.push(`\nEarlier in this chat (summary): ${summary}`);
  return L.join('\n');
}

// ---- context ------------------------------------------------------------------

/** Everything the agent is given from the library is the AI copy: a DM's viewer becomes the model's, which never sees classified content. */
const forModel = (v: Viewer): Viewer => (v.role === 'dm' ? { ...v, audience: 'ai' } : v);

const lineText = (l: { speaker: string; text: string; audience?: string }) => `${l.speaker}${l.audience === 'dm' ? ' (DM only)' : ''}: ${l.text}`;

function recentTranscript(d: Deps, worldId: string, includeDm: boolean, limit = 30): string {
  const s = listSessions(d.db, worldId)[0];
  if (!s) return '';
  const lines = sessionLines(d.db, worldId, s.id, { includeDm }).slice(-limit);
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

const WANTS_TRANSCRIPT = /\b(session|last (time|session|game)|recap|transcript|happened|said|told|heard|earlier|just now|we (met|found|fought|saw|decided))\b/i;
const WANTS_ITEMS = /\b(my items?|inventory|i (have|carry|own|bought)|my (gold|coins?|loot|stuff))\b/i;
const WANTS_BROKER = /\b(broker|bought|purchased|paid for|information i)\b/i;
const WANTS_PEOPLE = /\b(npc|people|person|who (is|was)|met|my notes?)\b/i;

const compactCombat = (j: any): string => {
  if (!j?.active && !j?.combatants?.length) return '';
  const list = (j.combatants ?? []).slice(0, 30).map((x: any, i: number) => {
    const bits = [`${i + 1}. ${x.name} (id ${x.id}) init ${x.initiative}`];
    if (x.hp !== undefined && x.hp !== null) bits.push(`HP ${x.hp}${x.max_hp ?? x.maxHp ? `/${x.max_hp ?? x.maxHp}` : ''}`);
    if (x.ac) bits.push(`AC ${x.ac}`);
    if (Array.isArray(x.effects) && x.effects.length) bits.push(x.effects.join(', '));
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
  const dm = c.harness === 'dm';
  const { text } = input;
  const ctxIn = input.context;
  const [combat, inv, brk, ppl] = await Promise.all([
    dm ? get(d, c, '/live/combat') : null,
    !dm && WANTS_ITEMS.test(text) ? get(d, c, '/inventory?owner=me') : null,
    !dm && WANTS_BROKER.test(text) ? get(d, c, '/broker') : null,
    !dm && WANTS_PEOPLE.test(text) ? get(d, c, '/people') : null,
  ]);
  let hits = prefetchLibrary(d, c, text, hasJob(d, 'rerank') ? 20 : 5);
  // The optional rerank job picks the best five of the top 20 within 300 ms (the snippets are this viewer's own copy); otherwise the keyword order stands.
  if (hits.length > 1 && hasJob(d, 'rerank')) hits = (await rerankItems(d, text, hits, (h) => `${h.title}\n${h.snippet}`)).slice(0, 5);
  const L: string[] = [];
  const clock = (() => { try { return getClock(d.db, c.worldId).label; } catch { return ''; } })();
  if (clock) L.push(`World date: ${clock}.`);
  const mods = worldModules(d.db, c.worldId).enabled.map((m) => m.name).join(', ');
  if (mods) L.push(`Game modules: ${mods}.`);
  const cb = dm ? compactCombat(combat) : '';
  if (cb) L.push(cb.slice(0, 2500));
  if (hits.length) {
    const top = hits.slice(0, 2).map((h) => {
      try { const pg: any = d.library.get(c.worldId, h.id, forModel(c.viewer)); return String(pg.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 500); } catch { return ''; }
    });
    L.push(`Library matches for this message (page id in parentheses; cite by [title]):\n${hits.map((h, i) => `- [${h.title}] (${h.id}): ${h.snippet}${top[i] && i < 2 ? `\n  Starts: ${top[i]}` : ''}`).join('\n')}`);
  } else L.push('Library matches for this message: none.');
  if (WANTS_TRANSCRIPT.test(text)) { const tr = recentTranscript(d, c.worldId, dm); if (tr) L.push(tr.slice(0, 4500)); }
  if (!dm) {
    if (inv?.items?.length) L.push(`This player's items: ${inv.items.map((i: any) => `${i.qty ?? 1} x ${i.name}${i.note ? ` (${i.note})` : ''}`).join('; ').slice(0, 1500)}`);
    const bought = (brk?.requests ?? []).filter((q: any) => q.answer && ['answered', 'noted'].includes(q.status)).slice(0, 12);
    if (bought.length) L.push(`Information this player bought from the broker:\n${bought.map((q: any) => `- Q: ${q.question}\n  A: ${q.answer}`).join('\n').slice(0, 3000)}`);
    const notes = (Array.isArray(ppl) ? ppl : ppl?.people ?? []).map((p: any) => (p.myNote || p.note ? `${p.name}: ${p.myNote ?? p.note}` : '')).filter(Boolean);
    if (notes.length) L.push(`This player's notes on people: ${notes.join('; ').slice(0, 1500)}`);
  }
  if (ctxIn.page) {
    try {
      const pg: any = d.library.get(c.worldId, ctxIn.page, forModel(c.viewer));
      L.push(`The user is looking at the library page [${pg.title}] (${pg.id}):\n${String(pg.body ?? '').slice(0, 5000)}`);
    } catch { /* not a page this viewer may open */ }
  }
  if (ctxIn.selection && !d.library.containsClassified(c.worldId, ctxIn.selection)) L.push(`The user selected this text on the page:\n"""${ctxIn.selection.slice(0, 3000)}"""`);
  return { text: L.join('\n\n'), hits, prepMs: ms(t0) };
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

export interface RunInput { chatId: string; replyId: string; text: string; context: MessageContext; history: ChatMessage[]; summary?: string; fast?: FastPlan | null }

/** Runs in progress, so the Stop button can end one. */
const running = new Map<string, AbortController>();
export const stopRun = (chatId: string): boolean => { const a = running.get(chatId); if (!a) return false; a.abort(); return true; };

function proposeAction(d: Deps, c: Caller, chatId: string, tool: McpTool, args: any): string {
  const aid = id('act_');
  const summary = describeCall(tool.name, args);
  run(d.db, 'INSERT INTO agent_actions (id, world_id, chat_id, account_id, tool, args, summary, call, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', aid, c.worldId, chatId, c.accountId, tool.name, JSON.stringify(args ?? {}), summary, JSON.stringify(tool.call(args ?? {})), 'pending', now());
  audit(d, c.worldId, c.accountId, 'agent.propose', `${tool.name} ${JSON.stringify(args ?? {})}`);
  d.hub.emit(c.worldId, 'agent', { kind: 'action', chatId, actionId: aid }, only(c.accountId));
  return aid;
}

interface Executed { content: string; proposed?: string; ran?: { ok: boolean; status: number }; cites: Citation[]; summary?: string }

/** One tool call from the model or a fast path: unknown tools are refused, writes become proposals, reads run. */
async function execCall(d: Deps, c: Caller, chatId: string, byName: Map<string, McpTool>, auto: Set<string>, name: string, args: any): Promise<Executed> {
  const tool = byName.get(name);
  try {
    // The player harness never lists write tools, and a call to one is refused here too.
    if (!tool) return { content: `Unknown tool "${name}".`, cites: [] };
    if (tool.write && !auto.has(name)) {
      const aid = proposeAction(d, c, chatId, tool, args);
      return { content: `Proposed to the DM as action ${aid}: ${describeCall(name, args)}. It has NOT run; it waits for the DM to approve it.`, proposed: aid, cites: [], summary: describeCall(name, args) };
    }
    const t = await runTool(d, c, tool, args);
    if (c.harness === 'dm') audit(d, c.worldId, c.accountId, tool.write ? 'agent.action' : 'agent.read', `${name} ${JSON.stringify(args ?? {})}${tool.write ? ` auto-approved -> ${t.status}` : ''}`);
    return { content: (t.ok ? t.text : `Error ${t.status}: ${t.text}`).slice(0, 12_000), ran: { ok: t.ok, status: t.status }, cites: t.ok ? citationsFrom(name, t.text) : [], summary: describeCall(name, args) };
  } catch (e: any) {
    return { content: `The call failed: ${String(e?.message ?? e).slice(0, 200)}`, cites: [] };
  }
}

/** Cite the library pages that came with the question when the reply names them. */
function citedHits(reply: string, hits: Hit[]): Citation[] {
  const low = reply.toLowerCase();
  return hits.filter((h) => h.title.length >= 3 && (low.includes(`[${h.title.toLowerCase()}]`) || (h.title.length >= 5 && low.includes(h.title.toLowerCase())))).map((h) => ({ kind: 'page' as const, id: h.id, title: h.title, path: h.path, snippet: h.snippet.slice(0, 140) }));
}

/** Commands answered with no model. Null: not one (or it names something that is not there), so the model answers. */
async function runFast(d: Deps, c: Caller, input: RunInput, plan: FastPlan, byName: Map<string, McpTool>, auto: Set<string>): Promise<{ text: string; cites: Citation[] } | null> {
  if (plan.kind === 'reply') return { text: plan.text, cites: [] };
  if (plan.kind === 'date') { const l = getClock(d.db, c.worldId).label; return { text: `It is **${l}**.`, cites: [] }; }
  let calls: { tool: string; args: Record<string, unknown> }[];
  let intro = '';
  if (plan.kind === 'calls') { calls = plan.calls; intro = plan.intro; }
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
    intro = `${plan.verb === 'damage' ? 'Damage' : 'Healing'} for ${who.name}.`;
    calls = [{ tool: plan.verb === 'damage' ? 'damage_combatant' : 'heal_combatant', args: { combatant: who.id, amount: plan.amount } }];
  }
  const done = await Promise.all(calls.map((x) => execCall(d, c, input.chatId, byName, auto, x.tool, x.args)));
  const lines = done.map((r, i) => (r.proposed ? `- Waiting for your approval: ${r.summary}` : r.ran?.ok ? `- Done: ${r.summary}` : `- That did not work: ${describeCall(calls[i].tool, calls[i].args)}. ${r.content.slice(0, 160)}`));
  return { text: `${intro}\n\n${lines.join('\n')}`, cites: [] };
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
    const tools = await harnessTools(c.harness);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const auto = c.harness === 'dm' ? new Set(featureSetting<string[]>(c.settings, 'agentAutoApprove') ?? []) : new Set<string>();

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
      if (!hasJob(d, 'chat')) {
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
    const picked = new Set(selectTools(`${input.text} ${input.context.selection ? 'selection' : ''}`, tools.map((t) => t.name)));
    const chatTools = tools.filter((t) => picked.has(t.name)).map(asChatTool);
    T.toolsOffered = chatTools.length;
    const userText = (input.history.filter((m) => m.role === 'user').map((m) => m.content ?? '') as string[]).concat(input.text, input.context.selection ?? '');
    const check = c.harness === 'player' ? leakChecker(d.db, c.worldId, [...userText, ...all<{ answer: string }>(d.db, `SELECT answer FROM broker_requests WHERE world_id = ? AND account_id = ? AND status = 'answered' AND answer IS NOT NULL`, c.worldId, c.accountId).map((r) => r.answer)]) : null;
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(c, input.summary) }, ...input.history, { role: 'user', content: withContext(built.text, input.text) }];

    let reply = '';
    let done = false;
    for (let round = 0; round < MAX_TOOL_ROUNDS + 1 && !done; round++) {
      const last = round === MAX_TOOL_ROUNDS;
      if (last) messages.push({ role: 'user', content: 'You have used all your tool calls. Give your final answer now from what you have.' });
      if (check) gate = new SentenceGate(check, (s) => live.push(s));
      const g = gate;
      const tm = performance.now();
      let r;
      try {
        r = await chatStream(d, 'chat', { messages, tools: last ? undefined : chatTools, parallelToolCalls: last ? undefined : true }, (t) => { if (g) g.push(t); else live.push(t); }, ac.signal);
      } finally { T.modelMs += ms(tm); }
      T.rounds++;
      if (!r.toolCalls.length || last) { reply = r.content; done = true; break; }
      // The model wants tools: whatever it said so far is not the answer.
      live.reset();
      gate = null;
      messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.toolCalls });
      live.status(r.toolCalls.map((tc) => tc.function.name).join(', '));
      const tt = performance.now();
      const results = await Promise.all(r.toolCalls.map((tc) => execCall(d, c, input.chatId, byName, auto, tc.function?.name ?? '', parseJson<any>(tc.function?.arguments, {}))));
      T.toolMs += ms(tt);
      T.toolCalls += r.toolCalls.length;
      r.toolCalls.forEach((tc, i) => { messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function?.name ?? '', content: results[i].content }); addCites(results[i].cites); });
    }
    reply = reply.trim() || 'I have nothing to add.';
    let blocked = false;
    if (check) {
      const chk = check(reply);
      if (chk.blocked || gate?.blocked) {
        blocked = true;
        const match = chk.match ?? gate?.match ?? '';
        run(d.db, 'INSERT INTO agent_leaks (id, world_id, account_id, chat_id, matched, at) VALUES (?, ?, ?, ?, ?, ?)', id('lk_'), c.worldId, c.accountId, input.chatId, match, now());
        audit(d, c.worldId, c.accountId, 'agent.leak_blocked', `chat ${input.chatId}: reply shared DM-only text ("${match.slice(0, 80)}")`);
        d.hub.emit(c.worldId, 'agent', { kind: 'leak', chatId: input.chatId }, dmOnly);
        reply = BLOCKED_REPLY;
        live.replace(BLOCKED_REPLY);
      } else gate?.end();
    }
    live.flush();
    if (!blocked) addCites(citedHits(reply, hits));
    finish(reply, 'done', blocked);
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      // Stopped by the user: keep what was shown (the player's is only what passed the check).
      const shown = (gate ? gate.sent : live.text).trim();
      finish(shown ? `${shown}\n\n_Stopped._` : '_Stopped._', 'done');
    } else {
      const msg = err instanceof ModelUnavailable ? `The chat model is not available: ${err.message}` : 'The agent hit an error. Try again.';
      if (!(err instanceof ModelUnavailable)) console.error('agent: run failed', err);
      finish(msg, 'error');
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
export function historyFor(d: Deps, chatId: string): { messages: ChatMessage[]; summary: string } {
  const rows = all<any>(d.db, `SELECT rowid AS rid, role, content FROM agent_messages WHERE chat_id = ? AND status = 'done' AND content <> '' ORDER BY rowid`, chatId);
  const chat = one<any>(d.db, 'SELECT summary, summary_upto FROM agent_chats WHERE id = ?', chatId);
  const upto = chat?.summary_upto ?? 0;
  const firstNew = rows.findIndex((r) => r.rid > upto);
  const start = Math.max(rows.length - HISTORY_WINDOW * 2, Math.min(rows.length - HISTORY_WINDOW, firstNew < 0 ? rows.length : firstNew), 0);
  return { messages: rows.slice(start).map((r) => ({ role: r.role, content: r.content })), summary: chat?.summary ?? '' };
}
