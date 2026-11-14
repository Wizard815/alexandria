// What one stage card looks like. Pages, shops and people are always the
// player view (the server only builds those from player copies).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { useWorld } from '../../lib/world.tsx';
import { coins } from '../../lib/format.ts';
import { Markdown, ErrorBox, useAction } from '../../ui/index.tsx';
import { Blocks, Facts, Icon, type RenderCtx } from '../../pages/library/Blocks.tsx';
import { CombatPanel } from '../../pages/player/Live.tsx';
import Whiteboard from '../../pages/shared/Whiteboard.tsx';
import type { StageCard, PageOut } from './types.ts';

function Img({ url, alt }: { url: string | null; alt: string }) {
  const { client } = useAuth();
  if (!url) return null;
  const src = url.startsWith('/') ? client.baseUrl + url : url;
  return <img src={src} alt={alt} className="stg-img" referrerPolicy="no-referrer" loading="lazy" />;
}

function Countdown({ endsAt }: { endsAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  const left = Math.max(0, Math.round((Date.parse(endsAt) - now) / 1000));
  const m = Math.floor(left / 60), s = left % 60;
  return <div role="timer" aria-label="Countdown" className="stg-count" style={{ color: left === 0 ? 'var(--danger-text)' : 'var(--accent-strong)' }}>{m}:{String(s).padStart(2, '0')}</div>;
}

function PageBody({ page }: { page: PageOut }) {
  const nav = useNavigate();
  const ctx: RenderCtx = useMemo(() => ({ links: page.links ?? {}, isDM: false, children: [], open: (id: string) => nav(`${page.openPath.split('?')[0]}?page=${encodeURIComponent(id)}`) }), [page, nav]);
  return (
    <div className="lib-page" style={{ fontSize: 15 }}>
      {page.facts.length > 0 && <Facts groups={page.facts} ctx={ctx} />}
      <Blocks blocks={page.excerpt} ctx={ctx} />
      {page.truncated && <a href={page.openPath} className="small">Read the rest in the library</a>}
    </div>
  );
}

function Shop({ card }: { card: StageCard }) {
  const { w, isDM, info } = useWorld();
  const act = useAction();
  const [done, setDone] = useState<string | null>(null);
  const d = card.data;
  const buy = (name: string) => act.run(async () => {
    const r = await w.call<{ pending: boolean }>('POST', `/stage/cards/${card.id}/buy`, { item: name, qty: 1 });
    setDone(r.pending ? `Asked to buy ${name}. Waiting for the DM to approve.` : `Bought ${name}.`);
  });
  return (
    <>
      <PageBody page={d.page} />
      <table className="stg-table">
        <tbody>
          {(d.items as { name: string; price: string; priceCp: number | null }[]).map((it) => (
            <tr key={it.name}>
              <td>{it.name}</td>
              <td className="muted" style={{ whiteSpace: 'nowrap' }}>{it.priceCp ? coins(it.priceCp, info.settings.coins) : it.price || '—'}</td>
              {!isDM && d.canBuy && <td style={{ textAlign: 'right' }}>{it.priceCp ? <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void buy(it.name)}>Buy</button> : null}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {done && <div role="status" className="note">{done}</div>}
      <ErrorBox error={act.error} />
    </>
  );
}

function DmCombat({ view }: { view: any }) {
  const list = (view.combatants ?? []) as any[];
  return (
    <div className="stack tight">
      <div className="muted small">{view.active ? `Round ${view.round}` : 'No fight running'} · the table sees only the players' version</div>
      <ol className="stack tight" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {list.map((x, i) => (
          <li key={x.id} className="row" style={{ gap: 8, padding: '6px 10px', borderRadius: 6, border: `1px solid ${i === view.turn ? 'var(--accent)' : 'var(--line)'}` }}>
            <span className="grow"><strong>{x.name}</strong>{x.hidden && <span className="chip" style={{ marginLeft: 6 }}>hidden</span>}</span>
            <span className="small muted">{x.hp ?? '–'}{x.max_hp ? `/${x.max_hp}` : ''}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function cardTitle(c: StageCard): string {
  const d = c.data ?? {};
  switch (c.kind) {
    case 'image': return c.caption || d.caption || 'Picture';
    case 'combat': return 'Combat';
    case 'person': return d.person?.name ?? c.label ?? 'Person';
    case 'shop': case 'place': return d.page?.title ?? 'Page';
    case 'event': return d.title || 'Event';
    case 'text': return d.title || 'Handout';
    case 'drawing': return 'Drawing board';
  }
}

const ICON: Record<string, string> = { image: 'fa-image', combat: 'fa-khanda', person: 'fa-user', shop: 'fa-store', place: 'fa-location-dot', event: 'fa-bolt', text: 'fa-scroll', drawing: 'fa-chalkboard' };

export function CardView({ card, big = false, controls }: { card: StageCard; big?: boolean; controls?: ReactNode }) {
  const { isDM } = useWorld();
  const [board, setBoard] = useState(big);
  const d = card.data ?? {};
  let body: ReactNode;
  if (card.unavailable) body = <p className="muted small">Players can't open this right now (the page or person is not shared with the party). It will not show on their board.</p>;
  else switch (card.kind) {
    case 'image': body = <><Img url={d.url} alt={d.caption || 'Picture'} />{d.caption && <p className="small muted" style={{ margin: 0 }}>{d.caption}</p>}</>; break;
    case 'combat': body = isDM ? <DmCombat view={d.view} /> : <CombatPanel c={d.view} compact />; break;
    case 'person': body = (
      <>
        <div className="small muted">{[d.person.role, d.person.attitude, d.person.met && `met ${d.person.met}`].filter(Boolean).join(' · ')}</div>
        {d.person.quotes.map((q: any, i: number) => <blockquote key={i} className="stg-quote">“{q.text}”{q.said && <span className="faint"> — {q.said}</span>}</blockquote>)}
        {d.page && <PageBody page={d.page} />}
      </>
    ); break;
    case 'shop': body = <Shop card={card} />; break;
    case 'place': body = <PageBody page={d.page} />; break;
    case 'event': body = (
      <>
        <Img url={d.url} alt="" />
        {d.text && <Markdown text={d.text} />}
        {d.endsAt && <Countdown endsAt={d.endsAt} />}
      </>
    ); break;
    case 'text': body = <Markdown text={d.markdown ?? ''} />; break;
    case 'drawing': body = board ? <div className="stg-board"><Whiteboard /></div> : <button type="button" className="btn small" onClick={() => setBoard(true)}>Open the drawing board here</button>; break;
  }
  const title = cardTitle(card);
  return (
    <section className={`card stg-card k-${card.kind}${big ? ' big' : ''}`} aria-label={title}>
      <div className="card-head">
        <h2 style={{ fontSize: big ? 24 : 17, display: 'flex', gap: 8, alignItems: 'center', margin: 0 }}>
          {card.kind === 'place' || card.kind === 'shop' ? <Icon icon={card.data?.page?.icon} size={18} /> : <i className={`fa-solid ${ICON[card.kind]}`} aria-hidden="true" />}
          <span>{title}</span>
        </h2>
        {isDM && card.label && card.kind !== 'event' && card.kind !== 'text' && <span className="tiny muted">{card.label}</span>}
      </div>
      {body}
      {controls}
    </section>
  );
}
