// The admin side menu, built like the DM menu: a few task-based groups that fold away (and remember it) and a
// "Find a page" filter ("/" focuses it). Names, icons and descriptions come from lib/adminnames.ts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import * as F from '../features/registry.ts';
import './dmmenu.css';
import { ADMIN_GROUPS, ADMIN_NAMES, type AdminGroupId } from '../lib/adminnames.ts';

export interface AdminEntry { to: string; label: string; icon: string; desc: string; group: AdminGroupId | 'top' }
const OPEN_KEY = 'alx.admin.menu.open';

function read<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
function write(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* the choice lasts for this page only */ } }

/** Every page in the menu, in menu order. A page a feature adds without a name here lands under Server. */
export function adminEntries(): AdminEntry[] {
  const out: AdminEntry[] = Object.entries(ADMIN_NAMES).map(([to, n]) => ({ to, ...n }));
  for (const n of F.adminNav) if (!(n.to in ADMIN_NAMES)) out.push({ to: n.to, label: n.label, icon: 'fa-circle', desc: '', group: 'server' });
  return out;
}

export const matches = (e: AdminEntry, q: string): boolean => {
  const hay = `${e.label} ${e.desc} ${ADMIN_GROUPS.find((g) => g.id === e.group)?.label ?? ''}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
};

export function AdminMenu({ onNavigate }: { onNavigate: () => void }) {
  const entries = useMemo(adminEntries, []);
  const byTo = useMemo(() => new Map(entries.map((e) => [e.to, e])), [entries]);
  const loc = useLocation();
  const nav = useNavigate();
  const [fold, setFold] = useState<Record<string, boolean>>(() => read(OPEN_KEY, {}));
  const [q, setQ] = useState('');
  const find = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      find.current?.focus(); find.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const here = loc.pathname.replace(/\/$/, '').split('/')[2] ?? ''; // 'models', 'worlds', '' for the overview
  const activeGroup = byTo.get(here)?.group;
  const isOpen = (id: string) => fold[id] ?? (id === activeGroup || (!activeGroup && id === 'worlds'));
  const toggle = (id: string) => { const next = { ...fold, [id]: !isOpen(id) }; setFold(next); write(OPEN_KEY, next); };

  const link = (e: AdminEntry, desc = false) => (
    <div className="nav-item" key={e.to}>
      <NavLink to={`/admin/${e.to}`} end={e.to === ''} className="nav-link" title={e.desc} onClick={onNavigate}>
        <i className={`fa-solid ${e.icon} fa-fw nav-ico`} aria-hidden="true" />
        <span className="nav-text"><span>{e.label}</span>{desc && e.desc && <span className="nav-desc">{e.desc}</span>}</span>
      </NavLink>
    </div>
  );

  const query = q.trim();
  // Pages whose name matches come before pages that only mention the words in their description.
  const named = (e: AdminEntry) => (e.label.toLowerCase().includes(query.toLowerCase()) ? 0 : 1);
  const found = query ? entries.filter((e) => matches(e, query)).sort((a, b) => named(a) - named(b)) : [];
  const top = entries.filter((e) => e.group === 'top');

  return (
    <div className="nav-menu">
      <div className="nav-find" role="search">
        <i className="fa-solid fa-magnifying-glass" aria-hidden="true" />
        <input ref={find} type="search" value={q} placeholder="Find a page" aria-label="Find a page" aria-keyshortcuts="/" data-testid="menu-find" autoComplete="off"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setQ(''); e.currentTarget.blur(); }
            else if (e.key === 'Enter' && found[0]) { nav(`/admin/${found[0].to}`); setQ(''); e.currentTarget.blur(); onNavigate(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); (e.currentTarget.closest('.nav-menu')?.querySelector('.nav-results a') as HTMLElement | null)?.focus(); }
          }} />
        {!query && <kbd className="nav-kbd" aria-hidden="true">/</kbd>}
      </div>
      {query ? (
        <div className="nav-group nav-results" aria-label="Matching pages" data-testid="menu-results">
          {found.length ? found.map((e) => link(e, true)) : <p className="tiny faint nav-none" role="status">No page matches “{query}”.</p>}
        </div>
      ) : (
        <>
          <div className="nav-group">{top.map((e) => link(e))}</div>
          {ADMIN_GROUPS.map((g) => {
            const list = entries.filter((e) => e.group === g.id);
            if (!list.length) return null;
            const open = isOpen(g.id);
            return (
              <div className="nav-group" key={g.id} data-group={g.id}>
                <button type="button" className="nav-head" aria-expanded={open} aria-controls={`anavg-${g.id}`} onClick={() => toggle(g.id)}>
                  <i className={`fa-solid ${g.icon} fa-fw nav-ico`} aria-hidden="true" />
                  <span className="nav-label">{g.label}</span>
                  <i className={`fa-solid fa-chevron-${open ? 'down' : 'right'} nav-chev`} aria-hidden="true" />
                </button>
                {open && <div id={`anavg-${g.id}`} className="nav-items">{list.map((e) => link(e))}</div>}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
