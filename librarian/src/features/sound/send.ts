// Sending a sound event to the table and to players' devices.
import type { Deps } from '../../app.ts';
import { one } from '../../core/db.ts';
import { now } from '../../core/util.ts';

export type Target = 'table' | 'players' | 'both';
export const TARGETS: readonly Target[] = ['table', 'players', 'both'];
export const toPlayers = (t: Target) => t !== 'table';
export const toTable = (t: Target) => t !== 'players';

export interface SoundEvent {
  channel: 'music' | 'ambience' | 'sfx' | 'voice';
  action: 'play' | 'stop' | 'set';
  url: string | null;
  volume: number;
  loop: boolean;
  fadeMs: number;
  target: Target;
  at: string;
  [extra: string]: unknown;
}

const SWITCH: Record<SoundEvent['channel'], string> = { music: 'music', ambience: 'ambience', sfx: 'sfx', voice: 'sfx' };

/** Does any of this account's devices have this channel switched on? */
export function wants(d: Deps, worldId: string, accountId: string, channel: SoundEvent['channel']): boolean {
  return !!one(d.db, `SELECT 1 FROM sound_listeners WHERE world_id = ? AND account_id = ? AND ${SWITCH[channel]} = 1 LIMIT 1`, worldId, accountId);
}

/**
 * The DM's screen gets every event (it decides by `target` whether to play
 * it at the table). A player gets it only when the target includes players
 * and one of their devices has that channel's switch on.
 */
export function sendSound(d: Deps, worldId: string, ev: Omit<SoundEvent, 'at'> & { at?: string }): SoundEvent {
  const full = { ...ev, at: ev.at ?? now() } as SoundEvent;
  d.hub.emitPer(worldId, 'sound', (v) => {
    if (v.role === 'dm') return full;
    if (!toPlayers(full.target)) return null;
    return wants(d, worldId, v.accountId, full.channel) ? full : null;
  });
  return full;
}
