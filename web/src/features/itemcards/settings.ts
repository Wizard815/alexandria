// The hover delay is a per-person setting kept in this browser only.
import { useCallback, useState } from 'react';

const KEY = 'alx.itemcards.hoverDelay';
export const MIN_DELAY = 0.5;
export const MAX_DELAY = 5;
export const DEFAULT_DELAY = 3;

export const clampDelay = (n: number) => (Number.isFinite(n) ? Math.min(MAX_DELAY, Math.max(MIN_DELAY, Math.round(n * 2) / 2)) : DEFAULT_DELAY);

export function readDelay(): number {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? DEFAULT_DELAY : clampDelay(Number(v));
  } catch { return DEFAULT_DELAY; }
}

export function useHoverDelay(): [number, (n: number) => void] {
  const [delay, set] = useState(readDelay);
  const save = useCallback((n: number) => {
    const v = clampDelay(n);
    set(v);
    try { localStorage.setItem(KEY, String(v)); } catch { /* private mode: lasts this visit only */ }
  }, []);
  return [delay, save];
}
