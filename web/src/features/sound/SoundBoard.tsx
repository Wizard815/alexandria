// The DM's sound board: music (folders and the mood map), ambience mixer and
// scenes, effect pads, who is listening, Spotify and speaker groups.
import { useEffect, useRef, useState } from 'react';
import { PageHead, ErrorBox, Empty, Loading, Tabs, Field, useAction, useToast } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { Listeners, SpotifyTab, SpeakersTab } from './SoundMore.tsx';
import type { Target } from './engine.ts';

export interface Track { id: string; path: string; area: string; sub: string; title: string; duration: number | null; mood: { x: number; y: number; src: string } | null }
export interface Library {
  music: Track[]; areas: string[]; ambience: { id: string; layer: string; name: string }[]; layers: string[];
  sfx: { id: string; bank: string; name: string; path: string }[]; banks: string[]; configured: boolean;
}
interface Pad { id: string; label: string; file: string; bank: string; volume: number; loop: boolean; key: string; target: Target }
interface Scene { id: string; name: string; area: string; layers: { kind: string; volume: number }[] }

const TARGETS: [Target, string][] = [['table', 'The table'], ['players', 'Players’ devices'], ['both', 'Both']];
const mmss = (s: number | null) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
const CORNER_LABELS: [string, React.CSSProperties][] = [
  ['Calm', { left: 6, top: 4 }], ['Tense', { right: 6, top: 4 }], ['Sneaky', { left: 6, bottom: 4 }], ['Combat', { right: 6, bottom: 4 }],
];

function TargetPick({ value, onChange }: { value: Target; onChange: (t: Target) => void }) {
  return (
    <Field label="Plays on">
      <select value={value} onChange={(e) => onChange(e.target.value as Target)}>{TARGETS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
    </Field>
  );
}

export default function SoundBoard() {
  const { w, info } = useWorld();
  const [tab, setTab] = useState<'music' | 'ambience' | 'pads' | 'listeners' | 'spotify' | 'speakers'>(() => (new URLSearchParams(window.location.search).has('state') ? 'spotify' : 'music'));
  const lib = useLoad(() => w.call<Library>('GET', '/sound/library'), [w]);
  const L = lib.data;
  return (
    <div className="page">
      <PageHead title="Sound board" lead={`Music, ambience and effects for ${info.name}. Players hear them only if they switch it on.`} />
      <ErrorBox error={lib.error} />
      <Tabs label="Sound sections" value={tab} onChange={setTab} items={[['music', 'Music'], ['ambience', 'Ambience'], ['pads', 'Effects'], ['listeners', 'Listeners'], ['spotify', 'Spotify'], ['speakers', 'Speakers']]} />
      {lib.loading && !L ? <Loading what="the sound library" /> : null}
      {L && !L.configured && <Empty>This gateway has no data folder, so there is no sound library yet.</Empty>}
      {L && tab === 'music' && <MusicTab lib={L} reload={lib.reload} />}
      {L && tab === 'ambience' && <AmbienceTab lib={L} />}
      {L && tab === 'pads' && <PadsTab lib={L} reload={lib.reload} />}
      {tab === 'listeners' && <Listeners />}
      {tab === 'spotify' && <SpotifyTab />}
      {tab === 'speakers' && <SpeakersTab />}
    </div>
  );
}

// ---- music ---------------------------------------------------------------------
function MusicTab({ lib, reload }: { lib: Library; reload: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [area, setArea] = useState('');
  const [target, setTarget] = useState<Target>('table');
  const [volume, setVolume] = useState(0.7);
  const [marker, setMarker] = useState<{ x: number; y: number } | null>(null);
  const [placing, setPlacing] = useState<Track | null>(null);
  const now = useLoad(() => w.call('GET', '/sound/now'), [w], ['sound']);
  const map = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const last = useRef(0);

  const tracks = lib.music.filter((t) => !area || t.area === area);
  const groups = new Map<string, Track[]>();
  for (const t of tracks) { const k = area ? t.sub || '(top level)' : t.area || '(top level)'; groups.set(k, [...(groups.get(k) ?? []), t]); }
  const playing = now.data?.music;

  const pick = (e: React.PointerEvent) => {
    const r = map.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const send = (p: { x: number; y: number }) => act.run(async () => {
    const r = await w.call('POST', '/sound/music/mood', { ...p, area: area || undefined, target, volume });
    if (!r.track) toast(r.note ?? 'No track near that spot');
  });
  const down = (e: React.PointerEvent) => {
    const p = pick(e);
    if (placing) {
      void act.run(async () => { await w.call('PUT', `/sound/tracks/${placing.id}/mood`, p); toast(`Placed “${placing.title}”`); setPlacing(null); reload(); });
      return;
    }
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setMarker(p);
    last.current = Date.now();
    void send(p);
  };
  const move = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const p = pick(e);
    setMarker(p);
    if (Date.now() - last.current > 900) { last.current = Date.now(); void send(p); }
  };
  const up = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    void send(pick(e));
  };

  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Mood map</h3>
          <span className="tiny muted">{placing ? `Click the map to place “${placing.title}”` : 'Click or drag. The nearest track plays and fades in.'}</span></div>
        <div ref={map} className="mood-map" onPointerDown={down} onPointerMove={move} onPointerUp={up} role="application" aria-label="Mood map: Calm top left, Tense top right, Sneaky bottom left, Combat bottom right"
          style={{ position: 'relative', width: '100%', maxWidth: 420, aspectRatio: '1', border: '1px solid var(--line-strong)', borderRadius: 10, touchAction: 'none', cursor: 'crosshair', background: 'linear-gradient(135deg, var(--panel), var(--accent-bg))', userSelect: 'none' }}>
          {CORNER_LABELS.map(([t, st]) => <span key={t} className="tiny faint" style={{ position: 'absolute', ...st }}>{t}</span>)}
          {tracks.filter((t) => t.mood).map((t) => (
            <span key={t.id} title={`${t.title} (${t.mood!.src})`} style={{ position: 'absolute', left: `${t.mood!.x * 100}%`, top: `${t.mood!.y * 100}%`, width: 9, height: 9, margin: -4.5, borderRadius: '50%', background: playing?.id === t.id ? 'var(--accent)' : 'var(--faint)', outline: playing?.id === t.id ? '2px solid var(--accent)' : 'none' }} />
          ))}
          {marker && <span style={{ position: 'absolute', left: `${marker.x * 100}%`, top: `${marker.y * 100}%`, width: 20, height: 20, margin: -10, borderRadius: '50%', border: '2px solid var(--accent-strong)', pointerEvents: 'none' }} />}
        </div>
        <div className="row">
          <TargetPick value={target} onChange={setTarget} />
          <Field label={`Volume ${Math.round(volume * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} /></Field>
        </div>
        <div className="row">
          <span className="small">{playing ? <>Now playing: <strong>{playing.title}</strong></> : <span className="muted">Nothing playing.</span>}</span>
          <button type="button" className="btn small" disabled={act.busy || !playing} onClick={() => void act.run(() => w.call('POST', '/sound/music/stop', {}))}>Stop</button>
          <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(async () => { const r = await w.call('POST', '/sound/rescan'); toast(`${r.music} tracks, ${r.ambience} ambience, ${r.sfx} effects`); reload(); })}>Rescan folders</button>
        </div>
        <ErrorBox error={act.error} />
        {toastNode}
      </div>

      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Folders</h3></div>
        <div className="row" role="group" aria-label="Area">
          <button type="button" className={`btn small${area === '' ? ' on' : ''}`} onClick={() => setArea('')}>All</button>
          {lib.areas.map((a) => <button key={a} type="button" className={`btn small${area === a ? ' on' : ''}`} onClick={() => setArea(a)}>{a}</button>)}
        </div>
        {tracks.length === 0 && <Empty>No music yet. Put audio files in the gateway’s <code>music/&lt;area&gt;/</code> folders and press Rescan. Folders named combat, tense, sneaky or calm place tracks on the map.</Empty>}
        <div className="stack" style={{ maxHeight: 420, overflow: 'auto' }}>
          {[...groups].map(([g, ts]) => (
            <div key={g} className="stack tight">
              <span className="tiny faint">{g}</span>
              {ts.map((t) => (
                <div key={t.id} className="row between" style={{ flexWrap: 'nowrap' }}>
                  <button type="button" className={`btn small${playing?.id === t.id ? ' on' : ''}`} style={{ whiteSpace: 'normal', textAlign: 'left', flex: 1, justifyContent: 'flex-start' }} disabled={act.busy}
                    onClick={() => void act.run(() => w.call('POST', '/sound/music/play', { trackId: t.id, target, volume }))}>
                    <i className="fa-solid fa-play" aria-hidden="true" /> {t.title} <span className="tiny faint">{mmss(t.duration)}</span>
                  </button>
                  <button type="button" className={`btn small ghost${placing?.id === t.id ? ' on' : ''}`} title={t.mood ? `On the map (${t.mood.src}). Move it.` : 'Not on the map yet. Place it.'} aria-label={`Place ${t.title} on the map`}
                    onClick={() => setPlacing(placing?.id === t.id ? null : t)}><i className="fa-solid fa-location-crosshairs" aria-hidden="true" /></button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- ambience ------------------------------------------------------------------
function AmbienceTab({ lib }: { lib: Library }) {
  const { w } = useWorld();
  const act = useAction();
  const [target, setTarget] = useState<Target>('table');
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const scenes = useLoad(() => w.call<Scene[]>('GET', '/sound/scenes'), [w]);
  const now = useLoad(() => w.call('GET', '/sound/now'), [w], ['sound']);
  const seeded = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    if (seeded.current || !now.data) return;
    seeded.current = true;
    setLevels(Object.fromEntries((now.data.ambience?.layers ?? []).map((l: any) => [l.kind, l.volume])));
  }, [now.data]);

  // Apply the mix a moment after the last slider move.
  useEffect(() => {
    if (!dirty.current) return;
    const t = setTimeout(() => { dirty.current = false; void act.run(() => w.call('POST', '/sound/ambience/scene', { layers: mix(), target })); }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levels, target]);
  const mix = () => Object.entries(levels).filter(([, v]) => v > 0).map(([kind, volume]) => ({ kind, volume }));
  const set = (k: string, v: number) => { dirty.current = true; setLevels((l) => ({ ...l, [k]: v })); };

  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Mixer</h3><TargetPick value={target} onChange={setTarget} /></div>
        {lib.layers.length === 0 && <Empty>No ambience yet. Put loops in <code>ambience/rain/</code>, <code>ambience/tavern/</code> and so on, or upload one on the Effects tab.</Empty>}
        {lib.layers.map((k) => (
          <label key={k} className="row" style={{ flexWrap: 'nowrap' }}>
            <span style={{ width: 90, textTransform: 'capitalize' }}>{k}</span>
            <input type="range" min={0} max={1} step={0.05} value={levels[k] ?? 0} onChange={(e) => set(k, Number(e.target.value))} style={{ flex: 1 }} aria-label={`${k} volume`} />
            <span className="tiny muted" style={{ width: 36, textAlign: 'right' }}>{Math.round((levels[k] ?? 0) * 100)}%</span>
          </label>
        ))}
        <div className="row"><button type="button" className="btn small" disabled={act.busy} onClick={() => { setLevels({}); void act.run(() => w.call('POST', '/sound/ambience/stop', { target })); }}>Stop all</button></div>
        <ErrorBox error={act.error} />
      </div>
      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Scenes</h3></div>
        {(scenes.data ?? []).length === 0 && <p className="muted small">No scenes yet. Set a mix, name it and save it.</p>}
        {(scenes.data ?? []).map((s) => (
          <div key={s.id} className="row between">
            <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(async () => { const r = await w.call('POST', `/sound/scenes/${s.id}/play`, { target }); setLevels(Object.fromEntries(r.layers.map((l: any) => [l.kind, l.volume]))); dirty.current = false; })}>
              <i className="fa-solid fa-play" aria-hidden="true" /> {s.name}</button>
            <span className="tiny faint">{s.area}{s.area && ' · '}{s.layers.map((l) => `${l.kind} ${Math.round(l.volume * 100)}%`).join(', ')}</span>
            <button type="button" className="btn small ghost" aria-label={`Delete ${s.name}`} onClick={() => void act.run(async () => { await w.call('DELETE', `/sound/scenes/${s.id}`); await scenes.reload(); })}><i className="fa-solid fa-trash" aria-hidden="true" /></button>
          </div>
        ))}
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Save this mix as"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Stormy night at the tavern" /></Field>
          <Field label="Area (optional)"><select value={area} onChange={(e) => setArea(e.target.value)}><option value="">Any</option>{lib.music.map((t) => t.area).filter((a, i, all) => a && all.indexOf(a) === i).map((a) => <option key={a}>{a}</option>)}</select></Field>
          <button type="button" className="btn primary" disabled={act.busy || !name.trim() || mix().length === 0} onClick={() => void act.run(async () => { await w.call('POST', '/sound/scenes', { name, area, layers: mix() }); setName(''); await scenes.reload(); })}>Save scene</button>
        </div>
      </div>
    </div>
  );
}

// ---- effect pads ----------------------------------------------------------------
function PadsTab({ lib, reload }: { lib: Library; reload: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const pads = useLoad(() => w.call<Pad[]>('GET', '/sound/pads'), [w]);
  const [form, setForm] = useState({ file: '', label: '', key: '', volume: 0.8, loop: false, target: 'table' as Target });
  const [up, setUp] = useState({ kind: 'sfx', bank: '' });
  const fileRef = useRef<HTMLInputElement>(null);
  const list = pads.data ?? [];

  const fire = (p: Pad) => void act.run(() => w.call('POST', '/sound/sfx/play', { padId: p.id }));
  // Keys work while this page is open and you are not typing in a field.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
      const p = list.find((x) => x.key && x.key.toLowerCase() === e.key.toLowerCase());
      if (p) { e.preventDefault(); fire(p); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  const upload = () => {
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    void act.run(async () => {
      const c = w.client;
      const q = new URLSearchParams({ kind: up.kind, name: f.name, ...(up.bank ? { bank: up.bank } : {}) });
      const r = await fetch(`${c.baseUrl}${w.path('/sound/upload')}?${q}`, { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/octet-stream' }, body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Upload failed (${r.status})`);
      toast('Uploaded');
      if (fileRef.current) fileRef.current.value = '';
      reload();
    });
  };

  return (
    <div className="stack loose">
      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Pads</h3><span className="tiny muted">Press a pad, or its key while this page is open.</span></div>
        {list.length === 0 ? <Empty>No pads yet. Add one below.</Empty> : (
          <div className="grid small">
            {list.map((p) => (
              <div key={p.id} className="stack tight">
                <button type="button" className="btn" style={{ minHeight: 56, whiteSpace: 'normal' }} disabled={act.busy} onClick={() => fire(p)}>
                  {p.label}{p.key && <span className="chip" style={{ marginLeft: 6 }}>{p.key}</span>}
                </button>
                <span className="tiny faint">{p.bank} · {p.loop ? 'loop · ' : ''}{p.target}
                  <button type="button" className="btn small ghost" aria-label={`Delete ${p.label}`} onClick={() => void act.run(async () => { await w.call('DELETE', `/sound/pads/${p.id}`); await pads.reload(); })}><i className="fa-solid fa-trash" aria-hidden="true" /></button>
                  {p.loop && <button type="button" className="btn small ghost" onClick={() => void act.run(() => w.call('POST', '/sound/sfx/stop', { id: p.file, target: p.target }))}>stop</button>}
                </span>
              </div>
            ))}
          </div>
        )}
        <ErrorBox error={act.error} />
        {toastNode}
      </div>
      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Add a pad</h3></div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Sound"><select value={form.file} onChange={(e) => { const f = lib.sfx.find((s) => s.id === e.target.value); setForm({ ...form, file: e.target.value, label: form.label || f?.name || '' }); }}>
            <option value="">Choose…</option>{lib.sfx.map((s) => <option key={s.id} value={s.id}>{s.bank} / {s.name}</option>)}</select></Field>
          <Field label="Label"><input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
          <Field label="Key"><input value={form.key} maxLength={1} style={{ width: 60 }} onChange={(e) => setForm({ ...form, key: e.target.value })} /></Field>
          <Field label={`Volume ${Math.round(form.volume * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={form.volume} onChange={(e) => setForm({ ...form, volume: Number(e.target.value) })} /></Field>
          <label className="row small"><input type="checkbox" checked={form.loop} onChange={(e) => setForm({ ...form, loop: e.target.checked })} /> Loop</label>
          <TargetPick value={form.target} onChange={(t) => setForm({ ...form, target: t })} />
          <button type="button" className="btn primary" disabled={act.busy || !form.file} onClick={() => void act.run(async () => { await w.call('POST', '/sound/pads', form); setForm({ ...form, file: '', label: '', key: '' }); await pads.reload(); })}>Add pad</button>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Upload a sound</h3><span className="tiny muted">mp3, ogg, wav, flac or m4a. Effects up to 10 MB, ambience up to 25 MB.</span></div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="What is it"><select value={up.kind} onChange={(e) => setUp({ ...up, kind: e.target.value })}><option value="sfx">Sound effect</option><option value="ambience">Ambience loop</option></select></Field>
          <Field label={up.kind === 'sfx' ? 'Bank (folder)' : 'Kind (rain, cave…)'}><input value={up.bank} onChange={(e) => setUp({ ...up, bank: e.target.value })} placeholder={up.kind === 'sfx' ? 'doors' : 'rain'} /></Field>
          <Field label="File"><input ref={fileRef} type="file" accept="audio/*" /></Field>
          <button type="button" className="btn" disabled={act.busy} onClick={upload}>Upload</button>
        </div>
      </div>
    </div>
  );
}
