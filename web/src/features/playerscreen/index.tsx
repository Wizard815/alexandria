import type { WebFeature } from '../registry.ts';
import PlayerScreenPage from './PlayerScreenPage.tsx';

export { PlayerScreenControls } from './Controls.tsx';

const feature: WebFeature = {
  id: 'playerscreen',
  dmRoutes: [{ path: 'screen-players', element: <PlayerScreenPage /> }],
  dmNav: [{ group: 'At the table', to: 'screen-players', label: "📺 Players' screen" }],
};
export default feature;
