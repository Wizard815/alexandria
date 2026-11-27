import type { WebFeature } from '../registry.ts';
import WorldLorePage from './WorldLorePage.tsx';
import WorldLoreSettings from './WorldLoreSettings.tsx';

const feature: WebFeature = {
  id: 'worldlore',
  gmRoutes: [{ path: 'worldlore', element: <WorldLorePage /> }],
  gmNav: [{ to: 'worldlore' }],
  settings: { title: 'WorldLore', component: WorldLoreSettings },
};
export default feature;
