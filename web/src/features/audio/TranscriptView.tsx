// The transcript itself (word bubbles, the "So far" summary, rule cards), apart from where it sits. The floating island
// and the GM's pop-out / side-screen panel both show it, so the loading and live updates live here once.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Markdown } from '../../ui/index.tsx';
import { useAuth } from '../../lib/auth.tsx';
import { useWorld } from '../../lib/world.tsx';
import { engine, useEngine } from './engine.ts';
import { CardView, Highlighted, loadCard, matchText, useMatches, type Match } from './keywords.tsx';
import { useAttach } from './shared.tsx';

export interface Line { id: string; rev: number; start: number; end: number; speaker: string; speakerId?: string | null; text: string; audience?: 'players' | 'gm'; override?: 'players' | 'gm' | null }

/** Keeps the engine in step with the world: status on load, and whenever recording starts or stops. */
export function useRecordingSync() {
  const { on, info } = useWorld();
  const { client } = useAuth();
  // Effects run children first: attach before the status call, or the engine has no world yet and the badge never shows.
  useAttach();
  useEffect(() => {
    void engine.refresh().catch(() => {});
    const offRec = on(['recording'], () => { void engine.refresh().catch(() => {}); });
    // The GM changed where speech to text runs: a device that is recording switches now (loads or frees its model).
    const offStt = on(['stt-mode'], (e) => { const m = (e.data as any)?.mode; if (m === 'server' || m === 'device' || m === 'auto') engine.sttModeChanged(m); });
    return () => { offRec(); offStt(); };
  }, [on, info.id, client.token]);
}

/** The lines of one session (the one a link asks for, else the live one, else the latest), kept current, plus the running summary and spoken rule cards. */
export function useTranscript(opts: { autoCards: boolean; wantSession?: string | null }) {
  const { w, on, isGM } = useWorld();
  const st = useEngine();
  const [lines, setLines] = useState<Line[]>([]);
  const [sid, setSid] = useState<string | null>(null);
  const [view, setView] = useState<'lines' | 'sofar'>('lines');
  const [soFar, setSoFar] = useState<{ text: string; lines: number; updatedAt: string | null } | null>(null);
  // A rules term just said at the table: its card shows by itself for a while (a click keeps it).
  const [spoken, setSpoken] = useState<{ m: Match; card: any; keep: boolean; note?: string } | null>(null);
  const shownTerms = useRef(new Map<string, number>());
  const lastSeen = useRef<string | null>(null);
  const { autoCards, wantSession } = opts;

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
    if (!l || !autoCards || !st.recording) { if (l) lastSeen.current = l.id; return; }
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
  }, [lines, autoCards, st.recording, w]);
  // Minerva flagged a rules call (GM only): the rule's card with her one-line note, kept until closed.
  useEffect(() => on(['rules-note'], (e) => {
    const n = e.data;
    if (!isGM || !n || (sid && n.sessionId !== sid)) return;
    const m: Match = { start: 0, end: 0, text: n.term, term: n.term, kind: 'rule', source: 'module', id: n.ref } as Match;
    void loadCard(w, m).then((card) => { if (card) setSpoken({ m, card, keep: true, note: n.note }); });
  }), [on, isGM, sid, w]);
  useEffect(() => {
    if (!spoken || spoken.keep) return;
    const t = setTimeout(() => setSpoken((cur) => (cur && !cur.keep ? null : cur)), 15_000);
    return () => clearTimeout(t);
  }, [spoken]);

  return { st, lines, sid, view, setView, soFar, loadSoFar, spoken, setSpoken };
}
export type Transcript = ReturnType<typeof useTranscript>;

/**
 * Bubbles or the summary, and the rule card. `head` gets the "So far" toggle so the caller can put it in its own header
 * (the island's is a drag handle). `stick` is the caller's "follow the newest line" flag, so a link can switch it off.
 */
export function TranscriptView({ t, wantLine, stick, head }: { t: Transcript; wantLine?: string | null; stick?: React.MutableRefObject<boolean>; head?: (viewBtn: React.ReactNode) => React.ReactNode }) {
  const { w, isGM } = useWorld();
  const { st, lines, sid, view, setView, soFar, loadSoFar, spoken, setSpoken } = t;
  const [hover, setHover] = useState<{ m: Match; x: number; y: number; card: any } | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const own = useRef(true);
  const follow = stick ?? own;
  useEffect(() => {
    const el = body.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [lines, view, follow]);

  const showCard = async (m: Match | null, el?: HTMLElement) => {
    if (!m || !el) { setHover(null); return; }
    const r = el.getBoundingClientRect();
    const card = await loadCard(w, m);
    if (card) setHover({ m, x: Math.min(r.left, window.innerWidth - 300), y: r.bottom + 6, card });
  };
  const mark = (l: Line, audience: 'gm' | 'auto') => { void w.call('PATCH', `/audio/lines/${l.id}`, { audience }); };

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
      {isGM && sid && <button type="button" className="btn small" onClick={() => { void w.call('POST', `/audio/sessions/${sid}/summary/refresh`).then(loadSoFar).catch(() => {}); }}>Update now</button>}
    </div>
  );
  const viewBtn = <button type="button" className={`au-btn${view === 'sofar' ? ' on' : ''}`} aria-pressed={view === 'sofar'} title="So far: the running summary of the session" onClick={() => setView((v) => (v === 'sofar' ? 'lines' : 'sofar'))} data-testid="au-sofar-btn">So far</button>;
  const lineBubbles = (
    <div className="au-body" ref={body} onScroll={(e) => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {lines.length === 0 && <p className="au-empty">{st.recording ? 'Listening… the first lines appear after a few seconds.' : 'No transcript yet.'}</p>}
      {(wantLine && !lines.slice(-60).some((l) => l.id === wantLine) ? lines.filter((l, i) => i >= lines.length - 60 || l.id === wantLine) : lines.slice(-60)).map((l) => <Bubble key={l.id} l={l} isGM={isGM} onHover={showCard} onMark={mark} found={l.id === wantLine} />)}
    </div>
  );
  return (
    <>
      {head?.(viewBtn)}
      {view === 'sofar' ? sofarView : lineBubbles}{ruleCard}
      {hover && <div className="au-pop" style={{ left: hover.x, top: hover.y }}><CardView card={hover.card} m={hover.m} /></div>}
    </>
  );
}

function Bubble({ l, isGM, onHover, onMark, found }: { l: Line; isGM: boolean; onHover: (m: Match | null, el?: HTMLElement) => void; onMark: (l: Line, a: 'gm' | 'auto') => void; found?: boolean }) {
  const { w } = useWorld();
  const matches = useMatches(w, l.id, l.rev, l.text);
  const gmOnly = l.audience === 'gm';
  return (
    <div className={`au-bubble${gmOnly ? ' gm' : ''}${found ? ' found' : ''}`} data-line={l.id}>
      <span className="au-who">{l.speaker || 'Someone'}{gmOnly && <em className="au-tag">GM only</em>}</span>
      <span className="au-text"><Highlighted text={l.text} matches={matches} onHover={onHover} /></span>
      {isGM && !gmOnly && <button type="button" className="au-mini" onClick={() => onMark(l, 'gm')} title="Hide this line from the players">Make GM-only</button>}
      {isGM && gmOnly && l.override === 'gm' && <button type="button" className="au-mini" onClick={() => onMark(l, 'auto')} title="Let the rules decide again">Undo</button>}
    </div>
  );
}

/** The transcript on its own, for a pop-out window or a side-screen panel. */
export function TranscriptPanel() {
  useRecordingSync();
  const t = useTranscript({ autoCards: true });
  return (
    <div className="au-panel" style={{ ['--au-colour' as any]: '#D9B26A', ['--au-size' as any]: '16px' }}>
      <TranscriptView t={t} head={(btn) => <div className="au-head" style={{ cursor: 'default' }}><strong>Transcript</strong>{t.st.recording && <span className="au-rec-dot" />}<span className="au-sp" />{btn}</div>} />
    </div>
  );
}
