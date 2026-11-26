// The DM's Table: the splash page for a session, the world and the DM. A band across the top says what is true right now
// (the world's date and time, the session, who is at the table); the wide column is the play itself (the fight, the map,
// scenes); the side column is what is waiting on the DM; the world row at the bottom is shops, coin and the library.
// It is a dashboard the DM arranges: Arrange lets each block be dragged (or moved with buttons) to another place or zone,
// made wide, hidden, or brought back from the list of hidden blocks. Features add blocks through the registry (dmTable).
// The arrangement is kept on this device.
import * as F from '../../features/registry.ts';
import type { TableBlock, TableZone } from '../../features/registry.ts';
import { useState, type DragEvent } from 'react';
import { PageHead } from '../../ui/index.tsx';
import { useWorld } from '../../lib/world.tsx';
import { lsGet, lsSet } from './shared.tsx';
import { CombatBlock, HereBlock, LibraryBlock, MapBlock, MessagesBlock, NeedsBlock, PurseBlock, SessionBlock } from './TableBlocks.tsx';
import { ComingUpBlock, DiceBlock, LinksBlock, NamesBlock, NotesBlock, PeopleBlock, QuickEventsBlock, RecapBlock, SoundBlock, StageBlock } from './TableExtras.tsx';
import './table.css';

const BUILTIN: TableBlock[] = [
  { id: 'session', label: 'Session', zone: 'now', order: 20, component: SessionBlock },
  { id: 'here', label: 'At the table', zone: 'now', order: 30, component: HereBlock },
  { id: 'combat', label: 'Combat', zone: 'main', order: 10, component: CombatBlock },
  { id: 'map', label: 'Map', zone: 'main', order: 20, component: MapBlock },
  { id: 'stage', label: 'Stage', zone: 'main', order: 40, component: StageBlock },
  { id: 'sound', label: 'Sound', zone: 'main', order: 50, component: SoundBlock },
  { id: 'needs', label: 'Waiting on you', zone: 'side', order: 10, component: NeedsBlock },
  { id: 'quick', label: 'Quick events', zone: 'side', order: 30, component: QuickEventsBlock },
  { id: 'dice', label: 'Dice', zone: 'main', order: 60, component: DiceBlock },
  { id: 'names', label: 'NPC names', zone: 'main', order: 70, component: NamesBlock },
  { id: 'messages', label: 'Messages', zone: 'side', order: 50, component: MessagesBlock },
  { id: 'notes', label: 'Notes', zone: 'main', order: 80, component: NotesBlock },
  { id: 'coming', label: 'Coming up', zone: 'world', order: 5, component: ComingUpBlock },
  { id: 'purse', label: 'Party pouch', zone: 'world', order: 20, component: PurseBlock },
  { id: 'recap', label: 'Last time', zone: 'world', order: 25, component: RecapBlock },
  { id: 'people', label: 'People', zone: 'world', order: 27, component: PeopleBlock },
  { id: 'library', label: 'Library', zone: 'world', order: 30, component: LibraryBlock },
  { id: 'links', label: 'Quick links', zone: 'world', order: 40, component: LinksBlock },
];

const ZONES: { id: TableZone; label: string }[] = [
  { id: 'now', label: 'Top band' }, { id: 'main', label: 'Play column' }, { id: 'side', label: 'Side column' }, { id: 'world', label: 'World row' },
];

interface Place { zone: TableZone; order: number; wide?: boolean }
interface Layout { places: Record<string, Place>; hidden: string[] }

// The first Table remembered the blocks it showed, the second the ones hidden; both carry over.
const OLD_IDS: Record<string, string> = { here: 'here', purse: 'purse', combat: 'combat', requests: 'needs', quick: 'needs', messages: 'messages', library: 'library' };

function useLayout(worldId: string) {
  const key = `alx.dm.table.layout.${worldId}`;
  const [layout, setLayout] = useState<Layout>(() => {
    const now = lsGet<Layout | null>(key, null);
    if (now && now.places && Array.isArray(now.hidden)) return now;
    const hidden2 = lsGet<string[] | null>(`alx.dm.table.hidden.${worldId}`, null);
    if (hidden2) return { places: {}, hidden: hidden2 };
    const shown = lsGet<string[] | null>(`alx.dm.table.${worldId}`, null);
    if (!shown) return { places: {}, hidden: [] };
    return { places: {}, hidden: [...new Set(Object.values(OLD_IDS))].filter((id) => !Object.entries(OLD_IDS).some(([old, nid]) => nid === id && shown.includes(old))) };
  });
  const save = (l: Layout) => { setLayout(l); lsSet(key, l); };
  return { layout, save, reset: () => save({ places: {}, hidden: [] }) };
}

export default function DMTable() {
  const { info } = useWorld();
  const { layout, save, reset } = useLayout(info.id);
  const [arranging, setArranging] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const defs = [...BUILTIN, ...F.dmTable];
  const byId = new Map(defs.map((b) => [b.id, b]));
  const place = (b: TableBlock): Place => layout.places[b.id] ?? { zone: b.zone, order: b.order ?? 100 };
  const hidden = (id: string) => layout.hidden.includes(id);
  const zoneIds = (z: TableZone) => defs.filter((b) => place(b).zone === z && !hidden(b.id)).sort((a, b) => place(a).order - place(b).order).map((b) => b.id);

  /** Put a block in a zone, before another block (or at the end), and number the zone again. */
  const moveTo = (id: string, zone: TableZone, before: string | null) => {
    const list = zoneIds(zone).filter((x) => x !== id);
    const at = before ? list.indexOf(before) : -1;
    list.splice(at < 0 ? list.length : at, 0, id);
    const places = { ...layout.places };
    list.forEach((x, i) => { const b = byId.get(x)!; places[x] = { ...place(b), zone, order: (i + 1) * 10 }; });
    save({ places, hidden: layout.hidden.filter((x) => x !== id) });
  };
  const step = (id: string, by: -1 | 1) => {
    const b = byId.get(id)!;
    const list = zoneIds(place(b).zone);
    const i = list.indexOf(id), j = i + by;
    if (j < 0 || j >= list.length) return;
    moveTo(id, place(b).zone, by < 0 ? list[j] : list[j + 1] ?? null);
  };
  const toggleWide = (id: string) => { const b = byId.get(id)!; save({ ...layout, places: { ...layout.places, [id]: { ...place(b), wide: !place(b).wide } } }); };
  const hide = (id: string) => save({ ...layout, hidden: [...layout.hidden, id] });

  const onDrop = (zone: TableZone, before: string | null) => (e: DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    const id = e.dataTransfer.getData('text/x-tb-block') || dragging;
    setDragging(null);
    if (id && id !== before) moveTo(id, zone, before);
  };
  const allow = (e: DragEvent) => { if (arranging) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } };

  const render = (zone: TableZone) => zoneIds(zone).map((id, i, list) => {
    const b = byId.get(id)!;
    const p = place(b);
    const C = b.component;
    return (
      <div key={id} className={`tb-slot${p.wide ? ' wide' : ''}${arranging ? ' arranging' : ''}${dragging === id ? ' dragging' : ''}`} data-block={id}
        draggable={arranging} onDragStart={(e) => { e.dataTransfer.setData('text/x-tb-block', id); e.dataTransfer.effectAllowed = 'move'; setDragging(id); }}
        onDragEnd={() => setDragging(null)} onDragOver={allow} onDrop={arranging ? onDrop(zone, id) : undefined}>
        {arranging && (
          <div className="tb-tools" role="group" aria-label={`Arrange ${b.label}`}>
            <i className="fa-solid fa-grip-vertical tb-grip" aria-hidden="true" />
            <b className="grow tb-ellipsis">{b.label}</b>
            <button type="button" aria-label={`Move ${b.label} up`} disabled={i === 0} onClick={() => step(id, -1)}><i className="fa-solid fa-arrow-up" aria-hidden="true" /></button>
            <button type="button" aria-label={`Move ${b.label} down`} disabled={i === list.length - 1} onClick={() => step(id, 1)}><i className="fa-solid fa-arrow-down" aria-hidden="true" /></button>
            <select aria-label={`Where ${b.label} goes`} value={zone} onChange={(e) => moveTo(id, e.target.value as TableZone, null)}>
              {ZONES.map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}
            </select>
            {(zone === 'now' || zone === 'world') && <button type="button" aria-pressed={!!p.wide} title="Twice as wide" aria-label={`Make ${b.label} ${p.wide ? 'narrow' : 'wide'}`} onClick={() => toggleWide(id)}><i className={`fa-solid ${p.wide ? 'fa-compress' : 'fa-expand'}`} aria-hidden="true" /></button>}
            <button type="button" aria-label={`Hide ${b.label}`} title="Hide" onClick={() => hide(id)} data-testid={`tb-hide-${id}`}><i className="fa-solid fa-eye-slash" aria-hidden="true" /></button>
          </div>
        )}
        <C />
      </div>
    );
  });
  const zoneBox = (zone: TableZone, className: string, extra?: React.ReactNode) => (
    <div className={`${className}${arranging ? ' drop' : ''}`} data-testid={`table-${zone}`} onDragOver={allow} onDrop={arranging ? onDrop(zone, null) : undefined}>
      {extra}
      {render(zone)}
      {arranging && !zoneIds(zone).length && <div className="tb-empty-zone">Drop a block here</div>}
    </div>
  );
  const hiddenDefs = defs.filter((b) => hidden(b.id));

  return (
    <div className={`page wide tb-page${arranging ? ' tb-arranging' : ''}`} data-testid="dm-table">
      <PageHead title="Table" lead={`${info.name}, live: the world, the session and what needs you.`}>
        {arranging && <button type="button" className="btn small ghost" onClick={() => reset()}>Reset layout</button>}
        <button type="button" className={`btn small${arranging ? ' primary' : ''}`} aria-pressed={arranging} onClick={() => setArranging(!arranging)} data-testid="table-arrange">
          <i className={`fa-solid ${arranging ? 'fa-check' : 'fa-table-cells-large'}`} aria-hidden="true" /> {arranging ? 'Done' : 'Arrange'}
        </button>
      </PageHead>
      {arranging && (
        <div className="card tb-pick" data-testid="table-pick">
          <span className="small muted">Drag a block by its bar, or use the arrows and the place picker. Wide blocks take two columns in the top band and the world row. The layout is kept on this device.</span>
          {hiddenDefs.length > 0 ? (
            <div className="row" role="group" aria-label="Hidden blocks">
              <span className="tiny faint tb-pick-zone">Hidden</span>
              {hiddenDefs.map((b) => <button key={b.id} type="button" className="btn small" onClick={() => moveTo(b.id, place(b).zone, null)} data-testid={`tb-show-${b.id}`}><i className="fa-solid fa-plus" aria-hidden="true" /> {b.label}</button>)}
            </div>
          ) : <span className="tiny faint">Every block is showing. Hide one with its <i className="fa-solid fa-eye-slash" aria-hidden="true" /> button.</span>}
        </div>
      )}

      {(zoneIds('now').length > 0 || arranging) && zoneBox('now', 'tb-now')}

      <div className="tb-body">
        {zoneBox('main', 'tb-main')}
        {zoneBox('side', 'tb-side', F.dmHome.map((C, i) => <C key={`home-${i}`} />))}
      </div>

      {(zoneIds('world').length > 0 || arranging) && (
        <section className="tb-world" aria-labelledby="tb-world-h">
          <h2 id="tb-world-h" className="tb-zone-h"><i className="fa-solid fa-globe" aria-hidden="true" /> The world</h2>
          {zoneBox('world', 'tb-world-grid')}
        </section>
      )}
    </div>
  );
}
