import type { WebFeature } from '../registry.ts';
import ScenesPage from './ScenesPage.tsx';

const feature: WebFeature = {
  id: 'scenes',
  dmRoutes: [{ path: 'scenes', element: <ScenesPage /> }],
  dmNav: [{ to: 'scenes' }],
};
export default feature;
