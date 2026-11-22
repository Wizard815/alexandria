import type { WebFeature } from '../registry.ts';
import ClockPage from './ClockPage.tsx';
import ClockSettings from './ClockSettings.tsx';
import TodayCard from './TodayCard.tsx';
import WorldDate from './WorldDate.tsx';

const feature: WebFeature = {
  id: 'clock',
  dmRoutes: [{ path: 'clock', element: <ClockPage /> }],
  dmNav: [{ to: 'clock' }],
  settings: { title: 'World clock', component: ClockSettings },
  dmHome: [TodayCard],
  playerHome: [TodayCard],
  topbar: WorldDate,
};
export default feature;
