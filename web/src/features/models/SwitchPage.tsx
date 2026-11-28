// DM → Setup → Models: the model behind each AI role and its backup, changed from the table when one goes down.
// The same settings as Admin → Models (one set for the whole server); the admin decides how far a DM may go.
import { useEffect, useState } from 'react';
import { ErrorBox, Field, Loading, Modal, PageHead, useAction, useToast } from '../../ui/index.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { ROLE_USES, onWhat, roleName, type JobHealth } from './roles.ts';

type Access = 'off' | 'switch' | 'setup';
type Location = 'local' | 'cloud';
interface Provider { id: string; name: string; kind: string; location: Location; hasKey: boolean; mine?: boolean }
interface Role {
  job: string; follows: string | null; canFollow: string | null; fromEnv: boolean; providerId: string; model: string;
  effective: { model: string; provider: string | null; location: Location | null } | null;
  fallback: { providerId: string; model: string; location: Location | null; provider: string | null } | null;
  fallbackBlocked: boolean; health: JobHealth | null;
}
interface View { access: Access; providerRules?: { cloud: boolean; local: boolean }; roles: Role[]; providers: Provider[]; reembed?: boolean }
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

const OTHER = '\u0000other';
// Always a dropdown. A provider that lists its models gives those; one that cannot be reached (or lists none) gives the
// models already in use and the ones other providers list, and "Another model…" opens a box to type a name.
function ModelPick({ providerId, value, onChange, models, label, known }: { providerId: string; value: string; onChange: (v: string) => void; models: ReturnType<typeof useModels>; label: string; known: string[] }) {
  const [typing, setTyping] = useState(false);
  const l = models.lists[providerId];
  if (!providerId) return null;
  if (!l) return <select disabled aria-label={label}><option>Loading the models…</option></select>;
  const listed = l.models.map((m) => ({ id: m.id, note: m.status === 'loaded' ? ' · loaded' : m.status === 'unloaded' ? ' · loads on request' : '' }));
  const elsewhere = listed.length ? [] : [...new Set([...known, ...Object.values(models.lists).flatMap((x) => x.models.map((m) => m.id))])].filter(Boolean).sort();
  const ids = new Set([...listed.map((m) => m.id), ...elsewhere]);
  return (
    <>
      <select value={typing ? OTHER : value} onChange={(e) => { if (e.target.value === OTHER) { setTyping(true); onChange(''); } else { setTyping(false); onChange(e.target.value); } }} aria-label={label}>
        <option value="">(pick a model)</option>
        {value && !ids.has(value) && !typing && <option value={value}>{value}{listed.length ? ' (not listed)' : ''}</option>}
        {listed.map((m) => <option key={m.id} value={m.id}>{m.id}{m.note}</option>)}
        {elsewhere.length > 0 && <optgroup label="Not listed by this provider">{elsewhere.map((id) => <option key={id} value={id}>{id}</option>)}</optgroup>}
        <option value={OTHER}>Another model…</option>
      </select>
      {typing && <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="model name, e.g. qwen3-1.7b" aria-label={`${label} name`} autoFocus />}
      {!l.ok && <span className="tiny muted">This provider did not answer ({l.error}), so it could not list its models.</span>}
    </>
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
  // Models the roles already use: offered when a provider cannot list its own.
  const known = v.roles.flatMap((x) => [x.effective?.model ?? '', x.fallback?.model ?? '']);
  const prov = (id: string) => v.providers.find((p) => p.id === id);
  const localToCloud = (prov(pid)?.location ?? r.effective?.location) === 'local' && prov(fpid)?.location === 'cloud';

  const start = () => {
    // The editor starts from the role as it is now; a reload while it is open (models-health) keeps the edit.
    setPid(r.providerId); setModel(r.model); setFpid(r.fallback?.providerId ?? ''); setFmodel(r.fallback?.model ?? '');
    setOpen(true); setConfirm(null);
    for (const p of v.providers) void models.load(p.id);
  };
  const save = (confirmReindex = false) => act.run(async () => {
    try {
      const next = await w.call<View>('PUT', '/models/switch', {
        job: r.job, providerId: pid, model, fallback: fpid ? { providerId: fpid, model: fmodel || model, ...(localToCloud && v.access === 'setup' ? { allowCloud } : {}) } : null,
        ...(confirmReindex ? { confirmReindex: true } : {}),
      });
      onSaved(next);
      setOpen(false); setConfirm(null);
      toast(next.reembed ? 'Saved. Every world is being embedded again; the story bible keeps its facts.' : 'Saved');
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
          <strong style={{ fontSize: 17 }}>{roleName(r.job)}</strong>
          <span className="small muted">{ROLE_USES[r.job] ?? ''}</span>
        </div>
        <HealthChip h={r.health} />
      </div>
      <div className="row" data-testid="role-now">
        {r.effective ? <><span>Model: <strong>{r.effective.model}</strong>{r.effective.provider ? <> on {r.effective.provider}</> : null}</span><Where l={r.effective.location} /></> : <span className="muted">No model set</span>}
        {r.follows && <span className="chip">same as {roleName(r.follows)}</span>}
        {r.fromEnv && <span className="chip" title="Set by the server’s environment. Picking one here wins.">from the server setup</span>}
      </div>
      <div className="row">
        {r.fallback ? <span>Backup: <strong>{r.fallback.model}</strong>{r.fallback.provider ? <> on {r.fallback.provider}</> : null} <Where l={r.fallback.location} /></span> : !r.follows && <span className="muted">No backup. If this model goes down, the role stops until you pick another.</span>}
        {r.fallbackBlocked && <span className="chip red" title="A local role only falls back to a cloud provider when the admin allows it">cloud backup not allowed yet</span>}
      </div>
      {r.health && (
        <p role="status" style={{ margin: 0 }}>
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
          {r.job === 'extra' && <p className="small tb-danger" style={{ margin: 0 }}>A new embeddings model means re-embedding every world: vectors from two models do not match. You are asked first, and the story bible keeps its facts. For a backup, pick the same model on another server.</p>}
          <Field label="Main model">
            <div className="row">
              <select value={pid} onChange={(e) => { setPid(e.target.value); setModel(''); void models.load(e.target.value); }} aria-label="Main provider">
                <option value="">(pick a provider)</option>
                {v.providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.location}{p.mine ? ' · yours' : ''}</option>)}
              </select>
              <ModelPick providerId={pid} value={model} onChange={setModel} models={models} label="Main model" known={known} />
            </div>
          </Field>
          <Field label="Backup (used at once when the main one stops answering)">
            <div className="row">
              <select value={fpid} onChange={(e) => { setFpid(e.target.value); setFmodel(''); void models.load(e.target.value); }} aria-label="Backup provider">
                <option value="">No backup</option>
                {v.providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.location}{p.mine ? ' · yours' : ''}</option>)}
              </select>
              <ModelPick providerId={fpid} value={fmodel} onChange={setFmodel} models={models} label="Backup model" known={known} />
            </div>
          </Field>
          {localToCloud && (v.access === 'setup'
            ? <label className="row small"><input type="checkbox" checked={allowCloud} onChange={(e) => setAllowCloud(e.target.checked)} /> Let world text go to this cloud provider when the local model is down</label>
            : <p className="tiny muted" style={{ margin: 0 }}>A cloud backup for a local model stays unused until the admin allows it.</p>)}
          {confirm && (
            <div className="error-box" role="alert">
              {confirm}
              <div className="row" style={{ marginTop: 8 }}>
                <button type="button" className="btn small primary" onClick={() => save(true)} disabled={act.busy}>Change it and re-embed every world</button>
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

/** A phone: true under 600 px wide (the role list becomes a grid of squares). */
function useNarrow() {
  const q = '(max-width: 600px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    // Settle first: a passing resize (a full-page screenshot, a keyboard opening) must not swap the cards for squares
    // and throw away an edit in progress.
    let t: ReturnType<typeof setTimeout> | undefined;
    const f = () => { clearTimeout(t); t = setTimeout(() => setNarrow(m.matches), 300); };
    m.addEventListener('change', f);
    return () => { clearTimeout(t); m.removeEventListener('change', f); };
  }, []);
  return !!narrow;
}

const tone = (r: Role) => (!r.effective ? 'none' : !r.health ? 'ok' : r.health.state === 'fallback' ? 'backup' : 'down');
const TONE_STYLE: Record<string, React.CSSProperties> = {
  ok: { background: 'color-mix(in srgb, var(--ok) 35%, var(--panel))', borderColor: 'var(--ok)' },
  backup: { background: 'color-mix(in srgb, var(--accent) 35%, var(--panel))', borderColor: 'var(--accent)' },
  down: { background: 'color-mix(in srgb, var(--danger) 40%, var(--panel))', borderColor: 'var(--danger)' },
  none: { background: 'var(--panel)', borderColor: 'var(--line)' },
};
const TONE_TEXT: Record<string, string> = { ok: 'answering', backup: 'on backup', down: 'down', none: 'not set' };

/** On a phone: one square per role, green when it answers, gold on its backup, red when down. Tap for the card. */
function RoleGrid({ d, onPick }: { d: View; onPick: (job: string) => void }) {
  return (
    <div data-testid="role-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8 }}>
      {d.roles.map((r) => (
        <button key={r.job} type="button" data-role-square={r.job} data-tone={tone(r)} onClick={() => onPick(r.job)} aria-label={`${roleName(r.job)}: ${TONE_TEXT[tone(r)]}`}
          style={{ border: '2px solid', ...TONE_STYLE[tone(r)], aspectRatio: '1', borderRadius: 12, fontFamily: 'inherit', color: 'var(--text)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: 6, fontWeight: 700, fontSize: 15, textAlign: 'center' }}>
          {roleName(r.job).replace(' (default)', '')}
          <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.85 }}>{TONE_TEXT[tone(r)]}</span>
        </button>
      ))}
    </div>
  );
}

export default function SwitchPage() {
  const { w } = useWorld();
  // A change in Admin → Models (or by another DM) reloads this page: models-changed.
  const v = useLoad(() => w.call<View>('GET', '/models/switch'), [w], ['models-health', 'models-changed']);
  const models = useModels();
  const [reembed, setReembed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const narrow = useNarrow();
  const act = useAction();
  const { toast, toastNode } = useToast();
  if (!v.data) return <div className="page"><PageHead title="Models" /><ErrorBox error={v.error} />{!v.error && <Loading />}</div>;
  const d = v.data;
  const saved = (next: View) => { v.setData(next); if (next.reembed) setReembed(true); };
  const rules = d.providerRules;
  const denied = rules && (!rules.cloud || !rules.local) ? (!rules.cloud && !rules.local ? 'any of the admin’s providers' : `the admin’s ${!rules.cloud ? 'cloud' : 'local'} providers`) : null;
  const card = (r: Role) => <RoleCard key={r.job} r={r} v={d} onSaved={saved} models={models} />;
  const picked = d.roles.find((r) => r.job === open);
  return (
    <div className="page stack loose">
      {toastNode}
      <PageHead title="Models" lead="The model behind each AI role, and a backup that takes over at once when one goes down. The same settings as Admin → Models, so every world on this server uses them." />
      {d.access === 'off' && <p className="small muted">The admin has not let GMs change models. You can still test them here.</p>}
      {d.access === 'switch' && <p className="small muted">You can pick any provider the admin allows. Adding providers is up to the admin.</p>}
      {denied && <p className="small muted" data-testid="denied-note">The admin does not let GMs use {denied}.{d.access === 'setup' ? ' Add your own below, local or cloud.' : ''}</p>}
      {reembed && <p className="small" role="status" data-testid="reembedding">Every world is being embedded again with the new model. Search uses keywords until it is done; the story bible keeps its facts.</p>}
      {narrow ? <RoleGrid d={d} onPick={setOpen} /> : d.roles.map(card)}
      {narrow && picked && <Modal title={roleName(picked.job)} onClose={() => setOpen(null)}>{card(picked)}</Modal>}
      {d.access === 'setup' && <AddProvider onAdded={(providers) => v.setData({ ...d, providers })} />}
      <p className="tiny muted">Speech, voice and per-model options are in Admin → Models.</p>
    </div>
  );
}
