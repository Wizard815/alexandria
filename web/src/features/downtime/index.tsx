// DownTime: downtime activities from common to legendary, the GM's Downtime
// button and the players' popup. Server: librarian/src/features/downtime; the
// house rule that turns it on: mods/downtime.alxmod.json.
import type { WebFeature } from '../registry.ts';
import { Activities, GMDowntime, DowntimeCard } from './GM.tsx';
import { DowntimePopup, PlayerDowntime } from './Player.tsx';

const feature: WebFeature = {
  id: 'downtime',
  gmRoutes: [{ path: 'downtime', element: <GMDowntime /> }],
  playerRoutes: [{ path: 'downtime', element: <PlayerDowntime /> }],
  gmNav: [{ to: 'downtime' }],
  playerNav: [{ to: 'downtime', label: 'Downtime', icon: 'fa-hourglass-half' }],
  overlay: DowntimePopup,
  gmHome: [DowntimeCard],
  houseRuleTabs: [{ mod: 'downtime', title: 'DownTime activities', component: Activities }],
};
// The GM's Table (when this server has its block registry) shows the Downtime button in the "now" zone.
Object.assign(feature, { gmTable: [{ id: 'downtime', label: 'Downtime', zone: 'now', order: 30, component: DowntimeCard }] });
export default feature;
