import type { WebFeature } from '../registry.ts';
import PlayerScreenPage from './PlayerScreenPage.tsx';

export { PlayerScreenControls } from './Controls.tsx';

const feature: WebFeature = {
  id: 'playerscreen',
  gmRoutes: [{ path: 'screen-players', element: <PlayerScreenPage /> }],
  gmNav: [{ to: 'screen-players' }],
};
export default feature;
