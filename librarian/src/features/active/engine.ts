// Active mode: the engine. Lines arrive from the transcript as they settle;
// the rules pass reads each in a few milliseconds, the audit model settles
// the unsure ones and finds scene changes the rules cannot, and each action
// then runs at once (with an undo), waits on a confirm card, or is dropped,
// by the category's setting. Fail closed throughout: players only ever see
// party-level content, GM asides only set off GM-side things, classified
// text never reaches a model, and nothing destructive runs from here.
import type { Deps } from '../../app.ts';
import { chatJson, hasJob, ModelUnavailable, withPriority } from '../../core/ai.ts';
import { examplesOn, similarLineExamples } from './examples.ts';
import { all, one } from '../../core/db.ts';
import { gmOnly, only } from '../../core/events.ts';
import { parseJson } from '../../core/util.ts';
import { listSessions } from '../audio/api.ts';
import { onTranscriptLine } from '../audio/hooks.ts';
import { engine } from '../audio/engine.ts';
import { indexOf } from '../sound/index.ts';
import { PLAYER } from '../stage/cards.ts';
import { suggestionPass } from '../minerva/live.ts';
import { ASIDE_OK, build, type Call, type Candidate } from './intents.ts';
import { allCues, layersOf, norm, wakeCommand, type CueCtx, type Intent, type LineIn, type Scored } from './cues.ts';
import { execCalls, callOne, gmAuth, portOf } from './exec.ts';
import { addLog, addRule, effectiveMode, expireCards, getLog, getState, hasRule, listLog, setLog, undoOf, type LogRow } from './store.ts';
import { parseCommand, runCommand } from './commands.ts';
import { think, type Thought } from './thoughts.ts';

// ---- tunables --------------------------------------------------------------------------
export const SETTLE_MS = 700;
export const MAX_WAIT_MS = 2000;
export const AUTO_PER_MINUTE = 14;
const SCAN_EVERY_MS = 2000;

interface LineRow { id: string; session_id: string; world_id: string; start_ms: number; speaker_account: string | null; speaker_label: string; text: string; sources: string; audience: 'players' | 'gm'; updated_at: string }

interface Wstate {
  timer?: ReturnType<typeof setTimeout>; first?: number; pending: Set<string>; busy: Promise<void>; seen: Map<string, string>; acted: Map<string, Set<string>>;
  recent: Map<string, number>; initiativeUntil: number; lastScan: number; sinceNotes: number; lastLines: string[];
}
const states = new WeakMap<Deps, Map<string, Wstate>>();
const ws = (d: Deps, worldId: string): Wstate => {
  let m = states.get(d);
  if (!m) { m = new Map(); states.set(d, m); }
  let s = m.get(worldId);
  if (!s) { s = { pending: new Set(), busy: Promise.resolve(), seen: new Map(), acted: new Map(), recent: new Map(), initiativeUntil: 0, lastScan: 0, sinceNotes: 0, lastLines: [] }; m.set(worldId, s); }
  return s;
};

/** Tests: forget what was seen and done recently. */
export function resetActiveMemory(d: Deps, worldId: string) { states.get(d)?.delete(worldId); }

export interface Stats { lines: number; rulesMs: number[]; cands: number; auto: number; ask: number; blocked: number; modelCalls: number; modelMs: number[] }
const stats = new WeakMap<Deps, Stats>();
export const statsOf = (d: Deps): Stats => { let s = stats.get(d); if (!s) { s = { lines: 0, rulesMs: [], cands: 0, auto: 0, ask: 0, blocked: 0, modelCalls: 0, modelMs: [] }; stats.set(d, s); } return s; };

// ---- queue -----------------------------------------------------------------------------
onTranscriptLine((d, worldId, lineId, removed) => { if (!removed) enqueue(d, worldId, lineId); });

function enqueue(d: Deps, worldId: string, lineId: string) {
  const s = ws(d, worldId);
  s.pending.add(lineId);
  s.first ??= Date.now();
  clearTimeout(s.timer);
  const wait = Math.max(0, Math.min(SETTLE_MS, MAX_WAIT_MS - (Date.now() - s.first)));
  s.timer = setTimeout(() => { void flushActive(d, worldId).catch((e) => console.error('active: pass failed', e)); }, wait);
  s.timer.unref?.();
}

/** Process what is queued now (tests call this instead of waiting). */
export function flushActive(d: Deps, worldId: string): Promise<void> {
  const s = ws(d, worldId);
  clearTimeout(s.timer);
  s.first = undefined;
  const ids = [...s.pending];
  s.pending.clear();
  s.busy = s.busy.then(() => (ids.length ? handleLines(d, worldId, ids) : undefined)).catch((e) => { console.error('active: batch failed', e); });
  return s.busy;
}

// ---- context -----------------------------------------------------------------------------
export function loadCtx(d: Deps, worldId: string, initiativeOpen: boolean): CueCtx {
  const st = one<any>(d.db, 'SELECT * FROM combat WHERE world_id = ?', worldId) ?? { active: 0, turn: 0 };
  const rows = all<any>(d.db, 'SELECT * FROM combatants WHERE world_id = ? ORDER BY initiative DESC, name', worldId);
  const party = all<any>(d.db, "SELECT a.id, a.display_name, m.character_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.role = 'player'", worldId)
    .map((r) => ({ accountId: r.id as string, name: String(r.display_name ?? ''), character: String(r.character_name ?? '') }));
  let pages: CueCtx['pages'] = [];
  try { pages = (d.library.list(worldId, PLAYER) as any[]).map((p) => ({ id: p.id, title: p.title, path: p.path })); } catch { pages = []; }
  let sfx: string[] = [];
  try { sfx = indexOf(d).sfx.map((x) => x.name); } catch { sfx = []; }
  return {
    combat: { active: !!st.active, turn: st.turn, combatants: rows.map((x) => ({ id: x.id, name: x.name, hp: x.hp, maxHp: x.max_hp, effects: parseJson<any[]>(x.effects, []).map((e) => String(e?.name ?? e)), isPc: !!x.is_pc, accountId: x.account_id, concentration: parseJson(x.concentration, null) })) },
    party, pages, sfx, initiativeOpen,
  };
}

function lineOf(d: Deps, worldId: string, r: LineRow): LineIn & { audience: 'players' | 'gm'; gmMic: boolean; at: string } {
  const role = r.speaker_account ? (one<{ role: string }>(d.db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', worldId, r.speaker_account)?.role ?? 'other') : 'other';
  const mics = parseJson<string[]>(r.sources, []).map((id) => one<any>(d.db, 'SELECT m.room, mem.role FROM audio_mics m LEFT JOIN members mem ON mem.account_id = m.account_id AND mem.world_id = m.world_id WHERE m.id = ?', id));
  // The wake word counts only when no player's own mic is among the sources.
  const gmMic = role === 'gm' && mics.every((m) => m && (m.role === 'gm' || m.room));
  return { id: r.id, text: r.text, speaker: r.speaker_label || '', role: role === 'gm' ? 'gm' : role === 'player' ? 'player' : 'other', accountId: r.speaker_account, aside: r.audience === 'gm', audience: r.audience, gmMic, at: r.updated_at };
}

// ---- the batch -------------------------------------------------------------------------
interface Item { line: ReturnType<typeof lineOf>; cands: Candidate[]; explicit?: boolean }

async function handleLines(d: Deps, worldId: string, ids: string[]): Promise<void> {
  const sess = listSessions(d.db, worldId)[0];
  if (!sess || !sess.active) return;
  const state = getState(d, worldId);
  const mode = effectiveMode(d, worldId, sess.id);
  const W = ws(d, worldId);
  const rows = ids.map((id) => one<LineRow>(d.db, 'SELECT * FROM audio_lines WHERE id = ?', id)).filter((r): r is LineRow => !!r && r.session_id === sess.id).sort((a, b) => a.start_ms - b.start_ms);
  const ctx = loadCtx(d, worldId, Date.now() < W.initiativeUntil);
  const items: Item[] = [];
  const stat = statsOf(d);
  for (const r of rows) {
    const line = lineOf(d, worldId, r);
    // A room mic hears everybody and names no speaker: it counts as the GM's voice only if the GM said so (never for the wake word).
    if (line.role === 'other' && !line.accountId && state.listen.room) line.role = 'gm';
    const sig = norm(line.text);
    if (W.seen.get(line.id) === sig) continue;
    W.seen.set(line.id, sig);
    stat.lines++;
    // Classified text is never read by anything here.
    if (d.library.containsClassified(worldId, line.text)) continue;
    if (line.role === 'gm' && !state.listen.gm) continue;
    if (line.role === 'player' && !state.listen.players) continue;
    const t0 = performance.now();
    // Wake word: the GM's own mic only. The rest of the line is a direct request.
    const cmd = line.role === 'gm' && line.gmMic ? wakeCommand(line.text, state.wakeWord) : null;
    if (cmd) { hideWake(d, worldId, r); await handleWake(d, worldId, line, cmd, sess.id, mode); continue; }
    if (mode !== 'active') continue;
    think(d, worldId, { source: 'active', kind: 'heard', text: `${line.speaker || 'Table'}${line.aside ? ' (GM aside)' : ''}: “${line.text.slice(0, 160)}”` });
    const cues = allCues(line, ctx);
    stat.rulesMs.push(performance.now() - t0);
    const cands = cues.map((c) => build(d, worldId, ctx, c, line.text)).filter((c): c is Candidate => !!c);
    if (cands.length) think(d, worldId, { source: 'active', kind: 'plan', runId: line.id, text: `${line.speaker || 'Table'} said “${line.text.slice(0, 120)}”. That sounds like: ${cands.map((c) => `${c.summary}${c.confidence < 0.8 || c.borderline ? ' (not sure)' : ''}`).join('; ')}` });
    for (const c of cands) if (c.kind === 'combat_start') W.initiativeUntil = Date.now() + 90_000;
    // A line already acted on that is revised: only what it did not already do.
    const done = W.acted.get(line.id) ?? new Set<string>();
    const fresh = cands.filter((c) => !done.has(`${c.calls[0]?.tool}:${c.calls[0]?.args?.combatant ?? c.kind}`));
    // A revised line saying the same thing about the same target with another number is the speech model correcting itself: ignore it.
    items.push({ line, cands: fresh });
    for (const c of fresh) { const set = W.acted.get(line.id) ?? new Set<string>(); set.add(`${c.calls[0]?.tool}:${c.calls[0]?.args?.combatant ?? c.kind}`); W.acted.set(line.id, set); }
  }
  if (mode !== 'active' || !items.length) return;

  // Player-spoken item use needs the player's own inventory.
  for (const it of items) for (const c of cuesForUse(it, ctx)) it.cands.push(...useCandidates(d, worldId, it.line, c));

  // Sure things run at once. The model then settles the unsure ones and reads the narration the rules could not, and those run when it answers.
  const unsure = (c: Candidate) => c.borderline || c.confidence < 0.8;
  const model = hasJob(d, 'audit');
  const later: Item[] = items.map((it) => ({ line: it.line, cands: [] as Candidate[] }));
  if (model) {
    for (const [i, it] of items.entries()) { later[i].cands = it.cands.filter(unsure); it.cands = it.cands.filter((c) => !unsure(c)); }
  } else for (const it of items) for (const c of it.cands) if (unsure(c)) { c.forceAsk = true; c.why ??= 'I am not sure of it and no audit model is set to check'; }
  for (const it of items) for (const c of it.cands) await act(d, worldId, sess.id, state, c, it.line, 'line');
  if (model) {
    const known = items.map((it, i) => [...it.cands, ...later[i].cands].map((c) => c.category));
    await confirm(d, worldId, later);
    const found = state.scan ? await scan(d, worldId, items.map((it, i) => ({ line: it.line, cands: [...it.cands, ...later[i].cands] })), ctx, W, known) : [];
    for (const it of later) for (const c of it.cands) await act(d, worldId, sess.id, state, c, it.line, 'line');
    for (const it of found) for (const c of it.cands) await act(d, worldId, sess.id, state, c, it.line, 'line');
  }
  W.sinceNotes += items.length;
  // Clues, new NPCs and promises: drafts only, in the Review queue.
  if (state.cats.notes === 'draft' && W.sinceNotes >= 12) { W.sinceNotes = 0; void suggestionPass(d, worldId, { force: true }).catch(() => {}); }
}

function cuesForUse(it: Item, ctx: CueCtx): Scored[] {
  if (it.line.role !== 'player') return [];
  return allCues({ ...it.line }, ctx).filter((c) => c.kind === 'use_item');
}
function useCandidates(d: Deps, worldId: string, line: LineIn, c: Scored): Candidate[] {
  if (c.kind !== 'use_item') return [];
  const want = norm(c.phrase).split(' ').filter((t) => t.length >= 3 && !['the', 'and', 'for', 'one', 'some'].includes(t));
  if (!want.length) return [];
  const mine = all<any>(d.db, "SELECT id, name, qty FROM items WHERE world_id = ? AND owner = ? AND status = 'approved'", worldId, c.accountId);
  const hit = mine.find((i) => want.every((t) => norm(i.name).includes(t))) ?? mine.find((i) => want.some((t) => t.length >= 4 && norm(i.name).includes(t)));
  if (!hit || !(hit.qty >= 1)) return [];
  return [{ category: 'items', calls: [{ tool: 'inventory_patch', args: { id: hit.id, qty: hit.qty - 1, prevQty: hit.qty } }], summary: `${line.speaker || 'A player'} uses ${hit.name} (${hit.qty} left becomes ${hit.qty - 1})`, confidence: 0.75, cue: line.text.slice(0, 200), ruleKey: `use_item:${norm(hit.name).slice(0, 30)}`, visible: 'players', dedupeKey: `use:${hit.id}`, dedupeMs: 30_000, playerSource: true, forceAsk: true, source: 'rules', kind: 'use_item' }];
}

// ---- the model layer ---------------------------------------------------------------------
async function modelJson(d: Deps, worldId: string, system: string, user: string): Promise<any | null> {
  const st = statsOf(d);
  const t0 = performance.now();
  try {
    st.modelCalls++;
    // Active mode acts on what is said now: GM priority in the model queue.
    return await withPriority(2, () => chatJson(d, 'audit', [{ role: 'system', content: system }, { role: 'user', content: user }]));
  } catch (e) { if (e instanceof ModelUnavailable) return null; console.error('active: model call failed', (e as any)?.message ?? e); return null; }
  finally { st.modelMs.push(performance.now() - t0); void worldId; }
}

const recentText = (d: Deps, lines: ReturnType<typeof lineOf>[], upto: number) => lines.slice(Math.max(0, upto - 5), upto + 1).map((l) => `${l.speaker || '?'}${l.role === 'gm' ? ' (GM)' : ''}: ${l.text}`).join('\n');

async function confirm(d: Deps, worldId: string, items: Item[]): Promise<void> {
  const unsure: { it: Item; c: Candidate }[] = [];
  for (const it of items) for (const c of it.cands) if (c.borderline || c.confidence < 0.8) unsure.push({ it, c });
  if (!unsure.length) return;
  think(d, worldId, { source: 'active', kind: 'look', text: `Not sure about ${unsure.length === 1 ? `“${unsure[0].c.summary}”` : `${unsure.length} ideas`}: asking the audit model whether it was meant to happen now.` });
  const ctxLines = items.map((x) => x.line);
  const j = await modelJson(d, worldId,
    'You check actions that a tabletop RPG assistant drafted from a transcript line, using simple rules. Say ok:true only when the speaker clearly means this to happen now, at the table. Say ok:false for a question, a hypothetical, a plan, something that already happened, a price or an offer, or something the players only discuss. Reply with JSON only: {"verdicts":[{"i":0,"ok":true}]}',
    `Transcript (latest last):\n${ctxLines.slice(-8).map((l) => `${l.speaker || '?'}${l.role === 'gm' ? ' (GM)' : ''}: ${l.text}`).join('\n').slice(0, 2500)}\n\nProposed actions:\n${unsure.map((u, i) => `${i}. ${u.c.summary} (from: "${u.c.cue.slice(0, 100)}")`).join('\n')}`);
  const v: any[] = Array.isArray(j?.verdicts) ? j.verdicts : [];
  unsure.forEach((u, i) => {
    const x = v.find((y) => Number(y?.i) === i);
    if (!x) { u.c.forceAsk = true; u.c.why = j ? 'the audit model did not say' : 'the audit model did not answer'; return; }
    if (x.ok === true) { u.c.confidence = Math.max(u.c.confidence, 0.9); u.c.borderline = false; u.c.source = 'model'; think(d, worldId, { source: 'active', kind: 'plan', runId: u.it.line.id, text: `The audit model agrees: ${u.c.summary}.` }); }
    else { u.it.cands = u.it.cands.filter((c) => c !== u.c); think(d, worldId, { source: 'active', kind: 'skip', runId: u.it.line.id, text: `Letting it go: ${u.c.summary}. The audit model reads it as talk, a plan or a question, not something happening now.` }); }
  });
}

async function scan(d: Deps, worldId: string, items: Item[], ctx: CueCtx, W: Wstate, known: string[][]): Promise<Item[]> {
  const cand = items.map((x, i) => ({ x, i })).filter(({ x }) => x.line.role === 'gm' && x.line.text.split(/\s+/).length >= 5 && !/\?\s*$/.test(x.line.text.trim()));
  const out: Item[] = [];
  if (!cand.length) return out;
  if (Date.now() - W.lastScan < SCAN_EVERY_MS) await new Promise((r) => setTimeout(r, SCAN_EVERY_MS - (Date.now() - W.lastScan)));
  W.lastScan = Date.now();
  const batch = cand.slice(-6).map((c) => c.x);
  const batchKnown = cand.slice(-6).map((c) => c.i);
  think(d, worldId, { source: 'active', kind: 'look', text: `Reading your narration for scene changes (${batch.length} line${batch.length === 1 ? '' : 's'}).` });
  const snap = one<any>(d.db, 'SELECT music, ambience FROM sound_state WHERE world_id = ?', worldId);
  const cur = snap?.music ? parseJson<any>(snap.music, {}) : null;
  const layers = [...new Set(indexOf(d).ambience.map((a) => a.layer))].slice(0, 20);
  const sys = `You are the stage hand of a tabletop RPG Game Master. You read what the GM says and pick table actions ONLY when the GM clearly narrates or asks for them. Most lines need nothing: then return []. Never invent. Allowed actions (JSON objects):
{"line":N,"cat":"music","mood":"calm|tense|sneaky|combat"}  (ONLY when the party arrives somewhere new with a clearly different atmosphere, or the scene's mood clearly turns; never for a sound, a creature, a moment of suspense or a line inside a fight; not if the music already fits; current music mood: ${cur?.mood ?? cur?.name ?? 'none'})
{"line":N,"cat":"ambience","layers":[${layers.map((l) => `"${l}"`).join(',')}]}  (ONLY when the party arrives at a place with a distinct sound, or the weather or time of day clearly changes; not for travelling, a sound or a creature)
{"line":N,"cat":"sfx","name":"creak|thunder|roar|howl|crash|clash|bell|knock|splash|slam|explosion"}  (ONE distinct sound event the GM narrates as just happening: a door, a bell, thunder, a crash; not voices, shouting or the noise of a fight, and not the aftermath of a sound)
{"line":N,"cat":"item","name":"silver key","qty":1}  (the party finds or is given a portable item)
{"line":N,"cat":"coins","gp":0,"sp":0,"cp":0}  (the party finds or is given coins)
{"line":N,"cat":"clock","preset":"short-rest|long-rest|next-day"} or {"line":N,"cat":"clock","minutes":120}  (time passes or the party rests)
{"line":N,"cat":"event","skill":"Perception","dc":13}  (the GM asks the players for a roll)
Reply JSON only: {"actions":[...]}. Lines are numbered from 0.`;
  // Labelled lines nearest these ones (embeddings job): how close cases were decided, shown before the lines.
  const shots = examplesOn(d) ? await similarLineExamples(d, batch.map((x) => x.line.text), 6) : null;
  const shotText = shots?.length ? `Examples of similar lines and what a good stage hand picked (no line number; [] means nothing):\n${shots.map((e) => `- "${e.line}" -> ${JSON.stringify(e.actions)}`).join('\n')}\n\n` : '';
  const j = await modelJson(d, worldId, sys, `${shotText}Earlier context:\n${W.lastLines.slice(-4).join('\n')}\n\nGM lines (the rules already handled the categories in brackets: do not repeat those):\n${batch.map((x, i) => `${i}. ${x.line.text}${known[batchKnown[i]]?.length ? ` [${[...new Set(known[batchKnown[i]])].join(', ')}]` : ''}`).join('\n').slice(0, 3200)}`);
  W.lastLines = [...W.lastLines, ...batch.map((x) => x.line.text)].slice(-8);
  const acts: any[] = Array.isArray(j?.actions) ? j.actions : [];
  for (const a of acts.slice(0, 6)) {
    const it = batch[Number(a?.line)];
    if (!it) continue;
    // In a fight the rules and the GM's explicit words steer the sound; the scan does not guess.
    if (ctx.combat.active && ['music', 'ambience', 'sfx'].includes(String(a?.cat))) continue;
    const mk = (i: Intent, conf = 0.8): Scored => ({ ...i, confidence: conf }) as Scored;
    let intent: Scored | null = null;
    if (a.cat === 'music' && ['calm', 'tense', 'sneaky', 'combat'].includes(a.mood)) intent = mk({ kind: 'music', mood: a.mood, why: it.line.text.slice(0, 60) }, 0.85);
    else if (a.cat === 'ambience' && Array.isArray(a.layers) && a.layers.length) { const said = layersOf(it.line.text); const keep = a.layers.map(String).filter((l: string) => said.includes(l === 'hearth' ? 'fire' : l === 'chatter' ? 'tavern' : l)).slice(0, 3); if (keep.length) intent = mk({ kind: 'ambience', layers: keep, why: it.line.text.slice(0, 60) }, 0.85); }
    else if (a.cat === 'sfx' && typeof a.name === 'string') { if (!ctx.sfx.length || ctx.sfx.some((n) => norm(n).includes(norm(a.name)))) intent = mk({ kind: 'sfx', name: a.name.slice(0, 30), why: it.line.text.slice(0, 60) }, 0.85); }
    else if (a.cat === 'item' && typeof a.name === 'string' && a.name.trim()) intent = mk({ kind: 'item', owner: 'party', ownerName: 'the party', name: a.name.trim().slice(0, 80), qty: Math.max(1, Math.min(99, Number(a.qty) || 1)), why: it.line.text.slice(0, 60) }, 0.8);
    else if (a.cat === 'coins') { const cp = (Number(a.gp) || 0) * 100 + (Number(a.sp) || 0) * 10 + (Number(a.cp) || 0); if (cp > 0 && cp <= 1_000_000) intent = mk({ kind: 'coins', owner: 'party', ownerName: 'the party', cp, why: it.line.text.slice(0, 60) }, 0.8); }
    else if (a.cat === 'clock') { if (['short-rest', 'long-rest', 'next-day'].includes(a.preset)) intent = mk({ kind: 'clock', preset: a.preset, why: it.line.text.slice(0, 60) }, 0.8); else if (Number(a.minutes) > 0 && Number(a.minutes) <= 10080) intent = mk({ kind: 'clock', minutes: Math.round(Number(a.minutes)), why: it.line.text.slice(0, 60) }, 0.8); }
    else if (a.cat === 'event' && typeof a.skill === 'string') intent = mk({ kind: 'event', skill: a.skill.slice(0, 20), dc: Number(a.dc) || undefined, save: /save/i.test(it.line.text), why: it.line.text.slice(0, 60) }, 0.8);
    const c = intent && build(d, worldId, ctx, intent, it.line.text);
    if (c && !(known[batchKnown[Number(a?.line)]] ?? []).includes(c.category)) { c.source = 'model'; c.borderline = false; think(d, worldId, { source: 'active', kind: 'plan', runId: it.line.id, text: `From “${it.line.text.slice(0, 100)}”: ${c.summary}.` }); let o = out.find((y) => y.line === it.line); if (!o) { o = { line: it.line, cands: [] }; out.push(o); } o.cands.push(c); }
  }
  return out;
}

// ---- deciding and acting --------------------------------------------------------------------
const recentAuto = (d: Deps, worldId: string) => one<{ n: number }>(d.db, "SELECT COUNT(*) AS n FROM active_log WHERE world_id = ? AND status = 'done' AND mode = 'active' AND trigger = 'line' AND at > ?", worldId, new Date(Date.now() - 60_000).toISOString())?.n ?? 0;

export async function act(d: Deps, worldId: string, sessionId: string | null, state: ReturnType<typeof getState>, c: Candidate, line: { id: string; speaker: string; aside: boolean; at?: string }, trigger: 'line' | 'wake', opts: { explicit?: boolean } = {}): Promise<LogRow | null> {
  const stat = statsOf(d);
  const W = ws(d, worldId);
  stat.cands++;
  const base = { sessionId, trigger, lineId: line.id, speaker: line.speaker, cue: c.cue, category: c.category, tool: c.calls[0]?.tool ?? '', args: c.calls[0]?.args, calls: c.calls, summary: c.summary, source: c.source, confidence: c.confidence, visible: c.visible, ruleKey: c.ruleKey } as const;
  const src = trigger === 'wake' ? 'wake' : 'active';
  const note = (kind: Thought['kind'], text: string, logId?: string, undoable?: boolean) => { think(d, worldId, { source: src, kind, text, runId: line.id, logId, undoable }); };
  const block = (why: string) => { stat.blocked++; note('skip', `Not doing “${c.summary}”: ${why}`); return addLog(d, worldId, { ...base, status: 'blocked', result: why }); };
  if (hasRule(d, worldId, c.ruleKey)) { stat.blocked++; note('skip', `Not doing “${c.summary}”: you told me "Not this" for that cue before (Active page, rules).`); return null; }
  // A GM aside is for the GM: only the GM's side (music, the tracker) may follow, and only on the GM's own say-so.
  if (line.aside && !opts.explicit && !ASIDE_OK.has(c.category)) return block('Said in a GM-only aside: nothing the players see follows from it.');
  if (c.playerSource && c.category === 'items' && c.calls.some((x) => !['inventory_patch'].includes(x.tool))) return block('A player cannot add things.');
  const setting = state.cats[c.category];
  if (setting === 'off' && !opts.explicit) { stat.blocked++; note('skip', `Not doing “${c.summary}”: ${catName(c.category)} is set to Off.`); return null; }
  // De-dup: the same thing within its window (the speech model repeats itself), and one pending card per cue.
  const key = c.dedupeKey;
  const last = W.recent.get(key);
  if (last && Date.now() - last < c.dedupeMs) { stat.blocked++; note('skip', `Not doing “${c.summary}” again: I already did or asked about it ${Math.round((Date.now() - last) / 1000)} s ago.`); return null; }
  W.recent.set(key, Date.now());
  const latency = line.at ? Math.max(0, Date.now() - Date.parse(line.at)) : null;
  const askWhy = opts.explicit ? null
    : setting !== 'auto' ? `${catName(c.category)} is set to Ask`
    : c.forceAsk ? (c.why ?? 'I want you to check this one')
    : c.playerSource ? 'a player said it, not you'
    : c.confidence < 0.8 || c.borderline ? `I am not sure (${Math.round(c.confidence * 100)}%)`
    : recentAuto(d, worldId) >= AUTO_PER_MINUTE ? `I already did ${AUTO_PER_MINUTE} things by myself in the last minute`
    : null;
  if (askWhy) {
    stat.ask++;
    const row = addLog(d, worldId, { ...base, status: 'pending', expiresAt: new Date(Date.now() + state.askTtlMin * 60_000).toISOString(), latencyMs: latency });
    note('ask', `Asking you: ${c.summary} (${askWhy}).`, row.id);
    return row;
  }
  stat.auto++;
  const row = await runAndLog(d, worldId, base, c.calls, latency);
  note(row.status === 'done' ? 'do' : row.status === 'failed' ? 'error' : 'skip', row.status === 'done' ? `Did it: ${c.summary}${row.reversible ? ' (you can undo it)' : ''}.` : row.status === 'failed' ? `Tried “${c.summary}” but it did not work: ${row.result.slice(0, 160)}` : `Nothing to do for “${c.summary}”: ${row.result}`, row.id, row.reversible);
  return row;
}

const CAT_NAMES: Record<string, string> = { music: 'Music and ambience', sfx: 'Sound effects', stage: 'Stage', events: 'Quick events', combat: 'Combat tracker', combatAdd: 'Monsters in and out', items: 'Items and coins', clock: 'World clock', notes: 'Notes' };
const catName = (c: string) => CAT_NAMES[c] ?? c;

async function runAndLog(d: Deps, worldId: string, base: any, calls: Call[], latency: number | null): Promise<LogRow> {
  const out = await execCalls(d, worldId, calls);
  // The sound board says it was already playing: nothing changed, so nothing is logged.
  if (out.ok && calls.length === 1 && /^(play_music|play_ambience)$/.test(calls[0].tool) && out.unchanged) return addLog(d, worldId, { ...base, status: 'blocked', result: 'Already playing: nothing to change.' });
  return addLog(d, worldId, { ...base, status: out.ok ? 'done' : 'failed', result: out.ok ? out.results.join(' | ') : out.error ?? '', undo: out.undo ? { calls: out.undo } : null, latencyMs: latency });
}

// ---- cards, undo, reject --------------------------------------------------------------------
export async function approveCard(d: Deps, worldId: string, logId: string): Promise<LogRow> {
  expireCards(d, worldId);
  const row = getLog(d, worldId, logId);
  if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
  if (row.status !== 'pending') throw Object.assign(new Error(`That card is already ${row.status}`), { status: 409 });
  setLog(d, worldId, logId, { status: 'dismissed' }); // claim it first: a second tap never runs it twice
  const out = await execCalls(d, worldId, row.calls);
  setLog(d, worldId, logId, { status: out.ok ? 'done' : 'failed', result: out.ok ? out.results.join(' | ') : out.error ?? '', undo: out.undo ? { calls: out.undo } : null, decided: true });
  think(d, worldId, { source: row.trigger === 'wake' ? 'wake' : 'active', kind: out.ok ? 'do' : 'error', logId, text: out.ok ? `You said do it: ${row.summary}.` : `You said do it, but it did not work: ${row.summary}. ${(out.error ?? '').slice(0, 160)}` });
  return getLog(d, worldId, logId)!;
}
export function dismissCard(d: Deps, worldId: string, logId: string, rejected = false): LogRow {
  const row = getLog(d, worldId, logId);
  if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
  if (row.status !== 'pending') throw Object.assign(new Error(`That card is already ${row.status}`), { status: 409 });
  setLog(d, worldId, logId, { status: rejected ? 'rejected' : 'dismissed', decided: true, wrong: rejected });
  if (rejected) addRule(d, worldId, row.ruleKey);
  return getLog(d, worldId, logId)!;
}
export async function undoEntry(d: Deps, worldId: string, logId: string): Promise<LogRow> {
  const row = getLog(d, worldId, logId);
  if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
  const u = undoOf(d, logId);
  if (row.status !== 'done' || !u) throw Object.assign(new Error(row.status === 'done' ? 'That action cannot be undone' : `That action is ${row.status}`), { status: 409 });
  setLog(d, worldId, logId, { status: 'undone', decided: true });
  for (const c of u.calls) { const r = await callOne(d, worldId, c); if (!r.ok) { setLog(d, worldId, logId, { result: `Undo partly failed: ${r.text}`.slice(0, 300) }); break; } }
  return getLog(d, worldId, logId)!;
}
/** The GM says an automatic action was wrong: undo it where possible and never do that for that cue again. */
export async function markWrong(d: Deps, worldId: string, logId: string): Promise<LogRow> {
  const row = getLog(d, worldId, logId);
  if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
  if (row.status === 'pending') return dismissCard(d, worldId, logId, true);
  if (row.reversible) await undoEntry(d, worldId, logId);
  setLog(d, worldId, logId, { wrong: true });
  addRule(d, worldId, row.ruleKey);
  return getLog(d, worldId, logId)!;
}

/** A spoken command to the assistant is for the GM only: take the line out of the players' transcript. */
function hideWake(d: Deps, worldId: string, r: LineRow) {
  try { if (r.audience === 'players') engine(d).setAudience(r as any, 'gm', worldId); } catch (e) { console.error('active: could not hide a wake line', e); }
}

// ---- the wake word ------------------------------------------------------------------------------
async function handleWake(d: Deps, worldId: string, line: ReturnType<typeof lineOf>, cmd: string, sessionId: string, mode: 'assistant' | 'active'): Promise<void> {
  const state = getState(d, worldId);
  think(d, worldId, { source: 'wake', kind: 'plan', runId: line.id, text: `You asked me: “${cmd.slice(0, 160)}”` });
  const log = (summary: string, extra: Partial<Parameters<typeof addLog>[2]> = {}) => addLog(d, worldId, { sessionId, mode, trigger: 'wake', lineId: line.id, speaker: line.speaker, cue: line.text, category: 'command', tool: 'command', summary, status: 'done', visible: 'gm', ...extra });
  // A short command first.
  const c = parseCommand(cmd);
  if (c) { log(runCommand(d, worldId, c)); return; }
  // A macro by name.
  const macro = await runMacroByName(d, worldId, cmd);
  if (macro) { log(macro.text, { tool: 'macro', status: macro.ok ? 'done' : 'failed', visible: 'players' }); return; }
  // Rules, explicit: the GM asked, so it runs now.
  const ctx = loadCtx(d, worldId, Date.now() < ws(d, worldId).initiativeUntil);
  const cues = allCues({ ...line, role: 'gm' }, ctx, { explicit: true });
  const asked = allCues({ id: line.id, text: cmd, speaker: line.speaker, role: 'gm', accountId: line.accountId, aside: false }, ctx, { explicit: true });
  void cues;
  const cands = asked.map((x) => build(d, worldId, ctx, x, cmd)).filter((x): x is Candidate => !!x);
  if (cands.length) { for (const k of cands) await act(d, worldId, sessionId, state, k, { id: line.id, speaker: line.speaker, aside: false, at: line.at }, 'wake', { explicit: true }); return; }
  // Anything else goes to the assistant, which proposes what it would do.
  if (!hasJob(d, 'chat')) { think(d, worldId, { source: 'wake', kind: 'error', runId: line.id, text: 'No chat model is set, so I could not work out that request.' }); log('No chat model is set, so I could not work out that request.', { status: 'failed' }); return; }
  think(d, worldId, { source: 'wake', kind: 'plan', runId: line.id, text: 'No quick rule or macro fits, so I am handing it to the assistant. Anything it wants to change waits for you.' });
  const a = gmAuth(d, worldId);
  if (!a) return;
  const { runTask } = await import('./task.ts');
  const r = await withPriority(2, () => runTask(d, { worldId, accountId: a.accountId, token: a.token, port: portOf(d) }, { prompt: cmd, mode: 'propose', title: `Spoken: ${cmd.slice(0, 40)}` }));
  // The reply reaches the GM's own screen (and is read aloud there if they chose that), never the table: it may hold GM-only text.
  if (r.chatId && r.reply.trim()) d.hub.emit(worldId, 'agent', { kind: 'spoken', chatId: r.chatId, messageId: r.messageId, text: r.reply.slice(0, 4000), request: cmd.slice(0, 120), pending: r.pending }, only(a.accountId));
  log(`Asked the assistant: ${cmd.slice(0, 120)}${r.pending ? ` (${r.pending} proposal${r.pending === 1 ? '' : 's'} waiting in your chat)` : ''}`, { tool: 'agent', result: r.reply.slice(0, 600) });
}

async function runMacroByName(d: Deps, worldId: string, cmd: string): Promise<{ ok: boolean; text: string } | null> {
  const m = /^(?:please\s+)?(?:run|start|trigger|fire|do|play)\s+(?:the\s+)?(?:macro\s+)?(.+)$/i.exec(cmd.trim().replace(/[.!?]+$/, ''));
  if (!m) return null;
  const macros = all<any>(d.db, 'SELECT * FROM actions_macros WHERE world_id = ?', worldId);
  const rest = norm(m[1]);
  const hit = macros.filter((x) => rest.startsWith(norm(x.name))).sort((a, b) => b.name.length - a.name.length)[0];
  if (!hit) return null;
  const tail = rest.slice(norm(hit.name).length).replace(/^\s*(?:at|in|on|with|for|to|against|from|of|the)\s+/i, '').trim();
  const params = parseJson<any[]>(hit.params, []);
  const overrides: Record<string, string> = {};
  const first = params.find((p) => p.type === 'string');
  if (tail && first) overrides[first.name] = m[1].slice(m[1].toLowerCase().indexOf(tail)).trim() || tail;
  const a = gmAuth(d, worldId);
  if (!a) return null;
  const { makeRunner } = await import('../actions/index.ts');
  const { runMacro } = await import('../actions/macros.ts');
  try {
    const rep = await runMacro(makeRunner(d, { worldId, accountId: a.accountId, role: 'gm', token: a.token, port: portOf(d) }), hit, overrides, 'voice');
    return { ok: rep.ok, text: `Ran macro ${hit.name}${tail ? ` (${tail})` : ''}: ${rep.ok ? 'done' : rep.steps.find((s) => s.status === 'failed')?.error ?? 'a step failed'}` };
  } catch (e: any) { return { ok: false, text: `Macro ${hit.name} failed: ${String(e?.message ?? e).slice(0, 160)}` }; }
}

export { listLog, gmOnly };
