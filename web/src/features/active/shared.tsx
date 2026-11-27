// Active mode on the GM's screens: shared types and the loaders.
import { useLoad, useWorld } from '../../lib/world.tsx';

export type Setting = 'auto' | 'ask' | 'off' | 'draft';
export interface LogRow {
  id: string; at: string; mode: 'assistant' | 'active'; trigger: string; lineId: string | null; speaker: string; cue: string; category: string; tool: string; args: unknown; summary: string;
  source: string; confidence: number; status: string; result: string; reversible: boolean; visible: 'gm' | 'table' | 'players'; wrong: boolean; expiresAt: string | null; latencyMs: number | null; ruleKey: string;
}
export interface ActiveState {
  mode: 'assistant' | 'active'; effective: 'assistant' | 'active'; recording: boolean; sessionId: string | null; sessionOverride: 'assistant' | 'active' | null;
  wakeWord: string; cats: Record<string, Setting>; presets: Record<string, { name: string; cats: Record<string, Setting> }>; takeoverOn: boolean;
  listen: { gm: boolean; players: boolean; room: boolean }; askTtlMin: number; scan: boolean; categories: string[]; model: { audit: boolean; chat: boolean }; cards: LogRow[];
}

export const CATEGORY_INFO: Record<string, { label: string; help: string }> = {
  music: { label: 'Music and ambience', help: 'Mood music, weather and place sounds. Played on the GM device.' },
  sfx: { label: 'Sound effects', help: 'A door creaks, thunder rolls, the ogre roars.' },
  stage: { label: 'Stage: what players see', help: 'A map or handout on the table screen. Only pages players may already open.' },
  events: { label: 'Quick events', help: 'A Perception check or a save sent to the players.' },
  combat: { label: 'Combat tracker', help: 'Start and end, turns, damage, healing, conditions, initiative.' },
  combatAdd: { label: 'Monsters in and out', help: 'Adding creatures to the fight and taking defeated ones out.' },
  items: { label: 'Items and coins', help: 'Loot and gold given to the party or a player; a player using an item.' },
  clock: { label: 'World clock and rests', help: 'Time passing, short and long rests.' },
  notes: { label: 'Notes, clues, NPCs', help: 'Always drafted to Review; never applied by themselves.' },
};

export function useActive() {
  const { w, info } = useWorld();
  // Active mode is the GM's: a player's page never asks (the server would answer 403 on every page load).
  const gm = info?.role === 'gm';
  return useLoad<ActiveState | null>(() => (gm ? w.call<ActiveState>('GET', '/active') : Promise.resolve(null)), [w, gm], ['active', 'recording']);
}
export function useActiveLog(limit = 100) {
  const { w } = useWorld();
  return useLoad<{ log: LogRow[] }>(() => w.call('GET', `/active/log?limit=${limit}`), [w, limit], ['active']);
}

export const when = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const triggerText = (r: LogRow) => (r.trigger === 'line' ? `${r.speaker || 'table'}: "${r.cue}"` : r.trigger === 'wake' ? `Spoken: "${r.cue}"` : r.trigger === 'chat' ? (r.category === 'command' ? `Command: ${r.cue}` : 'Chat or macro') : r.trigger);
export const seesText = (v: string) => (v === 'players' ? 'Players see it' : v === 'table' ? 'Heard at the table' : 'GM only');
