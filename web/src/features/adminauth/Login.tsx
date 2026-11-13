// /admin/login: gateway admin sign-in, separate from the table sign-in.
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { AlexandriaClient, AlexandriaError } from '@alx/client';
import { ErrorBox, Field, useAction } from '../../ui/index.tsx';
import { setAdminToken, useAdminToken } from './session.ts';

export default function AdminLogin() {
  const nav = useNavigate();
  const token = useAdminToken();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const a = useAction();
  if (token) return <Navigate to="/admin" replace />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      const c = new AlexandriaClient({ baseUrl: window.location.origin });
      try {
        const r = await c.request('POST', '/api/admin-auth/login', { username: u, password: p, ...(code ? { totp: code } : {}) });
        setAdminToken(r.token);
        nav('/admin');
      } catch (err) {
        // 428: the password was right and this account needs an authenticator code.
        if (err instanceof AlexandriaError && err.status === 428) { setNeedCode(true); return; }
        throw err;
      }
    });
  };
  return (
    <div className="t-admin" style={{ display: 'flex', justifyContent: 'center', padding: '8vh 16px' }}>
      <div className="stack loose" style={{ width: 'min(420px, 100%)' }}>
        <div className="stack tight" style={{ textAlign: 'center' }}>
          <span style={{ fontFamily: 'var(--font-head)', fontSize: 28, fontWeight: 700, color: 'var(--accent)' }}>Alexandria</span>
          <h1 style={{ fontSize: 22 }}>Library admin sign-in</h1>
          <p className="muted">For the person who runs this server. Playing or running a game? <Link to="/login">Sign in to the table</Link>.</p>
        </div>
        <form className="card stack" onSubmit={submit}>
          <Field label="Username"><input value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" required /></Field>
          <Field label="Password"><input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" required /></Field>
          {needCode && (
            <Field label="Authenticator code" help="6 digits from your authenticator app, or one of your recovery codes.">
              <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoFocus required />
            </Field>
          )}
          <ErrorBox error={a.error} />
          <button className="btn primary" disabled={a.busy}>{needCode ? 'Verify and sign in' : 'Sign in'}</button>
        </form>
      </div>
    </div>
  );
}
