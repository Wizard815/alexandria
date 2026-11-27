import type { WebFeature } from '../registry.ts';
import ChatOverlay from './Overlay.tsx';
import ChatPage from './Page.tsx';
import './chat.css';

const feature: WebFeature = {
  id: 'sessionchat',
  gmRoutes: [{ path: 'chat', element: <ChatPage /> }],
  playerRoutes: [{ path: 'chat', element: <ChatPage /> }],
  gmNav: [{ to: 'chat' }],
  playerNav: [{ to: 'chat', label: 'Session chat', icon: 'fa-comments' }],
  overlay: ChatOverlay,
};
export default feature;
