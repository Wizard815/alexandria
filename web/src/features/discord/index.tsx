import type { WebFeature } from '../registry.ts';
import DiscordPage from './DiscordPage.tsx';
import MyDiscord from './MyDiscord.tsx';

const feature: WebFeature = {
  id: 'discord',
  gmRoutes: [{ path: 'discord', element: <DiscordPage /> }],
  gmNav: [{ to: 'discord', group: 'setup', label: 'Discord', icon: 'fa-comment-dots', desc: 'A bot in your Discord server: recaps, rolls, broker messages and the quick helper.' }],
  playerRoutes: [{ path: 'discord', element: <MyDiscord /> }],
  playerNav: [{ to: 'discord', label: 'Discord', icon: 'fa-comment-dots' }],
};
export default feature;
