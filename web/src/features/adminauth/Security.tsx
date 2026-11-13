// Admin → Security: authenticator app (TOTP), recovery codes and the allowed networks.
import { useMemo, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { ErrorBox, Field, Loading, PageHead, useAction } from '../../ui/index.tsx';
import { qrSvg } from './qr.ts';

interface SecurityMe {
  via: string;
  totp: { enabled: boolean; recoveryCodesLeft: number };
  network: { restricted: boolean; ranges: string[]; yourIp: string; yourIpAllowed: boolean };
  tableLogin: boolean;
}

function Qr({ text }: { text: string }) {
  const svg = useMemo(() => { try { return qrSvg(text, 200); } catch { return null; } }, [text]);
  if (!svg) return null;
  // The markup is made here from modules, never from server text.
  return <div style={{ background: '#fff', padding: 4, width: 'fit-content', borderRadius: 6 }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="card stack">
      <h3>Recovery codes</h3>
      <p className="small">Save these now. Each works once, if you lose your authenticator app. They are not shown again.</p>
      <pre className="mono" style={{ margin: 0, columns: 2 }}>{codes.join('\n')}</pre>
      <div><button type="button" className="btn primary" onClick={onDone}>I have saved them</button></div>
    </div>
  );
}

export default function Security() {
  const { client } = useAuth();
  const info = useLoad(() => client.request<SecurityMe>('GET', '/api/admin-auth/me'), []);
  const a = useAction();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [off, setOff] = useState(false);
  const d = info.data;

  const start = () => void a.run(async () => { setSetup(await client.request('POST', '/api/admin-auth/totp/setup')); setCode(''); });
  const enable = () => void a.run(async () => {
    const r = await client.request('POST', '/api/admin-auth/totp/enable', { code });
    setSetup(null); setCode(''); setCodes(r.recoveryCodes);
    await info.reload();
  });
  const disable = () => void a.run(async () => {
    await client.request('POST', '/api/admin-auth/totp/disable', { code });
    setOff(false); setCode('');
    await info.reload();
  });
  const regenerate = () => void a.run(async () => {
    const r = await client.request('POST', '/api/admin-auth/totp/recovery', { code });
    setCode(''); setCodes(r.recoveryCodes);
    await info.reload();
  });

  return (
    <div className="page">
      <PageHead title="Security" lead="A second step for signing in as admin, and where admin access is allowed from." />
      <ErrorBox error={info.error ?? a.error} />
      {!d ? <Loading /> : (
        <div className="stack loose">
          {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}

          <section className="card stack">
            <h2>Authenticator app</h2>
            {d.totp.enabled ? (
              <>
                <p>On. Signing in at <span className="mono">/admin/login</span> needs a 6-digit code. Recovery codes left: <b>{d.totp.recoveryCodesLeft}</b>.</p>
                <p className="small muted">With this on, a table sign-in no longer opens the admin pages for this account. Admin keys still work.</p>
                <Field label="Current code" help="From your authenticator app. Needed to turn it off or to make new recovery codes.">
                  <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />
                </Field>
                <div className="row">
                  <button type="button" className="btn" disabled={a.busy || !code} onClick={regenerate}>New recovery codes</button>
                  <button type="button" className="btn danger" disabled={a.busy || !code} onClick={() => (off ? disable() : setOff(true))}>{off ? 'Confirm: turn it off' : 'Turn off'}</button>
                </div>
              </>
            ) : setup ? (
              <>
                <p className="small">Scan this with an authenticator app (or type the secret in), then enter the 6-digit code it shows.</p>
                <Qr text={setup.uri} />
                <Field label="Secret"><input readOnly value={setup.secret} className="mono" onFocus={(e) => e.currentTarget.select()} /></Field>
                <Field label="otpauth address"><input readOnly value={setup.uri} className="mono" onFocus={(e) => e.currentTarget.select()} /></Field>
                <Field label="Code"><input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" /></Field>
                <div className="row">
                  <button type="button" className="btn primary" disabled={a.busy || !code} onClick={enable}>Turn on</button>
                  <button type="button" className="btn" onClick={() => setSetup(null)}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <p className="muted">Off. Admin sign-in needs only the password.</p>
                <div><button type="button" className="btn primary" disabled={a.busy} onClick={start}>Set up an authenticator</button></div>
              </>
            )}
          </section>

          <section className="card stack">
            <h2>Allowed networks</h2>
            {d.network.restricted ? (
              <>
                <p>Admin sign-in and the admin pages work only from these ranges (<span className="mono">ALX_ADMIN_ALLOW</span>):</p>
                <p className="mono">{d.network.ranges.join('  ')}</p>
              </>
            ) : (
              <p className="muted">Not limited: admin works from any address. Set <span className="mono">ALX_ADMIN_ALLOW</span> to a list of ranges, such as <span className="mono">192.168.0.0/16,127.0.0.1/32,::1/128</span>, and restart.</p>
            )}
            <p className="small">Your address: <span className="mono">{d.network.yourIp}</span> {d.network.yourIpAllowed ? '(allowed)' : '(not in the list)'}</p>
          </section>

          <section className="card stack">
            <h2>Table sign-in on admin pages</h2>
            <p className="small">{d.tableLogin ? 'Allowed: this server has one account or ALX_ADMIN_TABLE_LOGIN=1, so a table sign-in can open the admin pages.' : 'Not allowed: admin pages need this admin sign-in or an admin key.'}</p>
          </section>
        </div>
      )}
    </div>
  );
}
