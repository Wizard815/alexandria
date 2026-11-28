// Drawing pieces for the map: the SVG route layer and the mark buttons.
import { useRef, useState, type CSSProperties, type PointerEvent } from 'react';

export interface Pt { x: number; y: number }
export interface Mark {
  id: string; map_id: string; author_id: string; kind: 'pin' | 'note' | 'route' | 'stop' | 'icon';
  data: {
    x?: number; y?: number; label?: string; text?: string; icon?: string; plan?: string; n?: number; points?: Pt[]; arrow?: boolean; color?: string | null;
    /** A token from a linked Foundry scene (features/foundry): size is its width as a fraction of the map's; disposition 1 friendly, 0 neutral, -1 hostile. */
    token?: { scene: string; id: string; actor: string | null; account: string | null; size: number; disposition: number; player: boolean };
  };
  visibility: 'party' | 'me' | 'gm'; hidden_by_gm: boolean; created_at: string;
}

export const ICONS: [string, string, string][] = [
  ['camp', '⛺', 'Camp'], ['fight', '⚔', 'Fight'], ['danger', '⚠', 'Danger'], ['skull', '☠', 'Skull'], ['anchor', '⚓', 'Anchor'],
  ['question', '?', 'Question'], ['rest', '♨', 'Rest'], ['treasure', '◆', 'Treasure'], ['door', '⌂', 'Door'], ['eye', '◉', 'Eye'],
];

const colorFor = (m: Mark) => (m.visibility === 'me' ? '#E3A0D0' : m.visibility === 'gm' ? '#F0A096' : '#86CFC4');

export function RouteLayer({ marks, draft, selected, onPick }: { marks: Mark[]; draft: Pt[]; selected: string | null; onPick: (m: Mark) => void }) {
  const routes = marks.filter((m) => m.kind === 'route' && m.data.points && m.data.points.length > 1);
  const pts = (p: Pt[]) => p.map((q) => `${q.x},${q.y}`).join(' ');
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
      <defs>
        {['#86CFC4', '#E3A0D0', '#F0A096', '#D9B26A'].map((c) => (
          <marker key={c} id={`arrow-${c.slice(1)}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={c} />
          </marker>
        ))}
      </defs>
      {routes.map((m) => {
        const c = m.data.color || colorFor(m);
        return (
          <g key={m.id} data-mark={m.id} onClick={(e) => { e.stopPropagation(); onPick(m); }} style={{ cursor: 'pointer', opacity: m.hidden_by_gm ? 0.4 : 1 }}>
            <polyline points={pts(m.data.points!)} fill="none" stroke="transparent" strokeWidth={4} vectorEffect="non-scaling-stroke" style={{ strokeWidth: 14 }} />
            <polyline points={pts(m.data.points!)} fill="none" stroke={c} strokeWidth={selected === m.id ? 4 : 3} strokeLinecap="round" strokeLinejoin="round"
              strokeDasharray={m.visibility === 'me' ? '6 5' : undefined} vectorEffect="non-scaling-stroke"
              markerEnd={m.data.arrow !== false ? `url(#arrow-${(['#86CFC4', '#E3A0D0', '#F0A096', '#D9B26A'].includes(c) ? c : '#86CFC4').slice(1)})` : undefined} />
          </g>
        );
      })}
      {draft.length > 0 && (
        <>
          <polyline points={pts(draft)} fill="none" stroke="#D9B26A" strokeWidth={3} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
          {draft.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={0.7} fill="#D9B26A" />)}
        </>
      )}
    </svg>
  );
}

const TOKEN_COLOR: Record<number, string> = { 1: '#86CFC4', 0: '#D9B26A', [-1]: '#F0A096' };
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

/** canMove/onMove: tokens that may be dragged (a linked Foundry scene's), and where one was dropped (0-100). */
export function MarkLayer({ marks, selected, onPick, canMove, onMove }: { marks: Mark[]; selected: string | null; onPick: (m: Mark) => void; me?: string; canMove?: (m: Mark) => boolean; onMove?: (m: Mark, p: Pt) => void }) {
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragged = useRef(false);
  /** A drag follows the pointer over the whole window (the map's other layers sit on top of each other). */
  const startDrag = (e: PointerEvent<HTMLElement>, m: Mark) => {
    e.stopPropagation();
    const box = (e.currentTarget.offsetParent as HTMLElement).getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }): Pt => ({
      x: Math.round(Math.min(100, Math.max(0, ((ev.clientX - box.left) / box.width) * 100)) * 100) / 100,
      y: Math.round(Math.min(100, Math.max(0, ((ev.clientY - box.top) / box.height) * 100)) * 100) / 100,
    });
    dragged.current = false;
    setDrag({ id: m.id, ...at(e) });
    const move = (ev: globalThis.PointerEvent) => {
      const p = at(ev);
      if (Math.hypot(p.x - (m.data.x ?? 0), p.y - (m.data.y ?? 0)) > 0.4) dragged.current = true;
      setDrag({ id: m.id, ...p });
    };
    const up = (ev: globalThis.PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      setDrag(null);
      if (dragged.current) onMove?.(m, at(ev));
      // The click that follows a drag is not a pick; a click elsewhere (on another layer) must not clear it either.
      setTimeout(() => { dragged.current = false; }, 0);
    };
    const cancel = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); setDrag(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };
  return (
    <>
      {marks.filter((m) => m.kind !== 'route').map((m) => {
        const on = selected === m.id;
        const c = colorFor(m);
        const here = drag?.id === m.id ? drag : null;
        const pos: CSSProperties = { position: 'absolute', left: `${here?.x ?? m.data.x}%`, top: `${here?.y ?? m.data.y}%`, opacity: m.hidden_by_gm ? 0.45 : 1 };
        if (m.data.token) {
          const t = m.data.token;
          const tc = TOKEN_COLOR[t.disposition] ?? TOKEN_COLOR[0];
          const movable = !!(canMove?.(m) && onMove);
          return (
            <button key={m.id} type="button" data-mark={m.id} data-token={t.id} aria-label={`Token: ${m.data.label ?? ''}${movable ? '. Drag to move it.' : ''}`} aria-pressed={on}
              onClick={(e) => { e.stopPropagation(); if (dragged.current) { dragged.current = false; return; } onPick(m); }}
              onPointerDown={movable ? (e) => startDrag(e, m) : undefined}
              style={{ ...pos, transform: 'translate(-50%,-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: 0, border: 0, background: 'transparent', cursor: movable ? 'grab' : 'pointer', font: 'inherit', touchAction: movable ? 'none' : undefined, zIndex: here ? 5 : movable ? 3 : 2 }}>
              <span aria-hidden="true" style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: `max(24px, ${Math.min(30, t.size * 100)}cqw)`, minWidth: 24, aspectRatio: '1', borderRadius: '50%', fontSize: 11, fontWeight: 700,
                background: '#1C222D', color: tc, border: `3px solid ${tc}`, boxShadow: on ? '0 0 0 4px rgba(217,178,106,0.55)' : '0 2px 6px rgba(0,0,0,0.6)',
              }}>{initials(m.data.label ?? '')}</span>
              {m.data.label && <span style={{ padding: '0 5px', borderRadius: 4, background: 'rgba(18,22,31,0.85)', color: '#EDE3CF', fontSize: 11, whiteSpace: 'nowrap', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.data.label}</span>}
            </button>
          );
        }
        const label = m.kind === 'stop' ? `Stop ${m.data.n}${m.data.label ? `: ${m.data.label}` : ''}` : m.kind === 'note' ? `Note: ${m.data.text}` : `${m.kind === 'icon' ? ICONS.find((i) => i[0] === m.data.icon)?.[2] ?? 'Icon' : 'Pin'}${m.data.label ? `: ${m.data.label}` : ''}`;
        const ring = on ? '0 0 0 4px rgba(217,178,106,0.55)' : '0 2px 6px rgba(0,0,0,0.5)';
        if (m.kind === 'note') {
          return (
            <button key={m.id} type="button" data-mark={m.id} aria-label={label} aria-pressed={on} onClick={(e) => { e.stopPropagation(); onPick(m); }}
              style={{ ...pos, transform: 'translate(-8px,-8px) rotate(-2deg)', width: 'clamp(90px, 16%, 160px)', padding: '6px 8px', border: 0, borderRadius: 2, textAlign: 'left', cursor: 'pointer', font: 'inherit', fontSize: 13, lineHeight: 1.3, color: '#2A2416', background: m.visibility === 'me' ? '#F1C9E6' : '#E9D98B', boxShadow: ring, outline: on ? '2px solid #F3D99B' : undefined, overflowWrap: 'anywhere' }}>
              {(m.data.text ?? '').slice(0, 120)}
            </button>
          );
        }
        const glyph = m.kind === 'stop' ? String(m.data.n ?? '?') : m.kind === 'icon' ? ICONS.find((i) => i[0] === m.data.icon)?.[1] ?? '•' : '●';
        return (
          <button key={m.id} type="button" data-mark={m.id} aria-label={label} aria-pressed={on} onClick={(e) => { e.stopPropagation(); onPick(m); }}
            style={{ ...pos, transform: 'translate(-50%,-50%)', display: 'flex', alignItems: 'center', gap: 4, padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: 'inherit' }}>
            <span aria-hidden="true" style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: '50%', fontSize: 13, fontWeight: 700,
              background: m.kind === 'stop' ? c : '#1C222D', color: m.kind === 'stop' ? '#12161F' : c, border: `2px ${m.visibility === 'me' ? 'dashed' : 'solid'} ${m.kind === 'stop' ? '#12161F' : c}`, boxShadow: ring,
            }}>{glyph}</span>
            {m.data.label && <span style={{ padding: '1px 6px', borderRadius: 4, background: 'rgba(18,22,31,0.85)', color: '#EDE3CF', fontSize: 12, whiteSpace: 'nowrap', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.data.label}</span>}
          </button>
        );
      })}
    </>
  );
}
