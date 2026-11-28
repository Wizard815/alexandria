// /gm/scenes: make, edit and order the scenes, press one to set the room, and save the room as it is now as a new scene.
// Pickers list what already exists (queued media, library folders, stage cards, sound tracks and ambience scenes, lights
// presets, maps and map pictures); every part is optional and an unticked part is left alone when the scene runs.
import { useState } from 'react';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { PageHead, ErrorBox, Field, Empty } from '../../ui/index.tsx';
import { useMapPictures } from '../screens/fog.tsx';
import { OutcomeView, SceneButtons, SceneIcon } from './ScenePanel.tsx';
import { PART_KEYS, PART_LABEL, partsOf, useScenes, type PartKey, type Scene } from './useScenes.ts';
import './scenes.css';

const ICONS = ['', 'fa-beer-mug-empty', 'fa-khanda', 'fa-skull', 'fa-moon', 'fa-sun', 'fa-ship', 'fa-dungeon', 'fa-campground', 'fa-wand-sparkles', 'fa-crown', 'fa-tree', 'fa-fire'];

interface Draft {
  id: string | null; name: string; icon: string; color: string;
  tvOn: boolean; tvMode: 'off' | 'item' | 'folder' | 'card' | 'state'; tvItem: string; tvFolder: string; tvInterval: string; tvCard: string; tvSpot: boolean; tvState: any;
  soundOn: boolean; music: string; ambience: string; ambLayers: any[]; vol: string; target: 'table' | 'players' | 'both'; stopOthers: boolean;
  lightsMode: '' | 'scene' | 'off'; lightsScene: string;
  tableOn: boolean; mapId: string; pic: string; fogMode: 'keep' | 'now' | 'saved'; savedFog: any;
}

const blank = (): Draft => ({
  id: null, name: '', icon: '', color: '#D9B26A',
  tvOn: false, tvMode: 'off', tvItem: '', tvFolder: '', tvInterval: '', tvCard: '', tvSpot: false, tvState: null,
  soundOn: false, music: '', ambience: '', ambLayers: [], vol: '', target: 'table', stopOthers: false,
  lightsMode: '', lightsScene: '',
  tableOn: false, mapId: 'world', pic: '', fogMode: 'keep', savedFog: null,
});

function draftOf(s: Scene): Draft {
  const d = blank();
  Object.assign(d, { id: s.id, name: s.name, icon: s.icon, color: s.color || '#D9B26A' });
  const { tv, sound, lights, table } = s.parts;
  if (tv) Object.assign(d, { tvOn: true, tvMode: tv.mode, tvItem: tv.itemId ?? '', tvFolder: tv.folder ?? '', tvInterval: tv.intervalSec ? String(tv.intervalSec) : '', tvCard: tv.cardId ?? '', tvSpot: !!tv.spotlight, tvState: tv.state ?? null });
  if (sound) Object.assign(d, { soundOn: true, music: sound.musicTrackId ?? '', ambience: sound.ambience ?? '', ambLayers: sound.ambienceLayers ?? [], vol: sound.volume === undefined ? '' : String(sound.volume), target: sound.target ?? 'table', stopOthers: !!sound.stopOthers });
  if (lights) Object.assign(d, 'off' in lights ? { lightsMode: 'off' } : { lightsMode: 'scene', lightsScene: lights.scene });
  if (table) Object.assign(d, { tableOn: true, mapId: table.mapId ?? 'world', pic: table.pic ?? '', fogMode: table.fog && table.fog !== 'keep' ? 'saved' : 'keep', savedFog: table.fog && table.fog !== 'keep' ? table.fog : null });
  return d;
}

export default function ScenesPage() {
  const { w, info } = useWorld();
  const api = useScenes();
  const [edit, setEdit] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cap, setCap] = useState({ name: '', include: { tv: true, sound: true, lights: true, table: true } as Record<PartKey, boolean> });
  const [notes, setNotes] = useState<string[]>([]);

  const guard = async (fn: () => Promise<void>) => { setErr(null); try { await fn(); await api.reload(); } catch (e: any) { setErr(e.message ?? String(e)); } };
  const move = (i: number, d: -1 | 1) => {
    const ids = api.scenes.map((s) => s.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void guard(() => w.call('PUT', '/scenes/order', { ids }).then(() => undefined));
  };

  async function save(d: Draft) {
    setSaving(true); setErr(null);
    try {
      const parts: Record<string, unknown> = {};
      if (d.tvOn) {
        parts.tv = d.tvMode === 'off' ? { mode: 'off' } : d.tvMode === 'item' ? { mode: 'item', itemId: d.tvItem }
          : d.tvMode === 'folder' ? { mode: 'folder', folder: d.tvFolder, intervalSec: d.tvInterval ? Number(d.tvInterval) : undefined }
            : d.tvMode === 'card' ? { mode: 'card', cardId: d.tvCard, spotlight: d.tvSpot } : { mode: 'state', state: d.tvState };
      }
      if (d.soundOn) {
        parts.sound = {
          musicTrackId: d.music || undefined, ambience: d.ambience || undefined, ambienceLayers: !d.ambience && d.ambLayers.length ? d.ambLayers : undefined,
          volume: d.vol === '' ? undefined : Number(d.vol), target: d.target, stopOthers: d.stopOthers || undefined,
        };
      }
      if (d.lightsMode === 'off') parts.lights = { off: true };
      else if (d.lightsMode === 'scene' && d.lightsScene) parts.lights = { scene: d.lightsScene };
      if (d.tableOn) {
        let fog: unknown = 'keep';
        if (d.fogMode === 'now') {
          const f = await w.call<any>('GET', `/fog/map/${encodeURIComponent(d.mapId)}`, undefined, { pic: d.pic || 'none' });
          fog = { enabled: f.enabled, base: f.base, ops: f.ops };
        } else if (d.fogMode === 'saved' && d.savedFog) fog = d.savedFog;
        parts.table = { mapId: d.mapId, pic: d.pic || undefined, fog };
      }
      const body = { name: d.name, icon: d.icon, color: d.color, parts };
      if (d.id) await w.call('PUT', `/scenes/${d.id}`, body); else await w.call('POST', '/scenes', body);
      setEdit(null);
      await api.reload();
    } catch (e: any) { setErr(e.message ?? String(e)); } finally { setSaving(false); }
  }

  return (
    <div className="page" data-testid="scenes-page">
      <PageHead title="Scenes" lead="One button sets the TV, sound, lights and table map. What a scene leaves unset stays as it is." />
      <ErrorBox error={err ?? api.error ?? api.loadError} />

      <section className="card" aria-labelledby="scn-now">
        <h2 id="scn-now">Press a scene</h2>
        <SceneButtons api={api} />
      </section>

      <section className="card" aria-labelledby="scn-cap">
        <h2 id="scn-cap">Save the current room as a scene</h2>
        <p className="small muted">Takes what is playing, on the TV and lit now, and the table map with its fog, and saves it so one press brings it back.</p>
        <form className="row" style={{ flexWrap: 'wrap', gap: 10 }} onSubmit={(e) => {
          e.preventDefault();
          if (!cap.name.trim()) return;
          void guard(async () => {
            const r = await w.call<any>('POST', '/scenes/capture', { name: cap.name.trim(), include: PART_KEYS.filter((k) => cap.include[k]) });
            setNotes(r.notes ?? []); setCap({ ...cap, name: '' });
          });
        }}>
          <input className="input grow" aria-label="Name for the new scene" data-testid="capture-name" placeholder="Name, e.g. Docks at dusk" value={cap.name} onChange={(e) => setCap({ ...cap, name: e.target.value })} />
          {PART_KEYS.map((k) => (
            <label key={k} className="row small" style={{ gap: 4 }}><input type="checkbox" checked={cap.include[k]} onChange={(e) => setCap({ ...cap, include: { ...cap.include, [k]: e.target.checked } })} /> {PART_LABEL[k]}</label>
          ))}
          <button type="submit" className="btn primary" data-testid="capture-save" disabled={!cap.name.trim()}>Save current room</button>
        </form>
        {notes.length > 0 && <ul className="small muted">{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      </section>

      <section className="card" aria-labelledby="scn-all">
        <div className="card-head"><h2 id="scn-all">Your scenes</h2>
          <button type="button" className="btn small primary" data-testid="scene-new" onClick={() => setEdit(blank())}>New scene</button>
        </div>
        {!api.scenes.length && <Empty>No scenes yet.</Empty>}
        <div className="scn-list">
          {api.scenes.map((s, i) => (
            <div key={s.id} className="scn-row" data-testid="scene-row" style={{ '--scn': s.color || undefined } as React.CSSProperties}>
              <span className="scn-swatch" aria-hidden="true" />
              <strong className="grow"><SceneIcon s={s} /> {s.name}</strong>
              <span className="small muted">{partsOf(s).length ? partsOf(s).map((k) => PART_LABEL[k]).join(', ') : 'sets nothing yet'}</span>
              <button type="button" className="btn small" aria-label={`Activate ${s.name}`} disabled={api.busy} onClick={() => void api.activate(s)}>Activate</button>
              <button type="button" className="btn small" aria-label={`Edit ${s.name}`} onClick={() => setEdit(draftOf(s))}>Edit</button>
              <button type="button" className="btn small ghost" aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" className="btn small ghost" aria-label={`Move ${s.name} down`} disabled={i === api.scenes.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" className="btn small danger" aria-label={`Delete ${s.name}`} onClick={() => { if (confirm(`Delete the scene “${s.name}”?`)) void guard(() => w.call('DELETE', `/scenes/${s.id}`).then(() => undefined)); }}>Delete</button>
            </div>
          ))}
        </div>
      </section>

      {edit && <Editor d={edit} set={setEdit} saving={saving} onSave={() => void save(edit)} onCancel={() => setEdit(null)} world={info.id} />}
      {api.outcome && !edit && <OutcomeView o={api.outcome} onClose={api.clearOutcome} />}
    </div>
  );
}

function Editor({ d, set, saving, onSave, onCancel, world }: { d: Draft; set: (d: Draft) => void; saving: boolean; onSave: () => void; onCancel: () => void; world: string }) {
  const { w } = useWorld();
  const up = (p: Partial<Draft>) => set({ ...d, ...p });
  const media = useLoad<any>(() => w.call('GET', '/screen/media').catch(() => ({ items: [] })), [w], ['screen']);
  const sources = useLoad<any>(() => w.call('GET', '/screen/media/sources').catch(() => ({ folders: [] })), [w]);
  const stage = useLoad<any>(() => w.call('GET', '/stage').catch(() => ({ cards: [] })), [w], ['stage']);
  const lib = useLoad<any>(() => w.call('GET', '/sound/library').catch(() => ({ music: [] })), [w]);
  const ambs = useLoad<any[]>(() => w.call<any[]>('GET', '/sound/scenes').catch(() => []), [w]);
  const lights = useLoad<any[]>(() => w.call<any[]>('GET', '/lights/scenes').catch(() => []), [w]);
  const { options } = useMapPictures();
  let maps: string[] = ['world'];
  try { const m = JSON.parse(localStorage.getItem(`alx.maps.${world}`) ?? 'null'); if (Array.isArray(m) && m.length) maps = m; } catch { /* default */ }
  if (!maps.includes(d.mapId)) maps = [d.mapId, ...maps];
  const cardTitle = (c: any) => c.label || c.data?.title || c.data?.name || c.kind;
  const items: any[] = media.data?.items ?? [];
  const cards: any[] = stage.data?.cards ?? [];
  const tracks: any[] = lib.data?.music ?? [];

  return (
    <section className="card gold scn-edit" aria-label={d.id ? `Edit scene ${d.name}` : 'New scene'} data-testid="scene-editor">
      <h2>{d.id ? 'Edit scene' : 'New scene'}</h2>
      <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
        <Field label="Name"><input className="input" data-testid="scene-name" maxLength={60} value={d.name} onChange={(e) => up({ name: e.target.value })} /></Field>
        <Field label="Icon">
          <select value={ICONS.includes(d.icon) ? d.icon : ''} onChange={(e) => up({ icon: e.target.value })} aria-label="Icon">{ICONS.map((i) => <option key={i} value={i}>{i ? i.replace('fa-', '').replace(/-/g, ' ') : 'No icon'}</option>)}</select>
        </Field>
        <Field label="Colour"><input type="color" value={d.color || '#D9B26A'} onChange={(e) => up({ color: e.target.value })} aria-label="Colour" /></Field>
      </div>

      <div className="scn-part" data-testid="part-tv">
        <header><label className="row" style={{ gap: 6 }}><input type="checkbox" data-testid="part-tv-on" checked={d.tvOn} onChange={(e) => up({ tvOn: e.target.checked })} /> <strong>{PART_LABEL.tv}</strong></label></header>
        {d.tvOn && (
          <>
            <select aria-label="What the TV does" value={d.tvMode} onChange={(e) => up({ tvMode: e.target.value as Draft['tvMode'] })}>
              <option value="off">Turn TV media off</option>
              <option value="item">Show a media item</option>
              <option value="folder">Slideshow of a library folder</option>
              <option value="card">Show a stage card</option>
              {d.tvState && <option value="state">The queue as it was when saved</option>}
            </select>
            {d.tvMode === 'item' && (
              <select aria-label="Media item" value={d.tvItem} onChange={(e) => up({ tvItem: e.target.value })}>
                <option value="">Pick an item from the queue</option>
                {items.map((i) => <option key={i.id} value={i.id}>{i.title || i.kind}</option>)}
              </select>
            )}
            {d.tvMode === 'folder' && (
              <div className="row" style={{ gap: 8 }}>
                <select aria-label="Library folder" value={d.tvFolder} onChange={(e) => up({ tvFolder: e.target.value })}>
                  <option value="">All pictures and videos</option>
                  {(sources.data?.folders ?? []).map((f: any) => <option key={f.folder} value={f.folder}>{f.folder || '(top level)'} · {f.images + f.videos} files</option>)}
                </select>
                <label className="row small" style={{ gap: 4 }}>every <input type="number" min={2} max={3600} style={{ width: 70 }} value={d.tvInterval} placeholder="10" onChange={(e) => up({ tvInterval: e.target.value })} /> s</label>
              </div>
            )}
            {d.tvMode === 'card' && (
              <div className="row" style={{ gap: 8 }}>
                <select aria-label="Stage card" value={d.tvCard} onChange={(e) => up({ tvCard: e.target.value })}>
                  <option value="">Pick a card</option>
                  {cards.map((c) => <option key={c.id} value={c.id}>{cardTitle(c)}</option>)}
                </select>
                <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={d.tvSpot} onChange={(e) => up({ tvSpot: e.target.checked })} /> in the spotlight</label>
              </div>
            )}
          </>
        )}
      </div>

      <div className="scn-part" data-testid="part-sound">
        <header><label className="row" style={{ gap: 6 }}><input type="checkbox" data-testid="part-sound-on" checked={d.soundOn} onChange={(e) => up({ soundOn: e.target.checked })} /> <strong>{PART_LABEL.sound}</strong></label></header>
        {d.soundOn && (
          <>
            <select aria-label="Music track" value={d.music} onChange={(e) => up({ music: e.target.value })}>
              <option value="">No change to the music</option>
              {tracks.map((t) => <option key={t.id} value={t.id}>{[t.area, t.title].filter(Boolean).join(' / ')}</option>)}
            </select>
            <select aria-label="Ambience" value={d.ambience} onChange={(e) => up({ ambience: e.target.value, ambLayers: [] })}>
              <option value="">{d.ambLayers.length ? 'Ambience as saved' : 'No change to the ambience'}</option>
              {(ambs.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <label className="row small" style={{ gap: 6 }}>Volume <input type="range" min={0} max={1} step={0.05} value={d.vol === '' ? 0.7 : Number(d.vol)} onChange={(e) => up({ vol: e.target.value })} aria-label="Volume" /> {d.vol === '' ? 'as is' : Math.round(Number(d.vol) * 100) + '%'}</label>
              {d.vol !== '' && <button type="button" className="btn small ghost" onClick={() => up({ vol: '' })}>Leave volume as set</button>}
              <select aria-label="Who hears it" value={d.target} onChange={(e) => up({ target: e.target.value as Draft['target'] })}>
                <option value="table">The table (GM's device)</option><option value="players">Players' devices</option><option value="both">Both</option>
              </select>
              <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={d.stopOthers} onChange={(e) => up({ stopOthers: e.target.checked })} /> stop whatever else is playing</label>
            </div>
          </>
        )}
      </div>

      <div className="scn-part" data-testid="part-lights">
        <header><strong>{PART_LABEL.lights}</strong></header>
        <select aria-label="Lights" value={d.lightsMode === 'scene' ? d.lightsScene : d.lightsMode} onChange={(e) => (e.target.value === 'off' ? up({ lightsMode: 'off', lightsScene: '' }) : e.target.value === '' ? up({ lightsMode: '', lightsScene: '' }) : up({ lightsMode: 'scene', lightsScene: e.target.value }))}>
          <option value="">Leave the lights alone</option>
          {(lights.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          <option value="off">All lights off</option>
        </select>
      </div>

      <div className="scn-part" data-testid="part-table">
        <header><label className="row" style={{ gap: 6 }}><input type="checkbox" data-testid="part-table-on" checked={d.tableOn} onChange={(e) => up({ tableOn: e.target.checked })} /> <strong>{PART_LABEL.table}</strong></label></header>
        {d.tableOn && (
          <>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <select aria-label="Map" value={d.mapId} onChange={(e) => up({ mapId: e.target.value })}>{maps.map((m) => <option key={m} value={m}>{m}</option>)}</select>
              <select aria-label="Map picture" value={d.pic} onChange={(e) => up({ pic: e.target.value })}>
                <option value="">Keep the current picture</option>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                <option value="none">Blank map</option>
              </select>
            </div>
            <select aria-label="Fog" value={d.fogMode} onChange={(e) => up({ fogMode: e.target.value as Draft['fogMode'] })}>
              <option value="keep">Leave the fog as it is</option>
              <option value="now">Set the fog to what it is right now (saves it)</option>
              {d.savedFog && <option value="saved">Keep the fog state saved earlier</option>}
            </select>
          </>
        )}
      </div>

      <div className="row end">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn primary" data-testid="scene-save" disabled={saving || !d.name.trim()} onClick={onSave}>Save scene</button>
      </div>
    </section>
  );
}
