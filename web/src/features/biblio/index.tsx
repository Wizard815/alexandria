import type { WebFeature } from '../registry.ts';
import BiblioPage from './BiblioPage.tsx';

const feature: WebFeature = {
  id: 'biblio',
  gmRoutes: [{ path: 'biblio', element: <BiblioPage /> }],
  gmNav: [{ to: 'biblio' }],
  playerRoutes: [{ path: 'biblio', element: <BiblioPage /> }],
  playerNav: [{ to: 'biblio', label: 'Biblio', icon: 'fa-book-atlas' }],
};
export default feature;
