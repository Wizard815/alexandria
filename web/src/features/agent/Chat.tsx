// One conversation with the assistant. The reply streams in as it is written
// (live 'agent' events, with the chat polled as a fallback), can be stopped,
// quotes its sources as links to library pages, and (for the DM) shows
// actions waiting for approval right under the message that proposed them.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorBox, Markdown, useAction } from '../../ui/index.tsx';
import { useWorld } from '../../lib/world.tsx';
import { useAuth } from '../../lib/auth.tsx';
import { AloudToggle, OPEN_CHAT, chatKey, claimSpoken, rememberChat, rememberedChat, speakAloud, stopSpeaking, useReadAloud } from './aloud.tsx';

interface Citation { kind: string; id: string; title: string; path?: string; snippet?: string }
interface Timings { totalMs: number; firstTokenMs?: number; modelMs: number; toolMs: number; gatewayMs: number; rounds: number; toolCalls: number; fast?: boolean }
interface Msg { id: string; role: 'user' | 'assistant'; text: string; status: 'done' | 'working' | 'error'; citations: Citation[]; at: string; timings?: Timings | null }
interface Act { id: string; tool: string; summary: string; call: unknown; status: string; result: string | null; createdAt: string }
interface ChatState { id: string; messages: Msg[]; actions: Act[]; busy: boolean }
interface Live { text: string; status: string }

const KEY = chatKey;
const remembered = rememberedChat;
const remember = rememberChat;
interface ChatRow { id: string; title: string; updatedAt: string }

/** [Title] in a reply becomes a [[wikilink]] when it names a page the reply drew on. */
export function linkCitations(text: string, cites: Citation[]): string {
  const pages = new Set(cites.filter((c) => c.kind === 'page').map((c) => c.title.toLowerCase()));
  if (!pages.size) return text;
  return text.replace(/\[([^\][\n]{2,120})\](?![(:[])/g, (m, t: string) => (pages.has(t.trim().toLowerCase()) ? `[[${t.trim()}]]` : m));
}

const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const timingText = (t: Timings) => `${seconds(t.totalMs)}${t.fast ? ' (no model)' : t.firstTokenMs !== undefined ? `, first text ${seconds(t.firstTokenMs)}` : ''}${t.toolCalls ? `, ${t.toolCalls} tool call${t.toolCalls === 1 ? '' : 's'}` : ''}`;
const timingTitle = (t: Timings) => `Total ${t.totalMs} ms: model ${t.modelMs} ms, tools ${t.toolMs} ms, Alexandria ${t.gatewayMs} ms, ${t.rounds} model round${t.rounds === 1 ? '' : 's'}`;

type Quick = { label: string; send?: string; fill?: string; needs?: 'page' };
const QUICK: Record<'dm' | 'player', Quick[]> = {
  dm: [
    { label: 'Summarise this page', send: 'Summarise this page: the key facts and what the party could do with it, in a few bullets.', needs: 'page' },
    { label: 'Make a statblock', fill: 'Make a statblock for ' },
    { label: 'What happened last session?', send: 'What happened last session? Give me the key events and open threads.' },
    { label: 'Next turn', send: 'next turn' },
  ],
  player: [
    { label: 'What happened last session?', send: 'What happened last session?' },
    { label: 'Who have we met?', send: 'Who have we met so far?' },
    { label: 'What do I have?', send: 'What items do I have?' },
  ],
};

export default function Chat({ harness, page, placeholder }: { harness: 'dm' | 'player'; page?: string; placeholder?: string }) {
  const { w, info, on, isDM } = useWorld();
  const { world = '' } = useParams();
  const navigate = useNavigate();
  const [chat, setChat] = useState<ChatState | null>(null);
  const [text, setText] = useState('');
  const [selection, setSelection] = useState('');
  const [dropPage, setDropPage] = useState(false);
  const [pageTitle, setPageTitle] = useState('');
  const [combat, setCombat] = useState<{ active: boolean; round?: number } | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [model, setModel] = useState<boolean | null>(null);
  const { busy, error, setError, run } = useAction();
  const { client } = useAuth();
  const [aloud] = useReadAloud();
  const [aloudNote, setAloudNote] = useState('');
  const [list, setList] = useState<ChatRow[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  // Assistant messages already seen in the open chat: only one that arrives after this is read aloud.
  const seen = useRef<{ chat: string; ids: Set<string> }>({ chat: '', ids: new Set() });
  const end = useRef<HTMLDivElement>(null);
  const chatRef = useRef<ChatState | null>(null);
  chatRef.current = chat;
  const key = KEY(info.id, harness);
  const attachedPage = page && !dropPage ? page : undefined;

  const load = useCallback(async (id: string) => {
    try { setChat(await w.call<ChatState>('GET', `/agent/chats/${id}`)); } catch (e: any) { setError(e.message); }
  }, [w, setError]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const st = await w.call<any>('GET', '/agent/status');
        if (alive) setModel(!!st.model);
        const id = remembered(key);
        if (id) { try { const c = await w.call<ChatState>('GET', `/agent/chats/${id}`); if (alive) setChat(c); return; } catch { /* a deleted chat: start fresh */ } }
        const list = await w.call<{ chats: { id: string }[] }>('GET', '/agent/chats');
        if (list.chats[0]) { remember(key, list.chats[0].id); const c = await w.call<ChatState>('GET', `/agent/chats/${list.chats[0].id}`); if (alive) setChat(c); }
      } catch (e: any) { if (alive) setError(e.message); }
    })();
    return () => { alive = false; };
  }, [w, key, setError]);

  const refreshList = useCallback(() => { w.call<{ chats: ChatRow[] }>('GET', '/agent/chats').then((r) => setList(r.chats ?? [])).catch(() => {}); }, [w]);
  useEffect(() => { refreshList(); }, [refreshList, chat?.id, chat?.busy]);

  const open = useCallback(async (id: string) => {
    setConfirmDel(false); setRenaming(null); setLive(null); stopSpeaking();
    try { const c = await w.call<ChatState>('GET', `/agent/chats/${id}`); remember(key, id); setChat(c); } catch (e: any) { setError(e.message); }
  }, [w, key, setError]);
  // The notice for a spoken request asks for its chat to be shown.
  useEffect(() => {
    const h = (e: Event) => { const id = (e as CustomEvent).detail?.chatId; if (id && harness === 'dm') void open(id); };
    window.addEventListener(OPEN_CHAT, h);
    return () => window.removeEventListener(OPEN_CHAT, h);
  }, [open, harness]);

  // Read a finished reply aloud (DM only, if switched on). What was already in the chat when it opened is never read.
  useEffect(() => {
    if (!chat) return;
    const done = chat.messages.filter((m) => m.role === 'assistant' && m.status === 'done' && m.text.trim());
    if (seen.current.chat !== chat.id) { seen.current = { chat: chat.id, ids: new Set(done.map((m) => m.id)) }; return; }
    const fresh = done.filter((m) => !seen.current.ids.has(m.id));
    for (const m of fresh) seen.current.ids.add(m.id);
    const last = fresh.at(-1);
    if (last && aloud && isDM && harness === 'dm' && claimSpoken(last.id)) void speakAloud(info.id, client.token, last.text).then((n) => setAloudNote(n ?? ''));
  }, [chat, aloud, isDM, harness, info.id, client]);
  useEffect(() => { if (!aloud) setAloudNote(''); }, [aloud]);

  // The title of the page that is attached, and whether a fight is running (DM only: only the DM's assistant is given it).
  useEffect(() => {
    setDropPage(false);
    setPageTitle('');
    if (!page) return;
    let alive = true;
    w.call<any>('GET', `/library/pages/${encodeURIComponent(page)}`).then((p) => { if (alive) setPageTitle(p?.title ?? ''); }).catch(() => {});
    return () => { alive = false; };
  }, [w, page]);
  const loadCombat = useCallback(() => { if (isDM) w.call<any>('GET', '/live/combat').then((c) => setCombat({ active: !!c.active, round: c.round })).catch(() => {}); }, [w, isDM]);
  useEffect(() => { loadCombat(); return on(['combat'], loadCombat); }, [on, loadCombat]);

  // Text selected on the page (outside this panel) is offered as context.
  useEffect(() => {
    if (harness !== 'dm') return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const sel = window.getSelection();
        const s = (sel?.toString() ?? '').trim();
        const node = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
        if (s && s.length > 2 && !node?.closest('.ag-panel')) setSelection(s.slice(0, 3000));
      }, 250);
    };
    document.addEventListener('selectionchange', check);
    return () => { clearTimeout(t); document.removeEventListener('selectionchange', check); };
  }, [harness]);

  // The reply arriving: pieces of text, a reset when the model turns to tools, a replacement, a status line.
  useEffect(() => on(['agent'], (e) => {
    const d: any = e.data;
    const cur = chatRef.current;
    if (!cur || d?.chatId !== cur.id) return;
    if (d.kind === 'delta') setLive((l) => ({ text: (l?.text ?? '') + d.text, status: '' }));
    else if (d.kind === 'reset') setLive({ text: '', status: '' });
    else if (d.kind === 'replace') setLive({ text: d.text, status: '' });
    else if (d.kind === 'status') setLive((l) => ({ text: l?.text ?? '', status: String(d.status ?? d.text ?? '') }));
    else if (d.kind === 'message' || d.kind === 'action') { if (d.kind === 'message') setLive(null); void load(cur.id); }
  }), [on, load]);

  // Fallback while it is working: poll (this also carries the text so far, if the live stream was missed).
  useEffect(() => {
    if (!chat?.busy) return;
    const t = setInterval(() => void load(chat.id), 1500);
    return () => clearInterval(t);
  }, [chat?.busy, chat?.id, load]);
  useEffect(() => { if (!chat?.busy) setLive(null); }, [chat?.busy]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [chat?.messages.length, chat?.actions.length, live?.text.length]);

  const send = (override?: string) => run(async () => {
    const body = (override ?? text).trim();
    if (!body) return;
    let id = chat?.id;
    if (!id) { const c = await w.call<ChatState>('POST', '/agent/chats', {}); id = c.id; remember(key, id); seen.current = { chat: id, ids: new Set() }; }
    setText('');
    stopSpeaking();
    setLive({ text: '', status: '' });
    const sel = selection;
    setSelection('');
    setChat(await w.call<ChatState>('POST', `/agent/chats/${id}/messages`, { text: body, page: attachedPage, selection: sel || undefined }));
  });
  const stop = () => { if (chat) void w.call('POST', `/agent/chats/${chat.id}/stop`, {}).catch((e: any) => setError(e.message)); };
  const fresh = () => run(async () => { const c = await w.call<ChatState>('POST', '/agent/chats', {}); remember(key, c.id); setChat(c); setLive(null); stopSpeaking(); });
  const rename = (id: string, title: string) => run(async () => { await w.call('PATCH', `/agent/chats/${id}`, { title }); setRenaming(null); refreshList(); });
  const remove = () => run(async () => {
    if (!chat) return;
    await w.call('DELETE', `/agent/chats/${chat.id}`);
    setConfirmDel(false);
    const rest = list.filter((c) => c.id !== chat.id);
    if (rest[0]) await open(rest[0].id); else { remember(key, ''); setChat(null); setLive(null); }
    refreshList();
  });
  const decide = (a: Act, decision: 'approve' | 'reject') => run(async () => {
    try { await w.call('POST', `/agent/actions/${a.id}`, { decision }); } catch (e: any) { setError(e.message); }
    if (chat) await load(chat.id);
  });

  const libraryHref = useCallback((id: string) => `/w/${world}/${isDM ? 'dm/' : ''}library?page=${encodeURIComponent(id)}`, [world, isDM]);
  const goLink = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest?.('a.wikilink') as HTMLAnchorElement | null;
    const href = a?.getAttribute('href');
    if (href?.startsWith('/')) { e.preventDefault(); navigate(href); }
  };

  // Messages and the actions waiting on the DM, in the order they happened.
  const items = useMemo(() => {
    const out: ({ t: 'msg'; m: Msg } | { t: 'act'; a: Act })[] = (chat?.messages ?? []).map((m) => ({ t: 'msg' as const, m }));
    for (const a of chat?.actions ?? []) if (a.status === 'pending' || a.status === 'running') out.push({ t: 'act' as const, a });
    return out.sort((x, y) => (x.t === 'msg' ? x.m.at : x.a.createdAt).localeCompare(y.t === 'msg' ? y.m.at : y.a.createdAt));
  }, [chat?.messages, chat?.actions]);

  const quick = QUICK[harness].filter((q) => q.needs !== 'page' || attachedPage);
  const working = !!chat?.busy;
  const input = () => document.querySelector<HTMLTextAreaElement>('[data-ag-input]');
  return (
    <div className="stack" style={{ minHeight: 0, flex: 1 }}>
      {model === false && <p className="tiny muted">No chat model is set yet (Admin → Models). Dice, the date and simple combat commands still work.</p>}
      <div className="row ag-chats" aria-label="Your chats" data-testid="ag-chats">
        {renaming !== null && chat ? (
          <form className="row grow" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); if (renaming.trim()) void rename(chat.id, renaming.trim()); }}>
            <label className="grow" style={{ flex: 1 }}><span className="sr-only">Chat name</span><input style={{ width: '100%' }} value={renaming} maxLength={120} autoFocus onChange={(e) => setRenaming(e.target.value)} /></label>
            <button type="submit" className="btn small primary" disabled={busy || !renaming.trim()}>Save</button>
            <button type="button" className="btn small" onClick={() => setRenaming(null)}>Cancel</button>
          </form>
        ) : (
          <>
            <label className="grow" style={{ flex: 1, minWidth: 0 }}><span className="sr-only">Switch chat</span>
              <select style={{ width: '100%' }} value={chat?.id ?? ''} onChange={(e) => { if (e.target.value) void open(e.target.value); }} data-testid="ag-chat-select">
                {!chat && <option value="">New chat</option>}
                {list.map((c) => <option key={c.id} value={c.id}>{c.title || 'New chat'} · {new Date(c.updatedAt).toLocaleDateString()}</option>)}
                {chat && !list.some((c) => c.id === chat.id) && <option value={chat.id}>New chat</option>}
              </select>
            </label>
            {chat && !confirmDel && <>
              <button type="button" className="btn small ghost" aria-label="Rename this chat" title="Rename this chat" onClick={() => setRenaming(list.find((c) => c.id === chat.id)?.title ?? '')}><i className="fa-solid fa-pen" aria-hidden="true" /></button>
              <button type="button" className="btn small ghost" aria-label="Delete this chat" title="Delete this chat" onClick={() => setConfirmDel(true)}><i className="fa-solid fa-trash" aria-hidden="true" /></button>
            </>}
            {chat && confirmDel && <>
              <span className="tiny">Delete this chat?</span>
              <button type="button" className="btn small danger" disabled={busy} onClick={() => void remove()}>Delete</button>
              <button type="button" className="btn small" onClick={() => setConfirmDel(false)}>Keep</button>
            </>}
          </>
        )}
      </div>
      <div className="stack" style={{ overflowY: 'auto', flex: 1, minHeight: 120 }} aria-live="polite">
        {!chat?.messages.length && <p className="tiny muted">{harness === 'dm' ? 'Ask about your world, the last session, the rules or the fight. It can propose changes; nothing happens until you approve it.' : 'Ask about what your character knows: places, people, what happened, your items.'}</p>}
        {items.map((it) => {
          if (it.t === 'act') {
            const a = it.a;
            return (
              <div key={a.id} className="card gold" style={{ padding: '10px 12px' }} role="group" aria-label="Waiting for your approval">
                <strong>{a.summary.replace(/\s*·\s*Visible to players.*$/, '')}</strong>
                {/Visible to players/.test(a.summary) && <span className="chip red" role="status">{a.summary.slice(a.summary.indexOf('Visible to players'))}</span>}
                <details className="tiny muted"><summary>Exact call</summary><code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{a.tool} {JSON.stringify(a.call)}</code></details>
                <div className="row"><button type="button" className="btn small primary" disabled={busy || a.status !== 'pending'} onClick={() => void decide(a, 'approve')}>Approve</button><button type="button" className="btn small" disabled={busy || a.status !== 'pending'} onClick={() => void decide(a, 'reject')}>Reject</button></div>
              </div>
            );
          }
          const m = it.m;
          const shown = m.status === 'working' ? (live && live.text.length >= m.text.length ? live.text : m.text) : m.text;
          return (
            <div key={m.id} className="stack tight" style={{ alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div className="card ag-msg" style={{ padding: '8px 12px', maxWidth: '92%', borderColor: m.role === 'user' ? 'var(--accent)' : undefined }} onClick={goLink}>
                {m.status === 'working' && !shown ? <span className="muted">{live?.status ? `Using ${live.status}…` : 'Thinking…'}</span>
                  : m.role === 'assistant' ? <><Markdown text={linkCitations(shown, m.citations)} linkTo={(title) => { const c = m.citations.find((x) => x.kind === 'page' && x.title.toLowerCase() === title.toLowerCase()); return c ? libraryHref(c.id) : '#'; }} />{m.status === 'working' && <span className="ag-cursor" aria-hidden="true" />}</>
                    : <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>}
                {m.status === 'working' && shown && live?.status && <span className="tiny muted"> Using {live.status}…</span>}
                {m.status === 'error' && <span className="tiny" style={{ color: 'var(--danger-text)' }}>That did not work.</span>}
              </div>
              {m.citations.length > 0 && m.status !== 'working' && (
                <ul className="tiny muted ag-sources" aria-label="Sources">
                  {m.citations.map((c) => (
                    <li key={`${c.kind}${c.id}`}>
                      {c.kind === 'page' ? <a href={libraryHref(c.id)} className="wikilink" onClick={(e) => { e.preventDefault(); navigate(libraryHref(c.id)); }}>{c.title}</a> : <strong>{c.kind === 'transcript' ? `Transcript, ${c.title}` : c.title}</strong>}
                      {c.snippet ? `: ${c.snippet}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {isDM && m.role === 'assistant' && m.timings && m.status !== 'working' && <span className="tiny muted" title={timingTitle(m.timings)}>{timingText(m.timings)}</span>}
            </div>
          );
        })}
        <div ref={end} />
      </div>
      <ErrorBox error={error} />
      {aloud && aloudNote && <p className="tiny muted" role="status">{aloudNote}</p>}
      <div className="row ag-chips" aria-label="Attached to your message">
        {attachedPage && <span className="chip gold" title="The page you are looking at is sent with your message"><i className="fa-solid fa-file-lines" aria-hidden="true" /> {pageTitle || 'This page'} <button type="button" className="ag-x" aria-label="Do not send this page" onClick={() => setDropPage(true)}>×</button></span>}
        {page && dropPage && <button type="button" className="chip" onClick={() => setDropPage(false)}>Attach this page</button>}
        {selection && <span className="chip gold" title={selection}><i className="fa-solid fa-i-cursor" aria-hidden="true" /> “{selection.slice(0, 40)}{selection.length > 40 ? '…' : ''}” <button type="button" className="ag-x" aria-label="Do not send the selection" onClick={() => setSelection('')}>×</button></span>}
        {isDM && combat?.active && <span className="chip teal" title="The fight now is sent with your message"><i className="fa-solid fa-khanda" aria-hidden="true" /> Combat, round {combat.round}</span>}
      </div>
      <div className="row ag-quick" aria-label="Quick actions">
        {quick.map((q) => <button key={q.label} type="button" className="chip ag-quick-btn" disabled={busy || working} onClick={() => { if (q.send) void send(q.send); else { setText(q.fill ?? ''); input()?.focus(); } }}>{q.label}</button>)}
        <button type="button" className="chip ag-quick-btn" onClick={() => void fresh()}>New chat</button>
        {isDM && harness === 'dm' && <AloudToggle note={aloudNote} />}
      </div>
      <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label className="grow" style={{ flex: 1 }}><span className="sr-only">Message</span>
          <textarea data-ag-input rows={2} style={{ width: '100%' }} value={text} placeholder={placeholder ?? 'Ask…'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!working) void send(); } }} />
        </label>
        {isDM && <MicButton disabled={busy || working} onText={(t) => { setText((cur) => (cur.trim() ? `${cur.trim()} ${t}` : t)); input()?.focus(); }} />}
        {working
          ? <button type="button" className="btn small danger" onClick={stop} aria-label="Stop the answer"><i className="fa-solid fa-stop" aria-hidden="true" /> Stop</button>
          : <button type="submit" className="btn primary small" disabled={busy || !text.trim()}>Send</button>}
      </form>
    </div>
  );
}

/**
 * Talk instead of type: hold or tap to record, tap again to stop. The recording is turned into text by the world's own
 * speech model (the audio job on the server, never a browser dictation service) and put in the box to check and send.
 */
function MicButton({ onText, disabled }: { onText: (t: string) => void; disabled?: boolean }) {
  const { world } = useParams();
  const { client } = useAuth();
  const [state, setState] = useState<'idle' | 'rec' | 'busy'>('idle');
  const [err, setErr] = useState('');
  const rec = useRef<MediaRecorder | null>(null);
  const can = typeof window !== 'undefined' && typeof (window as any).MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  if (!can) return null;
  const start = async () => {
    setErr('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const parts: Blob[] = [];
      mr.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setState('busy');
        try {
          const blob = new Blob(parts, { type: mr.mimeType || 'audio/webm' });
          const r = await fetch(`${window.location.origin}/api/worlds/${encodeURIComponent(world ?? '')}/agent/dictate`, { method: 'POST', headers: { Authorization: `Bearer ${client.token ?? ''}`, 'Content-Type': blob.type }, body: blob });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error ?? `Dictation failed (${r.status})`);
          if (j.text) onText(j.text);
        } catch (e: any) { setErr(e.message ?? 'Dictation failed'); } finally { setState('idle'); }
      };
      rec.current = mr;
      mr.start();
      setState('rec');
      // A minute at most: this is for a request, not a monologue.
      setTimeout(() => { if (mr.state === 'recording') mr.stop(); }, 60_000);
    } catch { setErr('No microphone (or permission refused)'); setState('idle'); }
  };
  const stopRec = () => { if (rec.current?.state === 'recording') rec.current.stop(); };
  return (
    <button type="button" className={`btn small${state === 'rec' ? ' danger' : ''}`} disabled={disabled || state === 'busy'} title={err || (state === 'rec' ? 'Stop and turn it into text' : 'Talk to the assistant')} aria-label={state === 'rec' ? 'Stop recording' : 'Talk to the assistant'} onClick={() => (state === 'rec' ? stopRec() : void start())} data-testid="ag-mic">
      <i className={`fa-solid ${state === 'busy' ? 'fa-spinner fa-spin' : state === 'rec' ? 'fa-stop' : 'fa-microphone'}`} aria-hidden="true" />
    </button>
  );
}
