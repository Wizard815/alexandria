import type { WebFeature } from '../registry.ts';
import ConnectionsPage from './ConnectionsPage.tsx';
import SetupFlow from './SetupFlow.tsx';
import WorldPage from './WorldPage.tsx';

// Admin → Connections, and the world pages under Admin → Worlds (the list is pages/admin/Worlds.tsx).
const feature: WebFeature = {
  id: 'connections',
  adminRoutes: [
    { path: 'connections', element: <ConnectionsPage /> },
    { path: 'worlds/setup', element: <SetupFlow /> },
    { path: 'worlds/:id', element: <WorldPage /> },
  ],
  adminNav: [{ to: 'connections', label: 'Connections' }],
};
export default feature;
