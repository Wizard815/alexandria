import type { WebFeature } from '../registry.ts';
import EncountersDM from './EncountersDM.tsx';
import TableEncounters from './TableBlock.tsx';
import PlayerEncounter, { MyEncounters, WanderCard } from './PlayerEncounter.tsx';

const feature: WebFeature = {
  id: 'encounters',
  dmRoutes: [{ path: 'encounters', element: <EncountersDM /> }],
  dmNav: [{ to: 'encounters' }],
  playerRoutes: [{ path: 'encounters', element: <MyEncounters /> }],
  playerNav: [{ to: 'encounters', label: 'Encounters', icon: 'fa-person-walking' }],
  overlay: PlayerEncounter,
  playerHome: [WanderCard],
  dmTable: [{ id: 'encounters', label: 'Encounters & story events', zone: 'side', order: 20, component: TableEncounters }],
};
export default feature;
