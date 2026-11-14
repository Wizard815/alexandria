import type { WebFeature } from '../registry.ts';
import ChatOverlay from './Overlay.tsx';
import ChatPage from './Page.tsx';
import './chat.css';

const feature: WebFeature = {
  id: 'sessionchat',
  dmRoutes: [{ path: 'chat', element: <ChatPage /> }],
  playerRoutes: [{ path: 'chat', element: <ChatPage /> }],
  dmNav: [{ group: 'At the table', to: 'chat', label: '💬 Session chat' }],
  playerNav: [{ to: 'chat', label: 'Session chat', icon: 'fa-comments' }],
  overlay: ChatOverlay,
};
export default feature;
