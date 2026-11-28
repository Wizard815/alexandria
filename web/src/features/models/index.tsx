import type { WebFeature } from '../registry.ts';
import ModelsPage from './ModelsPage.tsx';
import TableModels from './TableBlock.tsx';
import SwitchPage from './SwitchPage.tsx';
import HealthBand from './HealthBand.tsx';

const feature: WebFeature = {
  id: 'models',
  adminRoutes: [{ path: 'models', element: <ModelsPage /> }],
  adminNav: [{ to: 'models', label: 'Models' }],
  // The DM's own model switcher, and the notice when a model goes down mid-session.
  dmRoutes: [{ path: 'models', element: <SwitchPage /> }],
  dmNav: [{ to: 'models' }],
  dmBand: HealthBand,
  dmTable: [{ id: 'ai', label: 'AI & templates', zone: 'side', order: 5, component: TableModels }],
};
export default feature;
