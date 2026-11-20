// The floating transcript island: an overlay on every DM and player page.
// Word bubbles, newest at the bottom. Drag it, lock it to a corner, resize
// it, change its opacity, colour and text size, or minimise it to a pill.
// On phones it is a bottom drawer. Settings are per device (localStorage).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Markdown, Modal } from '../../ui/index.tsx';
import { DockButton, DockItem, useExclusivePanel } from '../../ui/Dock.tsx';
import { useAuth } from '../../lib/auth.tsx';
import { useWorld } from '../../lib/world.tsx';
import { engine, useEngine } from './engine.ts';
import { CardView, Highlighted, loadCard, matchText, useMatches, type Match } from './keywords.tsx';
import { useAttach } from './shared.tsx';

interface Line { id: string; rev: number; start: number; end: number; speaker: string; speakerId?: string | null; text: string; audience?: 'players' | 'dm'; override?: 'players' | 'dm' | null }
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
  // A guest has no transcript and no microphone: nothing here would load but 403s.
  if (info.role === 'guest') return null;
  return <><RecordingBadge /><ConsentPrompt /><Island /></>;
}

/** Keeps the engine in step with the world: status on load, and whenever recording starts or stops. */
function useRecordingSync() {
  const { on, info } = useWorld();
  const { client } = useAuth();
  // Effects run children first: attach before the status call, or the engine has no world yet and the badge never shows.
  useAttach();
  useEffect(() => {
    void engine.refresh().catch(() => {});
    return on(['recording'], () => { void engine.refresh().catch(() => {}); });
  }, [on, info.id, client.token]);
}

function RecordingBadge() {
  useRecordingSync();
  const st = useEngine();
  if (!st.recording) return null;
  return <DockItem order={1} keep><span className="au-badge" role="status" aria-live="polite"><span className="au-rec-dot" /> Recording</span></DockItem>;
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
  const { w, on, isDM } = useWorld();
  const st = useEngine();
  const phone = usePhone();
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [lines, setLines] = useState<Line[]>([]);
  const [sid, setSid] = useState<string | null>(null);
  const [hover, setHover] = useState<{ m: Match; x: number; y: number; card: any } | null>(null);
  const [view, setView] = useState<'lines' | 'sofar'>('lines');
  const [soFar, setSoFar] = useState<{ text: string; lines: number; updatedAt: string | null } | null>(null);
  // A rules term just said at the table: its card shows by itself for a while (a click keeps it).
  const [spoken, setSpoken] = useState<{ m: Match; card: any; keep: boolean; note?: string } | null>(null);
  const shownTerms = useRef(new Map<string, number>());
  const lastSeen = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const patch = useCallback((p: Partial<Prefs>) => setPrefs((cur) => { const n = { ...cur, ...p }; savePrefs(n); return n; }), []);
  const shut = useCallback(() => patch(phone ? { drawerOpen: false } : { min: true }), [patch, phone]);
  useExclusivePanel('transcript', phone ? prefs.drawerOpen : !prefs.min, shut);

  // A search result links here with ?line=<id>&session=<id>: show that session and that line.
  const [params] = useSearchParams();
  const wantLine = params.get('line');
  const wantSession = params.get('session');

  // Which session to show: the one a link asks for, else the live one, else the latest.
  const load = useCallback(async () => {
    try {
      const s = await w.call<any>('GET', '/audio/status');
      const id = wantSession ?? s.session?.id ?? s.lastSession?.id ?? null;
      setSid(id);
      if (!id) { setLines([]); return; }
      const r = await w.call<any>('GET', `/audio/sessions/${id}/lines`);
      setLines(r.lines);
    } catch { /* guests and offline: nothing to show */ }
  }, [w, wantSession]);
  useEffect(() => { void load(); }, [load, st.sessionId, st.recording]);
  // Open the island on the linked line and scroll to it.
  useEffect(() => {
    if (!wantLine) return;
    patch(phone ? { drawerOpen: true } : { min: false });
    stick.current = false;
    const t = setTimeout(() => document.querySelector(`[data-line="${CSS.escape(wantLine)}"]`)?.scrollIntoView({ block: 'center' }), 150);
    return () => clearTimeout(t);
  }, [wantLine, lines.length, phone, patch]);
  useEffect(() => on(['transcript-line'], (e) => {
    const d = e.data;
    setLines((cur) => {
      if (d.removed) return cur.filter((l) => l.id !== d.id);
      const i = cur.findIndex((l) => l.id === d.id);
      if (i >= 0) { if (cur[i].rev > d.rev) return cur; const n = [...cur]; n[i] = d; return n; }
      return [...cur, d].sort((a, b) => a.start - b.start).slice(-300);
    });
  }), [on]);

  // The running summary of the session ("So far"): loaded when shown, and again whenever it is updated.
  const loadSoFar = useCallback(async () => { if (!sid) return; try { setSoFar(await w.call<any>('GET', `/audio/sessions/${sid}/summary`)); } catch { /* none yet */ } }, [w, sid]);
  useEffect(() => { if (view === 'sofar') void loadSoFar(); }, [view, loadSoFar]);
  useEffect(() => on(['audio-summary'], (e) => { if (e.data?.sessionId === sid && view === 'sofar') void loadSoFar(); }), [on, sid, view, loadSoFar]);

  // Rule cards by themselves: the newest line's first rules term (a spell, a condition...) that has not shown in the
  // last five minutes. Only while recording, only new lines, never for a line loaded from the past.
  useEffect(() => {
    const l = lines[lines.length - 1];
    if (!l || !prefs.autoCards || !st.recording) { if (l) lastSeen.current = l.id; return; }
    if (lastSeen.current === null) { lastSeen.current = l.id; return; }
    if (lastSeen.current === l.id) return;
    lastSeen.current = l.id;
    let alive = true;
    void matchText(w, `${l.id}:${l.rev}`, l.text).then(async (ms) => {
      const m = ms.find((x) => x.source === 'module' && Date.now() - (shownTerms.current.get(x.term) ?? 0) > 5 * 60_000);
      if (!m || !alive) return;
      const card = await loadCard(w, m);
      if (!card || !alive) return;
      shownTerms.current.set(m.term, Date.now());
      setSpoken((cur) => (cur?.keep ? cur : { m, card, keep: false }));
    });
    return () => { alive = false; };
  }, [lines, prefs.autoCards, st.recording, w]);
  // Minerva flagged a rules call (DM only): the rule's card with her one-line note, kept until closed.
  useEffect(() => on(['rules-note'], (e) => {
    const n = e.data;
    if (!isDM || !n || (sid && n.sessionId !== sid)) return;
    const m: Match = { start: 0, end: 0, text: n.term, term: n.term, kind: 'rule', source: 'module', id: n.ref } as Match;
    void loadCard(w, m).then((card) => { if (card) setSpoken({ m, card, keep: true, note: n.note }); });
  }), [on, isDM, sid, w]);
  useEffect(() => {
    if (!spoken || spoken.keep) return;
    const t = setTimeout(() => setSpoken((cur) => (cur && !cur.keep ? null : cur)), 15_000);
    return () => clearTimeout(t);
  }, [spoken]);

  useEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, prefs.min, prefs.drawerOpen]);

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
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { const r = el.getBoundingClientRect(); if (Math.abs(r.width - prefs.w) > 2 || Math.abs(r.height - prefs.h) > 2) patch({ w: Math.round(r.width), h: Math.round(r.height) }); }, 300);
    });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, [phone, prefs.min, prefs.w, prefs.h, patch]);

  const last = lines[lines.length - 1];
  const showCard = async (m: Match | null, el?: HTMLElement) => {
    if (!m || !el) { setHover(null); return; }
    const r = el.getBoundingClientRect();
    const card = await loadCard(w, m);
    if (card) setHover({ m, x: Math.min(r.left, window.innerWidth - 300), y: r.bottom + 6, card });
  };
  const mark = (l: Line, audience: 'dm' | 'auto') => { void w.call('PATCH', `/audio/lines/${l.id}`, { audience }); };

  const style = useMemo<React.CSSProperties>(() => {
    const s: React.CSSProperties = { opacity: phone ? 1 : prefs.opacity / 100, ['--au-colour' as any]: COLOURS[prefs.colour] ?? COLOURS.gold, ['--au-size' as any]: `${prefs.size}px` };
    if (phone) return s;
    if (prefs.min) { if (prefs.corner) Object.assign(s, corner(prefs.corner)); else Object.assign(s, { left: prefs.x, top: prefs.y }); return s; }
    Object.assign(s, { width: prefs.w, height: prefs.h });
    if (prefs.corner) Object.assign(s, corner(prefs.corner)); else Object.assign(s, { left: Math.min(prefs.x, Math.max(0, window.innerWidth - 120)), top: Math.min(prefs.y, Math.max(0, window.innerHeight - 60)) });
    return s;
  }, [prefs, phone]);

  if (!sid && !st.recording) return null;

  const ruleCard = spoken && (
    <div className="au-spoken" role="status" aria-live="polite" onClick={() => setSpoken({ ...spoken, keep: true })} data-testid="au-spoken">
      <div className="au-spoken-head"><span className="muted">{spoken.note ? "Minerva" : "Said just now"}</span><span className="au-sp" />
        {spoken.note ? <span className="muted">Rules check</span> : spoken.keep ? <span className="muted">kept</span> : <span className="muted">click to keep</span>}
        <button type="button" className="au-btn" aria-label="Close the rule card" onClick={(e) => { e.stopPropagation(); setSpoken(null); }}>×</button></div>
      {spoken.note && <p className="au-rules-note" data-testid="au-rules-note"><i className="fa-solid fa-scale-balanced" aria-hidden="true" /> {spoken.note}</p>}
      <CardView card={spoken.card} m={spoken.m} />
    </div>
  );
  const sofarView = (
    <div className="au-body au-sofar" data-testid="au-sofar">
      {soFar?.text ? <><Markdown text={soFar.text} /><p className="muted" style={{ fontSize: '0.8em' }}>Running summary of {soFar.lines} lines{soFar.updatedAt ? `, updated ${new Date(soFar.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}.</p></>
        : <p className="au-empty">The summary starts after the first few minutes of play (it needs a chat model).</p>}
      {isDM && sid && <button type="button" className="btn small" onClick={() => { void w.call('POST', `/audio/sessions/${sid}/summary/refresh`).then(loadSoFar).catch(() => {}); }}>Update now</button>}
    </div>
  );
  const viewBtn = <button type="button" className={`au-btn${view === 'sofar' ? ' on' : ''}`} aria-pressed={view === 'sofar'} title="So far: the running summary of the session" onClick={() => setView((v) => (v === 'sofar' ? 'lines' : 'sofar'))} data-testid="au-sofar-btn">So far</button>;
  const lineBubbles = (
    <div className="au-body" ref={body} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {lines.length === 0 && <p className="au-empty">{st.recording ? 'Listening… the first lines appear after a few seconds.' : 'No transcript yet.'}</p>}
      {(wantLine && !lines.slice(-60).some((l) => l.id === wantLine) ? lines.filter((l, i) => i >= lines.length - 60 || l.id === wantLine) : lines.slice(-60)).map((l) => <Bubble key={l.id} l={l} isDM={isDM} onHover={showCard} onMark={mark} found={l.id === wantLine} />)}
    </div>
  );

  const bubbles = <>{view === 'sofar' ? sofarView : lineBubbles}{ruleCard}</>;
  const open = phone ? prefs.drawerOpen : !prefs.min;
  const pill = (
    <DockButton order={40} icon="fa-closed-captioning" label={open ? 'Close the transcript' : 'Open the transcript'} title={last ? `Transcript - ${last.speaker}: ${last.text}`.slice(0, 120) : 'Transcript'} active={open} live={st.recording}
      onClick={() => (phone ? patch({ drawerOpen: !prefs.drawerOpen }) : patch({ min: !prefs.min }))} testId="dock-transcript" />
  );

  const card = hover && <div className="au-pop" style={{ left: hover.x, top: hover.y }}><CardView card={hover.card} m={hover.m} /></div>;

  if (phone) {
    if (!prefs.drawerOpen) return pill;
    return (
      <><div className="au-island au-drawer" style={style}>
        <div className="au-head"><strong>Transcript</strong>{st.recording && <span className="au-rec-dot" />}<span className="au-sp" />
          {viewBtn}<Controls p={prefs} patch={patch} phone />
          <button type="button" className="au-btn" onClick={() => patch({ drawerOpen: false })} aria-label="Close the transcript">▾</button></div>
        {bubbles}{card}
      </div>{pill}</>
    );
  }
  if (prefs.min) return <>{pill}{card}</>;
  return (
    <>{pill}<div className={`au-island${prefs.corner ? ` c-${prefs.corner}` : ''}`} style={style} ref={box} role="complementary" aria-label="Live transcript">
      <div className="au-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <strong>Transcript</strong>{st.recording && <span className="au-rec-dot" />}<span className="au-sp" />
        {viewBtn}<Controls p={prefs} patch={patch} />
        <button type="button" className="au-btn" onClick={() => patch({ min: true })} aria-label="Minimise the transcript">—</button>
      </div>
      {bubbles}{card}
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
          <label>Opacity <input type="range" min={20} max={100} value={p.opacity} onChange={(e) => patch({ opacity: Number(e.target.value) })} /></label>
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

function Bubble({ l, isDM, onHover, onMark, found }: { l: Line; isDM: boolean; onHover: (m: Match | null, el?: HTMLElement) => void; onMark: (l: Line, a: 'dm' | 'auto') => void; found?: boolean }) {
  const { w } = useWorld();
  const matches = useMatches(w, l.id, l.rev, l.text);
  const dmOnly = l.audience === 'dm';
  return (
    <div className={`au-bubble${dmOnly ? ' dm' : ''}${found ? ' found' : ''}`} data-line={l.id}>
      <span className="au-who">{l.speaker || 'Someone'}{dmOnly && <em className="au-tag">DM only</em>}</span>
      <span className="au-text"><Highlighted text={l.text} matches={matches} onHover={onHover} /></span>
      {isDM && !dmOnly && <button type="button" className="au-mini" onClick={() => onMark(l, 'dm')} title="Hide this line from the players">Make DM-only</button>}
      {isDM && dmOnly && l.override === 'dm' && <button type="button" className="au-mini" onClick={() => onMark(l, 'auto')} title="Let the rules decide again">Undo</button>}
    </div>
  );
}
