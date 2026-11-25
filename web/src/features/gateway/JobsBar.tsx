// "Server busy: 2 jobs": the heavy work the server is doing (a crawl, a sync, a re-index, a rebuild of the player copies, the warm-up after a
// start) with how far each one is, and a button to stop the ones that can be stopped. Shown at the top of every admin page; nothing is shown
// while the server is idle. The server answers requests while it works, so this is information, not a wait.
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';

interface Job { id: string; kind: string; title: string; status: string; progress: { done: number; total: number; message: string }; cancellable: boolean; startedAt: string }
interface JobsState { busy: number; warming: boolean; phase: string; jobs: Job[]; memory?: { rssMb: number; heapMb: number } }

const PHASES: Record<string, string> = { starting: 'starting', copies: 'rebuilding page copies', jobs: 'restarting interrupted jobs', caches: 'warming the search caches' };

export default function JobsBar() {
  const { client } = useAuth();
  const [state, setState] = useState<JobsState | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setState(await client.request('GET', '/api/admin/jobs')); setError(''); } catch (e: any) { setError(e?.status === 401 || e?.status === 403 ? '' : 'The server is not answering.'); }
  }, [client]);

  useEffect(() => {
    void load();
    // Quick while something runs, slow while idle; paused in a hidden tab.
    let t: ReturnType<typeof setTimeout>;
    const loop = () => { t = setTimeout(async () => { if (!document.hidden) await load(); loop(); }, state && (state.busy > 0 || state.warming) ? 2000 : 10000); };
    loop();
    return () => clearTimeout(t);
  }, [load, state?.busy, state?.warming]);

  const stop = async (id: string) => { try { await client.request('POST', `/api/admin/jobs/${encodeURIComponent(id)}/cancel`); } catch { /* the list shows what happened */ } await load(); };

  if (error) return <div className="jobsbar jobsbar-bad" role="status" data-testid="jobs-bar">{error}</div>;
  if (!state || (state.busy === 0 && !state.warming)) return null;
  const running = state.jobs.filter((j) => j.status === 'running');
  return (
    <div className="jobsbar" role="status" data-testid="jobs-bar">
      <button type="button" className="jobsbar-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="jobsbar-dot" aria-hidden="true" />
        <strong>{state.warming ? `Server starting: ${PHASES[state.phase] ?? 'getting ready'}` : `Server busy: ${state.busy} job${state.busy === 1 ? '' : 's'}`}</strong>
        <span className="tiny muted"> The table keeps working. {open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <ul className="jobsbar-list">
          {running.map((j) => (
            <li key={j.id}>
              <div className="jobsbar-row"><span>{j.title}</span>{j.cancellable && <button type="button" className="btn small" onClick={() => void stop(j.id)}>Stop</button>}</div>
              {j.progress.total > 0 ? <progress max={j.progress.total} value={Math.min(j.progress.done, j.progress.total)} aria-label={j.title} /> : <progress aria-label={j.title} />}
              <div className="tiny muted">{j.progress.message || (j.progress.total ? `${j.progress.done} of ${j.progress.total}` : 'working')}</div>
            </li>
          ))}
          {state.memory && <li className="tiny muted">Memory: {state.memory.heapMb} MB in use ({state.memory.rssMb} MB resident)</li>}
        </ul>
      )}
    </div>
  );
}
