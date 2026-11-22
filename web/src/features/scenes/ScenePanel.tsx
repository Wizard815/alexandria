// The big-button scene panel for the side screen and the pop-out window: one press sets the room, and the result says per
// part what happened (a failing part does not stop the others). Undo puts back what the last scene changed.

import { outcomeLines, partsOf, useScenes, type Outcome, type Scene, type ScenesApi } from './useScenes.ts';
import './scenes.css';

export function SceneIcon({ s }: { s: Pick<Scene, 'icon'> }) {
  if (!s.icon) return null;
  return /^fa-/.test(s.icon) ? <i className={`fa-solid ${s.icon}`} aria-hidden="true" /> : <span aria-hidden="true">{s.icon}</span>;
}

export function OutcomeView({ o, onClose }: { o: Outcome; onClose?: () => void }) {
  const lines = outcomeLines(o);
  return (
    <div className={`scn-report ${o.ok ? 'ok' : 'bad'}`} role="status" data-testid="scene-report">
      <strong>{o.kind === 'undo' ? `Undid ${o.name}` : o.ok ? `${o.name} is on` : `${o.name}: some parts failed`}</strong>
      {o.empty && <span className="small muted">This scene sets nothing yet.</span>}
      <ul>
        {lines.map((l) => <li key={l.key} className={l.status} data-testid={`scene-part-${l.key}`}><b>{l.label}</b> {l.status === 'failed' ? 'failed: ' : ''}{l.text}</li>)}
      </ul>
      {onClose && <button type="button" className="btn small ghost" onClick={onClose}>Dismiss</button>}
    </div>
  );
}

/** The buttons themselves, without a page around them. */
export function SceneButtons({ api }: { api: ScenesApi }) {
  const { scenes, last } = api;
  return (
    <div className="scn-wrap" data-testid="scene-buttons">
      {api.error && <div className="error-box" role="alert">{api.error}</div>}
      {!scenes.length && !api.loading && <p className="muted">No scenes yet. Make them on the Scenes page, or save the room as it is.</p>}
      <div className="scn-grid">
        {scenes.map((s) => (
          <button key={s.id} type="button" className="scn-btn" data-testid="scene-btn" data-scene={s.name} disabled={api.busy}
            style={s.color ? ({ '--scn': s.color } as React.CSSProperties) : undefined} onClick={() => void api.activate(s)}
            aria-label={`Activate scene ${s.name}`} title={partsOf(s).length ? `Sets: ${partsOf(s).join(', ')}` : 'Sets nothing yet'}>
            <SceneIcon s={s} /><span>{s.name}</span>
            <small>{partsOf(s).length ? partsOf(s).map((k) => ({ tv: 'TV', sound: 'sound', lights: 'lights', table: 'map' }[k])).join(' · ') : 'empty'}</small>
          </button>
        ))}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn" data-testid="scene-undo" disabled={api.busy || !last?.canUndo} onClick={() => void api.undo(last?.name ?? '')}>
          <i className="fa-solid fa-rotate-left" aria-hidden="true" /> Undo scene{last?.canUndo ? ` (${last.name})` : ''}
        </button>
      </div>
      {api.outcome && <OutcomeView o={api.outcome} onClose={api.clearOutcome} />}
    </div>
  );
}


export default function ScenePanel() {
  const api = useScenes();
  return <SceneButtons api={api} />;
}
