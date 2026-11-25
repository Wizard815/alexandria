// Admin → Source files: the pictures, maps and library files held for each world and source, how big they are, when they were fetched and
// how much disk they take. A source's files come back with its next sync ("Fetch again"); only library files can be deleted here.
// A file only a world's DM may see is shown as "a DM-only file" to an admin who is not that DM.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { Modal, ErrorBox, Loading, PageHead, useAction, useToast } from '../../ui/index.tsx';
import { Pill, Section, Tile } from '../../pages/admin/kit.tsx';
import { ago, bytes, usePolled, type FileRow, type SourceFiles, type SourceFilesWorld } from './api.ts';
import './gwstatus.css';

const SHOWN = 6;
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

export default function SourceFilesPage() {
  const q = usePolled<SourceFiles>('/files', 15_000);
  const { toast, toastNode } = useToast();
  const d = q.data;
  return (
    <div className="page">
      <PageHead title="Source files" lead="Pictures and maps fetched from sources, and files added to the library. A source's files are read again by its next sync; library files can be deleted here.">
        <Link className="btn" to="/admin/sources?tab=worlds">World sources</Link>
      </PageHead>
      <ErrorBox error={q.error} />
      {q.loading && !d ? <Loading /> : d && (
        <>
          <div className="tiles">
            <Tile label="Held in all" value={bytes(d.totals.bytes)} sub={`${plural(d.totals.pictures.count + d.totals.libraryFiles.count, 'file')}`} />
            <Tile label="From sources" value={plural(d.totals.pictures.count, 'picture')} sub={`${bytes(d.totals.pictures.bytes)} in the database`} />
            <Tile label="Library files" value={d.totals.libraryFiles.count.toLocaleString()} sub={`${bytes(d.totals.libraryFiles.bytes)} · ${bytes(d.totals.libraryFiles.onDiskBytes)} on disk`} />
          </div>
          {d.worlds.map((w) => <WorldFiles key={w.id} w={w} onChanged={() => void q.reload()} toast={toast} />)}
          {!d.worlds.length && <div className="card"><p className="muted">No worlds yet.</p></div>}
        </>
      )}
      {toastNode}
    </div>
  );
}

function FileTable({ files, total, what, action }: { files: FileRow[]; total: number; what: string; action?: (f: FileRow) => React.ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, SHOWN);
  if (!files.length) return <p className="small muted">No {what}.</p>;
  return (
    <>
      <div className="adm-table-wrap"><div className="scroll-x"><table className="table gws-files">
        <thead><tr><th>Name</th><th>Kind</th><th className="num">Size</th><th>Fetched</th>{action && <th />}</tr></thead>
        <tbody>{shown.map((f) => (
          <tr key={f.id}>
            <td className="gws-wrap">{f.name === null ? <span className="muted gws-hidden">a DM-only file</span> : <span className="mono small">{f.name}</span>}</td>
            <td><Pill>{f.kind}</Pill></td><td className="num">{bytes(f.size)}</td><td className="small">{ago(f.at)}</td>
            {action && <td>{action(f)}</td>}
          </tr>
        ))}</tbody>
      </table></div></div>
      {files.length > SHOWN && <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${files.length}${total > files.length ? ` of ${total}` : ''}`}</button>}
    </>
  );
}

function WorldFiles({ w, onChanged, toast }: { w: SourceFilesWorld; onChanged: () => void; toast: (m: string) => void }) {
  const { client } = useAuth();
  const a = useAction();
  const [del, setDel] = useState<FileRow | null>(null);
  const fetchAgain = (id: string, name: string) => void a.run(async () => {
    await client.request('POST', `/api/admin/sources/${id}/sync`, {});
    toast(`Reading ${name} again. New files appear here when it finishes.`);
    setTimeout(onChanged, 2500);
  });
  const remove = () => void a.run(async () => {
    if (!del) return;
    await client.request('DELETE', `/api/admin/gwstatus/files/library/${del.id}`);
    toast('File deleted');
    setDel(null);
    onChanged();
  });
  const empty = !w.sources.length && !w.library.count;
  return (
    <Section title={<span className="row wrap" style={{ gap: 10 }}>{w.name}{w.view === 'counts' && <Pill>counts and shared names only</Pill>}</span>}
      lead={empty ? 'No sources and no library files.' : w.view === 'dm' ? 'You are this world’s DM, so every name is shown.' : 'You are not this world’s DM. Files its players cannot see are counted but not named.'}>
      <ErrorBox error={a.error} />
      {w.sources.map((s) => (
        <div key={s.id} className="gws-source">
          <div className="gws-source-head">
            <div className="stack tight">
              <span className="row wrap" style={{ gap: 8 }}><strong>{s.name}</strong><Pill tone="teal">{s.connector}</Pill>{!s.enabled && <Pill tone="warn">off</Pill>}</span>
              <span className="small muted">
                {plural(s.count, 'file')} · {bytes(s.bytes)}{s.byKind.length > 1 ? ` (${s.byKind.map((k) => `${k.count} ${k.kind}`).join(', ')})` : ''} · last fetched {ago(s.lastFetchedAt)} · source read {ago(s.lastSyncAt)}
              </span>
              {s.lastStatus && <span className={`tiny ${/^error/.test(s.lastStatus) ? 'gws-bad' : 'muted'}`}>{s.lastStatus}</span>}
            </div>
            {s.canSync ? <button type="button" className="btn small" disabled={a.busy} onClick={() => fetchAgain(s.id, s.name)}>Fetch again</button> : <span className="tiny muted">nothing to fetch</span>}
          </div>
          {s.count > 0 && <FileTable files={s.files} total={s.count} what="files" />}
        </div>
      ))}
      <div className="gws-source">
        <div className="gws-source-head">
          <div className="stack tight">
            <strong>Library files</strong>
            <span className="small muted">Added by the DM or fetched for a page · {plural(w.library.count, 'file')} · {bytes(w.library.bytes)}{w.library.hiddenCount ? ` · ${w.library.hiddenCount} DM-only` : ''}</span>
          </div>
        </div>
        <FileTable files={w.library.files} total={w.library.count} what="library files"
          action={(f) => (f.hidden ? <span className="tiny faint">DM only</span> : <button type="button" className="btn small danger" disabled={a.busy} onClick={() => setDel(f)}>Delete</button>)} />
      </div>
      {del && (
        <Modal title="Delete this file?" onClose={() => setDel(null)}>
          <div className="stack">
            <p><span className="mono">{del.name}</span> ({bytes(del.size)}) is removed from the library and from the disk. The page it belongs to stays. This cannot be undone.</p>
            <ErrorBox error={a.error} />
            <div className="row end"><button type="button" className="btn" onClick={() => setDel(null)}>Cancel</button><button type="button" className="btn danger" disabled={a.busy} onClick={remove}>Delete file</button></div>
          </div>
        </Modal>
      )}
    </Section>
  );
}
