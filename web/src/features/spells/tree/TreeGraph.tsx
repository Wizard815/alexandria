// Copied from Wizard815/DND-Spell-Tree src/tree/TreeGraph.tsx by scripts/sync-alexandria.sh: change it there.
// The spell tree drawn as a skill tree: a root on the left, one branch per
// school of magic running left to right through its spell levels (cantrips
// first), then a branch for hybrid spells (two elements) and one for Others.
// Each level is a hub on the branch's spine; its spells hang off the hub.
// Known spells and the paths to them glow gold, spells that can be learned
// are bright, locked ones grey, unknown ones dark. Drag to pan, wheel or
// pinch to zoom; click (or Enter on) a spell to open it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { ELEMENT_COLOR, SCHOOL_COLOR } from './treeCss.ts';
import type { TreeData, TreeSpell, TreeStatus } from './types.ts';

export const STATUS_LABEL: Record<TreeStatus, string> = {
  known: 'Known', gift: 'Gift', studying: 'Studying', stopped: 'Paused', learn: 'Can learn', locked: 'Locked', hidden: 'Hidden recipe', dark: 'Unknown',
};
const levelName = (n: number) => (n === 0 ? 'Cantrip' : `Level ${n}`);

// Layout, in SVG units.
const ROOT_X = 70;
const TRUNK_X = 150;
const X0 = 250; // the cantrip hub
const COL = 245; // between level hubs
const SUBX = [-81, -27, 27, 81]; // a level's four columns of spells, around its hub
const ROW = 62; // between rows of spells
const R = 18; // spell node radius
const LANE_GAP = 46;

interface Lane { key: string; title: string; color: string; spells: TreeSpell[]; hybrid?: boolean }
interface Placed { s: TreeSpell; x: number; y: number; hubX: number; lane: number }
interface LaneLayout { lane: Lane; y: number; top: number; bottom: number; levels: number[]; litTo: number; known: number }

const isKnown = (s: TreeSpell) => s.status === 'known' || s.status === 'gift';

function layout(lanes: Lane[]) {
  const placed: Placed[] = [];
  const out: LaneLayout[] = [];
  let top = 30;
  lanes.forEach((lane, li) => {
    const by = new Map<number, TreeSpell[]>();
    for (const s of lane.spells) by.set(s.level, [...(by.get(s.level) ?? []), s]);
    const levels = [...by.keys()].sort((a, b) => a - b);
    // Rows above and below the spine: four columns per level, filling outward.
    const most = Math.max(1, ...[...by.values()].map((l) => l.length));
    const rowsPerSide = Math.ceil(Math.ceil(most / 2) / SUBX.length);
    const half = rowsPerSide * ROW + 14;
    const y = top + half;
    for (const lv of levels) {
      const list = (by.get(lv) ?? []).sort((a, b) => Number(isKnown(b)) - Number(isKnown(a)) || a.name.localeCompare(b.name));
      const hubX = X0 + lv * COL;
      list.forEach((s, k) => {
        const side = k % 2 === 0 ? -1 : 1;
        const j = Math.floor(k / 2);
        // Inner columns first, so a level with few spells stays close to its hub.
        const col = [1, 2, 0, 3][j % SUBX.length];
        const row = Math.floor(j / SUBX.length) + 1;
        placed.push({ s, x: hubX + SUBX[col], y: y + side * (row * ROW - 14), hubX, lane: li });
      });
    }
    const knownLv = lane.spells.filter(isKnown).map((s) => s.level);
    out.push({ lane, y, top, bottom: y + half, levels, litTo: knownLv.length ? Math.max(...knownLv) : -1, known: knownLv.length });
    top = y + half + LANE_GAP;
  });
  const endX = X0 + 9 * COL + 170;
  return { placed, lanes: out, width: endX + 130, height: top, endX };
}

/** A path with the angled corners of a circuit: across, then up or down at 45°, then across. */
const elbow = (x1: number, y1: number, x2: number, y2: number) => {
  const dy = y2 - y1;
  if (Math.abs(dy) < 1) return `M${x1},${y1}H${x2}`;
  const run = Math.min(Math.abs(dy), Math.abs(x2 - x1) * 0.5);
  const mid = x1 + (x2 - x1 - run) / 2;
  return `M${x1},${y1}H${mid}L${mid + run},${y2}H${x2}`;
};
/** Between two hubs: the spine splits in two and meets again, like the photo's hexagons. */
const hex = (x1: number, x2: number, y: number) => `M${x1 + 11},${y}L${x1 + 30},${y - 17}H${x2 - 30}L${x2 - 11},${y}L${x2 - 30},${y + 17}H${x1 + 30}Z`;

const initials = (name: string) => {
  const w = name.replace(/[^A-Za-z' ]/g, ' ').split(/\s+/).filter((x) => x && !/^(of|the|and|to|from|with)$/i.test(x));
  return ((w[0]?.[0] ?? '') + (w[1]?.[0] ?? w[0]?.[1] ?? '')).toUpperCase();
};
const short = (name: string, n: number) => (name.length > n ? `${name.slice(0, n - 1)}…` : name);

export interface TreeGraphProps {
  data: TreeData;
  sel: string | null;
  onPick: (id: string) => void;
  /** Spells to fade (a search or filter that leaves them out). */
  dim?: (s: TreeSpell) => boolean;
}

export default function TreeGraph({ data, sel, onPick, dim }: TreeGraphProps) {
  const lanes = useMemo<Lane[]>(() => {
    const out: Lane[] = data.schools.filter((g) => g.name !== 'Others').map((g) => ({ key: g.name, title: g.name, color: SCHOOL_COLOR[g.name] ?? SCHOOL_COLOR.Others, spells: g.spells }));
    if (data.hybrids.length) out.push({ key: 'hybrids', title: 'Where lines meet', color: '#c9a2ff', spells: data.hybrids, hybrid: true });
    const others = data.schools.find((g) => g.name === 'Others');
    if (others?.spells.length) out.push({ key: 'Others', title: 'Others', color: SCHOOL_COLOR.Others, spells: others.spells });
    return out;
  }, [data]);
  const L = useMemo(() => layout(lanes), [lanes]);
  const byName = useMemo(() => new Map(L.placed.map((p) => [p.s.name, p])), [L]);
  const picked = L.placed.find((p) => p.s.id === sel) ?? null;
  const rootY = (L.lanes[0]?.y ?? 0) + ((L.lanes[L.lanes.length - 1]?.y ?? 0) - (L.lanes[0]?.y ?? 0)) / 2;

  // ---- pan and zoom ----
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; k: number; dist: number; cx: number; cy: number; moved: number } | null>(null);
  const dragged = useRef(false);

  const clampK = (k: number) => Math.max(0.2, Math.min(2.5, k));
  const fit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const k = clampK(Math.min(w / L.width, h / L.height));
    setView({ k, x: (w - L.width * k) / 2, y: (h - L.height * k) / 2 });
  }, [L.width, L.height]);
  /** Readable size, the root at the left edge, the branch with the most known spells in the middle. */
  const home = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const k = w < 700 ? 0.62 : 0.8;
    const best = [...L.lanes].sort((a, b) => b.known - a.known)[0];
    const cy = best && best.known ? best.y : rootY;
    setView({ k, x: 12 - (ROOT_X - 50) * k, y: h / 2 - cy * k });
  }, [L.lanes, rootY]);
  useLayoutEffect(() => { home(); }, [home]);

  const zoomAt = (cx: number, cy: number, f: number) => setView((v) => {
    const k = clampK(v.k * f);
    return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
  });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const startGesture = () => {
    const ps = [...pointers.current.values()];
    const cx = ps.reduce((a, p) => a + p.x, 0) / ps.length;
    const cy = ps.reduce((a, p) => a + p.y, 0) / ps.length;
    const dist = ps.length > 1 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0;
    gesture.current = { x: view.x, y: view.y, k: view.k, dist, cx, cy, moved: gesture.current?.moved ?? 0 };
  };
  const down = (e: RPointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const r = box.current!.getBoundingClientRect();
    pointers.current.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
    if (pointers.current.size === 1) dragged.current = false;
    gesture.current = null;
    startGesture();
  };
  const move = (e: RPointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    const r = box.current!.getBoundingClientRect();
    pointers.current.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
    const g = gesture.current;
    const ps = [...pointers.current.values()];
    const cx = ps.reduce((a, p) => a + p.x, 0) / ps.length;
    const cy = ps.reduce((a, p) => a + p.y, 0) / ps.length;
    const moved = Math.hypot(cx - g.cx, cy - g.cy);
    if (moved > 6) { dragged.current = true; if (!box.current!.hasPointerCapture(e.pointerId)) box.current!.setPointerCapture(e.pointerId); }
    let k = g.k;
    if (ps.length > 1 && g.dist > 0) { k = clampK(g.k * (Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) / g.dist)); dragged.current = true; }
    // Keep the point under the fingers (or the mouse) where it was.
    setView({ k, x: cx - ((g.cx - g.x) * k) / g.k, y: cy - ((g.cy - g.y) * k) / g.k });
  };
  const up = (e: RPointerEvent) => {
    pointers.current.delete(e.pointerId);
    gesture.current = null;
    if (pointers.current.size) startGesture();
  };
  const pick = (id: string) => { if (!dragged.current) onPick(id); };
  const key = (id: string) => (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(id); } };

  // Bring the picked spell into view when it is off screen (picked from search or the panel).
  useEffect(() => {
    if (!picked || !box.current) return;
    const w = box.current.clientWidth;
    const h = box.current.clientHeight;
    setView((v) => {
      const sx = picked.x * v.k + v.x;
      const sy = picked.y * v.k + v.y;
      if (sx > 40 && sx < w - 40 && sy > 40 && sy < h - 40) return v;
      return { ...v, x: w / 2 - picked.x * v.k, y: h / 2 - picked.y * v.k };
    });
  }, [picked?.s.id]);

  const recipe = picked ? picked.s.from.map((n) => byName.get(n)).filter((p): p is Placed => !!p) : [];
  // Names under the spells that matter (known, open, studying, picked); every name once zoomed in.
  const allLabels = view.k >= 1.25;
  const labelled = (s: TreeSpell) => view.k >= 0.42 && (allLabels || sel === s.id || isKnown(s) || s.status === 'learn' || s.status === 'studying' || s.status === 'stopped');

  return (
    <div className="stg" ref={box} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className="stg-tools" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" className="st-btn small" aria-label="Zoom in" onClick={() => { const el = box.current!; zoomAt(el.clientWidth / 2, el.clientHeight / 2, 1.3); }}>+</button>
        <button type="button" className="st-btn small" aria-label="Zoom out" onClick={() => { const el = box.current!; zoomAt(el.clientWidth / 2, el.clientHeight / 2, 1 / 1.3); }}>−</button>
        <button type="button" className="st-btn small" onClick={home}>Start</button>
        <button type="button" className="st-btn small" onClick={fit}>All</button>
      </div>
      <svg width="100%" height="100%" role="img" aria-label={`Spell tree: ${L.placed.length} spells`}>
        <defs>
          <radialGradient id="stg-gold" cx="40%" cy="35%" r="70%"><stop offset="0" stopColor="#fff3b8" /><stop offset=".55" stopColor="#f0c040" /><stop offset="1" stopColor="#a8740c" /></radialGradient>
          <radialGradient id="stg-open" cx="40%" cy="35%" r="70%"><stop offset="0" stopColor="#ffffff" /><stop offset=".6" stopColor="#c9ced8" /><stop offset="1" stopColor="#7d8594" /></radialGradient>
          <radialGradient id="stg-root" cx="45%" cy="40%" r="70%"><stop offset="0" stopColor="#c8f070" /><stop offset=".7" stopColor="#3f8f1e" /><stop offset="1" stopColor="#1d4a0c" /></radialGradient>
          <filter id="stg-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* The trunk from the root to every branch. */}
          {L.lanes.map((ln, i) => (
            <path key={`t${i}`} className={`stg-line${ln.litTo >= 0 ? ' lit' : ''}`} d={elbow(ROOT_X + 40, rootY, X0 - 12, ln.y)} />
          ))}
          {L.lanes.map((ln, li) => {
            const hubs = Array.from({ length: 10 }, (_, lv) => lv).filter((lv) => ln.levels.includes(lv) || lv <= Math.max(...ln.levels, 0));
            const last = hubs[hubs.length - 1] ?? 0;
            return (
              <g key={ln.lane.key} role="group" aria-label={ln.lane.title}>
                <text className="stg-lane" x={TRUNK_X + 14} y={ln.top - 8} fill={ln.lane.color}>{ln.lane.title}</text>
                {hubs.slice(0, -1).map((lv, i) => (
                  <path key={`s${lv}`} className={`stg-line${ln.litTo > lv ? ' lit' : ''}`} d={hex(X0 + lv * COL, X0 + hubs[i + 1] * COL, ln.y)} fill="none" />
                ))}
                <path className={`stg-line${ln.litTo >= 0 && ln.known === ln.lane.spells.length ? ' lit' : ''}`} d={`M${X0 + last * COL + 11},${ln.y}H${L.endX - 44}`} />
                {L.placed.filter((p) => p.lane === li).map((p) => (
                  <path key={`c${p.s.id}`} className={`stg-line thin${isKnown(p.s) ? ' lit' : p.s.status === 'studying' ? ' study' : ''}`} d={`M${p.hubX},${ln.y}V${p.y}H${p.x}`} />
                ))}
                {hubs.map((lv) => (
                  <g key={`h${lv}`} className={`stg-hub${ln.litTo >= lv ? ' lit' : ''}`}>
                    <circle cx={X0 + lv * COL} cy={ln.y} r={11} />
                    <text x={X0 + lv * COL} y={ln.y + 4} textAnchor="middle">{lv === 0 ? 'C' : lv}</text>
                  </g>
                ))}
                <g className={`stg-emblem${ln.known ? ' lit' : ''}`}>
                  <circle cx={L.endX} cy={ln.y} r={42} style={{ stroke: ln.lane.color }} />
                  <text x={L.endX} y={ln.y + 2} textAnchor="middle" className="stg-emblem-k">{ln.known}</text>
                  <text x={L.endX} y={ln.y + 18} textAnchor="middle" className="stg-emblem-n">of {ln.lane.spells.length}</text>
                  <text x={L.endX + 52} y={ln.y + 5} className="stg-lane" fill={ln.lane.color}>{ln.lane.title}</text>
                </g>
              </g>
            );
          })}
          {/* The picked spell's recipe: dashed lines from the spells that teach it. */}
          {picked && recipe.map((p) => <path key={`r${p.s.id}`} className="stg-recipe" d={`M${p.x},${p.y}L${picked.x},${picked.y}`} />)}
          {L.placed.map((p) => {
            const s = p.s;
            const faded = dim?.(s) ?? false;
            const pct = s.study ? Math.max(0, Math.min(1, s.study.banked / Math.max(1, s.study.needed))) : 0;
            const circ = 2 * Math.PI * (R + 4);
            const two = s.hybrid && s.lines.length >= 2;
            return (
              <g key={s.id} className={`stg-node s-${s.status}${sel === s.id ? ' sel' : ''}${faded ? ' faded' : ''}`} transform={`translate(${p.x},${p.y})`}
                role="button" tabIndex={0} aria-label={`${s.name}, ${levelName(s.level)}, ${STATUS_LABEL[s.status]}`} aria-pressed={sel === s.id}
                onClick={() => pick(s.id)} onKeyDown={key(s.id)}>
                <title>{`${s.name} (${levelName(s.level)}): ${STATUS_LABEL[s.status]}`}</title>
                {sel === s.id && <circle r={R + 9} className="stg-selring" />}
                <circle r={R} className="stg-disc" filter={isKnown(s) || s.status === 'learn' ? 'url(#stg-glow)' : undefined} />
                {two && (
                  <>
                    <path d={`M0,${-R - 3}A${R + 3},${R + 3} 0 0 0 0,${R + 3}`} fill="none" stroke={ELEMENT_COLOR[s.lines[0]] ?? '#999'} strokeWidth={3} />
                    <path d={`M0,${-R - 3}A${R + 3},${R + 3} 0 0 1 0,${R + 3}`} fill="none" stroke={ELEMENT_COLOR[s.lines[1]] ?? '#999'} strokeWidth={3} />
                  </>
                )}
                {s.study && (
                  <circle r={R + 4} className="stg-prog" strokeDasharray={`${pct * circ} ${circ}`} transform="rotate(-90)" />
                )}
                <text className="stg-ini" y={4} textAnchor="middle">{initials(s.name)}</text>
                {labelled(s) && <text className="stg-name" y={R + 14} textAnchor="middle">{sel === s.id ? s.name : short(s.name, allLabels ? 14 : 11)}</text>}
              </g>
            );
          })}
          {/* The root: the character. */}
          <g className="stg-root">
            <circle cx={ROOT_X} cy={rootY} r={46} className="stg-root-ring" />
            <circle cx={ROOT_X} cy={rootY} r={36} fill="url(#stg-root)" filter="url(#stg-glow)" />
            <text x={ROOT_X} y={rootY + 9} textAnchor="middle" className="stg-root-t">✦</text>
          </g>
        </g>
      </svg>
    </div>
  );
}

export const GRAPH_CSS = `
.stg { position: relative; height: min(76vh, 900px); min-height: 420px; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; touch-action: none; user-select: none; cursor: grab;
  background: radial-gradient(ellipse at 30% 40%, #1d1f26 0%, #0c0d11 70%); }
.stg:active { cursor: grabbing; }
.stg svg { display: block; }
.stg-tools { position: absolute; right: 10px; top: 10px; display: flex; gap: 6px; z-index: 2; }
.stg-tools .st-btn { background: rgba(20,20,26,.85); color: #eee; border-color: #444; min-width: 34px; }
.stg-line { fill: none; stroke: #6f7380; stroke-width: 2.4; }
.stg-line.thin { stroke-width: 1.8; stroke: #575b66; }
.stg-line.lit { stroke: #f0c040; filter: drop-shadow(0 0 3px rgba(240,192,64,.7)); }
.stg-line.study { stroke: #f0c040; stroke-dasharray: 5 5; }
.stg-recipe { stroke: #fff; stroke-width: 2; stroke-dasharray: 3 6; fill: none; opacity: .85; }
.stg-hub circle { fill: #16171c; stroke: #8a8e99; stroke-width: 2; }
.stg-hub text { fill: #b9bcc6; font: 600 10px system-ui, sans-serif; }
.stg-hub.lit circle { fill: #3a2f0c; stroke: #f0c040; }
.stg-hub.lit text { fill: #ffe08a; }
.stg-lane { font: 700 15px system-ui, sans-serif; letter-spacing: .03em; }
.stg-emblem circle { fill: #141519; stroke-width: 3; opacity: .9; }
.stg-emblem.lit circle { fill: #241d08; }
.stg-emblem-k { fill: #fff; font: 700 20px system-ui, sans-serif; }
.stg-emblem-n { fill: #9aa0ab; font: 11px system-ui, sans-serif; }
.stg-node { cursor: pointer; outline: none; }
.stg-node .stg-disc { stroke-width: 2.5; }
.stg-node .stg-ini { font: 700 12px system-ui, sans-serif; pointer-events: none; }
.stg-node .stg-name { font: 10px system-ui, sans-serif; pointer-events: none; paint-order: stroke; stroke: #0c0d11; stroke-width: 3px; }
.stg-node.s-known .stg-disc, .stg-node.s-gift .stg-disc { fill: url(#stg-gold); stroke: #ffe8a0; }
.stg-node.s-gift .stg-disc { stroke: #d8b8ff; }
.stg-node.s-known .stg-ini, .stg-node.s-gift .stg-ini { fill: #3b2500; }
.stg-node.s-known .stg-name, .stg-node.s-gift .stg-name { fill: #ffe08a; }
.stg-node.s-learn .stg-disc { fill: url(#stg-open); stroke: #ffffff; }
.stg-node.s-learn .stg-ini { fill: #20232b; }
.stg-node.s-learn .stg-name { fill: #f2f4f8; font-weight: 600; }
.stg-node.s-studying .stg-disc, .stg-node.s-stopped .stg-disc { fill: #2a2d36; stroke: #c9ced8; }
.stg-node.s-stopped .stg-disc { stroke-dasharray: 4 3; }
.stg-node.s-studying .stg-ini, .stg-node.s-stopped .stg-ini { fill: #f2f4f8; }
.stg-node.s-studying .stg-name, .stg-node.s-stopped .stg-name { fill: #e6e8ee; }
.stg-prog { fill: none; stroke: #f0c040; stroke-width: 3.5; stroke-linecap: round; }
.stg-node.s-locked .stg-disc { fill: #2b2c33; stroke: #6a6d78; }
.stg-node.s-locked .stg-ini { fill: #9a9ea8; }
.stg-node.s-locked .stg-name { fill: #9a9ea8; }
.stg-node.s-dark .stg-disc, .stg-node.s-hidden .stg-disc { fill: #121317; stroke: #2e3038; }
.stg-node.s-dark .stg-ini, .stg-node.s-hidden .stg-ini { fill: #4a4d57; }
.stg-node.s-dark .stg-name, .stg-node.s-hidden .stg-name { fill: #555964; }
.stg-node:hover .stg-disc, .stg-node:focus-visible .stg-disc { stroke: #fff; stroke-width: 3.5; }
.stg-selring { fill: none; stroke: #fff; stroke-width: 2.5; stroke-dasharray: 6 4; }
.stg-node.faded { opacity: .14; }
.stg-root-ring { fill: none; stroke: #f0c040; stroke-width: 3; filter: drop-shadow(0 0 6px rgba(240,192,64,.7)); }
.stg-root-t { fill: #f8ffd8; font: 700 26px system-ui, sans-serif; }
`;
