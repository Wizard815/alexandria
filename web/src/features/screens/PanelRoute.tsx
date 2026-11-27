// /w/:world/panel/:name: one GM panel filling its own window, with none of the GM app's menu around it.
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useWorld } from '../../lib/world.tsx';
import { panelById } from './panels.tsx';
import './screens.css';

export default function PanelRoute() {
  const { name = '' } = useParams();
  const { isDM, info } = useWorld();
  const def = panelById(name);
  useEffect(() => { document.title = `${def?.title ?? 'Panel'} · ${info?.name ?? 'Alexandria'}`; }, [def?.title, info?.name]);
  if (!isDM) return <div className="t-fantasy"><div className="page"><p className="muted">Pop-out panels are for the GM.</p></div></div>;
  if (!def) return <div className="t-fantasy"><div className="page"><p className="muted">There is no panel called “{name}”.</p></div></div>;
  return (
    <div className="t-fantasy sc-window" data-testid={`panel-${def.id}`}>
      <header className="sc-bar"><i className={`fa-solid ${def.icon}`} aria-hidden="true" /> <strong>{def.title}</strong></header>
      <div className={`sc-body${def.page ? ' sc-scroll' : ''}`}>{def.render()}</div>
    </div>
  );
}
