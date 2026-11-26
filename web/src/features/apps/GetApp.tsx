// /get-app: where to download the apps and how to install each. Needs no sign-in, so the DM
// can send the link to a new player. The download address comes from the server
// (ALX_APP_DOWNLOADS, the GitHub releases page by default).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { isIOS } from '../../lib/install.tsx';
import { inApp } from '../../lib/nativeApp.ts';
import type { AppInfo } from './api.ts';

export default function GetApp() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => { fetch('/api/apps').then((r) => (r.ok ? r.json() : null)).then(setInfo).catch(() => setInfo(null)); }, []);
  const dl = info?.downloads ?? 'https://github.com/Wizard815/alexandria/releases/latest';
  const ios = isIOS();
  return (
    <div className="t-fantasy">
      <div className="page apps-page" style={{ maxWidth: 760 }}>
        <header className="stack tight">
          <h1>Get Alexandria</h1>
          <p className="muted">Every app opens this same server and uses the same sign-in.{info?.release ? ` This server runs ${info.release} (${info.version}).` : ''}</p>
        </header>
        <section className={`card${ios ? ' gold' : ''}`} aria-labelledby="ios-h">
          <h2 id="ios-h">iPhone and iPad</h2>
          <ol className="small">
            <li>Open <strong>{typeof location !== 'undefined' ? location.host : 'this server'}</strong> in <strong>Safari</strong> and sign in.</li>
            <li>Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</li>
            <li>Open it from the icon: full screen, works offline, and stays signed in.</li>
          </ol>
          <p className="tiny faint">There is no App Store app yet; the installed web app is the iPhone app.</p>
        </section>
        <section className="card" aria-labelledby="and-h">
          <h2 id="and-h">Android</h2>
          <ol className="small">
            <li>Download <strong>Alexandria-…-android.apk</strong> from the <a href={dl} target="_blank" rel="noreferrer">downloads page</a>.</li>
            <li>Open it and allow installing from your browser when Android asks.</li>
            <li>Type this server's address on first run, sign in, then add widgets: More, This device, Home-screen widget.</li>
          </ol>
          <p className="tiny faint">Or install the web app from Chrome's menu (Install app), with no widgets.</p>
        </section>
        <section className="card" aria-labelledby="desk-h">
          <h2 id="desk-h">Windows, macOS and Linux</h2>
          <p className="small">The setup .exe, the .dmg or the Linux .tar.gz, from the <a href={dl} target="_blank" rel="noreferrer">downloads page</a>. The desktop app adds a separate Assistant window with a global shortcut and the players' screen window.</p>
        </section>
        {!inApp() && <p className="small"><Link to="/">← Back to Alexandria</Link></p>}
      </div>
    </div>
  );
}

/** /app-link/... opened in a browser rather than in the app: nothing to do here. */
export function AppLinkFallback() {
  return (
    <div className="t-fantasy">
      <div className="page" style={{ maxWidth: 560 }}>
        <h1>Open this in the app</h1>
        <p className="muted">This link is for the Alexandria app. In a browser it does nothing.</p>
        <p><Link to="/" className="btn">Back to Alexandria</Link> <Link to="/get-app" className="btn ghost">Get the app</Link></p>
      </div>
    </div>
  );
}
