import { NavLink, Outlet, Navigate, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth.tsx';
import { useWorld } from '../lib/world.tsx';
import QuickPrompt from '../pages/player/QuickPrompt.tsx';

const LINKS: [string, string, string][] = [
  ['', 'Home', '⌂'], ['live', '● Live', '●'], ['library', 'Library', '❧'], ['broker', 'Broker', '⚖'], ['people', 'People', '☺'], ['me', 'Me', '✦'],
  ['inventory', 'Inventory', '♟'], ['map', 'Map', '✧'], ['messages', 'Messages', '✉'], ['calendar', 'Calendar', '▦'],
  ['ask', 'Ask the DM', '?'], ['whiteboard', 'Whiteboard', '▤'],
];
const MOBILE = ['', 'live', 'library', 'broker', 'me'];

export function PlayerLayout() {
  const { info, isDM, connected } = useWorld();
  const { me, signOut } = useAuth();
  if (isDM) return <Navigate to={`/w/${info.slug}/dm`} replace />;
  const base = `/w/${info.slug}`;
  return (
    <div className="t-fantasy">
      <header className="topbar">
        <Link to={base} className="brand">{info.name}</Link>
        <nav className="topnav desktop" aria-label="Scribe">
          {LINKS.map(([to, label]) => <NavLink key={to} to={`${base}/${to}`} end={to === ''} className="nav-link">{label}</NavLink>)}
        </nav>
        <span className="row" style={{ marginLeft: 'auto' }}>
          <span className="tiny faint" title={connected ? 'Live updates on' : 'Reconnecting'}><span className={`live-dot${connected ? '' : ' off'}`} /></span>
          <NavLink to={`${base}/connect`} className="nav-link small">Connect an AI</NavLink>
          <NavLink to="/" className="chip gold" style={{ textDecoration: 'none' }}>{me?.account.display_name}</NavLink>
          <button type="button" className="btn small ghost" onClick={() => void signOut()}>Sign out</button>
        </span>
      </header>
      <main><Outlet /></main>
      <nav className="bottomnav" aria-label="Scribe (phone)">
        {LINKS.filter(([to]) => MOBILE.includes(to)).map(([to, label, icon]) => (
          <NavLink key={to} to={`${base}/${to}`} end={to === ''}><span className="icon" aria-hidden="true">{icon}</span>{label.replace('● ', '')}</NavLink>
        ))}
      </nav>
      <QuickPrompt />
    </div>
  );
}
