// Per-browser choices for the DM's multi-monitor setup. All of it is localStorage in try/catch: a private window or blocked
// storage just means the defaults every time, never an error.
import { useCallback, useEffect, useState } from 'react';

function read<T>(key: string, fallback: T): T {
  try { const s = localStorage.getItem(key); return s ? { ...fallback, ...JSON.parse(s) } : fallback; } catch { return fallback; }
}
function write(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private window */ }
}

/** A stored object that every component using it (and every tab of this browser) stays in step with. */
function useStored<T extends object>(key: string, fallback: T): [T, (p: Partial<T>) => void] {
  const [v, setV] = useState<T>(() => read(key, fallback));
  useEffect(() => {
    const again = () => setV(read(key, fallback));
    const onStorage = (e: StorageEvent) => { if (e.key === key) again(); };
    window.addEventListener(`alx-pref:${key}`, again);
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener(`alx-pref:${key}`, again); window.removeEventListener('storage', onStorage); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const patch = useCallback((p: Partial<T>) => {
    write(key, { ...read(key, fallback), ...p });
    window.dispatchEvent(new Event(`alx-pref:${key}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [v, patch];
}

/** What the main monitor drops because it lives on the side screen. */
export interface MainPrefs { hideAssistant: boolean; hideTranscript: boolean }
export const useMainPrefs = () => useStored<MainPrefs>('alx.screens.main', { hideAssistant: false, hideTranscript: false });

/** Which physical monitor each display opens on (a Window Management API screen label), by display id. */
export type Assignments = Record<string, string>;
export const useAssignments = () => useStored<Assignments>('alx.screens.assign', {});

/** The side screen's stack: which panels, in which order, folded or not, and how tall (px). */
export interface SidePanel { id: string; folded: boolean; h: number }
export const SIDE_KEY = 'alx.screens.side';
export function loadSide(fallback: SidePanel[]): SidePanel[] {
  try {
    const v = JSON.parse(localStorage.getItem(SIDE_KEY) ?? 'null');
    if (Array.isArray(v)) return v.filter((p) => p && typeof p.id === 'string').map((p) => ({ id: p.id, folded: !!p.folded, h: Number.isFinite(p.h) ? p.h : 360 }));
  } catch { /* fall through */ }
  return fallback;
}
export const saveSide = (v: SidePanel[]) => write(SIDE_KEY, v);
