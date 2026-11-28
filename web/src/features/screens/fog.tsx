// Fog of war on a map picture, and the GM's choice of which picture the table screen shows.
// The server owns the truth (and keeps marks under fog away from players); this only draws it. Fog is a canvas laid over the
// map: opaque for players and the table screen, a translucent tint for the GM. The picture itself is not drawn until the fog
// state for it has arrived, so a fogged map never flashes uncovered.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { useLoad, useWorld } from '../../lib/world.tsx';
import './fog.css';

export const FOG_ASPECT = 1.6;
const GRID = 96;
export type FogOp =
  | { k: 'c'; x: number; y: number; r: number; v: 0 | 1; g?: number }
  | { k: 'r'; x: number; y: number; w: number; h: number; v: 0 | 1; g?: number }
  | { k: 'all'; v: 0 | 1; g?: number };
export interface FogState { mapId?: string; pic?: string; enabled: boolean; base: string | null; ops: FogOp[]; version: number }

const enc = encodeURIComponent;
const FOG_COLOR = '#0b0e14';

/** Fog for one map picture. `ready` is false until the state for exactly this map and picture has been read. */
export function useFog(mapId: string, pic: string, view?: 'players') {
  const { w } = useWorld();
  const q = useLoad<FogState>(() => w.call('GET', `/fog/map/${enc(mapId)}`, undefined, { pic, ...(view ? { view } : {}) }), [w, mapId, pic, view], ['fog']);
  const fresh = q.data && q.data.mapId === mapId && q.data.pic === pic ? q.data : null;
  return { ready: !!fresh, state: fresh, error: q.error, reload: q.reload };
}

/** Which map picture the table screen shows (the GM's choice). mapId and pic are null until the GM has chosen. */
export function useTableDisplay() {
  const { w } = useWorld();
  const q = useLoad<{ mapId: string | null; pic: string | null; version: number }>(() => w.call('GET', '/fog/table'), [w], ['table-display']);
  const set = async (patch: { mapId?: string | null; pic?: string | null }) => { await w.call('PUT', '/fog/table', patch); await q.reload(); };
  return { display: q.data, loading: q.loading, set };
}

export interface MapPic { value: string; label: string; url: string }

/** Every map picture this viewer may use: the world's imported maps, then library files. `view` asks for the players' copy. */
export function useMapPictures(view?: 'players') {
  const { w } = useWorld();
  const q = view ? { view } : undefined;
  const libMaps = useLoad<{ id: string; name: string; url: string }[]>(() => w.call<any[]>('GET', '/files/maps', undefined, q).catch(() => []), [w, view], ['libfile']);
  const imported = useLoad<{ id: string; name: string; url: string }[]>(() => w.call<any[]>('GET', '/intake/map-images', undefined, q).catch(() => []), [w, view], ['page']);
  const options = useMemo<MapPic[]>(() => [
    ...(imported.data ?? []).map((m) => ({ value: `imp:${m.id}`, label: m.name || 'Map', url: m.url })),
    ...(libMaps.data ?? []).map((f) => ({ value: `lib:${f.id}`, label: f.name, url: f.url })),
  ], [imported.data, libMaps.data]);
  return { options, loading: libMaps.loading || imported.loading };
}

/** The picture a map shows when nothing says otherwise: the GM's local choice on the Map page, else the first one. */
export function pickPicture(options: MapPic[], want: string): MapPic | null {
  return want === 'none' ? null : options.find((o) => o.value === want) ?? options[0] ?? null;
}

function paint(c: HTMLCanvasElement, base: string | null, ops: FogOp[]) {
  const g = c.getContext('2d');
  if (!g) return;
  const W = c.width, H = c.height;
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, W, H);
  if (!base) { g.fillStyle = FOG_COLOR; g.fillRect(0, 0, W, H); }
  else {
    const bits = Uint8Array.from(atob(base), (ch) => ch.charCodeAt(0));
    const small = document.createElement('canvas');
    small.width = small.height = GRID;
    const sg = small.getContext('2d')!;
    const img = sg.createImageData(GRID, GRID);
    for (let i = 0; i < GRID * GRID; i++) {
      if (bits[i >> 3] & (1 << (i & 7))) { img.data[i * 4] = 11; img.data[i * 4 + 1] = 14; img.data[i * 4 + 2] = 20; img.data[i * 4 + 3] = 255; }
    }
    sg.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(small, 0, 0, W, H);
  }
  for (const op of ops) {
    // Reveal cuts a hole in the fog; hide puts fog back over it.
    g.globalCompositeOperation = op.v === 1 ? 'destination-out' : 'source-over';
    g.fillStyle = FOG_COLOR;
    if (op.k === 'all') { g.fillRect(0, 0, W, H); continue; }
    g.beginPath();
    if (op.k === 'r') g.rect(op.x * W, op.y * H, op.w * W, op.h * H);
    else g.ellipse(op.x * W, op.y * H, op.r * W, op.r * FOG_ASPECT * H, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';
}

/**
 * The fog, drawn over its parent (which must be positioned). `tint` is the GM's see-through version; players get it opaque.
 * `extra` is strokes being drawn that the server has not confirmed yet.
 */
export function FogCanvas({ state, extra = [], tint = false }: { state: Pick<FogState, 'enabled' | 'base' | 'ops'>; extra?: FogOp[]; tint?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const ops = useMemo(() => (extra.length ? [...state.ops, ...extra] : state.ops), [state.ops, extra]);
  const draw = () => {
    const c = ref.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const w = Math.max(2, Math.min(2400, Math.round(r.width))), h = Math.max(2, Math.min(1600, Math.round(r.height)));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    paint(c, state.base, ops);
  };
  // Layout effect: painted before the browser shows the map under it.
  useLayoutEffect(draw);
  useEffect(() => {
    const c = ref.current;
    if (!c || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  });
  if (!state.enabled) return null;
  return <canvas ref={ref} className="fog-canvas" data-testid="fog-canvas" data-ops={state.ops.length} aria-hidden="true" style={{ opacity: tint ? 0.5 : 1 }} />;
}

/** The map picture as a background that only appears once its fog state is known. */
export function pictureStyle(pic: MapPic | null, ready: boolean): CSSProperties | undefined {
  if (!pic || !ready) return undefined;
  return { background: `center / 100% 100% no-repeat url("${pic.url.replace(/"/g, '%22')}"), #15212D` };
}

type Tool = 'circle' | 'rect';

/** The GM's fog controls for one map picture: what to draw, and the writes. */
export function useFogEditor(mapId: string, pic: string, fog: { state: FogState | null; reload: () => Promise<void> | void }, onFirstUse?: () => void) {
  const { w } = useWorld();
  const [tool, setTool] = useState<Tool>('circle');
  const [reveal, setReveal] = useState(true);
  const [size, setSize] = useState(0.07);
  const [pending, setPending] = useState<FogOp[]>([]);
  const [error, setError] = useState<string | null>(null);
  const base = `/fog/map/${enc(mapId)}`;
  const guard = async (fn: () => Promise<unknown>) => {
    try { setError(null); onFirstUse?.(); await fn(); await fog.reload(); } catch (e: any) { setError(e.message ?? String(e)); } finally { setPending([]); }
  };
  const send = (ops: FogOp[]) => guard(async () => {
    for (let i = 0; i < ops.length; i += 200) await w.call('POST', `${base}/ops`, { pic, ops: ops.slice(i, i + 200) });
  });
  return {
    tool, setTool, reveal, setReveal, size, setSize, pending, setPending, error,
    enabled: !!fog.state?.enabled,
    canUndo: !!fog.state?.ops.length,
    setEnabled: (on: boolean) => guard(() => w.call('PUT', `${base}/enabled`, { pic, enabled: on })),
    commit: (ops: FogOp[]) => { setPending(ops); return send(ops); },
    all: (v: 0 | 1) => send([{ k: 'all', v }]),
    undo: () => guard(() => w.call('POST', `${base}/undo`, { pic })),
  };
}
export type FogEditor = ReturnType<typeof useFogEditor>;

/** The pointer layer laid over the map while a fog tool is in use: drag to uncover or cover. */
export function FogDraw({ ed, active }: { ed: FogEditor; active: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const stroke = useRef<{ g: number; ops: FogOp[]; last: { x: number; y: number }; from: { x: number; y: number } } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  if (!active) return null;
  const v: 0 | 1 = ed.reveal ? 1 : 0;
  const at = (e: RPointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const rectOf = (a: { x: number; y: number }, b: { x: number; y: number }, g: number): FogOp => ({ k: 'r', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y), v, g });
  const down = (e: RPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = at(e), g = Math.floor(Math.random() * 2_000_000_000);
    stroke.current = { g, ops: [], last: p, from: p };
    stroke.current.ops = ed.tool === 'circle' ? [{ k: 'c', x: p.x, y: p.y, r: ed.size, v, g }] : [rectOf(p, p, g)];
    ed.setPending(stroke.current.ops);
  };
  const move = (e: RPointerEvent) => {
    const p = at(e);
    setHover(p);
    const s = stroke.current;
    if (!s) return;
    if (ed.tool === 'circle') {
      // A new circle every half radius keeps the drag a smooth band without a circle per pixel.
      const dx = p.x - s.last.x, dy = (p.y - s.last.y) / FOG_ASPECT;
      if (Math.hypot(dx, dy) < ed.size / 2 || s.ops.length >= 200) return;
      s.last = p;
      s.ops = [...s.ops, { k: 'c', x: p.x, y: p.y, r: ed.size, v, g: s.g }];
    } else s.ops = [rectOf(s.from, p, s.g)];
    ed.setPending(s.ops);
  };
  const up = () => {
    const s = stroke.current;
    stroke.current = null;
    if (!s) return;
    const ops = s.ops.filter((o) => o.k !== 'r' || (o.w > 0.004 && o.h > 0.004));
    if (ops.length) void ed.commit(ops); else ed.setPending([]);
  };
  return (
    <div ref={box} className="fog-draw" data-testid="fog-draw" role="application" aria-label="Fog of war: drag to uncover or cover the map"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { stroke.current = null; ed.setPending([]); }} onPointerLeave={() => setHover(null)}>
      {ed.tool === 'circle' && hover && <span aria-hidden="true" className="fog-brush" style={{ left: `${hover.x * 100}%`, top: `${hover.y * 100}%`, width: `${ed.size * 200}%`, height: `${ed.size * FOG_ASPECT * 200}%` }} />}
    </div>
  );
}

/** Buttons for the fog editor. `compact` is the side-panel version. */
export function FogToolbar({ ed }: { ed: FogEditor }) {
  return (
    <div className="fog-tools" role="toolbar" aria-label="Fog of war" data-testid="fog-toolbar">
      <button type="button" className={`btn small${ed.enabled ? ' on' : ''}`} aria-pressed={ed.enabled} data-testid="fog-toggle" onClick={() => void ed.setEnabled(!ed.enabled)}>
        {ed.enabled ? 'Fog on' : 'Fog off'}
      </button>
      {ed.enabled && (
        <>
          <span className="row" role="group" aria-label="What a stroke does" style={{ gap: 2 }}>
            <button type="button" className={`btn small${ed.reveal ? ' on' : ''}`} aria-pressed={ed.reveal} data-testid="fog-mode-reveal" onClick={() => ed.setReveal(true)}>Reveal</button>
            <button type="button" className={`btn small${!ed.reveal ? ' on' : ''}`} aria-pressed={!ed.reveal} data-testid="fog-mode-hide" onClick={() => ed.setReveal(false)}>Hide</button>
          </span>
          <span className="row" role="group" aria-label="Brush shape" style={{ gap: 2 }}>
            <button type="button" className={`btn small${ed.tool === 'circle' ? ' on' : ''}`} aria-pressed={ed.tool === 'circle'} data-testid="fog-tool-circle" onClick={() => ed.setTool('circle')}>Circle</button>
            <button type="button" className={`btn small${ed.tool === 'rect' ? ' on' : ''}`} aria-pressed={ed.tool === 'rect'} data-testid="fog-tool-rect" onClick={() => ed.setTool('rect')}>Rectangle</button>
          </span>
          {ed.tool === 'circle' && (
            <label className="row small" style={{ gap: 6 }}>Size
              <input type="range" min={0.02} max={0.25} step={0.01} value={ed.size} data-testid="fog-size" aria-label="Brush size" onChange={(e) => ed.setSize(Number(e.target.value))} />
            </label>
          )}
          <button type="button" className="btn small" data-testid="fog-reveal-all" onClick={() => void ed.all(1)}>Reveal all</button>
          <button type="button" className="btn small" data-testid="fog-hide-all" onClick={() => void ed.all(0)}>Hide all</button>
          <button type="button" className="btn small" data-testid="fog-undo" disabled={!ed.canUndo} onClick={() => void ed.undo()}>Undo stroke</button>
        </>
      )}
      {ed.error && <span className="small" role="alert" style={{ color: 'var(--danger)' }}>{ed.error}</span>}
    </div>
  );
}
