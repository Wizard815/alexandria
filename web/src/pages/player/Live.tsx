// The live session for a player: who is here, the party purse, my coin,
// and combat as the DM lets me see it. No health numbers, ever.
import { useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { coins } from '../../lib/format.ts';
import { AlertsCard, useMine } from '../broker/shared.tsx';
import { PageHead, Loading, ErrorBox, Empty, useAction } from '../../ui/index.tsx';

const PLACES = ['At the table', 'Discord', 'On the phone', 'Running late'];

export interface LiveView {
  here: { account_id: string; location: string; at: string; display_name: string; character_name: string | null; role: string }[];
  members: number;
  purse: { cp: number; recent: { id: string; amount_cp: number; note: string; session_label: string | null; at: string; status?: 'approved' | 'pending' }[] } | null;
  myCoin: number;
  combat: CombatView;
  captions: boolean;
}
export interface CombatView {
  active: boolean; round: number; myTurn?: boolean; currentId?: string | null;
  combatants?: { id: string; name: string; is_pc: boolean; mine: boolean; effects: { name: string; rounds?: number }[]; health: string | null }[];
}

export default function PlayerLive() {
  const { w, me, info } = useWorld();
  const live = useLoad(() => w.live() as Promise<LiveView>, [w], ['presence', 'coin', 'combat', 'settings', 'approval']);
  const mine = useMine();
  const act = useAction();
  const [place, setPlace] = useState(PLACES[0]);
  const mode = info.settings.coins;

  if (live.loading && !live.data) return <div className="page"><Loading what="the session" /></div>;
  const d = live.data;
  const amHere = !!d?.here.find((h) => h.account_id === me);

  return (
    <div className="page">
      <PageHead title="Live session" lead="Who's here, the party purse, and the fight as you can see it." />
      <ErrorBox error={live.error ?? act.error} />
      {d && (
        <div className="cols">
          <div className="col-3 stack loose">
            <CombatPanel c={d.combat} />
            {d.captions && <div className="note">Live captions show here when the DM turns on transcription for this session.</div>}
          </div>
          <aside className="col-1 stack loose">
            <section className="card" aria-labelledby="here-h">
              <div className="card-head"><h2 id="here-h">Here tonight</h2><span className="tiny muted">{d.here.length} of {d.members}</span></div>
              {amHere ? (
                <div className="row">
                  <span className="chip green">You're here · {d.here.find((h) => h.account_id === me)?.location}</span>
                  <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(async () => { await w.leave(); await live.reload(); })}>Leave</button>
                </div>
              ) : (
                <div className="row">
                  <label className="sr-only" htmlFor="here-where">Where are you</label>
                  <select id="here-where" className="input" style={{ width: 'auto' }} value={place} onChange={(e) => setPlace(e.target.value)}>
                    {PLACES.map((p) => <option key={p}>{p}</option>)}
                  </select>
                  <button type="button" className="btn primary small" disabled={act.busy} onClick={() => void act.run(async () => { await w.here(place); await live.reload(); })}>I'm here</button>
                </div>
              )}
              {d.here.length ? (
                <ul className="stack tight" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {d.here.map((h) => (
                    <li key={h.account_id} className="row" style={{ gap: 8 }}>
                      <span className="live-dot" aria-hidden="true" />
                      <span className="grow"><strong style={{ fontWeight: 500 }}>{h.character_name || h.display_name}</strong>{h.role === 'dm' && <span className="chip red" style={{ marginLeft: 6 }}>DM</span>}</span>
                      <span className="tiny muted">{h.location}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="muted small">Nobody has checked in yet.</p>}
            </section>

            {d.purse && (
              <section className="card gold" aria-labelledby="purse-h">
                <h2 id="purse-h">Party purse</h2>
                <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent-strong)' }}>{coins(d.purse.cp, mode)}</span>
                {d.purse.recent.length ? (
                  <ul className="stack tight small" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {d.purse.recent.slice(0, 8).map((e) => (
                      <li key={e.id} className="row between" style={{ gap: 6, opacity: e.status === 'pending' ? 0.7 : 1 }}>
                        <span className="grow">{e.note || (e.amount_cp > 0 ? 'Added' : 'Spent')}{e.session_label && <span className="faint"> · {e.session_label}</span>}{e.status === 'pending' && <span className="chip teal" style={{ marginLeft: 6 }}>Waiting for the DM</span>}</span>
                        <span style={{ color: e.amount_cp >= 0 ? 'var(--ok-text)' : 'var(--danger-text)', fontVariantNumeric: 'tabular-nums' }}>{e.amount_cp >= 0 ? '+' : ''}{coins(e.amount_cp, mode)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="muted small">No coin moved yet.</p>}
                <hr />
                <div className="row between small"><span className="muted">Your own coin</span><a href={`/w/${info.slug}/inventory`}>{coins(d.myCoin, mode)}</a></div>
              </section>
            )}
            {!d.purse && <section className="card"><div className="row between small"><span className="muted">Your coin</span><strong>{coins(d.myCoin, mode)}</strong></div></section>}
            <AlertsCard mine={mine.data} reload={mine.reload} compact />
          </aside>
        </div>
      )}
    </div>
  );
}

export function CombatPanel({ c, compact = false }: { c: CombatView; compact?: boolean }) {
  if (!c.active) {
    return compact ? null : <section className="card"><h2>No fight right now</h2><p className="muted">When the DM starts combat, the turn order shows here.</p></section>;
  }
  return (
    <section className="card gold" aria-labelledby="combat-h">
      <div className="card-head"><h2 id="combat-h">Combat</h2><span className="muted small">Round {c.round}</span></div>
      {c.myTurn && (
        <div role="status" className="row" style={{ padding: '12px 14px', borderRadius: 8, background: 'var(--accent-bg)', border: '1px solid var(--accent)' }}>
          <strong style={{ fontFamily: 'var(--font-head)', fontSize: 20, color: 'var(--accent-strong)' }}>Your turn</strong>
        </div>
      )}
      {c.combatants ? (
        c.combatants.length ? (
          <ol className="stack tight" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {c.combatants.map((x) => (
              <li key={x.id} aria-current={x.id === c.currentId ? 'step' : undefined} className="row" style={{
                gap: 8, padding: '9px 12px', borderRadius: 6,
                background: x.id === c.currentId ? 'var(--accent-bg)' : 'var(--bg)',
                border: `1px solid ${x.id === c.currentId ? 'var(--accent)' : x.mine ? 'var(--line-strong)' : 'var(--line)'}`,
              }}>
                <span className="grow"><strong>{x.name}</strong>{x.mine && <span className="faint"> (you)</span>}
                  {x.effects.length > 0 && <span className="muted small"> · {x.effects.map((e) => e.rounds ? `${e.name} (${e.rounds})` : e.name).join(', ')}</span>}
                </span>
                {x.health && <span className="small muted">{/^\d+$/.test(x.health) ? <HealthBar pct={Number(x.health)} /> : x.health}</span>}
              </li>
            ))}
          </ol>
        ) : <Empty>No one in the turn order yet.</Empty>
      ) : <p className="muted small">The DM keeps the turn order hidden in this world. You'll see “Your turn” when it's yours.</p>}
      {!compact && <span className="tiny faint">You see the turn order, effects, and how hurt foes look, as far as the DM allows. Your HP stays in your sheet.</span>}
    </section>
  );
}

function HealthBar({ pct }: { pct: number }) {
  return (
    <span role="img" aria-label={`${pct}% health`} style={{ display: 'inline-block', width: 70, height: 8, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden', verticalAlign: 'middle' }}>
      <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: pct > 50 ? 'var(--ok)' : pct > 25 ? 'var(--accent)' : 'var(--danger)' }} />
    </span>
  );
}

