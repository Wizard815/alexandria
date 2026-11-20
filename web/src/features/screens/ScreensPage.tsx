// The DM's Screens page: one card per display, an Open button for each, and (where the browser can) a choice of which physical
// monitor each one opens on.
import { useEffect, useState } from 'react';
import { PageHead } from '../../ui/index.tsx';
import { useWorld } from '../../lib/world.tsx';
import { canManageWindows, detectMonitors, openDisplay, type Monitor } from './open.ts';
import { panelUrl } from './names.ts';
import { PANELS } from './panels.tsx';
import { useAssignments, useMainPrefs } from './prefs.ts';
import './screens.css';

export default function ScreensPage() {
  const { info } = useWorld();
  const base = `/w/${encodeURIComponent(info.slug)}`;
  const [monitors, setMonitors] = useState<Monitor[] | null>(null);
  const [problem, setProblem] = useState('');
  const [assign, setAssign] = useAssignments();
  const [main, setMain] = useMainPrefs();
  const [blocked, setBlocked] = useState(false);
  const can = canManageWindows();

  const find = async () => {
    setProblem('');
    try { setMonitors(await detectMonitors()); } catch { setProblem('The browser did not allow it. Allow “window management” for this site (the padlock by the address) and try again.'); }
  };
  // If the DM already said yes on an earlier visit, pick the monitors up without asking again.
  useEffect(() => {
    if (!can) return;
    void (navigator.permissions as any)?.query?.({ name: 'window-management' }).then((s: any) => { if (s.state === 'granted') void find(); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [can]);

  const open = async (url: string, name: string, id: string) => { setBlocked(!(await openDisplay(url, name, id))); };

  const displays: { id: string; title: string; icon: string; url: string; name: string; about: string }[] = [
    { id: 'side', title: 'DM side screen', icon: 'fa-table-columns', url: `${base}/screen/side`, name: 'alx-side', about: 'The tall screen beside your main one: stack the assistant, transcript, initiative and approvals, fold them away or make them taller.' },
    { id: 'players', title: 'Players’ screen', icon: 'fa-tv', url: `${base}/screen/players`, name: 'alx-players', about: 'The TV facing the players: what you stage for them, handouts and scenes. Only what the players may see.' },
    { id: 'table', title: 'Table screen', icon: 'fa-chess-board', url: `${base}/screen/table`, name: 'alx-table', about: 'The screen lying face up where the players gather: the battle map and the initiative order, big, with a rotate button. It shows the players’ view only, even from your login.' },
  ];
  const Pick = ({ id }: { id: string }) => monitors ? (
    <label className="sc-assign">
      <span className="small muted">Open on</span>
      <select value={assign[id] ?? ''} onChange={(e) => setAssign({ [id]: e.target.value })} aria-label={`Screen for ${id}`} data-testid={`assign-${id}`}>
        <option value="">This window’s screen</option>
        {monitors.map((m) => <option key={m.key} value={m.key}>{m.label} ({m.width}×{m.height}{m.primary ? ', main' : ''})</option>)}
      </select>
    </label>
  ) : null;

  return (
    <div className="page" data-testid="screens-page">
      <PageHead title="Screens" lead="Run the table across several monitors: each display is its own window, and they all stay in step with the game." />
      <section className="card stack">
        <h2>A four-monitor table</h2>
        <ol className="small" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
          <li><strong>Main</strong> (landscape, in front of you): this app, the way you use it now.</li>
          <li><strong>Side</strong> (portrait, to its right): the DM side screen, a stack of assistant, transcript, initiative and approvals.</li>
          <li><strong>TV</strong> (facing the players): the Players’ screen.</li>
          <li><strong>Table</strong> (face up, in the middle of everyone): the battle map and initiative.</li>
        </ol>
        <p className="small muted">Open each display, then put it on its monitor. {can
          ? 'This browser can do that for you: find your screens below, choose one for each display, and it opens full-size there.'
          : 'This browser cannot choose the monitor for a window (Chrome and Edge can). Open the display, drag its window onto the right screen and press F11 for full screen.'}</p>
      </section>

      {can && (
        <section className="card stack" aria-label="Your monitors">
          <div className="row between">
            <h2>Your monitors</h2>
            <button type="button" className="btn" data-testid="find-screens" onClick={() => void find()}>{monitors ? 'Look again' : 'Find my screens'}</button>
          </div>
          {monitors ? (
            <ul className="sc-monitors">
              {monitors.map((m) => <li key={m.key}><strong>{m.label}</strong> <span className="muted small">{m.width}×{m.height} at {m.left},{m.top}{m.primary ? ' · main' : ''}</span></li>)}
            </ul>
          ) : <p className="small muted">The browser asks permission to see your screens. Nothing leaves this computer.</p>}
          {problem && <div className="error-box" role="alert">{problem}</div>}
        </section>
      )}
      {!can && <p className="small muted" data-testid="no-winmgmt">This browser cannot choose a screen for a window: open it normally, then drag it to the screen and press F11.</p>}
      {blocked && <div className="error-box" role="alert">The browser blocked the new window. Allow pop-ups for this site and press Open again.</div>}

      <div className="sc-cards">
        {displays.map((d) => (
          <section key={d.id} className="card stack" data-testid={`screen-card-${d.id}`}>
            <h3><i className={`fa-solid ${d.icon}`} aria-hidden="true" /> {d.title}</h3>
            <p className="small muted">{d.about}</p>
            <code className="tiny faint">{d.url}</code>
            <Pick id={d.id} />
            <div className="row">
              <button type="button" className="btn primary" data-testid={`open-${d.id}`} onClick={() => void open(d.url, d.name, d.id)}>Open</button>
            </div>
          </section>
        ))}
        <section className="card stack" data-testid="screen-card-panels">
          <h3><i className="fa-solid fa-window-restore" aria-hidden="true" /> Pop-out panels</h3>
          <p className="small muted">Any one panel in its own window, for a spare monitor or beside another app. The ↗ button on a page does the same.</p>
          <Pick id="panels" />
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {PANELS.map((p) => (
              <button key={p.id} type="button" className="btn small" data-testid={`open-panel-${p.id}`} onClick={() => void open(panelUrl(info.slug, p.id), `alx-panel-${p.id}`, 'panels')}>
                <i className={`fa-solid ${p.icon}`} aria-hidden="true" /> {p.title}
              </button>
            ))}
          </div>
        </section>
      </div>

      <section className="card stack" aria-label="This monitor">
        <h2>On this main monitor</h2>
        <p className="small muted">When the assistant and transcript live on the side screen, take them off this one so the pages get the full width. This is a choice for this browser only.</p>
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" data-testid="hide-assistant" checked={main.hideAssistant} onChange={(e) => setMain({ hideAssistant: e.target.checked })} /> Hide the docked assistant here (it is on the side screen)</label>
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" data-testid="hide-transcript" checked={main.hideTranscript} onChange={(e) => setMain({ hideTranscript: e.target.checked })} /> Hide the floating transcript here (it is on the side screen)</label>
      </section>
    </div>
  );
}
