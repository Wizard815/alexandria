import type { WebFeature } from '../registry.ts';
import AudioSetup from './AudioSetup.tsx';
import PlayerAudio from './PlayerAudio.tsx';
import TranscriptOverlay from './TranscriptIsland.tsx';
import './audio.css';

const feature: WebFeature = {
  id: 'audio',
  dmRoutes: [{ path: 'audio', element: <AudioSetup /> }],
  playerRoutes: [{ path: 'audio', element: <PlayerAudio /> }],
  dmNav: [{ group: 'Setup', to: 'audio', label: '● Audio setup' }],
  playerNav: [{ to: 'audio', label: 'My microphone', icon: 'fa-microphone' }],
  overlay: TranscriptOverlay,
};
export default feature;
