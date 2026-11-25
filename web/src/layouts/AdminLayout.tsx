// The library admin shell. It signs in with an admin session (/admin/login),
// kept apart from the table session. A table session is used only while the
// server still allows it (one account, or ALX_ADMIN_TABLE_LOGIN=1).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AlexandriaClient } from '@alx/client';
import { AuthScope, useAuth, type Me } from '../lib/auth.tsx';
import { OfflineBanner } from '../ui/index.tsx';
import AdminLogin from '../features/adminauth/Login.tsx';
import { setAdminToken, useAdminToken } from '../features/adminauth/session.ts';
import AdminSearchBox from '../features/gateway/SearchBox.tsx';
import JobsBar from '../features/gateway/JobsBar.tsx';

import '../admin.css';
import { useAdminTheme, type AdminTheme } from './adminTheme.ts';
import { Icon } from '../pages/admin/kit.tsx';
import { AdminMenu } from './AdminMenu.tsx';

type Mode = { kind: 'admin' | 'table'; me: Me };

export function AdminLayout() {
  const table = useAuth();
  const token = useAdminToken();
  const loc = useLocation();
  const nav = useNavigate();
  const adminClient = useMemo(() => new AlexandriaClient({ baseUrl: window.location.origin, token }), [token]);
  const [mode, setMode] = useState<Mode | null | undefined>(undefined); // undefined: checking
  const [menu, setMenu] = useState(false); // the phone menu
  const [theme, setTheme] = useAdminTheme();
  const [release, setRelease] = useState('');
  useEffect(() => { fetch('/health').then((r) => r.json()).then((h) => setRelease(h.release ? `${h.release} (${h.version})` : h.version ?? '')).catch(() => {}); }, []);

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
    <div className="t-admin shell adm">
      <nav className={`side${menu ? ' open' : ''}`} aria-label="Admin">
        <div className="adm-brand">
          <Icon name="brand" size={28} color="#7FD1C7" />
          <div className="adm-brand-text"><span className="name">Alexandria</span><span className="sub">Admin{window.location.port ? ` · :${window.location.port}` : ''}</span></div>
          <button type="button" className="adm-menu-btn" aria-expanded={menu} aria-controls="adm-nav" onClick={() => setMenu(!menu)}>{menu ? 'Close' : 'Menu'}</button>
        </div>
        <div className="adm-nav" id="adm-nav">
          <AdminMenu onNavigate={() => setMenu(false)} />
          <div className="side-foot">
            <NavLink to="/" className="nav-link"><Icon name="back" />Your worlds</NavLink>
            <div className="adm-theme" role="group" aria-label="Theme">
              {(['light', 'dark', 'system'] as AdminTheme[]).map((t) => <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>{t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}</button>)}
            </div>
            {release && <span className="tiny adm-who" data-testid="release">Alexandria {release}</span>}
            <span className="tiny adm-who">Signed in as {mode.me.account.username}{mode.kind === 'admin' ? ' (admin session)' : ''}</span>
            <button type="button" className="btn small" onClick={() => void (mode.kind === 'admin' ? signOutAdmin() : table.signOut())}>{mode.kind === 'admin' ? 'Sign out of admin' : 'Sign out'}</button>
          </div>
        </div>
      </nav>
      <main className="main"><AdminSearchBox /><OfflineBanner /><JobsBar /><Outlet /></main>
    </div>
  );
  if (mode.kind === 'table') return body;
  return <AuthScope client={adminClient} me={mode.me} signOut={signOutAdmin} refresh={check}>{body}</AuthScope>;
}
