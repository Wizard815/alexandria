// Auto mode: the DM's switch that lets the assistant apply its changes without asking first. It is one world setting
// (agentAuto), read fresh at every tool call so flipping it applies to the very next action, even in a reply that is
// already being written. Some tools never run on their own, whatever the switch says: they always become a card.
import type { Deps } from '../../app.ts';
import { featureSetting } from '../../core/policy.ts';
import { parseJson } from '../../core/util.ts';
import { one } from '../../core/db.ts';

/** Tool names (a trailing * is a prefix) that always wait for the DM's approval, in Auto mode and for tasks too. */
export const ALWAYS_ASK = ['delete_*', 'lore_delete', 'end_game_session', 'stop_recording', 'start_recording', 'decide_*', 'publish_*', 'broker_*', 'save_page', 'edit_session_log_draft', 'update_person', 'promote*', 'arc_close', 'source_lookup', 'set_shop_status'];
const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
/** Never run by a task or by Auto mode on its own, whatever the allowlist says. */
export const AUTO_NEVER = new RegExp(`^(?:${ALWAYS_ASK.map((n) => esc(n.replace(/\*$/, ''))).join('|')})`);
export const alwaysAsk = (tool: string): boolean => AUTO_NEVER.test(tool);

const settingsOf = (d: Deps, worldId: string): any => parseJson(one<any>(d.db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings ?? '{}', {});

/** Does this write tool run without a card for the DM right now? (The per-tool list, or Auto mode minus the always-ask tools.) */
export function runsWithoutAsking(d: Deps, worldId: string, tool: string): boolean {
  const s = settingsOf(d, worldId);
  if ((featureSetting<string[]>(s, 'agentAutoApprove') ?? []).includes(tool)) return true;
  return featureSetting<boolean>(s, 'agentAuto') === true && !alwaysAsk(tool);
}
