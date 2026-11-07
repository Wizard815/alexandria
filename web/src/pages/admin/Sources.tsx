// World sources: where each world's library comes from. Read-only imports.
import { useState, type FormEvent } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead, Switch, useAction, useToast } from '../../ui/index.tsx';

type Kind = 'mcp' | 'vault' | 'git' | 'kanka';
const KINDS: [Kind, string, string][] = [
  ['mcp', 'MCP server', 'LegendKeeper MCP or mcp-kanka'],
  ['vault', 'Markdown vault', 'Obsidian, Lokus or Otterly folder'],
  ['git', 'Git repo', 'your DND reference files'],
  ['kanka', 'Kanka API', 'token and campaign id'],
];

export default function AdminSources() {
  const { client } = useAuth();
  const worlds = useLoad(() => client.request<any[]>('GET', '/api/admin/worlds'), []);
  const [world, setWorld] = useState('');
  const wid = world || worlds.data?.[0]?.id || '';
  const sources = useLoad(() => (wid ? client.request<any[]>('GET', `/api/admin/worlds/${wid}/sources`) : Promise.resolve([])), [wid]);
  const [adding, setAdding] = useState(false);
  const a = useAction();
  const { toast, toastNode } = useToast();

  const sync = (s: any) => void a.run(async () => {
    const r = await client.request('POST', `/api/admin/sources/${s.id}/sync`);
    toast(`${s.name}: ${r.pages} pages imported. Player copies rebuilt.`);
    await sources.reload();
  });
  const remove = (s: any) => {
    if (!confirm(`Remove the source ${s.name}? Its pages stay in the library until you delete them.`)) return;
    void a.run(async () => { await client.request('DELETE', `/api/admin/sources/${s.id}`); await sources.reload(); });
  };

  return (
    <div className="page">
      <PageHead title="World sources" lead="Where a world's library comes from. The librarian only reads from a source. Anything hidden there stays DM-only here, and anything without a clear mark is DM-only too.">
        {!!worlds.data?.length && <button type="button" className="btn primary" onClick={() => setAdding(true)}>Add a source</button>}
      </PageHead>
      <ErrorBox error={a.error || worlds.error || sources.error} />
      {worlds.loading && !worlds.data ? <Loading /> : !worlds.data?.length ? <div className="card"><p className="muted">Make a world first.</p></div> : (
        <>
          <Field label="World"><select value={wid} onChange={(e) => setWorld(e.target.value)} style={{ maxWidth: 320 }}>{worlds.data.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
          <div className="stack">
            {(sources.data ?? []).map((s) => (
              <div className="card" key={s.id}>
                <div className="card-head">
                  <div className="stack tight grow"><strong style={{ fontSize: 16 }}>{s.name}</strong><span className="mono tiny muted">{s.kind}{s.config.profile ? ` · ${s.config.profile}` : ''} · {describe(s)}</span></div>
                  <span className={`chip ${String(s.last_status ?? '').startsWith('error') ? 'red' : s.last_status ? 'green' : ''}`}>{s.last_status ?? 'never synced'}</span>
                </div>
                <div className="row small muted">
                  <span>Last sync: {when(s.last_sync_at) || 'never'}</span>
                  <span>· Pages players can see: {s.default_visibility === 'party' ? 'what the source shares' : 'none (DM-only)'}</span>
                  {s.kind === 'mcp' && s.config.profile === 'kanka' && <span>· Posts: {s.config.trustPostVisibility ? 'Kanka visibility' : 'all DM-only'}</span>}
                </div>
                <div className="row"><button type="button" className="btn primary small" disabled={a.busy} onClick={() => sync(s)}>{a.busy ? 'Syncing…' : 'Sync now'}</button><button type="button" className="btn small danger" onClick={() => remove(s)}>Remove</button></div>
              </div>
            ))}
            {!sources.loading && !sources.data?.length && <div className="card"><Empty>No sources for this world yet. Pages can also be written by the DM in the Library.</Empty></div>}
          </div>
          <div className="note">
            <strong>How DM-only text is kept from players.</strong> LegendKeeper: hidden pages, anything under a hidden folder or document, and <span className="mono">&gt; [!secret]</span> blocks. Kanka: private entities, and posts that are not “all” or “members”. Vaults and git: files without <span className="mono">visibility: party</span>, plus <span className="mono">secret:</span> frontmatter, secret callouts, <span className="mono">%% %%</span> comments and headings marked (DM). After each sync, links to DM-only pages show as “(hidden)”.
          </div>
        </>
      )}
      {adding && <AddSource worldId={wid} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void sources.reload(); }} />}
      {toastNode}
    </div>
  );
}

function describe(s: any) {
  const c = s.config;
  if (s.kind === 'mcp') return c.transport === 'stdio' ? `local server “${c.server}”` : c.url;
  if (s.kind === 'vault') return `folder ${c.folder}`;
  if (s.kind === 'git') return `${c.url}${c.subdir ? ` · ${c.subdir}` : ''}`;
  return `campaign ${c.campaignId}`;
}

function AddSource({ worldId, onClose, onDone }: { worldId: string; onClose: () => void; onDone: () => void }) {
  const { client } = useAuth();
  const [kind, setKind] = useState<Kind>('mcp');
  const [name, setName] = useState('');
  const [v, setV] = useState<Record<string, string>>({ profile: 'legendkeeper', transport: 'http' });
  const [share, setShare] = useState(false);
  const [trust, setTrust] = useState(false);
  const a = useAction();
  const set = (k: string) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const config: Record<string, unknown> =
      kind === 'mcp' ? (v.transport === 'stdio' ? { profile: v.profile, transport: 'stdio', server: v.server } : { profile: v.profile, url: v.url, token: v.token || undefined, ...(v.project ? { project: v.project } : {}) })
      : kind === 'vault' ? { folder: v.folder }
      : kind === 'git' ? { url: v.url, ...(v.subdir ? { subdir: v.subdir } : {}) }
      : { campaignId: v.campaignId, token: v.token };
    if (kind === 'mcp' && v.profile === 'kanka') config.trustPostVisibility = trust;
    void a.run(async () => {
      await client.request('POST', `/api/admin/worlds/${worldId}/sources`, { kind, name, config, defaultVisibility: share ? 'party' : 'dm' });
      onDone();
    });
  };

  return (
    <Modal title="Add a source" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="tabs" role="radiogroup" aria-label="Kind of source">
          {KINDS.map(([k, label, sub]) => <button key={k} type="button" role="radio" aria-checked={kind === k} className={`btn small${kind === k ? ' on' : ''}`} onClick={() => setKind(k)} title={sub}>{label}</button>)}
        </div>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. LegendKeeper · BloodEarth" required /></Field>
        {kind === 'mcp' && (
          <>
            <Field label="Server"><select value={v.profile} onChange={set('profile')}><option value="legendkeeper">LegendKeeper MCP</option><option value="kanka">mcp-kanka</option></select></Field>
            <Field label="Connection"><select value={v.transport} onChange={set('transport')}><option value="http">HTTP URL</option><option value="stdio">Local server from ALX_MCP_STDIO</option></select></Field>
            {v.transport === 'stdio' ? (
              <Field label="Server name" help="A name the operator listed in ALX_MCP_STDIO."><input value={v.server ?? ''} onChange={set('server')} className="mono" required /></Field>
            ) : (
              <>
                <Field label="URL"><input value={v.url ?? ''} onChange={set('url')} placeholder="http://legendkeeper-mcp:8000/mcp" className="mono" required /></Field>
                <Field label="Token" help="Stored on the server and never shown again. Use a read-only key if the app has one."><input type="password" value={v.token ?? ''} onChange={set('token')} /></Field>
                {v.profile === 'legendkeeper' && <Field label="Project" help="Only if the server has more than one."><input value={v.project ?? ''} onChange={set('project')} /></Field>}
              </>
            )}
            {v.profile === 'kanka' && <label className="row small"><Switch checked={trust} onChange={setTrust} label="Trust post visibility" /> Trust Kanka post visibility (only with the fixed mcp-kanka; otherwise every post is DM-only)</label>}
          </>
        )}
        {kind === 'vault' && <Field label="Folder" help="A folder inside ALX_VAULTS_DIR on the server."><input value={v.folder ?? ''} onChange={set('folder')} className="mono" required /></Field>}
        {kind === 'git' && (
          <>
            <Field label="Repository" help="https only. Cloned read-only; nothing is pushed."><input value={v.url ?? ''} onChange={set('url')} placeholder="https://github.com/you/dnd-ref" className="mono" required /></Field>
            <Field label="Subfolder" help="Optional."><input value={v.subdir ?? ''} onChange={set('subdir')} className="mono" /></Field>
          </>
        )}
        {kind === 'kanka' && (
          <>
            <Field label="Campaign id"><input value={v.campaignId ?? ''} onChange={set('campaignId')} inputMode="numeric" required /></Field>
            <Field label="Kanka API token"><input type="password" value={v.token ?? ''} onChange={set('token')} required /></Field>
          </>
        )}
        <label className="row small"><Switch checked={share} onChange={setShare} label="Share what the source shares" /> Let players see what the source itself shows to players. Off: everything stays DM-only until a page is marked shared.</label>
        <ErrorBox error={a.error} />
        <button className="btn primary" disabled={a.busy}>Add source</button>
      </form>
    </Modal>
  );
}
