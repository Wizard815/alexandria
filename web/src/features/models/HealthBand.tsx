// A band on every DM page when an AI role moved to its backup or stopped answering (core/ai.ts health), with one tap to
// the model switcher. It goes away by itself when the model answers again or the DM picks another one.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { onWhat, roleName, type JobHealth } from './roles.ts';

export default function HealthBand() {
  const { w, info, isDM } = useWorld();
  const h = useLoad(() => (isDM ? w.call<{ jobs: JobHealth[] }>('GET', '/models/health') : Promise.resolve({ jobs: [] })).catch(() => ({ jobs: [] as JobHealth[] })), [w, isDM], ['models-health']);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const jobs = (h.data?.jobs ?? []).filter((j) => !hidden.has(`${j.job}|${j.state}|${j.since}`));
  if (!isDM || !jobs.length) return null;
  const down = jobs.some((j) => j.state === 'down');
  return (
    <div className={`card ${down ? '' : 'gold'}`} role="status" data-testid="model-health-band" style={{ margin: '8px 0', padding: '8px 12px', borderColor: down ? 'var(--danger)' : undefined }}>
      {jobs.map((j) => (
        <div key={j.job} className="row small" data-job={j.job} data-state={j.state}>
          <i className={`fa-solid ${j.state === 'down' ? 'fa-circle-xmark tb-danger' : 'fa-life-ring'}`} aria-hidden="true" />
          <span style={{ flex: 1, minWidth: 0 }}>
            {j.state === 'fallback'
              ? <><strong>{roleName(j.job)}</strong>: {onWhat(j.model, j.provider)} stopped answering. Using the backup {onWhat(j.using, j.usingProvider)} for now.</>
              : <><strong>{roleName(j.job)}</strong>: {onWhat(j.model, j.provider)} is not answering and there is no working backup.</>}
          </span>
          <Link className="btn small primary" to={`/w/${info.slug}/dm/models`}>{j.state === 'down' ? 'Pick another model' : 'Switch model'}</Link>
          <button type="button" className="btn small" aria-label="Hide this notice" onClick={() => setHidden((s) => new Set([...s, `${j.job}|${j.state}|${j.since}`]))}><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
        </div>
      ))}
    </div>
  );
}
