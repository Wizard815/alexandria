import type { WebFeature } from '../registry.ts';
import Journal from './Journal.tsx';
import MinervaPage from './MinervaPage.tsx';

// The DM's page is Minerva's. Players get their own notebook (journal, goals,
// what they know), kept for them by the broker: its route and label never name her.
const feature: WebFeature = {
  id: 'minerva',
  dmRoutes: [{ path: 'minerva', element: <MinervaPage /> }],
  dmNav: [{ group: 'The world', to: 'minerva', label: 'Minerva' }],
  playerRoutes: [{ path: 'journal', element: <Journal /> }],
  playerNav: [{ to: 'journal', label: 'My journal', icon: 'fa-book-open' }],
};
export default feature;
