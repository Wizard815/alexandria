import { useCallback, useEffect, useRef, useState } from 'react';

/** A short buzz where the browser allows it. */
export function buzz(ms: number | number[] = 12) {
  try { navigator.vibrate?.(ms); } catch { /* not supported */ }
}

export interface Shape { w: number; h: number; wide: boolean }

/** Near-square screens (about 4:3, like a Fold's inner screen) get two panes. */
export function shapeOf(w: number, h: number): Shape {
  const lo = Math.min(w, h), hi = Math.max(w, h);
  return { w, h, wide: lo >= 600 && hi / lo <= 1.5 };
}

export function useShape(): Shape {
  const [s, setS] = useState(() => shapeOf(window.innerWidth, window.innerHeight));
  useEffect(() => {
    const f = () => setS((p) => { const n = shapeOf(window.innerWidth, window.innerHeight); return n.w === p.w && n.h === p.h ? p : n; });
    window.addEventListener('resize', f);
    window.addEventListener('orientationchange', f);
    return () => { window.removeEventListener('resize', f); window.removeEventListener('orientationchange', f); };
  }, []);
  return s;
}

export const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
export const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

export interface Undo { text: string; undo: () => void }
/** One undo toast at a time; it goes away after a few seconds. */
export function useUndo() {
  const [u, setU] = useState<Undo | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((x: Undo) => { clearTimeout(t.current); setU(x); t.current = setTimeout(() => setU(null), 6000); }, []);
  const clear = useCallback(() => { clearTimeout(t.current); setU(null); }, []);
  useEffect(() => () => clearTimeout(t.current), []);
  return { undo: u, show, clear };
}

/** A small text message that fades, for "Played", "Saved". */
export function useFlash() {
  const [m, setM] = useState<string | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flash = useCallback((s: string) => { clearTimeout(t.current); setM(s); t.current = setTimeout(() => setM(null), 2500); }, []);
  useEffect(() => () => clearTimeout(t.current), []);
  return { msg: m, flash };
}

/** Gold ("12.5") to copper. */
export const gpToCp = (s: string): number | null => {
  const n = Number(s.replace(/,/g, '').trim());
  return Number.isFinite(n) && s.trim() !== '' ? Math.round(n * 100) : null;
};
