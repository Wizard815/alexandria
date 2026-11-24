// The Library file tree: grouped by source, then folders, then pages nested
// under their parent page. Rendered as a windowed list so thousands of pages
// scroll smoothly.
import { LevelChip } from './Levels.tsx';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Blocks.tsx';

import { buildTree, pageIds, type Node, type PageRow } from './treeModel.ts';
export { buildTree, pageIds, type PageRow };

interface Row { node: Node; depth: number }
/** Rows are 32 px on a desktop and 44 px on a phone or any touch screen (a finger needs about that much). */
const rowHeight = () => (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 760px), (pointer: coarse)').matches ? 44 : 32);
/** Room left under the last row so the floating dock never covers it. */
const END_PAD = 84;

export function Tree({ rows, selected, onOpen, onSaveFolder, onShare, saved }: { rows: PageRow[]; selected: string | null; onOpen: (id: string) => void; onSaveFolder?: (ids: string[], label: string) => void; onShare?: (id: string) => void; saved: Set<string> }) {
  const tree = useMemo(() => buildTree(rows), [rows]);
  const [ROW, setRow] = useState(rowHeight);
  useEffect(() => {
    const mq = window.matchMedia?.('(max-width: 760px), (pointer: coarse)');
    if (!mq) return;
    const f = () => setRow(rowHeight());
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // Start with the biggest source open (rows can arrive after the first render).
  const top = tree.length ? tree.reduce((a, b) => (b.count > a.count ? b : a)) : null;
  const only = top?.key ?? null;
  useEffect(() => { if (only) setOpen((o) => (o.size ? o : new Set([only]))); }, [only]);
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(560);

  // Open the path to the selected page.
  useEffect(() => {
    if (!selected) return;
    const path: string[] = [];
    const find = (ns: Node[], trail: string[]): boolean => ns.some((n) => (n.page?.id === selected ? (path.push(...trail), true) : find(n.children, [...trail, n.key])));
    if (find(tree, [])) setOpen((o) => (path.every((k) => o.has(k)) ? o : new Set([...o, ...path])));
  }, [selected, tree]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight || 560));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const flat = useMemo(() => {
    const out: Row[] = [];
    const walk = (ns: Node[], depth: number) => ns.forEach((n) => { out.push({ node: n, depth }); if (n.children.length && open.has(n.key)) walk(n.children, depth + 1); });
    walk(tree, 0);
    return out;
  }, [tree, open]);

  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const first = Math.max(0, Math.floor(scroll / ROW) - 10);
  const last = Math.min(flat.length, Math.ceil((scroll + height) / ROW) + 10);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, r: Row, i: number) => {
    const focusRow = (j: number) => {
      const el = box.current;
      if (!el || j < 0 || j >= flat.length) return;
      el.scrollTop = Math.max(0, Math.min(el.scrollTop, j * ROW - ROW), j * ROW - el.clientHeight + ROW * 2);
      requestAnimationFrame(() => (el.querySelector(`[data-row="${j}"]`) as HTMLElement | null)?.focus());
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(i - 1); }
    else if (e.key === 'ArrowRight' && r.node.children.length && !open.has(r.node.key)) { e.preventDefault(); toggle(r.node.key); }
    else if (e.key === 'ArrowLeft' && open.has(r.node.key)) { e.preventDefault(); toggle(r.node.key); }
  };

  if (!rows.length) return <p className="muted small" style={{ padding: 12 }}>No pages here yet.</p>;
  return (
    <div ref={box} className="lib-tree" role="tree" aria-label="Pages" style={{ ['--lib-row' as any]: `${ROW}px` }} onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)}>
      <div style={{ height: flat.length * ROW + END_PAD, position: 'relative' }}>
        {flat.slice(first, last).map((r, k) => {
          const i = first + k;
          const n = r.node;
          const isOpen = open.has(n.key);
          const hasKids = n.children.length > 0;
          return (
            <div key={n.key} className={`lib-row${n.page?.id === selected ? ' on' : ''}${n.page ? '' : ' folder'}`} style={{ top: i * ROW, paddingLeft: 6 + r.depth * 14 }} role="treeitem" aria-level={r.depth + 1} aria-expanded={hasKids ? isOpen : undefined} aria-selected={n.page?.id === selected}>
              {hasKids ? <button type="button" className="lib-caret" aria-label={isOpen ? `Close ${n.label}` : `Open ${n.label}`} onClick={() => toggle(n.key)} tabIndex={-1}><i className={`fa-solid fa-chevron-${isOpen ? 'down' : 'right'}`} aria-hidden="true" /></button> : <span className="lib-caret" />}
              <button type="button" data-row={i} className="lib-row-btn" onClick={() => (n.page ? onOpen(n.page.id) : toggle(n.key))} onKeyDown={(e) => onKey(e, r, i)} title={n.page?.path ?? n.label}>
                {n.page ? (n.page.icon?.glyph ? <Icon icon={n.page.icon} size={13} /> : <i className="fa-regular fa-file-lines lib-ico" aria-hidden="true" />) : <i className={`fa-solid ${r.depth === 0 ? 'fa-database' : isOpen ? 'fa-folder-open' : 'fa-folder'} lib-ico`} aria-hidden="true" />}
                <span className="lib-row-label">{n.label}</span>
                {n.page?.playersSee && <i className="fa-solid fa-eye lib-eye" title="Players can read a copy of this page" aria-label="Players can read a copy" />}
                {n.page?.visibility && n.page.visibility !== 'party' && n.page.visibility !== 'dm' && <LevelChip level={n.page.visibility} />}
                {n.page && saved.has(n.page.id) && <i className="fa-solid fa-download lib-saved-ico" title="Saved for offline" aria-label="Saved for offline" />}
                {!n.page && <span className="lib-count">{n.count}</span>}
              </button>
              {n.page && onShare && <button type="button" className="lib-row-save" title={`Share “${n.label}” with players`} aria-label={`Share ${n.label}`} onClick={() => onShare(n.page!.id)}><i className="fa-solid fa-share-nodes" aria-hidden="true" /></button>}
              {!n.page && onSaveFolder && <button type="button" className="lib-row-save" title={`Save “${n.label}” for offline`} aria-label={`Save ${n.label} for offline`} onClick={() => onSaveFolder(pageIds(n), n.label)}><i className="fa-solid fa-download" aria-hidden="true" /></button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const TREE_CSS = `
.lib-tree { position: relative; overflow-y: auto; height: min(70vh, calc(100vh - 260px)); min-height: 280px; font-family: var(--font); font-size: 14px; }
.lib-row { position: absolute; left: 0; right: 0; height: var(--lib-row, 32px); display: flex; align-items: center; gap: 2px; padding-right: 4px; border-radius: 6px; }
.lib-row.on { background: var(--accent-bg); box-shadow: inset 2px 0 0 var(--accent); }
.lib-row:hover { background: var(--panel-2); }
.lib-row.on:hover { background: var(--accent-bg); }
.lib-caret { width: 20px; height: calc(var(--lib-row, 32px) - 8px); flex: 0 0 auto; border: 0; background: transparent; color: var(--faint); cursor: pointer; font-size: 10px; padding: 0; }
.lib-row-btn { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; height: calc(var(--lib-row, 32px) - 2px); border: 0; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; border-radius: 4px; padding: 0 4px; }
.lib-row.folder .lib-row-btn { color: var(--muted); font-weight: 600; }
.lib-row-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }
.lib-ico { color: var(--faint); width: 16px; text-align: center; font-size: 13px; }
.lib-eye { color: var(--teal); font-size: 11px; flex: 0 0 auto; }
.lib-count { font-size: 12px; color: var(--faint); }
.lib-dm-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); flex: 0 0 auto; }
.lib-saved-ico { color: var(--teal); font-size: 11px; }
.lib-row-save { opacity: 0; border: 0; background: transparent; color: var(--faint); cursor: pointer; padding: 4px 6px; }
.lib-row:hover .lib-row-save, .lib-row-save:focus-visible { opacity: 1; }
@media (hover: none) { .lib-row-save { opacity: 0.6; } }
@media (max-width: 760px), (pointer: coarse) { .lib-caret { width: 32px; font-size: 12px; } .lib-row-save { padding: 10px 12px; } .lib-row-btn { font-size: 15px; } }
`;
