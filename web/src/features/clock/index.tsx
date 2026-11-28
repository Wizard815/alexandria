import type { WebFeature } from '../registry.ts';
import ClockPage from './ClockPage.tsx';
import ClockSettings from './ClockSettings.tsx';
import TodayCard from './TodayCard.tsx';
import TableNow, { TableToday } from './TableNow.tsx';
import WorldDate from './WorldDate.tsx';

const feature: WebFeature = {
  id: 'clock',
  gmRoutes: [{ path: 'clock', element: <ClockPage /> }],
  gmNav: [{ to: 'clock' }],
  settings: { title: 'World clock', component: ClockSettings },
  gmTable: [
    { id: 'clock', label: 'World clock', zone: 'now', order: 10, component: TableNow },
    { id: 'today', label: 'World events', zone: 'side', order: 40, component: TableToday },
  ],
  playerHome: [TodayCard],
  topbar: WorldDate,
};
export default feature;
