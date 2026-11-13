// The player's own sound settings: three switches (all start off) and a
// volume for each. Per device; the DM can see who has what on.
import { useEffect } from 'react';
import { Switch } from '../../ui/index.tsx';
import { useWorld } from '../../lib/world.tsx';
import { loadSwitches, updateSwitches, useSwitches } from './switches.ts';

const ROWS: ['music' | 'ambience' | 'sfx', string, string][] = [
  ['music', 'Play the DM’s music', 'Music the DM sends to players’ devices.'],
  ['ambience', 'Play the DM’s ambience', 'Rain, a crowded tavern, a crackling hearth.'],
  ['sfx', 'Play the DM’s sound effects and voices', 'Thunder, doors, and lines the DM reads aloud.'],
];

export default function SoundCard() {
  const { w } = useWorld();
  const s = useSwitches();
  useEffect(() => { if (!s.loaded) void loadSwitches(w); }, [w, s.loaded]);
  return (
    <section className="card" aria-labelledby="sound-card-h">
      <div className="card-head"><h3 id="sound-card-h" style={{ margin: 0 }}><i className="fa-solid fa-volume-high" aria-hidden="true" /> Sound</h3></div>
      <p className="tiny muted" style={{ margin: 0 }}>All off by default, and only for this device. At the table you probably want them off and to hear the room speakers.</p>
      {ROWS.map(([k, label, help]) => (
        <div key={k} className="stack tight">
          <div className="row between">
            <span><strong>{label}</strong><br /><span className="tiny muted">{help}</span></span>
            <Switch checked={s[k]} onChange={(v) => void updateSwitches(w, { [k]: v })} label={label} />
          </div>
          {s[k] && (
            <label className="row tiny muted" style={{ flexWrap: 'nowrap' }}>Volume
              <input type="range" min={0} max={1} step={0.05} value={s.volumes[k]} aria-label={`${label} volume`}
                onChange={(e) => void updateSwitches(w, { volumes: { [k]: Number(e.target.value) } })} style={{ flex: 1 }} />
            </label>
          )}
        </div>
      ))}
    </section>
  );
}
