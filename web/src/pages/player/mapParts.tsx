// Drawing pieces for the map: the SVG route layer and the mark buttons.
import type { CSSProperties } from 'react';

export interface Pt { x: number; y: number }
export interface Mark {
  id: string; map_id: string; author_id: string; kind: 'pin' | 'note' | 'route' | 'stop' | 'icon';
  data: { x?: number; y?: number; label?: string; text?: string; icon?: string; plan?: string; n?: number; points?: Pt[]; arrow?: boolean; color?: string | null };
  visibility: 'party' | 'me' | 'dm'; hidden_by_dm: boolean; created_at: string;
}

export const ICONS: [string, string, string][] = [
  ['camp', '⛺', 'Camp'], ['fight', '⚔', 'Fight'], ['danger', '⚠', 'Danger'], ['skull', '☠', 'Skull'], ['anchor', '⚓', 'Anchor'],
  ['question', '?', 'Question'], ['rest', '♨', 'Rest'], ['treasure', '◆', 'Treasure'], ['door', '⌂', 'Door'], ['eye', '◉', 'Eye'],
];

const colorFor = (m: Mark) => (m.visibility === 'me' ? '#E3A0D0' : m.visibility === 'dm' ? '#F0A096' : '#86CFC4');

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
          <g key={m.id} data-mark={m.id} onClick={(e) => { e.stopPropagation(); onPick(m); }} style={{ cursor: 'pointer', opacity: m.hidden_by_dm ? 0.4 : 1 }}>
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

export function MarkLayer({ marks, selected, onPick }: { marks: Mark[]; selected: string | null; onPick: (m: Mark) => void; me?: string }) {
  return (
    <>
      {marks.filter((m) => m.kind !== 'route').map((m) => {
        const on = selected === m.id;
        const c = colorFor(m);
        const pos: CSSProperties = { position: 'absolute', left: `${m.data.x}%`, top: `${m.data.y}%`, opacity: m.hidden_by_dm ? 0.45 : 1 };
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
