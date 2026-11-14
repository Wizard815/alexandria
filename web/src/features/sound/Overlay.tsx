// Sits on every page (no visible UI unless the browser blocked autoplay). It
// follows `sound` events:
//   DM:      plays what is aimed at the table, on the chosen speaker group.
//   players: plays what is aimed at players, on the channels they switched on.
import { useEffect, useRef, useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import { DockButton } from '../../ui/Dock.tsx';
import { Engine, loadSpeakers, type Channel, type SoundEvent } from './engine.ts';
import { getSwitches, loadSwitches } from './switches.ts';

const switchFor = (c: Channel): 'music' | 'ambience' | 'sfx' => (c === 'voice' ? 'sfx' : c);

export default function SoundOverlay() {
  const { w, on, isDM, info } = useWorld();
  const [blocked, setBlocked] = useState(false);
  const eng = useRef<Engine | null>(null);

  useEffect(() => {
    const e = new Engine({
      w,
      master: (c) => (isDM ? 1 : getSwitches().volumes[switchFor(c)] ?? 1),
      sinks: (c) => {
        if (!isDM) return [];
        const s = loadSpeakers();
        const g = s.assign[c];
        return g ? s.groups[g] ?? [] : [];
      },
      onBlocked: () => setBlocked(true),
    });
    eng.current = e;

    const wanted = (ev: SoundEvent) => {
      if (isDM) return loadSpeakers().tableOn && ev.target !== 'players';
      return ev.target !== 'table' && getSwitches()[switchFor(ev.channel)];
    };
    const off = on(['sound'], (m) => { const ev = m.data as SoundEvent; if (wanted(ev)) void e.handle(ev); });

    // Join in with what is already playing.
    const catchUp = async (only?: Channel) => {
      try {
        const now = await w.call('GET', '/sound/now');
        if (now.music && (!only || only === 'music') && wanted(now.music)) void e.handle({ ...now.music, action: 'play', fadeMs: 500 });
        if (now.ambience && (!only || only === 'ambience')) for (const l of now.ambience.layers) {
          const ev: SoundEvent = { channel: 'ambience', action: 'play', url: l.url, volume: l.volume, loop: true, fadeMs: 500, target: now.ambience.target, at: now.ambience.at, layer: l.kind, id: l.id };
          if (wanted(ev)) void e.handle(ev);
        }
      } catch { /* not signed in or offline */ }
    };
    let prev = { ...getSwitches() };
    const unsub = (() => {
      const f = () => {
        const s = getSwitches();
        for (const c of ['music', 'ambience', 'sfx'] as const) {
          if (prev[c] && !s[c]) e.stopChannel(c);
          if (!prev[c] && s[c] && c !== 'sfx') void catchUp(c);
        }
        prev = { ...s };
        e.refresh();
      };
      window.addEventListener('alx-switches', f);
      return () => window.removeEventListener('alx-switches', f);
    })();
    const speakersChanged = () => e.refresh();
    window.addEventListener('alx-speakers', speakersChanged);

    if (!isDM) void loadSwitches(w); // turning a switch on catches up with what is playing
    else void catchUp();
    return () => { off(); unsub(); window.removeEventListener('alx-speakers', speakersChanged); e.stopAll(); };
  }, [w, on, isDM, info.id]);

  if (!blocked) return null;
  return <DockButton order={5} primary icon="fa-volume-high" label="Tap to allow sound" text="Allow sound" onClick={() => { setBlocked(false); eng.current?.refresh(); }} testId="dock-sound" />;
}
