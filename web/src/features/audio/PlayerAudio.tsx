// Player: agree to recording, pick one mic, and (for hold to talk) a big
// button. A player's mic always records as that player.
import { useEffect, useState } from 'react';
import { PageHead, ErrorBox, Field, Switch, useAction } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { engine, healMic, useEngine, type MicSetting, type Mode } from './engine.ts';
import { KeyButton, Meter, MODE_LABELS, useAttach, useInputs } from './shared.tsx';
import { deviceStt, useDeviceStt } from './stt.ts';
import { DeviceSttNote } from './SttStatus.tsx';

const MODES: Mode[] = ['always', 'hold-to-talk', 'hold-to-mute', 'off'];

export default function PlayerAudio() {
  useAttach();
  const { w, info } = useWorld();
  const st = useEngine();
  const status = useLoad(() => w.call<any>('GET', '/audio/status'), [w], ['recording']);
  const { inputs, labelled, error: devError, reload } = useInputs();
  const [mic, setMic] = useState<MicSetting | null>(null);
  const { busy, error, run } = useAction();
  const stt = useDeviceStt();
  const [sttAllowed, setSttAllowed] = useState(() => deviceStt.allowed);

  useEffect(() => { setMic(engine.loadMics()[0] ?? null); }, [info.id]);
  // The browser may have renamed the device id since the mic was picked (Safari, a cleared profile): find it by name.
  useEffect(() => {
    if (!mic || !labelled) return;
    const healed = healMic(mic, inputs);
    if (healed !== mic) { setMic(healed); engine.saveMics([healed]); }
  }, [mic, inputs, labelled]);

  const consent = status.data?.consent;
  const recording = !!status.data?.recording;
  const ms = mic?.serverId ? st.mics[mic.serverId] : undefined;

  async function agree(v: boolean) {
    await run(async () => { await w.call('POST', '/audio/consent', { agree: v }); engine.setConsent(v); await status.reload(); });
  }

  async function save(patch: Partial<MicSetting>) {
    const base: MicSetting = mic ?? { deviceId: inputs[0]?.deviceId ?? '', label: inputs[0]?.label || 'My microphone', deviceLabel: inputs[0]?.label, enabled: false, mode: 'always', playersTranscript: true, aside: false, key: '' };
    const next = { ...base, ...patch };
    setMic(next);
    engine.saveMics([next]);
    if (next.enabled && next.deviceId !== undefined) {
      await run(async () => {
        const reg = await engine.register(next);
        setMic(reg);
        engine.saveMics([reg]);
        // Recording already? Join it.
        if (recording) { await engine.stopAll(); await engine.refresh(); }
      });
    } else if (!next.enabled && engine.getState().recording) await engine.stopAll().then(() => engine.refresh());
  }

  const holdMode = mic?.mode === 'hold-to-talk' || mic?.mode === 'hold-to-mute';
  const down = (e: React.PointerEvent) => { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); if (mic?.serverId) engine.pressMic(mic.serverId); };
  const up = () => { if (mic?.serverId) engine.releaseMic(mic.serverId); };

  return (
    <div className="page">
      <PageHead title="My microphone" lead="Use your phone or laptop mic so the table transcript knows when you speak." />
      <ErrorBox error={error ?? status.error ?? devError} />

      <section className="card gold">
        <h2>{recording ? <><span className="au-rec-dot" /> Recording now</> : 'Recording'}</h2>
        {consent ? (
          <>
            <p className="read">{consent.text}</p>
            {consent.agreed
              ? <div className="row between"><span className="small ok">You have agreed to recording in this world.</span><button type="button" className="btn small" disabled={busy} onClick={() => void agree(false)}>Withdraw my consent</button></div>
              : <div className="row"><button type="button" className="btn primary" disabled={busy} onClick={() => void agree(true)}>I agree</button><span className="small muted">Your mic is never used until you agree.</span></div>}
          </>
        ) : <p className="muted">Loading…</p>}
      </section>

      {consent?.agreed && (
        <section className="card">
          <div className="card-head">
            <h2>Your mic</h2>
            <label className="row" style={{ gap: 8 }}><span className="small">Use it</span><Switch checked={!!mic?.enabled} onChange={(v) => void save({ enabled: v })} label="Use my microphone" /></label>
          </div>
          <div className="au-grid">
            <Field label="Microphone">
              <select value={mic?.deviceId ?? ''} onChange={(e) => { const l = inputs.find((i) => i.deviceId === e.target.value)?.label; void save({ deviceId: e.target.value, label: l ?? 'My microphone', deviceLabel: l }); }}>
                {!mic?.deviceId && <option value="">Choose…</option>}
                {inputs.map((i) => <option key={i.deviceId} value={i.deviceId}>{i.label}</option>)}
              </select>
            </Field>
            <Field label="Mode"><select value={mic?.mode ?? 'always'} onChange={(e) => void save({ mode: e.target.value as Mode })}>{MODES.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}</select></Field>
            {holdMode && <div className="field"><span className="label">Hold key (laptop)</span><KeyButton value={mic?.key ?? ''} onChange={(k) => void save({ key: k })} /></div>}
            <div className="field"><span className="label">Signal</span>{ms?.recording ? <Meter level={ms.level} /> : <span className="tiny faint">{recording ? 'Not recording yet' : 'Starts when the GM starts recording'}</span>}</div>
          </div>
          {!labelled && <button type="button" className="btn small" onClick={() => void reload(true)}>Allow the microphone</button>}
          {ms?.error && <p className="small" style={{ color: 'var(--danger-text)' }}>{ms.error}</p>}
          {holdMode && (
            <button type="button" className={`au-hold${ms?.held ? ' held' : ''}`} disabled={!ms?.recording}
              onPointerDown={down} onPointerUp={up} onPointerCancel={up} onContextMenu={(e) => e.preventDefault()}>
              {mic?.mode === 'hold-to-mute' ? (ms?.held ? 'Muted' : 'Hold to mute') : (ms?.held ? 'Listening…' : 'Hold to talk')}
            </button>
          )}
          {holdMode && !ms?.recording && <p className="small muted">The button works once a session is recording.</p>}
        </section>
      )}

      {consent?.agreed && status.data?.transcription?.stt && status.data.transcription.stt !== 'server' && (
        <section className="card stack" aria-label="Speech to text on this device">
          <div className="card-head">
            <h2 style={{ margin: 0 }}>Speech to text on this device</h2>
            <label className="row" style={{ gap: 8 }}><span className="small">Allow</span><Switch checked={sttAllowed} onChange={(v) => { setSttAllowed(v); deviceStt.setAllowed(v); }} label="Let this device turn my speech into text" /></label>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            The GM asked {status.data.transcription.stt === 'auto' ? 'devices with a graphics card the browser can use' : 'each device'} to turn its own mic into text, so the server has less to do.
            {' '}The speech model is downloaded from your table’s server the first time (tens of megabytes) and kept. It uses battery while recording; switch it off and the server does it instead.
          </p>
          {ms?.recording ? <DeviceSttNote view={stt} player /> : <p className="tiny faint" style={{ margin: 0 }}>{sttAllowed ? 'Starts with the recording.' : 'Off: the server transcribes your mic.'}</p>}
        </section>
      )}
    </div>
  );
}
