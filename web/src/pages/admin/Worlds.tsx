import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead, useAction } from '../../ui/index.tsx';
import { when } from '../../lib/format.ts';
import { Pill } from './kit.tsx';
import { WorldCards, cardLine, type WorldCard } from './WorldCards.tsx';

export default function AdminWorlds() {
  const { client, me, refresh } = useAuth();
  const worlds = useLoad(() => client.request<any[]>('GET', '/api/admin/worlds'), []);
  const accounts = useLoad(() => client.request<any[]>('GET', '/api/admin/accounts'), []);
  const cards = useLoad(() => client.request<{ worlds: WorldCard[] }>('GET', '/api/admin/gateway/worlds'), []);
  const card = (id: string) => cards.data?.worlds.find((c) => c.id === id);
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const cur = (worlds.data ?? []).find((w) => w.id === sel) ?? null;

  return (
    <div className="page">
      <PageHead title="Worlds" lead="Each world has its own library, sources, table and settings. Make one, then pick its DM. The DM invites players from inside the world.">
        <Link className="btn primary" to="/admin/worlds/setup">Set up a world</Link>
        <button type="button" className="btn" onClick={() => setCreating(true)}>New empty world</button>
      </PageHead>
      <ErrorBox error={worlds.error} />
      <div className="cols">
        <div className="col-1">
          {worlds.loading && !worlds.data ? <Loading /> : (
            <div className="adm-world-list">
              {(worlds.data ?? []).map((w) => (
                <button key={w.id} type="button" className={`list-item${w.id === sel ? ' active' : ''}`} aria-current={(w.id === sel) || undefined} onClick={() => setSel(w.id)}>
                  <span className="grow"><strong>{w.name}</strong><br /><span className="tiny muted mono">{w.slug}</span></span>
                  <span className="tiny muted" style={{ textAlign: 'right' }}>{w.pages.toLocaleString()} pages<br />{w.sources} source{w.sources === 1 ? '' : 's'} · {w.members} people{card(w.id) && <><br />{cardLine(card(w.id))}</>}</span>
                </button>
              ))}
              {!worlds.data?.length && <Empty>No worlds yet.</Empty>}
            </div>
          )}
        </div>
        <div className="col-2">{cur ? <WorldMembers world={cur} card={card(cur.id)} accounts={accounts.data ?? []} onChange={() => { void worlds.reload(); void cards.reload(); void refresh(); }} /> : <div className="card"><p className="muted">Pick a world to see its sources and who is in it.</p></div>}</div>
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

function WorldMembers({ world, card, accounts, onChange }: { world: any; card?: WorldCard; accounts: any[]; onChange: () => void }) {
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
        <span className="row">
          <Link className="btn small" to={`/admin/worlds/${world.id}`}>Sources, crawl and index</Link>
          {iAmIn && <Link className="btn small" to={iAmIn.role === 'dm' ? `/w/${world.slug}/dm` : `/w/${world.slug}`}>Open</Link>}
        </span>
      </div>
      <ErrorBox error={a.error || members.error} />
      <WorldSources world={world} />
      {card && <WorldCards world={world} card={card} onChange={onChange} />}
      <h3>People</h3>
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
      <div className="row between"><span className="small muted">This world's sources, audience and crawl are on <Link to={`/admin/worlds/${world.id}`}>its page</Link>; the accounts they use are in <Link to="/admin/connections">Connections</Link>.</span><button type="button" className="btn small danger" onClick={del}>Delete world</button></div>
    </div>
  );
}

/** What feeds this world's library: each source with its connection, who it is for and how its last sync went. */
function WorldSources({ world }: { world: any }) {
  const { client } = useAuth();
  const ov = useLoad(() => client.request<any>('GET', `/api/admin/worlds/${world.id}/overview`), [world.id]);
  const d = ov.data;
  if (!d) return ov.error ? <ErrorBox error={ov.error} /> : null;
  return (
    <div className="stack">
      <div className="row wrap" aria-label="Pages by level">
        {([['party', 'Party', 'teal'], ['broker', 'Broker', 'gold'], ['dm', 'DM only', 'red'], ['classified', 'Classified', 'red']] as const).map(([k, label, tone]) => <span key={k} className={`chip ${tone}`}>{label}: <strong>{d.levels[k]}</strong></span>)}
      </div>
      <h3>Sources</h3>
      {d.sources.length ? (
        <div className="adm-table-wrap"><div className="scroll-x"><table className="table">
          <thead><tr><th>Source</th><th>Connection</th><th>Audience</th><th className="num">Pages</th><th>Last sync</th></tr></thead>
          <tbody>{d.sources.map((s: any) => (
            <tr key={s.id}>
              <td><strong>{s.name}</strong><span className="tiny muted">{s.connector?.label ?? s.kind}</span></td>
              <td>{s.connection?.name ?? <span className="faint">own settings</span>}</td>
              <td><Pill tone={s.audience === 'dm' ? 'bad' : s.audience === 'party' ? 'teal' : ''}>{s.audience_label}</Pill></td>
              <td className="num">{s.pages.toLocaleString()}</td>
              <td className="small">{s.last_sync_at ? when(s.last_sync_at) : <span className="faint">never</span>} {s.last_status && <Pill tone={s.last_status === 'ok' ? 'ok' : s.last_status === 'error' ? 'bad' : ''}>{s.last_status}</Pill>}</td>
            </tr>
          ))}</tbody>
        </table></div></div>
      ) : <p className="muted small">No sources yet. Open <Link to={`/admin/worlds/${world.id}`}>the world's page</Link> to add one.</p>}
    </div>
  );
}
