// The DM's assistant: docked to the right edge on every DM page, collapsible.
import { useCallback, useEffect, useState } from 'react';
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
  const set = useCallback((v: boolean) => { setOpen(v); try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* private mode */ } }, []);
  const focusInput = () => setTimeout(() => document.querySelector<HTMLTextAreaElement>('[data-ag-input]')?.focus(), 30);

  // Ctrl/Cmd+K opens the assistant and puts the cursor in its box; again (from the box) closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const box = document.querySelector('[data-ag-input]');
        if (box && document.activeElement === box) { set(false); return; }
        setTab('chat');
        set(true);
        focusInput();
      } else if (e.key === 'Escape' && document.activeElement === document.querySelector('[data-ag-input]') && !(document.activeElement as HTMLTextAreaElement).value) set(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [set]);

  if (!open) return <button type="button" className="ag-tab" aria-label="Open the assistant (Ctrl+K)" title="Ctrl+K" onClick={() => { set(true); focusInput(); }}><i className="fa-solid fa-comments" aria-hidden="true" /> Assistant</button>;
  return (
    <aside className="ag-panel" aria-label="Assistant">
      <header className="ag-head">
        <strong style={{ flex: 1 }}><i className="fa-solid fa-comments" aria-hidden="true" /> Assistant</strong>
        <button type="button" className={`btn small${tab === 'chat' ? ' on' : ''}`} onClick={() => setTab('chat')}>Chat</button>
        <button type="button" className={`btn small${tab === 'statblock' ? ' on' : ''}`} onClick={() => setTab('statblock')}>Statblock</button>
        <button type="button" className="btn small ghost" aria-label="Collapse the assistant" onClick={() => set(false)}><i className="fa-solid fa-chevron-right" aria-hidden="true" /></button>
      </header>
      <div className="ag-body">
        <div style={{ display: tab === 'chat' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}><Chat harness="dm" page={page} placeholder="Ask, or tell it what to do…" /></div>
        {tab === 'statblock' && <Statblock page={page} />}
      </div>
    </aside>
  );
}
