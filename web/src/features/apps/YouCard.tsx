// "You" on the player's home page: your own HP, temporary HP, conditions and mana, big,
// and a banner when it is your turn. Shown only when there is something to show (a fight
// you are in, or a world that uses mana). The same numbers as the home-screen widget.
import { Link } from 'react-router-dom';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { GLANCE_EVENTS, type Glance } from './api.ts';

function Bar({ label, now, max, tone }: { label: string; now: number; max: number | null; tone: 'hp' | 'mana' }) {
  const pct = max && max > 0 ? Math.max(0, Math.min(100, Math.round((now / max) * 100))) : null;
  return (
    <div className={`you-bar ${tone}`}>
      <span className="you-label">{label}</span>
      <span className="you-track" aria-hidden="true">{pct !== null && <span style={{ width: `${pct}%` }} />}</span>
      <strong className="you-num" aria-label={`${label} ${now}${max !== null ? ` of ${max}` : ''}`}>{now}{max !== null && <span className="faint"> / {max}</span>}</strong>
    </div>
  );
}

export default function YouCard() {
  const { w, info, isDM } = useWorld();
  const g = useLoad<Glance>(() => w.call('GET', '/glance'), [w], GLANCE_EVENTS);
  const d = g.data;
  if (isDM || !d) return null;
  const me = d.combat.me;
  const hasHp = me && me.hp !== null;
  const hasMana = d.mana && d.mana.now !== null;
  if (!hasHp && !hasMana && !d.combat.myTurn) return null;
  return (
    <section className="card you-card" aria-labelledby="you-h" data-testid="you-card">
      <div className="card-head">
        <h2 id="you-h">{me?.name || d.name || 'You'}</h2>
        {d.combat.active && <Link to={`/w/${info.slug}/live`} className="small">Round {d.combat.round} →</Link>}
      </div>
      {d.combat.myTurn && <div role="status" className="you-turn">Your turn</div>}
      {hasHp && <Bar label="HP" now={me!.hp!} max={me!.maxHp} tone="hp" />}
      {hasHp && me!.tempHp > 0 && <span className="small muted">+{me!.tempHp} temporary HP</span>}
      {hasMana && <Bar label="Mana" now={d.mana!.now!} max={d.mana!.max} tone="mana" />}
      {me && me.conditions.length > 0 && <span className="you-cond">{me.conditions.join(', ')}</span>}
    </section>
  );
}
