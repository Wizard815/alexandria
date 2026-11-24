// The DM's navigation: five areas on a rail that never moves, and every page of the area you are in as a strip of tabs above the page.
// Nothing folds away. Up to eight starred pages show on the strip wherever you are. Names, icons and descriptions come from lib/dmnames.ts;
// the search box (features/search) lists every page too.
import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import * as F from '../features/registry.ts';
import './dmmenu.css';
import { DM_GROUPS, DM_NAMES, type DMGroupId } from '../lib/dmnames.ts';

export interface MenuEntry { to: string; label: string; icon: string; desc: string; group: DMGroupId }

/** Pages the app itself provides; the rest appear only when their feature is installed. */
const CORE = new Set(['', 'combat', 'quick', 'inbox', 'sharing', 'party', 'broker', 'library', 'people', 'relations', 'map', 'messages', 'calendar', 'whiteboard', 'settings', 'connect']);
export const MAX_PINS = 8;
const PIN_KEY = 'alx.dm.menu.pins';
const LAST_KEY = 'alx.dm.menu.last';

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

/** Where we are: the page's route under /dm ('' is the table) and its entry. */
export function useDMPlace(base: string) {
  const entries = useMemo(menuEntries, []);
  const loc = useLocation();
  const route = loc.pathname.replace(/\/$/, '').slice(base.length + 1);
  const entry = entries.find((e) => e.to === route) ?? entries.find((e) => e.to && route.startsWith(`${e.to}/`)) ?? entries[0];
  return { entries, route, entry };
}

/** The rail. Each area goes back to the page you last had open in it. On a phone it is the bottom bar. */
export function DMRail({ base, badges }: { base: string; badges: Record<string, number> }) {
  const { entries, entry } = useDMPlace(base);
  const [last, setLast] = useState<Record<string, string>>(() => read(LAST_KEY, {}));
  useEffect(() => { if (last[entry.group] !== entry.to) { const next = { ...last, [entry.group]: entry.to }; setLast(next); write(LAST_KEY, next); } }, [entry]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <nav className="dmx-rail" aria-label="DM">
      {DM_GROUPS.map((g) => {
        const list = entries.filter((e) => e.group === g.id);
        if (!list.length) return null;
        const to = list.find((e) => e.to === last[g.id])?.to ?? list[0].to;
        const waiting = list.reduce((s, e) => s + (badges[e.to] ?? 0), 0);
        return (
          <NavLink key={g.id} to={`${base}/${to}`} className={`dmx-area${entry.group === g.id ? ' on' : ''}`} data-group={g.id} aria-current={entry.group === g.id ? 'true' : undefined}
            aria-label={waiting ? `${g.label}, ${waiting} waiting` : g.label} title={list.map((e) => e.label).join(' · ')}>
            <i className={`fa-solid ${g.icon}`} aria-hidden="true" /><span>{g.label}</span>
            {waiting > 0 && <span className="nav-badge" data-testid={`group-badge-${g.id}`}>{waiting}</span>}
          </NavLink>
        );
      })}
    </nav>
  );
}

/** Every page of this area, and your starred pages. */
export function DMTabs({ base, badges }: { base: string; badges: Record<string, number> }) {
  const { entries, entry } = useDMPlace(base);
  const [pins, setPins] = useState<string[]>(() => read<string[]>(PIN_KEY, []).filter((p) => typeof p === 'string').slice(0, MAX_PINS));
  const pinned = pins.includes(entry.to);
  const toggle = () => {
    const next = pinned ? pins.filter((p) => p !== entry.to) : pins.length < MAX_PINS ? [...pins, entry.to] : pins;
    setPins(next); write(PIN_KEY, next);
  };
  const tab = (e: MenuEntry, pin = false) => {
    const n = badges[e.to] ?? 0;
    return (
      <NavLink key={e.to} to={`${base}/${e.to}`} end={e.to === ''} className="dmx-tab" title={e.desc} aria-label={n ? `${e.label}, ${n} waiting` : undefined}>
        <i className={`fa-solid ${pin ? 'fa-star' : e.icon}`} aria-hidden="true" /><span>{e.label}</span>{n > 0 && <span className="nav-badge">{n}</span>}
      </NavLink>
    );
  };
  // A starred page of this area already has its tab.
  const elsewhere = pins.map((p) => entries.find((e) => e.to === p)).filter((e): e is MenuEntry => !!e && e.group !== entry.group);
  return (
    <nav className="dmx-tabs" aria-label={`${DM_GROUPS.find((g) => g.id === entry.group)?.label ?? ''} pages`} data-testid="dm-tabs">
      {entries.filter((e) => e.group === entry.group).map((e) => tab(e))}
      {elsewhere.length > 0 && <span className="dmx-pins" data-testid="dm-pins">{elsewhere.map((e) => tab(e, true))}</span>}
      <button type="button" className="dmx-star" aria-pressed={pinned} aria-label={`${pinned ? 'Unpin' : 'Pin'} ${entry.label}`} disabled={!pinned && pins.length >= MAX_PINS}
        title={pinned ? `Unpin ${entry.label}` : pins.length >= MAX_PINS ? `${MAX_PINS} pages are pinned; unpin one first` : `Keep ${entry.label} on this strip wherever you are`} onClick={toggle}>
        <i className={`${pinned ? 'fa-solid' : 'fa-regular'} fa-star`} aria-hidden="true" />
      </button>
    </nav>
  );
}
