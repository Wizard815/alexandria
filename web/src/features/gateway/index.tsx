import type { WebFeature } from '../registry.ts';
import Integrations from './Integrations.tsx';

// Gateway admin pages that read across worlds. Source keys, Permissions, Access and Search are tabs of the hubs in pages/admin/Hubs.tsx.
// Their data is /api/admin/gateway/* (read-only; no secrets, no GM-only text). Menu names and groups are in lib/adminnames.ts.
const feature: WebFeature = {
  id: 'gateway',
  adminRoutes: [
    { path: 'integrations', element: <Integrations /> },
  ],
  adminNav: [
    { to: 'integrations', label: 'Integrations' },
  ],
};
export default feature;
