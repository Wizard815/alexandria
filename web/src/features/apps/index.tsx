// The apps around the web app: the "You" card on the player's home page (HP, mana and
// conditions, from the same glance the Android widget reads), the This device page
// (install, the Android widget link, change server) and the public /get-app page
// (App.tsx routes it, as it is outside any world).
import type { WebFeature } from '../registry.ts';
import AdminApps from './AdminApps.tsx';
import AppPage from './AppPage.tsx';
import BackButton from './BackButton.tsx';
import UpdateBanner from './UpdateBanner.tsx';
import Notifier from './Notifier.tsx';
import YouCard from './YouCard.tsx';
import './apps.css';

const feature: WebFeature = {
  id: 'apps',
  dmRoutes: [{ path: 'app', element: <AppPage /> }],
  playerRoutes: [{ path: 'app', element: <AppPage /> }],
  dmNav: [{ to: 'app' }],
  playerNav: [{ to: 'app', label: 'This device', icon: 'fa-mobile-screen-button' }],
  adminRoutes: [{ path: 'apps', element: <AdminApps /> }],
  adminNav: [{ to: 'apps', label: 'App builds' }],
  playerHome: [YouCard],
  topbar: BackButton,
  overlay: () => <><UpdateBanner /><Notifier /></>,
};
export default feature;
