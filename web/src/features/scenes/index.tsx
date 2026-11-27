import type { WebFeature } from '../registry.ts';
import ScenesPage from './ScenesPage.tsx';
import TableScenes from './TableBlock.tsx';

const feature: WebFeature = {
  id: 'scenes',
  dmRoutes: [{ path: 'scenes', element: <ScenesPage /> }],
  dmNav: [{ to: 'scenes' }],
  dmTable: [{ id: 'scenes', label: 'Scenes', zone: 'main', order: 30, component: TableScenes }],
};
export default feature;
