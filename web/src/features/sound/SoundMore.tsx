// Sound board: who is listening, Spotify, and this computer's speaker groups.
import { useEffect, useRef, useState } from 'react';
import { ErrorBox, Empty, Field, useAction, useToast } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { loadSpeakers, saveSpeakers, sinkSupported, type Channel, type Speakers } from './engine.ts';

export function Listeners() {
  const { w } = useWorld();
  const l = useLoad(() => w.call<any[]>('GET', '/sound/listeners'), [w], ['sound-listeners']);
  const rows = (l.data ?? []).filter((r) => !r.stale);
  const yes = <span className="chip green">on</span>;
  const no = <span className="chip">off</span>;
  return (
    <div className="card">
      <div className="card-head"><h3 style={{ margin: 0 }}>Who hears what</h3><span className="tiny muted">Per device. Players switch these on themselves.</span></div>
      <ErrorBox error={l.error} />
      {rows.length === 0 ? <Empty>Nobody has any sound switched on. At the table that is usual: they hear the room speakers.</Empty> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead><tr><th align="left">Player</th><th align="left">Device</th><th>Music</th><th>Ambience</th><th>Effects</th><th align="left">Seen</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.account + r.device}>
                  <td>{r.name}</td><td>{r.label || 'Device'}</td>
                  <td align="center">{r.music ? yes : no}</td><td align="center">{r.ambience ? yes : no}</td><td align="center">{r.sfx ? yes : no}</td>
                  <td className="tiny muted">{when(r.seenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function SpotifyTab() {
  const { w, info } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const st = useLoad(() => w.call('GET', '/sound/spotify'), [w]);
  const [clientId, setClientId] = useState('');
  const [rows, setRows] = useState<[string, string][]>([]);
  const redirectUri = `${window.location.origin}/w/${info.slug}/dm/sound`;
  const seeded = useRef(false);

  useEffect(() => {
    if (!st.data || seeded.current) return;
    seeded.current = true;
    setClientId(st.data.clientId);
    const e = Object.entries(st.data.events) as [string, string][];
    setRows(e.length ? e : [['combat', ''], ['tavern', '']]);
  }, [st.data]);

  // Back from Spotify's sign-in: the address carries ?code=...&state=...
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.get('state') || !(q.get('code') || q.get('error'))) return;
    window.history.replaceState({}, '', window.location.pathname);
    if (q.get('error')) { act.setError(`Spotify said: ${q.get('error')}`); return; }
    void act.run(async () => { await w.call('POST', '/sound/spotify/callback', { code: q.get('code'), state: q.get('state') }); toast('Spotify connected'); await st.reload(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const S = st.data;
  return (
    <div className="stack loose">
      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Spotify</h3><span className={`chip${S?.connected ? ' green' : ''}`}>{S?.connected ? 'Connected' : 'Not connected'}</span></div>
        <p className="small muted" style={{ margin: 0 }}>Needs Spotify Premium and Spotify open on one of your own devices. It plays on that device only; players never hear Spotify through Alexandria.
          Create an app at developer.spotify.com, add this redirect address to it, and paste its client id:</p>
        <code className="small" style={{ overflowWrap: 'anywhere' }}>{redirectUri}</code>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Client id"><input value={clientId} onChange={(e) => setClientId(e.target.value)} /></Field>
          <button type="button" className="btn" disabled={act.busy || !clientId.trim()} onClick={() => void act.run(async () => { await w.call('PUT', '/sound/spotify', { clientId: clientId.trim() }); await st.reload(); toast('Saved'); })}>Save</button>
          <button type="button" className="btn primary" disabled={act.busy || !S?.clientId} onClick={() => void act.run(async () => { const r = await w.call('POST', '/sound/spotify/login', { redirectUri }); window.location.href = r.url; })}>{S?.connected ? 'Connect again' : 'Connect Spotify'}</button>
          {S?.connected && <button type="button" className="btn danger" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('DELETE', '/sound/spotify'); await st.reload(); })}>Disconnect</button>}
        </div>
        <ErrorBox error={act.error || st.error} />
        {toastNode}
      </div>
      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Events and playlists</h3></div>
        {rows.map(([k, v], i) => (
          <div key={i} className="row" style={{ alignItems: 'flex-end' }}>
            <Field label="Event"><input value={k} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} placeholder="combat" /></Field>
            <Field label="Playlist link or URI"><input value={v} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} placeholder="https://open.spotify.com/playlist/…" /></Field>
            <button type="button" className="btn small" disabled={act.busy || !S?.connected || !S?.events?.[k.trim().toLowerCase()]} onClick={() => void act.run(async () => { await w.call('POST', '/sound/spotify/play', { event: k }); toast(`Playing “${k}”`); })}><i className="fa-solid fa-play" aria-hidden="true" /> Play</button>
            <button type="button" className="btn small ghost" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
          </div>
        ))}
        <div className="row">
          <button type="button" className="btn small" onClick={() => setRows([...rows, ['', '']])}>Add event</button>
          <button type="button" className="btn primary" disabled={act.busy} onClick={() => void act.run(async () => { const r = await w.call('PUT', '/sound/spotify/events', { events: Object.fromEntries(rows.filter(([k]) => k.trim())) }); setRows(Object.entries(r.events) as [string, string][]); await st.reload(); toast('Saved'); })}>Save events</button>
        </div>
        <p className="tiny muted" style={{ margin: 0 }}>Save the events before playing one. A new link is checked when you save.</p>
      </div>
    </div>
  );
}

const CHANNELS: [Channel, string][] = [['music', 'Music'], ['ambience', 'Ambience'], ['sfx', 'Sound effects'], ['voice', 'Read aloud voice']];

export function SpeakersTab() {
  const [s, setS] = useState<Speakers>(loadSpeakers);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [name, setName] = useState('');
  const [pick, setPick] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const supported = sinkSupported();
  const update = (n: Speakers) => { setS(n); saveSpeakers(n); };

  const list = async () => {
    try {
      let d = (await navigator.mediaDevices.enumerateDevices()).filter((x) => x.kind === 'audiooutput');
      setDevices(d);
      setErr(null);
    } catch (e: any) { setErr(e.message ?? String(e)); }
  };
  useEffect(() => { if (supported) void list(); }, [supported]);
  const allow = async () => {
    // Browsers hide output device names until the page has been given the microphone once.
    try { const m = await navigator.mediaDevices.getUserMedia({ audio: true }); m.getTracks().forEach((t) => t.stop()); } catch { /* declined */ }
    await list();
  };

  return (
    <div className="stack loose">
      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>This computer’s speakers</h3><span className="tiny muted">Saved on this computer only.</span></div>
        <label className="row small"><input type="checkbox" checked={s.tableOn} onChange={(e) => update({ ...s, tableOn: e.target.checked })} /> Play table sound on this computer</label>
        {!supported && <p className="small muted" style={{ margin: 0 }}>This browser cannot choose an output device, so everything plays on the default output. Chrome, Edge and other Chromium browsers can.</p>}
        {supported && (
          <>
            <p className="small muted" style={{ margin: 0 }}>Name a group of speakers, then choose which group each kind of sound plays on. A group with several devices plays on all of them at once.</p>
            <div className="row"><button type="button" className="btn small" onClick={() => void allow()}>Show device names</button>{devices.length === 0 && <span className="tiny muted">No output devices found.</span>}</div>
            <ErrorBox error={err} />
            <div className="stack tight">
              {devices.map((d, i) => (
                <label key={d.deviceId + i} className="row small"><input type="checkbox" checked={pick.includes(d.deviceId)} onChange={(e) => setPick(e.target.checked ? [...pick, d.deviceId] : pick.filter((x) => x !== d.deviceId))} /> {d.label || `Output ${i + 1}`}</label>
              ))}
            </div>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <Field label="Group name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Table speakers" /></Field>
              <button type="button" className="btn primary" disabled={!name.trim() || !pick.length} onClick={() => { update({ ...s, groups: { ...s.groups, [name.trim()]: pick } }); setName(''); setPick([]); }}>Save group</button>
            </div>
            {Object.entries(s.groups).map(([g, ids]) => (
              <div key={g} className="row between"><span>{g} <span className="tiny faint">({ids.length} {ids.length === 1 ? 'device' : 'devices'})</span></span>
                <button type="button" className="btn small ghost" onClick={() => { const { [g]: _, ...rest } = s.groups; update({ ...s, groups: rest, assign: Object.fromEntries(Object.entries(s.assign).filter(([, v]) => v !== g)) }); }}>Remove</button></div>
            ))}
          </>
        )}
      </div>
      {supported && Object.keys(s.groups).length > 0 && (
        <div className="card">
          <div className="card-head"><h3 style={{ margin: 0 }}>Where each sound plays</h3></div>
          <div className="row">
            {CHANNELS.map(([c, label]) => (
              <Field key={c} label={label}>
                <select value={s.assign[c] ?? ''} onChange={(e) => update({ ...s, assign: { ...s.assign, [c]: e.target.value || undefined } })}>
                  <option value="">Default output</option>{Object.keys(s.groups).map((g) => <option key={g}>{g}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <p className="tiny muted" style={{ margin: 0 }}>The read-aloud voice with an echo or radio effect always uses the default output.</p>
        </div>
      )}
    </div>
  );
}
