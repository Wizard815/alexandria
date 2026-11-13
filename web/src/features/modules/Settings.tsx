// World settings → Game module: which modules are on and in what order,
// their credits, and Import (always a preview first).
import { useState } from 'react';
import { ErrorBox, Field, Loading, Tabs, useAction, useToast } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';

type Src = 'json' | 'zip' | 'folder' | 'git' | 'api';

const b64 = (buf: ArrayBuffer) => {
  let s = '';
  const a = new Uint8Array(buf);
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s);
};

export default function ModuleSettings() {
  const { w, isDM } = useWorld();
  const mods = useLoad<any>(() => w.call('GET', '/modules'), [w], ['modules']);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const enabled: any[] = mods.data?.modules ?? [];
  const off: any[] = (mods.data?.available ?? []).filter((m: any) => !enabled.some((e) => e.id === m.id));

  const save = (ids: string[]) => act.run(async () => { await w.call('PUT', '/modules/enabled', { ids }); await mods.reload(); toast('Saved'); });
  const move = (i: number, d: number) => {
    const ids = enabled.map((m) => m.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void save(ids);
  };

  return (
    <div className="stack">
      <ErrorBox error={mods.error ?? act.error} />
      {mods.loading && !mods.data ? <Loading /> : (
        <>
          <section className="card stack">
            <h3>On in this world</h3>
            <p className="tiny muted">The first module wins when two of them define the same term.</p>
            {enabled.length === 0 && <p className="muted">No module is on. Rules lookups and keyword highlights are off.</p>}
            {enabled.map((m, i) => (
              <div key={m.id} className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span><strong>{i + 1}. {m.name}</strong> <span className="tiny muted">{m.terms} terms{m.version ? ` · v${m.version}` : ''}{m.builtin ? '' : ' · imported'}</span></span>
                {isDM && (
                  <span className="row" style={{ gap: 6 }}>
                    <button type="button" className="btn small" disabled={act.busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${m.name} up`}>↑</button>
                    <button type="button" className="btn small" disabled={act.busy || i === enabled.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${m.name} down`}>↓</button>
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => void save(enabled.filter((x) => x.id !== m.id).map((x) => x.id))}>Turn off</button>
                  </span>
                )}
              </div>
            ))}
          </section>

          {off.length > 0 && (
            <section className="card stack">
              <h3>Available</h3>
              {off.map((m) => (
                <div key={m.id} className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span><strong>{m.name}</strong> <span className="tiny muted">{m.terms} terms{m.builtin ? '' : ' · imported'}</span></span>
                  {isDM && (
                    <span className="row" style={{ gap: 6 }}>
                      <button type="button" className="btn small" disabled={act.busy} onClick={() => void save([...enabled.map((x) => x.id), m.id])}>Turn on</button>
                      {!m.builtin && <button type="button" className="btn small" disabled={act.busy} onClick={() => { if (confirm(`Delete ${m.name} from this world?`)) void act.run(async () => { await w.call('DELETE', `/modules/imported/${encodeURIComponent(m.id)}`); await mods.reload(); }); }}>Delete</button>}
                    </span>
                  )}
                </div>
              ))}
            </section>
          )}

          <section className="card stack">
            <h3>Credits</h3>
            {(mods.data?.available ?? []).filter((m: any) => m.attribution).map((m: any) => (
              <p key={m.id} className="tiny"><strong>{m.name}</strong> ({m.license || 'license not given'}). {m.attribution}</p>
            ))}
          </section>

          {isDM && <ImportBox onDone={() => void mods.reload()} />}
        </>
      )}
      {toastNode}
    </div>
  );
}

function ImportBox({ onDone }: { onDone: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [src, setSrc] = useState<Src>('json');
  const [req, setReq] = useState<any | null>(null);
  const [meta, setMeta] = useState({ name: '', version: '', license: '', attribution: '' });
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [api, setApi] = useState({ itemsPath: '', term: 'name', text: 'description', kind: '', summary: '', aliases: '', id: '', paging: 'none', token: '' });
  const [pre, setPre] = useState<any | null>(null);
  const [replace, setReplace] = useState(false);
  const [done, setDone] = useState(false);

  const body = (): any => {
    const module = Object.fromEntries(Object.entries(meta).filter(([, v]) => v.trim()));
    if (src === 'git') return { type: 'git', url, module };
    if (src === 'api') {
      const mapping = Object.fromEntries(['term', 'text', 'kind', 'summary', 'aliases', 'id'].map((k) => [k, (api as any)[k]]).filter(([, v]) => v));
      return { type: 'api', url, itemsPath: api.itemsPath || undefined, paging: api.paging, token: api.token || undefined, mapping, module };
    }
    return { ...req, module };
  };

  async function pickFiles(files: FileList | null) {
    if (!files?.length) return;
    setPre(null); setDone(false);
    if (src === 'zip') {
      const f = files[0];
      setReq({ type: 'zip', zip: b64(await f.arrayBuffer()) });
      setMeta((m) => ({ ...m, name: m.name || f.name.replace(/\.zip$/i, '') }));
    } else if (src === 'folder') {
      const list = Array.from(files).filter((f) => /\.(md|markdown)$/i.test(f.name) || f.name === 'module.json');
      const out = await Promise.all(list.map(async (f) => ({ path: (f as any).webkitRelativePath || f.name, text: await f.text() })));
      setReq({ type: 'folder', files: out });
    } else {
      setReq({ type: 'json', json: await files[0].text() });
    }
  }

  const ready = src === 'git' || src === 'api' ? !!url.trim() : src === 'json' ? !!(req || text.trim()) : !!req;
  const payload = () => (src === 'json' && !req ? { type: 'json', json: text, module: body().module } : body());
  const doPreview = () => act.run(async () => { setDone(false); setPre(await w.call('POST', '/modules/import/preview', payload())); });
  const doSave = () => act.run(async () => { await w.call('POST', '/modules/import', { ...payload(), replace }); setDone(true); setPre(null); onDone(); });

  return (
    <section className="card stack">
      <h3>Import a module</h3>
      <Tabs label="Import from" value={src} onChange={(s) => { setSrc(s); setReq(null); setPre(null); setDone(false); }} items={[['json', 'JSON'], ['zip', 'Zip'], ['folder', 'Folder'], ['git', 'Git repo'], ['api', 'API']]} />
      <ErrorBox error={act.error} />
      {src === 'json' && (
        <>
          <Field label="JSON file"><input type="file" accept=".json,application/json" onChange={(e) => void pickFiles(e.target.files)} /></Field>
          <Field label="…or paste it"><textarea rows={4} value={text} onChange={(e) => { setText(e.target.value); setReq(null); setPre(null); }} placeholder='{ "id": "my-module", "name": "My module", "terms": [ … ] }' /></Field>
        </>
      )}
      {src === 'zip' && <Field label="Zip of Markdown files" help="One term per file. Frontmatter: kind, aliases, summary. Up to about 3 MB here."><input type="file" accept=".zip,application/zip" onChange={(e) => void pickFiles(e.target.files)} /></Field>}
      {src === 'folder' && <Field label="Folder of Markdown files" help="One term per file."><input type="file" multiple {...({ webkitdirectory: '' } as any)} onChange={(e) => void pickFiles(e.target.files)} /></Field>}
      {(src === 'git' || src === 'api') && <Field label={src === 'git' ? 'Repository address (https)' : 'API address'}><input type="url" value={url} onChange={(e) => { setUrl(e.target.value); setPre(null); }} placeholder={src === 'git' ? 'https://example.com/me/my-rules.git' : 'https://example.com/api/spells'} /></Field>}
      {src === 'api' && (
        <div className="stack tight">
          <p className="tiny muted">Say where the list is, and which field holds each part. A dotted path like <code>data.name</code> works.</p>
          {([['itemsPath', 'List at (blank: the answer is the list)'], ['term', 'Name field'], ['text', 'Text field(s), comma-separated'], ['kind', 'Kind field'], ['summary', 'Summary field'], ['aliases', 'Aliases field'], ['id', 'Id field'], ['token', 'Access token (optional)']] as const).map(([k, label]) => (
            <Field key={k} label={label}><input type={k === 'token' ? 'password' : 'text'} value={(api as any)[k]} onChange={(e) => setApi({ ...api, [k]: e.target.value })} /></Field>
          ))}
          <Field label="Paging"><select value={api.paging} onChange={(e) => setApi({ ...api, paging: e.target.value })}><option value="none">One request</option><option value="page">Page numbers</option><option value="link">Next link</option></select></Field>
        </div>
      )}
      <div className="stack tight">
        <Field label="Name"><input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} placeholder="Required for zips, folders, Git and APIs" /></Field>
        <Field label="Version"><input value={meta.version} onChange={(e) => setMeta({ ...meta, version: e.target.value })} /></Field>
        <Field label="License"><input value={meta.license} onChange={(e) => setMeta({ ...meta, license: e.target.value })} placeholder="e.g. CC-BY-4.0" /></Field>
        <Field label="Credit line (shown in the app)"><textarea rows={2} value={meta.attribution} onChange={(e) => setMeta({ ...meta, attribution: e.target.value })} /></Field>
      </div>
      <div className="row"><button type="button" className="btn" disabled={act.busy || !ready} onClick={() => void doPreview()}>Preview</button></div>

      {pre && (
        <div className="stack tight" role="region" aria-label="Import preview">
          <p><strong>{pre.module.name}</strong> ({pre.module.id}): {pre.total} terms. {Object.entries(pre.counts).map(([k, n]) => `${n} ${k}`).join(', ')}.</p>
          <ul className="tiny">{pre.samples.map((s: any, i: number) => <li key={i}><strong>{s.term}</strong> <span className="chip">{s.kind}</span> {s.summary}</li>)}</ul>
          {pre.warnings.map((m: string, i: number) => <p key={i} className="tiny muted">{m}</p>)}
          {pre.reserved && <p className="error-box">That id belongs to a built-in module. Give the module another name.</p>}
          {pre.exists && <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace the module already imported with this id</label>}
          <div className="row"><button type="button" className="btn primary" disabled={act.busy || pre.reserved || (pre.exists && !replace)} onClick={() => void doSave()}>Save module</button></div>
        </div>
      )}
      {done && <p role="status">Saved. It is on at the end of the list; reorder it above to let it win clashes.</p>}
    </section>
  );
}
