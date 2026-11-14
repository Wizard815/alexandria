import type { WebFeature } from '../registry.ts';
import ModelsPage from './ModelsPage.tsx';
import ReadyCard from './ReadyCard.tsx';

const feature: WebFeature = {
  id: 'models',
  adminRoutes: [{ path: 'models', element: <ModelsPage /> }],
  adminNav: [{ to: 'models', label: 'Models' }],
  dmHome: [ReadyCard],
};
export default feature;
