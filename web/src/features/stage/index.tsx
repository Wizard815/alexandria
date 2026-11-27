import type { WebFeature } from '../registry.ts';
import StagePage from './StagePage.tsx';
import StageBoard from './StageBoard.tsx';

export { default as StageBoard, useStage } from './StageBoard.tsx';

const feature: WebFeature = {
  id: 'stage',
  gmRoutes: [{ path: 'stage', element: <StagePage /> }],
  gmNav: [{ to: 'stage' }],
  playerRoutes: [{ path: 'stage', element: <StageBoard /> }],
  playerNav: [{ to: 'stage', label: 'Stage', icon: 'fa-masks-theater' }],
};
export default feature;
