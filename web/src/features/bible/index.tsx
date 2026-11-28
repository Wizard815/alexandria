import type { WebFeature } from '../registry.ts';
import BiblePage from './BiblePage.tsx';
import BibleSettings from './BibleSettings.tsx';

const feature: WebFeature = {
  id: 'bible',
  gmRoutes: [{ path: 'bible', element: <BiblePage /> }],
  playerRoutes: [{ path: 'bible', element: <BiblePage /> }],
  gmNav: [{ to: 'bible' }],
  settings: { title: 'Story bible', component: BibleSettings },
  playerNav: [{ to: 'bible', label: 'Story bible', icon: 'fa-book-open' }],
};
export default feature;
