import type { WebFeature } from '../registry.ts';
import LightsPage from './LightsPage.tsx';
import MyColour from './MyColour.tsx';

const feature: WebFeature = {
  id: 'lights',
  gmRoutes: [{ path: 'lights', element: <LightsPage /> }],
  gmNav: [{ to: 'lights' }],
  playerRoutes: [{ path: 'lights', element: <MyColour /> }],
  playerNav: [{ to: 'lights', label: 'My light colour', icon: 'fa-lightbulb' }],
};
export default feature;
