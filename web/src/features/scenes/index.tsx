import type { WebFeature } from '../registry.ts';
import ScenesPage from './ScenesPage.tsx';
import TableScenes from './TableBlock.tsx';

const feature: WebFeature = {
  id: 'scenes',
  gmRoutes: [{ path: 'scenes', element: <ScenesPage /> }],
  gmNav: [{ to: 'scenes' }],
  gmTable: [{ id: 'scenes', label: 'Scenes', zone: 'main', order: 30, component: TableScenes }],
};
export default feature;
