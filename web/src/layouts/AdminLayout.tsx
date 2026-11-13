import { NavLink, Outlet, Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.tsx';
import { OfflineBanner } from '../ui/index.tsx';
import * as F from '../features/registry.ts';

const LINKS: [string, string][] = [['', 'Overview'], ['accounts', 'Accounts'], ['worlds', 'Worlds'], ['sources', 'World sources'], ['keys', 'Keys & AI'], ['audit', 'Audit log'], ...F.adminNav.map((n) => [n.to, n.label] as [string, string])];

export function AdminLayout() {
  const { me, signOut } = useAuth();
  if (!me) return <Navigate to="/login" replace />;
  if (!me.account.is_admin) return <Navigate to="/" replace />;
  return (
    <div className="t-admin shell">
      <nav className="side" aria-label="Admin">
        <div className="stack tight"><span className="brand">Alexandria</span><span className="sub">Library admin</span></div>
        <div className="nav-group">
          {LINKS.map(([to, label]) => <NavLink key={to} to={`/admin/${to}`} end={to === ''} className="nav-link">{label}</NavLink>)}
        </div>
        <div className="side-foot">
          <NavLink to="/" className="nav-link">← Your worlds</NavLink>
          <span className="tiny" style={{ color: '#93A3AD' }}>Signed in as {me.account.username}</span>
          <button type="button" className="btn small" onClick={() => void signOut()}>Sign out</button>
        </div>
      </nav>
      <main className="main"><OfflineBanner /><Outlet /></main>
    </div>
  );
}
