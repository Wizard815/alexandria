import type { WebFeature } from '../registry.ts';
import FoundryPage from './FoundryPage.tsx';

// GM → Setup → Foundry VTT: connect a Foundry world (see librarian/src/features/foundry).
const feature: WebFeature = {
  id: 'foundry',
  gmRoutes: [{ path: 'foundry', element: <FoundryPage /> }],
  gmNav: [{ to: 'foundry' }],
};
export default feature;
