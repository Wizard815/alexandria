// /w/:world/screen/side: the DM's tall second monitor. A stack of the panels the DM picks, in the order the DM picks, each
// folding away and resizable in height. Built for a portrait 1080x1920 screen but it is only a column, so it works anywhere.
// The choice is remembered per browser.
import { useEffect, useRef, useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import { PANELS, panelById } from './panels.tsx';
import { popOutPanel } from './names.ts';
import { loadSide, saveSide, type SidePanel } from './prefs.ts';
import './screens.css';

const DEFAULT: SidePanel[] = [
  { id: 'assistant', folded: false, h: 560 },
  { id: 'transcript', folded: false, h: 380 },
  { id: 'combat', folded: false, h: 520 },
  { id: 'approvals', folded: false, h: 320 },
];
const MIN_H = 120, MAX_H = 2600;
const clamp = (h: number) => Math.max(MIN_H, Math.min(MAX_H, Math.round(h)));

export default function SideScreen() {
  const { isDM, info } = useWorld();
  const [stack, setStack] = useState<SidePanel[]>(() => loadSide(DEFAULT).filter((p) => panelById(p.id)));
  const [picking, setPicking] = useState(false);
  useEffect(() => { document.title = `Side screen · ${info?.name ?? 'Alexandria'}`; }, [info?.name]);
  const change = (next: SidePanel[]) => { setStack(next); saveSide(next); };
  const patch = (id: string, p: Partial<SidePanel>) => change(stack.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= stack.length) return;
    const n = [...stack];
    [n[i], n[j]] = [n[j], n[i]];
    change(n);
  };

  if (!isDM) return <div className="t-fantasy"><div className="page"><p className="muted">The side screen is for the DM.</p></div></div>;
  const spare = PANELS.filter((p) => !stack.some((s) => s.id === p.id));
  return (
    <div className="t-fantasy sc-side" data-testid="side-screen">
      <header className="sc-bar">
        <strong style={{ flex: 1 }}>{info.name} · side screen</strong>
        <button type="button" className={`btn small${picking ? ' on' : ''}`} aria-expanded={picking} data-testid="side-choose" onClick={() => setPicking((v) => !v)}><i className="fa-solid fa-table-list" aria-hidden="true" /> Panels</button>
        <button type="button" className="btn small ghost" aria-label="Full screen" title="Full screen (F11)" onClick={() => { void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()); }}><i className="fa-solid fa-expand" aria-hidden="true" /></button>
      </header>
      {picking && (
        <section className="sc-pick card" aria-label="Choose panels">
          <p className="small muted">Add a panel to the stack, or take one away. Move them with the arrows on each panel.</p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {PANELS.map((p) => {
              const on = stack.some((s) => s.id === p.id);
              return (
                <button key={p.id} type="button" className={`btn${on ? ' on' : ''}`} aria-pressed={on} data-testid={`side-toggle-${p.id}`}
                  onClick={() => change(on ? stack.filter((s) => s.id !== p.id) : [...stack, { id: p.id, folded: false, h: p.page ? 520 : 420 }])}>
                  <i className={`fa-solid ${p.icon}`} aria-hidden="true" /> {p.title}
                </button>
              );
            })}
          </div>
          {!spare.length && <p className="tiny faint">Every panel is already on the stack.</p>}
        </section>
      )}
      {!stack.length && <p className="muted" style={{ padding: 16 }}>Nothing on this screen yet. Press Panels to choose what lives here.</p>}
      {stack.map((s, i) => {
        const def = panelById(s.id)!;
        return (
          <section key={s.id} className="sc-panel" data-testid={`side-panel-${s.id}`} aria-label={def.title}>
            <header className="sc-phead">
              <button type="button" className="sc-fold" aria-expanded={!s.folded} aria-label={`${s.folded ? 'Unfold' : 'Fold'} ${def.title}`} onClick={() => patch(s.id, { folded: !s.folded })}>
                <i className={`fa-solid fa-chevron-${s.folded ? 'right' : 'down'}`} aria-hidden="true" />
              </button>
              <i className={`fa-solid ${def.icon}`} aria-hidden="true" /><strong style={{ flex: 1 }}>{def.title}</strong>
              <button type="button" className="btn small ghost" aria-label={`Move ${def.title} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" className="btn small ghost" aria-label={`Move ${def.title} down`} disabled={i === stack.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" className="btn small ghost" aria-label={`Pop ${def.title} out into its own window`} onClick={() => void popOutPanel(info.slug, s.id)}>↗</button>
              <button type="button" className="btn small ghost" aria-label={`Remove ${def.title} from this screen`} onClick={() => change(stack.filter((x) => x.id !== s.id))}>✕</button>
            </header>
            <div className={`sc-pbody${def.page ? ' sc-scroll' : ''}`} style={{ height: s.h, display: s.folded ? 'none' : undefined }}>{def.render()}</div>
            {!s.folded && <Grip h={s.h} onChange={(h) => patch(s.id, { h: clamp(h) })} label={def.title} />}
          </section>
        );
      })}
    </div>
  );
}

/** The bar under a panel: drag it, or use the arrow keys, to change the panel's height. */
function Grip({ h, onChange, label }: { h: number; onChange: (h: number) => void; label: string }) {
  const start = useRef<{ y: number; h: number } | null>(null);
  const [live, setLive] = useState<number | null>(null);
  return (
    <div className="sc-grip" role="separator" aria-orientation="horizontal" aria-label={`Resize ${label}`} aria-valuenow={h} aria-valuemin={MIN_H} aria-valuemax={MAX_H} tabIndex={0}
      onPointerDown={(e) => { start.current = { y: e.clientY, h }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const nh = clamp(start.current.h + e.clientY - start.current.y);
        setLive(nh);
        // The panel follows the pointer; the choice is saved once, on release.
        (e.currentTarget.previousElementSibling as HTMLElement | null)?.style.setProperty('height', `${nh}px`);
      }}
      onPointerUp={() => { if (start.current && live !== null) onChange(live); start.current = null; setLive(null); }}
      onPointerCancel={() => { start.current = null; setLive(null); }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 200 : 40;
        if (e.key === 'ArrowDown') { e.preventDefault(); onChange(h + step); } else if (e.key === 'ArrowUp') { e.preventDefault(); onChange(h - step); }
      }}>
      <span aria-hidden="true" />
    </div>
  );
}
