// DownTime: downtime activities from common to legendary, the DM's Downtime
// button and the players' popup. Server: librarian/src/features/downtime; the
// house rule that turns it on: mods/downtime.alxmod.json.
import type { WebFeature } from '../registry.ts';
import { Activities, DMDowntime, DowntimeCard } from './DM.tsx';
import { DowntimePopup, PlayerDowntime } from './Player.tsx';

const feature: WebFeature = {
  id: 'downtime',
  dmRoutes: [{ path: 'downtime', element: <DMDowntime /> }],
  playerRoutes: [{ path: 'downtime', element: <PlayerDowntime /> }],
  dmNav: [{ to: 'downtime' }],
  playerNav: [{ to: 'downtime', label: 'Downtime', icon: 'fa-hourglass-half' }],
  overlay: DowntimePopup,
  dmHome: [DowntimeCard],
  houseRuleTabs: [{ mod: 'downtime', title: 'DownTime activities', component: Activities }],
};
// The DM's Table (when this server has its block registry) shows the Downtime button in the "now" zone.
Object.assign(feature, { dmTable: [{ id: 'downtime', label: 'Downtime', zone: 'now', order: 30, component: DowntimeCard }] });
export default feature;
