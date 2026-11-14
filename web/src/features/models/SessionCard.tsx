// Admin → Models: session mode for Argos. Warm the local models when a game session starts,
// keep them loaded while it runs, optionally unload them when it ends; plus Load all / Unload all now.
// The setting is global (the GPUs are shared by every world on this server).
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { ErrorBox, Loading, Switch, useAction } from '../../ui/index.tsx';

export type WarmState = 'idle' | 'loading' | 'ready' | 'failed';
export interface WarmEntry { state: WarmState; ms?: number; error?: string }
interface SessionView { settings: { loadOnStart: boolean; keepLoaded: boolean; unloadOnEnd: boolean }; warm: Record<string, WarmEntry>; sessionRunning: boolean; localJobs: string[] }
interface UnloadResult { jobs: string[]; model: string; provider: string; ok: boolean; error?: string }

export const WARM_NAMES: Record<string, string> = { chat: 'chat', audit: 'audit', audio: 'whisper', voice: 'voice', extra: 'embeddings', rerank: 'rerank' };

export const WarmMark = ({ e }: { e?: WarmEntry }) => {
  if (!e || e.state === 'idle') return <span className="muted">not loaded yet</span>;
  if (e.state === 'loading') return <span className="chip gold" data-warm="loading">… loading</span>;
  if (e.state === 'ready') return <span className="chip green" data-warm="ready">✓ ready{e.ms !== undefined ? ` (${e.ms} ms)` : ''}</span>;
  return <span className="chip red" data-warm="failed" title={e.error}>✗ failed</span>;
};

export default function SessionCard({ onChanged }: { onChanged?: () => void }) {
  const { client } = useAuth();
  const [v, setV] = useState<SessionView | null>(null);
  const [results, setResults] = useState<UnloadResult[] | null>(null);
  const a = useAction();
  const load = useCallback(async () => { try { setV(await client.request<SessionView>('GET', '/api/admin/models/session')); } catch { /* the page shows other errors */ } }, [client]);
  useEffect(() => { void load(); }, [load]);
  const loading = Object.values(v?.warm ?? {}).some((e) => e.state === 'loading');
  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [loading, load]);

  const set = (k: keyof SessionView['settings'], on: boolean) => a.run(async () => { setV(await client.request<SessionView>('PUT', '/api/admin/models/session', { [k]: on })); });
  const loadAll = () => a.run(async () => { setResults(null); setV(await client.request<SessionView>('POST', '/api/admin/models/warm-all', {})); });
  const unloadAll = () => a.run(async () => {
    const r = await client.request<SessionView & { results: UnloadResult[] }>('POST', '/api/admin/models/unload-all', {});
    setV(r); setResults(r.results); onChanged?.();
  });

  return (
    <section className="card" aria-label="Session mode" data-testid="session-mode">
      <div>
        <h2 style={{ margin: 0 }}>Session mode</h2>
        <p className="muted small" style={{ margin: 0 }}>For Argos on your own machines. A session starts when the DM opens the session chat or starts a recording. This is one setting for the whole server, because the GPUs are shared by every world.</p>
      </div>
      {!v ? <Loading /> : (
        <>
          <div className="row small"><Switch checked={v.settings.loadOnStart} onChange={(on) => void set('loadOnStart', on)} label="Load before play" /> <span><strong>Load before play.</strong> When a session starts, send each local job one tiny request, all at once, so the models are ready before the first question. Cloud jobs are left alone.</span></div>
          <div className="row small"><Switch checked={v.settings.keepLoaded} onChange={(on) => void set('keepLoaded', on)} label="Keep loaded" /> <span><strong>Keep loaded.</strong> While a session runs, ping every local job every few minutes so Argos does not unload it. (Argos's own <code>ttl: 0</code> does the same from its side; see the Argos config below.)</span></div>
          <div className="row small"><Switch checked={v.settings.unloadOnEnd} onChange={(on) => void set('unloadOnEnd', on)} label="Unload when the session ends" /> <span><strong>Unload when the session ends.</strong> Frees the GPUs for other work by asking Argos to unload each job model. Off by default. Only models on an Argos provider are touched.</span></div>
          <p className="small" style={{ margin: 0 }}>{v.sessionRunning ? 'A session is running now.' : 'No session is running.'}</p>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }} data-testid="warm-list">
            {v.localJobs.length === 0 && <li className="muted">No job is on a local provider yet.</li>}
            {v.localJobs.map((j) => <li key={j} data-warm-job={j}>{WARM_NAMES[j] ?? j}: <WarmMark e={v.warm[j]} /></li>)}
          </ul>
          <ErrorBox error={a.error} />
          <div className="row">
            <button type="button" className="btn primary" onClick={() => void loadAll()} disabled={a.busy || loading || v.localJobs.length === 0}>Load all now</button>
            <button type="button" className="btn" onClick={() => void unloadAll()} disabled={a.busy || loading}>Unload all now</button>
          </div>
          {results && (
            <p className="small" role="status" style={{ margin: 0 }} data-testid="unload-results">
              {results.length === 0 ? 'No job uses an Argos model, so there was nothing to unload.' : results.map((r) => `${r.model}: ${r.ok ? 'unloaded' : `failed (${r.error})`}`).join('; ')}
            </p>
          )}
        </>
      )}
    </section>
  );
}
