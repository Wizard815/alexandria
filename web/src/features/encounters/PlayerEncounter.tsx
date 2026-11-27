// Player side: an NPC walks up. Pops up over any player screen when the GM
// (or wandering) starts an encounter for me: the NPC's words, my answers, and
// a small game when the NPC offers one. "Later" folds it into a chip in the
// corner. A finished talk stays up until I close it, with a button to the
// shop when the NPC showed me one. Also the "Wander" card on the home page.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { coins } from '../../lib/format.ts';
import { Empty, ErrorBox, Loading, PageHead, useAction } from '../../ui/index.tsx';
import { when } from '../../lib/format.ts';
import { Countdown } from './Countdown.tsx';
import { GAME_HELP, type Encounter, type EncounterConfig, type Line } from './types.ts';
import './encounters.css';

const SEEN = 'alx.enc.closed';
const RECENT_MS = 6 * 3600 * 1000;
const loadSeen = (): string[] => { try { return JSON.parse(localStorage.getItem(SEEN) || '[]'); } catch { return []; } };

export default function PlayerEncounter() {
  const { w, info } = useWorld();
  if (info.role !== 'player') return null;
  return <Inner />;
}

function Inner() {
  const { w } = useWorld();
  const list = useLoad<Encounter[]>(() => w.call('GET', '/encounters'), [w], ['encounter']);
  const [seen, setSeen] = useState<string[]>(loadSeen);
  const [folded, setFolded] = useState<string | null>(null);
  // The newest talk that is still going, else a just-finished one I have not closed.
  const e = useMemo(() => (list.data ?? []).find((x) => !seen.includes(x.id) && (x.status === 'open' || Date.now() - Date.parse(x.updatedAt) < RECENT_MS)), [list.data, seen]);
  if (!e) return null;
  const close = () => {
    const next = [...seen, e.id].slice(-200);
    setSeen(next);
    try { localStorage.setItem(SEEN, JSON.stringify(next)); } catch { /* private mode */ }
  };
  if (folded === e.id) {
    return (
      <button type="button" className="enc-chip" data-testid="enc-chip" onClick={() => setFolded(null)}>
        <i className={`fa-solid ${e.kind === 'event' ? 'fa-bolt' : 'fa-comment-dots'}`} aria-hidden="true" /> {e.npc.name} {e.kind === 'event' ? (e.status === 'open' ? ': your move' : ': done') : e.status === 'open' ? 'is waiting' : 'said goodbye'}
      </button>
    );
  }
  return <Talk key={e.id} e={e} onClose={close} onFold={() => setFolded(e.id)} onChanged={(v) => list.setData((l) => (l ?? []).map((x) => (x.id === v.id ? v : x)))} />;
}

function Talk({ e, onClose, onFold, onChanged }: { e: Encounter; onClose: () => void; onFold: () => void; onChanged: (v: Encounter) => void }) {
  const { w, info } = useWorld();
  const act = useAction();
  const [roll, setRoll] = useState('');
  const [crit, setCrit] = useState<'' | 'high' | 'low'>('');
  const logEnd = useRef<HTMLDivElement>(null);
  const open = e.status === 'open';
  const money = (cp: number) => coins(cp, info.settings.coins);
  useEffect(() => { logEnd.current?.scrollIntoView({ block: 'end' }); }, [e.log.length]);
  useEffect(() => {
    const k = (ev: KeyboardEvent) => { if (ev.key === 'Escape') (open ? onFold : onClose)(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onFold, onClose]);

  const choose = (body: Record<string, unknown>) => act.run(async () => onChanged(await w.call<Encounter>('POST', `/encounters/${encodeURIComponent(e.id)}/choose`, body)));
  // The countdown hit zero: the server picks the answer the GM set for running out of time.
  const timeUp = useCallback(() => { void act.run(async () => onChanged(await w.call<Encounter>('POST', `/encounters/${encodeURIComponent(e.id)}/choose`, { timeout: true }))); }, [e.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const leave = () => act.run(async () => onChanged(await w.call<Encounter>('POST', `/encounters/${encodeURIComponent(e.id)}/leave`)));
  // The latest NPC line is shown big; everything before it is the log.
  const history = open && e.log.length && e.log[e.log.length - 1].who !== 'you' ? e.log.slice(0, -1) : e.log;
  const titleId = `enc-${e.id}`;
  const g = e.game;
  return (
    <div className="modal-back">
      <div className="modal enc" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="encounter">
        <div className="row between">
          <span className="tiny enc-kicker">{e.kind === 'event' ? 'Something happens' : e.source === 'wander' ? 'Out and about' : 'Someone approaches'}</span>
          {open ? <button type="button" className="btn ghost small" onClick={onFold}>Later</button> : <button type="button" className="btn ghost small" onClick={onClose} aria-label="Close">✕</button>}
        </div>
        <div className="enc-npc">
          <span className="enc-avatar" aria-hidden="true">{e.kind === 'event' ? <i className="fa-solid fa-bolt" /> : e.npc.name.slice(0, 1).toUpperCase()}</span>
          <div className="stack tight">
            <h2 id={titleId} style={{ fontSize: 21 }}>{e.npc.name}</h2>
            {e.npc.blurb && <span className="small muted">{e.npc.blurb}</span>}
          </div>
        </div>

        {history.length > 0 && (
          <div className="enc-log" aria-label="The talk so far">
            {history.map((l, i) => <LogLine key={i} l={l} npc={e.npc.name} />)}
            <div ref={logEnd} />
          </div>
        )}

        {open && e.text && <p className="read enc-say">{e.text}</p>}
        {open && e.timer?.endsAt && <Countdown endsAt={e.timer.endsAt} secs={e.timer.secs} onZero={timeUp} />}
        <ErrorBox error={act.error} />

        {open && g && (
          <div className="card enc-game" data-testid="enc-game">
            <div className="row between"><strong>{g.label}{g.skill ? ` · ${g.skill}` : ''}</strong>
              {(e.kind !== 'event' || g.stakeCp > 0 || g.winCp > 0) && <span className="small muted">{g.stakeCp ? `Stake ${money(g.stakeCp)}` : 'Free to play'}{g.winCp ? ` · win ${money(g.winCp)}` : ''}</span>}
            </div>
            {g.kind !== 'check' && <span className="tiny faint">{GAME_HELP[g.kind]}</span>}
            {g.kind === 'coin' && (
              <div className="row">{['Heads', 'Tails'].map((s, i) => <button key={s} type="button" className="btn primary" disabled={act.busy} onClick={() => void choose({ play: true, pick: i })}>{s}</button>)}</div>
            )}
            {g.kind === 'shells' && (
              <div className="row enc-shells">{['Left', 'Middle', 'Right'].map((s, i) => (
                <button key={s} type="button" className="btn enc-shell" aria-label={`${s} shell`} disabled={act.busy} onClick={() => void choose({ play: true, pick: i })}><i className="fa-solid fa-bowl-food" aria-hidden="true" /><span className="tiny">{s}</span></button>
              ))}</div>
            )}
            {g.kind === 'dice' && <div className="row"><button type="button" className="btn primary" disabled={act.busy} onClick={() => void choose({ play: true })}><i className="fa-solid fa-dice" aria-hidden="true" /> Roll</button></div>}
            {g.kind === 'check' && (
              <form className="stack tight" data-testid="enc-roll" onSubmit={(ev) => { ev.preventDefault(); const t = roll !== '' && roll !== '-' ? Number(roll) : undefined; if (t !== undefined || crit) void choose({ play: true, total: t, crit: crit || undefined }); }}>
                <span className="small"><i className="fa-solid fa-dice-d20" aria-hidden="true" /> Roll a d20{g.skill ? ` for ${g.skill}` : ''}, add your bonus, and enter the total.</span>
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <label className="field" style={{ width: 120 }}><span className="label">Your total</span>
                    <input inputMode="numeric" value={roll} placeholder="e.g. 14" aria-label="Your total" autoFocus onChange={(ev) => setRoll(ev.target.value.replace(/[^\d-]/g, '').replace(/(?!^)-/g, '').slice(0, 3))} />
                  </label>
                  <button type="submit" className="btn primary" disabled={act.busy || ((roll === '' || roll === '-') && !crit)}>Send roll</button>
                  {e.kind !== 'event' && <button type="button" className="btn" disabled={act.busy} onClick={() => void choose({ play: true })}>Roll for me</button>}
                </div>
                <div className="row enc-crit" role="group" aria-label="Natural 20 or 1">
                  <button type="button" className={`btn small${crit === 'high' ? ' on' : ''}`} aria-pressed={crit === 'high'} onClick={() => setCrit(crit === 'high' ? '' : 'high')}><i className="fa-solid fa-star" aria-hidden="true" /> Natural 20</button>
                  <button type="button" className={`btn small${crit === 'low' ? ' on' : ''}`} aria-pressed={crit === 'low'} onClick={() => setCrit(crit === 'low' ? '' : 'low')}><i className="fa-solid fa-skull" aria-hidden="true" /> Natural 1</button>
                  {crit && <span className="tiny faint">{crit === 'high' ? 'Passes whatever the total.' : 'Fails whatever the total.'}</span>}
                </div>
              </form>
            )}
          </div>
        )}

        {open && (
          <div className="stack">
            {e.options.map((o, i) => (
              <button key={i} type="button" className={`btn enc-opt${i === 0 && !g ? ' primary' : ''}`} disabled={act.busy} onClick={() => void choose({ option: i })}>{o.label}</button>
            ))}
            {g && !e.options.length && <button type="button" className="btn ghost" disabled={act.busy} onClick={() => void leave()}>Walk away</button>}
          </div>
        )}

        {!open && (
          <div className="row">
            {e.shop && <Link className="btn primary" to={`/w/${info.slug}/shop?shop=${encodeURIComponent(e.shop.id)}`} onClick={onClose}><i className="fa-solid fa-store" aria-hidden="true" /> Browse {e.shop.name}</Link>}
            <button type="button" className="btn" onClick={onClose}>Done</button>
          </div>
        )}
        {open && e.shop && <Link className="small" to={`/w/${info.slug}/shop?shop=${encodeURIComponent(e.shop.id)}`} onClick={onFold}>Browse {e.shop.name} →</Link>}
      </div>
    </div>
  );
}

function LogLine({ l, npc }: { l: Line; npc: string }) {
  const who = l.who === 'npc' || l.who === 'dm' ? npc : l.who === 'you' ? 'You' : '';
  return (
    <div className={`enc-line ${l.who}`}>
      {who && <span className="enc-who">{who}</span>}
      <span>{l.text}</span>
    </div>
  );
}

/** Home page card: go looking for something to do while the GM is busy elsewhere. */
export function WanderCard() {
  const { w, info } = useWorld();
  const cfg = useLoad<EncounterConfig>(() => w.call('GET', '/encounters/config'), [w], ['settings', 'encounter']);
  const act = useAction();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  if (info.role !== 'player' || !cfg.data?.wander) return null;
  const wait = cfg.data.nextWanderAt && Date.parse(cfg.data.nextWanderAt) > Date.now() ? Math.ceil((Date.parse(cfg.data.nextWanderAt) - Date.now()) / 60_000) : 0;
  const go = () => act.run(async () => { await w.call('POST', '/encounters/wander'); await cfg.reload(); });
  return (
    <section className="card enc-wander" aria-labelledby="wander-h">
      <div className="card-head"><h2 id="wander-h"><i className="fa-solid fa-person-walking" aria-hidden="true" /> Wander about</h2></div>
      <span className="small muted">Not in the scene right now? Stroll around town and see who you meet. A game of chance, a small favour, a peddler’s cart…</span>
      <ErrorBox error={act.error} />
      <div className="row">
        <button type="button" className="btn primary" disabled={act.busy || wait > 0} onClick={() => void go()} data-testid="wander">Go for a wander</button>
        {wait > 0 && <span className="small faint">Nothing stirs yet. Try again in {wait} min.</span>}
      </div>
    </section>
  );
}

/** Player page: every NPC who has talked to me, and what was said, to look back on. */
export function MyEncounters() {
  const { w, info } = useWorld();
  const list = useLoad<Encounter[]>(() => w.call('GET', '/encounters'), [w], ['encounter']);
  if (info.role !== 'player') return <div className="page"><PageHead title="Encounters" /><Empty>Encounters are between an NPC and one player. As the GM, use the Encounters page.</Empty></div>;
  return (
    <div className="page">
      <PageHead title="Encounters" lead="NPCs who stopped to talk with you, and what was said." />
      <ErrorBox error={list.error} />
      {!list.data ? <Loading /> : !list.data.length ? <Empty>Nobody has stopped you yet.</Empty> : (
        <div className="stack loose">
          {list.data.map((e) => (
            <section key={e.id} className="card" data-testid="enc-history">
              <div className="row between">
                <strong>{e.npc.name}</strong>
                <span className="row" style={{ gap: 6 }}>
                  {e.status === 'open' && <span className="chip gold">Still talking</span>}
                  <span className="tiny faint">{when(e.createdAt)}</span>
                </span>
              </div>
              {e.npc.blurb && <span className="small muted">{e.npc.blurb}</span>}
              <div className="enc-log">{e.log.map((l, i) => <LogLine key={i} l={l} npc={e.npc.name} />)}</div>
              {e.shop && <Link className="small" to={`/w/${info.slug}/shop?shop=${encodeURIComponent(e.shop.id)}`}>Browse {e.shop.name} →</Link>}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
