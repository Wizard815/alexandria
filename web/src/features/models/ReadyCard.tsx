// The DM's table page: "Models ready: chat ✓ audit ✓ whisper … loading". Shown while a game session
// holds the local models (Admin → Models → Game night). Reads the server's state only, never asks a model.
import { useEffect } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { WARM_NAMES, type WarmEntry } from './GameNightCard.tsx';

interface Ready { enabled: boolean; jobs: Record<string, WarmEntry> }

const mark = (e: WarmEntry) => (e.state === 'ready' ? '✓' : e.state === 'failed' ? '✗' : e.state === 'loading' ? '… loading' : '·');

export default function ReadyCard() {
  const { w } = useWorld();
  const r = useLoad<Ready>(() => w.call('GET', '/models/ready'), [w], ['models-warm']);
  const loading = Object.values(r.data?.jobs ?? {}).some((e) => e.state === 'loading');
  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => void r.reload(), 2000);
    return () => clearInterval(t);
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = r.data;
  if (!d) return null;
  const entries = Object.entries(d.jobs);
  if (!entries.length || (!d.enabled && entries.every(([, e]) => e.state === 'idle'))) return null;
  const failed = entries.filter(([, e]) => e.state === 'failed');
  return (
    <section className="card" aria-label="Models ready" data-testid="models-ready">
      <div className="card-head"><h2 style={{ margin: 0 }}>Models ready</h2></div>
      <p style={{ margin: 0 }} data-testid="models-ready-line">
        {entries.map(([job, e], i) => <span key={job} data-job={job} data-state={e.state}>{i ? '  ' : ''}{WARM_NAMES[job] ?? job} {mark(e)}</span>)}
      </p>
      {failed.length > 0 && <p className="small muted" style={{ margin: 0 }}>{failed.map(([j]) => WARM_NAMES[j] ?? j).join(', ')} did not answer. Check Admin → Models.</p>}
    </section>
  );
}
