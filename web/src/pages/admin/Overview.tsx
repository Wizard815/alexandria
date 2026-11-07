import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { ErrorBox, Loading, PageHead } from '../../ui/index.tsx';
import { when } from '../../lib/format.ts';

export default function AdminOverview() {
  const { client } = useAuth();
  const o = useLoad(() => client.request('GET', '/api/admin/overview'), []);
  const d = o.data;
  return (
    <div className="page">
      <PageHead title="Overview" lead="The library behind every world: accounts, worlds and where their pages come from. Being an admin does not open a world's secrets; you need to be its DM." />
      <ErrorBox error={o.error} />
      {o.loading && !d ? <Loading /> : d && (
        <>
          <div className="grid small">
            <div className="stat"><b>{d.accounts}</b><span className="small muted">accounts</span></div>
            <div className="stat"><b>{d.worlds}</b><span className="small muted">worlds</span></div>
            <div className="stat"><b>{d.sources.length}</b><span className="small muted">sources</span></div>
            <div className="stat"><b>{d.liveConnections}</b><span className="small muted">live connections</span></div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Sources</h2><Link to="/admin/sources">Manage</Link></div>
            {d.sources.length ? (
              <div className="scroll-x"><table className="table"><thead><tr><th>Source</th><th>World</th><th>Last sync</th><th>Status</th></tr></thead>
                <tbody>{d.sources.map((s: any) => <tr key={s.id}><td>{s.name} <span className="chip">{s.kind}</span></td><td>{s.world}</td><td>{when(s.last_sync_at) || 'never'}</td><td className={String(s.last_status).startsWith('error') ? '' : 'muted'} style={String(s.last_status).startsWith('error') ? { color: 'var(--danger-text)' } : undefined}>{s.last_status ?? '—'}</td></tr>)}</tbody></table></div>
            ) : <p className="muted">No sources yet. <Link to="/admin/sources">Add one</Link> to fill a world's library.</p>}
          </div>
          <div className="row"><Link className="btn" to="/admin/worlds">Worlds</Link><Link className="btn" to="/admin/accounts">Accounts</Link><Link className="btn" to="/admin/keys">Keys & AI</Link></div>
        </>
      )}
    </div>
  );
}
