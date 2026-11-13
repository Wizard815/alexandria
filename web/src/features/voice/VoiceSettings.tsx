// World settings → Voice: presets for reading text aloud.
import { useState } from 'react';
import { ErrorBox, Empty, Field, useAction, useToast } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import type { Preset } from './SpeakOverlay.tsx';

const EFFECTS: [string, string][] = [['none', 'None'], ['echo', 'Echo'], ['radio', 'Radio']];
const TARGETS: [string, string][] = [['table', 'The table'], ['players', 'Players’ devices'], ['both', 'Both']];
const STARTERS = [
  { name: 'Narrator', voice: 'bm_george', speed: 0.95, pitch: 1, effect: 'none', target: 'both' },
  { name: 'Old man', voice: 'bm_lewis', speed: 0.85, pitch: 0.92, effect: 'none', target: 'table' },
  { name: 'Villain', voice: 'am_michael', speed: 0.9, pitch: 0.85, effect: 'echo', target: 'table' },
];
const blank = { name: '', voice: '', speed: 1, pitch: 1, effect: 'none', target: 'table' };

export default function VoiceSettings() {
  const { w } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const list = useLoad(() => w.call<Preset[]>('GET', '/voice/presets'), [w]);
  const [edit, setEdit] = useState<(typeof blank & { id?: string }) | null>(null);
  const presets = list.data ?? [];

  const save = () => edit && act.run(async () => {
    const { id, ...body } = edit;
    if (id) await w.call('PUT', `/voice/presets/${id}`, body); else await w.call('POST', '/voice/presets', body);
    setEdit(null);
    await list.reload();
    toast('Saved');
  });
  const test = (p: Preset) => act.run(async () => { await w.call('POST', '/voice/speak', { text: `This is ${p.name}, speaking.`, presetId: p.id }); });

  return (
    <div className="stack loose">
      <p className="small muted" style={{ margin: 0 }}>Select text on any DM page, right-click and choose Speak. A voice preset decides who reads it, how fast, with what effect, and where it plays.
        Speech comes from the voice model set up in Admin → Models (for example Kokoro).</p>
      <ErrorBox error={list.error || act.error} />
      {presets.length === 0 && !edit && (
        <Empty>No voices yet. <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(async () => { for (const s of STARTERS) await w.call('POST', '/voice/presets', s); await list.reload(); })}>Add starter voices</button></Empty>
      )}
      {presets.map((p) => (
        <div key={p.id} className="card">
          <div className="row between">
            <span><strong>{p.name}</strong> <span className="tiny muted">{p.voice || 'default voice'} · speed {p.speed} · pitch {p.pitch} · {p.effect} · {TARGETS.find((t) => t[0] === p.target)?.[1]}</span></span>
            <span className="row">
              <button type="button" className="btn small" disabled={act.busy} onClick={() => void test(p)}><i className="fa-solid fa-play" aria-hidden="true" /> Test</button>
              <button type="button" className="btn small" onClick={() => setEdit(p)}>Edit</button>
              <button type="button" className="btn small ghost" aria-label={`Delete ${p.name}`} onClick={() => void act.run(async () => { await w.call('DELETE', `/voice/presets/${p.id}`); await list.reload(); })}><i className="fa-solid fa-trash" aria-hidden="true" /></button>
            </span>
          </div>
        </div>
      ))}
      {edit ? (
        <div className="card">
          <div className="card-head"><h3 style={{ margin: 0 }}>{edit.id ? 'Edit voice' : 'New voice'}</h3></div>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label="Name"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Old man" /></Field>
            <Field label="Voice" help="The voice name the model knows, e.g. af_heart. Empty uses the model’s default."><input value={edit.voice} onChange={(e) => setEdit({ ...edit, voice: e.target.value })} /></Field>
          </div>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label={`Speed ${edit.speed}`}><input type="range" min={0.5} max={2} step={0.05} value={edit.speed} onChange={(e) => setEdit({ ...edit, speed: Number(e.target.value) })} /></Field>
            <Field label={`Pitch ${edit.pitch}`} help="Done in the listener’s browser by changing the playback rate, so it also changes speed a little."><input type="range" min={0.5} max={1.5} step={0.05} value={edit.pitch} onChange={(e) => setEdit({ ...edit, pitch: Number(e.target.value) })} /></Field>
            <Field label="Effect"><select value={edit.effect} onChange={(e) => setEdit({ ...edit, effect: e.target.value })}>{EFFECTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Plays on"><select value={edit.target} onChange={(e) => setEdit({ ...edit, target: e.target.value })}>{TARGETS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          </div>
          <div className="row"><button type="button" className="btn primary" disabled={act.busy || !edit.name.trim()} onClick={() => void save()}>Save</button><button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button></div>
        </div>
      ) : <div><button type="button" className="btn" onClick={() => setEdit({ ...blank })}>New voice</button></div>}
      {toastNode}
    </div>
  );
}
