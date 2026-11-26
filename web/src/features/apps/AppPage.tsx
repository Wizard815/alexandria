// "This device": install the web app, the Android app's home-screen widget, the desktop
// app's extras, change server, and where to get the apps. One page for players and the DM.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useWorld } from '../../lib/world.tsx';
import { InstallHint, isIOS, isStandalone } from '../../lib/install.tsx';
import { changeServer, inAndroidApp, inApp, linkWidget, unlinkWidget } from '../../lib/nativeApp.ts';
import { ErrorBox, useAction } from '../../ui/index.tsx';
import { Downloads, UpdateCard } from './Downloads.tsx';

export default function AppPage() {
  const { w, info, isDM } = useWorld();
  const act = useAction();
  const [linked, setLinked] = useState<'yes' | 'no' | null>(null);
  const android = inAndroidApp();
  const desktop = inApp() && !android;
  const installed = isStandalone();

  const link = () => act.run(async () => {
    const r = await w.call<{ key: string; world: string }>('POST', '/glance/link');
    linkWidget(r.key, r.world);
    setLinked('yes');
  });

  return (
    <div className="page apps-page" style={{ maxWidth: 760 }}>
      <header className="stack tight">
        <h1>This device</h1>
        <p className="muted">{android ? 'You are in the Alexandria Android app.' : desktop ? 'You are in the Alexandria desktop app.' : installed ? 'Alexandria is installed on this device.' : 'You are in a browser.'}</p>
      </header>
      <ErrorBox error={act.error} />

      {android && (
        <section className="card" aria-labelledby="widget-h">
          <h2 id="widget-h">Home-screen widget</h2>
          <p className="small">
            {isDM ? 'Whose turn it is, the session, open quick events and what waits for you, on your home screen.' : 'Your HP and mana, the session, quick events for you and what waits for you, on your home screen.'}
            {' '}The widget can only read that summary for {info.name}; it can't open the library or change anything.
          </p>
          {linked === 'yes' ? (
            <p className="small" role="status"><strong>Linked.</strong> Now long-press your home screen, pick Widgets, then Alexandria. A widget that was already there updates when you leave the app.</p>
          ) : linked === 'no' ? <p className="small" role="status">Unlinked. The widget shows how to link it again.</p> : null}
          <div className="row">
            <button type="button" className="btn" disabled={act.busy} onClick={() => void link()} data-testid="link-widget"><i className="fa-solid fa-link" aria-hidden="true" /> {linked === 'yes' ? 'Link again' : `Link the widget to ${info.name}`}</button>
            <button type="button" className="btn ghost" onClick={() => { unlinkWidget(); setLinked('no'); }}>Unlink</button>
          </div>
          <p className="tiny faint">One world at a time: linking another world moves the widget there. Each link shows in Connect an AI as a "Home-screen widget" key, which you can revoke.</p>
        </section>
      )}

      {desktop && (
        <section className="card" aria-labelledby="desk-h">
          <h2 id="desk-h">Desktop app</h2>
          <ul className="small">
            <li><strong>Ctrl+Shift+Space</strong> (Cmd+Shift+Space on a Mac) shows or hides the Assistant window from any program.</li>
            {isDM && <li>The Alexandria menu opens the players' screen in its own window, for a TV or second monitor.</li>}
            <li>Assistant always on top is in the Alexandria menu too.</li>
          </ul>
        </section>
      )}

      {!inApp() && !installed && (
        <section className="card" aria-labelledby="inst-h">
          <h2 id="inst-h">Install</h2>
          {isIOS() ? (
            <ol className="small">
              <li>Open this page in <strong>Safari</strong>.</li>
              <li>Tap <strong>Share</strong> <i className="fa-solid fa-arrow-up-from-bracket" aria-hidden="true" />, then <strong>Add to Home Screen</strong>.</li>
              <li>Open Alexandria from the new icon: it runs full screen, opens offline and keeps you signed in.</li>
            </ol>
          ) : <InstallHint className="stack tight" />}
          {!isIOS() && <p className="small muted">On Android you can also install the app (below), which adds home-screen widgets.</p>}
        </section>
      )}

      {(installed || inApp()) && (
        <section className="card" aria-labelledby="reload-h">
          <h2 id="reload-h">Reload</h2>
          <p className="small muted">An installed app has no reload button. Live updates arrive on their own; reload if something looks stuck.</p>
          <div className="row">
            <button type="button" className="btn" onClick={() => window.location.reload()}><i className="fa-solid fa-rotate-right" aria-hidden="true" /> Reload</button>
            {inApp() && <button type="button" className="btn ghost" onClick={changeServer}>Change server…</button>}
          </div>
        </section>
      )}

      <UpdateCard />
      <Downloads />

      <section className="card" aria-labelledby="get-h">
        <h2 id="get-h">Get the apps</h2>
        <p className="small">The Android app (with widgets) and the Windows, macOS and Linux apps, for players and the DM. They sign in to this same server.</p>
        <Link to="/get-app" className="btn">Get the app</Link>
      </section>
    </div>
  );
}
