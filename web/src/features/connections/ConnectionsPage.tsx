// Admin → Connections: the account-level half of a source (a token, a key, an
// MCP address, a generic API's mapping), kept once and used by any number of
// worlds. Secrets are never shown again; "••••" means one is saved.
import { EndpointReview } from './EndpointReview.tsx';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead, useAction, useToast } from '../../ui/index.tsx';
import {
  ConfigFields, ConnectorPicker, CopyBox, SECRET, defaultsFor, pickConfig, scopeOf,
  type Connection, type Connector, type Preset,
} from './shared.tsx';

export default function ConnectionsPage() {
  const { client } = useAuth();
  const api = <T = any,>(method: string, path: string, body?: unknown) => client.request<T>(method, `/api/admin${path}`, body);
  const conns = useLoad(() => api<Connection[]>('GET', '/connections'), []);
  const connectors = useLoad(() => api<Connector[]>('GET', '/connectors'), []);
  const [editing, setEditing] = useState<Connection | 'new' | null>(null);
  const [testing, setTesting] = useState<Connection | null>(null);
  const [del, setDel] = useState<Connection | null>(null);
  const [showPresets, setShowPresets] = useState(false);
  const [finding, setFinding] = useState<Connection | null>(null);
  const { toast, toastNode } = useToast();
  const byKind = new Map((connectors.data ?? []).map((c) => [c.id, c]));
  const reload = () => { void conns.reload(); void connectors.reload(); };

  return (
    <div className="page">
      <PageHead title="Connections" lead="Your accounts in other apps: a Kanka token, a LegendKeeper key, an MCP address. Keep each one here once, then point any world's sources at it. A source adds what is specific to its world: the campaign or project, a schedule, and who may see it.">
        <button type="button" className="btn primary" onClick={() => setEditing('new')}>New connection</button>
      </PageHead>
      <ErrorBox error={conns.error || connectors.error} />
      {conns.loading && !conns.data ? <Loading /> : (
        <div className="card flush">
          {conns.data?.length ? (
            <div className="scroll-x"><table className="table adm-conns">
              <thead><tr><th>Connection</th><th>Template</th><th>Secret</th><th>Used by</th><th /></tr></thead>
              <tbody>{conns.data.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong>{c.notes && <span className="tiny muted">{c.notes}</span>}</td>
                  <td>{c.connector?.label ?? c.kind}</td>
                  <td>{Object.values(c.config).some((v) => v === SECRET) ? <span className="pill ok">saved</span> : <span className="pill">none</span>}</td>
                  <td><span className="small">{c.sources} source{c.sources === 1 ? '' : 's'} · {c.worlds} world{c.worlds === 1 ? '' : 's'}</span><UsedBy id={c.id} count={c.sources} /></td>
                  <td>
                    <div className="row wrap" style={{ justifyContent: 'flex-end', gap: 6 }}>
                      <button type="button" className="btn small" onClick={() => setTesting(c)}>Test</button>
                      <button type="button" className="btn small" onClick={() => setEditing(c)}>Edit</button>
                      {c.kind === 'api' && <button type="button" className="btn small" onClick={() => setFinding(c)}>Find endpoints</button>}
                      {c.kind === 'api' && <SaveAsPreset connection={c} onDone={(m) => { toast(m); reload(); }} />}
                      <button type="button" className="btn small danger" onClick={() => setDel(c)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <Empty>No connections yet. Make one, or set up a world and make it there.</Empty>}
        </div>
      )}
      <div className="row"><button type="button" className={`btn small${showPresets ? ' on' : ''}`} aria-expanded={showPresets} onClick={() => setShowPresets(!showPresets)}>Generic API presets</button></div>
      {showPresets && <PresetsPanel onChanged={reload} toast={toast} />}
      {finding && <EndpointReview connection={finding} onClose={() => setFinding(null)} onDone={(m) => { setFinding(null); toast(m); reload(); }} />}
      {editing && connectors.data && <ConnectionDialog connectors={connectors.data} connection={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={(m) => { setEditing(null); toast(m); reload(); }} />}
      {testing && byKind.get(testing.kind) && <TestDialog connection={testing} connector={byKind.get(testing.kind)!} onClose={() => setTesting(null)} />}
      {del && <DeleteDialog connection={del} onClose={() => setDel(null)} onDone={() => { setDel(null); toast(`Deleted ${del.name}`); reload(); }} />}
      {toastNode}
    </div>
  );
}

function UsedBy({ id, count }: { id: string; count: number }) {
  const { client } = useAuth();
  const info = useLoad(() => (count ? client.request<Connection>('GET', `/api/admin/connections/${id}`) : Promise.resolve(null)), [id, count]);
  const uses = info.data?.usage ?? [];
  if (!uses.length) return null;
  return (
    <div className="row wrap tiny" style={{ gap: 6 }}>
      {uses.map((u) => <Link key={u.source_id} className="chip" to={`/admin/worlds/${u.world_id}`}>{u.source_name} · {u.world_name}</Link>)}
    </div>
  );
}

function ConnectionDialog({ connectors, connection, onClose, onDone }: { connectors: Connector[]; connection: Connection | null; onClose: () => void; onDone: (m: string) => void }) {
  const { client } = useAuth();
  const [kind, setKind] = useState(connection?.kind ?? connectors.find((c) => c.hasConnection)?.id ?? '');
  const [preset, setPreset] = useState<Preset | null>(null);
  const c = connectors.find((x) => x.id === kind);
  const [name, setName] = useState(connection?.name ?? '');
  const [notes, setNotes] = useState(connection?.notes ?? '');
  const [v, setV] = useState<Record<string, any>>(() => (connection ? { ...connection.config } : c ? defaultsFor(c, 'connection') : {}));
  const [importing, setImporting] = useState(false);
  const a = useAction();
  const pickKind = (k: string) => { setKind(k); setV(defaultsFor(connectors.find((x) => x.id === k), 'connection')); };
  const pickPreset = (p: Preset | null) => { setPreset(p); const base = defaultsFor(connectors.find((x) => x.id === 'api'), 'connection'); setV(p ? { ...base, ...p.config } : base); };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      const config = pickConfig(c, v, 'connection');
      if (connection) await client.request('PATCH', `/api/admin/connections/${connection.id}`, { name, notes, config });
      else await client.request('POST', '/api/admin/connections', { kind, name, notes, config, ...(preset ? { presetId: preset.id } : {}) });
      onDone(connection ? `Saved ${name}` : `Made ${name}. Use it from a world's source.`);
    });
  };

  return (
    <Modal title={connection ? `Edit · ${connection.name}` : 'New connection'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {!connection ? (
          <>
            <ConnectorPicker connectors={connectors} kind={kind} presetId={preset?.id ?? ''} onPick={(k, p) => { setKind(k); if (p) pickPreset(p); else { pickKind(k); setPreset(null); } }} only={(x) => x.hasConnection} />
            {kind === 'api' && <div className="row"><button type="button" className="btn small" onClick={() => setImporting(true)}>Import a preset from JSON</button></div>}
            <p className="tiny muted" style={{ margin: 0 }}>Markdown folders, git repositories and push sources keep no account settings: add them straight to a world.</p>
          </>
        ) : <p className="small muted">{c?.label ?? connection.kind}</p>}
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My Kanka account" required maxLength={80} /></Field>
        {c && <ConfigFields c={c} scope="connection" v={v} editing={!!connection} onChange={(k, x) => setV((o) => ({ ...o, [k]: x }))} />}
        <Field label="Notes (optional)" help="Where the key came from, when it expires, who owns it."><textarea rows={2} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} /></Field>
        <ErrorBox error={a.error} />
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={a.busy || !c}>{connection ? 'Save' : 'Make connection'}</button></div>
      </form>
      {importing && <ImportPreset onClose={() => setImporting(false)} onDone={(p) => { setImporting(false); pickPreset(p); }} />}
    </Modal>
  );
}

/** Try a connection. Connectors that need a campaign or project to read anything ask for a sample of it. */
function TestDialog({ connection, connector, onClose }: { connection: Connection; connector: Connector; onClose: () => void }) {
  const { client } = useAuth();
  const [sample, setSample] = useState<Record<string, any>>({});
  const [res, setRes] = useState<{ ok: boolean; message: string } | null>(null);
  const a = useAction();
  const needs = connector.fields.some((f) => scopeOf(f) === 'source' && (f.required || f.key === 'world'));
  const run = () => a.run(async () => { setRes(null); setRes(await client.request('POST', `/api/admin/connections/${connection.id}/test`, { sample: pickConfig(connector, sample, 'source') })); });
  return (
    <Modal title={`Test · ${connection.name}`} onClose={onClose}>
      <div className="stack">
        {needs && <p className="small muted" style={{ margin: 0 }}>To read anything, this kind of connection needs a sample of what a world would add. Nothing is saved.</p>}
        <ConfigFields c={{ ...connector, fields: connector.fields.filter((f) => f.required || f.key === 'world') }} scope="source" v={sample} editing={false} onChange={(k, x) => setSample((o) => ({ ...o, [k]: x }))} />
        {res && <div className={res.ok ? 'ok-box small' : 'error-box'} role="status">{res.ok ? '✓ ' : ''}{res.message}</div>}
        <ErrorBox error={a.error} />
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Close</button><button type="button" className="btn primary" disabled={a.busy} onClick={() => void run()}>{a.busy ? 'Testing…' : 'Test connection'}</button></div>
      </div>
    </Modal>
  );
}

function DeleteDialog({ connection, onClose, onDone }: { connection: Connection; onClose: () => void; onDone: () => void }) {
  const { client } = useAuth();
  const a = useAction();
  return (
    <Modal title={`Delete ${connection.name}?`} onClose={onClose}>
      <div className="stack">
        <p>The saved token or key is removed from the server. {connection.sources ? `${connection.sources} source${connection.sources === 1 ? ' still uses' : 's still use'} it, so the server will refuse until they are removed.` : 'No source uses it.'}</p>
        <ErrorBox error={a.error} />
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn danger" disabled={a.busy} onClick={() => void a.run(async () => { await client.request('DELETE', `/api/admin/connections/${connection.id}`); onDone(); })}>Delete connection</button></div>
      </div>
    </Modal>
  );
}

// ---- presets ------------------------------------------------------------------

function SaveAsPreset({ connection, onDone }: { connection: Connection; onDone: (m: string) => void }) {
  const { client } = useAuth();
  const a = useAction();
  const save = () => {
    const name = prompt('Name for this preset (the field mapping only: no token, nothing world-specific)', `${connection.name} mapping`);
    if (name) void a.run(async () => { await client.request('POST', '/api/admin/connections/presets', { connectionId: connection.id, name }); onDone(`Saved the preset ${name}`); });
  };
  return <button type="button" className="btn small" disabled={a.busy} onClick={save}>Save mapping as preset</button>;
}

function PresetsPanel({ onChanged, toast }: { onChanged: () => void; toast: (m: string) => void }) {
  const { client } = useAuth();
  const presets = useLoad(() => client.request<Preset[]>('GET', '/api/admin/connections/presets'), []);
  const [exp, setExp] = useState<{ name: string; json: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const a = useAction();
  const exportIt = (p: Preset) => a.run(async () => setExp({ name: p.name, json: JSON.stringify(await client.request('GET', `/api/admin/connections/presets/${encodeURIComponent(p.id)}/export`), null, 2) }));
  const remove = (p: Preset) => { if (confirm(`Delete the preset ${p.name}? Connections made from it keep their settings.`)) void a.run(async () => { await client.request('DELETE', `/api/admin/connections/presets/${encodeURIComponent(p.id)}`); await presets.reload(); onChanged(); }); };
  return (
    <div className="card">
      <div className="card-head"><h2>Generic API presets</h2><button type="button" className="btn small" onClick={() => setImporting(true)}>Import JSON</button></div>
      <p className="small muted" style={{ margin: 0 }}>A preset is a saved field mapping for the generic API: paging, where the list is, which fields hold the title, body and visibility, and a URL with placeholders such as <span className="mono">{'{world}'}</span>. It holds no secret and nothing about one world.</p>
      <ErrorBox error={a.error || presets.error} />
      {presets.loading && !presets.data ? <Loading /> : (
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {(presets.data ?? []).map((p) => (
            <li key={p.id} className="stack tight">
              <div className="row between wrap">
                <span><strong>{p.name}</strong> {p.builtin ? <span className="chip gold">Community example{p.unverified ? ' · unverified' : ''}</span> : <span className="chip">yours</span>}</span>
                <span className="row">
                  <button type="button" className="btn small" onClick={() => void exportIt(p)}>Export</button>
                  {!p.builtin && <button type="button" className="btn small danger" onClick={() => remove(p)}>Delete</button>}
                </span>
              </div>
              <span className="tiny muted">{p.description}</span>
              {p.note && <span className="tiny muted">{p.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {exp && <Modal title={`Export · ${exp.name}`} onClose={() => setExp(null)}><div className="stack"><p className="small muted">Share this JSON. It holds the mapping only.</p><CopyBox text={exp.json} rows={12} /></div></Modal>}
      {importing && <ImportPreset onClose={() => setImporting(false)} onDone={() => { setImporting(false); toast('Imported the preset'); void presets.reload(); onChanged(); }} saveIt />}
    </div>
  );
}

/** Paste an exported preset. `saveIt`: store it; otherwise only fill the form with it. */
function ImportPreset({ onClose, onDone, saveIt = true }: { onClose: () => void; onDone: (p: Preset) => void; saveIt?: boolean }) {
  const { client } = useAuth();
  const [text, setText] = useState('');
  const a = useAction();
  return (
    <Modal title="Import a preset" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void a.run(async () => onDone(await client.request<Preset>('POST', '/api/admin/connections/presets/import', { json: text }))); }}>
        <Field label="Preset JSON" help="As exported from another Alexandria."><textarea className="mono" rows={10} value={text} onChange={(e) => setText(e.target.value)} required /></Field>
        <ErrorBox error={a.error} />
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={a.busy || !text.trim()}>{saveIt ? 'Import' : 'Use'}</button></div>
      </form>
    </Modal>
  );
}
