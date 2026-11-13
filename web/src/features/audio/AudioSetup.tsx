// DM: Audio setup. Turn on any number of mics, name them, set each one's
// mode, players' transcript, aside and hold key; start and stop the session.
import { useEffect, useRef, useState } from 'react';
import { PageHead, ErrorBox, Field, Switch, Loading, useAction, useToast } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { engine, useEngine, type MicSetting, type Mode } from './engine.ts';
import { KeyButton, Meter, MODE_LABELS, useAttach, useInputs } from './shared.tsx';

const MODES: Mode[] = ['always', 'hold-to-talk', 'hold-to-mute', 'off'];

export default function AudioSetup() {
  useAttach();
  const { w, info } = useWorld();
  const st = useEngine();
  const status = useLoad(() => w.call<any>('GET', '/audio/status'), [w], ['recording']);
  const consents = useLoad(() => w.call<any[]>('GET', '/audio/consents'), [w], ['recording']);
  const mics = useLoad(() => w.call<any[]>('GET', '/audio/mics'), [w], []);
  const { inputs, labelled, error: devError, reload } = useInputs();
  const [settings, setSettings] = useState<MicSetting[]>(() => engine.loadMics());
  const [asideKey, setAsideKey] = useState(() => engine.loadAsideKey());
  const [name, setName] = useState('');
  const [text, setText] = useState<string | null>(null);
  const [days, setDays] = useState<string>('');
  const { busy, error, run } = useAction();
  const { toast, toastNode } = useToast();
  const textRef = useRef(false);

  useEffect(() => { if (status.data && !textRef.current) { textRef.current = true; setText(status.data.consent.text); setDays(status.data.retentionDays === null ? '' : String(status.data.retentionDays)); } }, [status.data]);
  // The aside key is read by the engine; load it once the world is attached.
  useEffect(() => { setSettings(engine.loadMics()); setAsideKey(engine.loadAsideKey()); }, [info.id]);

  const recording = !!status.data?.recording;
  const setFor = (deviceId: string): MicSetting => settings.find((s) => s.deviceId === deviceId) ?? { deviceId, label: inputs.find((i) => i.deviceId === deviceId)?.label ?? 'Microphone', enabled: false, mode: 'always', playersTranscript: true, aside: false, key: '' };

  async function update(deviceId: string, patch: Partial<MicSetting>) {
    const next = { ...setFor(deviceId), ...patch };
    const list = [...settings.filter((s) => s.deviceId !== deviceId), next];
    setSettings(list);
    engine.saveMics(list);
    if (next.enabled) {
      await run(async () => {
        const reg = await engine.register(next);
        const l2 = [...list.filter((s) => s.deviceId !== deviceId), reg];
        setSettings(l2);
        engine.saveMics(l2);
      });
    }
  }

  async function start() {
    await run(async () => {
      // Make sure every enabled mic is registered, then start the session.
      const l = await Promise.all(settings.map((s) => (s.enabled ? engine.register(s) : Promise.resolve(s))));
      setSettings(l); engine.saveMics(l);
      if (!l.some((s) => s.enabled && s.mode !== 'off')) throw new Error('Turn on at least one microphone first.');
      await w.call('POST', '/audio/sessions', { name: name.trim() || undefined });
      await engine.refresh();
      await status.reload();
    });
  }
  async function stop() {
    await run(async () => {
      await engine.stopAll();
      if (status.data?.session) await w.call('POST', `/audio/sessions/${status.data.session.id}/stop`);
      await status.reload();
    });
  }
  async function saveWorld() {
    await run(async () => {
      const patch: Record<string, unknown> = { recordingConsentText: text ?? '' };
      patch.audioRetentionDays = days.trim() === '' ? null : Number(days);
      await w.updateSettings(patch);
      toast('Saved');
    });
  }

  return (
    <div className="page">
      <PageHead title="Audio setup" lead="Choose the microphones for this computer. Players join with their own phone or laptop. Hold keys work while this tab is open and focused." />
      <ErrorBox error={error ?? status.error ?? devError} />

      <section className="card gold">
        <div className="card-head">
          <h2>{recording ? <><span className="au-rec-dot" /> Recording: {status.data.session.name}</> : 'Session'}</h2>
          {recording
            ? <button type="button" className="btn danger" disabled={busy} onClick={() => void stop()}>Stop recording</button>
            : <button type="button" className="btn primary" disabled={busy} onClick={() => void start()}>● Start recording</button>}
        </div>
        {!recording && <Field label="Session name (optional)"><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Session 12: the lighthouse" /></Field>}
        <p className="small muted">While recording, every player and every screen sees a Recording sign. Players who have not agreed are asked first, and their mic stays off until they do.</p>
        {recording && <p className="small muted">Mic changes apply the next time you start a session.</p>}
        {st.error && <p className="small" style={{ color: 'var(--danger-text)' }}>{st.error}</p>}
      </section>

      <section className="stack">
        <div className="row between">
          <h2>Microphones on this computer</h2>
          <button type="button" className="btn small" onClick={() => void reload(true)}>{labelled ? 'Refresh the list' : 'Allow the microphone and list devices'}</button>
        </div>
        {!inputs.length && <p className="muted">{devError ?? 'No microphones found yet. Press the button above to let the browser show them.'}</p>}
        {inputs.map((inp) => {
          const s = setFor(inp.deviceId);
          const ms = s.serverId ? st.mics[s.serverId] : undefined;
          return (
            <article key={inp.deviceId} className={`card au-mic${s.enabled ? ' on' : ''}`}>
              <div className="card-head">
                <div className="stack tight"><strong>{inp.label}</strong>{ms?.error && <span className="tiny" style={{ color: 'var(--danger-text)' }}>{ms.error}</span>}</div>
                <label className="row" style={{ gap: 8 }}><span className="small">Use this mic</span><Switch checked={s.enabled} onChange={(v) => void update(inp.deviceId, { enabled: v })} label={`Use ${inp.label}`} /></label>
              </div>
              {s.enabled && (
                <div className="au-grid">
                  <Field label="Name"><input value={s.label === inp.label ? '' : s.label} placeholder={inp.label} maxLength={60} onChange={(e) => setSettings((l) => [...l.filter((x) => x.deviceId !== inp.deviceId), { ...s, label: e.target.value }])} onBlur={(e) => void update(inp.deviceId, { label: e.target.value.trim() || inp.label })} /></Field>
                  <Field label="Mode"><select value={s.mode} onChange={(e) => void update(inp.deviceId, { mode: e.target.value as Mode })}>{MODES.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}</select></Field>
                  <div className="field"><span className="label">Players' transcript</span><label className="row" style={{ gap: 8 }}><Switch checked={s.playersTranscript} onChange={(v) => void update(inp.deviceId, { playersTranscript: v })} label="Show this mic in the players' transcript" /><span className="tiny">{s.playersTranscript ? 'Players see it' : 'DM only'}</span></label></div>
                  <div className="field"><span className="label">DM aside mic</span><label className="row" style={{ gap: 8 }}><Switch checked={s.aside} onChange={(v) => void update(inp.deviceId, { aside: v })} label="Treat this mic as an aside" /><span className="tiny">{s.aside ? 'Keeps every mic out of the players’ view while in use' : 'Off'}</span></label></div>
                  <div className="field"><span className="label">Hold key</span><KeyButton value={s.key} onChange={(k) => void update(inp.deviceId, { key: k })} /></div>
                  <div className="field"><span className="label">Signal</span>{ms?.recording ? <><Meter level={ms.level} /><span className="tiny faint">{ms.sent} sent{ms.failed ? `, ${ms.failed} failed` : ''}</span></> : <span className="tiny faint">Not recording</span>}</div>
                </div>
              )}
              {s.enabled && s.mode === 'hold-to-talk' && <p className="tiny muted">Hold to talk: this mic only counts while its key is held. A DM-only mic used this way is also an aside for every other mic.</p>}
            </article>
          );
        })}
      </section>

      <section className="card">
        <h2>DM aside key</h2>
        <p className="small muted">Hold it while you say something the players must not read. Everything every mic hears in that time stays in your transcript only.</p>
        <KeyButton value={asideKey} onChange={(k) => { setAsideKey(k); engine.saveAsideKey(k); }} />
        {engine.asideHeld && <span className="au-rec-dot" />}
      </section>

      <section className="card">
        <h2>Consent and keeping audio</h2>
        {text === null ? <Loading /> : (
          <>
            <Field label="What players are asked to agree to"><textarea value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} /></Field>
            <Field label="Keep raw audio for (days)" help="Blank keeps it forever. Transcripts are always kept until deleted."><input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} placeholder="30" /></Field>
            <div className="row"><button type="button" className="btn primary" disabled={busy} onClick={() => void saveWorld()}>Save</button></div>
          </>
        )}
        <h3>Who has agreed</h3>
        {(consents.data ?? []).length === 0 ? <p className="small muted">No players yet.</p> : (
          <ul className="au-list">{(consents.data ?? []).map((p) => <li key={p.accountId}><span>{p.character || p.name}</span><span className={p.agreed ? 'tiny ok' : 'tiny faint'}>{p.agreed ? 'Agreed' : 'Not yet'}</span></li>)}</ul>
        )}
      </section>

      <section className="card">
        <h2>Mics in this world</h2>
        <ul className="au-list">{(mics.data ?? []).map((m) => <li key={m.id}><span>{m.label} <span className="tiny faint">({m.owner})</span></span><span className="tiny faint">{MODE_LABELS[m.mode as Mode]}{m.playersTranscript ? '' : ' · DM only'}{m.aside ? ' · aside' : ''}</span></li>)}</ul>
        <div className="row"><button type="button" className="btn small" onClick={() => void run(async () => { const r = await w.call<any>('POST', '/audio/retry'); toast(`${r.transcribed} transcribed, ${r.pending} still waiting`); })}>Transcribe audio that was waiting for the model</button></div>
      </section>
      {toastNode}
    </div>
  );
}
