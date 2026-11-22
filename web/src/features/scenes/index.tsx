import type { WebFeature } from '../registry.ts';
import ScenesPage from './ScenesPage.tsx';

const feature: WebFeature = {
  id: 'scenes',
  dmRoutes: [{ path: 'scenes', element: <ScenesPage /> }],
  dmNav: [{ group: 'At the table', to: 'scenes', label: '▶ Scenes' }],
};
export default feature;
