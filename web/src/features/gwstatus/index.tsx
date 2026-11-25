import type { WebFeature } from '../registry.ts';

// Gateway admin pages for what the server is doing: the world mirror folders and the files held from sources.
// Connection health shows on Connections and Overview, and search insight on Search (see ConnStatus.tsx, SearchInsights.tsx).
// Data: /api/admin/gwstatus/*. They are tabs of the Sources and Search pages (pages/admin/Hubs.tsx).
const feature: WebFeature = {
  id: 'gwstatus',
};
export default feature;
