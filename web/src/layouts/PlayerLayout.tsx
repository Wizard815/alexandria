import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, Navigate, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth.tsx';
import { useWorld, useLoad } from '../lib/world.tsx';
import { FALLBACK_GROUP, GROUPS, availableLinks, groupOf, loadPinned, savePinned, tabsFor } from '../lib/playerNav.ts';
import { useKeyboardInset } from '../lib/viewport.ts';
import { useNavSide, useTopHeight } from '../lib/navSide.tsx';
import QuickPrompt from '../pages/player/QuickPrompt.tsx';
import { OfflineBanner } from '../ui/index.tsx';
import './gmmenu.css';
import { MoreSheet } from './MoreSheet.tsx';
import * as F from '../features/registry.ts';
import { useTrades, waitingForMe } from '../features/sessionchat/TradeDialog.tsx';

export function PlayerLayout() {
  const { info, isGM, connected, w, me: meId } = useWorld();
  const { me, signOut } = useAuth();
  const [menu, setMenu] = useState(false);
  const [pinned, setPinned] = useState<string[] | null>(() => loadPinned(info.slug));
  const loc = useLocation();
  const kb = useKeyboardInset();
  const top = useRef<HTMLElement>(null);
  useTopHeight(top);
  useNavSide();
  useEffect(() => setMenu(false), [loc.pathname]);
  useEffect(() => setPinned(loadPinned(info.slug)), [info.slug]);
  const update = (next: string[] | null) => { setPinned(next); savePinned(info.slug, next); };
  // Broker offers waiting for this player: a badge on the Broker link.
  const brokerOn = !isGM && (info.settings as { brokerEnabled?: boolean }).brokerEnabled !== false;
  const offers = useLoad(() => (brokerOn ? w.call<{ status: string }[]>('GET', '/broker/offers') : Promise.resolve([])), [w, brokerOn], ['broker-offer']);
  const offerCount = (offers.data ?? []).filter((o) => o.status === 'open').length;
  // Trade offers waiting for this player: a badge on the Inventory link.
  const trades = useTrades();
  const tradeCount = waitingForMe(trades.data, meId);
  const counts: Record<string, [number, string]> = { broker: [offerCount, 'offer'], inventory: [tradeCount, 'trade offer'] };
  const badge = (to: string) => {
    const [n, what] = counts[to] ?? [0, ''];
    return n > 0 ? <span className="nav-badge" data-testid={`nav-badge-${to}`} aria-label={`${n} ${what}${n === 1 ? '' : 's'} waiting`}>{n}</span> : null;
  };
  // Badges for pages that are not on the bottom bar go on More.
  const hidden = (ids: string[]) => Object.keys(counts).filter((k) => !ids.includes(k)).reduce((n, k) => n + counts[k][0], 0);
  if (isGM) return <Navigate to={`/w/${info.slug}/gm`} replace />;
  const base = `/w/${info.slug}`;
  const links = availableLinks(info.settings);
  const tabIds = tabsFor(pinned, info.settings);
  const tabs = tabIds.map((id) => links.find((l) => l.to === id)!).filter(Boolean);
  const here = (to: string) => (to === '' ? loc.pathname === base || loc.pathname === `${base}/` : loc.pathname === `${base}/${to}` || loc.pathname.startsWith(`${base}/${to}/`));
  const moreActive = !tabs.some((t) => here(t.to));
  const current = links.find((l) => here(l.to));
  const area = current ? groupOf(current.to) : loc.pathname.startsWith(`${base}/connect`) ? 'Settings & account' : GROUPS[0];
  const areas = [...GROUPS, FALLBACK_GROUP].map((g) => ({ g, list: links.filter((l) => groupOf(l.to) === g) })).filter((a) => a.list.length);
  return (
    <div className="t-fantasy player">
      <header className="topbar" ref={top}>
        <Link to={base} className="brand">{info.name}</Link>
        {F.topbars.map((C, i) => <C key={i} />)}
        <span className="phone-only"><span className={`live-dot${connected ? '' : ' off'}`} title={connected ? 'Live updates on' : 'Reconnecting'} role="img" aria-label={connected ? 'Live updates on' : 'Reconnecting'} /></span>
        <nav className="pl-areas desktop-only" aria-label="Areas">
          {areas.map((a) => <Link key={a.g} to={`${base}/${a.list[0].to}`} className={`pl-area${a.g === area ? ' on' : ''}`} aria-current={a.g === area || undefined} title={a.list.map((l) => l.label).join(' · ')}>{a.g}</Link>)}
        </nav>
        <span className="row topbar-end desktop-only">
          <span className="tiny faint" title={connected ? 'Live updates on' : 'Reconnecting'}><span className={`live-dot${connected ? '' : ' off'}`} role="img" aria-label={connected ? 'Live updates on' : 'Reconnecting'} /></span>
          <NavLink to="/" className="chip gold" style={{ textDecoration: 'none' }}>{me?.account.display_name}</NavLink>
          <button type="button" className="btn small ghost" onClick={() => void signOut()}>Sign out</button>
        </span>
        <nav className="topnav desktop" aria-label="Scribe">
          {(areas.find((a) => a.g === area)?.list ?? []).map(({ to, label }) => <NavLink key={to} to={`${base}/${to}`} end={to === ''} className="nav-link">{label}{badge(to)}</NavLink>)}
          {area === 'Settings & account' && <NavLink to={`${base}/connect`} className="nav-link">Connect an AI</NavLink>}
        </nav>
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
          <span className="icon" aria-hidden="true"><i className="fa-solid fa-bars" />{hidden(tabIds) > 0 && <span className="nav-badge" data-testid="nav-badge-more" aria-label={`${hidden(tabIds)} waiting`}>{hidden(tabIds)}</span>}</span>More
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
