import type { WebFeature } from '../registry.ts';
import KnowledgePage from './KnowledgePage.tsx';

const feature: WebFeature = {
  id: 'knowledge',
  dmRoutes: [{ path: 'knowledge', element: <KnowledgePage /> }],
  dmNav: [{ to: 'knowledge' }],
};
export default feature;
