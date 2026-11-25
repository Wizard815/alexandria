import type { WebFeature } from '../registry.ts';
import EncountersDM, { EncountersNow } from './EncountersDM.tsx';
import PlayerEncounter, { MyEncounters, WanderCard } from './PlayerEncounter.tsx';

const feature: WebFeature = {
  id: 'encounters',
  dmRoutes: [{ path: 'encounters', element: <EncountersDM /> }],
  dmNav: [{ to: 'encounters' }],
  playerRoutes: [{ path: 'encounters', element: <MyEncounters /> }],
  playerNav: [{ to: 'encounters', label: 'Encounters', icon: 'fa-person-walking' }],
  overlay: PlayerEncounter,
  playerHome: [WanderCard],
  dmHome: [EncountersNow],
};
export default feature;
