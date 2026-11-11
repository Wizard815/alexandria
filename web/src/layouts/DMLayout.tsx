import { NavLink, Outlet, Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.tsx';
import { useWorld, useLoad } from '../lib/world.tsx';

const GROUPS: [string, [string, string][]][] = [
  ['At the table', [['', '✦ The table'], ['combat', '⚔ Combat'], ['quick', '⚡ Quick events'], ['party', '♟ Party & inventory'], ['approvals', '✓ Approvals'], ['broker', '⚖ Information broker']]],
  ['The world', [['library', '❧ Library'], ['people', '☺ People'], ['relations', '⚭ Relations'], ['map', '✧ Map'], ['requests', '✎ Requests'], ['messages', '✉ Messages'], ['calendar', '▦ Session calendar'], ['whiteboard', '▤ Whiteboard']]],
  ['Setup', [['settings', '⚙ World settings'], ['connect', '⌁ Connect an AI']]],
];

export function DMLayout() {
  const { info, isDM, w, connected } = useWorld();
  const { me, signOut } = useAuth();
  const requests = useLoad(() => w.requests(), [w], ['request']);
  const approvals = useLoad(() => (isDM ? w.call<any>('GET', '/approvals') : Promise.resolve(null)), [w, isDM], ['approval', 'coin', 'item', 'item-removed']);
  if (!isDM) return <Navigate to={`/w/${info.slug}`} replace />;
  const open = (requests.data ?? []).filter((r: any) => r.status === 'open').length;
  const c = approvals.data?.counts;
  const pending = c ? c.coin + c.items + c.disputes : 0;
  return (
    <div className="t-fantasy shell">
      <nav className="side" aria-label="DM">
        <div className="stack tight"><span className="brand">Alexandria</span><span className="sub">Dungeon Master · {info.name}</span></div>
        {GROUPS.map(([label, links]) => (
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
      <main className="main"><Outlet /></main>
    </div>
  );
}
