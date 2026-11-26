// Admin, App builds: the Android APK and the desktop installers this server hands to its
// players and that the apps update themselves from. Fetch them from the latest GitHub release
// (which builds every platform, macOS included, on GitHub's machines), or upload a build from
// any computer: someone with a Mac can build the macOS app and upload it here.
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { ErrorBox, PageHead, useAction } from '../../ui/index.tsx';
import type { Build } from '../../lib/nativeApp.ts';
import { PLATFORM_NAMES, sizeText } from './useBuilds.ts';

interface FetchState { running: boolean; startedAt: string | null; finishedAt: string | null; release: string | null; version: string | null; files: string[]; error: string | null }
interface Admin { dir: string | null; repo: string; auto: boolean; builds: Build[]; fetch: FetchState }

const NAME_HINT = 'Alexandria-<version>-android.apk, -windows-x64-setup.exe, -macos-universal.dmg or -linux-x64.tar.gz';
const VERSION_IN = /(?:^|[-_v])(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|pre|dev)(?:\.?\d+)?)?)(?=[-_.]|$)/i;

export default function AdminApps() {
  const { client } = useAuth();
  const [data, setData] = useState<Admin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = useAction();
  const load = async () => { try { setData(await client.request<Admin>('GET', '/api/admin/apps')); setError(null); } catch (e: any) { setError(e.message ?? String(e)); } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);
  // While a fetch runs, look again every two seconds.
  useEffect(() => {
    if (!data?.fetch.running) return;
    const t = setTimeout(() => void load(), 2000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const fetchLatest = () => act.run(async () => { await client.request('POST', '/api/admin/apps/fetch'); await load(); });
  const remove = (f: string) => act.run(async () => {
    if (!window.confirm(`Remove ${f} from this server? Apps stop being offered it.`)) return;
    await client.request('DELETE', `/api/admin/apps/${encodeURIComponent(f)}`);
    await load();
  });
  const f = data?.fetch;

  return (
    <div className="stack" data-testid="admin-apps">
      <PageHead title="App builds" lead="The Android app and the desktop apps this server offers its players. Signed-in people download them from This device, and the apps update themselves from here." />
      <ErrorBox error={act.error ?? error} />

      <section className="card stack tight" aria-labelledby="fetch-h">
        <h2 id="fetch-h">From the latest release</h2>
        <p className="small">Copies every app build from the latest release of <strong>{data?.repo ?? '…'}</strong> on GitHub, replacing older ones. GitHub builds all of them, macOS included, so no Mac is needed. {data?.auto ? 'This server also does this every 12 hours.' : 'Set ALX_APPS_AUTO_FETCH=1 to do it every 12 hours.'}</p>
        <div className="row">
          <button type="button" className="btn" disabled={act.busy || !!f?.running} onClick={() => void fetchLatest()} data-testid="fetch-latest"><i className="fa-solid fa-cloud-arrow-down" aria-hidden="true" /> {f?.running ? 'Fetching…' : 'Fetch the latest release'}</button>
        </div>
        {f && !f.running && f.finishedAt && (
          f.error ? <p className="small" role="alert" style={{ color: 'var(--red, #c55)' }} data-testid="fetch-result">The last fetch failed: {f.error}</p>
            : <p className="small muted" data-testid="fetch-result">Last fetch: {f.release ?? f.version} ({f.files.length} file{f.files.length === 1 ? '' : 's'}).</p>
        )}
      </section>

      <Upload onDone={load} />

      <section className="card" aria-labelledby="have-h">
        <h2 id="have-h">On this server</h2>
        {data && !data.builds.length && <p className="small muted">No builds yet. Fetch the latest release or upload one.</p>}
        <ul className="dl-list" data-testid="admin-builds">
          {data?.builds.map((b) => (
            <li key={b.file}>
              <span className="grow">
                <strong>{PLATFORM_NAMES[b.platform]}</strong>{b.arch !== 'universal' && <span className="muted"> · {b.arch}</span>} <span className="muted">{b.version ?? 'no version'}</span>
                <br /><span className="tiny faint">{b.file} · {sizeText(b.size)} · sha256 {b.sha256.slice(0, 12)}…</span>
              </span>
              <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void remove(b.file)} aria-label={`Remove ${b.file}`}><i className="fa-solid fa-trash" aria-hidden="true" /> Remove</button>
            </li>
          ))}
        </ul>
        {data?.dir && <p className="tiny faint">Folder: {data.dir}. Files copied in by hand show up here too.</p>}
      </section>
    </div>
  );
}

function Upload({ onDone }: { onDone: () => Promise<void> }) {
  const { client } = useAuth();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState('');
  const [replace, setReplace] = useState(true);
  const [pct, setPct] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const pick = (f: File | null) => { setFile(f); setMsg(null); setVersion(f ? (VERSION_IN.exec(f.name.replace(/\.(apk|exe|msi|dmg|tar\.gz|appimage|deb)$/i, ''))?.[1] ?? '') : ''); };

  const send = () => {
    if (!file) return;
    const q = new URLSearchParams({ ...(version.trim() ? { version: version.trim() } : {}), ...(replace ? { replace: '1' } : {}) });
    const x = new XMLHttpRequest();
    x.open('PUT', `${client.baseUrl}/api/admin/apps/${encodeURIComponent(file.name)}?${q}`);
    if (client.token) x.setRequestHeader('Authorization', `Bearer ${client.token}`);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = (e) => { if (e.lengthComputable) setPct(Math.round((e.loaded * 100) / e.total)); };
    x.onload = () => {
      setPct(null);
      let j: any = null;
      try { j = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status >= 300) { setMsg({ ok: false, text: j?.error ?? (x.status === 413 ? 'That file is too big for this server (ALX_APPS_MAX_MB, or the proxy in front of it).' : `Upload failed (${x.status})`) }); return; }
      setMsg({ ok: true, text: `Uploaded ${file.name} as ${j?.build?.version ?? version}.${j?.removed?.length ? ` Removed ${j.removed.join(', ')}.` : ''}` });
      setFile(null); setVersion('');
      if (input.current) input.current.value = '';
      void onDone();
    };
    x.onerror = () => { setPct(null); setMsg({ ok: false, text: 'The upload did not reach the server. Check the connection and try again.' }); };
    setPct(0); setMsg(null);
    x.send(file);
  };

  return (
    <section className="card stack tight" aria-labelledby="up-h">
      <h2 id="up-h">Upload a build</h2>
      <p className="small">From any computer, for example a macOS build someone made on their Mac. Name it like a release file ({NAME_HINT}).</p>
      <input ref={input} type="file" accept=".apk,.exe,.msi,.dmg,.gz,.AppImage,.deb" aria-label="Build file" onChange={(e) => pick(e.target.files?.[0] ?? null)} data-testid="upload-file" />
      {file && (
        <>
          <label className="stack tight small">Version
            <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.2.3" aria-label="Version" data-testid="upload-version" />
          </label>
          <label className="row small" style={{ gap: 8, flexWrap: 'nowrap' }}>
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            <span>Remove older builds for this platform</span>
          </label>
          <div className="row">
            <button type="button" className="btn" disabled={pct !== null || !version.trim()} onClick={send} data-testid="upload-send"><i className="fa-solid fa-upload" aria-hidden="true" /> {pct !== null ? `Uploading… ${pct}%` : `Upload ${sizeText(file.size)}`}</button>
          </div>
        </>
      )}
      {msg && <p className="small" role={msg.ok ? 'status' : 'alert'} data-testid="upload-result">{msg.text}</p>}
    </section>
  );
}
