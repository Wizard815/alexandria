import type { WebFeature } from '../registry.ts';
import EncountersDM from './EncountersDM.tsx';
import PlayerEncounter, { WanderCard } from './PlayerEncounter.tsx';

const feature: WebFeature = {
  id: 'encounters',
  dmRoutes: [{ path: 'encounters', element: <EncountersDM /> }],
  dmNav: [{ to: 'encounters' }],
  overlay: PlayerEncounter,
  playerHome: [WanderCard],
};
export default feature;
