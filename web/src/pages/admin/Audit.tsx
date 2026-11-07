import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { ErrorBox, Loading, PageHead } from '../../ui/index.tsx';

export default function AdminAudit() {
  const { client } = useAuth();
  const log = useLoad(() => client.request<any[]>('GET', '/api/admin/audit', undefined, { limit: 300 }), []);
  return (
    <div className="page">
      <PageHead title="Audit log" lead="Every account, key, source, setting and page change, newest first." />
      <ErrorBox error={log.error} />
      {log.loading && !log.data ? <Loading /> : (
        <div className="card flush scroll-x">
          <table className="table">
            <thead><tr><th>When</th><th>What</th><th>Detail</th><th>Who</th></tr></thead>
            <tbody>{(log.data ?? []).map((e) => <tr key={e.id}><td className="small" style={{ whiteSpace: 'nowrap' }}>{when(e.at)}</td><td className="mono">{e.action}</td><td className="small">{e.detail}</td><td className="mono tiny muted">{e.account_id}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
