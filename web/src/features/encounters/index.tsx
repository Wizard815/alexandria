import type { WebFeature } from '../registry.ts';
import EncountersGM from './EncountersGM.tsx';
import TableEncounters from './TableBlock.tsx';
import PlayerEncounter, { MyEncounters, WanderCard } from './PlayerEncounter.tsx';

const feature: WebFeature = {
  id: 'encounters',
  gmRoutes: [{ path: 'encounters', element: <EncountersGM /> }],
  gmNav: [{ to: 'encounters' }],
  playerRoutes: [{ path: 'encounters', element: <MyEncounters /> }],
  playerNav: [{ to: 'encounters', label: 'Encounters', icon: 'fa-person-walking' }],
  overlay: PlayerEncounter,
  playerHome: [WanderCard],
  gmTable: [{ id: 'encounters', label: 'Encounters & story events', zone: 'side', order: 20, component: TableEncounters }],
};
export default feature;
