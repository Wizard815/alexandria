// The GM's workspace: the main area split into 1 to 4 panes, each showing a GM page. This file is the pure part (no React):
// the state, how it reads and writes the URL (/w/:world/gm/ws?l=cols&p=combat,sound&s=50,50&f=0), the operations the menu and
// the workspace both use, the presets and the saved layouts kept in the browser.

export type LayoutId = 'one' | 'cols' | 'rows' | 'grid' | 'side';

export interface LayoutDef { id: LayoutId; label: string; icon: string; min: number; max: number; desc: string }
export const LAYOUTS: LayoutDef[] = [
  { id: 'one', label: 'Single', icon: 'fa-square', min: 1, max: 1, desc: 'One page fills the window' },
  { id: 'cols', label: 'Side by side', icon: 'fa-table-columns', min: 2, max: 4, desc: 'Two to four columns' },
  { id: 'rows', label: 'Stacked', icon: 'fa-bars-staggered', min: 2, max: 4, desc: 'Two to four rows' },
  { id: 'grid', label: '2 × 2', icon: 'fa-table-cells-large', min: 4, max: 4, desc: 'Four panes in a grid' },
  { id: 'side', label: 'Main + side', icon: 'fa-table-columns fa-flip-horizontal', min: 2, max: 4, desc: 'One big pane and a column of smaller ones' },
];
export const layoutDef = (id: LayoutId): LayoutDef => LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[1];
export const MAX_PANES = 4;
/** Drag-and-drop types: a menu row (a page id) or a pane header (its index). */
export const PAGE_MIME = 'application/x-alx-page';
export const PANE_MIME = 'application/x-alx-pane';

export interface Workspace {
  l: LayoutId;
  /** Page ids: a GM route ('combat'; 'table' for the table page) or one of the panel-only ids ('assistant', 'transcript', 'fog'). */
  p: string[];
  /** Percentages. cols/rows: one per pane. grid: [first row's height, first column's width]. side: [main's width, ...the side column's panes' heights]. */
  s: number[];
  /** The focused pane (where a menu click opens). */
  f: number;
  /** The maximised pane, if any. */
  z: number | null;
}

/** What fills a new pane, in the order tried (those already open are skipped). */
const FILL = ['combat', 'sound', 'inbox', 'scenes', 'library', 'quick', 'table', 'clock', 'assistant', 'transcript'];

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const equal = (n: number): number[] => { const base = Math.floor(100 / n); return Array.from({ length: n }, (_, i) => (i === n - 1 ? 100 - base * (n - 1) : base)); };

export function defaultSizes(l: LayoutId, n: number): number[] {
  if (l === 'cols' || l === 'rows') return equal(n);
  if (l === 'grid') return [50, 50];
  if (l === 'side') return [n === 2 ? 60 : 62, ...equal(Math.max(1, n - 1))];
  return [];
}

/** A layout that can hold `n` panes: three panes in a 2x2 become main + side, and so on. */
export function fitLayout(l: LayoutId, n: number): LayoutId {
  if (n <= 1) return 'one';
  if (l === 'one') return 'cols';
  if (l === 'grid' && n < 4) return 'side';
  return l;
}

const sizesOk = (l: LayoutId, n: number, s: number[]): boolean => {
  const want = defaultSizes(l, n).length;
  if (s.length !== want || s.some((x) => !Number.isFinite(x) || x < 5 || x > 95)) return false;
  if (l === 'cols' || l === 'rows') return Math.abs(s.reduce((a, b) => a + b, 0) - 100) <= 2;
  if (l === 'side') return Math.abs(s.slice(1).reduce((a, b) => a + b, 0) - 100) <= 2;
  return true;
};

/** Make any state (from a URL, from storage) a valid one. */
export function normalize(ws: Partial<Workspace>): Workspace {
  let p = (ws.p ?? []).filter((x) => typeof x === 'string' && x).slice(0, MAX_PANES);
  if (!p.length) p = ['combat', 'sound'];
  let l: LayoutId = LAYOUTS.some((x) => x.id === ws.l) ? (ws.l as LayoutId) : p.length > 1 ? 'cols' : 'one';
  const def = layoutDef(l);
  // More panes than the layout holds: keep the first ones. Fewer: it becomes a layout that fits.
  if (p.length > def.max) p = p.slice(0, def.max);
  l = fitLayout(l, p.length);
  if (p.length < layoutDef(l).min) p = fill(p, layoutDef(l).min);
  const s = ws.s && sizesOk(l, p.length, ws.s) ? ws.s : defaultSizes(l, p.length);
  const f = clamp(Number.isInteger(ws.f) ? (ws.f as number) : 0, 0, p.length - 1);
  const z = ws.z != null && Number.isInteger(ws.z) && ws.z >= 0 && ws.z < p.length && p.length > 1 ? ws.z : null;
  return { l, p, s, f, z };
}

function fill(p: string[], n: number): string[] {
  const out = [...p];
  for (const id of FILL) { if (out.length >= n) break; if (!out.includes(id)) out.push(id); }
  return out;
}

export function parse(search: string): Workspace | null {
  const q = new URLSearchParams(search);
  const p = (q.get('p') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!p.length) return null;
  const s = (q.get('s') ?? '').split(',').map(Number).filter((x) => !Number.isNaN(x));
  const z = q.get('z');
  return normalize({ l: (q.get('l') ?? undefined) as LayoutId | undefined, p, s: s.length ? s : undefined, f: q.has('f') ? Number(q.get('f')) : 0, z: z === null || z === '' ? null : Number(z) });
}

/** The query string (with its "?") for a workspace; defaults are left out. */
export function serialize(ws: Workspace): string {
  const parts = [`l=${ws.l}`, `p=${ws.p.map(encodeURIComponent).join(',')}`];
  if (JSON.stringify(ws.s) !== JSON.stringify(defaultSizes(ws.l, ws.p.length))) parts.push(`s=${ws.s.join(',')}`);
  if (ws.f > 0) parts.push(`f=${ws.f}`);
  if (ws.z !== null) parts.push(`z=${ws.z}`);
  return `?${parts.join('&')}`;
}

export const wsPath = (base: string, ws: Workspace) => `${base}/ws${serialize(ws)}`;

export const pageOfRoute = (route: string): string => route || 'table';
export const routeOfPage = (id: string): string => (id === 'table' ? '' : id);

// ---- operations (each returns a new state) ----

export function setLayout(ws: Workspace, l: LayoutId): Workspace {
  const def = layoutDef(l);
  const n = clamp(ws.p.length, def.min, def.max);
  const p = fill(ws.p.slice(0, n), n);
  return normalize({ l, p, f: Math.min(ws.f, p.length - 1), z: null });
}

/** Show `id` in pane `i`. If it is already in another pane the two swap, so no page shows twice. */
export function openIn(ws: Workspace, i: number, id: string): Workspace {
  const at = ws.p.indexOf(id);
  const p = [...ws.p];
  if (at === i) return { ...ws, f: i };
  if (at >= 0) p[at] = p[i];
  p[i] = id;
  return { ...ws, p, f: i, s: ws.s };
}

/** Open `id` in a pane next to the focused one: a new pane if there is room, else it replaces the one after the focused pane. */
export function openBeside(ws: Workspace, id: string): Workspace {
  const at = ws.p.indexOf(id);
  if (at >= 0) return { ...ws, f: at, z: null };
  if (ws.l === 'one') return normalize({ l: 'cols', p: [...ws.p, id], f: 1 });
  if (ws.p.length < MAX_PANES) return normalize({ l: ws.l, p: [...ws.p, id], f: ws.p.length });
  const target = (ws.f + 1) % ws.p.length;
  const p = [...ws.p];
  p[target] = id;
  return { ...ws, p, f: target, z: null };
}

export function closePane(ws: Workspace, i: number): Workspace {
  if (ws.p.length <= 1) return ws;
  const p = ws.p.filter((_, j) => j !== i);
  return normalize({ l: ws.l, p, f: Math.min(ws.f > i ? ws.f - 1 : ws.f, p.length - 1) });
}

export function swapPanes(ws: Workspace, i: number, j: number): Workspace {
  if (i === j || i < 0 || j < 0 || i >= ws.p.length || j >= ws.p.length) return ws;
  const p = [...ws.p];
  [p[i], p[j]] = [p[j], p[i]];
  return { ...ws, p, f: ws.f === i ? j : ws.f === j ? i : ws.f, z: ws.z === i ? j : ws.z === j ? i : ws.z };
}

export const withFocus = (ws: Workspace, f: number): Workspace => (f === ws.f ? ws : { ...ws, f });
export const withSizes = (ws: Workspace, s: number[]): Workspace => ({ ...ws, s });
export const toggleMax = (ws: Workspace, i: number): Workspace => ({ ...ws, f: i, z: ws.z === i ? null : i });

/** Move the divider that sits between sizes[a] and sizes[b] (b null: sizes[a] alone), from the sizes at the start of a drag. */
export function resizeSizes(start: number[], a: number, b: number | null, deltaPct: number): number[] {
  const s = [...start];
  if (b === null) { s[a] = Math.round(clamp(start[a] + deltaPct, 15, 85)); return s; }
  const total = start[a] + start[b];
  const na = Math.round(clamp(start[a] + deltaPct, 10, total - 10));
  s[a] = na; s[b] = total - na;
  return s;
}

// ---- presets and saved layouts ----

export interface LayoutRec { id: string; name: string; l: LayoutId; p: string[]; s: number[]; /** A world's slug when it belongs to that world only. */ world: string | null; preset?: boolean }

export const PRESETS: LayoutRec[] = [
  { id: 'preset-combat', name: 'Combat night', l: 'side', p: ['combat', 'sound', 'inbox'], s: [62, 55, 45], world: null, preset: true },
  { id: 'preset-prep', name: 'Prep', l: 'cols', p: ['library', 'assistant'], s: [60, 40], world: null, preset: true },
  { id: 'preset-table', name: 'Full table', l: 'grid', p: ['combat', 'sound', 'inbox', 'scenes'], s: [50, 50], world: null, preset: true },
];

export const recWorkspace = (r: LayoutRec): Workspace => normalize({ l: r.l, p: r.p, s: r.s, f: 0, z: null });

const SAVED_KEY = 'alx.ws.layouts';
const LAST_KEY = 'alx.ws.last.';
export const LAYOUTS_EVENT = 'alx-ws-layouts';

function readJSON<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
function writeJSON(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: lasts for this page only */ } }

export function loadSaved(slug: string): LayoutRec[] {
  const all = readJSON<LayoutRec[]>(SAVED_KEY, []);
  if (!Array.isArray(all)) return [];
  return all.filter((r) => r && typeof r.name === 'string' && Array.isArray(r.p) && (r.world == null || r.world === slug)).map((r) => ({ ...r, world: r.world ?? null }));
}

export function saveLayout(slug: string, name: string, ws: Workspace, thisWorld: boolean): LayoutRec {
  const all = readJSON<LayoutRec[]>(SAVED_KEY, []);
  const world = thisWorld ? slug : null;
  const rec: LayoutRec = { id: `l-${Date.now().toString(36)}`, name: name.trim().slice(0, 40), l: ws.l, p: ws.p, s: ws.s, world };
  // The same name in the same scope is replaced.
  const next = [...(Array.isArray(all) ? all : []).filter((r) => !(r.name.toLowerCase() === rec.name.toLowerCase() && (r.world ?? null) === world)), rec];
  writeJSON(SAVED_KEY, next);
  try { window.dispatchEvent(new Event(LAYOUTS_EVENT)); } catch { /* no window */ }
  return rec;
}

export function deleteLayout(id: string) {
  const all = readJSON<LayoutRec[]>(SAVED_KEY, []);
  writeJSON(SAVED_KEY, (Array.isArray(all) ? all : []).filter((r) => r.id !== id));
  try { window.dispatchEvent(new Event(LAYOUTS_EVENT)); } catch { /* no window */ }
}

/** The GM can put the workspace away (this browser): its button leaves the strip until it is brought back from the world menu. */
const HIDE_KEY = 'alx.ws.hidden';
export const workspaceHidden = (): boolean => readJSON<boolean>(HIDE_KEY, false) === true;
export function setWorkspaceHidden(v: boolean) { writeJSON(HIDE_KEY, v); try { window.dispatchEvent(new Event(LAYOUTS_EVENT)); } catch { /* no window */ } }
/** Forget the panes that were open (and, if asked, every saved layout). */
export function clearWorkspace(slug: string, saved = false) {
  try { localStorage.removeItem(LAST_KEY + slug); if (saved) localStorage.removeItem(SAVED_KEY); } catch { /* storage blocked */ }
  try { window.dispatchEvent(new Event(LAYOUTS_EVENT)); } catch { /* no window */ }
}

export const rememberLast = (slug: string, ws: Workspace) => writeJSON(LAST_KEY + slug, ws);
export function recallLast(slug: string): Workspace | null {
  const raw = readJSON<Partial<Workspace> | null>(LAST_KEY + slug, null);
  return raw && Array.isArray(raw.p) ? normalize(raw) : null;
}
