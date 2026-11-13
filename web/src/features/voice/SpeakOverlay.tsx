// Select text anywhere in the DM's pages, right-click, and pick a voice. With
// nothing selected the browser's own menu stays. The line is read by the
// "voice" model and played through the sound board's live event.
import { useEffect, useRef, useState } from 'react';
import { useWorld } from '../../lib/world.tsx';

export interface Preset { id: string; name: string; voice: string; speed: number; pitch: number; effect: string; target: 'table' | 'players' | 'both' }
const WHERE = { table: 'table', players: 'players', both: 'table + players' };

export default function SpeakOverlay() {
  const { isDM } = useWorld();
  return isDM ? <SpeakMenu /> : null;
}

function SpeakMenu() {
  const { w } = useWorld();
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const text = (window.getSelection()?.toString() ?? '').trim();
      if (!text || (e.target as HTMLElement | null)?.closest?.('[data-no-speak]')) return; // keep the native menu
      e.preventDefault();
      setMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 220), text: text.slice(0, 2000) });
      w.call<Preset[]>('GET', '/voice/presets').then(setPresets).catch(() => setPresets([]));
    };
    const close = (e: Event) => { if (!box.current?.contains(e.target as Node)) setMenu(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('contextmenu', onMenu);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', () => setMenu(null), true);
    return () => { document.removeEventListener('contextmenu', onMenu); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [w]);

  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 4500); return () => clearTimeout(t); }, [note]);

  const speak = async (p: Preset, text: string) => {
    setMenu(null);
    setNote({ text: `Reading with “${p.name}”…` });
    try {
      try {
        await w.call('POST', '/voice/speak', { text, presetId: p.id });
      } catch (e: any) {
        // 409: the words come from DM-only notes and are going to players.
        if (e?.status !== 409) throw e;
        if (!window.confirm('This text comes from your DM-only notes, and this voice plays on players’ devices. Send it to players anyway?')) { setNote(null); return; }
        await w.call('POST', '/voice/speak', { text, presetId: p.id, confirm: true });
      }
      setNote({ text: 'Playing' });
    } catch (e: any) {
      setNote({ text: e.message ?? 'Could not read that aloud', bad: true });
    }
  };

  return (
    <>
      {menu && (
        <div ref={box} role="menu" aria-label="Speak" className="card" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 60, width: 220, padding: 8, gap: 2, boxShadow: '0 6px 24px rgba(0,0,0,.35)' }}>
          <span className="tiny faint" style={{ padding: '2px 8px' }}><i className="fa-solid fa-microphone-lines" aria-hidden="true" /> Speak</span>
          {presets === null && <span className="tiny muted" style={{ padding: '4px 8px' }}>Loading…</span>}
          {presets?.length === 0 && <span className="tiny muted" style={{ padding: '4px 8px' }}>No voices yet. Add one in World settings → Voice.</span>}
          {presets?.map((p) => (
            <button key={p.id} type="button" role="menuitem" className="btn small ghost" style={{ justifyContent: 'space-between' }} onClick={() => void speak(p, menu.text)}>
              <span>{p.name}</span><span className="tiny faint">{WHERE[p.target]}</span>
            </button>
          ))}
        </div>
      )}
      {note && <div className="toast" role="status" style={note.bad ? { borderColor: 'var(--danger)' } : undefined}>{note.text}</div>}
    </>
  );
}
