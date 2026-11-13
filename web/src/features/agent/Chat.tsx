// One conversation with the assistant: messages, citations, and (for the
// DM) the actions waiting for approval. Replies arrive by polling the chat
// while it is busy; the 'agent' live event just makes it quicker.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorBox, Markdown, useAction } from '../../ui/index.tsx';
import { useWorld } from '../../lib/world.tsx';

interface Citation { kind: string; id: string; title: string; path?: string; snippet?: string }
interface Msg { id: string; role: 'user' | 'assistant'; text: string; status: 'done' | 'working' | 'error'; citations: Citation[] }
interface Act { id: string; tool: string; summary: string; call: unknown; status: string; result: string | null }
interface ChatState { id: string; messages: Msg[]; actions: Act[]; busy: boolean }

const KEY = (world: string, harness: string) => `alx-agent-chat:${world}:${harness}`;
const remembered = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const remember = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

export default function Chat({ harness, getContext, placeholder }: { harness: 'dm' | 'player'; getContext?: () => { page?: string; selection?: string }; placeholder?: string }) {
  const { w, info, on } = useWorld();
  const [chat, setChat] = useState<ChatState | null>(null);
  const [text, setText] = useState('');
  const [withSel, setWithSel] = useState('');
  const [model, setModel] = useState<boolean | null>(null);
  const { busy, error, setError, run } = useAction();
  const end = useRef<HTMLDivElement>(null);
  const key = KEY(info.id, harness);

  const load = useCallback(async (id: string) => {
    try { setChat(await w.call<ChatState>('GET', `/agent/chats/${id}`)); } catch (e: any) { setError(e.message); }
  }, [w, setError]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const st = await w.call<any>('GET', '/agent/status');
        if (live) setModel(!!st.model);
        const id = remembered(key);
        if (id) { try { const c = await w.call<ChatState>('GET', `/agent/chats/${id}`); if (live) setChat(c); return; } catch { /* a deleted chat: start fresh */ } }
        const list = await w.call<{ chats: { id: string }[] }>('GET', '/agent/chats');
        if (list.chats[0]) { remember(key, list.chats[0].id); const c = await w.call<ChatState>('GET', `/agent/chats/${list.chats[0].id}`); if (live) setChat(c); }
      } catch (e: any) { if (live) setError(e.message); }
    })();
    return () => { live = false; };
  }, [w, key, setError]);

  // Poll while the assistant is working, and refresh when it says something.
  useEffect(() => {
    if (!chat?.busy) return;
    const t = setInterval(() => void load(chat.id), 1200);
    return () => clearInterval(t);
  }, [chat?.busy, chat?.id, load]);
  useEffect(() => on(['agent'], () => { if (chat) void load(chat.id); }), [on, chat, load]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [chat?.messages.length, chat?.actions.length]);

  const send = () => run(async () => {
    const body = text.trim();
    if (!body) return;
    let id = chat?.id;
    if (!id) { const c = await w.call<ChatState>('POST', '/agent/chats', {}); id = c.id; remember(key, id); }
    const ctx = getContext?.() ?? {};
    setText('');
    setWithSel('');
    setChat(await w.call<ChatState>('POST', `/agent/chats/${id}/messages`, { text: body, page: ctx.page, selection: withSel || undefined }));
  });
  const fresh = () => run(async () => { const c = await w.call<ChatState>('POST', '/agent/chats', {}); remember(key, c.id); setChat(c); });
  const decide = (a: Act, decision: 'approve' | 'reject') => run(async () => {
    try { await w.call('POST', `/agent/actions/${a.id}`, { decision }); } catch (e: any) { setError(e.message); }
    if (chat) await load(chat.id);
  });

  const pending = chat?.actions.filter((a) => a.status === 'pending') ?? [];
  return (
    <div className="stack" style={{ minHeight: 0, flex: 1 }}>
      {model === false && <p className="tiny muted">No chat model is set yet (Admin → Models), so the assistant cannot answer.</p>}
      <div className="stack" style={{ overflowY: 'auto', flex: 1, minHeight: 120 }} aria-live="polite">
        {!chat?.messages.length && <p className="tiny muted">{harness === 'dm' ? 'Ask about your world, the last session, the rules or the fight. It can propose changes; nothing happens until you approve it.' : 'Ask about what your character knows: places, people, what happened, your items.'}</p>}
        {chat?.messages.map((m) => (
          <div key={m.id} className="stack tight" style={{ alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div className="card" style={{ padding: '8px 12px', maxWidth: '92%', borderColor: m.role === 'user' ? 'var(--accent)' : undefined }}>
              {m.status === 'working' ? <span className="muted">Thinking…</span> : m.role === 'assistant' ? <Markdown text={m.text} /> : <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>}
              {m.status === 'error' && <span className="tiny" style={{ color: 'var(--danger-text)' }}>That did not work.</span>}
            </div>
            {m.citations.length > 0 && (
              <ul className="tiny muted" style={{ margin: 0, paddingLeft: 16 }} aria-label="Sources">
                {m.citations.map((c) => <li key={`${c.kind}${c.id}`}><strong>{c.kind === 'transcript' ? `Transcript, ${c.title}` : c.title}</strong>{c.snippet ? `: ${c.snippet}` : ''}</li>)}
              </ul>
            )}
          </div>
        ))}
        {pending.map((a) => (
          <div key={a.id} className="card gold" style={{ padding: '10px 12px' }} role="group" aria-label="Waiting for your approval">
            <strong>{a.summary}</strong>
            <details className="tiny muted"><summary>Exact call</summary><code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{a.tool} {JSON.stringify(a.call)}</code></details>
            <div className="row"><button type="button" className="btn small primary" disabled={busy} onClick={() => void decide(a, 'approve')}>Approve</button><button type="button" className="btn small" disabled={busy} onClick={() => void decide(a, 'reject')}>Reject</button></div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <ErrorBox error={error} />
      {withSel && <p className="tiny muted" style={{ margin: 0 }}>Selected text will be sent: “{withSel.slice(0, 80)}{withSel.length > 80 ? '…' : ''}” <button type="button" className="btn small ghost" onClick={() => setWithSel('')}>Remove</button></p>}
      <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label className="grow" style={{ flex: 1 }}><span className="sr-only">Message</span>
          <textarea rows={2} style={{ width: '100%' }} value={text} placeholder={placeholder ?? 'Ask…'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        </label>
        <div className="stack tight">
          <button type="submit" className="btn primary small" disabled={busy || !text.trim() || chat?.busy}>Send</button>
          {getContext && <button type="button" className="btn small" title="Send the text you selected on the page" onMouseDown={(e) => e.preventDefault()} onClick={() => { const s = (window.getSelection()?.toString() ?? '').trim(); if (s) setWithSel(s.slice(0, 3000)); }}>Use selection</button>}
          <button type="button" className="btn small ghost" onClick={() => void fresh()}>New chat</button>
        </div>
      </form>
    </div>
  );
}
