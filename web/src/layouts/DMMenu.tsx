// The DM's side menu: pages in a few task-based groups that fold away (and remember it), a "Find a page" filter ("/" focuses it),
// and up to eight starred pages in a Pinned group at the top. Names, icons and descriptions come from lib/dmnames.ts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import * as F from '../features/registry.ts';
import './dmmenu.css';
import { DM_GROUPS, DM_NAMES, type DMGroupId } from '../lib/dmnames.ts';

export interface MenuEntry { to: string; label: string; icon: string; desc: string; group: DMGroupId }

/** Pages the app itself provides; the rest appear only when their feature is installed. */
const CORE = new Set(['', 'combat', 'quick', 'inbox', 'party', 'broker', 'library', 'people', 'relations', 'map', 'messages', 'calendar', 'whiteboard', 'settings', 'connect']);
export const MAX_PINS = 8;
const OPEN_KEY = 'alx.dm.menu.open';
const PIN_KEY = 'alx.dm.menu.pins';

function read<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
function write(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: the choice lasts for this page only */ } }

/** Every page in the menu, in menu order. */
export function menuEntries(): MenuEntry[] {
  const fromFeatures = new Map(F.dmNav.map((n) => [n.to, n]));
  const out: MenuEntry[] = [];
  for (const [to, base] of Object.entries(DM_NAMES)) {
    if (!CORE.has(to) && !fromFeatures.has(to)) continue;
    const f = fromFeatures.get(to);
    out.push({ to, label: f?.label ?? base.label, icon: f?.icon ?? base.icon, desc: f?.desc ?? base.desc, group: f?.group ?? base.group });
  }
  for (const n of F.dmNav) if (!(n.to in DM_NAMES)) out.push({ to: n.to, label: n.label ?? n.to, icon: n.icon ?? 'fa-circle', desc: n.desc ?? '', group: n.group ?? 'prep' });
  return out;
}

export const matches = (e: MenuEntry, q: string): boolean => {
  const hay = `${e.label} ${e.desc} ${DM_GROUPS.find((g) => g.id === e.group)?.label ?? ''}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
};

export function DMMenu({ base, badges, openDrawer }: { base: string; badges: Record<string, number>; openDrawer: () => void }) {
  const entries = useMemo(menuEntries, []);
  const byTo = useMemo(() => new Map(entries.map((e) => [e.to, e])), [entries]);
  const loc = useLocation();
  const nav = useNavigate();
  const [fold, setFold] = useState<Record<string, boolean>>(() => read(OPEN_KEY, {}));
  const [pins, setPins] = useState<string[]>(() => read<string[]>(PIN_KEY, []).filter((p) => typeof p === 'string').slice(0, MAX_PINS));
  const [q, setQ] = useState('');
  const find = useRef<HTMLInputElement>(null);

  // "/" jumps to the filter unless the DM is typing somewhere. (Ctrl+K belongs to the assistant.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      if (window.matchMedia('(max-width: 760px)').matches) openDrawer();
      requestAnimationFrame(() => { find.current?.focus(); find.current?.select(); });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openDrawer]);

  const here = loc.pathname.replace(/\/$/, '').slice(base.length + 1); // '' for the table, 'combat', ...
  const activeGroup = byTo.get(here)?.group;
  const isOpen = (id: string) => fold[id] ?? (id === 'pinned' || id === 'run' || id === activeGroup);
  const toggle = (id: string) => { const next = { ...fold, [id]: !isOpen(id) }; setFold(next); write(OPEN_KEY, next); };
  const togglePin = (to: string) => {
    const next = pins.includes(to) ? pins.filter((p) => p !== to) : pins.length < MAX_PINS ? [...pins, to] : pins;
    setPins(next); write(PIN_KEY, next);
  };

  const link = (e: MenuEntry, opts: { pin?: boolean; desc?: boolean } = {}) => {
    const n = badges[e.to] ?? 0;
    const pinned = pins.includes(e.to);
    return (
      <div className="nav-item" key={e.to}>
        <NavLink to={`${base}/${e.to}`} end={e.to === ''} className="nav-link" title={e.desc} aria-label={n ? `${e.label}, ${n} waiting` : undefined}>
          <i className={`fa-solid ${e.icon} fa-fw nav-ico`} aria-hidden="true" />
          <span className="nav-text"><span>{e.label}</span>{opts.desc && e.desc && <span className="nav-desc">{e.desc}</span>}</span>
          {n > 0 && <span className="count">{n}</span>}
        </NavLink>
        {opts.pin && (
          <button type="button" className="nav-pin" aria-pressed={pinned} aria-label={`${pinned ? 'Unpin' : 'Pin'} ${e.label}`}
            title={pinned ? `Unpin ${e.label}` : pins.length >= MAX_PINS ? `${MAX_PINS} pages are pinned; unpin one first` : `Pin ${e.label} to the top`}
            disabled={!pinned && pins.length >= MAX_PINS} onClick={() => togglePin(e.to)}>
            <i className={`${pinned ? 'fa-solid' : 'fa-regular'} fa-star`} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  };

  const section = (id: string, label: string, icon: string, list: MenuEntry[], cls = '') => {
    const open = isOpen(id);
    const waiting = list.reduce((s, e) => s + (badges[e.to] ?? 0), 0);
    return (
      <div className={`nav-group ${cls}`.trim()} key={id} data-group={id}>
        <button type="button" className="nav-head" aria-expanded={open} aria-controls={`navg-${id}`} onClick={() => toggle(id)}
          aria-label={`${label}${waiting && !open ? `, ${waiting} waiting` : ''}`}>
          <i className={`fa-solid ${icon} fa-fw nav-ico`} aria-hidden="true" />
          <span className="nav-label">{label}</span>
          {!open && waiting > 0 && <span className="count" data-testid={`group-badge-${id}`}>{waiting}</span>}
          <i className={`fa-solid fa-chevron-${open ? 'down' : 'right'} nav-chev`} aria-hidden="true" />
        </button>
        {open && <div id={`navg-${id}`} className="nav-items">{list.map((e) => link(e, { pin: true }))}</div>}
      </div>
    );
  };

  const query = q.trim();
  const found = query ? entries.filter((e) => matches(e, query)) : [];
  const pinned = pins.map((p) => byTo.get(p)).filter((e): e is MenuEntry => !!e);

  return (
    <div className="nav-menu">
      <div className="nav-find" role="search">
        <i className="fa-solid fa-magnifying-glass" aria-hidden="true" />
        <input ref={find} type="search" value={q} placeholder="Find a page" aria-label="Find a page" aria-keyshortcuts="/" data-testid="menu-find" autoComplete="off"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setQ(''); e.currentTarget.blur(); }
            else if (e.key === 'Enter' && found[0]) { nav(`${base}/${found[0].to}`); setQ(''); e.currentTarget.blur(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); (e.currentTarget.closest('.nav-menu')?.querySelector('.nav-results a') as HTMLElement | null)?.focus(); }
          }} />
        {!query && <kbd className="nav-kbd" aria-hidden="true">/</kbd>}
      </div>
      {query ? (
        <div className="nav-group nav-results" aria-label="Matching pages" data-testid="menu-results">
          {found.length ? found.map((e) => link(e, { desc: true })) : <p className="tiny faint nav-none" role="status">No page matches “{query}”.</p>}
        </div>
      ) : (
        <>
          {pinned.length > 0 && section('pinned', 'Pinned', 'fa-star', pinned, 'pinned')}
          {DM_GROUPS.map((g) => section(g.id, g.label, g.icon, entries.filter((e) => e.group === g.id))).filter((_, i) => entries.some((e) => e.group === DM_GROUPS[i].id))}
        </>
      )}
    </div>
  );
}
