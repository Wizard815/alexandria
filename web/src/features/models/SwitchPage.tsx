// DM → Setup → Models: the model behind each AI role and its backup, changed from the table when one goes down.
// The same settings as Admin → Models (one set for the whole server); the admin decides how far a DM may go.
import { useState } from 'react';
import { ErrorBox, Field, Loading, PageHead, useAction, useToast } from '../../ui/index.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { ROLE_USES, onWhat, roleName, type JobHealth } from './roles.ts';

type Access = 'off' | 'switch' | 'setup';
type Location = 'local' | 'cloud';
interface Provider { id: string; name: string; kind: string; location: Location; hasKey: boolean }
interface Role {
  job: string; follows: string | null; canFollow: string | null; fromEnv: boolean; providerId: string; model: string;
  effective: { model: string; provider: string | null; location: Location | null } | null;
  fallback: { providerId: string; model: string; location: Location | null; provider: string | null } | null;
  fallbackBlocked: boolean; health: JobHealth | null;
}
interface View { access: Access; roles: Role[]; providers: Provider[]; reembed?: boolean }
interface Found { id: string; status: string; tools?: boolean; vision?: boolean; reranker?: boolean; contextLength?: number | null }
interface TestResult { ok: boolean; ms: number; sample?: string; error?: string }

const KEEP_EMBED = 'nomic-embed-text-v1.5';
const Where = ({ l }: { l: Location | null }) => (l ? <span className={`chip ${l === 'cloud' ? 'red' : 'green'}`}>{l === 'cloud' ? 'cloud' : 'local'}</span> : null);
const HealthChip = ({ h }: { h: JobHealth | null }) => (!h ? <span className="chip green" data-health="ok">answering</span>
  : h.state === 'fallback' ? <span className="chip gold" data-health="fallback" title={h.error}>on its backup</span>
  : <span className="chip red" data-health="down" title={h.error}>not answering</span>);

/** The models one provider lists: a dropdown, or a text box when it lists none. */
function useModels() {
  const { w } = useWorld();
  const [lists, setLists] = useState<Record<string, { ok: boolean; error?: string; models: Found[] }>>({});
  const load = async (providerId: string) => {
    if (!providerId || lists[providerId]) return;
    const r = await w.call<{ ok: boolean; error?: string; models: Found[] }>('POST', '/models/switch/discover', { providerId }).catch((e: any) => ({ ok: false, error: String(e?.message ?? e), models: [] }));
    setLists((l) => ({ ...l, [providerId]: r }));
  };
  return { lists, load };
}

function ModelPick({ providerId, value, onChange, models, label }: { providerId: string; value: string; onChange: (v: string) => void; models: ReturnType<typeof useModels>; label: string }) {
  const l = models.lists[providerId];
  if (!providerId) return null;
  if (!l || !l.models.length) {
    return (
      <>
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="model name" aria-label={label} />
        {l && !l.ok && <span className="tiny muted">This provider did not list its models ({l.error}). Type the name.</span>}
      </>
    );
  }
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">(pick a model)</option>
      {value && !l.models.some((m) => m.id === value) && <option value={value}>{value} (not listed)</option>}
      {l.models.map((m) => <option key={m.id} value={m.id}>{m.id}{m.status === 'loaded' ? ' · loaded' : m.status === 'unloaded' ? ' · loads on request' : ''}</option>)}
    </select>
  );
}

function RoleCard({ r, v, onSaved, models }: { r: Role; v: View; onSaved: (v: View) => void; models: ReturnType<typeof useModels> }) {
  const { w } = useWorld();
  const [open, setOpen] = useState(false);
  const [pid, setPid] = useState(r.providerId);
  const [model, setModel] = useState(r.model);
  const [fpid, setFpid] = useState(r.fallback?.providerId ?? '');
  const [fmodel, setFmodel] = useState(r.fallback?.model ?? '');
  const [allowCloud, setAllowCloud] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [test, setTest] = useState<Record<string, TestResult | 'busy'>>({});
  const act = useAction();
  const { toast, toastNode } = useToast();
  const canChange = v.access !== 'off';
  const prov = (id: string) => v.providers.find((p) => p.id === id);
  const localToCloud = (prov(pid)?.location ?? r.effective?.location) === 'local' && prov(fpid)?.location === 'cloud';

  const start = () => {
    setOpen(true); setConfirm(null);
    void models.load(pid); void models.load(fpid);
  };
  const save = (confirmReindex = false) => act.run(async () => {
    try {
      const next = await w.call<View>('PUT', '/models/switch', {
        job: r.job, providerId: pid, model, fallback: fpid ? { providerId: fpid, model: fmodel || model, ...(localToCloud && v.access === 'setup' ? { allowCloud } : {}) } : null,
        ...(confirmReindex ? { confirmReindex: true } : {}),
      });
      onSaved(next);
      setOpen(false); setConfirm(null);
      toast(next.reembed ? 'Saved. Re-embed this world so search matches the new model.' : 'Saved');
    } catch (e: any) {
      if (e?.status === 409) { setConfirm(String(e.message)); return; }
      throw e;
    }
  });
  const follow = () => act.run(async () => { onSaved(await w.call<View>('PUT', '/models/switch', { job: r.job, follow: true })); setOpen(false); toast('Saved'); });
  const runTest = async (which: 'primary' | 'fallback') => {
    setTest((t) => ({ ...t, [which]: 'busy' }));
    const res = await w.call<TestResult>('POST', '/models/switch/test', { job: r.job, which }).catch((e: any) => ({ ok: false, ms: 0, error: String(e?.message ?? e) }));
    setTest((t) => ({ ...t, [which]: res }));
  };
  const TestLine = ({ which }: { which: 'primary' | 'fallback' }) => {
    const t = test[which];
    if (!t) return null;
    if (t === 'busy') return <span className="tiny muted">Testing…</span>;
    return t.ok ? <span className="tiny tb-ok">Answered in {(t.ms / 1000).toFixed(1)} s</span> : <span className="tiny tb-danger">{t.error}</span>;
  };

  return (
    <section className="card" data-role={r.job} aria-label={roleName(r.job)}>
      {toastNode}
      <div className="card-head">
        <div className="stack tight" style={{ minWidth: 0 }}>
          <strong>{roleName(r.job)}</strong>
          <span className="small muted">{ROLE_USES[r.job] ?? ''}</span>
        </div>
        <HealthChip h={r.health} />
      </div>
      <div className="row small" data-testid="role-now">
        {r.effective ? <><span>Model: <strong>{r.effective.model}</strong>{r.effective.provider ? <> on {r.effective.provider}</> : null}</span><Where l={r.effective.location} /></> : <span className="muted">No model set</span>}
        {r.follows && <span className="chip">same as {roleName(r.follows)}</span>}
        {r.fromEnv && <span className="chip" title="Set by the server’s environment. Picking one here wins.">from the server setup</span>}
      </div>
      <div className="row small">
        {r.fallback ? <span>Backup: <strong>{r.fallback.model}</strong>{r.fallback.provider ? <> on {r.fallback.provider}</> : null} <Where l={r.fallback.location} /></span> : !r.follows && <span className="muted">No backup. If this model goes down, the role stops until you pick another.</span>}
        {r.fallbackBlocked && <span className="chip red" title="A local role only falls back to a cloud provider when the admin allows it">cloud backup not allowed yet</span>}
      </div>
      {r.health && (
        <p className="small" role="status" style={{ margin: 0 }}>
          {r.health.state === 'fallback' ? <>{onWhat(r.health.model, r.health.provider)} stopped answering, so {onWhat(r.health.using, r.health.usingProvider)} is answering instead.</> : <>{onWhat(r.health.model, r.health.provider)} is not answering{r.fallback ? ', and neither is the backup' : ''}. Pick another model.</>}
        </p>
      )}
      {r.job === 'extra' && r.effective && r.effective.model !== KEEP_EMBED && !r.effective.model.includes('nomic-embed-text-v1.5') && (
        <p className="tiny muted" style={{ margin: 0 }}>The Historian is meant to stay on {KEEP_EMBED}.</p>
      )}
      <div className="row">
        {canChange && !open && <button type="button" className="btn small primary" onClick={start}>Change</button>}
        {r.effective && <button type="button" className="btn small" onClick={() => void runTest('primary')} disabled={test.primary === 'busy'}>Test</button>}
        {r.fallback && <button type="button" className="btn small" onClick={() => void runTest('fallback')} disabled={test.fallback === 'busy'}>Test backup</button>}
        <TestLine which="primary" /> <TestLine which="fallback" />
      </div>
      {open && (
        <div className="stack" data-testid="role-edit">
          {r.job === 'extra' && <p className="small tb-danger" style={{ margin: 0 }}>A new embeddings model means re-embedding the world: vectors from two models do not match. For a backup, pick the same model on another server.</p>}
          <Field label="Main model">
            <div className="row">
              <select value={pid} onChange={(e) => { setPid(e.target.value); setModel(''); void models.load(e.target.value); }} aria-label="Main provider">
                <option value="">(pick a provider)</option>
                {v.providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.location}</option>)}
              </select>
              <ModelPick providerId={pid} value={model} onChange={setModel} models={models} label="Main model" />
            </div>
          </Field>
          <Field label="Backup (used at once when the main one stops answering)">
            <div className="row">
              <select value={fpid} onChange={(e) => { setFpid(e.target.value); setFmodel(''); void models.load(e.target.value); }} aria-label="Backup provider">
                <option value="">No backup</option>
                {v.providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.location}</option>)}
              </select>
              <ModelPick providerId={fpid} value={fmodel} onChange={setFmodel} models={models} label="Backup model" />
            </div>
          </Field>
          {localToCloud && (v.access === 'setup'
            ? <label className="row small"><input type="checkbox" checked={allowCloud} onChange={(e) => setAllowCloud(e.target.checked)} /> Let world text go to this cloud provider when the local model is down</label>
            : <p className="tiny muted" style={{ margin: 0 }}>A cloud backup for a local model stays unused until the admin allows it.</p>)}
          {confirm && (
            <div className="error-box" role="alert">
              {confirm}
              <div className="row" style={{ marginTop: 8 }}>
                <button type="button" className="btn small primary" onClick={() => save(true)} disabled={act.busy}>Change it and re-index</button>
                <button type="button" className="btn small" onClick={() => setConfirm(null)}>Keep the current model</button>
              </div>
            </div>
          )}
          <ErrorBox error={act.error} />
          <div className="row">
            <button type="button" className="btn primary" onClick={() => save()} disabled={act.busy || !pid || !model.trim()}>Save</button>
            {r.canFollow && !r.follows && <button type="button" className="btn" onClick={follow} disabled={act.busy}>Same as {roleName(r.canFollow)}</button>}
            <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

function AddProvider({ onAdded }: { onAdded: (providers: Provider[]) => void }) {
  const { w } = useWorld();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [location, setLocation] = useState<Location>('local');
  const act = useAction();
  if (!open) return <button type="button" className="btn" onClick={() => setOpen(true)}><i className="fa-solid fa-plus" aria-hidden="true" /> Add a provider</button>;
  const add = () => act.run(async () => {
    const r = await w.call<{ providers: Provider[] }>('POST', '/models/switch/providers', { name, baseUrl, apiKey, location, kind: 'openai-compatible' });
    onAdded(r.providers);
    setOpen(false); setName(''); setBaseUrl(''); setApiKey('');
  });
  return (
    <section className="card" aria-label="Add a provider">
      <strong>Add a provider</strong>
      <p className="small muted" style={{ margin: 0 }}>Any OpenAI-compatible server: Argos, llama.cpp, Ollama, LM Studio, OpenRouter.</p>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Spare box" /></Field>
      <Field label="Address"><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://192.168.1.20:8080/v1" inputMode="url" aria-label="Provider address" /></Field>
      <Field label="API key (optional)" help="Stored on the server and never shown again."><input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" aria-label="Provider API key" /></Field>
      <Field label="Where it runs">
        <select value={location} onChange={(e) => setLocation(e.target.value as Location)} aria-label="Where it runs">
          <option value="local">Local: my machines</option>
          <option value="cloud">Cloud: world text leaves this server</option>
        </select>
      </Field>
      <ErrorBox error={act.error} />
      <div className="row">
        <button type="button" className="btn primary" onClick={add} disabled={act.busy || !baseUrl.trim()}>Add</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </section>
  );
}

export default function SwitchPage() {
  const { w } = useWorld();
  const v = useLoad(() => w.call<View>('GET', '/models/switch'), [w], ['models-health']);
  const models = useModels();
  const [reembed, setReembed] = useState(false);
  const act = useAction();
  const { toast, toastNode } = useToast();
  if (!v.data) return <div className="page"><PageHead title="Models" /><ErrorBox error={v.error} />{!v.error && <Loading />}</div>;
  const d = v.data;
  const saved = (next: View) => { v.setData(next); if (next.reembed) setReembed(true); };
  const doReembed = () => act.run(async () => { await w.call('POST', '/search/reembed'); setReembed(false); toast('Re-embedding the world. Search is keyword only until it is done.'); });
  return (
    <div className="page stack loose">
      {toastNode}
      <PageHead title="Models" lead="The model behind each AI role, and a backup that takes over at once when one goes down. These are the server’s settings, so every world on it uses them." />
      {d.access === 'off' && <p className="small muted">The admin has not let DMs change models. You can still test them here.</p>}
      {d.access === 'switch' && <p className="small muted">You can pick any provider the admin added. Adding providers is up to the admin.</p>}
      {reembed && (
        <div className="card gold" role="status">
          <strong>Re-embed this world</strong>
          <span className="small">The Historian has a new model, so the search index no longer matches. Re-embedding reads every page again in the background.</span>
          <ErrorBox error={act.error} />
          <div className="row"><button type="button" className="btn primary" onClick={doReembed} disabled={act.busy}>Re-embed this world</button></div>
        </div>
      )}
      {d.roles.map((r) => <RoleCard key={`${r.job}:${r.providerId}:${r.model}:${r.fallback?.model ?? ''}`} r={r} v={d} onSaved={saved} models={models} />)}
      {d.access === 'setup' && <AddProvider onAdded={(providers) => v.setData({ ...d, providers })} />}
      <p className="tiny muted">Speech, voice and per-model options are in Admin → Models.</p>
    </div>
  );
}
