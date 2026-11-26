// The DM's status bar, at the top of every DM page: each player's name,
// health (with temporary HP and conditions) and mana. A tap opens that
// player's sheet. Live: it follows the sheets, the combat tracker and mana.
// A tap opens a quick panel where the DM deals damage, heals, adds
// conditions and changes mana, with a link to the whole sheet.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { ErrorBox, Loading, Modal, useAction } from '../../ui/index.tsx';
import { ManaMod, Vitals } from './Sheet.tsx';
import { HpBar, ManaMeter, type PartyRow, type Sheet } from './shared.tsx';

export default function PartyStatusBar() {
  const { w, info, isDM } = useWorld();
  const party = useLoad<{ players: PartyRow[] }>(() => (isDM ? w.call('GET', '/sheet/party') : Promise.resolve({ players: [] })), [w, isDM], ['sheet', 'spells-char', 'combat', 'settings', 'member']);
  const players = party.data?.players ?? [];
  const [open, setOpen] = useState<string | null>(null);
  if (!isDM || !players.length) return null;
  return (
    <nav className="sht-status" aria-label="Party health and mana" data-testid="party-status">
      {players.map((p) => {
        const down = p.hp === 0;
        const ds = p.deathSaves;
        const manaNow = p.mana.on && p.mana.max !== null && p.mana.max !== undefined ? p.mana.now ?? p.mana.max : null;
        return (
          <button type="button" key={p.accountId} onClick={() => setOpen(p.accountId)} className={`sht-pc${down ? ' down' : ''}`} title={`${p.name} (${p.player})${p.conditions.length ? `: ${p.conditions.join(', ')}` : ''}`}>
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
          </button>
        );
      })}
      {open && <Quick account={open} slug={info.slug} onClose={() => setOpen(null)} />}
    </nav>
  );
}

/** The DM's quick panel for one player: health, conditions and mana. */
function Quick({ account, slug, onClose }: { account: string; slug: string; onClose: () => void }) {
  const { w, info } = useWorld();
  const sheet = useLoad<Sheet>(() => w.call('GET', `/sheet/${account}`), [w, account], ['sheet', 'spells-char', 'combat']);
  const act = useAction();
  const post = (what: 'vitals' | 'mana') => (body: Record<string, unknown>) => act.run(async () => { await w.call('POST', `/sheet/${account}/${what}`, body); await sheet.reload(); });
  const s = sheet.data;
  return (
    <Modal title={s ? s.name : 'Player'} onClose={onClose}>
      {!s ? <Loading /> : <div className="stack" data-testid="quick-sheet">
        <ErrorBox error={act.error} />
        <div className="sht-quick">
          <section className="stack tight"><span className="tiny faint">Health and conditions</span><Vitals s={s} onChange={post('vitals')} busy={act.busy} /></section>
          {(info.settings as any).spellMana === true && <section className="stack tight"><span className="tiny faint">Mana</span><ManaMod s={s} onChange={post('mana')} busy={act.busy} /></section>}
        </div>
        <span className="tiny faint">Every change is logged and the player sees it at once.</span>
        <Link className="btn small" to={`/w/${slug}/dm/sheets?player=${account}`} onClick={onClose}>Open the whole sheet</Link>
      </div>}
    </Modal>
  );
}
