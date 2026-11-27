// The AI on the DM's Table: whether the local models are loaded for the session, and one tap to the templates and guides the
// assistant follows, the DM's model switcher, the model settings, Minerva and Active mode.
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { TableCard } from '../../ui/TableCard.tsx';
import { WARM_NAMES, type WarmEntry } from './GameNightCard.tsx';

interface Ready { enabled: boolean; jobs: Record<string, WarmEntry> }
const MARK: Record<string, [string, string]> = { ready: ['fa-circle-check', 'tb-ok'], failed: ['fa-circle-xmark', 'tb-danger'], loading: ['fa-spinner fa-spin', 'tb-accent'], idle: ['fa-circle', 'faint'] };

export default function TableModels() {
  const { w, info } = useWorld();
  const { me } = useAuth();
  const r = useLoad<Ready>(() => w.call<Ready>('GET', '/models/ready').catch(() => ({ enabled: false, jobs: {} })), [w], ['models-warm']);
  const loading = Object.values(r.data?.jobs ?? {}).some((e) => e.state === 'loading');
  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => void r.reload(), 2000);
    return () => clearInterval(t);
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps
  const jobs = Object.entries(r.data?.jobs ?? {});
  const failed = jobs.some(([, e]) => e.state === 'failed');
  const base = `/w/${info.slug}/dm`;
  return (
    <TableCard id="ai" title="AI & templates" icon="fa-microchip" tone={failed ? 'red' : undefined} link={['minerva', 'Minerva']}>
      {jobs.length > 0 ? (
        <div className="tb-models" data-testid="models-ready-line">
          {jobs.map(([job, e]) => <span key={job} data-job={job} data-state={e.state} title={e.state}><i className={`fa-solid ${MARK[e.state]?.[0] ?? 'fa-circle'} ${MARK[e.state]?.[1] ?? ''}`} aria-hidden="true" /> {WARM_NAMES[job] ?? job}</span>)}
        </div>
      ) : <span className="small muted">Models load when a game night starts (Admin → Models → Game night).</span>}
      {failed && <span className="small tb-danger">A model did not answer. Check the model settings.</span>}
      <div className="tb-links">
        <Link className="tb-link" to={`${base}/templates`}><i className="fa-solid fa-compass-drafting" aria-hidden="true" /> Templates &amp; guides</Link>
        <Link className="tb-link" to={`${base}/models`} data-testid="switch-models"><i className="fa-solid fa-shuffle" aria-hidden="true" /> Switch models</Link>
        {me?.account.is_admin && <Link className="tb-link" to="/admin/models"><i className="fa-solid fa-sliders" aria-hidden="true" /> Model settings</Link>}
        <Link className="tb-link" to={`${base}/active`}><i className="fa-solid fa-ear-listen" aria-hidden="true" /> Active mode</Link>
        <Link className="tb-link" to={`${base}/connect`}><i className="fa-solid fa-plug" aria-hidden="true" /> Connect AI</Link>
      </div>
    </TableCard>
  );
}
