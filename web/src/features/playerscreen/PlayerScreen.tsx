// The players' screen: a chrome-less full-screen page for the TV facing the
// table. It is opened on the DM's computer, so it never asks for anything but
// GET /screen/players, which the server builds as the player view whoever is
// signed in; nothing here fetches a DM endpoint. Live through the world's
// event stream, like the player stage.
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { Markdown } from '../../ui/index.tsx';
import { Blocks, Facts, LIB_CSS, type RenderCtx } from '../../pages/library/Blocks.tsx';

interface Combatant { id: string; name: string; is_pc: boolean; effects: { name: string; rounds?: number }[]; health: string | null }
interface Combat { active: boolean; round: number; currentId?: string | null; combatants?: Combatant[] }
interface Card { id: string; kind: string; z: number; data: any }
interface Media { mode: string; playing: boolean; current: { id: string; kind: 'youtube' | 'image' | 'video'; embed: string | null; url: string | null } | null }
interface ScreenData { world: { name: string }; stage: { layout: string; spotlightId: string | null; cards: Card[]; combat: Combat | null }; media: Media }

const NOOP_CTX: RenderCtx = { links: {}, isDM: false, children: [], open: () => {} };

export const CSS = `
.ps { position: fixed; inset: 0; overflow: hidden; background: var(--bg); color: var(--text); font-size: clamp(20px, 2.1vw, 40px); line-height: 1.35; display: flex; gap: 2vw; padding: 2vw; box-sizing: border-box; }
.ps.idle, .ps.idle * { cursor: none !important; }
.ps-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 2vh; }
.ps-media { position: absolute; inset: 0; background: #000; z-index: 2; display: flex; align-items: center; justify-content: center; }
.ps-media iframe { width: 100%; height: 100%; border: 0; }
.ps-media img { max-width: 100%; max-height: 100%; object-fit: contain; animation: ps-fade 0.6s ease; }
@keyframes ps-fade { from { opacity: 0; } to { opacity: 1; } }
.ps-side { flex: 0 0 min(28vw, 560px); min-height: 0; overflow: hidden; z-index: 3; }
.ps.media .ps-side { position: absolute; right: 2vw; top: 2vw; bottom: 2vw; width: min(28vw, 560px); background: color-mix(in srgb, var(--bg) 88%, transparent); border-radius: 12px; padding: 1.2vw; box-sizing: border-box; }
.ps h2 { font-size: 1.5em; margin: 0 0 0.3em; }
.ps-card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 1.2vw 1.6vw; min-width: 0; overflow: hidden; overflow-wrap: anywhere; display: flex; flex-direction: column; gap: 0.6vh; }
.ps-card.big { border-color: var(--accent); flex: 1; min-height: 0; }
.ps-grid { flex: 1; min-height: 0; display: grid; gap: 1.6vw; grid-template-columns: repeat(auto-fit, minmax(min(100%, 28vw), 1fr)); grid-auto-rows: minmax(0, 1fr); }
.ps-img { max-width: 100%; max-height: 100%; min-height: 0; object-fit: contain; align-self: center; border-radius: 8px; flex: 1; }
.ps-count { font-family: var(--font-head); font-size: 3em; text-align: center; font-variant-numeric: tabular-nums; color: var(--accent-strong); }
.ps-order { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5vh; }
.ps-order li { display: flex; align-items: center; gap: 0.6em; padding: 0.35em 0.6em; border-radius: 8px; border: 1px solid var(--line); }
.ps-order li.current { border-color: var(--accent); background: var(--accent-bg); font-weight: 700; }
.ps-order .who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ps-order .fx { display: block; font-size: 0.65em; font-weight: 400; color: var(--muted); }
.ps-bar { display: inline-block; width: 4em; height: 0.6em; border-radius: 4px; background: var(--panel-2); border: 1px solid var(--line); overflow: hidden; vertical-align: middle; }
.ps-bar > span { display: block; height: 100%; background: var(--accent); }
.ps-quote { margin: 0.2em 0; padding-left: 0.6em; border-left: 3px solid var(--line-strong); font-style: italic; }
.ps-idle { margin: auto; text-align: center; color: var(--muted); }
.ps-idle h1 { font-size: 2.4em; }
.ps-full { position: fixed; right: 1.5vw; top: 1.5vw; z-index: 10; font-size: 18px; padding: 10px 16px; border-radius: 10px; border: 1px solid var(--line-strong); background: var(--panel); color: var(--text); cursor: pointer; transition: opacity 0.4s; }
.ps.idle .ps-full { opacity: 0; }
/* The shared Markdown and page styles set their own small sizes; a TV needs them large. */
.ps-card p, .ps-card li, .ps-card td, .ps-card blockquote { font-size: 1em; line-height: 1.4; }
.ps .lib-page { font-size: 0.85em; }
.ps a { color: inherit; text-decoration: none; pointer-events: none; }
`;

function Countdown({ endsAt }: { endsAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  const left = Math.max(0, Math.round((Date.parse(endsAt) - now) / 1000));
  return <div role="timer" aria-label="Countdown" className="ps-count">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</div>;
}

function useSrc() {
  const { client } = useAuth();
  return (url: string | null) => (url ? (url.startsWith('/') ? client.baseUrl + url : url) : undefined);
}

function PageBody({ page }: { page: any }) {
  const ctx = useMemo(() => ({ ...NOOP_CTX, links: page.links ?? {} }), [page]);
  return (
    <div className="lib-page">
      {page.facts?.length > 0 && <Facts groups={page.facts} ctx={ctx} />}
      <Blocks blocks={page.excerpt ?? []} ctx={ctx} />
    </div>
  );
}

function ScreenCard({ card, big }: { card: Card; big: boolean }) {
  const src = useSrc();
  const d = card.data ?? {};
  let title = '';
  let body = null;
  switch (card.kind) {
    case 'image': title = d.caption ?? ''; body = d.url && <img className="ps-img" src={src(d.url)} alt={d.caption || 'Picture'} referrerPolicy="no-referrer" />; break;
    case 'text': title = d.title ?? ''; body = <Markdown text={d.markdown ?? ''} />; break;
    case 'event': title = d.title ?? ''; body = <>{d.url && <img className="ps-img" src={src(d.url)} alt="" referrerPolicy="no-referrer" />}{d.text && <Markdown text={d.text} />}{d.endsAt && <Countdown endsAt={d.endsAt} />}</>; break;
    case 'person': title = d.person?.name ?? ''; body = (
      <>
        <div className="muted">{[d.person?.role, d.person?.attitude].filter(Boolean).join(' · ')}</div>
        {(d.person?.quotes ?? []).map((q: any, i: number) => <blockquote key={i} className="ps-quote">“{q.text}”</blockquote>)}
        {d.page && <PageBody page={d.page} />}
      </>
    ); break;
    case 'place': title = d.page?.title ?? ''; body = d.page && <PageBody page={d.page} />; break;
    case 'shop': title = d.page?.title ?? ''; body = (
      <>
        {d.page && <PageBody page={d.page} />}
        <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>{(d.items ?? []).map((it: any) => <tr key={it.name}><td>{it.name}</td><td className="muted" style={{ textAlign: 'right' }}>{it.price || '—'}</td></tr>)}</tbody></table>
      </>
    ); break;
  }
  return (
    <section className={`ps-card${big ? ' big' : ''}`} aria-label={title || card.kind}>
      {title && <h2>{title}</h2>}
      {body}
    </section>
  );
}

function Order({ combat, monsterHealth }: { combat: Combat; monsterHealth: string }) {
  return (
    <section className="ps-card" aria-label="Combat">
      <h2>Combat <span className="muted" style={{ fontSize: '0.6em' }}>Round {combat.round}</span></h2>
      {combat.combatants ? (
        <ol className="ps-order">
          {combat.combatants.map((x) => (
            <li key={x.id} className={x.id === combat.currentId ? 'current' : ''} aria-current={x.id === combat.currentId ? 'step' : undefined}>
              <span aria-hidden="true">{x.id === combat.currentId ? '▶' : ''}</span>
              <span className="who">{x.name}{x.effects.length > 0 && <span className="fx">{x.effects.map((e) => (e.rounds ? `${e.name} (${e.rounds})` : e.name)).join(', ')}</span>}</span>
              {x.health && (monsterHealth === 'bar' && /^\d+$/.test(x.health) ? <span className="ps-bar" role="img" aria-label={`${x.health} percent`}><span style={{ width: `${x.health}%` }} /></span> : <span className="muted">{x.health}</span>)}
            </li>
          ))}
        </ol>
      ) : <p className="muted">The fight is on.</p>}
    </section>
  );
}

function Stage({ stage }: { stage: ScreenData['stage'] }) {
  const cards = [...stage.cards].sort((a, b) => b.z - a.z);
  const spot = stage.layout === 'spotlight' ? cards.find((c) => c.id === stage.spotlightId) : undefined;
  if (!cards.length) return null;
  if (spot) {
    const rest = cards.filter((c) => c.id !== spot.id).slice(0, 3);
    return (
      <div className="ps-main">
        <ScreenCard card={spot} big />
        {rest.length > 0 && <div className="ps-grid" style={{ flex: '0 0 30%' }}>{rest.map((c) => <ScreenCard key={c.id} card={c} big={false} />)}</div>}
      </div>
    );
  }
  return <div className="ps-grid">{cards.slice(0, 6).map((c) => <ScreenCard key={c.id} card={c} big={false} />)}</div>;
}

export default function PlayerScreen() {
  const { w, info } = useWorld();
  const src = useSrc();
  const data = useLoad(() => w.call<ScreenData>('GET', '/screen/players'), [w], ['stage', 'combat', 'person', 'page', 'settings', 'screen', 'libfile']);
  const [idle, setIdle] = useState(false);
  const [full, setFull] = useState(!!document.fullscreenElement);

  useEffect(() => { document.title = `Players' screen · ${info.name}`; }, [info.name]);
  // Picture tickets expire after hours: a table that stays on all night refreshes them.
  useEffect(() => { const t = setInterval(() => void data.reload(), 30 * 60_000); return () => clearInterval(t); }, [data.reload]);
  // The cursor hides after a few quiet seconds and comes back when the mouse moves.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 3000); };
    wake();
    window.addEventListener('mousemove', wake); window.addEventListener('mousedown', wake); window.addEventListener('keydown', wake);
    return () => { clearTimeout(t); window.removeEventListener('mousemove', wake); window.removeEventListener('mousedown', wake); window.removeEventListener('keydown', wake); };
  }, []);
  useEffect(() => {
    const f = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);

  const s = data.data;
  const cur = s?.media.current ?? null;
  const combat = s?.stage.combat ?? null;
  const hasStage = !!s && s.stage.cards.length > 0;
  const mh = info.settings.monsterHealth;

  return (
    <div className={`t-fantasy ps${idle ? ' idle' : ''}${cur ? ' media' : ''}`} aria-label="Players' screen">
      <style>{LIB_CSS + CSS}</style>
      {cur && (
        <div className="ps-media">
          {cur.kind === 'youtube' && cur.embed && <iframe key={cur.id} src={cur.embed} title="Video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />}
          {cur.kind === 'image' && cur.url && <img key={cur.id} src={src(cur.url)} alt="" referrerPolicy="no-referrer" />}
        </div>
      )}
      {!cur && (hasStage ? <Stage stage={s!.stage} /> : <div className="ps-idle"><h1>{s?.world.name ?? info.name}</h1><p>The adventure continues…</p></div>)}
      {combat && <aside className="ps-side"><Order combat={combat} monsterHealth={mh} /></aside>}
      {!full && document.fullscreenEnabled && (
        <button type="button" className="ps-full" onClick={() => void document.documentElement.requestFullscreen().catch(() => {})}>Fullscreen</button>
      )}
    </div>
  );
}
