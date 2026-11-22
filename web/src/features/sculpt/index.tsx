import type { WebFeature } from '../registry.ts';
import SculptPage from './SculptPage.tsx';

const feature: WebFeature = {
  id: 'sculpt',
  dmRoutes: [{ path: 'sculpt', element: <SculptPage /> }],
  dmNav: [{ to: 'sculpt' }],
};
export default feature;
