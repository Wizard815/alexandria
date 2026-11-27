// Copied from Wizard815/DND-Spell-Tree src/tree/TreeGraph.tsx by scripts/sync-alexandria.sh: change it there.
// The spell tree drawn as a web of spells, the way many games draw a skill
// tree: the character in the middle, a region for each school of magic
// around it, and spell levels moving outward ring by ring (cantrips closest).
// Spells link to the nearest spells one level in: inside their school, and in
// the early rings across into the neighbouring schools too; spells that share
// an element (fire, cold...) link across regions with that element's colour.
// Hybrid spells wear both elements' colours. Known spells and the links
// between them glow gold; spells that can be learned are bright, locked ones
// dim, unknown ones dark. Drag to pan, wheel or pinch to zoom; click (or
// Enter on) a spell to open it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { ELEMENT_COLOR, SCHOOL_COLOR } from './treeCss.ts';
import { GlyphMark, glyphFor } from './icons.tsx';
import type { TreeData, TreeSpell, TreeStatus } from './types.ts';

export const STATUS_LABEL: Record<TreeStatus, string> = {
  known: 'Known', gift: 'Gift', studying: 'Studying', stopped: 'Paused', learn: 'Can learn', locked: 'Locked', hidden: 'Hidden recipe', dark: 'Unknown',
};
const levelName = (n: number) => (n === 0 ? 'Cantrip' : `Level ${n}`);

// Layout, in SVG units, around the centre (0, 0).
const RING0 = 400; // the cantrip ring
const STEP = 165; // between level rings
const SPACE = 86; // the least room a spell needs along its ring
const SUBRING = 64; // between the sub-rings of a crowded level
// Schools next to each other share the most elements, so the web crosses where it makes sense.
const SCHOOL_ORDER = ['Evocation', 'Conjuration', 'Transmutation', 'Abjuration', 'Divination', 'Enchantment', 'Illusion', 'Necromancy'];
const ELEMENT_ORDER = ['Necrotic', 'Poison', 'Acid', 'Fire', 'Lightning', 'Thunder', 'Cold', 'Force', 'Radiant', 'Psychic'];

const isKnown = (s: TreeSpell) => s.status === 'known' || s.status === 'gift';
const radiusOf = (level: number) => RING0 + level * STEP;
/** Where the school names sit: the open ring between the start and the cantrips. */
const LABEL_R = RING0 - 150;
const nodeR = (level: number) => 20 + level * 1.2;

interface Node { s: TreeSpell; x: number; y: number; a: number; sector: number }
interface Sector { name: string; color: string; a0: number; a1: number; spells: TreeSpell[]; known: number }
interface Edge { a: Node | null; b: Node; kind: 'tree' | 'cross' | 'element'; color?: string }

const elemKey = (s: TreeSpell) => {
  const i = s.lines.map((l) => ELEMENT_ORDER.indexOf(l)).filter((x) => x >= 0);
  return i.length ? Math.min(...i) : ELEMENT_ORDER.length / 2;
};

function layout(data: TreeData) {
  const spells = [...data.schools.flatMap((g) => g.spells), ...data.hybrids];
  const names = [...new Set(spells.map((s) => s.school || 'Others'))];
  const order = [...SCHOOL_ORDER.filter((n) => names.includes(n)), ...names.filter((n) => !SCHOOL_ORDER.includes(n) && n !== 'Others').sort(), ...(names.includes('Others') ? ['Others'] : [])];
  const weight = (n: string) => Math.max(14, spells.filter((s) => (s.school || 'Others') === n).length);
  const total = order.reduce((a, n) => a + weight(n), 0);
  const GAP = 0.05;
  let a = -Math.PI / 2;
  const sectors: Sector[] = order.map((name) => {
    const span = (weight(name) / total) * Math.PI * 2;
    const list = spells.filter((s) => (s.school || 'Others') === name);
    const sec = { name, color: SCHOOL_COLOR[name] ?? SCHOOL_COLOR.Others, a0: a + GAP / 2, a1: a + span - GAP / 2, spells: list, known: list.filter(isKnown).length };
    a += span;
    return sec;
  });
  const nodes: Node[] = [];
  sectors.forEach((sec, si) => {
    for (let lv = 0; lv <= 9; lv++) {
      const list = sec.spells.filter((s) => s.level === lv).sort((x, y) => elemKey(x) - elemKey(y) || x.name.localeCompare(y.name));
      if (!list.length) continue;
      const r = radiusOf(lv);
      const span = sec.a1 - sec.a0;
      const k = Math.max(1, Math.ceil((list.length * SPACE) / (span * r)));
      // Crowded: deal the spells round-robin onto k staggered sub-rings.
      for (let ring = 0; ring < k; ring++) {
        const mine = list.filter((_, i) => i % k === ring);
        const rr = r + (ring - (k - 1) / 2) * SUBRING;
        mine.forEach((s, j) => {
          const t = (j + 0.5 + (k > 1 ? (ring / k) - 0.5 + 0.5 / k : 0)) / mine.length;
          const ang = sec.a0 + span * Math.max(0.02, Math.min(0.98, t));
          nodes.push({ s, x: rr * Math.cos(ang), y: rr * Math.sin(ang), a: ang, sector: si });
        });
      }
    }
  });
  // The web.
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const add = (x: Node | null, y: Node, kind: Edge['kind'], color?: string) => {
    const key = [x?.s.id ?? 'root', y.s.id].sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ a: x, b: y, kind, color });
  };
  const d = (p: Node, q: Node) => Math.hypot(p.x - q.x, p.y - q.y);
  const nearest = (n: Node, pool: Node[]) => pool.reduce<Node | null>((best, q) => (!best || d(n, q) < d(n, best) ? q : best), null);
  for (const n of nodes) {
    const sameIn = nodes.filter((q) => q.sector === n.sector && q.s.level < n.s.level);
    const lowest = !sameIn.length;
    if (lowest) add(null, n, 'tree');
    else {
      const lv = Math.max(...sameIn.map((q) => q.s.level));
      const p = nearest(n, sameIn.filter((q) => q.s.level === lv));
      if (p) add(p, n, 'tree');
    }
    // Early rings reach across into the neighbouring schools.
    if (n.s.level >= 1 && n.s.level <= 3) {
      const other = nodes.filter((q) => q.sector !== n.sector && q.s.level === n.s.level - 1);
      const p = nearest(n, other);
      if (p && d(n, p) < STEP * 1.45) add(p, n, 'cross');
    }
    // Shared elements link across regions.
    if (n.s.level >= 1 && n.s.lines.length) {
      const kin = nodes.filter((q) => q.sector !== n.sector && q.s.level < n.s.level && q.s.level >= n.s.level - 2 && q.s.lines.some((l) => n.s.lines.includes(l)));
      const p = nearest(n, kin);
      if (p && d(n, p) < STEP * 2.6) add(p, n, 'element', ELEMENT_COLOR[p.s.lines.find((l) => n.s.lines.includes(l))!]);
    }
  }
  const R9 = radiusOf(9) + SUBRING * 1.5;
  const pad = 260;
  return { nodes, edges, sectors, rings: Array.from({ length: 10 }, (_, lv) => radiusOf(lv)), blobs: [] as Blob[], links: [] as Link[], box: { x1: -R9 - pad, y1: -R9 - pad, x2: R9 + pad, y2: R9 + pad } };
}

// ---- the bubble layout: each school's spells in bubbles of about four ----
interface Blob { id: string; name: string; x: number; y: number; r: number; state: 'lit' | 'open' | 'shut'; sector: number }
interface Link { x1: number; y1: number; x2: number; y2: number; state: 'lit' | 'open' | 'shut'; root: boolean }
const BUB_GAP = 26; // between bubbles along a ring
const BUB_RING = 34; // between the rings of bubbles
const clusterR = (n: number) => (n <= 1 ? 0 : n === 2 ? 30 : n === 3 ? 36 : n === 4 ? 42 : 50);

function layoutBubbles(data: TreeData) {
  const spells = [...data.schools.flatMap((g) => g.spells), ...data.hybrids];
  const byId = new Map(spells.map((s) => [s.id, s]));
  const bubbles = (data.bubbles ?? []).map((b) => ({ ...b, spells: b.spells.filter((id) => byId.has(id)) })).filter((b) => b.spells.length);
  const names = [...new Set(spells.map((s) => s.school || 'Others'))];
  const order = [...SCHOOL_ORDER.filter((n) => names.includes(n)), ...names.filter((n) => !SCHOOL_ORDER.includes(n) && n !== 'Others').sort(), ...(names.includes('Others') ? ['Others'] : [])];
  const weight = (n: string) => Math.max(10, bubbles.filter((b) => b.school === n).length);
  const total = order.reduce((a, n) => a + weight(n), 0);
  const GAP = 0.04;
  let a0 = -Math.PI / 2;
  const sectors: Sector[] = order.map((name) => {
    const span = (weight(name) / total) * Math.PI * 2;
    const list = spells.filter((s) => (s.school || 'Others') === name);
    const sec = { name, color: SCHOOL_COLOR[name] ?? SCHOOL_COLOR.Others, a0: a0 + GAP / 2, a1: a0 + span - GAP / 2, spells: list, known: list.filter(isKnown).length };
    a0 += span;
    return sec;
  });
  const has = (b: { spells: string[] }) => b.spells.some((id) => { const s = byId.get(id); return !!s && isKnown(s); });
  const bubbleById = new Map(bubbles.map((b) => [b.id, b]));
  const stateOf = (b: (typeof bubbles)[number]): Blob['state'] => (has(b) ? 'lit' : !b.parent || (bubbleById.get(b.parent) && has(bubbleById.get(b.parent)!)) ? 'open' : 'shut');
  const size = (b: (typeof bubbles)[number]) => clusterR(b.spells.length) + nodeR(b.level) + 12;
  // Rings grow outward as far as each level needs: a crowded level takes two or three rings of bubbles.
  const rings: number[] = [];
  const place = new Map<string, { x: number; y: number; a: number; r: number }>();
  let cursor = RING0 - 40;
  for (let lv = 0; lv <= 9; lv++) {
    const per = sectors.map((sec) => bubbles.filter((b) => b.school === sec.name && b.level === lv));
    const deep = Math.max(80, ...per.flat().map(size));
    let k = 1;
    for (;;) {
      const r = cursor + deep + ((k - 1) * (2 * deep + BUB_RING)) / 2;
      if (per.every((list, si) => Math.ceil(list.reduce((t, b) => t + 2 * size(b) + BUB_GAP, 0) / k) <= (sectors[si].a1 - sectors[si].a0) * r) || k >= 4) break;
      k++;
    }
    const mid = cursor + deep + ((k - 1) * (2 * deep + BUB_RING)) / 2;
    rings.push(mid);
    per.forEach((list, si) => {
      const sec = sectors[si];
      const span = sec.a1 - sec.a0;
      for (let ring = 0; ring < k; ring++) {
        const mine = list.filter((_, i) => i % k === ring);
        const rr = cursor + deep + ring * (2 * deep + BUB_RING);
        mine.forEach((b, j) => {
          const t = (j + 0.5 + (k > 1 ? ring / k - 0.5 + 0.5 / k : 0)) / mine.length;
          const ang = sec.a0 + span * Math.max(0.04, Math.min(0.96, t));
          place.set(b.id, { x: rr * Math.cos(ang), y: rr * Math.sin(ang), a: ang, r: size(b) });
        });
      }
    });
    if (per.some((l) => l.length)) cursor += k * (2 * deep) + (k - 1) * BUB_RING + BUB_RING;
    else rings[lv] = cursor;
  }
  const nodes: Node[] = [];
  const blobs: Blob[] = [];
  for (const b of bubbles) {
    const p = place.get(b.id);
    if (!p) continue;
    const si = sectors.findIndex((x) => x.name === b.school);
    blobs.push({ id: b.id, name: b.name, x: p.x, y: p.y, r: p.r, state: stateOf(b), sector: si });
    const cr = clusterR(b.spells.length);
    b.spells.forEach((id, j) => {
      const s = byId.get(id)!;
      const phi = p.a + Math.PI + (2 * Math.PI * j) / b.spells.length + (b.spells.length === 2 ? Math.PI / 2 : 0);
      nodes.push({ s, x: p.x + cr * Math.cos(phi), y: p.y + cr * Math.sin(phi), a: p.a, sector: si });
    });
  }
  const links: Link[] = [];
  for (const b of bubbles) {
    const p = place.get(b.id);
    if (!p) continue;
    const st = stateOf(b);
    const par = b.parent ? place.get(b.parent) : null;
    const pb = b.parent ? bubbleById.get(b.parent) : null;
    const from = par ?? { x: 0, y: 0, r: 70 };
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const lit = st === 'lit' && (!pb || has(pb));
    links.push({ x1: from.x + (dx / len) * from.r, y1: from.y + (dy / len) * from.r, x2: p.x - (dx / len) * p.r, y2: p.y - (dy / len) * p.r, state: lit ? 'lit' : st === 'shut' ? 'shut' : 'open', root: !par });
  }
  const R9 = Math.max(...rings) + 160;
  const pad = 260;
  return { nodes, edges: [] as Edge[], sectors, rings, blobs, links, box: { x1: -R9 - pad, y1: -R9 - pad, x2: R9 + pad, y2: R9 + pad } };
}

/** Unknown spells keep their secret on the web: no name, no glyph. */
const secret = (s: TreeSpell) => s.status === 'dark' || s.status === 'hidden';
/** An arc for a school's name to sit on, read left to right on both halves. */
const arc = (r: number, a0: number, a1: number) => {
  const mid = (a0 + a1) / 2;
  const flip = Math.sin(mid) > 0.15; // the lower half reads the other way round
  const [s, e] = flip ? [a1, a0] : [a0, a1];
  return `M${r * Math.cos(s)},${r * Math.sin(s)}A${r},${r} 0 0 ${flip ? 0 : 1} ${r * Math.cos(e)},${r * Math.sin(e)}`;
};
const short = (name: string, n: number) => (name.length > n ? `${name.slice(0, n - 1)}…` : name);
/** A gentle curve between two points, bowed around the centre like the rings. */
const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const len = Math.hypot(mx, my) || 1;
  const bow = Math.min(40, Math.hypot(x2 - x1, y2 - y1) * 0.12);
  return `M${x1},${y1}Q${mx + (mx / len) * bow},${my + (my / len) * bow} ${x2},${y2}`;
};

export interface TreeGraphProps {
  data: TreeData;
  sel: string | null;
  onPick: (id: string) => void;
  /** Spells to fade (a search or filter that leaves them out). */
  dim?: (s: TreeSpell) => boolean;
}

export default function TreeGraph({ data, sel, onPick, dim }: TreeGraphProps) {
  const L = useMemo(() => (data.bubbles?.length ? layoutBubbles(data) : layout(data)), [data]);
  const byName = useMemo(() => new Map(L.nodes.map((p) => [p.s.name, p])), [L]);
  const picked = L.nodes.find((p) => p.s.id === sel) ?? null;

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
    const b = L.box;
    const k = clampK(Math.min(w / (b.x2 - b.x1), h / (b.y2 - b.y1)));
    setView({ k, x: w / 2 - ((b.x1 + b.x2) / 2) * k, y: h / 2 - ((b.y1 + b.y2) / 2) * k });
  }, [L.box]);
  /** The start in the middle, the first rings readable around it. */
  const home = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const k = clampK(Math.min(w, h) / (2 * ((L.rings[1] ?? RING0 + STEP) + 0.6 * STEP)));
    setView({ k, x: w / 2, y: h / 2 });
  }, [L.rings]);
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

  const recipe = picked ? picked.s.from.map((n) => byName.get(n)).filter((p): p is Node => !!p) : [];
  const allLabels = view.k >= 0.95;
  const labelled = (s: TreeSpell) => view.k >= 0.22 && (allLabels || sel === s.id || isKnown(s) || s.status === 'learn' || s.status === 'studying' || s.status === 'stopped');
  const R9 = L.rings[9] ?? radiusOf(9);
  // Names keep a readable size on screen when zoomed out.
  const nameSize = 13 * Math.max(1, 0.75 / view.k);
  // Names that would overlap another name are left off; the picked spell, then
  // known, studying and learnable spells win. Hover or zoom in to see the rest.
  const shown = useMemo(() => {
    const rank = (s: TreeSpell) => (s.id === sel ? 0 : isKnown(s) ? 1 : s.status === 'studying' || s.status === 'stopped' ? 2 : s.status === 'learn' ? 3 : 4);
    const want = L.nodes.filter((p) => !secret(p.s) && labelled(p.s)).sort((a, b) => rank(a.s) - rank(b.s));
    const boxes: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const out = new Set<string>();
    for (const p of want) {
      const text = p.s.id === sel ? p.s.name : short(p.s.name, allLabels ? 18 : 13);
      const w = text.length * nameSize * 0.56;
      const y = p.y + nodeR(p.s.level) + 6;
      const b = { x1: p.x - w / 2 - 3, x2: p.x + w / 2 + 3, y1: y, y2: y + nameSize * 1.2 };
      if (p.s.id !== sel && boxes.some((o) => b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1)) continue;
      boxes.push(b);
      out.add(p.s.id);
    }
    return out;
  }, [L, sel, nameSize, allLabels]);

  return (
    <div className="stg" ref={box} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className="stg-tools" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" className="st-btn small" aria-label="Zoom in" onClick={() => { const el = box.current!; zoomAt(el.clientWidth / 2, el.clientHeight / 2, 1.3); }}>+</button>
        <button type="button" className="st-btn small" aria-label="Zoom out" onClick={() => { const el = box.current!; zoomAt(el.clientWidth / 2, el.clientHeight / 2, 1 / 1.3); }}>−</button>
        <button type="button" className="st-btn small" onClick={home}>Start</button>
        <button type="button" className="st-btn small" onClick={fit}>All</button>
      </div>
      <svg width="100%" height="100%" role="img" aria-label={`Spell tree: ${L.nodes.length} spells`}>
        <defs>
          <radialGradient id="stg-gold" cx="40%" cy="35%" r="70%"><stop offset="0" stopColor="#ffe7a8" /><stop offset=".55" stopColor="#d9a24a" /><stop offset="1" stopColor="#8a5a1c" /></radialGradient>
          <radialGradient id="stg-open" cx="40%" cy="35%" r="70%"><stop offset="0" stopColor="#ffffff" /><stop offset=".6" stopColor="#cfd2da" /><stop offset="1" stopColor="#80869a" /></radialGradient>
          <radialGradient id="stg-dim" cx="40%" cy="35%" r="70%"><stop offset="0" stopColor="#6b5a45" /><stop offset="1" stopColor="#2b2219" /></radialGradient>
          <radialGradient id="stg-core" cx="50%" cy="45%" r="60%"><stop offset="0" stopColor="#fff6c8" /><stop offset=".5" stopColor="#f0b440" /><stop offset="1" stopColor="#7a4a10" /></radialGradient>
          <filter id="stg-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="5" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* Faint level rings and the borders between schools. */}
          {L.rings.map((r, lv) => <circle key={`ring${lv}`} r={r} className="stg-ring" />)}
          {L.sectors.map((sec) => (
            <line key={`b${sec.name}`} className="stg-border" x1={(RING0 - 70) * Math.cos(sec.a0 - 0.025)} y1={(RING0 - 70) * Math.sin(sec.a0 - 0.025)} x2={(R9 + 90) * Math.cos(sec.a0 - 0.025)} y2={(R9 + 90) * Math.sin(sec.a0 - 0.025)} />
          ))}
          {/* Region names. */}
          {L.sectors.map((sec) => {
            const mid = (sec.a0 + sec.a1) / 2;
            const r = R9 + 190;
            return (
              <g key={`n${sec.name}`} role="group" aria-label={sec.name}>
                <text className="stg-region" x={r * Math.cos(mid)} y={r * Math.sin(mid)} fill={sec.color} textAnchor="middle">{sec.name.toUpperCase()}</text>
                <text className="stg-region-n" x={r * Math.cos(mid)} y={r * Math.sin(mid) + 40} textAnchor="middle">{sec.known} of {sec.spells.length}</text>
                <path id={`stg-arc-${sec.name}`} d={arc(LABEL_R, sec.a0, sec.a1)} fill="none" />
                <text className="stg-region-inner" fill={sec.color} dy={Math.sin(mid) > 0.15 ? 20 : 0} style={{ fontSize: Math.max(22, Math.min(36, (0.9 * LABEL_R * (sec.a1 - sec.a0)) / (sec.name.length * 0.62))) }}>
                  <textPath href={`#stg-arc-${sec.name}`} startOffset="50%" textAnchor="middle">{sec.name}</textPath>
                </text>
              </g>
            );
          })}
          {/* Bubbles and the paths between them. */}
          {L.links.map((e, i) => <path key={`l${i}`} className={`stg-link ${e.state}`} d={curve(e.x1, e.y1, e.x2, e.y2)} />)}
          {L.blobs.map((b) => (
            <circle key={b.id} cx={b.x} cy={b.y} r={b.r} className={`stg-bubble ${b.state}`} style={{ stroke: b.state === 'shut' ? undefined : L.sectors[b.sector]?.color }}>
              <title>{b.name}{b.state === 'shut' ? ': learn a spell in the bubble before it to open it' : b.state === 'open' ? ': open, learn any spell in it' : ''}</title>
            </circle>
          ))}
          {/* The web. */}
          {L.edges.map((e, i) => {
            const ax = e.a?.x ?? 0;
            const ay = e.a?.y ?? 0;
            const aKnown = e.a ? isKnown(e.a.s) : true;
            const bKnown = isKnown(e.b.s);
            const lit = aKnown && bKnown;
            const open = !lit && (aKnown || bKnown) && (e.b.s.status === 'learn' || e.a?.s.status === 'learn');
            return <path key={i} className={`stg-edge ${e.kind}${lit ? ' lit' : open ? ' open' : ''}`} d={curve(ax, ay, e.b.x, e.b.y)} style={e.kind === 'element' && !lit ? { stroke: e.color } : undefined} />;
          })}
          {picked && recipe.map((p) => <path key={`r${p.s.id}`} className="stg-recipe" d={`M${p.x},${p.y}L${picked.x},${picked.y}`} />)}
          {L.nodes.map((p) => {
            const s = p.s;
            const r = nodeR(s.level);
            const faded = dim?.(s) ?? false;
            const pct = s.study ? Math.max(0, Math.min(1, s.study.banked / Math.max(1, s.study.needed))) : 0;
            const circ = 2 * Math.PI * (r + 5);
            const two = s.hybrid && s.lines.length >= 2;
            const rim = L.sectors[p.sector].color;
            const hid = secret(s);
            const glyph = glyphFor(s);
            return (
              <g key={s.id} className={`stg-node s-${s.status}${sel === s.id ? ' sel' : ''}${faded ? ' faded' : ''}`} transform={`translate(${p.x},${p.y})`}
                role="button" tabIndex={0} aria-label={hid ? `Unknown spell, ${levelName(s.level)}` : `${s.name}, ${levelName(s.level)}, ${STATUS_LABEL[s.status]}`} aria-pressed={sel === s.id}
                onClick={() => pick(s.id)} onKeyDown={key(s.id)}>
                <title>{hid ? `Unknown spell (${levelName(s.level)}, ${s.school})` : `${s.name} (${levelName(s.level)}, ${s.school}${s.lines.length ? `, ${s.lines.join(' + ')}` : ''}): ${STATUS_LABEL[s.status]}`}</title>
                <circle r={L.blobs.length ? r + 9 : Math.max(r + 8, 18 / view.k)} className="stg-hit" />
                {sel === s.id && <circle r={r + 10} className="stg-selring" />}
                <circle r={r} className="stg-disc" style={{ stroke: two ? 'transparent' : rim }} filter={isKnown(s) || s.status === 'learn' ? 'url(#stg-glow)' : undefined} />
                {two && (
                  <>
                    <path d={`M0,${-r}A${r},${r} 0 0 0 0,${r}`} fill="none" stroke={ELEMENT_COLOR[s.lines[0]] ?? rim} strokeWidth={3.5} />
                    <path d={`M0,${-r}A${r},${r} 0 0 1 0,${r}`} fill="none" stroke={ELEMENT_COLOR[s.lines[1]] ?? rim} strokeWidth={3.5} />
                  </>
                )}
                {s.study && <circle r={r + 5} className="stg-prog" strokeDasharray={`${pct * circ} ${circ}`} transform="rotate(-90)" />}
                {!hid && <GlyphMark g={glyph.g} size={r * 1.15} className="stg-ini" />}
                {!hid && shown.has(s.id) && <text className="stg-name" y={r + 6 + nameSize} textAnchor="middle" style={{ fontSize: nameSize }}>{sel === s.id ? s.name : short(s.name, allLabels ? 18 : 13)}</text>}
              </g>
            );
          })}
          {/* The centre: the character. */}
          <g className="stg-root">
            <circle r={78} className="stg-root-halo" />
            <circle r={52} fill="url(#stg-core)" filter="url(#stg-glow)" />
            <text y={12} textAnchor="middle" className="stg-root-t">✦</text>
          </g>
        </g>
      </svg>
    </div>
  );
}

export const GRAPH_CSS = `
.stg { position: relative; height: max(440px, calc(100vh - 190px)); min-height: 440px; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; touch-action: none; user-select: none; cursor: grab;
  background: radial-gradient(ellipse at 50% 50%, #3a1f4a 0%, #1f1029 40%, #0d0812 85%), #0d0812; }
.stg::before { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(circle at 20% 30%, rgba(160, 60, 140, .22), transparent 40%), radial-gradient(circle at 80% 70%, rgba(60, 80, 170, .2), transparent 45%); }
.stg:active { cursor: grabbing; }
.stg svg { display: block; position: relative; }
.stg-tools { position: absolute; right: 10px; top: 10px; display: flex; gap: 6px; z-index: 2; }
.stg-tools .st-btn { background: rgba(20,14,26,.85); color: #eee; border-color: #4a3a55; min-width: 34px; }
.stg-ring { fill: none; stroke: rgba(255,255,255,.04); stroke-width: 1; }
.stg-border { stroke: rgba(255,255,255,.07); stroke-width: 1.5; stroke-dasharray: 4 10; }
.stg-region { paint-order: stroke; stroke: #0d0812; stroke-width: 8px; font: 700 52px Georgia, "Times New Roman", serif; letter-spacing: .08em; opacity: .9; }
.stg-region-n { fill: #d4c6e0; font: 22px system-ui, sans-serif; paint-order: stroke; stroke: #0d0812; stroke-width: 5px; }
.stg-region-inner { font: 700 30px Georgia, serif; letter-spacing: .04em; paint-order: stroke; stroke: #120c1c; stroke-width: 7px; }
.stg-edge { fill: none; stroke: rgba(205, 180, 150, .28); stroke-width: 2; }
.stg-edge.cross { stroke-dasharray: 2 6; stroke: rgba(205, 180, 150, .3); }
.stg-edge.element { stroke-width: 1.6; opacity: .35; stroke-dasharray: 8 6; }
.stg-edge.open { stroke: rgba(255,255,255,.65); stroke-width: 2.4; opacity: 1; stroke-dasharray: none; }
.stg-edge.lit { stroke: #e9a94a; stroke-width: 3.2; opacity: 1; stroke-dasharray: none; filter: drop-shadow(0 0 4px rgba(240,170,70,.8)); }
.stg-bubble { fill: rgba(255,255,255,.035); stroke: rgba(255,255,255,.12); stroke-width: 2; }
.stg-bubble.open { fill: rgba(255,255,255,.07); stroke-width: 2.5; stroke-dasharray: 6 5; }
.stg-bubble.lit { fill: rgba(240,180,64,.10); stroke-width: 3; filter: drop-shadow(0 0 6px rgba(240,170,70,.45)); }
.stg-bubble.shut { stroke: rgba(255,255,255,.08); }
.stg-link { fill: none; stroke: rgba(205,180,150,.22); stroke-width: 3; }
.stg-link.open { stroke: rgba(255,255,255,.6); stroke-dasharray: 8 6; }
.stg-link.lit { stroke: #e9a94a; stroke-width: 4.5; filter: drop-shadow(0 0 4px rgba(240,170,70,.8)); }
.stg-recipe { stroke: #fff; stroke-width: 2.2; stroke-dasharray: 3 6; fill: none; opacity: .9; }
.stg-node { cursor: pointer; outline: none; }
.stg-hit { fill: transparent; }
.stg-node .stg-disc { stroke-width: 3; }
.stg-node .stg-ini { pointer-events: none; }
.stg-node .stg-name { font: 12.5px system-ui, sans-serif; pointer-events: none; paint-order: stroke; stroke: #0d0812; stroke-width: 3px; }
.stg-node.s-known .stg-disc, .stg-node.s-gift .stg-disc { fill: url(#stg-gold); }
.stg-node.s-known .stg-ini, .stg-node.s-gift .stg-ini { color: #3b2200; }
.stg-node.s-known .stg-name, .stg-node.s-gift .stg-name { fill: #ffd98a; }
.stg-node.s-learn .stg-disc { fill: url(#stg-open); }
.stg-node.s-learn .stg-ini { color: #20232b; }
.stg-node.s-learn .stg-name { fill: #f4f4f8; font-weight: 600; }
.stg-node.s-studying .stg-disc, .stg-node.s-stopped .stg-disc { fill: url(#stg-dim); }
.stg-node.s-stopped .stg-disc { stroke-dasharray: 4 3; }
.stg-node.s-studying .stg-ini, .stg-node.s-stopped .stg-ini { color: #f2e6d6; }
.stg-node.s-studying .stg-name, .stg-node.s-stopped .stg-name { fill: #f2e6d6; }
.stg-prog { fill: none; stroke: #f0b440; stroke-width: 3.5; stroke-linecap: round; }
.stg-node.s-locked .stg-disc { fill: url(#stg-dim); opacity: .85; }
.stg-node.s-locked .stg-ini { color: #c8b8a4; }
.stg-node.s-locked .stg-name { fill: #a8998a; }
.stg-node.s-dark .stg-disc, .stg-node.s-hidden .stg-disc { fill: #19141d; stroke: #2e2733 !important; }
.stg-node.s-dark .stg-name, .stg-node.s-hidden .stg-name { fill: #5a5060; }
.stg-node:hover .stg-disc, .stg-node:focus-visible .stg-disc { stroke: #fff !important; stroke-width: 3.5; }
.stg-selring { fill: none; stroke: #fff; stroke-width: 2.5; stroke-dasharray: 6 4; }
.stg-node.faded { opacity: .12; }
.stg-root-halo { fill: none; stroke: rgba(240,180,64,.55); stroke-width: 2; stroke-dasharray: 3 7; }
.stg-root-t { fill: #fffbe0; font: 700 34px system-ui, sans-serif; pointer-events: none; }
`;
