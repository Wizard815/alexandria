import type { WebFeature } from '../registry.ts';
import Roll20Page from './Roll20Page.tsx';

// DM → Setup → Roll20: connect a Roll20 game (see librarian/src/features/roll20).
const feature: WebFeature = {
  id: 'roll20',
  dmRoutes: [{ path: 'roll20', element: <Roll20Page /> }],
  dmNav: [{ to: 'roll20' }],
};
export default feature;
