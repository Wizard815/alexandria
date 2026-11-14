// The board itself: spotlight (one big card), grid or free layout. Cards
// stack in one column on a phone whatever the layout.
import type { ReactNode } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { Empty, ErrorBox, Loading } from '../../ui/index.tsx';
import { LIB_CSS } from '../../pages/library/Blocks.tsx';
import { CardView } from './CardView.tsx';
import type { StageCard, StageView } from './types.ts';

/** The board as this viewer may see it, kept live. The combat card follows the combat event. */
export function useStage() {
  const { w } = useWorld();
  return useLoad(() => w.call<StageView>('GET', '/stage'), [w], ['stage', 'combat', 'person', 'page', 'settings']);
}

export const CSS = `
.stg-grid { display: grid; gap: 14px; grid-template-columns: 1fr; align-items: start; }
@media (min-width: 720px) { .stg-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } .stg-grid > .s2 { grid-column: span 2; } .stg-grid > .s3 { grid-column: span 3; } }
.stg-spot { display: grid; gap: 14px; }
.stg-free { display: grid; gap: 14px; }
@media (min-width: 900px) { .stg-free { display: block; position: relative; min-height: 1100px; } .stg-free > .stg-slot { position: absolute; } }
.stg-card.big { border-color: var(--accent); }
.stg-img { max-width: 100%; max-height: 70vh; border-radius: 8px; object-fit: contain; align-self: center; background: var(--panel-2); }
.stg-card.big .stg-img { max-height: 78vh; }
.stg-count { font-family: var(--font-head); font-size: 40px; font-variant-numeric: tabular-nums; text-align: center; }
.stg-table { width: 100%; border-collapse: collapse; font-size: 15px; } .stg-table td { padding: 6px 4px; border-top: 1px solid var(--line); }
.stg-quote { margin: 4px 0; padding-left: 10px; border-left: 3px solid var(--line-strong); font-style: italic; }
.stg-board { max-height: 80vh; overflow: auto; }
.stg-card { min-width: 0; overflow-wrap: anywhere; }
`;

export function StageCards({ view, controls }: { view: StageView; controls?: (c: StageCard) => ReactNode }) {
  const cards = [...view.cards].sort((a, b) => a.z - b.z);
  const spot = view.layout === 'spotlight' ? cards.find((c) => c.id === view.spotlightId) ?? cards[cards.length - 1] : undefined;
  if (!cards.length) return <Empty>Nothing on the board.</Empty>;
  if (view.layout === 'spotlight' && spot) {
    const rest = cards.filter((c) => c.id !== spot.id).reverse();
    return (
      <div className="stg-spot">
        <CardView card={spot} big controls={controls?.(spot)} />
        {rest.length > 0 && <div className="stg-grid">{rest.map((c) => <div key={c.id}><CardView card={c} controls={controls?.(c)} /></div>)}</div>}
      </div>
    );
  }
  if (view.layout === 'free') {
    return (
      <div className="stg-free">
        {cards.map((c) => <div key={c.id} className="stg-slot" style={{ left: `${c.x}%`, top: `${Math.min(c.y, 90) * 11}px`, width: `${Math.min(100 - c.x, Math.min(c.w, 3) * 32)}%`, zIndex: c.z }}><CardView card={c} controls={controls?.(c)} /></div>)}
      </div>
    );
  }
  return (
    <div className="stg-grid">
      {[...cards].reverse().map((c) => <div key={c.id} className={c.w >= 3 ? 's3' : c.w >= 2 ? 's2' : ''}><CardView card={c} controls={controls?.(c)} /></div>)}
    </div>
  );
}

/** For players (and the player Live page): whatever the DM has put on the board. */
export default function StageBoard({ embedded = false }: { embedded?: boolean }) {
  const s = useStage();
  if (s.loading && !s.data) return embedded ? <Loading what="the stage" /> : <div className="page"><Loading what="the stage" /></div>;
  const body = (
    <>
      <style>{LIB_CSS + CSS}</style>
      <ErrorBox error={s.error} />
      {s.data && (s.data.cards.length ? <StageCards view={s.data} /> : <section className="card"><h2>The stage is quiet</h2><p className="muted">When the DM shows something (a map, a person, a shop, the fight), it appears here.</p></section>)}
    </>
  );
  return embedded ? <div className="stack loose">{body}</div> : <div className="page"><div className="stack loose"><h1>Stage</h1>{body}</div></div>;
}
