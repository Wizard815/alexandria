// /w/:world/dm/ws: the GM's workspace. The main area is split into 1 to 4 panes, each showing any GM page. The state (layout,
// pages, sizes, focused and maximised pane) lives in the URL, so a reload or a bookmark brings it back; the last one is also
// remembered per world, and layouts can be named and saved (lib/workspace.ts). One world event stream serves every pane: they
// are all inside the one WorldProvider.
import { Component, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useWorld } from '../../lib/world.tsx';
import { DM_GROUPS } from '../../lib/dmnames.ts';
import {
  LAYOUTS, MAX_PANES, PAGE_MIME, PANE_MIME, PRESETS, closePane, deleteLayout, layoutDef, loadSaved, LAYOUTS_EVENT, openIn, parse, recWorkspace, recallLast, rememberLast, clearWorkspace, setWorkspaceHidden, resizeSizes,
  routeOfPage, saveLayout, serialize, setLayout, swapPanes, toggleMax, withFocus, withSizes, type LayoutRec, type Workspace,
} from '../../lib/workspace.ts';
import PaneRouter from './PaneRouter.tsx';
import { pageChoices, pageMeta, paneRoutes, panelOnly, type PaneRoute } from './pages.tsx';
import '../screens/screens.css';
import './workspace.css';

const DEFAULT: Workspace = { l: 'cols', p: ['combat', 'sound'], s: [50, 50], f: 0, z: null };

function useMedia(q: string): boolean {
  const [on, setOn] = useState(() => (typeof matchMedia === 'function' ? matchMedia(q).matches : false));
  useEffect(() => {
    const m = matchMedia(q);
    const f = () => setOn(m.matches);
    f();
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [q]);
  return on;
}

/** A pane that crashes must not take the workspace with it. */
class Boundary extends Component<{ name: string; children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: Error) { return { err: e.message || 'Something went wrong.' }; }
  render() {
    if (this.state.err) return <div className="ws-empty" role="alert"><p>{this.props.name} could not be shown: {this.state.err}</p><button type="button" className="btn small" onClick={() => this.setState({ err: null })}>Try again</button></div>;
    return this.props.children;
  }
}

interface Geo { cols: string; rows: string; place: CSSProperties[]; divs: { orient: 'v' | 'h'; style: CSSProperties; a: number; b: number | null }[] }

const D = '8px';
const fr = (v: number) => `minmax(0, ${v}fr)`;
const join = (xs: number[]) => xs.map(fr).join(` ${D} `);

function geometry(ws: Workspace, s: number[]): Geo {
  const n = ws.p.length;
  if (ws.z !== null || ws.l === 'one') return { cols: '1fr', rows: '1fr', place: ws.p.map(() => ({ gridColumn: '1', gridRow: '1' })), divs: [] };
  if (ws.l === 'cols') return { cols: join(s), rows: '1fr', place: ws.p.map((_, i) => ({ gridColumn: String(2 * i + 1), gridRow: '1' })), divs: s.slice(0, -1).map((_, i) => ({ orient: 'v' as const, style: { gridColumn: String(2 * i + 2), gridRow: '1' }, a: i, b: i + 1 })) };
  if (ws.l === 'rows') return { cols: '1fr', rows: join(s), place: ws.p.map((_, i) => ({ gridColumn: '1', gridRow: String(2 * i + 1) })), divs: s.slice(0, -1).map((_, i) => ({ orient: 'h' as const, style: { gridColumn: '1', gridRow: String(2 * i + 2) }, a: i, b: i + 1 })) };
  if (ws.l === 'grid') {
    return {
      cols: join([s[1], 100 - s[1]]), rows: join([s[0], 100 - s[0]]),
      place: [{ gridColumn: '1', gridRow: '1' }, { gridColumn: '3', gridRow: '1' }, { gridColumn: '1', gridRow: '3' }, { gridColumn: '3', gridRow: '3' }],
      divs: [{ orient: 'v', style: { gridColumn: '2', gridRow: '1 / 4' }, a: 1, b: null }, { orient: 'h', style: { gridColumn: '1 / 4', gridRow: '2' }, a: 0, b: null }],
    };
  }
  // side: the main pane, and a column of the rest
  const k = n - 1;
  const stack = s.slice(1);
  return {
    cols: join([s[0], 100 - s[0]]), rows: join(stack),
    place: ws.p.map((_, i) => (i === 0 ? { gridColumn: '1', gridRow: '1 / -1' } : { gridColumn: '3', gridRow: String(2 * (i - 1) + 1) })),
    divs: [{ orient: 'v' as const, style: { gridColumn: '2', gridRow: '1 / -1' }, a: 0, b: null }, ...Array.from({ length: k - 1 }, (_, j) => ({ orient: 'h' as const, style: { gridColumn: '3', gridRow: String(2 * j + 2) }, a: 1 + j, b: 2 + j }))],
  };
}

export default function WorkspacePage() {
  const { info, isDM } = useWorld();
  const slug = info.slug;
  const base = `/w/${slug}/dm`;
  const loc = useLocation();
  const nav = useNavigate();
  const parsed = useMemo(() => parse(loc.search), [loc.search]);
  const ws = parsed ?? DEFAULT;
  const phone = useMedia('(max-width: 760px)');
  const [live, setLive] = useState<number[] | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const hints = useRef(new Map<string, string>());
  const routes = useMemo<PaneRoute[]>(paneRoutes, []);
  const choices = useMemo(pageChoices, []);

  // Open with no workspace in the URL: the last one for this world, else the default.
  useEffect(() => { if (!parsed) nav({ search: serialize(recallLast(slug) ?? DEFAULT) }, { replace: true }); }, [parsed, slug, nav]);
  // Leaving through Close or Hide must not be remembered as the last workspace again.
  const leaving = useRef(false);
  useEffect(() => { if (parsed && !leaving.current) rememberLast(slug, parsed); }, [parsed, slug]);
  const leave = useCallback((hide: boolean) => { leaving.current = true; clearWorkspace(slug); if (hide) setWorkspaceHidden(true); nav(`${base}/${routeOfPage(ws.p[ws.f] ?? 'table')}`); }, [slug, nav, base, ws]);
  useEffect(() => { document.title = `Workspace · ${info.name}`; }, [info.name]);

  const commit = useCallback((next: Workspace, push = true) => { nav({ search: serialize(next) }, { replace: !push }); }, [nav]);

  // Alt+1..4 focuses a pane.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !/^Digit[1-4]$/.test(e.code)) return;
      const i = Number(e.code.slice(5)) - 1;
      if (i >= ws.p.length) return;
      e.preventDefault();
      commit(withFocus(ws, i), false);
      document.querySelector<HTMLElement>(`[data-pane="${i}"]`)?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ws, commit]);

  if (!isDM) return <div className="page"><p className="muted">The workspace is for the GM.</p></div>;

  const sizes = live ?? ws.s;
  const z = phone ? ws.f : ws.z;
  const view: Workspace = { ...ws, z };
  const geo = geometry(view, sizes);
  const seen = new Map<string, number>();

  return (
    <div className="ws" data-testid="workspace" data-layout={ws.l} data-panes={ws.p.length}>
      <Toolbar ws={ws} slug={slug} commit={commit} onLeave={leave} />
      <div className="ws-grid" ref={grid} style={{ gridTemplateColumns: geo.cols, gridTemplateRows: geo.rows }}>
        {ws.p.map((id, i) => {
          const n = (seen.get(id) ?? 0) + 1; seen.set(id, n);
          const hidden = z !== null && z !== i;
          return (
            <Pane key={`${id}~${n}`} i={i} id={id} count={ws.p.length} slug={slug} routes={routes} choices={choices}
              focused={ws.f === i} maximised={z === i} hidden={hidden} style={hidden ? { display: 'none' } : geo.place[i]} entry={hints.current.get(id)}
              onFocus={() => { if (ws.f !== i) commit(withFocus(ws, i), false); }}
              onPick={(page) => commit(openIn(ws, i, page))}
              onClose={() => commit(closePane(ws, i))}
              onSwap={() => commit(swapPanes(ws, i, (i + 1) % ws.p.length))}
              onMax={() => commit(toggleMax(ws, i), false)}
              onDropPane={(from) => commit(swapPanes(ws, from, i))}
              onPageNav={(page, entry) => { hints.current.set(page, entry); commit(openIn(ws, i, page), false); }} />
          );
        })}
        {geo.divs.map((d, k) => (
          <Divider key={k} d={d} sizes={sizes} grid={grid} onLive={setLive} onCommit={(s) => { setLive(null); commit(withSizes(ws, s), false); }} />
        ))}
      </div>
    </div>
  );
}

function Divider({ d, sizes, grid, onLive, onCommit }: { d: Geo['divs'][number]; sizes: number[]; grid: React.RefObject<HTMLDivElement | null>; onLive: (s: number[] | null) => void; onCommit: (s: number[]) => void }) {
  const start = useRef<{ x: number; y: number; s: number[]; size: number; last: number[] } | null>(null);
  const v = d.orient === 'v';
  // Keys can repeat faster than the URL (and so `sizes`) updates: build on the last size asked for until the new one arrives.
  const pending = useRef<number[] | null>(null);
  useEffect(() => { pending.current = null; }, [sizes]);
  const value = sizes[d.a];
  const move = (e: React.PointerEvent) => {
    const st = start.current;
    if (!st) return;
    const delta = ((v ? e.clientX - st.x : e.clientY - st.y) / st.size) * 100;
    st.last = resizeSizes(st.s, d.a, d.b, delta);
    onLive(st.last);
  };
  return (
    <div className={`ws-divider ${v ? 'v' : 'h'}`} style={d.style} role="separator" aria-orientation={v ? 'vertical' : 'horizontal'} tabIndex={0}
      aria-label={v ? 'Resize panes (left and right)' : 'Resize panes (up and down)'} aria-valuenow={value} aria-valuemin={10} aria-valuemax={90} title="Drag to resize, arrow keys too, double-click to reset" data-testid="ws-divider"
      onPointerDown={(e) => {
        const r = grid.current?.getBoundingClientRect();
        if (!r) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, y: e.clientY, s: sizes, size: v ? r.width : r.height, last: sizes };
      }}
      onPointerMove={move}
      onPointerUp={() => { const st = start.current; start.current = null; if (st && st.last !== st.s) onCommit(st.last); else onLive(null); }}
      onPointerCancel={() => { start.current = null; onLive(null); }}
      onDoubleClick={() => onCommit(resetPair(sizes, d))}
      onKeyDown={(e) => {
        const dec = v ? 'ArrowLeft' : 'ArrowUp', inc = v ? 'ArrowRight' : 'ArrowDown';
        if (e.key !== dec && e.key !== inc) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 2;
        const next = resizeSizes(pending.current ?? sizes, d.a, d.b, e.key === inc ? step : -step);
        pending.current = next;
        onCommit(next);
      }}>
      <span aria-hidden="true" />
    </div>
  );
}

/** Back to an even split for the two sizes a divider sits between. */
function resetPair(sizes: number[], d: { a: number; b: number | null }): number[] {
  const s = [...sizes];
  if (d.b === null) { s[d.a] = 50; return s; }
  const total = s[d.a] + s[d.b];
  s[d.a] = Math.round(total / 2); s[d.b] = total - s[d.a];
  return s;
}

function Toolbar({ ws, slug, commit, onLeave }: { ws: Workspace; slug: string; commit: (w: Workspace, push?: boolean) => void; onLeave: (hide: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [thisWorld, setThisWorld] = useState(false);
  const [saved, setSaved] = useState<LayoutRec[]>(() => loadSaved(slug));
  const [note, setNote] = useState('');
  useEffect(() => {
    const f = () => setSaved(loadSaved(slug));
    window.addEventListener(LAYOUTS_EVENT, f);
    return () => window.removeEventListener(LAYOUTS_EVENT, f);
  }, [slug]);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const title = (r: LayoutRec) => `${layoutDef(r.l).label}: ${r.p.map((id) => pageMeta(id)?.title ?? id).join(', ')}`;
  const apply = (r: LayoutRec) => { commit(recWorkspace(r)); setOpen(false); };
  const row = (r: LayoutRec) => (
    <li key={r.id} className="ws-layout-row">
      <button type="button" className="ws-layout-name" title={title(r)} data-testid="ws-layout-item" onClick={() => apply(r)}>
        <i className={`fa-solid ${layoutDef(r.l).icon} fa-fw`} aria-hidden="true" /> {r.name}{r.world && <span className="tiny faint"> · this world</span>}
      </button>
      {!r.preset && <button type="button" className="btn small ghost" aria-label={`Delete layout ${r.name}`} onClick={() => deleteLayout(r.id)}>✕</button>}
    </li>
  );
  return (
    <div className="ws-toolbar" role="toolbar" aria-label="Workspace layout">
      <strong className="ws-tb-title"><i className="fa-solid fa-table-columns" aria-hidden="true" /> Workspace</strong>
      <div className="ws-layouts-switch" role="group" aria-label="Arrange panes">
        {LAYOUTS.map((l) => (
          <button key={l.id} type="button" className={`btn small${ws.l === l.id ? ' on' : ''}`} aria-pressed={ws.l === l.id} title={`${l.label}: ${l.desc}`} aria-label={l.label} data-testid={`ws-layout-${l.id}`}
            onClick={() => commit(setLayout(ws, l.id))}>
            <i className={`fa-solid ${l.icon}`} aria-hidden="true" />
          </button>
        ))}
      </div>
      <span className="tiny faint ws-tb-hint">{ws.p.length} of {MAX_PANES} panes</span>
      <div className="ws-saved" ref={wrap}>
        <button type="button" className="btn small" aria-expanded={open} aria-haspopup="true" data-testid="ws-layouts" onClick={() => setOpen((o) => !o)}><i className="fa-solid fa-bookmark" aria-hidden="true" /> Layouts</button>
        {open && (
          <div className="ws-pop card" role="dialog" aria-label="Saved layouts">
            <p className="tiny faint">Presets</p>
            <ul className="ws-layout-list">{PRESETS.map(row)}</ul>
            <p className="tiny faint row between">Yours {saved.length > 0 && <button type="button" className="btn small ghost" onClick={() => { if (window.confirm('Delete every layout you saved?')) clearWorkspace(slug, true); }}>Delete all</button>}</p>
            <ul className="ws-layout-list">{saved.length ? saved.map(row) : <li className="tiny faint">None yet. Arrange the panes, name it below.</li>}</ul>
            <form className="ws-save" onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              saveLayout(slug, name, ws, thisWorld);
              setNote(`Saved “${name.trim()}”.`);
              setName('');
            }}>
              <input type="text" value={name} onChange={(e) => { setName(e.target.value); setNote(''); }} placeholder="Name this layout" aria-label="Layout name" maxLength={40} data-testid="ws-layout-name" />
              <button type="submit" className="btn small primary" disabled={!name.trim()} data-testid="ws-layout-save">Save</button>
              <label className="tiny"><input type="checkbox" checked={thisWorld} onChange={(e) => setThisWorld(e.target.checked)} /> Only this world</label>
            </form>
            {note && <p className="tiny" role="status">{note}</p>}
          </div>
        )}
      </div>
      <button type="button" className="btn small" data-testid="ws-close-all" title="Close the panes and go back to one page" onClick={() => onLeave(false)}><i className="fa-solid fa-xmark" aria-hidden="true" /> Close</button>
      <button type="button" className="btn small ghost" data-testid="ws-hide" title="Put the workspace away. Bring it back from the world menu (top left)." onClick={() => onLeave(true)}>Hide workspaces</button>
    </div>
  );
}

function Pane({ i, id, count, slug, routes, choices, focused, maximised, hidden, style, entry, onFocus, onPick, onClose, onSwap, onMax, onDropPane, onPageNav }: {
  i: number; id: string; count: number; slug: string; routes: PaneRoute[]; choices: ReturnType<typeof pageChoices>;
  focused: boolean; maximised: boolean; hidden: boolean; style: CSSProperties; entry?: string;
  onFocus: () => void; onPick: (id: string) => void; onClose: () => void; onSwap: () => void; onMax: () => void; onDropPane: (from: number) => void; onPageNav: (page: string, entry: string) => void;
}) {
  const meta = pageMeta(id);
  const panel = panelOnly(id);
  const [over, setOver] = useState(false);
  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(PAGE_MIME) || e.dataTransfer.types.includes(PANE_MIME);
  const first = entry ?? `/w/${slug}/dm/${routeOfPage(id)}`;
  // The first location is read once: moving around inside the pane is the pane router's business.
  const firstRef = useRef(first);
  const noRoute = !panel && !meta;
  return (
    <section className={`ws-pane${focused ? ' focused' : ''}${over ? ' drop' : ''}${maximised ? ' max' : ''}`} style={style} data-pane={i} data-page={id} data-testid={`ws-pane-${i}`} aria-label={meta?.title ?? id} aria-hidden={hidden || undefined} tabIndex={-1}
      onPointerDownCapture={onFocus} onFocusCapture={onFocus}
      onDragOver={(e) => { if (accepts(e)) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const page = e.dataTransfer.getData(PAGE_MIME);
        const from = e.dataTransfer.getData(PANE_MIME);
        if (page) { e.preventDefault(); onPick(page); } else if (from !== '') { e.preventDefault(); onDropPane(Number(from)); }
      }}>
      <header className="ws-phead" draggable onDragStart={(e) => { e.dataTransfer.setData(PANE_MIME, String(i)); e.dataTransfer.effectAllowed = 'move'; }}>
        <i className={`fa-solid ${meta?.icon ?? 'fa-circle-question'} fa-fw ws-grab`} aria-hidden="true" title="Drag onto another pane to swap" />
        <select className="ws-pick" value={id} aria-label={`Page in pane ${i + 1}`} data-testid={`ws-pick-${i}`} title={meta?.desc} onChange={(e) => onPick(e.target.value)}>
          {noRoute && <option value={id}>{id} (not available)</option>}
          {[...DM_GROUPS.map((g) => ({ id: g.id as string, label: g.label })), { id: 'panels', label: 'Panels' }].map((g) => {
            const list = choices.filter((c) => c.group === g.id);
            return list.length ? <optgroup key={g.id} label={g.label}>{list.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</optgroup> : null;
          })}
        </select>
        <span className="ws-sp" />
        {count > 1 && <button type="button" className="btn small ghost ws-act" aria-label={`Swap pane ${i + 1} with the next`} title="Swap with the next pane" onClick={onSwap}>⇄</button>}
        {count > 1 && <button type="button" className="btn small ghost ws-act" aria-label={maximised ? `Restore pane ${i + 1}` : `Maximise pane ${i + 1}`} aria-pressed={maximised} title={maximised ? 'Restore' : 'Maximise'} data-testid={`ws-max-${i}`} onClick={onMax}><i className={`fa-solid ${maximised ? 'fa-compress' : 'fa-expand'}`} aria-hidden="true" /></button>}
        {count > 1 && <button type="button" className="btn small ghost ws-act" aria-label={`Close pane ${i + 1}`} title="Close pane" data-testid={`ws-close-${i}`} onClick={onClose}>✕</button>}
      </header>
      <div className={`ws-body${panel ? ' sc-body' : ''}`} data-page={id}>
        <Boundary name={meta?.title ?? id}>
          {panel ? panel.render() : noRoute ? <div className="ws-empty"><p>There is no page called “{id}”. Pick one above.</p></div>
            : <PaneRouter slug={slug} entry={firstRef.current} routes={routes} onPage={onPageNav} />}
        </Boundary>
      </div>
    </section>
  );
}
