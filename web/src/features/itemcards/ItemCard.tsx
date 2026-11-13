// Item cards. <ItemHover itemId>name</ItemHover> wraps an item's name:
//   mouse    hover for N seconds (a per-person setting, 0.5 to 5, default 3)
//            and the card pops out beside it; the pointer may move into it
//   touch    an (i) button opens the same card as a bottom sheet
//   keyboard focus the name and press Enter
// <ItemCard itemId> is the card itself, for screens that want it inline.
// The page part is read live by the server; players only get the player copy.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { ErrorBox, Loading } from '../../ui/index.tsx';
import { Blocks, Facts, Icon, LIB_CSS, type Block, type PropertyGroup, type RenderCtx } from '../../pages/library/Blocks.tsx';
import { ItemImage } from '../../pages/inventory/giving.tsx';
import { useHoverDelay } from './settings.ts';

export interface CardData {
  item: { id: string; name: string; image: string | null; qty: number; owner: string; ownerName: string | null; note: string; pageId: string | null; weight?: number | null; dmNote?: string };
  page: null | { id: string; title: string; kind: string; icon: any; facts: PropertyGroup[]; excerpt: Block[]; truncated: boolean; links: Record<string, string>; openPath: string; visibility?: string };
}

const CSS = `
.ic-trigger { cursor: help; border-radius: 4px; }
.ic-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ic-info { display: none; border: 0; background: none; color: var(--accent-strong); cursor: pointer; padding: 0 4px; font-size: 15px; line-height: 1; }
@media (hover: none), (pointer: coarse) { .ic-info { display: inline-block; min-width: 32px; min-height: 32px; } }
.ic-card { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 12px 36px rgba(0,0,0,.35); padding: 14px; overflow-y: auto; overscroll-behavior: contain; outline: none; z-index: 1000; }
.ic-pop { position: fixed; width: min(380px, calc(100vw - 24px)); max-height: min(70vh, 520px); }
.ic-sheet { position: fixed; left: 0; right: 0; bottom: 0; max-height: 78vh; border-radius: 16px 16px 0 0; padding-bottom: calc(14px + env(safe-area-inset-bottom)); }
.ic-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 999; }
.ic-head { display: flex; gap: 10px; align-items: center; }
.ic-body .lib-page { font-size: 15px; }
.ic-body .lib-facts { margin: 8px 0; }
`;

/** The card's contents. */
export function ItemCard({ itemId, onClose }: { itemId: string; onClose?: () => void }) {
  const { w, isDM } = useWorld();
  const navigate = useNavigate();
  const card = useLoad(() => w.call<CardData>('GET', `/itemcards/${encodeURIComponent(itemId)}`), [w, itemId], ['item', 'page', 'item-moved']);
  const d = card.data;
  const pg = d?.page ?? null;
  const ctx: RenderCtx = useMemo(() => ({
    links: pg?.links ?? {}, isDM, children: [],
    open: (id: string) => { onClose?.(); navigate(`${(pg?.openPath ?? '').split('?')[0]}?page=${encodeURIComponent(id)}`); },
  }), [pg, isDM, navigate, onClose]);
  if (card.error && !d) return <ErrorBox error={card.error} />;
  if (!d) return <Loading what="card" />;
  const it = d.item;
  return (
    <div className="ic-body stack tight">
      <style>{LIB_CSS + CSS}</style>
      <div className="ic-head">
        <ItemImage image={it.image} name={it.name} size={48} />
        <div className="grow" style={{ minWidth: 0 }}>
          <strong className="read" style={{ fontSize: 17, overflowWrap: 'anywhere' }}>{it.name}</strong>
          <div className="small muted">
            × {it.qty}{it.weight != null ? ` · ${it.weight} each` : ''} · {it.owner === 'party' ? 'Party stash' : it.ownerName ?? 'Someone'}
          </div>
        </div>
        {onClose && <button type="button" className="btn small ghost" onClick={onClose} aria-label="Close card">✕</button>}
      </div>
      {it.note && <p className="small" style={{ margin: 0 }}>{it.note}</p>}
      {it.dmNote && <p className="small" style={{ margin: 0 }}><span className="chip">DM note</span> {it.dmNote}</p>}
      {pg ? (
        <section aria-label={`About ${pg.title}`} className="stack tight" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <div className="row between" style={{ alignItems: 'baseline', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}><Icon icon={pg.icon} size={14} /> {pg.title}</h3>
            {pg.visibility === 'dm' && <span className="chip">DM only page</span>}
          </div>
          {pg.facts.length > 0 && <Facts groups={pg.facts} ctx={ctx} />}
          <div className="lib-page">{pg.excerpt.length ? <Blocks blocks={pg.excerpt} ctx={ctx} /> : null}</div>
          {pg.truncated && <span className="tiny faint">…</span>}
          <Link className="btn small" to={pg.openPath} onClick={onClose}>Open page</Link>
        </section>
      ) : it.pageId && isDM ? <p className="tiny faint" style={{ margin: 0 }}>The linked page is no longer available.</p> : null}
    </div>
  );
}

type Mode = 'pop' | 'sheet';

/** Wrap an item's name: hover (after the delay), Enter, or the (i) button opens its card. */
export function ItemHover({ itemId, children, className }: { itemId: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState<Mode | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [delay, setDelay] = useHoverDelay();
  const trigger = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);

  const clear = () => { window.clearTimeout(openTimer.current); window.clearTimeout(closeTimer.current); };
  useEffect(() => clear, []);
  const show = useCallback((mode: Mode) => {
    clear();
    if (trigger.current) setRect(trigger.current.getBoundingClientRect());
    setOpen(mode);
  }, []);
  const hide = useCallback((refocus = false) => { clear(); setOpen(null); if (refocus) trigger.current?.focus(); }, []);
  const hideSoon = () => { window.clearTimeout(openTimer.current); window.clearTimeout(closeTimer.current); closeTimer.current = window.setTimeout(() => setOpen((o) => (o === 'pop' ? null : o)), 250); };

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); hide(true); } };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [open, hide]);
  useEffect(() => { if (open && card.current && open === 'sheet') card.current.focus(); }, [open]);

  const style = (() => {
    if (open !== 'pop' || !rect) return undefined;
    const W = Math.min(380, window.innerWidth - 24);
    const room = window.innerWidth - rect.right - 12;
    const left = room >= W ? rect.right + 8 : Math.max(12, Math.min(rect.left, window.innerWidth - W - 12));
    const below = room >= W ? false : true;
    const top = below ? Math.min(rect.bottom + 6, Math.max(12, window.innerHeight - 200)) : Math.max(12, Math.min(rect.top - 8, window.innerHeight - 220));
    return { left, top };
  })();

  return (
    <>
      <span
        ref={trigger}
        className={`ic-trigger${className ? ` ${className}` : ''}`}
        tabIndex={0}
        role="button"
        aria-haspopup="dialog"
        aria-expanded={!!open}
        aria-label={undefined}
        onPointerEnter={(e) => {
          if (e.pointerType !== 'mouse' || open) return;
          window.clearTimeout(openTimer.current);
          openTimer.current = window.setTimeout(() => show('pop'), delay * 1000);
        }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') hideSoon(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); show('pop'); setTimeout(() => card.current?.focus(), 0); } }}
      >
        {children}
      </span>
      <button type="button" className="ic-info" aria-label="Show item card" onClick={() => show('sheet')}>ⓘ</button>
      {open && createPortal(
        <>
          {open === 'sheet' && <div className="ic-backdrop" onClick={() => hide()} />}
          <div
            ref={card}
            className={`ic-card ${open === 'sheet' ? 'ic-sheet' : 'ic-pop'}`}
            role="dialog"
            aria-label="Item card"
            tabIndex={-1}
            style={style}
            onPointerEnter={() => window.clearTimeout(closeTimer.current)}
            onPointerLeave={(e) => { if (e.pointerType === 'mouse') hideSoon(); }}
          >
            <ItemCard itemId={itemId} onClose={() => hide()} />
            <label className="tiny faint row" style={{ gap: 6, marginTop: 8, alignItems: 'center' }}>
              Hover delay
              <input type="range" min={0.5} max={5} step={0.5} value={delay} onChange={(e) => setDelay(Number(e.target.value))} aria-label="Seconds to hover before a card opens" />
              {delay}s
            </label>
          </div>
        </>,
        trigger.current?.closest('.t-fantasy, .t-admin') ?? document.body,
      )}
    </>
  );
}
