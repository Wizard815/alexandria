// Admin → Models → Game night: the model lifecycle tied to the game session (librarian features/models/lifecycle.ts).
// A session (a recording, an open session chat, or "Start game night") loads every job set to "Keep loaded", holds it
// while the session runs and releases it after a grace period. Per job it shows the model, the server type and what
// that server can do, whether the model is loaded now, and what happens at the start and end of a session.
// One setting for the whole server: the GPUs are shared by every world.
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { ErrorBox, Loading, useAction } from '../../ui/index.tsx';

export type WarmState = 'idle' | 'loading' | 'ready' | 'failed';
export interface WarmEntry { state: WarmState; ms?: number; error?: string }
export const WARM_NAMES: Record<string, string> = { chat: 'chat', audit: 'audit', audio: 'whisper', voice: 'voice', extra: 'embeddings', rerank: 'rerank' };

type Backend = 'argos' | 'llama-swap' | 'ollama' | 'lmstudio' | 'generic' | 'hosted';
type Policy = 'hold' | 'ondemand';
type HoldState = 'loading' | 'ready' | 'failed' | 'lost';
type Seen = 'loaded' | 'unloaded' | 'unknown' | 'missing' | 'unreachable';

interface ProviderLife {
  id: string; backend: Backend; detected: Backend | null; auto: boolean; override: Backend | 'auto'; ttl: number; pingMinutes: number;
  hosted: boolean; label: string; canHold: boolean; canUnload: boolean; summary: string; probedAt: string | null;
}
interface HoldView { key: string; provider: string; model: string; jobs: string[]; backend: Backend; state: HoldState; ms?: number; error?: string; ttl?: number }
export interface Lifecycle {
  phase: 'off' | 'warming' | 'ready' | 'releasing'; live: boolean; reasons: ('manual' | 'recording' | 'chat')[];
  graceUntil: string | null; graceMinutes: number; progress: { ready: number; total: number };
  holds: HoldView[]; lastRelease: { at: string; results: { model: string; ok: boolean; note?: string; error?: string }[] } | null;
  policies: Record<string, Policy>; providers: ProviderLife[]; backends: Backend[];
}
interface UnloadResult { model: string; provider: string; backend: Backend; ok: boolean; note?: string; error?: string }
export interface JobLite { job: string; providerId: string; model: string; effective: { model: string; provider: string | null; location: 'local' | 'cloud' } | null }
interface ProviderLite { id: string; name: string; location: 'local' | 'cloud' }

const BACKEND_NAMES: Record<Backend, string> = { argos: 'Argos', 'llama-swap': 'llama-swap', ollama: 'Ollama', lmstudio: 'LM Studio', generic: 'OpenAI-compatible (no load control)', hosted: 'Hosted API' };
const REASONS: Record<string, string> = { manual: 'started by hand', recording: 'a recording is running', chat: 'a session chat is open' };
const HOLD_TEXT: Record<HoldState, string> = { loading: '… loading', ready: '✓ loaded, held', failed: '✗ failed', lost: 'reloading' };
const SEEN_TEXT: Record<Seen, string> = { loaded: 'loaded', unloaded: 'not loaded', unknown: 'unknown', missing: 'not on the server', unreachable: 'server not reachable' };
const JOB_TITLES: Record<string, string> = { chat: 'Chat', audit: 'Audit', audio: 'Audio', voice: 'Voice', extra: 'Historian (embeddings)', rerank: 'Arbiter (rerank)' };

export const WarmMark = ({ e }: { e?: WarmEntry }) => {
  if (!e || e.state === 'idle') return <span className="muted">not loaded yet</span>;
  if (e.state === 'loading') return <span className="chip gold" data-warm="loading">… loading</span>;
  if (e.state === 'ready') return <span className="chip green" data-warm="ready">✓ ready{e.ms !== undefined ? ` (${e.ms} ms)` : ''}</span>;
  return <span className="chip red" data-warm="failed" title={e.error}>✗ failed</span>;
};

/** What a session does to this job's model, in words, from the policy and what its server can do. */
function plan(policy: Policy, pl: ProviderLife | undefined, cloud: boolean, grace: number): { start: string; end: string } {
  if (cloud || pl?.hosted || pl?.backend === 'hosted') return { start: 'Nothing: a hosted API is always ready.', end: 'Nothing.' };
  const b = pl?.backend ?? 'generic';
  if (policy === 'ondemand') return { start: 'Not loaded ahead: the server loads it on first use.', end: 'Left to the server’s own idle timer.' };
  const after = grace > 0 ? `${grace} min after the session ends` : 'when the session ends';
  if (b === 'generic') {
    return pl && pl.pingMinutes > 0
      ? { start: `A tiny request every ${pl.pingMinutes} min to keep it warm.`, end: 'Pings stop. This server has nothing to unload.' }
      : { start: 'Nothing: this server cannot be told to load or keep a model. It loads on first use.', end: 'Nothing to unload.' };
  }
  if (b === 'lmstudio') return { start: 'Loaded at once, checked every minute, reloaded if it went away.', end: `Unloaded ${after} (or by LM Studio’s idle timer if it has no unload endpoint).` };
  if (b === 'llama-swap') return { start: `Loaded at once; a tiny request just inside the ${pl?.ttl ?? 300}s ttl keeps it.`, end: `Unloaded ${after}.` };
  if (b === 'ollama') return { start: 'Loaded at once with keep_alive -1 (held until told otherwise).', end: `Unloaded ${after} (keep_alive 0).` };
  return { start: 'Loaded at once, checked every minute, reloaded if Argos let it go.', end: `Unloaded ${after}.` };
}

function ServerRow({ p, pl, onSaved }: { p: ProviderLite; pl: ProviderLife; onSaved: (v: Lifecycle) => void }) {
  const { client } = useAuth();
  const a = useAction();
  const [ttl, setTtl] = useState(String(pl.ttl));
  const [ping, setPing] = useState(String(pl.pingMinutes));
  const save = (patch: Record<string, unknown>) => a.run(async () => {
    await client.request('PUT', `/api/admin/models/providers/${p.id}`, patch);
    onSaved(await client.request<Lifecycle>('GET', '/api/admin/models/lifecycle'));
  });
  const detect = () => a.run(async () => {
    await client.request('POST', `/api/admin/models/providers/${p.id}/detect`, {});
    onSaved(await client.request<Lifecycle>('GET', '/api/admin/models/lifecycle'));
  });
  return (
    <li className="gn-server" data-server={p.id} data-backend={pl.backend}>
      <div className="row between">
        <strong>{p.name}</strong>
        <span className={`chip${pl.canHold ? ' green' : ''}`}>{pl.label}</span>
      </div>
      <p className="tiny muted" style={{ margin: 0 }}>{pl.summary}</p>
      {!pl.hosted && (
        <div className="row small gn-server-set">
          <label className="row tight">Server type
            <select value={pl.override} onChange={(e) => void save({ backend: e.target.value })} aria-label={`${p.name} server type`} disabled={a.busy}>
              <option value="auto">Detect{pl.detected ? ` (found ${BACKEND_NAMES[pl.detected]})` : ''}</option>
              {(['argos', 'llama-swap', 'ollama', 'lmstudio', 'generic'] as Backend[]).map((b) => <option key={b} value={b}>{BACKEND_NAMES[b]}</option>)}
            </select>
          </label>
          {pl.backend === 'llama-swap' && (
            <label className="row tight">ttl (s)
              <input className="gn-num" inputMode="numeric" value={ttl} onChange={(e) => setTtl(e.target.value)} onBlur={() => { if (ttl !== String(pl.ttl)) void save({ ttl: Number(ttl) }); }} aria-label={`${p.name} ttl in seconds`} />
            </label>
          )}
          {pl.backend === 'generic' && (
            <label className="row tight">Ping every (min, 0 = never)
              <input className="gn-num" inputMode="numeric" value={ping} onChange={(e) => setPing(e.target.value)} onBlur={() => { if (ping !== String(pl.pingMinutes)) void save({ pingMinutes: Number(ping) }); }} aria-label={`${p.name} ping minutes`} />
            </label>
          )}
          <button type="button" className="btn small" onClick={() => void detect()} disabled={a.busy}>Detect again</button>
        </div>
      )}
      <ErrorBox error={a.error} />
    </li>
  );
}

export default function GameNightCard({ jobs, providers, status, onChanged }: {
  jobs: JobLite[]; providers: ProviderLite[]; status?: Record<string, { primary?: Seen }>; onChanged?: () => void;
}) {
  const { client } = useAuth();
  const [v, setV] = useState<Lifecycle | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<UnloadResult[] | null>(null);
  const [grace, setGrace] = useState('');
  const a = useAction();
  const load = useCallback(async () => {
    try { const r = await client.request<Lifecycle>('GET', '/api/admin/models/lifecycle'); setV(r); setErr(null); } catch (e: any) { setErr(String(e?.message ?? e)); }
  }, [client]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (v) setGrace(String(v.graceMinutes)); }, [v?.graceMinutes]); // eslint-disable-line react-hooks/exhaustive-deps
  const busy = !!v && (v.phase === 'warming' || v.phase === 'releasing' || v.holds.some((h) => h.state === 'loading' || h.state === 'lost'));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [busy, load]);

  const startNight = () => a.run(async () => { setResults(null); setV(await client.request<Lifecycle>('POST', '/api/admin/models/game-night/start', {})); });
  const endNight = (now: boolean) => a.run(async () => { setV(await client.request<Lifecycle>('POST', '/api/admin/models/game-night/end', { now })); onChanged?.(); });
  const unloadAll = () => a.run(async () => {
    const r = await client.request<Lifecycle & { results: UnloadResult[] }>('POST', '/api/admin/models/unload-all', {});
    setV(r); setResults(r.results); onChanged?.();
  });
  const setPolicy = (job: string, p: Policy) => a.run(async () => { setV(await client.request<Lifecycle>('PUT', '/api/admin/models/lifecycle', { policies: { [job]: p } })); });
  const saveGrace = () => a.run(async () => { setV(await client.request<Lifecycle>('PUT', '/api/admin/models/lifecycle', { graceMinutes: Number(grace) })); });

  const pOf = (id: string) => v?.providers.find((x) => x.id === id);
  const used = providers.filter((p) => jobs.some((j) => j.providerId === p.id && j.model));
  const manual = !!v?.reasons.includes('manual');

  return (
    <section className="card" aria-label="Game night" data-testid="game-night">
      <div>
        <h2 style={{ margin: 0 }}>Game night</h2>
        <p className="muted small" style={{ margin: 0 }}>A session starts when a GM starts a recording or opens the session chat, or when you press Start below. Jobs set to <strong>Keep loaded</strong> are loaded then and held while it runs; after it ends they are unloaded. While no session is open Alexandria sends the model servers nothing.</p>
      </div>
      <ErrorBox error={err} />
      {!v ? <Loading /> : (
        <>
          <p className="small" role="status" style={{ margin: 0 }} data-testid="gn-phase" data-phase={v.phase} data-live={v.live ? '1' : '0'}>
            {v.live
              ? <><span className="chip green">Session live</span> {v.reasons.map((r) => REASONS[r]).join(', ')}. {v.progress.total ? `${v.progress.ready} of ${v.progress.total} models loaded.` : 'No model here needs holding.'}</>
              : v.phase === 'releasing' && v.graceUntil
                ? <><span className="chip gold">Session ended</span> Models are unloaded at {new Date(v.graceUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, unless a session starts again.</>
                : <><span className="chip">No session</span> Nothing is held. No requests are made.</>}
          </p>

          <ul className="gn-jobs" data-testid="gn-jobs">
            {jobs.filter((j) => j.effective).map((j) => {
              const pl = pOf(j.providerId);
              const pol = v.policies[j.job] ?? 'ondemand';
              const hold = v.holds.find((h) => h.jobs.includes(j.job));
              const seen = status?.[j.job]?.primary;
              const cloud = j.effective?.location === 'cloud';
              const what = plan(pol, pl, cloud, v.graceMinutes);
              return (
                <li key={j.job} className="gn-job" data-gn-job={j.job} data-policy={pol}>
                  <div className="gn-job-head">
                    <strong>{JOB_TITLES[j.job] ?? j.job}</strong>
                    <code className="gn-model" title={j.effective?.model}>{j.effective?.model}</code>
                    <span className="tiny muted">{j.effective?.provider ?? 'environment'} · {cloud ? 'Hosted API' : pl ? BACKEND_NAMES[pl.backend] : 'unknown server'}</span>
                  </div>
                  <div className="row small gn-job-now">
                    <span>Now: {hold
                      ? <span className={`chip ${hold.state === 'ready' ? 'green' : hold.state === 'failed' ? 'red' : 'gold'}`} data-hold={hold.state} title={hold.error}>{HOLD_TEXT[hold.state]}{hold.ms !== undefined && hold.state === 'ready' ? ` (${hold.ms} ms)` : ''}</span>
                      : seen ? <span className={`chip${seen === 'loaded' ? ' green' : seen === 'unreachable' || seen === 'missing' ? ' red' : ''}`} data-seen={seen}>{SEEN_TEXT[seen]}</span> : <span className="muted">-</span>}</span>
                    {!cloud && (
                      <select value={pol} onChange={(e) => void setPolicy(j.job, e.target.value as Policy)} aria-label={`${JOB_TITLES[j.job] ?? j.job} during a session`} disabled={a.busy}>
                        <option value="hold">Keep loaded during a session</option>
                        <option value="ondemand">Load when needed</option>
                      </select>
                    )}
                  </div>
                  {hold?.error && <p className="tiny" style={{ margin: 0, color: 'var(--red, #b33)' }}>{hold.error}</p>}
                  <dl className="tiny gn-plan">
                    <dt>Session start</dt><dd>{what.start}</dd>
                    <dt>Session end</dt><dd>{what.end}</dd>
                  </dl>
                </li>
              );
            })}
            {!jobs.some((j) => j.effective) && <li className="muted small">No job has a model yet.</li>}
          </ul>

          <ErrorBox error={a.error} />
          <div className="row">
            {manual
              ? <button type="button" className="btn primary" onClick={() => void endNight(false)} disabled={a.busy} data-testid="gn-end">End game night</button>
              : <button type="button" className="btn primary" onClick={() => void startNight()} disabled={a.busy} data-testid="gn-start">Start game night</button>}
            {!v.live && v.phase === 'releasing' && <button type="button" className="btn" onClick={() => void endNight(true)} disabled={a.busy} data-testid="gn-release">Unload now (skip the wait)</button>}
            <button type="button" className="btn" onClick={() => void unloadAll()} disabled={a.busy || v.live} title={v.live ? 'A session is live; end it first' : undefined} data-testid="gn-unload-all">Unload all job models now</button>
          </div>
          <div className="row small">
            <label className="row tight">Wait after a session ends (min)
              <input className="gn-num" inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value)} aria-label="Minutes to wait before unloading" />
            </label>
            <button type="button" className="btn small" onClick={() => void saveGrace()} disabled={a.busy || grace === String(v.graceMinutes)}>Save</button>
            <span className="tiny muted">A break or a restarted recording does not unload anything.</span>
          </div>
          {results && (
            <p className="small" role="status" style={{ margin: 0 }} data-testid="unload-results">
              {results.length === 0 ? 'No job model is on a server that can unload, so there was nothing to unload.' : results.map((r) => `${r.model}: ${r.ok ? (r.note ?? 'unloaded') : `failed (${r.error})`}`).join('; ')}
            </p>
          )}
          {v.lastRelease && !results && (
            <p className="tiny muted" style={{ margin: 0 }} data-testid="last-release">
              Last unload {new Date(v.lastRelease.at).toLocaleString()}: {v.lastRelease.results.length ? v.lastRelease.results.map((r) => `${r.model} ${r.ok ? (r.note ?? 'unloaded') : `failed (${r.error})`}`).join('; ') : 'nothing was held'}.
            </p>
          )}

          {used.length > 0 && (
            <details className="gn-servers-box">
              <summary className="small"><strong>Model servers</strong> <span className="muted">what each one can do</span></summary>
              <p className="tiny muted" style={{ margin: '4px 0' }}>Found by asking the server once. Argos, llama-swap, Ollama and LM Studio can load and unload; a plain OpenAI-compatible server (vLLM, llama.cpp, a proxy) cannot, so its models load on first use and stay as long as that server decides.</p>
              <ul className="gn-servers">
                {used.map((p) => { const pl = pOf(p.id); return pl ? <ServerRow key={p.id + pl.backend + pl.ttl + pl.pingMinutes} p={p} pl={pl} onSaved={setV} /> : null; })}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
