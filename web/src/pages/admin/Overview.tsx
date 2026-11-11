import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { ErrorBox, Loading, PageHead, useAction } from '../../ui/index.tsx';
import { when } from '../../lib/format.ts';

const STATUS: Record<string, string> = { ok: 'green', error: 'red', stopped: '', running: 'teal' };

export default function AdminOverview() {
  const { client } = useAuth();
  const o = useLoad(() => client.request('GET', '/api/admin/overview'), []);
  const backup = useAction();
  const d = o.data;

  const download = () => void backup.run(async () => {
    const r = await fetch('/api/admin/backup', { headers: { Authorization: `Bearer ${client.token}` } });
    if (!r.ok) throw new Error(`Backup failed (${r.status})`);
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `alexandria-${new Date().toISOString().slice(0, 10)}.db`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });

  return (
    <div className="page">
      <PageHead title="Overview" lead="The library behind every world: accounts, worlds and where their pages come from. Being an admin does not open a world's secrets; you need to be its DM.">
        <button type="button" className="btn" onClick={download} disabled={backup.busy}>{backup.busy ? 'Preparing…' : 'Download backup'}</button>
      </PageHead>
      <ErrorBox error={o.error || backup.error} />
      {o.loading && !d ? <Loading /> : d && (
        <>
          <div className="grid small">
            <div className="stat"><b>{d.accounts}</b><span className="small muted">accounts</span></div>
            <div className="stat"><b>{d.worlds}</b><span className="small muted">worlds</span></div>
            <div className="stat"><b>{d.pages}</b><span className="small muted">library pages</span></div>
            <div className="stat"><b>{d.sources.length}</b><span className="small muted">sources</span></div>
            <div className="stat"><b>{d.liveConnections}</b><span className="small muted">live connections</span></div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Recent syncs</h2><Link to="/admin/sources">World sources</Link></div>
            {d.runs.length ? (
              <div className="scroll-x"><table className="table">
                <thead><tr><th>Source</th><th>World</th><th>Started</th><th>Status</th><th>Pages</th></tr></thead>
                <tbody>{d.runs.map((r: any) => (
                  <tr key={r.id}>
                    <td>{r.source}</td><td>{r.world}</td><td className="small">{when(r.started_at)}</td>
                    <td><span className={`chip ${STATUS[r.status] ?? ''}`}>{r.status}</span>{r.error && <div className="tiny" style={{ color: 'var(--danger-text)' }}>{r.error}</div>}</td>
                    <td className="small">{r.stats.pages ?? 0} · {r.stats.shared ?? 0} shared · {r.stats.dmOnly ?? 0} DM-only{r.stats.removed ? ` · ${r.stats.removed} removed` : ''}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            ) : <p className="muted">No syncs yet. <Link to="/admin/sources">Add a source</Link> to fill a world's library.</p>}
          </div>
          <div className="card">
            <h2>This server</h2>
            <table className="table"><tbody>
              <tr><td>Public address</td><td className="mono">{d.system.publicUrl ?? <span className="muted">not set (ALX_PUBLIC_URL); AI settings use the address in the browser</span>}</td></tr>
              <tr><td>Data folder</td><td className="mono">{d.system.dataDir ?? 'none (memory only)'}</td></tr>
              <tr><td>Vault folder</td><td className="mono">{d.system.vaultsDir ?? <span className="muted">off (ALX_VAULTS_DIR)</span>}</td></tr>
              <tr><td>Model endpoint</td><td>{d.system.modelEndpoint ? 'set' : <span className="muted">not set; AI features fall back to library search</span>}</td></tr>
              <tr><td>Local MCP servers</td><td className="mono">{d.system.stdioMcpServers.length ? d.system.stdioMcpServers.join(', ') : <span className="muted">none (ALX_MCP_STDIO)</span>}</td></tr>
              <tr><td>Node</td><td className="mono">{d.system.node}</td></tr>
            </tbody></table>
            <p className="tiny faint">Setup and settings are explained in docs/HOSTING.md.</p>
          </div>
          <div className="row"><Link className="btn" to="/admin/worlds">Worlds</Link><Link className="btn" to="/admin/accounts">Accounts</Link><Link className="btn" to="/admin/keys">Keys & AI</Link></div>
        </>
      )}
    </div>
  );
}
