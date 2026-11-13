import type { WebFeature } from '../registry.ts';
import ModelsPage from './ModelsPage.tsx';

const feature: WebFeature = {
  id: 'models',
  adminRoutes: [{ path: 'models', element: <ModelsPage /> }],
  adminNav: [{ to: 'models', label: 'Models' }],
};
export default feature;
