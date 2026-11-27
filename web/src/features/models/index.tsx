import type { WebFeature } from '../registry.ts';
import ModelsPage from './ModelsPage.tsx';
import TableModels from './TableBlock.tsx';

const feature: WebFeature = {
  id: 'models',
  adminRoutes: [{ path: 'models', element: <ModelsPage /> }],
  adminNav: [{ to: 'models', label: 'Models' }],
  dmTable: [{ id: 'ai', label: 'AI & templates', zone: 'side', order: 5, component: TableModels }],
};
export default feature;
