import type { WebFeature } from '../registry.ts';
import ScreensPage from './ScreensPage.tsx';

// The pop-out panel and the side and table screens are routes of their own (outside the GM layout): see App.tsx.
const feature: WebFeature = {
  id: 'screens',
  gmRoutes: [{ path: 'screens', element: <ScreensPage /> }],
  gmNav: [{ to: 'screens' }],
};
export default feature;
