// The DM's Table: the splash page for a session, the world and the DM. A band across the top says what is true right now
// (the world's date and time, the session, who is at the table); the wide column is the play itself (the map on the table,
// the fight, scenes); the side column is what is waiting on the DM; the world row at the bottom is shops, coin and the
// library. Features add blocks to any zone through the registry (dmTable); every block can be hidden on this device.
import * as F from '../../features/registry.ts';
import type { TableBlock, TableZone } from '../../features/registry.ts';
import { useState } from 'react';
import { PageHead } from '../../ui/index.tsx';
import { useWorld } from '../../lib/world.tsx';
import { lsGet, lsSet } from './shared.tsx';
import { CombatBlock, HereBlock, LibraryBlock, MapBlock, MessagesBlock, NeedsBlock, PurseBlock, SessionBlock } from './TableBlocks.tsx';
import './table.css';

const BUILTIN: TableBlock[] = [
  { id: 'session', label: 'Session', zone: 'now', order: 20, component: SessionBlock },
  { id: 'here', label: 'Who is here', zone: 'now', order: 30, component: HereBlock },
  { id: 'map', label: 'Map on the table', zone: 'main', order: 20, component: MapBlock },
  { id: 'combat', label: 'Combat', zone: 'main', order: 10, component: CombatBlock },
  { id: 'needs', label: 'Waiting on you', zone: 'side', order: 10, component: NeedsBlock },
  { id: 'messages', label: 'Messages', zone: 'side', order: 50, component: MessagesBlock },
  { id: 'purse', label: 'Party pouch', zone: 'world', order: 20, component: PurseBlock },
  { id: 'library', label: 'Library', zone: 'world', order: 30, component: LibraryBlock },
];

const ZONES: { id: TableZone; label: string }[] = [
  { id: 'now', label: 'Right now' }, { id: 'main', label: 'Play' }, { id: 'side', label: 'Waiting on you' }, { id: 'world', label: 'The world' },
];

// The first Table remembered the blocks it showed; this one remembers the ones hidden, so a new block shows up on its own.
const OLD_IDS: Record<string, string> = { here: 'here', purse: 'purse', combat: 'combat', requests: 'needs', quick: 'needs', messages: 'messages', library: 'library' };

function useHidden(worldId: string) {
  const key = `alx.dm.table.hidden.${worldId}`;
  const [hidden, setHidden] = useState<string[]>(() => {
    const now = lsGet<string[] | null>(key, null);
    if (now) return now;
    const shown = lsGet<string[] | null>(`alx.dm.table.${worldId}`, null);
    if (!shown) return [];
    // A block that took over old ones stays if any of them was shown.
    return [...new Set(Object.values(OLD_IDS))].filter((id) => !Object.entries(OLD_IDS).some(([old, nid]) => nid === id && shown.includes(old)));
  });
  const toggle = (id: string) => {
    const next = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
    setHidden(next);
    lsSet(key, next);
  };
  return { hidden, toggle };
}

export default function DMTable() {
  const { info } = useWorld();
  const { hidden, toggle } = useHidden(info.id);
  const [picking, setPicking] = useState(false);
  const blocks = [...BUILTIN, ...F.dmTable].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  const zone = (z: TableZone) => blocks.filter((b) => b.zone === z && !hidden.includes(b.id));
  const render = (list: TableBlock[]) => list.map((b) => <b.component key={b.id} />);

  return (
    <div className="page wide tb-page" data-testid="dm-table">
      <PageHead title="Table" lead={`${info.name}, live: the world, the session and what needs you.`}>
        <button type="button" className={`btn small${picking ? ' on' : ''}`} aria-expanded={picking} onClick={() => setPicking(!picking)}>
          <i className="fa-solid fa-sliders" aria-hidden="true" /> Choose blocks
        </button>
      </PageHead>
      {picking && (
        <div className="card tb-pick" data-testid="table-pick">
          <span className="small muted">Show these blocks (remembered on this device):</span>
          {ZONES.map((z) => (
            <div key={z.id} className="row" role="group" aria-label={z.label}>
              <span className="tiny faint tb-pick-zone">{z.label}</span>
              {blocks.filter((b) => b.zone === z.id).map((b) => (
                <button key={b.id} type="button" role="checkbox" aria-checked={!hidden.includes(b.id)} className={`btn small${hidden.includes(b.id) ? '' : ' on'}`} onClick={() => toggle(b.id)}>{b.label}</button>
              ))}
            </div>
          ))}
        </div>
      )}

      {zone('now').length > 0 && <div className="tb-now" data-testid="table-now">{render(zone('now'))}</div>}

      <div className="tb-body">
        <div className="tb-main" data-testid="table-main">{render(zone('main'))}</div>
        <aside className="tb-side" aria-label="Waiting on you" data-testid="table-side">
          {F.dmHome.map((C, i) => <C key={`home-${i}`} />)}
          {render(zone('side'))}
        </aside>
      </div>

      {zone('world').length > 0 && (
        <section className="tb-world" aria-labelledby="tb-world-h">
          <h2 id="tb-world-h" className="tb-zone-h"><i className="fa-solid fa-globe" aria-hidden="true" /> The world</h2>
          <div className="tb-world-grid">{render(zone('world'))}</div>
        </section>
      )}
    </div>
  );
}
