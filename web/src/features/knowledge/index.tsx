import type { WebFeature } from '../registry.ts';
import KnowledgePage from './KnowledgePage.tsx';

const feature: WebFeature = {
  id: 'knowledge',
  gmRoutes: [{ path: 'knowledge', element: <KnowledgePage /> }],
  gmNav: [{ to: 'knowledge' }],
};
export default feature;
