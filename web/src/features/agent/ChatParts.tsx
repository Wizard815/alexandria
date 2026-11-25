// The pieces of the assistant chat that both layouts draw: the chat switcher, the messages with their approval cards
// and sources, and the dictation button. `phone` swaps the desktop classes for the DM phone's big-target ones; the
// state and behaviour live in Chat.tsx, so there is one chat, not a desktop one and a phone copy.
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Markdown } from '../../ui/index.tsx';
import { useAuth } from '../../lib/auth.tsx';

export interface Citation { kind: string; id: string; title: string; path?: string; snippet?: string }
export interface Timings { totalMs: number; firstTokenMs?: number; modelMs: number; toolMs: number; gatewayMs: number; rounds: number; toolCalls: number; fast?: boolean }
export interface GuideStep { kind: string; label: string; status: 'done' | 'waiting' | 'skipped' | 'blocked'; detail?: string }
export interface GuideNote { id: string; name: string; version: number; why: string; steps: GuideStep[] }
export interface Msg { id: string; role: 'user' | 'assistant'; text: string; status: 'done' | 'working' | 'error'; citations: Citation[]; at: string; timings?: Timings | null; guides?: GuideNote[] }

const STEP_ICON: Record<GuideStep['status'], string> = { done: 'fa-circle-check', waiting: 'fa-hourglass-half', skipped: 'fa-circle-minus', blocked: 'fa-ban' };
/** "Using guide: Towns" above a reply, with what each of the guide's steps did. */
export function GuideBox({ guides, phone }: { guides: GuideNote[]; phone?: boolean }) {
  return (
    <div className={`ag-guide${phone ? ' phone' : ''}`} data-testid="ag-guide">
      <strong><i className="fa-solid fa-compass" aria-hidden="true" /> Using guide: {guides.map((g) => g.name).join(', ')}</strong>
      {guides.map((g) => g.steps.length > 0 && (
        <ul key={g.id} aria-label={`Steps of the guide ${g.name}`}>
          {g.steps.map((s, i) => (
            <li key={i} data-status={s.status} data-kind={s.kind}><i className={`fa-solid ${STEP_ICON[s.status] ?? 'fa-circle'}`} aria-hidden="true" /> {s.label}{s.detail ? <span className="muted">: {s.detail}</span> : null}</li>
          ))}
        </ul>
      ))}
    </div>
  );
}
export interface Act { id: string; tool: string; summary: string; call: unknown; status: string; result: string | null; createdAt: string; auto?: boolean; alwaysAsk?: boolean; decidedAt?: string | null }
export interface ChatState { id: string; messages: Msg[]; actions: Act[]; busy: boolean }
export interface Live { text: string; status: string; queue?: string }
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

const clock = (iso: string) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };

/** What the assistant is doing while no text has come yet: waiting in the model's queue, using a tool, or thinking (with the seconds so far). */
function WorkingNote({ live, since, className }: { live: Live | null; since: string; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const secs = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000));
  const what = live?.queue ? live.queue : live?.status ? `Using ${live.status}` : 'Thinking';
  return <span className={className} role="status" data-testid="ag-working">{what}…{secs >= 3 ? ` ${secs} s` : ''}</span>;
}

/**
 * One change the assistant proposed or made. Waiting: what will change, with Approve and Reject. After that the same card
 * shows the outcome (applying, done, did not work, rejected), so the chat reads as a record of what happened.
 */
export function ActionCard({ a, phone, auto, decide }: { a: Act; phone?: boolean; auto?: boolean; decide: (a: Act, d: 'approve' | 'reject') => void }) {
  const title = a.summary.replace(/\s*·\s*Visible to players.*$/, '');
  const visible = /Visible to players/.test(a.summary) ? a.summary.slice(a.summary.indexOf('Visible to players')) : '';
  const exact = <details className={phone ? 'tiny' : 'tiny muted'}><summary style={phone ? { minHeight: 32 } : undefined}>Exact call</summary><code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{a.tool} {JSON.stringify(a.call)}</code></details>;
  if (a.status === 'pending') {
    return phone ? (
      <div className="c" style={{ borderColor: 'var(--accent)' }} role="group" aria-label="Waiting for your approval" data-testid="action-card" data-status="pending">
        <b className="tx">{title}</b>
        {visible && <span className="pill red" role="status">{visible}</span>}
        {a.alwaysAsk && auto && <span className="sub">Always asks first, even in Auto</span>}
        {exact}
        <div className="grid g2">
          <button type="button" className="b ok big" onClick={() => decide(a, 'approve')}>Approve</button>
          <button type="button" className="b danger big" onClick={() => decide(a, 'reject')}>Reject</button>
        </div>
      </div>
    ) : (
      <div className="card gold" style={{ padding: '10px 12px' }} role="group" aria-label="Waiting for your approval" data-testid="action-card" data-status="pending">
        <strong>{title}</strong>
        {visible && <span className="chip red" role="status">{visible}</span>}
        {a.alwaysAsk && auto && <div className="tiny muted">Always asks first, even in Auto</div>}
        {exact}
        <div className="row"><button type="button" className="btn small primary" onClick={() => decide(a, 'approve')}>Approve</button><button type="button" className="btn small" onClick={() => decide(a, 'reject')}>Reject</button></div>
      </div>
    );
  }
  const st = a.status;
  const label = st === 'done' ? (a.auto ? 'Applied automatically' : 'Done') : st === 'running' ? 'Applying…' : st === 'failed' ? 'That did not work' : 'Rejected';
  const icon = st === 'done' ? 'fa-circle-check' : st === 'running' ? 'fa-spinner fa-spin' : st === 'failed' ? 'fa-triangle-exclamation' : 'fa-ban';
  const result = a.result && a.result !== '{}' ? a.result : '';
  return (
    <div className={phone ? 'c' : 'card'} style={{ padding: phone ? undefined : '8px 12px', opacity: st === 'rejected' ? 0.7 : 1, borderColor: st === 'failed' ? 'var(--danger-text)' : undefined }} role="group" aria-label={`Action ${st}`} data-testid="action-card" data-status={st}>
      <div className={phone ? 'tx' : undefined}><i className={`fa-solid ${icon}`} aria-hidden="true" /> <strong>{label}</strong> <span className="muted">· {title}</span></div>
      {visible && <span className={phone ? 'pill red' : 'chip red'}>{visible}</span>}
      {(result || st === 'failed') && st !== 'running' && <details className={phone ? 'tiny' : 'tiny muted'} open={st === 'failed' && result.length < 200}><summary>Result</summary><pre className="ag-result">{result.slice(0, 1500) || 'No details.'}</pre></details>}
    </div>
  );
}

/** Say a tool name the way the DM would ("lore_delete" -> "lore delete", "publish_*" -> "publish"). */
const plain = (t: string) => t.replace(/[_*]+$/, '').replace(/_/g, ' ');

/** The chat's mode: "Ask first" (every change waits for a card) or "Auto" (changes are applied at once, except the tools that always ask). */
export function AutoSwitch({ phone, on, saving, onToggle, alwaysAsk }: { phone?: boolean; on: boolean; saving: boolean; onToggle: () => void; alwaysAsk: string[] }) {
  return (
    <div className={`ag-mode${on ? ' on' : ''}`} data-testid="ag-mode" data-mode={on ? 'auto' : 'ask'}>
      <button type="button" role="switch" aria-checked={on} aria-label="Auto mode" className={`${phone ? 'b chip' : 'btn small'}${on ? ' on' : ''}`} disabled={saving} onClick={onToggle} data-testid="ag-auto"
        title={on ? 'Auto: the assistant applies its changes without asking. Tap to ask first again.' : 'Ask first: every change waits for your Approve. Tap to let the assistant apply changes itself.'}>
        <i className={`fa-solid ${on ? 'fa-bolt' : 'fa-hand'}`} aria-hidden="true" /> {on ? 'Auto' : 'Ask first'}
      </button>
      <span className={phone ? 'sub' : 'tiny muted'} role="status">{on ? 'Changes are applied without asking.' : 'Changes wait for your approval.'}</span>
      {on && alwaysAsk.length > 0 && <details className={phone ? 'sub' : 'tiny muted'}><summary>Always asks first</summary>{[...new Set(alwaysAsk.map(plain))].join(', ')}.</details>}
    </div>
  );
}

/** Messages and the actions waiting on the DM, in the order they happened. */
export function ChatMessages({ phone, items, live, isDM, auto, libraryHref, onLink, onNavigate, decide, retry }: {
  phone?: boolean; items: Item[]; live: Live | null; isDM: boolean; auto?: boolean; retry?: () => void;
  libraryHref: (id: string) => string; onLink: (e: React.MouseEvent) => void; onNavigate: (href: string) => void;
  decide: (a: Act, d: 'approve' | 'reject') => void;
}) {
  const lastAssistant = [...items].reverse().find((x): x is { t: 'msg'; m: Msg } => x.t === 'msg' && x.m.role === 'assistant');
  const lastErr = lastAssistant?.m.status === 'error' ? lastAssistant.m.id : '';
  return (
    <>
      {items.map((it) => {
        if (it.t === 'act') return <ActionCard key={it.a.id} a={it.a} phone={phone} auto={auto} decide={decide} />;
        const m = it.m;
        const shown = m.status === 'working' ? (live && live.text.length >= m.text.length ? live.text : m.text) : m.text;
        const body = m.status === 'working' && !shown ? <WorkingNote live={live} since={m.at} className={phone ? 'sub' : 'muted'} />
          : m.role === 'assistant' ? <><Markdown text={linkCitations(shown, m.citations)} linkTo={(title) => { const c = m.citations.find((x) => x.kind === 'page' && x.title.toLowerCase() === title.toLowerCase()); return c ? libraryHref(c.id) : '#'; }} />{m.status === 'working' && <span className="ag-cursor" aria-hidden="true" />}</>
            : <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>;
        const sources = m.citations.length > 0 && m.status !== 'working' && (
          <ul className={`tiny ${phone ? '' : 'muted '}ag-sources`} aria-label="Sources">
            {m.citations.map((c) => (
              <li key={`${c.kind}${c.id}`}>
                {c.kind === 'page' ? <a href={libraryHref(c.id)} className="wikilink" onClick={(e) => { e.preventDefault(); onNavigate(libraryHref(c.id)); }}>{c.title}</a>
                  : c.kind === 'web' && /^https?:\/\//.test(c.path ?? '') ? <a href={c.path} target="_blank" rel="noopener noreferrer"><i className="fa-solid fa-globe" aria-hidden="true" /> {c.title}</a> : <strong>{c.kind === 'transcript' ? `Transcript, ${c.title}` : c.title}</strong>}
                {c.snippet ? `: ${c.snippet}` : ''}
              </li>
            ))}
          </ul>
        );
        const timing = isDM && m.role === 'assistant' && m.timings && m.status !== 'working' ? <span title={timingTitle(m.timings)}>{timingText(m.timings)}</span> : null;
        const stamp = m.status === 'working' ? null : <time dateTime={m.at} title={new Date(m.at).toLocaleString()} className={phone ? 'sub' : undefined}>{clock(m.at)}</time>;
        if (phone) {
          return (
            <div key={m.id} className={`msg ag-msg${m.role === 'user' ? ' me' : ''}`} onClick={onLink}>
              {m.guides?.length ? <GuideBox guides={m.guides} phone /> : null}
              {body}
              {m.status === 'working' && shown && live?.status && <span className="sub"> Using {live.status}…</span>}
              {m.status === 'error' && retry && it.m.id === lastErr && <div><button type="button" className="b" onClick={retry} data-testid="ag-retry"><i className="fa-solid fa-rotate-right" aria-hidden="true" /> Try again</button></div>}
              {sources}
              <div className="sub ag-stamp">{stamp}{timing ? <> · {timing}</> : null}</div>
            </div>
          );
        }
        return (
          <div key={m.id} className="stack tight" style={{ alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div className="card ag-msg" style={{ padding: '8px 12px', maxWidth: '92%', borderColor: m.role === 'user' ? 'var(--accent)' : undefined }} onClick={onLink}>
              {m.guides?.length ? <GuideBox guides={m.guides} /> : null}
              {body}
              {m.status === 'working' && shown && live?.status && <span className="tiny muted"> Using {live.status}…</span>}
              {m.status === 'error' && retry && it.m.id === lastErr && <div><button type="button" className="btn small" onClick={retry} data-testid="ag-retry"><i className="fa-solid fa-rotate-right" aria-hidden="true" /> Try again</button></div>}
            </div>
            {sources}
            <span className="tiny muted">{stamp}{timing ? <> · {timing}</> : null}</span>
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
const MIC_KEY = 'alx.dictation.mic';
const savedMic = (): string => { try { return localStorage.getItem(MIC_KEY) || ''; } catch { return ''; } };

/** The microphones this browser lists, with the saved choice (kept on this browser only). */
function MicPicker() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ id: string; label: string }[]>([]);
  const [pick, setPick] = useState(savedMic);
  const load = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setList(all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications').map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })));
    } catch { setList([]); }
  };
  return (
    <>
      <button type="button" className="btn small ghost" aria-label="Choose the microphone" aria-expanded={open} title="Choose the microphone" data-testid="ag-mic-pick"
        onClick={() => { setOpen((o) => !o); void load(); }}><i className="fa-solid fa-sliders" aria-hidden="true" /></button>
      {open && (
        <select className="input" aria-label="Microphone for dictation" value={pick} style={{ width: 'auto', maxWidth: 220 }} data-testid="ag-mic-select"
          onChange={(e) => { setPick(e.target.value); try { localStorage.setItem(MIC_KEY, e.target.value); } catch { /* ignore */ } }}>
          <option value="">Default microphone</option>
          {list.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
      )}
    </>
  );
}

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
      const want = savedMic();
      // A saved microphone that was unplugged falls back to the default one.
      const stream = await (want ? navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: want } } }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true })) : navigator.mediaDevices.getUserMedia({ audio: true }));
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
    return (
      <>
        <button type="button" className={`btn small${state === 'rec' ? ' danger' : ''}`} disabled={disabled || state === 'busy'} title={title} aria-label={label} onClick={() => (state === 'rec' ? stopRec() : void start())} data-testid="ag-mic">{icon}</button>
        <MicPicker />
      </>
    );
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
