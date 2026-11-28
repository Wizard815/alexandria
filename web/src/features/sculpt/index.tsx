import type { WebFeature } from '../registry.ts';
import SculptPage from './SculptPage.tsx';

const feature: WebFeature = {
  id: 'sculpt',
  gmRoutes: [{ path: 'sculpt', element: <SculptPage /> }],
  gmNav: [{ to: 'sculpt' }],
};
export default feature;
