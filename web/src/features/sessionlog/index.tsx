import type { WebFeature } from '../registry.ts';
import { SessionLogDM, SessionLogPlayer } from './pages.tsx';

const feature: WebFeature = {
  id: 'sessionlog',
  dmRoutes: [{ path: 'sessionlog', element: <SessionLogDM /> }],
  playerRoutes: [{ path: 'log', element: <SessionLogPlayer /> }],
  dmNav: [{ to: 'sessionlog' }],
  playerNav: [{ to: 'log', label: 'Session log', icon: 'fa-scroll' }],
};
export default feature;
