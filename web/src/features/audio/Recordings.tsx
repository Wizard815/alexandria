// Recordings: the GM's page (every session's audio: a full recording and one track per mic, the transcript
// beside it, downloads, retention) and the player's "My recordings" (their own mic track and the players'
// transcript only). Audio is played from signed per-viewer addresses the server hands out.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHead, ErrorBox, Empty, Loading, Markdown, useAction } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';

interface Track { id: string; kind: 'full' | 'mic'; label: string; person: string; durationMs: number; bytes: number; file: string; url: string }
interface Retention { mode: 'default' | 'forever' | 'days'; days: number | null; effectiveDays: number | null; deletesAt: string | null; daysLeft: number | null }
interface RecSession {
  id: string; name: string; date: string; startedAt: string; stoppedAt: string | null; active: boolean; durationMs: number; status: string; error: string | null; warnings: string[];
  progress: { pct: number; step: string } | null; builtAt: string | null; folder?: string; people: string[]; mics: number; bytes: number; rawChunks: number; retention: Retention;
  audioDeleted: boolean; canBuild: boolean; tracks?: Track[]; final?: FinalView | null; zipUrl?: string | null;
}
interface FinalView {
  status: 'running' | 'done' | 'failed' | 'undone'; step: string; pct: number; startedAt: string; finishedAt: string | null; error: string | null;
  offsets: Record<string, { ms: number; method: string; votes: number }>; stats: { mics?: number; words?: number; liveLines?: number; finalLines?: number; retranscribed?: boolean }; hasLive: boolean;
}
interface Line { id: string; start: number; end: number; speaker: string; text: string; audience?: 'players' | 'dm' }

const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const x = s % 60; return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(x).padStart(2, '0')}`; };
const long = (ms: number) => { if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} s`; const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

function retentionText(s: { audioDeleted: boolean; retention: Retention }): string {
  if (s.audioDeleted) return 'Audio deleted';
  const r = s.retention;
  if (!r.deletesAt) return 'Kept forever';
  return r.daysLeft === 0 ? 'Deletes today' : `Deletes in ${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'}`;
}

const STATUS: Record<string, string> = { ready: 'Ready', building: 'Building…', queued: 'Waiting to build…', failed: 'Build failed', raw: 'Not built yet', deleted: 'Audio deleted', none: 'No audio', preparing: 'Being prepared…', recording: 'Recording…' };

function save(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim() || 'session';

function transcriptText(name: string, date: string, lines: Line[], md: boolean): string {
  const head = md ? `# ${name}\n\n${date}\n\n` : `${name}\n${date}\n\n`;
  return head + lines.map((l) => (md ? `- \`${clock(l.start)}\` **${l.speaker}**${l.audience === 'dm' ? ' (**GM only**)' : ''}: ${l.text}` : `[${clock(l.start)}] ${l.speaker}${l.audience === 'dm' ? ' (GM only)' : ''}: ${l.text}`)).join('\n') + '\n';
}

/** The transcript; a click on a line moves the player to that moment. */
function Transcript({ lines, now, onSeek, dm }: { lines: Line[]; now: number; onSeek: (ms: number) => void; dm: boolean }) {
  const active = useMemo(() => { let a = -1; lines.forEach((l, i) => { if (l.start <= now) a = i; }); return a; }, [lines, now]);
  const box = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = box.current?.children[active] as HTMLElement | undefined;
    const c = box.current;
    if (el && c && (el.offsetTop < c.scrollTop || el.offsetTop + el.offsetHeight > c.scrollTop + c.clientHeight)) c.scrollTop = el.offsetTop - c.clientHeight / 3;
  }, [active]);
  if (!lines.length) return <Empty>No transcript for this session.</Empty>;
  return (
    <ol className="rec-lines" ref={box} aria-label="Transcript">
      {lines.map((l, i) => (
        <li key={l.id} className={i === active ? 'on' : ''}>
          <button type="button" className="rec-line" onClick={() => onSeek(l.start)} aria-label={`Play from ${clock(l.start)}`}>
            <span className="rec-t">{clock(l.start)}</span>
            <span className="rec-s">{l.speaker}{dm && l.audience === 'dm' && <em className="au-tag">GM only</em>}</span>
            <span className="rec-x">{l.text}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function TrackRow({ t, audioRef, main }: { t: Track; audioRef?: (el: HTMLAudioElement | null) => void; main?: boolean }) {
  return (
    <div className={`rec-track${main ? ' main' : ''}`}>
      <div className="row between wrap" style={{ gap: 8 }}>
        <div><strong>{t.label}</strong>{t.kind === 'mic' && <span className="muted small"> · {t.person}</span>}<span className="muted small"> · {clock(t.durationMs)} · {size(t.bytes)}</span></div>
        <a className="btn small" href={`${t.url}?download=1`} download={t.file} aria-label={`Download ${t.label}`}><i className="fa-solid fa-download" aria-hidden="true" /> Download</a>
      </div>
      <audio controls preload="metadata" src={t.url} ref={audioRef} aria-label={t.label} />
    </div>
  );
}

/** One session: players, transcript beside them and downloads. */
function SessionView({ s, lines, dm }: { s: { id: string; name: string; date: string; tracks?: Track[]; zipUrl?: string | null }; lines: Line[]; dm: boolean }) {
  const main = useRef<HTMLAudioElement | null>(null);
  const [now, setNow] = useState(0);
  const tracks = s.tracks ?? [];
  const lead = tracks.find((t) => t.kind === 'full') ?? tracks[0];
  useEffect(() => { setNow(0); }, [s.id]);
  useEffect(() => {
    const a = main.current;
    if (!a) return;
    const f = () => setNow(a.currentTime * 1000);
    a.addEventListener('timeupdate', f);
    a.addEventListener('seeked', f);
    return () => { a.removeEventListener('timeupdate', f); a.removeEventListener('seeked', f); };
  }, [lead?.id]);
  const seek = (ms: number) => {
    const a = main.current;
    if (!a) return;
    const go = () => { a.currentTime = ms / 1000; setNow(ms); void a.play().catch(() => {}); };
    if (a.readyState >= 1) go(); else { a.addEventListener('loadedmetadata', go, { once: true }); a.load(); }
  };
  return (
    <div className="rec-view">
      <div className="rec-players stack">
        {s.zipUrl && (
          <div className="row between wrap" style={{ gap: 6 }}>
            <a className="btn small" href={s.zipUrl} download data-testid="rec-download-all" aria-label={`Download everything for ${s.name}`}><i className="fa-solid fa-file-zipper" aria-hidden="true" /> Download all (.zip)</a>
            <span className="tiny muted">{dm ? 'The full session, every mic, the transcripts, the approved summary and session.json.' : 'Your own microphone, the players’ transcript and the players’ summary.'}</span>
          </div>
        )}
        {lead ? <TrackRow key={lead.id} t={lead} audioRef={(el) => { main.current = el; }} main /> : <Empty>No audio to play.</Empty>}
        {tracks.filter((t) => t !== lead).length > 0 && <h3 className="rec-h">{dm ? 'Each microphone' : 'Your microphone'}</h3>}
        {tracks.filter((t) => t !== lead).map((t) => <TrackRow key={t.id} t={t} />)}
      </div>
      <div className="rec-transcript stack">
        <div className="row between wrap" style={{ gap: 8 }}>
          <h3 className="rec-h" style={{ margin: 0 }}>Transcript</h3>
          {lines.length > 0 && (
            <span className="row" style={{ gap: 6 }}>
              <button type="button" className="btn small" onClick={() => save(`${safeName(s.name)} - Transcript.md`, transcriptText(s.name, s.date, lines, true), 'text/markdown')}><i className="fa-solid fa-download" aria-hidden="true" /> .md</button>
              <button type="button" className="btn small" onClick={() => save(`${safeName(s.name)} - Transcript.txt`, transcriptText(s.name, s.date, lines, false), 'text/plain')}><i className="fa-solid fa-download" aria-hidden="true" /> .txt</button>
            </span>
          )}
        </div>
        {lead && lines.length > 0 && <p className="tiny muted" style={{ margin: 0 }}>Click a line to play the recording from there.</p>}
        <Transcript lines={lines} now={now} onSeek={seek} dm={dm} />
      </div>
    </div>
  );
}

// ---- the GM's page ----------------------------------------------------------------------------------

function KeepAudio({ s, reload }: { s: RecSession; reload: () => Promise<void> }) {
  const { w } = useWorld();
  const act = useAction();
  const [mode, setMode] = useState<Retention['mode']>(s.retention.mode);
  const [days, setDays] = useState(String(s.retention.days ?? s.retention.effectiveDays ?? 30));
  useEffect(() => { setMode(s.retention.mode); setDays(String(s.retention.days ?? s.retention.effectiveDays ?? 30)); }, [s.id, s.retention.mode, s.retention.days, s.retention.effectiveDays]);
  const apply = () => act.run(async () => { await w.call('POST', `/audio/recordings/${s.id}/retention`, mode === 'days' ? { mode, days: Number(days) } : { mode }); await reload(); });
  const wipe = () => {
    if (!window.confirm(`Delete the audio of “${s.name}” from the server now? The transcript, summaries and logs stay. This cannot be undone.`)) return;
    void act.run(async () => { await w.call('POST', `/audio/recordings/${s.id}/delete-audio`, { confirm: true }); await reload(); });
  };
  return (
    <section className="card stack" aria-label="Keeping the audio">
      <h3 style={{ margin: 0 }}>Keeping the audio</h3>
      <ErrorBox error={act.error} />
      {s.audioDeleted ? <p className="muted small" style={{ margin: 0 }}>The audio was deleted. The transcript stays.</p> : (
        <>
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <label className="row" style={{ gap: 6 }}><span className="small">Audio</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as Retention['mode'])} aria-label="How long to keep the audio">
                <option value="default">Use the world setting</option>
                <option value="days">Delete after N days</option>
                <option value="forever">Keep forever</option>
              </select>
            </label>
            {mode === 'days' && <label className="row" style={{ gap: 6 }}><input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 80 }} aria-label="Days to keep the audio" /><span className="small">days after the session</span></label>}
            <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void apply()}>Save</button>
          </div>
          <p className="tiny muted" style={{ margin: 0 }}>{retentionText(s)}{s.retention.mode === 'default' && ` (world setting: ${s.retention.effectiveDays ? `${s.retention.effectiveDays} days` : 'forever'})`}. The transcript, summaries and logs always stay.</p>
          {s.status !== 'building' && s.status !== 'queued' && <div><button type="button" className="btn small danger" disabled={act.busy} onClick={wipe}>Delete audio now</button></div>}
        </>
      )}
    </section>
  );
}

function StatusBox({ s, reload }: { s: RecSession; reload: () => Promise<void> }) {
  const { w } = useWorld();
  const act = useAction();
  const build = () => act.run(async () => { await w.call('POST', `/audio/recordings/${s.id}/build`); await reload(); });
  return (
    <div className="stack" style={{ gap: 6 }}>
      <ErrorBox error={act.error} />
      {(s.status === 'building' || s.status === 'queued') && (
        <div role="status"><strong>{s.status === 'queued' ? 'Waiting to build…' : s.progress?.step ?? 'Building…'}</strong>
          <div className="au-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={s.progress?.pct ?? 0}><div style={{ width: `${s.progress?.pct ?? 3}%` }} /></div>
          <p className="tiny muted" style={{ margin: '4px 0 0' }}>The files are joined on the server; you can leave this page.</p></div>
      )}
      {s.status === 'failed' && <div className="error-box" role="alert">Build failed: {s.error ?? 'unknown error'} {s.canBuild ? 'The raw audio is kept. ' : ''}{s.canBuild && <button type="button" className="btn small" disabled={act.busy} onClick={() => void build()}>Rebuild</button>}</div>}
      {s.status === 'raw' && !s.active && <div className="row wrap" style={{ gap: 8 }}><span className="small">This session is still raw audio chunks.</span><button type="button" className="btn small primary" disabled={act.busy || !s.canBuild} onClick={() => void build()}>Build recording</button></div>}
      {s.status === 'raw' && s.active && <p className="small muted" style={{ margin: 0 }}>Still recording. The files are built when you stop.</p>}
      {s.warnings.map((x) => <p key={x} className="tiny muted" style={{ margin: 0 }}>{x}</p>)}
      {s.status === 'ready' && s.folder && <p className="tiny muted" style={{ margin: 0 }}>On the server: <code>./data/{s.folder}/</code></p>}
    </div>
  );
}

const SYNC: Record<string, string> = { reference: 'reference clock', words: 'matched by shared words', upload: 'from upload timing', none: 'not shifted' };

/** The final transcript: every mic synced onto one timeline, duplicates removed; made after the session, can be redone or undone. */
function FinalBox({ s, reload }: { s: RecSession; reload: () => Promise<void> }) {
  const { w } = useWorld();
  const act = useAction();
  const mics = useLoad<any[]>(() => w.call<any[]>('GET', '/audio/mics'), [w]);
  const f = s.final ?? null;
  const name = (id: string) => mics.data?.find((m) => m.id === id)?.label ?? 'A mic that was removed';
  const make = (retranscribe: boolean) => act.run(async () => { await w.call('POST', `/audio/sessions/${s.id}/final`, { retranscribe }); await reload(); });
  const undo = () => act.run(async () => { await w.call('POST', `/audio/sessions/${s.id}/final/undo`); await reload(); });
  if (s.active) return null;
  return (
    <section className="card stack" aria-label="Final transcript">
      <h3 style={{ margin: 0 }}>Final transcript</h3>
      <ErrorBox error={act.error} />
      {!f && <p className="small muted" style={{ margin: 0 }}>Not made yet. It is made a little after the session stops: every mic’s text is put on one clock, the same speech heard by two mics is kept once, and each line is credited to the closest mic.</p>}
      {f?.status === 'running' && (
        <div role="status"><strong>{f.step || 'Working…'}</strong>
          <div className="au-meter" role="progressbar" aria-label="Final transcript" aria-valuemin={0} aria-valuemax={100} aria-valuenow={f.pct}><div style={{ width: `${Math.max(3, f.pct)}%` }} /></div></div>
      )}
      {f?.status === 'done' && (
        <p className="small" style={{ margin: 0 }} data-final="done">
          Synced {f.stats.mics ?? 0} mic{f.stats.mics === 1 ? '' : 's'} onto one timeline: {f.stats.liveLines ?? 0} live lines became {f.stats.finalLines ?? 0}.{f.stats.retranscribed ? ' The audio was listened to again by the server model first.' : ''} Transcript.md was written again.
        </p>
      )}
      {f?.status === 'failed' && <div className="error-box" role="alert">The final transcript failed: {f.error ?? 'unknown error'}. The live transcript is unchanged.</div>}
      {f?.status === 'undone' && <p className="small muted" style={{ margin: 0 }}>Undone: this is the live transcript again.</p>}
      {f && Object.keys(f.offsets).length > 1 && (
        <ul className="au-list" aria-label="Clock sync per mic">
          {Object.entries(f.offsets).map(([id, o]) => <li key={id}><span className="small">{name(id)}</span><span className="tiny faint">{o.method === 'reference' ? SYNC.reference : `${o.ms > 0 ? '+' : ''}${(o.ms / 1000).toFixed(2)} s · ${SYNC[o.method] ?? o.method}`}</span></li>)}
        </ul>
      )}
      {f?.status !== 'running' && (
        <div className="row wrap" style={{ gap: 6 }}>
          <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void make(false)}>{f && f.status !== 'undone' ? 'Make it again' : 'Make the final transcript'}</button>
          <button type="button" className="btn small" disabled={act.busy || s.audioDeleted} title={s.audioDeleted ? 'The audio was deleted' : undefined} onClick={() => void make(true)}>Listen again with the server model, then sync</button>
          {f?.status === 'done' && f.hasLive && <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void undo()}>Undo (back to the live transcript)</button>}
        </div>
      )}
    </section>
  );
}

interface HandoffCard { id: string; status: 'pending' | 'approved' | 'discarded'; text: string; source: 'live' | 'final'; logDraftId: string | null; createdAt: string; updatedAt: string; decidedAt: string | null }
interface Handoff { minervaOn: boolean; where: 'minerva' | 'recordings' | 'none'; source: 'live' | 'final'; hasSummary: boolean; minerva: { id: string; status: string; title: string; createdAt: string }[]; cards: HandoffCard[] }
const FROM = { live: 'the running notes (live transcript)', final: 'the final transcript' };

/**
 * Where this session's summary went: Minerva's review queue (when Minerva is on), or a "Summary ready" card here to
 * approve (saved as a session log draft), edit or discard. It is the GM's summary, so only the GM's page shows it.
 */
function SummaryBox({ s }: { s: RecSession }) {
  const { w, info } = useWorld();
  const act = useAction();
  const h = useLoad<Handoff>(() => w.call<Handoff>('GET', `/audio/sessions/${s.id}/handoff`), [w, s.id], ['audio-handoff', 'audio-summary', 'minerva', 'transcript-final']);
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  if (s.active) return null;
  const v = h.data;
  const decide = (c: HandoffCard, action: 'approve' | 'discard') => act.run(async () => {
    await w.call('POST', `/audio/sessions/${s.id}/handoff/${c.id}`, { action, ...(edit?.id === c.id ? { text: edit.text } : {}) });
    setEdit(null);
    await h.reload();
  });
  const pending = v?.cards.filter((c) => c.status === 'pending') ?? [];
  const decided = v?.cards.filter((c) => c.status !== 'pending') ?? [];
  const minervaPending = v?.minerva.filter((x) => x.status === 'pending') ?? [];
  return (
    <section className="card stack" aria-label="Session summary" data-testid="rec-summary" data-where={v?.where ?? ''}>
      <h3 style={{ margin: 0 }}>Session summary</h3>
      <ErrorBox error={act.error ?? h.error} />
      {!v ? <Loading /> : (
        <>
          {v.where === 'none' && <p className="small muted" style={{ margin: 0 }}>{v.hasSummary ? 'Getting the summary ready for your review…' : 'No summary yet. It is made from the transcript a few seconds after the recording stops (it needs a chat model), and made again from the final transcript.'}</p>}
          {v.where === 'minerva' && (
            <p className="small" style={{ margin: 0 }} data-testid="rec-summary-where">
              The summary went to <Link to={`/w/${info.slug}/gm/minerva`}>Minerva’s review queue</Link> as “Last session” for the Campaign Status.{' '}
              {minervaPending.length ? `${minervaPending.length === 1 ? 'It waits' : `${minervaPending.length} drafts wait`} for your approval there; nothing is written before you approve.` : 'You have decided it there.'}
              {v.source === 'final' ? ' It is made from the final transcript.' : ''}
            </p>
          )}
          {v.where === 'recordings' && (
            <p className="small" style={{ margin: 0 }} data-testid="rec-summary-where">
              Minerva is off for this world, so the summary waits here for you. Approve saves it as a <Link to={`/w/${info.slug}/gm/sessionlog`}>session log</Link> draft (players see nothing until you publish it there); Discard drops it.
            </p>
          )}
          {pending.map((c) => (
            <div key={c.id} className="stack tight rec-summary-card" data-card="pending">
              <div className="row between wrap" style={{ gap: 6 }}><strong>Summary ready</strong><span className="tiny muted">from {FROM[c.source]}{decided.some((x) => x.status === 'approved') ? ' · an update after the one you approved' : ''}</span></div>
              {edit?.id === c.id
                ? <textarea value={edit.text} onChange={(e) => setEdit({ id: c.id, text: e.target.value })} rows={10} aria-label="Edit the summary" style={{ width: '100%' }} />
                : <div className="small rec-summary-text"><Markdown text={c.text} /></div>}
              <div className="row wrap" style={{ gap: 6 }}>
                <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void decide(c, 'approve')}>{edit?.id === c.id ? 'Save and approve' : 'Approve'}</button>
                {edit?.id === c.id
                  ? <button type="button" className="btn small" disabled={act.busy} onClick={() => setEdit(null)}>Cancel edit</button>
                  : <button type="button" className="btn small" disabled={act.busy} onClick={() => setEdit({ id: c.id, text: c.text })}>Edit</button>}
                <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void decide(c, 'discard')}>Discard</button>
              </div>
            </div>
          ))}
          {decided.map((c) => (
            <p key={c.id} className="tiny muted" style={{ margin: 0 }} data-card={c.status}>
              {c.status === 'approved' ? <>Approved{c.decidedAt ? ` ${c.decidedAt.slice(0, 10)}` : ''}: saved as a <Link to={`/w/${info.slug}/gm/sessionlog`}>session log draft</Link> (from {FROM[c.source]}).</> : <>Discarded (from {FROM[c.source]}).</>}
            </p>
          ))}
        </>
      )}
    </section>
  );
}

export function RecordingsDM() {
  const { w } = useWorld();
  const list = useLoad<{ sessions: RecSession[]; ffmpeg: boolean }>(() => w.call('GET', '/audio/recordings'), [w], ['recording', 'transcript-final']);
  const [sel, setSel] = useState<string | null>(null);
  const sessions = list.data?.sessions ?? [];
  useEffect(() => { if (!sel && sessions.length) setSel(sessions[0].id); }, [sessions, sel]);
  const busy = sessions.some((s) => s.status === 'building' || s.status === 'queued' || s.final?.status === 'running');
  useEffect(() => { if (!busy) return; const t = setInterval(() => void list.reload(), 2000); return () => clearInterval(t); }, [busy, list]);
  const cur = sessions.find((s) => s.id === sel) ?? null;
  const detail = useLoad<RecSession | null>(() => (sel ? w.call<RecSession>('GET', `/audio/recordings/${sel}`) : Promise.resolve(null)), [w, sel, cur?.status, cur?.builtAt], []);
  const lines = useLoad<Line[]>(() => (sel ? w.call<{ lines: Line[] }>('GET', `/audio/sessions/${sel}/lines`).then((r) => r.lines) : Promise.resolve([])), [w, sel, cur?.final?.status, cur?.final?.finishedAt]);
  const d = detail.data && detail.data.id === sel ? detail.data : null;
  const reload = async () => { await list.reload(); await detail.reload(); };

  return (
    <div className="page wide">
      <PageHead title="Recordings" lead="Each session’s audio, to play, download or delete. The files also sit plainly on the server." />
      <ErrorBox error={list.error} />
      {list.data && !list.data.ffmpeg && <div className="error-box" role="alert">ffmpeg is not installed on this server, so recordings cannot be built (the Docker image has it). Raw audio is kept until it is.</div>}
      {list.loading && !list.data ? <Loading /> : !sessions.length ? <Empty>No sessions have been recorded yet.</Empty> : (
        <div className="cols rec-cols">
          <aside className="col-1 stack rec-list" aria-label="Sessions">
            {sessions.map((s) => (
              <button key={s.id} type="button" className={`card rec-item${s.id === sel ? ' on' : ''}`} aria-pressed={s.id === sel} onClick={() => setSel(s.id)}>
                <div className="row between" style={{ gap: 8 }}><strong>{s.name}</strong><span className={`rec-chip ${s.status}`}>{STATUS[s.status] ?? s.status}</span></div>
                <div className="small muted">{s.date} · {s.durationMs ? long(s.durationMs) : '—'} · {s.bytes ? size(s.bytes) : 'no files'}</div>
                <div className="small muted">{s.mics} mic{s.mics === 1 ? '' : 's'}{s.people.length ? ` · ${s.people.join(', ')}` : ''}</div>
                <div className="small">{retentionText(s)}</div>
              </button>
            ))}
          </aside>
          <div className="col-2 stack">
            {cur && (
              <>
                <h2 style={{ margin: 0 }}>{cur.name} <span className="muted small">{cur.date}</span></h2>
                <StatusBox s={cur} reload={reload} />
                <SessionView s={{ id: cur.id, name: cur.name, date: cur.date, tracks: d && !d.audioDeleted && d.status === 'ready' ? d.tracks : [], zipUrl: d?.zipUrl ?? null }} lines={lines.data ?? []} dm />
                <FinalBox s={cur} reload={reload} />
                <SummaryBox s={cur} />
                <KeepAudio s={cur} reload={reload} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- a player's page ------------------------------------------------------------------------------------

interface MineSession { id: string; name: string; date: string; status: string; durationMs: number; audioDeleted: boolean; deletesAt: string | null; daysLeft: number | null; tracks: Track[]; zipUrl?: string | null }

export function MyRecordings() {
  const { w } = useWorld();
  const list = useLoad<{ sessions: MineSession[] }>(() => w.call('GET', '/audio/recordings/mine'), [w], ['recording']);
  const [sel, setSel] = useState<string | null>(null);
  const sessions = list.data?.sessions ?? [];
  useEffect(() => { if (!sel && sessions.length) setSel(sessions[0].id); }, [sessions, sel]);
  const wait = sessions.some((s) => s.status === 'preparing');
  useEffect(() => { if (!wait) return; const t = setInterval(() => void list.reload(), 4000); return () => clearInterval(t); }, [wait, list]);
  const cur = sessions.find((s) => s.id === sel) ?? null;
  const lines = useLoad<Line[]>(() => (sel ? w.call<{ lines: Line[] }>('GET', `/audio/sessions/${sel}/lines`).then((r) => r.lines) : Promise.resolve([])), [w, sel]);
  return (
    <div className="page">
      <PageHead title="My recordings" lead="Your own microphone from each session, and what the table said." />
      <ErrorBox error={list.error} />
      {list.loading && !list.data ? <Loading /> : !sessions.length ? <Empty>You have not been recorded in any session yet. Turn on your microphone under My microphone when the GM starts one.</Empty> : (
        <div className="stack">
          <label className="field" style={{ maxWidth: 420 }}><span className="label">Session</span>
            <select value={sel ?? ''} onChange={(e) => setSel(e.target.value)} aria-label="Session">
              {sessions.map((s) => <option key={s.id} value={s.id}>{s.date} · {s.name}</option>)}
            </select>
          </label>
          {cur && (
            <>
              <p className="small muted" style={{ margin: 0 }}>{STATUS[cur.status] ?? cur.status}{cur.durationMs ? ` · ${long(cur.durationMs)}` : ''}{cur.deletesAt && !cur.audioDeleted ? ` · ${retentionText({ audioDeleted: false, retention: { mode: 'default', days: null, effectiveDays: 1, deletesAt: cur.deletesAt, daysLeft: cur.daysLeft } })}` : ''}</p>
              <SessionView s={cur} lines={lines.data ?? []} dm={false} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
