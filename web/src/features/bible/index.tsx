import type { WebFeature } from '../registry.ts';
import BiblePage from './BiblePage.tsx';

const feature: WebFeature = {
  id: 'bible',
  dmRoutes: [{ path: 'bible', element: <BiblePage /> }],
  playerRoutes: [{ path: 'bible', element: <BiblePage /> }],
  dmNav: [{ group: 'The world', to: 'bible', label: 'Story bible' }],
  playerNav: [{ to: 'bible', label: 'Story bible', icon: 'fa-book-open' }],
};
export default feature;
