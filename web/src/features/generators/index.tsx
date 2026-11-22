import type { WebFeature } from '../registry.ts';
import GeneratorsPage from './GeneratorsPage.tsx';

const feature: WebFeature = {
  id: 'generators',
  dmRoutes: [{ path: 'generators', element: <GeneratorsPage /> }],
  dmNav: [{ to: 'generators' }],
};
export default feature;
