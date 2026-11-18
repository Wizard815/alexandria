import type { WebFeature } from '../registry.ts';
import ActivePage from './ActivePage.tsx';
import ActiveOverlay from './Cards.tsx';
import ModeBadge from './ModeBadge.tsx';

// The DM's Active mode. Nothing here is for players: every component checks the role,
// and the API refuses players too.
const feature: WebFeature = {
  id: 'active',
  dmRoutes: [{ path: 'active', element: <ActivePage /> }],
  dmNav: [{ group: 'At the table', to: 'active', label: '◉ Active mode' }],
  overlay: ActiveOverlay,
  topbar: ModeBadge,
};
export default feature;
