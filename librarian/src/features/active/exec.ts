// Running Active-mode actions as the GM, with an undo for each one that can be
// undone. Actions are ordinary MCP tools (the same ones the GM's agent has),
// called over loopback with a short-lived GM session, plus a few pseudo-tools
// for inventory and the clock. Only the tools in ALLOWED can run from here.
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { now, parseJson, secret, sha256 } from '../../core/util.ts';
import { harnessTools, runTool } from '../agent/harness.ts';
import type { Call } from './intents.ts';

/** Tools Active mode, a wake command or an undo may run. Nothing that deletes, publishes, ends a session or writes pages. */
export const ALLOWED = new Set([
  'play_music', 'stop_music', 'play_ambience', 'play_sfx', 'show_on_stage', 'hide_stage_card', 'send_quick_event', 'cancel_quick_event',
  'set_combat', 'next_turn', 'damage_combatant', 'heal_combatant', 'set_conditions', 'add_combatant', 'remove_combatant', 'set_initiative',
  'give_temp_hp', 'set_concentration', 'concentration_save', 'death_save', 'set_combatant_state',
  'add_item', 'add_coin', 'advance_world_time', 'inventory_patch', 'inventory_delete', 'clock_undo',
]);

const ports = new WeakMap<Deps, number>();
export const setPort = (d: Deps, p: number | undefined) => { if (p) ports.set(d, p); };
export const portOf = (d: Deps): number => ports.get(d) ?? (Number(d.env.LIBRARIAN_PORT) || 8090);

const sessions = new Map<string, { token: string; accountId: string; exp: number }>();
export function gmAuth(d: Deps, worldId: string): { token: string; accountId: string } | null {
  const key = `${worldId}`;
  const c = sessions.get(key);
  if (c && c.exp - Date.now() > 60_000) return c;
  const m = one<{ account_id: string }>(d.db, "SELECT account_id FROM members WHERE world_id = ? AND role = 'gm' ORDER BY rowid LIMIT 1", worldId);
  if (!m) return null;
  const token = secret('alx_ses_');
  const exp = Date.now() + 15 * 60_000;
  run(d.db, 'INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(token), m.account_id, now(), new Date(exp).toISOString());
  run(d.db, "DELETE FROM sessions WHERE expires_at < ? AND token_hash IN (SELECT token_hash FROM sessions WHERE account_id = ?)", now(), m.account_id);
  const v = { token, accountId: m.account_id, exp };
  sessions.set(key, v);
  return v;
}

const enc = encodeURIComponent;
async function http(d: Deps, worldId: string, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; text: string }> {
  const a = gmAuth(d, worldId);
  if (!a) return { ok: false, status: 403, text: 'No GM in this world' };
  try {
    const r = await d.fetch(`http://127.0.0.1:${portOf(d)}/api/worlds/${enc(worldId)}${path}`, { method, headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json', 'X-Alexandria-Caller': 'model' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (e: any) { return { ok: false, status: 502, text: String(e?.message ?? e).slice(0, 200) }; }
}

export interface CallResult { ok: boolean; text: string; json: any }
export async function callOne(d: Deps, worldId: string, c: Call): Promise<CallResult> {
  if (!ALLOWED.has(c.tool)) return { ok: false, text: `${c.tool} may not run from here`, json: null };
  let r: { ok: boolean; status: number; text: string };
  if (c.tool === 'inventory_patch') r = await http(d, worldId, 'PATCH', `/inventory/${enc(String(c.args.id))}`, { qty: c.args.qty, reason: 'At the table' });
  else if (c.tool === 'inventory_delete') r = await http(d, worldId, 'DELETE', `/inventory/${enc(String(c.args.id))}?reason=${enc('Undone at the table')}`);
  else if (c.tool === 'clock_undo') r = await http(d, worldId, 'POST', `/clock/log/${enc(String(c.args.id))}/undo`, {});
  else {
    const a = gmAuth(d, worldId);
    const tool = (await harnessTools('gm')).find((t) => t.name === c.tool);
    if (!a || !tool) return { ok: false, text: 'That tool is not available', json: null };
    r = await runTool(d, { worldId, token: a.token, port: portOf(d) }, tool, c.args);
  }
  return { ok: r.ok, text: r.text.slice(0, 1500), json: parseJson<any>(r.text, null) };
}

interface Snap { combat: { active: boolean; round: number; turn: number; list: any[] }; sound: { music: any; ambience: any } }
export function snapshot(d: Deps, worldId: string): Snap {
  const st = one<any>(d.db, 'SELECT * FROM combat WHERE world_id = ?', worldId) ?? { active: 0, round: 1, turn: 0 };
  const list = all<any>(d.db, 'SELECT * FROM combatants WHERE world_id = ? ORDER BY initiative DESC, name', worldId).map((x) => ({ ...x, effects: parseJson(x.effects, []) }));
  const s = one<any>(d.db, 'SELECT music, ambience FROM sound_state WHERE world_id = ?', worldId);
  return { combat: { active: !!st.active, round: st.round, turn: st.turn, list }, sound: { music: s?.music ? parseJson(s.music, null) : null, ambience: s?.ambience ? parseJson(s.ambience, null) : null } };
}

/** Everything the combat rules can change on one combatant, as it was in the snapshot. */
const restore = (b: any): Call => ({ tool: 'set_combatant_state', args: { combatant: b.id, ...(b.hp !== null && b.hp !== undefined ? { hp: b.hp } : {}), tempHp: b.temp_hp ?? 0, concentration: parseJson(b.concentration, null), deathSaves: parseJson(b.death_saves, null), conditions: b.effects } });

/** The calls that put things back, from before and after one call. Null: it cannot be undone. */
export function undoFor(c: Call, before: Snap, r: CallResult): Call[] | null {
  const j = r.json ?? {};
  switch (c.tool) {
    case 'play_music': case 'stop_music': {
      const m = before.sound.music;
      const trackId = m?.trackId ?? m?.id ?? m?.track?.id;
      return trackId ? [{ tool: 'play_music', args: { trackId, fadeMs: 800 } }] : [{ tool: 'stop_music', args: { fadeMs: 800 } }];
    }
    case 'play_ambience': {
      const a = before.sound.ambience;
      const layers = a?.layers ?? a?.scene?.layers;
      return Array.isArray(layers) && layers.length ? [{ tool: 'play_ambience', args: { layers: layers.map((l: any) => ({ kind: l.kind ?? l.layer ?? l.id, volume: l.volume ?? 0.5 })) } }] : [{ tool: 'play_ambience', args: {} }];
    }
    case 'show_on_stage': { const id = j.id ?? j.card?.id; return id ? [{ tool: 'hide_stage_card', args: { cardId: id } }] : null; }
    case 'send_quick_event': { const id = j.id ?? j.event?.id; return id ? [{ tool: 'cancel_quick_event', args: { id } }] : null; }
    case 'set_combat': return [{ tool: 'set_combat', args: { active: before.combat.active, round: before.combat.round, turn: before.combat.turn } }];
    case 'next_turn': {
      // Conditions that counted down or ended come back as they were.
      const now: any[] = Array.isArray(j.combatants) ? j.combatants : [];
      const fx = before.combat.list.filter((b) => { const a = now.find((x) => x.id === b.id); return a && JSON.stringify(a.effects) !== JSON.stringify(b.effects); }).map((b): Call => ({ tool: 'set_conditions', args: { combatant: b.id, conditions: b.effects } }));
      return [{ tool: 'set_combat', args: { round: before.combat.round, turn: before.combat.turn } }, ...fx];
    }
    case 'give_temp_hp': case 'set_concentration': case 'concentration_save': case 'death_save': case 'set_combatant_state': {
      const b = before.combat.list.find((x) => x.id === c.args.combatant);
      return b ? [restore(b)] : null;
    }
    case 'damage_combatant': case 'heal_combatant': {
      const b = before.combat.list.find((x) => x.id === c.args.combatant);
      if (!b) return null;
      // Temp HP, concentration or death saves moved too: a plain heal/damage back would not put them right.
      const same = (a: unknown, z: unknown) => JSON.stringify(a ?? null) === JSON.stringify(z ?? null);
      if ((typeof j.tempHp === 'number' && j.tempHp !== (b.temp_hp ?? 0)) || ('concentration' in j && !same(j.concentration, parseJson(b.concentration, null))) || ('deathSaves' in j && !same(j.deathSaves, parseJson(b.death_saves, null)))) return [restore(b)];
      if (b.hp === null || b.hp === undefined) return null;
      const after = typeof j.hp === 'number' ? j.hp : j.combatant?.hp;
      const delta = typeof after === 'number' ? b.hp - after : null;
      if (delta === null) return null;
      return delta > 0 ? [{ tool: 'heal_combatant', args: { combatant: b.id, amount: delta } }] : delta < 0 ? [{ tool: 'damage_combatant', args: { combatant: b.id, amount: -delta } }] : [];
    }
    case 'set_conditions': { const b = before.combat.list.find((x) => x.id === c.args.combatant); return b ? [{ tool: 'set_conditions', args: { combatant: b.id, conditions: b.effects } }] : null; }
    case 'add_combatant': { const id = j.id ?? j.combatant?.id; return id ? [{ tool: 'remove_combatant', args: { combatant: id } }] : null; }
    case 'remove_combatant': {
      const b = before.combat.list.find((x) => x.id === c.args.combatant);
      return b ? [{ tool: 'add_combatant', args: { name: b.name, initiative: b.initiative, hp: b.hp ?? undefined, maxHp: b.max_hp ?? undefined, ac: b.ac ?? undefined, hidden: !!b.hidden, tempHp: b.temp_hp || undefined, concentration: parseJson<any>(b.concentration, null) ?? undefined, deathSaves: parseJson<any>(b.death_saves, null) ?? undefined,
        // A turn timer points at a combatant id, and this one gets a new id: keep the round counts only.
        effects: b.effects.map((e: any) => ({ name: e.name, ...(e.rounds ? { rounds: e.rounds } : {}) })), ...(b.account_id ? { accountId: b.account_id } : {}) } }] : null;
    }
    case 'set_initiative': { const b = before.combat.list.find((x) => x.id === c.args.combatant); return b ? [{ tool: 'set_initiative', args: { combatant: b.id, value: b.initiative } }] : null; }
    case 'add_item': { const id = j.id ?? j.item?.id; return id ? [{ tool: 'inventory_delete', args: { id } }] : null; }
    case 'add_coin': return typeof c.args.amountCp === 'number' ? [{ tool: 'add_coin', args: { owner: c.args.owner, amountCp: -c.args.amountCp, note: 'Undone' } }] : null;
    case 'inventory_patch': return c.args.prevQty !== undefined ? [{ tool: 'inventory_patch', args: { id: c.args.id, qty: c.args.prevQty } }] : null;
    case 'advance_world_time': { const id = j.entry?.id ?? j.id ?? j.logId; return id ? [{ tool: 'clock_undo', args: { id } }] : null; }
    default: return null;
  }
}

export interface ExecOut { ok: boolean; results: string[]; undo: Call[] | null; error?: string; unchanged?: boolean }
/** Run calls in order; the undo is the reverse of each call that can be undone (null if any one cannot). */
export async function execCalls(d: Deps, worldId: string, calls: Call[]): Promise<ExecOut> {
  const results: string[] = [];
  const undo: Call[] = [];
  let reversible = true;
  let unchanged = false;
  for (const c of calls) {
    const before = snapshot(d, worldId);
    const args = c.tool === 'inventory_patch' ? { ...c.args } : c.args;
    const r = await callOne(d, worldId, { tool: c.tool, args });
    results.push(r.text.slice(0, 200));
    if (r.json?.changed === false) unchanged = true;
    if (!r.ok) return { ok: false, results, undo: undo.length && reversible ? undo.reverse() : null, error: r.text.slice(0, 200) };
    const u = undoFor(c, before, r);
    if (u === null) reversible = false; else undo.push(...u);
  }
  return { ok: true, results, undo: reversible && undo.length ? undo.reverse() : null, unchanged };
}
