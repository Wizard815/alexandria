// The DM's assistant: docked to the right edge on every DM page, collapsible.
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useWorld } from '../../lib/world.tsx';
import Chat from './Chat.tsx';
import Statblock from './Statblock.tsx';
import './agent.css';

const KEY = 'alx-agent-open';
const wasOpen = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

export default function AgentPanel() {
  const { isDM } = useWorld();
  return isDM ? <Panel /> : null;
}

function Panel() {
  const [open, setOpen] = useState(wasOpen);
  const [tab, setTab] = useState<'chat' | 'statblock'>('chat');
  const loc = useLocation();
  const page = new URLSearchParams(loc.search).get('page') ?? undefined;
  const set = (v: boolean) => { setOpen(v); try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* private mode */ } };

  if (!open) return <button type="button" className="ag-tab" aria-label="Open the assistant" onClick={() => set(true)}><i className="fa-solid fa-comments" aria-hidden="true" /> Assistant</button>;
  return (
    <aside className="ag-panel" aria-label="Assistant">
      <header className="ag-head">
        <strong style={{ flex: 1 }}><i className="fa-solid fa-comments" aria-hidden="true" /> Assistant</strong>
        <button type="button" className={`btn small${tab === 'chat' ? ' on' : ''}`} onClick={() => setTab('chat')}>Chat</button>
        <button type="button" className={`btn small${tab === 'statblock' ? ' on' : ''}`} onClick={() => setTab('statblock')}>Statblock</button>
        <button type="button" className="btn small ghost" aria-label="Collapse the assistant" onClick={() => set(false)}><i className="fa-solid fa-chevron-right" aria-hidden="true" /></button>
      </header>
      <div className="ag-body">
        <div style={{ display: tab === 'chat' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}><Chat harness="dm" getContext={() => ({ page })} placeholder="Ask, or tell it what to do…" /></div>
        {tab === 'statblock' && <Statblock page={page} />}
      </div>
    </aside>
  );
}
