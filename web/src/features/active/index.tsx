import type { WebFeature } from '../registry.ts';
import ActivePage from './ActivePage.tsx';
import ActiveOverlay from './Cards.tsx';
import ModeBadge from './ModeBadge.tsx';

// The GM's Active mode. Nothing here is for players: every component checks the role,
// and the API refuses players too.
const feature: WebFeature = {
  id: 'active',
  gmRoutes: [{ path: 'active', element: <ActivePage /> }],
  gmNav: [{ to: 'active' }],
  overlay: ActiveOverlay,
  topbar: ModeBadge,
};
export default feature;
