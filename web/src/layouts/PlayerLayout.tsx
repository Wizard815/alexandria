import { useEffect, useState } from 'react';
import { NavLink, Outlet, Navigate, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth.tsx';
import { useWorld, useLoad } from '../lib/world.tsx';
import { availableLinks, loadPinned, savePinned, tabsFor } from '../lib/playerNav.ts';
import { useKeyboardInset } from '../lib/viewport.ts';
import QuickPrompt from '../pages/player/QuickPrompt.tsx';
import { OfflineBanner } from '../ui/index.tsx';
import { MoreSheet } from './MoreSheet.tsx';
import * as F from '../features/registry.ts';

export function PlayerLayout() {
  const { info, isDM, connected, w } = useWorld();
  const { me, signOut } = useAuth();
  const [menu, setMenu] = useState(false);
  const [pinned, setPinned] = useState<string[] | null>(() => loadPinned(info.slug));
  const loc = useLocation();
  const kb = useKeyboardInset();
  useEffect(() => setMenu(false), [loc.pathname]);
  useEffect(() => setPinned(loadPinned(info.slug)), [info.slug]);
  const update = (next: string[] | null) => { setPinned(next); savePinned(info.slug, next); };
  // Broker offers waiting for this player: a badge on the Broker link.
  const brokerOn = !isDM && (info.settings as { brokerEnabled?: boolean }).brokerEnabled !== false;
  const offers = useLoad(() => (brokerOn ? w.call<{ status: string }[]>('GET', '/broker/offers') : Promise.resolve([])), [w, brokerOn], ['broker-offer']);
  const offerCount = (offers.data ?? []).filter((o) => o.status === 'open').length;
  const badge = (to: string) => (to === 'broker' && offerCount > 0 ? <span className="nav-badge" aria-label={`${offerCount} offer${offerCount === 1 ? '' : 's'} waiting`}>{offerCount}</span> : null);
  if (isDM) return <Navigate to={`/w/${info.slug}/dm`} replace />;
  const base = `/w/${info.slug}`;
  const links = availableLinks(info.settings);
  const tabIds = tabsFor(pinned, info.settings);
  const tabs = tabIds.map((id) => links.find((l) => l.to === id)!).filter(Boolean);
  const here = (to: string) => (to === '' ? loc.pathname === base || loc.pathname === `${base}/` : loc.pathname === `${base}/${to}` || loc.pathname.startsWith(`${base}/${to}/`));
  const moreActive = !tabs.some((t) => here(t.to));
  return (
    <div className="t-fantasy player">
      <header className="topbar">
        <Link to={base} className="brand">{info.name}</Link>
        {F.topbars.map((C, i) => <C key={i} />)}
        <span className={`live-dot${connected ? '' : ' off'} phone-only`} title={connected ? 'Live updates on' : 'Reconnecting'} role="img" aria-label={connected ? 'Live updates on' : 'Reconnecting'} />
        <nav className="topnav desktop" aria-label="Scribe">
          {links.map(({ to, label }) => <NavLink key={to} to={`${base}/${to}`} end={to === ''} className="nav-link">{label}{badge(to)}</NavLink>)}
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
      <nav className={`bottomnav${kb > 120 ? ' kb-open' : ''}`} aria-label="Scribe (phone)" data-testid="tabbar">
        {tabs.map(({ to, label, icon }) => (
          <NavLink key={to} to={`${base}/${to}`} end={to === ''} data-tab={to}>
            <span className="icon" aria-hidden="true"><i className={`fa-solid ${icon}`} />{badge(to)}</span>{label === 'Assistant' ? 'Ask' : label}
          </NavLink>
        ))}
        <button type="button" className={moreActive ? 'active' : ''} aria-haspopup="dialog" aria-expanded={menu} onClick={() => setMenu((m) => !m)} data-testid="more-btn">
          <span className="icon" aria-hidden="true"><i className="fa-solid fa-bars" />{!tabs.some((t) => t.to === 'broker') && badge('broker')}</span>More
        </button>
      </nav>
      {menu && (
        <MoreSheet base={base} links={links} tabIds={tabIds} isDefault={!pinned} badge={badge} name={me?.account.display_name ?? ''}
          onPins={update} onClose={() => setMenu(false)} onSignOut={() => void signOut()} />
      )}
      <QuickPrompt />
      {F.overlays.map((C, i) => <C key={i} />)}
    </div>
  );
}
