import type { WebFeature } from '../registry.ts';
import MirrorPage from './MirrorPage.tsx';
import SourceFilesPage from './SourceFilesPage.tsx';

// Gateway admin pages for what the server is doing: the world mirror folders and the files held from sources.
// Connection health shows on Connections and Overview, and search insight on Search (see ConnStatus.tsx, SearchInsights.tsx).
// Data: /api/admin/gwstatus/*. The sidebar places are in layouts/AdminLayout.tsx.
const feature: WebFeature = {
  id: 'gwstatus',
  adminRoutes: [
    { path: 'mirror', element: <MirrorPage /> },
    { path: 'source-files', element: <SourceFilesPage /> },
  ],
  adminNav: [
    { to: 'mirror', label: 'World mirror' },
    { to: 'source-files', label: 'Source files' },
  ],
};
export default feature;
