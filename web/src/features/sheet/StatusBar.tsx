// The DM's status bar, at the top of every DM page: each player's name,
// health (with temporary HP and conditions) and mana. A tap opens that
// player's sheet. Live: it follows the sheets, the combat tracker and mana.
import { Link } from 'react-router-dom';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { HpBar, ManaMeter, type PartyRow } from './shared.tsx';

export default function PartyStatusBar() {
  const { w, info, isDM } = useWorld();
  const party = useLoad<{ players: PartyRow[] }>(() => (isDM ? w.call('GET', '/sheet/party') : Promise.resolve({ players: [] })), [w, isDM], ['sheet', 'spells-char', 'combat', 'settings', 'member']);
  const players = party.data?.players ?? [];
  if (!isDM || !players.length) return null;
  return (
    <nav className="sht-status" aria-label="Party health and mana" data-testid="party-status">
      {players.map((p) => {
        const down = p.hp === 0;
        const ds = p.deathSaves;
        const manaNow = p.mana.on && p.mana.max !== null && p.mana.max !== undefined ? p.mana.now ?? p.mana.max : null;
        return (
          <Link key={p.accountId} to={`/w/${info.slug}/dm/sheets?player=${p.accountId}`} className={`sht-pc${down ? ' down' : ''}`} title={`${p.name} (${p.player})${p.conditions.length ? `: ${p.conditions.join(', ')}` : ''}`}>
            <span className="row between">
              <span className="nm">{p.inCombat && <i className="fa-solid fa-khanda faint" aria-label="In combat" style={{ marginRight: 4 }} />}{p.name}</span>
              <span className="nums" aria-label={`HP ${p.hp ?? 'not set'}${p.maxHp !== null ? ` of ${p.maxHp}` : ''}`}>
                {p.hp ?? '—'}/{p.maxHp ?? '—'}{p.tempHp > 0 && <span style={{ color: 'var(--teal)' }}> +{p.tempHp}</span>}
              </span>
            </span>
            <HpBar hp={p.hp} maxHp={p.maxHp} tempHp={p.tempHp} small />
            {manaNow !== null && <span className="row between"><ManaMeter mana={p.mana} small /><span className="nums" style={{ marginLeft: 6 }} aria-label={`Mana ${manaNow} of ${p.mana.max}`}>{manaNow}/{p.mana.max}</span></span>}
            {(p.conditions.length > 0 || (down && ds)) && (
              <span className="tiny" style={{ color: down ? 'var(--danger-text)' : 'var(--accent-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {down && ds ? (ds.dead ? 'Dead' : ds.stable ? 'Stable' : `Dying ${ds.successes}✓ ${ds.failures}✗`) : ''}{down && ds && p.conditions.length ? ' · ' : ''}{p.conditions.join(', ')}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
