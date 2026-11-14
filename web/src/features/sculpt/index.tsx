import type { WebFeature } from '../registry.ts';
import SculptPage from './SculptPage.tsx';

const feature: WebFeature = {
  id: 'sculpt',
  dmRoutes: [{ path: 'sculpt', element: <SculptPage /> }],
  dmNav: [{ group: 'The world', to: 'sculpt', label: 'Sculpting' }],
};
export default feature;
