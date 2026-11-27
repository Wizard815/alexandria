// The command log also records what the GM's assistant does in Assistant mode:
// each proposal, and what became of it (approved and run, rejected, run on
// auto-approve). One row per action, in the same table as Active mode's.
import type { Deps } from '../../app.ts';
import { one } from '../../core/db.ts';
import { addLog, effectiveMode, setLog, type Status } from './store.ts';
import { listSessions } from '../audio/api.ts';

const PLAYERS = /^(show_on_stage|send_quick_event|send_scene|send_table_chat|add_item|add_coin|move_item|add_combatant|damage_combatant|heal_combatant|set_conditions|remove_combatant|set_initiative|set_combat|next_turn|advance_world_time|add_world_event|send_broker_offer|speak|publish_session_log|add_map_mark|run_macro)/;
const TABLE = /^(play_music|stop_music|play_ambience|play_sfx)/;
export const visibleOf = (tool: string): 'dm' | 'table' | 'players' => (PLAYERS.test(tool) ? 'players' : TABLE.test(tool) ? 'table' : 'dm');

const sessionId = (d: Deps, worldId: string): string | null => { const s = listSessions(d.db, worldId)[0]; return s?.active ? s.id : null; };
const find = (d: Deps, worldId: string, actionId: string) => one<{ id: string }>(d.db, "SELECT id FROM active_log WHERE world_id = ? AND rule_key = ? AND trigger = 'chat'", worldId, `agent:${actionId}`);

export function logAgentProposal(d: Deps, worldId: string, p: { actionId: string; tool: string; args: unknown; summary: string }) {
  try {
    const sid = sessionId(d, worldId);
    addLog(d, worldId, { sessionId: sid, mode: effectiveMode(d, worldId, sid), trigger: 'chat', category: 'assistant', tool: p.tool, args: p.args, calls: [{ tool: p.tool, args: p.args }], summary: p.summary, status: 'pending', visible: visibleOf(p.tool), ruleKey: `agent:${p.actionId}`, source: 'chat' });
  } catch (e) { console.error('active: log failed', e); }
}
export function logAgentCall(d: Deps, worldId: string, p: { tool: string; args: unknown; summary: string; ok: boolean; result: string; via: string; actionId?: string; rejected?: boolean }) {
  try {
    const status: Status = p.rejected ? 'rejected' : p.ok ? 'done' : 'failed';
    const row = p.actionId ? find(d, worldId, p.actionId) : null;
    if (row) { setLog(d, worldId, row.id, { status, result: `${p.via}: ${p.result}`, decided: true }); return; }
    const sid = sessionId(d, worldId);
    addLog(d, worldId, { sessionId: sid, mode: effectiveMode(d, worldId, sid), trigger: 'chat', category: 'assistant', tool: p.tool, args: p.args, calls: [{ tool: p.tool, args: p.args }], summary: p.summary, status, result: `${p.via}: ${p.result}`, visible: visibleOf(p.tool), source: 'chat' });
  } catch (e) { console.error('active: log failed', e); }
}
export function logAgentCommand(d: Deps, worldId: string, text: string, reply: string) {
  try {
    const sid = sessionId(d, worldId);
    addLog(d, worldId, { sessionId: sid, mode: effectiveMode(d, worldId, sid), trigger: 'chat', category: 'command', tool: 'command', summary: reply.slice(0, 200), cue: text, status: 'done', visible: 'dm', source: 'chat' });
  } catch (e) { console.error('active: log failed', e); }
}
