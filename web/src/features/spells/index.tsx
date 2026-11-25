// The Codex: every spell in the world (SRD 5.2.1, homebrew, imports), mana
// instead of spell slots and spell crafting. See docs/SPELLS.md.
import { Link } from 'react-router-dom';
import type { WebFeature } from '../registry.ts';
import { useLoad, useWorld } from '../../lib/world.tsx';
import DMCodex from './DMCodex.tsx';
import PlayerCodex from './PlayerCodex.tsx';
import SpellSettings from './Settings.tsx';
import { CSS, ManaBar } from './shared.tsx';

function CodexPage() {
  const { isDM } = useWorld();
  return <><style>{CSS}</style>{isDM ? <DMCodex /> : <PlayerCodex />}</>;
}

/** On the player's home page: their mana, when the world uses it. */
function ManaCard() {
  const { w, info } = useWorld();
  const on = (info.settings as any).spellMana === true;
  const me = useLoad<any>(() => (on ? w.call('GET', '/spells/characters/me') : Promise.resolve(null)), [w, on], ['spells-char', 'settings']);
  if (!on || !me.data?.mana?.on) return null;
  return (
    <section className="card stack" aria-labelledby="mana-home">
      <style>{CSS}</style>
      <div className="card-head"><h2 id="mana-home">Mana</h2><Link className="btn small" to="codex">Codex</Link></div>
      <ManaBar mana={me.data.mana} />
    </section>
  );
}

const feature: WebFeature = {
  id: 'spells',
  dmRoutes: [{ path: 'codex', element: <CodexPage /> }],
  playerRoutes: [{ path: 'codex', element: <CodexPage /> }],
  dmNav: [{ to: 'codex' }],
  playerNav: [{ to: 'codex', label: 'Codex', icon: 'fa-book-journal-whills' }],
  settings: { title: 'Spells & mana', component: SpellSettings },
  playerHome: [ManaCard],
};
export default feature;
