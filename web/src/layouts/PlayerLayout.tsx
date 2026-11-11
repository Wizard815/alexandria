import { NavLink, Outlet, Navigate, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth.tsx';
import { useWorld, useLoad } from '../lib/world.tsx';
import QuickPrompt from '../pages/player/QuickPrompt.tsx';
import { OfflineBanner } from '../ui/index.tsx';

const LINKS: [string, string, string][] = [
  ['', 'Home', '⌂'], ['live', '● Live', '●'], ['library', 'Library', '❧'], ['broker', 'Broker', '⚖'], ['people', 'People', '☺'], ['me', 'Me', '✦'],
  ['inventory', 'Inventory', '♟'], ['map', 'Map', '✧'], ['messages', 'Messages', '✉'], ['calendar', 'Calendar', '▦'],
  ['ask', 'Ask the DM', '?'], ['whiteboard', 'Whiteboard', '▤'],
];
const MOBILE = ['', 'live', 'library', 'broker', 'me'];

export function PlayerLayout() {
  const { info, isDM, connected, w } = useWorld();
  const { me, signOut } = useAuth();
  // Broker offers waiting for this player: a badge on the Broker link.
  const brokerOn = !isDM && (info.settings as { brokerEnabled?: boolean }).brokerEnabled !== false;
  const offers = useLoad(() => (brokerOn ? w.call<{ status: string }[]>('GET', '/broker/offers') : Promise.resolve([])), [w, brokerOn], ['broker-offer']);
  const offerCount = (offers.data ?? []).filter((o) => o.status === 'open').length;
  const badge = (to: string) => (to === 'broker' && offerCount > 0 ? <span className="count" style={{ marginLeft: 4, padding: '0 6px', borderRadius: 999, background: 'var(--accent)', color: 'var(--on-accent)', fontSize: 11, fontWeight: 700, lineHeight: '16px' }} aria-label={`${offerCount} offer${offerCount === 1 ? '' : 's'} waiting`}>{offerCount}</span> : null);
  if (isDM) return <Navigate to={`/w/${info.slug}/dm`} replace />;
  const base = `/w/${info.slug}`;
  return (
    <div className="t-fantasy">
      <header className="topbar">
        <Link to={base} className="brand">{info.name}</Link>
        <nav className="topnav desktop" aria-label="Scribe">
          {LINKS.map(([to, label]) => <NavLink key={to} to={`${base}/${to}`} end={to === ''} className="nav-link">{label}{badge(to)}</NavLink>)}
        </nav>
        <span className="row" style={{ marginLeft: 'auto' }}>
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
          <NavLink key={to} to={`${base}/${to}`} end={to === ''}><span className="icon" aria-hidden="true">{icon}</span>{label.replace('● ', '')}{badge(to)}</NavLink>
        ))}
      </nav>
      <QuickPrompt />
    </div>
  );
}
