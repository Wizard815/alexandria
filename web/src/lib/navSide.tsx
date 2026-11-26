// Where the tab panel sits on a phone or a foldable: the player's tab bar and the DM's area rail.
// 'auto' keeps the default (bottom on a phone, left on a foldable opened up). Kept per device, in
// this browser, because it is about the hand holding the screen. The choice is applied as
// <html data-nav-side="..."> and fold.css does the rest; the height of the top bar is published as
// --top-h so a panel on top can sit just under it.
import { useEffect, useState, type RefObject } from 'react';

export type NavSide = 'auto' | 'left' | 'right' | 'top' | 'bottom';
export const NAV_SIDES: { id: NavSide; label: string; icon: string }[] = [
  { id: 'auto', label: 'Auto', icon: 'fa-wand-magic-sparkles' },
  { id: 'left', label: 'Left', icon: 'fa-arrow-left' },
  { id: 'right', label: 'Right', icon: 'fa-arrow-right' },
  { id: 'top', label: 'Top', icon: 'fa-arrow-up' },
  { id: 'bottom', label: 'Bottom', icon: 'fa-arrow-down' },
];
const KEY = 'alx.navSide';
const EVENT = 'alx-nav-side';

export function navSide(): NavSide {
  try { const v = localStorage.getItem(KEY); return NAV_SIDES.some((s) => s.id === v) ? (v as NavSide) : 'auto'; } catch { return 'auto'; }
}

/** Call once before the first render, so the page does not jump. */
export const initNavSide = () => apply(navSide());

function apply(s: NavSide) {
  if (s === 'auto') delete document.documentElement.dataset.navSide;
  else document.documentElement.dataset.navSide = s;
}

export function setNavSide(s: NavSide) {
  try { if (s === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, s); } catch { /* private mode: this visit only */ }
  apply(s);
  window.dispatchEvent(new Event(EVENT));
}

/** The current choice; re-renders when it changes (here or in another tab). */
export function useNavSide(): NavSide {
  const [s, setS] = useState(navSide);
  useEffect(() => {
    apply(navSide());
    const f = () => setS(navSide());
    window.addEventListener(EVENT, f);
    const st = (e: StorageEvent) => { if (e.key === KEY) { apply(navSide()); f(); } };
    window.addEventListener('storage', st);
    return () => { window.removeEventListener(EVENT, f); window.removeEventListener('storage', st); };
  }, []);
  return s;
}

/** Publishes the element's height as --top-h on <html>, for a panel that sits under it. */
export function useTopHeight(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const set = () => document.documentElement.style.setProperty('--top-h', `${Math.round(el.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
}

/** Left / Right / Top / Bottom buttons. */
export function NavSidePicker({ onPick }: { onPick?: (s: NavSide) => void }) {
  const cur = useNavSide();
  return (
    <div className="nav-side" role="radiogroup" aria-label="Tab panel position" data-testid="nav-side">
      {NAV_SIDES.map((s) => (
        <button key={s.id} type="button" role="radio" aria-checked={cur === s.id} className={`btn small${cur === s.id ? ' on' : ''}`} data-side={s.id}
          onClick={() => { setNavSide(s.id); onPick?.(s.id); }}>
          <i className={`fa-solid ${s.icon}`} aria-hidden="true" /> {s.label}
        </button>
      ))}
    </div>
  );
}
