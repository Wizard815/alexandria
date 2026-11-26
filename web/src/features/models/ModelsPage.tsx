import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { useSearchParams } from 'react-router-dom';
import { ErrorBox, Field, Loading, PageHead, Switch, Tabs, useAction, useToast } from '../../ui/index.tsx';
import GameNightCard from './GameNightCard.tsx';
import VramCard from './VramCard.tsx';
import GatewayLogCard from './GatewayLogCard.tsx';
import EmbeddingsCard from '../bible/EmbeddingsCard.tsx';

type Kind = 'argos' | 'openai' | 'ollama' | 'lmstudio' | 'openai-compatible';
type Location = 'local' | 'cloud';
type Seen = 'loaded' | 'unloaded' | 'unknown' | 'missing' | 'unreachable';

interface Provider { id: string; name: string; kind: Kind; baseUrl: string; apiKey: string; location: Location; webUrl?: string; usedBy: string[]; backend?: { label: string; canHold: boolean; detected: string | null } }
interface FallbackView { providerId: string; model: string; options: Record<string, unknown>; allowCloud: boolean; location?: Location }
interface Choice { providerId: string; model: string }
interface JobView {
  job: string; uses: string; providerId: string; baseUrl: string; model: string; apiKey: string; options: Record<string, unknown>;
  enabled: boolean; gameNight: 'hold' | 'ondemand'; fallback: FallbackView | null; fallbackBlocked: boolean;
  location: Location | null; lastChoice?: Record<Location, Choice | null>;
  source: 'saved' | 'env' | 'none' | 'chat'; effective: { baseUrl: string; model: string; hasKey: boolean; provider: string | null; location: Location; hasFallback: boolean } | null;
}
interface Found { id: string; name: string; description: string; status: Seen; inputModalities: string[]; outputModalities: string[]; vision: boolean; tools: boolean; reranker: boolean; contextLength: number | null; role: string }
interface Discovery { ok: boolean; baseUrl: string; webUrl?: string; error?: string; models: Found[]; suggestions: Record<string, { model: string | null; reason: string }>; voices: string[] }
interface TestResult { ok: boolean; ms: number; sample?: string; error?: string }
interface Status { providers: Record<string, { ok: boolean; error?: string }>; jobs: Record<string, { primary?: Seen; fallback?: Seen }> }
interface All { jobs: JobView[]; providers: Provider[] }

const NAMES: Record<string, string> = { chat: 'Chat', audit: 'Audit', audio: 'Audio (speech to text)', voice: 'Voice (text to speech)', extra: 'Extra (embeddings)', rerank: 'Rerank (optional)', dm: 'DM assistant', player: 'Players', bible: 'Story bible', vision: 'Map vision (sees pictures)' };
const JOB_ORDER = ['chat', 'dm', 'player', 'bible', 'vision', 'audit', 'audio', 'voice', 'extra', 'rerank'];
const KIND_NAMES: Record<Kind, string> = { argos: 'Argos', openai: 'OpenAI', ollama: 'Ollama', lmstudio: 'LM Studio', 'openai-compatible': 'Other OpenAI-compatible' };
const CLOUD_WARNING = 'World text will leave this server for this cloud provider whenever the main one cannot answer.';
const STATUS_TEXT: Record<Seen, string> = { loaded: 'loaded', unloaded: 'unloaded (loads on request)', unknown: 'status unknown', missing: 'model not found there', unreachable: 'provider not reachable' };

const StatusChip = ({ s }: { s?: Seen }) => (s ? <span className={`chip ${s === 'loaded' ? 'green' : s === 'unloaded' ? 'gold' : s === 'unknown' ? '' : 'red'}`} data-status={s}>{STATUS_TEXT[s]}</span> : null);
const WhereChip = ({ l }: { l: Location }) => <span className={`chip ${l === 'cloud' ? 'red' : 'green'}`} data-where={l}>{l === 'cloud' ? 'Cloud' : 'Local'}</span>;
const LocChip = ({ l }: { l: Location }) => <span className={`chip ${l === 'cloud' ? 'red' : 'green'}`}>{l === 'cloud' ? 'cloud' : 'local'}</span>;


// A dropdown of the models the provider lists. Typed only when it listed none (not discovered or unreachable).
// Argos loads an unloaded model on the first request, so "unloaded" is shown as a note, not a warning.
function ModelPick({ value, onChange, found, label, argos }: { value: string; onChange: (v: string) => void; found: Found[]; label: string; argos: boolean }) {
  if (!found.length) return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. qwen3-32b" aria-label={label} />;
  const note = (st: Seen) => (st === 'loaded' ? 'loaded' : st === 'unloaded' ? (argos ? 'loads on request' : 'unloaded') : STATUS_TEXT[st]);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">(pick a model)</option>
      {value && !found.some((m) => m.id === value) && <option value={value}>{value} (not listed by the provider)</option>}
      {found.map((m) => <option key={m.id} value={m.id}>{m.id} · {note(m.status)}</option>)}
    </select>
  );
}

// ---- discovery table ---------------------------------------------------------------

function FoundTable({ d }: { d: Discovery }) {
  return (
    <div className="stack tight" data-testid="discovery">
      <div style={{ overflowX: 'auto' }}>
        <table className="small" style={{ borderCollapse: 'collapse', minWidth: 460 }}>
          <thead><tr><th align="left">Model</th><th align="left">Status</th><th align="left">In → out</th><th align="left">Can do</th><th align="right">Context</th></tr></thead>
          <tbody>
            {d.models.map((m) => (
              <tr key={m.id} data-model={m.id}>
                <td title={m.description}><strong>{m.id}</strong></td>
                <td><StatusChip s={m.status} /></td>
                <td>{m.inputModalities.join('+') || '?'} → {m.outputModalities.join('+') || '?'}</td>
                <td>{[m.tools && 'tools', m.vision && 'vision', m.reranker && 'reranker'].filter(Boolean).join(', ') || '-'}</td>
                <td align="right">{m.contextLength ? m.contextLength.toLocaleString() : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small" style={{ margin: 0 }}><strong>Suggested per job</strong></p>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        {Object.entries(d.suggestions).map(([job, s]) => (
          <li key={job} data-suggest={job}>{NAMES[job] ?? job}: {s.model ? <strong>{s.model}</strong> : <em>not set</em>} <span className="muted">{s.reason}</span></li>
        ))}
      </ul>
      {d.voices.length > 0 && <p className="tiny muted" style={{ margin: 0 }}>Preset voices: {d.voices.join(', ')}</p>}
    </div>
  );
}

// ---- the Argos preset -------------------------------------------------------------------

function ArgosPreset({ jobs, onDone }: { jobs: JobView[]; onDone: () => void }) {
  const { client } = useAuth();
  const [address, setAddress] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [name, setName] = useState('Argos');
  const [found, setFound] = useState<Discovery | null>(null);
  const [apply, setApply] = useState(true);
  const a = useAction();
  const { toast, toastNode } = useToast();

  const run = () => a.run(async () => {
    setFound(await client.request<Discovery>('POST', '/api/admin/models/discover', { kind: 'argos', baseUrl: address, apiKey }));
  });
  const save = () => a.run(async () => {
    const made = await client.request<{ provider: Provider }>('POST', '/api/admin/models/providers', { name, kind: 'argos', baseUrl: address, apiKey });
    if (apply && found?.ok) {
      const set: Record<string, unknown> = {};
      for (const [job, s] of Object.entries(found.suggestions)) {
        if (!s.model) continue;
        // Keep a job's own settings when it already has a provider: only fill the empty ones.
        const cur = jobs.find((j) => j.job === job);
        if (cur?.providerId) continue;
        // The chat model's context window sizes what the assistant is given (history, transcript, tool results).
        const ctx = found.models.find((m) => m.id === s.model)?.contextLength;
        set[job] = { providerId: made.provider.id, model: s.model, enabled: true, ...(job === 'chat' && ctx ? { options: { contextTokens: ctx } } : {}) };
      }
      if (Object.keys(set).length) await client.request('PUT', '/api/admin/models', { jobs: set });
    }
    toast('Saved');
    setFound(null); setAddress(''); setApiKey('');
    onDone();
  });

  return (
    <section className="card" aria-label="Add Argos" data-testid="argos-preset">
      <div><h2 style={{ margin: 0 }}>Argos: one link for everything</h2><p className="muted small" style={{ margin: 0 }}>Argos routes chat, speech, voice, embeddings and rerank by model name. Paste its address (with or without /v1), press Discover, and it suggests a model for each job.</p></div>
      <Field label="Argos address"><input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="http://argos:8080" inputMode="url" aria-label="Argos address" /></Field>
      <Field label="API key (optional)" help="Only if Argos has apiKeys set. Sent as a Bearer token, stored on the server, never shown again."><input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" aria-label="Argos API key" /></Field>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <ErrorBox error={a.error} />
      <div className="row">
        <button type="button" className="btn" onClick={run} disabled={a.busy || !address.trim()}>Discover</button>
        {found?.ok && <button type="button" className="btn primary" onClick={save} disabled={a.busy}>Save provider</button>}
      </div>
      {found && !found.ok && <div className="error-box" role="alert">{found.error}</div>}
      {found?.ok && (
        <>
          <p className="small" style={{ margin: 0 }}>Found {found.models.length} models at {found.baseUrl}.{found.webUrl && <> <a href={found.webUrl} target="_blank" rel="noreferrer">Open the Argos page</a>.</>}</p>
          <FoundTable d={found} />
          <label className="row small"><input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} /> Assign the suggested models to jobs that have no provider yet</label>
        </>
      )}
      {toastNode}
    </section>
  );
}

// ---- one provider ----------------------------------------------------------------------------

function ProviderCard({ p, onChanged, onFound }: { p: Provider; onChanged: () => void; onFound: (id: string, d: Discovery) => void }) {
  const { client } = useAuth();
  const [name, setName] = useState(p.name);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl);
  const [apiKey, setApiKey] = useState(p.apiKey);
  const [location, setLocation] = useState<Location>(p.location);
  const [found, setFound] = useState<Discovery | null>(null);
  const a = useAction();
  const { toast, toastNode } = useToast();

  const save = () => a.run(async () => { await client.request('PUT', `/api/admin/models/providers/${p.id}`, { name, baseUrl, apiKey, location }); toast('Saved'); onChanged(); });
  const del = () => a.run(async () => { await client.request('DELETE', `/api/admin/models/providers/${p.id}`); onChanged(); });
  const discover = () => a.run(async () => {
    const d = await client.request<Discovery>('POST', '/api/admin/models/discover', { providerId: p.id, apiKey: apiKey === p.apiKey ? undefined : apiKey });
    setFound(d);
    if (d.ok) onFound(p.id, d);
  });

  return (
    <section className="card" aria-label={`Provider ${p.name}`} data-provider={p.id}>
      <div className="row between">
        <div className="row"><h3 style={{ margin: 0 }}>{p.name}</h3><span className="chip">{KIND_NAMES[p.kind]}</span><LocChip l={p.location} />{p.backend?.detected && <span className="chip" title="What this server can do around a game session (Game night tab)" data-backend={p.backend.detected}>{p.backend.label}</span>}</div>
        {p.webUrl && <a className="small" href={p.webUrl} target="_blank" rel="noreferrer">Argos page ↗</a>}
      </div>
      <p className="tiny muted" style={{ margin: 0 }}>{p.usedBy.length ? `Used by ${p.usedBy.join(', ')}.` : 'Not used by any job yet.'}</p>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Base URL"><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} inputMode="url" /></Field>
      <Field label="API key" help="Leave the dots to keep it; clear the box to remove it."><input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" /></Field>
      <Field label="Where it runs" help="Cloud means text sent to it leaves this server.">
        <select value={location} onChange={(e) => setLocation(e.target.value as Location)}><option value="local">Local (my own machines)</option><option value="cloud">Cloud (a third party)</option></select>
      </Field>
      <ErrorBox error={a.error} />
      <div className="row">
        <button type="button" className="btn primary" onClick={save} disabled={a.busy}>Save</button>
        <button type="button" className="btn" onClick={discover} disabled={a.busy}>Discover models</button>
        <button type="button" className="btn danger" onClick={del} disabled={a.busy || p.usedBy.length > 0} title={p.usedBy.length ? 'Point its jobs somewhere else first' : undefined}>Remove</button>
      </div>
      {found && !found.ok && <div className="error-box" role="alert">{found.error}</div>}
      {found?.ok && <FoundTable d={found} />}
      {toastNode}
    </section>
  );
}

function AddProvider({ onDone }: { onDone: () => void }) {
  const { client } = useAuth();
  const [kind, setKind] = useState<Kind>('openai');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [location, setLocation] = useState<Location>('cloud');
  const a = useAction();
  const pick = (k: Kind) => { setKind(k); setLocation(k === 'openai' || k === 'openai-compatible' ? 'cloud' : 'local'); if (k === 'openai' && !baseUrl) setBaseUrl('https://api.openai.com/v1'); };
  const add = () => a.run(async () => { await client.request('POST', '/api/admin/models/providers', { name, kind, baseUrl, apiKey, location }); setName(''); setBaseUrl(''); setApiKey(''); onDone(); });
  return (
    <section className="card" aria-label="Add a provider">
      <h2 style={{ margin: 0 }}>Add another provider</h2>
      <Field label="Kind"><select value={kind} onChange={(e) => pick(e.target.value as Kind)}>{(Object.keys(KIND_NAMES) as Kind[]).map((k) => <option key={k} value={k}>{KIND_NAMES[k]}</option>)}</select></Field>
      <Field label="Name (optional)"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Base URL" help="Usually ends in /v1; a bare address gets /v1 added."><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://host:port/v1" inputMode="url" /></Field>
      <Field label="API key (optional)"><input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" /></Field>
      <Field label="Where it runs"><select value={location} onChange={(e) => setLocation(e.target.value as Location)}><option value="local">Local (my own machines)</option><option value="cloud">Cloud (a third party)</option></select></Field>
      <ErrorBox error={a.error} />
      <div className="row"><button type="button" className="btn primary" onClick={add} disabled={a.busy || !baseUrl.trim()}>Add provider</button></div>
    </section>
  );
}

// ---- one job ---------------------------------------------------------------------------------------

function JobRow({ j, providers, models, status, onSaved }: { j: JobView; providers: Provider[]; models: Record<string, Found[]>; status?: { primary?: Seen; fallback?: Seen }; onSaved: () => void }) {
  const { client } = useAuth();
  const [providerId, setProviderId] = useState(j.providerId);
  const [model, setModel] = useState(j.model);
  // Local or Cloud: the provider list is filtered to the chosen place, and the last model used in each place is remembered.
  const [loc, setLoc] = useState<Location>(providers.find((p) => p.id === j.providerId)?.location ?? j.location ?? 'local');
  const drafts = useRef<Record<Location, Choice | null>>({ local: j.lastChoice?.local ?? null, cloud: j.lastChoice?.cloud ?? null });
  const pickLoc = (next: Location) => {
    if (next === loc) return;
    if (providerId) drafts.current[loc] = { providerId, model };
    const back = drafts.current[next];
    const first = providers.find((p) => p.location === next);
    setLoc(next);
    setProviderId(back && providers.some((p) => p.id === back.providerId) ? back.providerId : first?.id ?? '');
    setModel(back && providers.some((p) => p.id === back.providerId) ? back.model : '');
  };
  const here = providers.filter((p) => p.location === loc);
  const [options, setOptions] = useState(Object.keys(j.options).length ? JSON.stringify(j.options) : '');
  const [enabled, setEnabled] = useState(j.enabled);
  const [gameNight, setGameNight] = useState(j.gameNight);
  const [hasFb, setHasFb] = useState(!!j.fallback);
  const [fbProvider, setFbProvider] = useState(j.fallback?.providerId ?? '');
  const [fbModel, setFbModel] = useState(j.fallback?.model ?? '');
  const [allowCloud, setAllowCloud] = useState(!!j.fallback?.allowCloud);
  const [result, setResult] = useState<(TestResult & { what: string }) | null>(null);
  const a = useAction();
  const { toast, toastNode } = useToast();

  const main = providers.find((p) => p.id === providerId);
  const fb = providers.find((p) => p.id === fbProvider);
  const crossesToCloud = !!(hasFb && main && fb && main.location === 'local' && fb.location === 'cloud');

  const save = () => a.run(async () => {
    const fallback = hasFb && fbProvider ? { providerId: fbProvider, model: fbModel, allowCloud: crossesToCloud && allowCloud } : null;
    await client.request('PUT', '/api/admin/models', { jobs: { [j.job]: { providerId, model, options: options.trim() || '{}', enabled, gameNight, fallback } } });
    toast('Saved');
    onSaved();
  });
  const call = (what: string, path: string) => a.run(async () => {
    setResult(null);
    setResult({ what, ...(await client.request<TestResult>('POST', path, {})) });
  });

  return (
    <section className="card" aria-label={NAMES[j.job]} data-job={j.job}>
      <div className="row between">
        <div><div className="row"><h2 style={{ margin: 0 }}>{NAMES[j.job] ?? j.job}</h2><WhereChip l={loc} /></div><p className="muted small" style={{ margin: 0 }}>{j.uses}</p></div>
        <Switch checked={enabled} onChange={setEnabled} label={`${NAMES[j.job]} on`} />
      </div>
      <p className="tiny muted" style={{ margin: 0 }}>
        {j.source === 'saved' && 'Using these saved settings.'}
        {j.source === 'env' && `Using the server's environment settings (${j.effective?.baseUrl}).`}
        {j.source === 'chat' && `Using the ${j.job === 'vision' ? 'DM assistant (or Chat)' : 'Chat'} model${j.effective ? ` (${j.effective.model})` : ''}. Pick a provider and a model here to give this its own.`}
        {j.source === 'none' && (j.job === 'rerank' ? 'Not set. Search keeps its keyword order.' : 'No model set. Features that need it fall back or stay off.')}
      </p>

      <div className="row small" role="radiogroup" aria-label={`${NAMES[j.job]} runs`}>
        {(['local', 'cloud'] as Location[]).map((l) => (
          <button key={l} type="button" role="radio" aria-checked={loc === l} className={`btn small${loc === l ? ' on' : ''}`} onClick={() => pickLoc(l)} data-pick={l}>{l === 'local' ? 'Local' : 'Cloud'}</button>
        ))}
        <span className="tiny muted">{loc === 'local' ? 'On your own machines: world text stays here.' : 'A third party: world text leaves this server.'}</span>
      </div>
      <Field label="Provider" help={here.length === 0 ? `No ${loc} provider yet. Add one above.` : undefined}>
        <select value={providerId} onChange={(e) => setProviderId(e.target.value)} aria-label={`${NAMES[j.job]} provider`}>
          <option value="">(none: use the server's environment)</option>
          {here.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="Model name" help={providerId && !(models[providerId]?.length) ? 'Press Discover on the provider to pick from its models.' : undefined}>
        <ModelPick value={model} onChange={setModel} found={models[providerId] ?? []} label={`${NAMES[j.job]} model`} argos={main?.kind === 'argos'} />
      </Field>
      {status?.primary && <p className="small" style={{ margin: 0 }}>On {main?.name ?? 'the provider'}: <StatusChip s={status.primary} /></p>}
      <Field label="Extra options (JSON)" help={'Sent with every request, e.g. {"voice":"af_heart"}'}><input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="{}" /></Field>

      <div className="stack tight">
        <label className="row small"><input type="checkbox" checked={hasFb} onChange={(e) => setHasFb(e.target.checked)} aria-label={`${NAMES[j.job]} has a fallback`} /> Fallback: try another provider once when this one cannot answer</label>
        {hasFb && (
          <div className="stack tight" data-testid={`fallback-${j.job}`}>
            <Field label="Fallback provider">
              <select value={fbProvider} onChange={(e) => setFbProvider(e.target.value)} aria-label={`${NAMES[j.job]} fallback provider`}>
                <option value="">(pick one)</option>
                {providers.filter((p) => p.id !== providerId).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.location})</option>)}
              </select>
            </Field>
            {fb && <p className="small row" style={{ margin: 0 }} data-testid={`fallback-where-${j.job}`}>The fallback runs <WhereChip l={fb.location} /></p>}
            <Field label="Fallback model"><ModelPick value={fbModel} onChange={setFbModel} found={models[fbProvider] ?? []} label={`${NAMES[j.job]} fallback model`} argos={fb?.kind === 'argos'} /></Field>
            {crossesToCloud && (
              <label className="row small" style={{ alignItems: 'flex-start' }}>
                <input type="checkbox" checked={allowCloud} onChange={(e) => setAllowCloud(e.target.checked)} aria-label={`${NAMES[j.job]} allow cloud fallback`} />
                <span><strong>Allow falling back to the cloud.</strong> {CLOUD_WARNING} Without this the fallback is never used.</span>
              </label>
            )}
            {j.fallbackBlocked && <div className="error-box" role="status">The cloud fallback is saved but switched off, so it is not being used.</div>}
            {status?.fallback && <p className="small" style={{ margin: 0 }}>On {fb?.name ?? 'the fallback'}: <StatusChip s={status.fallback} /></p>}
            <p className="tiny muted" style={{ margin: 0 }}>Used after a connection error, a timeout, a 5xx, a model that is loading, unloaded or not found. Never after an error about the request itself.</p>
          </div>
        )}
      </div>

      {loc === 'local' && (
        <Field label="During a game session" help="Keep loaded: loaded when a session starts, held while it runs, unloaded after. See the Game night tab for what this server can do.">
          <select value={gameNight} onChange={(e) => setGameNight(e.target.value as 'hold' | 'ondemand')} aria-label={`${NAMES[j.job]} during a session`}>
            <option value="hold">Keep loaded</option>
            <option value="ondemand">Load when needed</option>
          </select>
        </Field>
      )}

      <ErrorBox error={a.error} />
      <div className="row">
        <button type="button" className="btn primary" onClick={save} disabled={a.busy}>Save</button>
        <button type="button" className="btn" onClick={() => call('Test', `/api/admin/models/${j.job}/test`)} disabled={a.busy}>Test</button>
        {j.fallback && <button type="button" className="btn" onClick={() => call('Fallback test', `/api/admin/models/${j.job}/test?which=fallback`)} disabled={a.busy}>Test fallback</button>}
        <button type="button" className="btn" onClick={() => call('Warm up', `/api/admin/models/${j.job}/warm`)} disabled={a.busy} data-testid={`warm-${j.job}`}>Warm up</button>
        {result && (
          <span role="status" className="small" data-testid={`test-${j.job}`}>
            {result.ok ? `${result.what}: OK in ${result.ms} ms${result.sample ? `: ${result.sample}` : ''}` : `${result.what} failed: ${result.error}`}
          </span>
        )}
      </div>
      {toastNode}
    </section>
  );
}

type Tab = 'setup' | 'session' | 'memory' | 'embeddings' | 'calls';
const TABS: [Tab, string][] = [['setup', 'Providers & jobs'], ['session', 'Game night'], ['memory', 'GPU & queue'], ['embeddings', 'Embeddings'], ['calls', 'Gateway calls']];

export default function ModelsPage() {
  const { client } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS.find(([id]) => id === params.get('tab'))?.[0]) ?? 'setup';
  const pick = (id: Tab) => { const next = new URLSearchParams(params); next.set('tab', id); setParams(next, { replace: true }); };
  const data = useLoad(() => client.request<All>('GET', '/api/admin/models'), []);
  const [status, setStatus] = useState<Status | null>(null);
  const [models, setModels] = useState<Record<string, Found[]>>({});
  const [statusError, setStatusError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    setStatusError(null);
    try { setStatus(await client.request<Status>('GET', '/api/admin/models/status')); } catch (e: any) { setStatusError(String(e?.message ?? e)); }
  }, [client]);
  const providers = data.data?.providers ?? [];
  const jobs = [...(data.data?.jobs ?? [])].sort((a, b) => JOB_ORDER.indexOf(a.job) - JOB_ORDER.indexOf(b.job));
  const signature = providers.map((p) => p.id).join(',') + '|' + jobs.map((j) => `${j.providerId}:${j.model}`).join(',');
  // Asks each provider which models it has loaded (a model list, never a generation): only while this page is open.
  useEffect(() => { if (data.data && (tab === 'setup' || tab === 'session')) void refreshStatus(); }, [signature, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = () => void data.reload();
  const remember = (id: string, d: Discovery) => setModels((m) => ({ ...m, [id]: d.models }));
  // Fill every job's model dropdown on open: ask each saved provider for its models once.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const p of data.data?.providers ?? []) {
      if (asked.current.has(p.id)) continue;
      asked.current.add(p.id);
      client.request<Discovery>('POST', '/api/admin/models/discover', { providerId: p.id })
        .then((d) => { if (d.ok && d.models.length) remember(p.id, d); }).catch(() => {});
    }
  }, [data.data, client]);

  return (
    <div className="page models-page">
      <PageHead title="Models" lead="Which model does each job, and what happens to the models around a game session.">
        <button type="button" className="btn small" onClick={() => void refreshStatus()}>Refresh status</button>
      </PageHead>
      <Tabs label="Models sections" value={tab} onChange={pick} items={TABS} />
      <ErrorBox error={data.error} />
      <ErrorBox error={statusError} />
      {data.loading && !data.data ? <Loading /> : (
        <div role="tabpanel" aria-label={TABS.find(([id]) => id === tab)?.[1]} className="stack" key={tab}>
          {tab === 'setup' && (
            <>
              <p className="muted small" style={{ margin: 0 }}>Providers are where models live; each job picks a provider and a model, and can fall back to another. Save first, then Test.</p>
              <h2 style={{ marginBottom: 0 }}>Providers</h2>
              <ArgosPreset jobs={jobs} onDone={reload} />
              {providers.map((p) => <ProviderCard key={p.id + p.name + p.baseUrl + p.location + p.apiKey} p={p} onChanged={reload} onFound={remember} />)}
              <AddProvider onDone={reload} />
              <h2 style={{ marginBottom: 0 }}>Jobs</h2>
              {jobs.map((j) => <JobRow key={JSON.stringify(j) + providers.length} j={j} providers={providers} models={models} status={status?.jobs[j.job]} onSaved={reload} />)}
            </>
          )}
          {tab === 'session' && <GameNightCard jobs={jobs} providers={providers} status={status?.jobs} onChanged={() => { void refreshStatus(); reload(); }} />}
          {tab === 'memory' && (
            <>
              <VramCard refreshKey={signature} />
              <QueueCard />
            </>
          )}
          {tab === 'embeddings' && <EmbeddingsCard />}
          {tab === 'calls' && <GatewayLogCard />}
        </div>
      )}
    </div>
  );
}

/**
 * The queue in front of each model, live: how many requests run now and how many wait. Waiting requests go in order:
 * the live transcript, then the DM and Active mode, then players, then background work. Set a job's maxConcurrent
 * option to change how many run at once (a local model takes 2, a cloud one 8).
 */
function QueueCard() {
  const { client } = useAuth();
  const [rows, setRows] = useState<{ server: string; model: string; max: number; running: number; waiting: number }[] | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => client.request<{ models: any[] }>('GET', '/api/admin/models/queue').then((r) => { if (alive) setRows(r.models); }).catch(() => {});
    void tick();
    const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [client]);
  const busy = (rows ?? []).filter((r) => r.running || r.waiting);
  return (
    <div className="card" data-testid="model-queue">
      <div className="row between"><strong>Requests to the models</strong><span className="muted small">{busy.length ? `${busy.reduce((n, r) => n + r.waiting, 0)} waiting` : 'nothing waiting'}</span></div>
      <p className="muted small" style={{ margin: '4px 0 8px' }}>Live. When more people ask than a model takes at once, the rest wait here: the live transcript first, then the DM and Active mode, then players, then background work. A job's <code>maxConcurrent</code> option sets how many run at once (local 2, cloud 8).</p>
      {!rows ? <p className="muted small">Loading…</p> : !rows.length ? <p className="muted small">No model has been asked anything since the server started.</p> : (
        <table className="table">
          <thead><tr><th>Model</th><th>Running</th><th>Waiting</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.server + r.model}><td>{r.model}<div className="muted small">{r.server}</div></td><td>{r.running} / {r.max}</td><td>{r.waiting ? <strong>{r.waiting}</strong> : 0}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}
