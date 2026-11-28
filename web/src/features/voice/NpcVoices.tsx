// World settings → Voice → NPC voices: encounter NPCs read aloud on the player's own device (not at the table, and
// not to the rest of the party), each NPC in their own preset or the default one; and the voice for quick events.
import { useState } from 'react';
import { ErrorBox, Field, Switch, useAction } from '../../ui/index.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import type { Preset } from './SpeakOverlay.tsx';

interface NpcVoices { npcVoices: boolean; npcVoicePreset: string; quickEventVoicePreset: string; npcs: { npc: string; presetId: string; preset: string }[] }

export default function NpcVoices({ presets }: { presets: Preset[] }) {
  const { w } = useWorld();
  const act = useAction();
  const cur = useLoad(() => w.call<NpcVoices>('GET', '/voice/npcs'), [w], ['settings']);
  const [npc, setNpc] = useState('');
  const [preset, setPreset] = useState('');
  const v = cur.data;
  const set = (body: Record<string, unknown>) => act.run(async () => { await w.call('PATCH', '/settings', body); await cur.reload(); });
  const give = () => act.run(async () => { await w.call('PUT', '/voice/npcs', { npc, preset }); setNpc(''); await cur.reload(); });
  const pick = (value: string, on: (x: string) => void, none: string) => (
    <select value={value} onChange={(e) => on(e.target.value)}>
      <option value="">{none}</option>
      {presets.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
    </select>
  );
  if (!v) return <ErrorBox error={cur.error} />;
  return (
    <div className="card stack" data-testid="npc-voices">
      <div className="card-head"><h3 style={{ margin: 0 }}>NPC voices</h3></div>
      <p className="small muted" style={{ margin: 0 }}>What an NPC says in an encounter is read aloud on that player’s device only, so the rest of the party does not hear a private talk. Players hear it when their sound effects switch is on.</p>
      <div className="row"><Switch checked={v.npcVoices} onChange={(on) => void set({ npcVoices: on })} label="Read encounter NPCs aloud" /><span>Read encounter NPCs aloud</span></div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Default NPC voice" help="For NPCs without a voice of their own. None: only NPCs given a voice speak.">{pick(v.npcVoicePreset, (x) => void set({ npcVoicePreset: x }), 'None')}</Field>
        <Field label="Quick events" help="Reads a new quick event to the players it went to.">{pick(v.quickEventVoicePreset, (x) => void set({ quickEventVoicePreset: x }), 'Silent')}</Field>
      </div>
      {v.npcs.map((n) => (
        <div key={n.npc} className="row between">
          <span><strong>{n.npc}</strong> <span className="tiny muted">{n.preset}</span></span>
          <button type="button" className="btn small ghost" aria-label={`Take ${n.npc}'s voice away`} disabled={act.busy} onClick={() => void act.run(async () => { await w.call('PUT', '/voice/npcs', { npc: n.npc, preset: '' }); await cur.reload(); })}><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
        </div>
      ))}
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="NPC"><input value={npc} maxLength={80} onChange={(e) => setNpc(e.target.value)} placeholder="Captain Vex" /></Field>
        <Field label="Voice">{pick(preset, setPreset, 'Pick a voice')}</Field>
        <button type="button" className="btn" disabled={act.busy || !npc.trim() || !preset} onClick={() => void give()}>Give a voice</button>
      </div>
      <ErrorBox error={act.error} />
    </div>
  );
}
