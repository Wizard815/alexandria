// The GM's assistant: docked to the right edge on every GM page, collapsible.
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useWorld } from '../../lib/world.tsx';
import { DockButton, useDockShift } from '../../ui/Dock.tsx';
import { useMainPrefs } from '../screens/prefs.ts';
import Chat, { ACTIONS_CHANGED } from './Chat.tsx';
import { SpokenNotice } from './aloud.tsx';
import Statblock from './Statblock.tsx';
import { PREFILL_EVENT } from './prefill.ts';
import './agent.css';

const KEY = 'alx-agent-open';
const wasOpen = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

export default function AgentPanel() {
  const { isGM } = useWorld();
  const [main] = useMainPrefs();
  // With the assistant on the side screen the main monitor keeps its full width.
  return isGM && !main.hideAssistant ? <Panel /> : null;
}

/** How many of the assistant's changes wait for the GM: shown on the folded assistant's dock button. */
function usePendingCount(): number {
  const { w, on } = useWorld();
  const [n, setN] = useState(0);
  const load = useCallback(() => { void w.call<{ actions: unknown[] }>('GET', '/agent/actions?status=pending').then((r) => setN(r.actions?.length ?? 0)).catch(() => {}); }, [w]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => on(['agent'], (e) => { const k = (e.data as any)?.kind; if (k === 'action' || k === 'message') load(); }), [on, load]);
  useEffect(() => { window.addEventListener(ACTIONS_CHANGED, load); return () => window.removeEventListener(ACTIONS_CHANGED, load); }, [load]);
  return n;
}

function Panel() {
  const pending = usePendingCount();
  const [open, setOpen] = useState(wasOpen);
  const [tab, setTab] = useState<'chat' | 'statblock'>('chat');
  const loc = useLocation();
  const { world } = useParams();
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

  // "Ask the assistant" from another page opens the panel on the chat; the chat puts the text in its box.
  useEffect(() => {
    const onFill = () => { setTab('chat'); set(true); };
    window.addEventListener(PREFILL_EVENT, onFill);
    return () => window.removeEventListener(PREFILL_EVENT, onFill);
  }, [set]);
  useDockShift(open);
  // Heard even with the panel folded away; clicking it unfolds the panel on the chat it names.
  const notice = <SpokenNotice onOpen={() => { setTab('chat'); set(true); }} />;
  if (!open) return <>{notice}<DockButton order={20} icon="fa-wand-magic-sparkles" label="Open the assistant (Ctrl+K)" title="Assistant (Ctrl+K)" text="Assistant" badge={pending || undefined} onClick={() => { set(true); focusInput(); }} testId="dock-agent" /></>;
  return (
    <>{notice}<aside className="ag-panel" aria-label="Assistant">
      <header className="ag-head">
        <strong style={{ flex: 1 }}><i className="fa-solid fa-comments" aria-hidden="true" /> Assistant</strong>
        <button type="button" className={`btn small${tab === 'chat' ? ' on' : ''}`} onClick={() => setTab('chat')}>Chat</button>
        <button type="button" className={`btn small${tab === 'statblock' ? ' on' : ''}`} onClick={() => setTab('statblock')}>Statblock</button>
        <button type="button" className="btn small ghost" aria-label="Pop the assistant out into its own window" title="Pop out (its own window: a second screen, beside other apps)" data-testid="ag-popout" onClick={() => { window.open(`/w/${encodeURIComponent(world ?? '')}/assistant-window`, 'alx-assistant', 'popup,width=460,height=800'); set(false); }}><i className="fa-solid fa-up-right-from-square" aria-hidden="true" /></button>
        <button type="button" className="btn small ghost" aria-label="Collapse the assistant" onClick={() => set(false)}><i className="fa-solid fa-chevron-right" aria-hidden="true" /></button>
      </header>
      <div className="ag-body">
        <div style={{ display: tab === 'chat' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}><Chat harness="gm" page={page} placeholder="Ask, or tell it what to do…" /></div>
        {tab === 'statblock' && <Statblock page={page} />}
      </div>
    </aside></>
  );
}
