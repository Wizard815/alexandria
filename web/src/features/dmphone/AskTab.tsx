// Ask: the DM agent on a phone. The reply streams in through the live
// 'agent' events (the chat is also polled while it works), and actions the
// agent proposes wait right under its message for one tap.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import { Markdown, useAction } from '../../ui/index.tsx';
import { Err } from './Sheet.tsx';
import { buzz, lsGet, lsSet } from './hooks.ts';

interface Msg { id: string; role: 'user' | 'assistant'; text: string; status: 'done' | 'working' | 'error'; at: string }
interface Act { id: string; tool: string; summary: string; status: string; createdAt: string }
interface ChatState { id: string; messages: Msg[]; actions: Act[]; busy: boolean }

const CHIPS: { label: string; send?: string; fill?: string }[] = [
  { label: 'Next turn', send: 'next turn' },
  { label: "What's the DC…", fill: "What's the DC for " },
  { label: 'Make a statblock', fill: 'Make a statblock for ' },
  { label: 'Summarise last session', send: 'What happened last session? Give me the key events and open threads.' },
];

export default function AskTab() {
  const { w, info, on } = useWorld();
  const key = `alx-agent-chat:${info.id}:dm`;
  const [chat, setChat] = useState<ChatState | null>(null);
  const [text, setText] = useState('');
  const [live, setLive] = useState<{ text: string; status: string } | null>(null);
  const [model, setModel] = useState<boolean | null>(null);
  const { busy, error, setError, run } = useAction();
  const end = useRef<HTMLDivElement>(null);
  const ref = useRef<ChatState | null>(null);
  ref.current = chat;

  const load = useCallback(async (id: string) => {
    try { setChat(await w.call<ChatState>('GET', `/agent/chats/${id}`)); } catch (e: any) { setError(e.message); }
  }, [w, setError]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const st = await w.call<any>('GET', '/agent/status');
        if (alive) setModel(!!st.model);
        const id = lsGet(key);
        if (id) { try { const c = await w.call<ChatState>('GET', `/agent/chats/${id}`); if (alive) setChat(c); return; } catch { /* deleted: start fresh */ } }
        const list = await w.call<{ chats: { id: string }[] }>('GET', '/agent/chats');
        if (list.chats[0]) { lsSet(key, list.chats[0].id); const c = await w.call<ChatState>('GET', `/agent/chats/${list.chats[0].id}`); if (alive) setChat(c); }
      } catch (e: any) { if (alive) setError(e.message); }
    })();
    return () => { alive = false; };
  }, [w, key, setError]);

  useEffect(() => on(['agent'], (e) => {
    const d: any = e.data;
    const cur = ref.current;
    if (!cur || d?.chatId !== cur.id) return;
    if (d.kind === 'delta') setLive((l) => ({ text: (l?.text ?? '') + d.text, status: '' }));
    else if (d.kind === 'reset') setLive({ text: '', status: '' });
    else if (d.kind === 'replace') setLive({ text: d.text, status: '' });
    else if (d.kind === 'status') setLive((l) => ({ text: l?.text ?? '', status: String(d.status ?? d.text ?? '') }));
    else if (d.kind === 'message' || d.kind === 'action') { if (d.kind === 'message') setLive(null); void load(cur.id); }
  }), [on, load]);

  useEffect(() => {
    if (!chat?.busy) { setLive(null); return; }
    const t = setInterval(() => void load(chat.id), 1500);
    return () => clearInterval(t);
  }, [chat?.busy, chat?.id, load]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [chat?.messages.length, chat?.actions.length, live?.text.length]);

  const send = (override?: string) => run(async () => {
    const body = (override ?? text).trim();
    if (!body) return;
    buzz(10);
    let id = chat?.id;
    if (!id) { const c = await w.call<ChatState>('POST', '/agent/chats', {}); id = c.id; lsSet(key, id); }
    setText('');
    setLive({ text: '', status: '' });
    setChat(await w.call<ChatState>('POST', `/agent/chats/${id}/messages`, { text: body }));
  });
  const stop = () => { if (chat) void w.call('POST', `/agent/chats/${chat.id}/stop`, {}).catch((e: any) => setError(e.message)); };
  const fresh = () => run(async () => { const c = await w.call<ChatState>('POST', '/agent/chats', {}); lsSet(key, c.id); setChat(c); setLive(null); });
  const decide = (a: Act, decision: 'approve' | 'reject') => run(async () => {
    buzz(15);
    try { await w.call('POST', `/agent/actions/${a.id}`, { decision }); } catch (e: any) { setError(e.message); }
    if (chat) await load(chat.id);
  });

  const items = [
    ...(chat?.messages ?? []).map((m) => ({ t: 'm' as const, m, at: m.at })),
    ...(chat?.actions ?? []).filter((a) => a.status === 'pending' || a.status === 'running').map((a) => ({ t: 'a' as const, a, at: a.createdAt })),
  ].sort((x, y) => x.at.localeCompare(y.at));
  const working = !!chat?.busy;

  return (
    <div className="ask">
      <div className="ask-log" aria-live="polite" data-testid="ask-log">
        {model === false && <div className="sub">No chat model is set (Admin, Models). Dice, the date and simple combat commands still work.</div>}
        {!items.length && <div className="empty">Ask about your world, the last session, the rules or the fight. Nothing it proposes happens until you approve it.</div>}
        {items.map((it) => {
          if (it.t === 'a') {
            const a = it.a;
            return (
              <div key={a.id} className="c" style={{ borderColor: 'var(--line-strong)' }} role="group" aria-label="Waiting for your approval">
                <b className="tx">{a.summary}</b>
                <div className="grid g2">
                  <button type="button" className="b ok" disabled={busy || a.status !== 'pending'} onClick={() => void decide(a, 'approve')}>Approve</button>
                  <button type="button" className="b danger" disabled={busy || a.status !== 'pending'} onClick={() => void decide(a, 'reject')}>Reject</button>
                </div>
              </div>
            );
          }
          const m = it.m;
          const shown = m.status === 'working' ? (live && live.text.length >= m.text.length ? live.text : m.text) : m.text;
          return (
            <div key={m.id} className={`msg${m.role === 'user' ? ' me' : ''}`}>
              {m.status === 'working' && !shown ? <span className="sub">{live?.status ? `Using ${live.status}…` : 'Thinking…'}</span>
                : m.role === 'assistant' ? <Markdown text={shown} /> : <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>}
              {m.status === 'error' && <div className="sub" style={{ color: 'var(--danger-text)' }}>That did not work.</div>}
            </div>
          );
        })}
        <div ref={end} />
      </div>
      <div className="ask-bar">
        <Err error={error} />
        <div className="flow" aria-label="Quick asks" style={{ flexWrap: 'nowrap', overflowX: 'auto', paddingBottom: 2 }}>
          {CHIPS.map((q) => <button key={q.label} type="button" className="b chip" style={{ flex: '0 0 auto' }} disabled={busy || working} onClick={() => { if (q.send) void send(q.send); else setText(q.fill ?? ''); }}>{q.label}</button>)}
          <button type="button" className="b chip" style={{ flex: '0 0 auto' }} onClick={() => void fresh()}>New chat</button>
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <label className="grow"><span className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Message</span>
            <textarea rows={1} value={text} placeholder="Ask…" onChange={(e) => setText(e.target.value)} /></label>
          {working
            ? <button type="button" className="b danger" onClick={stop} aria-label="Stop the answer"><i className="fa-solid fa-stop" aria-hidden="true" /></button>
            : <button type="submit" className="b primary" disabled={busy || !text.trim()} aria-label="Send"><i className="fa-solid fa-paper-plane" aria-hidden="true" /></button>}
        </form>
      </div>
    </div>
  );
}
