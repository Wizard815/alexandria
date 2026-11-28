// A small bar of pinned macros in the dock, and the key bindings: while the
// tab is focused, a bound key runs its macro. (The installed app will read
// the same bindings with scope=app for global hotkeys.)
import { useEffect, useRef, useState } from 'react';
import { DockButton } from '../../ui/Dock.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { captureState, comboFromEvent } from './keys.ts';

interface MacroLite { id: string; name: string; pinned: boolean }
interface Binding { id: string; combo: string; macroId: string; macroName: string; scope: string }

export default function MacroBar() {
  const { w, info } = useWorld();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const macros = useLoad(() => w.call<MacroLite[]>('GET', '/actions/macros').catch(() => []), [w], ['macros']);
  const binds = useLoad(() => w.call<{ bindings: Binding[] }>('GET', '/actions/bindings?scope=web').catch(() => ({ bindings: [] })), [w], ['bindings']);
  const bindRef = useRef<Binding[]>([]);
  bindRef.current = binds.data?.bindings ?? [];
  const role = info?.role;

  const run = async (id: string, name: string) => {
    try {
      const r = await w.call<any>('POST', `/actions/macros/${encodeURIComponent(id)}/run`, {});
      setNote(r.ok ? `${name}: done` : `${name}: ${r.steps.find((s: any) => s.status === 'failed')?.error ?? 'a step failed'}`);
    } catch (e: any) { setNote(`${name}: ${e.message ?? e}`); }
    setTimeout(() => setNote(null), 3500);
  };
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (captureState.on || e.repeat) return;
      const combo = comboFromEvent(e);
      if (!combo) return;
      const b = bindRef.current.find((x) => x.combo === combo);
      if (!b) return;
      e.preventDefault();
      void runRef.current(b.macroId, b.macroName);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (role !== 'gm') return note ? <div className="toast" role="status">{note}</div> : null;
  const pinned = (macros.data ?? []).filter((m) => m.pinned);
  return (
    <>
      {pinned.length > 0 && <DockButton order={30} icon="fa-bolt" label="Macros" active={open} onClick={() => setOpen(!open)} testId="macro-bar-toggle" />}
      {open && pinned.length > 0 && (
        <div className="dock-panel card" role="group" aria-label="Pinned macros" style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 260 }}>
          {pinned.map((m) => <button key={m.id} type="button" className="btn small" onClick={() => void run(m.id, m.name)}>{m.name}</button>)}
        </div>
      )}
      {note && <div className="toast" role="status">{note}</div>}
    </>
  );
}
