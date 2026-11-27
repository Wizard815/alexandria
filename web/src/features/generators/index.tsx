import type { WebFeature } from '../registry.ts';
import GeneratorsPage from './GeneratorsPage.tsx';

const feature: WebFeature = {
  id: 'generators',
  gmRoutes: [{ path: 'generators', element: <GeneratorsPage /> }],
  gmNav: [{ to: 'generators' }],
};
export default feature;
