// The pieces of the assistant chat that both layouts draw: the chat switcher, the messages with their approval cards
// and sources, and the dictation button. `phone` swaps the desktop classes for the DM phone's big-target ones; the
// state and behaviour live in Chat.tsx, so there is one chat, not a desktop one and a phone copy.
import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Markdown } from '../../ui/index.tsx';
import { useAuth } from '../../lib/auth.tsx';

export interface Citation { kind: string; id: string; title: string; path?: string; snippet?: string }
export interface Timings { totalMs: number; firstTokenMs?: number; modelMs: number; toolMs: number; gatewayMs: number; rounds: number; toolCalls: number; fast?: boolean }
export interface Msg { id: string; role: 'user' | 'assistant'; text: string; status: 'done' | 'working' | 'error'; citations: Citation[]; at: string; timings?: Timings | null }
export interface Act { id: string; tool: string; summary: string; call: unknown; status: string; result: string | null; createdAt: string }
export interface ChatState { id: string; messages: Msg[]; actions: Act[]; busy: boolean }
export interface Live { text: string; status: string }
export interface ChatRow { id: string; title: string; updatedAt: string }
export type Item = { t: 'msg'; m: Msg } | { t: 'act'; a: Act };

/** [Title] in a reply becomes a [[wikilink]] when it names a page the reply drew on. */
export function linkCitations(text: string, cites: Citation[]): string {
  const pages = new Set(cites.filter((c) => c.kind === 'page').map((c) => c.title.toLowerCase()));
  if (!pages.size) return text;
  return text.replace(/\[([^\][\n]{2,120})\](?![(:[])/g, (m, t: string) => (pages.has(t.trim().toLowerCase()) ? `[[${t.trim()}]]` : m));
}

const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
export const timingText = (t: Timings) => `${seconds(t.totalMs)}${t.fast ? ' (no model)' : t.firstTokenMs !== undefined ? `, first text ${seconds(t.firstTokenMs)}` : ''}${t.toolCalls ? `, ${t.toolCalls} tool call${t.toolCalls === 1 ? '' : 's'}` : ''}`;
export const timingTitle = (t: Timings) => `Total ${t.totalMs} ms: model ${t.modelMs} ms, tools ${t.toolMs} ms, Alexandria ${t.gatewayMs} ms, ${t.rounds} model round${t.rounds === 1 ? '' : 's'}`;

export interface Switcher {
  chat: ChatState | null; list: ChatRow[]; busy: boolean;
  renaming: string | null; setRenaming: (v: string | null) => void;
  confirmDel: boolean; setConfirmDel: (v: boolean) => void;
  open: (id: string) => void; fresh?: () => void; rename: (id: string, title: string) => void; remove: () => void;
}

/** Switch between past chats; rename or delete the open one. */
export function ChatSwitcher({ phone, s }: { phone?: boolean; s: Switcher }) {
  const { chat, list, busy, renaming, setRenaming, confirmDel, setConfirmDel } = s;
  const btn = (extra: string) => (phone ? `b ${extra}`.trim() : `btn small ${extra}`.trim());
  return (
    <div className={phone ? 'row ag-chats ask-chats' : 'row ag-chats'} aria-label="Your chats" data-testid="ag-chats">
      {renaming !== null && chat ? (
        <form className="row grow" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); if (renaming.trim()) s.rename(chat.id, renaming.trim()); }}>
          <label className="grow" style={{ flex: 1 }}><span className="sr-only">Chat name</span><input style={{ width: '100%' }} value={renaming} maxLength={120} autoFocus onChange={(e) => setRenaming(e.target.value)} /></label>
          <button type="submit" className={phone ? 'b primary' : 'btn small primary'} disabled={busy || !renaming.trim()}>Save</button>
          <button type="button" className={btn('')} onClick={() => setRenaming(null)}>Cancel</button>
        </form>
      ) : (
        <>
          <label className="grow" style={{ flex: 1, minWidth: 0 }}><span className="sr-only">Switch chat</span>
            <select style={{ width: '100%' }} value={chat?.id ?? ''} onChange={(e) => { if (e.target.value) s.open(e.target.value); }} data-testid="ag-chat-select">
              {!chat && <option value="">New chat</option>}
              {list.map((c) => <option key={c.id} value={c.id}>{c.title || 'New chat'} · {new Date(c.updatedAt).toLocaleDateString()}</option>)}
              {chat && !list.some((c) => c.id === chat.id) && <option value={chat.id}>New chat</option>}
            </select>
          </label>
          {chat && !confirmDel && <>
            {phone && s.fresh && <button type="button" className="b" aria-label="New chat" title="New chat" disabled={busy} onClick={() => s.fresh?.()} data-testid="ag-new"><i className="fa-solid fa-plus" aria-hidden="true" /></button>}
            <button type="button" className={btn('ghost')} aria-label="Rename this chat" title="Rename this chat" onClick={() => setRenaming(list.find((c) => c.id === chat.id)?.title ?? '')}><i className="fa-solid fa-pen" aria-hidden="true" /></button>
            <button type="button" className={btn('ghost')} aria-label="Delete this chat" title="Delete this chat" onClick={() => setConfirmDel(true)}><i className="fa-solid fa-trash" aria-hidden="true" /></button>
          </>}
          {chat && confirmDel && <>
            <span className="tiny">Delete this chat?</span>
            <button type="button" className={btn('danger')} disabled={busy} onClick={() => s.remove()}>Delete</button>
            <button type="button" className={btn('')} onClick={() => setConfirmDel(false)}>Keep</button>
          </>}
        </>
      )}
    </div>
  );
}

/** Messages and the actions waiting on the DM, in the order they happened. */
export function ChatMessages({ phone, items, live, isDM, busy, libraryHref, onLink, onNavigate, decide }: {
  phone?: boolean; items: Item[]; live: Live | null; isDM: boolean; busy: boolean;
  libraryHref: (id: string) => string; onLink: (e: React.MouseEvent) => void; onNavigate: (href: string) => void;
  decide: (a: Act, d: 'approve' | 'reject') => void;
}) {
  return (
    <>
      {items.map((it) => {
        if (it.t === 'act') {
          const a = it.a;
          const title = a.summary.replace(/\s*·\s*Visible to players.*$/, '');
          const visible = /Visible to players/.test(a.summary) ? a.summary.slice(a.summary.indexOf('Visible to players')) : '';
          const off = busy || a.status !== 'pending';
          if (phone) {
            return (
              <div key={a.id} className="c" style={{ borderColor: 'var(--accent)' }} role="group" aria-label="Waiting for your approval">
                <b className="tx">{title}</b>
                {visible && <span className="pill red" role="status">{visible}</span>}
                <details className="tiny"><summary style={{ minHeight: 32 }}>Exact call</summary><code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{a.tool} {JSON.stringify(a.call)}</code></details>
                <div className="grid g2">
                  <button type="button" className="b ok big" disabled={off} onClick={() => decide(a, 'approve')}>Approve</button>
                  <button type="button" className="b danger big" disabled={off} onClick={() => decide(a, 'reject')}>Reject</button>
                </div>
              </div>
            );
          }
          return (
            <div key={a.id} className="card gold" style={{ padding: '10px 12px' }} role="group" aria-label="Waiting for your approval">
              <strong>{title}</strong>
              {visible && <span className="chip red" role="status">{visible}</span>}
              <details className="tiny muted"><summary>Exact call</summary><code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{a.tool} {JSON.stringify(a.call)}</code></details>
              <div className="row"><button type="button" className="btn small primary" disabled={off} onClick={() => decide(a, 'approve')}>Approve</button><button type="button" className="btn small" disabled={off} onClick={() => decide(a, 'reject')}>Reject</button></div>
            </div>
          );
        }
        const m = it.m;
        const shown = m.status === 'working' ? (live && live.text.length >= m.text.length ? live.text : m.text) : m.text;
        const body = m.status === 'working' && !shown ? <span className={phone ? 'sub' : 'muted'}>{live?.status ? `Using ${live.status}…` : 'Thinking…'}</span>
          : m.role === 'assistant' ? <><Markdown text={linkCitations(shown, m.citations)} linkTo={(title) => { const c = m.citations.find((x) => x.kind === 'page' && x.title.toLowerCase() === title.toLowerCase()); return c ? libraryHref(c.id) : '#'; }} />{m.status === 'working' && <span className="ag-cursor" aria-hidden="true" />}</>
            : <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>;
        const sources = m.citations.length > 0 && m.status !== 'working' && (
          <ul className={`tiny ${phone ? '' : 'muted '}ag-sources`} aria-label="Sources">
            {m.citations.map((c) => (
              <li key={`${c.kind}${c.id}`}>
                {c.kind === 'page' ? <a href={libraryHref(c.id)} className="wikilink" onClick={(e) => { e.preventDefault(); onNavigate(libraryHref(c.id)); }}>{c.title}</a> : <strong>{c.kind === 'transcript' ? `Transcript, ${c.title}` : c.title}</strong>}
                {c.snippet ? `: ${c.snippet}` : ''}
              </li>
            ))}
          </ul>
        );
        const timing = isDM && m.role === 'assistant' && m.timings && m.status !== 'working' && <span className="tiny muted" title={timingTitle(m.timings)}>{timingText(m.timings)}</span>;
        if (phone) {
          return (
            <div key={m.id} className={`msg ag-msg${m.role === 'user' ? ' me' : ''}`} onClick={onLink}>
              {body}
              {m.status === 'working' && shown && live?.status && <span className="sub"> Using {live.status}…</span>}
              {m.status === 'error' && <div className="sub" style={{ color: 'var(--danger-text)' }}>That did not work.</div>}
              {sources}
              {timing}
            </div>
          );
        }
        return (
          <div key={m.id} className="stack tight" style={{ alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div className="card ag-msg" style={{ padding: '8px 12px', maxWidth: '92%', borderColor: m.role === 'user' ? 'var(--accent)' : undefined }} onClick={onLink}>
              {body}
              {m.status === 'working' && shown && live?.status && <span className="tiny muted"> Using {live.status}…</span>}
              {m.status === 'error' && <span className="tiny" style={{ color: 'var(--danger-text)' }}>That did not work.</span>}
            </div>
            {sources}
            {timing}
          </div>
        );
      })}
    </>
  );
}

// A press shorter than this is a tap (record until the next tap); a longer one is push-to-talk (stop on release).
const HOLD_MS = 450;
interface Press { at: number; upAt: number }

/**
 * Talk instead of type. On the desktop, tap to record and tap again to stop. On the phone (`hold`) press and hold to
 * talk and let go to stop, or tap once to keep recording hands-free until the next tap. The recording is turned into
 * text by the world's own speech model (the audio job on the server, never a browser dictation service) and put in the
 * box to check and send.
 */
export function MicButton({ onText, onError, disabled, hold }: { onText: (t: string) => void; onError?: (m: string) => void; disabled?: boolean; hold?: boolean }) {
  const { world } = useParams();
  const { client } = useAuth();
  const [state, setState] = useState<'idle' | 'rec' | 'busy'>('idle');
  const [err, setErr] = useState('');
  const rec = useRef<MediaRecorder | null>(null);
  const down = useRef<Press | null>(null);
  const can = typeof window !== 'undefined' && typeof (window as any).MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  if (!can) return null;
  const stopRec = () => { if (rec.current?.state === 'recording') rec.current.stop(); };
  const start = async (press?: Press) => {
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
        } catch (e: any) { const m = e.message ?? 'Dictation failed'; setErr(m); onError?.(m); } finally { setState('idle'); }
      };
      rec.current = mr;
      mr.start();
      setState('rec');
      // Let go (after a hold) before the microphone was ready: stop now.
      if (press?.upAt && press.upAt - press.at >= HOLD_MS) stopRec();
      // A minute at most: this is for a request, not a monologue.
      setTimeout(() => { if (mr.state === 'recording') mr.stop(); }, 60_000);
    } catch { setErr('No microphone (or permission refused)'); onError?.('No microphone (or permission refused)'); setState('idle'); }
  };
  const label = state === 'rec' ? 'Stop recording' : 'Talk to the assistant';
  const icon = <i className={`fa-solid ${state === 'busy' ? 'fa-spinner fa-spin' : state === 'rec' ? 'fa-stop' : 'fa-microphone'}`} aria-hidden="true" />;
  const title = err || (state === 'rec' ? 'Stop and turn it into text' : hold ? 'Hold to talk, let go to send it to the box' : 'Talk to the assistant');
  if (!hold) {
    return <button type="button" className={`btn small${state === 'rec' ? ' danger' : ''}`} disabled={disabled || state === 'busy'} title={title} aria-label={label} onClick={() => (state === 'rec' ? stopRec() : void start())} data-testid="ag-mic">{icon}</button>;
  }
  return (
    <button type="button" className={`b mic${state === 'rec' ? ' danger' : ''}`} disabled={disabled || state === 'busy'} title={title} aria-label={label} data-testid="ag-mic" data-state={state}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        if (state === 'rec') { down.current = null; stopRec(); return; }
        const press = { at: Date.now(), upAt: 0 };
        down.current = press;
        void start(press);
      }}
      onPointerUp={() => {
        const d = down.current;
        down.current = null;
        if (!d) return;
        d.upAt = Date.now();
        if (d.upAt - d.at >= HOLD_MS) stopRec();
      }}
      onPointerCancel={() => { down.current = null; stopRec(); }}
      // A keyboard press arrives as a click with no pointer: toggle, as on the desktop.
      onClick={(e) => { if (e.detail === 0) { if (state === 'rec') stopRec(); else void start(); } }}>
      {icon}
    </button>
  );
}
