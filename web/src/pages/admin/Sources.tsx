// World sources: where each world's library comes from. Every connector the
// librarian knows (LegendKeeper, Kanka, Markdown vaults, git, MCP file
// servers, any JSON API) describes its own settings, and the forms here are
// built from that description. Imports are read-only.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead, Switch, useAction, useToast } from '../../ui/index.tsx';

interface ConfigField {
  key: string; label: string; type: 'text' | 'password' | 'url' | 'number' | 'boolean' | 'select' | 'textarea';
  required?: boolean; help?: string; placeholder?: string; options?: [string, string][]; secret?: boolean; default?: unknown; showIf?: Record<string, unknown>;
}
interface Connector { id: string; label: string; description?: string; fields: ConfigField[]; capabilities?: string[]; push?: boolean }
interface Stats { pages?: number; shared?: number; dmOnly?: number; removed?: number; skipped?: number; records?: number }
interface PushKey { id: string; label: string; prefix: string; created_at: string; last_used_at: string | null; revoked: boolean }
interface Run { id: string; status: 'running' | 'ok' | 'error' | 'stopped'; started_at: string; finished_at: string | null; stats: Stats; error: string | null; log?: string }
interface Source {
  id: string; world_id: string; kind: string; connector: { id: string; label: string } | null; name: string; config: Record<string, any>;
  default_visibility: 'dm' | 'party'; schedule_minutes: number | null; enabled: boolean; running: boolean;
  last_sync_at: string | null; last_status: string | null; last_run: Run | null; pages: number;
}

const SECRET = '••••';
const CAP_LABELS: Record<string, string> = { pages: 'Pages', properties: 'Facts', tags: 'Tags', images: 'Images', relations: 'Relations', timelines: 'Timelines', maps: 'Maps', calendars: 'Calendars', items: 'Items', characters: 'Characters' };
function Capabilities({ c }: { c?: Connector }) {
  if (!c?.capabilities?.length) return null;
  return <span className="row wrap tiny" style={{ gap: 4 }} aria-label="What this source provides">{c.capabilities.map((k) => <span key={k} className="chip">{CAP_LABELS[k] ?? k}</span>)}</span>;
}
const SCHEDULES: [string, string][] = [['', 'Only when I press Sync'], ['15', 'Every 15 minutes'], ['60', 'Every hour'], ['360', 'Every 6 hours'], ['1440', 'Every day'], ['10080', 'Every week']];

export default function AdminSources() {
  const { client } = useAuth();
  const api = <T = any,>(method: string, path: string, body?: unknown) => client.request<T>(method, `/api/admin${path}`, body);
  const worlds = useLoad(() => api<any[]>('GET', '/worlds'), []);
  const connectors = useLoad(() => api<Connector[]>('GET', '/connectors'), []);
  const [world, setWorld] = useState('');
  const wid = world || worlds.data?.[0]?.id || '';
  const sources = useLoad(() => (wid ? api<Source[]>('GET', `/worlds/${wid}/sources`) : Promise.resolve([] as Source[])), [wid]);
  const [editing, setEditing] = useState<Source | 'new' | null>(null);
  const { toast, toastNode } = useToast();

  // While anything syncs, refresh the list so the cards show live numbers.
  const anyRunning = !!sources.data?.some((s) => s.running);
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void sources.reload(), 1500);
    return () => clearInterval(t);
  }, [anyRunning, sources]);

  const byId = useMemo(() => new Map((connectors.data ?? []).map((c) => [c.id, c])), [connectors.data]);

  return (
    <div className="page">
      <PageHead title="World sources" lead="Where a world's library comes from. The librarian only reads from a source; nothing is ever written back. Anything hidden there stays DM-only here, and anything without a clear mark is DM-only too.">
        {!!worlds.data?.length && <button type="button" className="btn primary" onClick={() => setEditing('new')}>Add a source</button>}
      </PageHead>
      <ErrorBox error={worlds.error || sources.error || connectors.error} />
      {worlds.loading && !worlds.data ? <Loading /> : !worlds.data?.length ? <div className="card"><p className="muted">Make a world first.</p></div> : (
        <>
          <Field label="World"><select aria-label="World" value={wid} onChange={(e) => setWorld(e.target.value)} style={{ maxWidth: 320 }}>{worlds.data.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
          <div className="stack">
            {(sources.data ?? []).map((s) => <SourceCard key={s.id} s={s} connector={byId.get(s.kind)} onEdit={() => setEditing(s)} onChanged={() => void sources.reload()} toast={toast} />)}
            {!sources.loading && !sources.data?.length && <div className="card"><Empty>No sources for this world yet. The DM can also write pages in the Library.</Empty></div>}
          </div>
          <HowSecretsWork />
        </>
      )}
      {editing && connectors.data && (
        <SourceForm worldId={wid} connectors={connectors.data} source={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
          onDone={(msg) => { setEditing(null); toast(msg); void sources.reload(); }} />
      )}
      {toastNode}
    </div>
  );
}

function StatLine({ st }: { st: Stats }) {
  return (
    <span className="row wrap small" style={{ gap: 10 }}>
      <span><strong>{st.pages ?? 0}</strong> pages</span>
      <span className="chip teal">{st.shared ?? 0} shared</span>
      <span className="chip red">{st.dmOnly ?? 0} DM-only</span>
      {!!st.removed && <span className="muted">{st.removed} removed</span>}
      {!!st.skipped && <span className="muted">{st.skipped} skipped</span>}
      {!!st.records && <span className="muted">{st.records} relations, timelines, calendars and markers</span>}
    </span>
  );
}

const statusChip = (st: string | null | undefined) => (st === 'ok' ? 'green' : st === 'error' ? 'red' : st === 'running' ? 'gold' : '');
const duration = (r: Run) => {
  const ms = Date.parse(r.finished_at ?? new Date().toISOString()) - Date.parse(r.started_at);
  return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`;
};

function SourceCard({ s, connector, onEdit, onChanged, toast }: { s: Source; connector?: Connector; onEdit: () => void; onChanged: () => void; toast: (m: string) => void }) {
  const { client } = useAuth();
  const api = <T = any,>(method: string, path: string, body?: unknown) => client.request<T>(method, `/api/admin${path}`, body);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  const [logRun, setLogRun] = useState<Run | null>(null);
  const [del, setDel] = useState(false);
  const a = useAction();

  const loadRuns = () => api<Run[]>('GET', `/sources/${s.id}/runs?limit=20`).then(setRuns).catch(() => {});
  useEffect(() => { if (showRuns || s.running) void loadRuns(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [showRuns, s.running, s.last_sync_at]);

  const sync = () => a.run(async () => { await api('POST', `/sources/${s.id}/sync`); toast(`Syncing ${s.name}…`); onChanged(); });
  const stop = () => a.run(async () => { await api('POST', `/sources/${s.id}/stop`); onChanged(); });
  const test = () => a.run(async () => { const r = await api<{ ok: boolean; message: string }>('POST', `/sources/${s.id}/test`); toast(`${r.ok ? '✓' : '✗'} ${r.message}`); });
  const toggle = (enabled: boolean) => a.run(async () => { await api('PATCH', `/sources/${s.id}`, { enabled }); onChanged(); });
  const live = s.running ? (runs?.find((r) => r.status === 'running') ?? s.last_run) : null;
  const last = s.last_run;

  return (
    <div className="card">
      <div className="card-head">
        <div className="stack tight grow" style={{ minWidth: 0 }}>
          <strong style={{ fontSize: 16 }}>{s.name}</strong>
          <span className="tiny muted">{s.connector?.label ?? s.kind} · {s.pages} page{s.pages === 1 ? '' : 's'} · {connector?.push ? 'pushed by your tool' : SCHEDULES.find(([k]) => k === String(s.schedule_minutes ?? ''))?.[1] ?? `every ${s.schedule_minutes} min`}</span>
        </div>
        <span className={`chip ${s.running ? 'gold' : statusChip(last?.status)}`}>{s.running ? 'syncing' : last?.status ?? 'never synced'}</span>
      </div>
      <Capabilities c={connector} />
      {s.running && live ? (
        <div className="stack tight" role="status"><span className="small">Syncing… <StatLine st={live.stats} /></span></div>
      ) : last ? (
        <div className="row wrap small muted"><span>Last sync {when(last.finished_at ?? last.started_at)} ({duration(last)})</span><StatLine st={last.stats} /></div>
      ) : null}
      {!s.running && last?.status === 'error' && <ErrorBox error={last.error} />}
      <div className="row small muted wrap">
        <span>Players see: {s.default_visibility === 'party' ? 'what the source shows its players' : 'nothing until a page is marked shared (DM-only)'}</span>
        {connector?.fields.some((f) => f.key === 'trustPostVisibility') && <span>· Posts: {s.config.trustPostVisibility ? 'Kanka visibility' : 'all DM-only'}</span>}
      </div>
      <div className="row wrap">
        {connector?.push ? null : s.running
          ? <button type="button" className="btn small danger" disabled={a.busy} onClick={() => void stop()}>Stop</button>
          : <button type="button" className="btn primary small" disabled={a.busy || !s.enabled} onClick={() => void sync()}>Sync now</button>}
        <button type="button" className="btn small" disabled={a.busy} onClick={() => void test()}>Test connection</button>
        <button type="button" className="btn small" onClick={onEdit}>Settings</button>
        <button type="button" className={`btn small${showRuns ? ' on' : ''}`} aria-expanded={showRuns} onClick={() => setShowRuns(!showRuns)}>History</button>
        <span className="grow" />
        <label className="row small"><Switch checked={s.enabled} onChange={(v) => void toggle(v)} label={`${s.name} enabled`} /> {s.enabled ? 'On' : 'Off'}</label>
        <button type="button" className="btn small danger" onClick={() => setDel(true)}>Remove</button>
      </div>
      <ErrorBox error={a.error} />
      {connector?.push && <PushKeys s={s} toast={toast} />}
      {showRuns && (
        runs === null ? <Loading /> : runs.length ? (
          <div className="table-wrap" style={{ overflowX: 'auto' }}>
            <table className="table small">
              <thead><tr><th>Started</th><th>Status</th><th>Took</th><th>Pages</th><th>Shared</th><th>DM-only</th><th>Removed</th><th>Skipped</th><th /></tr></thead>
              <tbody>{runs.map((r) => (
                <tr key={r.id}>
                  <td>{when(r.started_at)}</td><td><span className={`chip ${statusChip(r.status)}`}>{r.status}</span></td><td>{duration(r)}</td>
                  <td>{r.stats.pages ?? 0}</td><td>{r.stats.shared ?? 0}</td><td>{r.stats.dmOnly ?? 0}</td><td>{r.stats.removed ?? 0}</td><td>{r.stats.skipped ?? 0}</td>
                  <td><button type="button" className="btn small" onClick={() => void api<Run>('GET', `/runs/${r.id}`).then(setLogRun)}>Log</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="small muted">No syncs yet.</p>
      )}
      {logRun && (
        <Modal title={`Sync log · ${when(logRun.started_at)}`} onClose={() => setLogRun(null)}>
          <div className="stack">
            <StatLine st={logRun.stats} />
            {logRun.error && <ErrorBox error={logRun.error} />}
            <pre className="code" style={{ maxHeight: '55vh', overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}>{logRun.log || 'No log lines.'}</pre>
          </div>
        </Modal>
      )}
      {del && <DeleteSource s={s} onClose={() => setDel(false)} onDone={() => { setDel(false); toast(`Removed ${s.name}`); onChanged(); }} />}
    </div>
  );
}

/** The endpoint a push tool calls, and the keys that may call it. A key is shown once, when it is made. */
function PushKeys({ s, toast }: { s: Source; toast: (m: string) => void }) {
  const { client } = useAuth();
  const [keys, setKeys] = useState<PushKey[] | null>(null);
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<{ key: string; label: string } | null>(null);
  const a = useAction();
  const base = `/api/admin/intake/sources/${s.id}/keys`;
  const load = () => client.request<PushKey[]>('GET', base).then(setKeys).catch(() => setKeys([]));
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [s.id]);
  const endpoint = `${window.location.origin}/api/intake/${s.id}/entries`;
  const create = () => a.run(async () => {
    const k = await client.request<PushKey & { key: string }>('POST', base, { label: label.trim() || 'Push key' });
    setFresh({ key: k.key, label: k.label });
    setLabel('');
    await load();
  });
  const revoke = (k: PushKey) => a.run(async () => { await client.request('DELETE', `/api/admin/intake/keys/${k.id}`); toast(`Revoked ${k.label}`); await load(); });
  const copy = (t: string) => { void navigator.clipboard?.writeText(t).then(() => toast('Copied'), () => toast('Select the text and copy it')); };
  const active = (keys ?? []).filter((k) => !k.revoked);
  return (
    <div className="stack tight">
      <div className="small"><strong>Endpoint</strong> <code className="mono" style={{ overflowWrap: 'anywhere' }}>POST {endpoint}</code> <button type="button" className="btn small" onClick={() => copy(endpoint)}>Copy</button></div>
      <p className="tiny muted" style={{ margin: 0 }}>Send <span className="mono">{'{ "entries": [ ... ] }'}</span> with <span className="mono">Authorization: Bearer alx_push_…</span>. A key writes to this source only and can read nothing. Entries are DM-only unless they say <span className="mono">"visibility": "party"</span> and “Share what the source shares” is on.</p>
      {active.length ? (
        <ul className="stack tight" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {active.map((k) => (
            <li key={k.id} className="row between small">
              <span><strong>{k.label}</strong> <span className="mono muted">{k.prefix}…</span> <span className="muted">· {k.last_used_at ? `last used ${when(k.last_used_at)}` : 'never used'}</span></span>
              <button type="button" className="btn small danger" disabled={a.busy} onClick={() => void revoke(k)}>Revoke</button>
            </li>
          ))}
        </ul>
      ) : keys ? <p className="small muted" style={{ margin: 0 }}>No keys yet. Make one for your tool.</p> : null}
      <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <input aria-label="Key name" placeholder="Key name, e.g. my sync script" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} style={{ maxWidth: 260 }} />
        <button className="btn small" disabled={a.busy}>Make a key</button>
      </form>
      <ErrorBox error={a.error} />
      {fresh && (
        <Modal title={`Source key · ${fresh.label}`} onClose={() => setFresh(null)}>
          <div className="stack">
            <p>Copy this key now. It is not stored and can't be shown again; if you lose it, revoke it and make another.</p>
            <input readOnly className="mono" value={fresh.key} aria-label="New source key" onFocus={(e) => e.target.select()} />
            <div className="row end"><button type="button" className="btn" onClick={() => copy(fresh.key)}>Copy</button><button type="button" className="btn primary" onClick={() => setFresh(null)}>Done</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function DeleteSource({ s, onClose, onDone }: { s: Source; onClose: () => void; onDone: () => void }) {
  const { client } = useAuth();
  const [pages, setPages] = useState(false);
  const a = useAction();
  return (
    <Modal title={`Remove ${s.name}?`} onClose={onClose}>
      <div className="stack">
        <p>The librarian stops reading from this source. Nothing in the source itself changes.</p>
        <label className="row small"><Switch checked={pages} onChange={setPages} label="Also delete its pages" /> Also delete the {s.pages} page{s.pages === 1 ? '' : 's'} it imported. Off: they stay in the library as they are.</label>
        <ErrorBox error={a.error} />
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn danger" disabled={a.busy} onClick={() => void a.run(async () => { await client.request('DELETE', `/api/admin/sources/${s.id}${pages ? '?pages=1' : ''}`); onDone(); })}>Remove source</button>
        </div>
      </div>
    </Modal>
  );
}

const shown = (f: ConfigField, v: Record<string, any>, fields: ConfigField[]) =>
  !f.showIf || Object.entries(f.showIf).every(([k, want]) => (v[k] ?? fields.find((x) => x.key === k)?.default) === want);

function defaults(c: Connector) {
  const out: Record<string, any> = {};
  for (const f of c.fields) if (f.default !== undefined) out[f.key] = f.default;
  return out;
}

function SourceForm({ worldId, connectors, source, onClose, onDone }: { worldId: string; connectors: Connector[]; source: Source | null; onClose: () => void; onDone: (msg: string) => void }) {
  const { client } = useAuth();
  const [kind, setKind] = useState(source?.kind ?? connectors[0]?.id ?? '');
  const c = connectors.find((x) => x.id === kind);
  const [name, setName] = useState(source?.name ?? '');
  const [v, setV] = useState<Record<string, any>>(() => (source ? { ...source.config } : c ? defaults(c) : {}));
  const [share, setShare] = useState(source?.default_visibility === 'party');
  const [sched, setSched] = useState(String(source?.schedule_minutes ?? ''));
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const a = useAction();
  const t = useAction();

  const pick = (k: string) => { setKind(k); const n = connectors.find((x) => x.id === k); setV(n ? defaults(n) : {}); setResult(null); };
  const config = () => {
    const out: Record<string, any> = {};
    for (const f of c?.fields ?? []) {
      if (!shown(f, v, c!.fields)) continue;
      const x = v[f.key];
      if (x === undefined || x === '') continue;
      out[f.key] = f.type === 'number' ? Number(x) : x;
    }
    return out;
  };

  const test = () => t.run(async () => {
    setResult(null);
    const cfg = config();
    // A saved source keeps its secrets on the server, so test it there unless settings changed.
    const unchanged = source && JSON.stringify(cfg) === JSON.stringify(Object.fromEntries(Object.entries(source.config).filter(([, x]) => x !== '' && x !== undefined)));
    if (unchanged) return setResult(await client.request('POST', `/api/admin/sources/${source!.id}/test`));
    if (Object.values(cfg).includes(SECRET)) return setResult({ ok: false, message: 'Save the changed settings first, then test. Saved secrets never come back to the browser, so they can only be tested on the server.' });
    setResult(await client.request('POST', '/api/admin/sources/test', { kind, config: cfg }));
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      const body = { name, config: config(), defaultVisibility: share ? 'party' : 'dm', scheduleMinutes: sched ? Number(sched) : null };
      if (source) await client.request('PATCH', `/api/admin/sources/${source.id}`, body);
      else await client.request('POST', `/api/admin/worlds/${worldId}/sources`, { kind, ...body });
      onDone(source ? `Saved ${name}` : c?.push ? `Added ${name}. Make a key so your tool can push to it.` : `Added ${name}. Press Sync now to import it.`);
    });
  };

  return (
    <Modal title={source ? `Settings · ${source.name}` : 'Add a source'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {!source ? (
          <Field label="Kind of source">
            <select value={kind} onChange={(e) => pick(e.target.value)}>{connectors.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
          </Field>
        ) : <p className="small muted">{c?.label ?? source.kind}</p>}
        {c?.description && <p className="small muted" style={{ margin: 0 }}>{c.description}</p>}
        <Capabilities c={c} />
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. LegendKeeper · BloodEarth" required maxLength={80} /></Field>
        {c?.fields.filter((f) => shown(f, v, c.fields)).map((f) => <ConfigInput key={f.key} f={f} value={v[f.key]} editing={!!source} onChange={(x) => { setV((o) => ({ ...o, [f.key]: x })); setResult(null); }} />)}
        <label className="row small"><Switch checked={share} onChange={setShare} label="Share what the source shares" /> Let players see what the source itself shows its players. Off: everything stays DM-only until a page is marked shared.</label>
        {!c?.push && <Field label="Sync on its own"><select value={sched} onChange={(e) => setSched(e.target.value)}>{SCHEDULES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>}
        {result && <div className={result.ok ? 'ok-box small' : 'error-box'} role="status">{result.ok ? '✓ ' : ''}{result.message}</div>}
        <ErrorBox error={a.error || t.error} />
        <div className="row end wrap">
          <button type="button" className="btn" disabled={t.busy || !c} onClick={() => void test()}>{t.busy && !t.offline ? 'Testing…' : 'Test connection'}</button>
          <button className="btn primary" disabled={a.busy || !c}>{source ? 'Save' : 'Add source'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ConfigInput({ f, value, editing, onChange }: { f: ConfigField; value: any; editing: boolean; onChange: (v: any) => void }) {
  const help = f.secret || f.type === 'password'
    ? <>{f.help ? <>{f.help} </> : null}Stored on the server and never shown again.{editing && value === SECRET ? ' Leave it as is to keep it.' : ''}</>
    : f.help;
  if (f.type === 'boolean') return <label className="row small"><Switch checked={!!value} onChange={onChange} label={f.label} /> {f.label}{f.help && <span className="muted"> · {f.help}</span>}</label>;
  const common = { value: value ?? '', placeholder: f.placeholder, required: f.required };
  return (
    <Field label={`${f.label}${f.required ? '' : ' (optional)'}`} help={help}>
      {f.type === 'select' ? (
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} required={f.required}>
          {!f.required && <option value="">—</option>}
          {(f.options ?? []).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      ) : f.type === 'textarea' ? (
        <textarea className="code" rows={5} {...common} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input {...common} type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text'}
          className={f.type === 'url' || f.type === 'password' ? 'mono' : undefined} autoComplete={f.type === 'password' ? 'new-password' : 'off'}
          onFocus={(e) => { if (f.type === 'password' && value === SECRET) e.target.select(); }} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}

function HowSecretsWork() {
  return (
    <div className="note">
      <strong>How DM-only content is kept from players.</strong>
      <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
        <li><strong>LegendKeeper</strong> (MCP or API key): hidden pages, everything under a hidden page or document, and secret blocks.</li>
        <li><strong>Kanka</strong> (token or mcp-kanka): private entities, private attributes, and posts not visible to “all” or “members”. With the stock mcp-kanka every post is DM-only.</li>
        <li><strong>Markdown folders, git and MCP file servers</strong>: files without <span className="mono">visibility: party</span>, plus <span className="mono">secret:</span> frontmatter, <span className="mono">&gt; [!secret]</span> callouts, <span className="mono">%% %%</span> comments and headings marked (DM).</li>
        <li><strong>Relations, timelines, calendars and map markers</strong> (Kanka) and <strong>maps and timelines</strong> (LegendKeeper): private or hidden ones, hidden pins and events, and anything pointing at a DM-only page stay DM-only. LegendKeeper calendars have no hidden flag, so they stay DM-only.</li>
        <li><strong>Push sources</strong>: entries are DM-only unless they say “party” and the source is set to share. Secret blocks and DM facts are removed from the player copy like everywhere else.</li>
        <li><strong>Any JSON API</strong>: everything is DM-only unless the field you map to visibility says the record is shared.</li>
      </ul>
      <p className="small" style={{ margin: '6px 0 0' }}>With sharing off, players see nothing from a source until the DM shares a page. Players get a separate player copy built on the server: secret parts are removed, blocks the librarian doesn't understand are dropped, and links to DM-only pages show as “(hidden)”.</p>
    </div>
  );
}
