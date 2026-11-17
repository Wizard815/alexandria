import type { WebFeature } from '../registry.ts';
import SourceKeysAdmin from './SourceKeysAdmin.tsx';
import Permissions from './Permissions.tsx';
import Integrations from './Integrations.tsx';
import AdminSearch from './Search.tsx';
import Access from './Access.tsx';

// Gateway admin pages that read across worlds: Source keys, Permissions & leak guard, Integrations.
// Their data is /api/admin/gateway/* (read-only; no secrets, no DM-only text). The sidebar groups are in layouts/AdminLayout.tsx.
const feature: WebFeature = {
  id: 'gateway',
  adminRoutes: [
    { path: 'source-keys', element: <SourceKeysAdmin /> },
    { path: 'permissions', element: <Permissions /> },
    { path: 'integrations', element: <Integrations /> },
    { path: 'search', element: <AdminSearch /> },
    { path: 'access', element: <Access /> },
  ],
  adminNav: [
    { to: 'source-keys', label: 'Source keys' },
    { to: 'permissions', label: 'Permissions' },
    { to: 'integrations', label: 'Integrations' },
    { to: 'search', label: 'Search' },
    { to: 'access', label: 'Access & MCP' },
  ],
};
export default feature;
