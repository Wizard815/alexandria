// Start, see and end a session from any DM page: one button, one panel. Starting opens the table chat and, if wanted, the recording, and checks the DM in.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, Field, Switch, useAction } from '../ui/index.tsx';
import { useWorld, useLoad } from '../lib/world.tsx';
import { engine, type MicSetting } from '../features/audio/engine.ts';
import { useAttach, useInputs } from '../features/audio/shared.tsx';

const usable = (l: MicSetting[]) => l.some((s) => s.enabled && s.mode !== 'off');
const since = (iso: string) => { const m = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

export function SessionButton() {
  useAttach();
  const { w, info } = useWorld();
  const chat = useLoad<any>(() => w.call('GET', '/sessionchat/current'), [w], ['chat-session']);
  const audio = useLoad<any>(() => w.call('GET', '/audio/status'), [w], ['recording']);
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!open) return;
    const out = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', out); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc); };
  }, [open]);
  const session = chat.data?.session ?? null;
  const rec = audio.data?.recording ? audio.data.session : null;
  const running = !!session || !!rec;
  const reload = async () => { await Promise.all([chat.reload(), audio.reload()]); };
  return (
    <div className="dmx-pop-wrap" ref={box}>
      <button type="button" className={`btn small dmx-session${running ? ' live' : ' primary'}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="session-btn">
        {running ? <><span className={rec ? 'au-rec-dot' : 'live-dot'} /> <span>{rec ? 'Recording' : 'In session'}</span><span className="dmx-since"> · {since(session?.startedAt ?? session?.started_at ?? rec?.startedAt ?? rec?.started_at ?? new Date().toISOString())}</span></> : <><i className="fa-solid fa-play" aria-hidden="true" /> <span>Start session</span></>}
      </button>
      {open && (
        <div className="dmx-pop dmx-session-panel" role="dialog" aria-label="Session">
          {running ? <Running session={session} rec={rec} reload={reload} onDone={() => setOpen(false)} /> : <Start key={info.id} reload={reload} onDone={() => setOpen(false)} />}
        </div>
      )}
    </div>
  );
}

function Start({ reload, onDone }: { reload: () => Promise<void>; onDone: () => void }) {
  const { w, info } = useWorld();
  const { inputs, labelled, error: devError, reload: reloadInputs } = useInputs();
  const secure = typeof navigator !== 'undefined' && !!navigator.mediaDevices;
  const [mics, setMics] = useState<MicSetting[]>(() => engine.loadMics());
  const [title, setTitle] = useState('');
  const [record, setRecord] = useState(() => secure && usable(engine.loadMics()));
  const [here, setHere] = useState(true);
  const act = useAction();

  const useMic = (deviceId: string, label: string, enabled: boolean) => {
    const was = mics.find((m) => m.deviceId === deviceId);
    const next: MicSetting = { ...(was ?? ({ deviceId, label, deviceLabel: label, enabled, mode: 'always', playersTranscript: true, aside: false, key: '' } as MicSetting)), enabled };
    const list = [...mics.filter((m) => m.deviceId !== deviceId), next];
    setMics(list); engine.saveMics(list);
  };
  const start = () => act.run(async () => {
    if (record && !usable(mics)) throw new Error('Turn on a microphone below, or turn recording off.');
    try { await w.call('POST', '/sessionchat/sessions/start', { title: title.trim() || undefined }); } catch (e: any) { if (e.status !== 409) throw e; }
    if (here) await w.here('At the table').catch(() => {});
    if (record) {
      const l = await Promise.all(mics.map((m) => (m.enabled ? engine.register(m) : Promise.resolve(m))));
      setMics(l); engine.saveMics(l);
      try { await w.call('POST', '/audio/sessions', { name: title.trim() || undefined }); } catch (e: any) { await reload(); throw new Error(`The session is open, but recording did not start: ${e.message}`); }
      await engine.refresh();
    }
    await reload();
    onDone();
  });

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void start(); }}>
      <h2>Start a session</h2>
      <ErrorBox error={act.error} />
      <Field label="Name (optional)"><input value={title} maxLength={80} placeholder="Game night" onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>
      <label className="row between"><span>Check me in as here</span><Switch checked={here} onChange={setHere} label="Check me in as here" /></label>
      <label className="row between"><span>Record and transcribe</span><Switch checked={record} onChange={setRecord} label="Record and transcribe" /></label>
      {record && (!secure
        ? <p className="note small">This browser only allows microphones on a secure address. Open Alexandria with https:// to record from this computer.</p>
        : <div className="stack tight">
          {inputs.map((i) => <label key={i.deviceId} className="row between small"><span>{i.label}</span><Switch checked={!!mics.find((m) => m.deviceId === i.deviceId)?.enabled} onChange={(v) => useMic(i.deviceId, i.label, v)} label={`Use ${i.label}`} /></label>)}
          {(!inputs.length || !labelled) && <button type="button" className="btn small" onClick={() => void reloadInputs(true)}>Allow microphones</button>}
          {devError && <span className="tiny faint">{devError}</span>}
          <Link to={`/w/${info.slug}/dm/audio`} className="tiny" onClick={onDone}>Modes, hold keys and consent →</Link>
        </div>)}
      <button type="submit" className="btn primary" disabled={act.busy}>Start</button>
    </form>
  );
}

function Running({ session, rec, reload, onDone }: { session: any; rec: any; reload: () => Promise<void>; onDone: () => void }) {
  const { w, info } = useWorld();
  const act = useAction();
  const base = `/w/${info.slug}/dm`;
  const stopRec = async () => { await engine.stopAll(); await w.call('POST', `/audio/sessions/${rec.id}/stop`); };
  return (
    <div className="stack">
      <h2>{session?.title ?? rec?.name ?? 'Session'}</h2>
      <ErrorBox error={act.error} />
      <p className="small muted">{session ? 'Table chat is open.' : 'Table chat is closed.'} {rec ? 'Everyone sees the Recording sign.' : 'Not recording.'}</p>
      <div className="row"><Link className="btn small" to={`${base}/combat`} onClick={onDone}>Combat</Link><Link className="btn small" to={`${base}/chat`} onClick={onDone}>Table chat</Link><Link className="btn small" to={`${base}/scenes`} onClick={onDone}>Scenes</Link><Link className="btn small" to={`${base}/audio`} onClick={onDone}>Microphones</Link></div>
      <div className="row">
        <button type="button" className="btn danger" disabled={act.busy} onClick={() => void act.run(async () => { if (rec) await stopRec(); if (session) await w.call('POST', '/sessionchat/sessions/end'); await reload(); onDone(); })}>End session</button>
        {rec && session && <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(async () => { await stopRec(); await reload(); })}>Stop recording only</button>}
      </div>
    </div>
  );
}
