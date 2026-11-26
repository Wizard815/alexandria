// On This device: download any app build this server hosts (signed in), and, inside the
// Android or desktop app, update this app from here, by hand or automatically.
import { useState } from 'react';
import { appInfo, autoUpdateOn, inApp, setAutoUpdate, startUpdate, updateFor, type Build } from '../../lib/nativeApp.ts';
import { isIOS } from '../../lib/install.tsx';
import { ErrorBox, useAction } from '../../ui/index.tsx';
import { PLATFORM_NAMES, sizeText, useBuilds, useUpdateEvents } from './useBuilds.ts';

export function UpdateCard() {
  const app = appInfo();
  const b = useBuilds();
  const ev = useUpdateEvents();
  const act = useAction();
  const [auto, setAuto] = useState(autoUpdateOn());
  if (!app) return null;
  const next = updateFor(app, b.data);
  const latest = b.data?.latest[app.platform];
  const update = () => act.run(async () => { const t = await b.ticket(next!.file); startUpdate(t); });
  return (
    <section className="card" aria-labelledby="upd-h" data-testid="update-card">
      <h2 id="upd-h">Updates</h2>
      <p className="small">This app: <strong>{app.version}</strong> ({PLATFORM_NAMES[app.platform] ?? app.platform}). {latest ? <>On this server: <strong>{latest.version ?? 'a build with no version'}</strong>.</> : 'This server has no build for it yet.'}</p>
      <ErrorBox error={act.error ?? b.error} />
      {next ? (
        <div className="row">
          <button type="button" className="btn" disabled={act.busy} onClick={() => void update()} data-testid="update-now"><i className="fa-solid fa-download" aria-hidden="true" /> Update to {next.version}</button>
          <span className="tiny faint">{sizeText(next.size)}</span>
        </div>
      ) : latest ? <p className="small muted">You have the newest version.</p> : null}
      {ev && <p className="small" role="status" data-testid="update-status">{ev.message}</p>}
      <label className="row small" style={{ gap: 8, flexWrap: 'nowrap' }}>
        <input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); setAutoUpdate(e.target.checked); }} data-testid="auto-update" />
        <span>Update automatically when this server has a newer version</span>
      </label>
      <p className="tiny faint">
        {app.platform === 'android' ? 'Android asks you to confirm each install, and once to allow Alexandria to install apps.'
          : app.platform === 'windows' ? 'The installer runs with a progress bar; Alexandria closes for it, then open it again.'
          : app.platform === 'macos' ? 'The new version opens in Finder: drag it into Applications.'
          : 'The new version installs to ~/.local and restarts.'}
        {' '}Downloads are checked against the server's checksum before anything installs.
      </p>
    </section>
  );
}

export function Downloads() {
  const b = useBuilds();
  const act = useAction();
  const app = appInfo();
  const list = b.data?.builds ?? [];
  // The newest build per platform first; older ones stay available below it.
  const download = (x: Build) => act.run(async () => {
    const t = await b.ticket(x.file);
    if (inApp()) { window.open(t.url, '_blank'); return; } // the system browser downloads it
    const a = document.createElement('a');
    a.href = t.url; a.download = x.file; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  });
  if (b.data && !list.length) return null;
  return (
    <section className="card" aria-labelledby="dl-h" data-testid="downloads">
      <h2 id="dl-h">Download from this server</h2>
      <p className="small muted">The apps, straight from your DM's server. {isIOS() ? 'On iPhone, install from Safari instead (above).' : ''}</p>
      <ErrorBox error={act.error ?? b.error} />
      <ul className="dl-list">
        {list.map((x) => (
          <li key={x.file}>
            <span className="grow">
              <strong>{PLATFORM_NAMES[x.platform]}</strong>{x.arch !== 'universal' && <span className="muted"> · {x.arch}</span>}
              {' '}<span className="muted">{x.version ?? x.release ?? ''}</span>
              {b.data?.latest[x.platform]?.file !== x.file && <span className="chip">older</span>}
              {app?.platform === x.platform && b.data?.latest[x.platform]?.file === x.file && <span className="chip gold">this app</span>}
              <br /><span className="tiny faint">{x.file} · {sizeText(x.size)}</span>
            </span>
            <button type="button" className="btn small" disabled={act.busy} onClick={() => void download(x)} aria-label={`Download ${x.file}`}><i className="fa-solid fa-download" aria-hidden="true" /> Download</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
