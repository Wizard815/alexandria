import { useState, type FormEvent } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { ErrorBox, Field, Loading, Modal, PageHead, Switch, useAction } from '../../ui/index.tsx';

export default function AdminAccounts() {
  const { client, me } = useAuth();
  const list = useLoad(() => client.request<any[]>('GET', '/api/admin/accounts'), []);
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState<{ who: string; code: string } | null>(null);
  const a = useAction();

  const resetCode = (acc: any) => void a.run(async () => {
    const r = await client.request('POST', `/api/admin/accounts/${acc.id}/reset-code`);
    setCode({ who: acc.username, code: r.code });
  });
  const setAdmin = (acc: any, v: boolean) => void a.run(async () => { await client.request('PATCH', `/api/admin/accounts/${acc.id}`, { isAdmin: v }); await list.reload(); });
  const remove = (acc: any) => {
    if (!confirm(`Delete ${acc.username}? They lose access to every world.`)) return;
    void a.run(async () => { await client.request('DELETE', `/api/admin/accounts/${acc.id}`); await list.reload(); });
  };

  return (
    <div className="page">
      <PageHead title="Accounts" lead="Admin is an extra flag on an account. Roles in a world (DM, player, guest) are set on the Worlds page. Players usually make their own account with an invite code.">
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>Add account</button>
      </PageHead>
      <ErrorBox error={a.error || list.error} />
      {list.loading && !list.data ? <Loading /> : (
        <div className="card flush scroll-x">
          <table className="table">
            <thead><tr><th>Username</th><th>Name</th><th>Worlds</th><th>Admin</th><th /></tr></thead>
            <tbody>
              {(list.data ?? []).map((acc) => (
                <tr key={acc.id}>
                  <td className="mono">{acc.username}</td>
                  <td>{acc.display_name}</td>
                  <td className="small">{acc.worlds.filter((x: any) => x.world).map((x: any) => x.role).join(', ') || <span className="faint">none</span>}</td>
                  <td><Switch checked={acc.is_admin} onChange={(v) => setAdmin(acc, v)} label={`Admin: ${acc.username}`} /></td>
                  <td><div className="row end">
                    <button type="button" className="btn small" onClick={() => resetCode(acc)}>Reset code</button>
                    {acc.id !== me?.account.id && <button type="button" className="btn small danger" onClick={() => remove(acc)}>Delete</button>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {code && (
        <Modal title="Reset code" onClose={() => setCode(null)}>
          <p>Give this code to <strong>{code.who}</strong>. They enter it on the sign-in page under “I have a reset code”. It works once, for 24 hours.</p>
          <p className="mono" style={{ fontSize: 22, textAlign: 'center', padding: 12, border: '1px dashed var(--line-strong)', borderRadius: 8 }}>{code.code}</p>
        </Modal>
      )}
      {adding && <AddAccount onClose={() => setAdding(false)} onDone={(c) => { setAdding(false); void list.reload(); if (c) setCode(c); }} />}
    </div>
  );
}

function AddAccount({ onClose, onDone }: { onClose: () => void; onDone: (code: { who: string; code: string } | null) => void }) {
  const { client } = useAuth();
  const [u, setU] = useState('');
  const [name, setName] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      const r = await client.request('POST', '/api/admin/accounts', { username: u, displayName: name || undefined, isAdmin });
      onDone(r.resetCode ? { who: u, code: r.resetCode } : null);
    });
  };
  return (
    <Modal title="Add account" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Username"><input value={u} onChange={(e) => setU(e.target.value)} required /></Field>
        <Field label="Display name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <label className="row"><Switch checked={isAdmin} onChange={setIsAdmin} label="Library admin" /> Library admin</label>
        <p className="small muted">No password is set here. You get a one-time code; they use it to choose their own password.</p>
        <ErrorBox error={a.error} />
        <button className="btn primary" disabled={a.busy}>Add</button>
      </form>
    </Modal>
  );
}
