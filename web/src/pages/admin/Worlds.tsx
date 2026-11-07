import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead, useAction } from '../../ui/index.tsx';

export default function AdminWorlds() {
  const { client, me, refresh } = useAuth();
  const worlds = useLoad(() => client.request<any[]>('GET', '/api/admin/worlds'), []);
  const accounts = useLoad(() => client.request<any[]>('GET', '/api/admin/accounts'), []);
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const cur = (worlds.data ?? []).find((w) => w.id === sel) ?? null;

  return (
    <div className="page">
      <PageHead title="Worlds" lead="Each world has its own library, sources, table and settings. Make one, then pick its DM. The DM invites players from inside the world.">
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>New world</button>
      </PageHead>
      <ErrorBox error={worlds.error} />
      <div className="cols">
        <div className="col-1 card flush">
          {worlds.loading && !worlds.data ? <div style={{ padding: 16 }}><Loading /></div> : (
            <div className="list">
              {(worlds.data ?? []).map((w) => (
                <button key={w.id} type="button" className={`list-item${w.id === sel ? ' active' : ''}`} onClick={() => setSel(w.id)}>
                  <span className="grow"><strong>{w.name}</strong><br /><span className="tiny muted mono">{w.slug}</span></span>
                  <span className="tiny muted">{w.members} people · {w.pages} pages</span>
                </button>
              ))}
              {!worlds.data?.length && <Empty>No worlds yet.</Empty>}
            </div>
          )}
        </div>
        <div className="col-2">{cur ? <WorldMembers world={cur} accounts={accounts.data ?? []} onChange={() => { void worlds.reload(); void refresh(); }} /> : <div className="card"><p className="muted">Pick a world to see who is in it.</p></div>}</div>
      </div>
      {creating && <NewWorld accounts={accounts.data ?? []} meId={me!.account.id} onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); setSel(id); void worlds.reload(); void refresh(); }} />}
    </div>
  );
}

function NewWorld({ accounts, meId, onClose, onDone }: { accounts: any[]; meId: string; onClose: () => void; onDone: (id: string) => void }) {
  const { client } = useAuth();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [dm, setDm] = useState(meId);
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => onDone((await client.request('POST', '/api/admin/worlds', { name, slug: slug || undefined, dmAccountId: dm })).id));
  };
  return (
    <Modal title="New world" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label="Short name for links" help="Lowercase letters, numbers and dashes. Left empty, it is made from the name."><input value={slug} onChange={(e) => setSlug(e.target.value)} className="mono" /></Field>
        <Field label="Dungeon Master"><select value={dm} onChange={(e) => setDm(e.target.value)}>{accounts.map((acc) => <option key={acc.id} value={acc.id}>{acc.display_name} ({acc.username})</option>)}</select></Field>
        <ErrorBox error={a.error} />
        <button className="btn primary" disabled={a.busy}>Create world</button>
      </form>
    </Modal>
  );
}

function WorldMembers({ world, accounts, onChange }: { world: any; accounts: any[]; onChange: () => void }) {
  const { client, me } = useAuth();
  const members = useLoad(() => client.request<any[]>('GET', `/api/admin/worlds/${world.id}/members`), [world.id]);
  const [add, setAdd] = useState('');
  const [role, setRole] = useState('player');
  const a = useAction();
  const setMember = (id: string, r: string) => void a.run(async () => { await client.request('PUT', `/api/admin/worlds/${world.id}/members/${id}`, { role: r }); await members.reload(); onChange(); });
  const remove = (m: any) => {
    if (!confirm(`Remove ${m.display_name} from ${world.name}? Their keys for this world stop working.`)) return;
    void a.run(async () => { await client.request('DELETE', `/api/admin/worlds/${world.id}/members/${m.id}`); await members.reload(); onChange(); });
  };
  const del = () => {
    if (prompt(`Type the world's short name (${world.slug}) to delete it and everything in it.`) !== world.slug) return;
    void a.run(async () => { await client.request('DELETE', `/api/admin/worlds/${world.id}`, { confirm: true }); onChange(); });
  };
  const outside = accounts.filter((acc) => !(members.data ?? []).some((m) => m.id === acc.id));
  const iAmIn = (members.data ?? []).find((m) => m.id === me?.account.id);
  return (
    <div className="card">
      <div className="card-head">
        <h2>{world.name}</h2>
        {iAmIn && <Link className="btn small" to={iAmIn.role === 'dm' ? `/w/${world.slug}/dm` : `/w/${world.slug}`}>Open</Link>}
      </div>
      <ErrorBox error={a.error || members.error} />
      <div className="scroll-x"><table className="table">
        <thead><tr><th>Person</th><th>Character</th><th>Role</th><th /></tr></thead>
        <tbody>{(members.data ?? []).map((m) => (
          <tr key={m.id}>
            <td>{m.display_name} <span className="tiny muted mono">{m.username}</span></td>
            <td>{m.character_name ?? <span className="faint">—</span>}</td>
            <td><select className="input" value={m.role} onChange={(e) => setMember(m.id, e.target.value)} aria-label={`Role for ${m.display_name}`}><option value="dm">DM</option><option value="player">Player</option><option value="guest">Guest</option></select></td>
            <td><button type="button" className="btn small danger" onClick={() => remove(m)}>Remove</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      {outside.length > 0 && (
        <div className="row">
          <select className="input" style={{ maxWidth: 260 }} value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Account to add"><option value="">Add someone…</option>{outside.map((acc) => <option key={acc.id} value={acc.id}>{acc.display_name} ({acc.username})</option>)}</select>
          <select className="input" style={{ maxWidth: 140 }} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role"><option value="player">Player</option><option value="dm">DM</option><option value="guest">Guest</option></select>
          <button type="button" className="btn" disabled={!add || a.busy} onClick={() => { setMember(add, role); setAdd(''); }}>Add</button>
        </div>
      )}
      <hr />
      <div className="row between"><span className="small muted">Sources for this world are on the <Link to="/admin/sources">World sources</Link> page.</span><button type="button" className="btn small danger" onClick={del}>Delete world</button></div>
    </div>
  );
}
