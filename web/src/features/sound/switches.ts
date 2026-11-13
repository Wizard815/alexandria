// A player's three sound switches for this device (music, ambience, sound
// effects) and their volumes. They live on the gateway so the DM can see who
// hears what; a copy is kept here so every part of the page agrees.
import { useSyncExternalStore } from 'react';
import type { WorldClient } from '@alx/client';
import { deviceId } from './engine.ts';

export interface Switches {
  music: boolean; ambience: boolean; sfx: boolean;
  volumes: { music: number; ambience: number; sfx: number };
  loaded: boolean;
}

let state: Switches = { music: false, ambience: false, sfx: false, volumes: { music: 0.8, ambience: 0.6, sfx: 0.8 }, loaded: false };
const subs = new Set<() => void>();
const set = (s: Switches) => { state = s; for (const f of subs) f(); window.dispatchEvent(new Event('alx-switches')); };

export const getSwitches = () => state;
export function useSwitches(): Switches {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => state);
}

const from = (r: any): Switches => ({ music: !!r.music, ambience: !!r.ambience, sfx: !!r.sfx, volumes: { ...state.volumes, ...(r.volumes ?? {}) }, loaded: true });

export async function loadSwitches(w: WorldClient) {
  try {
    const r = await w.call('GET', '/sound/me/switches', undefined, { device: deviceId() });
    set(from(r));
    // Tell the DM this device is still here.
    if (r.music || r.ambience || r.sfx) void w.call('PUT', '/sound/me/switches', { device: deviceId() }).catch(() => {});
  } catch { set({ ...state, loaded: true }); }
}

let timer: ReturnType<typeof setTimeout> | undefined;
export async function updateSwitches(w: WorldClient, patch: Partial<Pick<Switches, 'music' | 'ambience' | 'sfx'>> & { volumes?: Partial<Switches['volumes']> }) {
  // Show the change at once; the server keeps it. Volume drags are sent once they pause.
  set({ ...state, ...patch, volumes: { ...state.volumes, ...(patch.volumes ?? {}) } });
  const send = async () => {
    try { await w.call('PUT', '/sound/me/switches', { device: deviceId(), label: deviceLabel(), music: state.music, ambience: state.ambience, sfx: state.sfx, volumes: state.volumes }); } catch { /* stays as shown */ }
  };
  clearTimeout(timer);
  if (Object.keys(patch).length === 1 && patch.volumes) { timer = setTimeout(() => void send(), 400); return; }
  await send();
}

function deviceLabel() {
  const ua = navigator.userAgent;
  return /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone/iPad' : /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Browser';
}
