import { useEffect, useState } from 'react';
import { NavLink, Outlet, Navigate, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth.tsx';
import { useWorld, useLoad } from '../lib/world.tsx';
import QuickPrompt from '../pages/player/QuickPrompt.tsx';
import { OfflineBanner } from '../ui/index.tsx';

// [path, label, Font Awesome icon]
const LINKS: [string, string, string][] = [
  ['', 'Home', 'fa-house'], ['live', 'Live', 'fa-tower-broadcast'], ['library', 'Library', 'fa-book'], ['broker', 'Broker', 'fa-scale-balanced'],
  ['inventory', 'Inventory', 'fa-sack-dollar'], ['people', 'People', 'fa-users'], ['me', 'Me', 'fa-user'], ['map', 'Map', 'fa-map'],
  ['messages', 'Messages', 'fa-envelope'], ['calendar', 'Calendar', 'fa-calendar'], ['ask', 'Ask the DM', 'fa-circle-question'], ['whiteboard', 'Whiteboard', 'fa-chalkboard'],
];
// The phone's bottom bar; everything else is under "More".
const MOBILE = ['', 'live', 'library', 'broker', 'inventory'];

export function PlayerLayout() {
  const { info, isDM, connected, w } = useWorld();
  const { me, signOut } = useAuth();
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  // Broker offers waiting for this player: a badge on the Broker link.
  const brokerOn = !isDM && (info.settings as { brokerEnabled?: boolean }).brokerEnabled !== false;
  const offers = useLoad(() => (brokerOn ? w.call<{ status: string }[]>('GET', '/broker/offers') : Promise.resolve([])), [w, brokerOn], ['broker-offer']);
  const offerCount = (offers.data ?? []).filter((o) => o.status === 'open').length;
  const badge = (to: string) => (to === 'broker' && offerCount > 0 ? <span className="nav-badge" aria-label={`${offerCount} offer${offerCount === 1 ? '' : 's'} waiting`}>{offerCount}</span> : null);
  if (isDM) return <Navigate to={`/w/${info.slug}/dm`} replace />;
  const base = `/w/${info.slug}`;
  const moreActive = !MOBILE.some((to) => (to === '' ? loc.pathname === base || loc.pathname === `${base}/` : loc.pathname.startsWith(`${base}/${to}`)));
  return (
    <div className="t-fantasy">
      <header className="topbar">
        <Link to={base} className="brand">{info.name}</Link>
        <span className={`live-dot${connected ? '' : ' off'} phone-only`} title={connected ? 'Live updates on' : 'Reconnecting'} />
        <nav className="topnav desktop" aria-label="Scribe">
          {LINKS.map(([to, label]) => <NavLink key={to} to={`${base}/${to}`} end={to === ''} className="nav-link">{label}{badge(to)}</NavLink>)}
        </nav>
        <span className="row topbar-end desktop-only">
          <span className="tiny faint" title={connected ? 'Live updates on' : 'Reconnecting'}><span className={`live-dot${connected ? '' : ' off'}`} /></span>
          <NavLink to={`${base}/connect`} className="nav-link small">Connect an AI</NavLink>
          <NavLink to="/" className="chip gold" style={{ textDecoration: 'none' }}>{me?.account.display_name}</NavLink>
          <button type="button" className="btn small ghost" onClick={() => void signOut()}>Sign out</button>
        </span>
      </header>
      <OfflineBanner />
      <main><Outlet /></main>
      <nav className="bottomnav" aria-label="Scribe (phone)">
        {LINKS.filter(([to]) => MOBILE.includes(to)).map(([to, label, icon]) => (
          <NavLink key={to} to={`${base}/${to}`} end={to === ''}>
            <span className="icon" aria-hidden="true"><i className={`fa-solid ${icon}`} />{badge(to)}</span>{label}
          </NavLink>
        ))}
        <button type="button" className={moreActive ? 'active' : ''} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          <span className="icon" aria-hidden="true"><i className="fa-solid fa-bars" /></span>More
        </button>
      </nav>
      {menu && (
        <div className="sheet-backdrop" onClick={() => setMenu(false)}>
          <nav className="sheet" aria-label="More" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grid">
              {LINKS.filter(([to]) => !MOBILE.includes(to)).map(([to, label, icon]) => (
                <NavLink key={to} to={`${base}/${to}`} className="sheet-link"><i className={`fa-solid ${icon}`} aria-hidden="true" />{label}</NavLink>
              ))}
              <NavLink to={`${base}/connect`} className="sheet-link"><i className="fa-solid fa-plug" aria-hidden="true" />Connect an AI</NavLink>
              <NavLink to="/" className="sheet-link"><i className="fa-solid fa-earth-americas" aria-hidden="true" />Your worlds</NavLink>
            </div>
            <div className="sheet-foot"><span className="small muted">Signed in as {me?.account.display_name}</span><button type="button" className="btn small ghost" onClick={() => void signOut()}>Sign out</button></div>
          </nav>
        </div>
      )}
      <QuickPrompt />
    </div>
  );
}
