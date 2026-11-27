// The assistant on its own, for a popped-out window: put it on a second screen or beside other apps. It is the same
// conversation as the docked panel (the same chat, the same live updates), so either can be used.
import { useEffect } from 'react';
import { useWorld } from '../../lib/world.tsx';
import Chat from './Chat.tsx';
import { SpokenNotice } from './aloud.tsx';
import './agent.css';

/** The assistant's chat on its own: a pop-out window or a panel on the side screen shows this. */
export function AssistantBody() {
  return (
    <>
      <div className="ag-body" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 12px 12px' }}>
        <Chat harness="dm" placeholder="Ask, or tell it what to do…" />
      </div>
      <SpokenNotice />
    </>
  );
}

export default function AssistantWindow() {
  const { isDM, info } = useWorld();
  useEffect(() => { document.title = `Assistant · ${info?.name ?? 'Alexandria'}`; }, [info?.name]);
  if (!isDM) return <div className="page"><p className="muted">The popped-out assistant is for the GM.</p></div>;
  return (
    <div className="t-fantasy ag-window" style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg, #111)' }}>
      <header className="ag-head" style={{ padding: '8px 12px' }}>
        <strong style={{ flex: 1 }}><i className="fa-solid fa-comments" aria-hidden="true" /> Assistant</strong>
      </header>
      <AssistantBody />
    </div>
  );
}
