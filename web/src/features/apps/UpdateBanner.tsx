// Inside the Android or desktop app: when this server has a newer build, a small banner
// offers it, or, with "Update automatically" on, the update starts by itself (once a session).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { appInfo, autoUpdateOn, startUpdate, updateFor } from '../../lib/nativeApp.ts';
import { useWorld } from '../../lib/world.tsx';
import { useBuilds, useUpdateEvents } from './useBuilds.ts';

const SEEN = 'alx.update.started';

export default function UpdateBanner() {
  const app = appInfo();
  if (!app) return null;
  return <Banner />;
}

function Banner() {
  const { info, isDM } = useWorld();
  const b = useBuilds();
  const ev = useUpdateEvents();
  const [hidden, setHidden] = useState(false);
  const next = updateFor(appInfo(), b.data);

  useEffect(() => {
    if (!next || !autoUpdateOn()) return;
    try { if (sessionStorage.getItem(SEEN) === next.version) return; sessionStorage.setItem(SEEN, next.version ?? ''); } catch { return; }
    void b.ticket(next.file).then(startUpdate).catch(() => {});
  }, [next?.file]); // eslint-disable-line react-hooks/exhaustive-deps

  if (ev && !hidden) {
    return (
      <div className="update-banner" role="status" data-testid="update-banner">
        <span className="grow">{ev.message}</span>
        <button type="button" className="icon-btn" aria-label="Hide" onClick={() => setHidden(true)}><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
      </div>
    );
  }
  if (!next || hidden || autoUpdateOn()) return null;
  return (
    <div className="update-banner" role="status" data-testid="update-banner">
      <span className="grow">Alexandria {next.version} is ready on this server.</span>
      <Link to={`/w/${info.slug}${isDM ? '/dm' : ''}/app`} className="btn small" onClick={() => setHidden(true)}>Update</Link>
      <button type="button" className="icon-btn" aria-label="Not now" onClick={() => setHidden(true)}><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
    </div>
  );
}
