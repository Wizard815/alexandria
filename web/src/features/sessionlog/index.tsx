import type { WebFeature } from '../registry.ts';
import { SessionLogGM, SessionLogPlayer } from './pages.tsx';

const feature: WebFeature = {
  id: 'sessionlog',
  gmRoutes: [{ path: 'sessionlog', element: <SessionLogGM /> }],
  playerRoutes: [{ path: 'log', element: <SessionLogPlayer /> }],
  gmNav: [{ to: 'sessionlog' }],
  playerNav: [{ to: 'log', label: 'Session log', icon: 'fa-scroll' }],
};
export default feature;
