// One tidy dock for the floating overlays (quick gen, assistant, chat,
// transcript, sound, recording). Every overlay puts its launcher button here
// with <DockButton>, so none can sit on top of another or on a page's own
// buttons: the dock is a single row in the bottom-right corner (above the
// player's bottom bar on phones). Panels that open from a button anchor just
// above the dock (class "dock-panel"); the assistant, which is a side panel,
// calls useDockShift(open) so the dock slides out of its way.
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './dock.css';

const ID = 'alx-dock';

/** The dock element, made on first use and kept for the life of the page. */
function dockEl(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById(ID);
  if (!el) {
    el = document.createElement('div');
    el.id = ID;
    el.className = 'dock';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Quick tools');
    // On phones the dock is folded behind one button, so five round buttons never sit on the page.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'dock-toggle';
    toggle.setAttribute('aria-label', 'Quick tools');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<i class="fa-solid fa-ellipsis" aria-hidden="true"></i>';
    const setOpen = (v: boolean) => { el!.classList.toggle('open', v); toggle.setAttribute('aria-expanded', String(v)); toggle.firstElementChild!.className = v ? 'fa-solid fa-xmark' : 'fa-solid fa-ellipsis'; };
    toggle.addEventListener('click', () => setOpen(!el!.classList.contains('open')));
    // Choosing a tool folds the dock again.
    el.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('.dock-btn')) setOpen(false); });
    el.appendChild(toggle);
    // Inside the themed shell, so the theme's colour variables apply.
    (document.querySelector('.t-fantasy, .t-admin') ?? document.body).appendChild(el);
  }
  return el;
}

/** Put anything in the dock. `order` sorts left to right (lower first). */
export function DockItem({ order = 50, keep, children }: { order?: number; /** Stays visible when the dock is folded on a phone. */ keep?: boolean; children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => { const e = dockEl(); if (e !== el) setEl(e); });
  if (!el) return null;
  return createPortal(<span className={`dock-slot${keep ? ' keep' : ''}`} style={{ order }}>{children}</span>, el);
}

export interface DockButtonProps {
  order?: number;
  /** A Font Awesome solid name such as 'fa-dice'. */
  icon: string;
  label: string;
  title?: string;
  onClick: () => void;
  badge?: number | string;
  active?: boolean;
  primary?: boolean;
  /** Shows a pulsing red dot (recording). */
  live?: boolean;
  /** Shown beside the icon (wide screens only). */
  text?: string;
  testId?: string;
}

export function DockButton({ order, icon, label, title, onClick, badge, active, primary, live, text, testId }: DockButtonProps) {
  return (
    <DockItem order={order}>
      <button type="button" className={`dock-btn${active ? ' on' : ''}${primary ? ' primary' : ''}`} aria-label={label} aria-pressed={active === undefined ? undefined : active} title={title ?? label} onClick={onClick} data-testid={testId}>
        <i className={`fa-solid ${icon}`} aria-hidden="true" />
        {text && <span className="dock-text">{text}</span>}
        {live && <span className="dock-live" aria-hidden="true" />}
        {badge !== undefined && badge !== 0 && badge !== '' && <span className="dock-badge">{badge}</span>}
      </button>
    </DockItem>
  );
}

/** Tell the dock a side panel is open (it moves left so it is not covered). */
export function useDockShift(open: boolean) {
  useEffect(() => {
    if (!open) return;
    document.documentElement.dataset.agentOpen = '1';
    return () => { delete document.documentElement.dataset.agentOpen; };
  }, [open]);
}

const PANEL_EVENT = 'alx-dock-panel';

/** Panels that open from the dock share one spot, so opening one closes the others. */
export function useExclusivePanel(id: string, open: boolean, close: () => void) {
  useEffect(() => {
    if (open) window.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: id }));
  }, [id, open]);
  useEffect(() => {
    const f = (e: Event) => { if ((e as CustomEvent).detail !== id && open) close(); };
    window.addEventListener(PANEL_EVENT, f);
    return () => window.removeEventListener(PANEL_EVENT, f);
  }, [id, open, close]);
}
