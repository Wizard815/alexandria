// The DM's navigation: five areas on a rail that never moves, and every page of the area you are in as a strip of tabs above the page.
// Nothing folds away. Up to eight starred pages show on the strip wherever you are. Names, icons and descriptions come from lib/dmnames.ts;
// the search box (features/search) lists every page too.
import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import * as F from '../features/registry.ts';
import './dmmenu.css';
import { DM_GROUPS, DM_NAMES, type DMGroupId } from '../lib/dmnames.ts';
import { LAYOUTS_EVENT, PAGE_MIME, PRESETS, layoutDef, loadSaved, normalize, openBeside, openIn, pageOfRoute, parse, recWorkspace, routeOfPage, workspaceHidden, wsPath, type LayoutRec, type Workspace } from '../lib/workspace.ts';

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
  const here = loc.pathname.replace(/\/$/, '').slice(base.length + 1);
  // In the workspace (ws?p=combat,sound...) the place is the page in the focused pane.
  const ws = here === 'ws' ? parse(loc.search) : null;
  const inWs = here === 'ws';
  const route = inWs ? routeOfPage(ws?.p[ws.f] ?? 'table') : here;
  const entry = entries.find((e) => e.to === route) ?? entries.find((e) => e.to && route.startsWith(`${e.to}/`)) ?? entries[0];
  return { entries, route, entry, ws, inWs };
}

/** In the workspace the rail only turns the strip to another area (the panes stay); anywhere the place changes, that ends. */
const AREA_EVENT = 'alx-dm-area';
function useArea(entry: MenuEntry): DMGroupId {
  const loc = useLocation();
  const [picked, setPicked] = useState<DMGroupId | null>(null);
  useEffect(() => setPicked(null), [loc.pathname, loc.search]);
  useEffect(() => {
    const f = (e: Event) => setPicked((e as CustomEvent).detail);
    window.addEventListener(AREA_EVENT, f);
    return () => window.removeEventListener(AREA_EVENT, f);
  }, []);
  return picked ?? entry.group;
}

/** The rail. Each area goes back to the page you last had open in it. On a phone it is the bottom bar. */
export function DMRail({ base, badges }: { base: string; badges: Record<string, number> }) {
  const { entries, entry, inWs } = useDMPlace(base);
  const area = useArea(entry);
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
          <NavLink key={g.id} to={`${base}/${to}`} className={`dmx-area${area === g.id ? ' on' : ''}`} data-group={g.id} aria-current={area === g.id ? 'true' : undefined}
            aria-label={waiting ? `${g.label}, ${waiting} waiting` : g.label} title={list.map((e) => e.label).join(' · ')}
            onClick={(ev) => { if (inWs && ev.button === 0 && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey) { ev.preventDefault(); window.dispatchEvent(new CustomEvent(AREA_EVENT, { detail: g.id })); } }}>
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
  const { entries, entry, route, ws, inWs } = useDMPlace(base);
  const area = useArea(entry);
  const nav = useNavigate();
  // In the workspace a click opens the page in the focused pane instead of leaving; "beside" (or a middle click) opens it in another.
  const openNext = (id: string) => {
    const from: Workspace = ws ?? normalize({ l: 'one', p: [pageOfRoute(route)] });
    nav(wsPath(base, openBeside(from, id)));
  };
  const [pins, setPins] = useState<string[]>(() => read<string[]>(PIN_KEY, []).filter((p) => typeof p === 'string').slice(0, MAX_PINS));
  const pinned = pins.includes(entry.to);
  const toggle = () => {
    const next = pinned ? pins.filter((p) => p !== entry.to) : pins.length < MAX_PINS ? [...pins, entry.to] : pins;
    setPins(next); write(PIN_KEY, next);
  };
  const tab = (e: MenuEntry, pin = false) => {
    const n = badges[e.to] ?? 0;
    const id = pageOfRoute(e.to);
    const inPane = !!ws && ws.p.includes(id);
    return (
      <span className="dmx-tabwrap" key={e.to} draggable onDragStart={(ev) => { ev.dataTransfer.setData(PAGE_MIME, id); ev.dataTransfer.effectAllowed = 'copyMove'; }}>
        <NavLink to={`${base}/${e.to}`} end={e.to === ''} className={({ isActive }) => `dmx-tab${isActive || inPane ? ' active' : ''}`} title={inPane ? `${e.desc} (open in a pane)` : e.desc} aria-label={n ? `${e.label}, ${n} waiting` : undefined} draggable={false}
          onClick={(ev) => { if (ws && ev.button === 0 && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey) { ev.preventDefault(); nav(wsPath(base, openIn(ws, ws.f, id))); } }}
          onAuxClick={(ev) => { if (ev.button === 1) { ev.preventDefault(); openNext(id); } }}>
          <i className={`fa-solid ${pin ? 'fa-star' : e.icon}`} aria-hidden="true" /><span>{e.label}</span>{n > 0 && <span className="nav-badge">{n}</span>}
        </NavLink>
        <button type="button" className="dmx-beside" aria-label={`Open ${e.label} beside`} title={`Open ${e.label} beside the current page, in another pane (or middle-click)`} data-testid={`beside-${id}`} onClick={() => openNext(id)}><i className="fa-solid fa-table-columns" aria-hidden="true" /></button>
      </span>
    );
  };
  // A starred page of this area already has its tab.
  const elsewhere = pins.map((p) => entries.find((e) => e.to === p)).filter((e): e is MenuEntry => !!e && e.group !== area);
  return (
    <nav className="dmx-tabs" aria-label={`${DM_GROUPS.find((g) => g.id === area)?.label ?? ''} pages`} data-testid="dm-tabs">
      {entries.filter((e) => e.group === area).map((e) => tab(e))}
      {elsewhere.length > 0 && <span className="dmx-pins" data-testid="dm-pins">{elsewhere.map((e) => tab(e, true))}</span>}
      <span className="dmx-tools">
      <WorkspaceMenu base={base} inWs={inWs} />
      <button type="button" className="dmx-star" aria-pressed={pinned} aria-label={`${pinned ? 'Unpin' : 'Pin'} ${entry.label}`} disabled={!pinned && pins.length >= MAX_PINS}
        title={pinned ? `Unpin ${entry.label}` : pins.length >= MAX_PINS ? `${MAX_PINS} pages are pinned; unpin one first` : `Keep ${entry.label} on this strip wherever you are`} onClick={toggle}>
        <i className={`${pinned ? 'fa-solid' : 'fa-regular'} fa-star`} aria-hidden="true" />
      </button>
      </span>
    </nav>
  );
}

/** Split the window into panes: the workspace, and its preset and saved layouts. */
function WorkspaceMenu({ base, inWs }: { base: string; inWs: boolean }) {
  const nav = useNavigate();
  const slug = base.split('/')[2] ?? '';
  const [open, setOpen] = useState(false);
  const [layouts, setLayouts] = useState<LayoutRec[]>(() => loadSaved(slug));
  const [hidden, setHidden] = useState(workspaceHidden);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const f = () => { setLayouts(loadSaved(slug)); setHidden(workspaceHidden()); };
    window.addEventListener(LAYOUTS_EVENT, f);
    return () => window.removeEventListener(LAYOUTS_EVENT, f);
  }, [slug]);
  useEffect(() => {
    if (!open) return;
    const out = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', out); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc); };
  }, [open]);
  useEffect(() => { document.body.classList.toggle('ws-hidden', hidden); }, [hidden]);
  if (hidden && !inWs) return null;
  return (
    <span className="dmx-pop-wrap dmx-ws" ref={box}>
      <NavLink to={`${base}/ws`} className={`dmx-tab${inWs ? ' active' : ''}`} title="Split the window into panes: Combat and Sound side by side, and more" data-testid="menu-workspace"><i className="fa-solid fa-table-columns" aria-hidden="true" /><span>Workspace</span></NavLink>
      <button type="button" className="dmx-star nav-layouts" aria-label="Layouts" title="Layouts" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><i className="fa-solid fa-chevron-down" aria-hidden="true" /></button>
      {open && (
        <div className="dmx-pop dmx-menu dmx-layouts" role="menu">
          {[...PRESETS, ...layouts].map((r) => (
            <button key={r.id} type="button" role="menuitem" title={`${layoutDef(r.l).label}: ${r.p.join(', ')}`} data-testid="menu-layout" onClick={() => { setOpen(false); nav(wsPath(base, recWorkspace(r))); }}><i className={`fa-solid ${layoutDef(r.l).icon}`} aria-hidden="true" /> {r.name}</button>
          ))}
        </div>
      )}
    </span>
  );
}
