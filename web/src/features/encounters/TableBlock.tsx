// Encounters and story events on the DM's Table: who is talking to whom right now, the last thing said, and when the next
// wandering NPC is due. A story event (an encounter of kind 'event', tied to a place) is marked as one.
import { useWorld, useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { TableCard } from '../../ui/TableCard.tsx';
import type { Encounter, EncounterConfig } from './types.ts';

export default function TableEncounters() {
  const { w } = useWorld();
  const list = useLoad<Encounter[]>(() => w.call('GET', '/encounters', undefined, { status: 'open' }), [w], ['encounter']);
  const cfg = useLoad<EncounterConfig>(() => w.call('GET', '/encounters/config'), [w], ['settings', 'encounter']);
  if (!list.data) return null;
  const open = list.data.filter((e) => e.status === 'open');
  const wander = cfg.data?.wander ? <span className="tiny faint"><i className="fa-solid fa-shoe-prints" aria-hidden="true" /> Wandering NPCs on{cfg.data.nextWanderAt ? ` · next ${when(cfg.data.nextWanderAt)}` : ''}</span> : null;
  if (!open.length) return <TableCard id="encounters" title="Encounters" icon="fa-person-walking" link={['encounters', 'Start one']} quiet={<>No one is meeting an NPC or a story event. {wander}</>} />;
  return (
    <TableCard id="encounters" title="Encounters" icon="fa-person-walking" tone="teal" badge={open.length} link={['encounters', 'Watch & reply']}>
      <ul className="tb-list">
        {open.slice(0, 5).map((e) => {
          const last = [...e.log].reverse().find((l) => l.who !== 'note');
          const event = (e as { kind?: string }).kind === 'event';
          return (
            <li key={e.id} data-testid="tb-encounter">
              <div className="row between">
                <span className="tb-ellipsis"><b>{e.player}</b> <span className="muted">{event ? 'in' : 'with'}</span> {e.npc.name}</span>
                <span className={`chip ${event ? 'gold' : e.source === 'wander' ? 'teal' : ''}`}>{event ? 'Story event' : e.source === 'wander' ? 'Wandered' : 'NPC'}</span>
              </div>
              <span className="small muted tb-ellipsis">{last ? `${last.who === 'you' ? `${e.player}: ` : last.who === 'npc' ? `${e.npc.name}: ` : ''}${last.text}` : 'Just started'}</span>
            </li>
          );
        })}
      </ul>
      {open.length > 5 && <span className="small muted">and {open.length - 5} more</span>}
      {wander}
    </TableCard>
  );
}
