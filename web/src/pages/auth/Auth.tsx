// First-run setup, sign in, joining a world with an invite code, and
// resetting a password with a code from an admin.
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { ErrorBox, Field, useAction } from '../../ui/index.tsx';
import { McpCard, type McpConnection } from '../shared/McpCard.tsx';

function Frame({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <div className="t-fantasy" style={{ display: 'flex', justifyContent: 'center', padding: '8vh 16px' }}>
      <div className="stack loose" style={{ width: 'min(460px, 100%)' }}>
        <div className="stack tight" style={{ textAlign: 'center' }}>
          <span style={{ fontFamily: 'var(--font-head)', fontSize: 30, fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.08em' }}>Alexandria</span>
          <h1 style={{ fontSize: 22 }}>{title}</h1>
          {lead && <p className="muted">{lead}</p>}
        </div>
        <div className="card gold">{children}</div>
      </div>
    </div>
  );
}

export function Setup() {
  const { client, needsSetup, signIn, me } = useAuth();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const a = useAction();
  // Once setup is done (by this form or earlier), the admin goes to Worlds.
  if (!needsSetup) return <Navigate to={me?.account.is_admin ? '/admin/worlds' : '/'} replace />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      const r = await client.setup(u, p);
      await signIn(r.token);
    });
  };
  return (
    <Frame title="Set up the library" lead="This first account is the library admin. You can make worlds, add sources and invite your table next.">
      <form className="stack" onSubmit={submit}>
        <Field label="Username"><input value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" required /></Field>
        <Field label="Password" help="At least 10 characters."><input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="new-password" minLength={10} required /></Field>
        <ErrorBox error={a.error} />
        <button className="btn primary" disabled={a.busy}>Create the admin account</button>
      </form>
    </Frame>
  );
}

export function Login() {
  const { client, me, needsSetup, signIn } = useAuth();
  const nav = useNavigate();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const a = useAction();
  if (needsSetup) return <Navigate to="/setup" replace />;
  if (me) return <Navigate to="/" replace />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      const r = await client.login(u, p);
      await signIn(r.token);
      nav('/');
    });
  };
  return (
    <Frame title="Sign in">
      <form className="stack" onSubmit={submit}>
        <Field label="Username"><input value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" required /></Field>
        <Field label="Password"><input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" required /></Field>
        <ErrorBox error={a.error} />
        <button className="btn primary" disabled={a.busy}>Sign in</button>
        <div className="row between small"><Link to="/join">I have an invite code</Link><Link to="/reset">I have a reset code</Link></div>
      </form>
    </Frame>
  );
}

export function Join() {
  const { client, me, signIn } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get('code') ?? '');
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [character, setCharacter] = useState('');
  const [done, setDone] = useState<{ slug: string; mcp: McpConnection } | null>(null);
  const a = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      // Signed in already: the session joins; otherwise make an account.
      const r = await client.request('POST', '/api/join', me ? { code, characterName: character } : { code, username: u, password: p, characterName: character });
      await signIn(r.token);
      setDone({ slug: r.worldSlug ?? r.worldId, mcp: r.mcp });
    });
  };

  if (done) {
    return (
      <Frame title="You're in" lead="Welcome to the table. Your AI app can be connected right now. Nothing else to set up.">
        <McpCard mcp={done.mcp} />
        <button type="button" className="btn primary" onClick={() => nav(`/w/${done.slug}`)}>Open the world</button>
      </Frame>
    );
  }
  return (
    <Frame title="Join a world" lead="Use the invite code your DM gave you.">
      <form className="stack" onSubmit={submit}>
        <Field label="Invite code"><input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required /></Field>
        {me ? (
          <p className="small muted">Joining as {me.account.display_name}.</p>
        ) : (
          <>
            <Field label="Pick a username"><input value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" required /></Field>
            <Field label="Pick a password" help="At least 10 characters."><input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="new-password" minLength={10} required /></Field>
          </>
        )}
        <Field label="Character name" help="Optional. Shown to the table instead of your username."><input value={character} onChange={(e) => setCharacter(e.target.value)} /></Field>
        <ErrorBox error={a.error} />
        <button className="btn primary" disabled={a.busy}>Join</button>
        {!me && <p className="small"><Link to="/login">I already have an account</Link></p>}
      </form>
    </Frame>
  );
}

export function Reset() {
  const { client, signIn } = useAuth();
  const nav = useNavigate();
  const [u, setU] = useState('');
  const [code, setCode] = useState('');
  const [p, setP] = useState('');
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      const r = await client.resetPassword(u, code, p);
      await signIn(r.token);
      nav('/');
    });
  };
  return (
    <Frame title="Set a new password" lead="Ask the library admin for a reset code. It works once, for 24 hours.">
      <form className="stack" onSubmit={submit}>
        <Field label="Username"><input value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" required /></Field>
        <Field label="Reset code"><input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required /></Field>
        <Field label="New password" help="At least 10 characters."><input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="new-password" minLength={10} required /></Field>
        <ErrorBox error={a.error} />
        <button className="btn primary" disabled={a.busy}>Set password and sign in</button>
        <p className="small"><Link to="/login">Back to sign in</Link></p>
      </form>
    </Frame>
  );
}
