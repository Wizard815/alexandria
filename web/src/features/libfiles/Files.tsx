// Files in the library: the files of one page (shown under it: pictures inline,
// PDFs and the rest as links), the Files tab of the Library side panel (every
// file the viewer may see, with search), and the upload form. The server decides
// what each viewer gets; tickets in the lists are per viewer.
import { useMemo, useRef, useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { ErrorBox, Empty, Loading, Field, useAction } from '../../ui/index.tsx';
import { LEVELS, LEVEL_LABEL, LevelChip, type Level } from '../../pages/library/Levels.tsx';

export interface LibFile {
  id: string; pageId: string; pageTitle?: string; name: string; kind: string; mime: string; family: 'image' | 'pdf' | 'text' | 'json' | 'csv'; size: number; at: string; url: string;
  level?: Level; remote?: { source: string; app: string; id: string | null; error: string | null };
}
interface FileList { max: number; canUpload: boolean; files: LibFile[] }
export const KINDS = ['map', 'handout', 'item', 'rules', 'other'] as const;
const KIND_LABEL: Record<string, string> = { map: 'Map', handout: 'Handout', item: 'Item or weapon sheet', rules: 'Rules', other: 'Other' };

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const icon = (f: LibFile) => (f.family === 'image' ? 'fa-regular fa-image' : f.family === 'pdf' ? 'fa-regular fa-file-pdf' : f.family === 'csv' ? 'fa-solid fa-table' : f.family === 'json' ? 'fa-regular fa-file-code' : 'fa-regular fa-file-lines');

export function useFiles(pageId?: string) {
  const { w } = useWorld();
  return useLoad<FileList>(() => w.call('GET', '/files', undefined, pageId ? { page: pageId } : undefined), [w, pageId], ['libfile']);
}

/** Upload: onto a page (`pageId`) or as a new file page in a folder. */
export function UploadForm({ pageId, max, onDone, onCancel }: { pageId?: string; max: number; onDone: (r: any) => void; onCancel?: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<string>('other');
  const [level, setLevel] = useState<Level>('dm');
  const [folder, setFolder] = useState('Files');
  const [title, setTitle] = useState('');
  const [send, setSend] = useState(false);
  // Where this could also be sent: only when the page comes from a source that takes files, and never for a classified file.
  const target = useLoad<{ target: { sourceId: string; sourceName: string; app: string } | null }>(
    () => (pageId && level !== 'classified' ? w.call('GET', '/files/targets', undefined, { page: pageId, level, ...(file?.type ? { mime: file.type } : {}) }) : Promise.resolve({ target: null })), [w, pageId, level, file?.type]);
  const t = level === 'classified' ? null : target.data?.target ?? null;

  const pick = (f: File | null) => {
    setFile(f);
    if (f) {
      if (!title) setTitle(f.name.replace(/\.[A-Za-z0-9]{1,8}$/, ''));
      if (/\.(png|jpe?g|gif|webp)$/i.test(f.name) && kind === 'other' && /map/i.test(f.name)) setKind('map');
    }
  };
  const tooBig = !!file && file.size > max;
  const submit = () => act.run(async () => {
    if (!file) return;
    const c = w.client;
    const q = new URLSearchParams({ name: file.name, kind, level });
    if (pageId) q.set('page', pageId); else { q.set('folder', folder.trim()); q.set('title', title.trim() || file.name); }
    if (send && t) q.set('send', t.sourceId);
    const r = await fetch(`${c.baseUrl}${w.path('/files')}?${q}`, { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/octet-stream' }, body: file });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error ?? `Upload failed (${r.status})`);
    setFile(null); setSend(false);
    if (input.current) input.current.value = '';
    onDone(body);
  });

  return (
    <form className="lf-form stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label="File" help={`Pictures, PDF, text, Markdown, JSON or CSV, up to ${Math.round(max / 1048576)} MB.`}>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,application/json,.md,.markdown,.txt,.json,.csv,.tsv" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
      </Field>
      {tooBig && <div className="error-box" role="alert">That file is {size(file!.size)}; the limit is {Math.round(max / 1048576)} MB.</div>}
      {!pageId && (
        <div className="lf-row">
          <Field label="Folder"><input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Files/Maps" /></Field>
          <Field label="Page title"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
        </div>
      )}
      <div className="lf-row">
        <Field label="Kind"><select value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></Field>
        <Field label="Who can see it"><select value={level} onChange={(e) => setLevel(e.target.value as Level)}>{LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}</select></Field>
      </div>
      {level === 'classified' && <p className="small muted"><i className="fa-solid fa-lock" aria-hidden="true" /> Classified files stay on this server. They are never sent to a model or to any source.</p>}
      {t && (
        <label className="lib-check"><input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} /> Also send to {t.app} ({t.sourceName}){level === 'party' ? '' : ', as private'}</label>
      )}
      <ErrorBox error={act.error} />
      <div className="row end">
        {onCancel && <button type="button" className="btn small" onClick={onCancel}>Cancel</button>}
        <button type="submit" className="btn small primary" disabled={!file || tooBig || act.busy}><i className="fa-solid fa-upload" aria-hidden="true" /> {act.busy ? 'Uploading…' : 'Upload'}</button>
      </div>
    </form>
  );
}

/** What the DM can do to one file; players get no controls. */
function FileTools({ f, canUpload, reload }: { f: LibFile; canUpload: boolean; reload: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  if (!canUpload) return null;
  return (
    <div className="row wrap lf-tools">
      <select aria-label={`Level of ${f.name}`} value={f.level} disabled={act.busy} onChange={(e) => void act.run(async () => { await w.call('PATCH', `/files/${f.id}`, { level: e.target.value }); reload(); })}>
        {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
      </select>
      <select aria-label={`Kind of ${f.name}`} value={f.kind} disabled={act.busy} onChange={(e) => void act.run(async () => { await w.call('PATCH', `/files/${f.id}`, { kind: e.target.value }); reload(); })}>
        {KINDS.map((k) => <option key={k} value={k} disabled={k === 'map' && f.family !== 'image'}>{KIND_LABEL[k]}</option>)}
      </select>
      {f.remote?.error && f.level !== 'classified' && <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('POST', `/files/${f.id}/send`, {}); reload(); })}>Try sending again</button>}
      <button type="button" className="btn small danger" disabled={act.busy} aria-label={`Delete ${f.name}`} onClick={() => void act.run(async () => { if (!window.confirm(`Delete “${f.name}”?`)) return; await w.call('DELETE', `/files/${f.id}`); reload(); })}><i className="fa-solid fa-trash" aria-hidden="true" /></button>
      <ErrorBox error={act.error} />
    </div>
  );
}

function Remote({ f }: { f: LibFile }) {
  if (!f.remote) return null;
  return f.remote.error
    ? <span className="tiny lf-bad" role="status"><i className="fa-solid fa-triangle-exclamation" aria-hidden="true" /> Not sent to {f.remote.app || 'the source'}: {f.remote.error}</span>
    : <span className="tiny faint"><i className="fa-solid fa-cloud-arrow-up" aria-hidden="true" /> Sent to {f.remote.app} ({f.remote.source}){f.remote.id ? ` as ${f.remote.id}` : ''}</span>;
}

function Meta({ f }: { f: LibFile }) {
  return <span className="tiny faint">{KIND_LABEL[f.kind] ?? f.kind} · {size(f.size)}</span>;
}

/** The files under a page. Maps and pictures show inline; a PDF is a view link and a download. */
export function PageFiles({ pageId }: { pageId: string }) {
  const files = useFiles(pageId);
  const [adding, setAdding] = useState(false);
  const d = files.data;
  if (!d) return files.error ? <ErrorBox error={files.error} /> : null;
  if (!d.files.length && !d.canUpload) return null;
  const pics = d.files.filter((f) => f.family === 'image');
  const rest = d.files.filter((f) => f.family !== 'image');
  return (
    <section className="lf-section" aria-label="Files">
      <h3 className="lib-h lib-h3">Files{d.files.length ? ` (${d.files.length})` : ''}</h3>
      {pics.map((f) => (
        <figure className="lf-pic" key={f.id}>
          <a href={f.url} target="_blank" rel="noopener noreferrer"><img src={f.url} alt={f.name} loading="lazy" /></a>
          <figcaption className="row wrap"><strong className="small">{f.name}</strong><Meta f={f} />{f.level && <LevelChip level={f.level} all />}<a className="small" href={`${f.url}${f.url.includes('?') ? '&' : '?'}download=1`}>Download</a></figcaption>
          <Remote f={f} />
          <FileTools f={f} canUpload={d.canUpload} reload={files.reload} />
        </figure>
      ))}
      {rest.map((f) => (
        <div className="lf-doc" key={f.id}>
          <i className={`${icon(f)} lf-ico`} aria-hidden="true" />
          <div className="stack tight grow" style={{ minWidth: 0 }}>
            <strong className="lib-ellipsis">{f.name}</strong>
            <span className="row wrap"><Meta f={f} />{f.level && <LevelChip level={f.level} all />}</span>
            <Remote f={f} />
            <FileTools f={f} canUpload={d.canUpload} reload={files.reload} />
          </div>
          <div className="row lf-open">
            {(f.family === 'pdf' || f.family === 'text' || f.family === 'json') && <a className="btn small" href={f.url} target="_blank" rel="noopener noreferrer">View</a>}
            <a className="btn small" href={`${f.url}${f.url.includes('?') ? '&' : '?'}download=1`}>Download</a>
          </div>
        </div>
      ))}
      {d.canUpload && (adding
        ? <UploadForm pageId={pageId} max={d.max} onDone={() => { setAdding(false); files.reload(); }} onCancel={() => setAdding(false)} />
        : <button type="button" className="btn small" onClick={() => setAdding(true)}><i className="fa-solid fa-paperclip" aria-hidden="true" /> Attach a file</button>)}
    </section>
  );
}

/** The Files tab: every file the viewer may see, searchable, and (for a DM) a way to add a file as a new page. */
export function FilesTab({ onOpen }: { onOpen: (pageId: string) => void }) {
  const files = useFiles();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [adding, setAdding] = useState(false);
  const d = files.data;
  const needle = q.trim().toLowerCase();
  const list = useMemo(() => (d?.files ?? []).filter((f) => (!kind || f.kind === kind) && (!needle || f.name.toLowerCase().includes(needle) || (f.pageTitle ?? '').toLowerCase().includes(needle))), [d, kind, needle]);
  if (!d) return files.error ? <ErrorBox error={files.error} /> : <Loading what="files" />;
  return (
    <div className="stack">
      <label className="field"><span className="sr-only">Search files</span><input type="search" placeholder="Search files and their pages…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <div className="lib-filters">
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All kinds</option>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
        {d.canUpload && !adding && <button type="button" className="btn small" onClick={() => setAdding(true)}><i className="fa-solid fa-upload" aria-hidden="true" /> Upload a file</button>}
      </div>
      {adding && <UploadForm max={d.max} onDone={(r) => { setAdding(false); files.reload(); if (r?.page?.id) onOpen(r.page.id); }} onCancel={() => setAdding(false)} />}
      {list.length ? (
        <div className="lib-flat">
          {list.map((f) => (
            <button key={f.id} type="button" className="list-item" onClick={() => onOpen(f.pageId)}>
              {f.family === 'image' ? <img className="lf-thumb" src={f.url} alt="" loading="lazy" /> : <i className={`${icon(f)} lf-ico`} aria-hidden="true" />}
              <span className="stack tight grow" style={{ minWidth: 0 }}><strong className="lib-ellipsis">{f.name}</strong><span className="tiny faint lib-ellipsis">{f.pageTitle} · {KIND_LABEL[f.kind] ?? f.kind} · {size(f.size)}</span></span>
              {f.level && f.level !== 'party' && <LevelChip level={f.level} />}
            </button>
          ))}
        </div>
      ) : <Empty>{d.files.length ? 'No files match.' : 'No files yet.'}</Empty>}
    </div>
  );
}

export const FILES_CSS = `
.lf-section { margin-top: 22px; display: flex; flex-direction: column; gap: 12px; }
.lf-pic { margin: 0; display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
.lf-pic img { max-width: 100%; max-height: 520px; object-fit: contain; border-radius: 6px; display: block; margin: 0 auto; background: var(--panel); }
.lf-doc { display: flex; gap: 12px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
.lf-ico { font-size: 22px; color: var(--muted); width: 28px; text-align: center; flex: none; padding-top: 2px; }
.lf-thumb { width: 36px; height: 36px; object-fit: cover; border-radius: 4px; flex: none; }
.lf-open { flex: none; }
.lf-tools select { width: auto; max-width: 100%; padding: 4px 8px; font-size: 13px; }
.lf-bad { color: var(--danger-text, #8a1c12); }
.lf-form { padding: 12px; border: 1px dashed var(--line); border-radius: 8px; }
.lf-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
@media (max-width: 760px) { .lf-doc { flex-wrap: wrap; } .lf-open { width: 100%; } .lf-pic img { max-height: 340px; } }
`;
