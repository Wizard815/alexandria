import type { WebFeature } from '../registry.ts';
import Roll20Page from './Roll20Page.tsx';

// GM → Setup → Roll20: connect a Roll20 game (see librarian/src/features/roll20).
const feature: WebFeature = {
  id: 'roll20',
  gmRoutes: [{ path: 'roll20', element: <Roll20Page /> }],
  gmNav: [{ to: 'roll20' }],
};
export default feature;
