import type { WebFeature } from '../registry.ts';
import WorldLorePage from './WorldLorePage.tsx';
import WorldLoreSettings from './WorldLoreSettings.tsx';

const feature: WebFeature = {
  id: 'worldlore',
  dmRoutes: [{ path: 'worldlore', element: <WorldLorePage /> }],
  dmNav: [{ group: 'The world', to: 'worldlore', label: 'WorldLore' }],
  settings: { title: 'WorldLore', component: WorldLoreSettings },
};
export default feature;
