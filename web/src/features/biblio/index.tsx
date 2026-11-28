import type { WebFeature } from '../registry.ts';
import BiblioPage from './BiblioPage.tsx';

const feature: WebFeature = {
  id: 'biblio',
  dmRoutes: [{ path: 'biblio', element: <BiblioPage /> }],
  dmNav: [{ to: 'biblio' }],
  playerRoutes: [{ path: 'biblio', element: <BiblioPage /> }],
  playerNav: [{ to: 'biblio', label: 'Biblio', icon: 'fa-book-atlas' }],
};
export default feature;
