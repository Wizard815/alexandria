import type { WebFeature } from '../registry.ts';
import GeneratorsPage from './GeneratorsPage.tsx';

const feature: WebFeature = {
  id: 'generators',
  dmRoutes: [{ path: 'generators', element: <GeneratorsPage /> }],
  dmNav: [{ group: 'Tools', to: 'generators', label: '✦ Generators' }],
};
export default feature;
