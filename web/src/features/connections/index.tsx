import type { WebFeature } from '../registry.ts';
import SetupFlow from './SetupFlow.tsx';
import WorldPage from './WorldPage.tsx';

// Admin → Connections, and the world pages under Admin → Worlds (the list is pages/admin/Worlds.tsx).
const feature: WebFeature = {
  id: 'connections',
  adminRoutes: [
    { path: 'worlds/setup', element: <SetupFlow /> },
    { path: 'worlds/:id', element: <WorldPage /> },
  ],
};
export default feature;
