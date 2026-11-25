// Minerva's thoughts: a floating window for the DM that shows what the assistant is doing and why, live.
// Active mode says what it heard, what it made of it, and why it acted, asked or let it go; the chat
// assistant (and a spoken request or a macro's task) says what it is working on, what it looked up and
// what it proposed. What waits for the DM (Active-mode cards and the assistant's proposals) sits at the
// top with its buttons, so a decision never needs another page.
//
// Like the transcript island: drag it by its header, lock it to a corner, resize it, or fold it to its
// dock button. It opens by itself when Active mode or Auto is switched on (unless the DM closed it while
// that mode was on). Settings are per device.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useWorld } from '../../lib/world.tsx';
import { DockButton } from '../../ui/Dock.tsx';
import { useAction } from '../../ui/index.tsx';
import { ACTIONS_CHANGED, announceActions } from '../agent/Chat.tsx';
import { seesText, useActive, type LogRow } from './shared.tsx';
import './active.css';

export type ThoughtKind = 'heard' | 'plan' | 'look' | 'do' | 'ask' | 'skip' | 'done' | 'error';
export interface Thought { id: string; at: string; source: 'active' | 'assistant' | 'task' | 'wake'; kind: ThoughtKind; text: string; detail?: string; runId?: string; logId?: string; actionId?: string; chatId?: string; undoable?: boolean }
interface Feed { thoughts: Thought[]; heard: Thought | null; recording: boolean; mode: 'assistant' | 'active'; auto: boolean }
interface Pending { id: string; chatId: string; tool: string; summary: string; createdAt: string; alwaysAsk?: boolean }

type Corner = 'br' | 'bl' | 'tr' | 'tl';
interface Prefs { x: number; y: number; w: number; h: number; corner: Corner | null; open: boolean; filter: 'all' | 'active' | 'assistant'; dismissedFor: string; autoOpen: boolean }
const DEFAULTS: Prefs = { x: 40, y: 120, w: 360, h: 380, corner: 'bl', open: false, filter: 'all', dismissedFor: '', autoOpen: true };
const KEY = 'alx.thoughts.prefs';
const CORNERS: Corner[] = ['bl', 'br', 'tr', 'tl'];

// One store for the prefs, so the overlay that hides the old cards knows when the window is open.
let prefs: Prefs = (() => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEFAULTS; } })();
const subs = new Set<() => void>();
const setPrefs = (p: Partial<Prefs>, save = true) => {
  prefs = { ...prefs, ...p };
  if (save) { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private window */ } }
  subs.forEach((f) => f());
};
export const useThoughtPrefs = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => prefs);

const ICON: Record<ThoughtKind, string> = { heard: 'fa-ear-listen', plan: 'fa-lightbulb', look: 'fa-magnifying-glass', do: 'fa-circle-check', ask: 'fa-hand', skip: 'fa-circle-minus', done: 'fa-flag-checkered', error: 'fa-triangle-exclamation' };
const SOURCE: Record<Thought['source'], string> = { active: 'Active', assistant: 'Chat', task: 'Task', wake: 'Spoken' };
const clock = (iso: string) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }); };
const left = (iso: string | null) => { if (!iso) return ''; const s = Math.round((Date.parse(iso) - Date.now()) / 1000); return s <= 0 ? 'expiring' : s < 60 ? `${s} s left` : `${Math.round(s / 60)} min left`; };

/** The feed and what is waiting, kept live by the 'thought', 'agent' and 'active' events. */
function useThoughts(enabled: boolean) {
  const { w, on } = useWorld();
  const [feed, setFeed] = useState<Feed | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const loadFeed = useCallback(() => { if (enabled) void w.call<Feed>('GET', '/active/thoughts').then(setFeed).catch(() => {}); }, [w, enabled]);
  const loadPending = useCallback(() => { void w.call<{ actions: Pending[] }>('GET', '/agent/actions?status=pending').then((r) => setPending((r.actions ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)))).catch(() => {}); }, [w]);
  useEffect(() => { loadFeed(); loadPending(); }, [loadFeed, loadPending]);
  useEffect(() => on(['thought'], (e) => {
    const t = e.data as Thought;
    setFeed((f) => {
      if (!f) return f;
      if (t.kind === 'heard') return { ...f, heard: t };
      return { ...f, thoughts: [...f.thoughts.filter((x) => x.id !== t.id), t].slice(-200) };
    });
  }), [on]);
  // Proposals come and go with the assistant's events; the mode and recording with the settings and Active mode's.
  useEffect(() => on(['agent'], (e) => { const k = (e.data as any)?.kind; if (k === 'action' || k === 'message') loadPending(); }), [on, loadPending]);
  useEffect(() => on(['settings', 'recording'], loadFeed), [on, loadFeed]);
  useEffect(() => { window.addEventListener(ACTIONS_CHANGED, loadPending); return () => window.removeEventListener(ACTIONS_CHANGED, loadPending); }, [loadPending]);
  return { feed, pending, loadFeed, loadPending };
}

export default function ThoughtsIsland() {
  const { w, info } = useWorld();
  const st = useActive();
  const p = useThoughtPrefs();
  const act = useAction();
  const auto = (info.settings as any)?.agentAuto === true;
  const active = st.data?.effective === 'active';
  const on = active || auto;
  const { feed, pending, loadPending } = useThoughts(true);
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);

  // Opens by itself when a mode that acts by itself is switched on; closing it while that mode is on keeps it closed until the mode changes.
  const modeKey = `${active ? 'active' : ''}${auto ? 'auto' : ''}`;
  useEffect(() => { if (on && p.autoOpen && !p.open && p.dismissedFor !== modeKey) setPrefs({ open: true }); }, [on, modeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => setPrefs({ open: false, dismissedFor: on ? modeKey : '' });

  // Countdowns on the cards.
  useEffect(() => { if (!p.open) return; const t = setInterval(() => tick((n) => n + 1), 5000); return () => clearInterval(t); }, [p.open]);

  const cards: LogRow[] = st.data?.cards ?? [];
  // Active-mode cards that are the assistant's own proposals are shown once, as the proposal.
  const activeCards = cards.filter((c) => !c.ruleKey?.startsWith('agent:'));
  const waiting = activeCards.length + pending.length;
  const shown = useMemo(() => (feed?.thoughts ?? []).filter((t) => p.filter === 'all' || (p.filter === 'active' ? t.source === 'active' || t.source === 'wake' : t.source === 'assistant' || t.source === 'task')), [feed, p.filter]);
  // Follow the newest thought, unless the DM scrolled up to read.
  const follow = useRef(true);
  useEffect(() => { const el = body.current; if (el && follow.current) el.scrollTop = el.scrollHeight; }, [shown.length, p.open, waiting]);

  // Drag by the header.
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, input, select')) return;
    const r = box.current!.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setPrefs({ x: r.left, y: r.top, corner: null }, false);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPrefs({ x: Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.current.dx)), y: Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.current.dy)), corner: null }, false);
  };
  const onUp = () => { if (drag.current) { drag.current = null; setPrefs({}); } };
  // Remember the size after a resize.
  useEffect(() => {
    const el = box.current;
    if (!el || !p.open || typeof ResizeObserver === 'undefined') return;
    let tm: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => { clearTimeout(tm); tm = setTimeout(() => { const r = el.getBoundingClientRect(); if (Math.abs(r.width - prefs.w) > 2 || Math.abs(r.height - prefs.h) > 2) setPrefs({ w: Math.round(r.width), h: Math.round(r.height) }); }, 300); });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(tm); };
  }, [p.open]);

  const [undone, setUndone] = useState<Set<string>>(new Set());
  const undo = (logId: string) => act.run(async () => { await w.call('POST', `/active/log/${logId}/undo`, {}); setUndone((u) => new Set(u).add(logId)); });
  const decideCard = (c: LogRow, verb: 'approve' | 'dismiss' | 'reject') => act.run(async () => { await w.call('POST', `/active/log/${c.id}/${verb}`, {}); await st.reload(); });
  const decideAction = (a: Pending, decision: 'approve' | 'reject') => act.run(async () => {
    try { await w.call('POST', `/agent/actions/${a.id}`, { decision }); } finally { loadPending(); announceActions(); }
  });

  const status = (() => {
    if (feed?.mode === 'active' || active) {
      if (!(feed?.recording ?? st.data?.recording)) return { cls: 'idle', text: 'Active mode is on, but nothing is recording, so I am not listening.' };
      const h = feed?.heard;
      return { cls: 'live', text: h ? `Listening. Last heard ${clock(h.at)}: ${h.text}` : 'Listening to the table.' };
    }
    return { cls: auto ? 'live' : 'idle', text: auto ? 'Auto is on: I apply my changes in the chat without asking (except the ones that always ask).' : 'Assistant mode: I act only when you ask.' };
  })();

  const pill = <DockButton order={30} icon="fa-brain" label={p.open ? "Close Minerva's thoughts" : "Open Minerva's thoughts"} title={waiting ? `Minerva's thoughts: ${waiting} waiting for you` : "Minerva's thoughts"} active={p.open} live={on} badge={waiting || undefined} onClick={() => (p.open ? close() : setPrefs({ open: true }))} testId="dock-thoughts" />;
  if (!p.open) return pill;

  const style: React.CSSProperties = { width: p.w, height: p.h };
  if (p.corner) Object.assign(style, { [p.corner[0] === 'b' ? 'bottom' : 'top']: p.corner[0] === 'b' ? 68 : 16, [p.corner[1] === 'r' ? 'right' : 'left']: p.corner[1] === 'r' ? 'var(--dock-right, 16px)' : 16 });
  else Object.assign(style, { left: Math.min(p.x, Math.max(0, window.innerWidth - 120)), top: Math.min(p.y, Math.max(0, window.innerHeight - 60)) });

  return (
    <>{pill}<div className="th-island" style={style} ref={box} role="complementary" aria-label="Minerva's thoughts" data-testid="thoughts">
      <div className="th-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <i className="fa-solid fa-brain" aria-hidden="true" /> <strong>Minerva's thoughts</strong>
        <span className="th-sp" />
        <select className="th-filter" aria-label="Show" value={p.filter} onChange={(e) => setPrefs({ filter: e.target.value as Prefs['filter'] })}>
          <option value="all">All</option><option value="active">Active mode</option><option value="assistant">Chat and tasks</option>
        </select>
        <button type="button" className={`th-btn${p.autoOpen ? ' on' : ''}`} aria-pressed={p.autoOpen} title={p.autoOpen ? 'Opens by itself when Active mode or Auto is switched on. Tap to open it only from the dock.' : 'Opens only from the dock. Tap to open it by itself when Active mode or Auto is switched on.'} aria-label="Open by itself when Active mode or Auto is on" onClick={() => setPrefs({ autoOpen: !p.autoOpen })}><i className="fa-solid fa-wand-magic-sparkles" aria-hidden="true" /></button>
        <button type="button" className="th-btn" title="Lock to the next corner" aria-label="Lock to the next corner" onClick={() => setPrefs({ corner: CORNERS[(CORNERS.indexOf(p.corner ?? 'tl') + 1) % 4] })}>⌖</button>
        <button type="button" className="th-btn" aria-label="Close Minerva's thoughts" onClick={close}>—</button>
      </div>
      <div className={`th-status ${status.cls}`} role="status" data-testid="thoughts-status"><span className="act-dot" aria-hidden="true" /> {status.text}</div>
      {waiting > 0 && (
          <section className="th-waiting" aria-label="Waiting for you" data-testid="thoughts-waiting">
            <div className="tiny muted">Waiting for you ({waiting})</div>
            {activeCards.map((c) => (
              <div key={c.id} className="th-card" data-testid="thoughts-card">
                <div className="row" style={{ justifyContent: 'space-between' }}><span className="chip gold">Active</span><span className="tiny muted">{seesText(c.visible)}{c.expiresAt ? ` · ${left(c.expiresAt)}` : ''}</span></div>
                <strong>{c.summary}</strong>
                {c.cue && <div className="tiny muted">{c.trigger === 'line' ? `${c.speaker || 'Table'} said: ` : ''}“{c.cue.slice(0, 110)}”</div>}
                <div className="row">
                  <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void decideCard(c, 'approve')}>Do it</button>
                  <button type="button" className="btn small" disabled={act.busy} onClick={() => void decideCard(c, 'dismiss')}>Dismiss</button>
                  <button type="button" className="btn small ghost" disabled={act.busy} title="Dismiss and never do this for that cue again" onClick={() => void decideCard(c, 'reject')}>Not this</button>
                </div>
              </div>
            ))}
            {pending.map((a) => (
              <div key={a.id} className="th-card" data-testid="thoughts-action">
                <div className="row" style={{ justifyContent: 'space-between' }}><span className="chip teal">Chat</span><span className="tiny muted">{a.alwaysAsk ? 'always asks first' : clock(a.createdAt)}</span></div>
                <strong>{a.summary}</strong>
                <div className="row">
                  <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void decideAction(a, 'approve')}>Approve</button>
                  <button type="button" className="btn small" disabled={act.busy} onClick={() => void decideAction(a, 'reject')}>Reject</button>
                </div>
              </div>
            ))}
            {act.error && <div className="tiny" style={{ color: 'var(--danger-text)' }}>{act.error}</div>}
          </section>
      )}
      <div className="th-body" ref={body} onScroll={(e) => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        {!shown.length && <p className="tiny muted">Nothing yet. When I hear something at the table or work on a request, my reasoning shows here: what I made of it, what I looked up, and why I did it, asked you, or let it go.</p>}
        <ol className="th-feed" aria-label="What I am thinking" data-testid="thoughts-feed">
          {shown.map((t, i) => {
            const first = i === 0 || shown[i - 1].runId !== t.runId || !t.runId;
            return (
              <li key={t.id} className={`th-item k-${t.kind}${first ? ' first' : ''}`} data-kind={t.kind}>
                <i className={`fa-solid ${ICON[t.kind]}`} aria-hidden="true" />
                <div className="th-text">
                  {first && <span className="th-src">{SOURCE[t.source]} · {clock(t.at)}</span>}
                  <span>{t.text}</span>
                  {t.undoable && t.logId && !undone.has(t.logId) && <span><button type="button" className="btn small" disabled={act.busy} onClick={() => void undo(t.logId!)}>Undo</button></span>}
                  {t.detail && <details className="tiny muted"><summary>More</summary><div style={{ whiteSpace: 'pre-wrap' }}>{t.detail}</div></details>}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div></>
  );
}
