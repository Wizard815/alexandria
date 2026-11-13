// The library admin shell. It signs in with an admin session (/admin/login),
// kept apart from the table session. A table session is used only while the
// server still allows it (one account, or ALX_ADMIN_TABLE_LOGIN=1).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AlexandriaClient } from '@alx/client';
import { AuthScope, useAuth, type Me } from '../lib/auth.tsx';
import { OfflineBanner } from '../ui/index.tsx';
import * as F from '../features/registry.ts';
import AdminLogin from '../features/adminauth/Login.tsx';
import { setAdminToken, useAdminToken } from '../features/adminauth/session.ts';

const LINKS: [string, string][] = [['', 'Overview'], ['accounts', 'Accounts'], ['worlds', 'Worlds'], ['sources', 'World sources'], ['keys', 'Keys & AI'], ['audit', 'Audit log'], ...F.adminNav.map((n) => [n.to, n.label] as [string, string])];

type Mode = { kind: 'admin' | 'table'; me: Me };

export function AdminLayout() {
  const table = useAuth();
  const token = useAdminToken();
  const loc = useLocation();
  const nav = useNavigate();
  const adminClient = useMemo(() => new AlexandriaClient({ baseUrl: window.location.origin, token }), [token]);
  const [mode, setMode] = useState<Mode | null | undefined>(undefined); // undefined: checking

  const check = useCallback(async () => {
    const asMe = (r: any): Me => ({ account: { ...r.account, is_admin: true }, theme: null, worlds: [] });
    try {
      if (token) {
        setMode({ kind: 'admin', me: asMe(await adminClient.request('GET', '/api/admin-auth/me')) });
        return;
      }
      if (table.me?.account.is_admin) {
        setMode({ kind: 'table', me: asMe(await table.client.request('GET', '/api/admin-auth/me')) });
        return;
      }
      setMode(null);
    } catch (e: any) {
      // A dead admin session is forgotten; a refused table session means "sign in at /admin/login".
      if (token && (e?.status === 401 || e?.status === 403)) setAdminToken(null);
      setMode(null);
    }
  }, [token, adminClient, table.client, table.me]);

  useEffect(() => { void check(); }, [check]);

  const signOutAdmin = useCallback(async () => {
    try { await adminClient.request('POST', '/api/admin-auth/logout'); } catch { /* already gone */ }
    setAdminToken(null);
    nav('/admin/login');
  }, [adminClient, nav]);

  if (loc.pathname === '/admin/login') return <AdminLogin />;
  if (!table.ready || mode === undefined) return <div className="t-admin"><div className="page"><p className="muted">Opening the library admin…</p></div></div>;
  if (!mode) return <Navigate to="/admin/login" replace />;

  const body = (
    <div className="t-admin shell">
      <nav className="side" aria-label="Admin">
        <div className="stack tight"><span className="brand">Alexandria</span><span className="sub">Library admin</span></div>
        <div className="nav-group">
          {LINKS.map(([to, label]) => <NavLink key={to} to={`/admin/${to}`} end={to === ''} className="nav-link">{label}</NavLink>)}
        </div>
        <div className="side-foot">
          <NavLink to="/" className="nav-link">← Your worlds</NavLink>
          <span className="tiny" style={{ color: '#93A3AD' }}>Signed in as {mode.me.account.username}{mode.kind === 'admin' ? ' (admin session)' : ''}</span>
          <button type="button" className="btn small" onClick={() => void (mode.kind === 'admin' ? signOutAdmin() : table.signOut())}>{mode.kind === 'admin' ? 'Sign out of admin' : 'Sign out'}</button>
        </div>
      </nav>
      <main className="main"><OfflineBanner /><Outlet /></main>
    </div>
  );
  if (mode.kind === 'table') return body;
  return <AuthScope client={adminClient} me={mode.me} signOut={signOutAdmin} refresh={check}>{body}</AuthScope>;
}
