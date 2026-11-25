// The floating transcript island: an overlay on every DM and player page.
// Word bubbles, newest at the bottom. Drag it, lock it to a corner, resize
// it, change its opacity, colour and text size, or minimise it to a pill.
// On phones it is a bottom drawer. Settings are per device (localStorage).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Modal } from '../../ui/index.tsx';
import { DockButton, DockItem, useExclusivePanel } from '../../ui/Dock.tsx';
import { useWorld } from '../../lib/world.tsx';
import { engine, useEngine } from './engine.ts';
import { useDeviceStt } from './stt.ts';
import { TranscriptView, useRecordingSync, useTranscript } from './TranscriptView.tsx';
import { useMainPrefs } from '../screens/prefs.ts';

type Corner = 'br' | 'bl' | 'tr' | 'tl';
interface Prefs { x: number; y: number; w: number; h: number; corner: Corner | null; opacity: number; colour: string; size: number; min: boolean; drawerOpen: boolean; autoCards: boolean }
const DEFAULTS: Prefs = { x: 40, y: 80, w: 340, h: 280, corner: 'br', opacity: 100, colour: 'gold', size: 15, min: true, drawerOpen: false, autoCards: true };
const COLOURS: Record<string, string> = { gold: '#D9B26A', teal: '#86CFC4', rose: '#E39AA6', sky: '#8FB8E8', slate: '#A8B0BF' };
const CORNERS: Corner[] = ['br', 'bl', 'tl', 'tr'];
const KEY = 'alx.island.prefs';

function loadPrefs(): Prefs {
  try {
    const p = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    // 92 was the old default, which let the page show through the text: only a deliberate choice stays see-through.
    if (p.opacity === 92) p.opacity = 100;
    return p;
  } catch { return DEFAULTS; }
}
function savePrefs(p: Prefs) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private window */ } }

function usePhone() {
  const [phone, setPhone] = useState(() => window.matchMedia?.('(max-width: 640px)').matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.('(max-width: 640px)');
    if (!mq) return;
    const f = () => setPhone(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  return phone;
}

export default function TranscriptOverlay() {
  const { info } = useWorld();
  const [main] = useMainPrefs();
  // A guest has no transcript and no microphone: nothing here would load but 403s.
  if (info.role === 'guest') return null;
  // The DM can keep the island off the main monitor when the transcript lives on the side screen.
  const onSideScreen = main.hideTranscript && info.role === 'dm';
  return <><RecordingBadge /><ConsentPrompt />{!onSideScreen && <Island />}</>;
}

function RecordingBadge() {
  useRecordingSync();
  const st = useEngine();
  const stt = useDeviceStt();
  if (!st.recording) return null;
  const here = stt.state === 'ready' || stt.state === 'running' || stt.state === 'behind';
  return (
    <DockItem order={1} keep>
      <span className="au-badge" role="status" aria-live="polite"><span className="au-rec-dot" /> Recording{here && <span className="au-badge-stt" title={`Transcribing on this device: ${stt.model}, ${stt.backend === 'webgpu' ? 'graphics card' : 'processor'}`}> · <i className="fa-solid fa-microchip" aria-hidden="true" /> transcribing on this device</span>}</span>
    </DockItem>
  );
}

function ConsentPrompt() {
  const { w, isDM } = useWorld();
  const st = useEngine();
  const [text, setText] = useState('');
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (st.recording && !isDM && !st.consent) void w.call<any>('GET', '/audio/consent').then((c) => setText(c.text)).catch(() => {}); }, [st.recording, st.consent, isDM, w]);
  if (isDM || !st.recording || st.consent || dismissed === st.sessionId) return null;
  return (
    <Modal title="This session is being recorded" onClose={() => setDismissed(st.sessionId)}>
      <p className="read">{text}</p>
      {err && <p className="small" style={{ color: 'var(--danger-text)' }}>{err}</p>}
      <div className="row end">
        <button type="button" className="btn" onClick={() => setDismissed(st.sessionId)}>Not now</button>
        <button type="button" className="btn primary" onClick={() => { void w.call('POST', '/audio/consent', { agree: true }).then(() => engine.setConsent(true)).catch((e) => setErr(e.message)); }}>I agree</button>
      </div>
      <p className="tiny muted">Your mic is only used if you also turn it on under My microphone.</p>
    </Modal>
  );
}

function Island() {
  const phone = usePhone();
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const stick = useRef(true);
  const box = useRef<HTMLDivElement>(null);
  const patch = useCallback((p: Partial<Prefs>) => setPrefs((cur) => { const n = { ...cur, ...p }; savePrefs(n); return n; }), []);
  const shut = useCallback(() => patch(phone ? { drawerOpen: false } : { min: true }), [patch, phone]);
  useExclusivePanel('transcript', phone ? prefs.drawerOpen : !prefs.min, shut);

  // A search result links here with ?line=<id>&session=<id>: show that session and that line.
  const [params] = useSearchParams();
  const wantLine = params.get('line');
  const wantSession = params.get('session');
  const t = useTranscript({ autoCards: prefs.autoCards, wantSession });
  const { st, lines, sid } = t;

  // Open the island on the linked line and scroll to it.
  useEffect(() => {
    if (!wantLine) return;
    patch(phone ? { drawerOpen: true } : { min: false });
    stick.current = false;
    const tm = setTimeout(() => document.querySelector(`[data-line="${CSS.escape(wantLine)}"]`)?.scrollIntoView({ block: 'center' }), 150);
    return () => clearTimeout(tm);
  }, [wantLine, lines.length, phone, patch]);

  // Drag by the header.
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, input, select')) return;
    const r = box.current!.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    patch({ x: r.left, y: r.top, corner: null });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const x = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.current.dx));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.current.dy));
    setPrefs((p) => ({ ...p, x, y, corner: null }));
  };
  const onUp = () => { if (drag.current) { drag.current = null; setPrefs((p) => { savePrefs(p); return p; }); } };

  // Remember the size after a resize.
  useEffect(() => {
    const el = box.current;
    if (!el || phone || prefs.min || typeof ResizeObserver === 'undefined') return;
    let tm: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(tm);
      tm = setTimeout(() => { const r = el.getBoundingClientRect(); if (Math.abs(r.width - prefs.w) > 2 || Math.abs(r.height - prefs.h) > 2) patch({ w: Math.round(r.width), h: Math.round(r.height) }); }, 300);
    });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(tm); };
  }, [phone, prefs.min, prefs.w, prefs.h, patch]);

  // The open island floats over the page, so it can sit on top of a chat box and its Send button (the assistant on a
  // laptop). Typing into a field whose form the island covers minimises it to its dock button; one click brings it back.
  useEffect(() => {
    if (phone || prefs.min) return;
    const onFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      const isl = box.current;
      if (!el || !isl || isl.contains(el) || !el.matches('input, textarea, [contenteditable="true"]')) return;
      const a = (el.closest('form') ?? el).getBoundingClientRect();
      const b = isl.getBoundingClientRect();
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) patch({ min: true });
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, [phone, prefs.min, patch]);

  const last = lines[lines.length - 1];
  const style = useMemo<React.CSSProperties>(() => {
    const s: React.CSSProperties = { ['--au-bg' as any]: `${prefs.opacity}%`, ['--au-colour' as any]: COLOURS[prefs.colour] ?? COLOURS.gold, ['--au-size' as any]: `${prefs.size}px` };
    if (phone) return s;
    if (prefs.min) { if (prefs.corner) Object.assign(s, corner(prefs.corner)); else Object.assign(s, { left: prefs.x, top: prefs.y }); return s; }
    Object.assign(s, { width: prefs.w, height: prefs.h });
    if (prefs.corner) Object.assign(s, corner(prefs.corner)); else Object.assign(s, { left: Math.min(prefs.x, Math.max(0, window.innerWidth - 120)), top: Math.min(prefs.y, Math.max(0, window.innerHeight - 60)) });
    return s;
  }, [prefs, phone]);

  if (!sid && !st.recording) return null;

  const open = phone ? prefs.drawerOpen : !prefs.min;
  const pill = (
    <DockButton order={40} icon="fa-closed-captioning" label={open ? 'Close the transcript' : 'Open the transcript'} title={last ? `Transcript - ${last.speaker}: ${last.text}`.slice(0, 120) : 'Transcript'} active={open} live={st.recording}
      onClick={() => (phone ? patch({ drawerOpen: !prefs.drawerOpen }) : patch({ min: !prefs.min }))} testId="dock-transcript" />
  );

  if (phone) {
    if (!prefs.drawerOpen) return pill;
    return (
      <><div className="au-island au-drawer" style={style}>
        <TranscriptView t={t} wantLine={wantLine} stick={stick} head={(viewBtn) => (
          <div className="au-head"><strong>Transcript</strong>{st.recording && <span className="au-rec-dot" />}<span className="au-sp" />
            {viewBtn}<Controls p={prefs} patch={patch} phone />
            <button type="button" className="au-btn" onClick={() => patch({ drawerOpen: false })} aria-label="Close the transcript">▾</button></div>
        )} />
      </div>{pill}</>
    );
  }
  if (prefs.min) return pill;
  return (
    <>{pill}<div className={`au-island${prefs.corner ? ` c-${prefs.corner}` : ''}`} style={style} ref={box} role="complementary" aria-label="Live transcript">
      <TranscriptView t={t} wantLine={wantLine} stick={stick} head={(viewBtn) => (
        <div className="au-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <strong>Transcript</strong>{st.recording && <span className="au-rec-dot" />}<span className="au-sp" />
          {viewBtn}<Controls p={prefs} patch={patch} />
          <button type="button" className="au-btn" aria-pressed={prefs.opacity < 100} title={prefs.opacity < 100 ? 'Make the background solid' : 'Make the background see-through'} aria-label="See-through transcript" onClick={() => patch({ opacity: prefs.opacity < 100 ? 100 : 15 })}><i className="fa-solid fa-circle-half-stroke" aria-hidden="true" /></button>
          <button type="button" className="au-btn" onClick={() => patch({ min: true })} aria-label="Minimise the transcript">—</button>
        </div>
      )} />
    </div></>
  );
}

function corner(c: Corner): React.CSSProperties {
  return { [c[0] === 'b' ? 'bottom' : 'top']: c[0] === 'b' ? 68 : 16, [c[1] === 'r' ? 'right' : 'left']: c[1] === 'r' ? 'var(--dock-right, 16px)' : 16 } as React.CSSProperties;
}

function Controls({ p, patch, phone }: { p: Prefs; patch: (x: Partial<Prefs>) => void; phone?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {!phone && <button type="button" className="au-btn" title="Lock to the next corner" aria-label="Lock to the next corner" onClick={() => patch({ corner: CORNERS[(CORNERS.indexOf(p.corner ?? 'tr') + 1) % 4] })}>⌖</button>}
      <button type="button" className="au-btn" aria-expanded={open} aria-label="Look and feel" onClick={() => setOpen((o) => !o)}>Aa</button>
      {open && (
        <div className="au-menu" onPointerDown={(e) => e.stopPropagation()}>
          <label>Background: {p.opacity === 0 ? 'clear' : p.opacity === 100 ? 'solid' : `${p.opacity}%`} <input type="range" min={0} max={100} value={p.opacity} aria-label="Transcript background" onChange={(e) => patch({ opacity: Number(e.target.value) })} /></label>
          <label>Text size <input type="range" min={11} max={26} value={p.size} onChange={(e) => patch({ size: Number(e.target.value) })} /></label>
          <label><input type="checkbox" checked={p.autoCards} onChange={(e) => patch({ autoCards: e.target.checked })} /> Show rule cards when a rule is said</label>
          <div className="au-swatches" role="group" aria-label="Bubble colour">
            {Object.entries(COLOURS).map(([k, v]) => <button key={k} type="button" className={`au-sw${p.colour === k ? ' on' : ''}`} style={{ background: v }} aria-label={k} onClick={() => patch({ colour: k })} />)}
          </div>
        </div>
      )}
    </>
  );
}
