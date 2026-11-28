// The phone's "More" menu: every page in groups, a search box, and a pin button
// on each page to put it in the bottom tab bar (up to four, reorderable).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { FALLBACK_GROUP, GROUPS, MAX_TABS, groupOf, type NavItem } from '../lib/playerNav.ts';
import { NavSidePicker } from '../lib/navSide.tsx';
import { ZoomPicker } from '../lib/uiZoom.tsx';

interface Props {
  base: string;
  links: NavItem[];
  tabIds: string[];
  isDefault: boolean;
  badge: (to: string) => ReactNode;
  name: string;
  onPins: (ids: string[] | null) => void;
  onClose: () => void;
  onSignOut: () => void;
}

// Entries that are not in the tab list (they cannot be pinned).
const EXTRA: (NavItem & { id: string; group: string; href?: string })[] = [
  { id: 'connect', to: 'connect', label: 'Connect an AI', icon: 'fa-plug', group: 'Settings & account' },
  { id: 'theme', to: 'me#theme', label: 'Theme & effects', icon: 'fa-palette', group: 'Settings & account' },
  { id: 'worlds', to: '/', label: 'Your worlds', icon: 'fa-earth-americas', group: 'Settings & account', href: '/' },
];

export function MoreSheet({ base, links, tabIds, isDefault, badge, name, onPins, onClose, onSignOut }: Props) {
  const [q, setQ] = useState('');
  const [arrange, setArrange] = useState(false);
  const [note, setNote] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const label = (id: string) => links.find((l) => l.to === id)?.label ?? id;

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const needle = q.trim().toLowerCase();
  const groups = useMemo(() => {
    const items = [
      ...links.map((l) => ({ ...l, id: l.to, group: groupOf(l.to), href: undefined as string | undefined, pin: true })),
      ...EXTRA.map((e) => ({ ...e, pin: false })),
    ].filter((i) => !needle || i.label.toLowerCase().includes(needle));
    const names = [...GROUPS, FALLBACK_GROUP];
    return names.map((g) => ({ g, items: items.filter((i) => i.group === g) })).filter((x) => x.items.length);
  }, [links, needle]);

  const pin = (to: string) => {
    if (tabIds.includes(to)) { setNote(''); onPins(tabIds.filter((t) => t !== to)); return; }
    if (tabIds.length >= MAX_TABS) { setNote(`The tab bar holds ${MAX_TABS}. Unpin one first.`); return; }
    setNote(`${label(to)} added to the tab bar.`);
    onPins([...tabIds, to]);
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= tabIds.length) return;
    const next = [...tabIds];
    [next[i], next[j]] = [next[j], next[i]];
    onPins(next);
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet more" role="dialog" aria-modal="true" aria-label="More" ref={ref} tabIndex={-1} onClick={(e) => e.stopPropagation()} data-testid="more-sheet">
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-top">
          <input type="search" className="input" placeholder="Find a page" aria-label="Find a page" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="button" className={`btn${arrange ? ' on' : ''}`} aria-pressed={arrange} onClick={() => setArrange((a) => !a)}>Edit tabs</button>
          <button type="button" className="btn" aria-label="Close menu" onClick={onClose}>Close</button>
        </div>
        <div className="sheet-body">
          {arrange && (
            <section className="more-tabs" aria-label="Your tab bar">
              <h3>Your tab bar{isDefault ? ' (default)' : ''}</h3>
              <ol className="more-tablist">
                {tabIds.map((id, i) => (
                  <li key={id}>
                    <span className="grow">{label(id)}</span>
                    <button type="button" className="icon-btn" aria-label={`Move ${label(id)} earlier`} disabled={i === 0} onClick={() => move(i, -1)}><i className="fa-solid fa-arrow-up" aria-hidden="true" /></button>
                    <button type="button" className="icon-btn" aria-label={`Move ${label(id)} later`} disabled={i === tabIds.length - 1} onClick={() => move(i, 1)}><i className="fa-solid fa-arrow-down" aria-hidden="true" /></button>
                    <button type="button" className="icon-btn" aria-label={`Remove ${label(id)} from the tab bar`} onClick={() => pin(id)}><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
                  </li>
                ))}
              </ol>
              <button type="button" className="btn" onClick={() => { setNote('Tab bar reset.'); onPins(null); }} disabled={isDefault}>Reset to default</button>
              <h3>Where the tab bar sits</h3>
              <p className="small muted">On this device. Auto: bottom on a phone, left on a foldable opened up.</p>
              <ZoomPicker />
              <NavSidePicker onPick={(s) => setNote(s === 'auto' ? 'Tab bar back to its usual place.' : `Tab bar on the ${s}.`)} />
            </section>
          )}
          <p className="small muted more-note" role="status">{note}</p>
          {groups.map(({ g, items }) => (
            <section key={g} aria-label={g} data-group={g}>
              <h3 className="more-group">{g}</h3>
              <ul className="more-list">
                {items.map((i) => {
                  const on = tabIds.includes(i.to);
                  return (
                    <li key={i.id}>
                      {i.href
                        ? <NavLink to={i.href} className="more-link"><i className={`fa-solid ${i.icon}`} aria-hidden="true" />{i.label}</NavLink>
                        : <NavLink to={`${base}/${i.to}`} end={i.to === ''} className={({ isActive }) => `more-link${isActive && i.id !== 'theme' ? ' active' : ''}`} data-more={i.id}><i className={`fa-solid ${i.icon}`} aria-hidden="true" />{i.label}{badge(i.to)}</NavLink>}
                      {i.pin && (
                        <button type="button" className={`pin-btn${on ? ' on' : ''}`} aria-pressed={on} aria-label={on ? `Unpin ${i.label} from the tab bar` : `Pin ${i.label} to the tab bar`} onClick={() => pin(i.to)}>
                          <i className="fa-solid fa-thumbtack" aria-hidden="true" />
                        </button>
                      )}
                    </li>
                  );
                })}
                {g === 'Settings & account' && !needle && (
                  <li><button type="button" className="more-link" onClick={onSignOut}><i className="fa-solid fa-right-from-bracket" aria-hidden="true" />Sign out <span className="faint small">{name}</span></button></li>
                )}
              </ul>
            </section>
          ))}
          {!groups.length && <p className="empty">Nothing matches “{q}”.</p>}
        </div>
      </div>
    </div>
  );
}
