// Extra layers for the map: the pins the picture has in its own source (LegendKeeper), and the ruler.
import { Icon } from '../library/Blocks.tsx';
import type { Pt } from '../player/mapParts.tsx';

export interface SourcePin { id: string; name: string; icon: string | null; color: string | null; dm: boolean; pageId: string | null; x: number; y: number }
export interface Scale { width: number; unit: string }

/** Distance along the points, in picture widths (so a tall map measures right: y counts by the picture's own shape). */
export function lengthOf(points: Pt[], aspect: number): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += Math.hypot((points[i].x - points[i - 1].x) / 100, (points[i].y - points[i - 1].y) / 100 / aspect);
  return d;
}
export function distanceText(points: Pt[], aspect: number, scale: Scale | null): string {
  const d = lengthOf(points, aspect);
  if (!scale) return `${(d * 100).toFixed(1)}% of the map's width`;
  const v = d * scale.width;
  return `${v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${scale.unit}`;
}

export function SourcePins({ pins, selected, onPick, labels, active }: { pins: SourcePin[]; selected: string | null; onPick: (p: SourcePin) => void; labels: boolean; /** Pins can be pressed (false while a drawing tool is in use: presses go to the map). */ active: boolean }) {
  return (
    <>
      {pins.map((p) => (
        <button key={p.id} type="button" data-mark={active ? p.id : undefined} data-testid="source-pin" className="map-spin" aria-label={`${p.name}${p.dm ? ' (DM only)' : ''}`} title={`${p.name}${p.dm ? ' (DM only)' : ''}`} aria-pressed={selected === p.id}
          style={{ left: `${p.x}%`, top: `${p.y}%`, pointerEvents: active ? 'auto' : 'none', zIndex: selected === p.id ? 3 : 1 }} onClick={(e) => { e.stopPropagation(); onPick(p); }}>
          <span className={`map-spin-dot${selected === p.id ? ' on' : ''}`}><Icon icon={{ glyph: p.icon ?? 'location-dot', color: p.color ?? undefined }} size={13} /></span>
          {(labels || selected === p.id) && <span className="map-spin-name">{p.name}</span>}
        </button>
      ))}
    </>
  );
}

export function Ruler({ points, cursor, aspect, scale }: { points: Pt[]; cursor: Pt | null; aspect: number; scale: Scale | null }) {
  const all = cursor && points.length ? [...points, cursor] : points;
  if (!all.length) return null;
  const last = all[all.length - 1];
  return (
    <>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} aria-hidden="true">
        <polyline points={all.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#12161F" strokeWidth={5} vectorEffect="non-scaling-stroke" />
        <polyline points={all.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#F3D99B" strokeWidth={2.5} strokeDasharray="7 4" vectorEffect="non-scaling-stroke" />
      </svg>
      {points.map((p, i) => <span key={i} aria-hidden="true" className="map-ruler-dot" style={{ left: `${p.x}%`, top: `${p.y}%` }} />)}
      {all.length > 1 && <span className="map-ruler-label" role="status" data-testid="ruler-distance" style={{ left: `${last.x}%`, top: `${last.y}%` }}>{distanceText(all, aspect, scale)}</span>}
    </>
  );
}

export const MAP_CSS = `
.map-spin { position: absolute; transform: translate(-50%, -50%); display: flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; font: inherit; cursor: pointer; }
.map-spin-dot { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: rgba(18, 22, 31, 0.88); border: 1px solid rgba(243, 217, 155, 0.55); }
.map-spin-dot.on { box-shadow: 0 0 0 4px rgba(217, 178, 106, 0.55); }
.map-spin-name { padding: 1px 6px; border-radius: 4px; background: rgba(18, 22, 31, 0.85); color: #EDE3CF; font-size: 12px; white-space: nowrap; }
.map-ruler-dot { position: absolute; width: 9px; height: 9px; border-radius: 50%; background: #F3D99B; border: 2px solid #12161F; transform: translate(-50%, -50%); pointer-events: none; }
.map-ruler-label { position: absolute; transform: translate(12px, -130%); padding: 3px 9px; border-radius: 6px; background: #12161F; border: 1px solid #F3D99B; color: #F3D99B; font-weight: 700; font-size: 14px; white-space: nowrap; pointer-events: none; z-index: 5; }
@media (max-width: 760px) { .map-tools-row input[type=range] { min-height: 44px; } .map-tools-row label { min-height: 44px; } }
.map-zoom { overflow: auto; max-height: calc(100vh - 190px); border-radius: 10px; }
`;
