// Admin → Worlds → one world: its sources (connection, audience, schedule,
// last sync), how many pages are at each level, how much of the library the
// embeddings model has read, and Sync now / Crawl / Re-index with live progress.
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead, Switch, useAction, useToast } from '../../ui/index.tsx';
import { TierPanel } from './Tiers.tsx';
import { StatusBanner, type WorldStatus } from './StatusBanner.tsx';
import { SourceFields, newDraft, problem, saveDraft, type Draft } from './SourceForm.tsx';
import {
  AudienceChip, AudiencePicker, ConfigFields, SCHEDULES, pickConfig, scheduleLabel,
  type Audience, type Connection, type Connector, type Crawl, type Progress, type Source,
} from './shared.tsx';

interface Overview {
  world: { id: string; slug: string; name: string };
  sources: Source[]; levels: { party: number; broker: number; gm: number; classified: number }; pages: number;
  embeddings: { configured: boolean; model: string | null; location: string | null; gmChunks: number; partyChunks: number; chunks: number; pages: { eligible: number; indexed: number; pending: number }; scopes?: Record<string, { eligible: number; indexed: number; pending: number; chunks: number }> };
  crawl: Crawl | null; crawling: boolean; status?: WorldStatus;
}

const LEVELS: [keyof Overview['levels'], string, string][] = [['party', 'Party', 'teal'], ['broker', 'Broker', 'gold'], ['gm', 'GM only', 'red'], ['classified', 'Classified', 'red']];
const statusChip = (s: string | null | undefined) => (s === 'ok' ? 'green' : s === 'error' ? 'red' : s === 'running' ? 'gold' : '');

export default function WorldPage() {
  const { id = '' } = useParams();
  const { client } = useAuth();
  const api = <T = any,>(method: string, path: string, body?: unknown) => client.request<T>(method, `/api/admin${path}`, body);
  const ov = useLoad(() => api<Overview>('GET', `/worlds/${id}/overview`), [id]);
  const connectors = useLoad(() => api<Connector[]>('GET', '/connectors'), []);
  const connections = useLoad(() => api<Connection[]>('GET', '/connections'), []);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Source | null>(null);
  const [audienceFor, setAudienceFor] = useState<Source | null>(null);
  const [removing, setRemoving] = useState<Source | null>(null);
  const [log, setLog] = useState<{ title: string; text: string } | null>(null);
  const { toast, toastNode } = useToast();
  const a = useAction();

  // While a crawl or a sync runs, the page follows it.
  const busy = !!ov.data?.crawling || !!ov.data?.sources.some((s) => s.running);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void ov.reload(), 1000);
    return () => clearInterval(t);
  }, [busy, ov]);

  const d = ov.data;
  const byId = new Map((connectors.data ?? []).map((c) => [c.id, c]));
  const syncable = (d?.sources ?? []).filter((s) => s.enabled && !byId.get(s.kind)?.push);

  const crawl = () => a.run(async () => { await api('POST', `/worlds/${id}/crawl`); toast('Crawl started'); await ov.reload(); });
  const reindex = () => a.run(async () => { await api('POST', `/worlds/${id}/reindex`); toast('Re-index started'); await ov.reload(); });
  const cancel = () => a.run(async () => { await api('POST', `/worlds/${id}/crawl/stop`); await ov.reload(); });
  const showLog = (c: Crawl) => a.run(async () => { const r = await api<{ log: string }>('GET', `/crawls/${c.id}`); setLog({ title: `Crawl log · ${when(c.started_at)}`, text: r.log || 'No log lines.' }); });

  if (ov.loading && !d) return <div className="page"><Loading /></div>;
  if (!d) return <div className="page"><ErrorBox error={ov.error ?? 'World not found'} /><Link to="/admin/worlds">Back to worlds</Link></div>;

  return (
    <div className="page">
      <PageHead title={d.world.name} lead={<><Link to="/admin/worlds">Worlds</Link> · <span className="mono">{d.world.slug}</span>. Where this world's library comes from, and how far it has been read.</>}>
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>Add a source</button>
      </PageHead>
      <ErrorBox error={ov.error || a.error} />

      <div className="card">
        <div className="card-head">
          <h2>Library</h2>
          <span className="small muted">{d.pages} page{d.pages === 1 ? '' : 's'}</span>
        </div>
        <div className="row wrap" aria-label="Pages by level">
          {LEVELS.map(([k, label, tone]) => <span key={k} className={`chip ${tone}`}>{label}: <strong>{d.levels[k]}</strong></span>)}
        </div>
        <StatusBanner status={d.status ?? null} />
        <EmbeddingsBox e={d.embeddings} />
        <div className="row wrap">
          {d.crawling
            ? <button type="button" className="btn danger" disabled={a.busy} onClick={() => void cancel()}>Cancel crawl</button>
            : <button type="button" className="btn primary" disabled={a.busy || !syncable.length} onClick={() => void crawl()}>{d.crawl ? 'Crawl again' : 'Connect and crawl'}</button>}
          <button type="button" className="btn" disabled={a.busy || d.crawling || !d.pages} onClick={() => void reindex()}>Re-index</button>
          {!syncable.length && <span className="small muted">Add a source to crawl.</span>}
        </div>
        {d.crawl && <CrawlPanel crawl={d.crawl} live={d.levels} onLog={() => void showLog(d.crawl!)} />}
        <TierPanel worldId={id} active={busy} />
      </div>

      <h2 style={{ margin: '8px 0 0' }}>Sources</h2>
      <div className="stack">
        {d.sources.map((s) => (
          <SourceCard key={s.id} s={s} connector={byId.get(s.kind)} onChanged={() => void ov.reload()} onEdit={() => setEditing(s)} onAudience={() => setAudienceFor(s)} onRemove={() => setRemoving(s)} toast={toast} />
        ))}
        {!d.sources.length && <div className="card"><Empty>No sources yet. Add one to fill this world's library.</Empty></div>}
      </div>
      <p className="small muted">The older <Link to="/admin/sources?tab=worlds">World sources</Link> page still works.</p>

      {adding && connectors.data && connections.data && (
        <AddSource worldId={id} connectors={connectors.data} connections={connections.data} onClose={() => setAdding(false)} onDone={(m) => { setAdding(false); toast(m); void ov.reload(); void connections.reload(); }} />
      )}
      {editing && byId.get(editing.kind) && <EditSource s={editing} c={byId.get(editing.kind)!} onClose={() => setEditing(null)} onDone={() => { setEditing(null); toast(`Saved ${editing.name}`); void ov.reload(); }} />}
      {audienceFor && <AudienceDialog s={audienceFor} onClose={() => setAudienceFor(null)} onDone={(m) => { setAudienceFor(null); toast(m); void ov.reload(); }} />}
      {removing && <RemoveSource s={removing} onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); toast(`Removed ${removing.name}`); void ov.reload(); void connections.reload(); }} />}
      {log && <Modal title={log.title} onClose={() => setLog(null)}><pre className="code" style={{ maxHeight: '60vh', overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}>{log.text}</pre></Modal>}
      {toastNode}
    </div>
  );
}

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return <div role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 8, borderRadius: 4, background: 'var(--line)', overflow: 'hidden' }}><div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} /></div>;
}

function EmbeddingsBox({ e }: { e: Overview['embeddings'] }) {
  if (!e.configured) return <div className="note"><strong>No embeddings model is set.</strong> The library works and keyword search is on; semantic search is off. Set a model in <Link to="/admin/models">Models</Link>, then press Re-index.</div>;
  return (
    <div className="stack tight">
      <div className="row between wrap small"><span>Embeddings: <strong>{e.model}</strong>{e.location ? <span className="muted"> ({e.location})</span> : null}</span><span><strong>{e.pages.indexed.toLocaleString()}</strong> of {e.pages.eligible.toLocaleString()} pages indexed · {e.chunks.toLocaleString()} chunks · {e.pages.pending.toLocaleString()} pending</span></div>
      <Bar value={e.pages.indexed} max={e.pages.eligible} label="Pages indexed" />
      {e.scopes && (
        <div className="tiny muted" title="A page can have several copies (what the GM reads, what the table reads); each copy is indexed on its own.">
          Copies indexed, by who reads them: {SCOPE_LABEL.filter(([k]) => e.scopes![k]?.eligible).map(([k, label]) => `${label} ${e.scopes![k].indexed.toLocaleString()}/${e.scopes![k].eligible.toLocaleString()}`).join(' · ') || 'none yet'}. A page counts once above, however many copies it has.
        </div>
      )}
    </div>
  );
}

const SCOPE_LABEL: [string, string][] = [['gm', 'GM copy'], ['broker', 'Broker copy'], ['party', 'Player copy'], ['lifted', 'Shared with some']];
const EMBED_TEXT: Record<string, string> = { waiting: 'Waiting for the library', running: 'Embedding', done: 'Done', 'no-model': 'No embeddings model set: library only', error: 'Stopped on an error', cancelled: 'Cancelled' };

function CrawlPanel({ crawl, live, onLog }: { crawl: Crawl; live: Progress['levels']; onLog: () => void }) {
  const p = crawl.progress;
  const run = crawl.status === 'running';
  return (
    <div className="stack tight" role="status" aria-live="polite" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
      <div className="row between wrap">
        <span><strong>{crawl.mode === 'reindex' ? 'Re-index' : 'Crawl'}</strong> <span className={`chip ${statusChip(crawl.status)}`}>{run ? (p.phase === 'embed' ? 'embedding' : 'fetching') : crawl.status === 'stopped' ? 'cancelled' : crawl.status}</span> <span className="tiny muted">{when(crawl.started_at)}</span></span>
        <button type="button" className="btn small" onClick={onLog}>Log</button>
      </div>
      {crawl.mode === 'crawl' && (
        <>
          <div className="small">Sources {p.sources.done}/{p.sources.total}{p.sources.current ? ` · reading ${p.sources.current}` : ''}</div>
          <Bar value={p.sources.done} max={p.sources.total} label="Sources done" />
          <div className="row wrap small" style={{ gap: 12 }}>
            <span><strong>{p.fetched}</strong> listed</span><span><strong>{p.saved}</strong> saved</span>
            {p.calls && <span><strong>{p.calls.index.toLocaleString()}</strong> list calls{p.calls.detail ? <>, {p.calls.detail.toLocaleString()} detail calls</> : null}</span>}
            {!!p.skipped && <span className="muted">{p.skipped} skipped</span>}{!!p.removed && <span className="muted">{p.removed} removed</span>}
          </div>
          {(p.tiers ?? []).map((t) => <div key={t.sourceId} className="small">{t.name}: Index: {t.indexCalls.toLocaleString()} calls, {t.pages.toLocaleString()} pages · Details: {t.read.toLocaleString()} of {t.pages.toLocaleString()} · Budget {t.paused ? 'paused' : `${t.budget}/min`}</div>)}
          {/* The crawl's own numbers are a snapshot; once it is over, the library's numbers (above) are the live ones, so show those and say so. */}
          <div className="row wrap" aria-label={run ? 'Pages by level while the crawl runs' : 'Pages by level now'}>{LEVELS.map(([k, label, tone]) => <span key={k} className={`chip ${tone}`}>{label}: {(run ? p.levels : live)[k]}</span>)}<span className="tiny muted">{run ? 'so far' : 'now (the same as the Library card)'}</span></div>
        </>
      )}
      <div className="small">Embeddings: {EMBED_TEXT[p.embedding.state] ?? p.embedding.state}{p.embedding.state === 'running' || p.embedding.state === 'done' ? ` · ${p.embedding.pagesDone}${p.embedding.pagesTotal ? ` of ${p.embedding.pagesTotal}` : ''} pages · ${p.embedding.chunks} chunks` : ''}</div>
      {p.embedding.state === 'running' && <Bar value={p.embedding.pagesDone} max={p.embedding.pagesTotal} label="Pages embedded" />}
      {p.errors > 0 && <div className="error-box small"><strong>{p.errors} problem{p.errors === 1 ? '' : 's'}.</strong>{p.errorSamples.map((m, i) => <div key={i}>{m}</div>)}</div>}
      {crawl.error && <ErrorBox error={crawl.error} />}
    </div>
  );
}

function SourceCard({ s, connector, onEdit, onAudience, onRemove, onChanged, toast }: { s: Source; connector?: Connector; onEdit: () => void; onAudience: () => void; onRemove: () => void; onChanged: () => void; toast: (m: string) => void }) {
  const { client } = useAuth();
  const a = useAction();
  const last = s.last_run;
  const sync = () => a.run(async () => { await client.request('POST', `/api/admin/sources/${s.id}/sync`); toast(`Syncing ${s.name}…`); onChanged(); });
  const stop = () => a.run(async () => { await client.request('POST', `/api/admin/sources/${s.id}/stop`); onChanged(); });
  const test = () => a.run(async () => { const r = await client.request<{ ok: boolean; message: string }>('POST', `/api/admin/sources/${s.id}/test`); toast(`${r.ok ? '✓' : '✗'} ${r.message}`); });
  return (
    <div className="card">
      <div className="card-head">
        <div className="stack tight grow" style={{ minWidth: 0 }}>
          <strong style={{ fontSize: 16 }}>{s.name}</strong>
          <span className="tiny muted">{s.connector?.label ?? s.kind}{s.connection ? <> · connection <Link to="/admin/sources?tab=connections">{s.connection.name}</Link></> : ''} · {s.pages} page{s.pages === 1 ? '' : 's'}</span>
        </div>
        <AudienceChip a={s.audience} />
      </div>
      <div className="row wrap small muted">
        <span>{connector?.push ? 'Pushed by your tool' : scheduleLabel(s.schedule_minutes)}</span>
        <span>· {s.running ? 'syncing…' : last ? `last sync ${when(last.finished_at ?? last.started_at)} (${last.status}${last.stats?.pages !== undefined ? `, ${last.stats.pages} pages` : ''})` : 'never synced'}</span>
        {!s.enabled && <span className="chip">switched off</span>}
      </div>
      {!s.running && last?.status === 'error' && <ErrorBox error={last.error} />}
      <div className="row wrap">
        {connector?.push ? null : s.running
          ? <button type="button" className="btn small danger" disabled={a.busy} onClick={() => void stop()}>Stop</button>
          : <button type="button" className="btn small primary" disabled={a.busy || !s.enabled} onClick={() => void sync()}>Sync now</button>}
        <button type="button" className="btn small" onClick={onAudience}>Audience</button>
        <button type="button" className="btn small" disabled={a.busy} onClick={() => void test()}>Test</button>
        <button type="button" className="btn small" onClick={onEdit}>Settings</button>
        <span className="grow" />
        <button type="button" className="btn small danger" onClick={onRemove}>Remove</button>
      </div>
      <ErrorBox error={a.error} />
    </div>
  );
}

function AddSource({ worldId, connectors, connections, onClose, onDone }: { worldId: string; connectors: Connector[]; connections: Connection[]; onClose: () => void; onDone: (m: string) => void }) {
  const { client } = useAuth();
  const [d, setD] = useState<Draft>(() => newDraft(connectors, connections));
  const c = connectors.find((x) => x.id === d.kind);
  const a = useAction();
  const issue = problem(d, c);
  const submit = (e: FormEvent) => { e.preventDefault(); void a.run(async () => { await saveDraft(client, worldId, d, c!, (id) => setD((o) => ({ ...o, connectionId: id }))); onDone(`Added ${d.name}. Press Sync now, or Crawl, to import it.`); }); };
  return (
    <Modal title="Add a source" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <SourceFields d={d} set={setD} connectors={connectors} connections={connections} />
        {issue && <p className="small muted" style={{ margin: 0 }}>{issue}</p>}
        <ErrorBox error={a.error} />
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={a.busy || !!issue}>Add source</button></div>
      </form>
    </Modal>
  );
}

function EditSource({ s, c, onClose, onDone }: { s: Source; c: Connector; onClose: () => void; onDone: () => void }) {
  const { client } = useAuth();
  const [name, setName] = useState(s.name);
  const [v, setV] = useState<Record<string, any>>({ ...s.config });
  const [sched, setSched] = useState(String(s.schedule_minutes ?? ''));
  const [enabled, setEnabled] = useState(s.enabled);
  const a = useAction();
  const own = c.hasConnection ? c : { ...c, fields: c.fields.map((f) => ({ ...f, scope: 'source' as const })) };
  const submit = (e: FormEvent) => { e.preventDefault(); void a.run(async () => { await client.request('PATCH', `/api/admin/sources/${s.id}`, { name, config: pickConfig(own, v, 'source'), scheduleMinutes: sched ? Number(sched) : null, enabled }); onDone(); }); };
  return (
    <Modal title={`Settings · ${s.name}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="small muted" style={{ margin: 0 }}>{s.connector?.label ?? s.kind}{s.connection ? <> · connection <Link to="/admin/sources?tab=connections">{s.connection.name}</Link> (its token or address is changed there)</> : null}</p>
        <Field label="Name"><input value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} /></Field>
        <ConfigFields c={own} scope="source" v={v} editing onChange={(k, x) => setV((o) => ({ ...o, [k]: x }))} />
        {!c.push && <Field label="Sync on its own"><select value={sched} onChange={(e) => setSched(e.target.value)}>{SCHEDULES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>}
        <label className="row small"><Switch checked={enabled} onChange={setEnabled} label="Source enabled" /> {enabled ? 'On' : 'Off'}</label>
        <ErrorBox error={a.error} />
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={a.busy}>Save</button></div>
      </form>
    </Modal>
  );
}

/** Change who a source is for. Sharing with players needs a tick; the server asks for it and records it. */
function AudienceDialog({ s, onClose, onDone }: { s: Source; onClose: () => void; onDone: (m: string) => void }) {
  const { client } = useAuth();
  const [aud, setAud] = useState<Audience>(s.audience);
  const [ok, setOk] = useState(false);
  const a = useAction();
  const save = () => a.run(async () => { await client.request('PATCH', `/api/admin/sources/${s.id}`, { audience: aud, ...(aud === 'party' ? { confirmParty: true } : {}) }); onDone(`${s.name}: ${aud === 'gm' ? 'GM only' : aud === 'party' ? 'shared with players' : 'follows the source'}. The player copies were rebuilt.`); });
  return (
    <Modal title={`Audience · ${s.name}`} onClose={onClose}>
      <div className="stack">
        <AudiencePicker value={aud} onChange={(x) => { setAud(x); setOk(false); }} confirmed={ok} onConfirm={setOk} />
        <p className="tiny muted" style={{ margin: 0 }}>Changing it rebuilds every page's player copy, search and embeddings for this world.</p>
        <ErrorBox error={a.error} />
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={a.busy || aud === s.audience || (aud === 'party' && !ok)} onClick={() => void save()}>Save</button></div>
      </div>
    </Modal>
  );
}

function RemoveSource({ s, onClose, onDone }: { s: Source; onClose: () => void; onDone: () => void }) {
  const { client } = useAuth();
  const [pages, setPages] = useState(false);
  const a = useAction();
  return (
    <Modal title={`Remove ${s.name}?`} onClose={onClose}>
      <div className="stack">
        <p>The librarian stops reading from this source. Nothing in the source itself changes, and its connection stays for other sources.</p>
        <label className="row small"><Switch checked={pages} onChange={setPages} label="Also delete its pages" /> Also delete the {s.pages} page{s.pages === 1 ? '' : 's'} it imported. Off: they stay in the library as they are.</label>
        <ErrorBox error={a.error} />
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn danger" disabled={a.busy} onClick={() => void a.run(async () => { await client.request('DELETE', `/api/admin/sources/${s.id}${pages ? '?pages=1' : ''}`); onDone(); })}>Remove source</button></div>
      </div>
    </Modal>
  );
}
