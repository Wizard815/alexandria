import type { WebFeature } from '../registry.ts';
import FoundryPage from './FoundryPage.tsx';

// DM → Setup → Foundry VTT: connect a Foundry world (see librarian/src/features/foundry).
const feature: WebFeature = {
  id: 'foundry',
  dmRoutes: [{ path: 'foundry', element: <FoundryPage /> }],
  dmNav: [{ to: 'foundry' }],
};
export default feature;
