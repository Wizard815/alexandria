import { useEffect, useState } from 'react';
import { NavLink, Outlet, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth.tsx';
import { useWorld, useLoad } from '../lib/world.tsx';
import { OfflineBanner } from '../ui/index.tsx';
import * as F from '../features/registry.ts';

const GROUPS: [string, [string, string][]][] = [
  ['At the table', [['', '✦ The table'], ['combat', '⚔ Combat'], ['quick', '⚡ Quick events'], ['party', '♟ Party & inventory'], ['approvals', '✓ Approvals'], ['broker', '⚖ Information broker']]],
  ['The world', [['library', '❧ Library'], ['people', '☺ People'], ['relations', '⚭ Relations'], ['map', '✧ Map'], ['requests', '✎ Requests'], ['messages', '✉ Messages'], ['calendar', '▦ Session calendar'], ['whiteboard', '▤ Whiteboard']]],
  ['Setup', [['settings', '⚙ World settings'], ['connect', '⌁ Connect an AI']]],
];

export function DMLayout() {
  const { info, isDM, w, connected } = useWorld();
  const { me, signOut } = useAuth();
  // On a phone the side menu is a drawer behind the top bar's menu button.
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  useEffect(() => setDrawer(false), [loc.pathname]);
  const requests = useLoad(() => w.requests(), [w], ['request']);
  const approvals = useLoad(() => (isDM ? w.call<any>('GET', '/approvals') : Promise.resolve(null)), [w, isDM], ['approval', 'coin', 'item', 'item-removed']);
  if (!isDM) return <Navigate to={`/w/${info.slug}`} replace />;
  const open = (requests.data ?? []).filter((r: any) => r.status === 'open').length;
  const c = approvals.data?.counts;
  const pending = c ? c.coin + c.items + c.disputes : 0;
  return (
    <div className="t-fantasy shell has-drawer">
      <header className="dm-phonebar">
        <button type="button" className="icon-btn" aria-label="Menu" aria-expanded={drawer} onClick={() => setDrawer((d) => !d)}><i className="fa-solid fa-bars" aria-hidden="true" />{open + pending > 0 && <span className="nav-badge">{open + pending}</span>}</button>
        <span className="brand">{info.name}</span>
        <span className="tiny faint" style={{ marginLeft: 'auto' }}><span className={`live-dot${connected ? '' : ' off'}`} /> DM</span>
      </header>
      {drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} />}
      <nav className={`side${drawer ? ' open' : ''}`} aria-label="DM">
        <div className="stack tight"><span className="brand">Alexandria</span><span className="sub">Dungeon Master · {info.name}</span></div>
        {GROUPS.map(([label, core]) => [label, [...core, ...F.dmNav.filter((n) => n.group === label).map((n) => [n.to, n.label] as [string, string])]] as const).map(([label, links]) => (
          <div className="nav-group" key={label}>
            <span className="nav-label">{label}</span>
            {links.map(([to, text]) => (
              <NavLink key={to} to={`/w/${info.slug}/dm/${to}`} end={to === ''} className="nav-link">
                {text}{to === 'requests' && open > 0 && <span className="count">{open}</span>}{to === 'approvals' && pending > 0 && <span className="count">{pending}</span>}
              </NavLink>
            ))}
          </div>
        ))}
        <div className="side-foot">
          <span className="tiny faint"><span className={`live-dot${connected ? '' : ' off'}`} /> {connected ? 'Live' : 'Reconnecting…'}</span>
          <NavLink to="/" className="nav-link">← Your worlds</NavLink>
          {me?.account.is_admin && <NavLink to="/admin" className="nav-link">Library admin</NavLink>}
          <button type="button" className="btn small" onClick={() => void signOut()}>Sign out</button>
        </div>
      </nav>
      <main className="main"><OfflineBanner />{F.topbars.length > 0 && <div className="feature-topbar">{F.topbars.map((C, i) => <C key={i} />)}</div>}<Outlet /></main>
      {F.overlays.map((C, i) => <C key={i} />)}
    </div>
  );
}
