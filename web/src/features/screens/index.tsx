import type { WebFeature } from '../registry.ts';
import ScreensPage from './ScreensPage.tsx';

// The pop-out panel and the side and table screens are routes of their own (outside the DM layout): see App.tsx.
const feature: WebFeature = {
  id: 'screens',
  dmRoutes: [{ path: 'screens', element: <ScreensPage /> }],
  dmNav: [{ group: 'Setup', to: 'screens', label: '▭ Screens' }],
};
export default feature;
