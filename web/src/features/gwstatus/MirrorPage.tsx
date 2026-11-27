// Admin → World mirror: each world is also written to a folder of Markdown files on the server, a copy for people who read the folder
// (an editor, Obsidian). The database is the truth. This page says whether the folder is complete, when it was last written, and which
// copies could not be written. An admin who is not a world's GM sees counts only: page paths are page text.
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { ErrorBox, Loading, PageHead, useAction, useToast } from '../../ui/index.tsx';
import { Pill, Section, Tile } from '../../pages/admin/kit.tsx';
import { ago, bytes, usePolled, type Mirror, type MirrorWorld } from './api.ts';
import './gwstatus.css';

const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

export default function MirrorPage() {
  const m = usePolled<Mirror>('/mirror', 15_000);
  const { toast, toastNode } = useToast();
  const d = m.data;
  return (
    <div className="page">
      <PageHead title="World mirror" lead="Every world is also written to a folder of Markdown files, so people can read it in an editor. The database is the truth; the folder is a copy. Rewrite a folder if it looks incomplete.">
        <Link className="btn" to="/admin/worlds">Worlds</Link>
      </PageHead>
      <ErrorBox error={m.error} />
      {m.loading && !d ? <Loading /> : d && (
        !d.enabled ? <div className="card"><p className="muted">This server keeps no data folder, so nothing is written to disk. Set ALX_DATA_DIR to keep one (docs/HOSTING.md).</p></div> : (
          <>
            <div className="tiles">
              <Tile label="Worlds" value={d.worlds.length} sub={`${d.worlds.filter((w) => w.exists).length} with a folder`} />
              <Tile label="Files on disk" value={d.totals.files.toLocaleString()} sub={bytes(d.totals.bytes)} />
              <Tile label="Last written" value={ago(d.worlds.map((w) => w.lastWrittenAt).filter(Boolean).sort().pop())} />
              <Tile label="Failed copies" value={d.totals.failures} tone={d.totals.failures ? 'bad' : 'ok'} sub={d.totals.failures ? 'see the worlds below' : 'every copy was written'} />
            </div>
            {d.worlds.map((w) => <WorldMirror key={w.id} w={w} onChanged={() => void m.reload()} toast={toast} />)}
            {!d.worlds.length && <div className="card"><p className="muted">No worlds yet. <Link to="/admin/worlds/setup">Set one up</Link>.</p></div>}
          </>
        )
      )}
      {toastNode}
    </div>
  );
}

function WorldMirror({ w, onChanged, toast }: { w: MirrorWorld; onChanged: () => void; toast: (m: string) => void }) {
  const { client } = useAuth();
  const a = useAction();
  const rewrite = () => void a.run(async () => {
    const r = await client.request<{ world: MirrorWorld }>('POST', `/api/admin/gwstatus/mirror/${w.id}/rewrite`);
    toast(r.world.failures ? `Rewrote ${w.name}; ${r.world.failures} still could not be written` : `Rewrote ${w.name}`);
    onChanged();
  });
  const rows: { key: 'vault' | 'party' | 'api'; name: string; what: string; expect: number }[] = [
    { key: 'vault', name: 'vault', what: 'every page, as the GM sees it', expect: w.pages },
    { key: 'party', name: 'party', what: 'pages shared with players', expect: w.shared },
    { key: 'api', name: '_api', what: 'the party pages as JSON', expect: w.shared },
  ];
  return (
    <Section
      title={<span className="row wrap" style={{ gap: 10 }}>{w.name} <Pill tone={w.failures ? 'bad' : w.exists ? 'ok' : 'warn'}>{!w.exists ? 'No folder yet' : w.failures ? `${w.failures} failed cop${w.failures === 1 ? 'y' : 'ies'}` : 'Complete'}</Pill></span>}
      lead={<><span className="mono">{w.folder ?? 'no data folder'}</span> · {w.exists ? `last written ${ago(w.lastWrittenAt)}` : 'nothing written'} · {w.view === 'gm' ? 'you are its GM' : 'counts only: you are not its GM'}</>}
      actions={<button type="button" className="btn small" disabled={a.busy} onClick={rewrite}>{a.busy && !a.offline ? 'Rewriting…' : 'Rewrite mirror'}</button>}
    >
      <ErrorBox error={a.error} />
      <div className="adm-table-wrap"><div className="scroll-x"><table className="table">
        <thead><tr><th>Folder</th><th>Holds</th><th className="num">Files</th><th className="num">Pages</th><th className="num">Size</th><th>State</th></tr></thead>
        <tbody>{rows.map((r) => {
          const have = w.copies[r.key].files;
          const missing = Math.max(0, r.expect - have);
          return (
            <tr key={r.key}>
              <td className="mono">{r.name}/</td><td className="small">{r.what}</td>
              <td className="num">{have.toLocaleString()}</td><td className="num">{r.expect.toLocaleString()}</td><td className="num">{bytes(w.copies[r.key].bytes)}</td>
              <td>{!w.exists ? <Pill tone="warn">Not written</Pill> : missing ? <Pill tone="warn">{missing.toLocaleString()} missing</Pill> : have > r.expect ? <Pill tone="">{(have - r.expect).toLocaleString()} extra</Pill> : <Pill tone="ok">Complete</Pill>}</td>
            </tr>
          );
        })}</tbody>
      </table></div></div>
      {w.failures > 0 && (w.failed ? (
        <div className="stack tight">
          <h3 className="gws-h3">Copies that could not be written</h3>
          <div className="adm-table-wrap"><div className="scroll-x"><table className="table">
            <thead><tr><th>Folder</th><th>Page</th><th>Why</th><th>When</th><th className="num">Tries</th></tr></thead>
            <tbody>{w.failed.map((f) => (
              <tr key={`${f.copy}/${f.path}`}><td className="mono">{f.copy}/</td><td className="mono small gws-wrap">{f.path}</td><td className="small gws-wrap">{f.error}</td><td className="small">{ago(f.at)}</td><td className="num">{f.attempts}</td></tr>
            ))}</tbody>
          </table></div></div>
          <p className="tiny muted">The page itself is saved. Usually a page path needs a name as both a file and a folder (a/Dup.md and a/Dup.md/Child.md). Rename one of them in the library, then rewrite.</p>
        </div>
      ) : <p className="small muted">{w.failures} cop{w.failures === 1 ? 'y' : 'ies'} could not be written. The page paths are shown only to this world's GM.</p>)}
    </Section>
  );
}
