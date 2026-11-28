import { useEffect, useRef, useState } from 'react';
import { Outlet, Navigate, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth.tsx';
import { useWorld, useLoad } from '../lib/world.tsx';
import { OfflineBanner } from '../ui/index.tsx';
import * as F from '../features/registry.ts';
import { OPEN_EVENT } from '../features/search/SearchBox.tsx';
import { ShareHost, openShare } from '../features/sourcekeys/ShareButton.tsx';
import { setWorkspaceHidden, workspaceHidden } from '../lib/workspace.ts';
import { GMRail, GMTabs } from './GMMenu.tsx';
import { SessionButton } from './SessionButton.tsx';

// Search has its own wide box in this bar, so its small button is left out.
const TOPBARS = F.FEATURES.filter((f) => f.topbar && f.id !== 'search').map((f) => f.topbar!);

export function GMLayout() {
  const { info, isGM, w, connected } = useWorld();
  const inWorkspace = /\/gm\/ws\/?$/.test(useLocation().pathname);
  const requests = useLoad(() => w.requests(), [w], ['request']);
  const approvals = useLoad(() => (isGM ? w.call<any>('GET', '/approvals') : Promise.resolve(null)), [w, isGM], ['approval', 'coin', 'item', 'item-removed']);
  if (!isGM) return <Navigate to={`/w/${info.slug}`} replace />;
  const base = `/w/${info.slug}/gm`;
  const open = (requests.data ?? []).filter((r: any) => r.status === 'open').length;
  const c = approvals.data?.counts;
  const waiting = open + (c ? c.coin + c.items + c.disputes : 0);
  const badges = { inbox: waiting };
  return (
    <div className="t-fantasy gmx">
      <header className="dmx-top">
        <AccountMenu connected={connected} />
        <SessionButton />
        <button type="button" className="dmx-search" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))} aria-keyshortcuts="/" data-testid="menu-find">
          <i className="fa-solid fa-magnifying-glass" aria-hidden="true" /><span>Find any page, person or setting</span><kbd aria-hidden="true">/</kbd>
        </button>
        <span className="dmx-end">
          {TOPBARS.map((C, i) => <C key={i} />)}
          <button type="button" className="btn small" onClick={() => openShare()} data-testid="share-open"><i className="fa-solid fa-share-nodes" aria-hidden="true" /> <span>Share</span></button>
          <Link to={`${base}/inbox`} className="icon-btn" aria-label={waiting ? `Inbox, ${waiting} waiting` : 'Inbox'} title="Inbox"><i className="fa-solid fa-inbox" aria-hidden="true" />{waiting > 0 && <span className="nav-badge">{waiting}</span>}</Link>
        </span>
      </header>
      <div className="dmx-body">
        <GMRail base={base} badges={badges} />
        <div className="dmx-col">
          <GMTabs base={base} badges={badges} />
          {F.gmBands.map((C, i) => <C key={i} />)}
          <main className={`main${inWorkspace ? ' main-ws' : ''}`}><OfflineBanner /><Outlet /></main>
        </div>
      </div>
      <ShareHost />
      {F.overlays.map((C, i) => <C key={i} />)}
    </div>
  );
}

/** The world's name: other worlds, library admin, sign out. */
function AccountMenu({ connected }: { connected: boolean }) {
  const { info } = useWorld();
  const { me, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const out = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', out); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="dmx-pop-wrap" ref={box}>
      <button type="button" className="dmx-brand" aria-haspopup="menu" aria-expanded={open} aria-label={`${info.name}: worlds and account`} onClick={() => setOpen((o) => !o)}>
        <span className={`live-dot${connected ? '' : ' off'}`} title={connected ? 'Live' : 'Reconnecting…'} /><span>{info.name}</span><i className="fa-solid fa-chevron-down" aria-hidden="true" />
      </button>
      {open && (
        <div className="dmx-pop dmx-menu" role="menu">
          <span className="tiny faint">{me?.account.display_name} · Game Master · {connected ? 'live' : 'reconnecting…'}</span>
          <Link role="menuitem" to="/">Your worlds</Link>
          {me?.account.is_admin && <Link role="menuitem" to="/admin">Library admin</Link>}
          <button type="button" role="menuitem" data-testid="ws-toggle" onClick={() => { setWorkspaceHidden(!workspaceHidden()); setOpen(false); }}>{workspaceHidden() ? 'Show workspaces' : 'Hide workspaces'}</button>
          <button type="button" role="menuitem" onClick={() => void signOut()}>Sign out</button>
        </div>
      )}
    </div>
  );
}
